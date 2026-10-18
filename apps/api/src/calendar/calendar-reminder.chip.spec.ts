import { escolherChipPaciente, chipPacienteOuLegado, soTemChipFinanceiro } from '@crm/shared';
import { CalendarReminderWorker } from './calendar-reminder.worker';

/**
 * BLINDAGEM — chip do lembrete pela FUNÇÃO, sempre DENTRO da clínica (out/2026).
 *
 * Caso real (Instituto, tenant all-zeros): chips t00000000-1 COMERCIAL,
 * t00000000-2 CLINICA, t00000000-3 FINANCEIRO + duas linhas ÓRFÃS com purpose
 * NULL — 'whatsapp' (nem existe mais na Evolution, 404) e 'Comercial'. Os envios
 * escolhiam a órfã (1ª por nome / conversa de qualquer caixa / 1ª Instance do
 * banco SEM filtro de clínica) e falhavam calados, gravando "enviado".
 *
 * Se um refactor voltar a pegar chip fora da função, de outra clínica, o
 * FINANCEIRO, ou a gravar falha como envio, ESTE TESTE QUEBRA — de propósito.
 */
const TENANT = '00000000-0000-0000-0000-000000000000';
const OUTRA = 'd124bd41-0000-0000-0000-000000000000';

const CHIPS_INSTITUTO = [
  { name: 'whatsapp', purpose: null },
  { name: 'Comercial', purpose: null },
  { name: 't00000000-1', purpose: 'COMERCIAL' },
  { name: 't00000000-2', purpose: 'CLINICA' },
  { name: 't00000000-3', purpose: 'FINANCEIRO' },
];

describe('escolherChipPaciente (regra única API/worker)', () => {
  it('paciente → CLINICA; comercial → COMERCIAL (ignora as órfãs purpose NULL)', () => {
    expect(escolherChipPaciente(CHIPS_INSTITUTO, 'CLINICA')).toEqual({
      tipo: 'FUNCAO', instance: 't00000000-2', funcao: 'CLINICA', usouIrmao: false,
    });
    expect(escolherChipPaciente(CHIPS_INSTITUTO, 'COMERCIAL')).toEqual({
      tipo: 'FUNCAO', instance: 't00000000-1', funcao: 'COMERCIAL', usouIrmao: false,
    });
  });

  it('na falta da função pedida usa a irmã (Comercial↔Clínica) — nunca o FINANCEIRO', () => {
    const semClinica = CHIPS_INSTITUTO.filter((c) => c.purpose !== 'CLINICA');
    expect(chipPacienteOuLegado(escolherChipPaciente(semClinica, 'CLINICA'))).toBe('t00000000-1');
    const semComercial = CHIPS_INSTITUTO.filter((c) => c.purpose !== 'COMERCIAL');
    expect(chipPacienteOuLegado(escolherChipPaciente(semComercial, 'COMERCIAL'))).toBe('t00000000-2');
  });

  it('só FINANCEIRO → nenhum chip (pausa em vez de trocar o número do paciente)', () => {
    const e = escolherChipPaciente([{ name: 't00000000-3', purpose: 'FINANCEIRO' }], 'CLINICA');
    expect(chipPacienteOuLegado(e)).toBeNull();
    expect(soTemChipFinanceiro(e)).toBe(true);
  });

  it('clínica LEGADA (sem chip com função) mantém o 1º chip da lista, sem o financeiro', () => {
    const e = escolherChipPaciente(
      [{ name: 'fin', purpose: 'FINANCEIRO' }, { name: 'legado-a', purpose: null }, { name: 'legado-b', purpose: null }],
      'CLINICA',
    );
    expect(e).toEqual({ tipo: 'LEGADO', naoFinanceiros: ['legado-a', 'legado-b'], financeiros: ['fin'] });
    expect(chipPacienteOuLegado(e)).toBe('legado-a');
    expect(soTemChipFinanceiro(e)).toBe(false);
  });

  it('sem chips → LEGADO vazio (não é "só financeiro")', () => {
    const e = escolherChipPaciente([], 'COMERCIAL');
    expect(chipPacienteOuLegado(e)).toBeNull();
    expect(soTemChipFinanceiro(e)).toBe(false);
  });
});

describe('CalendarReminderWorker — chip do lembrete (blindagem)', () => {
  function build(opts: {
    chipsByTenant?: Record<string, { name: string; purpose: string | null }[]>;
    settings?: Record<string, string>;
    sendText?: jest.Mock;
    lastConvo?: any;
  } = {}) {
    const chipsByTenant = opts.chipsByTenant ?? {
      [TENANT]: CHIPS_INSTITUTO,
      [OUTRA]: [{ name: 'td124bd4-1', purpose: 'CLINICA' }],
    };
    const settings = opts.settings ?? {};
    const sendText = opts.sendText ?? jest.fn().mockResolvedValue({ key: { id: 'wamid-1' }, data: { key: { id: 'wamid-1' } } });
    const prisma: any = {
      instance: {
        findMany: jest.fn().mockImplementation(({ where }: any) => Promise.resolve(chipsByTenant[where?.tenant_id] ?? [])),
        // O resolvedor NÃO pode mais usar findFirst (era o "1ª Instance do banco").
        findFirst: jest.fn().mockRejectedValue(new Error('instance.findFirst não deveria ser chamado')),
      },
      conversation: {
        // A conversa do lead ainda aponta pro chip órfão 'whatsapp' — não pode ditar o chip.
        findFirst: jest.fn().mockResolvedValue(opts.lastConvo === undefined ? { id: 'conv-1', instance_name: 'whatsapp' } : opts.lastConvo),
        update: jest.fn().mockResolvedValue({}),
      },
      globalSetting: {
        findUnique: jest.fn().mockImplementation(({ where: { key } }: any) =>
          Promise.resolve(settings[key] !== undefined ? { value: settings[key] } : null)),
      },
      tenantSetting: { findUnique: jest.fn().mockResolvedValue(null) },
      tenant: { findUnique: jest.fn().mockResolvedValue(null) },
      aiMemory: { findUnique: jest.fn().mockResolvedValue(null) },
      message: { create: jest.fn().mockResolvedValue({}) },
      dispatchLog: { create: jest.fn().mockResolvedValue({}) },
      eventReminder: {
        findUnique: jest.fn().mockResolvedValue({ id: 'r1', sent_at: null, minutes_before: 60 }),
        findFirst: jest.fn().mockResolvedValue(null),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        update: jest.fn().mockResolvedValue({}),
      },
      calendarEvent: { findUnique: jest.fn() },
      user: { findMany: jest.fn().mockResolvedValue([]) },
      notification: { create: jest.fn().mockResolvedValue({}) },
    };
    const whatsapp: any = { sendText };
    const appSettings: any = { getAiConfig: jest.fn().mockRejectedValue(new Error('sem IA no teste')) };
    const worker = new CalendarReminderWorker(prisma, whatsapp, appSettings);
    return { worker, prisma, sendText };
  }

  function evento(over: any = {}) {
    return {
      id: 'ev-1',
      type: 'CONSULTA',
      status: 'AGENDADO',
      tenant_id: TENANT,
      title: 'Avaliação',
      start_at: new Date('2026-10-20T14:00:00Z'),
      location: null,
      assigned_user: { id: 'u-1', name: 'Dra. Suellen Passos', phone: '82999990000' },
      lead: { id: 'lead-1', name: 'Maria Silva', phone: '82988887777', tenant_id: TENANT },
      patient: null,
      reminders: [{ minutes_before: 60 }],
      ...over,
    };
  }

  it('paciente: lembrete sai pelo CLINICA da clínica, com tenantId — e o dentista NÃO recebe cópia', async () => {
    const { worker, sendText, prisma } = build();
    await (worker as any).sendWhatsAppReminders(evento(), 60);

    // Só o paciente: o dentista recebe a agenda no "Resumo diário do dentista", nunca
    // 1 mensagem por paciente × antecedência (era a enxurrada, até fora do expediente).
    const chamadas = sendText.mock.calls.map((c: any[]) => ({ to: c[0], inst: c[2], tenant: c[4] }));
    expect(chamadas).toEqual([
      { to: '82988887777', inst: 't00000000-2', tenant: TENANT }, // paciente
    ]);
    // Toda busca de chip foi escopada pela clínica do evento.
    for (const [args] of prisma.instance.findMany.mock.calls) expect(args.where.tenant_id).toBe(TENANT);
    expect(prisma.instance.findFirst).not.toHaveBeenCalled();
    expect(prisma.message.create).toHaveBeenCalledTimes(1);
  });

  // (O ramo comercial do sendWhatsAppReminders lê o toggle via `await import('@crm/shared')`,
  // que o jest deste projeto — module nodenext, sem VM modules — não executa; por isso o
  // chip do lembrete COMERCIAL é travado direto no resolvedor.)
  it('lembrete comercial: COMERCIAL; sem ele, o CLINICA; nunca o FINANCEIRO nem órfã', async () => {
    const { worker } = build({
      chipsByTenant: {
        [TENANT]: CHIPS_INSTITUTO,
        [OUTRA]: CHIPS_INSTITUTO.filter((c) => c.purpose !== 'COMERCIAL'),
      },
    });
    expect(await (worker as any).resolveTenantInstance(TENANT, 'COMERCIAL')).toBe('t00000000-1');
    expect(await (worker as any).resolveTenantInstance(OUTRA, 'COMERCIAL')).toBe('t00000000-2');
  });

  it('evento sem tenant_id usa a clínica do lead — nunca chip de outra clínica', async () => {
    const { worker, sendText, prisma } = build();
    await (worker as any).sendWhatsAppReminders(evento({ tenant_id: null }), 60);
    for (const [args] of prisma.instance.findMany.mock.calls) expect(args.where.tenant_id).toBe(TENANT);
    expect(sendText.mock.calls.every((c: any[]) => c[2] === 't00000000-2' && c[4] === TENANT)).toBe(true);
  });

  it('sem clínica nenhuma: NÃO envia nada e falha com motivo (antes: 1ª Instance do banco)', async () => {
    const { worker, sendText, prisma } = build();
    await expect(
      (worker as any).sendWhatsAppReminders(
        evento({ tenant_id: null, lead: { id: 'l', name: 'X', phone: '82911112222', tenant_id: null } }),
        60,
      ),
    ).rejects.toThrow(/sem clínica/);
    expect(sendText).not.toHaveBeenCalled();
    expect(prisma.instance.findMany).not.toHaveBeenCalled();
  });

  it('clínica só com FINANCEIRO: nada sai por ele e o lembrete vira falha', async () => {
    const { worker, sendText } = build({
      chipsByTenant: { [TENANT]: [{ name: 't00000000-3', purpose: 'FINANCEIRO' }] },
      lastConvo: null,
    });
    await expect((worker as any).sendWhatsAppReminders(evento(), 60)).rejects.toThrow(/Financeiro/);
    expect(sendText).not.toHaveBeenCalled();
  });

  it('Evolution recusa (404 do chip) → falha, não arquiva como enviado', async () => {
    const sendText = jest.fn()
      .mockResolvedValueOnce({ statusCode: 404, error: 'instance does not exist' }); // paciente
    const { worker, prisma } = build({ sendText });
    await expect((worker as any).sendWhatsAppReminders(evento(), 60)).rejects.toThrow(/Evolution recusou/);
    expect(prisma.message.create).not.toHaveBeenCalled();
  });

  it('exists:false (número sem WhatsApp) também é falha', async () => {
    const sendText = jest.fn()
      .mockResolvedValueOnce({ key: { id: 'x' }, response: { message: [{ exists: false, number: '5582988887777' }] } });
    const { worker, prisma } = build({ sendText });
    await expect((worker as any).sendWhatsAppReminders(evento(), 60)).rejects.toThrow(/Evolution recusou o envio .*número sem WhatsApp/);
    expect(prisma.message.create).not.toHaveBeenCalled();
  });

  it('"Reenviar" manual (resend) manda só pro paciente', async () => {
    const { worker, sendText, prisma } = build();
    prisma.calendarEvent.findUnique.mockResolvedValue(evento());
    await worker.process({ name: 'send-reminder', id: 'j3', data: { reminderId: 'r1', eventId: 'ev-1', channel: 'WHATSAPP', resend: true } } as any);
    expect(sendText.mock.calls.map((c: any[]) => c[0])).toEqual(['82988887777']);
    // E o envio que deu certo grava sent_at + last_error null.
    const ok = prisma.eventReminder.update.mock.calls.at(-1)[0].data;
    expect(ok.sent_at).toBeInstanceOf(Date);
    expect(ok.last_error).toBeNull();
  });

  it('process(): falha de envio grava FAILED (sent_at volta a null + last_error), não "enviado"', async () => {
    const sendText = jest.fn()
      .mockResolvedValueOnce({ statusCode: 404, error: 'instance does not exist' });
    const { worker, prisma } = build({ sendText });
    prisma.calendarEvent.findUnique.mockResolvedValue(evento());
    await worker.process({ name: 'send-reminder', id: 'j1', data: { reminderId: 'r1', eventId: 'ev-1', channel: 'WHATSAPP' } } as any);

    const updates = prisma.eventReminder.update.mock.calls.map((c: any[]) => c[0].data);
    expect(updates).toHaveLength(1);
    expect(updates[0].sent_at).toBeNull();
    expect(updates[0].last_error).toMatch(/Evolution recusou/);
  });

  it('nenhuma antecedência (48h/24h/1h/15min) manda mensagem ao dentista', async () => {
    for (const min of [2880, 1440, 60, 15]) {
      const { worker, sendText, prisma } = build();
      prisma.eventReminder.findUnique.mockResolvedValue({ id: 'r1', sent_at: null, minutes_before: min });
      prisma.calendarEvent.findUnique.mockResolvedValue(evento({ reminders: [{ minutes_before: min }] }));
      await worker.process({ name: 'send-reminder', id: `j-${min}`, data: { reminderId: 'r1', eventId: 'ev-1', channel: 'WHATSAPP' } } as any);
      expect(sendText.mock.calls.map((c: any[]) => c[0])).not.toContain('82999990000');
    }
  });

  it('aviso de audiência agendada: chip CLINICA da clínica + tenantId (antes: conversa de qualquer caixa)', async () => {
    const { worker, sendText, prisma } = build();
    prisma.calendarEvent.findUnique.mockResolvedValue(evento({ type: 'AUDIENCIA', assigned_user: null }));
    await worker.process({ name: 'notify-hearing-scheduled', id: 'j2', data: { eventId: 'ev-1' } } as any);
    expect(sendText).toHaveBeenCalledTimes(1);
    expect(sendText.mock.calls[0][2]).toBe('t00000000-2');
    expect(sendText.mock.calls[0][4]).toBe(TENANT);
  });

  it('clínica legada sem NENHUM chip: usa só o override legado DELA (TenantSetting), nunca o default global', async () => {
    const { worker, prisma } = build({ chipsByTenant: {}, lastConvo: null });
    prisma.tenantSetting.findUnique.mockResolvedValue({ value: 'chip-legado-da-clinica' });
    expect(await (worker as any).resolveTenantInstance(TENANT, 'CLINICA')).toBe('chip-legado-da-clinica');
    expect(prisma.tenantSetting.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { tenant_id_key: { tenant_id: TENANT, key: 'EVOLUTION_INSTANCE_NAME' } } }),
    );

    prisma.tenantSetting.findUnique.mockResolvedValue(null);
    expect(await (worker as any).resolveTenantInstance(TENANT, 'CLINICA')).toBeNull();
  });
});

import { WaitlistService } from './waitlist.service';

/**
 * BLINDAGEM — aviso de vaga da lista de espera: chip pela FUNÇÃO, dentro da clínica
 * da entrada (out/2026). Antes: conversa do lead em qualquer caixa e, sem ela, a 1ª
 * Instance do banco SEM filtro de clínica (chip de outra clínica).
 */
const TENANT = '00000000-0000-0000-0000-000000000000';
const OUTRA = 'd124bd41-0000-0000-0000-000000000000';
const CHIPS = {
  [TENANT]: [
    { name: 'whatsapp', purpose: null },
    { name: 'Comercial', purpose: null },
    { name: 't00000000-1', purpose: 'COMERCIAL' },
    { name: 't00000000-2', purpose: 'CLINICA' },
    { name: 't00000000-3', purpose: 'FINANCEIRO' },
  ],
  [OUTRA]: [{ name: 'td124bd4-1', purpose: 'CLINICA' }],
} as Record<string, any[]>;

describe('WaitlistService.notifySlotOpened — chip (blindagem)', () => {
  function build(entries: any[], sendResult: any = { key: { id: 'wamid' } }) {
    const sendText = jest.fn().mockResolvedValue(sendResult);
    const update = jest.fn().mockResolvedValue({});
    const prisma: any = {
      waitlistEntry: { findMany: jest.fn().mockResolvedValue(entries), update },
      instance: {
        findMany: jest.fn().mockImplementation(({ where }: any) => Promise.resolve(CHIPS[where?.tenant_id] ?? [])),
        findFirst: jest.fn().mockRejectedValue(new Error('instance.findFirst não deveria ser chamado')),
      },
      conversation: { findFirst: jest.fn().mockResolvedValue({ instance_name: 'whatsapp' }) },
      tenantSetting: { findUnique: jest.fn().mockResolvedValue(null) },
    };
    const svc = new WaitlistService(prisma, { sendText } as any);
    return { svc, sendText, update, prisma };
  }

  const entry = (over: any = {}) => ({
    id: 'w1',
    tenant_id: TENANT,
    lead_id: 'lead-1',
    lead: { id: 'lead-1', name: 'Maria Silva', phone: '82988887777', tenant_id: TENANT },
    dentist: null,
    ...over,
  });

  it('paciente → CLINICA da clínica da entrada, com tenantId; lead não-cliente → COMERCIAL', async () => {
    const { svc, sendText, update } = build([
      entry(),
      entry({ id: 'w2', lead_id: 'lead-2', lead: { id: 'lead-2', name: 'João', phone: '82977776666', tenant_id: TENANT, is_client: false } }),
    ]);
    const r = await svc.notifySlotOpened({ dentistId: 'd', slotStart: new Date('2026-10-20T14:00:00Z'), tenantId: TENANT });
    expect(r.notified).toBe(2);
    expect(sendText.mock.calls.map((c: any[]) => [c[2], c[4]])).toEqual([
      ['t00000000-2', TENANT],
      ['t00000000-1', TENANT],
    ]);
    expect(update).toHaveBeenCalledTimes(2);
  });

  it('entrada de outra clínica usa o chip DELA — nunca o do Instituto', async () => {
    const { svc, sendText } = build([
      entry({ tenant_id: OUTRA, lead: { id: 'lead-9', name: 'Ana', phone: '82966665555', tenant_id: OUTRA } }),
    ]);
    await svc.notifySlotOpened({ dentistId: 'd', slotStart: new Date('2026-10-20T14:00:00Z') });
    expect(sendText.mock.calls[0][2]).toBe('td124bd4-1');
    expect(sendText.mock.calls[0][4]).toBe(OUTRA);
  });

  it('falha da Evolution NÃO marca NOTIFICADO', async () => {
    const { svc, update } = build([entry()], { statusCode: 404, error: 'instance does not exist' });
    const r = await svc.notifySlotOpened({ dentistId: 'd', slotStart: new Date('2026-10-20T14:00:00Z'), tenantId: TENANT });
    expect(r.notified).toBe(0);
    expect(update).not.toHaveBeenCalled();
  });

  it('clínica legada sem chip na tabela: só o override DELA — sem ele não envia (nunca o default global)', async () => {
    const LEGADA = 'legada00-0000-0000-0000-000000000000';
    const e = entry({ tenant_id: LEGADA, lead: { id: 'lead-7', name: 'Bia', phone: '82955554444', tenant_id: LEGADA } });

    const semOverride = build([e]);
    semOverride.prisma.conversation.findFirst.mockResolvedValue(null);
    await semOverride.svc.notifySlotOpened({ dentistId: 'd', slotStart: new Date('2026-10-20T14:00:00Z') });
    expect(semOverride.sendText).not.toHaveBeenCalled();

    const comOverride = build([e]);
    comOverride.prisma.conversation.findFirst.mockResolvedValue(null);
    comOverride.prisma.tenantSetting.findUnique.mockResolvedValue({ value: 'chip-legado-da-legada' });
    await comOverride.svc.notifySlotOpened({ dentistId: 'd', slotStart: new Date('2026-10-20T14:00:00Z') });
    expect(comOverride.sendText.mock.calls[0][2]).toBe('chip-legado-da-legada');
    expect(comOverride.sendText.mock.calls[0][4]).toBe(LEGADA);
  });

  it('erro de banco numa entrada não derruba as outras nem zera a contagem', async () => {
    const { svc, sendText, prisma } = build([entry(), entry({ id: 'w2', lead_id: 'lead-2' })]);
    prisma.instance.findMany
      .mockRejectedValueOnce(new Error('conexão caiu'))
      .mockImplementation(({ where }: any) => Promise.resolve(CHIPS[where?.tenant_id] ?? []));
    const r = await svc.notifySlotOpened({ dentistId: 'd', slotStart: new Date('2026-10-20T14:00:00Z'), tenantId: TENANT });
    expect(r.notified).toBe(1);
    expect(sendText).toHaveBeenCalledTimes(1);
  });

  it('entrada sem clínica: não envia', async () => {
    const { svc, sendText } = build([entry({ tenant_id: null, lead: { id: 'l', name: 'X', phone: '82911112222', tenant_id: null } })]);
    await svc.notifySlotOpened({ dentistId: 'd', slotStart: new Date('2026-10-20T14:00:00Z') });
    expect(sendText).not.toHaveBeenCalled();
  });
});

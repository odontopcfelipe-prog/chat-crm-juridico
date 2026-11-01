/**
 * F7 do laboratório — confirmação da véspera da coleta, da prova e da entrega
 * (agendarConfirmacoesDoLaboratorio): texto exato, conferências antes de ler chave,
 * a mesma trava da clínica (lock + conferência na transação) e nada de vocabulário
 * de clínica no texto que sai.
 */
import { LAB_AGENDA_TEXTOS } from '@crm/shared';
import { agendarConfirmacoesDoLaboratorio } from './confirmacao-do-laboratorio';

// Dados de exemplo (repositório público: nada real).
const LAB = 'tenant-lab';
const OUTRO_LAB = 'tenant-lab-2';
const TEL = '5582900000021';
const AGORA = new Date('2026-10-21T15:00:00.000Z');
const JANELA = {
  in24h: new Date('2026-10-22T12:00:00.000Z'),
  in25h: new Date('2026-10-22T13:00:00.000Z'),
  now: AGORA,
};
const LOGGER = { log: jest.fn(), warn: jest.fn() };

// Mesmo vocabulário barrado pela trava 2 (scripts/ci/check-pick-literals.mjs).
const PROIBIDOS = /(?<![\p{L}\p{N}])(pacientes?|consultas?|prontuarios?|anamneses?|odontogramas?|planos? de tratamentos?|tratamentos? odontologicos?|tcle)(?![\p{L}\p{N}])/u;
const semAcento = (t: string) => t.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();

const visita = (over: Record<string, any> = {}, paciente: Record<string, any> = {}) => ({
  id: 'ev-1',
  tenant_id: LAB,
  type: 'COLETA',
  title: 'Coleta',
  start_at: new Date('2026-10-22T12:30:00.000Z'),
  location: null,
  assigned_user: { name: 'Expedição Exemplo' },
  patient: {
    id: 'pac-1',
    name: 'Dra. Ana Souza',
    phone: TEL,
    tenant_id: LAB,
    address: 'Rua Exemplo',
    address_number: '100',
    address_complement: null,
    neighborhood: 'Centro',
    city: 'Maceió',
    state: 'AL',
    ...paciente,
  },
  ...over,
});

function montar(eventos: any[], chaves: Record<string, string> = {}, opcoes: { existente?: boolean; dupNaTransacao?: boolean } = {}) {
  const criadas: any[] = [];
  const tx: any = {
    $executeRaw: jest.fn(async () => 0),
    appointmentConfirmation: {
      findFirst: jest.fn(async () => (opcoes.dupNaTransacao ? { id: 'dup' } : null)),
      create: jest.fn(async (a: any) => {
        criadas.push(a.data);
        return a.data;
      }),
    },
  };
  const prisma: any = {
    calendarEvent: { findMany: jest.fn(async () => eventos) },
    globalSetting: { findUnique: jest.fn(async ({ where }: any) => (where.key in chaves ? { value: chaves[where.key] } : null)) },
    appointmentConfirmation: { findFirst: jest.fn(async () => (opcoes.existente ? { id: 'ja' } : null)) },
    tenant: { findUnique: jest.fn(async () => ({ name: 'Laboratório Exemplo' })) },
    eventReminder: { findFirst: jest.fn(async () => ({ id: 'r-48h' })) },
    $transaction: jest.fn(async (cb: any) => cb(tx)),
  };
  return { prisma, tx, criadas };
}

const TEXTO = (tipo: string, linha = '📍 Rua Exemplo, 100, Centro, Maceió/AL\n\n') =>
  `Oi Ana, tudo bem? Aqui é do laboratório. Passando pra confirmar a ${tipo} do seu trabalho amanhã, *22/10* às *12:30*.\n` +
  linha +
  'Vai ter alguém no consultório pra receber? Se precisar mudar, é só responder aqui.';

// Sem endereço a linha 📍 some e fica só a quebra.
const SEM_ENDERECO = String.fromCharCode(10);

describe('Confirmação 24 h do laboratório (agendarConfirmacoesDoLaboratorio)', () => {
  beforeEach(() => jest.clearAllMocks());

  it('sem laboratório: nenhuma consulta', async () => {
    const { prisma } = montar([visita()]);
    expect(await agendarConfirmacoesDoLaboratorio(prisma, new Set(), JANELA, LOGGER)).toEqual({ criadas: 0, puladas: 0 });
    expect(prisma.calendarEvent.findMany).not.toHaveBeenCalled();
  });

  it('busca só as contas de laboratório, os tipos do laboratório e a janela', async () => {
    const { prisma } = montar([]);
    await agendarConfirmacoesDoLaboratorio(prisma, new Set([LAB, OUTRO_LAB]), JANELA, LOGGER);
    expect(prisma.calendarEvent.findMany.mock.calls[0][0].where).toEqual({
      tenant_id: { in: [LAB, OUTRO_LAB] },
      type: { in: ['COLETA', 'PROVA', 'ENTREGA'] },
      status: 'AGENDADO',
      OR: [{ patient_id: { not: null } }, { lead_id: { not: null } }],
      start_at: { gte: JANELA.in24h, lt: JANELA.in25h },
    });
  });

  it('contato sem ficha (só o contato no evento): sai pelo telefone e nome do contato, sem endereço', async () => {
    const ev = { ...visita(), patient: null, lead: { name: 'Dr. Bruno Lima', phone: TEL, tenant_id: LAB } };
    const { prisma, criadas } = montar([ev]);
    expect(await agendarConfirmacoesDoLaboratorio(prisma, new Set([LAB]), JANELA, LOGGER)).toEqual({ criadas: 1, puladas: 0 });
    expect(criadas[0].message_text).toBe(TEXTO('coleta', SEM_ENDERECO).replace('Oi Ana,', 'Oi Bruno,'));
  });

  it('contato ou cadastro de outra conta: pula sem ler chave', async () => {
    const a = montar([{ ...visita(), patient: null, lead: { name: 'Dr. Bruno Lima', phone: TEL, tenant_id: OUTRO_LAB } }]);
    expect(await agendarConfirmacoesDoLaboratorio(a.prisma, new Set([LAB, OUTRO_LAB]), JANELA, LOGGER)).toEqual({ criadas: 0, puladas: 1 });
    const b = montar([{ ...visita(), lead: { name: 'Dr. Bruno Lima', phone: TEL, tenant_id: OUTRO_LAB } }]);
    expect(await agendarConfirmacoesDoLaboratorio(b.prisma, new Set([LAB, OUTRO_LAB]), JANELA, LOGGER)).toEqual({ criadas: 0, puladas: 1 });
    expect(a.prisma.globalSetting.findUnique).not.toHaveBeenCalled();
    expect(b.prisma.globalSetting.findUnique).not.toHaveBeenCalled();
  });

  it.each([
    ['COLETA', 'coleta'],
    ['PROVA', 'prova'],
    ['ENTREGA', 'entrega'],
  ])('%s: texto exato do laboratório, com a mesma trava da clínica', async (tipo, frase) => {
    const { prisma, tx, criadas } = montar([visita({ type: tipo })]);
    expect(await agendarConfirmacoesDoLaboratorio(prisma, new Set([LAB]), JANELA, LOGGER)).toEqual({ criadas: 1, puladas: 0 });
    expect(criadas).toEqual([
      { appointment_id: 'ev-1', channel: 'WHATSAPP', scheduled_for: AGORA, message_text: TEXTO(frase), response_status: 'PENDENTE' },
    ]);
    expect(tx.$executeRaw).toHaveBeenCalledTimes(1);
    expect(tx.appointmentConfirmation.findFirst).toHaveBeenCalledWith({ where: { appointment_id: 'ev-1', channel: 'WHATSAPP' }, select: { id: true } });
    expect(PROIBIDOS.test(semAcento(criadas[0].message_text))).toBe(false);
    // Sem a conferência da 48 h e sem ler o nome do laboratório (o texto não usa {clinica}).
    expect(prisma.eventReminder.findFirst).not.toHaveBeenCalled();
    expect(prisma.tenant.findUnique).not.toHaveBeenCalled();
  });

  it('o local digitado no evento vale antes do cadastro; sem endereço a linha some', async () => {
    const a = montar([visita({ location: 'Consultório Exemplo, sala 2' })]);
    await agendarConfirmacoesDoLaboratorio(a.prisma, new Set([LAB]), JANELA, LOGGER);
    expect(a.criadas[0].message_text).toBe(TEXTO('coleta', '📍 Consultório Exemplo, sala 2\n\n'));
    const b = montar([visita({}, { address: null, address_number: null, neighborhood: null, city: null, state: null })]);
    await agendarConfirmacoesDoLaboratorio(b.prisma, new Set([LAB]), JANELA, LOGGER);
    expect(b.criadas[0].message_text).toBe(TEXTO('coleta', '\n'));
  });

  it('texto salvo na conta (com {clinica}) e o padrão quando o salvo está vazio', async () => {
    const a = montar([visita()], {
      [`APPOINTMENT_CONFIRMATION_TEMPLATE_${LAB}`]: JSON.stringify({ template: '{clinica}: {nome}, a {tipo} é amanhã às {hora}.' }),
    });
    await agendarConfirmacoesDoLaboratorio(a.prisma, new Set([LAB]), JANELA, LOGGER);
    expect(a.criadas[0].message_text).toBe('Laboratório Exemplo: Ana, a coleta é amanhã às 12:30.');
    const b = montar([visita()], { [`APPOINTMENT_CONFIRMATION_TEMPLATE_${LAB}`]: JSON.stringify({ template: '  ' }) });
    await agendarConfirmacoesDoLaboratorio(b.prisma, new Set([LAB]), JANELA, LOGGER);
    expect(b.criadas[0].message_text).toBe(TEXTO('coleta'));
    expect(LAB_AGENDA_TEXTOS.confirmacao24h).toContain('{tipo}');
  });

  it('liga/desliga da conta: desligado não cria', async () => {
    const { prisma, criadas } = montar([visita()], { [`APPOINTMENT_CONFIRMATION_ENABLED_${LAB}`]: 'false' });
    expect(await agendarConfirmacoesDoLaboratorio(prisma, new Set([LAB]), JANELA, LOGGER)).toEqual({ criadas: 0, puladas: 1 });
    expect(criadas).toEqual([]);
  });

  it('já existe confirmação (fora ou dentro da transação): não cria outra', async () => {
    const a = montar([visita()], {}, { existente: true });
    await agendarConfirmacoesDoLaboratorio(a.prisma, new Set([LAB]), JANELA, LOGGER);
    expect(a.criadas).toEqual([]);
    expect(a.prisma.$transaction).not.toHaveBeenCalled();
    const b = montar([visita()], {}, { dupNaTransacao: true });
    expect(await agendarConfirmacoesDoLaboratorio(b.prisma, new Set([LAB]), JANELA, LOGGER)).toEqual({ criadas: 0, puladas: 0 });
    expect(b.criadas).toEqual([]);
  });

  it.each([
    ['tipo de clínica', visita({ type: 'CONSULTA' })],
    ['conta fora do conjunto', visita({ tenant_id: 'tenant-clinica' })],
    ['cadastro de outra conta', visita({}, { tenant_id: 'tenant-clinica' })],
    ['sem telefone', visita({}, { phone: null })],
  ])('%s: pula sem ler nenhuma chave', async (_n, ev) => {
    const { prisma, criadas } = montar([ev]);
    expect(await agendarConfirmacoesDoLaboratorio(prisma, new Set([LAB]), JANELA, LOGGER)).toEqual({ criadas: 0, puladas: 1 });
    expect(prisma.globalSetting.findUnique).not.toHaveBeenCalled();
    expect(criadas).toEqual([]);
  });

  it('os textos padrão do laboratório não têm vocabulário de clínica', () => {
    for (const t of [LAB_AGENDA_TEXTOS.confirmacao24h, LAB_AGENDA_TEXTOS.confirmacaoReserva, LAB_AGENDA_TEXTOS.semChipConfirmacao]) {
      expect(PROIBIDOS.test(semAcento(t))).toBe(false);
    }
  });
});

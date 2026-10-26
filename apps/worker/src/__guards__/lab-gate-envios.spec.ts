/**
 * F2 parte 2a do laboratório — envios automáticos do WORKER ao contato e à equipe.
 * Conta de laboratório não recebe nenhum destes; a clínica segue EXATAMENTE como
 * antes (mesmas consultas, mesmos argumentos, mesma ordem de envio).
 *
 *  - aviso de novo agendamento aos ADMs;
 *  - confirmação 24 h (agendador e envio) e lembrete de ortodontia 1 h;
 *  - follow-up legado de 5 dias, fila das sequências (cron e processador com IA) e
 *    disparo em massa legado;
 *  - recall de revisão (marca-passo);
 *  - régua de cobrança inteira: marcos, atrasados recorrente, apresentação D+1 e a
 *    âncora que libera o carnê automático D+2;
 *  - pesquisa pós-atendimento (varredura e envio).
 *
 * Cada freio tem três casos: (a) sem laboratório cadastrado (o caso de produção
 * hoje) = mesmas chamadas de antes; (b) clínica com OUTRA conta laboratório = igual
 * ao (a); (c) laboratório = nada sai, nada é criado.
 *
 * O banco falso responde aos where de verdade só no que importa aqui: as linhas
 * cuja conta cai num `tenant_id: { notIn }` (ou fora de um `tenant_id: { in }`)
 * saem, como no Postgres. Sem filtro no where, a linha do laboratório volta.
 */
import { Logger } from '@nestjs/common';
import axios from 'axios';
import { __limparCacheLabTenants } from '@crm/shared';
import { AdminAgendamentoAlertService } from '../admin-alerts/admin-agendamento-alert.service';
import { ADMIN_AGENDAMENTO_KEY_PREFIX } from '../admin-alerts/admin-agendamento-regras';
import { adminAlertRecipients, sendAdminAlert } from '../admin-alerts/admin-alert';
import { AppointmentConfirmationSchedulerService } from '../automation/appointment-confirmation-scheduler.service';
import { AppointmentConfirmationDispatcherService } from '../automation/appointment-confirmation-dispatcher.service';
import { AppointmentOrtoReminderService } from '../automation/appointment-orto-reminder.service';
import { FollowupCronService } from '../followup/followup-cron.service';
import { FollowupProcessor } from '../followup/followup.processor';
import { MaintenanceRecallCronService } from '../maintenance/maintenance-recall-cron.service';
import { PaymentAlertsCronService } from '../payment/payment-alerts-cron.service';
import { PostCareCronService } from '../post-care/post-care-cron.service';

jest.mock('axios', () => {
  const m: any = { post: jest.fn(), get: jest.fn() };
  m.default = m;
  return { __esModule: true, ...m };
});
jest.mock('../admin-alerts/admin-alert', () => ({
  adminAlertRecipients: jest.fn(),
  sendAdminAlert: jest.fn(),
}));
jest.mock('../automation/disparo-anexos', () => ({
  enviarAnexosDoDisparoWorker: jest.fn(async () => ({ enviados: 0, falhas: [] })),
}));

// ─── Dados de exemplo (repositório público: nada real) ───────────────────────
const CLINICA = 'tenant-clinica';
const OUTRA_CLINICA = 'tenant-clinica-2';
const LAB = 'tenant-lab';
const AGORA = new Date('2026-10-21T15:00:00.000Z'); // quarta, 12:00 em Maceió
const EVO = 'https://evolution.exemplo.test';
const TEL: Record<string, string> = {
  [CLINICA]: '5582900000001',
  [OUTRA_CLINICA]: '5582900000002',
  [LAB]: '5582900000003',
};
const SETTINGS: any = { getEvolutionConfig: async () => ({ apiUrl: EVO, apiKey: 'chave-somente-teste' }) };
const CHIPS = [
  { name: 'chip-clinica', purpose: 'CLINICA' },
  { name: 'chip-financeiro', purpose: 'FINANCEIRO' },
];
const OR_SEM_LAB = { OR: [{ tenant_id: null }, { tenant_id: { notIn: [LAB] } }] };

beforeAll(() => {
  for (const m of ['log', 'warn', 'debug', 'error'] as const) {
    jest.spyOn(Logger.prototype, m).mockImplementation(() => undefined);
  }
});

/** Evolution falsa: cada envio responde um id novo (wamid-1, wamid-2...), do zero. */
function reiniciarEvolution() {
  (axios.post as jest.Mock).mockReset();
  let n = 0;
  (axios.post as jest.Mock).mockImplementation(async () => ({ data: { key: { id: `wamid-${++n}` } } }));
}

beforeEach(() => {
  __limparCacheLabTenants();
  jest.clearAllMocks();
  reiniciarEvolution();
  // Só o relógio é falso; promessas e timers seguem reais.
  jest.useFakeTimers({
    now: AGORA,
    doNotFake: [
      'nextTick', 'setImmediate', 'clearImmediate', 'setTimeout', 'clearTimeout',
      'setInterval', 'clearInterval', 'queueMicrotask', 'hrtime', 'performance',
    ],
  });
});
afterEach(() => jest.useRealTimers());

const perfis = (labs: string[]) => ({
  findMany: jest.fn(async () => labs.map((tenant_id) => ({ tenant_id }))),
});

/** Restrições de conta escritas no where (em qualquer profundidade). */
function restricoesDeConta(where: any, out = { fora: new Set<string>(), so: null as Set<string> | null }) {
  if (Array.isArray(where)) {
    for (const w of where) restricoesDeConta(w, out);
    return out;
  }
  if (!where || typeof where !== 'object' || where instanceof Date) return out;
  for (const [k, v] of Object.entries(where)) {
    if (k === 'tenant_id' && v && typeof v === 'object') {
      for (const id of (v as any).notIn ?? []) out.fora.add(id);
      if ((v as any).in) out.so = new Set((v as any).in);
    } else {
      restricoesDeConta(v, out);
    }
  }
  return out;
}

/** Como o banco devolveria as linhas para este where (só o filtro de conta). */
function comoBanco<T>(linhas: T[], where: any, contaDe: (l: T) => string | null | undefined): T[] {
  const r = restricoesDeConta(where);
  return linhas.filter((l) => {
    const t = contaDe(l);
    if (t != null && r.fora.has(t)) return false;
    if (r.so && !(t != null && r.so.has(t))) return false;
    return true;
  });
}

const postsPara = (tel: string) => (axios.post as jest.Mock).mock.calls.filter((c) => c[1]?.number === tel);
const postsDe = () => (axios.post as jest.Mock).mock.calls.map((c) => [c[0], c[1]]);

// ─── aviso de novo agendamento aos ADMs ─────────────────────────────────────

describe('Aviso de agendamento aos ADMs — laboratório fica de fora', () => {
  function montar(labs: string[]) {
    __limparCacheLabTenants();
    jest.clearAllMocks();
    const desde = new Date(AGORA.getTime() - 30 * 60_000);
    const prisma: any = {
      tenantBusinessProfile: perfis(labs),
      globalSetting: {
        findMany: jest.fn(async () =>
          [CLINICA, LAB, OUTRA_CLINICA].map((t) => ({ key: `${ADMIN_AGENDAMENTO_KEY_PREFIX.EQUIPE}${t}`, value: 'true', updated_at: desde })),
        ),
      },
      calendarEvent: {
        findMany: jest.fn(async ({ where }: any) => [
          {
            id: `ev-${where.tenant_id}`,
            type: 'CONSULTA',
            title: 'Consulta',
            start_at: new Date('2026-10-22T14:30:00.000Z'),
            all_day: false,
            created_by_ai: false,
            recurrence_rule: null,
            patient_id: `pac-${where.tenant_id}`,
            patient: { name: 'Maria Exemplo', phone: TEL[where.tenant_id] },
            lead: null,
            conversation: null,
            assigned_user: { name: 'Dra. Ana Exemplo' },
            created_by: { name: 'Recepção Exemplo' },
            appointment_type: null,
          },
        ]),
        updateMany: jest.fn(async () => ({ count: 1 })),
      },
      instance: { findFirst: jest.fn(async () => null) },
      tenantSetting: { findUnique: jest.fn(async () => null) },
    };
    (adminAlertRecipients as jest.Mock).mockResolvedValue([{ phone: '5582900000099', userId: null, nome: 'ADM Exemplo' }]);
    (sendAdminAlert as jest.Mock).mockResolvedValue({ sent: 1 });
    return { svc: new AdminAgendamentoAlertService(prisma, {} as any), prisma };
  }
  /** Tudo o que saiu, sem as referências do prisma/settings (mudam a cada montagem). */
  const efeitos = (prisma: any) => ({
    destinatarios: (adminAlertRecipients as jest.Mock).mock.calls.map((c) => c.slice(1)),
    busca: prisma.calendarEvent.findMany.mock.calls.map((c: any[]) => c[0]),
    claim: prisma.calendarEvent.updateMany.mock.calls.map((c: any[]) => c[0].where),
    envio: (sendAdminAlert as jest.Mock).mock.calls.map((c) => c.slice(2)),
  });
  const semLab = (e: ReturnType<typeof efeitos>) => ({
    destinatarios: e.destinatarios.filter((c) => c[0] !== LAB),
    busca: e.busca.filter((w: any) => w.where.tenant_id !== LAB),
    claim: e.claim.filter((w: any) => w.tenant_id !== LAB),
    envio: e.envio.filter((c) => c[0] !== LAB),
  });

  it('sem laboratório cadastrado: as três contas avisam, na ordem de antes', async () => {
    const { svc, prisma } = montar([]);
    expect(await svc.processar(AGORA)).toBe(3);
    const e = efeitos(prisma);
    expect(e.envio.map((c) => c[0])).toEqual([CLINICA, LAB, OUTRA_CLINICA]);
    expect(e.busca.map((w: any) => w.where.tenant_id)).toEqual([CLINICA, LAB, OUTRA_CLINICA]);
    expect(e.claim.map((w: any) => w.tenant_id)).toEqual([CLINICA, LAB, OUTRA_CLINICA]);
  });

  it('clínica com OUTRA conta laboratório: as clínicas avisam igual (mesmos argumentos)', async () => {
    const antes = montar([]);
    await antes.svc.processar(AGORA);
    const esperado = semLab(efeitos(antes.prisma));
    const depois = montar([LAB]);
    expect(await depois.svc.processar(AGORA)).toBe(2);
    expect(efeitos(depois.prisma)).toEqual(esperado);
  });

  it('laboratório: nem busca, nem reivindica, nem avisa', async () => {
    const { svc, prisma } = montar([LAB]);
    await svc.processar(AGORA);
    const e = efeitos(prisma);
    expect(e.destinatarios.some((c) => c[0] === LAB)).toBe(false);
    expect(e.busca.some((w: any) => w.where.tenant_id === LAB)).toBe(false);
    expect(e.claim.some((w: any) => w.tenant_id === LAB)).toBe(false);
    expect(e.envio.some((c) => c[0] === LAB)).toBe(false);
  });
});

// ─── confirmação 24 h: agendador ────────────────────────────────────────────

const consulta = (t: string | null, id = `ev-${t}`) => ({
  id,
  tenant_id: t,
  type: 'CONSULTA',
  title: 'Consulta',
  start_at: new Date('2026-10-22T12:30:00.000Z'),
  location: 'Sala 1',
  assigned_user: { name: 'Dra. Ana Exemplo' },
  patient: { id: `pac-${t}`, name: 'Maria Exemplo', phone: TEL[t ?? CLINICA], lead: null },
});

describe('Confirmação 24 h (agendador) — evento de laboratório fica fora da busca', () => {
  const nowNaive = AGORA.getTime() - 3 * 3_600_000;
  const WHERE_DE_ANTES = {
    type: { in: ['CONSULTA', 'PROCEDIMENTO', 'RETORNO', 'ORTODONTIA'] },
    status: 'AGENDADO',
    patient_id: { not: null },
    start_at: { gte: new Date(nowNaive + 24 * 3_600_000), lt: new Date(nowNaive + 25 * 3_600_000) },
  };

  function montar(labs: string[], eventos: any[]) {
    __limparCacheLabTenants();
    const criadas: any[] = [];
    const tx: any = {
      $executeRaw: jest.fn(async () => 0),
      appointmentConfirmation: {
        findFirst: jest.fn(async () => null),
        create: jest.fn(async (a: any) => {
          criadas.push(a.data);
          return a.data;
        }),
      },
    };
    const prisma: any = {
      tenantBusinessProfile: perfis(labs),
      calendarEvent: { findMany: jest.fn(async ({ where }: any) => comoBanco(eventos, where, (e) => e.tenant_id)) },
      globalSetting: { findUnique: jest.fn(async () => null) },
      eventReminder: { findFirst: jest.fn(async () => null) },
      appointmentConfirmation: { findFirst: jest.fn(async () => null) },
      tenant: { findUnique: jest.fn(async () => null) },
      $transaction: jest.fn(async (cb: any) => cb(tx)),
    };
    return { svc: new AppointmentConfirmationSchedulerService(prisma), prisma, criadas };
  }

  it('sem laboratório cadastrado: mesmo where de antes e cria para todas as contas', async () => {
    const { svc, prisma, criadas } = montar([], [consulta(CLINICA), consulta(LAB), consulta(OUTRA_CLINICA)]);
    await svc.scheduleConfirmations();
    expect(prisma.calendarEvent.findMany.mock.calls[0][0].where).toEqual(WHERE_DE_ANTES);
    expect(criadas.map((c) => c.appointment_id)).toEqual([`ev-${CLINICA}`, `ev-${LAB}`, `ev-${OUTRA_CLINICA}`]);
  });

  it('clínica com OUTRA conta laboratório: where de antes + fora o laboratório (null-safe); confirmação igual', async () => {
    const eventos = [consulta(CLINICA), consulta(null, 'ev-legado'), consulta(OUTRA_CLINICA)];
    const antes = montar([], eventos);
    await antes.svc.scheduleConfirmations();
    const depois = montar([LAB], eventos);
    await depois.svc.scheduleConfirmations();
    const where = depois.prisma.calendarEvent.findMany.mock.calls[0][0].where;
    expect(where).toEqual({ AND: [WHERE_DE_ANTES, OR_SEM_LAB] });
    expect(depois.criadas).toEqual(antes.criadas);
    expect(depois.criadas).toHaveLength(3);
  });

  it('laboratório: nenhuma confirmação criada', async () => {
    const { svc, criadas, prisma } = montar([LAB], [consulta(LAB), consulta(CLINICA)]);
    await svc.scheduleConfirmations();
    expect(criadas.map((c) => c.appointment_id)).toEqual([`ev-${CLINICA}`]);
    const chaves = prisma.globalSetting.findUnique.mock.calls.map((c: any[]) => c[0].where.key);
    expect(chaves.some((k: string) => k.endsWith(LAB))).toBe(false);
  });
});

// ─── confirmação 24 h: envio ────────────────────────────────────────────────

describe('Confirmação 24 h (envio) — a de laboratório não sai', () => {
  const pendente = (t: string) => ({
    id: `conf-${t}`,
    message_text: `Oi Maria, confirma amanhã? (${t})`,
    appointment: { id: `ev-${t}`, tenant_id: t, type: 'CONSULTA', start_at: new Date(), patient: { id: `pac-${t}`, name: 'Maria Exemplo', phone: TEL[t] } },
  });
  function montar(labs: string[], pendentes: any[]) {
    __limparCacheLabTenants();
    reiniciarEvolution();
    const prisma: any = {
      tenantBusinessProfile: perfis(labs),
      appointmentConfirmation: {
        findMany: jest.fn(async () => pendentes),
        updateMany: jest.fn(async () => ({ count: 1 })),
        update: jest.fn(async () => ({})),
      },
      globalSetting: { findUnique: jest.fn(async () => null) },
      instance: { findMany: jest.fn(async () => CHIPS) },
    };
    return { svc: new AppointmentConfirmationDispatcherService(prisma, SETTINGS), prisma };
  }
  const efeitos = (prisma: any) => ({
    posts: postsDe(),
    claims: prisma.appointmentConfirmation.updateMany.mock.calls.map((c: any[]) => c[0]),
    updates: prisma.appointmentConfirmation.update.mock.calls.map((c: any[]) => c[0]),
  });

  it('sem laboratório cadastrado: todas saem, na ordem', async () => {
    const { svc } = montar([], [pendente(CLINICA), pendente(LAB), pendente(OUTRA_CLINICA)]);
    await svc.dispatchPending();
    expect(postsDe().map((p) => p[1].number)).toEqual([TEL[CLINICA], TEL[LAB], TEL[OUTRA_CLINICA]]);
  });

  it('clínica com OUTRA conta laboratório: as da clínica saem igual', async () => {
    const lista = [pendente(CLINICA), pendente(OUTRA_CLINICA)];
    const antes = montar([], lista);
    await antes.svc.dispatchPending();
    const esperado = efeitos(antes.prisma);
    const depois = montar([LAB], lista);
    await depois.svc.dispatchPending();
    expect(efeitos(depois.prisma)).toEqual(esperado);
    expect(esperado.posts).toHaveLength(2);
  });

  it('laboratório: não envia, não reivindica e sai da fila como falha', async () => {
    const { svc, prisma } = montar([LAB], [pendente(LAB), pendente(CLINICA)]);
    await svc.dispatchPending();
    expect(postsPara(TEL[LAB])).toHaveLength(0);
    expect(postsPara(TEL[CLINICA])).toHaveLength(1);
    expect(prisma.appointmentConfirmation.updateMany.mock.calls.some((c: any[]) => c[0].where.id === `conf-${LAB}`)).toBe(false);
    const doLab = prisma.appointmentConfirmation.update.mock.calls.filter((c: any[]) => c[0].where.id === `conf-${LAB}`);
    expect(doLab).toHaveLength(1);
    expect(doLab[0][0].data.delivery_status).toBe('FAILED');
  });
});

// ─── lembrete de ortodontia 1 h ─────────────────────────────────────────────

describe('Lembrete de ortodontia 1 h — evento de laboratório fica fora da busca', () => {
  const nowNaive = AGORA.getTime() - 3 * 3_600_000;
  const WHERE_DE_ANTES = {
    type: 'ORTODONTIA',
    status: { in: ['AGENDADO', 'CONFIRMADO'] },
    patient_id: { not: null },
    start_at: { gte: new Date(nowNaive + 3_600_000), lt: new Date(nowNaive + 7_200_000) },
  };
  const orto = (t: string | null, id = `ev-${t}`) => ({
    id,
    tenant_id: t,
    start_at: new Date('2026-10-21T13:00:00.000Z'),
    location: null,
    assigned_user: { name: 'Dra. Ana Exemplo' },
    patient: { id: `pac-${t}`, name: 'Maria Exemplo', phone: TEL[t ?? CLINICA] },
  });
  function montar(labs: string[], eventos: any[]) {
    __limparCacheLabTenants();
    reiniciarEvolution();
    const prisma: any = {
      tenantBusinessProfile: perfis(labs),
      calendarEvent: { findMany: jest.fn(async ({ where }: any) => comoBanco(eventos, where, (e) => e.tenant_id)) },
      globalSetting: {
        findUnique: jest.fn(async ({ where }: any) =>
          /^(APPOINTMENT_ORTO_REMINDER_ENABLED_|ORTO_ORDEM_CHEGADA_)/.test(where.key) ? { value: 'true' } : null,
        ),
      },
      dispatchLog: { findFirst: jest.fn(async () => null), create: jest.fn(async () => ({})) },
      instance: { findMany: jest.fn(async () => CHIPS) },
      tenant: { findUnique: jest.fn(async () => null) },
    };
    return { svc: new AppointmentOrtoReminderService(prisma, SETTINGS), prisma };
  }
  const logs = (prisma: any) => prisma.dispatchLog.create.mock.calls.map((c: any[]) => c[0].data);

  it('sem laboratório cadastrado: mesmo where de antes e lembra todas as contas', async () => {
    const { svc, prisma } = montar([], [orto(CLINICA), orto(LAB)]);
    await svc.sendOrtoReminders();
    const args = prisma.calendarEvent.findMany.mock.calls[0][0];
    expect(args.where).toEqual(WHERE_DE_ANTES);
    expect(args.take).toBe(50);
    expect(postsDe().map((p) => p[1].number)).toEqual([TEL[CLINICA], TEL[LAB]]);
  });

  it('clínica com OUTRA conta laboratório: where de antes + fora o laboratório; lembretes iguais', async () => {
    const eventos = [orto(CLINICA), orto(null, 'ev-legado'), orto(OUTRA_CLINICA)];
    const antes = montar([], eventos);
    await antes.svc.sendOrtoReminders();
    const postsAntes = postsDe();
    const logsAntes = logs(antes.prisma);
    const depois = montar([LAB], eventos);
    await depois.svc.sendOrtoReminders();
    expect(depois.prisma.calendarEvent.findMany.mock.calls[0][0].where).toEqual({ AND: [WHERE_DE_ANTES, OR_SEM_LAB] });
    expect(postsDe()).toEqual(postsAntes);
    expect(logs(depois.prisma)).toEqual(logsAntes);
  });

  it('laboratório: não lembra, não registra e nem lê a configuração dele', async () => {
    const { svc, prisma } = montar([LAB], [orto(LAB), orto(CLINICA)]);
    await svc.sendOrtoReminders();
    expect(postsPara(TEL[LAB])).toHaveLength(0);
    expect(postsPara(TEL[CLINICA])).toHaveLength(1);
    expect(logs(prisma).some((d: any) => d.tenant_id === LAB)).toBe(false);
    expect(prisma.globalSetting.findUnique.mock.calls.some((c: any[]) => c[0].where.key.endsWith(LAB))).toBe(false);
  });
});

// ─── follow-up legado (5 dias) ──────────────────────────────────────────────

describe('Follow-up legado — lead de laboratório fica fora da busca', () => {
  const lead = (t: string | null, id = `lead-${t}`) => ({
    id,
    tenant_id: t,
    name: 'Maria Exemplo',
    phone: TEL[t ?? CLINICA],
    conversations: [{ id: `conv-${id}`, ai_mode: true, instance_name: 'chip-comercial', last_message_at: new Date(AGORA.getTime() - 3 * 86_400_000) }],
  });
  const whereDeAntes = (stage: string, dias: number) => ({
    stage,
    updated_at: { lt: new Date(AGORA.getTime() - dias * 86_400_000) },
    is_client: false,
    OR: [{ last_followup_at: null }, { last_followup_at: { lt: new Date(AGORA.getTime() - dias * 86_400_000) } }],
    followup_enrollments: { none: { status: 'ATIVO' } },
  });
  function montar(labs: string[], leads: any[]) {
    __limparCacheLabTenants();
    const prisma: any = {
      tenantBusinessProfile: perfis(labs),
      lead: { findMany: jest.fn(async ({ where }: any) => comoBanco(leads, where, (l) => l.tenant_id)) },
    };
    const svc: any = new FollowupCronService(prisma, SETTINGS, { add: jest.fn() } as any);
    svc.sendLegacyFollowup = jest.fn(async () => undefined);
    return { svc, prisma };
  }

  it('sem laboratório cadastrado: mesmo where de antes nos dois estágios e envia a todos', async () => {
    const { svc, prisma } = montar([], [lead(CLINICA), lead(LAB)]);
    await svc.legacyStageFollowup();
    const wheres = prisma.lead.findMany.mock.calls.map((c: any[]) => c[0].where);
    expect(wheres).toEqual([whereDeAntes('AGUARDANDO_FORM', 2), whereDeAntes('QUALIFICANDO', 5)]);
    expect(svc.sendLegacyFollowup.mock.calls.map((c: any[]) => c[0].id)).toEqual([
      `lead-${CLINICA}`, `lead-${LAB}`, `lead-${CLINICA}`, `lead-${LAB}`,
    ]);
  });

  it('clínica com OUTRA conta laboratório: where de antes + fora o laboratório (null-safe); envios iguais', async () => {
    const leads = [lead(CLINICA), lead(null, 'lead-legado'), lead(OUTRA_CLINICA)];
    const antes = montar([], leads);
    await antes.svc.legacyStageFollowup();
    const depois = montar([LAB], leads);
    await depois.svc.legacyStageFollowup();
    const wheres = depois.prisma.lead.findMany.mock.calls.map((c: any[]) => c[0].where);
    expect(wheres).toEqual([
      { AND: [whereDeAntes('AGUARDANDO_FORM', 2), OR_SEM_LAB] },
      { AND: [whereDeAntes('QUALIFICANDO', 5), OR_SEM_LAB] },
    ]);
    expect(depois.svc.sendLegacyFollowup.mock.calls).toEqual(antes.svc.sendLegacyFollowup.mock.calls);
    expect(antes.svc.sendLegacyFollowup).toHaveBeenCalledTimes(6);
  });

  it('laboratório: não recebe follow-up', async () => {
    const { svc } = montar([LAB], [lead(LAB), lead(CLINICA)]);
    await svc.legacyStageFollowup();
    expect(svc.sendLegacyFollowup.mock.calls.map((c: any[]) => c[0].id)).toEqual([`lead-${CLINICA}`, `lead-${CLINICA}`]);
  });
});

// ─── sequências de follow-up: cron que enfileira ────────────────────────────

describe('Sequências de follow-up (cron) — inscrição de laboratório não entra na fila', () => {
  const inscricao = (t: string) => ({ id: `enr-${t}`, lead: { tenant_id: t } });
  function montar(labs: string[], linhas: any[]) {
    __limparCacheLabTenants();
    const fila: any = { add: jest.fn(async () => ({})) };
    const prisma: any = {
      tenantBusinessProfile: perfis(labs),
      followupEnrollment: {
        findMany: jest.fn(async ({ where }: any) => comoBanco(linhas, where, (l) => l.lead.tenant_id).map((l) => ({ id: l.id }))),
      },
    };
    return { svc: new FollowupCronService(prisma, SETTINGS, fila), prisma, fila };
  }

  it('sem laboratório cadastrado: mesma consulta de antes e enfileira todas', async () => {
    const { svc, prisma, fila } = montar([], [inscricao(CLINICA), inscricao(LAB)]);
    await svc.processEnrollments();
    expect(prisma.followupEnrollment.findMany).toHaveBeenCalledWith({
      where: { status: 'ATIVO', next_send_at: { lte: AGORA } },
      select: { id: true },
      take: 50,
    });
    expect(Object.keys(prisma.followupEnrollment.findMany.mock.calls[0][0].where)).toEqual(['status', 'next_send_at']);
    expect(fila.add.mock.calls.map((c: any[]) => c[1].enrollment_id)).toEqual([`enr-${CLINICA}`, `enr-${LAB}`]);
  });

  it('clínica com OUTRA conta laboratório: mesmos jobs; o where ganha só o filtro do lead', async () => {
    const linhas = [inscricao(CLINICA), inscricao(OUTRA_CLINICA)];
    const antes = montar([], linhas);
    await antes.svc.processEnrollments();
    const depois = montar([LAB], linhas);
    await depois.svc.processEnrollments();
    expect(depois.fila.add.mock.calls).toEqual(antes.fila.add.mock.calls);
    expect(depois.prisma.followupEnrollment.findMany.mock.calls[0][0].where).toEqual({
      status: 'ATIVO',
      next_send_at: { lte: AGORA },
      lead: { AND: [{}, OR_SEM_LAB] },
    });
  });

  it('laboratório: a inscrição dele não é enfileirada', async () => {
    const { svc, fila } = montar([LAB], [inscricao(LAB), inscricao(CLINICA)]);
    await svc.processEnrollments();
    expect(fila.add.mock.calls.map((c: any[]) => c[1].enrollment_id)).toEqual([`enr-${CLINICA}`]);
  });
});

// ─── sequências de follow-up: processador (IA + envio) ─────────────────────

describe('Sequências de follow-up (processador) — laboratório não gera texto nem envia', () => {
  function montar(labs: string[], tenantDoLead: string) {
    __limparCacheLabTenants();
    const enrollment = {
      id: 'enr-1',
      lead_id: 'lead-1',
      status: 'ATIVO',
      current_step: 1,
      lead: { id: 'lead-1', tenant_id: tenantDoLead, is_client: false, name: 'Maria Exemplo', phone: TEL[tenantDoLead] },
      sequence: { category: 'LEADS', steps: [{ id: 'step-1', position: 1, channel: 'whatsapp', auto_send: true, custom_prompt: 'tom leve' }] },
    };
    const prisma: any = {
      tenantBusinessProfile: perfis(labs),
      followupEnrollment: { findUnique: jest.fn(async () => enrollment), update: jest.fn(async () => ({})) },
      followupMessage: { count: jest.fn(async () => 0), create: jest.fn(async (a: any) => ({ id: 'fm-1', ...a.data })) },
      conversation: { findFirst: jest.fn(async () => null) },
    };
    const followup: any = {
      buildDossie: jest.fn(async () => ({ resumo: 'dossiê' })),
      generateMessage: jest.fn(async () => 'Texto gerado'),
      classifyRisk: jest.fn(() => 'medio'), // vai para aprovação: nada de envio no teste
    };
    const proc = new FollowupProcessor(prisma, SETTINGS, followup);
    return { proc, prisma, followup };
  }
  const job = { name: 'process-step', data: { enrollment_id: 'enr-1' } } as any;
  const efeitos = (m: ReturnType<typeof montar>) => ({
    dossie: m.followup.buildDossie.mock.calls,
    ia: m.followup.generateMessage.mock.calls,
    msg: m.prisma.followupMessage.create.mock.calls,
    pausa: m.prisma.followupEnrollment.update.mock.calls,
  });

  it('sem laboratório cadastrado: monta o dossiê, chama a IA e grava a mensagem', async () => {
    const m = montar([], CLINICA);
    await m.proc.process(job);
    expect(m.followup.buildDossie).toHaveBeenCalledTimes(1);
    expect(m.followup.generateMessage).toHaveBeenCalledWith({ resumo: 'dossiê' }, 'tom leve');
    expect(m.prisma.followupMessage.create).toHaveBeenCalledTimes(1);
    expect(m.prisma.followupEnrollment.update).not.toHaveBeenCalled();
  });

  it('clínica com OUTRA conta laboratório: mesmas chamadas', async () => {
    const antes = montar([], CLINICA);
    await antes.proc.process(job);
    const depois = montar([LAB], CLINICA);
    await depois.proc.process(job);
    expect(efeitos(depois)).toEqual(efeitos(antes));
  });

  it('laboratório: sem IA, sem mensagem; a inscrição sai do ATIVO', async () => {
    const m = montar([LAB], LAB);
    await m.proc.process(job);
    expect(m.followup.buildDossie).not.toHaveBeenCalled();
    expect(m.followup.generateMessage).not.toHaveBeenCalled();
    expect(m.prisma.followupMessage.create).not.toHaveBeenCalled();
    expect(m.prisma.followupMessage.count).not.toHaveBeenCalled();
    expect(m.prisma.followupEnrollment.update).toHaveBeenCalledTimes(1);
    expect(m.prisma.followupEnrollment.update.mock.calls[0][0]).toEqual({
      where: { id: 'enr-1' },
      data: { status: 'PAUSADO', paused_reason: expect.stringContaining('Laboratório') },
    });
  });
});

// ─── disparo em massa legado ────────────────────────────────────────────────

describe('Disparo em massa legado — o de laboratório não sai nem chama a IA', () => {
  function montar(labs: string[], tenant: string | null, contato: string = tenant as string) {
    __limparCacheLabTenants();
    reiniciarEvolution();
    const prisma: any = {
      tenantBusinessProfile: perfis(labs),
      broadcastJob: {
        findUnique: jest.fn(async () => ({ id: 'bc-1', tenant_id: tenant, status: 'EM_ANDAMENTO', type: 'COMUNICADO' })),
        update: jest.fn(async () => ({})),
      },
      broadcastItem: {
        findUnique: jest.fn(async () => ({ id: 'it-1', status: 'PENDENTE', lead_id: 'lead-1', event_id: null })),
        update: jest.fn(async () => ({})),
        count: jest.fn(async () => 0),
      },
      lead: { findUnique: jest.fn(async () => ({ id: 'lead-1', tenant_id: contato, name: 'Maria Exemplo', phone: TEL[contato] })) },
      conversation: { findFirst: jest.fn(async () => ({ id: 'conv-1', instance_name: 'chip-comercial' })), update: jest.fn(async () => ({})) },
      message: { create: jest.fn(async () => ({})) },
    };
    const proc: any = new FollowupProcessor(prisma, SETTINGS, {} as any);
    proc.generateBroadcastMessage = jest.fn(async () => 'Texto da IA');
    return { proc, prisma };
  }
  const job = (prompt?: string) => ({ name: 'broadcast-send', data: { broadcast_id: 'bc-1', item_id: 'it-1', custom_prompt: prompt } }) as any;
  const efeitos = (m: ReturnType<typeof montar>) => ({
    posts: postsDe(),
    ia: m.proc.generateBroadcastMessage.mock.calls,
    item: m.prisma.broadcastItem.update.mock.calls.map((c: any[]) => ({ ...c[0], data: { ...c[0].data, sent_at: undefined } })),
    disparo: m.prisma.broadcastJob.update.mock.calls.map((c: any[]) => ({ ...c[0], data: { ...c[0].data, completed_at: undefined } })),
  });

  it('sem laboratório cadastrado: texto do operador sai pelo chip da conversa', async () => {
    const m = montar([], CLINICA);
    await m.proc.process(job('Oi {{nome}}!'));
    expect(postsDe()).toEqual([[`${EVO}/message/sendText/chip-comercial`, { number: TEL[CLINICA], text: 'Oi Maria!' }]]);
  });

  it('clínica com OUTRA conta laboratório: mesmos envios (com e sem IA)', async () => {
    for (const prompt of ['Oi {{nome}}!', undefined]) {
      const antes = montar([], CLINICA);
      await antes.proc.process(job(prompt));
      const esperado = efeitos(antes);
      const depois = montar([LAB], CLINICA);
      await depois.proc.process(job(prompt));
      expect(efeitos(depois)).toEqual(esperado);
      expect(esperado.posts).toHaveLength(1);
    }
  });

  it('laboratório: não envia, não chama a IA, o item fica como falha e o disparo é concluído', async () => {
    for (const prompt of ['Oi {{nome}}!', undefined]) {
      const m = montar([LAB], LAB);
      await m.proc.process(job(prompt));
      expect(axios.post).not.toHaveBeenCalled();
      expect(m.proc.generateBroadcastMessage).not.toHaveBeenCalled();
      expect(m.prisma.broadcastItem.update.mock.calls.map((c: any[]) => c[0].data.status)).toEqual(['FALHOU']);
      expect(m.prisma.broadcastItem.update.mock.calls[0][0].data.error).toBe('Laboratório: sem disparo em massa');
      const disparo = m.prisma.broadcastJob.update.mock.calls.map((c: any[]) => c[0].data);
      expect(disparo[0]).toEqual({ failed_count: { increment: 1 } });
      expect(disparo[1]).toMatchObject({ status: 'CONCLUIDO' });
    }
  });

  it('disparo sem conta com contato do laboratório: não sai nem chama a IA', async () => {
    for (const prompt of ['Oi {{nome}}!', undefined]) {
      const m = montar([LAB], null, LAB);
      await m.proc.process(job(prompt));
      expect(axios.post).not.toHaveBeenCalled();
      expect(m.proc.generateBroadcastMessage).not.toHaveBeenCalled();
      expect(m.prisma.broadcastItem.update.mock.calls.map((c: any[]) => c[0].data.status)).toEqual(['FALHOU']);
    }
  });

  it('disparo do laboratório com contato legado sem conta: não sai', async () => {
    const m = montar([LAB], LAB, null as any);
    await m.proc.process(job('Oi {{nome}}!'));
    expect(axios.post).not.toHaveBeenCalled();
    expect(m.prisma.broadcastItem.update.mock.calls.map((c: any[]) => c[0].data.status)).toEqual(['FALHOU']);
  });

  it('disparo sem conta com contato de clínica: sai como hoje', async () => {
    const m = montar([LAB], null, CLINICA);
    await m.proc.process(job('Oi {{nome}}!'));
    expect(postsDe()).toEqual([[`${EVO}/message/sendText/chip-comercial`, { number: TEL[CLINICA], text: 'Oi Maria!' }]]);
  });
});

// ─── recall de revisão (marca-passo) ────────────────────────────────────────

describe('Recall de revisão — laboratório entra na exclusão do banco', () => {
  const tarefa = (t: string, dias: number) => ({
    id: `task-${t}`,
    title: 'Revisão',
    due_date: new Date(AGORA.getTime() + dias * 86_400_000),
    procedure: { name: 'Limpeza' },
    patient: { id: `pac-${t}`, name: 'Maria Exemplo', phone: TEL[t], tenant_id: t },
  });
  function montar(labs: string[], tarefas: any[], opcoes: { off?: string[]; ignoraWhere?: boolean } = {}) {
    __limparCacheLabTenants();
    reiniciarEvolution();
    const prisma: any = {
      tenantBusinessProfile: perfis(labs),
      globalSetting: {
        findMany: jest.fn(async () => (opcoes.off ?? []).map((t) => ({ key: `RECALL_PREVENTIVO_ENABLED_${t}` }))),
        findUnique: jest.fn(async () => null),
      },
      maintenanceTask: {
        findFirst: jest.fn(async ({ where }: any) =>
          (opcoes.ignoraWhere ? tarefas : comoBanco(tarefas, where, (x) => x.patient.tenant_id))[0] ?? null,
        ),
        updateMany: jest.fn(async () => ({ count: 1 })),
        update: jest.fn(async () => ({})),
      },
      dispatchLog: { count: jest.fn(async () => 0), create: jest.fn(async () => ({})) },
      instance: { findMany: jest.fn(async () => CHIPS) },
      whatsappChipPacer: { createMany: jest.fn(async () => ({})), updateMany: jest.fn(async () => ({ count: 1 })) },
      tenantSetting: { findUnique: jest.fn(async () => null) },
    };
    return { svc: new MaintenanceRecallCronService(prisma, SETTINGS), prisma };
  }
  const efeitos = (prisma: any) => ({
    posts: postsDe(),
    claim: prisma.maintenanceTask.updateMany.mock.calls,
    marca: prisma.maintenanceTask.update.mock.calls,
    log: prisma.dispatchLog.create.mock.calls,
  });

  it('sem laboratório cadastrado: mesmo where de antes (com e sem clínica OFF) e manda a mais próxima', async () => {
    const semOff = montar([], [tarefa(LAB, 1), tarefa(CLINICA, 2)]);
    expect(await semOff.svc.sendOnePacedRecall()).toBe('sent');
    expect(semOff.prisma.maintenanceTask.findFirst.mock.calls[0][0].where.patient).toEqual({ phone: { not: null } });
    expect(postsDe().map((p) => p[1].number)).toEqual([TEL[LAB]]);

    const comOff = montar([], [tarefa(CLINICA, 2)], { off: ['tenant-off'] });
    await comOff.svc.sendOnePacedRecall();
    expect(comOff.prisma.maintenanceTask.findFirst.mock.calls[0][0].where.patient).toEqual({
      phone: { not: null },
      tenant_id: { notIn: ['tenant-off'] },
    });
  });

  it('clínica com OUTRA conta laboratório: o laboratório soma à exclusão; o recall da clínica sai igual', async () => {
    const antes = montar([], [tarefa(CLINICA, 2)], { off: ['tenant-off'] });
    await antes.svc.sendOnePacedRecall();
    const esperado = efeitos(antes.prisma);
    const depois = montar([LAB], [tarefa(CLINICA, 2)], { off: ['tenant-off'] });
    expect(await depois.svc.sendOnePacedRecall()).toBe('sent');
    expect(efeitos(depois.prisma)).toEqual(esperado);
    expect(depois.prisma.maintenanceTask.findFirst.mock.calls[0][0].where.patient).toEqual({
      phone: { not: null },
      tenant_id: { notIn: ['tenant-off', LAB] },
    });
  });

  it('laboratório: a task dele (mais próxima) não trava a fila — sai a da clínica', async () => {
    const { svc, prisma } = montar([LAB], [tarefa(LAB, 1), tarefa(CLINICA, 2)]);
    expect(await svc.sendOnePacedRecall()).toBe('sent');
    expect(postsPara(TEL[LAB])).toHaveLength(0);
    expect(postsPara(TEL[CLINICA])).toHaveLength(1);
    expect(prisma.maintenanceTask.updateMany.mock.calls.some((c: any[]) => c[0].where.id === `task-${LAB}`)).toBe(false);
  });

  it('defesa: se a task do laboratório chegar mesmo assim, não reivindica nem envia', async () => {
    const { svc, prisma } = montar([LAB], [tarefa(LAB, 1)], { ignoraWhere: true });
    expect(await svc.sendOnePacedRecall()).toBe('empty');
    expect(axios.post).not.toHaveBeenCalled();
    expect(prisma.maintenanceTask.updateMany).not.toHaveBeenCalled();
  });
});

// ─── régua de cobrança ──────────────────────────────────────────────────────

const cobranca = (t: string | null, id: string, due: string) => ({
  id,
  external_id: null,
  gateway: 'LOCAL',
  created_at: new Date('2026-10-01T12:00:00.000Z'),
  tenant_id: t,
  amount: 250,
  due_date: new Date(`${due}T00:00:00.000Z`),
  invoice_url: `https://pagamento.exemplo.test/${id}`,
  boleto_url: null,
  billing_type: 'BOLETO',
  pix_copy_paste: null,
  boleto_barcode: null,
  treatment_plan: null,
  installment: null,
  patient: { id: `pac-${t}`, name: 'Maria Exemplo', phone: TEL[t ?? CLINICA], no_overdue_dunning: false },
});

function prismaRegua(labs: string[], extra: Record<string, any>) {
  __limparCacheLabTenants();
  return {
    tenantBusinessProfile: perfis(labs),
    auditLog: { findMany: jest.fn(async () => []), create: jest.fn(async () => ({})) },
    ...extra,
  } as any;
}

describe('Régua — marcos: cobrança de laboratório fica fora da busca', () => {
  const WHERE_DE_ANTES = {
    status: { in: ['PENDING', 'OVERDUE'] },
    received_in_cash: false,
    due_date: { gte: new Date(AGORA.getTime() - 33 * 86_400_000), lte: new Date(AGORA.getTime() + 3 * 86_400_000) },
  };
  function montar(labs: string[], cobrancas: any[]) {
    const prisma = prismaRegua(labs, {
      paymentGatewayCharge: { findMany: jest.fn(async ({ where }: any) => comoBanco(cobrancas, where, (c) => c.tenant_id)) },
      // Todos os marcos ligados, para qualquer conta.
      globalSetting: { findMany: jest.fn(async ({ where }: any) => (where.key.in as string[]).map((key) => ({ key, value: 'true' }))) },
    });
    return { svc: new PaymentAlertsCronService(prisma, SETTINGS) as any, prisma };
  }
  const contasLidas = (prisma: any) =>
    prisma.globalSetting.findMany.mock.calls.flatMap((c: any[]) => c[0].where.key.in as string[]);

  it('sem laboratório cadastrado: mesmo where de antes; a mais antiga é a escolhida', async () => {
    const { svc, prisma } = montar([], [cobranca(LAB, 'ch-lab', '2026-10-20'), cobranca(CLINICA, 'ch-cli', '2026-10-20')]);
    const pick = await svc.findNextCharge();
    expect(prisma.paymentGatewayCharge.findMany.mock.calls[0][0].where).toEqual(WHERE_DE_ANTES);
    expect(pick).toMatchObject({ chargeId: 'ch-lab', tenantId: LAB, stage: 'boleto_atraso_1d' });
  });

  it('clínica com OUTRA conta laboratório: where de antes + fora o laboratório (null-safe); mesma escolha', async () => {
    const cobrancas = [cobranca(CLINICA, 'ch-cli', '2026-10-20'), cobranca(OUTRA_CLINICA, 'ch-outra', '2026-10-20')];
    const antes = montar([], cobrancas);
    const pickAntes = await antes.svc.findNextCharge();
    const depois = montar([LAB], cobrancas);
    const pickDepois = await depois.svc.findNextCharge();
    expect(depois.prisma.paymentGatewayCharge.findMany.mock.calls[0][0].where).toEqual({ AND: [WHERE_DE_ANTES, OR_SEM_LAB] });
    expect(pickDepois).toEqual(pickAntes);
    expect(pickAntes).toMatchObject({ chargeId: 'ch-cli', tenantId: CLINICA });
  });

  it('laboratório: a cobrança dele não é escolhida (nem a configuração dele é lida)', async () => {
    const { svc, prisma } = montar([LAB], [cobranca(LAB, 'ch-lab', '2026-10-20'), cobranca(CLINICA, 'ch-cli', '2026-10-20')]);
    const pick = await svc.findNextCharge();
    expect(pick).toMatchObject({ chargeId: 'ch-cli', tenantId: CLINICA });
    expect(contasLidas(prisma).some((k: string) => k.endsWith(LAB))).toBe(false);
  });
});

describe('Régua — cobrar atrasados (recorrente): laboratório sai do conjunto', () => {
  function montar(labs: string[], ligados: string[], cobrancas: any[]) {
    const prisma = prismaRegua(labs, {
      paymentGatewayCharge: { findMany: jest.fn(async ({ where }: any) => comoBanco(cobrancas, where, (c) => c.tenant_id)) },
      globalSetting: { findMany: jest.fn(async () => ligados.map((t) => ({ key: `BOLETO_ATRASADO_${t}` }))) },
    });
    return { svc: new PaymentAlertsCronService(prisma, SETTINGS) as any, prisma };
  }
  const contasDaBusca = (prisma: any) => prisma.paymentGatewayCharge.findMany.mock.calls[0][0].where.tenant_id.in;

  it('sem laboratório cadastrado: busca as contas ligadas, na ordem de antes', async () => {
    const { svc, prisma } = montar([], [CLINICA, LAB], [cobranca(LAB, 'ch-lab', '2026-09-01'), cobranca(CLINICA, 'ch-cli', '2026-09-01')]);
    const pick = await svc.findNextOverdue();
    expect(contasDaBusca(prisma)).toEqual([CLINICA, LAB]);
    expect(pick).toMatchObject({ tenantId: LAB, stage: 'boleto_atrasado' });
  });

  it('clínica com OUTRA conta laboratório: mesma busca e mesma escolha', async () => {
    const cobrancas = [cobranca(CLINICA, 'ch-cli', '2026-09-01')];
    const antes = montar([], [CLINICA], cobrancas);
    const pickAntes = await antes.svc.findNextOverdue();
    const depois = montar([LAB], [CLINICA], cobrancas);
    const pickDepois = await depois.svc.findNextOverdue();
    expect(depois.prisma.paymentGatewayCharge.findMany.mock.calls).toEqual(antes.prisma.paymentGatewayCharge.findMany.mock.calls);
    expect(pickDepois).toEqual(pickAntes);
    expect(pickAntes).toMatchObject({ tenantId: CLINICA });
  });

  it('laboratório com o toggle ligado: fica fora (sozinho, nem consulta o banco)', async () => {
    const ambos = montar([LAB], [CLINICA, LAB], [cobranca(LAB, 'ch-lab', '2026-09-01'), cobranca(CLINICA, 'ch-cli', '2026-09-01')]);
    const pick = await ambos.svc.findNextOverdue();
    expect(contasDaBusca(ambos.prisma)).toEqual([CLINICA]);
    expect(pick).toMatchObject({ tenantId: CLINICA });

    const so = montar([LAB], [LAB], [cobranca(LAB, 'ch-lab', '2026-09-01')]);
    expect(await so.svc.findNextOverdue()).toBeNull();
    expect(so.prisma.paymentGatewayCharge.findMany).not.toHaveBeenCalled();
  });
});

describe('Régua — apresentação D+1 e âncora do carnê D+2: venda de laboratório fica fora', () => {
  const todayStartUtcMs = Date.UTC(2026, 9, 21) + 3 * 3_600_000;
  const WHERE_DE_ANTES = {
    billing_type: 'BOLETO',
    created_at: { gte: new Date(todayStartUtcMs - 5 * 86_400_000), lt: new Date(todayStartUtcMs) },
    treatment_plan_id: { not: null },
    status: { in: ['PENDING', 'OVERDUE'] },
    received_in_cash: false,
  };
  const venda = (t: string) => ({ treatment_plan_id: `plan-${t}`, tenant_id: t });
  /** flags: conta → [apresentação, entrega]. */
  function montar(labs: string[], vendas: any[], flags: Record<string, [boolean, boolean]>) {
    const prisma = prismaRegua(labs, {
      paymentGatewayCharge: { groupBy: jest.fn(async ({ where }: any) => comoBanco(vendas, where, (v) => v.tenant_id)) },
      globalSetting: {
        findUnique: jest.fn(async ({ where }: any) => {
          const m = /^BOLETO_(INTRO|DELIVERY)_ENABLED_(.+)$/.exec(where.key);
          if (!m || !flags[m[2]]) return null;
          return { value: String(flags[m[2]][m[1] === 'INTRO' ? 0 : 1]) };
        }),
      },
      treatmentPlan: {
        findMany: jest.fn(async ({ where }: any) => {
          if (where.id?.in) {
            return (where.id.in as string[]).map((id) => {
              const t = id.slice('plan-'.length);
              return { id, patient_id: `pac-${t}`, patient: { name: 'Maria Exemplo', phone: TEL[t] } };
            });
          }
          return [];
        }),
      },
    });
    return { svc: new PaymentAlertsCronService(prisma, SETTINGS) as any, prisma };
  }
  const ancoras = (prisma: any) => prisma.auditLog.create.mock.calls.map((c: any[]) => c[0].data.entity_id);
  const contasLidas = (prisma: any) => prisma.globalSetting.findUnique.mock.calls.map((c: any[]) => c[0].where.key);

  it('sem laboratório cadastrado: mesmo where de antes; apresenta e ancora como antes', async () => {
    const ligado = montar([], [venda(LAB), venda(CLINICA)], { [LAB]: [true, true], [CLINICA]: [true, true] });
    const pick = await ligado.svc.findNextIntro();
    expect(ligado.prisma.paymentGatewayCharge.groupBy.mock.calls[0][0].where).toEqual(WHERE_DE_ANTES);
    expect(pick).toEqual({ planId: `plan-${LAB}`, tenantId: LAB, phone: TEL[LAB], name: 'Maria Exemplo' });

    // Só a entrega ligada: não apresenta, só ancora (é a âncora que libera o carnê D+2).
    const soEntrega = montar([], [venda(LAB)], { [LAB]: [false, true] });
    expect(await soEntrega.svc.findNextIntro()).toBeNull();
    expect(ancoras(soEntrega.prisma)).toEqual([`plan-${LAB}`]);
  });

  it('clínica com OUTRA conta laboratório: where de antes + fora o laboratório; mesma apresentação e âncoras', async () => {
    const vendas = [venda(CLINICA), venda(OUTRA_CLINICA)];
    const flags: Record<string, [boolean, boolean]> = { [CLINICA]: [false, true], [OUTRA_CLINICA]: [true, true] };
    const antes = montar([], vendas, flags);
    const pickAntes = await antes.svc.findNextIntro();
    const depois = montar([LAB], vendas, flags);
    const pickDepois = await depois.svc.findNextIntro();
    expect(depois.prisma.paymentGatewayCharge.groupBy.mock.calls[0][0].where).toEqual({ AND: [WHERE_DE_ANTES, OR_SEM_LAB] });
    expect(pickDepois).toEqual(pickAntes);
    expect(pickAntes).toMatchObject({ planId: `plan-${OUTRA_CLINICA}` });
    expect(ancoras(depois.prisma)).toEqual(ancoras(antes.prisma));
    expect(ancoras(antes.prisma)).toEqual([`plan-${CLINICA}`]);
  });

  it('laboratório: sem apresentação, sem âncora (sem carnê D+2) e sem ler a configuração dele', async () => {
    const ligado = montar([LAB], [venda(LAB), venda(CLINICA)], { [LAB]: [true, true], [CLINICA]: [true, true] });
    expect(await ligado.svc.findNextIntro()).toMatchObject({ planId: `plan-${CLINICA}`, tenantId: CLINICA });
    expect(contasLidas(ligado.prisma).some((k: string) => k.endsWith(LAB))).toBe(false);

    const soEntrega = montar([LAB], [venda(LAB)], { [LAB]: [false, true] });
    expect(await soEntrega.svc.findNextIntro()).toBeNull();
    expect(ancoras(soEntrega.prisma)).toEqual([]);
  });
});

// ─── pesquisa pós-atendimento ───────────────────────────────────────────────

describe('Pesquisa pós-atendimento — laboratório não ganha pesquisa nem recebe', () => {
  const ontem = () => {
    const d = new Date();
    d.setDate(d.getDate() - 1);
    return d;
  };
  const WHERE_SCAN_DE_ANTES = () => ({
    status: 'CONCLUIDO',
    type: 'CONSULTA',
    updated_at: { gte: ontem() },
    post_care_survey: null,
    patient_id: { not: null },
  });
  const WHERE_ENVIO_DE_ANTES = { status: 'PENDING', trigger_at: { lte: AGORA } };
  const evento = (t: string | null, id = `ev-${t}`) => ({
    id,
    tenant_id: t,
    patient_id: `pac-${t}`,
    assigned_user_id: 'dentista-1',
    title: 'Consulta',
    start_at: new Date('2026-10-21T09:00:00.000Z'),
    end_at: new Date('2026-10-21T09:30:00.000Z'),
  });
  const pesquisa = (t: string) => ({
    id: `pesq-${t}`,
    tenant_id: t,
    procedure_summary: 'Consulta',
    patient: { id: `pac-${t}`, name: 'Maria Exemplo', phone: TEL[t], tenant_id: t },
    dentist: { name: 'Ana Exemplo Souza' },
  });
  function montar(labs: string[], eventos: any[], pesquisas: any[]) {
    __limparCacheLabTenants();
    reiniciarEvolution();
    const prisma: any = {
      tenantBusinessProfile: perfis(labs),
      // Config da pesquisa por conta (POST_CARE_CONFIG_<conta>): nenhuma salva; as contas
      // são antigas e herdam a global (ausente = padrão, ligada).
      globalSetting: { findUnique: jest.fn(async () => null), findMany: jest.fn(async () => []) },
      tenant: { findMany: jest.fn(async () => []), findUnique: jest.fn(async () => ({ created_at: new Date('2026-01-01T00:00:00.000Z') })) },
      calendarEvent: { findMany: jest.fn(async ({ where }: any) => comoBanco(eventos, where, (e) => e.tenant_id)) },
      postCareSurvey: {
        create: jest.fn(async () => ({})),
        findMany: jest.fn(async ({ where }: any) => comoBanco(pesquisas, where, (s) => s.tenant_id)),
        update: jest.fn(async () => ({})),
      },
      instance: { findMany: jest.fn(async () => CHIPS) },
    };
    return { svc: new PostCareCronService(prisma, SETTINGS), prisma };
  }
  const efeitos = (prisma: any) => ({
    criadas: prisma.postCareSurvey.create.mock.calls,
    posts: postsDe(),
    atualizadas: prisma.postCareSurvey.update.mock.calls,
  });

  it('sem laboratório cadastrado: mesmos where de antes; cria e envia para todas as contas', async () => {
    const { svc, prisma } = montar([], [evento(CLINICA), evento(LAB)], [pesquisa(CLINICA), pesquisa(LAB)]);
    await svc.tick();
    expect(prisma.calendarEvent.findMany.mock.calls[0][0].where).toEqual(WHERE_SCAN_DE_ANTES());
    expect(prisma.postCareSurvey.findMany.mock.calls[0][0].where).toEqual(WHERE_ENVIO_DE_ANTES);
    expect(prisma.postCareSurvey.create.mock.calls.map((c: any[]) => c[0].data.tenant_id)).toEqual([CLINICA, LAB]);
    expect(postsDe().map((p) => p[1].number)).toEqual([TEL[CLINICA], TEL[LAB]]);
  });

  it('clínica com OUTRA conta laboratório: where de antes + fora o laboratório; mesmas pesquisas', async () => {
    const eventos = [evento(CLINICA), evento(OUTRA_CLINICA)];
    const pesquisas = [pesquisa(CLINICA), pesquisa(OUTRA_CLINICA)];
    const antes = montar([], eventos, pesquisas);
    await antes.svc.tick();
    const esperado = efeitos(antes.prisma);
    const depois = montar([LAB], eventos, pesquisas);
    await depois.svc.tick();
    expect(depois.prisma.calendarEvent.findMany.mock.calls[0][0].where).toEqual({ AND: [WHERE_SCAN_DE_ANTES(), OR_SEM_LAB] });
    expect(depois.prisma.postCareSurvey.findMany.mock.calls[0][0].where).toEqual({
      AND: [WHERE_ENVIO_DE_ANTES, { tenant_id: { notIn: [LAB] } }],
    });
    expect(efeitos(depois.prisma)).toEqual(esperado);
    expect(esperado.posts).toHaveLength(2);
  });

  it('laboratório: consulta dele não ganha pesquisa e a pesquisa dele não sai', async () => {
    const { svc, prisma } = montar([LAB], [evento(LAB), evento(CLINICA)], [pesquisa(LAB), pesquisa(CLINICA)]);
    await svc.tick();
    expect(prisma.postCareSurvey.create.mock.calls.map((c: any[]) => c[0].data.tenant_id)).toEqual([CLINICA]);
    expect(postsPara(TEL[LAB])).toHaveLength(0);
    expect(postsPara(TEL[CLINICA])).toHaveLength(1);
    expect(prisma.postCareSurvey.update.mock.calls.some((c: any[]) => c[0].where.id === `pesq-${LAB}`)).toBe(false);
  });
});

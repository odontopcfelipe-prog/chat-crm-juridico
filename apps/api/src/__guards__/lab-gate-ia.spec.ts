/**
 * F2 do laboratório — freio da IA na API. Laboratório não tem IA em nenhuma camada;
 * a clínica segue EXATAMENTE como antes (mesmas chamadas, mesmos argumentos).
 *
 *  - webhook (handleMessagesUpsert): enfileira a resposta da IA só para clínica;
 *  - robô de admin: em laboratório a mensagem segue como a de um contato;
 *  - memory-op (mensagem do atendente): não enfileira para laboratório;
 *  - isChipAiEnabled (mover de setor liga a IA): false para laboratório.
 *
 * O conjunto de laboratórios vem de TenantBusinessProfile (cache de 60 s, limpo a
 * cada teste). "Sem laboratório" = tabela vazia, o caso de produção hoje.
 */
import { Logger } from '@nestjs/common';
import { __limparCacheLabTenants } from '@crm/shared';
import { EvolutionService } from '../webhooks/evolution.service';
import { MessagesService } from '../messages/messages.service';
import { isChipAiEnabled } from '../settings/chip-ai-enabled.util';

const CLINICA = 'tenant-clinica';
const LAB = 'tenant-lab';

beforeAll(() => {
  jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
});
beforeEach(() => __limparCacheLabTenants());

/** Proxy em que todo método é um jest.fn com resposta neutra (a menos que sobrescrito). */
function autoMock(over: Record<string, any> = {}, padrao: (nome: string, args: any[]) => any = () => undefined): any {
  const fns: Record<string, any> = { ...over };
  return new Proxy(fns, {
    get(alvo, nome: string) {
      if (nome === 'then') return undefined; // não é promessa
      if (!(nome in alvo)) alvo[nome] = jest.fn((...args: any[]) => padrao(nome, args));
      return alvo[nome];
    },
  });
}

/** Prisma falso: findUnique/findFirst=null, findMany=[], create devolve os dados com id. */
function prismaFalso(labs: string[], over: Record<string, Record<string, any>> = {}): any {
  const modelos: Record<string, any> = {
    tenantBusinessProfile: { findMany: jest.fn(async () => labs.map((tenant_id) => ({ tenant_id }))) },
  };
  for (const [m, metodos] of Object.entries(over)) modelos[m] = metodos;
  return new Proxy(modelos, {
    get(alvo, modelo: string) {
      if (modelo === 'then') return undefined;
      if (!(modelo in alvo)) alvo[modelo] = {};
      return autoMockModelo(alvo[modelo], modelo);
    },
  });
}
function autoMockModelo(metodos: Record<string, any>, modelo: string): any {
  return new Proxy(metodos, {
    get(alvo, nome: string) {
      if (nome === 'then') return undefined;
      if (!(nome in alvo)) {
        alvo[nome] = jest.fn(async (args: any) => {
          if (nome === 'findMany' || nome === 'groupBy') return [];
          if (nome === 'count') return 0;
          if (nome === 'updateMany' || nome === 'deleteMany') return { count: 0 };
          if (nome === 'create') return { id: `novo-${modelo}`, ...(args?.data ?? {}) };
          if (nome === 'update') return { id: args?.where?.id ?? `upd-${modelo}`, ...(args?.data ?? {}) };
          if (nome === 'upsert') return { id: `up-${modelo}`, ...(args?.create ?? {}) };
          return null;
        });
      }
      return alvo[nome];
    },
  });
}

// ─── webhook ────────────────────────────────────────────────────────────────

type IdsWebhook = { conv?: string | null; inbox?: string | null; lead?: string | null; chip?: string | null };

/** `conta` vale para conversa, inbox, contato e chip; `ids` troca algum deles (legado/misto). */
function montarWebhook(opts: {
  labs: string[];
  conta: string;
  ids?: IdsWebhook;
  adminDoBot?: { id: string; tenant_id: string } | null;
}) {
  const { labs, conta } = opts;
  const id = (k: keyof IdsWebhook) => (opts.ids && k in opts.ids ? (opts.ids[k] ?? null) : conta);
  const conv = {
    id: 'conv-1',
    tenant_id: id('conv'),
    lead_id: 'lead-1',
    ai_mode: true,
    status: 'ABERTO',
    inbox_id: 'inbox-1',
    instance_name: 'chip-1',
    assigned_user_id: 'u-1',
  };
  const prisma = prismaFalso(labs, {
    conversation: { findFirst: jest.fn(async () => conv), findUnique: jest.fn(async () => conv) },
    instance: { findFirst: jest.fn(async () => ({ purpose: 'COMERCIAL', tenant_id: id('chip'), name: 'chip-1' })) },
    globalSetting: {
      findUnique: jest.fn(async ({ where }: any) => (where.key === 'AI_ENABLED_COMERCIAL' ? { value: 'true' } : null)),
    },
    message: {
      findUnique: jest.fn(async () => null),
      findFirst: jest.fn(async () => null),
      create: jest.fn(async ({ data }: any) => ({ id: 'msg-1', ...data })),
    },
  });
  const aiQueue = { getJob: jest.fn(async () => null), add: jest.fn(async () => ({})) };
  const leads = autoMock({
    upsert: jest.fn(async () => ({ id: 'lead-1', phone: '5582900000001', tenant_id: id('lead'), stage: 'NOVO', is_client: false })),
  });
  const inboxes = autoMock({
    findByInstanceName: jest.fn(async () => ({ inbox_id: 'inbox-1', tenant_id: id('inbox'), purpose: 'COMERCIAL', name: 'chip-1' })),
    getNextAssignee: jest.fn(async () => null),
  });
  const gateway = autoMock({ getOnlineUserIds: jest.fn(() => []) });
  const adminBot = autoMock({
    isEnabled: jest.fn(async () => !!opts.adminDoBot),
    isAdminCommand: jest.fn(() => true),
    findAdminByPhone: jest.fn(async () => opts.adminDoBot ?? null),
    handle: jest.fn(async () => undefined),
  });
  const moduleRef = { get: jest.fn(() => autoMock({}, () => Promise.resolve(null))) };
  const evo = new EvolutionService(
    prisma,
    gateway,
    leads,
    inboxes,
    autoMock({}, () => Promise.resolve({})),
    aiQueue as any,
    autoMock({}, () => Promise.resolve({})),
    moduleRef as any,
    adminBot,
    autoMock({}, () => Promise.resolve(null)),
    autoMock({}, () => Promise.resolve(null)),
  );
  const payload: any = {
    instance: 'chip-1',
    data: {
      key: { remoteJid: '5582900000001@s.whatsapp.net', fromMe: false, id: 'EXT-1' },
      pushName: 'Contato Exemplo',
      message: { conversation: 'oi, tudo bem?' },
      messageType: 'conversation',
      messageTimestamp: 1761400000,
    },
  };
  return { evo, prisma, aiQueue, adminBot, payload };
}

const jobsDaIa = (aiQueue: any) =>
  aiQueue.add.mock.calls.filter((c: any[]) => c[0] === 'process_ai_response' && c[2]?.jobId === 'ai-debounce-conv-1');

describe('webhook — a IA responde só na clínica', () => {
  it('clínica sem laboratório cadastrado: enfileira a resposta da IA como hoje', async () => {
    const { evo, aiQueue, payload } = montarWebhook({ labs: [], conta: CLINICA });
    await evo.handleMessagesUpsert(payload);
    const jobs = jobsDaIa(aiQueue);
    expect(jobs).toHaveLength(1);
    expect(jobs[0][1]).toEqual({ conversation_id: 'conv-1', lead_id: 'lead-1' });
    expect(jobs[0][2]).toEqual({ jobId: 'ai-debounce-conv-1', delay: 8000, removeOnComplete: true, removeOnFail: false });
  });

  it('clínica com OUTRA conta laboratório cadastrada: igual', async () => {
    const { evo, aiQueue, payload } = montarWebhook({ labs: [LAB], conta: CLINICA });
    await evo.handleMessagesUpsert(payload);
    expect(jobsDaIa(aiQueue)).toHaveLength(1);
  });

  it('conversa de laboratório: a IA não é enfileirada (mesmo com AI_ENABLED_COMERCIAL global ligado)', async () => {
    const { evo, aiQueue, payload } = montarWebhook({ labs: [LAB], conta: LAB });
    await evo.handleMessagesUpsert(payload);
    expect(jobsDaIa(aiQueue)).toHaveLength(0);
    expect(aiQueue.add.mock.calls.filter((c: any[]) => c[0] === 'process_ai_response')).toHaveLength(0);
  });

  const LEGADO = { conv: null, inbox: null, lead: null } as const;

  it('legado sem conta (conversa, inbox e contato), chip de clínica: enfileira como hoje', async () => {
    const { evo, aiQueue, payload } = montarWebhook({ labs: [LAB], conta: CLINICA, ids: { ...LEGADO, chip: CLINICA } });
    await evo.handleMessagesUpsert(payload);
    expect(jobsDaIa(aiQueue)).toHaveLength(1);
  });

  it('legado sem conta (conversa, inbox e contato), chip do laboratório: não enfileira', async () => {
    const { evo, aiQueue, payload } = montarWebhook({ labs: [LAB], conta: CLINICA, ids: { ...LEGADO, chip: LAB } });
    await evo.handleMessagesUpsert(payload);
    expect(jobsDaIa(aiQueue)).toHaveLength(0);
  });

  // Dado cruzado (não deveria existir): conversa, inbox e chip da clínica com o
  // contato marcado como laboratório. Na dúvida, a IA não responde.
  it('dado cruzado — conversa da clínica, contato do laboratório: não enfileira', async () => {
    const { evo, aiQueue, payload } = montarWebhook({ labs: [LAB], conta: CLINICA, ids: { lead: LAB } });
    await evo.handleMessagesUpsert(payload);
    expect(jobsDaIa(aiQueue)).toHaveLength(0);
  });

  it('conversa e chip sem conta, contato do laboratório: não enfileira', async () => {
    const { evo, aiQueue, payload } = montarWebhook({ labs: [LAB], conta: CLINICA, ids: { conv: null, inbox: null, chip: null, lead: LAB } });
    await evo.handleMessagesUpsert(payload);
    expect(jobsDaIa(aiQueue)).toHaveLength(0);
  });
});

describe('webhook — robô de admin', () => {
  it('clínica: o comando do admin vai para o robô e não vira mensagem de contato', async () => {
    const { evo, adminBot, prisma, payload } = montarWebhook({
      labs: [LAB],
      conta: CLINICA,
      adminDoBot: { id: 'adm-1', tenant_id: CLINICA },
    });
    await evo.handleMessagesUpsert(payload);
    expect(adminBot.handle).toHaveBeenCalledTimes(1);
    expect(adminBot.handle).toHaveBeenCalledWith('chip-1', '5582900000001', 'oi, tudo bem?', 'adm-1', CLINICA);
    expect(prisma.message.create).not.toHaveBeenCalled();
  });

  it('laboratório: o robô não atende e a mensagem segue como a de um contato', async () => {
    const { evo, adminBot, prisma, payload } = montarWebhook({
      labs: [LAB],
      conta: LAB,
      adminDoBot: { id: 'adm-lab', tenant_id: LAB },
    });
    await evo.handleMessagesUpsert(payload);
    expect(adminBot.handle).not.toHaveBeenCalled();
    expect(prisma.message.create).toHaveBeenCalled();
  });

  // Inbox legada sem conta: o admin é procurado em todas as contas, e o único sinal
  // de laboratório é a conta do próprio admin.
  it('inbox legada sem conta + admin de clínica: o robô atende como hoje', async () => {
    const { evo, adminBot, payload } = montarWebhook({
      labs: [LAB],
      conta: CLINICA,
      ids: { inbox: null },
      adminDoBot: { id: 'adm-1', tenant_id: CLINICA },
    });
    await evo.handleMessagesUpsert(payload);
    expect(adminBot.handle).toHaveBeenCalledWith('chip-1', '5582900000001', 'oi, tudo bem?', 'adm-1', CLINICA);
  });

  it('inbox legada sem conta + admin de laboratório: o robô não atende', async () => {
    const { evo, adminBot, prisma, payload } = montarWebhook({
      labs: [LAB],
      conta: CLINICA,
      ids: { inbox: null },
      adminDoBot: { id: 'adm-lab', tenant_id: LAB },
    });
    await evo.handleMessagesUpsert(payload);
    expect(adminBot.handle).not.toHaveBeenCalled();
    expect(prisma.message.create).toHaveBeenCalled();
  });

  it('inbox do laboratório + admin de outra conta: o robô não atende', async () => {
    const { evo, adminBot, payload } = montarWebhook({
      labs: [LAB],
      conta: LAB,
      adminDoBot: { id: 'adm-1', tenant_id: CLINICA },
    });
    await evo.handleMessagesUpsert(payload);
    expect(adminBot.handle).not.toHaveBeenCalled();
  });
});

// ─── memory-op (mensagem do atendente) ──────────────────────────────────────

function montarMensagens(labs: string[]) {
  const prisma = prismaFalso(labs);
  const aiQueue = { getJob: jest.fn(async () => null), add: jest.fn(async () => ({})) };
  const svc: any = new MessagesService(
    prisma,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    aiQueue as any,
  );
  return { svc, aiQueue };
}

describe('memory-op — só enfileira para clínica', () => {
  it('clínica: mesmo job de antes (nome, dados e opções)', async () => {
    const { svc, aiQueue } = montarMensagens([LAB]);
    await svc.enqueueMemoryUpdate('conv-9', 'lead-9', [CLINICA, CLINICA]);
    expect(aiQueue.add).toHaveBeenCalledTimes(1);
    expect(aiQueue.add).toHaveBeenCalledWith(
      'process_ai_response',
      { conversation_id: 'conv-9', lead_id: 'lead-9' },
      { jobId: 'memory-op-conv-9', delay: 15_000, removeOnComplete: true, removeOnFail: false },
    );
  });

  it('conversa legada sem conta: enfileira como antes', async () => {
    const { svc, aiQueue } = montarMensagens([LAB]);
    await svc.enqueueMemoryUpdate('conv-9', 'lead-9', [null, undefined]);
    expect(aiQueue.add).toHaveBeenCalledTimes(1);
  });

  it('laboratório (pela conversa ou pelo contato): não enfileira', async () => {
    const a = montarMensagens([LAB]);
    await a.svc.enqueueMemoryUpdate('conv-9', 'lead-9', [LAB, LAB]);
    expect(a.aiQueue.add).not.toHaveBeenCalled();
    __limparCacheLabTenants();
    const b = montarMensagens([LAB]);
    await b.svc.enqueueMemoryUpdate('conv-9', 'lead-9', [null, LAB]);
    expect(b.aiQueue.add).not.toHaveBeenCalled();
  });
});

// ─── isChipAiEnabled (mover de setor) ───────────────────────────────────────

function prismaChaves(labs: string[], tenantVal: string | null, globalVal: string | null, kill: string | null): any {
  return {
    tenantBusinessProfile: { findMany: jest.fn(async () => labs.map((tenant_id) => ({ tenant_id }))) },
    tenantSetting: { findUnique: jest.fn(async () => (tenantVal == null ? null : { value: tenantVal })) },
    globalSetting: {
      findUnique: jest.fn(async ({ where }: any) => {
        if (where.key === 'WHATSAPP_AI_ENABLED') return kill == null ? null : { value: kill };
        return globalVal == null ? null : { value: globalVal };
      }),
    },
  };
}

describe('isChipAiEnabled — laboratório sempre desligado, clínica igual', () => {
  const casos: Array<[string | null, string | null, string | null, boolean]> = [
    // [TenantSetting, GlobalSetting AI_ENABLED_<P>, kill switch, resultado da clínica]
    [null, null, null, true],
    [null, 'true', null, true],
    [null, 'false', null, false],
    ['true', 'false', null, true],
    ['false', 'true', null, false],
    [null, null, 'false', false],
  ];
  it.each(casos)('clínica: tenant=%s global=%s kill=%s → %s', async (t, g, k, esperado) => {
    __limparCacheLabTenants();
    expect(await isChipAiEnabled(prismaChaves([LAB], t, g, k), CLINICA, 'COMERCIAL')).toBe(esperado);
  });

  it.each(casos)('laboratório: tenant=%s global=%s kill=%s → false', async (t, g, k) => {
    __limparCacheLabTenants();
    expect(await isChipAiEnabled(prismaChaves([LAB], t, g, k), LAB, 'COMERCIAL')).toBe(false);
  });
});

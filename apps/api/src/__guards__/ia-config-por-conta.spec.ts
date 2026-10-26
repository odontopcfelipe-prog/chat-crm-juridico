/**
 * Ajustes IA › "Conectar a IA", o liga/desliga por chip e os Custos de IA.
 *
 *  - Chaves OpenAI/Admin/Anthropic, modelo padrão, DJEN e o liga/desliga geral
 *    antigo são da PLATAFORMA: só o SUPER_ADMIN grava; vindos da clínica num
 *    salvamento misto são ignorados (200, lista `ignorados`), nunca 403.
 *  - Tempo de resposta padrão e robô de comando são DA CLÍNICA
 *    (`AI_COOLDOWN_SECONDS_<conta>`, `ADMIN_BOT_ENABLED_<conta>`): o webhook e o
 *    robô decidem pela conta da conversa/chip.
 *  - Custos de IA: a clínica vê só o consumo dela; o SUPER_ADMIN, a plataforma.
 */
import * as fs from 'fs';
import * as path from 'path';
import { BadRequestException, ForbiddenException, Logger } from '@nestjs/common';
import { __limparCacheContaLegada, __limparCacheLabTenants, aiProfileKey } from '@crm/shared';
import { SettingsController } from '../settings/settings.controller';
import { SettingsService } from '../settings/settings.service';
import { AdminBotService } from '../admin-bot/admin-bot.service';
import { EvolutionService } from '../webhooks/evolution.service';
import { isSensitiveKey } from '../common/utils/crypto.util';

const A = '0a0a0a0a-0000-4000-8000-00000000000a';
const B = '0b0b0b0b-0000-4000-8000-00000000000b';
const NOVA = '0c0c0c0c-0000-4000-8000-00000000000c';
const CRIACAO: Record<string, Date> = {
  [A]: new Date('2025-01-10T10:00:00Z'),
  [B]: new Date('2026-02-20T10:00:00Z'),
  [NOVA]: new Date('2026-11-02T10:00:00Z'),
};

const ADMIN_A = { id: 'u-a', roles: ['ADMIN'], tenant_id: A };
const ADMIN_B = { id: 'u-b', roles: ['ADMIN'], tenant_id: B };
const ADMIN_NOVA = { id: 'u-c', roles: ['ADMIN'], tenant_id: NOVA };
const ADMIN_SEM_CONTA = { id: 'u-x', roles: ['ADMIN'], tenant_id: null };
const DONO = { id: 'u-dono', roles: ['ADMIN', 'SUPER_ADMIN'], tenant_id: A };
const SUPER_SEM_CONTA = { id: 'u-s', roles: ['SUPER_ADMIN', 'ADMIN'], tenant_id: null };

const PLATAFORMA = [
  'OPENAI_API_KEY',
  'OPENAI_ADMIN_KEY',
  'ANTHROPIC_API_KEY',
  'OPENAI_DEFAULT_MODEL',
  'DJEN_AI_MODEL',
  'DJEN_SYSTEM_PROMPT',
  'DJEN_CLIENT_NOTIFY_TEMPLATE',
  'WHATSAPP_AI_ENABLED',
];

const ENC_ANTES = process.env.ENCRYPTION_KEY;
beforeAll(() => {
  process.env.ENCRYPTION_KEY = 'chave-somente-teste';
  for (const m of ['log', 'warn', 'debug', 'error'] as const) {
    jest.spyOn(Logger.prototype, m).mockImplementation(() => undefined);
  }
});
afterAll(() => {
  if (ENC_ANTES === undefined) delete process.env.ENCRYPTION_KEY;
  else process.env.ENCRYPTION_KEY = ENC_ANTES;
});
beforeEach(() => {
  __limparCacheContaLegada();
  __limparCacheLabTenants();
});
afterEach(() => jest.restoreAllMocks());

function montar(inicial: Record<string, string>, opts: { falhaNaLeitura?: boolean } = {}) {
  const store = new Map<string, string>(Object.entries(inicial));
  const prisma: any = {
    globalSetting: {
      findMany: jest.fn(async () => [...store.keys()].sort().map((key) => ({ key, value: store.get(key)! }))),
      findUnique: jest.fn(async ({ where }: any) => {
        if (opts.falhaNaLeitura) throw new Error('banco fora');
        return store.has(where.key) ? { key: where.key, value: store.get(where.key)! } : null;
      }),
      upsert: jest.fn(async ({ where, create, update }: any) => {
        store.set(where.key, store.has(where.key) ? update.value : create.value);
        return { key: where.key, value: store.get(where.key) };
      }),
    },
    tenant: {
      findUnique: jest.fn(async ({ where, select }: any) => {
        if (!CRIACAO[where.id]) return null;
        if (select?.created_at) return { created_at: CRIACAO[where.id] };
        return { name: 'Clínica', phone: null, email: null, business_hours: null };
      }),
    },
    tenantBusinessProfile: { findMany: jest.fn(async () => []) },
    tenantSetting: {
      findMany: jest.fn(async () => []),
      findUnique: jest.fn(async () => null),
      upsert: jest.fn(async ({ create }: any) => create),
    },
    organizationProfile: { findUnique: jest.fn(async () => null) },
    aiUsage: {
      aggregate: jest.fn(async () => ({ _sum: { cost_usd: 1, total_tokens: 10, prompt_tokens: 6, completion_tokens: 4 }, _count: { id: 2 } })),
      groupBy: jest.fn(async () => []),
    },
  };
  const service = new SettingsService(prisma);
  const ctl = new SettingsController(service, {} as any, {} as any, prisma, {} as any);
  const gravadas = () => prisma.globalSetting.upsert.mock.calls.map((c: any[]) => c[0].where.key);
  return { ctl, service, store, prisma, gravadas };
}

const req = (user: any) => ({ user });
const negado = (e: any) => {
  expect(e).toBeInstanceOf(ForbiddenException);
  expect((e as ForbiddenException).getResponse()).toMatchObject({ code: 'PERMISSION_DENIED' });
};

/** O que a tela antiga (JS em cache) manda num "Salvar Configurações". */
const PAYLOAD_TELA_ANTIGA = {
  defaultModel: 'gpt-4o',
  djenModel: 'gpt-4o',
  djenPrompt: '',
  djenNotifyTemplate: '',
  adminBotEnabled: false,
  whatsappAiEnabled: false,
  cooldownSeconds: 0,
  apiKey: 'sk-chave-digitada-teste',
  adminKey: 'sk-admin-digitada-teste',
  anthropicApiKey: 'sk-ant-digitada-teste',
};

const BANCO_DE_HOJE = {
  OPENAI_API_KEY: 'sk-proj-plataforma-0000000000',
  OPENAI_DEFAULT_MODEL: 'gpt-4.1-mini',
  WHATSAPP_AI_ENABLED: 'true',
  AI_COOLDOWN_SECONDS: '12',
  ADMIN_BOT_ENABLED: 'false',
};

describe('Ajustes IA: plataforma × clínica', () => {
  describe('a clínica não grava a plataforma nem a configuração de outra conta', () => {
    it('ADMIN da B com o payload da tela antiga: 200, plataforma ignorada, tempo e robô só na B', async () => {
      const { ctl, store, gravadas } = montar(BANCO_DE_HOJE);
      const r = await ctl.setAiConfig(req(ADMIN_B), { ...PAYLOAD_TELA_ANTIGA });
      expect(r).toEqual({
        message: 'Configurações de IA salvas com sucesso',
        ignorados: ['apiKey', 'adminKey', 'anthropicApiKey', 'defaultModel', 'djenModel', 'djenPrompt', 'djenNotifyTemplate', 'whatsappAiEnabled'],
      });
      expect(gravadas().sort()).toEqual([`ADMIN_BOT_ENABLED_${B}`, `AI_COOLDOWN_SECONDS_${B}`].sort());
      expect(store.get(`AI_COOLDOWN_SECONDS_${B}`)).toBe('0');
      expect(store.get(`ADMIN_BOT_ENABLED_${B}`)).toBe('false');
      for (const k of [...PLATAFORMA, 'AI_COOLDOWN_SECONDS', 'ADMIN_BOT_ENABLED']) {
        expect(store.get(k)).toBe((BANCO_DE_HOJE as any)[k]);
      }
    });

    it('o que a B salva não muda o que a A vê', async () => {
      const { ctl } = montar(BANCO_DE_HOJE);
      await ctl.setAiConfig(req(ADMIN_B), { adminBotEnabled: true, cooldownSeconds: 3 });
      const daA = await ctl.getAiConfig(req(ADMIN_A));
      expect(daA).toMatchObject({ cooldownSeconds: 12, adminBotEnabled: false });
      const daB = await ctl.getAiConfig(req(ADMIN_B));
      expect(daB).toMatchObject({ cooldownSeconds: 3, adminBotEnabled: true });
    });

    it('GET para a clínica: sem nenhum pedaço da chave da plataforma, com os sim/não', async () => {
      const { ctl } = montar(BANCO_DE_HOJE);
      const r: any = await ctl.getAiConfig(req(ADMIN_A));
      expect(r.apiKey).toBeNull();
      expect(r.isConfigured).toBe(true);
      expect(JSON.stringify(r)).not.toContain('sk-p');
      expect(JSON.stringify(r)).not.toContain('0000');
    });

    it('ai-chip-toggle: com conta grava só na TenantSetting da conta (nunca a global)', async () => {
      const { ctl, prisma } = montar({});
      expect(await ctl.setAiChipToggle(req(ADMIN_B), { purpose: 'COMERCIAL', enabled: false })).toEqual({
        ok: true,
        purpose: 'COMERCIAL',
        enabled: false,
      });
      expect(prisma.tenantSetting.upsert.mock.calls[0][0].where).toEqual({ tenant_id_key: { tenant_id: B, key: 'AI_ENABLED_COMERCIAL' } });
      expect(prisma.globalSetting.upsert).not.toHaveBeenCalled();
    });
  });

  describe('a tela da clínica continua salvando', () => {
    it('payload novo da tela da clínica ({adminBotEnabled, cooldownSeconds}): 200, nada ignorado', async () => {
      const { ctl, store } = montar(BANCO_DE_HOJE);
      expect(await ctl.setAiConfig(req(ADMIN_A), { adminBotEnabled: true, cooldownSeconds: 20 })).toEqual({
        message: 'Configurações de IA salvas com sucesso',
        ignorados: [],
      });
      expect(store.get(`AI_COOLDOWN_SECONDS_${A}`)).toBe('20');
      expect(store.get(`ADMIN_BOT_ENABLED_${A}`)).toBe('true');
    });

    it('tempo fora de 0..60 (vindo do GET) é limitado, não recusado; não-número dá 400 sem gravar', async () => {
      const { ctl, store, prisma } = montar({});
      for (const [enviado, gravado] of [[61, '60'], [-1, '0'], [7.6, '8'], ['15', '15'], [600, '60']] as Array<[any, string]>) {
        await ctl.setAiConfig(req(ADMIN_A), { cooldownSeconds: enviado });
        expect(store.get(`AI_COOLDOWN_SECONDS_${A}`)).toBe(gravado);
      }
      prisma.globalSetting.upsert.mockClear();
      for (const ruim of ['x', {}, true, NaN]) {
        const e = await ctl.setAiConfig(req(ADMIN_A), { cooldownSeconds: ruim as any, adminBotEnabled: false }).catch((x) => x);
        expect(e).toBeInstanceOf(BadRequestException);
      }
      expect(prisma.globalSetting.upsert).not.toHaveBeenCalled();
    });

    it('o valor que o GET devolve volta no salvar sem erro (ida e volta)', async () => {
      const { ctl } = montar({ AI_COOLDOWN_SECONDS: '75' });
      const cfg: any = await ctl.getAiConfig(req(ADMIN_B));
      await expect(ctl.setAiConfig(req(ADMIN_B), { adminBotEnabled: cfg.adminBotEnabled, cooldownSeconds: cfg.cooldownSeconds })).resolves.toBeTruthy();
    });

    it('GET: mesmo formato (mesmas chaves) para a clínica e para o dono', async () => {
      const { ctl } = montar(BANCO_DE_HOJE);
      const clinica: any = await ctl.getAiConfig(req(ADMIN_A));
      const dono: any = await ctl.getAiConfig(req(DONO));
      expect(Object.keys(clinica).sort()).toEqual(Object.keys(dono).sort());
      expect(dono.apiKey).toMatch(/^sk-p\*+0000$/);
    });

    it('erro do banco na leitura: o GET responde com o padrão (8s, robô ligado), nunca 500', async () => {
      const { ctl } = montar(BANCO_DE_HOJE, { falhaNaLeitura: true });
      await expect(ctl.getAiConfig(req(ADMIN_A))).resolves.toMatchObject({ cooldownSeconds: 8, adminBotEnabled: true });
    });

    it('perfil da IA: o "Usar o padrão (Xs)" mostra o tempo da clínica; erro do banco = 8', async () => {
      const { ctl } = montar({ AI_COOLDOWN_SECONDS: '12', [`AI_COOLDOWN_SECONDS_${A}`]: '4' });
      expect((await ctl.getAiProfile(req(ADMIN_A))).defaults).toEqual({ cooldownSeconds: 4 });
      expect((await ctl.getAiProfile(req(ADMIN_B))).defaults).toEqual({ cooldownSeconds: 12 });
      expect((await ctl.getAiProfile(req(ADMIN_NOVA))).defaults).toEqual({ cooldownSeconds: 8 });
      const ruim = montar({ AI_COOLDOWN_SECONDS: '12' }, { falhaNaLeitura: true });
      expect((await ruim.ctl.getAiProfile(req(ADMIN_A))).defaults).toEqual({ cooldownSeconds: 8 });
    });
  });

  describe('conta legada herda a global antiga; conta nova não', () => {
    it('legada sem a própria: tempo e robô globais; nova: 8 e ligado; com a própria: a dela', async () => {
      const { ctl } = montar({ ...BANCO_DE_HOJE, [`AI_COOLDOWN_SECONDS_${A}`]: '2', [`ADMIN_BOT_ENABLED_${A}`]: 'true' });
      expect(await ctl.getAiConfig(req(ADMIN_B))).toMatchObject({ cooldownSeconds: 12, adminBotEnabled: false });
      expect(await ctl.getAiConfig(req(ADMIN_NOVA))).toMatchObject({ cooldownSeconds: 8, adminBotEnabled: true });
      expect(await ctl.getAiConfig(req(ADMIN_A))).toMatchObject({ cooldownSeconds: 2, adminBotEnabled: true });
    });
  });

  describe('o dono (SUPER_ADMIN com conta) e o SUPER_ADMIN sem conta', () => {
    it('dono: chaves e modelo na plataforma; tempo e robô na conta dele; globais intactas', async () => {
      const { ctl, store } = montar(BANCO_DE_HOJE);
      const r = await ctl.setAiConfig(req(DONO), { ...PAYLOAD_TELA_ANTIGA, cooldownSeconds: 5, adminBotEnabled: true });
      expect(r.ignorados).toEqual([]);
      expect(store.get('OPENAI_API_KEY')).toMatch(/^enc:/);
      expect(store.get('OPENAI_DEFAULT_MODEL')).toBe('gpt-4o');
      expect(store.get('WHATSAPP_AI_ENABLED')).toBe('false');
      expect(store.get(`AI_COOLDOWN_SECONDS_${A}`)).toBe('5');
      expect(store.get(`ADMIN_BOT_ENABLED_${A}`)).toBe('true');
      expect(store.get('AI_COOLDOWN_SECONDS')).toBe('12');
      expect(store.get('ADMIN_BOT_ENABLED')).toBe('false');
    });

    it('a chave Anthropic passa a ser guardada criptografada e sai mascarada na lista do SUPER_ADMIN', async () => {
      const { ctl, store } = montar({});
      await ctl.setAiConfig(req(DONO), { anthropicApiKey: 'sk-ant-nova-teste' });
      expect(store.get('ANTHROPIC_API_KEY')).toMatch(/^enc:/);
      expect(isSensitiveKey('ANTHROPIC_API_KEY')).toBe(true);
      const lista: any[] = await ctl.getAll(req(SUPER_SEM_CONTA));
      expect(lista.find((s) => s.key === 'ANTHROPIC_API_KEY')?.value).toBe('********');
      expect((await ctl.getAiConfig(req(DONO))).isAnthropicKeyConfigured).toBe(true);
    });

    it('SUPER_ADMIN sem conta: tempo e robô vão para a global antiga', async () => {
      const { ctl, store, gravadas } = montar(BANCO_DE_HOJE);
      await ctl.setAiConfig(req(SUPER_SEM_CONTA), { cooldownSeconds: 9, adminBotEnabled: true });
      expect(gravadas().sort()).toEqual(['ADMIN_BOT_ENABLED', 'AI_COOLDOWN_SECONDS']);
      expect(store.get('AI_COOLDOWN_SECONDS')).toBe('9');
    });

    it('ADMIN sem conta: 403 e nada gravado (nem a plataforma)', async () => {
      const { ctl, prisma } = montar(BANCO_DE_HOJE);
      negado(await ctl.setAiConfig(req(ADMIN_SEM_CONTA), { ...PAYLOAD_TELA_ANTIGA }).catch((e) => e));
      negado(await ctl.setAiConfig(req(ADMIN_SEM_CONTA), { adminBotEnabled: true }).catch((e) => e));
      expect(prisma.globalSetting.upsert).not.toHaveBeenCalled();
    });

    it('ai-chip-toggle: ADMIN sem conta 403 (sem gravar a global); SUPER_ADMIN sem conta grava a global', async () => {
      const { ctl, prisma, gravadas } = montar({});
      negado(await ctl.setAiChipToggle(req(ADMIN_SEM_CONTA), { purpose: 'COMERCIAL', enabled: false }).catch((e) => e));
      expect(prisma.globalSetting.upsert).not.toHaveBeenCalled();
      expect(prisma.tenantSetting.upsert).not.toHaveBeenCalled();
      await ctl.setAiChipToggle(req(SUPER_SEM_CONTA), { purpose: 'COMERCIAL', enabled: false });
      expect(gravadas()).toEqual(['AI_ENABLED_COMERCIAL']);
    });
  });
});

// ─── Custos de IA ────────────────────────────────────────────────────────────

describe('Custos de IA', () => {
  function semRede() {
    return jest.spyOn(global, 'fetch' as any).mockImplementation(async (url: any) => {
      if (String(url).includes('awesomeapi')) return { ok: true, json: async () => ({ USDBRL: { bid: '5.5' } }) } as any;
      return { ok: true, json: async () => ({ data: [], has_more: false, next_page: null }) } as any;
    });
  }
  const wheres = (prisma: any) => [
    ...prisma.aiUsage.aggregate.mock.calls.map((c: any[]) => c[0].where),
    ...prisma.aiUsage.groupBy.mock.calls.map((c: any[]) => c[0].where),
  ];

  it('ADMIN da B: as 5 consultas levam a conta B, sem Admin Key nem OpenAI', async () => {
    const fetch = semRede();
    const { ctl, prisma } = montar({ OPENAI_ADMIN_KEY: 'sk-admin-plataforma' });
    const r: any = await ctl.getAiCosts(req(ADMIN_B));
    expect(r.escopo).toBe('clinica');
    expect(r.openai.configured).toBe(false);
    const ws = wheres(prisma);
    expect(ws).toHaveLength(5);
    for (const w of ws) expect(w.tenant_id).toBe(B);
    expect(prisma.globalSetting.findUnique.mock.calls.map((c: any[]) => c[0].where.key)).not.toContain('OPENAI_ADMIN_KEY');
    expect(fetch.mock.calls.map((c: any[]) => String(c[0])).filter((u: string) => u.includes('openai'))).toEqual([]);
    expect(r.month).toMatchObject({ calls: 2 });
  });

  it('ADMIN sem conta: zerado, 200, sem consultar o consumo', async () => {
    semRede();
    const { ctl, prisma } = montar({ OPENAI_ADMIN_KEY: 'sk-admin-plataforma' });
    const r: any = await ctl.getAiCosts(req(ADMIN_SEM_CONTA));
    expect(r).toMatchObject({ escopo: 'clinica', today: { calls: 0, cost_usd: 0 }, month: { calls: 0 }, byModel: [], byType: [] });
    expect(prisma.aiUsage.aggregate).not.toHaveBeenCalled();
    expect(prisma.aiUsage.groupBy).not.toHaveBeenCalled();
  });

  it('SUPER_ADMIN (o dono, com conta): a plataforma inteira e a OpenAI, como antes', async () => {
    const fetch = semRede();
    const { ctl, prisma } = montar({ OPENAI_ADMIN_KEY: 'sk-admin-plataforma' });
    const r: any = await ctl.getAiCosts(req(DONO));
    expect(r.escopo).toBe('plataforma');
    expect(r.openai.configured).toBe(true);
    for (const w of wheres(prisma)) expect(w).not.toHaveProperty('tenant_id');
    expect(fetch.mock.calls.some((c: any[]) => String(c[0]).includes('api.openai.com'))).toBe(true);
  });
});

// ─── Webhook e robô de comando ──────────────────────────────────────────────

function autoMock(over: Record<string, any> = {}, padrao: () => any = () => undefined): any {
  const fns: Record<string, any> = { ...over };
  return new Proxy(fns, {
    get(alvo, nome: string) {
      if (nome === 'then') return undefined;
      if (!(nome in alvo)) alvo[nome] = jest.fn(() => padrao());
      return alvo[nome];
    },
  });
}

function prismaWebhook(store: Map<string, string>, perfilDelay: number | null): any {
  const modelos: Record<string, any> = {
    tenantBusinessProfile: { findMany: jest.fn(async () => []) },
    tenant: { findUnique: jest.fn(async ({ where }: any) => (CRIACAO[where.id] ? { created_at: CRIACAO[where.id] } : null)) },
    globalSetting: {
      findUnique: jest.fn(async ({ where }: any) => (store.has(where.key) ? { key: where.key, value: store.get(where.key) } : null)),
    },
    tenantSetting: {
      findUnique: jest.fn(async ({ where }: any) =>
        perfilDelay !== null && where.tenant_id_key?.key === aiProfileKey('COMERCIAL')
          ? { value: JSON.stringify({ responseDelaySec: perfilDelay }) }
          : null,
      ),
    },
  };
  const metodoNeutro = (modelo: string) => (nome: string) =>
    jest.fn(async (args: any) => {
      if (nome === 'findMany' || nome === 'groupBy') return [];
      if (nome === 'count') return 0;
      if (nome === 'updateMany' || nome === 'deleteMany') return { count: 0 };
      if (nome === 'create') return { id: `novo-${modelo}`, ...(args?.data ?? {}) };
      if (nome === 'update') return { id: args?.where?.id ?? `upd-${modelo}`, ...(args?.data ?? {}) };
      if (nome === 'upsert') return { id: `up-${modelo}`, ...(args?.create ?? {}) };
      return null;
    });
  return new Proxy(modelos, {
    get(alvo, modelo: string) {
      if (modelo === 'then') return undefined;
      if (!(modelo in alvo)) alvo[modelo] = {};
      const metodos = alvo[modelo];
      const novo = metodoNeutro(modelo);
      return new Proxy(metodos, {
        get(m, nome: string) {
          if (nome === 'then') return undefined;
          if (!(nome in m)) m[nome] = novo(nome);
          return m[nome];
        },
      });
    },
  });
}

async function webhook(conta: string, banco: Record<string, string>, opts: { perfilDelay?: number | null } = {}) {
  const store = new Map(Object.entries({ AI_ENABLED_COMERCIAL: 'true', ...banco }));
  const prisma = prismaWebhook(store, opts.perfilDelay ?? null);
  const conv = { id: 'conv-1', tenant_id: conta, lead_id: 'lead-1', ai_mode: true, status: 'ABERTO', inbox_id: 'inbox-1', instance_name: 'chip-1', assigned_user_id: 'u-1' };
  prisma.conversation = { findFirst: jest.fn(async () => conv), findUnique: jest.fn(async () => conv) };
  prisma.instance = { findFirst: jest.fn(async () => ({ purpose: 'COMERCIAL', tenant_id: conta, name: 'chip-1' })) };
  prisma.message = { findUnique: jest.fn(async () => null), findFirst: jest.fn(async () => null), create: jest.fn(async ({ data }: any) => ({ id: 'msg-1', ...data })) };
  const aiQueue: any = { getJob: jest.fn(async () => null), add: jest.fn(async () => ({})) };
  const adminBot = autoMock({ isEnabled: jest.fn(async () => false), isAdminCommand: jest.fn(() => false) });
  const evo = new EvolutionService(
    prisma,
    autoMock({ getOnlineUserIds: jest.fn(() => []) }),
    autoMock({ upsert: jest.fn(async () => ({ id: 'lead-1', phone: '5582900000001', tenant_id: conta, stage: 'NOVO', is_client: false })) }),
    autoMock({ findByInstanceName: jest.fn(async () => ({ inbox_id: 'inbox-1', tenant_id: conta, purpose: 'COMERCIAL', name: 'chip-1' })), getNextAssignee: jest.fn(async () => null) }),
    autoMock({}, () => Promise.resolve({})),
    aiQueue as any,
    autoMock({}, () => Promise.resolve({})),
    { get: jest.fn(() => autoMock({}, () => Promise.resolve(null))) } as any,
    adminBot,
    autoMock({}, () => Promise.resolve(null)),
    autoMock({}, () => Promise.resolve(null)),
  );
  await evo.handleMessagesUpsert({
    instance: 'chip-1',
    data: {
      key: { remoteJid: '5582900000001@s.whatsapp.net', fromMe: false, id: 'EXT-1' },
      pushName: 'Contato Exemplo',
      message: { conversation: 'oi, tudo bem?' },
      messageType: 'conversation',
      messageTimestamp: 1761400000,
    },
  } as any);
  const job = aiQueue.add.mock.calls.find((c: any[]) => c[0] === 'process_ai_response' && c[2]?.jobId === 'ai-debounce-conv-1');
  return { delay: job?.[2]?.delay as number | undefined, adminBot };
}

describe('Webhook: tempo de resposta e robô de comando da clínica da conversa', () => {
  const GLOBAL_12 = { AI_COOLDOWN_SECONDS: '12' };

  it('conta com tempo próprio usa o dela; a outra clínica não é afetada', async () => {
    const banco = { ...GLOBAL_12, [`AI_COOLDOWN_SECONDS_${A}`]: '3' };
    expect((await webhook(A, banco)).delay).toBe(3000);
    expect((await webhook(B, banco)).delay).toBe(12000);
  });

  it('legada sem tempo próprio: o global antigo (como hoje); conta nova: 8s', async () => {
    expect((await webhook(B, GLOBAL_12)).delay).toBe(12000);
    expect((await webhook(NOVA, GLOBAL_12)).delay).toBe(8000);
  });

  it('o tempo do perfil do chip continua vencendo', async () => {
    expect((await webhook(A, { ...GLOBAL_12, [`AI_COOLDOWN_SECONDS_${A}`]: '3' }, { perfilDelay: 5 })).delay).toBe(5000);
  });

  it('o webhook pergunta ao robô pela clínica dona do chip', async () => {
    const { adminBot } = await webhook(B, {});
    expect(adminBot.isEnabled).toHaveBeenCalledWith(B);
  });

  it('AdminBot.isEnabled: cada conta com o seu (cache separado); sem conta = global', async () => {
    const store = new Map<string, string>([
      ['ADMIN_BOT_ENABLED', 'true'],
      [`ADMIN_BOT_ENABLED_${A}`, 'false'],
    ]);
    const prisma = prismaWebhook(store, null);
    const bot = new AdminBotService(prisma, {} as any, {} as any, {} as any, {} as any, {} as any);
    expect(await bot.isEnabled(A)).toBe(false);
    expect(await bot.isEnabled(B)).toBe(true);
    expect(await bot.isEnabled(null)).toBe(true);
    store.set('ADMIN_BOT_ENABLED', 'false');
    // B legada ficou no cache (60 s) com o valor que leu; nova conta lê agora: padrão ligado.
    expect(await bot.isEnabled(B)).toBe(true);
    expect(await bot.isEnabled(NOVA)).toBe(true);
    bot.clearEnabledCache();
    expect(await bot.isEnabled(B)).toBe(false);
    expect(await bot.isEnabled(A)).toBe(false);
  });
});

describe('AdminBot.isEnabled — a entrada sem conta não serve para a clínica', () => {
  it('o "sem conta" em cache não é usado para B nem para a conta nova', async () => {
    const store = new Map<string, string>([['ADMIN_BOT_ENABLED', 'false']]);
    const prisma = prismaWebhook(store, null);
    const bot = new AdminBotService(prisma, {} as any, {} as any, {} as any, {} as any, {} as any);
    expect(await bot.isEnabled(null)).toBe(false);
    store.set('ADMIN_BOT_ENABLED', 'true');
    // B (legada) lê agora a global antiga; a conta nova, o padrão — nenhuma usa o "sem conta" guardado.
    expect(await bot.isEnabled(B)).toBe(true);
    expect(await bot.isEnabled(NOVA)).toBe(true);
    expect(await bot.isEnabled(null)).toBe(false);
  });
});

describe('GET /settings/whatsapp-config — trechos da chave só para o administrador do sistema', () => {
  const CHAVE = 'chave-de-exemplo-do-servidor-0123456789';
  function controller() {
    const settings: any = {
      getWhatsAppConfig: jest.fn(async () => ({ apiUrl: 'https://evo.exemplo.test', apiKey: CHAVE, webhookUrl: 'https://api.exemplo.test/webhooks/evolution' })),
    };
    return new SettingsController(settings, {} as any, {} as any, {} as any, {} as any);
  }
  it('ADMIN de clínica: só sabe que existe (sem trecho da chave), mesmo formato', async () => {
    const r: any = await controller().getWhatsAppConfig({ user: { tenant_id: A, roles: ['ADMIN'] } });
    expect(r).toEqual({ apiUrl: 'https://evo.exemplo.test', apiKey: '********', webhookUrl: 'https://api.exemplo.test/webhooks/evolution' });
  });
  it('SUPER_ADMIN: o mascarado de hoje (início e fim)', async () => {
    const r: any = await controller().getWhatsAppConfig({ user: { tenant_id: A, roles: ['ADMIN', 'SUPER_ADMIN'] } });
    expect(r.apiKey.startsWith(CHAVE.slice(0, 4))).toBe(true);
    expect(r.apiKey.endsWith(CHAVE.slice(-4))).toBe(true);
  });
});

// ─── Tela (leitura do código) ──────────────────────────────────────────────

describe('Telas: o gate também no front', () => {
  const web = path.resolve(__dirname, '../../../web/src/app/atendimento/settings');

  it('Ajustes IA: a clínica manda só robô e tempo; chaves, modelo e DJEN só para o SUPER_ADMIN', () => {
    const p = fs.readFileSync(path.join(web, 'ai/page.tsx'), 'utf8');
    expect(p).toMatch(/const payload: any = isSuperAdmin\s*\?/);
    expect(p).toContain(': { adminBotEnabled, cooldownSeconds };');
    expect(p).not.toMatch(/whatsappAiEnabled,\s*cooldownSeconds/);
    expect(p).toMatch(/isSuperAdmin && apiKey\.trim\(\)/);
    expect(p).toMatch(/isSuperAdmin && adminKey\.trim\(\)/);
    expect(p).toMatch(/isSuperAdmin && anthropicKey\.trim\(\)/);
    // Modelo padrão e DJEN: dentro de um bloco só do SUPER_ADMIN.
    const modelo = p.indexOf('Modelo padrão (Chat / Skills)</label>');
    const abreModelo = p.lastIndexOf('{isSuperAdmin && (<>', modelo);
    expect(modelo).toBeGreaterThan(-1);
    expect(abreModelo).toBeGreaterThan(-1);
    expect(p.indexOf('</>)}', abreModelo)).toBeGreaterThan(modelo);
    expect(p.lastIndexOf('</>)}', modelo)).toBeLessThan(abreModelo);
    const chaves = p.indexOf('API Key OpenAI</label>');
    const abre = p.lastIndexOf('{isSuperAdmin && (<>', chaves);
    expect(abre).toBeGreaterThan(-1);
    expect(p.indexOf('</>)}', abre)).toBeGreaterThan(p.indexOf('API Key Anthropic Claude</label>'));
    expect(p).not.toContain('este padrão vale para TODAS as clínicas');
  });

  it('Custos IA: a clínica não vê o aviso da Admin Key nem o link da OpenAI', () => {
    const p = fs.readFileSync(path.join(web, 'costs/page.tsx'), 'utf8');
    expect(p).toContain("const daClinica   = data.escopo === 'clinica';");
    expect(p).toContain('{!daClinica && !openai.configured && (');
    expect(p).toMatch(/\{!daClinica && \(\s*<a href="https:\/\/platform\.openai\.com\/usage"/);
    // Rodapé "Fontes de dados": para a clínica, a estimativa dela (sem mandar configurar a Admin Key).
    expect(p).toMatch(/\{daClinica \? \(\s*<p>\s*Estimativa pelas chamadas de IA registradas da sua clínica/);
    const rodape = p.indexOf('Fatura oficial:');
    expect(p.lastIndexOf('{!daClinica && (', rodape)).toBeGreaterThan(p.indexOf('Fontes de dados'));
  });
});

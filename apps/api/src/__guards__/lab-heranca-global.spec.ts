/**
 * F2 parte 3a do laboratório — HERANÇA CENTRAL da configuração global.
 *
 * Regra: cada conta tem a sua configuração; da GlobalSetting (chave → valor, sem
 * conta) o laboratório só usa o que é da PLATAFORMA (GLOBAIS_DA_PLATAFORMA de
 * @crm/shared). Nada de configuração, texto, liga/desliga ou conta de terceiro
 * das clínicas.
 *
 *  - getTenantSetting: reserva na global só para chave da plataforma; o resto é a
 *    TenantSetting do laboratório e o env;
 *  - AsaasClient.getConfig / hasOwnAccount: só a conta Asaas do laboratório; sem
 *    chave própria, a mesma resposta "Asaas não configurado"; base URL só a dele;
 *  - horário do escritório (loadOfficeHoursValues e o que monta horário a partir
 *    dele): só o do laboratório, senão o padrão do código; a IA fora do expediente
 *    nunca vem ligada da global;
 *  - conta legada (contaLegada / lerConfigDaConta): laboratório nunca é.
 *
 * Cada freio tem três casos: (a) sem laboratório cadastrado (o caso de produção
 * hoje) = mesmas leituras, na mesma ordem, e o mesmo resultado de antes; (b)
 * clínica com OUTRA conta laboratório = igual ao (a); (c) laboratório = não herda.
 * A leitura da lista de laboratórios (TenantBusinessProfile, cache de 60 s) é a
 * única coisa nova para a clínica e fica fora do rastro.
 *
 * Repositório público: contas, chaves e endereços fictícios.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as ts from 'typescript';
import { Logger, ServiceUnavailableException } from '@nestjs/common';
import {
  GLOBAIS_DA_PLATAFORMA,
  OFFICE_HOURS_KEYS,
  __limparCacheContaLegada,
  __limparCacheLabTenants,
  computeBusinessHoursInfo,
  contaLegada,
  eGlobalDaPlataforma,
  globalValeParaConta,
  isAfterHoursAiEnabled,
  lerConfigDaConta,
  loadBusinessHoursSettings,
  loadOfficeHoursValues,
  podeLerGlobal,
} from '@crm/shared';
import { getTenantSetting, invalidateAllSettings } from '../tenants/tenant-settings.helper';

// ─── Dados de exemplo (repositório público: nada real) ───────────────────────
const CLINICA = 'tenant-clinica';
const OUTRA_CLINICA = 'tenant-clinica-2';
const LAB = 'tenant-lab';
const ANTES_DO_CORTE = new Date('2025-03-01T12:00:00.000Z');
const DEPOIS_DO_CORTE = new Date('2026-11-05T12:00:00.000Z');

// ─── Carregador do AsaasClient ───────────────────────────────────────────────
// O getConfig faz `await import('../../tenants/tenant-settings.helper.js')`, que o
// jest deste projeto não executa (sem --experimental-vm-modules). O arquivo de
// produção é transpilado para CommonJS e o import dinâmico vira require do mesmo
// módulo (mesmo cache do getTenantSetting que este spec limpa).
const RAIZ_SRC = path.resolve(__dirname, '..');
const OPCOES_TS = (() => {
  const raizApi = path.resolve(RAIZ_SRC, '..');
  const lido = ts.readConfigFile(path.join(raizApi, 'tsconfig.json'), ts.sys.readFile);
  const { options } = ts.convertCompilerOptionsFromJson(lido.config.compilerOptions, raizApi);
  return {
    ...options,
    module: ts.ModuleKind.CommonJS,
    moduleResolution: ts.ModuleResolutionKind.Node10,
    resolvePackageJsonExports: undefined,
    sourceMap: false,
    inlineSourceMap: false,
    declaration: false,
    incremental: false,
  };
})();
function carregarFonte(relativo: string): any {
  const arquivo = path.join(RAIZ_SRC, relativo);
  const { outputText } = ts.transpileModule(fs.readFileSync(arquivo, 'utf8'), {
    fileName: arquivo,
    compilerOptions: OPCOES_TS,
  });
  const modulo = { exports: {} as any };
  const requerer = (id: string) =>
    require(id.startsWith('.') ? path.resolve(path.dirname(arquivo), id.replace(/\.js$/, '')) : id);
  new Function('exports', 'require', 'module', '__filename', '__dirname', outputText)(
    modulo.exports, requerer, modulo, arquivo, path.dirname(arquivo),
  );
  return modulo.exports;
}
const { AsaasClient } = carregarFonte('payment-gateway/asaas/asaas-client.ts');

// ─── Logs ([LAB-GATE] e avisos conferidos; nada vai para o console) ──────────
let logs: { nivel: string; msg: string }[] = [];
beforeAll(() => {
  for (const nivel of ['log', 'warn', 'debug', 'error', 'verbose'] as const) {
    jest.spyOn(Logger.prototype, nivel).mockImplementation((msg: any) => {
      logs.push({ nivel, msg: String(msg) });
    });
  }
});
const envOriginal = { ...process.env };
beforeEach(() => {
  logs = [];
  __limparCacheLabTenants();
  __limparCacheContaLegada();
  invalidateAllSettings();
});
afterEach(() => {
  jest.useRealTimers();
  for (const k of Object.keys(process.env)) if (!(k in envOriginal)) delete process.env[k];
  Object.assign(process.env, envOriginal);
});
const registrou = (trecho: string) => logs.some((l) => l.msg.includes(trecho));
/** Relógio falso: só a data é falsa; promessas e timers seguem reais. */
function relogio(agora: Date): void {
  jest.useFakeTimers({
    now: agora,
    doNotFake: [
      'nextTick', 'setImmediate', 'clearImmediate', 'setTimeout', 'clearTimeout',
      'setInterval', 'clearInterval', 'queueMicrotask', 'hrtime', 'performance',
    ],
  });
}

// ─── Banco falso ─────────────────────────────────────────────────────────────

type Op = [string, any];
type Estado = {
  /** Contas de laboratório (TenantBusinessProfile LABORATORIO). */
  labs?: string[];
  /** A leitura da lista de laboratórios falha. */
  labsFalha?: boolean;
  /** TenantSetting: `${conta}|${chave}` → valor. */
  propria?: Record<string, string>;
  /** GlobalSetting: chave → valor. */
  global?: Record<string, string>;
  /** Tenant.created_at por conta. */
  criada?: Record<string, Date>;
};

/**
 * Grava cada leitura (menos a da lista de laboratórios) e responde pelo estado,
 * que o teste pode mudar no meio (ex.: a conta vira laboratório).
 */
function banco(e: Estado) {
  const ops: Op[] = [];
  const grava = (op: string, args: any) => ops.push([op, args]);
  const perfis = jest.fn(async (_args: any) => {
    if (e.labsFalha) throw new Error('banco fora');
    return (e.labs ?? []).map((tenant_id) => ({ tenant_id }));
  });
  const linhasPropria = (conta: string, chaves: string[]) =>
    Object.entries(e.propria ?? {})
      .map(([k, value]) => ({ tenant_id: k.split('|')[0], key: k.split('|')[1], value }))
      .filter((l) => l.tenant_id === conta && chaves.includes(l.key));
  const prisma: any = {
    tenantBusinessProfile: { findMany: perfis },
    tenantSetting: {
      findUnique: jest.fn(async (args: any) => {
        grava('tenantSetting.findUnique', args);
        const { tenant_id, key } = args.where.tenant_id_key;
        const v = (e.propria ?? {})[`${tenant_id}|${key}`];
        return v === undefined ? null : { tenant_id, key, value: v };
      }),
      findMany: jest.fn(async (args: any) => {
        grava('tenantSetting.findMany', args);
        return linhasPropria(args.where.tenant_id, args.where.key.in);
      }),
    },
    globalSetting: {
      findUnique: jest.fn(async (args: any) => {
        grava('globalSetting.findUnique', args);
        const v = (e.global ?? {})[args.where.key];
        return v === undefined ? null : { key: args.where.key, value: v };
      }),
      findMany: jest.fn(async (args: any) => {
        grava('globalSetting.findMany', args);
        return Object.entries(e.global ?? {})
          .filter(([k]) => args.where.key.in.includes(k))
          .map(([key, value]) => ({ key, value }));
      }),
    },
    tenant: {
      findUnique: jest.fn(async (args: any) => {
        grava('tenant.findUnique', args);
        const c = (e.criada ?? {})[args.where.id];
        return c ? { created_at: c } : null;
      }),
    },
    holiday: {
      findFirst: jest.fn(async (args: any) => {
        grava('holiday.findFirst', args);
        return null;
      }),
    },
    $queryRaw: jest.fn(async (..._args: any[]) => {
      grava('$queryRaw', null);
      return [];
    }),
  };
  /** Chaves da GlobalSetting lidas (findUnique), na ordem. */
  const globaisLidas = () =>
    ops.filter(([o]) => o === 'globalSetting.findUnique').map(([, a]) => a.where.key as string);
  return { prisma, ops, perfis, globaisLidas, e };
}

// ═════════════════════════════════════════════════════════════════════════════
// Lista da plataforma (função pura)
// ═════════════════════════════════════════════════════════════════════════════

describe('GLOBAIS_DA_PLATAFORMA — o que o laboratório pode ler da GlobalSetting', () => {
  it('IA (créditos e modelos), servidor Evolution, SMTP, Web Push e vigias de operação são da plataforma', () => {
    for (const k of [
      'OPENAI_API_KEY', 'OPENAI_ADMIN_KEY', 'ANTHROPIC_API_KEY', 'OPENAI_DEFAULT_MODEL',
      'AI_ROUTER_MODEL', 'MEMORY_EXTRACTION_MODEL', 'MEMORY_ORG_MODEL', 'SMILE_DESIGN_MODEL',
      'EVOLUTION_API_URL', 'EVOLUTION_GLOBAL_APIKEY', 'WEBHOOK_URL', 'EVOLUTION_BASE_URL', 'EVOLUTION_API_KEY',
      'SMTP_HOST', 'SMTP_PASS', 'VAPID_PUBLIC_KEY', 'VAPID_PRIVATE_KEY', 'DISK_SENTINEL_90',
      'AVATAR_AUTOBACKFILL_OFF', 'REATIVACAO_LEADS_OFF', 'AI_FINANCEIRO_SEND_OFF', 'asaas_webhook_token',
    ]) {
      expect([k, eGlobalDaPlataforma(k)]).toEqual([k, true]);
    }
  });

  it('configuração, texto, liga/desliga e conta de terceiro das clínicas NÃO são', () => {
    for (const k of [
      'asaas_api_key', 'asaas_sandbox', 'ASAAS_GLOBAL_OWNER_TENANT', 'ASAAS_BASE_URL', 'ASAAS_API_KEY',
      'EVOLUTION_INSTANCE_NAME', 'WHATSAPP_AI_ENABLED', 'AI_ENABLED_COMERCIAL', 'AI_COOLDOWN_SECONDS',
      'GDRIVE_CONFIG', 'GA4_PROPERTY_ID', 'CLICKSIGN_API_TOKEN', 'CLICKSIGN_BASE_URL',
      'RECALL_MESSAGE_TEMPLATE', 'RECALL_DEFAULT_MONTHS', 'DESCONTO_AVISTA_PCT', 'CONTRACT_CONFIG',
      'CRM_CONFIG', 'CANNED_RESPONSES', 'TTS_ENABLED', 'GOOGLE_TTS_API_KEY', 'CLINIC_ADDRESS',
      ...OFFICE_HOURS_KEYS,
      // prefixo sozinho, minúsculas e vazio também não
      'SMTP_', 'openai_api_key', '', null, undefined, 42,
    ]) {
      expect([k, eGlobalDaPlataforma(k)]).toEqual([k, false]);
    }
  });

  it('a lista não traz chave de clínica nem prefixo largo demais', () => {
    expect(GLOBAIS_DA_PLATAFORMA.prefixos).toEqual(['SMTP_', 'VAPID_', 'DISK_SENTINEL_']);
    expect(GLOBAIS_DA_PLATAFORMA.chaves).not.toContain('asaas_api_key');
    expect(GLOBAIS_DA_PLATAFORMA.chaves).not.toContain('ASAAS_GLOBAL_OWNER_TENANT');
  });

  it('globalValeParaConta: clínica sempre (como hoje); laboratório só a chave da plataforma', () => {
    expect(globalValeParaConta(false, 'RECALL_DEFAULT_MONTHS')).toBe(true);
    expect(globalValeParaConta(false, 'OPENAI_API_KEY')).toBe(true);
    expect(globalValeParaConta(true, 'OPENAI_API_KEY')).toBe(true);
    expect(globalValeParaConta(true, 'RECALL_DEFAULT_MONTHS')).toBe(false);
  });

  it('podeLerGlobal: sem conta ou chave da plataforma não consulta nada; clínica true; laboratório só plataforma', async () => {
    const b = banco({ labs: [LAB] });
    expect(await podeLerGlobal(b.prisma, null, 'RECALL_DEFAULT_MONTHS')).toBe(true);
    expect(await podeLerGlobal(b.prisma, '', 'RECALL_DEFAULT_MONTHS')).toBe(true);
    expect(await podeLerGlobal(b.prisma, LAB, 'EVOLUTION_BASE_URL')).toBe(true);
    expect(b.perfis).not.toHaveBeenCalled();
    expect(await podeLerGlobal(b.prisma, CLINICA, 'RECALL_DEFAULT_MONTHS')).toBe(true);
    expect(await podeLerGlobal(b.prisma, LAB, 'RECALL_DEFAULT_MONTHS')).toBe(false);
    __limparCacheLabTenants();
    expect(await podeLerGlobal(banco({ labs: [] }).prisma, LAB, 'RECALL_DEFAULT_MONTHS')).toBe(true);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// getTenantSetting
// ═════════════════════════════════════════════════════════════════════════════

describe('getTenantSetting — laboratório só herda da global a chave da plataforma', () => {
  const GLOBAL = {
    RECALL_DEFAULT_MONTHS: '9',
    DESCONTO_AVISTA_PCT: '15',
    CLICKSIGN_BASE_URL: 'https://clicksign-global.exemplo.test',
    EVOLUTION_BASE_URL: 'https://evo-plataforma.exemplo.test',
    EVOLUTION_API_KEY: 'apikey-plataforma-exemplo',
  };

  /** As leituras da clínica, na ordem em que o código de produção as faz. */
  async function rodadaDaClinica(labs: string[]) {
    const b = banco({
      labs,
      global: GLOBAL,
      propria: { [`${CLINICA}|DESCONTO_AVISTA_PCT`]: '12' },
    });
    process.env.CLICKSIGN_ENV_EXEMPLO = 'https://clicksign-env.exemplo.test';
    const r = [
      await getTenantSetting(b.prisma, 'RECALL_DEFAULT_MONTHS', CLINICA, undefined),
      await getTenantSetting(b.prisma, 'DESCONTO_AVISTA_PCT', CLINICA, undefined),
      await getTenantSetting(b.prisma, 'CHAVE_QUE_NINGUEM_TEM', CLINICA, 'CLICKSIGN_ENV_EXEMPLO'),
      await getTenantSetting(b.prisma, 'EVOLUTION_BASE_URL', CLINICA, 'EVOLUTION_BASE_URL'),
      await getTenantSetting(b.prisma, 'RECALL_DEFAULT_MONTHS', null, undefined),
      // 2ª leitura da mesma conta+chave vem do cache (nenhuma consulta)
      await getTenantSetting(b.prisma, 'RECALL_DEFAULT_MONTHS', CLINICA, undefined),
    ];
    return { r, ops: b.ops };
  }

  it('(a) clínica, sem laboratório: TenantSetting → GlobalSetting → env, como antes', async () => {
    const { r, ops } = await rodadaDaClinica([]);
    expect(r).toEqual(['9', '12', 'https://clicksign-env.exemplo.test', 'https://evo-plataforma.exemplo.test', '9', '9']);
    const ts = (key: string) => ['tenantSetting.findUnique', { where: { tenant_id_key: { tenant_id: CLINICA, key } } }];
    const gs = (key: string) => ['globalSetting.findUnique', { where: { key } }];
    expect(ops).toEqual([
      ts('RECALL_DEFAULT_MONTHS'), gs('RECALL_DEFAULT_MONTHS'),
      ts('DESCONTO_AVISTA_PCT'),
      ts('CHAVE_QUE_NINGUEM_TEM'), gs('CHAVE_QUE_NINGUEM_TEM'),
      ts('EVOLUTION_BASE_URL'), gs('EVOLUTION_BASE_URL'),
      gs('RECALL_DEFAULT_MONTHS'),
    ]);
  });

  it('(b) clínica com OUTRA conta laboratório: as mesmas leituras e os mesmos valores', async () => {
    const sem = await rodadaDaClinica([]);
    invalidateAllSettings();
    __limparCacheLabTenants();
    const com = await rodadaDaClinica([LAB]);
    expect(com).toEqual(sem);
  });

  it('(c) laboratório: chave de clínica não cai na global (só a dele, senão o env, senão null)', async () => {
    const b = banco({ labs: [LAB], global: GLOBAL });
    process.env.CLICKSIGN_BASE_URL = 'https://clicksign-env.exemplo.test';
    expect(await getTenantSetting(b.prisma, 'RECALL_DEFAULT_MONTHS', LAB, undefined)).toBeNull();
    expect(await getTenantSetting(b.prisma, 'DESCONTO_AVISTA_PCT', LAB, undefined)).toBeNull();
    expect(await getTenantSetting(b.prisma, 'CLICKSIGN_BASE_URL', LAB, 'CLICKSIGN_BASE_URL')).toBe('https://clicksign-env.exemplo.test');
    expect(b.globaisLidas()).toEqual([]);
  });

  it('(c) laboratório: a própria TenantSetting vale; chave da plataforma segue lendo a global', async () => {
    const b = banco({ labs: [LAB], global: GLOBAL, propria: { [`${LAB}|RECALL_DEFAULT_MONTHS`]: '4' } });
    expect(await getTenantSetting(b.prisma, 'RECALL_DEFAULT_MONTHS', LAB, undefined)).toBe('4');
    expect(await getTenantSetting(b.prisma, 'EVOLUTION_BASE_URL', LAB, 'EVOLUTION_BASE_URL')).toBe('https://evo-plataforma.exemplo.test');
    expect(await getTenantSetting(b.prisma, 'EVOLUTION_API_KEY', LAB, 'EVOLUTION_API_KEY')).toBe('apikey-plataforma-exemplo');
    expect(b.globaisLidas()).toEqual(['EVOLUTION_BASE_URL', 'EVOLUTION_API_KEY']);
  });

  it('cache por conta+chave: o valor da clínica não serve ao laboratório, nem o contrário', async () => {
    const b = banco({ labs: [LAB], global: GLOBAL });
    // clínica primeiro, depois o laboratório
    expect(await getTenantSetting(b.prisma, 'RECALL_DEFAULT_MONTHS', CLINICA, undefined)).toBe('9');
    expect(await getTenantSetting(b.prisma, 'RECALL_DEFAULT_MONTHS', LAB, undefined)).toBeNull();
    // laboratório primeiro, depois outra clínica (e a global sem conta)
    expect(await getTenantSetting(b.prisma, 'DESCONTO_AVISTA_PCT', LAB, undefined)).toBeNull();
    expect(await getTenantSetting(b.prisma, 'DESCONTO_AVISTA_PCT', OUTRA_CLINICA, undefined)).toBe('15');
    expect(await getTenantSetting(b.prisma, 'DESCONTO_AVISTA_PCT', null, undefined)).toBe('15');
    // as 2as leituras vêm do cache de cada conta
    expect(await getTenantSetting(b.prisma, 'RECALL_DEFAULT_MONTHS', LAB, undefined)).toBeNull();
    expect(await getTenantSetting(b.prisma, 'RECALL_DEFAULT_MONTHS', CLINICA, undefined)).toBe('9');
    expect(b.globaisLidas()).toEqual(['RECALL_DEFAULT_MONTHS', 'DESCONTO_AVISTA_PCT', 'DESCONTO_AVISTA_PCT']);
  });

  it('sem conta (SUPER_ADMIN, chamada legada): a global, sem perguntar pelo laboratório', async () => {
    const b = banco({ labs: [LAB], global: GLOBAL });
    expect(await getTenantSetting(b.prisma, 'RECALL_DEFAULT_MONTHS', undefined, undefined)).toBe('9');
    expect(b.perfis).not.toHaveBeenCalled();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Asaas (API)
// ═════════════════════════════════════════════════════════════════════════════

describe('AsaasClient.getConfig / hasOwnAccount — laboratório só usa a conta Asaas dele', () => {
  const GLOBAL_ASAAS = {
    asaas_api_key: 'chave-asaas-global-exemplo',
    asaas_sandbox: 'true',
    asaas_webhook_token: 'token-webhook-exemplo',
  };
  const PRODUCAO = 'https://api.asaas.com/v3';
  const SANDBOX = 'https://api-sandbox.asaas.com/v3';

  function montar(e: Estado) {
    const b = banco(e);
    const settings = {
      get: jest.fn(async (key: string) => {
        b.ops.push(['settings.get', key]);
        return (e.global ?? {})[key] ?? null;
      }),
    };
    const asaas = new AsaasClient(settings as any, b.prisma);
    return { asaas, settings, ...b };
  }

  /** A clínica em quatro situações: sem dono, dono outra, dona, chave própria. */
  async function rodadaDaClinica(labs: string[]) {
    const saidas: any[] = [];
    const rastros: Op[][] = [];
    const cenarios: Estado[] = [
      { global: { ...GLOBAL_ASAAS } },
      { global: { ...GLOBAL_ASAAS, ASAAS_GLOBAL_OWNER_TENANT: OUTRA_CLINICA } },
      { global: { ...GLOBAL_ASAAS, ASAAS_GLOBAL_OWNER_TENANT: CLINICA } },
      {
        global: { ...GLOBAL_ASAAS, ASAAS_GLOBAL_OWNER_TENANT: OUTRA_CLINICA },
        propria: { [`${CLINICA}|ASAAS_API_KEY`]: 'chave-propria-clinica', [`${CLINICA}|ASAAS_BASE_URL`]: 'https://api.asaas.com' },
      },
    ];
    for (const c of cenarios) {
      invalidateAllSettings();
      __limparCacheLabTenants();
      const m = montar({ ...c, labs });
      saidas.push([await m.asaas.getConfig(CLINICA), await m.asaas.hasOwnAccount(CLINICA), await m.asaas.isConfigured(CLINICA)]);
      rastros.push(m.ops);
    }
    return { saidas, rastros };
  }

  it('(a) clínica, sem laboratório: as quatro situações de hoje', async () => {
    const { saidas, rastros } = await rodadaDaClinica([]);
    expect(saidas).toEqual([
      // sem dono da global: herda a chave global (legado) e o flag de sandbox
      [{ apiKey: 'chave-asaas-global-exemplo', baseUrl: SANDBOX, sandbox: true, webhookToken: 'token-webhook-exemplo' }, false, true],
      // dono é OUTRA clínica: bloqueada
      [{ apiKey: '', baseUrl: SANDBOX, sandbox: true, webhookToken: 'token-webhook-exemplo' }, false, false],
      // ela é a dona: usa a global
      [{ apiKey: 'chave-asaas-global-exemplo', baseUrl: SANDBOX, sandbox: true, webhookToken: 'token-webhook-exemplo' }, true, true],
      // chave e base URL próprias
      [{ apiKey: 'chave-propria-clinica', baseUrl: PRODUCAO, sandbox: false, webhookToken: 'token-webhook-exemplo' }, true, true],
    ]);
    const ts = (key: string) => ['tenantSetting.findUnique', { where: { tenant_id_key: { tenant_id: CLINICA, key } } }];
    const gs = (key: string) => ['globalSetting.findUnique', { where: { key } }];
    const get = (key: string) => ['settings.get', key];
    expect(rastros[0].slice(0, 7)).toEqual([
      ts('ASAAS_API_KEY'), gs('ASAAS_GLOBAL_OWNER_TENANT'), get('asaas_api_key'),
      ts('ASAAS_BASE_URL'), gs('ASAAS_BASE_URL'), get('asaas_sandbox'), get('asaas_webhook_token'),
    ]);
    expect(registrou(`tenant ${CLINICA} sem chave propria e nao e o dono da global`)).toBe(true);
  });

  it('(b) clínica com OUTRA conta laboratório: mesmas leituras e mesma configuração', async () => {
    const sem = await rodadaDaClinica([]);
    const com = await rodadaDaClinica([LAB]);
    expect(com).toEqual(sem);
  });

  it('sem conta (mensalidade da plataforma, webhook): a global, como hoje, com ou sem laboratório', async () => {
    const sem = montar({ global: { ...GLOBAL_ASAAS, ASAAS_API_KEY: 'chave-sistema-exemplo' } });
    const a = await sem.asaas.getConfig();
    invalidateAllSettings();
    const com = montar({ labs: [LAB], global: { ...GLOBAL_ASAAS, ASAAS_API_KEY: 'chave-sistema-exemplo' } });
    expect(await com.asaas.getConfig()).toEqual(a);
    expect(com.ops).toEqual(sem.ops);
    expect(a.apiKey).toBe('chave-sistema-exemplo');
    expect(com.perfis).not.toHaveBeenCalled();
  });

  it('(c) laboratório sem chave própria: apiKey vazia mesmo sem dono da global; nada global de conta é lido', async () => {
    const m = montar({ labs: [LAB], global: { ...GLOBAL_ASAAS, ASAAS_BASE_URL: 'https://api-sandbox.asaas.com' } });
    const cfg = await m.asaas.getConfig(LAB);
    expect(cfg).toEqual({ apiKey: '', baseUrl: PRODUCAO, sandbox: false, webhookToken: 'token-webhook-exemplo' });
    expect(m.settings.get.mock.calls.map((c: any[]) => c[0])).toEqual(['asaas_webhook_token']);
    expect(m.globaisLidas()).toEqual([]);
    expect(registrou(`[LAB-GATE] asaas — conta ${LAB}`)).toBe(true);
    expect(await m.asaas.hasOwnAccount(LAB)).toBe(false);
    expect(await m.asaas.isConfigured(LAB)).toBe(false);
  });

  it('(c) laboratório dono da global (regra das clínicas): continua sem chave', async () => {
    const m = montar({ labs: [LAB], global: { ...GLOBAL_ASAAS, ASAAS_GLOBAL_OWNER_TENANT: LAB } });
    expect((await m.asaas.getConfig(LAB)).apiKey).toBe('');
    expect(await m.asaas.hasOwnAccount(LAB)).toBe(false);
    expect(m.settings.get).not.toHaveBeenCalledWith('asaas_api_key');
    expect(m.globaisLidas()).toEqual([]);
  });

  it('(c) laboratório com conta própria: a chave e a base URL dele', async () => {
    const m = montar({
      labs: [LAB],
      global: { ...GLOBAL_ASAAS, asaas_sandbox: 'false' },
      propria: { [`${LAB}|ASAAS_API_KEY`]: 'chave-propria-lab', [`${LAB}|ASAAS_BASE_URL`]: 'https://api-sandbox.asaas.com' },
    });
    expect(await m.asaas.getConfig(LAB)).toEqual({
      apiKey: 'chave-propria-lab',
      baseUrl: SANDBOX,
      sandbox: true,
      webhookToken: 'token-webhook-exemplo',
    });
    expect(await m.asaas.hasOwnAccount(LAB)).toBe(true);
    expect(m.settings.get).not.toHaveBeenCalledWith('asaas_sandbox');
  });

  it('(c) laboratório sem chave: a operação recebe o MESMO erro "Asaas não configurado" da clínica bloqueada', async () => {
    const lab = montar({ labs: [LAB], global: { ...GLOBAL_ASAAS } });
    const bloqueada = montar({ labs: [LAB], global: { ...GLOBAL_ASAAS, ASAAS_GLOBAL_OWNER_TENANT: OUTRA_CLINICA } });
    const erroLab = await lab.asaas.getBalance(LAB).catch((e: unknown) => e);
    const erroClinica = await bloqueada.asaas.getBalance(CLINICA).catch((e: unknown) => e);
    expect(erroLab).toBeInstanceOf(ServiceUnavailableException);
    expect((erroLab as any).getResponse()).toEqual((erroClinica as any).getResponse());
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Horário do escritório
// ═════════════════════════════════════════════════════════════════════════════

describe('loadOfficeHoursValues e o que monta horário — laboratório não herda o horário global', () => {
  const GLOBAL_HORARIO = {
    AFTER_HOURS_AI_ENABLED: 'true',
    AFTER_HOURS_START: '19:00',
    AFTER_HOURS_END: '07:00',
    BUSINESS_DAYS: '1,2,3,4,5,6',
    TIMEZONE: 'America/Recife',
  };
  const argsGlobal = { where: { key: { in: [...OFFICE_HOURS_KEYS] } } };
  const argsDaConta = (t: string) => ({ where: { tenant_id: t, key: { in: [...OFFICE_HOURS_KEYS, 'AI_CLINIC_HOURS'] } } });

  async function rodadaDaClinica(labs: string[]) {
    const b = banco({ labs, global: GLOBAL_HORARIO, propria: { [`${CLINICA}|AFTER_HOURS_START`]: '18:00' } });
    const valores = await loadOfficeHoursValues(b.prisma, CLINICA);
    const settings = await loadBusinessHoursSettings(b.prisma, CLINICA);
    const semConta = await loadOfficeHoursValues(b.prisma, null);
    return { valores, settings: { ...settings, businessDays: [...settings.businessDays] }, semConta, ops: b.ops };
  }

  it('(a) clínica, sem laboratório: a dela vence a global chave a chave, como antes', async () => {
    const r = await rodadaDaClinica([]);
    expect(r.valores).toEqual({
      values: { ...GLOBAL_HORARIO, AFTER_HOURS_START: '18:00' },
      ownKeys: ['AFTER_HOURS_START'],
      clinicHours: null,
    });
    expect(r.settings).toEqual({
      start: { h: 18, m: 0 },
      end: { h: 7, m: 0 },
      businessDays: [1, 2, 3, 4, 5, 6],
      timezone: 'America/Recife',
      clinicHours: null,
    });
    expect(r.semConta).toEqual({ values: GLOBAL_HORARIO, ownKeys: [], clinicHours: null });
    expect(r.ops).toEqual([
      ['globalSetting.findMany', argsGlobal], ['tenantSetting.findMany', argsDaConta(CLINICA)],
      ['globalSetting.findMany', argsGlobal], ['tenantSetting.findMany', argsDaConta(CLINICA)],
      ['globalSetting.findMany', argsGlobal],
    ]);
  });

  it('(b) clínica com OUTRA conta laboratório: o mesmo', async () => {
    const sem = await rodadaDaClinica([]);
    __limparCacheLabTenants();
    const com = await rodadaDaClinica([LAB]);
    expect(com).toEqual(sem);
  });

  it('(c) laboratório sem horário próprio: o padrão do código, IA fora do expediente DESLIGADA, a global nem é lida', async () => {
    const b = banco({ labs: [LAB], global: GLOBAL_HORARIO });
    const v = await loadOfficeHoursValues(b.prisma, LAB);
    expect(v).toEqual({ values: { AFTER_HOURS_AI_ENABLED: 'false' }, ownKeys: [], clinicHours: null });
    expect(isAfterHoursAiEnabled(v.values)).toBe(false);
    const s = await loadBusinessHoursSettings(b.prisma, LAB);
    expect({ ...s, businessDays: [...s.businessDays] }).toEqual({
      start: { h: 17, m: 0 },
      end: { h: 8, m: 0 },
      businessDays: [1, 2, 3, 4, 5],
      timezone: 'America/Maceio',
      clinicHours: null,
    });
    expect(b.ops.map(([o]) => o)).toEqual(['tenantSetting.findMany', 'tenantSetting.findMany']);
  });

  it('(c) laboratório com horário próprio: só o dele (inclusive ligar a IA fora do expediente)', async () => {
    const b = banco({
      labs: [LAB],
      global: { ...GLOBAL_HORARIO, AFTER_HOURS_AI_ENABLED: 'false' },
      propria: { [`${LAB}|AFTER_HOURS_END`]: '09:00', [`${LAB}|AFTER_HOURS_AI_ENABLED`]: 'true' },
    });
    const v = await loadOfficeHoursValues(b.prisma, LAB);
    expect(v.values).toEqual({ AFTER_HOURS_END: '09:00', AFTER_HOURS_AI_ENABLED: 'true' });
    expect(v.ownKeys.sort()).toEqual(['AFTER_HOURS_AI_ENABLED', 'AFTER_HOURS_END']);
    expect(isAfterHoursAiEnabled(v.values)).toBe(true);
  });

  it('o texto de horário ({{business_hours_info}}): a clínica sem horário próprio usa a global; o laboratório, o padrão', async () => {
    // domingo, 10:00 em Maceió: fechado para os dois
    relogio(new Date('2026-10-25T13:00:00.000Z'));
    const b = banco({ labs: [LAB], global: GLOBAL_HORARIO });
    const clinica = await computeBusinessHoursInfo(b.prisma, OUTRA_CLINICA);
    const lab = await computeBusinessHoursInfo(b.prisma, LAB);
    expect(clinica).toContain('Funcionamento: Segunda a sábado, das 07:00 às 19:00.');
    expect(lab).toContain('Funcionamento: Segunda a sexta, das 08:00 às 17:00.');
    expect(lab).toContain('(America/Maceio)');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Conta legada
// ═════════════════════════════════════════════════════════════════════════════

describe('contaLegada / lerConfigDaConta — laboratório nunca é conta legada', () => {
  const GLOBAL_ANTIGA = { POST_CARE_CONFIG: '{"enabled":true}', MEMORY_BATCH_ENABLED: 'true' };

  async function rodadaDaClinica(labs: string[]) {
    const b = banco({
      labs,
      global: { ...GLOBAL_ANTIGA, [`MEMORY_BATCH_ENABLED_${OUTRA_CLINICA}`]: 'false' },
      criada: { [CLINICA]: ANTES_DO_CORTE, [OUTRA_CLINICA]: DEPOIS_DO_CORTE },
    });
    const r = [
      await contaLegada(b.prisma, CLINICA, () => undefined),
      await contaLegada(b.prisma, OUTRA_CLINICA, () => undefined),
      await lerConfigDaConta(b.prisma, 'POST_CARE_CONFIG', CLINICA),
      await lerConfigDaConta(b.prisma, 'POST_CARE_CONFIG', OUTRA_CLINICA),
      await lerConfigDaConta(b.prisma, 'MEMORY_BATCH_ENABLED', OUTRA_CLINICA),
      await lerConfigDaConta(b.prisma, 'POST_CARE_CONFIG', null),
    ];
    return { r, ops: b.ops };
  }

  it('(a) clínica, sem laboratório: antiga herda a global, nova não, a própria vence, como antes', async () => {
    const { r, ops } = await rodadaDaClinica([]);
    expect(r).toEqual([true, false, '{"enabled":true}', null, 'false', '{"enabled":true}']);
    expect(ops).toEqual([
      ['tenant.findUnique', { where: { id: CLINICA }, select: { created_at: true } }],
      ['tenant.findUnique', { where: { id: OUTRA_CLINICA }, select: { created_at: true } }],
      ['globalSetting.findUnique', { where: { key: `POST_CARE_CONFIG_${CLINICA}` } }],
      ['globalSetting.findUnique', { where: { key: 'POST_CARE_CONFIG' } }],
      ['globalSetting.findUnique', { where: { key: `POST_CARE_CONFIG_${OUTRA_CLINICA}` } }],
      ['globalSetting.findUnique', { where: { key: `MEMORY_BATCH_ENABLED_${OUTRA_CLINICA}` } }],
      ['globalSetting.findUnique', { where: { key: 'POST_CARE_CONFIG' } }],
    ]);
  });

  it('(b) clínica com OUTRA conta laboratório: o mesmo', async () => {
    const sem = await rodadaDaClinica([]);
    __limparCacheContaLegada();
    __limparCacheLabTenants();
    const com = await rodadaDaClinica([LAB]);
    expect(com).toEqual(sem);
  });

  it('(c) laboratório criado ANTES do corte: não é legado e não herda a global antiga', async () => {
    const b = banco({ labs: [LAB], global: GLOBAL_ANTIGA, criada: { [LAB]: ANTES_DO_CORTE } });
    expect(await contaLegada(b.prisma, LAB, () => undefined)).toBe(false);
    expect(await lerConfigDaConta(b.prisma, 'POST_CARE_CONFIG', LAB)).toBeNull();
    expect(await lerConfigDaConta(b.prisma, 'MEMORY_BATCH_ENABLED', LAB)).toBeNull();
    expect(b.globaisLidas()).toEqual([`POST_CARE_CONFIG_${LAB}`, `MEMORY_BATCH_ENABLED_${LAB}`]);
  });

  it('(c) laboratório: a configuração dele mesmo continua valendo', async () => {
    const b = banco({ labs: [LAB], global: { ...GLOBAL_ANTIGA, [`POST_CARE_CONFIG_${LAB}`]: '{"enabled":false}' } });
    expect(await lerConfigDaConta(b.prisma, 'POST_CARE_CONFIG', LAB)).toBe('{"enabled":false}');
  });

  it('(c) conta antiga CONVERTIDA em laboratório depois: deixa de herdar (o cache da data não segura)', async () => {
    relogio(new Date('2026-10-26T12:00:00.000Z'));
    const b = banco({ labs: [], global: GLOBAL_ANTIGA, criada: { [LAB]: ANTES_DO_CORTE } });
    expect(await contaLegada(b.prisma, LAB, () => undefined)).toBe(true);
    b.e.labs = [LAB];
    jest.setSystemTime(new Date('2026-10-26T12:01:01.000Z')); // a lista de laboratórios recarrega (60 s)
    expect(await contaLegada(b.prisma, LAB, () => undefined)).toBe(false);
    expect(await lerConfigDaConta(b.prisma, 'POST_CARE_CONFIG', LAB)).toBeNull();
  });

  it('falha ao ler o tipo da conta: vale o último conjunto conhecido (laboratório segue de fora)', async () => {
    relogio(new Date('2026-10-26T12:00:00.000Z'));
    const b = banco({ labs: [LAB], global: GLOBAL_ANTIGA, criada: { [LAB]: ANTES_DO_CORTE, [CLINICA]: ANTES_DO_CORTE } });
    expect(await contaLegada(b.prisma, LAB, () => undefined)).toBe(false);
    b.e.labsFalha = true;
    jest.setSystemTime(new Date('2026-10-26T12:01:01.000Z'));
    const avisos: string[] = [];
    expect(await contaLegada(b.prisma, LAB, (m) => avisos.push(m))).toBe(false);
    expect(await contaLegada(b.prisma, CLINICA, (m) => avisos.push(m))).toBe(true);
    expect(avisos.join()).toMatch(/falha ao ler TenantBusinessProfile/);
  });

  it('falha ao ler o tipo sem nada conhecido: a conta segue como clínica (o comportamento de hoje)', async () => {
    const b = banco({ labsFalha: true, global: GLOBAL_ANTIGA, criada: { [CLINICA]: ANTES_DO_CORTE } });
    const avisos: string[] = [];
    expect(await contaLegada(b.prisma, CLINICA, (m) => avisos.push(m))).toBe(true);
    expect(await lerConfigDaConta(b.prisma, 'POST_CARE_CONFIG', CLINICA)).toBe('{"enabled":true}');
    expect(avisos.join()).toMatch(/falha ao ler TenantBusinessProfile/);
  });
});

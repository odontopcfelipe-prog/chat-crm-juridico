/**
 * F2 parte 3a do laboratório — HERANÇA CENTRAL da configuração global no WORKER.
 *
 * Com a conta no contexto, o laboratório não herda da GlobalSetting o que é das
 * clínicas:
 *  - SettingsService.getAsaasConfig: só a conta Asaas do laboratório (chave e base
 *    URL da TenantSetting dele); sem chave própria, null (sem consulta ao Asaas),
 *    nunca a chave global nem a regra do dono; sem base URL própria, produção;
 *  - SettingsService.getTtsConfig(conta): TTS desligado, sem a chave nem a voz
 *    globais (a IA passa a conta da conversa);
 *  - recall de revisão (resolveRecallTemplate): só o texto do laboratório, senão o
 *    padrão do código, nunca o RECALL_MESSAGE_TEMPLATE global.
 *
 * Cada freio tem três casos: (a) sem laboratório cadastrado (o caso de produção
 * hoje) = mesmas leituras, na mesma ordem, e o mesmo resultado de antes; (b)
 * clínica com OUTRA conta laboratório = igual ao (a); (c) laboratório = não herda.
 * A leitura da lista de laboratórios (TenantBusinessProfile) fica fora do rastro.
 *
 * Repositório público: contas, chaves e textos fictícios.
 */
import * as fs from 'fs';
import * as path from 'path';
import { Logger } from '@nestjs/common';
import { DEFAULT_RECALL_TEMPLATE, __limparCacheLabTenants } from '@crm/shared';
import { SettingsService } from '../settings/settings.service';
import { MaintenanceRecallCronService } from '../maintenance/maintenance-recall-cron.service';

// ─── Dados de exemplo (repositório público: nada real) ───────────────────────
const CLINICA = 'tenant-clinica';
const OUTRA_CLINICA = 'tenant-clinica-2';
const LAB = 'tenant-lab';
const PRODUCAO = 'https://api.asaas.com/v3';
const SANDBOX = 'https://api-sandbox.asaas.com/v3';

let logs: { nivel: string; msg: string }[] = [];
beforeAll(() => {
  for (const nivel of ['log', 'warn', 'debug', 'error', 'verbose'] as const) {
    jest.spyOn(Logger.prototype, nivel).mockImplementation((msg: any) => {
      logs.push({ nivel, msg: String(msg) });
    });
  }
});
beforeEach(() => {
  logs = [];
  __limparCacheLabTenants();
});
const registrou = (trecho: string) => logs.some((l) => l.msg.includes(trecho));

// ─── Banco falso ─────────────────────────────────────────────────────────────

type Op = [string, any];
type Estado = {
  labs?: string[];
  /** TenantSetting: `${conta}|${chave}` → valor. */
  propria?: Record<string, string>;
  /** GlobalSetting: chave → valor. */
  global?: Record<string, string>;
};

/** Grava cada leitura (menos a da lista de laboratórios) e responde pelo estado. */
function banco(e: Estado) {
  __limparCacheLabTenants();
  const ops: Op[] = [];
  const perfis = jest.fn(async (_args: any) => (e.labs ?? []).map((tenant_id) => ({ tenant_id })));
  const prisma: any = {
    tenantBusinessProfile: { findMany: perfis },
    tenantSetting: {
      findUnique: jest.fn(async (args: any) => {
        ops.push(['tenantSetting.findUnique', args]);
        const { tenant_id, key } = args.where.tenant_id_key;
        const v = (e.propria ?? {})[`${tenant_id}|${key}`];
        return v === undefined ? null : { tenant_id, key, value: v };
      }),
    },
    globalSetting: {
      findUnique: jest.fn(async (args: any) => {
        ops.push(['globalSetting.findUnique', args]);
        const v = (e.global ?? {})[args.where.key];
        return v === undefined ? null : { key: args.where.key, value: v };
      }),
      findMany: jest.fn(async (args: any) => {
        ops.push(['globalSetting.findMany', args]);
        return Object.entries(e.global ?? {})
          .filter(([k]) => args.where.key.in.includes(k))
          .map(([key, value]) => ({ key, value }));
      }),
    },
  };
  const globaisLidas = () =>
    ops.filter(([o]) => o.startsWith('globalSetting.')).map(([, a]) => (a.where.key.in ? a.where.key.in : a.where.key));
  return { prisma, ops, perfis, globaisLidas };
}

const ts = (tenant_id: string, key: string): Op => ['tenantSetting.findUnique', { where: { tenant_id_key: { tenant_id, key } } }];
const gs = (key: string): Op => ['globalSetting.findUnique', { where: { key } }];

// ═════════════════════════════════════════════════════════════════════════════
// Asaas (worker)
// ═════════════════════════════════════════════════════════════════════════════

describe('SettingsService.getAsaasConfig — laboratório só usa a conta Asaas dele', () => {
  const GLOBAL_ASAAS = { asaas_api_key: 'chave-asaas-global-exemplo', asaas_sandbox: 'true' };

  async function rodadaDaClinica(labs: string[]) {
    const cenarios: Estado[] = [
      { global: { ...GLOBAL_ASAAS } },
      { global: { ...GLOBAL_ASAAS, ASAAS_GLOBAL_OWNER_TENANT: OUTRA_CLINICA } },
      { global: { ...GLOBAL_ASAAS, ASAAS_GLOBAL_OWNER_TENANT: CLINICA } },
      {
        global: { ...GLOBAL_ASAAS, ASAAS_GLOBAL_OWNER_TENANT: OUTRA_CLINICA },
        propria: { [`${CLINICA}|ASAAS_API_KEY`]: 'chave-propria-clinica', [`${CLINICA}|ASAAS_BASE_URL`]: 'https://api.asaas.com' },
      },
    ];
    const saidas: any[] = [];
    const rastros: Op[][] = [];
    for (const c of cenarios) {
      const b = banco({ ...c, labs });
      saidas.push(await new SettingsService(b.prisma).getAsaasConfig(CLINICA));
      rastros.push(b.ops);
    }
    return { saidas, rastros };
  }

  it('(a) clínica, sem laboratório: as quatro situações de hoje', async () => {
    const { saidas, rastros } = await rodadaDaClinica([]);
    expect(saidas).toEqual([
      { apiKey: 'chave-asaas-global-exemplo', baseUrl: SANDBOX },
      null,
      { apiKey: 'chave-asaas-global-exemplo', baseUrl: SANDBOX },
      { apiKey: 'chave-propria-clinica', baseUrl: PRODUCAO },
    ]);
    expect(rastros).toEqual([
      [ts(CLINICA, 'ASAAS_API_KEY'), gs('ASAAS_GLOBAL_OWNER_TENANT'), gs('asaas_api_key'), ts(CLINICA, 'ASAAS_BASE_URL'), gs('asaas_sandbox')],
      [ts(CLINICA, 'ASAAS_API_KEY'), gs('ASAAS_GLOBAL_OWNER_TENANT')],
      [ts(CLINICA, 'ASAAS_API_KEY'), gs('ASAAS_GLOBAL_OWNER_TENANT'), gs('asaas_api_key'), ts(CLINICA, 'ASAAS_BASE_URL'), gs('asaas_sandbox')],
      [ts(CLINICA, 'ASAAS_API_KEY'), ts(CLINICA, 'ASAAS_BASE_URL'), gs('asaas_sandbox')],
    ]);
  });

  it('(b) clínica com OUTRA conta laboratório: mesmas leituras e mesma configuração', async () => {
    expect(await rodadaDaClinica([LAB])).toEqual(await rodadaDaClinica([]));
  });

  it('sem conta: a global, como hoje, sem perguntar pelo laboratório', async () => {
    const b = banco({ labs: [LAB], global: { ...GLOBAL_ASAAS } });
    expect(await new SettingsService(b.prisma).getAsaasConfig(null)).toEqual({ apiKey: 'chave-asaas-global-exemplo', baseUrl: SANDBOX });
    expect(b.perfis).not.toHaveBeenCalled();
  });

  it('(c) laboratório sem chave própria: null (sem consulta ao Asaas), mesmo sem dono ou sendo o dono', async () => {
    for (const global of [{ ...GLOBAL_ASAAS }, { ...GLOBAL_ASAAS, ASAAS_GLOBAL_OWNER_TENANT: LAB }]) {
      const b = banco({ labs: [LAB], global });
      expect(await new SettingsService(b.prisma).getAsaasConfig(LAB)).toBeNull();
      expect(b.globaisLidas()).toEqual([]);
    }
    expect(registrou(`[LAB-GATE] asaas — conta ${LAB}`)).toBe(true);
  });

  it('(c) laboratório com conta própria: a chave e a base URL dele; sem base própria, produção', async () => {
    const com = banco({
      labs: [LAB],
      global: { ...GLOBAL_ASAAS, asaas_sandbox: 'false' },
      propria: { [`${LAB}|ASAAS_API_KEY`]: 'chave-propria-lab', [`${LAB}|ASAAS_BASE_URL`]: 'https://api-sandbox.asaas.com' },
    });
    expect(await new SettingsService(com.prisma).getAsaasConfig(LAB)).toEqual({ apiKey: 'chave-propria-lab', baseUrl: SANDBOX });
    const semBase = banco({ labs: [LAB], global: { ...GLOBAL_ASAAS }, propria: { [`${LAB}|ASAAS_API_KEY`]: 'chave-propria-lab' } });
    expect(await new SettingsService(semBase.prisma).getAsaasConfig(LAB)).toEqual({ apiKey: 'chave-propria-lab', baseUrl: PRODUCAO });
    expect([...com.globaisLidas(), ...semBase.globaisLidas()]).toEqual([]);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Voz da IA (TTS)
// ═════════════════════════════════════════════════════════════════════════════

describe('SettingsService.getTtsConfig — laboratório não herda a voz global', () => {
  const GLOBAL_TTS = {
    TTS_ENABLED: 'true',
    GOOGLE_TTS_API_KEY: 'chave-tts-exemplo',
    TTS_VOICE: 'pt-BR-Exemplo-A',
    TTS_LANGUAGE: 'pt-BR',
  };
  const LIGADA = { enabled: true, googleApiKey: 'chave-tts-exemplo', voice: 'pt-BR-Exemplo-A', language: 'pt-BR' };
  const leitura: Op = ['globalSetting.findMany', { where: { key: { in: ['TTS_ENABLED', 'GOOGLE_TTS_API_KEY', 'TTS_VOICE', 'TTS_LANGUAGE'] } } }];

  async function rodadaDaClinica(labs: string[]) {
    const b = banco({ labs, global: GLOBAL_TTS });
    const s = new SettingsService(b.prisma);
    return { r: [await s.getTtsConfig(CLINICA), await s.getTtsConfig()], ops: b.ops };
  }

  it('(a) clínica, sem laboratório (e chamada sem conta): a global, como antes', async () => {
    const { r, ops } = await rodadaDaClinica([]);
    expect(r).toEqual([LIGADA, LIGADA]);
    expect(ops).toEqual([leitura, leitura]);
  });

  it('(b) clínica com OUTRA conta laboratório: o mesmo', async () => {
    expect(await rodadaDaClinica([LAB])).toEqual(await rodadaDaClinica([]));
  });

  it('(c) laboratório: desligado, sem chave, voz e idioma padrão; a global nem é lida', async () => {
    const b = banco({ labs: [LAB], global: GLOBAL_TTS });
    expect(await new SettingsService(b.prisma).getTtsConfig(LAB)).toEqual({
      enabled: false,
      googleApiKey: '',
      voice: 'pt-BR-Neural2-B',
      language: 'pt-BR',
    });
    expect(b.ops).toEqual([]);
  });

  it('a IA passa a conta da conversa para o TTS', () => {
    const fonte = fs.readFileSync(path.resolve(__dirname, '../ai/ai.processor.ts'), 'utf8');
    expect(fonte.match(/getTtsConfig\([^)]*\)/g)).toEqual(['getTtsConfig(profileTenantId)']);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Recall de revisão
// ═════════════════════════════════════════════════════════════════════════════

describe('resolveRecallTemplate — laboratório não herda o texto global do recall', () => {
  const TEXTO_GLOBAL = 'Olá {nome}, texto global de exemplo';
  const TEXTO_DA_CONTA = 'Olá {nome}, texto da própria conta';

  const resolver = (prisma: any, conta: string) =>
    (new MaintenanceRecallCronService(prisma, {} as any) as any).resolveRecallTemplate(conta) as Promise<string>;

  async function rodadaDaClinica(labs: string[]) {
    const comGlobal = banco({ labs, global: { RECALL_MESSAGE_TEMPLATE: TEXTO_GLOBAL } });
    const comPropria = banco({
      labs,
      global: { RECALL_MESSAGE_TEMPLATE: TEXTO_GLOBAL },
      propria: { [`${CLINICA}|RECALL_MESSAGE_TEMPLATE`]: TEXTO_DA_CONTA },
    });
    const semNada = banco({ labs });
    return {
      r: [await resolver(comGlobal.prisma, CLINICA), await resolver(comPropria.prisma, CLINICA), await resolver(semNada.prisma, CLINICA)],
      ops: [comGlobal.ops, comPropria.ops, semNada.ops],
    };
  }

  it('(a) clínica, sem laboratório: a dela, senão a global, senão o padrão — como antes', async () => {
    const { r, ops } = await rodadaDaClinica([]);
    expect(r).toEqual([TEXTO_GLOBAL, TEXTO_DA_CONTA, DEFAULT_RECALL_TEMPLATE]);
    expect(ops).toEqual([
      [ts(CLINICA, 'RECALL_MESSAGE_TEMPLATE'), gs('RECALL_MESSAGE_TEMPLATE')],
      [ts(CLINICA, 'RECALL_MESSAGE_TEMPLATE')],
      [ts(CLINICA, 'RECALL_MESSAGE_TEMPLATE'), gs('RECALL_MESSAGE_TEMPLATE')],
    ]);
  });

  it('(b) clínica com OUTRA conta laboratório: o mesmo', async () => {
    expect(await rodadaDaClinica([LAB])).toEqual(await rodadaDaClinica([]));
  });

  it('(c) laboratório: o texto dele, senão o padrão do código; a global nunca é lida', async () => {
    const semPropria = banco({ labs: [LAB], global: { RECALL_MESSAGE_TEMPLATE: TEXTO_GLOBAL } });
    expect(await resolver(semPropria.prisma, LAB)).toBe(DEFAULT_RECALL_TEMPLATE);
    expect(semPropria.globaisLidas()).toEqual([]);
    const comPropria = banco({
      labs: [LAB],
      global: { RECALL_MESSAGE_TEMPLATE: TEXTO_GLOBAL },
      propria: { [`${LAB}|RECALL_MESSAGE_TEMPLATE`]: TEXTO_DA_CONTA },
    });
    expect(await resolver(comPropria.prisma, LAB)).toBe(TEXTO_DA_CONTA);
  });
});

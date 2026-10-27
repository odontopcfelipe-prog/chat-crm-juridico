/**
 * F2 parte 3b do laboratório — TELAS e ESCRITORES da configuração.
 *
 * Regra: cada conta tem a sua configuração; da GlobalSetting (e das tabelas sem
 * conta, como as skills da IA) o laboratório só usa o que é da PLATAFORMA
 * (GLOBAIS_DA_PLATAFORMA) e NUNCA grava a configuração global. É um freio POR
 * CIMA da entrega "configuração por clínica" (quem grava o quê):
 *  - configuração POR CONTA (`<CHAVE>_<conta>`: CRM, respostas rápidas, robô e
 *    tempo de resposta da IA, dados do contrato, GA4): o laboratório lê e grava a
 *    DELE (nunca herda a global das clínicas — config-da-clinica / ga4-config);
 *  - tela que mostra configuração global das clínicas (fora de
 *    GLOBAIS_DA_PLATAFORMA): o laboratório recebe o padrão do código / vazio /
 *    "não configurado", no MESMO formato;
 *  - escrita da plataforma (DJEN, ClickSign, voz, skills, prompts da memória da
 *    organização): quem não é SUPER_ADMIN já recebe 403 PERMISSION_DENIED; o
 *    SUPER_ADMIN logado numa conta de laboratório recebe 403 VERTICAL_DENIED e
 *    nada é lido nem gravado; num salvamento misto (ai-config, contrato) os
 *    campos da plataforma vindos de uma conta de laboratório são ignorados;
 *  - custos da IA: o laboratório vê só o consumo dele (nunca o da plataforma);
 *  - follow-up: o laboratório só vê as sequências dele e cria sempre na conta dele;
 *  - lembrete em áudio: a voz do Google (chave das clínicas) fica fora do laboratório.
 *
 * Cada freio tem três casos: (a) clínica sem laboratório cadastrado (o caso de
 * produção hoje) = o comportamento da configuração por clínica; (b) clínica com
 * OUTRA conta laboratório = igual ao (a), com as mesmas leituras e gravações, na
 * mesma ordem; (c) laboratório. A leitura da lista de laboratórios
 * (TenantBusinessProfile, cache de 60 s) é a única coisa nova para a clínica e
 * fica fora do rastro. Os casos (a) e (b) também rodam contra o código anterior:
 * `rota()` chama a rota com o req só quando a assinatura tem esse parâmetro a mais.
 *
 * Repositório público: contas, chaves e textos fictícios.
 */
import { Logger, NotFoundException } from '@nestjs/common';
import { __limparCacheContaLegada, __limparCacheLabTenants, eGlobalDaPlataforma } from '@crm/shared';
import { SettingsService } from '../settings/settings.service';
import { SettingsController } from '../settings/settings.controller';
import { MemoriesService } from '../memories/memories.service';
import { MemoriesController } from '../memories/memories.controller';
import { AnalyticsService } from '../analytics/analytics.service';
import { AnalyticsController } from '../analytics/analytics.controller';
import { GoogleDriveController } from '../google-drive/google-drive.controller';
import { FollowupService } from '../followup/followup.service';
import { FollowupController } from '../followup/followup.controller';
import { AudioDisparoService } from '../audio-disparo/audio-disparo.service';
import { CODIGO_VERTICAL_NEGADA } from '../common/lab-gate.util';

// ─── Dados de exemplo (repositório público: nada real) ───────────────────────
const CLINICA = 'tenant-clinica';
const LAB = 'tenant-lab';
const ADMIN_CLINICA = { id: 'u-clin', tenant_id: CLINICA, roles: ['ADMIN'] };
const ADMIN_LAB = { id: 'u-lab', tenant_id: LAB, roles: ['ADMIN'] };
const DONO_NA_CLINICA = { id: 'u-dono', tenant_id: CLINICA, roles: ['ADMIN', 'SUPER_ADMIN'] };
const DONO_NO_LAB = { id: 'u-dono-lab', tenant_id: LAB, roles: ['ADMIN', 'SUPER_ADMIN'] };
const SUPER_SEM_CONTA = { id: 'u-super', tenant_id: null, roles: ['ADMIN', 'SUPER_ADMIN'] };
const req = (user: any) => ({ user });
const PERMISSAO = 'PERMISSION_DENIED';

/** Configuração global das clínicas (e chaves da plataforma) no banco falso. */
const GLOBAL: Record<string, string> = {
  // plataforma
  OPENAI_API_KEY: 'sk-plataforma-exemplo-0000',
  OPENAI_ADMIN_KEY: 'admin-plataforma-exemplo',
  ANTHROPIC_API_KEY: 'ant-plataforma-exemplo',
  OPENAI_DEFAULT_MODEL: 'gpt-4.1',
  DJEN_AI_MODEL: 'gpt-4.1-mini',
  MEMORY_ORG_MODEL: 'gpt-4o',
  // das clínicas
  CRM_CONFIG: '{"stagnationDays":5}',
  CANNED_RESPONSES: JSON.stringify([{ id: 'r1', label: 'Boas-vindas', text: 'Olá, aqui é da clínica exemplo' }]),
  CONTRACT_CONFIG: JSON.stringify({ foro: 'Comarca Exemplo', escritorio_cidade: 'Cidade Exemplo', publicApiUrl: 'https://api-global.exemplo.test' }),
  TTS_ENABLED: 'true',
  GOOGLE_TTS_API_KEY: 'chave-google-exemplo',
  TTS_VOICE: 'pt-BR-Wavenet-A',
  TTS_LANGUAGE: 'pt-PT',
  DJEN_LAWYERS: JSON.stringify([{ oab: '00000', uf: 'XX', nome: 'Advogado Exemplo' }]),
  DJEN_SYSTEM_PROMPT: 'prompt do DJEN das clínicas',
  DJEN_CLIENT_NOTIFY_TEMPLATE: 'aviso do DJEN das clínicas',
  ADMIN_BOT_ENABLED: 'false',
  WHATSAPP_AI_ENABLED: 'true',
  AI_ENABLED_COMERCIAL: 'true',
  AI_ENABLED_FINANCEIRO: 'false',
  AI_COOLDOWN_SECONDS: '20',
  MEMORY_ORG_INCREMENTAL_PROMPT: 'prompt incremental personalizado das clínicas',
  MEMORY_ORG_REBUILD_PROMPT: 'prompt de reconstrução personalizado das clínicas',
  AFTER_HOURS_AI_ENABLED: 'true',
  AFTER_HOURS_START: '19:00',
  AFTER_HOURS_END: '07:00',
  BUSINESS_DAYS: '1,2,3,4,5,6',
  TIMEZONE: 'America/Sao_Paulo',
};
const PUBLIC_API_URL_ENV = 'https://api-env.exemplo.test';

// ─── Logs (nada vai para o console) ──────────────────────────────────────────
let logs: string[] = [];
beforeAll(() => {
  for (const nivel of ['log', 'warn', 'debug', 'error', 'verbose'] as const) {
    jest.spyOn(Logger.prototype, nivel).mockImplementation((msg: any) => {
      logs.push(String(msg));
    });
  }
});
const envOriginal = { ...process.env };
const fetchOriginal = global.fetch;
/** Limpa os caches de processo (lista de laboratórios e conta legada). */
function limparCaches(): void {
  __limparCacheLabTenants();
  __limparCacheContaLegada();
}
beforeEach(() => {
  logs = [];
  limparCaches();
  for (const k of ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'GA4_PROPERTY_ID', 'GA4_SERVICE_ACCOUNT_B64']) delete process.env[k];
  process.env.PUBLIC_API_URL = PUBLIC_API_URL_ENV;
  process.env.ENCRYPTION_KEY = 'chave-de-teste-somente';
});
afterEach(() => {
  global.fetch = fetchOriginal;
  for (const k of Object.keys(process.env)) if (!(k in envOriginal)) delete process.env[k];
  Object.assign(process.env, envOriginal);
});

/**
 * Chama a rota com o req quando a assinatura tem um parâmetro a mais que `resto`
 * (o código anterior não recebia o req em algumas rotas).
 */
function rota(obj: any, nome: string, r: any, ...resto: any[]): Promise<any> {
  const f = obj[nome];
  return f.length > resto.length ? f.call(obj, r, ...resto) : f.call(obj, ...resto);
}

/** Resultado da rota: ['ok', valor] ou ['erro', resposta do erro]. */
function resultado(p: Promise<any>): Promise<[string, any]> {
  return p.then(
    (x) => ['ok', x] as [string, any],
    (e) => ['erro', e?.getResponse?.() ?? String(e)] as [string, any],
  );
}

// ─── Banco falso ─────────────────────────────────────────────────────────────

type Op = [string, any];
type Estado = {
  /** Contas de laboratório (TenantBusinessProfile LABORATORIO). */
  labs?: string[];
  /** GlobalSetting: chave → valor. */
  global?: Record<string, string>;
  /** TenantSetting: `${conta}|${chave}` → valor. */
  propria?: Record<string, string>;
};

/** Grava cada leitura e gravação (menos a da lista de laboratórios), na ordem. */
function banco(e: Estado) {
  const ops: Op[] = [];
  const g = (op: string, x: any) => ops.push([op, x]);
  const global: Record<string, string> = { ...(e.global ?? {}) };
  const propria: Record<string, string> = { ...(e.propria ?? {}) };
  const perfis = jest.fn(async (_a: any) => (e.labs ?? []).map((tenant_id) => ({ tenant_id })));
  const fn = (nome: string, resposta: (a: any) => any = () => null) =>
    jest.fn(async (a: any) => {
      g(nome, a);
      return resposta(a);
    });
  const skills = [
    { id: 'skill-1', name: 'Atendimento', area: 'Triagem', active: true, order: 1, system_prompt: 'Você é a atendente da clínica exemplo.' },
  ];
  const prisma: any = {
    tenantBusinessProfile: { findMany: perfis },
    globalSetting: {
      findUnique: jest.fn(async (a: any) => {
        g('gs.ler', a.where.key);
        const v = global[a.where.key];
        return v === undefined ? null : { key: a.where.key, value: v };
      }),
      findMany: jest.fn(async (a: any) => {
        g('gs.lerVarias', a.where.key.in);
        return Object.entries(global)
          .filter(([k]) => a.where.key.in.includes(k))
          .map(([key, value]) => ({ key, value }));
      }),
      upsert: jest.fn(async (a: any) => {
        g('gs.gravar', a.where.key);
        global[a.where.key] = a.update.value;
        return { key: a.where.key, value: a.update.value };
      }),
      deleteMany: jest.fn(async (a: any) => {
        g('gs.apagar', a.where.key);
        delete global[a.where.key];
        return { count: 1 };
      }),
    },
    tenantSetting: {
      findUnique: jest.fn(async (a: any) => {
        const { tenant_id, key } = a.where.tenant_id_key;
        g('ts.ler', `${tenant_id}|${key}`);
        const v = propria[`${tenant_id}|${key}`];
        return v === undefined ? null : { tenant_id, key, value: v };
      }),
      findMany: jest.fn(async (a: any) => {
        const chaves: string[] = a.where.key?.in ?? [];
        g('ts.lerVarias', `${a.where.tenant_id}|${chaves.join(',')}`);
        return Object.entries(propria)
          .map(([k, value]) => ({ tenant_id: k.split('|')[0], key: k.split('|')[1], value }))
          .filter((l) => l.tenant_id === a.where.tenant_id && chaves.includes(l.key));
      }),
      upsert: jest.fn(async (a: any) => {
        const { tenant_id, key } = a.where.tenant_id_key;
        g('ts.gravar', `${tenant_id}|${key}`);
        propria[`${tenant_id}|${key}`] = a.update.value;
        return {};
      }),
    },
    tenant: {
      // Contas criadas antes do corte (conta legada): a clínica herda a global antiga.
      findUnique: fn('tenant.ler', (a) => ({
        name: 'Conta Exemplo', phone: null, email: null, zip_code: null, address: null, address_number: null,
        address_complement: null, neighborhood: null, city: null, state: null, business_hours: null,
        ...(a?.select?.created_at ? { created_at: new Date('2025-01-01T00:00:00Z') } : {}),
      })),
    },
    organizationProfile: { findUnique: fn('orgProfile.ler') },
    user: { findFirst: fn('user.ler', () => ({ name: 'Dra. Exemplo' })) },
    instance: { findMany: fn('instance.listar', () => [{ name: 'chip-clinica', purpose: 'CLINICA' }]) },
    holiday: { findFirst: fn('feriado.ler') },
    $queryRaw: jest.fn(async () => []),
    promptSkill: {
      findMany: fn('skill.listar', () => skills.map((s) => ({ ...s }))),
      update: fn('skill.gravar', () => ({})),
    },
    followupSequence: {
      findMany: fn('seq.listar', () => []),
      create: jest.fn(async (a: any) => {
        g('seq.criar', a.data.tenant_id ?? null);
        return a.data;
      }),
    },
  };
  return { prisma, ops, global, propria, perfis };
}

function montarSettings(e: Estado) {
  const b = banco(e);
  const service = new SettingsService(b.prisma);
  const s3 = {
    uploadBuffer: jest.fn(async () => undefined),
    deleteObject: jest.fn(async () => undefined),
    getObjectBuffer: jest.fn(async () => ({ buffer: Buffer.from('conteudo'), contentType: 'text/plain' })),
  };
  const ctl = new SettingsController(service, {} as any, s3 as any, b.prisma, {} as any);
  return { ...b, service, ctl, s3 };
}

const gs = (key: string): Op => ['gs.ler', key];
const gravou = (key: string): Op => ['gs.gravar', key];
const CHIPS = ['AI_ENABLED_COMERCIAL', 'AI_ENABLED_CLINICA', 'AI_ENABLED_FINANCEIRO'];
const PERFIL_CHAVES = ['AI_CLINIC_HOURS', 'AI_FINANCEIRO_ESCALATION_USERS', 'AI_PROFILE_COMERCIAL', 'AI_PROFILE_CLINICA', 'AI_PROFILE_FINANCEIRO'];
const mascara = (k: string) => `${k.slice(0, 4)}${'*'.repeat(Math.min(k.length - 8, 20))}${k.slice(-4)}`;
const daConta = (chave: string, conta: string) => `${chave}_${conta}`;
/** Chaves da GlobalSetting lidas / gravadas no rastro. */
const lidas = (ops: Op[]) => ops.filter(([o]) => o === 'gs.ler' || o === 'gs.lerVarias').flatMap(([, k]) => (Array.isArray(k) ? k : [k]));
const gravadas = (ops: Op[]) => ops.filter(([o]) => o === 'gs.gravar' || o === 'gs.apagar').map(([, k]) => k);
/** A chave é da plataforma ou da própria conta de laboratório? */
const daPlataformaOuDoLab = (k: string) => eGlobalDaPlataforma(k) || k.endsWith(`_${LAB}`);
/** A global depois = a de antes, mais só chaves `_<LAB>`. */
function globalSoGanhouDoLab(depois: Record<string, string>): void {
  const semDoLab = Object.fromEntries(Object.entries(depois).filter(([k]) => !k.endsWith(`_${LAB}`)));
  expect(semDoLab).toEqual(GLOBAL);
}

// ═════════════════════════════════════════════════════════════════════════════
// 1. Telas que leem configuração (Ajustes)
// ═════════════════════════════════════════════════════════════════════════════

describe('telas de Ajustes — o laboratório vê o dele e o da plataforma, no mesmo formato', () => {
  const CLICKSIGN_GLOBAL = {
    baseUrl: 'https://clicksign-global.exemplo.test',
    apiToken: 'token-clicksign-exemplo-1234',
    webhookToken: 'webhook-clicksign-exemplo-5678',
    isConfigured: true,
  };
  const CONTRATO_EM_BRANCO = {
    advogado1_nome: '', advogado1_oab: '', advogado2_nome: '', advogado2_oab: '',
    escritorio_logradouro: '', escritorio_cidade: '', escritorio_cep: '', foro: '',
  };

  /** Cada tela, com o usuário dado; a ClickSign global vem de um espião (import dinâmico). */
  async function telas(labs: string[], user: any, propria: Record<string, string> = {}, globalExtra: Record<string, string> = {}) {
    limparCaches();
    const m = montarSettings({ labs, global: { ...GLOBAL, ...globalExtra }, propria });
    const clicksign = jest.spyOn(m.service, 'getClicksignConfig').mockResolvedValue({ ...CLICKSIGN_GLOBAL });
    const r = req(user);
    const passo = async (f: () => Promise<any>) => {
      const antes = m.ops.length;
      const [st, x] = await resultado(f());
      return { saida: st === 'ok' ? x : { erro: x }, ops: m.ops.slice(antes) };
    };
    const t = {
      crm: await passo(() => rota(m.ctl, 'getCrmConfig', r)),
      respostas: await passo(() => rota(m.ctl, 'getCannedResponses', r)),
      contrato: await passo(() => rota(m.ctl, 'getContract', r)),
      tts: await passo(() => rota(m.ctl, 'getTtsConfig', r)),
      djen: await passo(() => rota(m.ctl, 'getDjenLawyers', r)),
      ia: await passo(() => m.ctl.getAiConfig(r)),
      perfil: await passo(() => m.ctl.getAiProfile(r)),
      clicksign: await passo(() => rota(m.ctl, 'getClicksign', r)),
    };
    return { t, clicksign: clicksign.mock.calls };
  }

  it('(a) clínica, sem laboratório: a configuração por clínica (a legada herda a global)', async () => {
    const { t, clicksign } = await telas([], ADMIN_CLINICA, { [`${CLINICA}|AI_ENABLED_CLINICA`]: 'false' });
    expect(t.crm.saida).toEqual({ stagnationDays: 5 });
    expect(t.respostas.saida).toEqual(JSON.parse(GLOBAL.CANNED_RESPONSES));
    expect(t.contrato.saida).toEqual({
      ...CONTRATO_EM_BRANCO, escritorio_cidade: 'Cidade Exemplo', foro: 'Comarca Exemplo',
      publicApiUrl: 'https://api-global.exemplo.test',
    });
    expect(t.tts).toEqual({
      saida: { enabled: true, isConfigured: true, voice: 'pt-BR-Wavenet-A', language: 'pt-PT' },
      ops: [gs('TTS_ENABLED'), gs('GOOGLE_TTS_API_KEY'), gs('TTS_VOICE'), gs('TTS_LANGUAGE')],
    });
    // DJEN: só o administrador do sistema (configuração por clínica)
    expect(t.djen).toEqual({ saida: { erro: expect.objectContaining({ code: PERMISSAO }) }, ops: [] });
    expect(t.ia.saida).toEqual({
      apiKey: null, isConfigured: true, isAdminKeyConfigured: true, isAnthropicKeyConfigured: true,
      defaultModel: 'gpt-4.1', djenModel: 'gpt-4.1-mini',
      djenPrompt: 'prompt do DJEN das clínicas', djenPromptIsCustom: true,
      djenNotifyTemplate: 'aviso do DJEN das clínicas', djenNotifyTemplateIsCustom: true,
      adminBotEnabled: false, whatsappAiEnabled: true,
      aiChip: { COMERCIAL: true, CLINICA: false, FINANCEIRO: false },
      cooldownSeconds: 20,
    });
    expect(lidas(t.ia.ops)).toEqual([
      'OPENAI_API_KEY', 'OPENAI_ADMIN_KEY', 'ANTHROPIC_API_KEY', 'OPENAI_DEFAULT_MODEL', 'DJEN_AI_MODEL',
      'DJEN_SYSTEM_PROMPT', 'DJEN_CLIENT_NOTIFY_TEMPLATE', daConta('ADMIN_BOT_ENABLED', CLINICA), 'ADMIN_BOT_ENABLED',
      'WHATSAPP_AI_ENABLED', 'AI_ENABLED_COMERCIAL', 'AI_ENABLED_FINANCEIRO',
      daConta('AI_COOLDOWN_SECONDS', CLINICA), 'AI_COOLDOWN_SECONDS',
    ]);
    expect(t.ia.ops).toContainEqual(['ts.lerVarias', `${CLINICA}|${CHIPS.join(',')}`]);
    expect(t.perfil.saida.defaults).toEqual({ cooldownSeconds: 20 });
    expect(Object.fromEntries(Object.entries(t.perfil.saida.chips).map(([p, c]: any) => [p, c.enabled]))).toEqual({
      COMERCIAL: true, CLINICA: false, FINANCEIRO: false,
    });
    expect(t.clicksign.saida).toEqual({ ...CLICKSIGN_GLOBAL, apiToken: '********', webhookToken: '********' });
    expect(clicksign).toEqual([[]]); // a global, sem conta (como antes)
  });

  it('(b) clínica com OUTRA conta laboratório: o mesmo resultado e as mesmas leituras', async () => {
    const propria = { [`${CLINICA}|AI_ENABLED_CLINICA`]: 'false' };
    for (const user of [ADMIN_CLINICA, DONO_NA_CLINICA]) {
      const sem = await telas([], user, propria);
      const com = await telas([LAB], user, propria);
      expect(com).toEqual(sem);
    }
  });

  it('(c) laboratório: o dele ou o padrão do código; nada da configuração global das clínicas', async () => {
    const clinica = await telas([], ADMIN_CLINICA);
    // o laboratório tem até um liga/desliga próprio: a IA dele segue desligada
    const { t, clicksign } = await telas([LAB], ADMIN_LAB, { [`${LAB}|AI_ENABLED_COMERCIAL`]: 'true' });
    expect(t.crm).toEqual({ saida: { stagnationDays: 3 }, ops: [gs(daConta('CRM_CONFIG', LAB))] });
    expect(t.respostas).toEqual({ saida: [], ops: [gs(daConta('CANNED_RESPONSES', LAB))] });
    // dados do contrato em branco; a URL pública é da plataforma (a global é lida só por ela)
    expect(t.contrato).toEqual({
      saida: { ...CONTRATO_EM_BRANCO, publicApiUrl: 'https://api-global.exemplo.test' },
      ops: [gs('CONTRACT_CONFIG'), gs(daConta('CONTRACT_CONFIG', LAB))],
    });
    expect(t.tts).toEqual({ saida: { enabled: false, isConfigured: false, voice: 'pt-BR-Neural2-B', language: 'pt-BR' }, ops: [] });
    expect(t.djen).toEqual({ saida: { erro: expect.objectContaining({ code: PERMISSAO }) }, ops: [] });
    // IA: da global, só a parte da plataforma; robô e tempo de resposta, os dele (aqui, o padrão)
    expect(t.ia.saida).toEqual({
      apiKey: null, isConfigured: true, isAdminKeyConfigured: true, isAnthropicKeyConfigured: true,
      defaultModel: 'gpt-4.1', djenModel: 'gpt-4.1-mini',
      djenPrompt: '', djenPromptIsCustom: false, djenNotifyTemplate: '', djenNotifyTemplateIsCustom: false,
      adminBotEnabled: true, whatsappAiEnabled: false,
      aiChip: { COMERCIAL: false, CLINICA: false, FINANCEIRO: false },
      cooldownSeconds: 8,
    });
    expect(t.ia.ops).toEqual([
      gs('OPENAI_API_KEY'), gs('OPENAI_ADMIN_KEY'), gs('ANTHROPIC_API_KEY'), gs('OPENAI_DEFAULT_MODEL'), gs('DJEN_AI_MODEL'),
      gs(daConta('ADMIN_BOT_ENABLED', LAB)), gs(daConta('AI_COOLDOWN_SECONDS', LAB)),
    ]);
    // perfil da IA: os dados da conta dele; chips desligados e o tempo dele (padrão)
    expect(t.perfil.saida.defaults).toEqual({ cooldownSeconds: 8 });
    for (const c of Object.values(t.perfil.saida.chips) as any[]) expect(c.enabled).toBe(false);
    expect(lidas(t.perfil.ops)).toEqual([daConta('AI_COOLDOWN_SECONDS', LAB)]);
    expect(t.perfil.ops.filter(([o]) => o === 'ts.lerVarias')).toEqual([['ts.lerVarias', `${LAB}|${PERFIL_CHAVES.join(',')}`]]);
    // ClickSign: não configurado e a global nem é consultada
    expect(t.clicksign.saida).toEqual({ baseUrl: 'https://sandbox.clicksign.com', apiToken: null, webhookToken: null, isConfigured: false });
    expect(clicksign).toEqual([]);
    // nenhuma tela leu configuração global de clínica (só a plataforma e as chaves dele)
    for (const [k, v] of Object.entries(t)) {
      const fora = lidas(v.ops).filter((c) => !daPlataformaOuDoLab(c) && !(k === 'contrato' && c === 'CONTRACT_CONFIG'));
      expect([k, fora]).toEqual([k, []]);
    }
    // mesmo formato da clínica, tela a tela
    for (const k of ['crm', 'contrato', 'tts', 'ia', 'clicksign'] as const) {
      expect([k, Object.keys(t[k].saida).sort()]).toEqual([k, Object.keys(clinica.t[k].saida).sort()]);
    }
    expect(Object.keys(t.perfil.saida)).toEqual(Object.keys(clinica.t.perfil.saida));
    expect(Array.isArray(t.respostas.saida)).toBe(true);
  });

  it('(c) laboratório com a configuração dele: lê a dele', async () => {
    const doLab = {
      [daConta('CRM_CONFIG', LAB)]: '{"stagnationDays":9}',
      [daConta('CANNED_RESPONSES', LAB)]: JSON.stringify([{ id: 'l1', label: 'prazo', text: 'Prazo do laboratório exemplo' }]),
      [daConta('CONTRACT_CONFIG', LAB)]: JSON.stringify({ foro: 'Foro do laboratório exemplo' }),
      [daConta('ADMIN_BOT_ENABLED', LAB)]: 'false',
      [daConta('AI_COOLDOWN_SECONDS', LAB)]: '15',
    };
    const { t } = await telas([LAB], ADMIN_LAB, {}, doLab);
    expect(t.crm.saida).toEqual({ stagnationDays: 9 });
    expect(t.respostas.saida).toEqual([{ id: 'l1', label: 'prazo', text: 'Prazo do laboratório exemplo' }]);
    expect(t.contrato.saida).toEqual({ ...CONTRATO_EM_BRANCO, foro: 'Foro do laboratório exemplo', publicApiUrl: 'https://api-global.exemplo.test' });
    expect(t.ia.saida).toMatchObject({ adminBotEnabled: false, cooldownSeconds: 15, whatsappAiEnabled: false });
    expect(t.perfil.saida.defaults).toEqual({ cooldownSeconds: 15 });
  });

  it('(c) o dono (SUPER_ADMIN) dentro de uma conta laboratório vê as telas do laboratório', async () => {
    const { t, clicksign } = await telas([LAB], DONO_NO_LAB);
    expect(t.crm.saida).toEqual({ stagnationDays: 3 });
    expect(t.respostas.saida).toEqual([]);
    expect(t.tts).toEqual({ saida: { enabled: false, isConfigured: false, voice: 'pt-BR-Neural2-B', language: 'pt-BR' }, ops: [] });
    expect(t.djen).toEqual({ saida: [], ops: [] });
    expect(t.ia.saida).toMatchObject({
      apiKey: mascara(GLOBAL.OPENAI_API_KEY), djenPrompt: '', djenNotifyTemplate: '', whatsappAiEnabled: false,
      aiChip: { COMERCIAL: false, CLINICA: false, FINANCEIRO: false }, cooldownSeconds: 8,
    });
    expect(t.clicksign.saida).toEqual({ baseUrl: 'https://sandbox.clicksign.com', apiToken: null, webhookToken: null, isConfigured: false });
    expect(clicksign).toEqual([]);
    for (const [k, v] of Object.entries(t)) {
      const fora = lidas(v.ops).filter((c) => !daPlataformaOuDoLab(c) && !(k === 'contrato' && c === 'CONTRACT_CONFIG'));
      expect([k, fora]).toEqual([k, []]);
    }
  });

  it('sem conta no token (SUPER_ADMIN do painel): a global, sem perguntar pelo laboratório', async () => {
    const m = montarSettings({ labs: [LAB], global: GLOBAL });
    const r = req(SUPER_SEM_CONTA);
    expect(await rota(m.ctl, 'getCrmConfig', r)).toEqual({ stagnationDays: 5 });
    expect(await rota(m.ctl, 'getCannedResponses', r)).toEqual(JSON.parse(GLOBAL.CANNED_RESPONSES));
    expect((await rota(m.ctl, 'getTtsConfig', r)).enabled).toBe(true);
    expect(await rota(m.ctl, 'getDjenLawyers', r)).toEqual(JSON.parse(GLOBAL.DJEN_LAWYERS));
    expect((await m.ctl.getAiConfig(r)).djenPrompt).toBe('prompt do DJEN das clínicas');
    expect(m.perfis).not.toHaveBeenCalled();
  });

  it('salvar o perfil de um chip no laboratório devolve a IA desligada, sem ler a global', async () => {
    const m = montarSettings({ labs: [LAB], global: GLOBAL });
    const r = await m.ctl.saveAiProfileChip(req(ADMIN_LAB), 'COMERCIAL', { enabled: true });
    expect(r.enabled).toBe(false);
    expect(m.ops.filter(([o]) => o.startsWith('gs.'))).toEqual([]);
    // na clínica, como antes: o liga/desliga dela
    limparCaches();
    const c = montarSettings({ labs: [LAB], global: GLOBAL });
    const rc = await c.ctl.saveAiProfileChip(req(ADMIN_CLINICA), 'COMERCIAL', { enabled: true });
    expect(rc.enabled).toBe(true);
    // (o chip salvo vem da TenantSetting dela; os outros dois, da global)
    expect(c.ops.filter(([o]) => o.startsWith('gs.'))).toEqual([gs('WHATSAPP_AI_ENABLED'), gs('AI_ENABLED_CLINICA'), gs('AI_ENABLED_FINANCEIRO')]);
  });

  it('horário do escritório e a prévia da variável: o laboratório não lê o horário global', async () => {
    const m = montarSettings({ labs: [LAB], global: GLOBAL });
    const lab = await m.ctl.getOfficeHours(req(ADMIN_LAB));
    expect(lab).toMatchObject({ ai_enabled: false, open_time: '08:00', close_time: '17:00', business_days: [1, 2, 3, 4, 5], timezone: 'America/Maceio' });
    await m.ctl.getVariablePreview(req(ADMIN_LAB));
    expect(m.ops.filter(([o]) => o.startsWith('gs.'))).toEqual([]);
    const clinica = await m.ctl.getOfficeHours(req(ADMIN_CLINICA));
    expect(clinica).toMatchObject({ ai_enabled: true, open_time: '07:00', close_time: '19:00', timezone: 'America/Sao_Paulo' });
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 2. Escritores de Ajustes
// ═════════════════════════════════════════════════════════════════════════════

describe('rotas que gravam configuração — o laboratório grava só a dele, nunca a global', () => {
  /** [rota, argumentos depois do req] */
  const ESCRITORES: Array<[string, any[]]> = [
    ['saveDjenLawyers', [{ lawyers: [{ oab: '11111', uf: 'YY', nome: 'Novo Exemplo' }] }]],
    ['setAiConfig', [{ defaultModel: 'gpt-5', djenPrompt: 'novo prompt', adminBotEnabled: false, whatsappAiEnabled: false, cooldownSeconds: 12 }]],
    ['setCrmConfig', [{ stagnationDays: 7 }]],
    ['setCannedResponses', [{ responses: [{ id: 'n1', label: 'Novo', text: 'Texto novo' }] }]],
    ['setClicksign', [{ baseUrl: 'https://app.clicksign.com', webhookToken: 'wh-novo' }]],
    ['setContract', [{ foro: 'Novo foro', publicApiUrl: 'https://outra.exemplo.test' }]],
    ['setTtsConfig', [{ enabled: false, voice: 'pt-BR-Neural2-C' }]],
  ];
  const IGNORADOS_IA = ['defaultModel', 'djenPrompt', 'whatsappAiEnabled'];

  async function rodada(labs: string[], user: any) {
    limparCaches();
    const saidas: Record<string, { r: [string, any]; ops: Op[]; global: Record<string, string> }> = {};
    for (const [nome, args] of ESCRITORES) {
      const m = montarSettings({ labs, global: GLOBAL });
      const r = await resultado(rota(m.ctl, nome, req(user), ...args));
      saidas[nome] = { r, ops: m.ops, global: m.global };
    }
    return saidas;
  }

  /** [status, chaves gravadas, `ignorados` da resposta (só nos salvamentos mistos)] por rota. */
  type Esperado = Record<string, [string, string[], string[]?]>;
  const doAdmin = (conta: string): Esperado => ({
    saveDjenLawyers: ['erro', []],
    setAiConfig: ['ok', [daConta('ADMIN_BOT_ENABLED', conta), daConta('AI_COOLDOWN_SECONDS', conta)], IGNORADOS_IA],
    setCrmConfig: ['ok', [daConta('CRM_CONFIG', conta)]],
    setCannedResponses: ['ok', [daConta('CANNED_RESPONSES', conta)]],
    setClicksign: ['erro', []],
    setContract: ['ok', [daConta('CONTRACT_CONFIG', conta)], ['publicApiUrl']],
    setTtsConfig: ['erro', []],
  });

  function conferir(saidas: Awaited<ReturnType<typeof rodada>>, esperado: Esperado, codigoErro: string) {
    for (const [nome, [st, chaves, ignorados]] of Object.entries(esperado)) {
      const { r, ops } = saidas[nome];
      expect([nome, r[0]]).toEqual([nome, st]);
      if (st === 'erro') {
        expect([nome, r[1]]).toEqual([nome, expect.objectContaining({ code: codigoErro })]);
        expect([nome, ops]).toEqual([nome, []]); // nada lido nem gravado
      }
      expect([nome, gravadas(ops)]).toEqual([nome, chaves]);
      if (ignorados) expect([nome, r[1].ignorados]).toEqual([nome, ignorados]);
    }
  }

  it('(a) clínica, sem laboratório: o ADMIN grava a dele; o dono grava também a plataforma', async () => {
    conferir(await rodada([], ADMIN_CLINICA), doAdmin(CLINICA), PERMISSAO);
    const dono = await rodada([], DONO_NA_CLINICA);
    conferir(dono, {
      saveDjenLawyers: ['ok', ['DJEN_LAWYERS']],
      setAiConfig: ['ok', ['OPENAI_DEFAULT_MODEL', 'DJEN_SYSTEM_PROMPT', 'WHATSAPP_AI_ENABLED',
        daConta('ADMIN_BOT_ENABLED', CLINICA), daConta('AI_COOLDOWN_SECONDS', CLINICA)], []],
      setCrmConfig: ['ok', [daConta('CRM_CONFIG', CLINICA)]],
      setCannedResponses: ['ok', [daConta('CANNED_RESPONSES', CLINICA)]],
      setClicksign: ['ok', ['CLICKSIGN_BASE_URL', 'CLICKSIGN_WEBHOOK_TOKEN']],
      setContract: ['ok', [daConta('CONTRACT_CONFIG', CLINICA), 'CONTRACT_CONFIG'], []],
      setTtsConfig: ['ok', ['TTS_ENABLED', 'TTS_VOICE']],
    }, PERMISSAO);
    expect(JSON.parse(dono.setContract.global.CONTRACT_CONFIG).publicApiUrl).toBe('https://outra.exemplo.test');
  });

  it('(b) clínica com OUTRA conta laboratório: o mesmo (ADMIN, dono e SUPER_ADMIN sem conta)', async () => {
    for (const user of [ADMIN_CLINICA, DONO_NA_CLINICA, SUPER_SEM_CONTA]) {
      const sem = await rodada([], user);
      const com = await rodada([LAB], user);
      expect([user.id, com]).toEqual([user.id, sem]);
    }
  });

  it('(c) ADMIN do laboratório: grava só a dele; a plataforma, 403 da configuração por clínica', async () => {
    const saidas = await rodada([LAB], ADMIN_LAB);
    conferir(saidas, doAdmin(LAB), PERMISSAO);
    for (const [nome, { ops, global }] of Object.entries(saidas)) {
      expect([nome, lidas(ops).filter((k) => !daPlataformaOuDoLab(k) && k !== 'CONTRACT_CONFIG')]).toEqual([nome, []]);
      globalSoGanhouDoLab(global);
    }
    // os dados do contrato do laboratório não levam nada da clínica
    expect(JSON.parse(saidas.setContract.global[daConta('CONTRACT_CONFIG', LAB)])).toEqual({
      advogado1_nome: '', advogado1_oab: '', advogado2_nome: '', advogado2_oab: '',
      escritorio_logradouro: '', escritorio_cidade: '', escritorio_cep: '', foro: 'Novo foro',
    });
  });

  it('(c) o dono (SUPER_ADMIN) dentro de uma conta laboratório: 403 VERTICAL_DENIED na plataforma, a dele no resto', async () => {
    const saidas = await rodada([LAB], DONO_NO_LAB);
    conferir(saidas, doAdmin(LAB), CODIGO_VERTICAL_NEGADA);
    for (const [nome, { ops, global }] of Object.entries(saidas)) {
      expect([nome, lidas(ops).filter((k) => !daPlataformaOuDoLab(k) && k !== 'CONTRACT_CONFIG')]).toEqual([nome, []]);
      globalSoGanhouDoLab(global);
    }
    expect(logs.some((l) => l.includes('em conta de laboratório'))).toBe(true);
  });

  it('custos da IA: a clínica como antes; o laboratório só o consumo dele, mesmo com o dono logado nele', async () => {
    async function chamadas(labs: string[], user: any) {
      limparCaches();
      const m = montarSettings({ labs, global: GLOBAL });
      const custos = jest.spyOn(m.service, 'getAiCosts').mockResolvedValue({ total: 1 } as any);
      expect(await rota(m.ctl, 'getAiCosts', req(user))).toEqual({ total: 1 });
      return custos.mock.calls;
    }
    for (const labs of [[], [LAB]]) {
      expect(await chamadas(labs, ADMIN_CLINICA)).toEqual([[{ tipo: 'clinica', tenantId: CLINICA }]]);
      expect(await chamadas(labs, DONO_NA_CLINICA)).toEqual([[{ tipo: 'plataforma' }]]);
      expect(await chamadas(labs, SUPER_SEM_CONTA)).toEqual([[{ tipo: 'plataforma' }]]);
    }
    expect(await chamadas([LAB], ADMIN_LAB)).toEqual([[{ tipo: 'clinica', tenantId: LAB }]]);
    expect(await chamadas([LAB], DONO_NO_LAB)).toEqual([[{ tipo: 'clinica', tenantId: LAB }]]);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 3. Skills da IA (PromptSkill / SkillTool / SkillAsset — sem conta, da plataforma)
// ═════════════════════════════════════════════════════════════════════════════

describe('rotas /settings/skills* — de dentro do laboratório ninguém edita', () => {
  const ARQUIVO = { originalname: 'regras.md', mimetype: 'text/markdown', size: 12, buffer: Buffer.from('# Regras\nok') };
  /** [rota, argumentos depois do req, método do serviço, argumentos que o serviço recebe] */
  const ESCRITAS: Array<[string, any[], string, any[]]> = [
    ['toggleSkill', ['skill-1', { isActive: false }], 'toggleSkill', ['skill-1', false]],
    ['resetSkillsToDefaults', [], 'resetSkillsToDefaults', []],
    ['migrateSdrToOdonto', [], 'migrateSdrToOdonto', []],
    ['createSkill', [{ name: 'Nova' }], 'createSkill', [{ name: 'Nova' }]],
    ['updateSkill', ['skill-1', { name: 'Outra' }], 'updateSkill', ['skill-1', { name: 'Outra' }]],
    ['deleteSkill', ['skill-1'], 'deleteSkill', ['skill-1']],
    ['createSkillTool', ['skill-1', { name: 'ferramenta' }], 'createSkillTool', ['skill-1', { name: 'ferramenta' }]],
    ['updateSkillTool', ['tool-1', { name: 'ferramenta-2' }], 'updateSkillTool', ['tool-1', { name: 'ferramenta-2' }]],
    ['deleteSkillTool', ['tool-1'], 'deleteSkillTool', ['tool-1']],
    ['uploadSkillAsset', ['skill-1', ARQUIVO, { asset_type: 'reference' }], 'createSkillAsset', ['skill-1', expect.objectContaining({ name: 'regras.md', content_text: '# Regras\nok' })]],
    ['updateSkillAsset', ['asset-1', { inject_mode: 'none' }], 'updateSkillAsset', ['asset-1', { inject_mode: 'none' }]],
    ['deleteSkillAsset', ['asset-1'], 'deleteSkillAsset', ['asset-1']],
  ];
  const LEITURAS: Array<[string, any[], string, any]> = [
    ['getSkills', [], 'getSkills', [{ id: 'skill-1', name: 'Atendimento' }]],
    ['getSkillTools', ['skill-1'], 'getSkillTools', [{ id: 'tool-1' }]],
    ['getSkillAssets', ['skill-1'], 'getSkillAssets', [{ id: 'asset-1' }]],
  ];
  const METODOS = [...new Set([...ESCRITAS.map((e) => e[2]), ...LEITURAS.map((l) => l[2]), 'findSkillAssetById'])];
  const METODOS_DE_ESCRITA = new Set(ESCRITAS.map((e) => e[2]));

  function montar(labs: string[]) {
    const m = montarSettings({ labs, global: GLOBAL });
    const espioes: Record<string, jest.SpyInstance> = {};
    for (const nome of METODOS) {
      const resposta = LEITURAS.find((l) => l[2] === nome)?.[3] ?? (nome === 'deleteSkillAsset' || nome === 'findSkillAssetById' ? { id: 'asset-1', name: 'regras.md', s3_key: 'skill-assets/skill-1/x.md' } : { ok: true });
      espioes[nome] = jest.spyOn(m.service as any, nome).mockResolvedValue(resposta);
    }
    return { ...m, espioes };
  }

  async function rodada(labs: string[], user: any) {
    limparCaches();
    const m = montar(labs);
    const saidas: any[] = [];
    for (const [nome, args] of [...ESCRITAS, ...LEITURAS]) {
      saidas.push([nome, await resultado(rota(m.ctl, nome, req(user), ...args))]);
    }
    const res = { set: jest.fn(), send: jest.fn() };
    saidas.push(['downloadSkillAsset', await resultado(rota(m.ctl, 'downloadSkillAsset', req(user), 'asset-1', res))]);
    const chamadas = Object.fromEntries(Object.entries(m.espioes).map(([k, s]) => [k, s.mock.calls]));
    return { saidas, chamadas, s3: [m.s3.uploadBuffer.mock.calls.length, m.s3.deleteObject.mock.calls, m.s3.getObjectBuffer.mock.calls], enviado: res.send.mock.calls.length, ops: m.ops };
  }
  const saida = (r: any, nome: string) => r.saidas.find((s: any) => s[0] === nome)[1];

  it('(a) clínica, sem laboratório: o dono (SUPER_ADMIN) edita e lê como antes', async () => {
    const r = await rodada([], DONO_NA_CLINICA);
    for (const [nome, , metodo, argsServico] of ESCRITAS) {
      expect([nome, r.chamadas[metodo]]).toEqual([nome, [argsServico]]);
    }
    for (const [nome, args, metodo, resposta] of LEITURAS) {
      expect([nome, r.chamadas[metodo]]).toEqual([nome, [args]]);
      expect(saida(r, nome)).toEqual(['ok', resposta]);
    }
    expect(r.chamadas.findSkillAssetById).toEqual([['asset-1']]);
    expect(r.s3).toEqual([1, [['skill-assets/skill-1/x.md']], [['skill-assets/skill-1/x.md']]]);
    expect(r.enviado).toBe(1);
    expect(r.ops).toEqual([]);
  });

  it('(b) clínica com OUTRA conta laboratório: o mesmo (dono e ADMIN de clínica)', async () => {
    // o upload gera um nome aleatório no S3: compara sem ele
    const semNome = (x: any) => JSON.parse(JSON.stringify(x).replace(/skill-assets\/skill-1\/[0-9a-f-]+\.md/g, 'skill-assets/skill-1/<uuid>.md'));
    for (const user of [DONO_NA_CLINICA, ADMIN_CLINICA]) {
      const sem = await rodada([], user);
      const com = await rodada([LAB], user);
      expect([user.id, semNome(com)]).toEqual([user.id, semNome(sem)]);
    }
  });

  it('(c) ADMIN do laboratório: leitura vazia, asset não encontrado, escrita 403 — o serviço e o S3 nem são chamados', async () => {
    const r = await rodada([LAB], ADMIN_LAB);
    for (const [nome] of ESCRITAS) expect([nome, saida(r, nome)]).toEqual([nome, ['erro', expect.objectContaining({ code: PERMISSAO })]]);
    for (const [nome] of LEITURAS) expect([nome, saida(r, nome)]).toEqual([nome, ['ok', []]]);
    expect(saida(r, 'downloadSkillAsset')).toEqual(['erro', expect.objectContaining({ statusCode: 404 })]);
    for (const [metodo, chamadas] of Object.entries(r.chamadas)) expect([metodo, chamadas]).toEqual([metodo, []]);
    expect(r.s3).toEqual([0, [], []]);
    expect(r.enviado).toBe(0);
  });

  it('(c) o dono (SUPER_ADMIN) dentro de uma conta laboratório: escrita 403 VERTICAL_DENIED, nada gravado nem enviado ao S3', async () => {
    const r = await rodada([LAB], DONO_NO_LAB);
    for (const [nome] of ESCRITAS) {
      expect([nome, saida(r, nome)]).toEqual([nome, ['erro', expect.objectContaining({ code: CODIGO_VERTICAL_NEGADA })]]);
    }
    for (const [metodo, chamadas] of Object.entries(r.chamadas)) {
      if (METODOS_DE_ESCRITA.has(metodo)) expect([metodo, chamadas]).toEqual([metodo, []]);
    }
    expect(r.s3.slice(0, 2)).toEqual([0, []]); // nem upload nem remoção
  });

  it('o download do laboratório é o mesmo "não encontrado" de um asset que não existe', async () => {
    const m = montar([LAB]);
    const e = await rota(m.ctl, 'downloadSkillAsset', req(ADMIN_LAB), 'asset-1', { set: jest.fn(), send: jest.fn() }).catch((x) => x);
    expect(e).toBeInstanceOf(NotFoundException);
    expect(e.message).toBe('Asset não encontrado');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 4. Memórias: perfil da organização (prompts) e limpeza/migração das skills
// ═════════════════════════════════════════════════════════════════════════════

describe('memórias — prompts do perfil da organização e rotas que reescrevem skills', () => {
  function montar(labs: string[]) {
    const b = banco({ labs, global: GLOBAL });
    const fila: any = { add: jest.fn(async () => ({})), getJob: jest.fn(async () => null) };
    const service = new MemoriesService(b.prisma, {} as any, fila);
    const ctl = new MemoriesController(service, fila);
    return { ...b, service, ctl };
  }

  async function rodada(labs: string[], user: any) {
    limparCaches();
    const m = montar(labs);
    const r = req(user);
    const passo = async (f: () => Promise<any>) => {
      const antes = m.ops.length;
      const saida = await resultado(f());
      return { saida, ops: m.ops.slice(antes) };
    };
    return {
      ler: await passo(() => rota(m.ctl, 'getOrgSettings', r)),
      previa: await passo(() => rota(m.ctl, 'previewCleanSkillsHardcoded', r)),
      previaPost: await passo(() => rota(m.ctl, 'applyCleanSkillsHardcoded', r, undefined)),
      aplicar: await passo(() => rota(m.ctl, 'applyCleanSkillsHardcoded', r, 'false')),
      migrar: await passo(() => rota(m.ctl, 'migrateSkills', r)),
      gravar: await passo(() => rota(m.ctl, 'updateOrgSettings', r, { model: 'gpt-5', incremental_prompt: '' })),
      global: m.global,
    };
  }

  const LEU_TUDO = [gs('MEMORY_ORG_MODEL'), gs('MEMORY_EXTRACTION_MODEL'), gs('MEMORY_ORG_INCREMENTAL_PROMPT'), gs('MEMORY_ORG_REBUILD_PROMPT')];
  const ESCRITAS = ['previa', 'previaPost', 'aplicar', 'migrar', 'gravar'] as const;

  it('(a) clínica, sem laboratório: o ADMIN lê; o dono (SUPER_ADMIN) lê, limpa, migra e grava como antes', async () => {
    const admin = await rodada([], ADMIN_CLINICA);
    expect(admin.ler.ops).toEqual(LEU_TUDO);
    for (const k of ESCRITAS) {
      expect([k, admin[k].saida]).toEqual([k, ['erro', expect.objectContaining({ code: PERMISSAO })]]);
      expect([k, admin[k].ops]).toEqual([k, []]);
    }
    const r = await rodada([], DONO_NA_CLINICA);
    expect(r.ler.ops).toEqual(LEU_TUDO);
    expect(r.ler.saida[1]).toMatchObject({
      model: 'gpt-4o', incremental_prompt: GLOBAL.MEMORY_ORG_INCREMENTAL_PROMPT, incremental_is_custom: true,
      rebuild_prompt: GLOBAL.MEMORY_ORG_REBUILD_PROMPT, rebuild_is_custom: true,
    });
    expect(r.previa.ops).toEqual([['skill.listar', expect.anything()]]);
    expect(r.previa.saida[1].summary).toMatchObject({ dry_run: true, total_skills: 1 });
    expect(r.previaPost.saida[1].summary).toMatchObject({ dry_run: true, total_skills: 1 });
    expect(r.aplicar.saida[1].summary).toMatchObject({ dry_run: false, total_skills: 1 });
    expect(r.migrar.ops.map(([o]) => o)).toEqual(['skill.listar', 'skill.gravar']);
    expect(r.gravar.ops).toEqual([gravou('MEMORY_ORG_MODEL'), ['gs.apagar', 'MEMORY_ORG_INCREMENTAL_PROMPT'], ...LEU_TUDO]);
    expect(r.global.MEMORY_ORG_MODEL).toBe('gpt-5');
  });

  it('(b) clínica com OUTRA conta laboratório: o mesmo (ADMIN, dono e SUPER_ADMIN sem conta)', async () => {
    for (const user of [ADMIN_CLINICA, DONO_NA_CLINICA, SUPER_SEM_CONTA]) {
      const sem = await rodada([], user);
      const com = await rodada([LAB], user);
      expect([user.id, com]).toEqual([user.id, sem]);
    }
  });

  it('(c) laboratório: prompts padrão (o modelo é da plataforma); escrita 403 e nada lido nem gravado', async () => {
    const clinica = await rodada([], DONO_NA_CLINICA);
    const r = await rodada([LAB], ADMIN_LAB);
    expect(r.ler.ops).toEqual([gs('MEMORY_ORG_MODEL'), gs('MEMORY_EXTRACTION_MODEL')]);
    expect(r.ler.saida[1]).toMatchObject({ model: 'gpt-4o', incremental_prompt: '', incremental_is_custom: false, rebuild_prompt: '', rebuild_is_custom: false });
    expect(r.ler.saida[1].incremental_prompt_default).toBe(clinica.ler.saida[1].incremental_prompt_default);
    expect(Object.keys(r.ler.saida[1])).toEqual(Object.keys(clinica.ler.saida[1]));
    for (const k of ESCRITAS) {
      expect([k, r[k].saida]).toEqual([k, ['erro', expect.objectContaining({ code: PERMISSAO })]]);
      expect([k, r[k].ops]).toEqual([k, []]);
    }
    expect(r.global).toEqual(GLOBAL);
  });

  it('(c) o dono (SUPER_ADMIN) dentro de uma conta laboratório: prévias vazias; aplicar, migrar e gravar 403 VERTICAL_DENIED', async () => {
    const clinica = await rodada([], DONO_NA_CLINICA);
    const r = await rodada([LAB], DONO_NO_LAB);
    expect(r.ler.ops).toEqual([gs('MEMORY_ORG_MODEL'), gs('MEMORY_EXTRACTION_MODEL')]);
    expect(r.ler.saida[1]).toMatchObject({ incremental_prompt: '', rebuild_prompt: '' });
    const vazia = { summary: { dry_run: true, total_skills: 0, would_change: 0, applied_changes: 0, total_chars_removed: 0 }, report: [] };
    expect(r.previa).toEqual({ saida: ['ok', vazia], ops: [] });
    expect(r.previaPost).toEqual({ saida: ['ok', vazia], ops: [] });
    expect(Object.keys(r.previa.saida[1].summary)).toEqual(Object.keys(clinica.previa.saida[1].summary));
    for (const k of ['aplicar', 'migrar', 'gravar'] as const) {
      expect([k, r[k].saida]).toEqual([k, ['erro', expect.objectContaining({ code: CODIGO_VERTICAL_NEGADA })]]);
      expect([k, r[k].ops]).toEqual([k, []]);
    }
    expect(r.global).toEqual(GLOBAL);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 5. Google Analytics (GA4) e Google Drive
// ═════════════════════════════════════════════════════════════════════════════

describe('GA4 — por conta: o laboratório usa e grava só o dele', () => {
  const B64 = Buffer.from('{"client_email":"exemplo@exemplo.test"}').toString('base64');
  const GA4_GLOBAL = { ...GLOBAL, GA4_PROPERTY_ID: 'properties/123' };
  async function rodada(labs: string[], user: any) {
    limparCaches();
    const b = banco({ labs, global: GA4_GLOBAL });
    const ctl = new AnalyticsController(new AnalyticsService(b.prisma));
    const r = req(user);
    const passo = async (f: () => Promise<any>) => {
      const antes = b.ops.length;
      const saida = await resultado(f());
      return { saida, ops: b.ops.slice(antes) };
    };
    const resumo = await passo(() => rota(ctl, 'getGa4', r)); // sem a conta de serviço: null
    b.global.GA4_SERVICE_ACCOUNT_B64 = B64;
    const config = await passo(() => rota(ctl, 'getGa4Config', r));
    const gravar = await passo(() => rota(ctl, 'saveGa4Config', r, { propertyId: '456', serviceAccountJson: '{"a":1}' }));
    const depois = await passo(() => rota(ctl, 'getGa4Config', r));
    // a credencial é criptografada (aleatória): compara sem o valor
    const global = Object.fromEntries(Object.entries(b.global).map(([k, v]) => [k, k.startsWith('GA4_SERVICE_ACCOUNT_B64_') ? '<cripto>' : v]));
    return { resumo, config, gravar, depois, global };
  }

  it('(a) clínica legada, sem laboratório: herda o par global; grava o dela', async () => {
    const r = await rodada([], ADMIN_CLINICA);
    expect(r.resumo.saida).toEqual(['ok', null]);
    expect(r.config.saida).toEqual(['ok', { isConfigured: true, propertyId: '123' }]);
    expect(gravadas(r.gravar.ops)).toEqual([daConta('GA4_SERVICE_ACCOUNT_B64', CLINICA), daConta('GA4_PROPERTY_ID', CLINICA)]);
    expect(r.depois.saida).toEqual(['ok', { isConfigured: true, propertyId: '456' }]);
    expect(r.global.GA4_PROPERTY_ID).toBe('properties/123');
  });

  it('(b) clínica com OUTRA conta laboratório: o mesmo', async () => {
    for (const user of [ADMIN_CLINICA, DONO_NA_CLINICA]) {
      const sem = await rodada([], user);
      const com = await rodada([LAB], user);
      expect([user.id, com]).toEqual([user.id, sem]);
    }
  });

  it('(c) laboratório (ADMIN ou o dono logado nele): não herda o par global nem o env; grava e lê só o dele', async () => {
    process.env.GA4_PROPERTY_ID = 'properties/env';
    process.env.GA4_SERVICE_ACCOUNT_B64 = B64;
    for (const user of [ADMIN_LAB, DONO_NO_LAB]) {
      const r = await rodada([LAB], user);
      expect(r.resumo.saida).toEqual(['ok', null]);
      expect(r.config.saida).toEqual(['ok', { isConfigured: false, propertyId: null }]);
      expect(gravadas(r.gravar.ops)).toEqual([daConta('GA4_SERVICE_ACCOUNT_B64', LAB), daConta('GA4_PROPERTY_ID', LAB)]);
      expect(r.depois.saida).toEqual(['ok', { isConfigured: true, propertyId: '456' }]);
      for (const p of [r.resumo, r.config, r.gravar, r.depois]) {
        expect(lidas(p.ops).filter((k) => !k.endsWith(`_${LAB}`))).toEqual([]);
      }
      expect(r.global.GA4_PROPERTY_ID).toBe('properties/123');
      expect(r.global.GA4_SERVICE_ACCOUNT_B64).toBe(B64);
    }
  });
});

describe('Google Drive — GET /google-drive/config', () => {
  const CONFIG = {
    configured: true, hasServiceAccount: false, hasRootFolder: true, rootFolderId: 'pasta-raiz-exemplo',
    hasOAuth: true, oauthConfigured: true, oauthConnected: true, oauthUserEmail: 'conta@exemplo.test',
    hasLetterhead: true, letterheadTemplateId: 'timbrado-exemplo', letterheadTemplateName: 'Timbrado',
  };
  function montar(labs: string[]) {
    const b = banco({ labs });
    const drive: any = { getConfig: jest.fn(async () => ({ ...CONFIG })) };
    return { ctl: new GoogleDriveController(drive, b.prisma), drive, ...b };
  }
  const MASCARADA = { ...CONFIG, rootFolderId: null, oauthUserEmail: null, letterheadTemplateId: null, letterheadTemplateName: null };

  it('(a)/(b) clínica, com ou sem laboratório: os sim/não da global, como antes', async () => {
    for (const labs of [[], [LAB]]) {
      limparCaches();
      const m = montar(labs);
      expect(await m.ctl.getConfig(req(ADMIN_CLINICA))).toEqual(MASCARADA);
      expect(m.drive.getConfig).toHaveBeenCalledTimes(1);
    }
  });

  it('(c) laboratório: tudo "não", mesmo formato, sem ler a configuração', async () => {
    const m = montar([LAB]);
    const cfg = await m.ctl.getConfig(req(ADMIN_LAB));
    expect(Object.keys(cfg).sort()).toEqual(Object.keys(CONFIG).sort());
    expect(cfg).toEqual({
      configured: false, hasServiceAccount: false, hasRootFolder: false, rootFolderId: null,
      hasOAuth: false, oauthConfigured: false, oauthConnected: false, oauthUserEmail: null,
      hasLetterhead: false, letterheadTemplateId: null, letterheadTemplateName: null,
    });
    expect(m.drive.getConfig).not.toHaveBeenCalled();
  });

  it('o dono (SUPER_ADMIN) segue com a tela inteira, em qualquer conta', async () => {
    const m = montar([LAB]);
    expect(await m.ctl.getConfig(req(DONO_NO_LAB))).toEqual(CONFIG);
    expect(m.perfis).not.toHaveBeenCalled();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 6. Follow-up: sequências
// ═════════════════════════════════════════════════════════════════════════════

describe('gravação genérica e e-mail da plataforma — nada global de dentro do laboratório', () => {
  it('PUT /settings: o dono no laboratório recusa a chave global; na clínica e sem conta grava como antes', async () => {
    for (const [user, esperado] of [
      [DONO_NO_LAB, 'erro'],
      [DONO_NA_CLINICA, 'ok'],
      [SUPER_SEM_CONTA, 'ok'],
    ] as Array<[any, string]>) {
      limparCaches();
      const m = montarSettings({ labs: [LAB], global: GLOBAL });
      const r = await resultado(m.ctl.upsert(req(user), { key: 'TTS_ENABLED', value: 'true' }));
      expect(r[0]).toBe(esperado);
      if (esperado === 'erro') {
        expect(r[1].code).toBe('VERTICAL_DENIED');
        expect(gravadas(m.ops)).toEqual([]);
      } else {
        expect(gravadas(m.ops)).toEqual(['TTS_ENABLED']);
      }
    }
  });

  it('PUT /settings: chave de tela de clínica, o dono no laboratório grava na do laboratório', async () => {
    limparCaches();
    const m = montarSettings({ labs: [LAB], global: GLOBAL });
    await m.ctl.upsert(req(DONO_NO_LAB), { key: 'MEMORY_BATCH_ENABLED', value: 'false' });
    expect(gravadas(m.ops)).toEqual([daConta('MEMORY_BATCH_ENABLED', LAB)]);
  });

  it('PUT /settings/smtp: o dono no laboratório recusa; sem conta grava como antes', async () => {
    limparCaches();
    const lab = montarSettings({ labs: [LAB], global: GLOBAL });
    const r = await resultado(lab.ctl.saveSmtp({ host: 'smtp.exemplo.test' }, req(DONO_NO_LAB)));
    expect(r[0]).toBe('erro');
    expect(r[1].code).toBe('VERTICAL_DENIED');
    expect(gravadas(lab.ops)).toEqual([]);
    limparCaches();
    const plat = montarSettings({ labs: [LAB], global: GLOBAL });
    expect((await resultado(plat.ctl.saveSmtp({ host: 'smtp.exemplo.test' }, req(SUPER_SEM_CONTA))))[0]).toBe('ok');
    expect(gravadas(plat.ops)).toEqual(['SMTP_HOST']);
  });
});

describe('follow-up — o dono no laboratório não mexe nas sequências globais', () => {
  function montarSeq(labs: string[], dono: string | null) {
    const prisma: any = {
      tenantBusinessProfile: { findMany: jest.fn(async () => labs.map((tenant_id) => ({ tenant_id }))) },
      followupSequence: {
        findUnique: jest.fn(async () => ({ tenant_id: dono })),
        update: jest.fn(async () => ({})),
        delete: jest.fn(async () => ({})),
      },
    };
    return { svc: new FollowupService(prisma, { add: jest.fn() } as any), prisma };
  }
  const escopo = (u: any) => ({ tenantId: u.tenant_id, superAdmin: u.roles.includes('SUPER_ADMIN') });

  it('sequência global: o dono na clínica e sem conta editam como antes; no laboratório, 404', async () => {
    for (const [user, edita] of [[DONO_NA_CLINICA, true], [SUPER_SEM_CONTA, true], [DONO_NO_LAB, false]] as Array<[any, boolean]>) {
      limparCaches();
      const m = montarSeq([LAB], null);
      const r = await m.svc.updateSequence('seq-global', { name: 'Novo nome' }, escopo(user)).then(() => 'ok', (e: any) => e);
      if (edita) {
        expect(r).toBe('ok');
        expect(m.prisma.followupSequence.update).toHaveBeenCalledTimes(1);
      } else {
        expect(r).toBeInstanceOf(NotFoundException);
        expect(m.prisma.followupSequence.update).not.toHaveBeenCalled();
      }
    }
  });

  it('sequência do próprio laboratório: o dono no laboratório edita', async () => {
    limparCaches();
    const m = montarSeq([LAB], LAB);
    await m.svc.updateSequence('seq-lab', { name: 'Novo nome' }, escopo(DONO_NO_LAB));
    expect(m.prisma.followupSequence.update).toHaveBeenCalledTimes(1);
  });
});

describe('follow-up — sequências do laboratório são só dele', () => {
  function montar(labs: string[]) {
    const b = banco({ labs });
    const svc = new FollowupService(b.prisma, { add: jest.fn() } as any);
    return { ctl: new FollowupController(svc), ...b };
  }
  const CASOS_CLINICA: Array<[any, any]> = [
    [ADMIN_CLINICA, { name: 'A', tenant_id: 'tenant-outra' }],
    [DONO_NA_CLINICA, { name: 'B', tenant_id: 'tenant-outra' }],
    [DONO_NA_CLINICA, { name: 'C' }],
    [SUPER_SEM_CONTA, { name: 'D' }],
  ];
  async function rodada(labs: string[]) {
    limparCaches();
    const m = montar(labs);
    await m.ctl.listSequences(req(ADMIN_CLINICA));
    await m.ctl.listSequences(req(SUPER_SEM_CONTA));
    for (const [user, body] of CASOS_CLINICA) await m.ctl.createSequence({ ...body }, req(user));
    return m.ops.map(([o, a]) => (o === 'seq.listar' ? [o, a.where] : [o, a]));
  }

  it('(a) clínica, sem laboratório: as dela + as globais; cria como antes', async () => {
    expect(await rodada([])).toEqual([
      ['seq.listar', { OR: [{ tenant_id: CLINICA }, { tenant_id: null }] }],
      ['seq.listar', {}],
      ['seq.criar', CLINICA],
      ['seq.criar', 'tenant-outra'],
      ['seq.criar', null],
      ['seq.criar', null],
    ]);
  });

  it('(b) clínica com OUTRA conta laboratório: o mesmo', async () => {
    const sem = await rodada([]);
    expect(await rodada([LAB])).toEqual(sem);
  });

  it('(c) laboratório: lista só as dele (nunca as globais) e cria sempre na conta dele', async () => {
    const m = montar([LAB]);
    await m.ctl.listSequences(req(ADMIN_LAB));
    await m.ctl.createSequence({ name: 'X', tenant_id: CLINICA }, req(ADMIN_LAB));
    await m.ctl.createSequence({ name: 'Y', tenant_id: CLINICA }, req(DONO_NO_LAB));
    await m.ctl.createSequence({ name: 'Z' }, req(DONO_NO_LAB));
    expect(m.ops.map(([o, a]) => (o === 'seq.listar' ? [o, a.where] : [o, a]))).toEqual([
      ['seq.listar', { tenant_id: LAB }],
      ['seq.criar', LAB],
      ['seq.criar', LAB],
      ['seq.criar', LAB],
    ]);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 7. Lembrete em áudio: voz do Google (GOOGLE_TTS_API_KEY)
// ═════════════════════════════════════════════════════════════════════════════

describe('lembrete em áudio — a voz do Google é das clínicas; a OpenAI é da plataforma', () => {
  const resp = (status: number, body: any, bin?: Buffer) => ({
    ok: status < 400,
    status,
    text: async () => JSON.stringify(body),
    json: async () => body,
    arrayBuffer: async () => {
      const b = bin || Buffer.from('mp3');
      return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
    },
  });
  function montar(labs: string[]) {
    const b = banco({ labs });
    const settings: any = {
      getAiConfig: jest.fn(async () => ({ apiKey: 'sk-plataforma-exemplo' })),
      get: jest.fn(async (k: string) => (k === 'GOOGLE_TTS_API_KEY' ? 'chave-google-exemplo' : null)),
    };
    const whatsapp: any = { sendMedia: jest.fn(async () => ({ key: { id: 'msg-1' } })) };
    const f = jest.fn(async (url: string) =>
      String(url).includes('generativelanguage')
        ? resp(200, { candidates: [{ content: { parts: [{ inlineData: { data: Buffer.alloc(8).toString('base64') } }] } }] })
        : resp(200, null, Buffer.from('MP3')),
    );
    global.fetch = f as any;
    return { s: new AudioDisparoService(b.prisma, settings, whatsapp), settings, whatsapp, f, ...b };
  }
  const GEMINI = { motor: 'gemini', voz: 'Kore', texto: 'Oi {nome}' };

  async function rodada(labs: string[], conta: string) {
    limparCaches();
    const m = montar(labs);
    const passo = async (fn: () => Promise<any>) =>
      fn().then((x) => ['ok', x?.mime ?? x], (e) => ['erro', e?.getResponse?.() ?? String(e)]);
    const r = {
      config: await passo(() => m.s.getConfig(conta)),
      ouvirGemini: await passo(() => m.s.ouvir(conta, GEMINI)),
      enviarGemini: await passo(() => m.s.enviarTeste(conta, GEMINI, '82999990000')),
      ouvirOpenai: await passo(() => m.s.ouvir(conta, { motor: 'openai', voz: 'nova', texto: 'Oi' })),
    };
    return {
      r,
      chaves: m.settings.get.mock.calls,
      urls: m.f.mock.calls.map((c: any[]) => String(c[0]).replace(/key=[^&]+/, 'key=<k>')),
      enviados: m.whatsapp.sendMedia.mock.calls.length,
      ops: m.ops.map(([o]) => o),
    };
  }

  it('(a) clínica, sem laboratório: Gemini com a chave global, como antes', async () => {
    const x = await rodada([], CLINICA);
    expect(x.r.config).toEqual(['ok', expect.objectContaining({ motores: { chatgpt: true, openai: true, gemini: true } })]);
    expect(x.r.ouvirGemini).toEqual(['ok', 'audio/wav']);
    expect(x.r.enviarGemini).toEqual(['ok', { ok: true }]);
    expect(x.r.ouvirOpenai).toEqual(['ok', 'audio/mpeg']);
    expect(x.chaves).toEqual([['GOOGLE_TTS_API_KEY'], ['GOOGLE_TTS_API_KEY'], ['GOOGLE_TTS_API_KEY']]);
    expect(x.urls.filter((u) => u.includes('generativelanguage'))).toHaveLength(2);
    expect(x.enviados).toBe(1);
  });

  it('(b) clínica com OUTRA conta laboratório: o mesmo', async () => {
    const sem = await rodada([], CLINICA);
    expect(await rodada([LAB], CLINICA)).toEqual(sem);
  });

  it('(c) laboratório: Gemini desligado na tela e recusado (403) ao ouvir/enviar; a chave do Google nem é lida', async () => {
    const x = await rodada([LAB], LAB);
    expect(x.r.config).toEqual(['ok', expect.objectContaining({ motores: { chatgpt: true, openai: true, gemini: false } })]);
    expect(x.r.ouvirGemini).toEqual(['erro', expect.objectContaining({ code: CODIGO_VERTICAL_NEGADA })]);
    expect(x.r.enviarGemini).toEqual(['erro', expect.objectContaining({ code: CODIGO_VERTICAL_NEGADA })]);
    // a voz da OpenAI segue: créditos da plataforma
    expect(x.r.ouvirOpenai).toEqual(['ok', 'audio/mpeg']);
    expect(x.chaves).toEqual([]);
    expect(x.urls.filter((u) => u.includes('generativelanguage'))).toEqual([]);
    expect(x.enviados).toBe(0);
  });
});

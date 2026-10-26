/**
 * Contratos & Assinatura e Voz da IA.
 *
 *  - ClickSign (ambiente e tokens), URL pública da API, voz da IA (TTS) e DJEN
 *    são da PLATAFORMA: só o SUPER_ADMIN grava. A clínica vê o status (GET sem
 *    403, mesmo formato; tokens como '********').
 *  - Dados fixos dos contratos (8 campos) são DA CLÍNICA: `CONTRACT_CONFIG_<conta>`.
 *    Campo a mais/nulo é ignorado ou convertido (nunca 400); publicApiUrl vinda da
 *    clínica é ignorada (200, `ignorados`).
 */
import * as fs from 'fs';
import * as path from 'path';
import { BadRequestException, ForbiddenException, Logger } from '@nestjs/common';
import { __limparCacheContaLegada, __limparCacheLabTenants } from '@crm/shared';
import { SettingsController } from '../settings/settings.controller';
import { SettingsService } from '../settings/settings.service';

const A = '0a0a0a0a-0000-4000-8000-00000000000a';
const B = '0b0b0b0b-0000-4000-8000-00000000000b';
const NOVA = '0c0c0c0c-0000-4000-8000-00000000000c';
const LAB = '0d0d0d0d-0000-4000-8000-00000000000d';
const CRIACAO: Record<string, Date> = {
  [A]: new Date('2025-01-10T10:00:00Z'),
  [B]: new Date('2026-02-20T10:00:00Z'),
  [NOVA]: new Date('2026-11-02T10:00:00Z'),
  [LAB]: new Date('2026-03-01T10:00:00Z'),
};

const ADMIN_A = { id: 'u-a', roles: ['ADMIN'], tenant_id: A };
const ADMIN_B = { id: 'u-b', roles: ['ADMIN'], tenant_id: B };
const DENTISTA_A = { id: 'u-d', roles: ['DENTIST'], tenant_id: A };
const ADMIN_NOVA = { id: 'u-c', roles: ['ADMIN'], tenant_id: NOVA };
const ADMIN_LAB = { id: 'u-l', roles: ['ADMIN'], tenant_id: LAB };
const ADMIN_SEM_CONTA = { id: 'u-x', roles: ['ADMIN'], tenant_id: null };
const DONO = { id: 'u-dono', roles: ['ADMIN', 'SUPER_ADMIN'], tenant_id: A };
const SUPER_SEM_CONTA = { id: 'u-s', roles: ['SUPER_ADMIN', 'ADMIN'], tenant_id: null };

const ENC_ANTES = process.env.ENCRYPTION_KEY;
const URL_ANTES = process.env.PUBLIC_API_URL;
beforeAll(() => {
  process.env.ENCRYPTION_KEY = 'chave-somente-teste';
  for (const m of ['log', 'warn', 'debug', 'error'] as const) {
    jest.spyOn(Logger.prototype, m).mockImplementation(() => undefined);
  }
});
afterAll(() => {
  if (ENC_ANTES === undefined) delete process.env.ENCRYPTION_KEY;
  else process.env.ENCRYPTION_KEY = ENC_ANTES;
  if (URL_ANTES === undefined) delete process.env.PUBLIC_API_URL;
  else process.env.PUBLIC_API_URL = URL_ANTES;
});
beforeEach(() => {
  __limparCacheContaLegada();
  __limparCacheLabTenants();
  process.env.PUBLIC_API_URL = 'https://api-do-servidor.exemplo';
});

function montar(inicial: Record<string, string>) {
  const store = new Map<string, string>(Object.entries(inicial));
  const prisma: any = {
    globalSetting: {
      findMany: jest.fn(async () => [...store.keys()].sort().map((key) => ({ key, value: store.get(key)! }))),
      findUnique: jest.fn(async ({ where }: any) => (store.has(where.key) ? { key: where.key, value: store.get(where.key)! } : null)),
      upsert: jest.fn(async ({ where, create, update }: any) => {
        store.set(where.key, store.has(where.key) ? update.value : create.value);
        return { key: where.key, value: store.get(where.key) };
      }),
    },
    tenantSetting: { findUnique: jest.fn(async () => null) },
    tenant: {
      findUnique: jest.fn(async ({ where }: any) => (CRIACAO[where.id] ? { created_at: CRIACAO[where.id] } : null)),
    },
    tenantBusinessProfile: { findMany: jest.fn(async () => [{ tenant_id: LAB }]) },
  };
  const service = new SettingsService(prisma);
  // getClicksignConfig usa import() dinâmico (o jest não carrega): mesma leitura, sem conta.
  jest.spyOn(service, 'getClicksignConfig').mockImplementation(async () => {
    const apiToken = store.get('CLICKSIGN_API_TOKEN') || '';
    return {
      baseUrl: store.get('CLICKSIGN_BASE_URL') || 'https://sandbox.clicksign.com',
      apiToken,
      webhookToken: store.get('CLICKSIGN_WEBHOOK_TOKEN') || '',
      isConfigured: !!apiToken,
    };
  });
  const ctl = new SettingsController(service, {} as any, {} as any, prisma, {} as any);
  const gravadas = () => prisma.globalSetting.upsert.mock.calls.map((c: any[]) => c[0].where.key);
  return { ctl, service, store, prisma, gravadas };
}

const req = (user: any) => ({ user });
const negado = (e: any) => {
  expect(e).toBeInstanceOf(ForbiddenException);
  expect((e as ForbiddenException).getResponse()).toMatchObject({ code: 'PERMISSION_DENIED' });
};

const DADOS_GLOBAIS = {
  advogado1_nome: 'Dra. Exemplo Global',
  advogado1_oab: 'CRO/AL 0001',
  advogado2_nome: '',
  advogado2_oab: '',
  escritorio_logradouro: 'Rua Exemplo, 1',
  escritorio_cidade: 'Cidade/UF',
  escritorio_cep: '00000-000',
  foro: 'Cidade/UF',
};
const BANCO_DE_HOJE = {
  CONTRACT_CONFIG: JSON.stringify({ ...DADOS_GLOBAIS, publicApiUrl: 'https://api-gravada.exemplo', antiga: 'x' }),
  CLICKSIGN_BASE_URL: 'https://app.clicksign.com',
  CLICKSIGN_API_TOKEN: 'token-clicksign-plataforma-123456',
  CLICKSIGN_WEBHOOK_TOKEN: 'segredo-webhook-plataforma-123456',
  TTS_ENABLED: 'true',
  TTS_VOICE: 'Kore',
};
const CHAVES_TELA = [...Object.keys(DADOS_GLOBAIS), 'publicApiUrl'].sort();

describe('ClickSign, URL pública, voz e DJEN: só o SUPER_ADMIN grava', () => {
  it('PATCH /settings/clicksign pela clínica: 403 e nada gravado; o dono grava', async () => {
    const { ctl, prisma, store } = montar(BANCO_DE_HOJE);
    for (const u of [ADMIN_A, ADMIN_B, ADMIN_SEM_CONTA]) {
      negado(await ctl.setClicksign(req(u), { baseUrl: 'https://sandbox.clicksign.com' }).catch((e) => e));
    }
    expect(prisma.globalSetting.upsert).not.toHaveBeenCalled();
    expect(await ctl.setClicksign(req(DONO), { baseUrl: 'https://sandbox.clicksign.com/' })).toEqual({ ok: true });
    expect(store.get('CLICKSIGN_BASE_URL')).toBe('https://sandbox.clicksign.com');
  });

  it('ClickSign: ambiente fora dos dois oficiais dá 400; token vazio ou mascarado mantém o atual', async () => {
    const { ctl, store, prisma } = montar(BANCO_DE_HOJE);
    for (const baseUrl of ['https://outro-site.exemplo', 'http://app.clicksign.com', 'javascript:alert(1)']) {
      expect(await ctl.setClicksign(req(DONO), { baseUrl }).catch((e) => e)).toBeInstanceOf(BadRequestException);
    }
    expect(prisma.globalSetting.upsert).not.toHaveBeenCalled();
    await ctl.setClicksign(req(DONO), { baseUrl: 'https://app.clicksign.com', apiToken: '', webhookToken: 'segr****3456' });
    expect(store.get('CLICKSIGN_API_TOKEN')).toBe('token-clicksign-plataforma-123456');
    expect(store.get('CLICKSIGN_WEBHOOK_TOKEN')).toBe('segredo-webhook-plataforma-123456');
    await ctl.setClicksign(req(DONO), { apiToken: ' token-novo ' });
    expect(store.get('CLICKSIGN_API_TOKEN')).toBe('token-novo');
  });

  it('GET /settings/clicksign: a clínica vê o mesmo formato, tokens só como ********', async () => {
    const { ctl } = montar(BANCO_DE_HOJE);
    const daClinica: any = await ctl.getClicksign(req(ADMIN_A));
    const doDono: any = await ctl.getClicksign(req(DONO));
    expect(Object.keys(daClinica).sort()).toEqual(Object.keys(doDono).sort());
    expect(daClinica).toEqual({ baseUrl: 'https://app.clicksign.com', apiToken: '********', webhookToken: '********', isConfigured: true });
    expect(doDono.apiToken).toMatch(/^toke\*+3456$/);
    const vazio: any = await montar({}).ctl.getClicksign(req(ADMIN_A));
    expect(vazio).toMatchObject({ apiToken: null, webhookToken: null, isConfigured: false });
  });

  it('PATCH /settings/tts pela clínica: 403 e nada gravado; o GET continua 200', async () => {
    const { ctl, prisma } = montar(BANCO_DE_HOJE);
    negado(await ctl.setTtsConfig(req(ADMIN_A), { enabled: false, voice: 'Puck', googleApiKey: 'chave-x' }).catch((e) => e));
    expect(prisma.globalSetting.upsert).not.toHaveBeenCalled();
    await expect(ctl.getTtsConfig()).resolves.toMatchObject({ enabled: true, voice: 'Kore' });
  });

  it('PATCH /settings/tts pelo dono: grava a plataforma (chave criptografada)', async () => {
    const { ctl, store } = montar(BANCO_DE_HOJE);
    await ctl.setTtsConfig(req(DONO), { enabled: false, voice: 'Puck', googleApiKey: 'chave-google-teste' });
    expect(store.get('TTS_ENABLED')).toBe('false');
    expect(store.get('TTS_VOICE')).toBe('Puck');
    expect(store.get('GOOGLE_TTS_API_KEY')).toMatch(/^enc:/);
  });

  it('DJEN: GET e PATCH só para o SUPER_ADMIN; PATCH sem lista dá 400', async () => {
    const { ctl, prisma } = montar({ DJEN_LAWYERS: '[{"oab":"1","uf":"AL","nome":"X"}]' });
    for (const u of [ADMIN_A, DENTISTA_A]) {
      negado(await ctl.getDjenLawyers(req(u)).catch((e) => e));
      negado(await ctl.saveDjenLawyers(req(u), { lawyers: [] }).catch((e) => e));
    }
    expect(prisma.globalSetting.upsert).not.toHaveBeenCalled();
    expect(await ctl.getDjenLawyers(req(DONO))).toEqual([{ oab: '1', uf: 'AL', nome: 'X' }]);
    expect(await ctl.saveDjenLawyers(req(DONO), {} as any).catch((e) => e)).toBeInstanceOf(BadRequestException);
  });
});

describe('Dados fixos dos contratos por conta', () => {
  describe('a clínica não grava a plataforma nem a outra conta', () => {
    it('ADMIN da A manda os 8 campos + publicApiUrl + extra: só CONTRACT_CONFIG_<A> com os 8; global intacta', async () => {
      const { ctl, service, store, gravadas } = montar(BANCO_DE_HOJE);
      const tela = { ...DADOS_GLOBAIS, advogado1_nome: 'Dra. Da Clínica A', publicApiUrl: 'https://outra.exemplo', antiga: 'x', extra: 'y' };
      expect(await ctl.setContract(req(ADMIN_A), tela as any)).toEqual({ ok: true, ignorados: ['publicApiUrl'] });
      expect(gravadas()).toEqual([`CONTRACT_CONFIG_${A}`]);
      expect(JSON.parse(store.get(`CONTRACT_CONFIG_${A}`)!)).toEqual({ ...DADOS_GLOBAIS, advogado1_nome: 'Dra. Da Clínica A' });
      expect(store.get('CONTRACT_CONFIG')).toBe(BANCO_DE_HOJE.CONTRACT_CONFIG);
      // A base dos arquivos mandados ao paciente (messages.service) não mudou.
      expect((await service.getContractConfig()).publicApiUrl).toBe('https://api-gravada.exemplo');
      // A outra clínica continua vendo o que via.
      expect(await ctl.getContract(req(ADMIN_B))).toEqual({ ...DADOS_GLOBAIS, publicApiUrl: 'https://api-gravada.exemplo' });
    });

    it('ADMIN sem conta: 403 e nada gravado', async () => {
      const { ctl, prisma } = montar(BANCO_DE_HOJE);
      negado(await ctl.setContract(req(ADMIN_SEM_CONTA), { ...DADOS_GLOBAIS }).catch((e) => e));
      expect(prisma.globalSetting.upsert).not.toHaveBeenCalled();
    });
  });

  describe('a tela continua igual', () => {
    it('GET: as mesmas 9 chaves que a tela usa, para clínica e dono', async () => {
      const { ctl } = montar(BANCO_DE_HOJE);
      for (const u of [ADMIN_A, DONO, ADMIN_NOVA, SUPER_SEM_CONTA, DENTISTA_A]) {
        expect(Object.keys(await ctl.getContract(req(u))).sort()).toEqual(CHAVES_TELA);
      }
    });

    it('ida e volta: o objeto do GET (com nulo e chave antiga guardados) salva com 200', async () => {
      const { ctl, store } = montar({
        [`CONTRACT_CONFIG_${A}`]: JSON.stringify({ ...DADOS_GLOBAIS, advogado2_nome: null, foro: 42, sobra: { a: 1 } }),
      });
      const visto: any = await ctl.getContract(req(ADMIN_A));
      expect(visto).toMatchObject({ advogado2_nome: '', foro: '42' });
      expect(await ctl.setContract(req(ADMIN_A), { ...visto, advogado2_nome: null, outra: 'z' })).toEqual({ ok: true, ignorados: ['publicApiUrl'] });
      expect(JSON.parse(store.get(`CONTRACT_CONFIG_${A}`)!)).toEqual({ ...DADOS_GLOBAIS, advogado2_nome: '', foro: '42' });
    });

    it('campo nulo limpa o valor (vira texto vazio); campo ausente mantém', async () => {
      const { ctl, store } = montar({ [`CONTRACT_CONFIG_${A}`]: JSON.stringify({ ...DADOS_GLOBAIS, foro: 'Foro antigo' }) });
      await ctl.setContract(req(ADMIN_A), { foro: null, advogado1_nome: 'Dra. Nova' } as any);
      expect(JSON.parse(store.get(`CONTRACT_CONFIG_${A}`)!)).toEqual({ ...DADOS_GLOBAIS, foro: '', advogado1_nome: 'Dra. Nova' });
    });

    it('texto longo é cortado, não recusado', async () => {
      const { ctl, store } = montar({});
      await ctl.setContract(req(ADMIN_A), { foro: 'x'.repeat(5000) });
      expect(JSON.parse(store.get(`CONTRACT_CONFIG_${A}`)!).foro).toHaveLength(1000);
    });

    it('payload sem publicApiUrl (tela nova da clínica): 200, nada ignorado', async () => {
      const { ctl } = montar(BANCO_DE_HOJE);
      expect(await ctl.setContract(req(ADMIN_A), { ...DADOS_GLOBAIS })).toEqual({ ok: true, ignorados: [] });
    });
  });

  describe('conta legada herda a global antiga; conta nova e laboratório, não', () => {
    it('B legada vê os dados globais; NOVA e laboratório em branco; publicApiUrl igual para todas', async () => {
      const { ctl } = montar(BANCO_DE_HOJE);
      expect(await ctl.getContract(req(ADMIN_B))).toEqual({ ...DADOS_GLOBAIS, publicApiUrl: 'https://api-gravada.exemplo' });
      const branco = Object.fromEntries(Object.keys(DADOS_GLOBAIS).map((k) => [k, '']));
      expect(await ctl.getContract(req(ADMIN_NOVA))).toEqual({ ...branco, publicApiUrl: 'https://api-gravada.exemplo' });
      expect(await ctl.getContract(req(ADMIN_LAB))).toEqual({ ...branco, publicApiUrl: 'https://api-gravada.exemplo' });
    });

    it('sem nada gravado: publicApiUrl vem do servidor (env)', async () => {
      const { ctl } = montar({});
      expect((await ctl.getContract(req(ADMIN_A))).publicApiUrl).toBe('https://api-do-servidor.exemplo');
    });
  });

  describe('o dono e o SUPER_ADMIN sem conta', () => {
    it('dono: os dados vão para a conta A; publicApiUrl alterada vai para a global', async () => {
      const { ctl, store, gravadas } = montar(BANCO_DE_HOJE);
      const r = await ctl.setContract(req(DONO), { ...DADOS_GLOBAIS, foro: 'Foro do Instituto', publicApiUrl: 'https://api-nova.exemplo' });
      expect(r).toEqual({ ok: true, ignorados: [] });
      expect(gravadas()).toEqual([`CONTRACT_CONFIG_${A}`, 'CONTRACT_CONFIG']);
      expect(JSON.parse(store.get(`CONTRACT_CONFIG_${A}`)!).foro).toBe('Foro do Instituto');
      const global = JSON.parse(store.get('CONTRACT_CONFIG')!);
      expect(global).toEqual({ ...DADOS_GLOBAIS, publicApiUrl: 'https://api-nova.exemplo', antiga: 'x' });
    });

    it('dono: publicApiUrl igual à atual não grava a global (não congela o env)', async () => {
      const { ctl, gravadas } = montar({});
      await ctl.setContract(req(DONO), { ...DADOS_GLOBAIS, publicApiUrl: 'https://api-do-servidor.exemplo' });
      expect(gravadas()).toEqual([`CONTRACT_CONFIG_${A}`]);
    });

    it('dono: publicApiUrl inválida dá 400 sem gravar nada', async () => {
      const { ctl, prisma } = montar(BANCO_DE_HOJE);
      for (const url of ['api sem protocolo', 'ftp://x.exemplo', 'https://']) {
        expect(await ctl.setContract(req(DONO), { ...DADOS_GLOBAIS, publicApiUrl: url }).catch((e) => e)).toBeInstanceOf(BadRequestException);
      }
      expect(prisma.globalSetting.upsert).not.toHaveBeenCalled();
    });

    it('SUPER_ADMIN sem conta: os dados vão para a global antiga (merge de antes)', async () => {
      const { ctl, store, gravadas } = montar(BANCO_DE_HOJE);
      await ctl.setContract(req(SUPER_SEM_CONTA), { foro: 'Novo foro' });
      expect(gravadas()).toEqual(['CONTRACT_CONFIG']);
      expect(JSON.parse(store.get('CONTRACT_CONFIG')!)).toEqual({ ...DADOS_GLOBAIS, foro: 'Novo foro', publicApiUrl: 'https://api-gravada.exemplo', antiga: 'x' });
    });
  });
});

describe('Telas: o gate também no front', () => {
  const web = path.resolve(__dirname, '../../../web/src/app/atendimento/settings');

  it('Contratos: ClickSign só leitura e sem URL pública para quem não é SUPER_ADMIN', () => {
    const p = fs.readFileSync(path.join(web, 'contracts/page.tsx'), 'utf8');
    expect(p).toContain("await api.patch('/settings/contract', isSuperAdmin ? contract : daClinica);");
    const salvarCs = p.indexOf("{savedCs ? 'Salvo!' : 'Salvar Clicksign'}");
    expect(p.lastIndexOf('{isSuperAdmin && (<>', salvarCs)).toBeGreaterThan(p.indexOf('{/* Webhook URL info */}') - 200);
    expect(p).toMatch(/\{isSuperAdmin && \(\s*<div className="space-y-1\.5">\s*<label[^>]*>\s*<Link size=\{12\} \/> URL Pública da API/);
    expect((p.match(/\{isSuperAdmin && \(\s*<button\s+onClick=\{\(\) => \{ setEdit(Token|Webhook)/g) || []).length).toBe(2);
  });

  it('Ajustes IA › Voz: a clínica vê só o status e não salva', () => {
    const p = fs.readFileSync(path.join(web, 'ai/page.tsx'), 'utf8');
    expect(p).toMatch(/const handleSaveTts = async \(\) => \{[\s\S]{0,200}if \(!isSuperAdmin\) return;/);
    const status = p.indexOf('Chave Google da plataforma');
    const editor = p.indexOf('API Key Google Cloud TTS');
    expect(status).toBeGreaterThan(-1);
    expect(p.lastIndexOf('{!isSuperAdmin ? (', status)).toBeGreaterThan(-1);
    expect(editor).toBeGreaterThan(status);
  });
});

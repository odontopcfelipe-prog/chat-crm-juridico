/**
 * Google Analytics (GA4) por clínica (Marketing > Analytics):
 *
 *  - cada clínica salva o PRÓPRIO par (GA4_PROPERTY_ID_<conta> e
 *    GA4_SERVICE_ACCOUNT_B64_<conta>, este criptografado) e lê só o dela;
 *  - clínica legada sem o par próprio continua com o par global de antes (e, no
 *    resumo, as variáveis de ambiente); conta nova e laboratório, não;
 *  - a origem do par é decidida pelo Property ID: nunca o Property de uma
 *    origem com a credencial de outra;
 *  - salvar: só ADMIN/SUPER_ADMIN; o dono (SUPER_ADMIN logado numa clínica)
 *    grava na clínica dele; o SUPER_ADMIN sem conta grava o par global; o ADMIN
 *    sem conta e os demais papéis recebem 403 PERMISSION_DENIED sem gravar nada;
 *  - a conta vem do token, nunca do corpo; a credencial nunca volta ao front;
 *  - a lista geral de configurações (GET /settings) mascara a credencial;
 *  - front: o formulário de configuração só aparece para o administrador.
 */
import * as fs from 'fs';
import * as path from 'path';
import { BadRequestException, ForbiddenException, Logger } from '@nestjs/common';
import { __limparCacheContaLegada, __limparCacheLabTenants } from '@crm/shared';
import { AnalyticsController } from '../analytics/analytics.controller';
import { AnalyticsService } from '../analytics/analytics.service';
import { abrirCredencialGa4 } from '../analytics/ga4-config';
import { decryptValue, encryptValue, isSensitiveKey } from '../common/utils/crypto.util';
import { SettingsService } from '../settings/settings.service';

const clientes: Array<{ credentials: any; properties: string[] }> = [];
jest.mock('@google-analytics/data', () => ({
  BetaAnalyticsDataClient: jest.fn().mockImplementation((opts: any) => {
    const cliente = { credentials: opts?.credentials, properties: [] as string[] };
    clientes.push(cliente);
    return {
      runReport: jest.fn(async (req: any) => {
        cliente.properties.push(req.property);
        return [{ rows: [] }];
      }),
    };
  }),
}));

const A = 'conta-a';
const B = 'conta-b';
const NOVA = 'conta-nova';
const LAB = 'conta-lab';
const CRIACAO: Record<string, string> = {
  [A]: '2025-01-10T00:00:00.000Z',
  [B]: '2025-06-01T00:00:00.000Z',
  [NOVA]: '2026-11-15T00:00:00.000Z',
  [LAB]: '2025-03-01T00:00:00.000Z', // laboratório legado: mesmo assim não herda
};

const ADMIN_A = { id: 'u-a', roles: ['ADMIN'], tenant_id: A };
const ADMIN_B = { id: 'u-b', roles: ['ADMIN'], tenant_id: B };
const ADMIN_NOVA = { id: 'u-n', roles: ['ADMIN'], tenant_id: NOVA };
const ADMIN_LAB = { id: 'u-l', roles: ['ADMIN'], tenant_id: LAB };
const ADMIN_SEM_CONTA = { id: 'u-x', roles: ['ADMIN'], tenant_id: null };
const ADMIN_CONTA_VAZIA = { id: 'u-y', roles: ['ADMIN'], tenant_id: '' };
const COMERCIAL_A = { id: 'u-c', roles: ['COMERCIAL'], tenant_id: A };
const DENTISTA_A = { id: 'u-d', roles: ['DENTIST'], tenant_id: A };
const DONO = { id: 'u-dono', roles: ['ADMIN', 'SUPER_ADMIN'], tenant_id: A };
const SUPER_SEM_CONTA = { id: 'u-s', roles: ['SUPER_ADMIN'], tenant_id: null };

const json = (email: string) =>
  JSON.stringify({ type: 'service_account', client_email: email, private_key: `chave-de-teste-${email}` });
const b64 = (s: string) => Buffer.from(s).toString('base64');

/** O par global antigo (Property + base64 puro), como está gravado hoje. */
const GLOBAL_ANTIGO = {
  GA4_PROPERTY_ID: 'properties/111',
  GA4_SERVICE_ACCOUNT_B64: b64(json('global@exemplo')),
};

const ENV_ANTES = {
  ENCRYPTION_KEY: process.env.ENCRYPTION_KEY,
  GA4_PROPERTY_ID: process.env.GA4_PROPERTY_ID,
  GA4_SERVICE_ACCOUNT_B64: process.env.GA4_SERVICE_ACCOUNT_B64,
};
const restaurar = (k: keyof typeof ENV_ANTES) => {
  if (ENV_ANTES[k] === undefined) delete process.env[k];
  else process.env[k] = ENV_ANTES[k];
};

beforeAll(() => {
  process.env.ENCRYPTION_KEY = 'chave-somente-teste';
  for (const m of ['log', 'warn', 'debug', 'error'] as const) {
    jest.spyOn(Logger.prototype, m).mockImplementation(() => undefined);
  }
});
afterAll(() => {
  (Object.keys(ENV_ANTES) as Array<keyof typeof ENV_ANTES>).forEach(restaurar);
});
beforeEach(() => {
  __limparCacheContaLegada();
  __limparCacheLabTenants();
  clientes.length = 0;
  delete process.env.GA4_PROPERTY_ID;
  delete process.env.GA4_SERVICE_ACCOUNT_B64;
});

function montar(inicial: Record<string, string> = {}) {
  const banco = new Map<string, string>(Object.entries(inicial));
  const gravadas: string[] = [];
  const prisma: any = {
    globalSetting: {
      findMany: jest.fn(async () => [...banco.keys()].sort().map((key) => ({ key, value: banco.get(key)! }))),
      findUnique: jest.fn(async ({ where }: any) => (banco.has(where.key) ? { key: where.key, value: banco.get(where.key)! } : null)),
      upsert: jest.fn(async ({ where, create, update }: any) => {
        gravadas.push(where.key);
        banco.set(where.key, banco.has(where.key) ? update.value : create.value);
        return {};
      }),
    },
    tenant: {
      findUnique: jest.fn(async ({ where }: any) => (CRIACAO[where.id] ? { created_at: CRIACAO[where.id] } : null)),
    },
    tenantBusinessProfile: { findMany: jest.fn(async () => [{ tenant_id: LAB }]) },
  };
  const service = new AnalyticsService(prisma);
  const ctl = new AnalyticsController(service);
  return { ctl, service, prisma, banco, gravadas };
}

const req = (user: any) => ({ user });
const negado = (e: unknown) => {
  expect(e).toBeInstanceOf(ForbiddenException);
  expect((e as ForbiddenException).getResponse()).toMatchObject({ code: 'PERMISSION_DENIED' });
};

/** O que a tela manda no "Salvar e Conectar". */
const telaSalva = (propertyId: string, email: string) => ({ propertyId, serviceAccountJson: json(email) });

describe('GA4 por clínica', () => {
  describe('(a) a clínica A não grava nem lê a da B', () => {
    it('ADMIN da A salva: só as chaves da A, credencial criptografada; a global fica como estava', async () => {
      const { ctl, banco, gravadas } = montar({ ...GLOBAL_ANTIGO });
      await ctl.saveGa4Config(req(ADMIN_A), telaSalva('222', 'a@exemplo'));
      expect(gravadas).toEqual([`GA4_SERVICE_ACCOUNT_B64_${A}`, `GA4_PROPERTY_ID_${A}`]);
      expect(banco.get(`GA4_PROPERTY_ID_${A}`)).toBe('properties/222');
      const guardada = banco.get(`GA4_SERVICE_ACCOUNT_B64_${A}`)!;
      expect(guardada.startsWith('enc:')).toBe(true);
      expect(decryptValue(guardada)).toBe(b64(json('a@exemplo')));
      expect(banco.get('GA4_PROPERTY_ID')).toBe(GLOBAL_ANTIGO.GA4_PROPERTY_ID);
      expect(banco.get('GA4_SERVICE_ACCOUNT_B64')).toBe(GLOBAL_ANTIGO.GA4_SERVICE_ACCOUNT_B64);
    });

    it('depois da A salvar, a B (legada) continua com o par global, nunca o da A', async () => {
      const { ctl } = montar({ ...GLOBAL_ANTIGO });
      await ctl.saveGa4Config(req(ADMIN_A), telaSalva('222', 'a@exemplo'));
      expect(await ctl.getGa4Config(req(ADMIN_A))).toEqual({ isConfigured: true, propertyId: '222' });
      expect(await ctl.getGa4Config(req(ADMIN_B))).toEqual({ isConfigured: true, propertyId: '111' });
      await ctl.getGa4(req(ADMIN_B));
      expect(clientes).toHaveLength(1);
      expect(clientes[0].properties).toEqual(['properties/111', 'properties/111']);
      expect(clientes[0].credentials.client_email).toBe('global@exemplo');
    });

    it('o resumo da A usa o Property e a credencial da A', async () => {
      const { ctl } = montar({ ...GLOBAL_ANTIGO });
      await ctl.saveGa4Config(req(ADMIN_A), telaSalva('222', 'a@exemplo'));
      expect(await ctl.getGa4(req(ADMIN_A))).toMatchObject({ sessions: 0, by_channel: [] });
      expect(clientes[0].properties).toEqual(['properties/222', 'properties/222']);
      expect(clientes[0].credentials).toEqual({ client_email: 'a@exemplo', private_key: 'chave-de-teste-a@exemplo' });
    });

    it('a conta vem do token: tenant_id no corpo é ignorado', async () => {
      const { ctl, gravadas } = montar();
      await ctl.saveGa4Config(req(ADMIN_A), { ...telaSalva('222', 'a@exemplo'), tenant_id: B } as any);
      expect(gravadas).toEqual([`GA4_SERVICE_ACCOUNT_B64_${A}`, `GA4_PROPERTY_ID_${A}`]);
    });
  });

  describe('(b) a tela continua com o mesmo formato e salvando', () => {
    it('o payload de hoje salva (sem erro) e o GET devolve só status e Property, nunca a credencial', async () => {
      const { ctl } = montar();
      expect(await ctl.saveGa4Config(req(ADMIN_A), telaSalva('484715478', 'a@exemplo'))).toBeUndefined();
      const r: any = await ctl.getGa4Config(req(ADMIN_A));
      expect(r).toEqual({ isConfigured: true, propertyId: '484715478' });
      expect(JSON.stringify(r)).not.toContain('chave-de-teste');
    });

    it('Property com "properties/" na frente também vale (fica um prefixo só)', async () => {
      const { ctl, banco } = montar();
      await ctl.saveGa4Config(req(ADMIN_A), telaSalva('properties/333', 'a@exemplo'));
      expect(banco.get(`GA4_PROPERTY_ID_${A}`)).toBe('properties/333');
    });

    it('sem Property ou com JSON inválido: 400 e nada gravado', async () => {
      const { ctl, gravadas } = montar();
      expect(await ctl.saveGa4Config(req(ADMIN_A), { propertyId: '', serviceAccountJson: json('a') }).catch((e) => e)).toBeInstanceOf(BadRequestException);
      expect(await ctl.saveGa4Config(req(ADMIN_A), { propertyId: '1', serviceAccountJson: '{quebrado' }).catch((e) => e)).toBeInstanceOf(BadRequestException);
      expect(gravadas).toEqual([]);
    });

    it('GET de quem só vê o Marketing (COMERCIAL) carrega sem 403', async () => {
      const { ctl } = montar({ ...GLOBAL_ANTIGO });
      expect(await ctl.getGa4Config(req(COMERCIAL_A))).toEqual({ isConfigured: true, propertyId: '111' });
      expect(await ctl.getGa4(req(COMERCIAL_A))).toMatchObject({ sessions: 0 });
    });
  });

  describe('(c) conta legada herda o par global; conta nova e laboratório, não', () => {
    it('legada sem o par próprio: lê o global (status e resumo), como antes', async () => {
      const { ctl } = montar({ ...GLOBAL_ANTIGO });
      expect(await ctl.getGa4Config(req(ADMIN_B))).toEqual({ isConfigured: true, propertyId: '111' });
      expect(await ctl.getGa4(req(ADMIN_B))).not.toBeNull();
    });

    it('legada sem nada no banco: o resumo usa as variáveis de ambiente, como antes', async () => {
      process.env.GA4_PROPERTY_ID = 'properties/999';
      process.env.GA4_SERVICE_ACCOUNT_B64 = b64(json('env@exemplo'));
      const { ctl } = montar();
      expect(await ctl.getGa4(req(ADMIN_B))).not.toBeNull();
      expect(clientes[0].properties[0]).toBe('properties/999');
      expect(clientes[0].credentials.client_email).toBe('env@exemplo');
      // o status, como antes, olha só o banco
      expect(await ctl.getGa4Config(req(ADMIN_B))).toEqual({ isConfigured: false, propertyId: null });
    });

    it('conta nova: não configurado, nem pelo global nem pelo ambiente', async () => {
      process.env.GA4_PROPERTY_ID = 'properties/999';
      process.env.GA4_SERVICE_ACCOUNT_B64 = b64(json('env@exemplo'));
      const { ctl } = montar({ ...GLOBAL_ANTIGO });
      expect(await ctl.getGa4Config(req(ADMIN_NOVA))).toEqual({ isConfigured: false, propertyId: null });
      expect(await ctl.getGa4(req(ADMIN_NOVA))).toBeNull();
      expect(clientes).toHaveLength(0);
    });

    it('laboratório (mesmo criado antes do corte): não herda o site de uma clínica', async () => {
      process.env.GA4_PROPERTY_ID = 'properties/999';
      process.env.GA4_SERVICE_ACCOUNT_B64 = b64(json('env@exemplo'));
      const { ctl } = montar({ ...GLOBAL_ANTIGO });
      expect(await ctl.getGa4Config(req(ADMIN_LAB))).toEqual({ isConfigured: false, propertyId: null });
      expect(await ctl.getGa4(req(ADMIN_LAB))).toBeNull();
      expect(clientes).toHaveLength(0);
    });

    it('conta nova e laboratório usam o par próprio depois de salvar', async () => {
      const { ctl } = montar({ ...GLOBAL_ANTIGO });
      await ctl.saveGa4Config(req(ADMIN_NOVA), telaSalva('444', 'n@exemplo'));
      await ctl.saveGa4Config(req(ADMIN_LAB), telaSalva('555', 'l@exemplo'));
      expect(await ctl.getGa4Config(req(ADMIN_NOVA))).toEqual({ isConfigured: true, propertyId: '444' });
      expect(await ctl.getGa4Config(req(ADMIN_LAB))).toEqual({ isConfigured: true, propertyId: '555' });
    });
  });

  describe('o par nunca mistura origens', () => {
    it('a conta tem só a credencial (sem Property próprio): usa o par global inteiro', async () => {
      const { ctl } = montar({ ...GLOBAL_ANTIGO, [`GA4_SERVICE_ACCOUNT_B64_${B}`]: encryptValue(b64(json('b@exemplo'))) });
      await ctl.getGa4(req(ADMIN_B));
      expect(clientes[0].properties[0]).toBe('properties/111');
      expect(clientes[0].credentials.client_email).toBe('global@exemplo');
    });

    it('a conta tem só o Property (sem credencial própria): não configurado, sem pegar a credencial global', async () => {
      process.env.GA4_SERVICE_ACCOUNT_B64 = b64(json('env@exemplo'));
      const { ctl } = montar({ ...GLOBAL_ANTIGO, [`GA4_PROPERTY_ID_${B}`]: 'properties/777' });
      expect(await ctl.getGa4Config(req(ADMIN_B))).toEqual({ isConfigured: false, propertyId: '777' });
      expect(await ctl.getGa4(req(ADMIN_B))).toBeNull();
      expect(clientes).toHaveLength(0);
    });

    it('a credencial é gravada antes do Property (o Property decide a origem na leitura)', async () => {
      const { ctl, gravadas } = montar();
      await ctl.saveGa4Config(req(ADMIN_B), telaSalva('222', 'b@exemplo'));
      expect(gravadas.indexOf(`GA4_SERVICE_ACCOUNT_B64_${B}`)).toBeLessThan(gravadas.indexOf(`GA4_PROPERTY_ID_${B}`));
    });

    it('credencial que não abre: resumo vazio (sem erro), com aviso', async () => {
      const avisos: string[] = [];
      expect(abrirCredencialGa4('enc:00:00:00', (m) => avisos.push(m))).toBeNull();
      expect(avisos).toHaveLength(1);
      expect(abrirCredencialGa4(GLOBAL_ANTIGO.GA4_SERVICE_ACCOUNT_B64, () => undefined)).toBe(GLOBAL_ANTIGO.GA4_SERVICE_ACCOUNT_B64);
      expect(abrirCredencialGa4(null, () => undefined)).toBeNull();
    });
  });

  describe('quem pode salvar', () => {
    it.each([
      ['ADMIN sem conta', ADMIN_SEM_CONTA],
      ['ADMIN com conta vazia', ADMIN_CONTA_VAZIA],
      ['COMERCIAL', COMERCIAL_A],
      ['DENTISTA', DENTISTA_A],
      ['sem usuário', undefined],
    ])('%s: 403 PERMISSION_DENIED, nada gravado', async (_n, u) => {
      const { ctl, gravadas } = montar({ ...GLOBAL_ANTIGO });
      negado(await ctl.saveGa4Config(req(u), telaSalva('222', 'x@exemplo')).catch((e) => e));
      expect(gravadas).toEqual([]);
    });

    it('a permissão vem antes da validação: corpo inválido de quem não pode também é 403', async () => {
      const { ctl } = montar();
      negado(await ctl.saveGa4Config(req(COMERCIAL_A), { propertyId: '', serviceAccountJson: '' }).catch((e) => e));
    });

    it('(d) o dono (SUPER_ADMIN logado na clínica) grava na clínica dele, não no global', async () => {
      const { ctl, banco, gravadas } = montar({ ...GLOBAL_ANTIGO });
      await ctl.saveGa4Config(req(DONO), telaSalva('888', 'dono@exemplo'));
      expect(gravadas).toEqual([`GA4_SERVICE_ACCOUNT_B64_${A}`, `GA4_PROPERTY_ID_${A}`]);
      expect(banco.get('GA4_PROPERTY_ID')).toBe(GLOBAL_ANTIGO.GA4_PROPERTY_ID);
      expect(await ctl.getGa4Config(req(DONO))).toEqual({ isConfigured: true, propertyId: '888' });
      expect(await ctl.getGa4Config(req(ADMIN_B))).toEqual({ isConfigured: true, propertyId: '111' });
    });

    it('(e) SUPER_ADMIN sem conta grava o par global (credencial criptografada, lida pelas legadas)', async () => {
      const { ctl, banco, gravadas } = montar({ ...GLOBAL_ANTIGO });
      await ctl.saveGa4Config(req(SUPER_SEM_CONTA), telaSalva('123', 'plataforma@exemplo'));
      expect(gravadas).toEqual(['GA4_SERVICE_ACCOUNT_B64', 'GA4_PROPERTY_ID']);
      expect(banco.get('GA4_SERVICE_ACCOUNT_B64')!.startsWith('enc:')).toBe(true);
      await ctl.getGa4(req(ADMIN_B));
      expect(clientes[0].properties[0]).toBe('properties/123');
      expect(clientes[0].credentials.client_email).toBe('plataforma@exemplo');
      expect(await ctl.getGa4Config(req(SUPER_SEM_CONTA))).toEqual({ isConfigured: true, propertyId: '123' });
    });
  });

  describe('a lista geral de configurações não mostra a credencial', () => {
    it('GA4_SERVICE_ACCOUNT_B64 (global e da conta) é segredo; o Property não', () => {
      expect(isSensitiveKey('GA4_SERVICE_ACCOUNT_B64')).toBe(true);
      expect(isSensitiveKey(`GA4_SERVICE_ACCOUNT_B64_${A}`)).toBe(true);
      expect(isSensitiveKey('GA4_SERVICE_ACCOUNT_B64_')).toBe(false);
      expect(isSensitiveKey(`GA4_PROPERTY_ID_${A}`)).toBe(false);
      expect(isSensitiveKey('GA4_PROPERTY_ID')).toBe(false);
    });

    it('GET /settings (SettingsService.getAll) devolve ******** no lugar das credenciais', async () => {
      const { prisma } = montar({
        ...GLOBAL_ANTIGO,
        [`GA4_SERVICE_ACCOUNT_B64_${A}`]: encryptValue(b64(json('a@exemplo'))),
        [`GA4_PROPERTY_ID_${A}`]: 'properties/222',
      });
      const lista: any[] = await new SettingsService(prisma).getAll();
      const valor = (k: string) => lista.find((r) => r.key === k)?.value;
      expect(valor('GA4_SERVICE_ACCOUNT_B64')).toBe('********');
      expect(valor(`GA4_SERVICE_ACCOUNT_B64_${A}`)).toBe('********');
      expect(valor(`GA4_PROPERTY_ID_${A}`)).toBe('properties/222');
    });
  });

  it('front: o formulário de configuração do GA4 só aparece (e só salva) para o administrador', () => {
    const p = fs.readFileSync(path.resolve(__dirname, '../../../web/src/app/atendimento/marketing/analytics/page.tsx'), 'utf8');
    expect(p).toContain("import { useRole } from '@/lib/useRole';");
    expect(p).toContain('const podeConfigurarGa4 = isAdmin || isSuperAdmin;');
    expect(p).toMatch(/const handleSaveGa4Config = async \(\) => \{\s*if \(!podeConfigurarGa4\) return;/);
    expect(p).toMatch(/\{podeConfigurarGa4 && \(\s*<div className="shrink-0 border-t border-border">\s*<button\s*onClick=\{\(\) => setShowGa4Config/);
  });
});

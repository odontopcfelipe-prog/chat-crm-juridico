/**
 * GET/PUT /settings e a Nota Fiscal: configuração de clínica é POR CONTA.
 *
 *  - ADMIN de clínica: o GET devolve só a linha MEMORY_BATCH_ENABLED (o nome que a
 *    Base de Conhecimento procura), com o valor efetivo da conta dele; o PUT grava
 *    as chaves das telas de clínica (extração diária, NFS-e) na chave DA CONTA e
 *    recusa (403 PERMISSION_DENIED) qualquer outra;
 *  - SUPER_ADMIN: igual a antes nas chaves da plataforma; com conta (o dono),
 *    as chaves de clínica vão para a conta dele;
 *  - conta legada sem a própria herda a extração diária global; conta nova, não;
 *  - NFS-e: só `nfse_*_<conta>` (sem herança), chave da API criptografada.
 */
import * as fs from 'fs';
import * as path from 'path';
import { BadRequestException, ForbiddenException, Logger } from '@nestjs/common';
import { __limparCacheContaLegada } from '@crm/shared';
import { SettingsController } from '../settings/settings.controller';
import { CLINIC_SCOPED_SETTING_KEYS } from '../settings/settings-scope';
import { SettingsService } from '../settings/settings.service';
import { NotaFiscalService } from '../nota-fiscal/nota-fiscal.service';
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
const SUPER_SEM_CONTA = { id: 'u-s', roles: ['SUPER_ADMIN'], tenant_id: null };

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
beforeEach(() => __limparCacheContaLegada());

function montar(inicial: Record<string, string>) {
  const store = new Map<string, string>(Object.entries(inicial));
  const prisma: any = {
    globalSetting: {
      findMany: jest.fn(async () =>
        [...store.keys()].sort().map((key) => ({ key, value: store.get(key)!, updated_at: new Date(0) })),
      ),
      findUnique: jest.fn(async ({ where }: any) =>
        store.has(where.key) ? { key: where.key, value: store.get(where.key)!, updated_at: new Date(0) } : null,
      ),
      upsert: jest.fn(async ({ where, create, update }: any) => {
        store.set(where.key, store.has(where.key) ? update.value : create.value);
        return { key: where.key, value: store.get(where.key) };
      }),
    },
    tenant: {
      findUnique: jest.fn(async ({ where }: any) => (CRIACAO[where.id] ? { created_at: CRIACAO[where.id] } : null)),
    },
    financialTransaction: { findUnique: jest.fn(async () => null) },
  };
  const service = new SettingsService(prisma);
  const ctl = new SettingsController(service, {} as any, {} as any, prisma, {} as any);
  const nf = new NotaFiscalService(prisma, service);
  const gravadas = () => prisma.globalSetting.upsert.mock.calls.map((c: any[]) => c[0].where.key);
  return { ctl, nf, store, prisma, gravadas };
}

const req = (user: any) => ({ user });
const negado = (e: any) => {
  expect(e).toBeInstanceOf(ForbiddenException);
  expect((e as ForbiddenException).getResponse()).toMatchObject({ code: 'PERMISSION_DENIED' });
};

const BANCO_DE_HOJE = {
  [`DAILY_SUMMARY_PHONE_${A}`]: '5582999990000',
  [`VENDA_FEITA_PHONE_${A}`]: '5582988880000',
  [`VENDA_FEITA_ENABLED_${A}`]: 'true',
  ANTHROPIC_API_KEY: 'sk-ant-somente-teste',
  VAPID_PRIVATE_KEY: 'vapid-privada-teste',
  CLICKSIGN_API_TOKEN: 'clicksign-teste',
  EVOLUTION_API_URL: 'https://evo.exemplo',
  GDRIVE_ROOT_FOLDER_ID: 'pasta-raiz-teste',
  GDRIVE_OAUTH_USER_EMAIL: 'dono@exemplo.com',
  SMTP_HOST: 'smtp.exemplo',
  MEMORY_BATCH_ENABLED: 'true',
  [`MEMORY_BATCH_ENABLED_${A}`]: 'false',
};

describe('Configurações por conta (GET/PUT /settings e NFS-e)', () => {
  describe('a clínica não lê nem grava a configuração de outra conta nem a da plataforma', () => {
    it('GET como ADMIN da B: exatamente a linha que a tela usa, com o valor da B', async () => {
      const { ctl } = montar(BANCO_DE_HOJE);
      const r = await ctl.getAll(req(ADMIN_B));
      expect(r).toEqual([{ key: 'MEMORY_BATCH_ENABLED', value: 'true' }]);
      const texto = JSON.stringify(r);
      for (const proibido of [A, 'sk-ant', '5582', 'vapid', 'clicksign', 'evo.exemplo', 'pasta-raiz', 'dono@', 'smtp']) {
        expect(texto).not.toContain(proibido);
      }
    });

    it('GET como ADMIN da A: o valor da própria conta vence o global', async () => {
      const { ctl } = montar(BANCO_DE_HOJE);
      expect(await ctl.getAll(req(ADMIN_A))).toEqual([{ key: 'MEMORY_BATCH_ENABLED', value: 'false' }]);
    });

    it.each([
      `DAILY_SUMMARY_PHONE_${A}`,
      `VENDA_FEITA_ENABLED_${A}`,
      `MEMORY_BATCH_ENABLED_${A}`,
      `nfse_cnpj_${A}`,
      `AI_AUTOBOOK_ENABLED_${B}`,
      'OPENAI_API_KEY',
      'EVOLUTION_API_URL',
      'WHATSAPP_AI_ENABLED',
      'GDRIVE_ROOT_FOLDER_ID',
      'GDRIVE_OAUTH_REFRESH_TOKEN',
      'POST_CARE_CONFIG',
      'SMTP_HOST',
      'asaas_api_key',
    ])('PUT %s como ADMIN da B: 403 PERMISSION_DENIED, nada gravado', async (key) => {
      const { ctl, prisma } = montar(BANCO_DE_HOJE);
      negado(await ctl.upsert(req(ADMIN_B), { key, value: 'x' }).catch((e) => e));
      expect(prisma.globalSetting.upsert).not.toHaveBeenCalled();
    });

    it('PUT da extração diária como ADMIN da B: só a chave da B; global e A intactas', async () => {
      const { ctl, store, gravadas } = montar(BANCO_DE_HOJE);
      await ctl.upsert(req(ADMIN_B), { key: 'MEMORY_BATCH_ENABLED', value: 'false' });
      expect(gravadas()).toEqual([`MEMORY_BATCH_ENABLED_${B}`]);
      expect(store.get('MEMORY_BATCH_ENABLED')).toBe('true');
      expect(store.get(`MEMORY_BATCH_ENABLED_${A}`)).toBe('false');
      // A outra clínica continua vendo o dela.
      expect(await ctl.getAll(req(ADMIN_A))).toEqual([{ key: 'MEMORY_BATCH_ENABLED', value: 'false' }]);
    });

    it('NFS-e salva na B não aparece na A (nem para o FINANCEIRO da A)', async () => {
      const { ctl, nf } = montar({});
      await ctl.upsert(req(ADMIN_B), { key: 'nfse_provider', value: 'enotas' });
      await ctl.upsert(req(ADMIN_B), { key: 'nfse_cnpj', value: '11222333000181' });
      await ctl.upsert(req(ADMIN_B), { key: 'nfse_api_key', value: 'chave-nfse-b' });
      const daA = await nf.getConfig(A);
      expect(daA).toMatchObject({ configured: false, provider: null, has_api_key: false, cnpj: null });
      const daB = await nf.getConfig(B);
      expect(daB).toMatchObject({ configured: true, provider: 'enotas', has_api_key: true, cnpj: '11222333000181' });
    });

    it('NFS-e: a chave global antiga (de antes) não vale para ninguém', async () => {
      const { nf } = montar({ nfse_provider: 'enotas', nfse_api_key: 'antiga', nfse_cnpj: '99888777000166' });
      expect(await nf.getConfig(A)).toMatchObject({ configured: false, cnpj: null, has_api_key: false });
    });

    it('emissão usa a NFS-e da conta da transação', async () => {
      const { ctl, nf, prisma } = montar({});
      await ctl.upsert(req(ADMIN_B), { key: 'nfse_provider', value: 'enotas' });
      prisma.financialTransaction.findUnique.mockResolvedValue({ id: 't1', tenant_id: A, amount: 100, lead: null });
      prisma.notaFiscal = { findUnique: jest.fn(async () => null), create: jest.fn() };
      // A transação é da A, que não configurou NFS-e: não usa a da B.
      const e = await nf.emit('t1', undefined).catch((x) => x);
      expect(e).toBeInstanceOf(BadRequestException);
      expect(prisma.notaFiscal.create).not.toHaveBeenCalled();
    });
  });

  describe('a tela da clínica continua igual', () => {
    it('Nota Fiscal: salva campo em branco (\'\'), acento e texto longo como antes, e o status volta certo', async () => {
      const { ctl, nf } = montar({});
      const tela: Record<string, string> = {
        nfse_provider: 'enotas',
        nfse_cnpj: '',
        nfse_inscricao_municipal: '',
        nfse_cnae_code: '8630-5/04',
        nfse_default_iss_rate: '5.00',
        nfse_auto_emit: 'true',
        nfse_servico_descricao: 'Serviços odontológicos — tratamento e manutenção '.repeat(10),
        nfse_api_key: 'chave-nfse-a',
      };
      for (const [key, value] of Object.entries(tela)) {
        await expect(ctl.upsert(req(ADMIN_A), { key, value })).resolves.toBeTruthy();
      }
      const cfg = await nf.getConfig(A);
      expect(cfg).toMatchObject({ provider: 'enotas', has_api_key: true, auto_emit: true, cnae_code: '8630-5/04' });
    });

    it('a chave da NFS-e da conta é guardada criptografada e sai mascarada no GET do SUPER_ADMIN', async () => {
      const { ctl, store } = montar({});
      await ctl.upsert(req(ADMIN_A), { key: 'nfse_api_key', value: 'chave-nfse-a' });
      expect(store.get(`nfse_api_key_${A}`)).toMatch(/^enc:/);
      const lista: any[] = await ctl.getAll(req(SUPER_SEM_CONTA));
      expect(lista.find((s) => s.key === `nfse_api_key_${A}`)?.value).toBe('********');
    });

    it('a criptografia por prefixo não muda as chaves de hoje', () => {
      expect(isSensitiveKey('nfse_api_key')).toBe(true);
      expect(isSensitiveKey('nfse_api_key_')).toBe(false);
      expect(isSensitiveKey(`nfse_api_key_${A}`)).toBe(true);
      expect(isSensitiveKey(`nfse_cnpj_${A}`)).toBe(false);
      expect(isSensitiveKey('MEMORY_BATCH_ENABLED')).toBe(false);
      expect(isSensitiveKey('OPENAI_API_KEY')).toBe(true);
    });

    it('valor inválido nas chaves de clínica: 400 (não grava)', async () => {
      const { ctl, prisma } = montar({});
      for (const [key, value] of [
        ['MEMORY_BATCH_ENABLED', 'talvez'],
        ['nfse_auto_emit', 'sim'],
        ['nfse_cnpj', 123],
        ['nfse_servico_descricao', 'x'.repeat(2001)],
      ] as Array<[string, any]>) {
        expect(await ctl.upsert(req(ADMIN_A), { key, value }).catch((e) => e)).toBeInstanceOf(BadRequestException);
      }
      expect(prisma.globalSetting.upsert).not.toHaveBeenCalled();
    });

    it('as telas que usam /settings só mandam chaves de clínica (o resto é do ramo SUPER_ADMIN)', () => {
      const raizWeb = path.resolve(__dirname, '../../../web/src');
      const usam: string[] = [];
      const varrer = (dir: string) => {
        for (const nome of fs.readdirSync(dir)) {
          const p = path.join(dir, nome);
          if (fs.statSync(p).isDirectory()) varrer(p);
          else if (/\.(tsx?|jsx?)$/.test(nome) && /['"`]\/settings['"`]/.test(fs.readFileSync(p, 'utf8'))) {
            usam.push(path.relative(raizWeb, p).replace(/\\/g, '/'));
          }
        }
      };
      varrer(raizWeb);
      // Tela nova chamando o caminho genérico: confira aqui o que ela grava (ADMIN só grava chave de clínica).
      expect(usam.sort()).toEqual([
        'app/atendimento/settings/knowledge/page.tsx',
        'app/atendimento/settings/nota-fiscal/page.tsx',
        'app/atendimento/settings/payment-gateway/page.tsx',
      ]);
      const chaves = (arq: string, re: RegExp) =>
        [...fs.readFileSync(path.join(raizWeb, arq), 'utf8').matchAll(re)].map((m) => m[1]);
      const daClinica = [
        ...chaves('app/atendimento/settings/knowledge/page.tsx', /key:\s*'([A-Za-z_]+)'/g),
        ...chaves('app/atendimento/settings/nota-fiscal/page.tsx', /^\s*(nfse_[a-z_]+)\s*:/gm),
        ...chaves('app/atendimento/settings/nota-fiscal/page.tsx', /settings\.(nfse_[a-z_]+)\s*=/g),
      ];
      expect(daClinica.length).toBe(9);
      for (const k of daClinica) expect(CLINIC_SCOPED_SETTING_KEYS.has(k)).toBe(true);
      const gateway = fs.readFileSync(path.join(raizWeb, 'app/atendimento/settings/payment-gateway/page.tsx'), 'utf8');
      expect(gateway.indexOf('if (isSuperAdmin')).toBeGreaterThan(-1);
      expect(gateway.indexOf("api.put('/settings'")).toBeGreaterThan(gateway.indexOf('if (isSuperAdmin'));
    });

    it('a 1ª abertura mostra o mesmo valor de antes (sem nada salvo: ligada)', async () => {
      const { ctl } = montar({});
      expect(await ctl.getAll(req(ADMIN_A))).toEqual([{ key: 'MEMORY_BATCH_ENABLED', value: 'true' }]);
    });
  });

  describe('conta legada herda a global antiga; conta nova não', () => {
    it('global desligada: a conta legada sem a própria vê desligada (como hoje)', async () => {
      const { ctl } = montar({ MEMORY_BATCH_ENABLED: 'false' });
      expect(await ctl.getAll(req(ADMIN_B))).toEqual([{ key: 'MEMORY_BATCH_ENABLED', value: 'false' }]);
    });

    it('global desligada: a conta NOVA sem a própria fica no padrão (ligada)', async () => {
      const { ctl } = montar({ MEMORY_BATCH_ENABLED: 'false' });
      expect(await ctl.getAll(req(ADMIN_NOVA))).toEqual([{ key: 'MEMORY_BATCH_ENABLED', value: 'true' }]);
    });
  });

  describe('o dono (SUPER_ADMIN com conta) e o SUPER_ADMIN sem conta', () => {
    it('dono: a extração diária e a NFS-e vão para a conta dele, não para a global', async () => {
      const { ctl, store, gravadas } = montar({ MEMORY_BATCH_ENABLED: 'true' });
      await ctl.upsert(req(DONO), { key: 'MEMORY_BATCH_ENABLED', value: 'false' });
      await ctl.upsert(req(DONO), { key: 'nfse_cnpj', value: '11222333000181' });
      expect(gravadas()).toEqual([`MEMORY_BATCH_ENABLED_${A}`, `nfse_cnpj_${A}`]);
      expect(store.get('MEMORY_BATCH_ENABLED')).toBe('true');
    });

    it('dono: a lista inteira, com a linha MEMORY_BATCH_ENABLED no valor da conta dele', async () => {
      const { ctl } = montar(BANCO_DE_HOJE);
      const lista: any[] = await ctl.getAll(req(DONO));
      expect(lista.filter((s) => s.key === 'MEMORY_BATCH_ENABLED')).toEqual([
        expect.objectContaining({ key: 'MEMORY_BATCH_ENABLED', value: 'false' }),
      ]);
      expect(lista.map((s) => s.key)).toEqual(expect.arrayContaining(['SMTP_HOST', 'EVOLUTION_API_URL']));
    });

    it('dono sem a linha global: a tela ainda acha MEMORY_BATCH_ENABLED (valor da conta)', async () => {
      const { ctl } = montar({ [`MEMORY_BATCH_ENABLED_${A}`]: 'false', SMTP_HOST: 'x' });
      const lista: any[] = await ctl.getAll(req(DONO));
      expect(lista.find((s) => s.key === 'MEMORY_BATCH_ENABLED')?.value).toBe('false');
    });

    it('SUPER_ADMIN: as chaves da plataforma gravam na global como antes (Gateway do Asaas)', async () => {
      const { ctl, gravadas } = montar({});
      await ctl.upsert(req(DONO), { key: 'asaas_sandbox', value: 'false' });
      await ctl.upsert(req(SUPER_SEM_CONTA), { key: 'asaas_api_key', value: 'chave-asaas-teste' });
      expect(gravadas()).toEqual(['asaas_sandbox', 'asaas_api_key']);
    });

    it('SUPER_ADMIN sem conta: a extração diária grava a global antiga; o GET é a lista de antes', async () => {
      const { ctl, gravadas, store } = montar({ SMTP_HOST: 'x' });
      await ctl.upsert(req(SUPER_SEM_CONTA), { key: 'MEMORY_BATCH_ENABLED', value: 'false' });
      expect(gravadas()).toEqual(['MEMORY_BATCH_ENABLED']);
      const lista: any[] = await ctl.getAll(req(SUPER_SEM_CONTA));
      expect(lista.map((s) => [s.key, s.value])).toEqual([
        ['MEMORY_BATCH_ENABLED', 'false'],
        ['SMTP_HOST', 'x'],
      ]);
      expect(store.size).toBe(2);
    });

    it('ADMIN sem conta: GET vazio (a tela não cai) e PUT 403', async () => {
      const { ctl, prisma } = montar(BANCO_DE_HOJE);
      expect(await ctl.getAll(req(ADMIN_SEM_CONTA))).toEqual([]);
      negado(await ctl.upsert(req(ADMIN_SEM_CONTA), { key: 'MEMORY_BATCH_ENABLED', value: 'false' }).catch((e) => e));
      expect(prisma.globalSetting.upsert).not.toHaveBeenCalled();
    });
  });
});

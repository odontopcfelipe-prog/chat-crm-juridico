/**
 * Respostas rápidas (menu "/" do inbox) e dias de "lead parado" do CRM são POR
 * CONTA (`CANNED_RESPONSES_<conta>`, `CRM_CONFIG_<conta>`):
 *
 *  - a clínica lê e grava só as dela (o dono logado numa clínica também);
 *  - a tela continua igual: mesmo payload → 200, mesmo formato no GET;
 *  - conta legada sem a própria herda a global antiga; conta nova e laboratório,
 *    não (padrão do código: [] e 3 dias);
 *  - SUPER_ADMIN sem conta grava a global antiga; ADMIN sem conta leva 403.
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
const RECEPCAO_A = { id: 'u-r', roles: ['OPERADOR'], tenant_id: A };
const ADMIN_NOVA = { id: 'u-c', roles: ['ADMIN'], tenant_id: NOVA };
const ADMIN_LAB = { id: 'u-l', roles: ['ADMIN'], tenant_id: LAB };
const ADMIN_SEM_CONTA = { id: 'u-x', roles: ['ADMIN'], tenant_id: null };
const DONO = { id: 'u-dono', roles: ['ADMIN', 'SUPER_ADMIN'], tenant_id: A };
const SUPER_SEM_CONTA = { id: 'u-s', roles: ['SUPER_ADMIN', 'ADMIN'], tenant_id: null };

beforeAll(() => {
  for (const m of ['log', 'warn', 'debug', 'error'] as const) {
    jest.spyOn(Logger.prototype, m).mockImplementation(() => undefined);
  }
});
beforeEach(() => {
  __limparCacheContaLegada();
  __limparCacheLabTenants();
});

function montar(inicial: Record<string, string>, opts: { falhaNaLeitura?: boolean } = {}) {
  const store = new Map<string, string>(Object.entries(inicial));
  const prisma: any = {
    globalSetting: {
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
      findUnique: jest.fn(async ({ where }: any) => (CRIACAO[where.id] ? { created_at: CRIACAO[where.id] } : null)),
    },
    tenantBusinessProfile: { findMany: jest.fn(async () => [{ tenant_id: LAB }]) },
  };
  const service = new SettingsService(prisma);
  const ctl = new SettingsController(service, {} as any, {} as any, prisma, {} as any);
  const gravadas = () => prisma.globalSetting.upsert.mock.calls.map((c: any[]) => c[0].where.key);
  return { ctl, store, prisma, gravadas };
}

const req = (user: any) => ({ user });
const negado = (e: any) => {
  expect(e).toBeInstanceOf(ForbiddenException);
  expect((e as ForbiddenException).getResponse()).toMatchObject({ code: 'PERMISSION_DENIED' });
};

const LISTA_ANTIGA = [
  { id: 'r1', label: 'pix', text: 'Chave PIX da clínica: exemplo' },
  { id: 'r2', label: 'endereco', text: 'Rua Exemplo, 100' },
];
const BANCO_DE_HOJE = {
  CANNED_RESPONSES: JSON.stringify(LISTA_ANTIGA),
  CRM_CONFIG: JSON.stringify({ stagnationDays: 7 }),
};

describe('Respostas rápidas e lead parado por conta', () => {
  describe('a clínica não lê nem grava a configuração de outra conta', () => {
    it('PATCH das respostas pelo ADMIN da B: só a chave da B; global e A intactas', async () => {
      const { ctl, store, gravadas } = montar(BANCO_DE_HOJE);
      const nova = [...LISTA_ANTIGA.slice(1), { id: 'r3', label: 'teste-b', text: 'Só da B' }];
      await ctl.setCannedResponses(req(ADMIN_B), { responses: nova });
      expect(gravadas()).toEqual([`CANNED_RESPONSES_${B}`]);
      expect(store.get('CANNED_RESPONSES')).toBe(JSON.stringify(LISTA_ANTIGA));
      expect(await ctl.getCannedResponses(req(ADMIN_A))).toEqual(LISTA_ANTIGA);
      expect(await ctl.getCannedResponses(req(RECEPCAO_A))).toEqual(LISTA_ANTIGA);
      expect(await ctl.getCannedResponses(req(ADMIN_B))).toEqual(nova);
    });

    it('a A com lista própria lê a dela (a da B e a global não entram)', async () => {
      const daA = [{ id: 'a1', label: 'oi', text: 'Olá da A' }];
      const { ctl } = montar({ ...BANCO_DE_HOJE, [`CANNED_RESPONSES_${A}`]: JSON.stringify(daA), [`CANNED_RESPONSES_${B}`]: '[]' });
      expect(await ctl.getCannedResponses(req(RECEPCAO_A))).toEqual(daA);
      expect(await ctl.getCannedResponses(req(ADMIN_B))).toEqual([]);
    });

    it('PATCH do lead parado pela B: CRM_CONFIG_<B> só com stagnationDays; a global e a A seguem 7', async () => {
      const { ctl, store, gravadas } = montar(BANCO_DE_HOJE);
      await ctl.setCrmConfig(req(ADMIN_B), { stagnationDays: 5, lixo: 'x' } as any);
      expect(gravadas()).toEqual([`CRM_CONFIG_${B}`]);
      expect(store.get(`CRM_CONFIG_${B}`)).toBe('{"stagnationDays":5}');
      expect(store.get('CRM_CONFIG')).toBe('{"stagnationDays":7}');
      expect(await ctl.getCrmConfig(req(RECEPCAO_A))).toEqual({ stagnationDays: 7 });
      expect(await ctl.getCrmConfig(req(ADMIN_B))).toEqual({ stagnationDays: 5 });
    });
  });

  describe('a tela da clínica continua igual', () => {
    it('payload igual ao da tela (com item recém-criado em branco): 200 e salva', async () => {
      const { ctl, store } = montar(BANCO_DE_HOJE);
      const tela = [...LISTA_ANTIGA, { id: 'k9x', label: '', text: '' }];
      expect(await ctl.setCannedResponses(req(ADMIN_A), { responses: tela })).toEqual({ ok: true });
      expect(JSON.parse(store.get(`CANNED_RESPONSES_${A}`)!)).toEqual(tela);
    });

    it('lead parado: os valores que a tela manda (presets, digitado, onBlur) dão 200', async () => {
      const { ctl, store } = montar({});
      for (const v of [1, 2, 3, 5, 7, 14, 90]) {
        expect(await ctl.setCrmConfig(req(ADMIN_A), { stagnationDays: v })).toEqual({ ok: true });
        expect(store.get(`CRM_CONFIG_${A}`)).toBe(JSON.stringify({ stagnationDays: v }));
      }
    });

    it('GET do lead parado devolve só {stagnationDays} (chave lixo antiga não sai)', async () => {
      const { ctl } = montar({ CRM_CONFIG: JSON.stringify({ stagnationDays: 4, lixo: 'x'.repeat(100) }) });
      expect(await ctl.getCrmConfig(req(ADMIN_A))).toEqual({ stagnationDays: 4 });
    });

    it('valor guardado malformado: o inbox recebe só os itens válidos (nunca cai)', async () => {
      for (const [guardado, esperado] of [
        ['{}', []],
        ['não é json', []],
        [JSON.stringify([{ id: 'x' }, null, 'texto', { id: 7, label: 'ok', text: 'vale' }, { label: 1, text: 'n' }]), [{ id: '7', label: 'ok', text: 'vale' }]],
      ] as Array<[string, any[]]>) {
        const { ctl } = montar({ [`CANNED_RESPONSES_${A}`]: guardado });
        expect(await ctl.getCannedResponses(req(RECEPCAO_A))).toEqual(esperado);
      }
    });

    it('erro do banco na leitura: [] e 3 dias (nunca 500)', async () => {
      const { ctl } = montar(BANCO_DE_HOJE, { falhaNaLeitura: true });
      expect(await ctl.getCannedResponses(req(ADMIN_A))).toEqual([]);
      expect(await ctl.getCrmConfig(req(ADMIN_A))).toEqual({ stagnationDays: 3 });
    });

    it('respostas: corpo sem lista dá 400 e não apaga nada; acima do limite, 400', async () => {
      const { ctl, prisma } = montar(BANCO_DE_HOJE);
      for (const corpo of [{}, { responses: {} }, { responses: 'x' }, { responses: null }]) {
        expect(await ctl.setCannedResponses(req(ADMIN_A), corpo as any).catch((e) => e)).toBeInstanceOf(BadRequestException);
      }
      const longo = [{ id: 'l', label: 'l', text: 'x'.repeat(50_001) }];
      expect(await ctl.setCannedResponses(req(ADMIN_A), { responses: longo }).catch((e) => e)).toBeInstanceOf(BadRequestException);
      const muitas = Array.from({ length: 2001 }, (_, i) => ({ id: `i${i}`, label: 'a', text: 'b' }));
      expect(await ctl.setCannedResponses(req(ADMIN_A), { responses: muitas }).catch((e) => e)).toBeInstanceOf(BadRequestException);
      expect(prisma.globalSetting.upsert).not.toHaveBeenCalled();
    });

    it('respostas: item com tipo errado é descartado (o resto salva)', async () => {
      const { ctl, store } = montar({});
      await ctl.setCannedResponses(req(ADMIN_A), {
        responses: [{ id: 'a', label: 'ok', text: 'vale' }, { id: 'b', label: 'x', text: 9 }, { id: 'c', text: 'sem atalho' }] as any,
      });
      expect(JSON.parse(store.get(`CANNED_RESPONSES_${A}`)!)).toEqual([{ id: 'a', label: 'ok', text: 'vale' }]);
    });

    it('lead parado: fora de 1..90 é limitado; inválido ou ausente mantém o atual (sem 400)', async () => {
      const { ctl, store } = montar({ [`CRM_CONFIG_${A}`]: '{"stagnationDays":6}' });
      await ctl.setCrmConfig(req(ADMIN_A), { stagnationDays: 0 });
      expect(store.get(`CRM_CONFIG_${A}`)).toBe('{"stagnationDays":1}');
      await ctl.setCrmConfig(req(ADMIN_A), { stagnationDays: 200 });
      expect(store.get(`CRM_CONFIG_${A}`)).toBe('{"stagnationDays":90}');
      for (const v of ['abc', null, undefined, '']) {
        expect(await ctl.setCrmConfig(req(ADMIN_A), { stagnationDays: v } as any)).toEqual({ ok: true });
      }
      expect(store.get(`CRM_CONFIG_${A}`)).toBe('{"stagnationDays":90}');
    });

    it('nenhuma varredura por prefixo da GlobalSetting pega CRM_ ou CANNED_', () => {
      const raizes = [path.resolve(__dirname, '..'), path.resolve(__dirname, '../../../worker/src')];
      const chavesNovas = [`CRM_CONFIG_${A}`, `CANNED_RESPONSES_${A}`];
      const achados: string[] = [];
      let prefixos = 0;
      const varrer = (dir: string) => {
        for (const nome of fs.readdirSync(dir)) {
          const p = path.join(dir, nome);
          if (fs.statSync(p).isDirectory()) varrer(p);
          else if (/\.ts$/.test(nome) && !/\.spec\.ts$/.test(nome)) {
            for (const m of fs.readFileSync(p, 'utf8').matchAll(/startsWith\s*:\s*['"`]([^'"`$]*)['"`]/g)) {
              prefixos++;
              if (chavesNovas.some((k) => k.startsWith(m[1]))) achados.push(`${path.basename(p)}: ${m[1]}`);
            }
          }
        }
      };
      raizes.forEach(varrer);
      expect(prefixos).toBeGreaterThan(0); // a varredura achou as consultas por prefixo
      expect(achados).toEqual([]);
    });
  });

  describe('conta legada herda a global antiga; conta nova e laboratório, não', () => {
    it('legadas sem a própria: a lista e os dias globais (como hoje)', async () => {
      const { ctl } = montar(BANCO_DE_HOJE);
      expect(await ctl.getCannedResponses(req(ADMIN_B))).toEqual(LISTA_ANTIGA);
      expect(await ctl.getCrmConfig(req(ADMIN_B))).toEqual({ stagnationDays: 7 });
    });

    it('conta nova: lista vazia e 3 dias', async () => {
      const { ctl } = montar(BANCO_DE_HOJE);
      expect(await ctl.getCannedResponses(req(ADMIN_NOVA))).toEqual([]);
      expect(await ctl.getCrmConfig(req(ADMIN_NOVA))).toEqual({ stagnationDays: 3 });
    });

    it('laboratório (mesmo criado antes do corte): não herda da clínica', async () => {
      const { ctl } = montar(BANCO_DE_HOJE);
      expect(await ctl.getCannedResponses(req(ADMIN_LAB))).toEqual([]);
      expect(await ctl.getCrmConfig(req(ADMIN_LAB))).toEqual({ stagnationDays: 3 });
    });

    it('laboratório com a própria lista: lê a dela', async () => {
      const doLab = [{ id: 'l1', label: 'prazo', text: 'Prazo do lab' }];
      const { ctl } = montar({ ...BANCO_DE_HOJE, [`CANNED_RESPONSES_${LAB}`]: JSON.stringify(doLab) });
      expect(await ctl.getCannedResponses(req(ADMIN_LAB))).toEqual(doLab);
    });
  });

  describe('o dono (SUPER_ADMIN com conta) e o SUPER_ADMIN sem conta', () => {
    it('dono: grava na conta dele (A), nunca na global', async () => {
      const { ctl, store, gravadas } = montar(BANCO_DE_HOJE);
      await ctl.setCannedResponses(req(DONO), { responses: [{ id: 'd', label: 'dono', text: 'do Instituto' }] });
      await ctl.setCrmConfig(req(DONO), { stagnationDays: 2 });
      expect(gravadas()).toEqual([`CANNED_RESPONSES_${A}`, `CRM_CONFIG_${A}`]);
      expect(store.get('CANNED_RESPONSES')).toBe(JSON.stringify(LISTA_ANTIGA));
      expect(store.get('CRM_CONFIG')).toBe('{"stagnationDays":7}');
    });

    it('SUPER_ADMIN sem conta: grava e lê a global antiga', async () => {
      const { ctl, gravadas } = montar(BANCO_DE_HOJE);
      await ctl.setCannedResponses(req(SUPER_SEM_CONTA), { responses: [{ id: 'g', label: 'g', text: 'global' }] });
      await ctl.setCrmConfig(req(SUPER_SEM_CONTA), { stagnationDays: 9 });
      expect(gravadas()).toEqual(['CANNED_RESPONSES', 'CRM_CONFIG']);
      expect(await ctl.getCannedResponses(req(SUPER_SEM_CONTA))).toEqual([{ id: 'g', label: 'g', text: 'global' }]);
      expect(await ctl.getCrmConfig(req(SUPER_SEM_CONTA))).toEqual({ stagnationDays: 9 });
    });

    it('ADMIN sem conta: 403 PERMISSION_DENIED ao gravar, nada gravado', async () => {
      const { ctl, prisma } = montar(BANCO_DE_HOJE);
      negado(await ctl.setCannedResponses(req(ADMIN_SEM_CONTA), { responses: [] }).catch((e) => e));
      negado(await ctl.setCrmConfig(req(ADMIN_SEM_CONTA), { stagnationDays: 4 }).catch((e) => e));
      expect(prisma.globalSetting.upsert).not.toHaveBeenCalled();
    });
  });
});

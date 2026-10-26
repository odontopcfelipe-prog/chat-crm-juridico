/**
 * Pesquisa pós-atendimento (NPS): configuração POR CONTA (POST_CARE_CONFIG_<conta>).
 *
 *  - o modal "Configurar" (PATCH /post-care/config) e o liga/desliga da Central
 *    de Disparos gravam SÓ na chave da conta; a global antiga não é mais escrita;
 *  - a conta legada sem a própria herda a global antiga (a mesma tela de antes na
 *    1ª abertura); a conta nova fica no padrão;
 *  - o 1º salvamento parte do que a conta via (nada volta ao padrão sem querer);
 *  - campo a mais no corpo é ignorado (a tela manda o objeto inteiro do GET);
 *  - o "test-send" não cria pesquisa para consulta de outra conta.
 */
import { BadRequestException, Logger } from '@nestjs/common';
import { __limparCacheContaLegada } from '@crm/shared';
import { PostCareService } from '../post-care/post-care.service';
import { PostCareController } from '../post-care/post-care.controller';
import { FollowupService } from '../followup/followup.service';
import { DEFAULT_CONFIG } from '../post-care/post-care-templates';

const A = 'conta-a';
const B = 'conta-b';
const NOVA = 'conta-nova';
const CRIACAO: Record<string, Date> = {
  [A]: new Date('2025-01-10T10:00:00Z'),
  [B]: new Date('2026-02-20T10:00:00Z'),
  [NOVA]: new Date('2026-11-02T10:00:00Z'),
};
const GLOBAL = 'POST_CARE_CONFIG';
const daConta = (t: string) => `POST_CARE_CONFIG_${t}`;

beforeAll(() => {
  for (const m of ['log', 'warn', 'debug', 'error'] as const) {
    jest.spyOn(Logger.prototype, m).mockImplementation(() => undefined);
  }
});
beforeEach(() => __limparCacheContaLegada());

/**
 * Banco falso: GlobalSetting em memória; Tenant com data de criação; o resto
 * responde vazio (null / [] / 0) — o suficiente para o painel Operacional.
 */
function montar(inicial: Record<string, any>, eventos: Record<string, any> = {}) {
  const store = new Map<string, string>(
    Object.entries(inicial).map(([k, v]) => [k, typeof v === 'string' ? v : JSON.stringify(v)]),
  );
  const globalSetting = {
    findUnique: jest.fn(async ({ where }: any) => (store.has(where.key) ? { key: where.key, value: store.get(where.key)! } : null)),
    findMany: jest.fn(async ({ where }: any = {}) => {
      const chaves = [...store.keys()].filter((k) =>
        where?.key?.in ? where.key.in.includes(k) : where?.key?.startsWith ? k.startsWith(where.key.startsWith) : true,
      );
      return chaves.map((key) => ({ key, value: store.get(key)! }));
    }),
    upsert: jest.fn(async ({ where, create, update }: any) => {
      store.set(where.key, store.has(where.key) ? update.value : create.value);
      return { key: where.key, value: store.get(where.key) };
    }),
  };
  const especificos: Record<string, any> = {
    globalSetting,
    tenant: {
      findUnique: jest.fn(async ({ where }: any) => (CRIACAO[where.id] ? { created_at: CRIACAO[where.id] } : null)),
    },
    calendarEvent: {
      findUnique: jest.fn(async ({ where }: any) => eventos[where.id] ?? null),
      findMany: jest.fn(async () => []),
    },
    postCareSurvey: {
      findUnique: jest.fn(async () => null),
      findFirst: jest.fn(async () => null),
      findMany: jest.fn(async () => []),
      count: jest.fn(async () => 0),
      create: jest.fn(async ({ data }: any) => ({ id: 'nova-pesquisa', ...data })),
      update: jest.fn(async () => ({})),
    },
  };
  const vazio = (metodo: string) => {
    if (metodo === 'findMany' || metodo === 'groupBy') return [];
    if (metodo === 'count') return 0;
    if (metodo === 'aggregate') return { _avg: {}, _count: {}, _sum: {} };
    return null;
  };
  const prisma: any = new Proxy(especificos, {
    get(alvo, modelo: string) {
      if (modelo in alvo) return alvo[modelo];
      if (modelo === '$queryRaw' || modelo === '$queryRawUnsafe') return jest.fn(async () => []);
      return new Proxy({}, { get: (_x, metodo: string) => jest.fn(async () => vazio(metodo)) });
    },
  });
  const settings: any = { get: jest.fn(async () => null), set: jest.fn() };
  const svc = new PostCareService(prisma, settings);
  const ctl = new PostCareController(svc);
  const followup = new FollowupService(prisma, {} as any);
  const lido = (k: string) => (store.has(k) ? JSON.parse(store.get(k)!) : undefined);
  const gravadas = () => globalSetting.upsert.mock.calls.map((c: any[]) => c[0].where.key);
  return { svc, ctl, followup, store, lido, gravadas, prisma, settings };
}

const req = (user: any) => ({ user });
const ADMIN_A = { id: 'u-a', roles: ['ADMIN'], tenant_id: A };
const DONO = { id: 'u-dono', roles: ['ADMIN', 'SUPER_ADMIN'], tenant_id: A };
const GLOBAL_DE_HOJE = { initial_choice: 'formal', delay_hours: 3, enabled: true };

describe('Pesquisa pós-atendimento — configuração por conta', () => {
  describe('uma clínica não muda a configuração da outra', () => {
    it('Configurar na A: grava só POST_CARE_CONFIG_A; a B continua vendo a global antiga', async () => {
      const { svc, gravadas, lido } = montar({ [GLOBAL]: GLOBAL_DE_HOJE });
      await svc.updateConfig(A, { initial_choice: 'custom', initial_custom: 'Olá do A' });
      expect(gravadas()).toEqual([daConta(A)]);
      expect(lido(daConta(A))).toMatchObject({ initial_choice: 'custom', initial_custom: 'Olá do A', delay_hours: 3 });
      expect(lido(GLOBAL)).toEqual(GLOBAL_DE_HOJE);
      expect(await svc.getConfig(B)).toMatchObject({ initial_choice: 'formal', delay_hours: 3 });
    });

    it('liga/desliga da Central na A: só a A desliga; a B segue ligada; a global fica intacta', async () => {
      const { followup, lido, gravadas } = montar({ [GLOBAL]: GLOBAL_DE_HOJE });
      await followup.setOperacionalToggle(A, 'pos', false);
      expect(gravadas()).toEqual([daConta(A)]);
      expect(lido(daConta(A))).toEqual({ ...GLOBAL_DE_HOJE, enabled: false });
      expect(lido(GLOBAL)).toEqual(GLOBAL_DE_HOJE);
      expect((await followup.getOperacional(A)).pos.enabled).toBe(false);
      expect((await followup.getOperacional(B)).pos.enabled).toBe(true);
    });

    it('Configurar sem conta no login: 400, nada gravado (a global não é mais escrita pela tela)', async () => {
      const { ctl, gravadas } = montar({ [GLOBAL]: GLOBAL_DE_HOJE });
      const e = await ctl.updateConfig(req({ id: 'u-s', roles: ['ADMIN', 'SUPER_ADMIN'], tenant_id: null }), { enabled: false }).catch((x) => x);
      expect(e).toBeInstanceOf(BadRequestException);
      expect(gravadas()).toEqual([]);
    });

    it('test-send com consulta da B, chamado pela A: não cria pesquisa', async () => {
      const ev = { id: 'ev-b', tenant_id: B, patient_id: 'p-b', status: 'CONCLUIDO', type: 'CONSULTA', start_at: new Date(), end_at: null, title: 'Limpeza', assigned_user_id: null };
      const { ctl, prisma } = montar({}, { 'ev-b': ev });
      expect(await ctl.testSend(req(ADMIN_A), { appointment_id: 'ev-b' })).toBeNull();
      expect(prisma.postCareSurvey.create).not.toHaveBeenCalled();
    });

    it('test-send de ADMIN sem conta no login: 400', async () => {
      const { ctl, prisma } = montar({});
      const e = await Promise.resolve()
        .then(() => ctl.testSend(req({ id: 'u-x', roles: ['ADMIN'], tenant_id: null }), { appointment_id: 'ev' }))
        .catch((x) => x);
      expect(e).toBeInstanceOf(BadRequestException);
      expect(prisma.calendarEvent.findUnique).not.toHaveBeenCalled();
    });

    it('resposta do paciente da B usa a configuração da B', async () => {
      const { svc, prisma } = montar({ [daConta(B)]: { send_thanks_on_positive: false }, [GLOBAL]: { send_thanks_on_positive: true } });
      prisma.postCareSurvey.findFirst.mockResolvedValue({ id: 's-b', tenant_id: B });
      const auto = jest.spyOn(svc as any, 'queueAutoReply');
      await svc.tryCaptureResponse(B, 'p-b', 'nota 10');
      expect(auto).not.toHaveBeenCalled();
      // A A (legada, sem a própria) segue a global, que agradece.
      prisma.postCareSurvey.findFirst.mockResolvedValue({ id: 's-a', tenant_id: A });
      await svc.tryCaptureResponse(A, 'p-a', 'nota 10');
      expect(auto).toHaveBeenCalledWith('s-a', 'thanks');
    });
  });

  describe('a tela da clínica continua igual', () => {
    it('1ª abertura do Configurar: os mesmos valores de antes (herdados da global) + _meta', async () => {
      const { ctl } = montar({ [GLOBAL]: GLOBAL_DE_HOJE });
      const r: any = await ctl.getConfig(req(ADMIN_A));
      expect(r).toMatchObject({ ...DEFAULT_CONFIG, ...GLOBAL_DE_HOJE });
      expect(r._meta.choices.length).toBe(4);
    });

    it('Salvar com o objeto inteiro do GET (mais campos de sobra): salva, sem 400', async () => {
      const { ctl, lido } = montar({ [GLOBAL]: { ...GLOBAL_DE_HOJE, campo_legado: 'x' } });
      const doGet: any = await ctl.getConfig(req(ADMIN_A));
      const { _meta, ...payload } = doGet;
      const salvo = await ctl.updateConfig(req(ADMIN_A), { ...payload, delay_hours: 5, inventado: 'y' } as any);
      expect(salvo).toMatchObject({ delay_hours: 5, initial_choice: 'formal' });
      expect(lido(daConta(A))).not.toHaveProperty('inventado');
      expect(_meta).toBeDefined();
    });

    it('as mesmas validações de antes (atraso 1..48, estilo válido)', async () => {
      const { svc } = montar({});
      expect(await svc.updateConfig(A, { delay_hours: 99, initial_choice: 'xx' as any })).toMatchObject({ delay_hours: 48, initial_choice: 'descontraido' });
      expect(await svc.updateConfig(A, { delay_hours: 0 })).toMatchObject({ delay_hours: 1 });
    });

    it('test-send com consulta da própria conta: cria a pesquisa com o atraso da conta', async () => {
      const fim = new Date('2026-10-20T15:00:00Z');
      const ev = { id: 'ev-a', tenant_id: A, patient_id: 'p-a', status: 'CONCLUIDO', type: 'CONSULTA', start_at: fim, end_at: fim, title: 'Limpeza', assigned_user_id: 'd-1' };
      const { ctl, prisma } = montar({ [daConta(A)]: { delay_hours: 5 }, [GLOBAL]: { delay_hours: 2 } }, { 'ev-a': ev });
      expect(await ctl.testSend(req(ADMIN_A), { appointment_id: 'ev-a' })).toEqual({ survey_id: 'nova-pesquisa', created: true });
      expect(prisma.postCareSurvey.create.mock.calls[0][0].data).toMatchObject({
        tenant_id: A,
        trigger_at: new Date(fim.getTime() + 5 * 3600_000),
      });
    });

    it('Central de Disparos sem nada salvo: o card NPS aparece ligado, como antes', async () => {
      const { followup } = montar({});
      expect((await followup.getOperacional(A)).pos.enabled).toBe(true);
    });

    it('desligar e religar na Central preserva o texto da clínica', async () => {
      const { followup, lido } = montar({ [daConta(A)]: { initial_choice: 'custom', initial_custom: 'Texto da A' } });
      await followup.setOperacionalToggle(A, 'pos', false);
      await followup.setOperacionalToggle(A, 'pos', true);
      expect(lido(daConta(A))).toEqual({ initial_choice: 'custom', initial_custom: 'Texto da A', enabled: true });
    });
  });

  describe('conta legada herda a global antiga; conta nova não', () => {
    it('legada sem a própria: a global antiga (inclusive desligada)', async () => {
      const { svc, followup } = montar({ [GLOBAL]: { ...GLOBAL_DE_HOJE, enabled: false } });
      expect(await svc.getConfig(B)).toMatchObject({ initial_choice: 'formal', enabled: false });
      expect((await followup.getOperacional(B)).pos.enabled).toBe(false);
    });

    it('nova sem a própria: o padrão, nunca o texto de outra clínica', async () => {
      const { svc, followup } = montar({ [GLOBAL]: { initial_choice: 'custom', initial_custom: 'Aqui é a clínica antiga', enabled: false } });
      expect(await svc.getConfig(NOVA)).toEqual(DEFAULT_CONFIG);
      expect((await followup.getOperacional(NOVA)).pos.enabled).toBe(true);
    });

    it('nova desligando na Central: grava só {enabled:false} na dela (sem copiar a global)', async () => {
      const { followup, lido } = montar({ [GLOBAL]: { initial_custom: 'Aqui é a clínica antiga' } });
      await followup.setOperacionalToggle(NOVA, 'pos', false);
      expect(lido(daConta(NOVA))).toEqual({ enabled: false });
    });
  });

  it('o dono (SUPER_ADMIN com conta) grava na conta dele', async () => {
    const { ctl, gravadas } = montar({ [GLOBAL]: GLOBAL_DE_HOJE });
    await ctl.updateConfig(req(DONO), { enabled: false });
    expect(gravadas()).toEqual([daConta(A)]);
  });
});

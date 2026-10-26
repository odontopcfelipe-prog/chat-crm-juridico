/**
 * Pesquisa pós-atendimento no worker: cada conta com a SUA configuração
 * (POST_CARE_CONFIG_<conta>); conta legada sem a própria herda a global antiga;
 * conta nova sem a própria fica no padrão. Uma clínica desligada não para nem
 * "entope" a outra. Sem chave de conta, tudo como antes (retrato em
 * mensagens-paciente-worker.spec.ts).
 */
import axios from 'axios';
import { Logger } from '@nestjs/common';
import { __limparCacheContaLegada } from '@crm/shared';
import { PostCareCronService } from '../post-care/post-care-cron.service';

jest.mock('axios');

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

const SETTINGS: any = { getEvolutionConfig: async () => ({ apiUrl: 'https://evo.teste', apiKey: 'chave-somente-teste' }) };

beforeAll(() => {
  for (const m of ['log', 'warn', 'debug', 'error'] as const) {
    jest.spyOn(Logger.prototype, m).mockImplementation(() => undefined);
  }
});
let envios: Array<{ chip: string; text: string }> = [];
beforeEach(() => {
  __limparCacheContaLegada();
  envios = [];
  (axios.post as jest.Mock).mockReset();
  (axios.post as jest.Mock).mockImplementation(async (url: string, corpo: any) => {
    envios.push({ chip: String(url).split('/').pop()!, text: corpo.text });
    return { data: { key: { id: 'wamid' } } };
  });
});

const pesquisa = (id: string, tenant: string) => ({
  id,
  tenant_id: tenant,
  procedure_summary: 'Limpeza',
  patient: { id: `p-${id}`, name: 'Maria Souza', phone: '82988887777', tenant_id: tenant },
  dentist: { name: 'Ana Lima' },
});

function montar(settings: Record<string, any>, opts: { pesquisas?: any[]; eventos?: any[]; contas?: string[]; semFiltro?: boolean } = {}) {
  const store = new Map<string, string>(Object.entries(settings).map(([k, v]) => [k, JSON.stringify(v)]));
  const prisma: any = {
    globalSetting: {
      findUnique: jest.fn(async ({ where }: any) => (store.has(where.key) ? { value: store.get(where.key) } : null)),
      findMany: jest.fn(async ({ where }: any) =>
        [...store.keys()].filter((k) => k.startsWith(where.key.startsWith)).map((key) => ({ key, value: store.get(key) })),
      ),
    },
    tenant: {
      findUnique: jest.fn(async ({ where }: any) => (CRIACAO[where.id] ? { created_at: CRIACAO[where.id] } : null)),
      findMany: jest.fn(async () => (opts.contas ?? [A, B, NOVA]).map((id) => ({ id }))),
    },
    calendarEvent: {
      findMany: jest.fn(async ({ where, take }: any) => filtrar(opts.eventos ?? [], opts.semFiltro ? {} : where).slice(0, take)),
    },
    postCareSurvey: {
      findMany: jest.fn(async ({ where, take }: any) => filtrar(opts.pesquisas ?? [], opts.semFiltro ? {} : where).slice(0, take)),
      create: jest.fn(async ({ data }: any) => data),
      update: jest.fn(async () => ({})),
    },
    instance: {
      findMany: jest.fn(async ({ where }: any) => [{ name: `chip-${where.tenant_id}`, purpose: 'CLINICA' }]),
    },
  };
  return { svc: new PostCareCronService(prisma, SETTINGS), prisma };
}

/** Aplica o filtro de conta (in / notIn) como o banco aplicaria. */
function filtrar(linhas: any[], where: any) {
  const f = where?.tenant_id;
  return linhas.filter((l) => {
    if (!f) return true;
    if (f.in) return f.in.includes(l.tenant_id);
    if (f.notIn) return l.tenant_id != null && !f.notIn.includes(l.tenant_id);
    return true;
  });
}

const FORMAL = 'Olá, Maria. Esperamos que esteja bem.';
const BREVE = 'Oi Maria! Como foi seu atendimento';
const DESCONTRAIDO = 'Olá Maria! Passando aqui pra perguntar';

describe('Pesquisa pós-atendimento (worker) — configuração por conta', () => {
  describe('uma clínica desligada não para nem alcança a outra', () => {
    it('global ligada (formal) e A desligou a dela: só a B sai, com o texto formal; a A fica PENDING', async () => {
      const { svc, prisma } = montar(
        { [GLOBAL]: { enabled: true, initial_choice: 'formal' }, [daConta(A)]: { enabled: false } },
        { pesquisas: [pesquisa('s-a', A), pesquisa('s-b', B)] },
      );
      await svc.tick();
      expect(envios).toHaveLength(1);
      expect(envios[0].chip).toBe(`chip-${B}`);
      expect(envios[0].text).toContain(FORMAL);
      expect(prisma.postCareSurvey.update.mock.calls.map((c: any[]) => c[0].where.id)).toEqual(['s-b']);
      expect(prisma.postCareSurvey.findMany.mock.calls[0][0].where.tenant_id).toEqual({ notIn: [A] });
    });

    it('global desligada e B ligou a dela (breve): só a B sai, com o texto dela', async () => {
      const { svc, prisma } = montar(
        { [GLOBAL]: { enabled: false }, [daConta(B)]: { enabled: true, initial_choice: 'breve' } },
        { pesquisas: [pesquisa('s-a', A), pesquisa('s-b', B)], contas: [A, B] },
      );
      await svc.tick();
      expect(envios.map((e) => e.chip)).toEqual([`chip-${B}`]);
      expect(envios[0].text).toContain(BREVE);
      expect(prisma.postCareSurvey.findMany.mock.calls[0][0].where.tenant_id).toEqual({ in: [B] });
    });

    it('a A desligada com 30+ pendentes não entope a B', async () => {
      const pendentesA = Array.from({ length: 40 }, (_, i) => pesquisa(`s-a${i}`, A));
      const { svc } = montar({ [daConta(A)]: { enabled: false } }, { pesquisas: [...pendentesA, pesquisa('s-b', B)] });
      await svc.tick();
      expect(envios.map((e) => e.chip)).toEqual([`chip-${B}`]);
    });

    it('mesmo que a consulta traga linha de conta desligada, nada sai nem é criado para ela', async () => {
      const fim = new Date('2026-10-20T15:00:00Z');
      const { svc, prisma } = montar(
        { [daConta(A)]: { enabled: false } },
        {
          pesquisas: [pesquisa('s-a', A), pesquisa('s-b', B)],
          eventos: [{ id: 'ev-a', tenant_id: A, patient_id: 'p-a', assigned_user_id: null, title: 'X', start_at: fim, end_at: fim }],
          semFiltro: true,
        },
      );
      await svc.tick();
      expect(envios.map((e) => e.chip)).toEqual([`chip-${B}`]);
      expect(prisma.postCareSurvey.update.mock.calls.map((c: any[]) => c[0].where.id)).toEqual(['s-b']);
      expect(prisma.postCareSurvey.create).not.toHaveBeenCalled();
    });

    it('cada conta com o seu atraso ao criar a pesquisa', async () => {
      const fim = new Date('2026-10-20T15:00:00Z');
      const ev = (id: string, tenant_id: string) => ({ id, tenant_id, patient_id: `p-${id}`, assigned_user_id: null, title: 'Limpeza', start_at: fim, end_at: fim });
      const { svc, prisma } = montar(
        { [GLOBAL]: { delay_hours: 2 }, [daConta(A)]: { delay_hours: 5 } },
        { eventos: [ev('ev-a', A), ev('ev-b', B)] },
      );
      await svc.tick();
      const criadas = prisma.postCareSurvey.create.mock.calls.map((c: any[]) => [c[0].data.tenant_id, c[0].data.trigger_at.getTime() - fim.getTime()]);
      expect(criadas).toEqual([
        [A, 5 * 3600_000],
        [B, 2 * 3600_000],
      ]);
    });
  });

  describe('sem chave de conta, como antes', () => {
    it('global ligada: as duas saem com o estilo da global; sem filtro de conta na consulta', async () => {
      const { svc, prisma } = montar({ [GLOBAL]: { initial_choice: 'formal' } }, { pesquisas: [pesquisa('s-a', A), pesquisa('s-b', B)] });
      await svc.tick();
      expect(envios.map((e) => e.chip)).toEqual([`chip-${A}`, `chip-${B}`]);
      for (const e of envios) expect(e.text).toContain(FORMAL);
      expect(prisma.postCareSurvey.findMany.mock.calls[0][0].where).not.toHaveProperty('tenant_id');
    });

    it('pesquisa sem conta: vira FAILED como antes (não fica PENDING para sempre)', async () => {
      const semConta = { ...pesquisa('s-x', A), tenant_id: null, patient: { ...pesquisa('s-x', A).patient, tenant_id: null } };
      const { svc, prisma } = montar({}, { pesquisas: [semConta] });
      await svc.tick();
      expect(envios).toEqual([]);
      expect(prisma.postCareSurvey.update.mock.calls[0][0]).toMatchObject({ where: { id: 's-x' }, data: { status: 'FAILED' } });
    });

    it('global desligada: nada sai (como antes)', async () => {
      const { svc, prisma } = montar({ [GLOBAL]: { enabled: false } }, { pesquisas: [pesquisa('s-a', A), pesquisa('s-b', B)], contas: [A, B] });
      await svc.tick();
      expect(envios).toEqual([]);
      expect(prisma.postCareSurvey.findMany).not.toHaveBeenCalled();
      expect(prisma.calendarEvent.findMany).not.toHaveBeenCalled();
    });
  });

  describe('conta nova não herda a configuração antiga', () => {
    it('global com o texto de outra clínica: a conta nova sai com o padrão', async () => {
      const { svc } = montar(
        { [GLOBAL]: { initial_choice: 'custom', initial_custom: 'Aqui é a clínica antiga, {patient_name}' } },
        { pesquisas: [pesquisa('s-a', A), pesquisa('s-n', NOVA)] },
      );
      await svc.tick();
      const porChip = Object.fromEntries(envios.map((e) => [e.chip, e.text]));
      expect(porChip[`chip-${A}`]).toContain('Aqui é a clínica antiga, Maria');
      expect(porChip[`chip-${NOVA}`]).toContain(DESCONTRAIDO);
    });

    it('global desligada: a conta nova sem a própria segue o padrão (ligada); as legadas, não', async () => {
      const { svc, prisma } = montar({ [GLOBAL]: { enabled: false } }, { pesquisas: [pesquisa('s-a', A), pesquisa('s-n', NOVA)] });
      await svc.tick();
      expect(envios.map((e) => e.chip)).toEqual([`chip-${NOVA}`]);
      expect(prisma.postCareSurvey.findMany.mock.calls[0][0].where.tenant_id).toEqual({ in: [NOVA] });
    });
  });
});

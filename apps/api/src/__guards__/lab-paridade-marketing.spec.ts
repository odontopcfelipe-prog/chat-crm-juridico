/**
 * Paridade do laboratório — marketing: influenciadores (agendamento nasce pausado),
 * analytics (landing pages sem conta: o laboratório não recebe a métrica) e o comparativo
 * de unidades (visitas do laboratório = coleta, prova e entrega).
 *
 * Dublês simples de Prisma: só o que cada serviço consulta. A clínica (com ou sem
 * laboratório cadastrado) recebe o mesmo de sempre.
 */
import { __limparCacheLabTenants } from '@crm/shared';
import { AnalyticsService } from '../analytics/analytics.service';
import { InfluencerSchedulesService } from '../influencers/influencer-schedules.service';
import { ClinicsService } from '../clinics/clinics.service';

const LAB = 'conta-lab-1';
const CLINICA = 'conta-clinica-1';

function prismaCom(labs: string[], extra: Record<string, any> = {}) {
  __limparCacheLabTenants();
  return {
    tenantBusinessProfile: { findMany: jest.fn(async () => labs.map((tenant_id) => ({ tenant_id }))) },
    ...extra,
  } as any;
}

describe('influenciadores — o agendamento de WhatsApp nasce pausado no laboratório', () => {
  const dto = { name: 'Campanha', template_id: 'tpl-1', schedule_type: 'ONCE' as const, run_at: '2031-01-01T12:00:00.000Z' };
  function montar(labs: string[]) {
    const create = jest.fn(async ({ data }: any) => ({ id: 'ag-1', ...data })) as jest.Mock;
    const prisma = prismaCom(labs, {
      influencerMessageTemplate: { findFirst: jest.fn(async () => ({ id: 'tpl-1' })) },
      influencerSchedule: { create },
    });
    return { svc: new InfluencerSchedulesService(prisma), create };
  }

  it('laboratório sem o campo active: pausado; com active explícito: o que a conta escolheu', async () => {
    const a = montar([LAB]);
    await a.svc.create(LAB, dto);
    expect(a.create.mock.calls[0][0].data).toEqual(expect.objectContaining({ tenant_id: LAB, active: false }));
    const b = montar([LAB]);
    await b.svc.create(LAB, { ...dto, active: true });
    expect(b.create.mock.calls[0][0].data.active).toBe(true);
  });

  it('clínica (com ou sem laboratório cadastrado): ativo, como antes', async () => {
    for (const labs of [[], [LAB]]) {
      const m = montar(labs);
      await m.svc.create(CLINICA, dto);
      expect(m.create.mock.calls[0][0].data.active).toBe(true);
    }
  });
});

describe('analytics — landing pages não pertencem a conta: o laboratório não recebe a métrica', () => {
  function montar(labs: string[]) {
    const findMany = jest.fn(async (_args?: any) => [
      { page_path: '/lp', event_type: 'view', utm_source: null, gclid: null, referrer: null, created_at: new Date() },
    ]);
    const prisma = prismaCom(labs, { lpEvent: { findMany } });
    return { svc: new AnalyticsService(prisma), findMany };
  }

  it('laboratório: lista vazia e detalhe zerado, sem consultar os eventos', async () => {
    const m = montar([LAB]);
    expect(await m.svc.getPages(LAB)).toEqual([]);
    const d = await m.svc.getPageDetail('/lp', LAB);
    expect(d).toEqual(expect.objectContaining({ page_path: '/lp', total_views: 0, total_clicks: 0, by_source: [] }));
    expect(d.by_day).toHaveLength(7);
    expect(m.findMany).not.toHaveBeenCalled();
  });

  it('clínica (com ou sem laboratório cadastrado): lê os eventos como antes', async () => {
    for (const labs of [[], [LAB]]) {
      const m = montar(labs);
      const paginas = await m.svc.getPages(CLINICA);
      expect(paginas).toHaveLength(1);
      expect(paginas[0]).toEqual(expect.objectContaining({ page_path: '/lp', views: 1 }));
      expect(m.findMany).toHaveBeenCalledTimes(1);
    }
  });
});

describe('minha rede — as visitas do laboratório são coleta, prova e entrega', () => {
  function montar(labs: string[]) {
    const eventos = jest.fn(async (_args?: any) => 2);
    const prisma = prismaCom(labs, {
      clinic: { findMany: jest.fn(async () => [{ id: 'un-1', name: 'Unidade', city: null, type: 'MIXED', user_clinics: [{ user_id: 'u1' }] }]) },
      quote: { aggregate: jest.fn(async () => ({ _sum: { total_value: 100 }, _count: { _all: 1 } })) },
      calendarEvent: { count: eventos },
      commission: { aggregate: jest.fn(async () => ({ _sum: { amount: 0 } })) },
    });
    return { svc: new ClinicsService(prisma), eventos };
  }

  it('laboratório conta os tipos dele; clínica segue contando CONSULTA', async () => {
    const lab = montar([LAB]);
    await lab.svc.ranking(LAB);
    expect(lab.eventos.mock.calls[0][0].where.type).toEqual({ in: ['COLETA', 'PROVA', 'ENTREGA'] });
    expect(lab.eventos.mock.calls[0][0].where.tenant_id).toBe(LAB);
    for (const labs of [[], [LAB]]) {
      const c = montar(labs);
      await c.svc.ranking(CLINICA);
      expect(c.eventos.mock.calls[0][0].where.type).toBe('CONSULTA');
    }
  });
});

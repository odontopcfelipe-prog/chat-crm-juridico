/**
 * Painel (início, comparações, desempenho da equipe e gráficos) — cada conta só
 * conta e lista dado DELA.
 *
 * Prisma mockado; o que se confere é o where de cada consulta, inteiro:
 *  - contato, conversa e usuário: { tenant_id: conta } (registro sem conta fica de fora);
 *  - evento da agenda (tarefas e próximos eventos): a conta gravada OU, no evento
 *    antigo sem conta, a conta de quem o criou (a própria conta continua vendo os dela);
 *  - SUPER_ADMIN sem conta: nenhum filtro de conta, como hoje.
 */
import { DashboardService } from './dashboard.service';
import { DashboardAnalyticsService } from './dashboard-analytics.service';
import { TeamPerformanceService } from './team-performance.service';

const A = 'conta-a';
const CONTA_A = { tenant_id: A };
const EVENTOS_DA_A = {
  OR: [
    { tenant_id: A },
    { tenant_id: null, created_by: { tenant_id: A } },
    { tenant_id: null, created_by: { tenant_id: null }, lead: { tenant_id: A } },
    { tenant_id: null, created_by: { tenant_id: null }, lead_id: null, patient: { tenant_id: A } },
    { tenant_id: null, created_by: { tenant_id: null }, lead: { tenant_id: null }, patient: { tenant_id: A } },
  ],
};
const DATA = expect.any(Date);

function montarPrisma() {
  const prisma: any = {
    user: {
      findUnique: jest.fn(async () => ({ name: 'Ana', inboxes: [] })),
      findMany: jest.fn(async () => []),
    },
    conversation: {
      count: jest.fn(async () => 0),
      groupBy: jest.fn(async () => []),
      findMany: jest.fn(async () => []),
    },
    lead: {
      count: jest.fn(async () => 0),
      groupBy: jest.fn(async () => []),
      findMany: jest.fn(async () => []),
    },
    calendarEvent: {
      count: jest.fn(async () => 0),
      findMany: jest.fn(async () => []),
      groupBy: jest.fn(async () => []),
    },
    leadStageHistory: { groupBy: jest.fn(async () => []) },
    message: { findFirst: jest.fn(async () => null) },
  };
  return prisma;
}

const wheres = (fn: jest.Mock) => fn.mock.calls.map((c: any[]) => c[0].where);

describe('DashboardService.aggregate — números do início', () => {
  const ADMIN = ['ADMIN'];

  it('ADMIN da conta A: conversas, contatos e equipe só da A; tarefas e próximos eventos pela conta do evento', async () => {
    const prisma = montarPrisma();
    await new DashboardService(prisma).aggregate('u-a', ADMIN, A);

    expect(wheres(prisma.conversation.count)).toEqual([
      { status: { not: 'FECHADO' }, ...CONTA_A },
      { pending_transfer_to_id: { not: null }, status: { not: 'FECHADO' }, ...CONTA_A },
      { status: 'FECHADO', last_message_at: { gte: DATA }, ...CONTA_A },
      { status: 'FECHADO', last_message_at: { gte: DATA }, ...CONTA_A },
      { status: 'FECHADO', last_message_at: { gte: DATA }, ...CONTA_A },
    ]);
    expect(wheres(prisma.lead.count)).toEqual([
      { is_client: false, stage: { notIn: ['PERDIDO', 'FINALIZADO'] }, ...CONTA_A },
      { stage: { not: 'PERDIDO' }, ...CONTA_A },
      { stage: 'PERDIDO', ...CONTA_A },
    ]);
    expect(prisma.lead.groupBy.mock.calls[0][0]).toEqual({ by: ['stage'], _count: true, where: CONTA_A });
    expect(prisma.user.findMany.mock.calls[0][0]).toEqual({
      where: CONTA_A,
      select: { id: true, name: true, roles: true },
      orderBy: { name: 'asc' },
    });
    expect(wheres(prisma.calendarEvent.findMany)).toEqual([
      { start_at: { gte: DATA, lte: DATA }, status: { notIn: ['CANCELADO', 'CONCLUIDO'] }, ...EVENTOS_DA_A },
    ]);
    expect(wheres(prisma.calendarEvent.count)).toEqual([
      { type: 'TAREFA', status: { in: ['AGENDADO'] }, ...EVENTOS_DA_A },
      { type: 'TAREFA', status: { in: ['CONFIRMADO'] }, ...EVENTOS_DA_A },
      { type: 'TAREFA', status: { in: ['AGENDADO', 'CONFIRMADO'] }, ...EVENTOS_DA_A, start_at: { lt: DATA } },
    ]);
  });

  it('dentista da conta A: os filtros dele de hoje, com a conta junto', async () => {
    const prisma = montarPrisma();
    await new DashboardService(prisma).aggregate('u-a', ['DENTIST'], A);
    expect(wheres(prisma.lead.count)[0]).toEqual({
      is_client: false,
      stage: { notIn: ['PERDIDO', 'FINALIZADO'] },
      cs_user_id: 'u-a',
      ...CONTA_A,
    });
    expect(wheres(prisma.calendarEvent.findMany)).toEqual([
      { start_at: { gte: DATA, lte: DATA }, status: { notIn: ['CANCELADO', 'CONCLUIDO'] }, assigned_user_id: 'u-a', ...EVENTOS_DA_A },
    ]);
    expect(wheres(prisma.calendarEvent.count)[0]).toEqual({
      type: 'TAREFA',
      status: { in: ['AGENDADO'] },
      assigned_user_id: 'u-a',
      ...EVENTOS_DA_A,
    });
    // Conversas do dentista seguem pelas caixas/atribuição dele, como hoje.
    expect(wheres(prisma.conversation.count)[0]).toEqual({ status: { not: 'FECHADO' }, assigned_user_id: 'u-a' });
    expect(prisma.user.findMany).not.toHaveBeenCalled();
  });

  it('SUPER_ADMIN sem conta: nenhum filtro de conta, como hoje', async () => {
    const prisma = montarPrisma();
    await new DashboardService(prisma).aggregate('root', ['SUPER_ADMIN', 'ADMIN'], undefined);
    expect(wheres(prisma.conversation.count)[0]).toEqual({ status: { not: 'FECHADO' } });
    expect(wheres(prisma.lead.count)).toEqual([
      { is_client: false, stage: { notIn: ['PERDIDO', 'FINALIZADO'] } },
      { stage: { not: 'PERDIDO' } },
      { stage: 'PERDIDO' },
    ]);
    expect(prisma.lead.groupBy.mock.calls[0][0].where).toEqual({});
    expect(prisma.user.findMany.mock.calls[0][0].where).toEqual({});
    expect(wheres(prisma.calendarEvent.findMany)).toEqual([
      { start_at: { gte: DATA, lte: DATA }, status: { notIn: ['CANCELADO', 'CONCLUIDO'] } },
    ]);
    expect(wheres(prisma.calendarEvent.count)[0]).toEqual({ type: 'TAREFA', status: { in: ['AGENDADO'] } });
  });
});

describe('DashboardService.comparisons — comparativo de períodos', () => {
  it('conta A: contatos só da A; tarefas atrasadas pela conta do evento (3 janelas)', async () => {
    const prisma = montarPrisma();
    await new DashboardService(prisma).comparisons('u-a', ['ADMIN'], A);
    expect(prisma.lead.count).toHaveBeenCalledTimes(12);
    for (const w of wheres(prisma.lead.count)) {
      expect(w.tenant_id).toBe(A);
      expect(w).not.toHaveProperty('OR');
    }
    expect(wheres(prisma.lead.count)[0]).toEqual({ stage: { not: 'PERDIDO' }, ...CONTA_A, created_at: { gte: DATA, lte: DATA } });
    expect(wheres(prisma.calendarEvent.count)).toEqual(
      Array(3).fill({
        type: 'TAREFA',
        status: { in: ['AGENDADO', 'CONFIRMADO'] },
        start_at: { gte: DATA, lte: DATA },
        ...EVENTOS_DA_A,
      }),
    );
  });

  it('SUPER_ADMIN sem conta: sem filtro de conta', async () => {
    const prisma = montarPrisma();
    await new DashboardService(prisma).comparisons('root', ['SUPER_ADMIN', 'ADMIN'], undefined);
    expect(wheres(prisma.lead.count)[0]).toEqual({ stage: { not: 'PERDIDO' }, created_at: { gte: DATA, lte: DATA } });
    expect(wheres(prisma.calendarEvent.count)[0]).toEqual({
      type: 'TAREFA',
      status: { in: ['AGENDADO', 'CONFIRMADO'] },
      start_at: { gte: DATA, lte: DATA },
    });
  });
});

describe('TeamPerformanceService.getPerformance — desempenho da equipe', () => {
  const EQUIPE = [{ id: 'u-a', name: 'Ana', roles: ['OPERADOR'] }];

  it('conta A: equipe, conversas e contatos só da A; tarefas pela conta do evento', async () => {
    const prisma = montarPrisma();
    prisma.user.findMany.mockResolvedValue(EQUIPE);
    await new TeamPerformanceService(prisma).getPerformance('u-a', ['ADMIN'], A);

    expect(prisma.user.findMany.mock.calls[0][0]).toEqual({
      where: CONTA_A,
      select: { id: true, name: true, roles: true },
      orderBy: { name: 'asc' },
    });
    const ids = { in: ['u-a'] };
    expect(wheres(prisma.calendarEvent.groupBy)).toEqual([
      { type: 'TAREFA', status: 'CONCLUIDO', assigned_user_id: ids, ...EVENTOS_DA_A },
      { type: 'TAREFA', status: { in: ['AGENDADO', 'CONFIRMADO'] }, assigned_user_id: ids, ...EVENTOS_DA_A },
      { type: 'TAREFA', status: { in: ['AGENDADO', 'CONFIRMADO'] }, start_at: { lt: DATA }, assigned_user_id: ids, ...EVENTOS_DA_A },
      { type: 'TAREFA', status: 'CONCLUIDO', assigned_user_id: ids, created_at: { gte: DATA, lte: DATA }, ...EVENTOS_DA_A },
      { type: 'TAREFA', status: { in: ['AGENDADO', 'CONFIRMADO'] }, assigned_user_id: ids, created_at: { gte: DATA, lte: DATA }, ...EVENTOS_DA_A },
    ]);
    expect(wheres(prisma.conversation.groupBy)).toEqual([
      { assigned_user_id: ids, status: { not: 'FECHADO' }, ...CONTA_A },
      { assigned_user_id: ids, status: 'FECHADO', last_message_at: { gte: DATA, lte: DATA }, ...CONTA_A },
      { assigned_user_id: ids, status: 'FECHADO', last_message_at: { gte: DATA, lte: DATA }, ...CONTA_A },
    ]);
    expect(wheres(prisma.lead.groupBy)).toEqual([
      { cs_user_id: ids, ...CONTA_A },
      { cs_user_id: ids, is_client: true, ...CONTA_A },
      { cs_user_id: ids, stage: 'PERDIDO', ...CONTA_A },
    ]);
  });

  it('escopo comercial da conta A: só a equipe comercial da A', async () => {
    const prisma = montarPrisma();
    await new TeamPerformanceService(prisma).getPerformance('u-a', ['ADMIN'], A, undefined, undefined, 'comercial');
    expect(prisma.user.findMany.mock.calls[0][0].where).toEqual({ ...CONTA_A, roles: { hasSome: ['OPERADOR', 'COMERCIAL'] } });
  });

  it('SUPER_ADMIN sem conta: sem filtro de conta, como hoje', async () => {
    const prisma = montarPrisma();
    prisma.user.findMany.mockResolvedValue(EQUIPE);
    await new TeamPerformanceService(prisma).getPerformance('root', ['SUPER_ADMIN', 'ADMIN'], undefined);
    expect(prisma.user.findMany.mock.calls[0][0].where).toEqual({});
    expect(wheres(prisma.calendarEvent.groupBy)[0]).toEqual({ type: 'TAREFA', status: 'CONCLUIDO', assigned_user_id: { in: ['u-a'] } });
    expect(wheres(prisma.conversation.groupBy)[0]).toEqual({ assigned_user_id: { in: ['u-a'] }, status: { not: 'FECHADO' } });
    expect(wheres(prisma.lead.groupBy)[0]).toEqual({ cs_user_id: { in: ['u-a'] } });
  });
});

describe('DashboardAnalyticsService — gráficos do painel', () => {
  const INI = '2026-10-01T00:00:00.000Z';
  const FIM = '2026-10-27T23:59:59.000Z';

  it('conta A: funil, origem, velocidade e tempo de resposta só da A; tarefas pela conta do evento', async () => {
    const prisma = montarPrisma();
    const svc = new DashboardAnalyticsService(prisma);
    await svc.leadFunnel('u-a', ['ADMIN'], A, INI, FIM);
    await svc.leadSources('u-a', ['ADMIN'], A, INI, FIM);
    await svc.conversionVelocity('u-a', ['ADMIN'], A);
    await svc.responseTime('u-a', ['ADMIN'], A);
    await svc.taskCompletion('u-a', ['ADMIN'], A);

    const periodo = { gte: new Date(INI), lte: new Date(FIM) };
    expect(wheres(prisma.lead.groupBy)).toEqual([
      { ...CONTA_A, created_at: periodo },
      { ...CONTA_A, created_at: periodo },
    ]);
    expect(wheres(prisma.lead.count)).toEqual([
      { is_client: true, ...CONTA_A, became_client_at: periodo },
      { is_client: true, ...CONTA_A, created_at: periodo },
    ]);
    expect(wheres(prisma.lead.findMany)).toEqual([{ is_client: true, became_client_at: { not: null }, ...CONTA_A }]);
    expect(wheres(prisma.conversation.findMany)).toEqual([CONTA_A]);
    expect(wheres(prisma.calendarEvent.count)).toEqual([
      { type: 'TAREFA', ...EVENTOS_DA_A, status: 'CONCLUIDO' },
      { type: 'TAREFA', ...EVENTOS_DA_A, status: { in: ['AGENDADO', 'CONFIRMADO'] } },
      { type: 'TAREFA', ...EVENTOS_DA_A, status: { in: ['AGENDADO', 'CONFIRMADO'] }, start_at: { lt: DATA } },
    ]);
  });

  it('SUPER_ADMIN sem conta: sem filtro de conta, como hoje', async () => {
    const prisma = montarPrisma();
    const svc = new DashboardAnalyticsService(prisma);
    await svc.leadFunnel('root', ['SUPER_ADMIN', 'ADMIN'], undefined);
    await svc.responseTime('root', ['SUPER_ADMIN', 'ADMIN'], undefined);
    await svc.taskCompletion('root', ['SUPER_ADMIN', 'ADMIN'], undefined);
    expect(wheres(prisma.lead.groupBy)).toEqual([{}]);
    expect(wheres(prisma.conversation.findMany)).toEqual([{}]);
    expect(wheres(prisma.calendarEvent.count)[0]).toEqual({ type: 'TAREFA', status: 'CONCLUIDO' });
  });
});

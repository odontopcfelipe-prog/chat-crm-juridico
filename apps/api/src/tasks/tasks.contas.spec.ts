/**
 * Tarefas só da própria conta.
 *
 * - Lista, carga de trabalho e ações por id: só tarefa da própria conta; tarefa
 *   de outra conta ou sem conta → 403, nada é gravado.
 * - Criar/editar: contato, conversa e responsável só da própria conta (o sem
 *   conta também fica fora; usuário sem conta é da plataforma).
 * - Item do checklist tem de ser da tarefa da URL.
 * - Sem conta no token (plataforma) segue passando; a tarefa criada assim nasce
 *   na conta do contato/conversa/responsável.
 * - Conta própria: mesmas chamadas e argumentos de antes.
 */
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { TasksService } from './tasks.service';
import { TasksController } from './tasks.controller';
import { AdminBotService } from '../admin-bot/admin-bot.service';

const A = 'conta-a';
const B = 'conta-b';

const TAREFAS: Record<string, any> = {
  't-a': { id: 't-a', tenant_id: A, conversation_id: 'c-a', calendar_event_id: null, due_at: null, title: 'Ligar' },
  't-b': { id: 't-b', tenant_id: B, conversation_id: 'c-b', calendar_event_id: null, due_at: null, title: 'Ligar' },
  't-0': { id: 't-0', tenant_id: null, conversation_id: 'c-0', calendar_event_id: null, due_at: null, title: 'Ligar' },
};
const LEADS: Record<string, any> = { 'l-a': { tenant_id: A }, 'l-b': { tenant_id: B }, 'l-0': { tenant_id: null } };
const CONVERSAS: Record<string, any> = { 'c-a': { tenant_id: A }, 'c-b': { tenant_id: B }, 'c-0': { tenant_id: null } };
const USUARIOS: Record<string, any> = { 'u-a': { tenant_id: A }, 'u-b': { tenant_id: B }, 'u-plataforma': { tenant_id: null } };
const ITENS: Record<string, any> = { 'i-a': { task_id: 't-a' }, 'i-b': { task_id: 't-b' } };

function montar() {
  const porId = (tabela: Record<string, any>) => jest.fn(async ({ where }: any) => tabela[where.id] ?? null);
  const prisma: any = {
    task: {
      findUnique: porId(TAREFAS),
      findMany: jest.fn(async () => []),
      findFirst: jest.fn(async () => null),
      count: jest.fn(async () => 0),
      create: jest.fn(async ({ data }: any) => ({ id: 't-nova', calendar_event_id: null, lead_id: null, ...data })),
      update: jest.fn(async ({ where, data }: any) => ({ ...TAREFAS[where.id], ...data })),
    },
    lead: {
      findUnique: porId(LEADS),
      findFirst: jest.fn(async ({ where }: any) => (LEADS[where.id]?.tenant_id === where.tenant_id ? { id: where.id } : null)),
    },
    conversation: { findUnique: porId(CONVERSAS), update: jest.fn(async () => ({})) },
    user: {
      findUnique: porId(USUARIOS),
      findFirst: jest.fn(async ({ where }: any) => (USUARIOS[where.id]?.tenant_id === where.tenant_id ? { id: where.id } : null)),
    },
    taskComment: {
      create: jest.fn(async ({ data }: any) => ({ id: 'cm-1', ...data, user: { id: data.user_id, name: 'Equipe' } })),
      findMany: jest.fn(async () => []),
    },
    taskChecklistItem: {
      findUnique: porId(ITENS),
      count: jest.fn(async () => 0),
      create: jest.fn(async ({ data }: any) => ({ id: 'i-nova', ...data })),
      update: jest.fn(async ({ where, data }: any) => ({ id: where.id, ...data })),
      delete: jest.fn(async () => ({})),
    },
    taskPostponement: { create: jest.fn(async () => ({})) },
    $transaction: jest.fn(async (ops: any[]) => Promise.all(ops)),
  };
  const gateway: any = { emitConversationsUpdate: jest.fn(), emitTaskComment: jest.fn() };
  const agenda: any = { create: jest.fn(), update: jest.fn(), updateStatus: jest.fn(), remove: jest.fn() };
  const svc = new TasksService(prisma, gateway, agenda);
  const ctrl = new TasksController(svc);
  const escritas = () =>
    [
      prisma.task.create,
      prisma.task.update,
      prisma.conversation.update,
      prisma.taskComment.create,
      prisma.taskChecklistItem.create,
      prisma.taskChecklistItem.update,
      prisma.taskChecklistItem.delete,
      prisma.taskPostponement.create,
      prisma.$transaction,
    ].reduce((n, f) => n + f.mock.calls.length, 0);
  return { prisma, svc, ctrl, escritas };
}

const req = (tenant_id: string | undefined, id = 'u-a') => ({ user: { id, tenant_id } });

describe('Tarefas — lista e carga de trabalho só da própria conta', () => {
  it('findAll: o where é só a conta (sem tarefa sem conta), com os mesmos filtros de antes', async () => {
    const { svc, prisma } = montar();
    await svc.findAll(A);
    await svc.findAll(A, undefined, undefined, { status: 'A_FAZER', assignedUserId: 'u-a', search: ' ligar ' });
    await svc.findAll(A, undefined, undefined, { status: 'all' });
    const wheres = prisma.task.findMany.mock.calls.map((c: any[]) => c[0].where);
    expect(wheres).toEqual([
      { tenant_id: A },
      {
        AND: [
          { tenant_id: A },
          { status: 'A_FAZER' },
          { assigned_user_id: 'u-a' },
          { title: { contains: 'ligar', mode: 'insensitive' } },
        ],
      },
      { tenant_id: A },
    ]);
  });

  it.each(['today', 'week', 'overdue'])('findAll com prazo "%s": a conta vem primeiro e nada de tenant_id null', async (dueFilter) => {
    const { svc, prisma } = montar();
    await svc.findAll(A, 1, 20, { dueFilter });
    const where = prisma.task.findMany.mock.calls[0][0].where;
    expect(where.AND[0]).toEqual({ tenant_id: A });
    expect(where.AND).toHaveLength(2);
    expect(JSON.stringify(where)).not.toContain('null');
    expect(prisma.task.count.mock.calls[0][0].where).toBe(where);
  });

  it('getWorkload: só a conta', async () => {
    const { svc, prisma } = montar();
    await svc.getWorkload(A);
    expect(prisma.task.findMany.mock.calls[0][0].where).toEqual({
      tenant_id: A,
      status: { notIn: ['CONCLUIDA', 'CANCELADA'] },
      assigned_user_id: { not: null },
    });
  });

  it('sem conta no token (plataforma): where vazio, como antes', async () => {
    const { svc, prisma } = montar();
    await svc.findAll(undefined);
    await svc.getWorkload(undefined);
    expect(prisma.task.findMany.mock.calls[0][0].where).toEqual({});
    expect(prisma.task.findMany.mock.calls[1][0].where).toEqual({
      status: { notIn: ['CONCLUIDA', 'CANCELADA'] },
      assigned_user_id: { not: null },
    });
  });
});

describe('Tarefas — ações por id', () => {
  const acoes: [string, (s: TasksService, id: string, t?: string) => Promise<any>][] = [
    ['findOne', (s, id, t) => s.findOne(id, t)],
    ['update', (s, id, t) => s.update(id, { title: 'novo' }, t)],
    ['updateStatus', (s, id, t) => s.updateStatus(id, 'CONCLUIDA', t)],
    ['complete', (s, id, t) => s.complete(id, 'feito', 'u-a', t)],
    ['completeAndReopen', (s, id, t) => s.completeAndReopen(id, t)],
    ['postpone', (s, id, t) => s.postpone(id, '2026-11-01T12:00:00.000Z', 'sem retorno', 'u-a', t)],
    ['addComment', (s, id, t) => s.addComment(id, 'u-a', 'oi', t)],
    ['findComments', (s, id, t) => s.findComments(id, t)],
    ['addChecklistItem', (s, id, t) => s.addChecklistItem(id, 'passo', t)],
    ['toggleChecklistItem', (s, id, t) => s.toggleChecklistItem(id, 'i-a', true, t)],
    ['deleteChecklistItem', (s, id, t) => s.deleteChecklistItem(id, 'i-a', t)],
  ];

  describe.each([
    ['de outra conta', 't-b'],
    ['sem conta (legado)', 't-0'],
  ])('tarefa %s', (_n, id) => {
    it.each(acoes)('%s → 403 e nada é gravado', async (_a, fn) => {
      const { svc, escritas, prisma } = montar();
      await expect(fn(svc, id, A)).rejects.toBeInstanceOf(ForbiddenException);
      expect(escritas()).toBe(0);
      // só a conferência da conta foi lida
      expect(prisma.task.findUnique).toHaveBeenCalledTimes(1);
      expect(prisma.task.findUnique.mock.calls[0][0]).toEqual({ where: { id }, select: { tenant_id: true } });
    });
  });

  it('conta própria: findOne lê a tarefa com o mesmo include de antes', async () => {
    const { svc, prisma } = montar();
    await expect(svc.findOne('t-a', A)).resolves.toMatchObject({ id: 't-a' });
    expect(prisma.task.findUnique.mock.calls[1][0]).toEqual({
      where: { id: 't-a' },
      include: {
        assigned_user: { select: { id: true, name: true } },
        lead: { select: { id: true, name: true, phone: true } },
        comments: { include: { user: { select: { id: true, name: true } } }, orderBy: { created_at: 'asc' } },
        checklist_items: { orderBy: { position: 'asc' } },
        _count: { select: { comments: true, checklist_items: true } },
      },
    });
  });

  it('conta própria: complete grava o mesmo de antes (tarefa, conversa reaberta, comentário)', async () => {
    const { svc, prisma } = montar();
    await expect(svc.complete('t-a', ' feito ', 'u-a', A)).resolves.toMatchObject({ conversationId: 'c-a' });
    expect(prisma.task.update.mock.calls).toEqual([
      [{ where: { id: 't-a' }, data: { status: 'CONCLUIDA', completion_note: 'feito' } }],
    ]);
    expect(prisma.conversation.update.mock.calls).toEqual([[{ where: { id: 'c-a' }, data: { status: 'ABERTO' } }]]);
    expect(prisma.taskComment.create.mock.calls).toEqual([
      [{ data: { task_id: 't-a', user_id: 'u-a', text: '✅ Concluída: feito' } }],
    ]);
  });

  it('conta própria: updateStatus, addComment e postpone gravam como antes', async () => {
    const { svc, prisma } = montar();
    await svc.updateStatus('t-a', 'EM_PROGRESSO', A);
    expect(prisma.task.update.mock.calls[0][0]).toEqual({ where: { id: 't-a' }, data: { status: 'EM_PROGRESSO' } });
    await svc.addComment('t-a', 'u-a', 'oi', A);
    expect(prisma.taskComment.create.mock.calls[0][0]).toEqual({
      data: { task_id: 't-a', user_id: 'u-a', text: 'oi' },
      include: { user: { select: { id: true, name: true } } },
    });
    await expect(svc.postpone('t-a', '2026-11-01T12:00:00.000Z', 'sem retorno', 'u-a', A)).resolves.toEqual({
      ok: true,
      conversationId: 'c-a',
    });
    expect(prisma.taskPostponement.create).toHaveBeenCalledTimes(1);
  });

  it('id que não existe: como antes (findOne devolve null, sem 403)', async () => {
    const { svc } = montar();
    await expect(svc.findOne('t-nao-existe', A)).resolves.toBeNull();
    await expect(svc.complete('t-nao-existe', '', 'u-a', A)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('sem conta no token (plataforma): tarefa de qualquer conta passa, como antes', async () => {
    const { svc, prisma } = montar();
    await expect(svc.findOne('t-b', undefined)).resolves.toMatchObject({ id: 't-b' });
    await expect(svc.complete('t-0', '', 'system', undefined)).resolves.toMatchObject({ conversationId: 'c-0' });
    expect(prisma.conversation.update).toHaveBeenCalledWith({ where: { id: 'c-0' }, data: { status: 'ABERTO' } });
  });
});

describe('Tarefas — item do checklist da tarefa da URL', () => {
  it('item de outra tarefa (tarefa própria na URL) → 404 e nada é gravado', async () => {
    const { svc, escritas } = montar();
    await expect(svc.toggleChecklistItem('t-a', 'i-b', true, A)).rejects.toBeInstanceOf(NotFoundException);
    await expect(svc.deleteChecklistItem('t-a', 'i-b', A)).rejects.toBeInstanceOf(NotFoundException);
    expect(escritas()).toBe(0);
  });

  it('item da própria tarefa: mesmas escritas de antes', async () => {
    const { svc, prisma } = montar();
    await svc.toggleChecklistItem('t-a', 'i-a', true, A);
    await expect(svc.deleteChecklistItem('t-a', 'i-a', A)).resolves.toEqual({ ok: true });
    expect(prisma.taskChecklistItem.update.mock.calls).toEqual([[{ where: { id: 'i-a' }, data: { done: true } }]]);
    expect(prisma.taskChecklistItem.delete.mock.calls).toEqual([[{ where: { id: 'i-a' } }]]);
  });

  it('item que não existe: segue para a escrita, como antes', async () => {
    const { svc, prisma } = montar();
    await svc.toggleChecklistItem('t-a', 'i-nao-existe', false, A);
    expect(prisma.taskChecklistItem.update).toHaveBeenCalledWith({ where: { id: 'i-nao-existe' }, data: { done: false } });
  });

  it('sem conta no token (plataforma): como antes, sem leitura a mais', async () => {
    const { svc, prisma } = montar();
    await svc.toggleChecklistItem('t-b', 'i-b', true, undefined);
    expect(prisma.taskChecklistItem.findUnique).not.toHaveBeenCalled();
    expect(prisma.taskChecklistItem.update).toHaveBeenCalledWith({ where: { id: 'i-b' }, data: { done: true } });
  });
});

describe('Tarefas — conversa ativa (findActiveByConversation)', () => {
  it.each([
    ['de outra conta', 'c-b'],
    ['sem conta (legado)', 'c-0'],
  ])('conversa %s → 403, a tarefa nem é buscada', async (_n, conv) => {
    const { svc, prisma } = montar();
    await expect(svc.findActiveByConversation(conv, A)).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.task.findFirst).not.toHaveBeenCalled();
  });

  it('conversa da própria conta, inexistente ou sem conta no token: mesma busca de antes', async () => {
    const { svc, prisma } = montar();
    await svc.findActiveByConversation('c-a', A);
    await svc.findActiveByConversation('c-nao-existe', A);
    await svc.findActiveByConversation('c-b', undefined);
    const esperado = (id: string) => [
      { where: { conversation_id: id, status: { in: ['A_FAZER', 'EM_PROGRESSO'] } }, orderBy: { created_at: 'desc' } },
    ];
    expect(prisma.task.findFirst.mock.calls).toEqual([esperado('c-a'), esperado('c-nao-existe'), esperado('c-b')]);
  });
});

describe('Tarefas — criar (POST /tasks)', () => {
  it.each([
    ['contato de outra conta', { lead_id: 'l-b' }],
    ['contato sem conta', { lead_id: 'l-0' }],
    ['conversa de outra conta', { conversation_id: 'c-b' }],
    ['conversa sem conta', { conversation_id: 'c-0' }],
    ['responsável de outra conta', { assigned_user_id: 'u-b' }],
    ['responsável da plataforma (sem conta)', { assigned_user_id: 'u-plataforma' }],
    ['um da conta e outro não', { lead_id: 'l-a', conversation_id: 'c-a', assigned_user_id: 'u-b' }],
  ])('%s → 403 e a tarefa não é criada', async (_n, ids) => {
    const { ctrl, escritas } = montar();
    await expect(ctrl.create({ title: 'Ligar', ...ids } as any, req(A))).rejects.toBeInstanceOf(ForbiddenException);
    expect(escritas()).toBe(0);
  });

  it('tudo da própria conta: task.create com os mesmos dados de antes', async () => {
    const { ctrl, prisma } = montar();
    await ctrl.create(
      { title: 'Ligar', description: 'retorno', lead_id: 'l-a', conversation_id: 'c-a', assigned_user_id: 'u-a' } as any,
      req(A),
    );
    expect(prisma.task.create.mock.calls).toEqual([
      [
        {
          data: {
            title: 'Ligar',
            description: 'retorno',
            lead_id: 'l-a',
            conversation_id: 'c-a',
            assigned_user_id: 'u-a',
            due_at: null,
            tenant_id: A,
            status: 'A_FAZER',
          },
        },
      ],
    ]);
  });

  it('sem ids no corpo: nenhuma leitura a mais', async () => {
    const { ctrl, prisma } = montar();
    await ctrl.create({ title: 'Ligar' } as any, req(A));
    expect(prisma.lead.findUnique).not.toHaveBeenCalled();
    expect(prisma.conversation.findUnique).not.toHaveBeenCalled();
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
    expect(prisma.task.create.mock.calls[0][0].data.tenant_id).toBe(A);
  });

  it('id que não existe: segue para o create, como antes', async () => {
    const { ctrl, prisma } = montar();
    await ctrl.create({ title: 'Ligar', lead_id: 'l-nao-existe' } as any, req(A));
    expect(prisma.task.create).toHaveBeenCalledTimes(1);
  });

  it('sem conta no token (plataforma): passa, e a tarefa nasce na conta do contato/conversa/responsável', async () => {
    const { ctrl, prisma } = montar();
    await ctrl.create({ title: 'Ligar', lead_id: 'l-b', assigned_user_id: 'u-a' } as any, req(undefined, 'u-plataforma'));
    await ctrl.create({ title: 'Ligar', lead_id: 'l-0', conversation_id: 'c-a' } as any, req(undefined, 'u-plataforma'));
    await ctrl.create({ title: 'Ligar', assigned_user_id: 'u-b' } as any, req(undefined, 'u-plataforma'));
    await ctrl.create({ title: 'Ligar' } as any, req(undefined, 'u-plataforma'));
    expect(prisma.task.create.mock.calls.map((c: any[]) => c[0].data.tenant_id)).toEqual([B, A, B, undefined]);
  });
});

describe('Tarefas — editar (PATCH /tasks/:id)', () => {
  it.each([
    ['de outra conta', 'u-b'],
    ['da plataforma (sem conta)', 'u-plataforma'],
  ])('responsável %s → 403 e nada é gravado', async (_n, user) => {
    const { svc, escritas } = montar();
    await expect(svc.update('t-a', { assigned_user_id: user }, A)).rejects.toBeInstanceOf(ForbiddenException);
    expect(escritas()).toBe(0);
  });

  it('responsável da própria conta, ou tirar o responsável: mesmo update de antes', async () => {
    const { svc, prisma } = montar();
    await svc.update('t-a', { title: 'novo', assigned_user_id: 'u-a' }, A);
    await svc.update('t-a', { assigned_user_id: null }, A);
    expect(prisma.task.update.mock.calls).toEqual([
      [{ where: { id: 't-a' }, data: { title: 'novo', assigned_user_id: 'u-a' } }],
      [{ where: { id: 't-a' }, data: { assigned_user_id: null } }],
    ]);
    expect(prisma.user.findUnique).toHaveBeenCalledTimes(1);
  });

  it('sem conta no token (plataforma): passa, como antes', async () => {
    const { svc, prisma } = montar();
    await svc.update('t-b', { assigned_user_id: 'u-a' }, undefined);
    expect(prisma.task.update).toHaveBeenCalledWith({ where: { id: 't-b' }, data: { assigned_user_id: 'u-a' } });
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
  });
});

describe('Robô de admin (create_task) — a tarefa nasce com conta', () => {
  function montarRobo() {
    const m = montar();
    const robo = new AdminBotService(m.prisma, {} as any, m.svc, {} as any, {} as any, {} as any);
    const rodar = (args: any, tenant: string | null, userId = 'u-a') =>
      (robo as any).executeTool('create_task', args, userId, tenant);
    return { ...m, rodar };
  }

  it('robô da conta: tarefa na conta do robô, mesmos dados de antes', async () => {
    const { rodar, prisma } = montarRobo();
    await expect(rodar({ title: 'Ligar', lead_id: 'l-a' }, A)).resolves.toMatchObject({ success: true });
    expect(prisma.task.create.mock.calls[0][0].data).toMatchObject({
      title: 'Ligar',
      lead_id: 'l-a',
      assigned_user_id: 'u-a',
      tenant_id: A,
      status: 'A_FAZER',
    });
    expect(prisma.lead.findUnique).not.toHaveBeenCalled();
  });

  it('robô sem conta: a tarefa nasce na conta do contato; sem contato, na do responsável', async () => {
    const { rodar, prisma } = montarRobo();
    await rodar({ title: 'Ligar', lead_id: 'l-b' }, null, 'u-plataforma');
    await rodar({ title: 'Ligar', assigned_user_id: 'u-a' }, null, 'u-plataforma');
    expect(prisma.task.create.mock.calls.map((c: any[]) => c[0].data.tenant_id)).toEqual([B, A]);
  });
});

import { ConversationsService } from './conversations.service';

// Números de não-lidas "reais" (out/2026): contam CONVERSAS (não mensagens), o
// admin conta a lista inteira, os filtros seguem as regras do front e abrir a
// conversa sempre zera — mesmo sem chip/número/id do WhatsApp.
function makeService(prisma: any, whatsapp: any = { markAsRead: jest.fn() }) {
  const gateway: any = { emitConversationRead: jest.fn(), emitConversationsUpdate: jest.fn() };
  const notifications: any = { markByConversation: jest.fn().mockResolvedValue(undefined) };
  return { svc: new ConversationsService(prisma, gateway, whatsapp, notifications), gateway, whatsapp };
}

describe('não-lidas reais', () => {
  it('admin: conta mensagens de TODAS as conversas visíveis (não só as atribuídas a ele)', async () => {
    const prisma: any = {
      user: { findUnique: jest.fn().mockResolvedValue({ roles: ['ADMIN'], inboxes: [] }) },
      conversation: { findMany: jest.fn() },
      message: { groupBy: jest.fn().mockResolvedValue([{ conversation_id: 'c1', _count: { id: 3 } }]) },
    };
    const { svc } = makeService(prisma);
    await expect(svc.getUnreadCounts('t1', 'admin')).resolves.toEqual({ c1: 3 });
    expect(prisma.conversation.findMany).not.toHaveBeenCalled();
    const where = prisma.message.groupBy.mock.calls[0][0].where;
    expect(where.conversation.tenant_id).toBe('t1');
    expect(where.conversation.status).toEqual({ not: 'ENCERRADO' });
    expect(where.conversation).not.toHaveProperty('assigned_user_id');
  });

  it('resumo conta CONVERSAS por aba e por filtro', async () => {
    const prisma: any = {
      user: { findUnique: jest.fn().mockResolvedValue({ roles: ['ADMIN'], inboxes: [] }) },
      message: {
        groupBy: jest.fn().mockResolvedValue([
          { conversation_id: 'mine', _count: { id: 7 } },
          { conversation_id: 'wait', _count: { id: 2 } },
          { conversation_id: 'bot', _count: { id: 4 } },
          { conversation_id: 'adi', _count: { id: 1 } },
          { conversation_id: 'cli', _count: { id: 5 } },
          { conversation_id: 'fin', _count: { id: 9 } },
        ]),
      },
      conversation: {
        findMany: jest.fn().mockResolvedValue([
          { id: 'mine', status: 'ABERTO', ai_mode: false, assigned_user_id: 'admin', assigned_dentist_id: null, lead: { is_client: false }, inbox: { purpose: 'COMERCIAL' } },
          { id: 'wait', status: 'ABERTO', ai_mode: false, assigned_user_id: null, assigned_dentist_id: null, lead: { is_client: false }, inbox: null },
          { id: 'bot', status: 'ABERTO', ai_mode: true, assigned_user_id: 'admin', assigned_dentist_id: null, lead: { is_client: false }, inbox: null },
          { id: 'adi', status: 'ADIADO', ai_mode: false, assigned_user_id: null, assigned_dentist_id: null, lead: { is_client: false }, inbox: null },
          { id: 'cli', status: 'ABERTO', ai_mode: false, assigned_user_id: 'outro', assigned_dentist_id: 'admin', lead: { is_client: true }, inbox: { purpose: 'CLINICA' } },
          { id: 'fin', status: 'FECHADO', ai_mode: false, assigned_user_id: 'admin', assigned_dentist_id: null, lead: { is_client: true }, inbox: { purpose: 'FINANCEIRO' } },
        ]),
      },
    };
    const { svc } = makeService(prisma);
    const r = await svc.getUnreadSummary('t1', 'admin');
    // 4 conversas de lead (não 7+2+4+1 = 14 mensagens)
    expect(r.leads).toBe(4);
    expect(r.clients).toBe(1);
    expect(r.financial).toBe(1);
    expect(r.filters.leads).toEqual({ all: 4, mine: 1, waiting: 1, adiado: 1 });
    // dentista responsável também é "minha"
    expect(r.filters.clients).toEqual({ all: 1, mine: 1, waiting: 0, adiado: 0 });
    // fechada não entra em Minhas nem Espera
    expect(r.filters.financial).toEqual({ all: 1, mine: 0, waiting: 0, adiado: 0 });
  });

  it('abrir conversa sem chip zera as não-lidas (sem mandar tique azul)', async () => {
    const prisma: any = {
      conversation: { findUnique: jest.fn().mockResolvedValue({ id: 'c1', instance_name: null, tenant_id: 't1', lead: { phone: '5582999990000' } }) },
      message: {
        findMany: jest.fn().mockResolvedValue([{ id: 'm1', external_message_id: 'ABC' }, { id: 'm2', external_message_id: null }]),
        updateMany: jest.fn().mockResolvedValue({ count: 2 }),
      },
    };
    const { svc, whatsapp, gateway } = makeService(prisma);
    await expect(svc.markAsRead('c1', 'u1')).resolves.toEqual({ marked: 2 });
    expect(whatsapp.markAsRead).not.toHaveBeenCalled();
    expect(prisma.message.updateMany).toHaveBeenCalledWith({ where: { id: { in: ['m1', 'm2'] } }, data: { status: 'lido' } });
    expect(gateway.emitConversationRead).toHaveBeenCalledWith('u1', 'c1');
  });

  it('com chip: tique azul só das que têm id do WhatsApp, mas marca todas como lidas', async () => {
    const prisma: any = {
      conversation: { findUnique: jest.fn().mockResolvedValue({ id: 'c1', instance_name: 'clinica', external_id: null, tenant_id: 't1', lead: { phone: '5582999990000' } }) },
      message: {
        findMany: jest.fn().mockResolvedValue([{ id: 'm1', external_message_id: 'ABC' }, { id: 'm2', external_message_id: null }]),
        updateMany: jest.fn().mockResolvedValue({ count: 2 }),
      },
    };
    const { svc, whatsapp } = makeService(prisma);
    await svc.markAsRead('c1', 'u1');
    expect(whatsapp.markAsRead).toHaveBeenCalledWith('clinica', [{ remoteJid: '5582999990000@s.whatsapp.net', fromMe: false, id: 'ABC' }]);
    expect(prisma.message.updateMany.mock.calls[0][0].where.id.in).toEqual(['m1', 'm2']);
  });
});

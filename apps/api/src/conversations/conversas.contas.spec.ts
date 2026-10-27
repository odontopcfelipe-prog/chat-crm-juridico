/**
 * Chat só da própria conta: conversas, mensagens, notas internas e "Recarregar" mídia.
 *
 *  - conversa de outra conta, ou sem conta (nem na conversa nem no contato) → 403
 *    (na mídia, o mesmo 404 de mensagem inexistente), sem gravar nem enviar nada;
 *  - conversa sem conta gravada mas com contato da conta → segue como hoje;
 *  - lead/setor/usuário/chip vindos do corpo só da própria conta (as rotas do
 *    controller levam a conta do login ao service);
 *  - dentista vinculado de outra conta → a mesma resposta de "nenhum dentista vinculado";
 *  - citação (replyToId) só de mensagem da própria conta;
 *  - conta própria → as mesmas chamadas de hoje; SUPER_ADMIN (sem conta) passa.
 *
 * Repositório público: ids e números fictícios.
 */
import { BadRequestException, ForbiddenException, Logger, NotFoundException } from '@nestjs/common';
import { __limparCacheLabTenants } from '@crm/shared';
import { ConversationOwnershipGuard } from './conversation-ownership.guard';
import { ConversationsService } from './conversations.service';
import { ConversationsController } from './conversations.controller';
import { MessagesService } from '../messages/messages.service';
import { MediaDownloadService } from '../media/media-download.service';
import { MediaController } from '../media/media.controller';

const LEADS: Record<string, any> = {
  'lead-a': { id: 'lead-a', tenant_id: 'a', phone: '558290000001', is_client: true, created_at: new Date('2026-01-01'), profile_picture_url: null },
  'lead-b': { id: 'lead-b', tenant_id: 'b', phone: '558290000002', is_client: true, created_at: new Date('2026-01-01'), profile_picture_url: null },
  'lead-0': { id: 'lead-0', tenant_id: null, phone: '558290000003', is_client: true, created_at: new Date('2026-01-01'), profile_picture_url: null },
};
const CONVS: Record<string, any> = {
  'conv-a': { id: 'conv-a', tenant_id: 'a', lead_id: 'lead-a', instance_name: 'chip-a', inbox_id: null, assigned_user_id: null },
  'conv-b': { id: 'conv-b', tenant_id: 'b', lead_id: 'lead-b', instance_name: 'chip-b', inbox_id: null, assigned_user_id: null },
  // legado sem conta (nem na conversa, nem no contato)
  'conv-0': { id: 'conv-0', tenant_id: null, lead_id: 'lead-0', instance_name: 'chip-0', inbox_id: null, assigned_user_id: null },
  // nasceu sem conta gravada, mas o contato é da conta "a"
  'conv-0a': { id: 'conv-0a', tenant_id: null, lead_id: 'lead-a', instance_name: 'chip-a', inbox_id: null, assigned_user_id: null },
};
const MSGS: Record<string, any> = {
  'msg-a': { id: 'msg-a', conversation_id: 'conv-a', external_message_id: 'ext-a', direction: 'out', type: 'text', text: 'oi a', instance_name: 'chip-a', media: { file_path: '2026/01/msg-a.ogg' } },
  'msg-b': { id: 'msg-b', conversation_id: 'conv-b', external_message_id: 'ext-b', direction: 'out', type: 'text', text: 'texto da b', instance_name: 'chip-b', media: null },
  'msg-0': { id: 'msg-0', conversation_id: 'conv-0', external_message_id: 'ext-0', direction: 'out', type: 'text', text: 'legado', instance_name: 'chip-0', media: null },
  'msg-0a': { id: 'msg-0a', conversation_id: 'conv-0a', external_message_id: 'ext-0a', direction: 'in', type: 'text', text: 'do contato a', instance_name: 'chip-a', media: null },
  'msg-0a-out': { id: 'msg-0a-out', conversation_id: 'conv-0a', external_message_id: 'ext-0a-out', direction: 'out', type: 'text', text: 'da equipe a', instance_name: 'chip-a', media: null },
};
const USERS: Record<string, any> = {
  'u-a': { id: 'u-a', tenant_id: 'a', name: 'Ana', phone: '558290000010' },
  'u-a2': { id: 'u-a2', tenant_id: 'a', name: 'Bia', phone: '558290000011' },
  'u-b': { id: 'u-b', tenant_id: 'b', name: 'Caio', phone: '558290000012' },
  'u-0': { id: 'u-0', tenant_id: null, name: 'Sem conta', phone: '558290000013' },
};
const INBOXES: Record<string, any> = {
  'in-a': { id: 'in-a', tenant_id: 'a' },
  'in-b': { id: 'in-b', tenant_id: 'b' },
  'in-0': { id: 'in-0', tenant_id: null },
};
const INSTANCES: Record<string, any> = {
  'chip-a': { name: 'chip-a', tenant_id: 'a' },
  'chip-b': { name: 'chip-b', tenant_id: 'b' },
  'chip-0': { name: 'chip-0', tenant_id: null },
};

const conv = (id: string) => {
  const c = CONVS[id];
  return c ? { ...c, lead: { ...LEADS[c.lead_id] } } : null;
};

function montar() {
  const prisma: any = {
    conversation: {
      findUnique: jest.fn(async ({ where }: any) => conv(where.id)),
      findMany: jest.fn(async () => []),
      create: jest.fn(async ({ data }: any) => ({ id: 'conv-nova', ...data })),
      update: jest.fn(async ({ where }: any) => ({ ...conv(where.id), lead: { name: 'Contato', phone: '558290000001' } })),
    },
    lead: { findUnique: jest.fn(async ({ where }: any) => LEADS[where.id] ?? null), findFirst: jest.fn(async () => null), update: jest.fn() },
    inbox: { findUnique: jest.fn(async ({ where }: any) => INBOXES[where.id] ?? null) },
    instance: {
      findUnique: jest.fn(async ({ where }: any) => INSTANCES[where.name] ?? null),
      findMany: jest.fn(async () => []),
      findFirst: jest.fn(async () => null),
    },
    user: { findUnique: jest.fn(async ({ where }: any) => USERS[where.id] ?? null), findMany: jest.fn(async () => []) },
    message: {
      findUnique: jest.fn(async ({ where }: any) => {
        const m = MSGS[where.id];
        return m ? { ...m, created_at: new Date(), conversation: conv(m.conversation_id) } : null;
      }),
      findMany: jest.fn(async () => []),
      count: jest.fn(async () => 0),
      create: jest.fn(async ({ data }: any) => ({ id: 'msg-nova', ...data })),
      update: jest.fn(async ({ where, data }: any) => ({ id: where.id, ...data })),
    },
    media: { create: jest.fn(), upsert: jest.fn() },
    conversationNote: { findMany: jest.fn(async () => []), create: jest.fn(async ({ data }: any) => ({ id: 'nota-1', ...data })) },
    calendarEvent: { updateMany: jest.fn() },
    messageReaction: { upsert: jest.fn(), deleteMany: jest.fn(), findMany: jest.fn(async () => []) },
    tenantBusinessProfile: { findMany: jest.fn(async () => []) },
  };
  // A transação usa o mesmo mock (tx = prisma).
  prisma.$transaction = jest.fn(async (fn: any) => fn(prisma));

  const gateway: any = {
    emitNewMessage: jest.fn(), emitConversationsUpdate: jest.fn(), emitTransferRequest: jest.fn(),
    emitNewNote: jest.fn(), emitMessageUpdate: jest.fn(), emitMessageReaction: jest.fn(), emitMessagesSynced: jest.fn(),
  };
  const whatsapp: any = {
    sendText: jest.fn(async () => ({ key: { id: 'ext-novo' } })),
    sendMedia: jest.fn(async () => ({ key: { id: 'ext-midia' } })),
    fetchMessages: jest.fn(async () => []),
    fetchProfilePicture: jest.fn(async () => null),
    editMessage: jest.fn(), deleteForEveryone: jest.fn(), sendReaction: jest.fn(),
  };
  const fileStorage: any = { generatePath: jest.fn(() => '2026/01/x.bin'), write: jest.fn(), read: jest.fn() };
  const mediaSign: any = { attachToMessages: jest.fn(), signedQuery: jest.fn(() => 'token=x') };
  const aiQueue: any = { getJob: jest.fn(async () => null), add: jest.fn() };

  const conversas = new ConversationsService(prisma, gateway, whatsapp, {} as any);
  const mensagens = new MessagesService(prisma, whatsapp, gateway, {} as any, fileStorage, {} as any, mediaSign, aiQueue);
  const midia = new MediaDownloadService(prisma, fileStorage, {} as any, {} as any, gateway);

  /** Toda escrita no banco e todo envio ao WhatsApp/socket com efeito. */
  const escritas = () => [
    prisma.conversation.create, prisma.conversation.update, prisma.lead.update,
    prisma.message.create, prisma.message.update, prisma.media.create, prisma.media.upsert,
    prisma.conversationNote.create, prisma.calendarEvent.updateMany,
    prisma.messageReaction.upsert, prisma.messageReaction.deleteMany,
    whatsapp.sendText, whatsapp.sendMedia, whatsapp.fetchMessages, whatsapp.editMessage,
    whatsapp.deleteForEveryone, whatsapp.sendReaction, fileStorage.write,
    gateway.emitNewMessage, gateway.emitTransferRequest, gateway.emitNewNote, gateway.emitMessageUpdate,
  ].reduce((n, fn) => n + fn.mock.calls.length, 0);

  return { prisma, gateway, whatsapp, fileStorage, conversas, mensagens, midia, escritas };
}

const ctx = (user: any, params: any) => ({ switchToHttp: () => ({ getRequest: () => ({ user, params }) }) }) as any;
const NEGADO = ForbiddenException;
const SEM_DENTISTA = 'Nenhum dentista foi vinculado a esta conversa pela IA. Aguarde a IA processar as mensagens ou faça transferência manual.';

/** Roda `fn` com campos trocados na conv-a e devolve a fixture como estava. */
async function comConvA(campos: Record<string, any>, fn: () => Promise<void>) {
  const antes = { ...CONVS['conv-a'] };
  Object.assign(CONVS['conv-a'], campos);
  try {
    await fn();
  } finally {
    CONVS['conv-a'] = antes;
  }
}

beforeEach(() => {
  __limparCacheLabTenants();
  jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
});
afterEach(() => jest.restoreAllMocks());

describe('ConversationOwnershipGuard — rotas :id só da própria conta', () => {
  it('conversa de outra conta e legado sem conta → 403', async () => {
    const { prisma } = montar();
    const guard = new ConversationOwnershipGuard(prisma);
    await expect(guard.canActivate(ctx({ tenant_id: 'a' }, { id: 'conv-b' }))).rejects.toThrow(NEGADO);
    await expect(guard.canActivate(ctx({ tenant_id: 'a' }, { id: 'conv-0' }))).rejects.toThrow(NEGADO);
  });

  it('conta própria: passa com a mesma consulta de hoje (uma só)', async () => {
    const { prisma } = montar();
    const guard = new ConversationOwnershipGuard(prisma);
    await expect(guard.canActivate(ctx({ tenant_id: 'a' }, { id: 'conv-a' }))).resolves.toBe(true);
    expect(prisma.conversation.findUnique.mock.calls).toEqual([[{ where: { id: 'conv-a' }, select: { tenant_id: true } }]]);
  });

  it('conversa sem conta gravada e contato da conta → passa; inexistente → segue pro handler', async () => {
    const { prisma } = montar();
    const guard = new ConversationOwnershipGuard(prisma);
    await expect(guard.canActivate(ctx({ tenant_id: 'a' }, { id: 'conv-0a' }))).resolves.toBe(true);
    await expect(guard.canActivate(ctx({ tenant_id: 'a' }, { id: 'nao-existe' }))).resolves.toBe(true);
  });

  it('SUPER_ADMIN (sem conta) passa sem consultar', async () => {
    const { prisma } = montar();
    const guard = new ConversationOwnershipGuard(prisma);
    await expect(guard.canActivate(ctx({ tenant_id: undefined }, { id: 'conv-b' }))).resolves.toBe(true);
    expect(prisma.conversation.findUnique).not.toHaveBeenCalled();
  });
});

describe('ConversationsService — leitura só da própria conta', () => {
  it('findOne: outra conta e legado sem conta → 403; própria e sem conta gravada com contato da conta → devolve', async () => {
    const { conversas } = montar();
    await expect(conversas.findOne('conv-b', 'a')).rejects.toThrow(NEGADO);
    await expect(conversas.findOne('conv-0', 'a')).rejects.toThrow(NEGADO);
    await expect(conversas.findOne('conv-a', 'a')).resolves.toMatchObject({ id: 'conv-a' });
    await expect(conversas.findOne('conv-0a', 'a')).resolves.toMatchObject({ id: 'conv-0a' });
    await expect(conversas.findOne('nao-existe', 'a')).resolves.toBeNull();
    await expect(conversas.findOne('conv-b', undefined)).resolves.toMatchObject({ id: 'conv-b' });
  });

  it('findAllByLead: lead de outra conta e lead sem conta → 403 sem listar', async () => {
    const { conversas, prisma } = montar();
    await expect(conversas.findAllByLead('lead-b', 'a')).rejects.toThrow(NEGADO);
    await expect(conversas.findAllByLead('lead-0', 'a')).rejects.toThrow(NEGADO);
    expect(prisma.conversation.findMany).not.toHaveBeenCalled();
  });

  it('findAllByLead: lead da própria conta → mesma consulta de hoje; SUPER_ADMIN passa', async () => {
    const { conversas, prisma } = montar();
    await conversas.findAllByLead('lead-a', 'a');
    await conversas.findAllByLead('lead-b', undefined);
    expect(prisma.conversation.findMany.mock.calls[0][0]).toEqual({
      where: { lead_id: 'lead-a' },
      orderBy: { last_message_at: 'desc' },
      include: {
        lead: { include: { memory: { select: { facts_json: true } } } },
        messages: { orderBy: { created_at: 'asc' }, take: 100, include: { media: true, skill: { select: { id: true, name: true, area: true } } } },
        assigned_user: { select: { id: true, name: true } },
      },
    });
    expect(prisma.conversation.findMany).toHaveBeenCalledTimes(2);
  });

  it('notas internas: outra conta e legado sem conta → 403 sem listar nem gravar', async () => {
    const { conversas, prisma, escritas } = montar();
    await expect(conversas.listNotes('conv-b', 'a')).rejects.toThrow(NEGADO);
    await expect(conversas.listNotes('conv-0', 'a')).rejects.toThrow(NEGADO);
    await expect(conversas.createNote('conv-b', 'u-a', 'x', 'a')).rejects.toThrow(NEGADO);
    await expect(conversas.createNote('conv-0', 'u-a', 'x', 'a')).rejects.toThrow(NEGADO);
    expect(prisma.conversationNote.findMany).not.toHaveBeenCalled();
    expect(escritas()).toBe(0);
  });

  it('notas internas: conta própria grava igual a hoje; SUPER_ADMIN passa', async () => {
    const { conversas, prisma } = montar();
    await conversas.createNote('conv-a', 'u-a', 'lembrar', 'a');
    await conversas.listNotes('conv-b', undefined);
    expect(prisma.conversationNote.create).toHaveBeenCalledWith({
      data: { conversation_id: 'conv-a', user_id: 'u-a', text: 'lembrar' },
      include: { user: { select: { id: true, name: true } } },
    });
    expect(prisma.conversationNote.findMany).toHaveBeenCalledTimes(1);
  });
});

describe('POST /conversations — lead, setor e chip só da própria conta', () => {
  const criar = (dto: any, user: any) => {
    const m = montar();
    const controller = new ConversationsController(m.conversas);
    return { ...m, r: controller.create(dto, { user }) };
  };

  it('lead de outra conta, lead sem conta, setor de outra conta ou sem conta → 403 sem criar', async () => {
    for (const dto of [
      { lead_id: 'lead-b' },
      { lead_id: 'lead-0' },
      { lead_id: 'lead-a', inbox_id: 'in-b' },
      { lead_id: 'lead-a', inbox_id: 'in-0' },
    ]) {
      const { r, prisma, escritas } = criar(dto, { id: 'u-a', tenant_id: 'a' });
      await expect(r).rejects.toThrow(NEGADO);
      expect(prisma.conversation.create).not.toHaveBeenCalled();
      expect(escritas()).toBe(0);
    }
  });

  it('conta própria: cria com exatamente os mesmos dados de hoje', async () => {
    const { r, prisma } = criar({ lead_id: 'lead-a', inbox_id: 'in-a' }, { id: 'u-a', tenant_id: 'a' });
    await r;
    expect(prisma.conversation.create.mock.calls).toEqual([[{
      data: {
        lead: { connect: { id: 'lead-a' } },
        channel: 'whatsapp',
        external_id: undefined,
        inbox: { connect: { id: 'in-a' } },
        instance_name: null,
        ai_mode: true,
        tenant: { connect: { id: 'a' } },
      },
    }]]);
  });

  it('SUPER_ADMIN (sem conta) passa e a conversa nasce na conta do lead', async () => {
    const { r, prisma } = criar({ lead_id: 'lead-b', instance_name: 'chip-b' }, { id: 'root', tenant_id: undefined });
    await r;
    expect(prisma.conversation.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ lead: { connect: { id: 'lead-b' } }, instance_name: 'chip-b', tenant: { connect: { id: 'b' } } }),
    });
    expect(prisma.instance.findUnique).not.toHaveBeenCalled();
  });

  it('chip pedido: de outra conta ou sem conta é ignorado; da própria conta e nome legado sem cadastro seguem', async () => {
    const { conversas } = montar();
    await expect(conversas.resolveManualConversationInstance('a', 'lead-a', 'chip-b')).resolves.toBeNull();
    await expect(conversas.resolveManualConversationInstance('a', 'lead-a', 'chip-0')).resolves.toBeNull();
    await expect(conversas.resolveManualConversationInstance('a', 'lead-a', 'chip-a')).resolves.toBe('chip-a');
    await expect(conversas.resolveManualConversationInstance('a', 'lead-a', 'whatsapp')).resolves.toBe('whatsapp');
    await expect(conversas.resolveManualConversationInstance(undefined, 'lead-a', 'chip-b')).resolves.toBe('chip-b');
  });
});

describe('Atribuir / transferir / dentista vinculado — usuário só da própria conta', () => {
  it('transferir (PATCH :id/transfer) para usuário de outra conta ou sem conta → 403 sem gravar', async () => {
    const { conversas, escritas } = montar();
    await expect(conversas.assign('conv-a', 'u-b', 'a')).rejects.toThrow(NEGADO);
    await expect(conversas.assign('conv-a', 'u-0', 'a')).rejects.toThrow(NEGADO);
    expect(escritas()).toBe(0);
  });

  it('transferir para usuário da própria conta (ou id inexistente) → mesma gravação de hoje; SUPER_ADMIN passa', async () => {
    const { conversas, prisma } = montar();
    await conversas.assign('conv-a', 'u-a2', 'a');
    await conversas.assign('conv-a', 'nao-existe', 'a');
    await conversas.assign('conv-b', 'u-a', undefined);
    expect(prisma.conversation.update.mock.calls.map((c: any[]) => c[0])).toEqual([
      { where: { id: 'conv-a' }, data: { assigned_user_id: 'u-a2', ai_mode: false, ai_mode_disabled_at: expect.any(Date), ai_mode_source: 'MANUAL' } },
      { where: { id: 'conv-a' }, data: { assigned_user_id: 'nao-existe', ai_mode: false, ai_mode_disabled_at: expect.any(Date), ai_mode_source: 'MANUAL' } },
      { where: { id: 'conv-b' }, data: { assigned_user_id: 'u-a', ai_mode: false, ai_mode_disabled_at: expect.any(Date), ai_mode_source: 'MANUAL' } },
    ]);
  });

  it('assumir (PATCH :id/assign) usa o próprio usuário: nenhuma consulta a mais', async () => {
    const { conversas, prisma } = montar();
    await conversas.assign('conv-a', 'u-a');
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
  });

  it('dentista vinculado de outra conta → 403 sem gravar nem avisar no WhatsApp', async () => {
    const { conversas, escritas } = montar();
    await expect(conversas.setAssignedLawyer('conv-a', 'u-b', 'a')).rejects.toThrow(NEGADO);
    await expect(conversas.setAssignedLawyer('conv-a', 'u-0', 'a')).rejects.toThrow(NEGADO);
    expect(escritas()).toBe(0);
  });

  it('dentista vinculado da própria conta → mesmas gravações e aviso de hoje', async () => {
    const { conversas, prisma, whatsapp } = montar();
    await conversas.setAssignedLawyer('conv-a', 'u-a2', 'a');
    expect(prisma.conversation.update).toHaveBeenCalledWith({ where: { id: 'conv-a' }, data: { assigned_dentist_id: 'u-a2' } });
    expect(whatsapp.sendText).toHaveBeenCalledWith('558290000011', expect.any(String), 'chip-a');
    expect(prisma.calendarEvent.updateMany).toHaveBeenCalledWith({
      where: { conversation_id: 'conv-a', status: { notIn: ['CONCLUIDO', 'CANCELADO'] } },
      data: { assigned_user_id: 'u-a2' },
    });
  });

  it('pedido de transferência para usuário de outra conta → 403 sem gravar nem avisar', async () => {
    const { conversas, prisma, gateway, escritas } = montar();
    CONVS['conv-a'].assigned_user_id = 'u-a';
    try {
      await expect(conversas.requestTransfer('conv-a', 'u-b', 'u-a', 'motivo', undefined, 'a')).rejects.toThrow(NEGADO);
      await expect(conversas.requestTransfer('conv-a', 'u-0', 'u-a', 'motivo', undefined, 'a')).rejects.toThrow(NEGADO);
      expect(prisma.conversation.update).not.toHaveBeenCalled();
      expect(gateway.emitTransferRequest).not.toHaveBeenCalled();
      expect(escritas()).toBe(0);
    } finally {
      CONVS['conv-a'].assigned_user_id = null;
    }
  });

  it('pedido de transferência na própria conta → grava e avisa igual a hoje; SUPER_ADMIN passa', async () => {
    const { conversas, prisma, gateway } = montar();
    CONVS['conv-a'].assigned_user_id = 'u-a';
    try {
      await conversas.requestTransfer('conv-a', 'u-a2', 'u-a', 'motivo', undefined, 'a');
      await conversas.requestTransfer('conv-a', 'u-b', 'u-a', 'motivo', undefined, undefined);
      expect(prisma.conversation.update.mock.calls[0][0]).toEqual({
        where: { id: 'conv-a' },
        data: { pending_transfer_to_id: 'u-a2', pending_transfer_from_id: 'u-a', pending_transfer_reason: 'motivo' },
        include: { lead: { select: { name: true, phone: true } } },
      });
      expect(gateway.emitTransferRequest.mock.calls.map((c: any[]) => c[0])).toEqual(['u-a2', 'u-b']);
    } finally {
      CONVS['conv-a'].assigned_user_id = null;
    }
  });

  it('transferir ao dentista vinculado de outra conta ou sem conta → a mesma resposta de "nenhum dentista vinculado", sem gravar nem avisar', async () => {
    for (const dentista of ['u-b', 'u-0']) {
      const { conversas, prisma, gateway, escritas } = montar();
      await comConvA({ assigned_user_id: 'u-a', assigned_dentist_id: dentista }, async () => {
        const r = conversas.transferToAssignedLawyer('conv-a', 'u-a', undefined, undefined, 'a');
        await expect(r).rejects.toBeInstanceOf(BadRequestException);
        await expect(r).rejects.toThrow(SEM_DENTISTA);
        expect(prisma.conversation.update).not.toHaveBeenCalled();
        expect(gateway.emitTransferRequest).not.toHaveBeenCalled();
        expect(escritas()).toBe(0);
      });
    }
  });

  it('transferir ao dentista vinculado da própria conta → grava a origem e pede a transferência igual a hoje; SUPER_ADMIN passa', async () => {
    const { conversas, prisma, gateway } = montar();
    await comConvA({ assigned_user_id: 'u-a', assigned_dentist_id: 'u-a2', specialty: 'Ortodontia' }, async () => {
      await conversas.transferToAssignedLawyer('conv-a', 'u-a', undefined, undefined, 'a');
      await conversas.transferToAssignedLawyer('conv-a', 'u-a', 'motivo', undefined, undefined);
    });
    await comConvA({ assigned_user_id: 'u-a', assigned_dentist_id: 'u-b' }, async () => {
      await conversas.transferToAssignedLawyer('conv-a', 'u-a', 'motivo', undefined, undefined);
    });
    expect(prisma.conversation.update.mock.calls.map((c: any[]) => c[0].data)).toEqual([
      { origin_assigned_user_id: 'u-a' },
      { pending_transfer_to_id: 'u-a2', pending_transfer_from_id: 'u-a', pending_transfer_reason: 'Especialidade detectada pela IA: Ortodontia' },
      { origin_assigned_user_id: 'u-a' },
      { pending_transfer_to_id: 'u-a2', pending_transfer_from_id: 'u-a', pending_transfer_reason: 'motivo' },
      { origin_assigned_user_id: 'u-a' },
      { pending_transfer_to_id: 'u-b', pending_transfer_from_id: 'u-a', pending_transfer_reason: 'motivo' },
    ]);
    expect(gateway.emitTransferRequest.mock.calls.map((c: any[]) => c[0])).toEqual(['u-a2', 'u-a2', 'u-b']);
  });
});

describe('ConversationsController — as rotas de atribuir/transferir levam a conta do login ao service', () => {
  const REQ_A = { user: { id: 'u-a', tenant_id: 'a' } };
  const montarController = () => {
    const m = montar();
    return { ...m, controller: new ConversationsController(m.conversas) };
  };

  it('usuário de outra conta pelo controller → recusado sem gravar nem avisar (transfer, transfer-request, transfer-to-lawyer, assign-lawyer)', async () => {
    await comConvA({ assigned_user_id: 'u-a', assigned_dentist_id: 'u-b' }, async () => {
      const { controller, escritas } = montarController();
      await expect(controller.transfer('conv-a', 'u-b', REQ_A)).rejects.toThrow(NEGADO);
      await expect(controller.transferRequest('conv-a', { toUserId: 'u-b', reason: 'motivo' } as any, REQ_A)).rejects.toThrow(NEGADO);
      await expect(controller.transferToLawyer('conv-a', {} as any, REQ_A)).rejects.toThrow(SEM_DENTISTA);
      await expect(controller.assignLawyer('conv-a', 'u-b', REQ_A)).rejects.toThrow(NEGADO);
      expect(escritas()).toBe(0);
    });
  });

  it('cada rota repassa req.user.tenant_id ao service', async () => {
    await comConvA({ assigned_user_id: 'u-a', assigned_dentist_id: 'u-a2' }, async () => {
      const { controller, conversas } = montarController();
      const assign = jest.spyOn(conversas, 'assign');
      const requestTransfer = jest.spyOn(conversas, 'requestTransfer');
      const transferToAssignedLawyer = jest.spyOn(conversas, 'transferToAssignedLawyer');
      const setAssignedLawyer = jest.spyOn(conversas, 'setAssignedLawyer');
      await controller.transfer('conv-a', 'u-a2', REQ_A);
      await controller.transferRequest('conv-a', { toUserId: 'u-a2', reason: 'motivo' } as any, REQ_A);
      await controller.transferToLawyer('conv-a', { reason: 'ortodontia' } as any, REQ_A);
      await controller.assignLawyer('conv-a', 'u-a2', REQ_A);
      expect(assign).toHaveBeenCalledWith('conv-a', 'u-a2', 'a');
      expect(requestTransfer.mock.calls[0]).toEqual(['conv-a', 'u-a2', 'u-a', 'motivo', undefined, 'a']);
      expect(transferToAssignedLawyer).toHaveBeenCalledWith('conv-a', 'u-a', 'ortodontia', undefined, 'a');
      expect(setAssignedLawyer).toHaveBeenCalledWith('conv-a', 'u-a2', 'a');
    });
  });

  it('usuário da própria conta pelo controller → as mesmas gravações de hoje', async () => {
    await comConvA({ assigned_user_id: 'u-a', assigned_dentist_id: 'u-a2' }, async () => {
      const { controller, prisma, gateway } = montarController();
      await controller.transfer('conv-a', 'u-a2', REQ_A);
      await controller.transferRequest('conv-a', { toUserId: 'u-a2', reason: 'motivo' } as any, REQ_A);
      await controller.transferToLawyer('conv-a', { reason: 'ortodontia' } as any, REQ_A);
      await controller.assignLawyer('conv-a', 'u-a2', REQ_A);
      expect(prisma.conversation.update.mock.calls.map((c: any[]) => c[0].data)).toEqual([
        { assigned_user_id: 'u-a2', ai_mode: false, ai_mode_disabled_at: expect.any(Date), ai_mode_source: 'MANUAL' },
        { pending_transfer_to_id: 'u-a2', pending_transfer_from_id: 'u-a', pending_transfer_reason: 'motivo' },
        { origin_assigned_user_id: 'u-a' },
        { pending_transfer_to_id: 'u-a2', pending_transfer_from_id: 'u-a', pending_transfer_reason: 'ortodontia' },
        { assigned_dentist_id: 'u-a2' },
      ]);
      expect(gateway.emitTransferRequest.mock.calls.map((c: any[]) => c[0])).toEqual(['u-a2', 'u-a2']);
    });
  });

  it('SUPER_ADMIN (sem conta) pelo controller → passa como hoje', async () => {
    const { controller, prisma } = montarController();
    await controller.transfer('conv-b', 'u-a', { user: { id: 'root', tenant_id: undefined } });
    await controller.assignLawyer('conv-b', 'u-a', { user: { id: 'root', tenant_id: undefined } });
    expect(prisma.conversation.update.mock.calls.map((c: any[]) => c[0].data)).toEqual([
      { assigned_user_id: 'u-a', ai_mode: false, ai_mode_disabled_at: expect.any(Date), ai_mode_source: 'MANUAL' },
      { assigned_dentist_id: 'u-a' },
    ]);
  });
});

describe('MessagesService — conversa e mensagem só da própria conta', () => {
  const arquivo: any = { buffer: Buffer.from('x'), mimetype: 'audio/ogg', size: 1, originalname: 'a.ogg' };

  it('conversa de outra conta e legado sem conta → 403 sem ler, gravar nem enviar', async () => {
    for (const id of ['conv-b', 'conv-0']) {
      const { mensagens, prisma, escritas } = montar();
      await expect(mensagens.getMessages(id, 1, 100, 'a')).rejects.toThrow(NEGADO);
      await expect(mensagens.sendMessage(id, 'oi', undefined, 'u-a', false, 'a')).rejects.toThrow(NEGADO);
      await expect(mensagens.sendMessage(id, 'nota', undefined, 'u-a', true, 'a')).rejects.toThrow(NEGADO);
      await expect(mensagens.sendAudio(id, arquivo, 'u-a', 'a')).rejects.toThrow(NEGADO);
      await expect(mensagens.sendFile(id, { ...arquivo, mimetype: 'application/pdf' }, 'doc', 'u-a', 'a')).rejects.toThrow(NEGADO);
      await expect(mensagens.syncHistoryFromWhatsApp(id, 'a')).rejects.toThrow(NEGADO);
      expect(prisma.message.findMany).not.toHaveBeenCalled();
      expect(escritas()).toBe(0);
    }
  });

  it('mensagem de outra conta e de legado sem conta → 403 ao editar, apagar e reagir', async () => {
    for (const id of ['msg-b', 'msg-0']) {
      const { mensagens, escritas } = montar();
      await expect(mensagens.editMessage(id, 'novo', 'a')).rejects.toThrow(NEGADO);
      await expect(mensagens.deleteMessage(id, 'a')).rejects.toThrow(NEGADO);
      await expect(mensagens.reactToMessage(id, '+1', 'u-a', 'a')).rejects.toThrow(NEGADO);
      expect(escritas()).toBe(0);
    }
  });

  it('getMessages da própria conta: mesma consulta de hoje', async () => {
    const { mensagens, prisma } = montar();
    await mensagens.getMessages('conv-a', 1, 100, 'a');
    expect(prisma.conversation.findUnique.mock.calls).toEqual([[{ where: { id: 'conv-a' }, select: { tenant_id: true } }]]);
    expect(prisma.message.findMany).toHaveBeenCalledWith({
      where: { conversation_id: 'conv-a' },
      orderBy: { created_at: 'desc' },
      skip: 0,
      take: 100,
      include: { media: true, reactions: true, skill: { select: { id: true, name: true, area: true } } },
    });
  });

  it('conversa sem conta gravada com contato da conta → envia como hoje', async () => {
    const { mensagens, whatsapp } = montar();
    await mensagens.sendMessage('conv-0a', 'oi', undefined, 'u-a', false, 'a');
    expect(whatsapp.sendText).toHaveBeenCalledWith('558290000001', '*Ana:* oi', 'chip-a', undefined);
  });

  it('mensagem de conversa sem conta gravada com contato da conta → editar, apagar e reagir como hoje', async () => {
    const { mensagens, prisma, whatsapp, gateway } = montar();
    await mensagens.editMessage('msg-0a-out', 'novo', 'a');
    await mensagens.deleteMessage('msg-0a', 'a');
    await mensagens.reactToMessage('msg-0a', '+1', 'u-a', 'a');

    expect(prisma.message.update.mock.calls.map((c: any[]) => c[0])).toEqual([
      { where: { id: 'msg-0a-out' }, data: { text: 'novo' } },
      { where: { id: 'msg-0a' }, data: { type: 'deleted', text: null } },
    ]);
    expect(whatsapp.editMessage).toHaveBeenCalledWith('chip-a', '558290000001', 'ext-0a-out', 'novo');
    expect(whatsapp.deleteForEveryone).toHaveBeenCalledWith('chip-a', '558290000001@s.whatsapp.net', 'ext-0a', false);
    expect(whatsapp.sendReaction).toHaveBeenCalledWith(
      'chip-a',
      { remoteJid: '558290000001@s.whatsapp.net', fromMe: false, id: 'ext-0a' },
      '+1',
    );
    expect(prisma.messageReaction.upsert).toHaveBeenCalledWith({
      where: { message_id_user_id: { message_id: 'msg-0a', user_id: 'u-a' } },
      update: { emoji: '+1' },
      create: { message_id: 'msg-0a', user_id: 'u-a', emoji: '+1' },
    });
    expect(gateway.emitMessageUpdate.mock.calls.map((c: any[]) => c[0])).toEqual(['conv-0a', 'conv-0a']);
    expect(gateway.emitMessageReaction).toHaveBeenCalledWith('conv-0a', { messageId: 'msg-0a', reactions: [] });
  });

  it('editar mensagem da própria conta: mesma gravação de hoje; SUPER_ADMIN passa', async () => {
    const { mensagens, prisma } = montar();
    await mensagens.editMessage('msg-a', 'novo', 'a');
    await mensagens.editMessage('msg-b', 'outro', undefined);
    expect(prisma.message.update.mock.calls.map((c: any[]) => c[0])).toEqual([
      { where: { id: 'msg-a' }, data: { text: 'novo' } },
      { where: { id: 'msg-b' }, data: { text: 'outro' } },
    ]);
  });

  it('citação de mensagem de outra conta ou de legado sem conta → 403 antes de reatribuir, gravar ou enviar', async () => {
    for (const reply of ['msg-b', 'msg-0']) {
      const { mensagens, escritas } = montar();
      await expect(mensagens.sendMessage('conv-a', 'oi', reply, 'u-a', false, 'a')).rejects.toThrow(NEGADO);
      await expect(mensagens.sendMessage('conv-a', 'nota', reply, 'u-a', true, 'a')).rejects.toThrow(NEGADO);
      expect(escritas()).toBe(0);
    }
  });

  it('citação da própria conta → mesmo envio e mesma gravação de hoje (uma leitura da citada)', async () => {
    const { mensagens, prisma, whatsapp } = montar();
    await mensagens.sendMessage('conv-a', 'oi', 'msg-a', 'u-a', false, 'a');
    expect(prisma.message.findUnique.mock.calls).toEqual([[{ where: { id: 'msg-a' } }]]);
    expect(whatsapp.sendText).toHaveBeenCalledWith('558290000001', '*Ana:* oi', 'chip-a', {
      key: { remoteJid: '558290000001@s.whatsapp.net', fromMe: true, id: 'ext-a' },
      message: { conversation: 'oi a' },
    });
    expect(prisma.message.create).toHaveBeenCalledWith({
      data: {
        conversation_id: 'conv-a', direction: 'out', type: 'text', text: 'oi',
        external_message_id: 'ext-novo', status: 'enviado', reply_to_id: 'msg-a', reply_to_text: 'oi a',
      },
    });
  });

  it('citação de outra conversa da mesma conta (contato da conta) → aceita', async () => {
    const { mensagens, whatsapp } = montar();
    await mensagens.sendMessage('conv-a', 'oi', 'msg-0a', 'u-a', false, 'a');
    expect(whatsapp.sendText).toHaveBeenCalledWith('558290000001', '*Ana:* oi', 'chip-a', expect.objectContaining({ key: expect.objectContaining({ id: 'ext-0a' }) }));
  });

  it('SUPER_ADMIN (sem conta) envia e cita como hoje', async () => {
    const { mensagens, whatsapp } = montar();
    await mensagens.sendMessage('conv-b', 'oi', 'msg-a', 'u-a', false, undefined);
    expect(whatsapp.sendText).toHaveBeenCalledWith('558290000002', '*Ana:* oi', 'chip-b', expect.objectContaining({ key: expect.objectContaining({ id: 'ext-a' }) }));
  });
});

describe('Recarregar mídia (POST /media/:messageId/retry) — só mensagem da própria conta', () => {
  it('mensagem de outra conta e de legado sem conta → not_found, sem baixar nem emitir', async () => {
    for (const id of ['msg-b', 'msg-0']) {
      const { midia, escritas } = montar();
      const baixar = jest.spyOn(midia, 'downloadAndStore').mockResolvedValue(true);
      await expect(midia.retryDownload(id, 'a')).resolves.toEqual({ ok: false, reason: 'not_found' });
      expect(baixar).not.toHaveBeenCalled();
      expect(escritas()).toBe(0);
    }
  });

  it('o controller responde o mesmo 404 de mensagem inexistente', async () => {
    const { midia, prisma } = montar();
    const controller = new MediaController(prisma, {} as any, {} as any, midia, {} as any);
    await expect(controller.retryMediaDownload('msg-b', { user: { tenant_id: 'a' } })).rejects.toThrow(
      new NotFoundException('Mensagem não encontrada'),
    );
  });

  it('mensagem da própria conta (e de conversa sem conta gravada com contato da conta) → como hoje', async () => {
    const { midia, gateway } = montar();
    await expect(midia.retryDownload('msg-a', 'a')).resolves.toEqual({ ok: true });
    expect(gateway.emitMessageUpdate).toHaveBeenCalledWith('conv-a', expect.objectContaining({ id: 'msg-a' }));
    const baixar = jest.spyOn(midia, 'downloadAndStore').mockResolvedValue(true);
    await expect(midia.retryDownload('msg-0a', 'a')).resolves.toEqual({ ok: true });
    expect(baixar).toHaveBeenCalledWith(expect.objectContaining({ messageId: 'msg-0a', instanceName: 'chip-a' }));
  });

  it('SUPER_ADMIN (sem conta) passa', async () => {
    const { midia } = montar();
    const baixar = jest.spyOn(midia, 'downloadAndStore').mockResolvedValue(true);
    await expect(midia.retryDownload('msg-b', undefined)).resolves.toEqual({ ok: true });
    expect(baixar).toHaveBeenCalledWith(expect.objectContaining({ messageId: 'msg-b', instanceName: 'chip-b' }));
  });
});

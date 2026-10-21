import { ChatGateway } from './chat.gateway';

// Out/2026 — quem não tem WhatsApp (dentista) não recebe aviso de mensagem nem
// entra nos rooms do setor, mesmo tendo sido recepção antes (inboxes/atribuição).
const USERS: Record<string, any> = {
  dent: { id: 'dent', roles: ['DENTIST'], sector: 'dentista', extra_grants: [], extra_revokes: [], inboxes: [{ id: 'I1' }] },
  recep: { id: 'recep', roles: ['OPERADOR'], sector: 'recepcao', extra_grants: [], extra_revokes: [], inboxes: [{ id: 'I1' }] },
  dentChat: { id: 'dentChat', roles: ['DENTIST'], sector: 'dentista', extra_grants: ['view_chat'], extra_revokes: [], inboxes: [] },
};

function setup() {
  const emitted: string[] = [];
  const prisma = {
    user: { findUnique: jest.fn(async ({ where }: any) => USERS[where.id] ?? null) },
    inbox: { findMany: jest.fn(async () => [{ id: 'I1' }, { id: 'I2' }]) },
  };
  const notifSettings = { getNotifFlags: jest.fn(async () => ({ skipSound: false, skipDesktop: false })) };
  const notifications = { isConversationMuted: jest.fn(async () => false), create: jest.fn(async () => ({})) };
  const push = { sendToUser: jest.fn(async () => undefined) };
  const gw = new ChatGateway(prisma as any, {} as any, notifSettings as any, notifications as any, push as any);
  gw.server = { to: (room: string) => ({ emit: (ev: string) => emitted.push(`${room} ${ev}`) }) } as any;
  return { gw, emitted, push, notifications };
}

describe('ChatGateway — aviso de mensagem só pra quem tem WhatsApp', () => {
  it('conversa atribuída a dentista: ele não recebe, cai no pool do setor', async () => {
    const { gw, emitted, push, notifications } = setup();
    await gw.emitIncomingMessageNotification('t1', 'I1', 'dent', { conversationId: 'c1', contactName: 'Ana' });
    expect(emitted).toEqual(['inbox:I1 incoming_message_notification']);
    expect(push.sendToUser).not.toHaveBeenCalled();
    expect(notifications.create).not.toHaveBeenCalled();
  });

  it('conversa atribuída à recepção: só ela recebe', async () => {
    const { gw, emitted, push } = setup();
    await gw.emitIncomingMessageNotification('t1', 'I1', 'recep', { conversationId: 'c1' });
    expect(emitted).toEqual(['user:recep incoming_message_notification']);
    expect(push.sendToUser).toHaveBeenCalledWith('recep', expect.anything());
  });

  it('cliente com dentista responsável sem WhatsApp: dentista não é avisado', async () => {
    const { gw, emitted } = setup();
    await gw.emitIncomingMessageNotification('t1', 'I1', 'recep', { conversationId: 'c1' }, 'dent', true);
    expect(emitted).toEqual(['user:recep incoming_message_notification']);
  });

  it('dentista com WhatsApp liberado (extra) continua sendo avisado', async () => {
    const { gw, emitted } = setup();
    await gw.emitIncomingMessageNotification('t1', 'I1', 'recep', { conversationId: 'c1' }, 'dentChat', true);
    expect(emitted).toEqual(['user:recep incoming_message_notification', 'user:dentChat incoming_message_notification']);
  });

  it('lead novo atribuído a dentista: vai pro pool, não pra ele', async () => {
    const { gw, emitted } = setup();
    await gw.emitNewLeadNotification('t1', 'dent', 'I1', { leadId: 'l1' });
    expect(emitted).toEqual(['inbox:I1 new_lead_notification']);
  });

  it('socket do dentista não entra nos inboxes nem no room de operadores', async () => {
    const { gw } = setup();
    const joined: string[] = [];
    await gw.autoJoinRooms('dent', 't1', { id: 's1', join: (r: string) => joined.push(r) } as any);
    expect(joined).toEqual([]);
    const joinedRecep: string[] = [];
    await gw.autoJoinRooms('recep', 't1', { id: 's2', join: (r: string) => joinedRecep.push(r) } as any);
    expect(joinedRecep).toEqual(['inbox:I1', 'operators:t1']);
  });
});

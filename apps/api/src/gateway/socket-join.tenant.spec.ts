/**
 * F0b — a sala de conversa ao vivo e a presença ficam na clínica.
 *
 * Antes: o ADM de qualquer clínica entrava na sala de qualquer conversa (e até
 * em salas que não são conversa, como "tenant:<outra>"), via mensagens e o
 * "digitando" de outra clínica; o "fulano está online" ia para todas as
 * clínicas; e o aviso sem tenant caía numa clínica qualquer (findFirst sem ordem).
 */
import { ChatGateway } from './chat.gateway';

const CONVS: Record<string, any> = {
  'conv-a': { inbox_id: 'in-a', assigned_user_id: null, assigned_dentist_id: null, tenant_id: 'a' },
  'conv-b': { inbox_id: 'in-b', assigned_user_id: null, assigned_dentist_id: null, tenant_id: 'b' },
  'conv-0': { inbox_id: null, assigned_user_id: null, assigned_dentist_id: null, tenant_id: null },
};

function setup() {
  const emitted: string[] = [];
  const prisma: any = {
    conversation: { findUnique: jest.fn(async ({ where }: any) => CONVS[where.id] ?? null) },
    user: { findUnique: jest.fn(async () => ({ inboxes: [] })) },
    tenant: { findFirst: jest.fn(async () => ({ id: 'mais-antiga' })) },
  };
  const gw = new ChatGateway(prisma, {} as any, {} as any, {} as any, {} as any);
  gw.server = {
    to: (room: string) => ({ emit: (ev: string) => emitted.push(`${room} ${ev}`) }),
    emit: (ev: string) => emitted.push(`GLOBAL ${ev}`),
  } as any;
  (gw as any).assignPendingConversations = jest.fn(async () => undefined);
  return { gw, emitted, prisma };
}

function socket(user: { sub: string; tenant_id: string | null; roles: string[] }, id = 'sock-1') {
  const rooms = new Set<string>();
  return {
    id,
    data: { user },
    conn: { transport: { name: 'websocket' }, on: () => undefined },
    join: (r: string) => rooms.add(r),
    rooms,
  } as any;
}

describe('join_conversation — ADMIN só na própria clínica', () => {
  it('ADMIN da clínica A entra nas conversas da A', async () => {
    const { gw } = setup();
    const s = socket({ sub: 'adm-a', tenant_id: 'a', roles: ['ADMIN'] });
    await gw.handleJoinConversation('conv-a', s);
    expect([...s.rooms]).toEqual(['conv-a']);
  });

  it('ADMIN da clínica A NÃO entra em conversa da B, de legado sem clínica, nem em sala que não é conversa', async () => {
    const { gw } = setup();
    const s = socket({ sub: 'adm-a', tenant_id: 'a', roles: ['ADMIN'] });
    await gw.handleJoinConversation('conv-b', s);
    await gw.handleJoinConversation('conv-0', s);
    await gw.handleJoinConversation('tenant:b', s);
    expect([...s.rooms]).toEqual([]);
  });

  it('SUPER_ADMIN entra em qualquer uma', async () => {
    const { gw } = setup();
    const s = socket({ sub: 'root', tenant_id: null, roles: ['SUPER_ADMIN'] });
    await gw.handleJoinConversation('conv-b', s);
    expect([...s.rooms]).toEqual(['conv-b']);
  });
});

describe('user_presence — só para a clínica da pessoa', () => {
  it('online/offline vão para tenant:<clínica>, nunca para todas', () => {
    const { gw, emitted } = setup();
    const a = socket({ sub: 'u-a', tenant_id: 'a', roles: ['OPERADOR'] }, 's-a');
    const b = socket({ sub: 'u-b', tenant_id: 'b', roles: ['OPERADOR'] }, 's-b');
    gw.handleConnection(a);
    gw.handleConnection(b);
    gw.handleDisconnect(a);
    expect(emitted).toEqual([
      'tenant:a user_presence',
      'tenant:b user_presence',
      'tenant:a user_presence',
    ]);
    // a contagem de online (usada no round-robin e no painel) segue certa
    expect(gw.getOnlineUserIds()).toEqual(['u-b']);
    expect(gw.isUserOnline('u-a')).toBe(false);
  });
});

describe('evento sem tenant → clínica padrão determinística', () => {
  it('inboxUpdate e aviso sem tenant usam a clínica mais antiga (findFirst ordenado)', async () => {
    const { gw, emitted, prisma } = setup();
    gw.emitConversationsUpdate(null, true);
    await new Promise((r) => setImmediate(r));
    expect(prisma.tenant.findFirst).toHaveBeenCalledWith({ orderBy: { created_at: 'asc' }, select: { id: true } });
    expect(emitted).toEqual(['tenant:mais-antiga inboxUpdate']);
  });
});

import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { canUseChannel, dmChannel, parseChannel } from './team-chat-channels';
import { TeamChatService } from './team-chat.service';

jest.mock('../auth/patient-scope', () => ({
  // 'dent' só vê a própria carteira; o resto vê todos.
  restrictedPatientOwner: jest.fn(async (_p: unknown, u: { id: string }) => (u.id === 'dent-0001' ? u.id : null)),
  isOwnPatient: jest.fn(async (_p: unknown, _t: string, _u: string, patientId: string) => patientId === 'pac-dele'),
}));

const A = 'aaaa-0001';
const B = 'bbbb-0001';
const ADM = 'admn-0001';
const DENT = 'dent-0001';
const FORA = 'fora-0001';

// Filtro Prisma em memória — só o que o serviço usa.
function casa(row: any, where: any): boolean {
  if (!where) return true;
  return Object.entries(where).every(([k, cond]: [string, any]) => {
    if (k === 'OR') return (cond as any[]).some((w) => casa(row, w));
    if (k === 'AND') return (cond as any[]).every((w) => casa(row, w));
    const v = row[k];
    if (cond && typeof cond === 'object' && !(cond instanceof Date)) {
      if ('not' in cond && v === cond.not) return false;
      if ('in' in cond && !cond.in.includes(v)) return false;
      if ('notIn' in cond && cond.notIn.includes(v)) return false;
      if ('startsWith' in cond && !String(v).startsWith(cond.startsWith)) return false;
      if ('endsWith' in cond && !String(v).endsWith(cond.endsWith)) return false;
      if ('gt' in cond && !(v > cond.gt)) return false;
      if ('lt' in cond && !(v < cond.lt)) return false;
      return true;
    }
    return v === cond;
  });
}

function setup() {
  const users = [
    { id: A, name: 'Ana', sector: 'recepcao', roles: ['OPERADOR'], tenant_id: 't1' },
    { id: B, name: 'Bia', sector: 'financeiro', roles: ['FINANCEIRO'], tenant_id: 't1' },
    { id: ADM, name: 'Dono', sector: 'admin', roles: ['ADMIN'], tenant_id: 't1' },
    { id: DENT, name: 'Dra. Carla', sector: 'dentista', roles: ['DENTIST'], tenant_id: 't1' },
    { id: FORA, name: 'Outra clínica', sector: 'recepcao', roles: ['OPERADOR'], tenant_id: 't2' },
  ];
  const messages: any[] = [];
  const reads: any[] = [];
  let seq = 0;
  const prisma = {
    user: {
      findMany: jest.fn(async ({ where }: any) => users.filter((u) => casa(u, where))),
      findFirst: jest.fn(async ({ where }: any) => users.find((u) => casa(u, where)) ?? null),
      findUnique: jest.fn(async ({ where }: any) => users.find((u) => u.id === where.id) ?? null),
    },
    patient: {
      findFirst: jest.fn(async ({ where }: any) =>
        ['pac-dele', 'pac-outro'].includes(where.id) && where.tenant_id === 't1' ? { id: where.id, name: 'Paciente ' + where.id } : null,
      ),
    },
    teamMessage: {
      create: jest.fn(async ({ data }: any) => {
        jest.advanceTimersByTime(1000); // cada mensagem 1s depois da anterior
        const row = { id: `m${++seq}`, created_at: new Date(), ...data };
        messages.push(row);
        return row;
      }),
      findMany: jest.fn(async ({ where, take }: any) =>
        messages.filter((m) => casa(m, where)).sort((x, y) => +y.created_at - +x.created_at).slice(0, take),
      ),
      groupBy: jest.fn(async ({ where, _count, _max }: any) => {
        const by = new Map<string, any[]>();
        for (const m of messages.filter((r) => casa(r, where))) by.set(m.channel, [...(by.get(m.channel) ?? []), m]);
        return [...by.entries()].map(([channel, rows]) => ({
          channel,
          ...(_count ? { _count: { _all: rows.length } } : {}),
          ...(_max ? { _max: { created_at: rows.reduce((a, r) => (r.created_at > a ? r.created_at : a), rows[0].created_at) } } : {}),
        }));
      }),
    },
    teamChannelRead: {
      findMany: jest.fn(async ({ where }: any) => reads.filter((r) => casa(r, where))),
      upsert: jest.fn(async ({ where, create, update }: any) => {
        const k = where.user_id_channel;
        const found = reads.find((r) => r.user_id === k.user_id && r.channel === k.channel);
        if (found) Object.assign(found, update);
        else reads.push({ ...create });
        return found ?? create;
      }),
    },
  };
  const emitted: Array<{ rooms: string[]; msg: any }> = [];
  const gateway = {
    isUserOnline: jest.fn((id: string) => id === B),
    emitTeamMessage: jest.fn((tenantId: string, msg: any, dm?: string[]) =>
      emitted.push({ rooms: dm ? dm.map((u) => `user:${u}`) : [`tenant:${tenantId}`], msg }),
    ),
  };
  const svc = new TeamChatService(prisma as any, gateway as any);
  return { svc, emitted, messages, reads };
}

describe('canais da conversa da equipe', () => {
  it('aceita Geral, os setores e dm em ordem; recusa o resto', () => {
    expect(parseChannel('geral')?.kind).toBe('geral');
    expect(parseChannel('financeiro')?.kind).toBe('setor');
    expect(parseChannel(dmChannel(B, A))).toEqual({ kind: 'dm', id: `dm:${A}:${B}`, users: [A, B] });
    expect(parseChannel(`dm:${B}:${A}`)).toBeNull(); // fora de ordem
    expect(parseChannel(`dm:${A}:${A}`)).toBeNull(); // consigo mesmo
    expect(parseChannel('juridico')).toBeNull();
    expect(parseChannel(undefined)).toBeNull();
  });

  it('dm só pros dois — nem o admin', () => {
    const dm = parseChannel(dmChannel(A, B))!;
    expect(canUseChannel(dm, A)).toBe(true);
    expect(canUseChannel(dm, B)).toBe(true);
    expect(canUseChannel(dm, ADM)).toBe(false);
    expect(canUseChannel(parseChannel('financeiro')!, A)).toBe(true);
  });
});

describe('TeamChatService', () => {
  beforeEach(() => jest.useFakeTimers({ now: new Date('2026-10-22T12:00:00Z') }));
  afterEach(() => jest.useRealTimers());

  it('canal de setor vai pra clínica toda; dm só pros dois', async () => {
    const { svc, emitted } = setup();
    await svc.send('t1', A, { channel: 'financeiro', text: ' Oi, financeiro ' });
    await svc.send('t1', A, { channel: dmChannel(A, B), text: 'Particular' });
    expect(emitted[0].rooms).toEqual(['tenant:t1']);
    expect(emitted[0].msg).toMatchObject({ text: 'Oi, financeiro', sender_name: 'Ana', sender_sector: 'recepcao' });
    expect(emitted[1].rooms).toEqual([`user:${A}`, `user:${B}`]);
  });

  it('admin não lê a conversa direta dos outros', async () => {
    const { svc } = setup();
    await svc.send('t1', A, { channel: dmChannel(A, B), text: 'Particular' });
    await expect(svc.messages('t1', ADM, dmChannel(A, B))).rejects.toBeInstanceOf(ForbiddenException);
    await expect(svc.read('t1', ADM, dmChannel(A, B))).rejects.toBeInstanceOf(ForbiddenException);
    await expect(svc.send('t1', ADM, { channel: dmChannel(A, B), text: 'x' })).rejects.toBeInstanceOf(ForbiddenException);
    expect((await svc.messages('t1', B, dmChannel(A, B))).messages.map((m) => m.text)).toEqual(['Particular']);
  });

  it('não abre dm com gente de outra clínica nem lê mensagens de outra clínica', async () => {
    const { svc } = setup();
    await expect(svc.send('t1', A, { channel: dmChannel(A, FORA), text: 'oi' })).rejects.toBeInstanceOf(NotFoundException);
    await svc.send('t2', FORA, { channel: 'geral', text: 'de lá' });
    expect((await svc.messages('t1', A, 'geral')).messages).toEqual([]);
  });

  it('mensagem vazia e canal inválido dão 400', async () => {
    const { svc } = setup();
    await expect(svc.send('t1', A, { channel: 'geral', text: '   ' })).rejects.toBeInstanceOf(BadRequestException);
    await expect(svc.send('t1', A, { channel: 'juridico', text: 'oi' })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('não lidas: Geral + canal do próprio setor + dm; zera ao abrir; o que eu mando não conta', async () => {
    const { svc } = setup();
    await svc.send('t1', B, { channel: 'geral', text: '1' });
    await svc.send('t1', B, { channel: 'recepcao', text: '2' }); // setor da Ana
    await svc.send('t1', B, { channel: 'financeiro', text: '3' }); // Ana não acompanha
    await svc.send('t1', B, { channel: dmChannel(A, B), text: '4' });
    await svc.send('t1', A, { channel: 'geral', text: 'minha' });

    let ov = await svc.overview('t1', A);
    const por = (o: typeof ov) => Object.fromEntries(o.channels.map((c) => [c.id, c.unread]));
    // Ana mandou no Geral depois da Bia → leu o Geral.
    expect(por(ov)).toMatchObject({ geral: 0, recepcao: 1, financeiro: 0 });
    expect(ov.people.find((p) => p.id === B)).toMatchObject({ unread: 1, online: true, sector: 'financeiro' });
    expect(ov.people.some((p) => p.id === FORA || p.id === A)).toBe(false);
    expect(ov.total_unread).toBe(2);
    expect(ov.me).toEqual({ id: A, sector: 'recepcao' });

    await svc.read('t1', A, 'recepcao');
    await svc.read('t1', A, dmChannel(A, B));
    ov = await svc.overview('t1', A);
    expect(ov.total_unread).toBe(0);

    // Abriu o canal do Financeiro uma vez → passa a acompanhar.
    await svc.read('t1', A, 'financeiro');
    await svc.send('t1', B, { channel: 'financeiro', text: '5' });
    ov = await svc.overview('t1', A);
    expect(por(ov).financeiro).toBe(1);
    expect(ov.channels.find((c) => c.id === 'financeiro')?.following).toBe(true);
  });

  it('dentista participa e só anexa paciente da carteira dele', async () => {
    const { svc, emitted } = setup();
    await expect(svc.send('t1', DENT, { channel: 'recepcao', text: 'olha', patient_id: 'pac-outro' })).rejects.toBeInstanceOf(ForbiddenException);
    const msg = await svc.send('t1', DENT, { channel: 'recepcao', text: 'remarcar', patient_id: 'pac-dele' });
    expect(msg.patient).toEqual({ id: 'pac-dele', name: 'Paciente pac-dele' });
    expect(emitted).toHaveLength(1);
    // Recepção (vê todos) anexa qualquer paciente da clínica; de outra clínica não.
    await expect(svc.send('t1', A, { channel: 'geral', patient_id: 'pac-outro' })).resolves.toMatchObject({ text: '' });
    await expect(svc.send('t1', A, { channel: 'geral', patient_id: 'nao-existe' })).rejects.toBeInstanceOf(NotFoundException);
  });
});

import { AiProcessor } from './ai.processor';

/**
 * Atualizações da IA só dentro da conta da conversa:
 *  - a TAREFA automática (stage AGUARDANDO_*) nasce com a conta da conversa;
 *    conversa sem conta gravada usa a do contato (mesma resolução do book_appointment);
 *  - o especialista pré-atribuído é escolhido só entre os usuários da conta, e a
 *    ocupação conta só as conversas abertas dessa conta;
 *  - sem conta conhecida (nem na conversa nem no contato), ninguém é atribuído.
 *
 * Repositório público: ids fictícios.
 */

/** Devolve só os campos pedidos no `select` (relações com select aninhado). */
function pick(obj: any, select: any): any {
  if (!obj) return null;
  if (!select) return { ...obj };
  const out: any = {};
  for (const [k, v] of Object.entries(select)) {
    if (!v) continue;
    out[k] = v === true ? obj[k] : pick(obj[k], (v as any).select);
  }
  return out;
}

type Cenario = {
  conversa: { tenant_id: string | null; assigned_dentist_id?: string | null; specialty?: string | null };
  contato: { tenant_id: string | null };
  usuarios?: { id: string; tenant_id: string | null; specialties: string[] }[];
  /** Conversas abertas já atribuídas (para a ocupação). */
  abertas?: { assigned_dentist_id: string; tenant_id: string | null }[];
};

function montar(c: Cenario) {
  const lead = { id: 'lead-1', name: 'Fulano', is_client: false, ...c.contato };
  const conversa = { id: 'conv-1', assigned_dentist_id: null, specialty: null, ...c.conversa, lead };
  const usuarios = c.usuarios ?? [];
  const abertas = c.abertas ?? [];

  const prisma: any = {
    lead: {
      findUnique: jest.fn(async ({ select }: any) => pick(lead, select)),
      update: jest.fn(async () => ({})),
    },
    conversation: {
      findUnique: jest.fn(async ({ select }: any) => pick(conversa, select)),
      update: jest.fn(async () => ({})),
      count: jest.fn(async ({ where }: any) =>
        abertas.filter(
          (a) =>
            a.assigned_dentist_id === where.assigned_dentist_id &&
            where.status === 'ABERTO' &&
            (!('tenant_id' in where) || a.tenant_id === where.tenant_id),
        ).length,
      ),
    },
    user: {
      findMany: jest.fn(async ({ where, select }: any) =>
        usuarios
          .filter((u) => u.specialties.length > 0 && (!('tenant_id' in where) || u.tenant_id === where.tenant_id))
          .map((u) => pick(u, select)),
      ),
    },
    calendarEvent: {
      findMany: jest.fn(async () => []),
      create: jest.fn(async ({ data }: any) => ({
        id: 'ev-1',
        start_at: data.start_at,
        reminders: data.reminders.create.map((r: any, i: number) => ({ id: `r${i}`, ...r })),
      })),
    },
  };
  // Sem o construtor (DI do Nest): só o que o método usa.
  const proc: any = Object.create(AiProcessor.prototype);
  proc.prisma = prisma;
  proc.reminderQueue = { add: jest.fn(async () => undefined) };
  proc.logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };

  const aplicar = (updates: any) => proc.applyAiUpdates(updates, 'conv-1', 'lead-1', '558290000001', 'chip-1');
  const dentistaGravado = () =>
    prisma.conversation.update.mock.calls
      .map((call: any[]) => call[0].data)
      .filter((d: any) => 'assigned_dentist_id' in d)
      .map((d: any) => d.assigned_dentist_id);

  return { prisma, proc, aplicar, dentistaGravado };
}

describe('AiProcessor — tarefa automática da IA nasce com a conta', () => {
  it('conversa da conta "a": a TAREFA é gravada com tenant_id "a"', async () => {
    const { prisma, aplicar } = montar({
      conversa: { tenant_id: 'a', assigned_dentist_id: 'dent-a' },
      contato: { tenant_id: 'a' },
    });
    await aplicar({ status: 'AGUARDANDO_DOCS' });

    expect(prisma.calendarEvent.create).toHaveBeenCalledTimes(1);
    expect(prisma.calendarEvent.create.mock.calls[0][0].data).toMatchObject({
      type: 'TAREFA',
      title: 'Cobrar documentos do lead — Fulano',
      assigned_user_id: 'dent-a',
      created_by_id: 'dent-a',
      lead_id: 'lead-1',
      conversation_id: 'conv-1',
      tenant_id: 'a',
    });
  });

  it('conversa sem conta gravada: a TAREFA usa a conta do contato', async () => {
    const { prisma, aplicar } = montar({
      conversa: { tenant_id: null, assigned_dentist_id: 'dent-a' },
      contato: { tenant_id: 'a' },
    });
    await aplicar({ next_step: 'procuracao' });

    expect(prisma.calendarEvent.create).toHaveBeenCalledTimes(1);
    expect(prisma.calendarEvent.create.mock.calls[0][0].data).toMatchObject({
      title: 'Cobrar procuração do lead — Fulano',
      tenant_id: 'a',
    });
  });

  it('sem conta na conversa nem no contato: a TAREFA sai como hoje, sem conta', async () => {
    const { prisma, aplicar } = montar({
      conversa: { tenant_id: null, assigned_dentist_id: 'dent-0' },
      contato: { tenant_id: null },
    });
    await aplicar({ status: 'AGUARDANDO_FORM' });

    expect(prisma.calendarEvent.create).toHaveBeenCalledTimes(1);
    expect(prisma.calendarEvent.create.mock.calls[0][0].data.tenant_id).toBeUndefined();
  });
});

describe('AiProcessor — especialista pré-atribuído só da conta da conversa', () => {
  const usuarios = [
    { id: 'orto-a', tenant_id: 'a', specialties: ['Ortodontia'] },
    { id: 'orto-a2', tenant_id: 'a', specialties: ['Ortodontia', 'Clínico Geral'] },
    { id: 'orto-b', tenant_id: 'b', specialties: ['Ortodontia'] },
    { id: 'orto-0', tenant_id: null, specialties: ['Ortodontia'] },
  ];

  it('escolhe o menos ocupado DA CONTA, mesmo com especialista menos ocupado em outra conta', async () => {
    const { prisma, aplicar, dentistaGravado } = montar({
      conversa: { tenant_id: 'a' },
      contato: { tenant_id: 'a' },
      usuarios,
      abertas: [
        { assigned_dentist_id: 'orto-a', tenant_id: 'a' },
        { assigned_dentist_id: 'orto-a', tenant_id: 'a' },
        { assigned_dentist_id: 'orto-a2', tenant_id: 'a' },
      ],
    });
    await aplicar({ area: 'Ortodontia' });

    expect(prisma.user.findMany).toHaveBeenCalledWith({
      where: { tenant_id: 'a', specialties: { isEmpty: false } },
      select: { id: true, specialties: true },
    });
    expect(dentistaGravado()).toEqual(['orto-a2']);
  });

  it('a ocupação conta só as conversas abertas da conta', async () => {
    const { prisma, aplicar, dentistaGravado } = montar({
      conversa: { tenant_id: 'a' },
      contato: { tenant_id: 'a' },
      usuarios,
      abertas: [
        // orto-a: 1 aberta na conta "a" (+ 3 registradas fora dela)
        { assigned_dentist_id: 'orto-a', tenant_id: 'a' },
        { assigned_dentist_id: 'orto-a', tenant_id: 'b' },
        { assigned_dentist_id: 'orto-a', tenant_id: 'b' },
        { assigned_dentist_id: 'orto-a', tenant_id: null },
        // orto-a2: 2 abertas na conta "a"
        { assigned_dentist_id: 'orto-a2', tenant_id: 'a' },
        { assigned_dentist_id: 'orto-a2', tenant_id: 'a' },
      ],
    });
    await aplicar({ area: 'ortodontia' });

    for (const [args] of prisma.conversation.count.mock.calls) {
      expect(args.where).toEqual({ assigned_dentist_id: expect.any(String), status: 'ABERTO', tenant_id: 'a' });
    }
    expect(dentistaGravado()).toEqual(['orto-a']);
  });

  it('conversa sem conta gravada: usa a conta do contato', async () => {
    const { prisma, aplicar, dentistaGravado } = montar({
      conversa: { tenant_id: null },
      contato: { tenant_id: 'b' },
      usuarios,
    });
    await aplicar({ area: 'Ortodontia' });

    expect(prisma.user.findMany.mock.calls[0][0].where).toEqual({ tenant_id: 'b', specialties: { isEmpty: false } });
    expect(dentistaGravado()).toEqual(['orto-b']);
  });

  it('sem conta conhecida: não procura nem grava especialista (a especialidade segue gravada)', async () => {
    const { prisma, aplicar, dentistaGravado } = montar({
      conversa: { tenant_id: null },
      contato: { tenant_id: null },
      usuarios,
    });
    await aplicar({ area: 'Ortodontia' });

    expect(prisma.user.findMany).not.toHaveBeenCalled();
    expect(prisma.conversation.count).not.toHaveBeenCalled();
    expect(dentistaGravado()).toEqual([]);
    expect(prisma.conversation.update).toHaveBeenCalledWith({ where: { id: 'conv-1' }, data: { specialty: 'Ortodontia' } });
  });

  it('nenhum especialista da área na conta: não grava ninguém', async () => {
    const { aplicar, dentistaGravado } = montar({
      conversa: { tenant_id: 'c' },
      contato: { tenant_id: 'c' },
      usuarios,
    });
    await aplicar({ area: 'Ortodontia' });

    expect(dentistaGravado()).toEqual([]);
  });
});

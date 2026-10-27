/**
 * Agenda — cada conta só lê, altera e liga dado DELA.
 *
 * Prisma mockado (registros com a conta de cada um). Três perguntas por rota:
 *  (a) id de outra conta, ou registro sem conta → recusado e nada gravado;
 *  (b) conta própria → as mesmas chamadas e os mesmos argumentos de hoje;
 *  (c) usuário sem conta (SUPER_ADMIN, tenant_id undefined) → como hoje.
 *
 * Evento antigo sem conta gravada pertence à conta de QUEM O CRIOU: a conta do
 * criador o vê e edita como hoje; para as outras contas ele não existe.
 */
import { BadRequestException, ForbiddenException, Logger, NotFoundException } from '@nestjs/common';
import { CalendarController } from './calendar.controller';
import { CalendarService } from './calendar.service';
import { contaDoEvento, eventoDaConta, eventosDaConta } from './conta-do-evento';

const A = 'conta-a';
const B = 'conta-b';

const LEADS: Record<string, string | null> = {
  'lead-a': A,
  'lead-a-ficha-b': A, // contato da A ligado (vínculo antigo) a paciente da B
  'lead-b': B,
  'lead-sem-conta': null,
};
const PACIENTES: Record<string, { tenant_id: string; lead_id: string | null }> = {
  'pac-a': { tenant_id: A, lead_id: 'lead-a' },
  'pac-b': { tenant_id: B, lead_id: 'lead-a-ficha-b' },
  'pac-a-contato-b': { tenant_id: A, lead_id: 'lead-b' },
  'pac-a-contato-sem-conta': { tenant_id: A, lead_id: 'lead-sem-conta' },
};
const CONVERSAS: Record<string, string | null> = { 'conv-a': A, 'conv-b': B, 'conv-sem-conta': null };
const USUARIOS: Record<string, string | null> = { 'user-a': A, 'user-b': B, 'user-sem-conta': null };
const TIPOS: Record<string, string | null> = { 'tipo-a': A, 'tipo-b': B, 'tipo-sem-conta': null };

const QUANDO = new Date('2026-10-27T14:00:00.000Z');
const evento = (id: string, tenant_id: string | null, extra: Record<string, any> = {}) => ({
  id,
  tenant_id,
  type: 'CONSULTA',
  status: 'AGENDADO',
  title: `Consulta ${id}`,
  description: null,
  location: null,
  start_at: QUANDO,
  end_at: null,
  created_at: QUANDO,
  updated_at: QUANDO,
  created_by_id: 'user-a',
  assigned_user_id: 'user-a',
  validated_at: null,
  validated_by_user_id: null,
  validation_notes: null,
  lead_id: 'lead-a',
  patient_id: 'pac-a',
  conversation_id: null,
  appointment_type_id: null,
  ...extra,
});
const DA_B = { created_by_id: 'user-b', assigned_user_id: 'user-b', lead_id: 'lead-b', patient_id: 'pac-b' };
const EVENTOS: Record<string, any> = {
  'ev-a': evento('ev-a', A),
  // Evento da A com vínculos antigos (contato sem conta, profissional da B).
  'ev-a-legado': evento('ev-a-legado', A, { lead_id: 'lead-sem-conta', assigned_user_id: 'user-b', appointment_type_id: 'tipo-b' }),
  'ev-b': evento('ev-b', B, DA_B),
  // Eventos antigos sem conta gravada: vale a conta de quem criou.
  'ev-sem-conta-da-a': evento('ev-sem-conta-da-a', null),
  'ev-sem-conta-da-a-validado': evento('ev-sem-conta-da-a-validado', null, { validated_at: QUANDO, validated_by_user_id: 'user-a' }),
  'ev-sem-conta-da-b': evento('ev-sem-conta-da-b', null, DA_B),
  'ev-sem-conta-sem-dono': evento('ev-sem-conta-sem-dono', null, { created_by_id: 'user-sem-conta', assigned_user_id: null, lead_id: null, patient_id: null }),
  // Criado por usuário sem conta (SUPER_ADMIN): vale a conta do contato e, sem contato, a do paciente.
  'ev-admin-contato-a': evento('ev-admin-contato-a', null, { created_by_id: 'user-sem-conta', patient_id: null }),
  'ev-admin-paciente-a': evento('ev-admin-paciente-a', null, { created_by_id: 'user-sem-conta', lead_id: null }),
  'ev-admin-contato-b': evento('ev-admin-contato-b', null, { created_by_id: 'user-sem-conta', lead_id: 'lead-b', patient_id: null }),
};
/** Eventos que a conta A não enxerga: da B, sem conta criado pela B, sem conta criado por usuário sem conta. */
const FORA_DA_A = ['ev-b', 'ev-sem-conta-da-b', 'ev-sem-conta-sem-dono', 'ev-admin-contato-b'];
const DA_A = ['ev-a', 'ev-a-legado', 'ev-sem-conta-da-a', 'ev-sem-conta-da-a-validado', 'ev-admin-contato-a', 'ev-admin-paciente-a'];
/** O where de "eventos da conta A", como o Prisma recebe. */
const EVENTOS_DA_A = {
  OR: [
    { tenant_id: A },
    { tenant_id: null, created_by: { tenant_id: A } },
    { tenant_id: null, created_by: { tenant_id: null }, lead: { tenant_id: A } },
    { tenant_id: null, created_by: { tenant_id: null }, lead_id: null, patient: { tenant_id: A } },
    { tenant_id: null, created_by: { tenant_id: null }, lead: { tenant_id: null }, patient: { tenant_id: A } },
  ],
};

const contaPorId = (mapa: Record<string, string | null>) =>
  jest.fn(async ({ where }: any) => (where.id in mapa ? { tenant_id: mapa[where.id] } : null));

/** Lê o evento como o Prisma: com `select`, só os campos pedidos (e a conta de quem criou, se pedida). */
const lerEvento = (e: any, args: any) => {
  if (!e) return null;
  if (!args?.select) return { ...e };
  const r: any = {};
  for (const [k, v] of Object.entries<any>(args.select)) {
    if (k === 'created_by') {
      if (v?.select?.tenant_id) r.created_by = { tenant_id: USUARIOS[e.created_by_id] ?? null };
    } else if (k === 'lead' && v?.select?.tenant_id) {
      r.lead = e.lead_id ? { tenant_id: LEADS[e.lead_id] ?? null } : null;
    } else if (k === 'patient' && v?.select?.tenant_id) {
      r.patient = e.patient_id ? { tenant_id: PACIENTES[e.patient_id]?.tenant_id ?? null } : null;
    } else if (v === true) r[k] = e[k];
  }
  return r;
};

/** Filtro do findMany: só as cláusulas de conta e de id contam (o resto do where é indiferente aqui). */
const casa = (e: any, w: any): boolean =>
  !w ||
  Object.entries<any>(w).every(([k, v]) => {
    if (k === 'OR') return v.some((c: any) => casa(e, c));
    if (k === 'AND') return v.every((c: any) => casa(e, c));
    if (k === 'id') return v?.in ? v.in.includes(e.id) : typeof v === 'string' ? v === e.id : true;
    if (k === 'tenant_id') return e.tenant_id === v;
    if (k === 'created_by') return (USUARIOS[e.created_by_id] ?? null) === v.tenant_id;
    // Relação opcional no Prisma: o filtro exige o registro ligado.
    if (k === 'lead') return !!e.lead_id && (LEADS[e.lead_id] ?? null) === v.tenant_id;
    if (k === 'lead_id') return v === null ? !e.lead_id : e.lead_id === v;
    if (k === 'patient') return !!e.patient_id && (PACIENTES[e.patient_id]?.tenant_id ?? null) === v.tenant_id;
    return true;
  });

const TURNO = { day_of_week: 3, start_time: '08:00', end_time: '09:00', lunch_start: null, lunch_end: null, label: null, sort_order: 0 };

function montar() {
  const prisma: any = {
    lead: { findUnique: contaPorId(LEADS) },
    conversation: { findUnique: contaPorId(CONVERSAS) },
    user: { findUnique: contaPorId(USUARIOS) },
    appointmentType: { findUnique: contaPorId(TIPOS) },
    patient: {
      findUnique: jest.fn(async ({ where }: any) => {
        const id = where.id ?? Object.keys(PACIENTES).find((k) => PACIENTES[k].lead_id === where.lead_id);
        const p = id ? PACIENTES[id] : undefined;
        if (!p) return null;
        return { id, ...p, lead: p.lead_id ? { tenant_id: LEADS[p.lead_id] } : null };
      }),
    },
    calendarEvent: {
      findUnique: jest.fn(async (args: any) => lerEvento(EVENTOS[args.where.id], args)),
      findMany: jest.fn(async ({ where }: any) => Object.values(EVENTOS).filter((e: any) => casa(e, where))),
      create: jest.fn(async ({ data }: any) => ({ id: 'novo', ...data, reminders: [], lead: null, assigned_user: null })),
      update: jest.fn(async () => ({})),
      updateMany: jest.fn(async () => ({ count: 1 })),
      delete: jest.fn(async () => ({})),
      deleteMany: jest.fn(async () => ({ count: 0 })),
    },
    userSchedule: {
      findMany: jest.fn(async ({ where }: any) =>
        where.user_id === 'user-a' && (where.day_of_week === undefined || where.day_of_week === TURNO.day_of_week) ? [TURNO] : [],
      ),
      deleteMany: jest.fn(async () => ({ count: 1 })),
      createMany: jest.fn(async () => ({ count: 1 })),
    },
    scheduleBlock: { create: jest.fn(async ({ data }: any) => ({ id: 'bloqueio', ...data })) },
    holiday: { findFirst: jest.fn(async () => null) },
    $queryRaw: jest.fn(async () => []),
    globalSetting: { findUnique: jest.fn(async () => null) },
    tenantBusinessProfile: { findMany: jest.fn(async () => []) },
    auditLog: { create: jest.fn(async () => ({})) },
  };
  prisma.$transaction = jest.fn(async (fn: any) => fn(prisma));
  const chatGateway: any = { emitCalendarUpdate: jest.fn() };
  const fila: any = { add: jest.fn(), getJob: jest.fn(async () => null) };
  const waitlist: any = { notifySlotOpened: jest.fn(async () => ({ notified: 0 })) };
  const svc = new CalendarService(prisma, chatGateway, fila, waitlist, {} as any, {} as any, { get: () => undefined } as any);
  const controller = new CalendarController(svc);
  return { prisma, svc, controller };
}

const usuario = (tenant_id: string | undefined, roles: string[] = ['ADMIN']) => ({
  user: { id: tenant_id === B ? 'user-b' : 'user-a', tenant_id, roles },
});
const daA = usuario(A);
const daB = usuario(B);
const superAdmin = usuario(undefined, ['SUPER_ADMIN', 'ADMIN']);

/** Leituras de conta feitas pela checagem dos ids do corpo. */
const leiturasDeConta = (prisma: any) =>
  ['lead', 'patient', 'conversation', 'user', 'appointmentType'].reduce(
    (n, m) => n + prisma[m].findUnique.mock.calls.length,
    0,
  );
const nenhumaEscrita = (prisma: any) => {
  for (const m of ['create', 'update', 'updateMany', 'delete', 'deleteMany']) {
    expect(prisma.calendarEvent[m]).not.toHaveBeenCalled();
  }
  expect(prisma.$transaction).not.toHaveBeenCalled();
};
const SELECT_CONTA = {
  tenant_id: true,
  created_by: { select: { tenant_id: true } },
  lead: { select: { tenant_id: true } },
  patient: { select: { tenant_id: true } },
};

beforeEach(() => {
  for (const nivel of ['log', 'warn', 'error', 'debug'] as const) {
    jest.spyOn(Logger.prototype, nivel).mockImplementation(() => undefined);
  }
});
afterEach(() => jest.restoreAllMocks());

describe('conta do evento (regra única da agenda, do estoque, da estética e do painel)', () => {
  it('filtro: conta gravada OU evento sem conta criado por usuário da conta; sem conta no contexto, sem filtro', () => {
    expect(eventosDaConta(A)).toEqual(EVENTOS_DA_A);
    expect(eventosDaConta(undefined)).toEqual({});
    expect(eventosDaConta(null)).toEqual({});
  });

  it('conta do evento: a gravada; sem ela, a de quem criou; sem as duas, nenhuma', () => {
    expect(contaDoEvento({ tenant_id: B, created_by: { tenant_id: A } })).toBe(B);
    expect(contaDoEvento({ tenant_id: null, created_by: { tenant_id: A } })).toBe(A);
    expect(contaDoEvento({ tenant_id: null, created_by: { tenant_id: null } })).toBeNull();
    // Criador sem conta: a do contato; sem ela, a do paciente.
    expect(contaDoEvento({ tenant_id: null, created_by: { tenant_id: null }, lead: { tenant_id: A }, patient: { tenant_id: B } })).toBe(A);
    expect(contaDoEvento({ tenant_id: null, created_by: { tenant_id: null }, lead: null, patient: { tenant_id: A } })).toBe(A);
    expect(contaDoEvento({ tenant_id: null, created_by: { tenant_id: null }, lead: { tenant_id: null }, patient: { tenant_id: A } })).toBe(A);
    expect(contaDoEvento({ tenant_id: null, created_by: { tenant_id: B }, lead: { tenant_id: A } })).toBe(B);
    expect(eventoDaConta({ tenant_id: null, created_by: { tenant_id: null }, lead: { tenant_id: B } }, A)).toBe(false);
    expect(eventoDaConta({ tenant_id: null, created_by: { tenant_id: B } }, A)).toBe(false);
    expect(eventoDaConta({ tenant_id: null, created_by: { tenant_id: B } }, undefined)).toBe(true);
  });
});

describe('evento por id: só da própria conta (evento sem conta: a de quem o criou)', () => {
  it.each(FORA_DA_A)('checkOwnership e checkSameTenant de %s com usuário da A: false', async (id) => {
    const { svc } = montar();
    expect(await svc.checkOwnership(id, 'user-a', ['ADMIN'], A)).toBe(false);
    expect(await svc.checkSameTenant(id, A)).toBe(false);
  });

  it('evento sem conta criado por usuário da A: true para a A (como hoje), false para a B', async () => {
    const { svc } = montar();
    expect(await svc.checkOwnership('ev-sem-conta-da-a', 'user-a', ['ADMIN'], A)).toBe(true);
    expect(await svc.checkSameTenant('ev-sem-conta-da-a', A)).toBe(true);
    // Dentista da A que criou o evento continua dono dele.
    expect(await svc.checkOwnership('ev-sem-conta-da-a', 'user-a', ['DENTIST'], A)).toBe(true);
    expect(await svc.checkOwnership('ev-sem-conta-da-a', 'user-b', ['ADMIN'], B)).toBe(false);
    expect(await svc.checkSameTenant('ev-sem-conta-da-a', B)).toBe(false);
  });

  it('conta própria: true; a leitura é a de hoje mais a conta de quem criou', async () => {
    const { svc, prisma } = montar();
    expect(await svc.checkOwnership('ev-a', 'user-a', ['ADMIN'], A)).toBe(true);
    expect(await svc.checkSameTenant('ev-a', A)).toBe(true);
    expect(prisma.calendarEvent.findUnique.mock.calls).toEqual([
      [{ where: { id: 'ev-a' }, select: { created_by_id: true, assigned_user_id: true, ...SELECT_CONTA } }],
      [{ where: { id: 'ev-a' }, select: SELECT_CONTA }],
    ]);
  });

  it.each(DA_A)('checkOwnership e checkSameTenant de %s com o ADMIN da A: true', async (id) => {
    const { svc } = montar();
    expect(await svc.checkOwnership(id, 'user-a', ['ADMIN'], A)).toBe(true);
    expect(await svc.checkSameTenant(id, A)).toBe(true);
  });

  it('SUPER_ADMIN sem conta: true para qualquer evento, como hoje', async () => {
    const { svc } = montar();
    for (const id of Object.keys(EVENTOS)) {
      expect(await svc.checkOwnership(id, 'super', ['SUPER_ADMIN', 'ADMIN'], undefined)).toBe(true);
      expect(await svc.checkSameTenant(id, undefined)).toBe(true);
    }
  });

  it('id que não existe: 404, como hoje', async () => {
    const { svc } = montar();
    await expect(svc.checkOwnership('nao-existe', 'user-a', ['ADMIN'], A)).rejects.toBeInstanceOf(NotFoundException);
    await expect(svc.checkSameTenant('nao-existe', A)).rejects.toBeInstanceOf(NotFoundException);
  });

  it.each(FORA_DA_A)('rotas por id com %s: 403 e nada gravado', async (id) => {
    const { controller, svc, prisma } = montar();
    const updateStatus = jest.spyOn(svc, 'updateStatus');
    await expect(controller.findOne(id, daA)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(controller.update(id, { title: 'x' } as any, undefined, daA)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(controller.update(id, { title: 'x' } as any, 'all', daA)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(controller.updateStatus(id, 'CONFIRMADO', daA)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(controller.remove(id, undefined, daA)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(controller.remove(id, 'all', daA)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(controller.addComment(id, 'oi', daA)).rejects.toBeInstanceOf(ForbiddenException);
    expect(updateStatus).not.toHaveBeenCalled();
    nenhumaEscrita(prisma);
  });

  it('rotas por id com evento sem conta criado pela A: seguem o caminho de hoje', async () => {
    const { controller, svc } = montar();
    const id = 'ev-sem-conta-da-a';
    const espiar = (m: keyof CalendarService) => jest.spyOn(svc, m as any).mockResolvedValue({ id } as any);
    const findOne = espiar('findOne');
    const update = espiar('update');
    const serie = espiar('updateRecurrenceAll');
    const updateStatus = espiar('updateStatus');
    const remove = espiar('remove');
    const addComment = espiar('addComment');
    await controller.findOne(id, daA);
    await controller.update(id, { title: 'x' } as any, undefined, daA);
    await controller.update(id, { title: 'x' } as any, 'all', daA);
    await controller.updateStatus(id, 'CONFIRMADO', daA);
    await controller.remove(id, undefined, daA);
    await controller.addComment(id, 'oi', daA);
    const actor = { userId: 'user-a', roles: ['ADMIN'], tenantId: A, via: 'patch_evento' };
    expect(findOne.mock.calls).toEqual([[id]]);
    expect(update.mock.calls).toEqual([[id, { title: 'x' }, actor]]);
    expect(serie.mock.calls).toEqual([[id, { title: 'x' }, actor]]);
    expect(updateStatus.mock.calls).toEqual([[id, 'CONFIRMADO', { ...actor, via: 'status_route' }]]);
    expect(remove.mock.calls).toEqual([[id]]);
    expect(addComment.mock.calls).toEqual([[id, 'user-a', 'oi']]);
  });

  it.each(FORA_DA_A)('validar e reverter %s com usuário da A: 403 e nada gravado', async (id) => {
    const { svc, prisma } = montar();
    await expect(svc.validate(id, 'user-a', true, 'ok', A)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(svc.unvalidate(id, true, 'user-a', A)).rejects.toBeInstanceOf(ForbiddenException);
    nenhumaEscrita(prisma);
  });

  const semEfeitos = (svc: CalendarService) => {
    for (const m of ['updatePatientVisitDates', 'autoEnsurePatientFromEvent', 'fillPrimaryDentistFromEvent', 'autoPromoteFromAttendance']) {
      jest.spyOn(svc as any, m).mockResolvedValue(undefined);
    }
  };

  it('validar evento da própria conta segue o caminho de hoje (claim + rastro)', async () => {
    const { svc, prisma } = montar();
    semEfeitos(svc);
    await svc.validate('ev-a', 'user-a', true, 'ok', A);
    expect(prisma.calendarEvent.updateMany.mock.calls[0][0].where).toEqual({ id: 'ev-a', validated_at: null });
    expect(prisma.auditLog.create.mock.calls[0][0].data).toMatchObject({ tenant_id: A, action: 'VALIDADO' });
  });

  it('validar e reverter evento sem conta criado pela A: caminho de hoje, rastro na conta A', async () => {
    const { svc, prisma } = montar();
    semEfeitos(svc);
    await svc.validate('ev-sem-conta-da-a', 'user-a', true, 'ok', A);
    expect(prisma.calendarEvent.updateMany.mock.calls[0][0].where).toEqual({ id: 'ev-sem-conta-da-a', validated_at: null });
    expect(prisma.auditLog.create.mock.calls[0][0].data).toMatchObject({ tenant_id: A, action: 'VALIDADO' });

    await svc.unvalidate('ev-sem-conta-da-a-validado', true, 'user-a', A);
    expect(prisma.calendarEvent.update.mock.calls[0][0]).toEqual({
      where: { id: 'ev-sem-conta-da-a-validado' },
      data: { validated_at: null, validated_by_user_id: null, validation_notes: null },
    });
    expect(prisma.auditLog.create.mock.calls[1][0].data).toMatchObject({ tenant_id: A, action: 'VALIDACAO_REVERTIDA' });
    // Reverter evento ainda não validado continua com a resposta de hoje.
    await expect(svc.unvalidate('ev-sem-conta-da-a', true, 'user-a', A)).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('lista, conflitos e ICS: só a própria conta', () => {
  it('findAll da A: where com a conta da A (e o evento sem conta criado por ela); o resto igual a hoje', async () => {
    const { svc, prisma } = montar();
    await svc.findAll({ tenantId: A, userId: 'user-a', search: 'dor' });
    const where = prisma.calendarEvent.findMany.mock.calls[0][0].where;
    expect(where).toEqual({
      ...EVENTOS_DA_A,
      AND: [
        { OR: [{ assigned_user_id: 'user-a' }, { assigned_user_id: null, created_by_id: 'user-a' }] },
        {
          OR: [
            { title: { contains: 'dor', mode: 'insensitive' } },
            { description: { contains: 'dor', mode: 'insensitive' } },
          ],
        },
      ],
    });
  });

  it('findAll da A traz os eventos dela e os sem conta criados por usuário dela; nunca os outros', async () => {
    const { svc } = montar();
    const ids = (await svc.findAll({ tenantId: A, start: '2026-10-27', end: '2026-10-28' })).map((e: any) => e.id);
    expect(ids.sort()).toEqual([...DA_A].sort());
    const daContaB = (await svc.findAll({ tenantId: B })).map((e: any) => e.id);
    expect(daContaB.sort()).toEqual(['ev-admin-contato-b', 'ev-b', 'ev-sem-conta-da-b']);
  });

  it('findAll sem conta (SUPER_ADMIN): sem cláusula de conta, como hoje', async () => {
    const { svc, prisma } = montar();
    await svc.findAll({});
    expect(prisma.calendarEvent.findMany.mock.calls[0][0].where).toEqual({});
  });

  it('checkConflicts da A: só eventos da A (e os sem conta criados por ela); sem conta: sem cláusula', async () => {
    const { svc, prisma } = montar();
    await svc.checkConflicts('user-a', '2026-10-27T14:00:00Z', '2026-10-27T15:00:00Z', undefined, A);
    expect(prisma.calendarEvent.findMany.mock.calls[0][0].where.AND).toEqual([EVENTOS_DA_A]);
    // O OR de sobreposição de horário continua no mesmo lugar.
    expect(prisma.calendarEvent.findMany.mock.calls[0][0].where.OR).toEqual([
      { end_at: { gt: new Date('2026-10-27T14:00:00Z') } },
      { end_at: null, start_at: { gte: new Date('2026-10-27T14:00:00Z') } },
    ]);
    await svc.checkConflicts('user-a', '2026-10-27T14:00:00Z', '2026-10-27T15:00:00Z', undefined, undefined);
    expect(prisma.calendarEvent.findMany.mock.calls[1][0].where.AND).toBeUndefined();
  });

  const res = () => ({ set: jest.fn(), send: jest.fn() });
  const ics = (r: any) => String(r.send.mock.calls[0][0]);

  it.each(FORA_DA_A)('ICS de %s pela A: calendário vazio, igual a id inexistente', async (id) => {
    const { controller, prisma } = montar();
    const r = res();
    await controller.exportEventIcs(id, daA, r as any);
    expect(prisma.calendarEvent.findMany.mock.calls[0][0].where).toEqual({ id: { in: [id] }, ...EVENTOS_DA_A });
    expect(ics(r)).not.toContain('BEGIN:VEVENT');
    const vazio = res();
    await controller.exportEventIcs('nao-existe', daA, vazio as any);
    expect(ics(vazio)).toBe(ics(r));
  });

  it('ICS do próprio evento (e do sem conta criado pela A): o mesmo arquivo de hoje; SUPER_ADMIN baixa qualquer um', async () => {
    const { controller } = montar();
    const r = res();
    await controller.exportEventIcs('ev-a', daA, r as any);
    expect(ics(r)).toContain('UID:ev-a@lexcrm');
    expect(r.set).toHaveBeenCalledWith({
      'Content-Type': 'text/calendar; charset=utf-8',
      'Content-Disposition': 'attachment; filename="event-ev-a.ics"',
    });
    const legado = res();
    await controller.exportEventIcs('ev-sem-conta-da-a', daA, legado as any);
    expect(ics(legado)).toContain('UID:ev-sem-conta-da-a@lexcrm');
    const s = res();
    await controller.exportEventIcs('ev-b', superAdmin, s as any);
    expect(ics(s)).toContain('UID:ev-b@lexcrm');
  });

  it('ICS do período: só os eventos da conta (com os sem conta criados por ela); SUPER_ADMIN, todos', async () => {
    const { controller, prisma } = montar();
    const r = res();
    await controller.exportRangeIcs('2026-10-27', '2026-10-28', undefined, daA, r as any);
    const uids = (txt: string) => (txt.match(/UID:[^\r\n]+/g) ?? []).map((l) => l.slice(4, -'@lexcrm'.length)).sort();
    expect(uids(ics(r))).toEqual([...DA_A].sort());
    expect(prisma.calendarEvent.findMany.mock.calls[1][0].where).toEqual({ id: { in: expect.any(Array) }, ...EVENTOS_DA_A });
    const s = res();
    await controller.exportRangeIcs('2026-10-27', '2026-10-28', undefined, superAdmin, s as any);
    expect(uids(ics(s))).toEqual(Object.keys(EVENTOS).sort());
  });
});

describe('expediente, horários livres e bloqueio de agenda: só profissional da própria conta', () => {
  const SLOT = { day_of_week: 1, start_time: '08:00', end_time: '12:00' };
  const BLOQUEIO = { start_at: '2026-11-02T00:00:00.000Z', end_at: '2026-11-02T23:59:00.000Z', all_day: true, reason: 'Curso' };
  const nadaNoExpediente = (prisma: any) => {
    expect(prisma.userSchedule.deleteMany).not.toHaveBeenCalled();
    expect(prisma.userSchedule.createMany).not.toHaveBeenCalled();
    expect(prisma.scheduleBlock.create).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
  };

  it.each(['user-b', 'user-sem-conta'])('%s pela A: 404 "Profissional nao encontrado", sem ler nem gravar', async (alvo) => {
    const { controller, prisma } = montar();
    const nao = expect.objectContaining({ message: 'Profissional nao encontrado' });
    await expect(controller.getSchedule(alvo, daA)).rejects.toEqual(nao);
    await expect(controller.setSchedule(alvo, [SLOT], daA)).rejects.toEqual(nao);
    await expect(controller.createScheduleBlock({ ...BLOQUEIO, user_id: alvo } as any, daA)).rejects.toEqual(nao);
    await expect(controller.getAvailability(alvo, '2026-10-28', '30', daA)).rejects.toEqual(nao);
    await expect(controller.getSchedule(alvo, daA)).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.userSchedule.findMany).not.toHaveBeenCalled();
    expect(prisma.calendarEvent.findMany).not.toHaveBeenCalled();
    nadaNoExpediente(prisma);
  });

  it('profissional da própria conta: mesmas leituras, gravações e respostas de hoje', async () => {
    const { controller, prisma } = montar();
    const ordem = [{ day_of_week: 'asc' }, { sort_order: 'asc' }, { start_time: 'asc' }];

    expect(await controller.getSchedule('user-a', daA)).toEqual([TURNO]);
    expect(prisma.userSchedule.findMany.mock.calls[0][0]).toEqual({ where: { user_id: 'user-a' }, orderBy: ordem });

    await controller.setSchedule('user-a', [SLOT], daA);
    expect(prisma.userSchedule.deleteMany).toHaveBeenCalledWith({ where: { user_id: 'user-a' } });
    expect(prisma.userSchedule.createMany).toHaveBeenCalledWith({
      data: [{ user_id: 'user-a', ...SLOT, lunch_start: null, lunch_end: null, label: null, sort_order: 0 }],
    });

    await controller.createScheduleBlock({ ...BLOQUEIO, user_id: 'user-a' } as any, daA);
    expect(prisma.scheduleBlock.create).toHaveBeenCalledWith({
      data: {
        user_id: 'user-a',
        start_at: new Date(BLOQUEIO.start_at),
        end_at: new Date(BLOQUEIO.end_at),
        all_day: true,
        reason: 'Curso',
        notes: undefined,
        created_by: 'user-a',
        tenant_id: A,
      },
      include: { user: { select: { id: true, name: true } } },
    });

    expect(await controller.getAvailability('user-a', '2026-10-28', '30', daA)).toEqual([
      { start: '08:00', end: '08:30' },
      { start: '08:30', end: '09:00' },
    ]);
  });

  it('dentista da própria conta edita o próprio expediente e bloqueia a própria agenda, como hoje', async () => {
    const { controller, prisma } = montar();
    const dentista = usuario(A, ['DENTIST']);
    await controller.setSchedule('user-a', [SLOT], dentista);
    await controller.createScheduleBlock({ ...BLOQUEIO, user_id: 'user-a' } as any, dentista);
    expect(prisma.userSchedule.createMany).toHaveBeenCalledTimes(1);
    expect(prisma.scheduleBlock.create).toHaveBeenCalledTimes(1);
  });

  it('id que não existe: segue o caminho de hoje (expediente vazio)', async () => {
    const { controller, prisma } = montar();
    expect(await controller.getSchedule('user-nao-existe', daA)).toEqual([]);
    expect(prisma.userSchedule.findMany).toHaveBeenCalledTimes(1);
  });

  it('SUPER_ADMIN sem conta: nada é conferido, como hoje', async () => {
    const { controller, prisma } = montar();
    await controller.getSchedule('user-b', superAdmin);
    await controller.setSchedule('user-b', [SLOT], superAdmin);
    await controller.createScheduleBlock({ ...BLOQUEIO, user_id: 'user-b' } as any, superAdmin);
    await controller.getAvailability('user-b', '2026-10-28', '30', superAdmin);
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
    expect(prisma.userSchedule.deleteMany).toHaveBeenCalledWith({ where: { user_id: 'user-b' } });
    expect(prisma.scheduleBlock.create.mock.calls[0][0].data).toMatchObject({ user_id: 'user-b', tenant_id: undefined });
  });

  it('conta B também só mexe nos profissionais dela', async () => {
    const { controller, prisma } = montar();
    await expect(controller.setSchedule('user-a', [SLOT], daB)).rejects.toBeInstanceOf(NotFoundException);
    await controller.setSchedule('user-b', [SLOT], daB);
    expect(prisma.userSchedule.deleteMany.mock.calls).toEqual([[{ where: { user_id: 'user-b' } }]]);
  });
});

describe('criar evento: contato, paciente, conversa, profissional e tipo só da própria conta', () => {
  const corpo = (extra: Record<string, any> = {}) =>
    ({ type: 'CONSULTA', title: 'Consulta', start_at: '2026-10-28T14:00:00.000Z', ...extra }) as any;

  it.each([
    ['lead_id', 'lead-b'],
    ['lead_id', 'lead-sem-conta'],
    ['patient_id', 'pac-b'],
    ['conversation_id', 'conv-b'],
    ['conversation_id', 'conv-sem-conta'],
    ['assigned_user_id', 'user-b'],
    ['assigned_user_id', 'user-sem-conta'],
    ['appointment_type_id', 'tipo-b'],
  ])('%s = %s: 404 e nada gravado', async (campo, id) => {
    const { controller, svc, prisma } = montar();
    const create = jest.spyOn(svc, 'create');
    await expect(controller.create(corpo({ assigned_user_id: 'user-a', [campo]: id }), daA)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(create).not.toHaveBeenCalled();
    nenhumaEscrita(prisma);
  });

  it('tudo da própria conta (e tipo sem conta, padrão antigo): o create recebe o mesmo objeto de hoje', async () => {
    const { controller, svc } = montar();
    const create = jest.spyOn(svc, 'create').mockResolvedValue({ id: 'novo' } as any);
    const data = corpo({
      lead_id: 'lead-a',
      patient_id: 'pac-a',
      conversation_id: 'conv-a',
      assigned_user_id: 'user-a',
      appointment_type_id: 'tipo-sem-conta',
    });
    expect(await controller.create(data, daA)).toEqual({ id: 'novo' });
    expect(create.mock.calls).toEqual([[{ ...data, created_by_id: 'user-a', tenant_id: A, actor_roles: ['ADMIN'] }]]);
  });

  it('sem ids no corpo: nenhuma leitura a mais; id que não existe segue para o create como hoje', async () => {
    const { controller, svc, prisma } = montar();
    const create = jest.spyOn(svc, 'create').mockResolvedValue({ id: 'novo' } as any);
    await controller.create(corpo({ type: 'TAREFA' }), daA);
    expect(leiturasDeConta(prisma)).toBe(0);
    await controller.create(corpo({ lead_id: 'lead-nao-existe', assigned_user_id: 'user-a' }), daA);
    expect(create).toHaveBeenCalledTimes(2);
  });

  it('SUPER_ADMIN sem conta: nada é conferido, como hoje', async () => {
    const { controller, svc, prisma } = montar();
    const create = jest.spyOn(svc, 'create').mockResolvedValue({ id: 'novo' } as any);
    await controller.create(corpo({ lead_id: 'lead-b', patient_id: 'pac-b', assigned_user_id: 'user-b' }), superAdmin);
    expect(leiturasDeConta(prisma)).toBe(0);
    expect(create.mock.calls[0][0]).toMatchObject({ lead_id: 'lead-b', patient_id: 'pac-b', tenant_id: undefined });
  });
});

describe('criar evento: paciente resolvido pelo contato (e contato pelo paciente) só da conta do evento', () => {
  const tarefa = (extra: Record<string, any>) =>
    ({ type: 'TAREFA', title: 'Ligar', start_at: '2026-10-28T14:00:00.000Z', created_by_id: 'user-a', ...extra }) as any;
  const gravado = (prisma: any) => prisma.calendarEvent.create.mock.calls[0][0].data;

  it('contato da A com ficha da A: vincula o paciente, com a mesma leitura de hoje', async () => {
    const { svc, prisma } = montar();
    await svc.create(tarefa({ lead_id: 'lead-a', tenant_id: A }));
    expect(prisma.patient.findUnique.mock.calls[0][0].where).toEqual({ lead_id: 'lead-a' });
    expect(gravado(prisma)).toMatchObject({ lead_id: 'lead-a', patient_id: 'pac-a', tenant_id: A });
  });

  it('contato da A ligado a ficha da B: o evento nasce sem o paciente da B', async () => {
    const { svc, prisma } = montar();
    await svc.create(tarefa({ lead_id: 'lead-a-ficha-b', tenant_id: A }));
    expect(gravado(prisma).patient_id).toBeUndefined();
    expect(gravado(prisma).lead_id).toBe('lead-a-ficha-b');
  });

  it('paciente da A: o contato dele entra; contato da B ou sem conta fica de fora', async () => {
    const a = montar();
    await a.svc.create(tarefa({ patient_id: 'pac-a', tenant_id: A }));
    expect(gravado(a.prisma)).toMatchObject({ lead_id: 'lead-a', patient_id: 'pac-a' });
    for (const pac of ['pac-a-contato-b', 'pac-a-contato-sem-conta']) {
      const m = montar();
      await m.svc.create(tarefa({ patient_id: pac, tenant_id: A }));
      expect(gravado(m.prisma).lead_id).toBeUndefined();
      expect(gravado(m.prisma).patient_id).toBe(pac);
    }
  });

  it('sem conta no evento (chamada interna sem conta): resolve como hoje', async () => {
    const { svc, prisma } = montar();
    await svc.create(tarefa({ lead_id: 'lead-a-ficha-b' }));
    expect(gravado(prisma).patient_id).toBe('pac-b');
  });
});

describe('editar evento: ids NOVOS do corpo só da própria conta', () => {
  const actor = { userId: 'user-a', roles: ['ADMIN'], tenantId: A, via: 'patch_evento' };

  it.each([
    ['lead_id', 'lead-b'],
    ['patient_id', 'pac-b'],
    ['conversation_id', 'conv-sem-conta'],
    ['assigned_user_id', 'user-b'],
    ['appointment_type_id', 'tipo-b'],
  ])('%s = %s: 404 e nada gravado (só este evento e a série)', async (campo, id) => {
    for (const escopo of [undefined, 'all']) {
      const { controller, svc, prisma } = montar();
      const update = jest.spyOn(svc, 'update');
      const serie = jest.spyOn(svc, 'updateRecurrenceAll');
      await expect(controller.update('ev-a', { [campo]: id } as any, escopo, daA)).rejects.toBeInstanceOf(NotFoundException);
      expect(update).not.toHaveBeenCalled();
      expect(serie).not.toHaveBeenCalled();
      nenhumaEscrita(prisma);
    }
  });

  it('ids novos da própria conta: update recebe os mesmos argumentos de hoje', async () => {
    const { controller, svc } = montar();
    const update = jest.spyOn(svc, 'update').mockResolvedValue({ id: 'ev-a' } as any);
    const serie = jest.spyOn(svc, 'updateRecurrenceAll').mockResolvedValue({ id: 'ev-a' } as any);
    const data = { title: 'Retorno', lead_id: 'lead-a', patient_id: 'pac-a', assigned_user_id: 'user-a', appointment_type_id: 'tipo-a' } as any;
    await controller.update('ev-a', data, undefined, daA);
    await controller.update('ev-a', data, 'all', daA);
    expect(update.mock.calls).toEqual([['ev-a', data, actor]]);
    expect(serie.mock.calls).toEqual([['ev-a', data, actor]]);
  });

  it('Salvar do modal reenviando os vínculos que o evento já tem (mesmo antigos): passa como hoje', async () => {
    const { controller, svc, prisma } = montar();
    const update = jest.spyOn(svc, 'update').mockResolvedValue({ id: 'ev-a-legado' } as any);
    const data = { title: 'Consulta', status: 'AGENDADO', lead_id: 'lead-sem-conta', assigned_user_id: 'user-b', appointment_type_id: 'tipo-b' } as any;
    await controller.update('ev-a-legado', data, undefined, daA);
    expect(update.mock.calls).toEqual([['ev-a-legado', data, actor]]);
    expect(leiturasDeConta(prisma)).toBe(0);
  });

  it('SUPER_ADMIN sem conta edita qualquer evento com qualquer id, como hoje', async () => {
    const { controller, svc, prisma } = montar();
    const update = jest.spyOn(svc, 'update').mockResolvedValue({ id: 'ev-b' } as any);
    await controller.update('ev-a', { lead_id: 'lead-b' } as any, undefined, superAdmin);
    expect(update).toHaveBeenCalledTimes(1);
    expect(leiturasDeConta(prisma)).toBe(0);
  });
});

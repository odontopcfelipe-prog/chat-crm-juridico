/**
 * Fase 0 — Grupo 4: travas de status da agenda e auditoria (AGENDA_EVENTO).
 * Prisma mockado; $transaction = (fn) => fn(prisma). Efeitos colaterais (lembretes,
 * lead→paciente, WhatsApp/e-mail) ficam stubados: aqui só importa a regra e o rastro.
 */
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { CalendarService } from './calendar.service';
import { MSG_CRIAR_SO_ADMIN, MSG_TIPO_VALIDADA_SO_ADMIN, MSG_VALIDADA_SO_ADMIN } from './agenda-status-guard';

const TENANT = 't1';
const VALIDADA = new Date('2026-10-19T15:00:00.000Z');

type Ev = {
  id: string;
  status: string;
  type: string;
  validated_at: Date | null;
  tenant_id: string | null;
  start_at: Date;
  patient_id: string | null;
  lead_id: string | null;
  assigned_user_id: string | null;
  title?: string;
};

function montar(opts: { ev?: Partial<Ev> | null; updateManyCount?: number } = {}) {
  const ev: Ev | null =
    opts.ev === null
      ? null
      : {
          id: 'ev1',
          status: 'AGENDADO',
          type: 'CONSULTA',
          validated_at: null,
          tenant_id: TENANT,
          start_at: new Date('2026-10-19T14:00:00.000Z'),
          patient_id: 'pat1',
          lead_id: 'lead1',
          assigned_user_id: 'dent1',
          title: 'Consulta',
          ...opts.ev,
        };

  const prisma: any = {
    calendarEvent: {
      findUnique: jest.fn(async () => (ev ? { ...ev, assigned_user: { id: 'dent1', name: 'Dra' } } : null)),
      updateMany: jest.fn(async () => ({ count: opts.updateManyCount ?? 1 })),
      update: jest.fn(async (args: any) => ({ ...ev, ...args.data, reminders: [], assigned_user: null, lead: null })),
      create: jest.fn(async (args: any) => ({
        id: 'novo1',
        ...args.data,
        reminders: [],
        assigned_user: { id: args.data.assigned_user_id, name: 'Dra' },
        lead: null,
      })),
      findMany: jest.fn(async () => []),
    },
    auditLog: { create: jest.fn(async () => ({})) },
    globalSetting: { findUnique: jest.fn(async () => null) },
    patient: { findUnique: jest.fn(async () => null) },
  };
  prisma.$transaction = jest.fn(async (fn: any) => fn(prisma));

  const chatGateway: any = { emitCalendarUpdate: jest.fn() };
  const queue: any = { add: jest.fn(), getJob: jest.fn(async () => null) };
  const waitlist: any = { notifySlotOpened: jest.fn(async () => ({ notified: 0 })) };
  const svc = new CalendarService(prisma, chatGateway, queue, waitlist, {} as any, {} as any, {} as any);

  // Efeitos colaterais fora do escopo do teste
  for (const m of [
    'cancelReminderJobs',
    'updatePatientVisitDates',
    'autoEnsurePatientFromEvent',
    'fillPrimaryDentistFromEvent',
    'autoPromoteFromAttendance',
    'sendAppointmentEventWhatsapp',
    'sendAppointmentEventEmail',
    'enqueueReminders',
    'boundedQueueOp',
  ]) {
    jest.spyOn(svc as any, m).mockResolvedValue(undefined);
  }
  return { svc, prisma, waitlist };
}

const ADMIN = { userId: 'adm1', roles: ['ADMIN'], tenantId: TENANT, via: 'status_route' };
const RECEPCAO = { userId: 'rec1', roles: ['OPERADOR'], tenantId: TENANT, via: 'status_route' };

describe('Fase 0 — CalendarService.updateStatus (trava pós-validação + auditoria)', () => {
  it('1. validada → NO_SHOW por não-admin: 403 PERMISSION_DENIED e não grava nada', async () => {
    const { svc, prisma } = montar({ ev: { status: 'CONCLUIDO', validated_at: VALIDADA } });
    const err = await svc.updateStatus('ev1', 'NO_SHOW', RECEPCAO).catch((e) => e);
    expect(err).toBeInstanceOf(ForbiddenException);
    expect(err.getResponse()).toEqual({ message: MSG_VALIDADA_SO_ADMIN, code: 'PERMISSION_DENIED' });
    expect(prisma.calendarEvent.updateMany).not.toHaveBeenCalled();
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });

  it('sem ator conta como não-admin', async () => {
    const { svc, prisma } = montar({ ev: { status: 'CONCLUIDO', validated_at: VALIDADA } });
    await expect(svc.updateStatus('ev1', 'CANCELADO')).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.calendarEvent.updateMany).not.toHaveBeenCalled();
  });

  it('2. validada → NO_SHOW por ADMIN: passa e audita com admin_override:true', async () => {
    const { svc, prisma } = montar({ ev: { status: 'CONCLUIDO', validated_at: VALIDADA } });
    await svc.updateStatus('ev1', 'NO_SHOW', ADMIN);
    expect(prisma.calendarEvent.updateMany).toHaveBeenCalledWith({ where: { id: 'ev1' }, data: { status: 'NO_SHOW' } });
    expect(prisma.auditLog.create).toHaveBeenCalledTimes(1);
    const data = prisma.auditLog.create.mock.calls[0][0].data;
    expect(data).toMatchObject({ tenant_id: TENANT, actor_user_id: 'adm1', entity: 'AGENDA_EVENTO', entity_id: 'ev1', action: 'STATUS' });
    expect(data.meta_json).toMatchObject({
      via: 'status_route',
      validada: true,
      admin_override: true,
      before: { status: 'CONCLUIDO' },
      after: { status: 'NO_SHOW' },
    });
  });

  it('SUPER_ADMIN também passa a trava', async () => {
    const { svc, prisma } = montar({ ev: { status: 'CONCLUIDO', validated_at: VALIDADA } });
    await svc.updateStatus('ev1', 'ADIADO', { ...ADMIN, roles: ['SUPER_ADMIN'] });
    expect(prisma.calendarEvent.updateMany).toHaveBeenCalled();
  });

  it('3. não validada → NO_SHOW com claim count 0 (validou no meio): 403', async () => {
    const { svc, prisma } = montar({ ev: { status: 'AGENDADO', validated_at: null }, updateManyCount: 0 });
    const err = await svc.updateStatus('ev1', 'NO_SHOW', RECEPCAO).catch((e) => e);
    expect(err).toBeInstanceOf(ForbiddenException);
    expect(err.getResponse()).toMatchObject({ code: 'PERMISSION_DENIED' });
    // claim condicionado a validated_at null
    expect(prisma.calendarEvent.updateMany).toHaveBeenCalledWith({
      where: { id: 'ev1', validated_at: null },
      data: { status: 'NO_SHOW' },
    });
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });

  it('não validada → NO_SHOW por recepção: passa (trava só pós-validação)', async () => {
    const { svc, prisma, waitlist } = montar({ ev: { status: 'AGENDADO', validated_at: null } });
    await svc.updateStatus('ev1', 'CANCELADO', RECEPCAO);
    expect(prisma.auditLog.create).toHaveBeenCalledTimes(1);
    expect(prisma.auditLog.create.mock.calls[0][0].data.meta_json).toMatchObject({ validada: false, admin_override: false });
    // efeito colateral de hoje continua (vaga aberta → lista de espera)
    expect(waitlist.notifySlotOpened).toHaveBeenCalled();
  });

  it('4. AGENDADO → COMPARECEU: audita com tenant_id na coluna', async () => {
    const { svc, prisma } = montar({ ev: { status: 'AGENDADO' } });
    await svc.updateStatus('ev1', 'COMPARECEU', RECEPCAO);
    expect(prisma.calendarEvent.updateMany).toHaveBeenCalledWith({ where: { id: 'ev1' }, data: { status: 'COMPARECEU' } });
    const data = prisma.auditLog.create.mock.calls[0][0].data;
    expect(data.tenant_id).toBe(TENANT);
    expect(data.actor_user_id).toBe('rec1');
    expect(data.meta_json).toMatchObject({ before: { status: 'AGENDADO' }, after: { status: 'COMPARECEU' }, patient_id: 'pat1', lead_id: 'lead1' });
  });

  it('validada → CONCLUIDO (mesmo fluxo do dentista) não é travado', async () => {
    const { svc, prisma } = montar({ ev: { status: 'COMPARECEU', validated_at: VALIDADA } });
    await svc.updateStatus('ev1', 'CONCLUIDO', RECEPCAO);
    expect(prisma.calendarEvent.updateMany).toHaveBeenCalledWith({ where: { id: 'ev1' }, data: { status: 'CONCLUIDO' } });
  });

  it('5. mesmo status: não grava auditoria', async () => {
    const { svc, prisma } = montar({ ev: { status: 'CONFIRMADO' } });
    await svc.updateStatus('ev1', 'CONFIRMADO', RECEPCAO);
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });

  it('5b. mesmo status NO_SHOW numa validada: não trava (nada muda)', async () => {
    const { svc, prisma } = montar({ ev: { status: 'NO_SHOW', validated_at: VALIDADA } });
    await svc.updateStatus('ev1', 'NO_SHOW', RECEPCAO);
    expect(prisma.calendarEvent.updateMany).toHaveBeenCalledWith({ where: { id: 'ev1' }, data: { status: 'NO_SHOW' } });
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });

  it('6. TAREFA: não trava nem grava auditoria', async () => {
    const { svc, prisma } = montar({ ev: { type: 'TAREFA', status: 'AGENDADO', validated_at: null } });
    await svc.updateStatus('ev1', 'CANCELADO');
    expect(prisma.calendarEvent.updateMany).toHaveBeenCalledWith({ where: { id: 'ev1' }, data: { status: 'CANCELADO' } });
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });

  it('6b. validada que está como TAREFA (tipo trocado) continua travada para não-admin', async () => {
    const { svc, prisma } = montar({ ev: { type: 'TAREFA', status: 'CONCLUIDO', validated_at: VALIDADA } });
    const err = await svc.updateStatus('ev1', 'NO_SHOW', RECEPCAO).catch((e) => e);
    expect(err).toBeInstanceOf(ForbiddenException);
    expect(err.getResponse()).toMatchObject({ message: MSG_VALIDADA_SO_ADMIN, code: 'PERMISSION_DENIED' });
    expect(prisma.calendarEvent.updateMany).not.toHaveBeenCalled();
  });

  it('6c. validada como TAREFA → NO_SHOW pelo ADMIN: passa e fica no rastro', async () => {
    const { svc, prisma } = montar({ ev: { type: 'TAREFA', status: 'CONCLUIDO', validated_at: VALIDADA } });
    await svc.updateStatus('ev1', 'NO_SHOW', ADMIN);
    expect(prisma.auditLog.create).toHaveBeenCalledTimes(1);
    expect(prisma.auditLog.create.mock.calls[0][0].data.meta_json).toMatchObject({ admin_override: true });
  });

  it('evento inexistente: 404', async () => {
    const { svc } = montar({ ev: null });
    await expect(svc.updateStatus('x', 'CONFIRMADO', RECEPCAO)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('status inválido: 400', async () => {
    const { svc } = montar();
    await expect(svc.updateStatus('ev1', 'QUALQUER', RECEPCAO)).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('Fase 0 — CalendarService.update (PATCH): mesma trava + auditoria best-effort', () => {
  const PATCH_REC = { userId: 'rec1', roles: ['OPERADOR'], tenantId: TENANT, via: 'patch_evento' };

  it('validada → CANCELADO por não-admin: 403 e não atualiza', async () => {
    const { svc, prisma } = montar({ ev: { status: 'CONCLUIDO', validated_at: VALIDADA } });
    await expect(svc.update('ev1', { status: 'CANCELADO' }, PATCH_REC)).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.calendarEvent.update).not.toHaveBeenCalled();
  });

  it('Salvar reenviando o status atual (NO_SHOW) numa validada: não trava nem audita', async () => {
    const { svc, prisma } = montar({ ev: { status: 'NO_SHOW', validated_at: VALIDADA } });
    await svc.update('ev1', { status: 'NO_SHOW', title: 'X' }, PATCH_REC);
    expect(prisma.calendarEvent.update).toHaveBeenCalled();
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });

  it('troca de status numa consulta: audita com via patch_evento', async () => {
    const { svc, prisma } = montar({ ev: { status: 'AGENDADO' } });
    await svc.update('ev1', { status: 'CONFIRMADO' }, PATCH_REC);
    const data = prisma.auditLog.create.mock.calls[0][0].data;
    expect(data).toMatchObject({ tenant_id: TENANT, actor_user_id: 'rec1', entity: 'AGENDA_EVENTO', action: 'STATUS' });
    expect(data.meta_json).toMatchObject({ via: 'patch_evento', before: { status: 'AGENDADO' }, after: { status: 'CONFIRMADO' } });
  });

  it('falha da auditoria não derruba o PATCH', async () => {
    const { svc, prisma } = montar({ ev: { status: 'AGENDADO' } });
    prisma.auditLog.create.mockRejectedValueOnce(new Error('db fora'));
    await expect(svc.update('ev1', { status: 'CONFIRMADO' }, PATCH_REC)).resolves.toBeTruthy();
  });

  it('updateRecurrenceAll repassa o ator (trava vale para a série)', async () => {
    const { svc, prisma } = montar({ ev: { status: 'CONCLUIDO', validated_at: VALIDADA } });
    await expect(svc.updateRecurrenceAll('ev1', { status: 'ADIADO' }, PATCH_REC)).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.calendarEvent.update).not.toHaveBeenCalled();
  });

  it('validada: não-admin não muda o tipo (virar TAREFA tirava a trava e o rastro)', async () => {
    const { svc, prisma } = montar({ ev: { status: 'CONCLUIDO', validated_at: VALIDADA } });
    const err = await svc.update('ev1', { type: 'TAREFA' }, PATCH_REC).catch((e) => e);
    expect(err).toBeInstanceOf(ForbiddenException);
    expect(err.getResponse()).toEqual({ message: MSG_TIPO_VALIDADA_SO_ADMIN, code: 'PERMISSION_DENIED' });
    expect(prisma.calendarEvent.update).not.toHaveBeenCalled();
  });

  it('validada: Salvar reenviando o MESMO tipo continua livre', async () => {
    const { svc, prisma } = montar({ ev: { status: 'CONCLUIDO', validated_at: VALIDADA } });
    await svc.update('ev1', { type: 'CONSULTA', status: 'CONCLUIDO', title: 'X' }, PATCH_REC);
    expect(prisma.calendarEvent.update).toHaveBeenCalled();
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });

  it('validada: ADMIN muda o tipo e fica o rastro TIPO', async () => {
    const { svc, prisma } = montar({ ev: { status: 'CONCLUIDO', validated_at: VALIDADA } });
    await svc.update('ev1', { type: 'RETORNO' }, { ...PATCH_REC, userId: 'adm1', roles: ['ADMIN'] });
    const data = prisma.auditLog.create.mock.calls[0][0].data;
    expect(data).toMatchObject({ tenant_id: TENANT, actor_user_id: 'adm1', entity: 'AGENDA_EVENTO', action: 'TIPO' });
    expect(data.meta_json).toMatchObject({
      before: { type: 'CONSULTA', status: 'CONCLUIDO' },
      after: { type: 'RETORNO', status: 'CONCLUIDO' },
      validada: true,
    });
  });

  it('TAREFA Atendido virando CONSULTA por não-admin: 403 (mesma regra do create)', async () => {
    const { svc, prisma } = montar({ ev: { type: 'TAREFA', status: 'CONCLUIDO', validated_at: null } });
    const err = await svc.update('ev1', { type: 'CONSULTA', status: 'CONCLUIDO', assigned_user_id: 'dent1' }, PATCH_REC).catch((e) => e);
    expect(err).toBeInstanceOf(ForbiddenException);
    expect(err.getResponse()).toEqual({ message: MSG_CRIAR_SO_ADMIN, code: 'PERMISSION_DENIED' });
    expect(prisma.calendarEvent.update).not.toHaveBeenCalled();
  });

  it('TAREFA Agendada virando CONSULTA por não-admin: passa e grava TIPO', async () => {
    const { svc, prisma } = montar({ ev: { type: 'TAREFA', status: 'AGENDADO', validated_at: null } });
    await svc.update('ev1', { type: 'CONSULTA', status: 'AGENDADO', assigned_user_id: 'dent1' }, PATCH_REC);
    expect(prisma.calendarEvent.update).toHaveBeenCalled();
    const tipo = prisma.auditLog.create.mock.calls.map((c: any) => c[0].data).find((d: any) => d.action === 'TIPO');
    expect(tipo).toMatchObject({ tenant_id: TENANT, actor_user_id: 'rec1' });
    expect(tipo.meta_json).toMatchObject({ before: { type: 'TAREFA', status: 'AGENDADO' }, after: { type: 'CONSULTA', status: 'AGENDADO' } });
  });

  it('TAREFA → CONSULTA trocando status no mesmo PATCH: audita STATUS (clínico depois)', async () => {
    const { svc, prisma } = montar({ ev: { type: 'TAREFA', status: 'AGENDADO', validated_at: null } });
    await svc.update('ev1', { type: 'CONSULTA', status: 'COMPARECEU', assigned_user_id: 'dent1' }, PATCH_REC);
    const acoes = prisma.auditLog.create.mock.calls.map((c: any) => c[0].data.action);
    expect(acoes).toEqual(expect.arrayContaining(['TIPO', 'STATUS']));
  });

  it('ADMIN pode virar TAREFA concluída em consulta Atendido (retroativo)', async () => {
    const { svc, prisma } = montar({ ev: { type: 'TAREFA', status: 'CONCLUIDO', validated_at: null } });
    await svc.update('ev1', { type: 'CONSULTA', assigned_user_id: 'dent1' }, { ...PATCH_REC, userId: 'adm1', roles: ['ADMIN'] });
    expect(prisma.calendarEvent.update).toHaveBeenCalled();
  });

  it('updateRecurrenceAll por não-admin: tipo/dentista só nos filhos NÃO validados; o resto na série toda', async () => {
    const { svc, prisma } = montar({ ev: { type: 'CONSULTA', status: 'AGENDADO', validated_at: null } });
    prisma.calendarEvent.count = jest.fn(async () => 0);
    await svc.updateRecurrenceAll('ev1', { type: 'RETORNO', title: 'Novo' }, PATCH_REC);
    expect(prisma.calendarEvent.updateMany).toHaveBeenCalledWith({ where: { parent_event_id: 'ev1' }, data: { title: 'Novo' } });
    expect(prisma.calendarEvent.updateMany).toHaveBeenCalledWith({
      where: { parent_event_id: 'ev1', validated_at: null },
      data: { title: 'Novo', type: 'RETORNO' },
    });
  });

  it('updateRecurrenceAll por ADMIN: série toda, como antes', async () => {
    const { svc, prisma } = montar({ ev: { type: 'CONSULTA', status: 'AGENDADO', validated_at: null } });
    await svc.updateRecurrenceAll('ev1', { type: 'RETORNO' }, { ...PATCH_REC, roles: ['ADMIN'] });
    expect(prisma.calendarEvent.updateMany).toHaveBeenCalledTimes(1);
    expect(prisma.calendarEvent.updateMany).toHaveBeenCalledWith({ where: { parent_event_id: 'ev1' }, data: { type: 'RETORNO' } });
  });

  it('updateRecurrenceAll: série TAREFA com filho Atendido virando consulta por não-admin → 403 antes de mexer no pai', async () => {
    const { svc, prisma } = montar({ ev: { type: 'TAREFA', status: 'AGENDADO', validated_at: null } });
    prisma.calendarEvent.count = jest.fn(async () => 2);
    const err = await svc.updateRecurrenceAll('ev1', { type: 'CONSULTA', assigned_user_id: 'dent1' }, PATCH_REC).catch((e) => e);
    expect(err).toBeInstanceOf(ForbiddenException);
    expect(err.getResponse()).toEqual({ message: MSG_CRIAR_SO_ADMIN, code: 'PERMISSION_DENIED' });
    expect(prisma.calendarEvent.count).toHaveBeenCalledWith({
      where: {
        parent_event_id: 'ev1',
        type: { notIn: ['CONSULTA', 'PROCEDIMENTO', 'RETORNO', 'ORTODONTIA'] },
        status: { in: ['CONCLUIDO', 'NO_SHOW', 'CANCELADO'] },
      },
    });
    expect(prisma.calendarEvent.update).not.toHaveBeenCalled();
    expect(prisma.calendarEvent.updateMany).not.toHaveBeenCalled();
  });
});

describe('Fase 0 — CalendarService.validate / unvalidate', () => {
  it('7a. validate de evento de outra clínica: 403', async () => {
    const { svc, prisma } = montar({ ev: { tenant_id: 'outra', status: 'COMPARECEU' } });
    await expect(svc.validate('ev1', 'dent1', false, undefined, TENANT)).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.calendarEvent.updateMany).not.toHaveBeenCalled();
  });

  it('7b. segunda validação (claim count 0): 400', async () => {
    const { svc, prisma } = montar({ ev: { status: 'COMPARECEU' }, updateManyCount: 0 });
    await expect(svc.validate('ev1', 'dent1', false, undefined, TENANT)).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });

  it('validate ok: claim em validated_at null + auditoria VALIDADO na mesma transação', async () => {
    const { svc, prisma } = montar({ ev: { status: 'COMPARECEU' } });
    await svc.validate('ev1', 'adm1', true, '  ok  ', TENANT);
    expect(prisma.$transaction).toHaveBeenCalled();
    const upd = prisma.calendarEvent.updateMany.mock.calls[0][0];
    expect(upd.where).toEqual({ id: 'ev1', validated_at: null });
    expect(upd.data).toMatchObject({ validated_by_user_id: 'adm1', validation_notes: 'ok', status: 'CONCLUIDO' });
    const data = prisma.auditLog.create.mock.calls[0][0].data;
    expect(data).toMatchObject({ tenant_id: TENANT, actor_user_id: 'adm1', action: 'VALIDADO', entity: 'AGENDA_EVENTO' });
    expect(data.meta_json).toMatchObject({ admin_por_outro: true, before: { status: 'COMPARECEU', validated_at: null }, after: { status: 'CONCLUIDO' } });
  });

  it('unvalidate de outra clínica: 403', async () => {
    const { svc } = montar({ ev: { tenant_id: 'outra', validated_at: VALIDADA } });
    await expect(svc.unvalidate('ev1', true, 'adm1', TENANT)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('unvalidate grava VALIDACAO_REVERTIDA com o estado anterior e o autor', async () => {
    const { svc, prisma } = montar({ ev: { status: 'CONCLUIDO', validated_at: VALIDADA } });
    (prisma.calendarEvent.findUnique as jest.Mock).mockResolvedValueOnce({
      id: 'ev1', validated_at: VALIDADA, assigned_user_id: 'dent1', type: 'CONSULTA', title: 'Consulta',
      tenant_id: TENANT, validated_by_user_id: 'dent1', validation_notes: 'feito', status: 'CONCLUIDO',
    });
    await svc.unvalidate('ev1', true, 'adm1', TENANT);
    const data = prisma.auditLog.create.mock.calls[0][0].data;
    expect(data).toMatchObject({ tenant_id: TENANT, actor_user_id: 'adm1', action: 'VALIDACAO_REVERTIDA' });
    expect(data.meta_json.before).toEqual({
      validated_at: VALIDADA.toISOString(), validated_by_user_id: 'dent1', validation_notes: 'feito', status: 'CONCLUIDO',
    });
    expect(data.meta_json.after).toEqual({ validated_at: null });
  });
});

describe('Fase 0 — CalendarService.create (status inicial)', () => {
  const base = {
    type: 'CONSULTA',
    title: 'Consulta',
    start_at: '2026-10-19T14:00:00.000Z',
    assigned_user_id: 'dent1',
    created_by_id: 'rec1',
    tenant_id: TENANT,
  };

  it('8a. CONCLUIDO por não-admin: 403 PERMISSION_DENIED, nada criado', async () => {
    const { svc, prisma } = montar();
    const err = await svc.create({ ...base, status: 'CONCLUIDO', actor_roles: ['OPERADOR'] }).catch((e) => e);
    expect(err).toBeInstanceOf(ForbiddenException);
    expect(err.getResponse()).toEqual({ message: MSG_CRIAR_SO_ADMIN, code: 'PERMISSION_DENIED' });
    expect(prisma.calendarEvent.create).not.toHaveBeenCalled();
  });

  it('CONCLUIDO por ADMIN: cria e grava CRIADO', async () => {
    const { svc, prisma } = montar();
    await svc.create({ ...base, created_by_id: 'adm1', status: 'CONCLUIDO', actor_roles: ['ADMIN'] });
    expect(prisma.calendarEvent.create).toHaveBeenCalled();
    expect(prisma.auditLog.create.mock.calls[0][0].data).toMatchObject({ action: 'CRIADO', actor_user_id: 'adm1' });
  });

  it('8b. COMPARECEU por não-admin: cria e grava CRIADO com tenant_id', async () => {
    const { svc, prisma } = montar();
    await svc.create({ ...base, status: 'COMPARECEU', actor_roles: ['OPERADOR'] });
    const data = prisma.auditLog.create.mock.calls[0][0].data;
    expect(data).toMatchObject({ tenant_id: TENANT, actor_user_id: 'rec1', entity: 'AGENDA_EVENTO', entity_id: 'novo1', action: 'CRIADO' });
    expect(data.meta_json).toMatchObject({ before: null, after: { status: 'COMPARECEU' }, assigned_user_id: 'dent1' });
  });

  it('AGENDADO (padrão): não grava auditoria', async () => {
    const { svc, prisma } = montar();
    await svc.create({ ...base, actor_roles: ['OPERADOR'] });
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });

  it('TAREFA criada como CONCLUIDO por não-admin: livre', async () => {
    const { svc, prisma } = montar();
    await svc.create({ ...base, type: 'TAREFA', status: 'CONCLUIDO', actor_roles: [] });
    expect(prisma.calendarEvent.create).toHaveBeenCalled();
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });
});

describe('Fase 0 — listPendingValidation usa o "agora" naive de Maceió', () => {
  afterEach(() => jest.useRealTimers());

  it('9. lte = agoraMaceioNaive() (consultas das próximas 3h não entram)', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-10-19T15:00:00.000Z'));
    const { svc, prisma } = montar();
    await svc.listPendingValidation({ tenantId: TENANT, actorUserId: 'dent1', isAdmin: false, daysBack: 30 });
    const where = prisma.calendarEvent.findMany.mock.calls[0][0].where;
    expect(where.start_at.lte.toISOString()).toBe('2026-10-19T12:00:00.000Z');
    expect(where.start_at.gte.toISOString()).toBe('2026-09-19T12:00:00.000Z');
  });
});

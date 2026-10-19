/**
 * Fase 0 — Grupo 4 (G9): o portal do paciente não confirma nem cancela consulta
 * já realizada/validada, e toda troca de status deixa rastro AGENDA_EVENTO (ator null).
 */
import { BadRequestException } from '@nestjs/common';
import { PortalService } from './portal.service';

function montar(ev: Record<string, unknown>) {
  const evento = { id: 'ev1', tenant_id: 't1', patient_id: 'pat1', status: 'AGENDADO', validated_at: null, description: null, ...ev };
  const prisma: any = {
    calendarEvent: {
      findFirst: jest.fn(async () => evento),
      update: jest.fn(async (args: any) => ({ ...evento, ...args.data })),
    },
    appointmentConfirmation: {
      findFirst: jest.fn(async () => null),
      update: jest.fn(),
    },
    auditLog: { create: jest.fn(async () => ({})) },
  };
  prisma.$transaction = jest.fn(async (fn: any) => fn(prisma));
  return { svc: new PortalService(prisma, {} as any), prisma };
}

describe('Fase 0 — PortalService.confirmAppointment', () => {
  it.each([
    [{ validated_at: new Date() }],
    [{ status: 'CONCLUIDO' }],
    [{ status: 'NO_SHOW' }],
  ])('barra consulta já realizada (%o)', async (ev) => {
    const { svc, prisma } = montar(ev);
    await expect(svc.confirmAppointment('t1', 'pat1', 'ev1')).rejects.toThrow(new BadRequestException('Consulta ja realizada'));
    expect(prisma.calendarEvent.update).not.toHaveBeenCalled();
  });

  it('AGENDADO → CONFIRMADO: audita via portal, ator null', async () => {
    const { svc, prisma } = montar({ status: 'AGENDADO' });
    await svc.confirmAppointment('t1', 'pat1', 'ev1');
    const data = prisma.auditLog.create.mock.calls[0][0].data;
    expect(data).toMatchObject({ tenant_id: 't1', actor_user_id: null, entity: 'AGENDA_EVENTO', entity_id: 'ev1', action: 'STATUS' });
    expect(data.meta_json).toMatchObject({ via: 'portal', patient_id: 'pat1', before: { status: 'AGENDADO' }, after: { status: 'CONFIRMADO' } });
  });

  it('já CONFIRMADO: não duplica rastro', async () => {
    const { svc, prisma } = montar({ status: 'CONFIRMADO' });
    await svc.confirmAppointment('t1', 'pat1', 'ev1');
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });
});

describe('Fase 0 — PortalService.cancelAppointment', () => {
  it('barra consulta validada', async () => {
    const { svc, prisma } = montar({ status: 'COMPARECEU', validated_at: new Date() });
    await expect(svc.cancelAppointment('t1', 'pat1', 'ev1', 'x')).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.calendarEvent.update).not.toHaveBeenCalled();
  });

  it('cancela e audita via portal com o motivo', async () => {
    const { svc, prisma } = montar({ status: 'CONFIRMADO' });
    await svc.cancelAppointment('t1', 'pat1', 'ev1', 'viagem');
    const data = prisma.auditLog.create.mock.calls[0][0].data;
    expect(data).toMatchObject({ actor_user_id: null, action: 'STATUS' });
    expect(data.meta_json).toMatchObject({ via: 'portal', motivo: 'viagem', before: { status: 'CONFIRMADO' }, after: { status: 'CANCELADO' } });
  });
});

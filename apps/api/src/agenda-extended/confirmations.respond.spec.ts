/**
 * Fase 0 — Grupo 4 (G8): "não vou" da confirmação só desmarca consulta ainda por
 * acontecer (AGENDADO/CONFIRMADO, não validada) e deixa rastro AGENDA_EVENTO.
 */
import { ConfirmationsService } from './confirmations.service';

function montar(appointment: { status: string; validated_at?: Date | null }, count = 1) {
  const prisma: any = {
    appointmentConfirmation: {
      findUnique: jest.fn(async () => ({
        id: 'conf1',
        appointment: { id: 'ev1', tenant_id: 't1', type: 'CONSULTA', validated_at: null, ...appointment },
      })),
      update: jest.fn(async (args: any) => ({ id: 'conf1', ...args.data })),
    },
    calendarEvent: {
      update: jest.fn(async () => ({})),
      updateMany: jest.fn(async () => ({ count })),
    },
    auditLog: { create: jest.fn(async () => ({})) },
  };
  return { svc: new ConfirmationsService(prisma), prisma };
}

describe('Fase 0 — ConfirmationsService.respond (REJEITADO)', () => {
  it('desmarca só com claim (não validada, AGENDADO/CONFIRMADO) e audita com o ator', async () => {
    const { svc, prisma } = montar({ status: 'CONFIRMADO' });
    await svc.respond('t1', 'conf1', { response_status: 'REJEITADO' } as any, 'rec1');
    expect(prisma.calendarEvent.updateMany).toHaveBeenCalledWith({
      where: { id: 'ev1', validated_at: null, status: { in: ['AGENDADO', 'CONFIRMADO'] } },
      data: { status: 'CANCELADO' },
    });
    expect(prisma.calendarEvent.update).not.toHaveBeenCalled();
    const data = prisma.auditLog.create.mock.calls[0][0].data;
    expect(data).toMatchObject({ tenant_id: 't1', actor_user_id: 'rec1', entity: 'AGENDA_EVENTO', entity_id: 'ev1', action: 'STATUS' });
    expect(data.meta_json).toMatchObject({ via: 'confirmacao_resposta', before: { status: 'CONFIRMADO' }, after: { status: 'CANCELADO' } });
  });

  it('consulta já validada/atendida (claim count 0): não muda status nem audita', async () => {
    const { svc, prisma } = montar({ status: 'CONCLUIDO', validated_at: new Date() }, 0);
    await svc.respond('t1', 'conf1', { response_status: 'REJEITADO' } as any, 'rec1');
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
    // a resposta em si continua registrada
    expect(prisma.appointmentConfirmation.update).toHaveBeenCalled();
  });
});

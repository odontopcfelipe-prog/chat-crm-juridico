/**
 * Trava "agendou como LEAD → só vai pra Clínica depois de comparecer ou pagar".
 *
 * Regra da clínica: o lead que foi agendado fica no COMERCIAL até a recepção marcar
 * comparecimento (COMPARECEU / EM_ATENDIMENTO / CONCLUIDO) ou entrar algum pagamento.
 * Se ele faltar, continua no funil do comercial pra ser recuperado — na Clínica ele
 * "some no esquecimento".
 *
 * Lead que nunca foi agendado não é afetado (a regra vale só pra quem tem consulta).
 * Função pura sobre o Prisma (sem DI) — pode ser usada por qualquer service sem
 * criar import cruzado entre módulos.
 */

const ATTENDED_STATUSES = ['COMPARECEU', 'EM_ATENDIMENTO', 'CONCLUIDO'];
// Tipos que não são consulta do paciente (não contam como "agendado").
const NON_CLINICAL_TYPES = ['TAREFA', 'PRAZO', 'AUDIENCIA', 'OUTRO', 'DAILY_SUMMARY'];
const PAID_CHARGE_STATUSES = ['RECEIVED', 'CONFIRMED', 'RECEIVED_IN_CASH'];

export const CLINIC_TRANSFER_BLOCKED_MSG =
  'Este lead foi agendado e ainda não compareceu nem pagou. Ele só pode ir para a Clínica ' +
  'depois que a recepção marcar o comparecimento na agenda ou houver algum pagamento.';

/** null = pode ir pra Clínica; string = motivo do bloqueio. */
export async function clinicTransferBlockReason(prisma: any, leadId: string): Promise<string | null> {
  if (!leadId) return null;

  const patients: { id: string }[] = await prisma.patient.findMany({
    where: { lead_id: leadId },
    select: { id: true },
  });
  const patientIds = patients.map((p) => p.id);

  const eventOwner = patientIds.length
    ? { OR: [{ lead_id: leadId }, { patient_id: { in: patientIds } }] }
    : { lead_id: leadId };
  const clinicalEvent = { ...eventOwner, type: { notIn: NON_CLINICAL_TYPES } };

  const scheduled = await prisma.calendarEvent.findFirst({ where: clinicalEvent, select: { id: true } });
  if (!scheduled) return null; // nunca agendado → regra não se aplica

  const attended = await prisma.calendarEvent.findFirst({
    where: { ...clinicalEvent, status: { in: ATTENDED_STATUSES } },
    select: { id: true },
  });
  if (attended) return null;

  // Algum pagamento: cobrança do gateway (por paciente ou pelo cliente do lead),
  // parcela paga ou receita lançada no caixa pro lead.
  const customers: { external_id: string }[] = await prisma.paymentGatewayCustomer.findMany({
    where: { lead_id: leadId },
    select: { external_id: true },
  });
  const chargeOwner: any[] = [];
  if (patientIds.length) chargeOwner.push({ patient_id: { in: patientIds } });
  if (customers.length) chargeOwner.push({ customer_external_id: { in: customers.map((c) => c.external_id) } });
  if (chargeOwner.length) {
    const paidCharge = await prisma.paymentGatewayCharge.findFirst({
      where: {
        AND: [
          { OR: chargeOwner },
          { OR: [{ status: { in: PAID_CHARGE_STATUSES } }, { received_in_cash: true }] },
        ],
      },
      select: { id: true },
    });
    if (paidCharge) return null;
  }
  if (patientIds.length) {
    const paidInstallment = await prisma.installment.findFirst({
      where: { patient_id: { in: patientIds }, status: { in: ['PAGA', 'PARCIAL'] } },
      select: { id: true },
    });
    if (paidInstallment) return null;
  }
  const receipt = await prisma.financialTransaction.findFirst({
    where: { lead_id: leadId, type: 'RECEITA', status: 'PAGO' },
    select: { id: true },
  });
  if (receipt) return null;

  return CLINIC_TRANSFER_BLOCKED_MSG;
}

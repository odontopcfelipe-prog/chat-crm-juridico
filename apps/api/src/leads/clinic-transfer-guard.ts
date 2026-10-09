/**
 * Regra da clínica — LEAD × PACIENTE:
 *
 *   Vira PACIENTE (de fato) quem COMPARECEU (agenda COMPARECEU / EM_ATENDIMENTO /
 *   CONCLUIDO) ou EFETUOU ALGUM PAGAMENTO. Até lá é LEAD (Comercial). Se ele
 *   faltar, continua no funil do comercial pra ser recuperado — na Clínica ele
 *   "some no esquecimento".
 *
 *   - patientEvidence: o que o contato tem (agendou / compareceu / pagou).
 *   - clinicTransferBlockReason: trava das ações MANUAIS (mover setor, promover,
 *     arrastar pra ganho): só barra quem foi agendado e ainda não compareceu nem
 *     pagou. Lead nunca agendado passa (paciente antigo, de antes do sistema).
 *   - promoteLeadInBackground: gatilhos AUTOMÁTICOS (agenda, Asaas, caixa,
 *     Financeiro) chamam LeadsService.promoteToPatientIfEligible, que exige
 *     comparecimento ou pagamento.
 *
 * Funções puras sobre o Prisma (sem DI) — usadas por qualquer service sem criar
 * import cruzado entre módulos (o LeadsService é resolvido em runtime).
 */

import { nearestStageIn } from '@crm/shared';
import type { PrismaService } from '../prisma/prisma.service';

export const ATTENDED_STATUSES = ['COMPARECEU', 'EM_ATENDIMENTO', 'CONCLUIDO'];
// Só atendimento do paciente conta (mesma lista do isClinicalEvent da agenda) —
// BLOQUEIO, TAREFA, PERÍCIA etc. não são "agendou" nem "compareceu".
const CLINICAL_TYPES = ['CONSULTA', 'PROCEDIMENTO', 'RETORNO', 'ORTODONTIA'];
const PAID_CHARGE_STATUSES = ['RECEIVED', 'CONFIRMED', 'RECEIVED_IN_CASH'];

export const CLINIC_TRANSFER_BLOCKED_MSG =
  'Este lead foi agendado e ainda não compareceu nem pagou. Ele só pode ir para a Clínica ' +
  'depois que a recepção marcar o comparecimento na agenda ou houver algum pagamento.';

export interface PatientEvidence {
  /** Tem consulta (de qualquer status) na agenda. */
  scheduled: boolean;
  /** Alguma consulta marcada como COMPARECEU / EM_ATENDIMENTO / CONCLUIDO. */
  attended: boolean;
  /** Algum pagamento: cobrança paga, parcela paga ou receita paga no caixa. */
  paid: boolean;
}

export async function patientEvidence(prisma: PrismaService, leadId: string): Promise<PatientEvidence> {
  const none: PatientEvidence = { scheduled: false, attended: false, paid: false };
  if (!leadId) return none;

  const patients: { id: string }[] = await prisma.patient.findMany({
    where: { lead_id: leadId },
    select: { id: true },
  });
  const patientIds = patients.map((p) => p.id);

  const eventOwner = patientIds.length
    ? { OR: [{ lead_id: leadId }, { patient_id: { in: patientIds } }] }
    : { lead_id: leadId };
  const clinicalEvent = { ...eventOwner, type: { in: CLINICAL_TYPES } };

  const [scheduled, attended] = await Promise.all([
    prisma.calendarEvent.findFirst({ where: clinicalEvent, select: { id: true } }),
    prisma.calendarEvent.findFirst({
      where: { ...clinicalEvent, status: { in: ATTENDED_STATUSES } },
      select: { id: true },
    }),
  ]);
  const base = { scheduled: !!scheduled, attended: !!attended };
  if (attended) return { ...base, paid: false };

  // Algum pagamento: cobrança do gateway (por paciente ou pelo cliente do lead),
  // parcela paga ou receita lançada no caixa pro lead.
  const customers: { external_id: string }[] = await prisma.paymentGatewayCustomer.findMany({
    where: { lead_id: leadId },
    select: { external_id: true },
  });
  const chargeOwner: any[] = [];
  if (patientIds.length) {
    chargeOwner.push({ patient_id: { in: patientIds } });
    // Cobranças do PLANO / da PARCELA (sinal, entrada, venda local 'CASH') não têm
    // patient_id — o paciente vem pelo plano ou pela parcela.
    chargeOwner.push({ treatment_plan: { patient_id: { in: patientIds } } });
    chargeOwner.push({ installment: { patient_id: { in: patientIds } } });
  }
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
    if (paidCharge) return { ...base, paid: true };
  }
  if (patientIds.length) {
    const paidInstallment = await prisma.installment.findFirst({
      where: { patient_id: { in: patientIds }, status: { in: ['PAGA', 'PARCIAL'] } },
      select: { id: true },
    });
    if (paidInstallment) return { ...base, paid: true };
  }
  const receipt = await prisma.financialTransaction.findFirst({
    where: { lead_id: leadId, type: 'RECEITA', status: 'PAGO' },
    select: { id: true },
  });
  return { ...base, paid: !!receipt };
}

/** Trava das ações MANUAIS. null = pode ir pra Clínica; string = motivo do bloqueio. */
export async function clinicTransferBlockReason(prisma: PrismaService, leadId: string): Promise<string | null> {
  if (!leadId) return null;
  const ev = await patientEvidence(prisma, leadId);
  if (!ev.scheduled) return null; // nunca agendado → regra não se aplica
  if (ev.attended || ev.paid) return null;
  return CLINIC_TRANSFER_BLOCKED_MSG;
}

/**
 * Contato devolvido ao Comercial (deixou de ser paciente): se a etapa do funil
 * está em "ganho", leva pra etapa ATIVA equivalente a negociação
 * (orçamento; no funil que não tem, a anterior mais próxima). {} = não mexe.
 * Sem isso o card voltava pro Comercial mas sumia do CRC (stage_id em "ganho").
 */
export async function workStageAfterDemotion(
  prisma: PrismaService,
  lead: { pipeline_id?: string | null; stage_id?: string | null },
): Promise<{ stage_id?: string }> {
  if (!lead.pipeline_id || !lead.stage_id) return {};
  const stages = await prisma.pipelineStage.findMany({
    where: { pipeline_id: lead.pipeline_id },
    orderBy: { position: 'asc' },
  });
  const current = stages.find((s: any) => s.id === lead.stage_id);
  // Só sai do "ganho". "Em fechamento" (oculta) fica: o card vive no CRC Fechamentos.
  if (!current || !current.is_won) return {};
  const target =
    nearestStageIn(stages, 'orcamento', { workOnly: true }) ??
    stages.find((s: any) => s.is_initial) ??
    null;
  return target && target.id !== lead.stage_id ? { stage_id: target.id } : {};
}

/**
 * Lead de uma cobrança. As cobranças que o sistema cria (sinal/entrada, parcelas
 * do plano, venda local 'CASH') quase nunca têm patient_id — o dono vem pelo
 * PLANO ou pela PARCELA. Ordem: paciente da cobrança → paciente do plano →
 * paciente da parcela → cliente do gateway (nunca o placeholder 'CASH').
 */
export async function leadIdForCharge(prisma: PrismaService, chargeId: string): Promise<string | null> {
  const charge = await prisma.paymentGatewayCharge.findUnique({
    where: { id: chargeId },
    select: {
      customer_external_id: true,
      patient: { select: { lead_id: true } },
      treatment_plan: { select: { patient: { select: { lead_id: true } } } },
      installment: { select: { patient: { select: { lead_id: true } } } },
    },
  });
  if (!charge) return null;
  const direct =
    charge.patient?.lead_id ??
    charge.treatment_plan?.patient?.lead_id ??
    charge.installment?.patient?.lead_id ??
    null;
  if (direct) return direct;
  if (charge.customer_external_id && charge.customer_external_id !== 'CASH') {
    // lead_id é obrigatório em PaymentGatewayCustomer (sem filtro `not: null` —
    // o Prisma rejeita `not: null` em coluna obrigatória).
    const c = await prisma.paymentGatewayCustomer.findFirst({
      where: { external_id: charge.customer_external_id },
      select: { lead_id: true },
    });
    if (c?.lead_id) return c.lead_id;
  }
  return null;
}

/**
 * Gatilho automático (compareceu / pagou): chama
 * LeadsService.promoteToPatientIfEligible em segundo plano. Nunca derruba o
 * chamador (agenda, webhook, caixa) — só loga.
 */
export function promoteLeadInBackground(
  moduleRef: any,
  logger: { warn: (m: string) => void },
  leadId: string | null | undefined,
  tenantId: string | null | undefined,
  source: string,
): void {
  if (!leadId || !tenantId || !moduleRef) return;
  try {
    // Resolvido em runtime (require + strict:false) pra não criar ciclo de módulos.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { LeadsService } = require('./leads.service');
    const leads = moduleRef.get(LeadsService, { strict: false });
    if (!leads?.promoteToPatientIfEligible) return;
    leads
      .promoteToPatientIfEligible(leadId, tenantId, source)
      .catch((e: any) => logger.warn(`[LEAD→PACIENTE] ${source}: falhou p/ lead ${leadId}: ${e?.message}`));
  } catch (e: any) {
    logger.warn(`[LEAD→PACIENTE] ${source}: LeadsService indisponível: ${e?.message}`);
  }
}

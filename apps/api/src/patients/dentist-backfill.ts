/**
 * Out/2026 — "Organizar pacientes por dentista" (dados ANTIGOS, decisão do dono).
 *
 * Preenche SÓ o que está vazio (nunca troca um dentista já escolhido), com
 * PRÉVIA antes de gravar:
 *   1. QuoteItem sem dentista (orçamento não apagado, DRAFT/SENT/ACCEPTED) →
 *      dentista da ÁREA do procedimento (preferindo quem montou, se for da área);
 *      ninguém da área → quem montou, se for dentista.
 *   2. TreatmentPlanItem sem dentista → o do item equivalente do orçamento do plano
 *      (mesmo procedimento + dente); senão quem executou (se dentista); senão área.
 *   3. Paciente sem "dentista responsável" → dentista da 1ª consulta clínica
 *      confirmada (CONCLUIDO/compareceu/validada).
 * planDentistBackfill é puro (testável); load/apply fazem o I/O.
 */
import type { PrismaService } from '../prisma/prisma.service';
import { pickDentistForProcedure, type RoutingDentist } from '@crm/shared';
import { loadTenantDentists } from '../common/utils/tenant-dentists';

interface ProcInfo { name?: string | null; category?: string | null; specialty?: { name?: string | null } | null }
export interface BfQuoteItem {
  id: string; quote_id: string; procedure_id: string; tooth_fdi: string | null; order_index: number;
  dentist_id: string | null; procedure: ProcInfo | null; quote_created_by: string | null;
  /** false = orçamento fora de DRAFT/SENT/ACCEPTED: só serve de referência, não recebe dentista. */
  assignable?: boolean;
}
export interface BfPlanItem {
  id: string; plan_quote_id: string | null; procedure_id: string; tooth_fdi: string | null; order_index: number;
  executed_by_user_id: string | null; procedure: ProcInfo | null;
}
export interface BfPatient { id: string; lead_id: string | null }
export interface BfEvent { patient_id: string | null; lead_id: string | null; assigned_user_id: string | null; start_at: Date }

export interface BackfillPlan {
  quoteItems: { id: string; dentist_id: string }[];
  planItems: { id: string; dentist_id: string }[];
  primary: { id: string; dentist_id: string }[];
  semDentista: { quoteItems: number; planItems: number; patients: number };
}

const toRouting = (p: ProcInfo | null) => ({ name: p?.name, category: p?.category, specialty: p?.specialty?.name });

export function planDentistBackfill(input: {
  dentists: RoutingDentist[];
  quoteItems: BfQuoteItem[];          // TODOS os itens dos orçamentos envolvidos (com e sem dentista)
  planItems: BfPlanItem[];            // itens de plano SEM dentista
  patients: BfPatient[];              // pacientes SEM responsável
  attendedEvents: BfEvent[];          // consultas clínicas confirmadas (ordem crescente de data)
}): BackfillPlan {
  const dentistIds = new Set(input.dentists.map((d) => d.id));
  const isDentist = (id: string | null | undefined) => !!id && dentistIds.has(id);

  // 1) itens de orçamento sem dentista
  const quoteItems: BackfillPlan['quoteItems'] = [];
  const qiDentist = new Map<string, string | null>(); // id → dentista (existente ou novo)
  let qiSem = 0;
  for (const qi of input.quoteItems) {
    if (qi.dentist_id) { qiDentist.set(qi.id, qi.dentist_id); continue; }
    if (qi.assignable === false) { qiDentist.set(qi.id, null); continue; }
    const prefer = isDentist(qi.quote_created_by) ? qi.quote_created_by : null;
    const d = pickDentistForProcedure(toRouting(qi.procedure), input.dentists, { preferUserId: prefer });
    qiDentist.set(qi.id, d);
    if (d) quoteItems.push({ id: qi.id, dentist_id: d }); else qiSem += 1;
  }

  // 2) itens de plano sem dentista → item equivalente do orçamento do plano
  const byQuote = new Map<string, BfQuoteItem[]>();
  for (const qi of input.quoteItems) {
    const l = byQuote.get(qi.quote_id) ?? [];
    l.push(qi);
    byQuote.set(qi.quote_id, l);
  }
  const planItems: BackfillPlan['planItems'] = [];
  let piSem = 0;
  for (const pi of input.planItems) {
    let d: string | null = null;
    const cands = pi.plan_quote_id ? (byQuote.get(pi.plan_quote_id) ?? []) : [];
    const same = cands.filter((q) => q.procedure_id === pi.procedure_id && (q.tooth_fdi ?? null) === (pi.tooth_fdi ?? null));
    const match = same.find((q) => q.order_index === pi.order_index) ?? same[0];
    if (match) d = qiDentist.get(match.id) ?? null;
    if (!d && isDentist(pi.executed_by_user_id)) d = pi.executed_by_user_id;
    if (!d) d = pickDentistForProcedure(toRouting(pi.procedure), input.dentists);
    if (d) planItems.push({ id: pi.id, dentist_id: d }); else piSem += 1;
  }

  // 3) paciente sem responsável → 1ª consulta confirmada (a MAIS ANTIGA, ligada
  //    pela ficha OU pelo lead do paciente — consulta antiga costuma ser só do lead).
  const patientIds = new Set(input.patients.map((p) => p.id));
  const leadToPatient = new Map<string, string>();
  for (const p of input.patients) if (p.lead_id) leadToPatient.set(p.lead_id, p.id);
  const first = new Map<string, { at: number; dentist: string }>();
  for (const ev of input.attendedEvents) {
    if (!isDentist(ev.assigned_user_id)) continue;
    const pid = ev.patient_id && patientIds.has(ev.patient_id)
      ? ev.patient_id
      : (ev.lead_id ? leadToPatient.get(ev.lead_id) : undefined);
    if (!pid) continue;
    const at = ev.start_at.getTime();
    const cur = first.get(pid);
    if (!cur || at < cur.at) first.set(pid, { at, dentist: ev.assigned_user_id as string });
  }
  const primary: BackfillPlan['primary'] = [];
  let ptSem = 0;
  for (const p of input.patients) {
    const d = first.get(p.id)?.dentist ?? null;
    if (d) primary.push({ id: p.id, dentist_id: d }); else ptSem += 1;
  }

  return { quoteItems, planItems, primary, semDentista: { quoteItems: qiSem, planItems: piSem, patients: ptSem } };
}

export async function loadDentistBackfill(prisma: PrismaService, tenantId: string) {
  const dentists = await loadTenantDentists(prisma, tenantId);
  const procSel = { select: { name: true, category: true, specialty: { select: { name: true } } } };

  const [qiNull, planItemsRaw, patients] = await Promise.all([
    prisma.quoteItem.findMany({
      where: {
        dentist_id: null,
        quote: { deleted_at: null, status: { in: ['DRAFT', 'SENT', 'ACCEPTED'] }, patient: { tenant_id: tenantId } },
      },
      select: { quote_id: true },
    }),
    prisma.treatmentPlanItem.findMany({
      where: { dentist_id: null, status: { not: 'CANCELLED' }, treatment_plan: { patient: { tenant_id: tenantId } } },
      select: {
        id: true, procedure_id: true, tooth_fdi: true, order_index: true, executed_by_user_id: true,
        treatment_plan: { select: { quote_id: true } }, procedure: procSel,
      },
    }),
    prisma.patient.findMany({ where: { tenant_id: tenantId, primary_dentist_id: null }, select: { id: true, lead_id: true } }),
  ]);

  // Todos os itens dos orçamentos envolvidos (os sem dentista + os dos planos).
  const quoteIds = [...new Set([
    ...qiNull.map((q) => q.quote_id),
    ...planItemsRaw.map((p) => p.treatment_plan.quote_id).filter((x): x is string => !!x),
  ])];
  const qiRaw = quoteIds.length
    ? await prisma.quoteItem.findMany({
        where: { quote_id: { in: quoteIds }, quote: { deleted_at: null } },
        select: {
          id: true, quote_id: true, procedure_id: true, tooth_fdi: true, order_index: true, dentist_id: true,
          procedure: procSel, quote: { select: { created_by_user_id: true, status: true } },
        },
      })
    : [];

  const ids = patients.map((p) => p.id);
  const leadIds = patients.map((p) => p.lead_id).filter((x): x is string => !!x);
  const attendedEvents = ids.length
    ? await prisma.calendarEvent.findMany({
        where: {
          tenant_id: tenantId,
          assigned_user_id: { in: dentists.map((d) => d.id) },
          type: { in: ['CONSULTA', 'PROCEDIMENTO', 'RETORNO', 'ORTODONTIA'] },
          AND: [
            { OR: [{ validated_at: { not: null } }, { status: { in: ['CONCLUIDO', 'COMPARECEU', 'EM_ATENDIMENTO'] } }] },
            { OR: [{ patient_id: { in: ids } }, ...(leadIds.length ? [{ lead_id: { in: leadIds } }] : [])] },
          ],
        },
        select: { patient_id: true, lead_id: true, assigned_user_id: true, start_at: true },
        orderBy: { start_at: 'asc' },
      })
    : [];

  const plan = planDentistBackfill({
    dentists,
    // Só itens de orçamento DRAFT/SENT/ACCEPTED recebem dentista novo; os de outros
    // status entram só como referência pros itens de plano.
    quoteItems: qiRaw.map((q) => ({
      id: q.id, quote_id: q.quote_id, procedure_id: q.procedure_id, tooth_fdi: q.tooth_fdi, order_index: q.order_index,
      dentist_id: q.dentist_id, procedure: q.procedure, quote_created_by: q.quote.created_by_user_id,
      assignable: ['DRAFT', 'SENT', 'ACCEPTED'].includes(q.quote.status),
    })),
    planItems: planItemsRaw.map((p) => ({
      id: p.id, plan_quote_id: p.treatment_plan.quote_id, procedure_id: p.procedure_id, tooth_fdi: p.tooth_fdi,
      order_index: p.order_index, executed_by_user_id: p.executed_by_user_id, procedure: p.procedure,
    })),
    patients,
    attendedEvents,
  });
  return { dentists, plan };
}

/** Resumo da prévia por dentista (pra tela). */
export function summarizeBackfill(dentists: RoutingDentist[], plan: BackfillPlan) {
  const name = new Map(dentists.map((d) => [d.id, d.name ?? 'Dentista']));
  const rows = new Map<string, { dentist_id: string; nome: string; procedimentos_orcamento: number; procedimentos_plano: number; pacientes_responsavel: number }>();
  const row = (id: string) => {
    let r = rows.get(id);
    if (!r) { r = { dentist_id: id, nome: name.get(id) ?? 'Dentista', procedimentos_orcamento: 0, procedimentos_plano: 0, pacientes_responsavel: 0 }; rows.set(id, r); }
    return r;
  };
  plan.quoteItems.forEach((q) => { row(q.dentist_id).procedimentos_orcamento += 1; });
  plan.planItems.forEach((q) => { row(q.dentist_id).procedimentos_plano += 1; });
  plan.primary.forEach((q) => { row(q.dentist_id).pacientes_responsavel += 1; });
  return {
    por_dentista: [...rows.values()].sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR')),
    totais: {
      procedimentos_orcamento: plan.quoteItems.length,
      procedimentos_plano: plan.planItems.length,
      pacientes_responsavel: plan.primary.length,
    },
    sem_dentista: plan.semDentista,
  };
}

/** Grava (só onde ainda está vazio — updateMany com dentist_id/primary null). */
export async function applyDentistBackfill(prisma: PrismaService, plan: BackfillPlan) {
  let qi = 0, pi = 0, pt = 0;
  const chunk = <T>(arr: T[], n: number) => Array.from({ length: Math.ceil(arr.length / n) }, (_, i) => arr.slice(i * n, i * n + n));
  for (const part of chunk(plan.quoteItems, 200)) {
    const rs = await prisma.$transaction(part.map((q) =>
      prisma.quoteItem.updateMany({ where: { id: q.id, dentist_id: null }, data: { dentist_id: q.dentist_id } })));
    qi += rs.reduce((s, r) => s + r.count, 0);
  }
  for (const part of chunk(plan.planItems, 200)) {
    const rs = await prisma.$transaction(part.map((q) =>
      prisma.treatmentPlanItem.updateMany({ where: { id: q.id, dentist_id: null }, data: { dentist_id: q.dentist_id } })));
    pi += rs.reduce((s, r) => s + r.count, 0);
  }
  for (const part of chunk(plan.primary, 200)) {
    const rs = await prisma.$transaction(part.map((q) =>
      prisma.patient.updateMany({ where: { id: q.id, primary_dentist_id: null }, data: { primary_dentist_id: q.dentist_id } })));
    pt += rs.reduce((s, r) => s + r.count, 0);
  }
  return { procedimentos_orcamento: qi, procedimentos_plano: pi, pacientes_responsavel: pt };
}

/**
 * Out/2026 — "Por que este paciente é deste dentista" + "de onde ele veio".
 *
 * Um paciente pode ser de vários dentistas (cada área um procedimento). Pra lista
 * "Meus pacientes" (e o filtro por dentista do admin), cada paciente ganha SELOS
 * com o motivo do vínculo COM AQUELE dentista, na ordem:
 *   Agendado (próxima consulta) · Atendido por você · Indicado por X (avaliação de
 *   outro) / Venda rápida / Avaliação sua · procedimentos seus no plano ·
 *   Responsável · Ortodontia
 * e a ORIGEM do paciente (Lead.origin / indicação de outro paciente).
 *
 * Mesmas fontes de ownPatientsWhere (auth/patient-scope.ts). Consultas em lote
 * pros ids da página (nada de N+1). Datas de consulta em naive-UTC.
 */
import type { PrismaService } from '../prisma/prisma.service';
// Mesma marca de isVendaRapidaQuote (commercial/quotes.service.ts) — copiada de
// propósito: importar o serviço de orçamentos aqui criaria ciclo de import entre
// módulos Nest (já derrubou a API em crash loop).
const norm = (s: string | null | undefined) =>
  String(s ?? '').normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase().trim();
function isVendaRapidaQuote(q: { title?: string | null; notes?: string | null }): boolean {
  return norm(q.title).startsWith('venda rapida') || norm(q.notes).startsWith('venda rapida');
}

export type LinkTone = 'violet' | 'emerald' | 'amber' | 'sky' | 'rose' | 'slate';
export interface DentistLink { key: string; label: string; tone: LinkTone }

export interface LinkPatient {
  id: string;
  lead_id: string | null;
  primary_dentist_id: string | null;
  ortho_dentist_id: string | null;
}

const CLINICAL_TYPES = ['CONSULTA', 'PROCEDIMENTO', 'RETORNO', 'ORTODONTIA'];

const ddmm = (d: Date) =>
  `${String(d.getUTCDate()).padStart(2, '0')}/${String(d.getUTCMonth() + 1).padStart(2, '0')}`;

const firstName = (n: string | null | undefined) => String(n ?? '').trim().split(/\s+/).slice(0, 2).join(' ') || 'outro profissional';

/** Origem legível (Lead.origin é texto livre). null = não mostra. */
export function originLabel(origin: string | null | undefined): string | null {
  const o = String(origin ?? '').trim();
  if (!o) return null;
  const k = o.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();
  if (k === 'auto_created_from_patient' || k === 'manual') return null;
  const MAP: Record<string, string> = {
    whatsapp: 'WhatsApp', cadastro_manual: 'Cadastro na clínica', asaas_import: 'Importado',
    aniversario: 'Aniversário', indicacao: 'Indicação', instagram: 'Instagram', google: 'Google',
    facebook: 'Facebook', site: 'Site', landing: 'Site',
  };
  return MAP[k] ?? o.charAt(0).toUpperCase() + o.slice(1);
}

export async function computeDentistLinks(
  prisma: PrismaService,
  tenantId: string,
  dentistId: string,
  patients: LinkPatient[],
  now = Date.now(),
): Promise<Record<string, DentistLink[]>> {
  const out: Record<string, DentistLink[]> = {};
  if (patients.length === 0) return out;
  const ids = patients.map((p) => p.id);
  const leadToPatient = new Map<string, string>();
  for (const p of patients) if (p.lead_id) leadToPatient.set(p.lead_id, p.id);
  const naiveNow = new Date(now - 3 * 60 * 60 * 1000);

  const [events, quoteItems, ownQuotes, planItems] = await Promise.all([
    prisma.calendarEvent.findMany({
      where: {
        tenant_id: tenantId,
        assigned_user_id: dentistId,
        type: { in: CLINICAL_TYPES },
        status: { notIn: ['CANCELADO'] },
        OR: [
          { patient_id: { in: ids } },
          ...(leadToPatient.size ? [{ lead_id: { in: [...leadToPatient.keys()] } }] : []),
        ],
      },
      select: { patient_id: true, lead_id: true, start_at: true, status: true, validated_at: true },
    }),
    prisma.quoteItem.findMany({
      where: { dentist_id: dentistId, quote: { patient_id: { in: ids }, deleted_at: null } },
      select: {
        quote: {
          select: {
            patient_id: true, title: true, notes: true, created_by_user_id: true,
            created_by: { select: { name: true } },
          },
        },
      },
    }),
    prisma.quote.findMany({
      where: { patient_id: { in: ids }, created_by_user_id: dentistId, deleted_at: null, items: { some: {} } },
      select: { patient_id: true },
    }),
    prisma.treatmentPlanItem.findMany({
      where: { dentist_id: dentistId, treatment_plan: { patient_id: { in: ids } }, status: { not: 'CANCELLED' } },
      select: { status: true, treatment_plan: { select: { patient_id: true } } },
    }),
  ]);

  type Acc = {
    next?: Date; last?: Date; avaliacaoSua?: boolean; vendaRapida?: boolean;
    indicadoPor: Set<string>; planPend: number; planDone: number;
  };
  const acc = new Map<string, Acc>();
  const get = (pid: string) => {
    let a = acc.get(pid);
    if (!a) { a = { indicadoPor: new Set(), planPend: 0, planDone: 0 }; acc.set(pid, a); }
    return a;
  };

  for (const ev of events) {
    const pid = ev.patient_id ?? (ev.lead_id ? leadToPatient.get(ev.lead_id) : undefined);
    if (!pid) continue;
    const a = get(pid);
    if (ev.start_at >= naiveNow) {
      if (!a.next || ev.start_at < a.next) a.next = ev.start_at;
    } else if (ev.validated_at || ev.status === 'CONCLUIDO' || ev.status === 'COMPARECEU' || ev.status === 'EM_ATENDIMENTO') {
      if (!a.last || ev.start_at > a.last) a.last = ev.start_at;
    }
  }
  for (const qi of quoteItems) {
    const q = qi.quote;
    const a = get(q.patient_id);
    if (isVendaRapidaQuote(q)) a.vendaRapida = true;
    else if (q.created_by_user_id === dentistId) a.avaliacaoSua = true;
    else a.indicadoPor.add(firstName(q.created_by?.name));
  }
  for (const q of ownQuotes) get(q.patient_id).avaliacaoSua = true;
  for (const it of planItems) {
    const a = get(it.treatment_plan.patient_id);
    if (it.status === 'DONE') a.planDone += 1; else a.planPend += 1;
  }

  for (const p of patients) {
    const a = acc.get(p.id);
    const chips: DentistLink[] = [];
    if (a?.next) chips.push({ key: 'agendado', label: `Agendado ${ddmm(a.next)}`, tone: 'violet' });
    if (a?.last) chips.push({ key: 'atendido', label: `Atendido por você ${ddmm(a.last)}`, tone: 'emerald' });
    if (a && a.indicadoPor.size) chips.push({ key: 'indicado', label: `Indicado por ${[...a.indicadoPor].join(', ')}`, tone: 'amber' });
    if (a?.vendaRapida) chips.push({ key: 'venda_rapida', label: 'Venda rápida', tone: 'sky' });
    if (a?.avaliacaoSua) chips.push({ key: 'avaliacao', label: 'Avaliação sua', tone: 'sky' });
    if (a && a.planPend > 0) {
      chips.push({ key: 'plano', label: `${a.planPend} procedimento${a.planPend > 1 ? 's' : ''} seu${a.planPend > 1 ? 's' : ''} no plano`, tone: 'emerald' });
    } else if (a && a.planDone > 0) {
      chips.push({ key: 'plano_ok', label: 'Seus procedimentos concluídos', tone: 'slate' });
    }
    if (p.primary_dentist_id === dentistId) chips.push({ key: 'responsavel', label: 'Responsável', tone: 'slate' });
    if (p.ortho_dentist_id === dentistId) chips.push({ key: 'orto', label: 'Ortodontia', tone: 'rose' });
    out[p.id] = chips;
  }
  return out;
}

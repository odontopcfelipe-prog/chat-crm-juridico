/**
 * Selos do evento da agenda — "IA" (marcado pela assistente no WhatsApp) e "Novo"
 * (paciente novo: ainda não compareceu nem pagou).
 *
 * Usado no card do schedule-x (HTML string, via _customContent), no "Próximos",
 * no tooltip, na Lista e no modal do evento. Estilo em agenda-theme.css (.ag-flag*),
 * com cor misturada aos tokens do tema (--text-primary / --bg-primary) → legível
 * em claro e escuro sem regra por tema.
 *
 * Regra de "paciente novo" (mesma do clinic-transfer-guard da API): o contato vira
 * PACIENTE quando compareceu ou pagou — aí o lead ganha is_client=true e/ou o evento
 * passa a ter ficha (patient_id). Enquanto o evento só tem LEAD com is_client=false,
 * é paciente novo. Sem contato nenhum ligado não dá pra afirmar nada → sem selo.
 */

import { Bot, UserPlus } from 'lucide-react';

/** Tipos que são atendimento de paciente (os demais — Bloqueio/Tarefa/Outro — não levam selo). */
export const AGENDA_PATIENT_TYPES: string[] = ['CONSULTA', 'PROCEDIMENTO', 'RETORNO', 'ORTODONTIA'];

/** Status em que o paciente já está na clínica (comparecimento). */
const ATTENDED_STATUSES = ['COMPARECEU', 'EM_ATENDIMENTO', 'CONCLUIDO'];

export interface AgendaFlagEvent {
  type: string;
  status?: string | null;
  created_by_ai?: boolean | null;
  patient_id?: string | null;
  patient?: { id: string } | null;
  lead_id?: string | null;
  lead?: { is_client?: boolean | null } | null;
}

/** Marcado pela IA (book_appointment grava created_by_ai=true). */
export function isAiBookedEvent(ev: AgendaFlagEvent): boolean {
  return ev.created_by_ai === true && AGENDA_PATIENT_TYPES.includes(ev.type);
}

/** Paciente novo: sem ficha ligada + lead que ainda não virou paciente (is_client=false). */
export function isNewPatientEvent(ev: AgendaFlagEvent): boolean {
  if (!AGENDA_PATIENT_TYPES.includes(ev.type)) return false;
  if (ev.patient_id || ev.patient) return false;
  return !!ev.lead && ev.lead.is_client === false;
}

/** Texto do detalhe: "ainda não compareceu" só faz sentido antes do comparecimento. */
export function newPatientDetail(ev: AgendaFlagEvent): string {
  return ATTENDED_STATUSES.includes(String(ev.status || ''))
    ? 'Paciente novo — primeira visita'
    : 'Paciente novo — ainda não compareceu';
}

// lucide "bot" (mesmo ícone de IA usado no chat) como SVG cru — o card do schedule-x
// é HTML string (dangerouslySetInnerHTML), não dá pra renderizar componente React.
const BOT_SVG =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<path d="M12 8V4H8"/><rect width="16" height="12" x="4" y="8" rx="2"/><path d="M2 14h2"/><path d="M20 14h2"/><path d="M15 13v2"/><path d="M9 13v2"/></svg>';

/**
 * Selos em HTML pro card do schedule-x.
 *  - 'full': "[robô] IA" + "Novo" (linha do horário do card / mês).
 *  - 'mini': só o robô + "Novo" (prefixo do nome quando o card é curto/estreito
 *    e a linha do horário some).
 */
export function agendaFlagsHtml(ev: AgendaFlagEvent, variant: 'full' | 'mini' = 'full'): string {
  const ai = isAiBookedEvent(ev);
  const novo = isNewPatientEvent(ev);
  if (!ai && !novo) return '';
  let html = '';
  if (ai) {
    html += variant === 'mini'
      ? `<span class="ag-flag ag-flag-ia ag-flag-icon" title="Agendado pela IA">${BOT_SVG}</span>`
      : `<span class="ag-flag ag-flag-ia" title="Agendado pela IA">${BOT_SVG}IA</span>`;
  }
  if (novo) {
    html += `<span class="ag-flag ag-flag-new" title="Paciente novo (ainda não compareceu)">Novo</span>`;
  }
  return html;
}

/** Selos em React (Próximos, Lista, tooltip, modal). `long` = "Agendado pela IA" / "Paciente novo". */
export function AgendaFlagChips({
  event,
  size = 'sm',
  long = false,
  className = '',
}: {
  event: AgendaFlagEvent;
  size?: 'sm' | 'lg';
  long?: boolean;
  className?: string;
}) {
  const ai = isAiBookedEvent(event);
  const novo = isNewPatientEvent(event);
  if (!ai && !novo) return null;
  const sz = size === 'lg' ? ' ag-flag-lg' : '';
  return (
    <span className={`inline-flex items-center gap-1 shrink-0 ${className}`}>
      {ai && (
        <span className={`ag-flag ag-flag-ia${sz}`} title="Agendado pela IA">
          <Bot aria-hidden="true" />
          {long ? 'Agendado pela IA' : 'IA'}
        </span>
      )}
      {novo && (
        <span className={`ag-flag ag-flag-new${sz}`} title={newPatientDetail(event)}>
          {long && <UserPlus aria-hidden="true" />}
          {long ? newPatientDetail(event) : 'Novo'}
        </span>
      )}
    </span>
  );
}

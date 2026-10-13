/**
 * Quem escreveu cada mensagem do histórico que vai pro LLM (historyText e os
 * turnos multi-turn do ai.processor).
 *
 * O prefixo do external_message_id NÃO diz mais quem mandou: a IA grava o balão
 * com o key.id real da Evolution, o painel troca o `out_*` pelo id real depois do
 * envio e o eco do webhook troca qualquer `sys_*`/`out_*` otimista pelo real. Antes
 * toda 'out' sem `sys_` virava "[Operador Humano]" — inclusive as respostas da
 * própria IA (com as ofertas de horário), e o modelo lia as próprias mensagens
 * como se um humano as tivesse escrito.
 *
 * - 'assistant'  : a própria IA — skill_id preenchido (a PromptSkill que gerou a
 *                  resposta; o eco do webhook só troca o id, o skill_id fica) ou id
 *                  `sys_ai_*` (ainda não reconciliado / chat de teste).
 * - 'automation' : disparo automático (follow-up, broadcast, régua de reativação,
 *                  lembretes, cobrança…): `sys_*` que não é da IA, id gravado num
 *                  DispatchLog / LeadDispatch, ou saiu junto (±3 min) com uma
 *                  FollowupMessage/BroadcastItem/DispatchLog 'followup_lead' — o eco
 *                  troca o id, o horário do envio fica (ver reativacao-dados.ts).
 * - 'operator'   : o resto — humano pelo painel (`out_*` ou id real) ou pelo celular.
 */
import type { PrismaService } from '../prisma/prisma.service';
import { temposDeAutomacaoDoLead } from '../reativacao/reativacao-dados';
import { TOLERANCIA_AUTOMACAO_MS, ehSaidaAutomatica } from '../reativacao/reativacao-regras';

export type HistorySender = 'client' | 'assistant' | 'automation' | 'operator';

export interface HistoryMessageLite {
  direction: string;
  external_message_id?: string | null;
  skill_id?: string | null;
  created_at?: Date | string | null;
}

export interface AutomationSignals {
  /** Ids reais (Evolution) de envios automáticos: DispatchLog + LeadDispatch. */
  externalIds: ReadonlySet<string>;
  /** Horários (ms) de envios automáticos: FollowupMessage, BroadcastItem, DispatchLog 'followup_lead'. */
  sentTimes: readonly number[];
}

export const NO_AUTOMATION_SIGNALS: AutomationSignals = { externalIds: new Set(), sentTimes: [] };

export const OPERATOR_TURN_LABEL = '[Operador Humano]';
export const AUTOMATION_TURN_LABEL = '[Mensagem automática da clínica]';

export function classifyHistorySender(
  m: HistoryMessageLite,
  signals: AutomationSignals = NO_AUTOMATION_SIGNALS,
): HistorySender {
  if (m.direction === 'in') return 'client';
  if (m.skill_id) return 'assistant';
  const ext = m.external_message_id || '';
  if (ext.startsWith('sys_ai_')) return 'assistant';
  if (ext.startsWith('sys_')) return 'automation';
  // Otimista do painel ainda não reconciliado: foi um humano que mandou.
  if (ext.startsWith('out_')) return 'operator';
  if (ext && signals.externalIds.has(ext)) return 'automation';
  if (m.created_at && ehSaidaAutomatica({ direction: m.direction, created_at: new Date(m.created_at) }, signals.sentTimes)) {
    return 'automation';
  }
  return 'operator';
}

/** Rótulo de quem fala no histórico em texto (history_summary). */
export function historyTextLabel(sender: HistorySender, assistantName: string): string {
  if (sender === 'client') return 'Cliente';
  if (sender === 'assistant') return assistantName;
  if (sender === 'automation') return 'Mensagem automática';
  return 'Operador';
}

/** Prefixo no turno 'assistant' do multi-turn. A própria IA (e o cliente) vão sem prefixo. */
export function chatTurnPrefix(sender: HistorySender): string {
  if (sender === 'operator') return `${OPERATOR_TURN_LABEL}: `;
  if (sender === 'automation') return `${AUTOMATION_TURN_LABEL}: `;
  return '';
}

/**
 * Tira um rótulo de turno que o modelo tenha copiado pro começo de uma linha da
 * resposta — "[Operador Humano]: …" nunca pode chegar ao paciente.
 */
export function stripHistoryLabels(text: string): string {
  return text.replace(/^[ \t]*\[(?:Operador Humano|Mensagem automática da clínica)\]:[ \t]*/gim, '');
}

/**
 * Sinais de automação pras 'out' do histórico que só o banco sabe classificar (id
 * real, sem skill_id). Nada pra conferir = nenhuma consulta. Erro PROPAGA — quem
 * chama cai em NO_AUTOMATION_SIGNALS (rótulo de operador, o comportamento antigo).
 */
export async function loadAutomationSignals(
  prisma: PrismaService,
  params: {
    tenantId: string | null;
    lead: { id: string; phone: string | null | undefined } | null;
    messages: HistoryMessageLite[];
  },
): Promise<AutomationSignals> {
  const pending = params.messages.filter(
    (m) => classifyHistorySender(m) === 'operator' && !!m.external_message_id && !m.external_message_id.startsWith('out_'),
  );
  if (!pending.length) return NO_AUTOMATION_SIGNALS;
  const ids = pending.map((m) => m.external_message_id as string);
  const oldest = Math.min(...pending.map((m) => new Date(m.created_at ?? Date.now()).getTime()));
  const desde = new Date(oldest - TOLERANCIA_AUTOMACAO_MS);

  const externalIds = new Set<string>();
  // Ids vêm das mensagens DESTA conversa: casar por id não vaza nada de outra clínica.
  const logs = await prisma.dispatchLog.findMany({
    where: { external_message_id: { in: ids } },
    select: { external_message_id: true },
  });
  for (const l of logs) if (l.external_message_id) externalIds.add(l.external_message_id);
  if (params.lead) {
    const toques = await prisma.leadDispatch.findMany({
      where: { lead_id: params.lead.id, status: 'ENVIADO', sent_at: { gte: desde } },
      select: { external_message_ids: true },
    });
    for (const t of toques) for (const id of t.external_message_ids) externalIds.add(id);
  }

  let sentTimes: number[] = [];
  if (params.tenantId && params.lead) {
    const tempos = await temposDeAutomacaoDoLead(prisma, params.tenantId, [params.lead], desde);
    sentTimes = tempos.get(params.lead.id) ?? [];
  }
  return { externalIds, sentTimes };
}

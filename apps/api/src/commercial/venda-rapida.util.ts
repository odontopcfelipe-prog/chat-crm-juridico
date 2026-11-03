/**
 * Venda rápida x proposta real — marca ÚNICA usada em TODO lugar (findAll, findByPatient,
 * board de progresso, origem das Entradas do Financeiro). A venda rápida grava title/notes
 * começando em "Venda rapida" (o fluxo gera automático: "Venda rapida — recebido na
 * clinica: ..."). Accent-strip (NFD) cobre "Venda rápida" com acento; checa title OU notes.
 * Centralizar evita a MESMA venda ser classificada diferente em telas diferentes (e furar o
 * gate de A_AGENDAR/STANDBY, que geraria cobrança de agendamento indevida pra quem já é
 * venda rápida). Arquivo puro, sem import: outros módulos importam sem ciclo.
 */
export function isVendaRapidaQuote(q: { title?: string | null; notes?: string | null }): boolean {
  const norm = (s: string | null | undefined) =>
    (s || '').normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();
  return norm(q.title).startsWith('venda rapida') || norm(q.notes).startsWith('venda rapida');
}

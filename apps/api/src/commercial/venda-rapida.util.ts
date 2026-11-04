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

/**
 * Forma de pagamento para a Lista de vendas, lida das notas que a venda grava
 * ("Venda rapida — recebido na clinica: Espécie") com os nomes da tela de pagamento.
 * Sem forma nas notas (PIX online antigo) devolve null.
 */
export function formaDaVendaRapida(notes: string | null | undefined): string | null {
  const texto = notes || '';
  const inicio = texto.indexOf(': ');
  if (inicio < 0) return null;
  return texto
    .slice(inicio + 2)
    .replace(/PIX \(Maquineta\)/g, 'PIX na maquineta')
    .replace(/PIX d[ao] (clínica|laboratório)/g, 'PIX na chave')
    .replace(/Espécie/g, 'Dinheiro')
    .replace(/Maquineta \((\d+) cartões\)/g, '$1 cartões')
    .replace(/Maquineta/g, 'Cartão')
    .replace(/R\$ (\d+)\.(\d{2})/g, 'R$ $1,$2');
}

export type EstadoDaVenda = 'RECEBIDA' | 'PENDENTE' | 'VENCIDA' | 'CANCELADA' | 'SEM_COBRANCA';

/** Estado da venda pelas cobranças dela. Uma cobrança recebida basta para contar como recebida. */
export function estadoDaVenda(statusDasCobrancas: string[]): EstadoDaVenda {
  const tem = (...lista: string[]) => statusDasCobrancas.some((s) => lista.includes(s));
  if (tem('RECEIVED', 'CONFIRMED', 'RECEIVED_IN_CASH')) return 'RECEBIDA';
  if (tem('OVERDUE')) return 'VENCIDA';
  if (tem('PENDING')) return 'PENDENTE';
  return statusDasCobrancas.length > 0 ? 'CANCELADA' : 'SEM_COBRANCA';
}

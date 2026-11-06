/**
 * Paridade clínica → laboratório — textos da página pública do orçamento de trabalho
 * (link de aceite on-line que o laboratório manda ao cliente).
 *
 * Só texto. A página existe só para o laboratório: não há versão de clínica. Este
 * arquivo só tem consts LAB_*: fica sob as travas de scripts/ci/check-pick-literals.mjs.
 */

export const LAB_PROPOSTA_PUBLICA = Object.freeze({
  /** Título e descrição da aba e da prévia do link (proposta/layout.tsx). */
  tituloDaAba: 'Orçamento de trabalho',
  descricaoDaAba: 'Veja os serviços e o valor do orçamento e confirme o aceite.',
  carregando: 'Carregando o orçamento…',
  linkInvalidoTitulo: 'Link inválido ou expirado',
  linkInvalidoTexto: 'Peça um novo link ao laboratório.',
  tituloDoc: (numero: string) => `Orçamento de trabalho nº ${numero}`,
  saudacao: (nome: string) => `Olá, ${nome}!`,
  introducao: 'Confira os serviços e o valor do orçamento. Se estiver tudo certo, confirme o aceite no final da página.',
  validoAte: (data: string) => `Válido até ${data}`,
  servicos: 'Serviços',
  colServico: 'Serviço',
  colElemento: 'Elemento',
  colQtd: 'Qtd',
  colUnitario: 'Unitário',
  colTotal: 'Total',
  elemento: (fdi: string) => `Elemento ${fdi}`,
  subtotal: 'Subtotal',
  desconto: (pct: number) => (pct > 0 ? `Desconto (${pct}%)` : 'Desconto'),
  total: 'Total',
  condicoes: 'Condições de pagamento',
  observacoes: 'Observações',
  aceiteTitulo: 'Aceitar o orçamento',
  aceiteTexto: 'Escreva seu nome completo para confirmar que está de acordo com os serviços, os valores e as condições acima.',
  nomeRotulo: 'Nome completo',
  nomePlaceholder: 'Seu nome',
  aceitar: 'Aceitar orçamento',
  aceitando: 'Registrando…',
  nomeObrigatorio: 'Escreva seu nome completo para aceitar.',
  erroAceite: 'Não foi possível registrar o aceite agora. Tente de novo.',
  aceitoTitulo: 'Orçamento aceito',
  aceitoTexto: 'Recebemos o seu aceite. O laboratório vai seguir com o trabalho e entrar em contato.',
  jaAceitoTitulo: 'Este orçamento já foi aceito',
  jaAceitoTexto: 'Se precisar de algo, fale com o laboratório.',
  vencidoTitulo: 'Orçamento vencido',
  vencidoTexto: 'O prazo deste orçamento terminou. Peça um novo ao laboratório.',
  encerradoTitulo: 'Orçamento fechado',
  encerradoTexto: 'Este orçamento não está mais aberto para aceite. Fale com o laboratório.',
  rodape: (laboratorio: string) => `Orçamento emitido por ${laboratorio}`,
});

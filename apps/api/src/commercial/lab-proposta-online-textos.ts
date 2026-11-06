/**
 * Paridade clínica → laboratório — textos do LINK DE ACEITE ON-LINE do orçamento de
 * trabalho: a mensagem do WhatsApp (linhas do link) e as respostas da página pública
 * (proposta-online-laboratorio.ts). Só o ramo do laboratório importa daqui.
 *
 * Só consts LAB_ (scripts/ci/check-pick-literals.mjs): nenhum termo de clínica.
 */

export const LAB_PROPOSTA_ONLINE_WHATSAPP = Object.freeze({
  /** Linhas do link na legenda do PDF (entre o resumo e o fecho). */
  linkAntes: '\nVeja o orçamento e aceite pelo link:',
});

export const LAB_PROPOSTA_ONLINE = Object.freeze({
  linkInvalido: 'Link inválido ou expirado. Peça um novo link ao laboratório.',
  nomeObrigatorio: 'Informe seu nome completo para confirmar o aceite.',
  jaAceita: 'Este orçamento já foi aceito.',
  outraOpcaoAceita: 'Outra opção deste orçamento já foi aceita, então esta não pode mais ser aceita. Fale com o laboratório.',
  encerrada: 'Este orçamento não está mais aberto para aceite. Fale com o laboratório.',
  vencida: 'Este orçamento está vencido. Peça um novo ao laboratório.',
  erroAceite: 'Não foi possível registrar o aceite agora. Tente de novo ou fale com o laboratório.',
  nomeDoLaboratorioPadrao: 'Laboratório',
  /** Linha do histórico (auditoria) do aceite. */
  descricaoDoAceite: (numero: string) => `Aceite on-line do orçamento nº ${numero} pelo link`,
});

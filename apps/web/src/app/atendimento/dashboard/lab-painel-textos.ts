/**
 * Paridade do laboratório — textos do LABORATÓRIO no painel completo (Painel financeiro
 * e Painel completo). Só texto: a clínica não usa nada daqui, quem usa escolhe pelo tipo
 * de negócio da sessão (`lab ? LAB_X.y : 'texto de hoje da clínica'`). Este arquivo só
 * tem consts LAB_* (scripts/ci/check-pick-literals.mjs).
 */
export const LAB_PAINEL = Object.freeze({
  geralSubtitulo: 'KPIs consolidados do laboratório',
  comercialSubtitulo: 'Contatos, conversão e atendimento',
  contatosEmAtendimento: 'Contatos em atendimento',
  contatosGeral: 'Contatos no geral',
  contatosConvertidos: 'Contatos convertidos',
  contatosPerdidos: 'Contatos perdidos',
  origemTitulo: 'Origem dos contatos',
  origemUnidade: 'contatos',
});

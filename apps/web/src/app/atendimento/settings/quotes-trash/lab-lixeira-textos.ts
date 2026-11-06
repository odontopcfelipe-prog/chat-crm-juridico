/**
 * Paridade clínica → laboratório — textos do LABORATÓRIO da Lixeira de Orçamentos
 * (Configurações › Comercial): onde o administrador recupera um orçamento de trabalho
 * apagado nos últimos 30 dias.
 *
 * Só texto. A clínica não usa nada daqui: a tela escolhe pelo tipo de negócio da sessão
 * (`lab ? LAB_X.y : 'texto de hoje da clínica'`). Este arquivo só tem consts LAB_*: fica
 * sob as travas de scripts/ci/check-pick-literals.mjs.
 */

export const LAB_LIXEIRA = Object.freeze({
  titulo: 'Lixeira de Orçamentos',
  subtitulo: 'Orçamentos de trabalho apagados nos últimos 30 dias podem ser restaurados aqui. Após 30 dias eles são removidos permanentemente.',
  avisoTitulo: 'Janela de recuperação: 30 dias',
  avisoTexto:
    'Apenas orçamentos em rascunho podem ser apagados (e portanto recuperados). Orçamentos enviados, aceitos ou recusados ficam no histórico permanente do cliente.',
  confirmarRestaurar: 'Restaurar este orçamento? Ele voltará a aparecer na ficha do cliente.',
  colCliente: 'Cliente',
  servicos: (n: number) => `${n} ${n === 1 ? 'serviço' : 'serviços'}`,
  vazio: 'Nenhum orçamento na lixeira. Tudo limpo.',
});

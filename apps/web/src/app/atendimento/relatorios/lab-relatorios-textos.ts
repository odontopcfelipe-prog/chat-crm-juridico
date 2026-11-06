/**
 * Paridade do laboratório — textos do LABORATÓRIO na tela de Relatórios (resumo de
 * números do período). Só texto: a clínica não usa nada daqui, quem usa escolhe pelo
 * tipo de negócio da sessão (`lab ? LAB_X.y : 'texto de hoje da clínica'`). Este
 * arquivo só tem consts LAB_* (scripts/ci/check-pick-literals.mjs).
 *
 * O catálogo de relatórios da clínica (agenda de consulta, estética, ANVISA...) não
 * existe no laboratório: a tela dele mostra só o resumo.
 */
export const LAB_RELATORIOS = Object.freeze({
  subtitulo: 'Resumo dos números do laboratório no período.',
  visitas: 'Visitas',
  clientesNovos: 'Novos clientes',
  principaisServicos: 'Principais serviços',
  origemClientes: 'Origem dos clientes (contatos)',
});

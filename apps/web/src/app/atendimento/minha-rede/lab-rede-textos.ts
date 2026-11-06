/**
 * Paridade do laboratório — textos do LABORATÓRIO da tela Minha rede (comparativo
 * entre as unidades). As visitas são as coletas, provas e entregas.
 *
 * Só texto. A clínica não usa nada daqui: a tela escolhe pelo tipo de negócio da sessão
 * (`lab ? LAB_X.y : 'texto de hoje da clínica'`). Este arquivo só tem consts LAB_*:
 * fica sob as travas de scripts/ci/check-pick-literals.mjs.
 */
export const LAB_REDE = Object.freeze({
  visitas: 'visita(s)',
  colVisitas: 'Visitas',
});

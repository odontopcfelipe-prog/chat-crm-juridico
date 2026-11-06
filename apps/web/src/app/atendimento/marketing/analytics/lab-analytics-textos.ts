/**
 * Paridade do laboratório — textos do LABORATÓRIO da tela Analytics (Marketing).
 *
 * As landing pages medidas aqui são as do site da plataforma e não pertencem a nenhuma
 * conta: o laboratório não recebe a métrica delas (a API devolve lista vazia). Fica o
 * Google Analytics do próprio laboratório, que é por conta.
 *
 * Só texto. A clínica não usa nada daqui: a tela escolhe pelo tipo de negócio da sessão
 * (`lab ? LAB_X.y : 'texto de hoje da clínica'`). Este arquivo só tem consts LAB_*:
 * fica sob as travas de scripts/ci/check-pick-literals.mjs.
 */
export const LAB_ANALYTICS = Object.freeze({
  titulo: 'Analytics do site',
  subtitulo: 'Últimos 30 dias · Google Analytics do laboratório',
  vazioTitulo: 'Nenhuma página do laboratório é rastreada aqui.',
  naoConfigurado: 'O Google Analytics do laboratório ainda não foi configurado — fale com o administrador do laboratório.',
  vazioDica: 'Configure o Google Analytics do seu site no painel logo abaixo para acompanhar as visitas.',
});

/**
 * Paridade do laboratório — textos da "Campanha manual" (Central de Disparos).
 *
 * Só texto. A clínica não usa nada daqui: a tela escolhe pelo tipo de negócio da sessão
 * (`lab ? LAB_CAMPANHAS.x : 'texto de hoje da clínica'`). Este arquivo só tem consts LAB_*:
 * fica sob as travas de scripts/ci/check-pick-literals.mjs.
 *
 * O público é a carteira de clientes do laboratório (dentistas e clínicas que ele atende).
 * A mensagem sai pelo WhatsApp da própria conta, no ritmo seguro, e a campanha só envia
 * quando o ADM clica em Iniciar.
 */
export const LAB_CAMPANHAS = Object.freeze({
  soAdm: 'Só o ADM do laboratório cria e envia campanhas.',
  explicacao:
    'Envio avulso pra um grupo de clientes do laboratório, pelo WhatsApp da própria conta, com texto, fotos e áudio. '
    + 'Sai no ritmo seguro (1 cliente a cada 3–7 min, seg–sáb 9h–18h, fora de feriado) e pula quem pediu pra não receber. '
    + 'A campanha nasce como rascunho e só começa a sair quando você clica em Iniciar.',
  setorAtendimento: 'Atendimento',
  chip: 'setor',
  setorTitulo: 'Setor (de onde sai a mensagem)',
  setorAjuda: 'A mensagem sai pelo WhatsApp do laboratório.',
  publicoTitulo: '2. Quem recebe (clientes)',
  etiquetas: 'Etiquetas (qualquer uma)',
  semEtiquetas: 'Nenhuma etiqueta cadastrada.',
  ativos: 'Ativos (com movimento recente)',
  inativos: 'Inativos (sem movimento há muito tempo)',
  comTrabalho: 'Com trabalho em andamento',
  recebem: 'cliente(s) recebem',
  variaveis: Object.freeze([
    { key: 'nome', desc: 'Primeiro nome do cliente' },
    { key: 'nome_completo', desc: 'Nome completo do cliente' },
    { key: 'clinica', desc: 'Nome do laboratório' },
  ]),
  nomeLabExemplo: 'seu laboratório',
  comoRecebe: 'Como o cliente recebe',
  exemploRecebe: 'Exemplo com o cliente “Ana”. Cada cliente recebe com o próprio nome.',
  enviarSaiPara: 'A lista de quem recebe é fechada ao iniciar. A mensagem sai para os clientes do laboratório pelo WhatsApp da própria conta, seg–sáb 9h–18h, fora de feriado, no ritmo seguro; dá pra pausar ou cancelar.',
  confirmarAgendar: (nome: string, n: number, setor: string, quando: string) =>
    `Agendar a campanha "${nome}" pra ${n} cliente(s) do laboratório, pelo WhatsApp da própria conta (setor ${setor}), a partir de ${quando}?`,
  confirmarAgora: (nome: string, n: number, setor: string, estimativa: string) =>
    `Começar agora a campanha "${nome}" pra ${n} cliente(s) do laboratório, pelo WhatsApp da própria conta (setor ${setor})?\n\nA mensagem sai no ritmo seguro (${estimativa}). Dá pra pausar ou cancelar depois.`,
});

/**
 * Paridade do laboratório — textos do LABORATÓRIO da tela Configurações → E-mails
 * automáticos. O título, o conteúdo e as variáveis de cada e-mail chegam prontos da
 * API (que já devolve o texto do laboratório); aqui ficam só os textos fixos da
 * própria página.
 *
 * Só texto. A clínica não usa nada daqui: a tela escolhe pelo tipo de negócio da
 * sessão (`lab ? LAB_X.y : 'texto de hoje da clínica'`). Este arquivo só tem consts
 * LAB_*: fica sob as travas de scripts/ci/check-pick-literals.mjs.
 */

/** Cabeçalho da página. */
export const LAB_EMAILS_TOPO = Object.freeze({
  titulo: 'E-mails automáticos',
  explicacaoAntes: 'Mensagens enviadas automaticamente aos seus clientes, em nome do laboratório. As respostas chegam no e-mail cadastrado em ',
  explicacaoNegrito: 'Identidade do laboratório',
  explicacaoDepois: '.',
});

/** Cartão do remetente. */
export const LAB_EMAILS_REMETENTE = Object.freeze({
  titulo: 'Remetente destes e-mails',
  enviadoEmNomeDe: 'Enviado em nome de ',
  nomePadrao: 'seu laboratório',
  respostasAntes: ' · respostas dos clientes chegam em ',
  semEmailAntes: 'Seu laboratório ainda não tem e-mail cadastrado — as respostas dos clientes não terão destino.',
  semEmailLink: 'Cadastrar em Identidade do laboratório',
  exclusivosAntes: 'Estes e-mails são ',
  exclusivosNegrito: 'exclusivos para os seus clientes',
  exclusivosDepois: ' (cobrança, pagamento, avisos de coleta, prova e entrega). Os e-mails do sistema — confirmação de acesso da equipe e redefinição de senha — são separados e enviados pela plataforma Odonto System.',
});

/** Cada e-mail sai desligado até a própria conta ligar o seletor. */
export const LAB_EMAILS_AVISOS = Object.freeze({
  desligadoPadrao: 'Cada e-mail só sai depois que o seu laboratório liga o seletor dele. Enquanto estiver desligado, nada é enviado ao cliente.',
  automaticos: '"Vencimento amanhã" e "Pagamento atrasado" são avisos automáticos ao cliente do laboratório: depois de ligados, saem sozinhos, sem você precisar enviar.',
});

/** Rótulos e confirmações dos botões. */
export const LAB_EMAILS_ACOES = Object.freeze({
  carregarErro: 'Não foi possível carregar.',
  salvarErro: 'Falha ao salvar.',
  restaurarConfirma: 'Restaurar o texto padrão do sistema para este e-mail?',
  restaurarErro: 'Falha ao restaurar.',
  testeErro: 'Falha ao enviar o teste.',
  ativadoTitulo: 'Ligado — clique para desligar',
  desativadoTitulo: 'Desligado — clique para ligar. O e-mail só sai depois de ligado.',
  personalizado: 'Personalizado',
  desligado: 'Desligado',
  fechar: 'Fechar',
  editar: 'Editar conteúdo',
  assunto: 'Assunto',
  conteudo: 'Conteúdo',
  variaveis: 'Variáveis disponíveis (clique para copiar)',
  salvar: 'Salvar',
  salvando: 'Salvando…',
  testeTitulo: 'Envia este e-mail com dados de exemplo para o seu próprio e-mail',
  testeBotao: 'Enviar teste para mim',
  testando: 'Enviando…',
  restaurar: 'Restaurar padrão',
  salvo: 'Salvo',
  testeEnviado: 'Teste enviado — confira sua caixa de entrada',
  carregando: 'Carregando…',
});

/** Nota de rodapé. */
export const LAB_EMAILS_RODAPE = Object.freeze({
  antes: 'Os e-mails só são enviados para clientes que têm e-mail no cadastro. Variáveis como ',
  exemplo: '{{cliente_nome}}',
  depois: ' são substituídas automaticamente pelos dados reais na hora do envio.',
});

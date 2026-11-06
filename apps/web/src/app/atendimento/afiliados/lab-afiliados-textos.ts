/**
 * Paridade do laboratório — textos do LABORATÓRIO do programa de afiliados: a tela
 * Afiliados (painel e Modo jogo), a aba Afiliado da ficha do cliente e o afiliado da
 * venda na aba Propostas.
 *
 * Só texto. A clínica não usa nada daqui: as telas escolhem pelo tipo de negócio da
 * sessão (`lab ? LAB_X.y : 'texto de hoje da clínica'`). Este arquivo só tem consts LAB_*:
 * fica sob as travas de scripts/ci/check-pick-literals.mjs.
 *
 * O afiliado do laboratório é um cliente (dentista ou clínica) que indica outros
 * clientes e recebe a comissão do trabalho fechado.
 */

/** Tela Afiliados (painel). */
export const LAB_AFILIADOS = Object.freeze({
  subtitulo: 'Clientes parceiros — recebem 3% por indicação fechada',
  adicionarTitulo: 'Adicionar cliente como afiliado',
  creditoNoTrabalho: 'Crédito em trabalho',
  vazioDica: 'Marque clientes como afiliados pela ficha (botão verde no header ou modal Editar).',
  confirmarTornar: (nome: string, codigo: string) =>
    `Tornar ${nome} um afiliado do laboratório?\n\n` +
    `• Recebe 3% por indicação fechada\n` +
    `• Saldo acumula e pode ser sacado\n` +
    `• Código: ${codigo}`,
  buscarCliente: 'Buscar cliente',
  nenhumEncontrado: 'Nenhum cliente encontrado pra',
  precisaCadastro: 'Afiliado precisa ser um cliente cadastrado —',
  cadastrarCompleto: 'cadastre o cliente completo aqui',
  eVolte: 'e volte pra adicioná-lo.',
  digiteNome: 'Digite o nome ou telefone do cliente.',
});

/** Modo jogo (Corrida das Indicações). */
export const LAB_AFILIADOS_JOGO = Object.freeze({
  metaPergunta:
    'Meta coletiva da temporada — quantas indicações FECHADAS o laboratório quer bater no mês?\n\n(0 ou vazio remove a meta)',
  intro: 'Cada trabalho fechado por indicação conta ponto. Bata a meta do laboratório e todos os afiliados concorrem ao prêmio.',
  vazioMarque: 'Marque clientes como afiliados (botão',
  vazioQuando: '). Quando indicarem e o trabalho fechar, eles sobem no ranking aqui — sem número inventado.',
  rodape: 'Progresso real (indicações fechadas no mês). A recompensa é um rótulo — o prêmio fica a critério do laboratório.',
});

/** Aba Afiliado da ficha do cliente. */
export const LAB_AFILIADO_ABA = Object.freeze({
  eAfiliado: 'Cliente é afiliado — ver saldo e indicações',
  semPlano: 'sem trabalho',
  emAndamento: 'em produção',
  nuncaVeio: 'Sem visita ainda',
  diasSemVir: (dias: number | null) => `${dias} dias sem visita`,
  semProximaVisita: 'sem próxima visita',
  fechouTrabalho: 'trabalho fechado por indicação dele.',
  usarComoCredito: 'Usar como crédito em trabalho',
  eFechar: 'e fechar um trabalho, vai aparecer aqui.',
  clienteIndicado: 'Cliente indicado',
  colTrabalho: 'Trabalho',
  colValor: 'Valor do trabalho',
  creditoEmTrabalho: 'Crédito em trabalho',
  descontoEmTrabalho: 'pode virar desconto em qualquer trabalho próprio do afiliado (vale como PIX',
  noFechamento: 'no fechamento).',
  escolhaIndicado: 'Escolha o cliente indicado',
  informeValor: 'Informe o valor acertado do trabalho',
  nenhumCliente: 'Nenhum cliente encontrado',
  creditoAviso: 'O valor vai aparecer como desconto disponível no próximo orçamento criado pra esse cliente.',
});

/** Afiliado da venda (aba Propostas). */
export const LAB_AFILIADO_DA_VENDA = Object.freeze({
  nenhumEncontrado: 'Nenhum afiliado encontrado. Pra virar afiliado: tela Afiliados › Adicionar afiliado.',
});

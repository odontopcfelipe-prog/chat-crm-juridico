/**
 * F5 do laboratório — textos do LABORATÓRIO da venda rápida (venda de balcão): o
 * cliente (dentista ou clínica) no lugar de quem compra, o protético responsável,
 * os serviços e os elementos de cada serviço.
 *
 * Só texto. A clínica não usa nada daqui: a tela escolhe pelo tipo de negócio da
 * sessão (`lab ? LAB_VENDA_RAPIDA.x : 'texto de hoje da clínica'`). Este arquivo só
 * tem a const LAB_VENDA_RAPIDA: fica sob as travas de scripts/ci/check-pick-literals.mjs,
 * e nenhum texto fora dela pode entrar aqui.
 *
 * Os espaços nas pontas de alguns textos são de propósito: eles encostam num
 * <strong> ou num <span> da tela, como o texto da clínica que substituem.
 */

export const LAB_VENDA_RAPIDA = Object.freeze({
  // Cabeçalho (o título "Venda rápida" é o mesmo da clínica).
  selo: 'Balcão · Sem orçamento',
  subtitulo: Object.freeze({
    antes: 'Venda um serviço na hora: ',
    destaque: 'vira um trabalho do cliente',
    depois: ' — gera a cobrança e já entra no caixa. O protético confirma a conclusão depois.',
  }),

  // Catálogo de serviços (só os marcados com o ⚡ na tabela de serviços).
  vitrine: 'Serviços',
  buscarServico: 'Buscar serviço... (coroa, provisório, placa)',
  carregando: 'Carregando serviços...',
  nadaNaBusca: 'Nenhum serviço liberado nessa busca.',
  nadaLiberado:
    'Nenhum serviço liberado para a venda rápida ainda. Vá em Configurações → Tabela de serviços e marque o ⚡ nos que devem aparecer aqui.',

  // Cliente (dentista ou clínica).
  informarCliente: 'Informe o cliente',
  trocarCliente: 'Trocar cliente',
  buscarCliente: 'Buscar dentista ou clínica por nome, CPF ou CNPJ...',
  cadastrarCliente: 'Cadastrar dentista ou clínica',
  obrigatorioCliente: 'obrigatório para lançar o trabalho',

  // Protético responsável (vem antes do "· obrigatório").
  responsavel: 'Protético responsável ',
  selecione: 'Selecione o protético…',
  responsavelOk: 'Os serviços ficam pendentes para esse protético confirmar a conclusão.',
  responsavelVazio: 'Escolha o protético responsável pelo trabalho.',

  // Carrinho e elementos.
  carrinhoVazio: 'Clique num serviço para começar a venda',
  elementos: 'Elementos',
  addElemento: '+ Elemento (opcional)',
  removerElemento: 'Remover elemento',
  porElemento: (n: number) => `× ${n} elemento${n > 1 ? 's' : ''}`,

  // Tela de pagamento.
  pagamento: Object.freeze({
    titulo: 'Como o cliente vai pagar?',
    pixSub: 'Na chave do laboratório ou na maquineta',
    pixChave: 'Chave do laboratório',
    resumoCliente: 'Cliente',
    resumoResponsavel: 'Protético',
  }),

  // Venda enviada sem resposta do servidor.
  semConfirmacao: (total: string, cliente: string) =>
    `Não chegou a resposta do servidor: a venda de R$ ${total} para ${cliente} pode ter entrado.`,
  verFinanceiro: 'Conferir no Financeiro do cliente',

  // Baixa de estoque.
  material: 'material consumido por estes serviços',
  bloqueiaSemSaldo:
    'Este laboratório bloqueia saída sem saldo — dê entrada no produto, ou desmarque a baixa pra fechar a venda mesmo assim.',

  // Botão de finalizar e rodapé (em volta do destaque "pendentes").
  cta: Object.freeze({
    cliente: 'Selecione o cliente',
    servicos: 'Adicione serviços',
    responsavel: 'Selecione o protético',
  }),
  pendentes: 'pendentes',
  rodape: Object.freeze({
    antes: 'Ao finalizar: registra o recebimento no caixa e lança os serviços no trabalho como ',
    depois: ' — o protético confirma a conclusão de cada um depois.',
  }),

  // Avisos ao finalizar.
  erros: Object.freeze({
    semCliente: 'Selecione o cliente antes de finalizar',
    semServico: 'Adicione ao menos 1 serviço',
    semResponsavel: 'Selecione o protético responsável antes de finalizar',
    maxItens: (max: number, n: number) =>
      `A venda rápida aceita até ${max} itens (cada elemento conta 1) — este carrinho tem ${n}. Divida em duas vendas.`,
  }),

  // Venda finalizada (recebida no balcão).
  sucesso: Object.freeze({
    validar: 'Esta venda passa pelo Validar do Financeiro antes de liberar o trabalho.',
    texto: Object.freeze({
      antes: 'Pagamento registrado e lançado no financeiro do cliente. Os serviços entram no trabalho como ',
      depois: ' — o protético confirma a conclusão de cada um.',
    }),
  }),

  // Seletor de elementos do serviço.
  seletor: Object.freeze({
    titulo: 'Elementos do serviço',
    aria: (servico: string) => `Elementos — ${servico}`,
    dica: 'Clique nos elementos do serviço. Cada elemento vira 1 item do trabalho.',
    pronto: (n: number) => (n > 0 ? `Pronto · ${n} elemento${n === 1 ? '' : 's'}` : 'Pronto'),
  }),
});

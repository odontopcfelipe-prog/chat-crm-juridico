/**
 * F6 do laboratório — textos do LABORATÓRIO da aba Propostas da ficha (PropostasTab):
 * cards, painel da proposta, os três modais de cobrança (boleto, PIX e cartão), nova
 * versão, arquivar, bônus e o resultado da aprovação.
 *
 * Só texto. A clínica não usa nada daqui: a PropostasTab escolhe pelo tipo de negócio
 * da sessão (`lab ? LAB_X.y : 'texto de hoje da clínica'`). Este arquivo só tem consts
 * LAB_*: fica sob as travas de scripts/ci/check-pick-literals.mjs, e nenhum texto fora
 * delas pode entrar aqui.
 *
 * Vocabulário: "cliente" nas frases; "trabalho" no lugar de tratamento ou plano;
 * "serviço"; "elemento"; "no laboratório"; a montagem do orçamento fica na aba
 * Orçamento. Sem Banco PASSOS, PagBank, Serasa nem Asaas Tap: o cartão do laboratório
 * passa na maquineta e o boleto sai pela conta Asaas do próprio laboratório.
 */

/** Parte de cima da aba: cards, painel, avisos e o aprovar e cobrar. */
export const LAB_PROPOSTAS = Object.freeze({
  /** Descrição dos três grupos (as chaves e os rótulos não mudam). */
  prioridade: Object.freeze<Partial<Record<string, { descricao: string }>>>({
    URGENTE: Object.freeze({ descricao: 'só o que o caso precisa agora' }),
    ESSENCIAL: Object.freeze({ descricao: 'o necessário — sem opcionais estéticos' }),
    COMPLETO: Object.freeze({ descricao: 'o ideal — todos os serviços sugeridos' }),
  }),
  /**
   * Bônus por tipo (o tipo gravado não muda). Os placeholders começam diferentes nos
   * 20 primeiros caracteres: o diálogo de bônus compara por esse começo.
   */
  bonus: Object.freeze<Partial<Record<string, { label?: string; description?: string; placeholder?: string }>>>({
    CORTESIA: Object.freeze({
      label: 'Cortesia do laboratório',
      description: 'provisório, ajuste extra, modelo de estudo...',
      placeholder: 'Ex.: provisório incluso + 1 ajuste sem custo',
    }),
    GARANTIA_ESTENDIDA: Object.freeze({
      description: '12 meses em vez de 6, reparo incluso...',
      placeholder: 'Ex.: Garantia estendida para 12 meses + 1 reparo sem custo',
    }),
    PROCEDIMENTO_ADICIONAL: Object.freeze({
      label: 'Serviço adicional',
      description: 'enceramento, modelo de estudo, escaneamento...',
      placeholder: 'Ex.: enceramento diagnóstico + modelo de estudo inclusos',
    }),
    PERSONALIZADO: Object.freeze({
      placeholder: 'Descreva o bônus oferecido ao cliente...',
    }),
  }),
  /** Diálogo do QR do PIX da entrada. */
  pixQr: Object.freeze({
    abrirPaginaTitulo: 'Abre a página hospedada do Asaas — útil pra copiar o link e mandar pro cliente via WhatsApp',
    abrirPagina: '🔗 Abrir página de pagamento (pra enviar ao cliente)',
  }),
  /** Selos das formas de pagamento. */
  badge: Object.freeze({
    asaasTitulo: 'Cobrança ONLINE gerada no Asaas — o cliente paga pelo link/QR',
    laboratorioTitulo: 'Recebido no laboratório — entra direto no caixa, sem cobrança no Asaas',
    laboratorio: 'NO LABORATÓRIO',
  }),
  /** Avisos (toast) da aba. */
  avisos: Object.freeze({
    propostaSalva: 'Proposta salva — aguardando decisão do cliente',
    enviada: 'Proposta enviada pro cliente',
    aprovadaBoletos: 'Proposta aprovada e boletos gerados.',
  }),
  /** Linhas da confirmação do aprovar e cobrar. */
  aprovar: Object.freeze({
    ativarTrabalho: '• Ativar o trabalho',
    ativarTrabalhoLinha: '• Ativar o trabalho\n',
    aceitarEAtivar: '• Aceitar o orçamento + ativar o trabalho\n',
    enviarCliente: '• Enviar pro cliente',
  }),
  /** Aba sem proposta nenhuma. */
  vazio: Object.freeze({
    antes: 'Crie uma proposta direto agora ou monte o orçamento detalhado na aba ',
    aba: 'Orçamento',
    depois: ' primeiro.',
    irPara: 'Ir para Orçamento',
  }),
  cabecalho: Object.freeze({
    titulo: 'Propostas de trabalho',
  }),
  card: Object.freeze({
    removerTitulo: 'Remover desta aba (continua na aba Orçamento)',
  }),
  /** Painel da proposta aberta. */
  painel: Object.freeze({
    confirmeEspecie: 'Confirme que o cliente entregou o dinheiro em mãos. ',
    pixEntradaGerado: 'PIX da entrada gerado — mostre o QR Code pro cliente',
    boletoParcelado: 'Boleto parcelado (carnê)',
    enviarTitulo: 'Envia o orçamento em PDF pro cliente no WhatsApp',
    enviar: 'Enviar pro cliente',
    aprovarTitulo:
      'Aprova a venda: cria as cobranças (ou lança o recebimento manual no caixa) e move a proposta pra aba Financeiro do cliente',
  }),
  criada: (label: string) => `Proposta ${label} criada. Adicione os serviços pela aba Orçamento quando puder.`,
  formaManual: (label: string) => `Forma: ${label} (recebido no laboratório, sem Asaas)\n`,
  elemento: (fdi: string) => `Elemento ${fdi}`,
  servicosIncluidos: (n: number) => (n === 1 ? 'serviço incluído' : 'serviços incluídos'),
});

/** O que os três modais de cobrança (boleto, PIX e cartão) têm em comum. */
export const LAB_PROPOSTAS_CONTRAPROPOSTA = Object.freeze({
  notaExemplo: 'Ex: cliente vai pensar até sexta · pediu mais um desconto',
});

export const LAB_PROPOSTAS_COBRANCA = Object.freeze({
  titulo: 'Cobrança do trabalho',
  valorTotal: 'Valor total do trabalho',
  valorDoTrabalho: 'Valor do trabalho',
  trabalhoPadrao: 'Trabalho',
  servico: 'serviço',
  servicos: 'serviços',
  jaSalvaTitulo: 'Esta já é a forma salva. Clique para salvar de novo com a configuração atual. Ela vale até a aprovação, no rodapé.',
  /** O parcelamento no boleto do laboratório (no lugar do financiamento com banco e consulta de crédito da clínica). */
  parcelamentoProprio: (parcelas: number, entradaPct: number, jurosMes: number) =>
    `${parcelas}x no Parcelamento próprio (entrada ${entradaPct}% + ${jurosMes}%/mês)`,
  enviarWhatsappTitulo: 'Envia o PDF do orçamento para o WhatsApp do cliente revisar antes',
  enviarWhatsapp: 'Enviar orçamento no WhatsApp',
});

/** Modal do boleto (só com a conta Asaas própria do laboratório). */
export const LAB_PROPOSTAS_BOLETO = Object.freeze({
  sjTitulo: 'S/J (sem juros): as parcelas do boleto saem SEM os 1,5%/mês. Independente do desconto à vista.',
  pagaNoFechamento: 'Quanto o cliente paga no fechamento — sem juros',
  jurosParcela: 'juros 1,5%/mês',
  semJuros: 'sem juros',
  salvarTitulo:
    'Salva esta forma de pagamento como a escolhida para apresentar ao cliente. As cobranças no Asaas só são criadas na aprovação, no rodapé.',
  ambienteSeguro: 'Boletos e PIX emitidos pela conta Asaas do laboratório. Sinal/entrada são idempotentes — não re-emite se já existir.',
  selos: Object.freeze(['Asaas', 'PIX']),
});

/** Modal do PIX ou dinheiro. "ComAsaas" = a conta Asaas própria do laboratório está cadastrada. */
export const LAB_PROPOSTAS_PIX = Object.freeze({
  comoPaga: 'Como o cliente vai pagar?',
  formasComAsaas: 'PIX (QR Code) · PIX maquineta (sem QR) · Espécie',
  formasSemAsaas: 'PIX em conta · PIX na maquineta · Espécie',
  descPixComAsaas: 'QR (Asaas) ou no laboratório',
  descPixSemAsaas: 'Em conta ou na maquineta',
  formaDoPixSemAsaas: 'Em conta ou na maquineta',
  recebidoNoLab: 'recebido no laboratório',
  salvarTitulo: 'Salva como forma escolhida. O lançamento (caixa/cobrança) só sai na aprovação, no rodapé.',
  ambienteSeguroLocal: 'PIX recebido no laboratório (em conta / maquineta), lançado no caixa. Sem QR/cobrança Asaas, com baixa automática.',
});

/** Modal do cartão: no laboratório o cartão passa na maquineta, sem entrada. */
export const LAB_PROPOSTAS_CARTAO = Object.freeze({
  naMaquineta: ' · na maquineta do laboratório',
  escolhaParcelamento: 'Escolha o parcelamento · o cartão passa na maquineta do laboratório',
  salvarTitulo: 'Salva Cartão (maquineta) como forma escolhida. O recebimento entra no caixa como cartão na aprovação, no rodapé.',
  ambienteSeguro: 'Cartão passado na maquineta do laboratório e lançado no caixa como cartão na aprovação.',
  selos: Object.freeze(['Maquineta', 'Visa', 'Master']),
});

/** Escolher orçamento e Nova proposta: a montagem fica na aba Orçamento. */
export const LAB_PROPOSTAS_VERSOES = Object.freeze({
  aba: 'Orçamento',
  semOrcamentoAntes: 'Crie um orçamento na aba ',
  semOrcamentoDepois: ' primeiro.',
  criarOuIrAntes: 'Criar a proposta direto agora ou ir para a aba ',
  criarOuIrDepois: ' primeiro?',
  irParaOrcamento: 'Ir para Orçamento',
  criarAgoraNota: '"Criar agora" gera proposta vazia — adicione os serviços depois pela aba Orçamento.',
  criarNovo: 'Criar novo orçamento na aba Orçamento',
});

/** Arquivar as outras versões depois de aprovar. */
export const LAB_PROPOSTAS_ARQUIVAR = Object.freeze({
  outrasVersoes: (n: number) =>
    `A proposta foi encaminhada ao financeiro. O cliente tem ${n} ${n === 1 ? 'outra versão' : 'outras versões'} em aberto. Quais quer arquivar?`,
  avisoForte: 'Só arquiva o que você marcar acima.',
  avisoAntes: ' Arquivados saem de Propostas e ficam em ',
  avisoOnde: 'Orçamentos de trabalho › Arquivado',
  avisoDepois: '.',
});

/**
 * Adicionar ao trabalho SEM cobrar (só o administrador): o trabalho já foi cobrado por fora,
 * então o orçamento é aceito e o trabalho entra na fila do Financeiro sem gerar boleto, PIX
 * nem dívida nova.
 */
export const LAB_PROPOSTAS_SEM_COBRANCA = Object.freeze({
  botao: 'Adicionar ao trabalho (sem cobrar)',
  botaoTitulo:
    'Adiciona os serviços ao trabalho SEM gerar cobrança (o cliente já pagou ou será cobrado por fora). Vai para a fila do Financeiro validar. Não gera boleto nem dívida nova.',
  semServicos: 'O orçamento não tem serviços para adicionar.',
  confirmar: (n: number) =>
    'Adicionar ao trabalho SEM gerar cobrança?\n\n' +
    `${n} serviço(s)\n\n` +
    'Isso vai:\n' +
    '• Aceitar o orçamento e ativar o trabalho\n' +
    '• ZERAR os valores dos serviços (a cobrança real fica por fora do sistema)\n' +
    '• Mandar para a fila do Financeiro validar\n' +
    '• NÃO gerar boleto/PIX nem dívida nova\n' +
    '• NÃO contar como venda do dia\n\n' +
    'Use só quando o trabalho já foi cobrado por fora. Para cobrar de verdade, use "Aprovar venda".',
  adicionado: 'Serviços adicionados ao trabalho (sem cobrança) — na fila do Financeiro.',
  erro: 'Erro ao adicionar ao trabalho sem cobrança',
});

/** Resultado do aprovar e cobrar (PIX ao vivo, cartão, boleto). */
export const LAB_PROPOSTAS_RESULTADO = Object.freeze({
  cobrancaExistente: '⚠ Esta cobrança já existia para este trabalho',
  obrigado: 'Obrigado pela preferência 💚',
  confirmadoFinanceiro: 'Pagamento confirmado pelo Asaas e lançado no financeiro do cliente.',
  mostreQr: 'Mostre o QR Code abaixo para o cliente',
  cartaoAntes: 'Entrou como ',
  cartaoAReceber: 'a receber',
  cartaoDepois:
    ' (sem Asaas). Passe o cartão na maquineta e confirme o recebimento — cai no caixa como cartão. Dá para confirmar depois no Financeiro do cliente também.',
  linkCliente: '💳 Link de pagamento para o cliente',
  compartilheLink: 'Compartilhe esse link com o cliente. Ele vai preencher os dados do cartão em página segura do Asaas.',
  acompanheAntes: '🔔 Você acompanha o status na aba ',
  acompanheAba: 'Financeiro',
  acompanheDepois: ' do cliente.',
});

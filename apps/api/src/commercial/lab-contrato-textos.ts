/**
 * Laboratório — textos do contrato de prestação de serviços de prótese dentária
 * no servidor: o PDF (contrato-laboratorio.ts), o checklist de dados que faltam,
 * as mensagens do envio pelo WhatsApp e os registros da linha do tempo do
 * contrato. Só o ramo do laboratório importa daqui; a clínica não lê este arquivo.
 *
 * MODELO INICIAL: o texto das cláusulas é um ponto de partida, escrito para ser
 * revisado pelo advogado do laboratório antes do uso. A tela de configuração dos
 * contratos mostra esse aviso e oferece o PDF de exemplo.
 *
 * Regras deste arquivo (scripts/ci/check-pick-literals.mjs):
 *   - só as consts LAB_: qualquer string fora delas conta como texto de clínica num
 *     arquivo novo e reprova a trava 1;
 *   - nenhum termo da lista PROIBIDOS do script (trava 2). Quem é atendido pelo
 *     caso é "paciente do caso" (frase permitida), nunca "paciente" solto.
 */

/** Contexto que as cláusulas usam (já formatado por quem desenha). */
export type ContextoDasClausulas = {
  numeroOrcamento: string;
  valor: string;
  valorExtenso: string;
  pagamento: string | null;
  foro: string;
};

export type ClausulaDoContrato = { titulo: string; paragrafos: string[] };

export const LAB_CONTRATO_PDF = Object.freeze({
  // ── cabeçalho e título
  nomePadraoDaConta: 'Laboratório',
  subtitulo: 'Laboratório de prótese dentária',
  cnpjDaConta: (doc: string) => `CNPJ: ${doc}`,
  titulo: 'CONTRATO DE PRESTAÇÃO DE SERVIÇOS DE PRÓTESE DENTÁRIA',
  tituloDoc: (numero: string, cliente: string) => `Contrato — orçamento nº ${numero} — ${cliente}`,
  assunto: 'Contrato de prestação de serviços de prótese dentária',
  referenciaOrcamento: (numero: string) => `Orçamento nº ${numero}`,
  // ── partes
  tituloPartes: 'DAS PARTES',
  contratante: 'CONTRATANTE: ',
  contratada: 'CONTRATADA: ',
  semNome: '—',
  clienteDentista: 'cirurgião(ã)-dentista',
  clienteClinica: 'clínica odontológica',
  documentoDoCliente: (doc: string) => `CPF/CNPJ: ${doc}`,
  croDoCliente: (cro: string) => `CRO: ${cro}`,
  telefone: (tel: string) => `Telefone: ${tel}`,
  email: (email: string) => `E-mail: ${email}`,
  representadaPor: (nome: string) => `representada por ${nome}`,
  qualificacaoCnpj: (cnpj: string) => `inscrita no CNPJ sob o nº ${cnpj}`,
  qualificacaoSede: (endereco: string) => `com sede em ${endereco}`,
  qualificacaoInscricaoCro: (insc: string) => `inscrita no CRO sob o nº ${insc}`,
  qualificacaoResponsavel: (nome: string, cro: string) =>
    `neste ato representada por seu responsável técnico ${nome}` + (cro ? `, inscrito(a) no CRO sob o nº ${cro}` : ''),
  // ── assinatura e rodapé
  assinaturaCliente: 'CONTRATANTE',
  assinaturaLaboratorio: 'CONTRATADA',
  responsavelTecnico: (nome: string, cro: string) => `${nome}${cro ? ` — CRO ${cro}` : ''}`,
  localEData: (local: string, data: string) => `${local}, ${data}`,
  rodape: (id: string, gerado: string, marca: string) => `Contrato ${id} · Gerado em ${gerado}${marca}`,
  marcaPrevia: ' · PRÉ-VISUALIZAÇÃO (não assinado)',
  marcaCancelado: ' · CANCELADO',
  marcaExpirado: ' · EXPIRADO',
  marcaModelo: ' · MODELO DE EXEMPLO (não assinar)',
  // ── anexo com os serviços
  anexoTitulo: 'ANEXO I — SERVIÇOS CONTRATADOS',
  colServico: 'Serviço',
  colElemento: 'Elemento',
  colQtd: 'Qtd',
  colPrazo: 'Prazo (dias)',
  colGarantia: 'Garantia (dias)',
  colTotal: 'Valor',
  servicoSemNome: 'Serviço',
  semElemento: '-',
  semPrazo: 'a combinar',
  semGarantia: 'conforme a lei',
  obs: (nota: string) => `  obs: ${nota}`,
  totalDoAnexo: 'TOTAL:',
  pagamentoDoAnexo: (forma: string) => `Forma de pagamento: ${forma}`,
  // ── valores de exemplo do modelo
  modelo: Object.freeze({
    cliente: '[nome do cliente]',
    documento: '[CPF ou CNPJ do cliente]',
    servico: 'Serviço de exemplo',
  }),

  /**
   * Cláusulas do contrato (MODELO INICIAL, para revisão do advogado do
   * laboratório). Os números de prazo e de garantia de cada serviço vêm do
   * cadastro do serviço, no Anexo I; nenhum prazo, percentual de garantia ou
   * valor é fixado aqui, exceto multa e juros de mora da cláusula 5ª.
   */
  clausulas: (c: ContextoDasClausulas): ClausulaDoContrato[] => [
    {
      titulo: 'CLÁUSULA 1ª — DO OBJETO',
      paragrafos: [
        `1.1. O presente contrato tem por objeto a prestação, pela CONTRATADA, de serviços de confecção de trabalhos de prótese dentária sob encomenda, descritos no ANEXO I (orçamento nº ${c.numeroOrcamento}), que faz parte deste contrato.`,
        '1.2. Os trabalhos são confeccionados a partir de moldagens, modelos, escaneamentos, registros, fotografias e especificações fornecidos pelo CONTRATANTE. A CONTRATADA responde pela execução técnica do trabalho; o CONTRATANTE responde pela indicação, pelo planejamento e pelo acompanhamento do caso.',
      ],
    },
    {
      titulo: 'CLÁUSULA 2ª — DAS OBRIGAÇÕES DO CONTRATANTE',
      paragrafos: [
        '2.1. Prescrever cada trabalho por ordem de serviço escrita ou pelo sistema, informando serviço, elemento, cor, material e demais especificações necessárias.',
        '2.2. Entregar moldagens, modelos e arquivos digitais em condições técnicas adequadas à execução e comunicar de imediato qualquer mudança na prescrição.',
        '2.3. A avaliação clínica, o diagnóstico, a indicação do trabalho, a prova, a instalação e o acompanhamento do paciente do caso são de responsabilidade exclusiva do CONTRATANTE.',
        '2.4. Pagar o preço no prazo e nas condições da cláusula 5ª.',
      ],
    },
    {
      titulo: 'CLÁUSULA 3ª — DAS OBRIGAÇÕES DA CONTRATADA',
      paragrafos: [
        '3.1. Executar os trabalhos com técnica adequada, com materiais regularizados perante a autoridade sanitária e sob a responsabilidade técnica de profissional inscrito no Conselho Regional de Odontologia.',
        '3.2. Avisar o CONTRATANTE, antes de iniciar ou durante a execução, sobre qualquer impossibilidade técnica identificada na moldagem, no modelo ou no arquivo recebido.',
        '3.3. Identificar cada peça de modo a permitir sua rastreabilidade e guardar sigilo sobre as informações do caso.',
      ],
    },
    {
      titulo: 'CLÁUSULA 4ª — DO PRAZO E DA ENTREGA',
      paragrafos: [
        '4.1. O prazo de entrega de cada serviço é o indicado no ANEXO I e conta do recebimento completo do material e da aprovação do orçamento. Para o serviço sem prazo indicado, a entrega será combinada por escrito.',
        '4.2. O prazo fica suspenso enquanto a CONTRATADA aguardar informação, material, prova ou aprovação do CONTRATANTE.',
        '4.3. Este contrato vigora até a entrega dos serviços do ANEXO I e a quitação do preço, sem prejuízo da garantia e das cláusulas que, por sua natureza, continuam valendo depois do término.',
      ],
    },
    {
      titulo: 'CLÁUSULA 5ª — DO PREÇO E DO PAGAMENTO',
      paragrafos: [
        `5.1. O preço total dos serviços é de R$ ${c.valor} (${c.valorExtenso}), conforme o ANEXO I.`,
        c.pagamento
          ? `5.2. Forma de pagamento: ${c.pagamento}.`
          : `5.2. Forma de pagamento: a condição aprovada no orçamento nº ${c.numeroOrcamento}.`,
        '5.3. O atraso no pagamento sujeita o CONTRATANTE a multa de 2% (dois por cento) e a juros de mora de 1% (um por cento) ao mês sobre o valor em atraso. Enquanto houver valor vencido e não pago, a CONTRATADA pode suspender novas entregas.',
      ],
    },
    {
      titulo: 'CLÁUSULA 6ª — DA PROVA, DA APROVAÇÃO E DAS ALTERAÇÕES',
      paragrafos: [
        '6.1. Quando o serviço tiver etapa de prova, a CONTRATADA envia a peça para prova e o CONTRATANTE a devolve com a aprovação ou com os ajustes necessários.',
        '6.2. Mudanças de prescrição, material, cor ou desenho depois do início da execução ou da aprovação podem alterar o prazo e o preço. A CONTRATADA informará a diferença antes de executar, e o novo trabalho será cobrado como serviço adicional.',
      ],
    },
    {
      titulo: 'CLÁUSULA 7ª — DA GARANTIA E DO RETRABALHO',
      paragrafos: [
        '7.1. A CONTRATADA garante os trabalhos contra defeitos de fabricação e de adaptação decorrentes de falha de sua execução, pelo prazo de garantia indicado no ANEXO I para cada serviço. O serviço sem prazo indicado tem a garantia que a lei assegura.',
        '7.2. Dentro do prazo de garantia, havendo defeito decorrente de falha de execução da CONTRATADA, a peça devolvida para análise será reparada ou refeita sem custo de mão de obra, em novo prazo a ser combinado.',
        '7.3. A garantia não cobre: fratura ou desgaste causado por trauma, mau uso, bruxismo ou falta de higiene; defeito decorrente de moldagem, modelo ou arquivo inadequado ou de prescrição incorreta; peça ajustada, reparada ou alterada por terceiros; e mudança no quadro clínico do caso. A refação pedida por mudança de indicação é cobrada como novo serviço.',
      ],
    },
    {
      titulo: 'CLÁUSULA 8ª — DOS ARQUIVOS, DOS MODELOS E DA PROPRIEDADE',
      paragrafos: [
        '8.1. Moldagens, modelos, escaneamentos, fotografias e demais materiais fornecidos pelo CONTRATANTE continuam sendo dele. A CONTRATADA os usa somente para executar este contrato e pode guardá-los pelo tempo necessário à execução, à garantia e ao cumprimento de obrigação legal.',
        '8.2. Os projetos digitais, desenhos de CAD e arquivos de fabricação criados pela CONTRATADA pertencem a ela e não estão incluídos no preço, salvo ajuste por escrito. Mediante pedido por escrito, a CONTRATADA pode fornecer cópia do arquivo final da peça para o registro do caso; a cessão do projeto para fabricação em outro local depende de ajuste específico.',
        '8.3. Os direitos sobre a peça entregue passam ao CONTRATANTE com o pagamento integral do preço.',
      ],
    },
    {
      titulo: 'CLÁUSULA 9ª — DA PROTEÇÃO DE DADOS (LGPD)',
      paragrafos: [
        '9.1. As partes cumprirão a Lei nº 13.709/2018 (Lei Geral de Proteção de Dados) no tratamento de dados pessoais ligados a este contrato.',
        '9.2. Quanto aos dados dos pacientes do caso, o CONTRATANTE é o controlador e deve informar à CONTRATADA somente o necessário para a execução, preferindo a identificação do caso sem dados que identifiquem diretamente a pessoa. A CONTRATADA atua como operadora: trata esses dados apenas conforme as instruções do CONTRATANTE e para executar este contrato.',
        '9.3. A CONTRATADA trata os dados cadastrais do próprio CONTRATANTE para executar o contrato, cobrar o preço e cumprir obrigações legais.',
        '9.4. A CONTRATADA adotará medidas de segurança adequadas, comunicará ao CONTRATANTE qualquer incidente que afete os dados do caso e eliminará os dados ao fim do contrato, respeitados os prazos de guarda exigidos em lei.',
      ],
    },
    {
      titulo: 'CLÁUSULA 10ª — DA RESCISÃO',
      paragrafos: [
        '10.1. Qualquer das partes pode rescindir este contrato mediante comunicação por escrito.',
        '10.2. Na rescisão, o CONTRATANTE paga os serviços já entregues e, pelos serviços em execução, o valor proporcional ao trabalho realizado e aos materiais já adquiridos ou usados.',
        '10.3. O descumprimento grave de qualquer obrigação autoriza a rescisão imediata pela outra parte.',
      ],
    },
    {
      titulo: 'CLÁUSULA 11ª — DISPOSIÇÕES GERAIS',
      paragrafos: [
        '11.1. As comunicações entre as partes podem ser feitas por escrito, inclusive por WhatsApp e por e-mail, nos contatos informados no cadastro.',
        '11.2. Este contrato pode ser assinado por meio eletrônico, e as assinaturas assim feitas são válidas nos termos da Medida Provisória nº 2.200-2/2001 e da Lei nº 14.063/2020.',
        '11.3. A tolerância de uma parte com o descumprimento da outra não muda o contrato nem impede a cobrança posterior.',
        '11.4. O ANEXO I faz parte deste contrato. Havendo diferença entre o anexo e as cláusulas, valem as cláusulas.',
      ],
    },
    {
      titulo: 'CLÁUSULA 12ª — DO FORO',
      paragrafos: [
        `12.1. Fica eleito o foro da comarca de ${c.foro} para resolver qualquer questão deste contrato, com renúncia a qualquer outro, por mais privilegiado que seja.`,
      ],
    },
  ],
});

/** Checklist de dados que faltam para gerar o contrato (rótulos que a tela mostra). */
export const LAB_CONTRATO_COMPLETUDE = Object.freeze({
  clienteNome: 'Nome do cliente',
  clienteDocumento: 'CPF ou CNPJ do cliente',
  clienteEndereco: 'Endereço do cliente',
  clienteCidade: 'Cidade do cliente',
  clienteCro: 'CRO do cliente',
  clienteTelefone: 'Telefone do cliente',
  labNome: 'Nome do laboratório',
  labCnpj: 'CNPJ do laboratório',
  labEndereco: 'Endereço do laboratório',
  labCidade: 'Cidade do laboratório (foro do contrato)',
  labInscricaoCro: 'Inscrição do laboratório no CRO',
  responsavelNome: 'Nome do responsável técnico do laboratório',
  responsavelCro: 'CRO do responsável técnico do laboratório',
  valor: 'Valor do orçamento',
});

/** Mensagens do fluxo do contrato: linha do tempo, envio e recusas. */
export const LAB_CONTRATO_MSG = Object.freeze({
  // ── linha do tempo (descrição gravada no evento)
  eventoCriado: 'Documento gerado a partir do modelo de prestação de serviços do laboratório',
  eventoEnviadoManual: 'Enviado ao cliente (manual)',
  eventoClienteAbriu: 'O cliente abriu o documento (manual)',
  eventoClienteAssinou: 'O cliente assinou (manual)',
  eventoLaboratorioAssinou: 'O laboratório assinou — contrato finalizado',
  // ── criação
  faltamDados: (lista: string) => `Faltam dados para gerar o contrato: ${lista}. Complete o cadastro antes de criar.`,
  // ── assinatura digital: a conta da ClickSign é da plataforma e não é usada pelo laboratório
  clicksignIndisponivel:
    'A assinatura pela ClickSign ainda não está disponível no laboratório. Envie o PDF pelo WhatsApp e registre a assinatura no contrato.',
  // ── WhatsApp
  legenda: (primeiroNome: string, laboratorio: string) =>
    `Olá${primeiroNome ? `, ${primeiroNome}` : ''}!\n\n` +
    `Segue em PDF o contrato de prestação de serviços com ${laboratorio}, para você ler com calma.\n\n` +
    'Qualquer dúvida, é só responder esta mensagem.',
  laboratorioPadrao: 'o laboratório',
  clientePadrao: 'Cliente',
  arquivoPadrao: 'cliente',
  rotuloChip: Object.freeze({ CLINICA: 'Atendimento', COMERCIAL: 'Comercial' }),
  inativo: 'Contrato cancelado ou expirado — não dá para enviar.',
  semTelefone: 'Cliente sem telefone válido no cadastro — adicione o telefone antes de enviar.',
  telefoneDiferente: (finalCadastro: string, finalContato: string) =>
    `O telefone do cadastro (final ${finalCadastro}) é diferente do contato do WhatsApp (final ${finalContato}) — corrija o cadastro do cliente antes de enviar.`,
  semChip:
    'Nenhum WhatsApp de Atendimento ou Comercial cadastrado — o contrato não sai pelo número do Financeiro. Configure em Configurações › WhatsApp.',
  contatoSeraVinculado: 'Cliente ainda sem contato no WhatsApp — o sistema vincula ou cria pelo telefone ao enviar.',
  semCaixaDeEntrada: 'Sem caixa de entrada de Atendimento ou Comercial para esse cliente — configure o WhatsApp do laboratório.',
});

/**
 * Laboratório — textos do card de contrato do orçamento (ContratoLaboratorioCard) e da
 * tela de configuração dos contratos.
 *
 * Só texto. A clínica não usa nada daqui: o orçamento escolhe o card pelo tipo de negócio
 * da sessão e a clínica segue com o ContratoCard de sempre. Este arquivo só tem consts
 * LAB_*: fica sob as travas de scripts/ci/check-pick-literals.mjs, e nenhum texto fora
 * delas pode entrar aqui.
 *
 * O texto do contrato em si (cláusulas) é um MODELO INICIAL, escrito no servidor
 * (commercial/lab-contrato-textos.ts), para o laboratório revisar com o advogado dele.
 */

/** Card do contrato no orçamento. */
export const LAB_CONTRATO_CARD = Object.freeze({
  titulo: 'Contrato de prestação de serviços',
  geradoPara: 'Gerado para:',
  orcamentoPadrao: 'Orçamento',
  carregando: 'Carregando contrato...',
  status: Object.freeze({
    naoEnviado: 'NÃO ENVIADO',
    assinado: 'ASSINADO',
    aguardandoLaboratorio: 'AGUARDANDO O LABORATÓRIO',
    enviado: 'ENVIADO',
    cancelado: 'CANCELADO',
    expirado: 'EXPIRADO',
  }),
  passos: Object.freeze({ montar: 'Montar', enviar: 'Enviar', assinar: 'Assinar' }),
  // ── o que vai no contrato
  oQueVai: 'O que vai no contrato',
  oQueVaiTexto:
    'Contrato de prestação de serviços de prótese dentária, com as cláusulas do laboratório (objeto, prazo, garantia e retrabalho, pagamento, arquivos, LGPD e foro) e o anexo com os serviços, prazos e valores deste orçamento.',
  modeloAviso: 'O texto do contrato é um modelo inicial. Revise com o seu advogado em Configurações › Contratos.',
  verModelo: 'Ver o modelo',
  // ── quem assina
  quemAssina: 'Quem vai assinar',
  clienteRotulo: 'Cliente',
  clienteSemNome: 'Cliente',
  responsavelRotulo: 'Responsável técnico do laboratório',
  responsavelFalta: 'Responsável técnico não cadastrado',
  assinou: 'ASSINOU',
  aguardando: 'AGUARDANDO',
  // ── dados que faltam
  faltamNoContrato: 'Faltam dados neste contrato:',
  faltamParaGerar: 'Faltam dados para gerar o contrato:',
  completeNoCadastro: 'Complete no cadastro do cliente e em Configurações → Identidade do laboratório (responsável técnico e CRO).',
  tudoCompleto: 'Todos os dados obrigatórios estão completos — pode gerar o contrato.',
  // ── rodapé e botões
  rodape: 'O PDF segue pelo WhatsApp e a assinatura é registrada aqui, no contrato.',
  previa: 'Pré-visualizar PDF',
  previaTitulo: 'Ver a prévia do contrato (sem criar ainda)',
  baixar: 'Baixar PDF',
  baixarTitulo: 'Baixar o PDF do contrato para imprimir ou guardar',
  whatsapp: 'Enviar no WhatsApp',
  whatsappTitulo: 'Enviar o PDF do contrato na conversa do cliente (WhatsApp de Atendimento ou Comercial)',
  criar: 'Criar contrato',
  criarTitulo: 'Criar o contrato em rascunho',
  completeAntes: (lista: string) => `Complete antes: ${lista}`,
  marcarEnviado: 'Marcar como enviado',
  clienteAssinou: 'Cliente assinou',
  laboratorioAssinou: 'Laboratório assinou',
  cancelarTitulo: 'Cancelar contrato',
  cancelarConfirma: 'Cancelar o contrato atual? Você pode criar um novo depois.',
  // ── avisos
  criado: 'Contrato criado — pronto para enviar',
  atualizado: 'Contrato atualizado',
  erroCriar: 'Erro ao criar contrato',
  erroAtualizar: 'Erro ao atualizar contrato',
  erroPdf: 'Erro ao gerar o PDF',
  erroPrevia: 'Erro ao gerar prévia',
  erroBaixar: 'Erro ao baixar PDF',
  erroPreparar: 'Erro ao preparar o envio',
  erroEnviar: 'Erro ao enviar no WhatsApp',
  escrevaMensagem: 'Escreva a mensagem que vai junto do contrato.',
  popupBloqueado: 'O navegador bloqueou a nova aba — permita pop-ups para este site.',
  contratoEnviadoToast: (chip: string) => `Contrato enviado no WhatsApp (${chip})`,
  // ── modal do WhatsApp
  modalTitulo: 'Enviar contrato no WhatsApp',
  modalSubtitulo: 'O PDF vai anexado, com a mensagem abaixo como legenda.',
  preparando: 'Preparando o envio...',
  contratoEnviado: 'Contrato enviado',
  saiuPor: (chip: string, nome: string) => `Saiu pelo WhatsApp ${chip} para ${nome}. Já aparece no histórico da conversa.`,
  para: 'Para: ',
  final: (digitos: string) => ` · final ${digitos}`,
  saiPor: 'Sai pelo WhatsApp ',
  saiPorFim: ' do laboratório (nunca pelo número do Financeiro).',
  placeholder: 'Mensagem que vai junto do contrato',
  fechar: 'Fechar',
  cancelar: 'Cancelar',
  enviar: 'Enviar',
  enviando: 'Enviando...',
  verNaConversa: 'Ver na conversa',
});

/** Tela de configuração dos contratos (Configurações › Contratos). */
export const LAB_CONTRATO_CONFIG = Object.freeze({
  titulo: 'Contratos',
  subtitulo: 'O contrato de prestação de serviços de prótese dentária que o laboratório envia aos clientes.',
  avisoTitulo: 'Modelo inicial: revise com o seu advogado',
  avisoTexto:
    'O texto das cláusulas é um modelo inicial, escrito como ponto de partida. Antes de usar com clientes, o laboratório deve revisá-lo com o advogado dele (garantia, retrabalho, multa e juros, propriedade dos arquivos, LGPD e foro).',
  modeloTitulo: 'Modelo do contrato',
  modeloTexto:
    'Veja o contrato de exemplo, já com os dados do laboratório (razão social, CNPJ, endereço, responsável técnico e CRO) e com o cliente e os serviços em branco.',
  modeloBotao: 'Abrir o modelo em PDF',
  modeloAbrindo: 'Abrindo...',
  modeloErro: 'Não foi possível abrir o modelo do contrato.',
  popupBloqueado: 'O navegador bloqueou a nova aba — permita pop-ups para este site.',
  dadosTitulo: 'De onde vêm os dados do contrato',
  dadosItens: Object.freeze([
    'Laboratório: razão social, CNPJ, endereço e cidade (foro) vêm de Configurações › Identidade do laboratório.',
    'Responsável técnico e CRO do laboratório: vêm do cadastro do laboratório; se faltarem, o contrato não é gerado.',
    'Cliente: nome, CPF ou CNPJ, endereço e cidade vêm do cadastro do cliente; o CRO vem da ficha quando o cliente é dentista.',
    'Serviços: o anexo traz os serviços do orçamento, com o prazo e a garantia (em dias) de cada serviço na tabela de serviços.',
  ]),
  identidadeLink: 'Abrir a Identidade do laboratório',
  assinaturaTitulo: 'Assinatura',
  assinaturaTexto:
    'No laboratório o PDF do contrato é enviado pelo WhatsApp e a assinatura do cliente e do laboratório é registrada no próprio contrato. A assinatura digital pela ClickSign ainda não está disponível para o laboratório: a conta da ClickSign é da plataforma e o laboratório precisaria da conta dele.',
  passosTitulo: 'Como funciona',
  passos: Object.freeze([
    'No orçamento aprovado, abra o card "Contrato de prestação de serviços" e confira o que falta.',
    'Crie o contrato e pré-visualize o PDF.',
    'Envie o PDF pelo WhatsApp (você escreve a mensagem) ou imprima para assinar.',
    'Registre a assinatura do cliente e do laboratório no card. Nada é enviado sozinho.',
  ]),
});

/** Tela da nota fiscal (NFS-e) do laboratório. */
export const LAB_NFSE_TELA = Object.freeze({
  titulo: 'Nota Fiscal Eletrônica (NFS-e)',
  subtitulo: 'Configuração da nota fiscal de serviço do laboratório',
  avisoSimulada:
    'Atenção: a emissão ainda é simulada. O sistema registra a nota com número de teste e não envia nada à prefeitura nem ao provedor. Continue emitindo a nota oficial pelo seu meio de sempre.',
  configurado: 'Configurado',
  naoConfigurado: 'Não configurado',
  emissaoAutomaticaAtiva: 'Emissão automática ativa (simulada)',
  provedor: 'Provedor NFS-e',
  site: 'Site',
  chaveDo: (provedor: string) => `Chave da API do ${provedor}`,
  chaveJaConfigurada: '••••••••••• (já configurada)',
  chavePlaceholder: 'Cole a chave da API aqui',
  cnpj: 'CNPJ do laboratório',
  cnpjPlaceholder: '00.000.000/0001-00',
  inscricaoMunicipal: 'Inscrição municipal',
  inscricaoPlaceholder: 'Nº da inscrição municipal',
  codigoServico: 'Código do serviço (CNAE)',
  codigoServicoPlaceholder: 'Informe o código do seu serviço',
  codigoServicoDica: 'O laboratório informa o código do serviço e o CNAE da sua atividade; o sistema não preenche por você.',
  aliquota: 'Alíquota do ISS (%)',
  aliquotaPlaceholder: 'Informe a alíquota do seu município',
  descricao: 'Descrição do serviço',
  descricaoPlaceholder: 'Serviços de prótese dentária',
  emissaoAutomatica: 'Emissão automática (simulada)',
  emissaoAutomaticaLigada: 'Ligada, mas simulada: nenhuma nota oficial é emitida. Nada vai à prefeitura nem ao provedor.',
  emissaoAutomaticaDesligada: 'Desligada. A emissão ainda é simulada: emita a nota oficial pelo seu meio de sempre.',
  salvar: 'Salvar configuração',
  salvo: 'Salvo!',
  erroSalvar: 'Erro ao salvar',
});

/**
 * F4 do laboratório — o texto que a conta de LABORATÓRIO recebe no lugar das
 * mensagens da API com vocabulário de clínica (mensagens-api-clinica.ts).
 *
 * Mesmas chaves (identificadores, sem aspas), outro texto. Quem troca é o
 * LabVocabInterceptor, só na conta de laboratório; a clínica nunca passa por aqui.
 * Nos moldes, os trechos {1}, {2}... são os mesmos do molde da clínica.
 *
 * Regras deste arquivo (scripts/ci/check-pick-literals.mjs):
 *   - só o import de tipo e as duas consts LAB_: qualquer string fora delas conta
 *     como texto de clínica num arquivo novo e reprova a trava 1;
 *   - nenhum termo da lista PROIBIDOS do script (trava 2);
 *   - "sua/nesta clínica" falando da própria conta vira "laboratório"; o cliente do
 *     laboratório (dentista ou clínica) é "cliente" nas frases.
 */
import type { MENSAGENS_API_CLINICA, MOLDES_API_CLINICA } from './mensagens-api-clinica';

export const LAB_API_MESSAGES = Object.freeze({
  pacienteNaoEncontrado: 'Cliente não encontrado',
  pacienteNaoEncontradoSemAcento: 'Cliente não encontrado',
  pacienteForaDaCarteira: 'Cliente fora da sua carteira',
  pacienteOuLeadInvalido: 'Cliente/contato inválido.',
  instanciaDeOutraConta: 'Esta instância pertence a outra conta.',
  setorForaDaConta: 'Setor não encontrado neste laboratório. Recarregue a página e tente de novo.',
  financeiroNaoEnvia: 'Conversa do Financeiro — mensagem para o cliente não sai pelo número de cobrança.',
  semChipAtendimento:
    'Nenhum WhatsApp Atendimento/Comercial cadastrado — a mensagem não sai pelo Financeiro. Configure em Configurações › WhatsApp.',
  linkSemPonto:
    'Esse link não traz o ponto exato do laboratório. No Google Maps, abra o laboratório e use "Compartilhar", ou toque e segure em cima dele e copie os números que aparecem.',
  usuarioForaDaConta: 'Usuário não encontrado neste laboratório.',
  horarioSalvo: 'Horário do laboratório salvo',
  soAdminEditaConta: 'Só ADMIN pode editar dados do laboratório',
  limiteDeChips: 'Limite de 3 WhatsApps por laboratório (1 Comercial + 1 Atendimento + 1 Financeiro) atingido.',
  linhaDeOutraConta: 'Essa linha de WhatsApp não pertence ao seu laboratório',
  linhaNaoRegistrada: 'Linha ainda não registrada pro seu laboratório — reabra a tela e tente de novo.',
  semTelefoneConversa: 'Cliente sem telefone — não dá para criar a conversa',
  semChipFotos: 'Nenhum chip WhatsApp do laboratório conectado pra buscar as fotos.',
  rotuloChipClinica: 'Atendimento',

  soAdminArquiva: 'Apenas ADMIN pode arquivar cliente',
  soAdminExclui: 'Apenas ADMIN pode excluir cliente permanentemente',
  soAdminTrocaFoto: 'Apenas ADMIN pode alterar a foto do cliente',
  soAdminRemoveFoto: 'Apenas ADMIN pode remover a foto do cliente',
  cpfDuplicado: 'Já existe um cliente com este CPF/CNPJ neste laboratório',
  cpfEmUso: 'Outro cliente já usa este CPF/CNPJ',
  responsavelInvalido: 'Protético inválido',
  procedimentoNaoEncontrado: 'Serviço não encontrado',
  especialidadeNaoEncontrada: 'Grupo de serviço não encontrado',
  orcamentoForaDaCarteira: 'Orçamento de cliente fora da sua carteira',
  trabalhoNaoCriado: 'Trabalho não foi criado — verifique se o orçamento tem itens',
  responsavelDaVendaInvalido: 'Protético responsável inválido para este laboratório.',
  vendaSemValor: 'Venda sem valor — confira os serviços.',
  precoMudou: 'O preço de algum serviço mudou — atualize a página e confira o total.',
  semCpfNaVenda: 'Cliente sem CPF/CNPJ cadastrado. Edite o cliente e adicione o CPF ou o CNPJ antes de gerar a cobrança.',
  semTelefoneNaVenda: 'Cliente sem telefone. Edite o cliente e adicione o telefone antes de gerar a cobrança.',
  telefoneDeOutroCliente:
    'Este telefone já pertence a outro contato/cliente. Dois clientes não podem dividir o mesmo número na cobrança — ajuste o telefone deste cliente antes de gerar a cobrança.',
  semTelefoneOrcamento: 'Cliente sem telefone cadastrado — adicione antes de enviar via WhatsApp.',
  semChipOrcamento:
    'Nenhum WhatsApp Atendimento/Comercial cadastrado — o orçamento não sai pelo número do Financeiro. Configure em Configurações › WhatsApp.',
  semCaixaDeEntrada: 'Sem caixa de entrada Atendimento/Comercial pra esse cliente — configure o WhatsApp do laboratório.',
  trabalhoSemValor: 'Trabalho com valor total zero — adicione serviços antes de cobrar',
  semContaAsaas:
    'Este laboratório não tem a conta Asaas cadastrada. Cadastre a chave de API do Asaas em Configurações → Gateway de pagamento para gerar PIX/boleto/cartão online, ou use uma forma de recebimento no laboratório.',
  trabalhoNaoEncontrado: 'Trabalho não encontrado',
  nenhumTrabalho: 'Nenhum trabalho informado',
  planoCanceladoNaoValida: 'Trabalho cancelado — não pode ser validado',
  responsavelForaDaConta: 'Responsável inválido — tem que ser um protético deste laboratório.',
  concluirServico: 'Para concluir um serviço use "Confirmar/Validar" (registra quem fez).',
  agendamentoDeOutraConta: 'Agendamento informado não é deste laboratório.',
  contaDeOutraEmpresa: 'Contas de outras empresas não entram no caixa do laboratório — use "marcar como pago".',
  asaasNaoConfigurado:
    'Cobrança Asaas não está configurada para este laboratório. Configure a conta Asaas do laboratório no cadastro do gateway (ou use recebimento no laboratório assim que o suporte habilitar).',
  asaasNaoConfiguradoCurto: 'Cobrança Asaas não está configurada para este laboratório.',
  cobrancaDeOutraConta: 'Cobrança de outra conta',
  semTelefoneCobranca: 'Cliente sem telefone cadastrado',
  semChipCobranca: 'Nenhuma instância WhatsApp configurada pra este laboratório. Configure em Configurações › WhatsApp.',
  semCpfCobranca: 'Cliente sem CPF — cadastre antes de gerar a cobrança',
  semContatoCobranca: 'Cliente não vinculado a um contato — necessário para gerar cobrança via Asaas',
  semContatoAsaas: 'Cliente não vinculado a um contato — necessário para o Asaas',
  clienteOuContaNaoIdentificados: 'Cliente/conta não identificados',

  itemDeOutroResponsavel: 'Este serviço é de outro protético — só ele ou o administrador pode concluir.',
  soResponsavelConclui: 'Só um protético ou o administrador pode concluir o serviço.',
  aguardandoFinanceiro: 'Aguardando validação do Financeiro — o trabalho ainda não foi liberado para a produção.',
  trabalhoCanceladoNaoConclui: 'Trabalho cancelado — o serviço não pode ser concluído.',
  parcelasJaEmitidas:
    'Este trabalho já tem parcelas emitidas. Recarregue a página. Se precisar reemitir, cancele as cobranças ativas primeiro.',

  tipoInvalidoDto: 'Tipo de agendamento inválido. Use Coleta, Prova, Entrega, Tarefa, Outro ou Bloqueio.',
  testeSemChip: 'Nenhum WhatsApp conectado neste laboratório. Conecte o WhatsApp primeiro.',
} satisfies Record<keyof typeof MENSAGENS_API_CLINICA, string>);

export const LAB_API_MOLDES = Object.freeze({
  jaTemChipDaFuncao: 'Seu laboratório já tem um WhatsApp {1} ("{2}"). Pra trocar, remova a linha atual primeiro.',
  jaTemChipConectado: 'Seu laboratório já possui um WhatsApp conectado ("{1}"). Pra trocar de número, remova a linha atual primeiro.',
  funcaoJaEmUso: 'Seu laboratório já tem um WhatsApp {1} ("{2}").',
  semChipDaFuncao: 'Seu laboratório não tem um WhatsApp {1} conectado.',
  telefoneDiferente:
    'O telefone do cadastro (final {1}) é diferente do contato do WhatsApp (final {2}) — corrija o cadastro do cliente antes de enviar.',
  pontoForaDaArea: 'Você está a {1} do laboratório (área de {2} m). O ponto só pode ser registrado no local.',
  limiteDoPlano: 'Limite do plano {1} atingido pra clientes ({2}/{3}). Atualize o plano pra continuar.',
  procedimentoIdNaoEncontrado: 'Serviço {1} não encontrado',
  devedorNaAgenda: 'Cliente com {1} boleto(s) em atraso ({2}). Regularize no Financeiro ou peça a um administrador para liberar.',
  edicaoSoStatus: 'Sem permissão para alterar: {1}. O protético pode mudar apenas o status do próprio evento.',
  testeNaoEnviou: 'Não enviou: {1}. Verifique se o WhatsApp do laboratório está conectado.',
} satisfies Record<keyof typeof MOLDES_API_CLINICA, string>);

/**
 * F4 do laboratório — mensagens que a API devolve HOJE com vocabulário de clínica.
 *
 * Cópia EXATA (acento, espaço, pontuação) do literal de cada serviço, com chave
 * neutra. Nenhum serviço lê este arquivo: a clínica continua recebendo o literal do
 * próprio serviço. Só o LabVocabInterceptor lê, e só na conta de laboratório, para
 * trocar a mensagem pelo texto da mesma chave em LAB_API_MESSAGES/LAB_API_MOLDES
 * (lab-api-messages.ts).
 *
 * MENSAGENS: texto fixo, trocado só quando a mensagem inteira é igual.
 * MOLDES: texto com trecho variável, marcado com {1}, {2}... Também só troca quando
 * a mensagem inteira bate com o molde; cada trecho variável passa pelo mapa exato.
 *
 * Ficam de fora de propósito: valores de enum (COMERCIAL/CLINICA/FINANCEIRO), as
 * mensagens que só saem de rota negada ao laboratório (IA, ortodontia, contrato,
 * TCLE, promover/rebaixar contato) e as da agenda (calendar.*, fase da agenda).
 *
 * O spec __guards__/lab-vocab.spec.ts confere que cada texto daqui ainda existe igual
 * em apps/api/src: se alguém mudar a frase no serviço, ele avisa para atualizar aqui.
 */
export const MENSAGENS_API_CLINICA = Object.freeze({
  // ─── Telas da F4 (inbox, chat, caixa, ponto, configurações) ─────────────────
  // team-chat.service.ts, patient-tags.service.ts, quotes.service.ts
  pacienteNaoEncontrado: 'Paciente não encontrado',
  // patients.service.ts, installments.service.ts, quotes.service.ts, treatment-plans.service.ts...
  pacienteNaoEncontradoSemAcento: 'Paciente nao encontrado',
  // team-chat.service.ts
  pacienteForaDaCarteira: 'Paciente fora da sua carteira',
  // caixa.service.ts
  pacienteOuLeadInvalido: 'Paciente/lead invalido.',
  // inboxes.service.ts
  instanciaDeOutraConta: 'Esta instância pertence a outra clínica.',
  // users.service.ts
  setorForaDaConta: 'Setor não encontrado nesta clínica. Recarregue a página e tente de novo.',
  // messages.service.ts
  financeiroNaoEnvia: 'Conversa do Financeiro — mensagem de paciente não sai pelo número de cobrança.',
  // messages.service.ts
  semChipAtendimento:
    'Nenhum WhatsApp Clínica/Comercial cadastrado — a mensagem não sai pelo Financeiro. Configure em Configurações › WhatsApp.',
  // ponto.service.ts (link do Google Maps sem coordenada)
  linkSemPonto:
    'Esse link não traz o ponto exato da clínica. No Google Maps, abra a clínica e use "Compartilhar", ou toque e segure em cima dela e copie os números que aparecem.',
  // ponto.service.ts
  usuarioForaDaConta: 'Usuário não encontrado nesta clínica.',
  // settings.controller.ts (corpo de SUCESSO)
  horarioSalvo: 'Horário da clínica salvo',
  // tenants.controller.ts
  soAdminEditaConta: 'So ADMIN pode editar dados da clinica',
  // whatsapp.service.ts
  limiteDeChips: 'Limite de 3 WhatsApps por clinica (1 Comercial + 1 Clinica + 1 Financeiro) atingido.',
  // whatsapp.service.ts
  linhaDeOutraConta: 'Essa linha de WhatsApp nao pertence a sua clinica',
  // whatsapp.service.ts
  linhaNaoRegistrada: 'Linha ainda nao registrada pra sua clinica — reabra a tela e tente de novo.',
  // patients.service.ts
  semTelefoneConversa: 'Paciente nao tem telefone — impossivel criar conversa',
  // patients.service.ts
  semChipFotos: 'Nenhum chip WhatsApp da clínica conectado pra buscar as fotos.',
  // whatsapp.service.ts (rótulo da função do chip; aparece dentro dos moldes)
  rotuloChipClinica: 'Clínica',

  // ─── Rotas que a API já libera ao laboratório (fichas, vendas, cobrança) ─────
  // patients.controller.ts
  soAdminArquiva: 'Apenas ADMIN pode arquivar paciente',
  // patients.controller.ts
  soAdminExclui: 'Apenas ADMIN pode excluir paciente permanentemente',
  // patients.controller.ts
  soAdminTrocaFoto: 'Apenas ADMIN pode alterar a foto do paciente',
  // patients.controller.ts
  soAdminRemoveFoto: 'Apenas ADMIN pode remover a foto do paciente',
  // patients.service.ts
  cpfDuplicado: 'Ja existe um paciente com este CPF neste tenant',
  // patients.service.ts
  cpfEmUso: 'Outro paciente ja usa este CPF',
  // patients.service.ts
  responsavelInvalido: 'Dentista inválido',
  // procedures.service.ts, procedure-consumables.service.ts
  procedimentoNaoEncontrado: 'Procedimento nao encontrado',
  // commercial.controller.ts
  orcamentoForaDaCarteira: 'Orçamento de paciente fora da sua carteira',
  // quotes.service.ts
  trabalhoNaoCriado: 'Plano de tratamento nao foi criado — verifique se o orcamento tem items',
  // quotes.service.ts
  responsavelDaVendaInvalido: 'Dentista responsável inválido para esta clínica.',
  // quotes.service.ts
  vendaSemValor: 'Venda sem valor — confira os procedimentos.',
  // quotes.service.ts
  precoMudou: 'O preço de algum procedimento mudou — atualize a página e confira o total.',
  // quotes.service.ts
  semCpfNaVenda: 'Paciente sem CPF cadastrado. Edite o paciente e adicione o CPF antes de gerar cobranca.',
  // quotes.service.ts
  semTelefoneOrcamento: 'Paciente sem telefone cadastrado — adicione antes de enviar via WhatsApp.',
  // quotes.service.ts
  semChipOrcamento:
    'Nenhum WhatsApp Clínica/Comercial cadastrado — o orçamento não sai pelo número do Financeiro. Configure em Configurações › WhatsApp.',
  // quotes.service.ts
  semCaixaDeEntrada: 'Sem caixa de entrada Clínica/Comercial pra esse paciente — configure o WhatsApp da clínica.',
  // treatment-plan-billing.service.ts
  trabalhoSemValor: 'Plano com valor total zero — adicione procedimentos antes de cobrar',
  // treatment-plan-billing.service.ts (literal em 3 pedaços somados)
  semContaAsaas:
    'Esta clínica não tem a conta Asaas cadastrada. Cadastre a chave de API do Asaas em Configurações → Gateway de pagamento para gerar PIX/boleto/cartão online, ou use uma forma "Recebido na clínica".',
  // treatment-plans.service.ts
  trabalhoNaoEncontrado: 'Plano de tratamento nao encontrado',
  // treatment-plans.service.ts
  nenhumTrabalho: 'Nenhum plano de tratamento informado',
  // treatment-plans.service.ts
  responsavelForaDaConta: 'Responsável inválido — tem que ser um dentista desta clínica.',
  // treatment-plans.service.ts
  concluirServico: 'Para concluir um procedimento use "Confirmar/Validar" (registra quem fez).',
  // treatment-plans.service.ts
  agendamentoDeOutraConta: 'Agendamento informado não é desta clínica.',
  // payables.service.ts
  contaDeOutraEmpresa: 'Contas de outras empresas não entram no caixa da clínica — use "marcar como pago".',
  // asaas/asaas-client.ts
  asaasNaoConfigurado:
    'Cobrança Asaas não está configurada para esta clínica. Configure a conta Asaas da clínica no cadastro do gateway (ou use recebimento na clínica assim que o suporte habilitar).',
  // asaas/asaas-client.ts
  asaasNaoConfiguradoCurto: 'Cobrança Asaas não está configurada para esta clínica.',
  // payment-gateway.controller.ts, payment-gateway.service.ts
  cobrancaDeOutraConta: 'Cobrança de outra clínica',
  // payment-gateway.service.ts
  semTelefoneCobranca: 'Paciente sem telefone cadastrado',
  // payment-gateway.service.ts
  semChipCobranca: 'Nenhuma instancia WhatsApp configurada pra esta clinica. Configure em Configuracoes › WhatsApp.',
  // payment-gateway.service.ts
  semCpfCobranca: 'Paciente sem CPF — cadastre antes de gerar cobranca',
  // payment-gateway.service.ts
  semContatoCobranca: 'Paciente nao vinculado a Lead — necessario para gerar cobranca via Asaas',
  // payment-gateway.service.ts
  semContatoAsaas: 'Paciente nao vinculado a Lead — necessario para Asaas',
  // payment-gateway.service.ts
  clienteOuContaNaoIdentificados: 'Paciente/clínica não identificados',
});

export const MOLDES_API_CLINICA = Object.freeze({
  // whatsapp.service.ts (conectar chip com função já ocupada)
  jaTemChipDaFuncao: 'Sua clinica ja tem um WhatsApp {1} ("{2}"). Pra trocar, remova a linha atual primeiro.',
  // whatsapp.service.ts (conta antiga, 1 chip só)
  jaTemChipConectado: 'Sua clinica ja possui um WhatsApp conectado ("{1}"). Pra trocar de numero, remova a linha atual primeiro.',
  // whatsapp.service.ts (trocar a função do chip)
  funcaoJaEmUso: 'Sua clinica ja tem um WhatsApp {1} ("{2}").',
  // conversations.service.ts (mover conversa de setor sem chip no destino)
  semChipDaFuncao: 'Sua clínica não tem um WhatsApp {1} conectado.',
  // messages.service.ts (telefone do cadastro diferente do contato do WhatsApp)
  telefoneDiferente:
    'O telefone do cadastro (final {1}) é diferente do contato do WhatsApp (final {2}) — corrija o cadastro do paciente antes de enviar.',
  // ponto.service.ts (batida fora da área)
  pontoForaDaArea: 'Você está a {1} da clínica (área de {2} m). O ponto só pode ser registrado no local.',
});

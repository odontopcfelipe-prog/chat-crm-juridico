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
 * Ficam de fora de propósito: valores de enum (COMERCIAL/CLINICA/FINANCEIRO) e as
 * mensagens que só saem de rota negada ao laboratório (IA, ortodontia, contrato,
 * TCLE, promover/rebaixar contato). Da agenda (F7) entram só as que a agenda e a
 * Central do laboratório alcançam; a recusa de tipo de clínica ("Evento do tipo X:
 * função de clínica...") fica de fora, porque a tela do laboratório não oferece esses
 * tipos.
 *
 * O spec __guards__/lab-vocab.spec.ts confere que cada texto daqui ainda existe igual
 * em apps/api/src: se alguém mudar a frase no serviço, ele avisa para atualizar aqui.
 */
export const MENSAGENS_API_CLINICA = Object.freeze({
  // ─── IA do laboratório (Ajustes de IA) ──────────────────────────────────────
  // ai-test-chat.service.ts
  iaTesteSemMensagem: 'Mande ao menos uma mensagem do paciente no teste.',
  iaTesteUltimaMensagem: 'A última mensagem do teste precisa ser do paciente.',
  iaTesteSemResposta:
    'A IA não respondeu. Confira se a chave da OpenAI/Anthropic está configurada e se há skill ativa no chip escolhido.',
  // settings.controller.ts, settings.service.ts
  iaUsuarioSemConta: 'Usuário sem clínica',
  iaContaNaoEncontrada: 'Clínica não encontrada',
  iaNomeVazio: 'O nome da clínica não pode ficar vazio.',
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
  // specialties.service.ts (grupo do catálogo)
  especialidadeNaoEncontrada: 'Especialidade nao encontrada',
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
  // quotes.service.ts (venda/cobrança sem telefone)
  semTelefoneNaVenda: 'Paciente sem telefone. Edite o paciente e adicione o telefone antes de gerar cobranca.',
  // quotes.service.ts (telefone de outro cadastro na cobrança)
  telefoneDeOutroCliente:
    'Este telefone já pertence a outro contato/paciente. Dois pacientes não podem dividir o mesmo número na cobrança — ajuste o telefone deste paciente antes de gerar a cobrança.',
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
  // treatment-plans.service.ts (Validar do Financeiro)
  planoCanceladoNaoValida: 'Plano cancelado — não pode ser validado',
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

  // ─── F6: abas Propostas e Trabalhos da ficha ──────────────────────────────────
  // execucao-regras.ts (MSG_ITEM_OUTRO_DENTISTA)
  itemDeOutroResponsavel: 'Este procedimento é de outro dentista — só ele ou o administrador pode confirmar.',
  // execucao-regras.ts (MSG_SO_DENTISTA)
  soResponsavelConclui: 'Só um dentista ou o administrador pode confirmar procedimento.',
  // execucao-regras.ts (MSG_AGUARDANDO_FINANCEIRO)
  aguardandoFinanceiro: 'Aguardando validação do Financeiro — o tratamento ainda não foi liberado.',
  // execucao-regras.ts (MSG_PLANO_CANCELADO)
  trabalhoCanceladoNaoConclui: 'Plano de tratamento cancelado — procedimento não pode ser confirmado.',
  // quotes.service.ts (applyFinancing com parcelas já emitidas)
  parcelasJaEmitidas:
    'Este plano já tem parcelas emitidas. Recarregue a página. Se precisar reemitir, cancele as cobranças ativas primeiro.',

  // ─── F7: agenda e Central de Disparos ─────────────────────────────────────────
  // calendar/dto/calendar.dto.ts (MSG_TIPO_DTO; vem num array, da validação do corpo)
  tipoInvalidoDto:
    'type must be one of the following values: CONSULTA, PROCEDIMENTO, RETORNO, ORTODONTIA, BLOQUEIO, TAREFA, OUTRO, AUDIENCIA, PERICIA, PRAZO',
  // calendar.service.ts (Testar da Central sem chip conectado)
  testeSemChip: 'Nenhuma instância de WhatsApp conectada pra esta clínica. Conecte o WhatsApp primeiro.',

  // ─── Paridade: afiliados e indicação ─────────────────────────────────────────
  // affiliate.service.ts (pedir saque de quem não é afiliado)
  afiliadoSaqueNaoAfiliado: 'Paciente nao e afiliado ativo',
  // affiliate.service.ts (lançar indicação antiga de quem não é afiliado)
  afiliadoNaoMarcado: 'Este paciente nao esta marcado como afiliado (Editar paciente > Programa de Afiliado)',
  // affiliate.service.ts (lançar indicação antiga: indicado não existe)
  afiliadoIndicadoNaoEncontrado: 'Paciente indicado nao encontrado',
  // affiliate.service.ts (lançar indicação antiga: proposta de outro paciente)
  afiliadoPropostaOutroPaciente: 'Proposta nao encontrada para este paciente',
  // affiliate.service.ts (lançar indicação antiga sem valor)
  afiliadoSemValorAcertado: 'Informe o valor acertado do tratamento (sem juros)',
  // referrals.service.ts (indicador e indicado de contas diferentes)
  indicacaoOutraConta: 'Indicador e indicado devem ser pacientes do mesmo tenant',
  // patients.service.ts (indicador de outra conta no cadastro)
  indicadorInvalido: 'Paciente indicador inválido',
  // analytics/ga4-config.ts (GA4_SO_ADMIN_MSG)
  ga4SoAdmin: 'Configurar o Google Analytics — somente o administrador da clínica.',
  // quotes.service.ts (trocar o afiliado da venda depois do aceite)
  afiliadoVendaJaAceita: 'Proposta ja aceita — a comissao de indicacao ja foi creditada e nao pode ser trocada',
  // quotes.service.ts (afiliado da venda é o próprio indicado)
  afiliadoDaPropriaVenda: 'O paciente nao pode ser afiliado da propria venda',
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
  // patients.service.ts (limite de cadastros do plano da conta)
  limiteDoPlano: 'Limite do plano {1} atingido pra pacientes ({2}/{3}). Atualize o plano pra continuar.',
  // quotes.service.ts (item com procedure_id que não existe)
  procedimentoIdNaoEncontrado: 'Procedimento {1} nao encontrado',
  // calendar.service.ts (agendar quem tem boleto em atraso, com o bloqueio ligado; o code e o overdue ficam)
  devedorNaAgenda: 'Paciente com {1} boleto(s) em atraso ({2}). Regularize no Financeiro ou peça a um administrador para liberar.',
  // calendar.controller.ts (o setor dentista edita só o status do próprio evento)
  edicaoSoStatus: 'Sem permissao para alterar: {1}. Dentista pode mudar apenas o status do proprio evento.',
  // calendar.service.ts (Testar da Central: o envio falhou)
  testeNaoEnviou: 'Não enviou: {1}. Verifique se o WhatsApp da clínica está conectado.',
  // quotes.service.ts (afiliado da venda sem o cadastro de afiliado; {1} = nome)
  afiliadoVendaNaoMarcado: '{1} nao esta marcado como afiliado (Editar paciente > Programa de Afiliado)',
  // ─── Funis comerciais (tela de funis do laboratório) ──────────────────────────
  // pipelines.service.ts (excluir funil com contatos)
  funilComContatos: 'Não é possível excluir: {1} lead(s) vinculado(s). Mova-os para outro funil primeiro.',
  // pipelines.service.ts (excluir etapa com contatos)
  etapaComContatos: 'Não é possível excluir: {1} lead(s) nesta etapa. Mova-os para outra primeiro.',
});

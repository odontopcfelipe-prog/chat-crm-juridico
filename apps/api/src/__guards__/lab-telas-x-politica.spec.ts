/**
 * F4 do laboratório — as telas que o laboratório abre × a política de rotas da API.
 *
 * O front abre para o laboratório só as rotas de ALLOWED_LAB_ROUTES (@crm/shared).
 * Cada uma chama um conjunto de handlers; todos têm de estar em ROTAS_DO_LABORATORIO,
 * senão a tela abre e quebra com 403 VERTICAL_DENIED. A tabela abaixo é o que cada
 * tela chama NO LABORATÓRIO (com os botões que ficam escondidos já fora).
 *
 * E o contrário: o que a tela ESCONDE no laboratório continua negado na API. Se
 * alguém liberar um desses handlers, este spec avisa para decidir junto com o front.
 */
import * as fs from 'fs';
import * as path from 'path';
import { ALLOWED_LAB_ROUTES } from '@crm/shared';
import { rotaDoLaboratorio } from '../business-type/lab-route-policy';

type Handler = { metodo: string; rota: string };
type Controller = { classe: string; handlers: Handler[] };

const SRC = path.resolve(__dirname, '..');
const RAIZ = path.resolve(SRC, '..', '..', '..');
const inventario = JSON.parse(fs.readFileSync(path.join(SRC, '__guards__', 'inventario.json'), 'utf8')) as {
  controllers: Controller[];
};
const HANDLERS = new Set(inventario.controllers.flatMap((c) => c.handlers.map((h) => h.metodo)));
const doController = (classe: string): string[] =>
  inventario.controllers.find((c) => c.classe === classe)?.handlers.map((h) => h.metodo) ?? [];

/** Casca (layout, barra lateral, cabeçalho): chamado em toda tela do laboratório. */
const CASCA = [
  'UsersController.getMe', // permissões e setor (useUserPermissions)
  'UsersController.getAvatar', // foto na barra lateral
  'TenantsMeController.getMyTenant', // nome e logo (useTenant), tipo da conta (useBusinessType)
  'PontoController.status', // "Meu ponto" no menu
  'TeamChatController.overview', // bolinha da conversa da equipe
  'ConversationsController.getUnreadCounts', // selo de não lidas
  'WhatsappController.myNumbers', // aviso de chip desconectado
  'NotificationSettingsController.get', // sino de notificações do cabeçalho
  'NotificationSettingsController.update',
  'PatientsController.findAll', // "Localizar" do cabeçalho (busca de cliente)
  'PatientsController.findOne',
];

/** Rota do front (ALLOWED_LAB_ROUTES) → handlers que a tela chama no laboratório. */
const TELAS: Readonly<Record<string, readonly string[]>> = {
  // Inbox (atendimento/page.tsx + InboxSidebar, ChatHeader, NotesPanel, CommandPalette)
  '/atendimento': [
    ...CASCA,
    'ConversationsController.findAll',
    'ConversationsController.findOne',
    'ConversationsController.sendPresence',
    'ConversationsController.getPendingTransfers',
    'ConversationsController.getUnreadSummary',
    'ConversationsController.markAsRead',
    'ConversationsController.assign',
    'ConversationsController.close',
    'ConversationsController.transferRequest',
    'ConversationsController.transferCancel',
    'ConversationsController.transferAccept',
    'ConversationsController.transferDecline',
    'ConversationsController.returnToOrigin',
    'ConversationsController.keepInInbox',
    'ConversationsController.defer',
    'ConversationsController.setAiMode',
    'ConversationsController.moveToSector',
    'ConversationsController.listNotes',
    'ConversationsController.createNote',
    'ConversationsController.updateNote',
    'InboxesController.findAll',
    'InboxesController.getAllOperators',
    'UsersController.findAgents',
    'PipelinesController.findAll',
    'LeadsController.findAll',
    'LeadsController.findOne',
    'LeadsController.update',
    'LeadsController.updateStage',
    'SettingsController.getCannedResponses',
    'MessagesController.getMessages',
    'MessagesController.syncHistory',
    'MessagesController.sendMessage',
    'MessagesController.sendFile',
    'MessagesController.deleteMessage',
    'MessagesController.editMessage',
    'TasksController.create',
    'TasksController.updateStatus',
    'TasksController.complete',
    'TasksController.postpone',
    'MediaController.retryMediaDownload',
    // F5: painel do contato do laboratório (LabClientPanel) — "Tornar cliente", histórico e notas
    'LeadsController.ensurePatient',
    'LeadsController.promoteToClient',
    'LeadsController.getTimeline',
    'LeadsController.deleteContact',
    'PatientsController.findByLead',
    'LeadNotesController.findAll',
    'LeadNotesController.create',
    'LeadNotesController.delete',
  ],
  // chat/[id] (ChatClient.tsx)
  '/atendimento/chat': [
    ...CASCA,
    'ConversationsController.findAllByLead',
    'ConversationsController.markAsRead',
    'ConversationsController.close',
    'ConversationsController.returnToOrigin',
    'ConversationsController.sendPresence',
    'ConversationsController.setAiMode',
    'LeadsController.findOne',
    'UsersController.findAgents',
    'MessagesController.getMessages',
    'MessagesController.syncHistory',
    'MessagesController.sendMessage',
    'MessagesController.sendFile',
    'MessagesController.deleteMessage',
    'MessagesController.editMessage',
    'MessagesController.reactToMessage',
  ],
  // split (split/page.tsx + ChatPane; os quadros são iframes de chat/[id])
  '/atendimento/split': [
    ...CASCA,
    'ConversationsController.findAll',
    'ConversationsController.close',
    'ConversationsController.setAiMode',
    'MessagesController.sendMessage',
    'MessagesController.sendFile',
  ],
  // Início do laboratório (LabInicio)
  '/atendimento/dashboard': [...CASCA, 'UsersController.getMe', 'TenantsMeController.getMyTenant', 'PontoController.status', 'CalendarController.findAll'],
  '/atendimento/caixa': [...CASCA, ...doController('CaixaController')],
  // Assinatura (mensalidade da conta, na conta Asaas da plataforma)
  '/atendimento/billing': [...CASCA, 'BillingController.getMine', 'BillingController.checkout'], // + GET /billing/plans (pública)
  // ponto e ponto/equipe
  '/atendimento/ponto': [
    ...CASCA,
    'PontoController.me',
    'PontoController.punch',
    'PontoController.team',
    'PontoController.report',
    'PontoController.espelho',
    'PontoController.addManual',
    'PontoController.voidPunch',
  ],
  // índice das configurações (no laboratório leva para settings/whatsapp)
  '/atendimento/settings': [...CASCA],
  '/atendimento/settings/whatsapp': [
    ...CASCA,
    'WhatsappController.connectMyNumber',
    'WhatsappController.setMyNumberPurpose',
    'WhatsappController.reconnectMyNumber',
    'WhatsappController.deleteMyNumber',
    'WhatsappController.renameMyNumber',
    'TenantsMeController.patchMyOnboardingStep',
  ],
  '/atendimento/settings/inboxes': [
    ...CASCA,
    'InboxesController.findAll',
    'InboxesController.createFull',
    'InboxesController.update',
    'InboxesController.remove',
    'InboxesController.addUser',
    'InboxesController.removeUser',
    'InboxesController.addInstance',
    'InboxesController.removeInstance',
    'UsersController.findAll',
  ],
  '/atendimento/settings/canned-responses': [...CASCA, 'SettingsController.getCannedResponses', 'SettingsController.setCannedResponses'],
  '/atendimento/settings/notifications': [
    ...CASCA,
    'PushController.getVapidKey',
    'PushController.subscribe',
    'PushController.unsubscribe',
  ],
  '/atendimento/settings/identidade': [...CASCA, 'TenantsMeController.updateMyTenant'],
  '/atendimento/settings/ponto': [
    ...CASCA,
    'PontoController.config',
    'PontoController.resolveMap',
    'PontoController.saveLocal',
    'PontoController.createMember',
    'PontoController.updateMember',
    'PontoController.saveSchedule',
    'PontoController.deleteSchedule',
  ],
  // [F5a]
  // lista (pacientes/page.tsx), Novo cliente e Editar, ficha (pacientes/[id]: Visão geral,
  // Histórico e a conversa do ChatPane) e a aba Financeiro (FinanceiroTab, que aparece
  // quando as rotas do financeiro, bloco F5b, estiverem na lista)
  '/atendimento/pacientes': [
    ...CASCA,
    'PatientsController.getStats',
    'PatientsController.create',
    'PatientsController.update',
    'PatientsController.archive',
    'PatientsController.uploadAvatar',
    'PatientsController.getAvatar',
    'PatientsController.getTimeline',
    'PatientTagsController.list',
    'PatientTagsController.create',
    'PatientTagsController.getForPatient',
    'PatientTagsController.setForPatient',
    'UsersController.findLawyers',
    'UsersController.findAgents',
    'CalendarController.patientBlockStatus',
    'PaymentGatewayController.getFinanceiroConversation',
    'ConversationsController.findOrCreatePatient',
    'ConversationsController.markAsRead',
    'ConversationsController.close',
    'ConversationsController.setAiMode',
    'MessagesController.getMessages',
    'MessagesController.syncHistory',
    'MessagesController.sendMessage',
    'MessagesController.sendFile',
    'InstallmentsController.findAll',
    'InstallmentsController.pay',
    'PaymentGatewayController.getPatientCharges',
    'PaymentGatewayController.deleteAsaasCharge',
    'PaymentGatewayController.receiveInCash',
    'PaymentGatewayController.sendCurrentBoleto',
    'PaymentGatewayController.getChargeSubInstallments',
    'PaymentGatewayController.resendChargeWhatsapp',
    'CommercialController.listQuotes',
    'CommercialController.findQuote',
    'CommercialController.validatePlan',
    'CommercialController.applyFinancing',
    // F8: ficha do cliente, casos dos orçamentos, ficha do caso, fichas dos serviços e aviso de telefone de outro cliente
    'LabFichasController.getPatientProfile',
    'LabFichasController.putPatientProfile',
    'LabFichasController.listPatientCases',
    'LabFichasController.getQuoteCase',
    'LabFichasController.putQuoteCase',
    'LabFichasController.listProcedureSpecs',
    'LeadsController.checkPhone',
    'PatientsController.findByLead',
  ],
  // contatos (contacts/page.tsx, Novo contato e o painel do contato do laboratório)
  '/atendimento/contacts': [
    ...CASCA,
    'LeadsController.findAll',
    'LeadsController.updateStage',
    'LeadsController.checkPhone',
    'LeadsController.create',
    'LeadsController.findOne',
    'LeadsController.update',
    'LeadsController.getTimeline',
    'LeadsController.deleteContact',
    'LeadsController.ensurePatient',
    'LeadsController.promoteToClient',
    'LeadNotesController.findAll',
    'LeadNotesController.create',
    'LeadNotesController.delete',
    'ConversationsController.findAllByLead',
    'ConversationsController.create',
    'ConversationsController.assign',
    'ConversationsController.findAll',
    'PatientsController.findByLead',
  ],
  // [/F5a]
  // [F5b]
  // financeiro/page.tsx só redireciona para a aba certa
  '/atendimento/financeiro': [...CASCA],
  '/atendimento/financeiro/contas-a-pagar': [
    ...CASCA,
    'PayablesController.list',
    'PayablesController.gastos',
    'PayablesController.categories',
    'PayablesController.accounts',
    'PayablesController.companies',
    'PayablesController.createCompany',
    'PayablesController.updateCompany',
    'PayablesController.create',
    'PayablesController.installmentPlan',
    'PayablesController.pay',
    'PayablesController.update',
    'PayablesController.remove',
    'FinanceiroController.findAllTransactions',
    'FinanceiroController.getAuditLog',
    'FinanceiroController.findAllCategories',
    'FinanceiroController.getDashboard',
    'FinanceiroController.createTransaction',
    'FinanceiroController.getPatientsSummary',
    'PaymentGatewayController.getBalance',
  ],
  // boletos/page.tsx (BoletosTab, BoletosKpis, BoletosMesResumo)
  '/atendimento/financeiro/boletos': [
    ...CASCA,
    'FinanceiroController.chargesKpis',
    'FinanceiroController.monthCharges',
    'FinanceiroController.findCharges',
    'CommercialController.markCashReceived',
    'PaymentGatewayController.receiveInCash',
    'PaymentGatewayController.deleteAsaasCharge',
  ],
  // validar/page.tsx (ValidarTab)
  '/atendimento/financeiro/validar': [...CASCA, 'CommercialController.pendingValidation', 'CommercialController.validatePlan'],
  '/atendimento/financeiro/parcelas': [
    ...CASCA,
    'InstallmentsController.findAll',
    'InstallmentsController.overdueSummary',
    'InstallmentsController.pay',
    'PaymentGatewayController.getOdontoInstallmentCharge',
    'PaymentGatewayController.createOdontoInstallmentCharge',
  ],
  // conta Asaas da própria conta (o PUT /settings da tela é só do dono da plataforma)
  '/atendimento/settings/payment-gateway': [...CASCA, 'PaymentGatewayController.getSettings', 'PaymentGatewayController.setup'],
  // [/F5b]
  // [F5c]
  // venda-rapida/page.tsx (sem o PIX online) e o Novo cliente que ela abre
  '/atendimento/venda-rapida': [
    ...CASCA,
    'ProceduresController.findAll',
    'InventoryController.previewConsumption',
    'InventoryController.commitConsumption',
    'UsersController.findLawyers',
    'CommercialController.vendaBalcao',
    'CommercialController.listarVendasRapidas',
    // Aba Produtos do tópico
    'ProceduresController.catalogo',
    'ProceduresController.create',
    'ProceduresController.update',
    'ProceduresController.uploadPhoto',
    'ProceduresController.getPhoto',
    'ProceduresController.removePhoto',
    'PatientsController.create',
    'PatientsController.uploadAvatar',
    'PatientTagsController.list',
    'PatientTagsController.create',
    // F8: fichas dos serviços (entrega sugerida), ficha do caso da venda e ficha do cliente no Novo cliente
    'LabFichasController.listProcedureSpecs',
    'LabFichasController.putQuoteCase',
    'LabFichasController.getPatientProfile',
    'LabFichasController.putPatientProfile',
    'LeadsController.checkPhone',
    'PatientsController.findByLead',
  ],
  '/atendimento/settings/procedures': [
    ...CASCA,
    'ProceduresController.findAll',
    'ProceduresController.create',
    'ProceduresController.update',
    'ProceduresController.remove',
    'SpecialtiesController.findAll',
    // F8: ficha técnica do serviço
    'LabFichasController.listProcedureSpecs',
    'LabFichasController.getProcedureSpec',
    'LabFichasController.putProcedureSpec',
  ],
  '/atendimento/settings/patient-tags': [
    ...CASCA,
    'PatientTagsController.list',
    'PatientTagsController.create',
    'PatientTagsController.update',
    'PatientTagsController.remove',
  ],
  // equipe (sem horários de agenda, jogo, avisos de disparo e vínculo de dentista)
  '/atendimento/settings/users': [
    ...CASCA,
    'UsersController.findAll',
    'UsersController.findLawyers',
    'UsersController.create',
    'UsersController.update',
    'UsersController.remove',
    'UsersController.linkSupervisors',
    'UsersController.resendVerification',
    'UsersController.transferSummary',
    'InboxesController.findAll',
  ],
  // estoque (produtos, movimentações e fornecedores; sem a aba de rastreio)
  '/atendimento/estoque': [
    ...CASCA,
    'InventoryController.getPolicy',
    'InventoryController.setPolicy',
    'InventoryController.listProducts',
    'InventoryController.createProduct',
    'InventoryController.updateProduct',
    'InventoryController.archiveProduct',
    'InventoryController.uploadProductPhoto',
    'InventoryController.getProductPhoto',
    'InventoryController.removeProductPhoto',
    'InventoryController.listMovements',
    'InventoryController.createMovement',
    'InventoryController.listSuppliers',
    'InventoryController.createSupplier',
    'InventoryController.updateSupplier',
    'InventoryController.archiveSupplier',
  ],
  // [/F5c]
  // [F6a]
  // painel "Orçamentos de trabalho" (orcamentos/page.tsx) e a rota que abre as abas Orçamento,
  // Propostas e Trabalhos da ficha (lab-ficha.ts: LabOrcamentoTab, PropostasTab e TratamentoTab)
  '/atendimento/orcamentos': [
    ...CASCA,
    'CommercialController.listAllQuotes',
    'CommercialController.listArchivedQuotes',
    'CommercialController.quotesDashboard',
    'CommercialController.sendQuoteByWhatsapp',
    'CommercialController.listQuotes',
    'CommercialController.createQuote',
    'CommercialController.findQuote',
    'CommercialController.updateQuote',
    'CommercialController.removeQuote',
    'CommercialController.addQuoteItem',
    'CommercialController.updateQuoteItem',
    'CommercialController.removeQuoteItem',
    'CommercialController.overrideItemPrice',
    'CommercialController.quotePdf',
    'CommercialController.listVersions',
    'CommercialController.findVersion',
    'CommercialController.listAttachments',
    'CommercialController.uploadAttachment',
    'CommercialController.getAttachmentFile',
    'CommercialController.removeAttachment',
    'CommercialController.listTemplates',
    'CommercialController.applyTemplate',
    'CommercialController.getAvistaDiscountConfig',
    'CommercialController.chooseQuoteAsProposal',
    'CommercialController.getOrCreateDraft',
    'CommercialController.emitDownPaymentByQuote',
    'CommercialController.markCashReceived',
    'CommercialController.approveAndBill',
    'CommercialController.applyFinancing',
    'CommercialController.addBonus',
    'CommercialController.saveCounterProposal',
    'CommercialController.archiveQuote',
    'CommercialController.renegotiateQuote',
    'CommercialController.listPatientTreatmentItems',
    'CommercialController.executePlanItem',
    'PatientsController.getAvatar',
    'ProceduresController.findAll',
    'UsersController.findLawyers',
    'PaymentGatewayController.getSettings',
    'PaymentGatewayController.confirmCartao',
    'PaymentGatewayController.getAsaasChargeStatus',
  ],
  // modelos de orçamento (só o administrador; serviço só da própria conta)
  '/atendimento/settings/quote-templates': [
    ...CASCA,
    'CommercialController.listTemplates',
    'CommercialController.findTemplate',
    'CommercialController.createTemplate',
    'CommercialController.updateTemplate',
    'CommercialController.removeTemplate',
    'ProceduresController.findAll',
  ],
  // [/F6a]
  // [F7a]
  // agenda de coleta, prova e entrega (agenda/page.tsx, ContactPicker, busca da agenda e a aba de
  // tarefas por ?tab=tasks), sem Bloquear, Notificar, Validar e a sugestão da IA nas tarefas
  '/atendimento/agenda': [
    ...CASCA,
    'CalendarController.findAll',
    'CalendarController.findOne',
    'CalendarController.create',
    'CalendarController.update',
    'CalendarController.updateStatus',
    'CalendarController.remove',
    'CalendarController.checkConflicts',
    'CalendarController.getReminderConfig',
    'CalendarController.findScheduleBlocks',
    'CalendarController.search',
    'CalendarController.exportRangeIcs',
    'CalendarController.exportEventIcs',
    'CalendarController.pendingValidation',
    'CalendarController.patientBlockStatus',
    'UsersController.findLawyers',
    'UsersController.findAgents',
    'UsersController.findAll',
    'LeadsController.findAll',
    'LeadsController.findOne',
    'PatientsController.getAvatar',
    'TasksController.findAll',
    'TasksController.getWorkload',
    'TasksController.create',
    'TasksController.updateStatus',
    'TasksController.update',
    'TasksController.findOne',
    'TasksController.addComment',
    'TasksController.findComments',
    'TasksController.addChecklistItem',
    'TasksController.toggleChecklistItem',
    'TasksController.deleteChecklistItem',
  ],
  // Central de Disparos do laboratório (só a lista permitida de avisos, sem Campanha manual,
  // anexos, áudio e o botão de corrigir telefones)
  '/atendimento/settings/disparos': [
    ...CASCA,
    'FollowupController.getOperacional',
    'FollowupController.setOperacionalToggle',
    'FollowupController.getCobrancaTemplate',
    'FollowupController.setCobrancaTemplate',
    'FollowupController.getDailySummaryConfig',
    'FollowupController.setDailySummaryConfig',
    'FollowupController.getVendaFeitaConfig',
    'FollowupController.setVendaFeitaConfig',
    'FollowupController.getDisparoDetail',
    'CalendarController.getReminderConfig',
    'CalendarController.setReminderConfig',
    'CalendarController.getAppointmentConfirmationConfig',
    'CalendarController.setAppointmentConfirmationConfig',
    'CalendarController.getAppointmentRescheduledConfig',
    'CalendarController.setAppointmentRescheduledConfig',
    'CalendarController.getDentistDailySummaryConfig',
    'CalendarController.setDentistDailySummaryConfig',
    'CalendarController.getBirthdayGreetingConfig',
    'CalendarController.setBirthdayGreetingConfig',
    'CalendarController.sendTestDisparo',
  ],
  // [/F7a]
  // [F9a]
  // Passos CAD: roda no navegador e não chama a API além da casca
  '/atendimento/passos-cad': [...CASCA],
  // [/F9a]
};

/** Componente que aparece em toda tela (balão da conversa da equipe). */
const EQUIPE_CHAT = ['TeamChatController.overview', 'TeamChatController.messages', 'TeamChatController.send', 'TeamChatController.read'];

/** O que o front ESCONDE no laboratório (F4 a F7) — continua negado na API. */
const ESCONDIDOS_NO_LAB = [
  'ConversationsController.setSpecialty',
  'ConversationsController.assignLawyer',
  'ConversationsController.transferToLawyer',
  'MessagesController.transcribeAudio',
  'MessagesController.correctText',
  ...doController('TransferAudioController'),
  'LeadsController.summarize',
  'LeadsController.demoteToLead',
  'LeadsController.resetMemory',
  ...doController('GoogleDriveController'),
  ...doController('LeadHonorariosController'),
  'HomeHighlightsController.moduleBadges',
  'MyGameController.myProcedures',
  // F5 — lista e ficha do cliente: primeiras consultas, aniversários, atender, alergias e
  // medicamentos, conversão pela rota da clínica, boas-vindas, afiliados e crédito
  'PatientsController.firstVisits',
  'PatientsController.getBirthdays',
  'PatientsController.startAttending',
  'PatientsController.addAllergy',
  'PatientsController.removeAllergy',
  'PatientsController.addMedication',
  'PatientsController.removeMedication',
  'PatientsController.convertFromLead',
  'PatientsController.getWelcome',
  'PatientsController.listAffiliateOptions',
  'PatientsController.getAffiliateDashboard',
  'PatientsController.updateCreditCheckData',
  'CalendarController.validate',
  'CalendarController.unvalidate',
  ...doController('OdontogramController'),
  ...doController('MemoriesController'),
  ...doController('PortalController'),
  // F5 — aba Financeiro da ficha: contrato do orçamento e envio de teste do boleto
  'CommercialController.getQuoteContract',
  'PaymentGatewayController.testBoletoDelivery',
  // F5 — venda e propostas: aceite sem cobrança, consulta de crédito e contrato
  'CommercialController.acceptQuoteNoCharge',
  'CommercialController.simulateCreditCheck',
  'CommercialController.getContractCompleteness',
  'CommercialController.createQuoteContract',
  'CommercialController.previewQuoteContractPdf',
  ...doController('ContractsController'),
  // F5 — equipe: horários da agenda, jogo, avisos de disparo e vínculo de dentista
  'CalendarController.getSchedule',
  'CalendarController.setSchedule',
  ...doController('GameScoringController'),
  ...doController('DentistLinksController'),
  // F5 e F7 — follow-up: o que não é da Central de Disparos do laboratório
  'FollowupController.getStats',
  'FollowupController.getDisparoHistory',
  'FollowupController.getRecallTemplate',
  'FollowupController.setRecallTemplate',
  'FollowupController.listSequences',
  'FollowupController.createSequence',
  'FollowupController.updateSequence',
  'FollowupController.deleteSequence',
  'FollowupController.addStep',
  'FollowupController.updateStep',
  'FollowupController.deleteStep',
  'FollowupController.listEnrollments',
  'FollowupController.enrollLead',
  'FollowupController.pauseEnrollment',
  'FollowupController.resumeEnrollment',
  'FollowupController.cancelEnrollment',
  'FollowupController.markConverted',
  'FollowupController.listPendingApprovals',
  'FollowupController.approveMessage',
  'FollowupController.rejectMessage',
  'FollowupController.regenerateMessage',
  'FollowupController.previewBroadcast',
  'FollowupController.listBroadcasts',
  'FollowupController.getBroadcast',
  'FollowupController.createBroadcast',
  'FollowupController.cancelBroadcast',
  'FollowupController.seedDefaultSequences',
  // F5 — estoque: baixa de insumo por procedimento
  'InventoryController.linkConsumable',
  'InventoryController.listConsumables',
  'InventoryController.unlinkConsumable',
  // F5 — grupos de serviço: o laboratório usa os grupos da semente; a tela de grupos fica para depois
  'SpecialtiesController.create',
  'SpecialtiesController.update',
  'SpecialtiesController.remove',
  'SpecialtiesController.addDentist',
  'SpecialtiesController.removeDentist',
  // F6 — propostas: contrato, duplicar e cobranças do plano
  'CommercialController.duplicateAsOption',
  'CommercialController.listPlanCharges',
  'CommercialController.setContractDentist',
  'CommercialController.updateContractDocuments',
  'CommercialController.previewContractPdf',
  'CommercialController.previewContractTemplate',
  'CommercialController.previewContractWhatsapp',
  'CommercialController.sendContractWhatsapp',
  'CommercialController.sendContract',
  'CommercialController.sendContractViaClickSign',
  'CommercialController.signContractClinic',
  'CommercialController.cancelContract',
  // F7 — agenda: Notificar, Bloquear, disponibilidade, métricas, lembretes avulsos, comentários,
  // tipos de atendimento, aniversariantes, abrir conversa, migrar tarefas e a sugestão da IA
  'CalendarController.notifyEvent',
  'CalendarController.createScheduleBlock',
  'CalendarController.findComments',
  'CalendarController.addComment',
  'CalendarController.getAvailability',
  'CalendarController.findAppointmentTypes',
  'CalendarController.createAppointmentType',
  'CalendarController.updateAppointmentType',
  'CalendarController.deleteAppointmentType',
  'CalendarController.getAgendaMetrics',
  'CalendarController.backfillReminders',
  'CalendarController.listReminders',
  'CalendarController.getRemindersSummary',
  'CalendarController.resendReminder',
  'CalendarController.cancelReminder',
  'CalendarController.getReminderPreview',
  'CalendarController.getRemindersHealth',
  'CalendarController.exportRemindersCSV',
  'CalendarController.getUpcomingBirthdays',
  'CalendarController.openConversation',
  'CalendarController.migrateTasks',
  'TasksController.suggestNextAction',
  ...doController('AgendaExtendedController'),
  // F7 — Central: Enviar agora do resumo, teste da confirmação, agenda do lead, ortodontia,
  // corrigir telefones, pacientes sem agendamento, anexos, campanha, áudio, pesquisa,
  // reativação e e-mails automáticos
  'CalendarController.sendDentistDailySummaryNow',
  'CalendarController.sendTestConfirmation',
  'CalendarController.getComercialAgendaTemplate',
  'CalendarController.setComercialAgendaTemplate',
  'CalendarController.getAppointmentConfirmationOrtoConfig',
  'CalendarController.setAppointmentConfirmationOrtoConfig',
  'CalendarController.getAppointmentOrtoReminderConfig',
  'CalendarController.setAppointmentOrtoReminderConfig',
  'CalendarController.getAppointmentOrtoImmediateConfig',
  'CalendarController.setAppointmentOrtoImmediateConfig',
  'LeadsController.deduplicatePhones',
  'CommercialController.semAgendamentoPreview',
  'CommercialController.semAgendamentoTest',
  'CommercialController.semAgendamentoAdmins',
  'CommercialController.semAgendamentoSend',
  ...doController('DisparoAnexosController'),
  ...doController('CampanhasController'),
  ...doController('AudioDisparoController'),
  ...doController('PostCareController'),
  ...doController('ReactivationController'),
  ...doController('EmailAutomationController'),
];

/** Controllers expandidos com doController acima: cada um tem de existir e ter handlers. */
const CONTROLLERS_EXPANDIDOS = [
  'CaixaController',
  'TransferAudioController',
  'GoogleDriveController',
  'LeadHonorariosController',
  'OdontogramController',
  'MemoriesController',
  'PortalController',
  'ContractsController',
  'GameScoringController',
  'DentistLinksController',
  'AgendaExtendedController',
  'DisparoAnexosController',
  'CampanhasController',
  'AudioDisparoController',
  'PostCareController',
  'ReactivationController',
  'EmailAutomationController',
];

/**
 * Os quatro arquivos de rota com os blocos de cada fase (F5a, F5b, F5c, F6a, F7a...; cada deploy
 * tira ou põe blocos inteiros). Fora das linhas de abrir e fechar, nenhum texto destes arquivos cita o
 * marcador entre colchetes: assim um corte por linha (sed de faixa) não pega linha errada.
 */
const ARQUIVOS_COM_BLOCOS = [
  'packages/shared/src/business-type.ts',
  'apps/api/src/__guards__/lab-telas-x-politica.spec.ts',
  'apps/api/src/__guards__/business-type.spec.ts',
  'apps/api/src/__guards__/business-route.spec.ts',
];

/**
 * Linhas de cada bloco (o comentário que abre e o que fecha levam o nome F5a, F6a...);
 * vários blocos com o mesmo nome se somam. Sem aninhar. O nome entre colchetes só pode
 * aparecer nas linhas de abrir e fechar.
 */
function linhasDosBlocos(arq: string): Map<string, string[]> {
  const src = fs.readFileSync(path.join(RAIZ, arq), 'utf8');
  const blocos = new Map<string, string[]>();
  let aberto: string | null = null;
  const MARCA_SOLTA = new RegExp('\\[\\/?F\\d[a-z]\\]');
  src.split(/\r?\n/).forEach((linha, i) => {
    const abre = /^\s*\/\/\s*\[(F\d[a-z])\]/.exec(linha);
    const fecha = /^\s*\/\/\s*\[\/(F\d[a-z])\]/.exec(linha);
    if (!abre && !fecha && MARCA_SOLTA.test(linha)) {
      throw new Error(`${arq}:${i + 1} cita o marcador fora da linha de abrir/fechar (o corte por linha pegaria esta linha)`);
    }
    if (abre) {
      if (aberto) throw new Error(`${arq}:${i + 1} abre [${abre[1]}] dentro de [${aberto}]`);
      aberto = abre[1];
      if (!blocos.has(aberto)) blocos.set(aberto, []);
    } else if (fecha) {
      if (aberto !== fecha[1]) throw new Error(`${arq}:${i + 1} fecha [/${fecha[1]}] com [${aberto ?? 'nada'}] aberto`);
      aberto = null;
    } else if (aberto) {
      blocos.get(aberto)!.push(linha);
    }
  });
  if (aberto) throw new Error(`${arq}: [${aberto}] aberto até o fim do arquivo`);
  return blocos;
}

const caminho = (e: unknown): string => (typeof e === 'string' ? e : (e as { path: string }).path);

describe('Telas do laboratório × política de rotas da API', () => {
  it('toda rota de ALLOWED_LAB_ROUTES tem a sua linha na tabela (e a tabela não tem rota a mais)', () => {
    const rotas = ALLOWED_LAB_ROUTES.map(caminho).sort();
    expect(rotas.length).toBeGreaterThan(0);
    expect(Object.keys(TELAS).sort()).toEqual(rotas);
  });

  it('todo handler da tabela existe no código (nome morto = renomearam e a tela quebrou)', () => {
    const todos = [...new Set([...Object.values(TELAS).flat(), ...EQUIPE_CHAT, ...ESCONDIDOS_NO_LAB])];
    expect(todos.filter((h) => !HANDLERS.has(h))).toEqual([]);
    // Os controllers expandidos com doController existem e têm handlers.
    for (const c of CONTROLLERS_EXPANDIDOS) {
      expect(doController(c).length).toBeGreaterThan(0);
    }
  });

  it('os blocos de cada fase fecham nos 4 arquivos de rota e listam as mesmas telas aqui e em business-type.ts', () => {
    const porArquivo = new Map(ARQUIVOS_COM_BLOCOS.map((arq) => [arq, linhasDosBlocos(arq)]));
    const daLista = porArquivo.get('packages/shared/src/business-type.ts')!;
    const daTabela = porArquivo.get('apps/api/src/__guards__/lab-telas-x-politica.spec.ts')!;
    // Mesmos marcadores nos quatro arquivos (um deploy tira o bloco de todos de uma vez).
    const marcadores = [...daLista.keys()].sort();
    for (const [arq, blocos] of porArquivo) expect([arq, [...blocos.keys()].sort()]).toEqual([arq, marcadores]);
    for (const m of marcadores) {
      // Rotas do bloco na lista do shared (string de prefixo ou path da entrada exata).
      const rotas = daLista
        .get(m)!
        .flatMap((l) => [...l.matchAll(/(?:^\s*|path:\s*)'(\/atendimento[^']*)'/g)].map((x) => x[1]))
        .sort();
      // Linhas da tabela TELAS dentro do mesmo bloco deste spec.
      const telas = daTabela
        .get(m)!
        .flatMap((l) => [.../^\s*'(\/atendimento[^']*)':\s*\[/.exec(l) ?? []].slice(1))
        .sort();
      expect([m, telas]).toEqual([m, rotas]);
    }
  });

  it.each(Object.entries(TELAS))('%s: tudo o que a tela chama está liberado para o laboratório', (_rota, handlers) => {
    expect(handlers.filter((h) => !rotaDoLaboratorio(h))).toEqual([]);
  });

  it('conversa da equipe (EquipeChat): liberada', () => {
    expect(EQUIPE_CHAT.filter((h) => !rotaDoLaboratorio(h))).toEqual([]);
  });

  it('o que fica ESCONDIDO no laboratório continua negado na API', () => {
    expect(ESCONDIDOS_NO_LAB.filter((h) => rotaDoLaboratorio(h))).toEqual([]);
  });

  it('o Início do laboratório e o hook do tipo de conta não chamam rota de início, jogo ou agenda da clínica', () => {
    const arquivos = ['apps/web/src/components/home/LabInicio.tsx', 'apps/web/src/lib/useBusinessType.ts'];
    for (const arq of arquivos) {
      const p = path.join(RAIZ, arq);
      expect(fs.existsSync(p) ? arq : `${arq} não existe`).toBe(arq);
      // F7: o Início do laboratório lê só a listagem de eventos (quadro das próximas
      // coletas, provas e entregas); qualquer outra rota de agenda continua fora.
      const lido = fs.readFileSync(p, 'utf8');
      const src = arq.endsWith('LabInicio.tsx') ? lido.split('/calendar/events').join('') : lido;
      for (const proibido of ['/home/', '/my-procedures', '/calendar/']) {
        expect(src.includes(proibido) ? `${arq} chama ${proibido}` : 'ok').toBe('ok');
      }
    }
  });
});

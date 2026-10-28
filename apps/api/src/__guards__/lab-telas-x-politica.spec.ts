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
  '/atendimento/dashboard': [...CASCA, 'UsersController.getMe', 'TenantsMeController.getMyTenant', 'PontoController.status'],
  '/atendimento/caixa': [...CASCA, ...doController('CaixaController')],
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
};

/** Componente que aparece em toda tela (balão da conversa da equipe). */
const EQUIPE_CHAT = ['TeamChatController.overview', 'TeamChatController.messages', 'TeamChatController.send', 'TeamChatController.read'];

/** O que o front ESCONDE no laboratório na F4 — continua negado na API. */
const ESCONDIDOS_NO_LAB = [
  'ConversationsController.setSpecialty',
  'ConversationsController.assignLawyer',
  'ConversationsController.transferToLawyer',
  'MessagesController.transcribeAudio',
  'MessagesController.correctText',
  ...doController('TransferAudioController'),
  'LeadsController.summarize',
  'LeadsController.promoteToClient',
  'LeadsController.demoteToLead',
  // "Tornar cliente": a ficha do cliente do laboratório chega numa fase própria.
  'LeadsController.ensurePatient',
  ...doController('GoogleDriveController'),
  ...doController('LeadHonorariosController'),
  'HomeHighlightsController.moduleBadges',
  'MyGameController.myProcedures',
];

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
    for (const c of ['CaixaController', 'TransferAudioController', 'GoogleDriveController', 'LeadHonorariosController']) {
      expect(doController(c).length).toBeGreaterThan(0);
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
      const src = fs.readFileSync(p, 'utf8');
      for (const proibido of ['/home/', '/my-procedures', '/calendar/']) {
        expect(src.includes(proibido) ? `${arq} chama ${proibido}` : 'ok').toBe('ok');
      }
    }
  });
});

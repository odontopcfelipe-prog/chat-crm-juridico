/**
 * F7 do laboratório — textos e cores da AGENDA do laboratório (coleta, prova e entrega no
 * consultório do cliente): os tipos da pílula, as cores do schedule-x, a legenda, os
 * rótulos do modal, os status visíveis, o seletor de contato (ContactPicker) e as visões
 * Lista e Por profissional.
 *
 * Só texto e cor. A clínica não usa nada daqui: a agenda escolhe pelo tipo de negócio da
 * sessão (`lab ? LAB_X.y : 'texto de hoje da clínica'`). Este arquivo só tem o import e
 * consts LAB_*: fica sob as travas de scripts/ci/check-pick-literals.mjs, e nenhum texto
 * fora delas pode entrar aqui (chave de objeto vai sem aspas).
 *
 * Regra das palavras: cliente (o dentista ou consultório atendido), contato (quem ainda
 * não tem cadastro), responsável (qualquer pessoa da equipe) e feito (no lugar do status
 * de atendimento concluído). Os ids (COLETA, AGENDADO...) são os mesmos gravados no banco.
 */
import { LAB_AGENDA_TIPO } from '@crm/shared';

/** Agenda do laboratório: tipos, cores, legenda, rótulos e textos do modal. */
export const LAB_AGENDA_UI = Object.freeze({
  /** Pílulas do modal, filtros e emoji do card: Coleta, Prova, Entrega, Bloqueio, Tarefa e Outro. */
  tipos: Object.freeze([
    Object.freeze({ id: 'COLETA', label: LAB_AGENDA_TIPO.COLETA, emoji: '📦', color: '#8b5cf6' }),
    Object.freeze({ id: 'PROVA', label: LAB_AGENDA_TIPO.PROVA, emoji: '🔍', color: '#14b8a6' }),
    Object.freeze({ id: 'ENTREGA', label: LAB_AGENDA_TIPO.ENTREGA, emoji: '🚚', color: '#0ea5e9' }),
    Object.freeze({ id: 'BLOQUEIO', label: 'Bloqueio', emoji: '🚫', color: '#f59e0b' }),
    Object.freeze({ id: 'TAREFA', label: 'Tarefa', emoji: '🟢', color: '#22c55e' }),
    Object.freeze({ id: 'OUTRO', label: 'Outro', emoji: '⚪', color: '#6b7280' }),
  ]),
  /** Tipo e título com que o modal de novo evento abre. */
  tipoPadrao: 'COLETA',
  tituloPadrao: LAB_AGENDA_TIPO.COLETA,
  /** Cores do schedule-x (calendarId = o próprio tipo) para os 3 tipos do laboratório. */
  calendarios: Object.freeze({
    COLETA: Object.freeze({
      colorName: 'coleta',
      lightColors: Object.freeze({ main: '#8b5cf6', container: '#ede9fe', onContainer: '#4c1d95' }),
      darkColors: Object.freeze({ main: '#a78bfa', container: '#4c1d95', onContainer: '#ede9fe' }),
    }),
    PROVA: Object.freeze({
      colorName: 'prova',
      lightColors: Object.freeze({ main: '#14b8a6', container: '#ccfbf1', onContainer: '#134e4a' }),
      darkColors: Object.freeze({ main: '#14b8a6', container: '#134e4a', onContainer: '#ccfbf1' }),
    }),
    ENTREGA: Object.freeze({
      colorName: 'entrega',
      lightColors: Object.freeze({ main: '#0ea5e9', container: '#e0f2fe', onContainer: '#0c4a6e' }),
      darkColors: Object.freeze({ main: '#0ea5e9', container: '#0c4a6e', onContainer: '#e0f2fe' }),
    }),
  }),
  /** Legenda do rodapé: cor do card pelo status e marcador do tipo. */
  legenda: Object.freeze({
    grupoStatus: 'Agendamentos',
    status: Object.freeze([
      Object.freeze({ label: 'Agendado', color: '#E91E63' }),
      Object.freeze({ label: 'Confirmado', color: '#22c55e' }),
      Object.freeze({ label: 'Feito', color: '#15803d' }),
      Object.freeze({ label: 'Desmarcado', color: '#eab308' }),
      Object.freeze({ label: 'Não realizado', color: '#991b1b' }),
    ]),
    tipos: Object.freeze([
      Object.freeze({ label: LAB_AGENDA_TIPO.COLETA, color: '#8b5cf6' }),
      Object.freeze({ label: LAB_AGENDA_TIPO.PROVA, color: '#14b8a6' }),
      Object.freeze({ label: LAB_AGENDA_TIPO.ENTREGA, color: '#0ea5e9' }),
      Object.freeze({ label: 'Bloqueio', color: '#dc2626' }),
      Object.freeze({ label: 'Tarefa', color: '#22c55e' }),
    ]),
    barra: 'barra à esquerda = responsável',
  }),
  /** Rótulos do topo e do modal. */
  rotulos: Object.freeze({
    responsavel: 'Responsável',
    filtroTitulo: 'Filtrar agenda por responsável',
    filtroTodos: 'Todos os responsáveis',
    contato: 'Cliente / Contato',
    cliente: 'Cliente',
    clienteSemNome: 'Cliente sem nome',
    abrirFicha: 'Abrir a ficha do cliente',
  }),
  /** Placeholder do Título por tipo; os outros tipos usam placeholderPadrao. */
  placeholders: Object.freeze<Record<string, string>>({
    COLETA: 'Coleta — ex.: moldagem da coroa',
    PROVA: 'Prova — ex.: prova da estrutura',
    ENTREGA: 'Entrega — ex.: coroa em zircônia',
    BLOQUEIO: 'Bloqueio — ex.: folga ou feriado',
  }),
  placeholderPadrao: 'Título do evento',
  /** Colunas do Kanban das tarefas da agenda (a última vira "Feito"). */
  kanban: Object.freeze([
    Object.freeze({ id: 'AGENDADO', label: 'A Fazer', emoji: '📋', color: '#3b82f6' }),
    Object.freeze({ id: 'CONFIRMADO', label: 'Em Andamento', emoji: '🔄', color: '#f59e0b' }),
    Object.freeze({ id: 'CONCLUIDO', label: 'Feito', emoji: '✅', color: '#22c55e' }),
  ]),
});

/**
 * Status visíveis na agenda do laboratório (id gravado → rótulo), na ordem do seletor.
 * "Chegou" e "Em atendimento" não aparecem; os valores gravados não mudam.
 */
export const LAB_AGENDA_STATUS = Object.freeze<Record<string, string>>({
  AGENDADO: 'Agendado',
  CONFIRMADO: 'Confirmado',
  CONCLUIDO: 'Feito',
  CANCELADO: 'Desmarcado',
  NO_SHOW: 'Não realizado',
});

/** Seletor de cliente ou contato do modal (ContactPicker). */
export const LAB_AGENDA_CONTATO = Object.freeze({
  erroClientes: 'erro ao carregar os clientes',
  erroContatos: 'erro ao carregar os contatos',
  carregandoCliente: 'Carregando cliente...',
  carregandoContato: 'Carregando contato...',
  seloCliente: 'Cliente',
  seloContato: 'Contato',
  nenhum: 'Nenhum — clique pra buscar cliente ou contato',
  buscar: 'Buscar por nome, telefone, CPF ou CNPJ...',
  carregando: 'Carregando clientes e contatos...',
  semResultado: (busca: string) => `Nenhum cliente ou contato corresponde a "${busca}".`,
  cadastre: 'Cadastre clientes em Dentistas → Novo cliente.',
  documento: (doc: string) => `CPF/CNPJ ${doc}`,
});

/** Visões Lista e Por profissional da agenda (impressão e legenda). */
export const LAB_AGENDA_LISTA = Object.freeze({
  tituloImpressao: 'Agenda',
});

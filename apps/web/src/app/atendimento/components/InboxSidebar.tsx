'use client';

import { Search, X, PanelLeftClose, Bell, Clock, UserCheck, UserSearch, Wallet, LayoutGrid, Grid3X3, Square } from 'lucide-react';
import { useState, useEffect, useRef, useCallback, memo } from 'react';
import {
  requestNotificationPermission,
  dismissBanner,
} from '@/lib/desktopNotifications';
import { showSuccess } from '@/lib/toast';
import { normalizeStage } from '@/lib/crmStages';
import { useRole } from '@/lib/useRole';
import { formatChatListTime } from '@/lib/chatUtils';
import type { ConversationSummary } from '../types';
import { ContactAvatar } from './ContactAvatar';

// ─── Saved Filters Type ──────────────────────────────────────

interface SavedFilter {
  id: string;
  name: string;
  inboxId: string | null;
  leadFilter: string;
}

// ─── Helpers ────────────────────────────────────────────────────
// A lista usa a pele FIXA do WhatsApp Web (classes wa-* em globals.css): sem
// separador de data — a hora de cada linha já diz o dia ("Ontem", "sexta-feira",
// "03/10/2026"), igual ao WhatsApp.

// ─── Lead Score ──────────────────────────────────────────────────

const STAGE_BASE_SCORES: Record<string, number> = {
  NOVO: 10, INICIAL: 15, EM_ATENDIMENTO: 25, QUALIFICANDO: 35, QUALIFICADO: 40,
  AGUARDANDO_FORM: 50, REUNIAO_AGENDADA: 65, AGUARDANDO_DOCS: 70,
  AGUARDANDO_PROC: 80, FINALIZADO: 100, PERDIDO: 0,
};

function computeScore(conv: ConversationSummary): number {
  const stage = normalizeStage(conv.leadStage || '');
  let score = STAGE_BASE_SCORES[stage] ?? 20;
  if (conv.specialty) score += 8;
  if (conv.assignedDentistId) score += 5;
  if (conv.nextStep && conv.nextStep !== 'duvidas') score += 5;
  if (conv.stageEnteredAt) {
    const days = Math.floor((Date.now() - new Date(conv.stageEnteredAt).getTime()) / 86400000);
    if (days > 3) score -= Math.min(25, (days - 3) * 3);
  }
  return Math.max(0, Math.min(100, Math.round(score)));
}

function scoreStyle(score: number): string {
  if (score >= 70) return 'wa-tag-green';
  if (score >= 45) return 'wa-tag-amber';
  if (score >= 20) return 'wa-tag-orange';
  return 'wa-tag-red';
}

function formatTaskDate(dateStr: string): string {
  const d = new Date(dateStr);
  const now = new Date();
  const isToday = d.toDateString() === now.toDateString();
  const tomorrow = new Date(now); tomorrow.setDate(now.getDate() + 1);
  const isTomorrow = d.toDateString() === tomorrow.toDateString();
  if (d < now) return 'Atrasado';
  if (isToday) return `Hoje ${d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}`;
  if (isTomorrow) return `Amanhã ${d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}`;
  return d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });
}

function statusBadge(status: string) {
  const map: Record<string, { class: string; label: string }> = {
    BOT: { class: '', label: '🤖 SophIA' },
    WAITING: { class: 'wa-tag-amber', label: '⏳ Aguardando' },
    ACTIVE: { class: 'wa-tag-green', label: '🟢 Atribuído' },
    CLOSED: { class: 'wa-tag-muted', label: '⬛ Fechado' },
    ADIADO: { class: 'wa-tag-amber', label: '⏰ Adiado' },
  };
  const badge = map[status] || map.CLOSED;
  return <span className={`wa-tag ${badge.class}`}>{badge.label}</span>;
}

// ─── Conversation Row (memoizado) ───────────────────────────────
// Onda 18.35 — extraído do map e memoizado por conv.id: quando `unreadCounts`
// muda pra UMA conversa (socket), só a linha afetada re-renderiza — não as ~200
// da lista. Props são primitivas/estáveis de propósito (unread number, flags
// boolean, handlers useCallback) pro React.memo conseguir pular.
interface ConversationRowProps {
  conv: ConversationSummary;
  unread: number;
  isSelected: boolean;
  isBulkSelected: boolean;
  inBulkMode: boolean;
  onSelect: (id: string) => void;
  onToggleBulk?: (id: string) => void;
  onLightbox: (url: string) => void;
}

const ConversationRow = memo(function ConversationRow({
  conv,
  unread,
  isSelected,
  isBulkSelected,
  inBulkMode,
  onSelect,
  onToggleBulk,
  onLightbox,
}: ConversationRowProps) {
  const name = conv.contactName || conv.contactPhone;
  const attendant = conv.originAssignedUserId ? conv.originAssignedUserName : conv.assignedAgentName;
  const stage = normalizeStage(conv.leadStage || '');
  const isOpenLead = stage !== 'PERDIDO' && stage !== 'FINALIZADO';
  const score = isOpenLead && conv.leadStage ? computeScore(conv) : null;

  // Badge SLA: aguardando resposta há mais de 15min
  let waitingMins = 0;
  if (unread > 0 && conv.status !== 'CLOSED' && conv.status !== 'ADIADO' && conv.lastMessageAt) {
    waitingMins = Math.floor((Date.now() - new Date(conv.lastMessageAt).getTime()) / 60000);
  }

  // Chip de dormência: sem atividade há mais de 2 dias
  let dormantDays = 0;
  if (conv.lastMessageAt && conv.status !== 'CLOSED' && conv.status !== 'ADIADO' && isOpenLead) {
    dormantDays = Math.floor((Date.now() - new Date(conv.lastMessageAt).getTime()) / 86400000);
  }

  const taskOverdue = conv.activeTask?.dueAt ? new Date(conv.activeTask.dueAt) < new Date() : false;

  return (
    <div
      onClick={() => {
        if (inBulkMode) { onToggleBulk?.(conv.id); return; }
        onSelect(conv.id);
      }}
      className={`group wa-chat-row ${isSelected ? 'wa-on' : ''} ${isBulkSelected ? 'wa-picked' : ''}`}
    >
      {/* Checkbox (visível no hover ou no modo seleção) + Avatar */}
      <div className="wa-chat-avatar">
        <div
          className={`wa-chat-check transition-opacity ${inBulkMode ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'}`}
          // Só impede o clique de abrir a conversa: quem marca é o onChange do
          // checkbox (marcar aqui também desmarcava no mesmo clique).
          onClick={(e) => e.stopPropagation()}
        >
          <input
            type="checkbox"
            checked={isBulkSelected}
            onChange={() => onToggleBulk?.(conv.id)}
            aria-label={`Selecionar ${name}`}
          />
        </div>
        <ContactAvatar
          src={conv.profile_picture_url}
          name={conv.contactName}
          sizeClass="w-[49px] h-[49px]"
          className="wa-avatar"
          onClick={(url) => { onLightbox(url); }}
        />
      </div>
      <div className="wa-chat-main">
        {/* Nome + hora */}
        <div className="flex items-baseline">
          <span
            className="wa-chat-name flex-1 min-w-0 truncate"
            title={conv.contactPhone && conv.contactName !== conv.contactPhone ? `${name} · ${conv.contactPhone}` : undefined}
          >
            {name}
          </span>
          <span
            className={`wa-chat-time ${unread > 0 ? 'wa-unread' : ''}`}
            title={conv.lastMessageAt ? new Date(conv.lastMessageAt).toLocaleString('pt-BR') : undefined}
          >
            {formatChatListTime(conv.lastMessageAt)}
          </span>
        </div>
        {/* Prévia + dormência + não lidas */}
        <div className="flex items-center gap-1.5 mt-0.5">
          <p className="wa-chat-preview flex-1 min-w-0 truncate">{conv.lastMessage}</p>
          {dormantDays >= 2 && (
            <span
              title={`Sem atividade há ${dormantDays} dia${dormantDays > 1 ? 's' : ''}`}
              className="shrink-0 text-[12px] leading-5 text-[#8696a0]"
            >
              💤 {dormantDays}d
            </span>
          )}
          {unread > 0 && (
            <span className="wa-unread-badge">{unread > 99 ? '99+' : unread}</span>
          )}
        </div>
        {/* CRM: status, atendente, SLA, especialidade, etiquetas, tarefa, score
            (o telefone fica na dica do nome e no cabeçalho da conversa) */}
        <div className="wa-chat-meta">
          {statusBadge(conv.status)}
          {attendant && (
            <span className="inline-flex items-center gap-1 truncate max-w-[160px]">
              <span className="w-1.5 h-1.5 rounded-full bg-[#8696a0] inline-block shrink-0" />
              Aten. {attendant}
            </span>
          )}
          {waitingMins >= 15 && (
            <span
              title={`Cliente aguardando resposta há ${waitingMins >= 60 ? `${Math.floor(waitingMins / 60)}h${waitingMins % 60 > 0 ? `${waitingMins % 60}min` : ''}` : `${waitingMins}min`}`}
              className={`wa-tag ${waitingMins >= 60 ? 'wa-tag-red' : 'wa-tag-amber'}`}
            >
              ⏱ {waitingMins >= 60 ? `${Math.floor(waitingMins / 60)}h` : `${waitingMins}min`}
            </span>
          )}
          {conv.specialty && (
            <span className="wa-tag wa-tag-blue">⚖️ {conv.specialty}</span>
          )}
          {conv.specialty && conv.assignedDentistName && (
            <span className="truncate max-w-[160px]">Dr(a). {conv.assignedDentistName}</span>
          )}
          {/* Etiquetas do lead */}
          {conv.leadTags && conv.leadTags.length > 0 && (
            <>
              {conv.leadTags.slice(0, 3).map(tag => (
                <span key={tag} className="wa-tag">{tag}</span>
              ))}
              {conv.leadTags.length > 3 && (
                <span className="text-[11px] text-[#8696a0]">+{conv.leadTags.length - 3}</span>
              )}
            </>
          )}
          {conv.activeTask && (
            <span className={`wa-tag ${taskOverdue ? 'wa-tag-red' : 'wa-tag-amber'} max-w-full`}>
              <Clock size={11} className={`shrink-0 ${taskOverdue ? 'animate-pulse' : ''}`} />
              <span className="truncate max-w-[120px]">{conv.activeTask.title}</span>
              {conv.activeTask.dueAt && (
                <span className="font-bold shrink-0">{formatTaskDate(conv.activeTask.dueAt)}</span>
              )}
              {(conv.activeTask.postponeCount ?? 0) > 0 && (
                <span className="opacity-70 shrink-0">×{conv.activeTask.postponeCount}</span>
              )}
            </span>
          )}
          {score !== null && (
            <span className={`wa-tag ${scoreStyle(score)}`} title={`Score do lead: ${score}/100`}>
              {score}
            </span>
          )}
        </div>
      </div>
    </div>
  );
});

// ─── Props ──────────────────────────────────────────────────────

export interface InboxSidebarProps {
  // Data
  conversations: ConversationSummary[];
  adiadoConversations: ConversationSummary[];
  filteredConversations: ConversationSummary[];
  userInboxes: { id: string; name: string }[];
  pendingTransfers: { conversationId: string; contactName: string; fromUserName: string; reason: string | null; audioIds?: string[] }[];
  unreadCounts: Record<string, number>;
  /** Totais globais de não-lidas por categoria (Leads/Clientes), independentes do clientMode ativo. */
  unreadSummary: { leads: number; clients: number; financial: number };
  currentUserId: string | null;
  // State
  selectedId: string | null;
  selectedInboxId: string | null;
  searchQuery: string;
  leadFilter: string;
  inboxOpen: boolean;
  loading: boolean;
  isMobile: boolean;
  showNotifBanner: boolean;
  // Bulk selection
  selectedBulk?: Set<string>;
  onToggleBulk?: (id: string) => void;
  onClearBulk?: () => void;
  onBulkAction?: (action: 'close' | 'assign', ids: string[]) => void;
  // Callbacks
  clientMode: boolean;
  onSetClientMode: (mode: boolean) => void;
  /** Onda 18.7 — aba Financeiro (sobreposta ao clientMode): conversas do chip FINANCEIRO. */
  financialMode?: boolean;
  onSetFinancialMode?: (v: boolean) => void;
  onSelectConversation: (id: string) => void;
  onSetSearchQuery: (q: string) => void;
  onSetLeadFilter: (f: string) => void;
  onSetSelectedInboxId: (id: string | null) => void;
  onSetInboxOpen: (open: boolean) => void;
  onSetShowNotifBanner: (show: boolean) => void;
  onSetUnreadCounts: React.Dispatch<React.SetStateAction<Record<string, number>>>;
  onQuickAcceptTransfer: (convId: string) => void;
  onShowTransferPopup: (transfer: { conversationId: string; contactName: string; fromUserName: string; reason: string | null; audioIds?: string[] }) => void;
  onLightbox: (url: string) => void;
  hasDisconnectedInstance?: boolean;
  /** Onda 14.55 — modo de split ativo (1 = chat unico, 4/6 = grid).
   *  Toggle no header da sidebar troca entre os modos sem mudar de rota. */
  splitMode?: 1 | 4 | 6;
  onSplitModeChange?: (mode: 1 | 4 | 6) => void;
  /** Onda 18.35 — scroll infinito: há próxima página no backend. */
  hasMore?: boolean;
  /** Uma página adicional está sendo carregada. */
  loadingMore?: boolean;
  /** Carrega a próxima página (chamado quando o sentinela entra em tela). */
  onLoadMore?: () => void;
}

// ─── Component ──────────────────────────────────────────────────

export const InboxSidebar = memo(function InboxSidebar({
  conversations,
  adiadoConversations,
  filteredConversations,
  userInboxes,
  pendingTransfers,
  unreadCounts,
  unreadSummary,
  currentUserId,
  selectedId,
  selectedInboxId,
  searchQuery,
  leadFilter,
  inboxOpen,
  loading,
  isMobile,
  showNotifBanner,
  selectedBulk,
  onToggleBulk,
  onClearBulk,
  onBulkAction,
  clientMode,
  onSetClientMode,
  financialMode = false,
  onSetFinancialMode,
  onSelectConversation,
  onSetSearchQuery,
  onSetLeadFilter,
  onSetSelectedInboxId,
  onSetInboxOpen,
  onSetShowNotifBanner,
  onSetUnreadCounts,
  onQuickAcceptTransfer,
  onShowTransferPopup,
  onLightbox,
  hasDisconnectedInstance,
  splitMode = 1,
  onSplitModeChange,
  hasMore = false,
  loadingMore = false,
  onLoadMore,
}: InboxSidebarProps) {
  const { isAdmin } = useRole();

  // Onda 18.35 — scroll infinito: IntersectionObserver dispara `onLoadMore` quando
  // o sentinela no fim da lista entra em tela (root = o próprio container rolável).
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const loadMoreRef = useRef<HTMLDivElement>(null);

  // Handler ESTÁVEL de seleção passado às linhas memoizadas: selecionar + zerar
  // o unread local daquela conversa (era inline no map, recriado a cada render).
  const handleSelectRow = useCallback((id: string) => {
    onSelectConversation(id);
    onSetUnreadCounts(prev => { const n = { ...prev }; delete n[id]; return n; });
  }, [onSelectConversation, onSetUnreadCounts]);

  useEffect(() => {
    const sentinel = loadMoreRef.current;
    if (!sentinel || !onLoadMore || !hasMore) return;
    const io = new IntersectionObserver(
      (entries) => { if (entries[0]?.isIntersecting) onLoadMore(); },
      { root: scrollContainerRef.current ?? null, rootMargin: '250px' },
    );
    io.observe(sentinel);
    return () => io.disconnect();
    // Reataca ao mudar tamanho da lista/estado: se o sentinela seguir visível após
    // carregar (viewport alto, poucos itens), dispara de novo até esvaziar as páginas.
    // searchQuery/leadFilter entram nas deps porque escondem/mostram o sentinela.
  }, [onLoadMore, hasMore, loadingMore, filteredConversations.length, searchQuery, leadFilter]);

  const myActiveConvs = (c: ConversationSummary) =>
    (c.status === 'ACTIVE' || c.status === 'MONITORING') && c.assignedAgentId === currentUserId;

  // Contadores GLOBAIS de não-lidos por categoria (vêm do backend, independem
  // do clientMode ativo). A lista `conversations` contém só a aba corrente, então
  // derivar daqui zeraria o badge da aba oposta.
  const unreadLeadsCount = unreadSummary.leads;
  const unreadClientsCount = unreadSummary.clients;
  const unreadFinancialCount = unreadSummary.financial;

  // ─── Saved Filters ────────────────────────────────────────────
  const [savedFilters, setSavedFilters] = useState<SavedFilter[]>([]);
  const [showSaveInput, setShowSaveInput] = useState(false);
  const [saveInputValue, setSaveInputValue] = useState('');
  const saveInputRef = useRef<HTMLInputElement>(null);

  // Load from localStorage on mount
  useEffect(() => {
    try {
      const raw = localStorage.getItem('inbox_saved_filters');
      if (raw) setSavedFilters(JSON.parse(raw));
    } catch { /* ignore */ }
  }, []);

  const persistSavedFilters = (filters: SavedFilter[]) => {
    setSavedFilters(filters);
    try { localStorage.setItem('inbox_saved_filters', JSON.stringify(filters)); } catch { /* ignore */ }
  };

  const hasNonDefaultFilter = selectedInboxId !== null || leadFilter !== '';

  const handleSaveFilter = () => {
    const name = saveInputValue.trim();
    if (!name) return;
    const newFilter: SavedFilter = {
      id: Date.now().toString(),
      name,
      inboxId: selectedInboxId,
      leadFilter,
    };
    persistSavedFilters([...savedFilters, newFilter]);
    setSaveInputValue('');
    setShowSaveInput(false);
  };

  const handleDeleteSavedFilter = (id: string) => {
    persistSavedFilters(savedFilters.filter((f) => f.id !== id));
  };

  const handleApplySavedFilter = (f: SavedFilter) => {
    onSetSelectedInboxId(f.inboxId);
    onSetLeadFilter(f.leadFilter);
  };

  // Focus the save input when shown
  useEffect(() => {
    if (showSaveInput) saveInputRef.current?.focus();
  }, [showSaveInput]);

  return (
    <section className={`wa-skin wa-list flex flex-col overflow-hidden shrink-0 z-40 transition-all duration-300 ${isMobile ? (selectedId ? 'hidden' : 'w-full') : (inboxOpen ? 'w-[31%] min-w-[400px] max-w-[640px]' : 'w-0')}`}>
      {/* Pele FIXA do WhatsApp Web (claro): título verde, abas com sublinhado,
          busca em pílula e filtros em chips — nenhum tema/efeito muda isso. */}
      <div className="shrink-0">
        <div className="flex items-center justify-between gap-1 h-[56px] pl-4 pr-2.5">
          <h2 className="wa-list-title">WhatsApp</h2>
          <div className="flex items-center gap-0.5">
            {/* Onda 14.55 — Toggle de Split View INLINE (era nova aba).
                3 botoes: 1 chat (default) / 4 quadrantes / 6 quadrantes.
                Estado vive no parent, sem mudanca de rota — InboxSidebar
                continua visivel ao ladoindependente do modo escolhido. */}
            {onSplitModeChange && (
              <div className="hidden md:flex items-center gap-0.5 mr-1">
                <button
                  onClick={() => onSplitModeChange(1)}
                  className={`wa-list-iconbtn ${splitMode === 1 ? 'wa-on' : ''}`}
                  title="Visualizar 1 conversa por vez"
                  aria-label="Single"
                  aria-pressed={splitMode === 1}
                >
                  <Square size={16} />
                </button>
                <button
                  onClick={() => onSplitModeChange(4)}
                  className={`wa-list-iconbtn ${splitMode === 4 ? 'wa-on' : ''}`}
                  title="Split de 4 conversas (2x2)"
                  aria-label="Split 4"
                  aria-pressed={splitMode === 4}
                >
                  <LayoutGrid size={16} />
                </button>
                <button
                  onClick={() => onSplitModeChange(6)}
                  className={`wa-list-iconbtn ${splitMode === 6 ? 'wa-on' : ''}`}
                  title="Split de 6 conversas (3x2)"
                  aria-label="Split 6"
                  aria-pressed={splitMode === 6}
                >
                  <Grid3X3 size={16} />
                </button>
              </div>
            )}
            <span className="hidden md:inline-flex">
              <button
                onClick={() => onSetInboxOpen(false)}
                className="wa-list-iconbtn"
                title="Fechar painel"
                aria-label="Fechar painel"
              >
                <PanelLeftClose size={18} />
              </button>
            </span>
          </div>
        </div>

        {/* Onda 18.7 — Abas Leads / Clientes / Financeiro */}
        <div className="wa-tabs">
          <button
            onClick={() => onSetClientMode(false)}
            className={`wa-tab ${!clientMode && !financialMode ? 'wa-on' : ''}`}
          >
            <UserSearch size={15} />
            Leads
            {unreadLeadsCount > 0 && (
              <span className="wa-unread-badge wa-sm">{unreadLeadsCount > 99 ? '99+' : unreadLeadsCount}</span>
            )}
          </button>
          <button
            onClick={() => onSetClientMode(true)}
            className={`wa-tab ${clientMode && !financialMode ? 'wa-on' : ''}`}
          >
            <UserCheck size={15} />
            Clientes
            {unreadClientsCount > 0 && (
              <span className="wa-unread-badge wa-sm">{unreadClientsCount > 99 ? '99+' : unreadClientsCount}</span>
            )}
          </button>
          <button
            onClick={() => onSetFinancialMode?.(true)}
            className={`wa-tab ${financialMode ? 'wa-on' : ''}`}
          >
            <Wallet size={15} />
            Financeiro
            {unreadFinancialCount > 0 && (
              <span className="wa-unread-badge wa-sm">{unreadFinancialCount > 99 ? '99+' : unreadFinancialCount}</span>
            )}
          </button>
        </div>

        <div className="px-3 pt-2.5 pb-2 space-y-2">
          {/* v15: Barra de busca INTERNA da inbox (busca contato/mensagem) —
              restaurada apos remocao acidental na v14. Esta eh diferente da
              barra global de paciente (PatientSearch) que ficava no topo do
              layout — essa global foi removida porque era redundante aqui. */}
          <div className="wa-search">
            <Search size={17} className="shrink-0" />
            <input
              type="text"
              value={searchQuery}
              onChange={e => onSetSearchQuery(e.target.value)}
              placeholder="Buscar contato ou mensagem"
            />
            {searchQuery && (
              <button
                onClick={() => onSetSearchQuery('')}
                className="wa-list-iconbtn wa-list-iconbtn-sm"
                title="Limpar busca"
                aria-label="Limpar busca"
              >
                <X size={15} />
              </button>
            )}
          </div>

          {/* Banner "Ativar notificações do navegador" removido pra dar mais espaço na
              lista (a permissão de notificação segue disponível em Config → Notificações). */}

          {/* WhatsApp disconnection banner */}
          {hasDisconnectedInstance && (
            <div className="wa-banner-red">
              <span className="w-2 h-2 bg-[#ea0038] rounded-full animate-pulse shrink-0" />
              WhatsApp desconectado
            </div>
          )}

          {/* Transferências aguardando resposta */}
          {pendingTransfers.length > 0 && (
            <div className="wa-banner-amber">
              <div className="flex items-center gap-2 px-3 py-2 border-b border-[#f6d78f]">
                <span className="text-sm">📨</span>
                <span className="text-[12px] leading-4 font-semibold text-[#8f5300]">
                  Aguardando você ({pendingTransfers.length})
                </span>
              </div>
              <div className="divide-y divide-[#f6d78f]/60">
                {pendingTransfers.map(pt => (
                  <div key={pt.conversationId} className="flex items-center gap-2 px-3 py-2">
                    <div className="flex-1 min-w-0">
                      <p className="text-[14px] leading-5 text-[#111b21] truncate">{pt.contactName}</p>
                      <p className="text-[12px] leading-4 text-[#667781] truncate">De: {pt.fromUserName}</p>
                      {pt.reason && <p className="text-[12px] leading-4 text-[#8f5300] italic truncate">{pt.reason}</p>}
                      {pt.audioIds && pt.audioIds.length > 0 && (
                        <p className="text-[12px] leading-4 text-[#02729f]">🎙 {pt.audioIds.length} áudio{pt.audioIds.length > 1 ? 's' : ''}</p>
                      )}
                    </div>
                    <div className="flex gap-1.5 shrink-0">
                      <button
                        onClick={() => onQuickAcceptTransfer(pt.conversationId)}
                        className="wa-round-btn wa-pill-green"
                        title="Aceitar transferência"
                      >✓</button>
                      <button
                        onClick={() => onShowTransferPopup(pt)}
                        className="wa-round-btn wa-pill-red"
                        title="Recusar transferência"
                      >✗</button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Onda 17.64 — barra "Seletor de Setores" removida a pedido do dono pra ganhar
              espaço na lista. O filtro por setor segue disponível pelos Filtros salvos
              (onSetSelectedInboxId continua usado lá); as abas Leads/Clientes já separam
              por função. */}

          <div className="flex items-center gap-2 overflow-x-auto no-scrollbar">
            {[
              // "Tudo" só visível para ADMIN — outros usuários veem apenas suas conversas
              ...(isAdmin ? [{ value: '', label: 'Tudo', count: conversations.filter(c => normalizeStage(c.leadStage) !== 'PERDIDO').length }] : []),
              { value: 'MINE', label: 'Minhas', count: conversations.filter(c => c.assignedAgentId === currentUserId && !c.aiMode && c.status !== 'CLOSED' && normalizeStage(c.leadStage) !== 'PERDIDO').length },
              { value: 'WAITING', label: 'Espera', count: conversations.filter(c => c.status === 'WAITING' && normalizeStage(c.leadStage) !== 'PERDIDO').length },
              // Aba "SophIA" (filtro BOT) removida pra dar mais espaço na barra — as
              // conversas em modo IA seguem visíveis em "Tudo"/"Minhas".
              { value: 'ADIADO', label: 'Adiados', count: adiadoConversations.filter(c => normalizeStage(c.leadStage) !== 'PERDIDO').length },
            ].map((tab) => (
              <button
                key={tab.value}
                onClick={() => onSetLeadFilter(tab.value)}
                className={`wa-chip ${leadFilter === tab.value ? 'wa-on' : ''}`}
                aria-pressed={leadFilter === tab.value}
              >
                {tab.label}
                {tab.count > 0 && (
                  <span className="wa-chip-count">{tab.count > 99 ? '99+' : tab.count}</span>
                )}
              </button>
            ))}

            {/* Save filter button — only shown when a non-default filter is active */}
            {hasNonDefaultFilter && (
              <button
                onClick={() => setShowSaveInput((v) => !v)}
                className="wa-list-iconbtn text-base leading-none"
                title="Salvar filtro atual"
                aria-label="Salvar filtro"
              >
                💾
              </button>
            )}
          </div>

          {/* Inline save input */}
          {showSaveInput && (
            <div className="flex items-center gap-2">
              <div className="wa-search flex-1 h-[34px]">
                <input
                  ref={saveInputRef}
                  type="text"
                  value={saveInputValue}
                  onChange={(e) => setSaveInputValue(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') handleSaveFilter();
                    if (e.key === 'Escape') { setShowSaveInput(false); setSaveInputValue(''); }
                  }}
                  placeholder="Nome do filtro"
                />
              </div>
              <button
                onClick={handleSaveFilter}
                className="wa-pill-btn wa-pill-green"
              >
                Salvar
              </button>
              <button
                onClick={() => { setShowSaveInput(false); setSaveInputValue(''); }}
                className="wa-list-iconbtn"
                aria-label="Cancelar"
              >
                <X size={16} />
              </button>
            </div>
          )}

          {/* Saved filter chips */}
          {savedFilters.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {savedFilters.map((f) => (
                <div
                  key={f.id}
                  className="wa-chip wa-chip-sm"
                  onClick={() => handleApplySavedFilter(f)}
                  title={`Aplicar filtro: ${f.name}`}
                >
                  <span>{f.name}</span>
                  <button
                    onClick={(e) => { e.stopPropagation(); handleDeleteSavedFilter(f.id); }}
                    className="wa-chip-x"
                    aria-label={`Remover filtro ${f.name}`}
                  >
                    <X size={12} />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      <div ref={scrollContainerRef} className={`flex-1 overflow-y-auto w-full ${isMobile && !selectedId ? 'pb-16' : ''}`}>
        {loading ? (
          <div className="wa-list-note p-10 text-center">Carregando conversas...</div>
        ) : filteredConversations.length === 0 ? (
          <div className="wa-list-note p-10 text-center">
            {searchQuery.trim() ? `Nenhum resultado para "${searchQuery}".` : 'Nenhuma conversa encontrada.'}
          </div>
        ) : (
          <>
            {filteredConversations.map((conv) => (
              <ConversationRow
                key={conv.id}
                conv={conv}
                unread={unreadCounts[conv.id] || 0}
                isSelected={selectedId === conv.id}
                isBulkSelected={selectedBulk?.has(conv.id) ?? false}
                inBulkMode={(selectedBulk?.size ?? 0) > 0}
                onSelect={handleSelectRow}
                onToggleBulk={onToggleBulk}
                onLightbox={onLightbox}
              />
            ))}
            {/* Onda 18.35 — sentinela do scroll infinito. Some durante a busca
                (a lista já carrega tudo), no filtro Adiados (fonte separada, não
                paginada) e quando o backend diz que não há mais. */}
            {hasMore && !searchQuery.trim() && leadFilter !== 'ADIADO' && (
              <div ref={loadMoreRef} className="py-4 text-center text-[12px] text-[#8696a0] select-none">
                {loadingMore ? 'Carregando mais…' : ' '}
              </div>
            )}
          </>
        )}
      </div>

      {/* Bulk action bar */}
      {(selectedBulk?.size ?? 0) > 0 && (
        <div className="shrink-0 border-t border-[#e9edef] bg-[#f0f2f5] px-4 py-2.5 flex items-center gap-2">
          <span className="text-[14px] text-[#111b21] flex-1">{selectedBulk!.size} selecionada{selectedBulk!.size > 1 ? 's' : ''}</span>
          <button onClick={() => onBulkAction?.('close', [...selectedBulk!])} className="wa-pill-btn wa-pill-red">Encerrar</button>
          <button onClick={() => onClearBulk?.()} className="wa-pill-btn wa-pill-gray">Cancelar</button>
        </div>
      )}
    </section>
  );
});

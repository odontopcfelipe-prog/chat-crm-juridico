'use client';

import { Search, X, PanelLeftClose, Bell, Clock, UserCheck, UserSearch, Wallet, LayoutGrid, Grid3X3, Square } from 'lucide-react';
import { useState, useEffect, useRef } from 'react';
import {
  requestNotificationPermission,
  dismissBanner,
} from '@/lib/desktopNotifications';
import { showSuccess } from '@/lib/toast';
import { normalizeStage } from '@/lib/crmStages';
import { useRole } from '@/lib/useRole';
import { getDateKey, formatDateLabel, formatTime, getInitial } from '@/lib/chatUtils';
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

function DateSeparator({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-3 px-3 py-2 select-none sticky top-0 z-10 bg-card/80 backdrop-blur-sm">
      <div className="flex-1 h-px bg-border/60" />
      <span className="text-[10px] font-bold text-muted-foreground uppercase tracking-widest whitespace-nowrap">{label}</span>
      <div className="flex-1 h-px bg-border/60" />
    </div>
  );
}

// getDateKey, formatDateLabel, formatTime, getInitial — importados de @/lib/chatUtils

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
  if (score >= 70) return 'text-emerald-400 bg-emerald-500/10 border-emerald-500/20';
  if (score >= 45) return 'text-yellow-400 bg-yellow-500/10 border-yellow-500/20';
  if (score >= 20) return 'text-orange-400 bg-orange-500/10 border-orange-500/20';
  return 'text-red-400 bg-red-500/10 border-red-500/20';
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
    BOT: { class: 'bg-slate-500/15 text-slate-400 border border-slate-500/20', label: '🤖 SophIA' },
    WAITING: { class: 'bg-amber-500/15 text-amber-500 border border-amber-500/20 shadow-[0_0_10px_rgba(251,191,36,0.15)]', label: '⏳ Aguardando' },
    ACTIVE: { class: 'bg-emerald-500/15 text-emerald-500 border border-emerald-500/20', label: '🟢 Atribuído' },
    CLOSED: { class: 'bg-gray-500/15 text-gray-400 border border-gray-500/20', label: '⬛ Fechado' },
    ADIADO: { class: 'bg-amber-500/15 text-amber-400 border border-amber-500/20', label: '⏰ Adiado' },
  };
  const badge = map[status] || map.CLOSED;
  return <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[10px] font-bold uppercase tracking-wider ${badge.class}`}>{badge.label}</span>;
}

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
}

// ─── Component ──────────────────────────────────────────────────

export function InboxSidebar({
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
}: InboxSidebarProps) {
  const { isAdmin } = useRole();

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
    <section className={`flex flex-col overflow-hidden bg-card border-r border-border shrink-0 z-40 transition-all duration-300 ${isMobile ? (selectedId ? 'hidden' : 'w-full') : (inboxOpen ? 'w-[380px]' : 'w-0')}`}>
      {/* Onda 5e v15 (Fase 25) — Header compactado:
          - Titulo "Inbox" -> "WhatsApp" (alinhado com label do menu)
          - Padding reduzido (p-5 -> p-3) e space-y-4 -> space-y-2
          - Toggle e busca menores. Espaco que sobra vai pra lista de conversas. */}
      <div className="shrink-0 p-3 border-b border-border space-y-2">
        <div className="flex items-center justify-between gap-1">
          <h2 className="text-lg font-bold">WhatsApp</h2>
          <div className="flex items-center gap-0.5">
            {/* Onda 14.55 — Toggle de Split View INLINE (era nova aba).
                3 botoes: 1 chat (default) / 4 quadrantes / 6 quadrantes.
                Estado vive no parent, sem mudanca de rota — InboxSidebar
                continua visivel ao ladoindependente do modo escolhido. */}
            {onSplitModeChange && (
              <div className="hidden md:flex items-center gap-0.5 mr-1 rounded-lg bg-accent/40 p-0.5">
                <button
                  onClick={() => onSplitModeChange(1)}
                  className={`inline-flex items-center justify-center p-1 rounded transition-all ${
                    splitMode === 1
                      ? 'bg-primary text-primary-foreground shadow-sm'
                      : 'text-muted-foreground hover:text-foreground hover:bg-accent'
                  }`}
                  title="Visualizar 1 conversa por vez"
                  aria-label="Single"
                  aria-pressed={splitMode === 1}
                >
                  <Square size={14} />
                </button>
                <button
                  onClick={() => onSplitModeChange(4)}
                  className={`inline-flex items-center justify-center p-1 rounded transition-all ${
                    splitMode === 4
                      ? 'bg-primary text-primary-foreground shadow-sm'
                      : 'text-muted-foreground hover:text-foreground hover:bg-accent'
                  }`}
                  title="Split de 4 conversas (2x2)"
                  aria-label="Split 4"
                  aria-pressed={splitMode === 4}
                >
                  <LayoutGrid size={14} />
                </button>
                <button
                  onClick={() => onSplitModeChange(6)}
                  className={`inline-flex items-center justify-center p-1 rounded transition-all ${
                    splitMode === 6
                      ? 'bg-primary text-primary-foreground shadow-sm'
                      : 'text-muted-foreground hover:text-foreground hover:bg-accent'
                  }`}
                  title="Split de 6 conversas (3x2)"
                  aria-label="Split 6"
                  aria-pressed={splitMode === 6}
                >
                  <Grid3X3 size={14} />
                </button>
              </div>
            )}
            <button
              onClick={() => onSetInboxOpen(false)}
              className="hidden md:block p-1 rounded-lg text-muted-foreground hover:text-foreground hover:bg-accent transition-all"
              title="Fechar painel"
              aria-label="Fechar painel"
            >
              <PanelLeftClose size={16} />
            </button>
          </div>
        </div>

        {/* Onda 18.7 — Toggle Leads / Clientes / Financeiro */}
        <div className="flex rounded-xl border border-border overflow-hidden">
          <button
            onClick={() => onSetClientMode(false)}
            className={`flex-1 flex items-center justify-center gap-1 py-1.5 text-[12px] font-semibold transition-colors ${
              !clientMode && !financialMode
                ? 'bg-primary text-primary-foreground'
                : 'text-muted-foreground hover:text-foreground hover:bg-accent/60'
            }`}
          >
            <UserSearch size={13} />
            Leads
            {unreadLeadsCount > 0 && (
              <span className="ml-0.5 min-w-[18px] h-[18px] flex items-center justify-center text-[9px] font-bold rounded-full bg-red-500 text-white">{unreadLeadsCount > 99 ? '99+' : unreadLeadsCount}</span>
            )}
          </button>
          <button
            onClick={() => onSetClientMode(true)}
            className={`flex-1 flex items-center justify-center gap-1 py-1.5 text-[12px] font-semibold transition-colors border-l border-border ${
              clientMode && !financialMode
                ? 'bg-primary text-primary-foreground'
                : 'text-muted-foreground hover:text-foreground hover:bg-accent/60'
            }`}
          >
            <UserCheck size={13} />
            Clientes
            {unreadClientsCount > 0 && (
              <span className="ml-0.5 min-w-[18px] h-[18px] flex items-center justify-center text-[9px] font-bold rounded-full bg-red-500 text-white">{unreadClientsCount > 99 ? '99+' : unreadClientsCount}</span>
            )}
          </button>
          <button
            onClick={() => onSetFinancialMode?.(true)}
            className={`flex-1 flex items-center justify-center gap-1 py-1.5 text-[12px] font-semibold transition-colors border-l border-border ${
              financialMode
                ? 'bg-primary text-primary-foreground'
                : 'text-muted-foreground hover:text-foreground hover:bg-accent/60'
            }`}
          >
            <Wallet size={13} />
            Financeiro
            {unreadFinancialCount > 0 && (
              <span className="ml-0.5 min-w-[18px] h-[18px] flex items-center justify-center text-[9px] font-bold rounded-full bg-red-500 text-white">{unreadFinancialCount > 99 ? '99+' : unreadFinancialCount}</span>
            )}
          </button>
        </div>

        {/* v15: Barra de busca INTERNA da inbox (busca contato/mensagem) —
            restaurada apos remocao acidental na v14. Esta eh diferente da
            barra global de paciente (PatientSearch) que ficava no topo do
            layout — essa global foi removida porque era redundante aqui. */}
        <div className="relative">
          <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground/60 pointer-events-none" />
          <input
            type="text"
            value={searchQuery}
            onChange={e => onSetSearchQuery(e.target.value)}
            placeholder="Buscar contato ou mensagem…"
            className="w-full pl-8 pr-7 py-1.5 text-[12px] bg-accent/50 border border-border rounded-lg placeholder:text-muted-foreground/50 focus:outline-none focus:ring-1 focus:ring-primary/40 focus:border-primary/40 transition-all"
          />
          {searchQuery && (
            <button
              onClick={() => onSetSearchQuery('')}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors"
              title="Limpar busca"
              aria-label="Limpar busca"
            >
              <X size={12} />
            </button>
          )}
        </div>

        {/* Banner "Ativar notificações do navegador" removido pra dar mais espaço na
            lista (a permissão de notificação segue disponível em Config → Notificações). */}

        {/* WhatsApp disconnection banner */}
        {hasDisconnectedInstance && (
          <div className="px-3 py-2 rounded-lg bg-red-500/10 border border-red-500/20 text-red-400 text-xs font-medium flex items-center gap-2">
            <span className="w-2 h-2 bg-red-500 rounded-full animate-pulse" />
            WhatsApp desconectado
          </div>
        )}

        {/* Transferências aguardando resposta */}
        {pendingTransfers.length > 0 && (
          <div className="rounded-xl border border-amber-500/30 bg-amber-500/5 overflow-hidden">
            <div className="flex items-center gap-2 px-3 py-2 border-b border-amber-500/20">
              <span className="text-amber-500 text-sm">📨</span>
              <span className="text-[11px] font-bold uppercase tracking-wider text-amber-500">
                Aguardando você ({pendingTransfers.length})
              </span>
            </div>
            <div className="divide-y divide-amber-500/10">
              {pendingTransfers.map(pt => (
                <div key={pt.conversationId} className="flex items-center gap-2 px-3 py-2.5">
                  <div className="flex-1 min-w-0">
                    <p className="text-xs font-semibold truncate">{pt.contactName}</p>
                    <p className="text-[10px] text-muted-foreground truncate">De: {pt.fromUserName}</p>
                    {pt.reason && <p className="text-[10px] text-amber-400/80 italic truncate">{pt.reason}</p>}
                    {pt.audioIds && pt.audioIds.length > 0 && (
                      <p className="text-[10px] text-violet-400/80">🎙 {pt.audioIds.length} áudio{pt.audioIds.length > 1 ? 's' : ''}</p>
                    )}
                  </div>
                  <div className="flex gap-1 shrink-0">
                    <button
                      onClick={() => onQuickAcceptTransfer(pt.conversationId)}
                      className="px-2 py-1 bg-emerald-500 text-white rounded-lg text-[10px] font-bold hover:bg-emerald-600 transition-colors"
                      title="Aceitar transferência"
                    >✓</button>
                    <button
                      onClick={() => onShowTransferPopup(pt)}
                      className="px-2 py-1 bg-red-500/10 text-red-400 border border-red-500/20 rounded-lg text-[10px] font-bold hover:bg-red-500/20 transition-colors"
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

        <div className="flex items-center gap-2">
          <div className="flex bg-muted rounded-xl p-1 flex-1 relative">
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
                className={`flex-1 py-1.5 text-[11px] font-bold uppercase tracking-wider rounded-lg transition-all relative ${leadFilter === tab.value ? 'bg-background shadow-sm text-foreground' : 'text-muted-foreground hover:text-foreground hover:bg-background/50'}`}
              >
                {tab.label}
                {tab.count > 0 && (
                  <span className="absolute -top-2.5 -right-2 min-w-[26px] h-[26px] px-1.5 rounded-full bg-red-500 text-white text-[12px] font-bold leading-[26px] text-center shadow-md">
                    {tab.count > 99 ? '99+' : tab.count}
                  </span>
                )}
              </button>
            ))}
          </div>

          {/* Save filter button — only shown when a non-default filter is active */}
          {hasNonDefaultFilter && (
            <button
              onClick={() => setShowSaveInput((v) => !v)}
              className="shrink-0 text-base leading-none px-2 py-1.5 rounded-lg text-muted-foreground hover:text-foreground hover:bg-accent transition-all"
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
            <input
              ref={saveInputRef}
              type="text"
              value={saveInputValue}
              onChange={(e) => setSaveInputValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleSaveFilter();
                if (e.key === 'Escape') { setShowSaveInput(false); setSaveInputValue(''); }
              }}
              placeholder="Nome do filtro…"
              className="flex-1 px-3 py-1.5 text-[12px] bg-accent/50 border border-border rounded-lg placeholder:text-muted-foreground/50 focus:outline-none focus:ring-1 focus:ring-primary/40 focus:border-primary/40 transition-all"
            />
            <button
              onClick={handleSaveFilter}
              className="px-3 py-1.5 bg-primary text-primary-foreground rounded-lg text-[11px] font-bold hover:opacity-90 transition-opacity"
            >
              Salvar
            </button>
            <button
              onClick={() => { setShowSaveInput(false); setSaveInputValue(''); }}
              className="text-muted-foreground hover:text-foreground transition-colors"
              aria-label="Cancelar"
            >
              <X size={14} />
            </button>
          </div>
        )}

        {/* Saved filter chips */}
        {savedFilters.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {savedFilters.map((f) => (
              <div
                key={f.id}
                className="flex items-center gap-1 px-2.5 py-1 rounded-full bg-primary/10 border border-primary/20 text-[10px] font-semibold text-primary/80 cursor-pointer hover:bg-primary/20 transition-colors group"
                onClick={() => handleApplySavedFilter(f)}
                title={`Aplicar filtro: ${f.name}`}
              >
                <span>{f.name}</span>
                <button
                  onClick={(e) => { e.stopPropagation(); handleDeleteSavedFilter(f.id); }}
                  className="text-primary/50 hover:text-primary transition-colors ml-0.5"
                  aria-label={`Remover filtro ${f.name}`}
                >
                  <X size={10} />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className={`flex-1 overflow-y-auto w-full custom-scrollbar ${isMobile && !selectedId ? 'pb-16' : ''}`}>
        {loading ? (
          <div className="p-10 text-center text-muted-foreground text-sm">Carregando conversas...</div>
        ) : filteredConversations.length === 0 ? (
          <div className="p-10 text-center text-muted-foreground text-sm">
            {searchQuery.trim() ? `Nenhum resultado para "${searchQuery}".` : 'Nenhuma conversa encontrada.'}
          </div>
        ) : (
          (() => {
            let lastConvDateKey = '';
            return filteredConversations.map((conv) => {
              const convDate = conv.lastMessageAt;
              const dateKey = convDate ? getDateKey(convDate) : '__nodate__';
              const showDateSep = dateKey !== lastConvDateKey;
              if (showDateSep) lastConvDateKey = dateKey;
              const isBulkSelected = selectedBulk?.has(conv.id) ?? false;
              const inBulkMode = (selectedBulk?.size ?? 0) > 0;
              return (
                <div key={conv.id}>
                  {showDateSep && convDate && (
                    <DateSeparator label={formatDateLabel(convDate)} />
                  )}
                  <div
                    onClick={() => {
                      if (inBulkMode) {
                        onToggleBulk?.(conv.id);
                        return;
                      }
                      onSelectConversation(conv.id);
                      onSetUnreadCounts(prev => { const n = { ...prev }; delete n[conv.id]; return n; });
                    }}
                    className={`group flex gap-4 p-4 border-b border-border/50 cursor-pointer transition-colors relative
                      ${selectedId === conv.id ? 'bg-accent/50' : 'hover:bg-accent/30'}
                      ${isBulkSelected ? 'bg-primary/10' : ''}
                    `}
                  >
                    {selectedId === conv.id && !inBulkMode && <div className="absolute left-0 top-0 bottom-0 w-1 bg-primary" />}
                    {/* Checkbox (visible on hover or in bulk mode) + Avatar + score badge */}
                    <div className="flex flex-col items-center gap-0.5 shrink-0 relative">
                      <div
                        className={`absolute -left-1 top-0 z-10 transition-opacity ${inBulkMode ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'}`}
                        onClick={(e) => { e.stopPropagation(); onToggleBulk?.(conv.id); }}
                      >
                        <input
                          type="checkbox"
                          checked={isBulkSelected}
                          onChange={() => onToggleBulk?.(conv.id)}
                          className="w-4 h-4 rounded accent-primary cursor-pointer"
                          aria-label={`Selecionar ${conv.contactName || conv.contactPhone}`}
                        />
                      </div>
                      <ContactAvatar
                        src={conv.profile_picture_url}
                        name={conv.contactName}
                        sizeClass="w-11 h-11"
                        onClick={(url) => { onLightbox(url); }}
                      />
                      {(() => {
                        const stage = normalizeStage(conv.leadStage || '');
                        if (stage === 'PERDIDO' || stage === 'FINALIZADO' || !conv.leadStage) return null;
                        const score = computeScore(conv);
                        return (
                          <span
                            className={`text-[9px] font-bold tabular-nums px-1.5 rounded-full border leading-[14px] ${scoreStyle(score)}`}
                            title={`Score do lead: ${score}/100`}
                          >
                            {score}
                          </span>
                        );
                      })()}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex justify-between items-start mb-0.5">
                        <span className="font-semibold truncate pl-0.5 text-foreground">
                          {conv.contactName || conv.contactPhone}
                        </span>
                        <div className="flex items-center gap-1.5 shrink-0 ml-1">
                          {(unreadCounts[conv.id] || 0) > 0 && (
                            <span className="bg-red-500 text-white text-[11px] font-bold rounded-full min-w-[20px] h-[20px] flex items-center justify-center px-1 leading-none shadow-md">
                              {unreadCounts[conv.id] > 99 ? '99+' : unreadCounts[conv.id]}
                            </span>
                          )}
                          <span className="text-[11px] text-muted-foreground">{formatTime(conv.lastMessageAt)}</span>
                        </div>
                      </div>
                      {conv.contactPhone && conv.contactName !== conv.contactPhone && (
                        <p className="text-[11px] text-muted-foreground truncate pl-0.5 mb-0.5">{conv.contactPhone}</p>
                      )}
                      <div className="mb-1 flex items-center gap-2 flex-wrap">
                        {statusBadge(conv.status)}
                        {(conv.originAssignedUserId ? conv.originAssignedUserName : conv.assignedAgentName) && (
                          <span className="inline-flex items-center gap-1 text-[10px] text-muted-foreground font-medium">
                            <span className="w-1.5 h-1.5 rounded-full bg-muted-foreground/40 inline-block" />
                            Aten. {conv.originAssignedUserId ? conv.originAssignedUserName : conv.assignedAgentName}
                          </span>
                        )}
                        {/* Badge SLA: aguardando resposta há mais de 15min */}
                        {(() => {
                          const unread = unreadCounts[conv.id] || 0;
                          if (unread === 0 || conv.status === 'CLOSED' || conv.status === 'ADIADO') return null;
                          const waitingMins = conv.lastMessageAt
                            ? Math.floor((Date.now() - new Date(conv.lastMessageAt).getTime()) / 60000)
                            : 0;
                          if (waitingMins < 15) return null;
                          const isUrgent = waitingMins >= 60;
                          return (
                            <span
                              title={`Cliente aguardando resposta há ${waitingMins >= 60 ? `${Math.floor(waitingMins / 60)}h${waitingMins % 60 > 0 ? `${waitingMins % 60}min` : ''}` : `${waitingMins}min`}`}
                              className={`inline-flex items-center gap-0.5 text-[9px] font-bold px-1.5 py-0.5 rounded-full border ${isUrgent ? 'bg-red-500/15 text-red-400 border-red-500/30' : 'bg-amber-500/15 text-amber-400 border-amber-500/30'}`}
                            >
                              ⏱ {waitingMins >= 60 ? `${Math.floor(waitingMins / 60)}h` : `${waitingMins}min`}
                            </span>
                          );
                        })()}
                      </div>
                      {conv.specialty && (
                        <div className="mb-1.5 flex items-center gap-1.5 flex-wrap">
                          <span className="inline-flex items-center gap-1 text-[10px] text-violet-400 font-bold border border-violet-500/20 bg-violet-500/10 rounded-md px-1.5 py-0.5">
                            ⚖️ {conv.specialty}
                          </span>
                          {conv.assignedDentistName && (
                            <span className="text-[10px] text-violet-300 font-medium truncate">
                              Dr(a). {conv.assignedDentistName}
                            </span>
                          )}
                        </div>
                      )}
                      {/* Etiquetas do lead */}
                      {conv.leadTags && conv.leadTags.length > 0 && (
                        <div className="mb-1 flex items-center gap-1 flex-wrap">
                          {conv.leadTags.slice(0, 3).map(tag => (
                            <span
                              key={tag}
                              className="inline-flex items-center text-[9px] font-semibold px-1.5 py-0.5 rounded-full bg-primary/10 text-primary/80 border border-primary/20"
                            >
                              {tag}
                            </span>
                          ))}
                          {conv.leadTags.length > 3 && (
                            <span className="text-[9px] text-muted-foreground/60">+{conv.leadTags.length - 3}</span>
                          )}
                        </div>
                      )}
                      {conv.activeTask && (() => {
                        const isOverdue = conv.activeTask.dueAt ? new Date(conv.activeTask.dueAt) < new Date() : false;
                        return (
                          <div className="flex items-center gap-1.5 mb-0.5">
                            <Clock size={11} className={isOverdue ? 'text-red-400 animate-pulse' : 'text-amber-400'} />
                            <span className={`text-[10px] font-medium truncate max-w-[120px] ${isOverdue ? 'text-red-400' : 'text-amber-400'}`}>
                              {conv.activeTask.title}
                            </span>
                            {conv.activeTask.dueAt && (
                              <span className={`text-[9px] font-bold whitespace-nowrap ${isOverdue ? 'text-red-500' : 'text-muted-foreground'}`}>
                                {formatTaskDate(conv.activeTask.dueAt)}
                              </span>
                            )}
                            {(conv.activeTask.postponeCount ?? 0) > 0 && (
                              <span className="text-[9px] text-amber-500/70 font-semibold whitespace-nowrap">
                                ×{conv.activeTask.postponeCount}
                              </span>
                            )}
                          </div>
                        );
                      })()}
                      <div className="flex items-center gap-2">
                        <p className={`text-sm truncate flex-1 ${(unreadCounts[conv.id] || 0) > 0 ? 'text-foreground font-medium' : 'text-muted-foreground'}`}>
                          {conv.lastMessage}
                        </p>
                        {/* Chip de dormência: sem atividade há mais de 2 dias */}
                        {(() => {
                          if (!conv.lastMessageAt || conv.status === 'CLOSED' || conv.status === 'ADIADO') return null;
                          const stage = normalizeStage(conv.leadStage || '');
                          if (stage === 'PERDIDO' || stage === 'FINALIZADO') return null;
                          const days = Math.floor((Date.now() - new Date(conv.lastMessageAt).getTime()) / 86400000);
                          if (days < 2) return null;
                          return (
                            <span
                              title={`Sem atividade há ${days} dia${days > 1 ? 's' : ''}`}
                              className="shrink-0 text-[9px] font-bold text-muted-foreground/70 bg-muted/60 border border-border/60 rounded-full px-1.5 py-0.5"
                            >
                              💤 {days}d
                            </span>
                          );
                        })()}
                      </div>
                    </div>
                  </div>
                </div>
              );
            });
          })()
        )}
      </div>

      {/* Bulk action bar */}
      {(selectedBulk?.size ?? 0) > 0 && (
        <div className="shrink-0 border-t border-border bg-card p-3 flex items-center gap-2">
          <span className="text-xs font-bold text-foreground flex-1">{selectedBulk!.size} selecionada{selectedBulk!.size > 1 ? 's' : ''}</span>
          <button onClick={() => onBulkAction?.('close', [...selectedBulk!])} className="px-3 py-1.5 text-xs font-bold bg-red-500/10 text-red-400 border border-red-500/20 rounded-lg hover:bg-red-500/20 transition-colors">Encerrar</button>
          <button onClick={() => onClearBulk?.()} className="px-3 py-1.5 text-xs font-bold bg-muted text-muted-foreground rounded-lg hover:bg-muted/80 transition-colors">Cancelar</button>
        </div>
      )}
    </section>
  );
}

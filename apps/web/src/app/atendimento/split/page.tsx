'use client';

/**
 * Onda 16 — Split View do WhatsApp.
 *
 * Renderiza um grid 2x2 (mode=4) ou 3x2 (mode=6) de iframes pra
 * /atendimento/chat/{id} — permite observar/atender varios chats
 * simultaneamente. Cada slot tem header com nome + trocar + fechar.
 *
 * Estado vive na URL:
 *   ?mode=4&ids=conv1,conv2,conv3,conv4
 *   ?mode=6&ids=conv1,EMPTY,conv2,EMPTY,EMPTY,EMPTY
 *
 * Vantagens de URL: refresh mantem layout, compartilhar link com colega,
 * abrir varias instancias do split em janelas diferentes.
 *
 * Por que iframe: reusa a pagina /atendimento/chat/[id] que ja existe
 * e funciona standalone. Zero refactor do page.tsx principal.
 */

import { Suspense, useEffect, useMemo, useState, useCallback } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { ArrowLeft, X, Plus, Search, RefreshCw, PanelLeftClose, PanelLeftOpen, Check } from 'lucide-react';
import api from '@/lib/api';

interface ConversationLite {
  id: string;
  contact_name: string | null;
  contact_phone: string | null;
  last_msg_preview?: string | null;
  last_msg_at?: string | null;
  unread_count?: number;
}

const EMPTY_SLOT = 'EMPTY';

// Next.js 16 exige <Suspense> em pages que usam useSearchParams() porque o
// search params nao existe durante prerender estatico. Wrapper externo +
// componente interno com a logica real.
export default function SplitPage() {
  return (
    <Suspense
      fallback={
        <div className="h-screen flex items-center justify-center text-muted-foreground text-sm">
          Carregando split…
        </div>
      }
    >
      <SplitPageInner />
    </Suspense>
  );
}

function SplitPageInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const mode = parseInt(searchParams.get('mode') ?? '4', 10);
  const validMode = mode === 6 ? 6 : 4;
  const idsParam = searchParams.get('ids') ?? '';

  // Slots = array fixo de tamanho validMode com conversationId ou EMPTY
  const slots = useMemo(() => {
    const parts = idsParam ? idsParam.split(',') : [];
    return Array.from({ length: validMode }, (_, i) => parts[i] || EMPTY_SLOT);
  }, [idsParam, validMode]);

  const [conversations, setConversations] = useState<ConversationLite[]>([]);
  const [loading, setLoading] = useState(true);
  const [pickerForSlot, setPickerForSlot] = useState<number | null>(null);
  const [search, setSearch] = useState('');
  // Onda 16.2 — sidebar lateral com lista de conversas (click rapido).
  // Default = aberta. Lembra preferencia em localStorage.
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [sidebarSearch, setSidebarSearch] = useState('');

  useEffect(() => {
    try {
      const saved = localStorage.getItem('split_sidebar_open');
      if (saved === '0') setSidebarOpen(false);
    } catch { /* ignore */ }
  }, []);
  useEffect(() => {
    try {
      localStorage.setItem('split_sidebar_open', sidebarOpen ? '1' : '0');
    } catch { /* ignore */ }
  }, [sidebarOpen]);

  const fetchConversations = useCallback(async () => {
    try {
      const res = await api.get('/conversations', { params: { limit: 100 } });
      const list = Array.isArray(res.data) ? res.data : res.data?.items ?? [];
      setConversations(list);
    } catch (e) {
      console.error('[split] erro buscando conversas', e);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchConversations();
  }, [fetchConversations]);

  const updateSlots = (next: string[]) => {
    const ids = next.join(',');
    const params = new URLSearchParams(searchParams);
    if (next.every((s) => s === EMPTY_SLOT)) params.delete('ids');
    else params.set('ids', ids);
    router.replace(`/atendimento/split?${params.toString()}`);
  };

  const setSlot = (index: number, conversationId: string) => {
    const next = [...slots];
    next[index] = conversationId;
    updateSlots(next);
    setPickerForSlot(null);
    setSearch('');
  };

  const clearSlot = (index: number) => {
    const next = [...slots];
    next[index] = EMPTY_SLOT;
    updateSlots(next);
  };

  const changeMode = (newMode: 4 | 6) => {
    const params = new URLSearchParams(searchParams);
    params.set('mode', String(newMode));
    // Se diminuiu, trunca; se aumentou, preenche com EMPTY
    const next = Array.from({ length: newMode }, (_, i) => slots[i] || EMPTY_SLOT);
    if (next.every((s) => s === EMPTY_SLOT)) params.delete('ids');
    else params.set('ids', next.join(','));
    router.replace(`/atendimento/split?${params.toString()}`);
  };

  // Filtra conversas no picker (busca por nome ou telefone) + remove ja selecionadas em outros slots
  const filteredConvs = useMemo(() => {
    const s = search.trim().toLowerCase();
    const inUse = new Set(slots.filter((x) => x !== EMPTY_SLOT));
    return conversations.filter((c) => {
      if (inUse.has(c.id)) return false;
      if (!s) return true;
      return (
        (c.contact_name ?? '').toLowerCase().includes(s) ||
        (c.contact_phone ?? '').includes(s)
      );
    });
  }, [conversations, slots, search]);

  // Helper pra encontrar dados da conversa por id (mostra no header do slot)
  const convById = (id: string) => conversations.find((c) => c.id === id);

  // Onda 16.2 — sidebar: lista filtrada + helper de "qual slot tem essa conv"
  const slotIndexOf = (id: string) => slots.indexOf(id);
  const sidebarConvs = useMemo(() => {
    const s = sidebarSearch.trim().toLowerCase();
    if (!s) return conversations;
    return conversations.filter(
      (c) =>
        (c.contact_name ?? '').toLowerCase().includes(s) ||
        (c.contact_phone ?? '').includes(s),
    );
  }, [conversations, sidebarSearch]);

  // Click na conversa da sidebar: se ja esta aberta em algum slot, scroll
  // (no caso de iframe foco visual) ou fecha. Senao, preenche primeiro
  // slot vazio. Se todos cheios, substitui o ultimo (slot N).
  const addOrToggleConv = (convId: string) => {
    const existingIdx = slots.indexOf(convId);
    if (existingIdx >= 0) {
      // Ja aberto — remove
      clearSlot(existingIdx);
      return;
    }
    const firstEmpty = slots.indexOf(EMPTY_SLOT);
    if (firstEmpty >= 0) {
      setSlot(firstEmpty, convId);
    } else {
      // Todos cheios — substitui o ULTIMO (mais a direita / embaixo)
      setSlot(slots.length - 1, convId);
    }
  };

  const gridCls =
    validMode === 4
      ? 'grid-cols-2 grid-rows-2'
      : 'grid-cols-3 grid-rows-2';

  return (
    <div className="h-screen flex flex-col bg-background">
      {/* ── Top bar ── */}
      <header className="flex items-center gap-3 px-4 py-2 border-b border-border bg-card/50 backdrop-blur-sm shrink-0">
        <button
          onClick={() => router.push('/atendimento')}
          className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors"
          title="Voltar pro WhatsApp"
        >
          <ArrowLeft size={16} />
          Voltar
        </button>
        <div className="h-4 w-px bg-border" />
        <h1 className="text-sm font-semibold text-foreground">
          Modo Split — {validMode} conversas
        </h1>
        <button
          onClick={() => setSidebarOpen((v) => !v)}
          className="ml-3 inline-flex items-center justify-center p-1.5 rounded-lg text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
          title={sidebarOpen ? 'Esconder lista de conversas' : 'Mostrar lista de conversas'}
        >
          {sidebarOpen ? <PanelLeftClose size={14} /> : <PanelLeftOpen size={14} />}
        </button>
        <div className="flex items-center gap-1 ml-auto">
          <button
            onClick={() => changeMode(4)}
            className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-all ${
              validMode === 4
                ? 'bg-primary text-primary-foreground shadow-sm'
                : 'text-muted-foreground hover:bg-accent hover:text-foreground'
            }`}
          >
            4
          </button>
          <button
            onClick={() => changeMode(6)}
            className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-all ${
              validMode === 6
                ? 'bg-primary text-primary-foreground shadow-sm'
                : 'text-muted-foreground hover:bg-accent hover:text-foreground'
            }`}
          >
            6
          </button>
          <button
            onClick={fetchConversations}
            className="p-1.5 rounded-lg text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
            title="Atualizar lista de conversas"
          >
            <RefreshCw size={14} />
          </button>
        </div>
      </header>

      {/* ── Layout: sidebar + grid ── */}
      <div className="flex-1 flex overflow-hidden">
        {/* Sidebar lateral — lista de conversas pra adicionar com 1 click */}
        {sidebarOpen && (
          <aside className="w-72 shrink-0 border-r border-border bg-card/30 backdrop-blur-sm flex flex-col overflow-hidden">
            <div className="p-3 border-b border-border shrink-0">
              <p className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground mb-2">
                Click pra adicionar
              </p>
              <div className="relative">
                <Search
                  size={13}
                  className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground pointer-events-none"
                />
                <input
                  type="text"
                  value={sidebarSearch}
                  onChange={(e) => setSidebarSearch(e.target.value)}
                  placeholder="Buscar..."
                  className="w-full pl-8 pr-2 py-1.5 text-xs rounded-lg border border-border bg-background focus:outline-none focus:ring-2 focus:ring-primary/40"
                />
              </div>
            </div>
            <div className="flex-1 overflow-y-auto">
              {loading ? (
                <div className="p-4 text-center text-xs text-muted-foreground">
                  Carregando…
                </div>
              ) : sidebarConvs.length === 0 ? (
                <div className="p-4 text-center text-xs text-muted-foreground">
                  Nenhuma conversa
                </div>
              ) : (
                <ul>
                  {sidebarConvs.map((c) => {
                    const slotIdx = slotIndexOf(c.id);
                    const isOpen = slotIdx >= 0;
                    return (
                      <li key={c.id}>
                        <button
                          onClick={() => addOrToggleConv(c.id)}
                          className={`w-full text-left px-3 py-2 flex items-center gap-2 transition-colors border-b border-border/40 ${
                            isOpen
                              ? 'bg-primary/10 hover:bg-primary/15'
                              : 'hover:bg-accent/40'
                          }`}
                          title={
                            isOpen
                              ? `Aberta no Slot ${slotIdx + 1} — click pra fechar`
                              : 'Click pra abrir no proximo slot vazio'
                          }
                        >
                          <div className="flex-1 min-w-0">
                            <p className="text-xs font-semibold text-foreground truncate">
                              {c.contact_name || c.contact_phone || 'Sem nome'}
                            </p>
                            {c.last_msg_preview && (
                              <p className="text-[10px] text-muted-foreground truncate">
                                {c.last_msg_preview}
                              </p>
                            )}
                          </div>
                          {isOpen ? (
                            <span
                              className="shrink-0 inline-flex items-center justify-center min-w-[20px] h-5 px-1.5 rounded-md bg-primary text-primary-foreground text-[10px] font-bold"
                              title={`Slot ${slotIdx + 1}`}
                            >
                              <Check size={11} className="mr-0.5" />
                              {slotIdx + 1}
                            </span>
                          ) : (c.unread_count ?? 0) > 0 ? (
                            <span className="shrink-0 min-w-[18px] h-4 px-1.5 rounded-full bg-red-500 text-white text-[9px] font-bold flex items-center justify-center">
                              {c.unread_count}
                            </span>
                          ) : null}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          </aside>
        )}

        {/* Grid de slots */}
        <main className={`flex-1 grid gap-2 p-2 overflow-hidden ${gridCls}`}>
        {slots.map((slotId, idx) => {
          const isEmpty = slotId === EMPTY_SLOT;
          const conv = isEmpty ? null : convById(slotId);
          return (
            <div
              key={`${idx}-${slotId}`}
              className="flex flex-col bg-card border border-border rounded-xl overflow-hidden shadow-sm"
            >
              {/* Header do slot */}
              <div className="flex items-center gap-2 px-3 py-2 border-b border-border bg-background/50 shrink-0">
                <span className="text-xs font-bold text-muted-foreground">
                  Slot {idx + 1}
                </span>
                {!isEmpty && (
                  <>
                    <span className="text-xs font-semibold text-foreground truncate flex-1">
                      {conv?.contact_name || conv?.contact_phone || 'Conversa'}
                    </span>
                    <button
                      onClick={() => setPickerForSlot(idx)}
                      className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground hover:text-foreground transition-colors px-2 py-0.5 rounded"
                      title="Trocar conversa neste slot"
                    >
                      Trocar
                    </button>
                    <button
                      onClick={() => clearSlot(idx)}
                      className="p-1 rounded text-muted-foreground hover:bg-destructive/10 hover:text-destructive transition-colors"
                      title="Fechar slot"
                    >
                      <X size={14} />
                    </button>
                  </>
                )}
                {isEmpty && (
                  <span className="text-xs text-muted-foreground italic flex-1">
                    Vazio
                  </span>
                )}
              </div>

              {/* Conteudo: iframe da conversa OU picker */}
              <div className="flex-1 overflow-hidden relative">
                {isEmpty ? (
                  <button
                    onClick={() => setPickerForSlot(idx)}
                    className="w-full h-full flex flex-col items-center justify-center gap-2 text-muted-foreground hover:bg-accent/30 transition-colors"
                  >
                    <Plus size={32} strokeWidth={1.5} className="opacity-50" />
                    <span className="text-sm font-medium">Selecionar conversa</span>
                  </button>
                ) : (
                  <iframe
                    key={slotId}
                    src={`/atendimento/chat/${slotId}`}
                    className="w-full h-full border-0"
                    title={`Conversa ${slotId}`}
                  />
                )}
              </div>
            </div>
          );
        })}
        </main>
      </div>

      {/* ── Picker modal ── */}
      {pickerForSlot !== null && (
        <div
          className="fixed inset-0 z-[9999] bg-black/50 backdrop-blur-sm flex items-center justify-center p-4"
          onClick={() => setPickerForSlot(null)}
        >
          <div
            className="bg-card border border-border rounded-2xl shadow-2xl w-full max-w-md max-h-[80vh] flex flex-col overflow-hidden"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="p-4 border-b border-border">
              <h2 className="text-base font-bold text-foreground mb-2">
                Selecionar conversa — Slot {pickerForSlot + 1}
              </h2>
              <div className="relative">
                <Search
                  size={14}
                  className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground pointer-events-none"
                />
                <input
                  autoFocus
                  type="text"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Buscar por nome ou telefone…"
                  className="w-full pl-9 pr-3 py-2 rounded-lg border border-border bg-background text-sm focus:outline-none focus:ring-2 focus:ring-primary/40"
                />
              </div>
            </div>
            <div className="flex-1 overflow-y-auto">
              {loading ? (
                <div className="p-6 text-center text-sm text-muted-foreground">
                  Carregando conversas…
                </div>
              ) : filteredConvs.length === 0 ? (
                <div className="p-6 text-center text-sm text-muted-foreground">
                  {search
                    ? `Nenhuma conversa para "${search}"`
                    : 'Todas as conversas ja estao abertas em outros slots'}
                </div>
              ) : (
                <ul>
                  {filteredConvs.map((c) => (
                    <li key={c.id}>
                      <button
                        onClick={() => setSlot(pickerForSlot, c.id)}
                        className="w-full text-left px-4 py-3 flex items-center gap-3 hover:bg-accent/40 transition-colors border-b border-border/50"
                      >
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-semibold text-foreground truncate">
                            {c.contact_name || c.contact_phone || 'Sem nome'}
                          </p>
                          {c.last_msg_preview && (
                            <p className="text-xs text-muted-foreground truncate">
                              {c.last_msg_preview}
                            </p>
                          )}
                        </div>
                        {(c.unread_count ?? 0) > 0 && (
                          <span className="shrink-0 min-w-[20px] h-5 px-1.5 rounded-full bg-red-500 text-white text-[10px] font-bold flex items-center justify-center">
                            {c.unread_count}
                          </span>
                        )}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <div className="p-3 border-t border-border flex justify-end">
              <button
                onClick={() => setPickerForSlot(null)}
                className="px-4 py-2 rounded-lg text-sm font-medium text-muted-foreground hover:bg-accent transition-colors"
              >
                Cancelar
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

'use client';

/**
 * SplitGrid — Onda 14.55
 *
 * Renderiza um grid 2x2 (mode=4) ou 3x2 (mode=6) de iframes pra
 * /atendimento/chat/{id}, embedavel dentro da pagina /atendimento (em
 * vez de ser uma rota separada `/atendimento/split` em nova aba).
 *
 * Diferencas vs /atendimento/split/page.tsx:
 *  - Sem top bar propria (toggle de modo vive no InboxSidebar)
 *  - Sem sidebar interna (a InboxSidebar de /atendimento ja lista as conversas)
 *  - Estado dos slots persistido em localStorage por mode (`split_slots_4`,
 *    `split_slots_6`) — sobrevive reload + alternar entre modos preserva
 *    cada layout separado
 *
 * Lista de conversas vem do parent (a mesma fonte que a InboxSidebar usa)
 * pra evitar requisicao duplicada.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Plus, Search, X } from 'lucide-react';
import ChatPane from '../split/components/ChatPane';

export interface SplitConversationLite {
  id: string;
  // Onda 17.23 — lead_id necessario pra ChatPane (useChatSocket espera leadId).
  leadId?: string;
  lead_id?: string;
  contact_name?: string | null;
  contact_phone?: string | null;
  last_msg_preview?: string | null;
  unread_count?: number;
}

/** Resolve lead_id de varios campos possiveis do DTO. */
function getLeadId(c: SplitConversationLite | undefined): string | null {
  if (!c) return null;
  return c.leadId || c.lead_id || null;
}

const EMPTY_SLOT = 'EMPTY';

interface Props {
  mode: 4 | 6;
  conversations: SplitConversationLite[];
}

export default function SplitGrid({ mode, conversations }: Props) {
  const storageKey = `split_slots_${mode}`;

  // Slots = array fixo de tamanho `mode` com conversationId ou EMPTY_SLOT.
  // Inicializa de localStorage (preserva entre reloads + entre modos).
  const [slots, setSlots] = useState<string[]>(() => {
    if (typeof window === 'undefined') {
      return Array.from({ length: mode }, () => EMPTY_SLOT);
    }
    try {
      const saved = localStorage.getItem(storageKey);
      if (saved) {
        const arr = saved.split(',');
        return Array.from({ length: mode }, (_, i) => arr[i] || EMPTY_SLOT);
      }
    } catch {
      /* ignore */
    }
    return Array.from({ length: mode }, () => EMPTY_SLOT);
  });

  // Quando mode muda (ex: 4→6), trunca/expande o array preservando o que cabe.
  // Carrega tambem do storage do novo mode pra alternancia entre layouts.
  useEffect(() => {
    try {
      const saved = localStorage.getItem(storageKey);
      if (saved) {
        const arr = saved.split(',');
        setSlots(Array.from({ length: mode }, (_, i) => arr[i] || EMPTY_SLOT));
        return;
      }
    } catch {
      /* ignore */
    }
    setSlots((prev) =>
      Array.from({ length: mode }, (_, i) => prev[i] || EMPTY_SLOT),
    );
  }, [mode, storageKey]);

  // Persiste mudancas no slot
  useEffect(() => {
    try {
      localStorage.setItem(storageKey, slots.join(','));
    } catch {
      /* ignore */
    }
  }, [slots, storageKey]);

  const [pickerForSlot, setPickerForSlot] = useState<number | null>(null);
  const [search, setSearch] = useState('');

  const setSlot = useCallback((index: number, conversationId: string) => {
    setSlots((prev) => {
      const next = [...prev];
      next[index] = conversationId;
      return next;
    });
    setPickerForSlot(null);
    setSearch('');
  }, []);

  const clearSlot = useCallback((index: number) => {
    setSlots((prev) => {
      const next = [...prev];
      next[index] = EMPTY_SLOT;
      return next;
    });
  }, []);

  // Filtra conversas no picker: remove ja selecionadas + filtro de busca
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

  const convById = useCallback(
    (id: string) => conversations.find((c) => c.id === id),
    [conversations],
  );

  const gridCls =
    mode === 4 ? 'grid-cols-2 grid-rows-2' : 'grid-cols-3 grid-rows-2';

  return (
    <>
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

              {/* Conteudo: ChatPane da conversa OU botao de selecao.
                  Onda 17.23 — substitui iframe (que tinha hydration mismatch
                  + sockets duplicados) por componente React real. */}
              <div className="flex-1 overflow-hidden relative">
                {isEmpty ? (
                  <button
                    onClick={() => setPickerForSlot(idx)}
                    className="w-full h-full flex flex-col items-center justify-center gap-2 text-muted-foreground hover:bg-accent/30 transition-colors"
                  >
                    <Plus size={32} strokeWidth={1.5} className="opacity-50" />
                    <span className="text-sm font-medium">Selecionar conversa</span>
                  </button>
                ) : (() => {
                  const conv = convById(slotId);
                  const leadId = getLeadId(conv);
                  if (!leadId) {
                    return (
                      <div className="w-full h-full flex flex-col items-center justify-center gap-2 text-muted-foreground">
                        <span className="text-xs text-amber-500">Conversa sem leadId</span>
                        <button
                          onClick={() => clearSlot(idx)}
                          className="text-[11px] underline hover:text-foreground"
                        >
                          Remover slot
                        </button>
                      </div>
                    );
                  }
                  return <ChatPane key={leadId} leadId={leadId} />;
                })()}
              </div>
            </div>
          );
        })}
      </main>

      {/* Picker modal — sobreposto, usado quando empty ou Trocar */}
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
              {filteredConvs.length === 0 ? (
                <div className="p-6 text-center text-sm text-muted-foreground">
                  {search
                    ? `Nenhuma conversa para "${search}"`
                    : 'Todas as conversas já estão abertas em outros slots'}
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
    </>
  );
}

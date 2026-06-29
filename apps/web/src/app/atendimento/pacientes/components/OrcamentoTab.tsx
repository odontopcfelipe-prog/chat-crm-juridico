'use client';

import { useEffect, useState, useCallback } from 'react';
import { Loader2, DollarSign, Plus, ArrowLeft, Send, Check, X, Trash2, MessageCircle, Calendar, Download, Tag, CreditCard, Repeat, Pencil, User as UserIcon } from 'lucide-react';
import QuoteAttachments from './QuoteAttachments';
import QuoteVersions from './QuoteVersions';
// Onda 5 — Aba Orcamentos so RECEBE/VALIDA (sem botao "+ Adicionar"). Mas
// AddQuoteItemModal continua importado pra suportar autoOpenAddItem (fluxo
// vindo da aba Avaliacao que cria DRAFT + abre modal de procedimentos direto).
import AddQuoteItemModal from './AddQuoteItemModal';
import api from '@/lib/api';
import { showError, showSuccess } from '@/lib/toast';
import { colorForSpecialty } from '@/lib/specialty-colors';
// Onda 14.18 — identificador unificado entre as 4 abas
import { getQuoteDisplayName, getQuoteNumberBadge } from '@/lib/quote-display';

interface Props {
  patientId: string;
  // Quando informado, abre direto esse orcamento em modo detalhe ao montar.
  // Usado quando a dra clica "Iniciar orcamento" na busca/ficha — o handler
  // cria DRAFT e redireciona pra ?tab=quotes&quote=<id>.
  initialQuoteId?: string;
  /**
   * Onda 3.34 — Quando true junto com initialQuoteId, abre o modal
   * AddQuoteItemModal automaticamente apos carregar o detalhe. Usado pela
   * aba Avaliação ao clicar "Iniciar nova avaliação" — cria o DRAFT
   * vazio e ja abre direto a tela de adicionar procedimentos, pulando
   * o "click no botao + Adicionar procedimentos" extra.
   */
  autoOpenAddItem?: boolean;
}

interface Procedure {
  id: string;
  name: string;
  base_price: string | number;
  code_tuss: string | null;
}

interface QuoteItem {
  id: string;
  procedure_id: string;
  tooth_fdi: string | null;
  quantity: number;
  unit_price: string | number;
  total_price: string | number;
  notes: string | null;
  procedure?: {
    id: string;
    name: string;
    code_tuss?: string | null;
    duration_minutes?: number;
    specialty?: { id: string; name: string } | null;
  };
  // Onda 3.2 (Fase 25) — dentista responsavel pelo procedimento
  dentist_id?: string | null;
  dentist?: { id: string; name: string } | null;
  // Onda 4.2 (Fase 25) — pagamento por procedimento (NULL = default do quote)
  payment_method?: string | null;
  installments_count?: number | null;
  // Onda 7.2 — aprovacao in-place. NULL = pendente, com data = aprovado.
  approved_at?: string | null;
}

// Onda 4.2 — labels amigaveis pro select de payment_method
const PAYMENT_METHOD_LABEL: Record<string, string> = {
  PIX: '💸 PIX',
  CASH: '💵 Dinheiro',
  CARD: '💳 Cartão à vista',
  INSTALLMENTS: '📅 Parcelado',
  BOLETO: '🧾 Boleto',
  TRANSFER: '🏦 Transferência',
};

// Onda 3.2 — dropdown de dentistas (carregado lazy quando entra no detalhe)
interface DentistOption {
  id: string;
  name: string;
}

interface QuoteListItem {
  id: string;
  status: 'DRAFT' | 'SENT' | 'ACCEPTED' | 'REJECTED' | 'EXPIRED';
  /// Onda 3.9 — nome customizavel pelo operador. Pode ser editado livremente.
  title: string | null;
  /// Onda 14.18 — numero sequencial global por tenant. Identificador unificado
  /// entre as 4 abas. Auto-incrementado no backend, imutavel apos criacao.
  quote_number?: number;
  /// Onda 5 — usado pra detectar "resto de aprovacao parcial" via prefix
  /// "[Resto de aprovacao parcial em X]" automatico nas notes — preserva
  /// o title customizado do operador.
  notes: string | null;
  /// Onda 6.4 — prioridade clinica definida pelo dentista na Avaliacao
  priority?: 'COMPLETO' | 'ESSENCIAL' | 'URGENTE' | null;
  total_value: string | number;
  created_at: string;
  valid_until: string | null;
  _count?: { items: number };
  created_by?: { id: string; name: string };
  // Onda 7.7 — contadores de aprovacao parcial (vem do backend)
  approved_count?: number;
  pending_count?: number;
}

interface QuoteDetail extends QuoteListItem {
  subtotal: string | number;
  discount_percent: string | number;
  discount_value: string | number;
  payment_terms: string | null;
  notes: string | null;
  sent_at: string | null;
  accepted_at: string | null;
  rejected_at: string | null;
  rejection_reason: string | null;
  items: QuoteItem[];
  // Onda 2 (Fase 24)
  coupon_id?: string | null;
  coupon?: {
    id: string;
    code: string;
    description: string | null;
    discount_type: 'PERCENT' | 'FIXED';
    discount_amount: string | number;
  } | null;
  // Onda 3b — Renegociacao
  renegotiated_from?: {
    id: string;
    status: string;
    total_value: string | number;
    created_at: string;
  } | null;
  // Onda 4.1 — Aprovacao parcial: aponta pro original que foi rejeitado
  accepted_from?: {
    id: string;
    status: string;
    total_value: string | number;
    created_at: string;
  } | null;
  // Onda 4.3 — Metricas de engajamento WhatsApp + portal
  whatsapp_message_id?: string | null;
  whatsapp_read_at?: string | null;
  portal_view_count?: number;
  portal_last_viewed_at?: string | null;
}

const STATUS_BADGE: Record<QuoteListItem['status'], string> = {
  DRAFT: 'bg-muted text-muted-foreground border-border',
  SENT: 'bg-blue-500/10 text-blue-600 border-blue-500/20',
  ACCEPTED: 'bg-emerald-500/10 text-emerald-600 border-emerald-500/20',
  REJECTED: 'bg-destructive/10 text-destructive border-destructive/20',
  EXPIRED: 'bg-amber-500/10 text-amber-600 border-amber-500/20',
};

const STATUS_LABEL: Record<QuoteListItem['status'], string> = {
  DRAFT: 'Rascunho',
  SENT: 'Enviado',
  ACCEPTED: 'Aceito',
  REJECTED: 'Rejeitado',
  EXPIRED: 'Expirado',
};

export default function OrcamentoTab({ patientId, initialQuoteId, autoOpenAddItem }: Props) {
  const [list, setList] = useState<QuoteListItem[]>([]);
  const [current, setCurrent] = useState<QuoteDetail | null>(null);
  const [procedures, setProcedures] = useState<Procedure[]>([]);
  const [loading, setLoading] = useState(true);
  const [mode, setMode] = useState<'list' | 'detail'>('list');
  const [saving, setSaving] = useState(false);

  const loadList = useCallback(async () => {
    setLoading(true);
    try {
      const [quotes, procs] = await Promise.all([
        api.get<QuoteListItem[]>(`/patients/${patientId}/quotes`),
        api.get<Procedure[]>('/procedures'),
      ]);
      setList(quotes.data);
      setProcedures(procs.data);
    } catch (err: any) {
      showError(err?.response?.data?.message || 'Erro ao carregar orçamentos');
    } finally {
      setLoading(false);
    }
  }, [patientId]);

  useEffect(() => { loadList(); }, [loadList]);

  const openDetail = useCallback(async (id: string) => {
    try {
      const { data } = await api.get<QuoteDetail>(`/quotes/${id}`);
      setCurrent(data);
      setMode('detail');
    } catch (err: any) {
      showError(err?.response?.data?.message || 'Erro ao carregar orçamento');
    }
  }, []);

  // Deep-link: ?quote=<id> abre direto o orcamento em modo detalhe quando
  // a dra clica "Iniciar orcamento" no header/busca. Roda 1x ao montar.
  useEffect(() => {
    if (initialQuoteId) openDetail(initialQuoteId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialQuoteId]);

  const createQuote = async () => {
    setSaving(true);
    try {
      const { data } = await api.post<QuoteDetail>(`/patients/${patientId}/quotes`, {});
      showSuccess('Rascunho criado');
      setCurrent(data);
      setMode('detail');
      loadList();
    } catch (err: any) {
      showError(err?.response?.data?.message || 'Erro ao criar');
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="py-12 flex items-center justify-center text-muted-foreground">
        <Loader2 size={18} className="animate-spin mr-2" /> Carregando orçamentos...
      </div>
    );
  }

  if (mode === 'detail' && current) {
    return (
      <QuoteDetailView
        quote={current}
        procedures={procedures}
        autoOpenAddItem={autoOpenAddItem}
        onBack={() => { setMode('list'); setCurrent(null); loadList(); }}
        onReload={async () => {
          const { data } = await api.get<QuoteDetail>(`/quotes/${current.id}`);
          setCurrent(data);
        }}
        onSwitchQuote={async (newQuoteId: string) => {
          const { data } = await api.get<QuoteDetail>(`/quotes/${newQuoteId}`);
          setCurrent(data);
        }}
      />
    );
  }

  // Onda 17.71 — orçamento TOTALMENTE aprovado some da Avaliação (já subiu pro
  // Financeiro + Tratamento). Parcial (ainda tem item pendente de aprovação)
  // permanece, pra você fechar o que falta antes de ele "subir".
  const visibleList = list.filter(
    (q) => !(q.status === 'ACCEPTED' && (q.pending_count ?? 0) === 0),
  );

  return (
    <div>
      <div className="flex items-center justify-between mb-3">
        <p className="text-sm text-muted-foreground">{visibleList.length} orçamento(s) em aberto</p>
      </div>

      {visibleList.length === 0 ? (
        <div className="bg-card border border-border border-dashed rounded-xl p-8 text-center">
          <DollarSign size={32} className="mx-auto text-muted-foreground mb-2" />
          <p className="text-muted-foreground text-sm">
            {list.length > 0
              ? 'Todos os orçamentos foram aprovados — já estão no Financeiro e no Tratamento.'
              : 'Nenhum orçamento cadastrado.'}
          </p>
        </div>
      ) : (
        <ul className="bg-card border border-border rounded-xl divide-y divide-border">
          {/* Onda 7.7 — Ordem crescente: mais antigo no topo (mesmo padrao
              da aba Avaliacao). API retorna desc por created_at, fazemos
              reverse aqui pra exibir asc. */}
          {[...visibleList].reverse().map((q, idx) => {
            const expiry = expiryStatus(q.valid_until, q.status);
            // Onda 5 — detecta "resto de aprovacao parcial" pelo prefixo
            // automatico nas notes (preserva titulo customizado do operador).
            // Fallback: title === 'Procedimento restante' pra compat com
            // quotes antigos que tinham titulo sobrescrito.
            const isRemainder =
              (q.notes || '').startsWith('[Resto de aprovacao parcial')
              || q.title === 'Procedimento restante';
            // Onda 5 — destaque visual pro status ACCEPTED (fundo verde +
            // borda esquerda emerald) pra equipe identificar de relance os
            // orcamentos fechados/aceitos.
            // Onda 7.8 — Card fica verde com QUALQUER aprovacao (parcial ou
            // total), mesmo se quote.status ainda for DRAFT/SENT. Mesma
            // logica da aba Avaliacao pra consistencia visual.
            const hasAnyApproved = (q.approved_count ?? 0) > 0;
            const isAccepted = q.status === 'ACCEPTED' || hasAnyApproved;

            const rowCls = isAccepted
              ? 'bg-emerald-50 dark:bg-emerald-950/30 border-l-4 border-emerald-500 hover:bg-emerald-100/60 dark:hover:bg-emerald-950/50'
              : isRemainder
              ? 'bg-amber-50/50 dark:bg-amber-950/20 border-l-4 border-amber-400 hover:bg-accent/40'
              : 'hover:bg-accent/40';
            const iconCls = isAccepted
              ? 'text-emerald-600'
              : isRemainder
              ? 'text-amber-600'
              : 'text-primary';
            const titleCls = isAccepted
              ? 'text-emerald-800 dark:text-emerald-200'
              : isRemainder
              ? 'text-amber-700'
              : 'text-foreground';

            return (
              <li
                key={q.id}
                onClick={() => openDetail(q.id)}
                className={`px-4 py-3 cursor-pointer flex items-center gap-3 ${rowCls}`}
              >
                <DollarSign size={18} className={`shrink-0 ${iconCls}`} />
                <div className="flex-1 min-w-0">
                  {/* Onda 14.18 — sempre mostra o identificador unificado
                      (#NNN · Nome) pra operador localizar o mesmo orcamento
                      em qualquer aba. Antes so renderizava se q.title existia.
                      Onda 14.19 — fallback `#${idx+1}` (indice local) pra quotes
                      legados com quote_number=0 antes do backfill SQL rodar.
                      Mesmo padrao do FinanceiroTab. Badge ganhou bg pra ficar
                      visualmente forte e ajudar o operador a achar o quote. */}
                  <p className={`text-sm font-semibold flex items-center gap-2 ${titleCls}`}>
                    <span className="text-[11px] font-mono font-bold text-primary bg-primary/10 border border-primary/20 px-1.5 py-0.5 rounded">
                      {getQuoteNumberBadge(q) || `#${idx + 1}`}
                    </span>
                    <span>{getQuoteDisplayName(q)}</span>
                    {isRemainder && (
                      <span className="inline-flex items-center text-[10px] px-1.5 py-0.5 rounded bg-amber-100 text-amber-800 border border-amber-300 dark:bg-amber-950 dark:text-amber-200 dark:border-amber-800 font-medium">
                        ↩ resto de aprovação parcial
                      </span>
                    )}
                  </p>
                  <p className={`text-sm font-medium ${isAccepted ? 'text-emerald-900 dark:text-emerald-100 font-bold' : 'text-foreground'}`}>
                    R$ {Number(q.total_value).toFixed(2)}
                    {q._count && <span className="text-xs text-muted-foreground ml-2">({q._count.items} itens)</span>}
                  </p>
                  <p className="text-xs text-muted-foreground flex items-center gap-2 flex-wrap">
                    <span>Criado em {new Date(q.created_at).toLocaleDateString('pt-BR')}</span>
                    {q.created_by && <span>por {q.created_by.name}</span>}
                    {expiry && (
                      <span className={`inline-flex items-center gap-1 ${expiry.cls}`}>
                        <Calendar size={11} /> {expiry.text}
                      </span>
                    )}
                  </p>
                </div>
                {/* Onda 6.4 — badge da prioridade clinica (mesmo padrao da
                    aba Avaliacao) — sempre visivel, 3 cores distintas.
                    Onda 14.19 — w-[96px] + justify-center: largura fixa pros 3
                    labels (URGENTE/ESSENCIAL/COMPLETO) ocuparem a mesma coluna,
                    deixando o badge de status (Aceito/Rascunho) alinhado
                    verticalmente entre as linhas. */}
                {(() => {
                  const p = q.priority || 'COMPLETO';
                  const cfg = {
                    URGENTE:   { label: '🔥 URGENTE',   cls: 'bg-red-500/15 text-red-700 border-red-500/30',         tip: 'Urgência clínica' },
                    ESSENCIAL: { label: '⚠ ESSENCIAL', cls: 'bg-amber-500/15 text-amber-700 border-amber-500/30',   tip: 'Procedimento essencial' },
                    COMPLETO:  { label: '✓ COMPLETO',  cls: 'bg-emerald-500/15 text-emerald-700 border-emerald-500/30', tip: 'Tratamento completo (sem urgência)' },
                  }[p];
                  return (
                    <span
                      className={`inline-flex items-center justify-center w-[96px] shrink-0 text-[10px] uppercase font-semibold px-2 py-0.5 rounded border ${cfg.cls}`}
                      title={cfg.tip}
                    >
                      {cfg.label}
                    </span>
                  );
                })()}
                <span className={`inline-flex items-center justify-center w-[78px] shrink-0 px-2 py-0.5 rounded-full text-xs font-medium border ${STATUS_BADGE[q.status]}`}>
                  {STATUS_LABEL[q.status]}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

// ─── Helpers de validade (Onda 1 — Fase 24) ─────────────────

/**
 * Calcula status de expiracao pra exibir na lista/detalhe:
 *  - Verde: > 7 dias restantes
 *  - Amarelo: 1-7 dias restantes (aviso)
 *  - Vermelho: ja expirou (status virou EXPIRED ou ainda SENT mas data passou)
 *  - Null: nao tem validade ou status nao se aplica (ACCEPTED/REJECTED)
 */
function expiryStatus(
  validUntil: string | null,
  status: string,
): { text: string; cls: string } | null {
  if (!validUntil) return null;
  // Em status terminal a validade nao faz sentido visual
  if (['ACCEPTED', 'REJECTED'].includes(status)) return null;

  const expiry = new Date(validUntil);
  const now = new Date();
  const msPerDay = 1000 * 60 * 60 * 24;
  const daysLeft = Math.floor((expiry.getTime() - now.getTime()) / msPerDay);

  if (daysLeft < 0) {
    return { text: `Expirou há ${Math.abs(daysLeft)}d`, cls: 'text-red-600' };
  }
  if (daysLeft === 0) {
    return { text: 'Expira hoje', cls: 'text-red-600' };
  }
  if (daysLeft <= 7) {
    return { text: `Expira em ${daysLeft}d`, cls: 'text-amber-600' };
  }
  return { text: `Válido por ${daysLeft}d`, cls: 'text-muted-foreground' };
}

function QuoteDetailView({
  quote, procedures, autoOpenAddItem, onBack, onReload, onSwitchQuote,
}: {
  quote: QuoteDetail;
  procedures: Procedure[];
  /** Onda 3.34 — Abre o modal AddQuoteItemModal automaticamente ao montar
   * (so na primeira vez). Usado quando navega da Avaliacao com "?add=1". */
  autoOpenAddItem?: boolean;
  onBack: () => void;
  onReload: () => Promise<void>;
  /** Onda 3.4 — abre outro quote sem passar pela lista (usado em "Duplicar como opcao") */
  onSwitchQuote?: (newQuoteId: string) => Promise<void>;
}) {
  // addingItem agora abre modal AddQuoteItemModal — nao mais form inline.
  // Onda 3.34 — Inicializa true se autoOpenAddItem (navegou da Avaliacao
  // clicando "Iniciar nova avaliacao"). Modal abre direto sem precisar do
  // botao "+ Adicionar procedimentos".
  // Onda 5 — botao "+ Adicionar procedimentos" foi removido da aba Orcamentos
  // (so recebe e valida). Mas o state addingItem permanece pra suportar o
  // fluxo da Avaliacao que abre o modal automaticamente via autoOpenAddItem.
  const [addingItem, setAddingItem] = useState(!!autoOpenAddItem);

  // Onda 14.18 — modal de renomear o orcamento. State + handler centralizados
  // aqui pra renderizar o modal no fim do JSX. PATCH /quotes/:id { title }
  // propaga pra todas as abas (mesma source of truth).
  const [renameModalOpen, setRenameModalOpen] = useState(false);
  const [renameDraft, setRenameDraft] = useState('');
  const [renaming, setRenaming] = useState(false);

  const openRenameModal = () => {
    setRenameDraft(quote.title || '');
    setRenameModalOpen(true);
  };
  const submitRename = async () => {
    const newTitle = renameDraft.trim();
    if (newTitle === (quote.title || '')) {
      setRenameModalOpen(false);
      return;
    }
    setRenaming(true);
    try {
      await api.patch(`/quotes/${quote.id}`, { title: newTitle || null });
      showSuccess('Orcamento renomeado');
      setRenameModalOpen(false);
      await onReload();
    } catch (e: any) {
      showError(e?.response?.data?.message || 'Falha ao renomear');
    } finally {
      setRenaming(false);
    }
  };

  // Cupom (Onda 2)
  const [couponCode, setCouponCode] = useState('');
  const [applyingCoupon, setApplyingCoupon] = useState(false);

  // Onda 3.2 — lista de dentistas pra dropdown nos items (carregado lazy)
  const [dentists, setDentists] = useState<DentistOption[]>([]);
  // Onda 3.4 — id do item em edicao inline (null = ninguem editando)
  const [editingItemId, setEditingItemId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState<{
    tooth_fdi: string;
    quantity: string;
    unit_price: string;
    dentist_id: string;
    // Onda 4.2 — pagamento por procedimento
    payment_method: string;
    installments_count: string;
  }>({ tooth_fdi: '', quantity: '1', unit_price: '0', dentist_id: '', payment_method: '', installments_count: '' });
  const [savingEdit, setSavingEdit] = useState(false);

  // Onda 4.1 — selecao de items pra aprovacao parcial (so visivel em SENT)
  // Onda 7.9 — Default: TODOS os items pendentes ja vem pre-selecionados.
  // Operador desmarca o que NAO vai aprovar (em vez de marcar o que vai).
  // Onda 7.10 — MEMORIA da selecao via sessionStorage keyed por quote.id.
  // Operador desmarca, sai pra lista, volta -> selecao preservada (nao volta
  // todo selecionado de novo). sessionStorage limpa ao fechar a aba.
  const storageKey = `quote-partial-selection-${quote.id}`;

  const computeDefaultSelection = (items: typeof quote.items): Set<string> => {
    return new Set(items.filter((it) => !it.approved_at).map((it) => it.id));
  };

  const [partialSelection, setPartialSelection] = useState<Set<string>>(() => {
    // Tenta restaurar do sessionStorage primeiro
    if (typeof window !== 'undefined') {
      try {
        const stored = window.sessionStorage.getItem(storageKey);
        if (stored) {
          const ids: string[] = JSON.parse(stored);
          const validIds = new Set(quote.items.map((it) => it.id));
          // Filtra ids que ainda existem (items podem ter sido removidos)
          // e que nao sao aprovados (approved_at == null)
          const filtered = ids.filter((id) => {
            const item = quote.items.find((it) => it.id === id);
            return !!item && !item.approved_at;
          });
          return new Set(filtered);
        }
      } catch {
        /* ignora — cai no default */
      }
    }
    // Sem storage: pre-seleciona todos pendentes
    return computeDefaultSelection(quote.items);
  });
  const [acceptingPartial, setAcceptingPartial] = useState(false);

  // Onda 7.10 — Persiste a selecao no sessionStorage sempre que mudar.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      window.sessionStorage.setItem(
        storageKey,
        JSON.stringify(Array.from(partialSelection)),
      );
    } catch {
      /* sessionStorage pode estar cheio ou bloqueado — silencia */
    }
  }, [partialSelection, storageKey]);

  // Re-sincroniza quando o quote muda (carrega outro detail). Restaura do
  // sessionStorage se houver, senao volta pro default (todos pendentes).
  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      const stored = window.sessionStorage.getItem(storageKey);
      if (stored) {
        const ids: string[] = JSON.parse(stored);
        const filtered = ids.filter((id) => {
          const item = quote.items.find((it) => it.id === id);
          return !!item && !item.approved_at;
        });
        setPartialSelection(new Set(filtered));
        return;
      }
    } catch {
      /* fallback */
    }
    setPartialSelection(computeDefaultSelection(quote.items));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [quote.id]);

  const isDraft = quote.status === 'DRAFT';
  const isSent = quote.status === 'SENT';
  // Onda 3.8 — aprovacao parcial agora permitida em DRAFT tambem (operador
  // confirma na recepcao sem passar pelo portal). Os items NAO selecionados
  // ficam preservados no orcamento original pra venda futura — nao sao mais
  // perdidos com REJECTED como antes.
  const canPartialAccept = (isDraft || isSent) && quote.items.length > 1;

  // Onda 4.1 — handlers da selecao parcial
  const togglePartialItem = (itemId: string) => {
    setPartialSelection((prev) => {
      const next = new Set(prev);
      if (next.has(itemId)) next.delete(itemId);
      else next.add(itemId);
      return next;
    });
  };

  const partialTotal = quote.items
    .filter((it) => partialSelection.has(it.id))
    .reduce((acc, it) => acc + Number(it.total_price), 0);

  const acceptPartial = async () => {
    if (partialSelection.size === 0) return;
    const total = partialTotal.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
    // Onda 7.2 — Aprovacao in-place. Items selecionados ficam com approved_at
    // setado, items pendentes ficam visiveis pra aprovacao futura. Sem split
    // em novo orcamento, sem mexer em cash flow/installments.
    const msg = `Aprovar ${partialSelection.size} procedimento(s) (${total})?\n\n` +
      `Os procedimentos selecionados ficarão marcados como APROVADOS neste mesmo orçamento.\n` +
      `Os demais continuam pendentes e podem ser aprovados depois (paciente volta proxima consulta).`;
    if (!confirm(msg)) return;
    setAcceptingPartial(true);
    try {
      await api.post(`/quotes/${quote.id}/approve-items`, {
        item_ids: Array.from(partialSelection),
      });
      showSuccess(`${partialSelection.size} item(ns) aprovado(s) neste orçamento`);
      setPartialSelection(new Set());
      await onReload();
    } catch (err: any) {
      showError(err?.response?.data?.message || 'Erro ao aprovar items');
    } finally {
      setAcceptingPartial(false);
    }
  };

  // Onda 3.2 — carrega dentistas quando entra no detalhe (1x por sessao do detail)
  useEffect(() => {
    // Onda 17.54 — /users/lawyers (não /users, que é ADMIN-only → 403 pra não-admin).
    // Acessível a qualquer logado, tenant-scoped, já filtra dentistas (+admin c/ especialidade).
    api.get<any>('/users/lawyers')
      .then((r) => {
        const data: any[] = Array.isArray(r.data) ? r.data : (r.data?.data || r.data?.users || []);
        const list = data.map((u: any) => ({ id: u.id, name: u.name }));
        setDentists(list);
      })
      .catch(() => { /* silente — dropdown vai aparecer vazio */ });
  }, []);

  const applyCoupon = async () => {
    if (!couponCode.trim()) return;
    setApplyingCoupon(true);
    try {
      await api.post(`/quotes/${quote.id}/apply-coupon`, { code: couponCode.trim() });
      showSuccess(`Cupom ${couponCode.trim().toUpperCase()} aplicado`);
      setCouponCode('');
      await onReload();
    } catch (err: any) {
      showError(err?.response?.data?.message || 'Cupom invalido');
    } finally {
      setApplyingCoupon(false);
    }
  };

  const removeCoupon = async () => {
    if (!confirm('Remover cupom aplicado? O desconto será zerado.')) return;
    try {
      await api.delete(`/quotes/${quote.id}/coupon`);
      showSuccess('Cupom removido');
      await onReload();
    } catch (err: any) {
      showError(err?.response?.data?.message || 'Erro ao remover');
    }
  };

  /** Baixa PDF do orcamento — abre em nova aba pra preview/print */
  const downloadPdf = () => {
    const token = typeof window !== 'undefined' ? localStorage.getItem('token') : null;
    if (!token) {
      showError('Sessao expirada — faca login novamente');
      return;
    }
    // Endpoint requer Authorization header — fetch + blob + open
    fetch(`${(api.defaults.baseURL || '')}/quotes/${quote.id}/pdf`, {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then((r) => {
        if (!r.ok) throw new Error('Erro ao gerar PDF');
        return r.blob();
      })
      .then((blob) => {
        const url = URL.createObjectURL(blob);
        window.open(url, '_blank');
        // Libera URL apos 1 minuto (deu tempo do navegador renderizar)
        setTimeout(() => URL.revokeObjectURL(url), 60_000);
      })
      .catch((err) => showError(err?.message || 'Erro ao baixar PDF'));
  };

  const removeItem = async (id: string) => {
    if (!confirm('Remover este item?')) return;
    try {
      await api.delete(`/quote-items/${id}`);
      showSuccess('Item removido');
      await onReload();
    } catch (err: any) {
      showError(err?.response?.data?.message || 'Erro ao remover');
    }
  };

  // Onda 3.4 — handlers de edicao inline dos items
  const startEditItem = (item: QuoteItem) => {
    setEditingItemId(item.id);
    setEditDraft({
      tooth_fdi: item.tooth_fdi || '',
      quantity: String(item.quantity),
      unit_price: String(item.unit_price),
      dentist_id: item.dentist_id || '',
      // Onda 4.2 — payment_method/installments_count opcional
      payment_method: item.payment_method || '',
      installments_count: item.installments_count ? String(item.installments_count) : '',
    });
  };

  const cancelEditItem = () => {
    setEditingItemId(null);
  };

  const saveEditItem = async (itemId: string) => {
    setSavingEdit(true);
    try {
      const qty = parseInt(editDraft.quantity, 10);
      const price = parseFloat(editDraft.unit_price);
      if (isNaN(qty) || qty < 1) {
        showError('Quantidade deve ser >= 1');
        return;
      }
      if (isNaN(price) || price < 0) {
        showError('Preço unitário inválido');
        return;
      }
      await api.patch(`/quote-items/${itemId}`, {
        tooth_fdi: editDraft.tooth_fdi || undefined,
        quantity: qty,
        unit_price: price,
        // String vazia significa "limpar dentista" — backend converte pra null
        dentist_id: editDraft.dentist_id || '',
        // Onda 4.2 — pagamento por procedimento (string vazia limpa)
        payment_method: editDraft.payment_method || '',
        installments_count: editDraft.payment_method === 'INSTALLMENTS'
          ? (editDraft.installments_count ? parseInt(editDraft.installments_count, 10) : null)
          : null,
      });
      showSuccess('Item atualizado');
      setEditingItemId(null);
      await onReload();
    } catch (err: any) {
      showError(err?.response?.data?.message || 'Erro ao salvar');
    } finally {
      setSavingEdit(false);
    }
  };

  const sendQuote = async () => {
    if (!confirm('Enviar orçamento ao paciente? Após envio não será possível editar os itens.')) return;
    try {
      await api.post(`/quotes/${quote.id}/send`);
      showSuccess('Orçamento enviado');
      await onReload();
    } catch (err: any) {
      showError(err?.response?.data?.message || 'Erro ao enviar');
    }
  };

  /** Envia via WhatsApp com link mágico do portal — Fase 24 Onda 1 */
  const sendByWhatsapp = async () => {
    const isResend = quote.status === 'SENT';
    const msg = isResend
      ? 'Reenviar orçamento ao paciente via WhatsApp?'
      : 'Enviar orçamento ao paciente via WhatsApp?\n\nIsso vai gerar um link do portal e enviar uma mensagem com o resumo do orçamento. Após envio, não será possível editar os itens.';
    if (!confirm(msg)) return;
    try {
      const { data } = await api.post(`/quotes/${quote.id}/send-whatsapp`);
      showSuccess(`Orçamento enviado pra ${data.sent_to}`);
      await onReload();
    } catch (err: any) {
      showError(err?.response?.data?.message || 'Erro ao enviar via WhatsApp');
    }
  };

  const accept = async () => {
    if (!confirm('Marcar como aceito e criar plano de tratamento?')) return;
    try {
      await api.post(`/quotes/${quote.id}/accept`);
      showSuccess('Aceito — plano de tratamento criado');
      await onReload();
    } catch (err: any) {
      showError(err?.response?.data?.message || 'Erro ao aceitar');
    }
  };

  const reject = async () => {
    const reason = prompt('Motivo da rejeição (opcional):');
    if (reason === null) return; // cancelou
    try {
      await api.post(`/quotes/${quote.id}/reject`, { rejection_reason: reason || undefined });
      showSuccess('Rejeitado');
      await onReload();
    } catch (err: any) {
      showError(err?.response?.data?.message || 'Erro ao rejeitar');
    }
  };

  /**
   * Onda 3.4 — Duplica como NOVA OPCAO PARALELA. Original NAO eh marcado como
   * REJECTED — fica ativo. Permite apresentar varias opcoes ao paciente
   * (a vista, parcelado, etc.) com os mesmos procedimentos clinicos.
   */
  const duplicateAsOption = async () => {
    if (!confirm(
      'Duplicar como nova opcao?\n\n' +
      'Os mesmos procedimentos serao copiados em um novo orcamento DRAFT.\n' +
      'O orcamento atual NAO sera alterado — voce podera apresentar ambas\n' +
      'as opcoes ao paciente (ex: a vista vs. parcelado).',
    )) return;
    try {
      const { data } = await api.post<{ id: string }>(`/quotes/${quote.id}/duplicate-as-option`);
      showSuccess('Nova opcao criada — abrindo para edicao');
      if (onSwitchQuote) {
        await onSwitchQuote(data.id);
      } else {
        onBack();
      }
    } catch (err: any) {
      showError(err?.response?.data?.message || 'Erro ao duplicar como opcao');
    }
  };

  /** Onda 3b — Renegociar cria duplicata DRAFT + marca atual REJECTED */
  const renegotiate = async () => {
    const note = prompt(
      'Renegociação\n\nIsso vai:\n' +
      '• Marcar este orçamento como REJEITADO (preserva histórico)\n' +
      '• Criar uma nova versão DRAFT com os mesmos procedimentos\n' +
      '• Você edita a nova versão (preço, items, cupom) e envia novamente\n\n' +
      'Motivo da renegociação (opcional):',
      '',
    );
    if (note === null) return;
    try {
      const { data } = await api.post(`/quotes/${quote.id}/renegotiate`, { note: note.trim() || undefined });
      showSuccess('Renegociação iniciada — abrindo nova versão');
      // Volta pra lista pra recarregar e abrir o novo
      onBack();
      // Pequeno delay pra UI atualizar antes de re-abrir o detalhe
      setTimeout(() => {
        // Recarrega a lista ja vai pegar a nova
        // Operador clica no novo DRAFT na lista
      }, 200);
      // Idealmente abriria o novo direto — TODO em refinement
    } catch (err: any) {
      showError(err?.response?.data?.message || 'Erro ao renegociar');
    }
  };

  const remove = async () => {
    if (!confirm('Deletar este rascunho de orçamento?')) return;
    try {
      await api.delete(`/quotes/${quote.id}`);
      showSuccess('Rascunho deletado');
      onBack();
    } catch (err: any) {
      showError(err?.response?.data?.message || 'Erro ao deletar');
    }
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-3">
        <button onClick={onBack} className="text-sm text-muted-foreground hover:text-foreground flex items-center gap-1">
          <ArrowLeft size={14} /> Voltar à lista
        </button>
        <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium border ${STATUS_BADGE[quote.status]}`}>
          {STATUS_LABEL[quote.status]}
        </span>
      </div>

      {/* Onda 14.18 — Header com identificador unificado (#NNN · Nome) +
          botao Renomear. Renderiza o mesmo nome que aparece nas abas
          Avaliacao, Propostas e Financeiro pra operador navegar com
          confianca. Botao Renomear so existe em Avaliacao e Orcamentos. */}
      <div className="mb-4 flex items-center justify-between gap-3 flex-wrap">
        <h2 className="text-lg font-bold flex items-center gap-2">
          {/* Onda 14.19 — badge com bg pro #NNN ficar destacado no header.
              Legados (quote_number=0) caem pro `·` aqui — nao temos idx no
              detail view, e mostrar `#1` artificial seria enganoso fora da
              lista. Backfill SQL resolve apos rodar na VPS. */}
          {getQuoteNumberBadge(quote) ? (
            <span className="text-sm font-mono font-bold text-primary bg-primary/10 border border-primary/20 px-2 py-0.5 rounded">
              {getQuoteNumberBadge(quote)}
            </span>
          ) : (
            <span className="text-sm font-mono text-muted-foreground">·</span>
          )}
          <span>{getQuoteDisplayName(quote)}</span>
        </h2>
        <button
          type="button"
          onClick={openRenameModal}
          className="text-xs px-2.5 py-1 rounded border border-border hover:bg-accent flex items-center gap-1.5"
          title="Renomear orcamento (propaga pra todas as abas)"
        >
          <Pencil size={12} /> Renomear
        </button>
      </div>

      {/* Onda 3b — Banner se este orcamento veio de uma renegociacao */}
      {quote.renegotiated_from && (
        <div className="mb-3 p-2.5 rounded-lg bg-amber-500/10 border border-amber-500/20 text-xs text-amber-700 flex items-center gap-2">
          <Repeat size={12} />
          <span>
            Esta é uma <strong>renegociação</strong> do orçamento de{' '}
            {Number(quote.renegotiated_from.total_value).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })}{' '}
            criado em {new Date(quote.renegotiated_from.created_at).toLocaleDateString('pt-BR')} (status: {quote.renegotiated_from.status}).
          </span>
        </div>
      )}

      {/* Onda 4.1 — Banner se este orcamento foi gerado por aprovacao parcial */}
      {quote.accepted_from && (
        <div className="mb-3 p-2.5 rounded-lg bg-emerald-500/10 border border-emerald-500/20 text-xs text-emerald-700 flex items-center gap-2">
          <Check size={12} />
          <span>
            <strong>Aprovação parcial</strong> do orçamento de{' '}
            {Number(quote.accepted_from.total_value).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })}{' '}
            criado em {new Date(quote.accepted_from.created_at).toLocaleDateString('pt-BR')} (status: {quote.accepted_from.status}).
            {' '}Este orçamento contém apenas os procedimentos selecionados pelo paciente.
          </span>
        </div>
      )}

      {/* Onda 3.8 — Hint pra operadora: aprovacao parcial agora preserva
          os items NAO selecionados no proprio orcamento (nao mais REJECTED
          como antes). Disponivel em DRAFT tambem. */}
      {canPartialAccept && (
        <div className="mb-3 p-2 rounded-lg bg-emerald-500/5 border border-dashed border-emerald-500/30 text-xs text-emerald-700 flex items-center gap-2">
          <Check size={12} />
          <span>
            <strong>Dica:</strong> marque os checkboxes ao lado dos procedimentos pra aceitar SÓ ALGUNS items
            (paciente fechou parte do orçamento). Os <strong>não selecionados ficam aqui</strong> pra venda futura.
            Use "Marcar aceito" se for tudo.
          </span>
        </div>
      )}

      {/* ─── Procedimentos — HERO (movido pro topo: ação mais usada) ─── */}
      <div className="bg-card border border-border rounded-xl overflow-hidden mb-4">
        <div className="px-4 py-3 border-b border-border flex items-center justify-between flex-wrap gap-2">
          <div className="flex items-center gap-2">
            <p className="text-sm font-semibold">Procedimentos</p>
            {quote.items.length > 0 && (
              <span className="text-xs text-muted-foreground">
                ({quote.items.length} {quote.items.length === 1 ? 'item' : 'itens'})
              </span>
            )}
          </div>
          {/* Onda 7.3 — Master checkbox: marca/desmarca todos os items
              PENDENTES (aprovados nao entram). So aparece quando aprovacao
              parcial eh possivel (DRAFT/SENT). Util pra orcamentos grandes
              (10+ items) — operador clica 1x em vez de 10. */}
          {canPartialAccept && (() => {
            const pendingItems = quote.items.filter((it) => !it.approved_at);
            const pendingIds = pendingItems.map((it) => it.id);
            const allPendingSelected = pendingItems.length > 0
              && pendingIds.every((id) => partialSelection.has(id));
            const somePendingSelected = pendingIds.some((id) => partialSelection.has(id));
            const indeterminate = somePendingSelected && !allPendingSelected;
            const toggleAll = () => {
              if (allPendingSelected) {
                // Tem todos os pendentes marcados → desmarca todos
                setPartialSelection(new Set());
              } else {
                // Marca todos os pendentes
                setPartialSelection(new Set(pendingIds));
              }
            };
            if (pendingItems.length === 0) return null;
            return (
              <div className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={allPendingSelected}
                  ref={(el) => { if (el) el.indeterminate = indeterminate; }}
                  onChange={toggleAll}
                  className="w-4 h-4 accent-emerald-600 cursor-pointer"
                  title={allPendingSelected ? 'Desmarcar todos' : 'Marcar todos os pendentes'}
                />
                <button
                  type="button"
                  onClick={toggleAll}
                  className="text-xs font-medium text-emerald-700 hover:underline"
                >
                  {allPendingSelected ? 'Desmarcar todos' : 'Marcar todos'}
                </button>
              </div>
            );
          })()}
        </div>

        {/* Modal de adicionar — Onda 5: nao aparece mais via botao na aba
            Orcamentos. Mas continua sendo aberto automaticamente quando o
            operador navega da aba Avaliacao com autoOpenAddItem=true. */}
        {addingItem && (
          <AddQuoteItemModal
            quoteId={quote.id}
            procedures={procedures}
            initialTitle={quote.title}
            onClose={() => setAddingItem(false)}
            onAdded={onReload}
          />
        )}

        {quote.items.length === 0 ? (
          <div className="py-10 px-6 text-center">
            <DollarSign size={36} className="mx-auto text-muted-foreground/40 mb-3" />
            <p className="text-sm text-muted-foreground">
              Nenhum procedimento neste orçamento.
            </p>
            {isDraft && (
              <p className="text-xs text-muted-foreground mt-2">
                Para adicionar procedimentos, acesse a aba <strong>Avaliação</strong> do paciente —
                o dentista registra lá e os itens sobem automaticamente pra cá.
              </p>
            )}
          </div>
        ) : (
          <ul className="divide-y divide-border">
            {quote.items.map((it) => {
              // Onda 25.2 — pinta borda esquerda + tag pela especialidade
              // (mesma paleta da Tabela de Precos pra leitura visual consistente)
              const spec = it.procedure?.specialty;
              const color = colorForSpecialty(spec?.id || null);
              const isEditing = editingItemId === it.id;

              // Onda 3.4 — modo EDICAO inline (substitui linha read por form compacto)
              if (isEditing) {
                return (
                  <li
                    key={it.id}
                    className="px-4 py-2.5 text-sm border-l-4 bg-primary/5"
                    style={{ borderLeftColor: color.bar }}
                  >
                    <div className="flex items-center gap-2 flex-wrap mb-2">
                      <p className="font-medium">{it.procedure?.name || 'Procedimento'}</p>
                      {spec?.name && (
                        <span
                          className="text-[10px] px-1.5 py-0.5 rounded-full font-medium border"
                          style={{ color: color.bar, borderColor: color.bar + '40', backgroundColor: color.tint }}
                        >
                          {spec.name}
                        </span>
                      )}
                      <span className="text-xs text-muted-foreground ml-auto">Editando…</span>
                    </div>
                    <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-xs">
                      <label className="flex flex-col">
                        <span className="text-muted-foreground mb-0.5">Dente FDI</span>
                        <input
                          value={editDraft.tooth_fdi}
                          onChange={(e) => setEditDraft({ ...editDraft, tooth_fdi: e.target.value })}
                          placeholder="ex: 21"
                          className="px-2 py-1 rounded bg-background border border-border focus:outline-none focus:ring-2 focus:ring-primary/30"
                        />
                      </label>
                      <label className="flex flex-col">
                        <span className="text-muted-foreground mb-0.5">Quantidade</span>
                        <input
                          type="number"
                          min={1}
                          value={editDraft.quantity}
                          onChange={(e) => setEditDraft({ ...editDraft, quantity: e.target.value })}
                          className="px-2 py-1 rounded bg-background border border-border focus:outline-none focus:ring-2 focus:ring-primary/30"
                        />
                      </label>
                      <label className="flex flex-col">
                        <span className="text-muted-foreground mb-0.5">Preço unit. (R$)</span>
                        <input
                          type="number"
                          min={0}
                          step="0.01"
                          value={editDraft.unit_price}
                          onChange={(e) => setEditDraft({ ...editDraft, unit_price: e.target.value })}
                          className="px-2 py-1 rounded bg-background border border-border focus:outline-none focus:ring-2 focus:ring-primary/30"
                        />
                      </label>
                      <label className="flex flex-col">
                        <span className="text-muted-foreground mb-0.5 flex items-center gap-1">
                          <UserIcon size={10} /> Cir. Dentista
                        </span>
                        <select
                          value={editDraft.dentist_id}
                          onChange={(e) => setEditDraft({ ...editDraft, dentist_id: e.target.value })}
                          className="px-2 py-1 rounded bg-background border border-border focus:outline-none focus:ring-2 focus:ring-primary/30"
                        >
                          <option value="">— sem dentista —</option>
                          {dentists.map((d) => (
                            <option key={d.id} value={d.id}>{d.name}</option>
                          ))}
                        </select>
                      </label>
                    </div>

                    {/* Onda 4.2 — pagamento por procedimento (linha extra no form de edicao) */}
                    <div className="grid grid-cols-2 gap-2 text-xs mt-2">
                      <label className="flex flex-col">
                        <span className="text-muted-foreground mb-0.5 flex items-center gap-1">
                          <CreditCard size={10} /> Pagamento (opcional)
                        </span>
                        <select
                          value={editDraft.payment_method}
                          onChange={(e) => setEditDraft({ ...editDraft, payment_method: e.target.value })}
                          className="px-2 py-1 rounded bg-background border border-border focus:outline-none focus:ring-2 focus:ring-primary/30"
                          title="Sobrescreve o pagamento default do orçamento APENAS pra este item"
                        >
                          <option value="">— usar default do orçamento —</option>
                          {Object.entries(PAYMENT_METHOD_LABEL).map(([k, label]) => (
                            <option key={k} value={k}>{label}</option>
                          ))}
                        </select>
                      </label>
                      {editDraft.payment_method === 'INSTALLMENTS' && (
                        <label className="flex flex-col">
                          <span className="text-muted-foreground mb-0.5">Parcelas (1-24)</span>
                          <input
                            type="number"
                            min={1}
                            max={24}
                            value={editDraft.installments_count}
                            onChange={(e) => setEditDraft({ ...editDraft, installments_count: e.target.value })}
                            placeholder="ex: 12"
                            className="px-2 py-1 rounded bg-background border border-border focus:outline-none focus:ring-2 focus:ring-primary/30"
                          />
                        </label>
                      )}
                    </div>
                    <div className="flex items-center justify-end gap-2 mt-2">
                      <button
                        onClick={cancelEditItem}
                        disabled={savingEdit}
                        className="text-xs px-3 py-1 rounded border border-border hover:bg-accent text-muted-foreground"
                      >
                        Cancelar
                      </button>
                      <button
                        onClick={() => saveEditItem(it.id)}
                        disabled={savingEdit}
                        className="text-xs inline-flex items-center gap-1 px-3 py-1 rounded bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50 font-medium"
                      >
                        {savingEdit ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />}
                        Salvar
                      </button>
                    </div>
                  </li>
                );
              }

              // Modo READ normal
              const isPartialSelected = partialSelection.has(it.id);
              // Onda 7.2 — Items com approved_at ficam INATIVOS visualmente
              // (✓ verde + opaco + sem checkbox). Operador nao pode desmarcar.
              const isApproved = !!it.approved_at;
              const approvedDate = it.approved_at
                ? new Date(it.approved_at).toLocaleDateString('pt-BR')
                : null;
              // Onda 7.5 — Fundo do item segue o estado:
              // - Aprovado (in-place): mantem cor da especialidade + opacity
              // - Selecionado (pendente marcado): fundo verde claro
              // - Pendente nao selecionado: fundo vermelho claro
              // Sobrescreve o tint da especialidade pra dar sinalizacao visual
              // forte do "fechou / vai fechar / nao decidiu".
              let bgColor = color.tint; // default = cor da especialidade
              if (!isApproved) {
                if (isPartialSelected) {
                  bgColor = 'rgba(16,185,129,0.10)'; // emerald-500/10
                } else {
                  bgColor = 'rgba(239,68,68,0.06)'; // red-500/6 (sutil)
                }
              }
              return (
                <li
                  key={it.id}
                  className={`px-4 py-2.5 flex items-center gap-3 text-sm border-l-4 transition-colors ${
                    isApproved
                      ? 'opacity-60'
                      : isPartialSelected
                      ? 'ring-1 ring-emerald-500 ring-inset'
                      : 'ring-1 ring-red-500/30 ring-inset'
                  }`}
                  style={{ borderLeftColor: color.bar, backgroundColor: bgColor }}
                >
                  {/* Onda 7.2 — Checkbox so em items pendentes; aprovados
                      mostram ✓ verde indicando que ja foram fechados. */}
                  {isApproved ? (
                    <div
                      className="w-4 h-4 rounded-full bg-emerald-500 flex items-center justify-center shrink-0"
                      title={`Aprovado em ${approvedDate}`}
                    >
                      <Check size={10} className="text-white" />
                    </div>
                  ) : canPartialAccept ? (
                    <input
                      type="checkbox"
                      checked={isPartialSelected}
                      onChange={() => togglePartialItem(it.id)}
                      className="w-4 h-4 accent-emerald-600 cursor-pointer shrink-0"
                      title="Selecionar pra aprovar"
                    />
                  ) : null}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <p className={`font-medium ${isApproved ? 'line-through decoration-emerald-600/60' : ''}`}>
                        {it.procedure?.name || 'Procedimento'}
                      </p>
                      {isApproved && (
                        <span className="text-[10px] px-1.5 py-0.5 rounded-full font-semibold bg-emerald-500/15 text-emerald-700 border border-emerald-500/30">
                          ✓ Aprovado em {approvedDate}
                        </span>
                      )}
                      {spec?.name && (
                        <span
                          className="text-[10px] px-1.5 py-0.5 rounded-full font-medium border"
                          style={{
                            color: color.bar,
                            borderColor: color.bar + '40',
                            backgroundColor: color.tint,
                          }}
                        >
                          {spec.name}
                        </span>
                      )}
                      {/* Onda 3.2 — pílula com nome do dentista responsavel */}
                      {it.dentist?.name && (
                        <span className="text-[10px] px-1.5 py-0.5 rounded-full font-medium bg-muted text-muted-foreground inline-flex items-center gap-1">
                          <UserIcon size={9} /> {it.dentist.name}
                        </span>
                      )}
                      {/* Onda 4.2 — pílula com pagamento por procedimento (so se diferente do default) */}
                      {it.payment_method && (
                        <span className="text-[10px] px-1.5 py-0.5 rounded-full font-medium bg-emerald-500/10 text-emerald-700 border border-emerald-500/20">
                          {PAYMENT_METHOD_LABEL[it.payment_method] || it.payment_method}
                          {it.payment_method === 'INSTALLMENTS' && it.installments_count
                            ? ` ${it.installments_count}x`
                            : ''}
                        </span>
                      )}
                    </div>
                    <p className="text-xs text-muted-foreground">
                      {it.tooth_fdi && `Dente ${it.tooth_fdi} · `}
                      {it.quantity}x R$ {Number(it.unit_price).toFixed(2)}
                    </p>
                  </div>
                  <div className="text-right">
                    <p className="font-semibold">R$ {Number(it.total_price).toFixed(2)}</p>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {/* Resumo — Onda 7.9: layout simplificado em 2 colunas.
          ESQUERDA (vermelho): Pendentes — soma dos items pendentes que o
            operador NAO marcou (real time conforme desmarca).
          DIREITA (verde): Aprovados — soma dos items que vao ser aprovados
            (ja aprovados in-place + selecionados agora) + tempo de cadeira. */}
      <div className="bg-card border border-border rounded-xl p-4 mb-4">
        {(() => {
          // Items pendentes NAO selecionados (vao ficar de fora dessa aprovacao)
          const pendentesNaoSelec = quote.items.filter(
            (it) => !it.approved_at && !partialSelection.has(it.id),
          );
          const pendentesTotal = pendentesNaoSelec.reduce(
            (acc, it) => acc + Number(it.total_price),
            0,
          );
          // Aprovados = ja aprovados in-place + selecionados agora
          const jaAprovados = quote.items.filter((it) => !!it.approved_at);
          const selecionadosNovos = quote.items.filter(
            (it) => !it.approved_at && partialSelection.has(it.id),
          );
          const aprovadosCount = jaAprovados.length + selecionadosNovos.length;
          const aprovadosTotal =
            jaAprovados.reduce((acc, it) => acc + Number(it.total_price), 0)
            + selecionadosNovos.reduce((acc, it) => acc + Number(it.total_price), 0);
          // Tempo de cadeira dos APROVADOS (ja + serao) — operador planeja
          // quanto vai ocupar de agenda apos essa aprovacao.
          const totalMinutes = [...jaAprovados, ...selecionadosNovos].reduce(
            (acc, it) => acc + (it.procedure?.duration_minutes || 0) * it.quantity,
            0,
          );
          let tempoLabel = '';
          if (totalMinutes > 0) {
            const h = Math.floor(totalMinutes / 60);
            const m = totalMinutes % 60;
            tempoLabel = h > 0
              ? (m > 0 ? `~${h}h${String(m).padStart(2, '0')}min` : `~${h}h`)
              : `~${m}min`;
          }
          return (
            <div className="flex items-center justify-between gap-4 text-sm flex-wrap">
              {/* ESQUERDA — pendentes em vermelho */}
              <div className="flex items-baseline gap-2">
                <p className="text-xl font-bold text-red-600">
                  R$ {pendentesTotal.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                </p>
                <p className="text-xs text-red-700">Pendentes ({pendentesNaoSelec.length})</p>
              </div>
              {/* DIREITA — aprovados (ja + serao) com tempo de cadeira */}
              <div className="text-right">
                <p className="text-xs text-emerald-700 inline-flex items-center gap-1 justify-end">
                  <Check size={10} /> Aprovados ({aprovadosCount})
                </p>
                <p className="text-xs text-muted-foreground">Total</p>
                <p className="text-xl font-bold text-emerald-700">
                  R$ {aprovadosTotal.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                </p>
                {tempoLabel && (
                  <p className="text-[11px] text-muted-foreground mt-0.5" title="Tempo estimado total de cadeira dos procedimentos aprovados">
                    ⏱ {tempoLabel} de cadeira
                  </p>
                )}
              </div>
            </div>
          );
        })()}

        {/* Onda 5 — Acoes da selecao parcial integradas ao resumo.
            Onda 7.2 — Removi `< quote.items.length`: aprovacao in-place
            (sem split) pode aprovar TODOS pendentes de uma vez. */}
        {canPartialAccept && partialSelection.size > 0 && (
          <div className="mt-4 pt-3 border-t border-emerald-200 dark:border-emerald-900/40 flex items-center justify-end gap-2 flex-wrap">
            <button
              onClick={() => setPartialSelection(new Set())}
              className="text-xs px-3 py-1.5 rounded-lg text-muted-foreground hover:bg-muted border border-border"
              title="Limpar seleção"
            >
              <X size={12} className="inline mr-1" />
              Limpar seleção
            </button>
            <button
              onClick={acceptPartial}
              disabled={acceptingPartial}
              className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-emerald-600 text-white text-sm font-semibold hover:bg-emerald-700 disabled:opacity-50"
            >
              {acceptingPartial ? (
                <Loader2 size={14} className="animate-spin" />
              ) : (
                <Check size={14} />
              )}
              Aprovar selecionados ({partialSelection.size})
            </button>
          </div>
        )}

        {quote.rejection_reason && (
          <div className="mt-3 pt-3 border-t border-border">
            <p className="text-xs text-muted-foreground">Motivo da rejeição</p>
            <p className="text-sm text-destructive">{quote.rejection_reason}</p>
          </div>
        )}

        {/* Onda 2 — Cupom aplicado */}
        {quote.coupon && (
          <div className="mt-3 pt-3 border-t border-border flex items-center gap-2">
            <Tag size={14} className="text-emerald-600" />
            <div className="flex-1 text-sm">
              <span className="font-mono font-semibold">{quote.coupon.code}</span>
              {quote.coupon.description && (
                <span className="text-muted-foreground ml-2">— {quote.coupon.description}</span>
              )}
            </div>
            {isDraft && (
              <button
                onClick={removeCoupon}
                className="text-xs text-muted-foreground hover:text-destructive"
                title="Remover cupom"
              >
                <X size={14} />
              </button>
            )}
          </div>
        )}

        {/* Onda 2 — Aplicar cupom (so DRAFT, sem cupom) */}
        {isDraft && !quote.coupon && Number(quote.subtotal) > 0 && (
          <div className="mt-3 pt-3 border-t border-border">
            <div className="flex items-center gap-2">
              <Tag size={14} className="text-muted-foreground" />
              <input
                type="text"
                value={couponCode}
                onChange={(e) => setCouponCode(e.target.value.toUpperCase())}
                placeholder="Cupom de desconto (opcional)"
                className="flex-1 px-2 py-1 rounded bg-background border border-border text-sm focus:outline-none focus:ring-2 focus:ring-primary/30 font-mono"
                onKeyDown={(e) => e.key === 'Enter' && applyCoupon()}
              />
              <button
                onClick={applyCoupon}
                disabled={applyingCoupon || !couponCode.trim()}
                className="text-xs px-3 py-1 rounded bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
              >
                {applyingCoupon ? <Loader2 size={12} className="animate-spin" /> : 'Aplicar'}
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Onda 4.3 — Card de metricas de envelope/engajamento (so apos envio) */}
      {(quote.sent_at || (quote.portal_view_count || 0) > 0) && (
        <EngagementMetricsCard quote={quote} />
      )}

      {/* Onda 12.9 — Bloco "Sugestoes de pagamento" removido da aba Orcamentos.
          As opcoes de pagamento agora ficam centralizadas na aba Propostas
          (PIX/Cartao/Financiamento Banco PASSOS). */}

      {/* Ações */}
      <div className="flex flex-wrap gap-2 mb-4">
        {isDraft && (
          <>
            {/* Onda 1 (Fase 24): WhatsApp eh o canal principal — cor verde de destaque */}
            <button
              onClick={sendByWhatsapp}
              className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg bg-emerald-600 text-white text-sm hover:bg-emerald-700 font-medium"
              title="Envia link mágico do portal via WhatsApp com resumo do orçamento"
            >
              <MessageCircle size={14} /> Enviar via WhatsApp
            </button>
            <button
              onClick={sendQuote}
              className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg border border-border text-muted-foreground text-sm hover:bg-accent"
              title="Marca como enviado sem disparar mensagem"
            >
              <Send size={14} /> Marcar enviado
            </button>
            <button onClick={remove} className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg border border-destructive/30 text-destructive text-sm hover:bg-destructive/10">
              <Trash2 size={14} /> Deletar rascunho
            </button>
          </>
        )}
        {isSent && (
          <>
            <button
              onClick={sendByWhatsapp}
              className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg border border-emerald-500/40 text-emerald-700 text-sm hover:bg-emerald-50"
              title="Reenviar mensagem com link"
            >
              <MessageCircle size={14} /> Reenviar WhatsApp
            </button>
            <button onClick={accept} className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg bg-emerald-500 text-white text-sm hover:bg-emerald-600">
              <Check size={14} /> Marcar aceito
            </button>
            <button onClick={reject} className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg border border-destructive/30 text-destructive text-sm hover:bg-destructive/10">
              <X size={14} /> Rejeitar
            </button>
          </>
        )}
        {/* Onda 3.4 — Duplicar como nova opcao paralela.
            Disponivel em qualquer status nao-deletado — permite "ressuscitar"
            um plano antigo (REJECTED/EXPIRED) como nova opcao tambem. */}
        <button
          onClick={duplicateAsOption}
          className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg border border-blue-500/40 text-blue-700 text-sm hover:bg-blue-50"
          title="Cria nova opcao DRAFT com os mesmos procedimentos (original permanece ativo)"
        >
          <Plus size={14} /> Nova opção
        </button>
        {/* Onda 3b — Renegociar: disponivel em SENT/REJECTED/EXPIRED */}
        {(isSent || quote.status === 'REJECTED' || quote.status === 'EXPIRED') && (
          <button
            onClick={renegotiate}
            className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg border border-amber-500/40 text-amber-700 text-sm hover:bg-amber-50"
            title="Cria nova versão DRAFT pra renegociar (mantém histórico)"
          >
            <Repeat size={14} /> Renegociar
          </button>
        )}
        {/* PDF — disponivel em qualquer status (Onda 2 — Fase 24) */}
        <button
          onClick={downloadPdf}
          className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg border border-border text-muted-foreground text-sm hover:bg-accent ml-auto"
          title="Abrir PDF do orçamento em nova aba"
        >
          <Download size={14} /> Baixar PDF
        </button>
      </div>

      {/* Onda 3b — Histórico de versões (auto-esconde se nao tem) */}
      <QuoteVersions quoteId={quote.id} />

      {/* Onda 3 — Anexos (fotos antes/depois, exames, TCLE, etc) — movido pro fim por ser secundário */}
      <QuoteAttachments quoteId={quote.id} quoteStatus={quote.status} />

      {/* Onda 14.18 — Modal de renomear. Fica no fim do JSX pra evitar
          conflito de z-index e nao re-renderizar a tela toda quando abre.
          Fix: clicar fora do modal SALVA (em vez de cancelar) — comportamento
          mais natural pra acao reversivel como rename. Cancelar so via botao
          ou Esc. */}
      {renameModalOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
          onClick={() => !renaming && submitRename()}
        >
          <div
            className="bg-card border border-border rounded-xl shadow-xl w-full max-w-md p-5"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="text-base font-bold mb-1">Renomear orcamento</h3>
            <p className="text-xs text-muted-foreground mb-3">
              Este nome aparece em todas as abas (Avaliacao, Orcamentos,
              Propostas, Financeiro). Identificador {getQuoteNumberBadge(quote) || 's/ numero'}.
              {' '}<span className="text-foreground/80">Enter ou clicar fora salva.</span>
            </p>
            <input
              type="text"
              autoFocus
              value={renameDraft}
              onChange={(e) => setRenameDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  submitRename();
                }
                if (e.key === 'Escape' && !renaming) {
                  e.preventDefault();
                  setRenameModalOpen(false);
                }
              }}
              placeholder="Ex: Aparelho ortodontico superior"
              disabled={renaming}
              className="w-full text-sm px-3 py-2 rounded border border-border bg-background focus:outline-none focus:border-primary"
            />
            <div className="flex items-center justify-end gap-2 mt-4">
              <button
                type="button"
                onClick={() => setRenameModalOpen(false)}
                disabled={renaming}
                className="text-xs px-3 py-1.5 rounded border border-border hover:bg-accent disabled:opacity-50"
              >
                Cancelar
              </button>
              <button
                type="button"
                onClick={submitRename}
                disabled={renaming}
                className="text-xs px-3 py-1.5 rounded bg-primary text-primary-foreground hover:opacity-90 disabled:opacity-50 inline-flex items-center gap-1"
              >
                {renaming && <Loader2 size={12} className="animate-spin" />}
                Salvar
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Onda 2 (Fase 24) — Card de sugestoes de pagamento ───────────
//
// Calcula opcoes comuns de pagamento na hora a partir do total. Por enquanto
// regras hardcoded; futuro: configuravel via tenant settings.
//  - À vista: 5% de desconto
//  - 3x sem juros
//  - 6x sem juros
//  - 12x +1.5%/mês (juros simples — calcula custo total)
//
// Mostrado em SENT/ACCEPTED — momento certo do paciente decidir como pagar.

// ─── Onda 4.3 (Fase 25) — Card de metricas de envelope/engajamento ──────────
//
// Mostra pra operadora os sinais de interesse do paciente apos o envio:
//   - Quando enviou (sent_at)
//   - Se leu o WhatsApp (whatsapp_read_at — TODO popular via webhook 4.3b)
//   - Quantas vezes abriu o portal (portal_view_count)
//   - Ultimo acesso (portal_last_viewed_at)
//
// Usa formato relativo amigavel ("ha 3h", "hoje 14:32", "ontem") pra
// recepcao bater olho e decidir momento de fazer follow-up.
function EngagementMetricsCard({ quote }: { quote: QuoteDetail }) {
  const fmtRelative = (iso: string | null | undefined): string => {
    if (!iso) return '—';
    const d = new Date(iso);
    const diffMs = Date.now() - d.getTime();
    const diffMin = Math.floor(diffMs / 60_000);
    if (diffMin < 1) return 'agora';
    if (diffMin < 60) return `há ${diffMin}min`;
    const diffH = Math.floor(diffMin / 60);
    if (diffH < 24) return `há ${diffH}h`;
    const diffD = Math.floor(diffH / 24);
    if (diffD === 1) return 'ontem';
    if (diffD < 7) return `há ${diffD}d`;
    return d.toLocaleDateString('pt-BR');
  };

  const fmtAbsolute = (iso: string | null | undefined): string => {
    if (!iso) return '—';
    return new Date(iso).toLocaleString('pt-BR', {
      day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
    });
  };

  const viewCount = quote.portal_view_count || 0;
  const noEngagementYet = quote.sent_at && !quote.whatsapp_read_at && viewCount === 0;
  const daysSinceSent = quote.sent_at
    ? Math.floor((Date.now() - new Date(quote.sent_at).getTime()) / (1000 * 60 * 60 * 24))
    : 0;

  return (
    <div className="bg-card border border-border rounded-xl p-4 mb-4">
      <h3 className="text-sm font-semibold mb-3 flex items-center gap-2">
        <MessageCircle size={14} className="text-primary" />
        Engajamento
        {noEngagementYet && daysSinceSent >= 2 && (
          <span className="text-[10px] px-1.5 py-0.5 rounded-full font-bold bg-amber-500/10 text-amber-700 border border-amber-500/20">
            ⏰ {daysSinceSent}d sem resposta
          </span>
        )}
      </h3>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-xs">
        <div>
          <p className="text-muted-foreground flex items-center gap-1">
            <Send size={10} /> Enviado
          </p>
          <p className="font-semibold mt-0.5" title={fmtAbsolute(quote.sent_at)}>
            {quote.sent_at ? fmtRelative(quote.sent_at) : 'não enviado'}
          </p>
        </div>
        <div>
          <p className="text-muted-foreground flex items-center gap-1">
            <Check size={10} /> Lido no WhatsApp
          </p>
          <p className={`font-semibold mt-0.5 ${quote.whatsapp_read_at ? 'text-emerald-600' : 'text-muted-foreground'}`} title={fmtAbsolute(quote.whatsapp_read_at)}>
            {quote.whatsapp_read_at ? fmtRelative(quote.whatsapp_read_at) : '—'}
          </p>
        </div>
        <div>
          <p className="text-muted-foreground flex items-center gap-1">
            <DollarSign size={10} /> Aberturas portal
          </p>
          <p className={`font-semibold mt-0.5 ${viewCount > 0 ? 'text-emerald-600' : 'text-muted-foreground'}`}>
            {viewCount === 0 ? 'nenhuma' : viewCount === 1 ? '1 vez' : `${viewCount} vezes`}
          </p>
        </div>
        <div>
          <p className="text-muted-foreground flex items-center gap-1">
            <Calendar size={10} /> Último acesso
          </p>
          <p className="font-semibold mt-0.5" title={fmtAbsolute(quote.portal_last_viewed_at)}>
            {quote.portal_last_viewed_at ? fmtRelative(quote.portal_last_viewed_at) : '—'}
          </p>
        </div>
      </div>
      {viewCount >= 3 && (
        <p className="text-[11px] text-emerald-600 mt-2 italic">
          🔥 Cliente abriu {viewCount} vezes — alto interesse, considere fazer follow-up agora.
        </p>
      )}
    </div>
  );
}

function PaymentSuggestionsCard({ total }: { total: number }) {
  const formatBRL = (v: number) =>
    v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

  // Onda 7.11 — 3 opcoes finais: 1x com 10% off, 12x e 24x.
  const cashDiscount = 0.10; // 10% de desconto à vista
  const cashTotal = total * (1 - cashDiscount);

  // Juros simples mensal (modelo conservador). Mesma taxa pra 12x e 24x.
  const interestRate = 0.015; // 1.5% ao mes
  const totalWith12x = total * (1 + interestRate * 12);
  const totalWith24x = total * (1 + interestRate * 24);

  const options = [
    {
      label: 'À vista (PIX/dinheiro)',
      sub: `10% de desconto · economia de ${formatBRL(total - cashTotal)}`,
      value: cashTotal,
      installments: '1x',
      highlighted: true,
      badge: '💸 Mais econômico',
    },
    {
      label: 'Cartão de crédito',
      sub: `Com juros (1,5%/mês) · total ${formatBRL(totalWith12x)}`,
      value: totalWith12x / 12,
      installments: '12x',
    },
    {
      label: 'Cartão de crédito',
      sub: `Com juros (1,5%/mês) · total ${formatBRL(totalWith24x)}`,
      value: totalWith24x / 24,
      installments: '24x',
    },
  ];

  return (
    <div className="bg-card border border-border rounded-xl p-4 mb-4">
      <h3 className="text-sm font-semibold mb-3 flex items-center gap-2">
        <CreditCard size={14} className="text-primary" />
        Sugestões de pagamento
      </h3>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
        {options.map((opt, idx) => (
          <div
            key={idx}
            className={`p-3 rounded-lg border ${
              opt.highlighted
                ? 'bg-emerald-500/5 border-emerald-500/30'
                : 'border-border'
            }`}
          >
            <div className="flex items-baseline gap-2 flex-wrap">
              <span className={`text-2xl font-bold ${opt.highlighted ? 'text-emerald-600' : 'text-foreground'}`}>
                {opt.installments}
              </span>
              <span className={`text-lg font-semibold ${opt.highlighted ? 'text-emerald-600' : 'text-foreground'}`}>
                {formatBRL(opt.value)}
              </span>
              {opt.badge && (
                <span className="text-[10px] font-bold px-1.5 py-0.5 rounded-full bg-emerald-500/10 text-emerald-700 border border-emerald-500/20">
                  {opt.badge}
                </span>
              )}
            </div>
            <p className="text-xs text-muted-foreground mt-1">
              <strong>{opt.label}</strong>
            </p>
            <p className="text-xs text-muted-foreground">{opt.sub}</p>
          </div>
        ))}
      </div>
      <p className="text-[10px] text-muted-foreground mt-2 italic">
        Valores calculados automaticamente. Confirme as condições com a recepção antes de finalizar.
      </p>
    </div>
  );
}


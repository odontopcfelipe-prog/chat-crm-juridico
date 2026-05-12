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

  return (
    <div>
      <div className="flex items-center justify-between mb-3">
        <p className="text-sm text-muted-foreground">{list.length} orçamento(s)</p>
      </div>

      {list.length === 0 ? (
        <div className="bg-card border border-border border-dashed rounded-xl p-8 text-center">
          <DollarSign size={32} className="mx-auto text-muted-foreground mb-2" />
          <p className="text-muted-foreground text-sm">Nenhum orçamento cadastrado.</p>
        </div>
      ) : (
        <ul className="bg-card border border-border rounded-xl divide-y divide-border">
          {list.map((q) => {
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
            const isAccepted = q.status === 'ACCEPTED';

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
                  {q.title && (
                    <p className={`text-sm font-semibold flex items-center gap-2 ${titleCls}`}>
                      {q.title}
                      {isRemainder && (
                        <span className="inline-flex items-center text-[10px] px-1.5 py-0.5 rounded bg-amber-100 text-amber-800 border border-amber-300 dark:bg-amber-950 dark:text-amber-200 dark:border-amber-800 font-medium">
                          ↩ resto de aprovação parcial
                        </span>
                      )}
                    </p>
                  )}
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
                    aba Avaliacao) — sempre visivel, 3 cores distintas */}
                {(() => {
                  const p = q.priority || 'COMPLETO';
                  const cfg = {
                    URGENTE:   { label: '🔥 URGENTE',   cls: 'bg-red-500/15 text-red-700 border-red-500/30',         tip: 'Urgência clínica' },
                    ESSENCIAL: { label: '⚠ ESSENCIAL', cls: 'bg-amber-500/15 text-amber-700 border-amber-500/30',   tip: 'Procedimento essencial' },
                    COMPLETO:  { label: '✓ COMPLETO',  cls: 'bg-emerald-500/15 text-emerald-700 border-emerald-500/30', tip: 'Tratamento completo (sem urgência)' },
                  }[p];
                  return (
                    <span
                      className={`inline-flex items-center text-[10px] uppercase font-semibold px-2 py-0.5 rounded border ${cfg.cls}`}
                      title={cfg.tip}
                    >
                      {cfg.label}
                    </span>
                  );
                })()}
                <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium border ${STATUS_BADGE[q.status]}`}>
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
  const [partialSelection, setPartialSelection] = useState<Set<string>>(new Set());
  const [acceptingPartial, setAcceptingPartial] = useState(false);

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
    api.get<any>('/users?limit=100')
      .then((r) => {
        const data: any[] = r.data?.data || r.data?.users || r.data || [];
        const list = data
          .filter((u: any) =>
            u.roles?.includes('DENTIST') || u.roles?.includes('ADMIN') ||
            u.role === 'DENTIST' || u.role === 'ADMIN'
          )
          .map((u: any) => ({ id: u.id, name: u.name }));
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
          {/* Onda 5 — aba Orcamentos so RECEBE e VALIDA. Adicao de procedimentos
              acontece exclusivamente na aba Avaliacao (dentista registra ali e
              uma copia sobe automaticamente pra ca pra negociar/aprovar). */}
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
              return (
                <li
                  key={it.id}
                  className={`px-4 py-2.5 flex items-center gap-3 text-sm border-l-4 transition-colors ${
                    isApproved
                      ? 'opacity-60'
                      : isPartialSelected
                      ? 'ring-1 ring-emerald-500 ring-inset'
                      : ''
                  }`}
                  style={{ borderLeftColor: color.bar, backgroundColor: color.tint }}
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

      {/* Resumo */}
      <div className="bg-card border border-border rounded-xl p-4 mb-4">
        {/* Layout adapta — adiciona col "Selecionados" quando ha selecao parcial */}
        {(() => {
          const hasDiscount = Number(quote.discount_value) > 0;
          // Onda 6.3 — Layout lado-a-lado (Selecionados esquerda, Total
          // direita). Desconto entra como coluna do meio quando aplicado.
          // Total fica destacado a direita pra leitura rapida.
          return (
            <div className="flex items-start justify-between gap-4 text-sm flex-wrap">
              <div>
                <p className="text-xs text-emerald-700">
                  Selecionados ({partialSelection.size})
                </p>
                <p className="text-lg font-bold text-emerald-600">
                  R$ {partialTotal.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                </p>
              </div>
              {/* Onda 7 — Card "Nao selecionados" em vermelho no meio.
                  Mostra a soma dos items pendentes que ainda nao foram
                  marcados pra aprovar agora. Items ja aprovados (approved_at)
                  NAO entram nessa conta — eles ja fecharam, nao sao "nao
                  selecionados". */}
              {(() => {
                const notSelected = quote.items.filter(
                  (it) => !it.approved_at && !partialSelection.has(it.id),
                );
                const notSelectedTotal = notSelected.reduce(
                  (acc, it) => acc + Number(it.total_price),
                  0,
                );
                if (notSelected.length === 0) return null;
                return (
                  <div>
                    <p className="text-xs text-red-700">
                      Pendentes ({notSelected.length})
                    </p>
                    <p className="text-lg font-bold text-red-600">
                      R$ {notSelectedTotal.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                    </p>
                  </div>
                );
              })()}
              {/* Onda 7.2 — Card "Aprovados" emerald no meio quando ha pelo
                  menos 1 item aprovado. Mostra o quanto ja foi fechado. */}
              {(() => {
                const approved = quote.items.filter((it) => !!it.approved_at);
                const approvedTotal = approved.reduce(
                  (acc, it) => acc + Number(it.total_price),
                  0,
                );
                if (approved.length === 0) return null;
                return (
                  <div>
                    <p className="text-xs text-emerald-700 inline-flex items-center gap-1">
                      <Check size={10} /> Aprovados ({approved.length})
                    </p>
                    <p className="text-lg font-bold text-emerald-700">
                      R$ {approvedTotal.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                    </p>
                  </div>
                );
              })()}
              {hasDiscount && (
                <div>
                  <p className="text-xs text-muted-foreground">Desconto</p>
                  <p className="font-semibold text-emerald-600">
                    {Number(quote.discount_percent)}% (-R$ {Number(quote.discount_value).toFixed(2)})
                  </p>
                </div>
              )}
              <div className="text-right">
                <p className="text-xs text-muted-foreground">Total</p>
                <p className="text-xl font-bold text-primary">R$ {Number(quote.total_value).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</p>
                {/* Tempo de cadeira (soma duration_minutes * quantity) */}
                {(() => {
                  const totalMinutes = quote.items.reduce(
                    (acc, it) => acc + (it.procedure?.duration_minutes || 0) * it.quantity,
                    0,
                  );
                  if (totalMinutes <= 0) return null;
                  const h = Math.floor(totalMinutes / 60);
                  const m = totalMinutes % 60;
                  const label = h > 0
                    ? (m > 0 ? `~${h}h${String(m).padStart(2, '0')}min` : `~${h}h`)
                    : `~${m}min`;
                  return (
                    <p className="text-[11px] text-muted-foreground mt-0.5" title="Tempo estimado total de cadeira (soma da duração de cada procedimento)">
                      ⏱ {label} de cadeira
                    </p>
                  );
                })()}
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

      {/* Onda 2 — Sugestoes de pagamento (calculado on-the-fly).
          Onda 3.3 (Fase 25) — agora aparece em QUALQUER status com total > 0.
          Antes era so SENT/ACCEPTED, mas o momento mais critico de vender
          condicao de pagamento eh DURANTE a montagem do orcamento, com paciente
          junto. Recepcao precisa ver "5% PIX vs 12x cartao" pra negociar.
          Onda 7.1 — usa partialTotal (soma dos SELECIONADOS) em vez do
          quote.total_value (soma de TUDO). Recepcao marca os items que o
          paciente vai fechar agora, e o card recalcula automaticamente as
          condicoes de pagamento. Fallback pro total cheio quando 0 selec. */}
      {(() => {
        const baseTotal = partialSelection.size > 0 ? partialTotal : Number(quote.total_value);
        if (baseTotal <= 0) return null;
        return <PaymentSuggestionsCard total={baseTotal} />;
      })()}

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

  const cashDiscount = 0.05;
  const cashTotal = total * (1 - cashDiscount);

  // Juros simples mensal pra parcelas longas (modelo conservador)
  const interestRate12x = 0.015; // 1.5% ao mes
  const totalWith12xInterest = total * (1 + interestRate12x * 12);

  const options = [
    {
      label: 'À vista (PIX/dinheiro)',
      sub: `5% de desconto · economia de ${formatBRL(total - cashTotal)}`,
      value: cashTotal,
      installments: '1x',
      highlighted: true,
      badge: '💸 Mais econômico',
    },
    {
      label: 'Cartão de crédito',
      sub: 'Sem juros',
      value: total / 3,
      installments: '3x',
    },
    {
      label: 'Cartão de crédito',
      sub: 'Sem juros',
      value: total / 6,
      installments: '6x',
    },
    {
      label: 'Cartão de crédito',
      sub: `Com juros (1,5%/mês) · total ${formatBRL(totalWith12xInterest)}`,
      value: totalWith12xInterest / 12,
      installments: '12x',
    },
  ];

  return (
    <div className="bg-card border border-border rounded-xl p-4 mb-4">
      <h3 className="text-sm font-semibold mb-3 flex items-center gap-2">
        <CreditCard size={14} className="text-primary" />
        Sugestões de pagamento
      </h3>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
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

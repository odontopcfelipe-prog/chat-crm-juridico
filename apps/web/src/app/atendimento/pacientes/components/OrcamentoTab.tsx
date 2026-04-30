'use client';

import { useEffect, useState, useCallback } from 'react';
import { Loader2, DollarSign, Plus, ArrowLeft, Send, Check, X, Trash2, MessageCircle, Calendar, Download, Tag, CreditCard, Repeat } from 'lucide-react';
import QuoteAttachments from './QuoteAttachments';
import QuoteVersions from './QuoteVersions';
import AddQuoteItemModal from './AddQuoteItemModal';
import api from '@/lib/api';
import { showError, showSuccess } from '@/lib/toast';
import { colorForSpecialty } from '@/lib/specialty-colors';

interface Props {
  patientId: string;
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
}

interface QuoteListItem {
  id: string;
  status: 'DRAFT' | 'SENT' | 'ACCEPTED' | 'REJECTED' | 'EXPIRED';
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

export default function OrcamentoTab({ patientId }: Props) {
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

  const openDetail = async (id: string) => {
    try {
      const { data } = await api.get<QuoteDetail>(`/quotes/${id}`);
      setCurrent(data);
      setMode('detail');
    } catch (err: any) {
      showError(err?.response?.data?.message || 'Erro ao carregar orçamento');
    }
  };

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
        onBack={() => { setMode('list'); setCurrent(null); loadList(); }}
        onReload={async () => {
          const { data } = await api.get<QuoteDetail>(`/quotes/${current.id}`);
          setCurrent(data);
        }}
      />
    );
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-3">
        <p className="text-sm text-muted-foreground">{list.length} orçamento(s)</p>
        <button
          onClick={createQuote}
          disabled={saving}
          className="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 disabled:opacity-50"
        >
          {saving ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />}
          Novo orçamento
        </button>
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
            return (
              <li
                key={q.id}
                onClick={() => openDetail(q.id)}
                className="px-4 py-3 hover:bg-accent/40 cursor-pointer flex items-center gap-3"
              >
                <DollarSign size={18} className="text-primary shrink-0" />
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-foreground">
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
  quote, procedures, onBack, onReload,
}: {
  quote: QuoteDetail;
  procedures: Procedure[];
  onBack: () => void;
  onReload: () => Promise<void>;
}) {
  // addingItem agora abre modal AddQuoteItemModal — nao mais form inline
  const [addingItem, setAddingItem] = useState(false);

  // Cupom (Onda 2)
  const [couponCode, setCouponCode] = useState('');
  const [applyingCoupon, setApplyingCoupon] = useState(false);

  const isDraft = quote.status === 'DRAFT';
  const isSent = quote.status === 'SENT';

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
          {isDraft && quote.items.length > 0 && (
            <button
              onClick={() => setAddingItem(true)}
              className="text-xs inline-flex items-center gap-1 px-3 py-1.5 rounded-lg bg-primary text-primary-foreground hover:bg-primary/90 font-medium"
            >
              <Plus size={12} /> Adicionar procedimentos
            </button>
          )}
        </div>

        {/* Modal de adicionar (substitui form inline cramped) */}
        {addingItem && (
          <AddQuoteItemModal
            quoteId={quote.id}
            procedures={procedures}
            onClose={() => setAddingItem(false)}
            onAdded={onReload}
          />
        )}

        {quote.items.length === 0 ? (
          <div className="py-10 px-6 text-center">
            <DollarSign size={36} className="mx-auto text-muted-foreground/40 mb-3" />
            {isDraft ? (
              <>
                <p className="text-sm text-muted-foreground mb-4">
                  Comece adicionando procedimentos ao orçamento.
                </p>
                <button
                  onClick={() => setAddingItem(true)}
                  className="inline-flex items-center gap-2 px-5 py-2.5 rounded-lg bg-primary text-primary-foreground text-sm font-semibold hover:bg-primary/90 shadow-sm"
                >
                  <Plus size={16} /> Adicionar procedimentos
                </button>
              </>
            ) : (
              <p className="text-sm text-muted-foreground">Nenhum procedimento neste orçamento.</p>
            )}
          </div>
        ) : (
          <ul className="divide-y divide-border">
            {quote.items.map((it) => {
              // Onda 25.2 — pinta borda esquerda + tag pela especialidade
              // (mesma paleta da Tabela de Precos pra leitura visual consistente)
              const spec = it.procedure?.specialty;
              const color = colorForSpecialty(spec?.id || null);
              return (
                <li
                  key={it.id}
                  className="px-4 py-2.5 flex items-center gap-3 text-sm border-l-4 transition-colors"
                  style={{ borderLeftColor: color.bar, backgroundColor: color.tint }}
                >
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <p className="font-medium">{it.procedure?.name || 'Procedimento'}</p>
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
                    </div>
                    <p className="text-xs text-muted-foreground">
                      {it.tooth_fdi && `Dente ${it.tooth_fdi} · `}
                      {it.quantity}x R$ {Number(it.unit_price).toFixed(2)}
                    </p>
                  </div>
                  <div className="text-right">
                    <p className="font-semibold">R$ {Number(it.total_price).toFixed(2)}</p>
                  </div>
                  {isDraft && (
                    <button onClick={() => removeItem(it.id)} className="text-destructive hover:bg-destructive/10 p-1 rounded">
                      <Trash2 size={14} />
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {/* Resumo */}
      <div className="bg-card border border-border rounded-xl p-4 mb-4">
        {/* Onda 25.1: layout adapta — 4 cols se tem desconto, 3 cols sem */}
        <div className={`grid grid-cols-2 gap-4 text-sm ${
          Number(quote.discount_value) > 0 ? 'md:grid-cols-4' : 'md:grid-cols-3'
        }`}>
          <div>
            <p className="text-xs text-muted-foreground">Subtotal</p>
            <p className="font-semibold">R$ {Number(quote.subtotal).toFixed(2)}</p>
          </div>
          {/* Onda 25.1: so mostra Desconto se houver desconto aplicado */}
          {Number(quote.discount_value) > 0 && (
            <div>
              <p className="text-xs text-muted-foreground">Desconto</p>
              <p className="font-semibold text-emerald-600">
                {Number(quote.discount_percent)}% (-R$ {Number(quote.discount_value).toFixed(2)})
              </p>
            </div>
          )}
          <div className="col-span-2 md:col-span-1">
            <p className="text-xs text-muted-foreground">Total</p>
            <p className="text-xl font-bold text-primary">R$ {Number(quote.total_value).toFixed(2)}</p>
            {/* Onda 25.3 — tempo de cadeira (soma duration_minutes * quantity) */}
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
          <div>
            <p className="text-xs text-muted-foreground">Validade</p>
            {quote.valid_until ? (
              (() => {
                const expiry = expiryStatus(quote.valid_until, quote.status);
                return (
                  <p className="text-sm flex items-center gap-2 flex-wrap">
                    <span>{new Date(quote.valid_until).toLocaleDateString('pt-BR')}</span>
                    {expiry && (
                      <span className={`text-xs font-medium ${expiry.cls}`}>
                        ({expiry.text})
                      </span>
                    )}
                  </p>
                );
              })()
            ) : (
              <p className="text-sm">—</p>
            )}
          </div>
        </div>
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

      {/* Onda 2 — Sugestoes de pagamento (calculado on-the-fly) */}
      {Number(quote.total_value) > 0 && (isSent || quote.status === 'ACCEPTED') && (
        <PaymentSuggestionsCard total={Number(quote.total_value)} />
      )}

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

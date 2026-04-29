'use client';

import { useEffect, useState, useCallback } from 'react';
import { Loader2, DollarSign, Plus, ArrowLeft, Send, Check, X, Trash2, MessageCircle, Calendar, AlertTriangle } from 'lucide-react';
import api from '@/lib/api';
import { showError, showSuccess } from '@/lib/toast';

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
  procedure?: { id: string; name: string; code_tuss: string | null };
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
  const [addingItem, setAddingItem] = useState(false);
  const [procedureId, setProcedureId] = useState('');
  const [quantity, setQuantity] = useState(1);
  const [unitPrice, setUnitPrice] = useState<string>('');
  const [toothFdi, setToothFdi] = useState('');
  const [saving, setSaving] = useState(false);

  const isDraft = quote.status === 'DRAFT';
  const isSent = quote.status === 'SENT';

  const addItem = async () => {
    if (!procedureId) {
      showError('Selecione um procedimento');
      return;
    }
    setSaving(true);
    try {
      await api.post(`/quotes/${quote.id}/items`, {
        procedure_id: procedureId,
        quantity,
        unit_price: unitPrice === '' ? undefined : Number(unitPrice),
        tooth_fdi: toothFdi || undefined,
      });
      showSuccess('Item adicionado');
      setAddingItem(false);
      setProcedureId('');
      setQuantity(1);
      setUnitPrice('');
      setToothFdi('');
      await onReload();
    } catch (err: any) {
      showError(err?.response?.data?.message || 'Erro ao adicionar');
    } finally {
      setSaving(false);
    }
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

      {/* Resumo */}
      <div className="bg-card border border-border rounded-xl p-4 mb-4">
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
          <div>
            <p className="text-xs text-muted-foreground">Subtotal</p>
            <p className="font-semibold">R$ {Number(quote.subtotal).toFixed(2)}</p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">Desconto</p>
            <p className="font-semibold">{Number(quote.discount_percent)}% (R$ {Number(quote.discount_value).toFixed(2)})</p>
          </div>
          <div className="col-span-2 md:col-span-1">
            <p className="text-xs text-muted-foreground">Total</p>
            <p className="text-xl font-bold text-primary">R$ {Number(quote.total_value).toFixed(2)}</p>
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
      </div>

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
      </div>

      {/* Items */}
      <div className="bg-card border border-border rounded-xl overflow-hidden mb-4">
        <div className="px-4 py-2 border-b border-border flex items-center justify-between">
          <p className="text-sm font-semibold">Procedimentos</p>
          {isDraft && !addingItem && (
            <button onClick={() => setAddingItem(true)} className="text-xs text-primary hover:bg-primary/10 px-2 py-1 rounded flex items-center gap-1">
              <Plus size={12} /> Adicionar
            </button>
          )}
        </div>

        {addingItem && (
          <div className="p-4 bg-accent/20 border-b border-border space-y-3">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium mb-1">Procedimento</label>
                <select
                  value={procedureId}
                  onChange={(e) => {
                    setProcedureId(e.target.value);
                    const p = procedures.find((x) => x.id === e.target.value);
                    if (p && unitPrice === '') setUnitPrice(String(p.base_price));
                  }}
                  className="w-full px-3 py-2 rounded-lg bg-background border border-border text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
                >
                  <option value="">Selecione...</option>
                  {procedures.map((p) => (
                    <option key={p.id} value={p.id}>{p.name} (R$ {Number(p.base_price).toFixed(2)})</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium mb-1">Dente FDI (opcional)</label>
                <input
                  type="text"
                  value={toothFdi}
                  onChange={(e) => setToothFdi(e.target.value)}
                  placeholder="ex: 11, 36, 47"
                  className="w-full px-3 py-2 rounded-lg bg-background border border-border text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
                />
              </div>
              <div>
                <label className="block text-xs font-medium mb-1">Quantidade</label>
                <input
                  type="number"
                  value={quantity}
                  onChange={(e) => setQuantity(parseInt(e.target.value, 10) || 1)}
                  min={1}
                  className="w-full px-3 py-2 rounded-lg bg-background border border-border text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
                />
              </div>
              <div>
                <label className="block text-xs font-medium mb-1">Preço unitário (R$)</label>
                <input
                  type="number"
                  step="0.01"
                  value={unitPrice}
                  onChange={(e) => setUnitPrice(e.target.value)}
                  className="w-full px-3 py-2 rounded-lg bg-background border border-border text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
                />
              </div>
            </div>
            <div className="flex justify-end gap-2">
              <button onClick={() => setAddingItem(false)} disabled={saving} className="px-3 py-1 rounded-lg border border-border text-sm hover:bg-accent disabled:opacity-50">
                Cancelar
              </button>
              <button onClick={addItem} disabled={saving} className="inline-flex items-center gap-1 px-3 py-1 rounded-lg bg-primary text-primary-foreground text-sm hover:bg-primary/90 disabled:opacity-50">
                {saving && <Loader2 size={12} className="animate-spin" />}
                Adicionar
              </button>
            </div>
          </div>
        )}

        {quote.items.length === 0 ? (
          <div className="py-8 text-center text-muted-foreground text-sm">Nenhum item.</div>
        ) : (
          <ul className="divide-y divide-border">
            {quote.items.map((it) => (
              <li key={it.id} className="px-4 py-2.5 flex items-center gap-3 text-sm">
                <div className="flex-1 min-w-0">
                  <p className="font-medium">{it.procedure?.name || 'Procedimento'}</p>
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
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

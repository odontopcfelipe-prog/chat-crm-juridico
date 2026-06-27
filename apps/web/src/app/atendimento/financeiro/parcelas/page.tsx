'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  Wallet, Loader2, Search, AlertTriangle, CheckCircle, Clock, X, DollarSign, Phone,
  CreditCard, QrCode, Copy, ExternalLink, Zap,
} from 'lucide-react';
import api from '@/lib/api';
import { showError, showSuccess } from '@/lib/toast';

interface Installment {
  id: string;
  sequence: number;
  total_count: number;
  amount: string;
  amount_paid: string;
  due_date: string;
  paid_at: string | null;
  payment_method: string | null;
  status: string;
  notes: string | null;
  collection_stage: string | null;
  gateway_charge_id: string | null;
  patient: { id: string; name: string; phone: string | null; email: string | null; cpf?: string | null };
  quote: { id: string; total_value: string } | null;
  _count?: { collection_attempts: number };
}

interface PaymentCharge {
  id: string;
  external_id: string;
  status: string;
  billing_type: string;
  amount: number | string;
  invoice_url?: string | null;
  boleto_url?: string | null;
  pix_qr_code?: string | null;
  pix_copy_paste?: string | null;
  pix?: { qrCode?: string; copyPaste?: string; expirationDate?: string } | null;
  boleto?: { url?: string; barcode?: string } | null;
}

const CHARGE_STATUS_CFG: Record<string, { label: string; cls: string }> = {
  PENDING:   { label: 'Aguardando',    cls: 'bg-amber-500/10 text-amber-700 border-amber-500/20' },
  RECEIVED:  { label: 'Pago',          cls: 'bg-green-500/10 text-green-700 border-green-500/20' },
  CONFIRMED: { label: 'Confirmado',    cls: 'bg-green-500/10 text-green-700 border-green-500/20' },
  OVERDUE:   { label: 'Vencido',       cls: 'bg-red-500/10 text-red-700 border-red-500/20' },
  REFUNDED:  { label: 'Estornado',     cls: 'bg-purple-500/10 text-purple-700 border-purple-500/20' },
  DELETED:   { label: 'Cancelado',     cls: 'bg-gray-500/10 text-gray-700 border-gray-500/20' },
};

interface OverdueSummary {
  total_overdue: number;
  total_value: number;
  buckets: Record<string, { count: number; total: number }>;
}

const STATUS_CFG: Record<string, { label: string; cls: string }> = {
  ABERTA:      { label: 'Aberta',      cls: 'bg-blue-500/10 text-blue-700 border-blue-500/20' },
  PARCIAL:     { label: 'Parcial',     cls: 'bg-amber-500/10 text-amber-700 border-amber-500/20' },
  PAGA:        { label: 'Paga',        cls: 'bg-green-500/10 text-green-700 border-green-500/20' },
  ATRASADA:    { label: 'Atrasada',    cls: 'bg-red-500/10 text-red-700 border-red-500/20' },
  CANCELADA:   { label: 'Cancelada',   cls: 'bg-gray-500/10 text-gray-700 border-gray-500/20' },
  RENEGOCIADA: { label: 'Renegociada', cls: 'bg-purple-500/10 text-purple-700 border-purple-500/20' },
};

const fmt = (v: number | string) =>
  new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(Number(v));

export default function ParcelasPage() {
  const [loading, setLoading] = useState(true);
  const [installments, setInstallments] = useState<Installment[]>([]);
  const [summary, setSummary] = useState<OverdueSummary | null>(null);
  const [statusFilter, setStatusFilter] = useState<string>('');
  const [overdueOnly, setOverdueOnly] = useState(false);
  const [search, setSearch] = useState('');
  const [openPay, setOpenPay] = useState<Installment | null>(null);
  const [openCharge, setOpenCharge] = useState<Installment | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ limit: '100' });
      if (statusFilter) params.set('status', statusFilter);
      if (overdueOnly) params.set('overdue', 'true');
      const [list, sum] = await Promise.all([
        api.get<{ data: Installment[] }>(`/installments?${params}`),
        api.get<OverdueSummary>('/installments/overdue-summary'),
      ]);
      let data = list.data?.data || [];
      if (search) {
        const q = search.toLowerCase();
        data = data.filter((i) =>
          i.patient.name.toLowerCase().includes(q) ||
          (i.patient.phone || '').includes(q),
        );
      }
      setInstallments(data);
      setSummary(sum.data);
    } catch (err: any) {
      showError(err?.response?.data?.message || 'Erro ao carregar parcelas');
    } finally {
      setLoading(false);
    }
  }, [statusFilter, overdueOnly, search]);

  useEffect(() => {
    const debounce = setTimeout(load, 300);
    return () => clearTimeout(debounce);
  }, [load]);

  return (
    <div className="h-full overflow-y-auto p-6 w-full">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-foreground flex items-center gap-2">
          <Wallet size={26} className="text-primary" /> Parcelas
        </h1>
        <p className="text-sm text-muted-foreground mt-1">
          Gestao de parcelas com regua de cobranca automatica (D-3, D, D+1, D+7, D+15, D+30).
        </p>
      </div>

      {/* Aging buckets */}
      {summary && summary.total_overdue > 0 && (
        <div className="bg-card border border-border rounded-xl p-4 mb-4">
          <div className="flex items-center justify-between mb-3">
            <h3 className="font-semibold text-foreground flex items-center gap-2">
              <AlertTriangle size={16} className="text-destructive" /> Inadimplencia
            </h3>
            <div className="text-right">
              <div className="text-2xl font-bold text-destructive">{fmt(summary.total_value)}</div>
              <div className="text-xs text-muted-foreground">{summary.total_overdue} parcela(s) em atraso</div>
            </div>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
            {Object.entries(summary.buckets).map(([label, b]) => (
              <div key={label} className="bg-background border border-border rounded p-2">
                <div className="text-xs text-muted-foreground">{label}</div>
                <div className="text-sm font-bold">{b.count}</div>
                <div className="text-xs font-mono text-destructive">{fmt(b.total)}</div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Toolbar */}
      <div className="flex flex-col sm:flex-row gap-2 mb-4">
        <div className="relative flex-1">
          <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Buscar por paciente ou telefone..."
            className="w-full pl-9 pr-3 py-2 rounded-lg bg-background border border-border text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
          />
        </div>
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
          className="px-3 py-2 rounded-lg bg-background border border-border text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
        >
          <option value="">Todos os status</option>
          {Object.entries(STATUS_CFG).map(([v, c]) => (
            <option key={v} value={v}>{c.label}</option>
          ))}
        </select>
        <label className="flex items-center gap-2 px-3 py-2 rounded-lg border border-border text-sm cursor-pointer hover:bg-accent">
          <input
            type="checkbox"
            checked={overdueOnly}
            onChange={(e) => setOverdueOnly(e.target.checked)}
            className="accent-primary"
          />
          So atrasadas
        </label>
      </div>

      {loading ? (
        <div className="p-12 flex items-center justify-center text-muted-foreground">
          <Loader2 size={20} className="animate-spin mr-2" /> Carregando...
        </div>
      ) : installments.length === 0 ? (
        <div className="p-12 text-center text-sm text-muted-foreground">
          <CheckCircle size={28} className="mx-auto mb-2 opacity-50" />
          Nenhuma parcela encontrada com esses filtros.
        </div>
      ) : (
        <div className="bg-card border border-border rounded-xl overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-muted/30 text-left text-xs uppercase tracking-wide text-muted-foreground">
                <th className="px-3 py-2">Paciente</th>
                <th className="px-3 py-2">Parcela</th>
                <th className="px-3 py-2">Vencimento</th>
                <th className="px-3 py-2 text-right">Valor</th>
                <th className="px-3 py-2">Status</th>
                <th className="px-3 py-2">Ultima cobranca</th>
                <th className="px-3 py-2 text-right">Acoes</th>
              </tr>
            </thead>
            <tbody>
              {installments.map((i) => {
                const cfg = STATUS_CFG[i.status] || STATUS_CFG.ABERTA;
                const due = new Date(i.due_date);
                const overdue = i.status !== 'PAGA' && due < new Date();
                const daysLate = overdue
                  ? Math.floor((Date.now() - due.getTime()) / (1000 * 60 * 60 * 24))
                  : 0;
                const remaining = Number(i.amount) - Number(i.amount_paid);

                return (
                  <tr key={i.id} className="border-b border-border last:border-0 hover:bg-accent/30">
                    <td className="px-3 py-2">
                      <div className="font-medium">{i.patient.name}</div>
                      {i.patient.phone && (
                        <div className="text-xs text-muted-foreground flex items-center gap-1">
                          <Phone size={10} /> {i.patient.phone}
                        </div>
                      )}
                    </td>
                    <td className="px-3 py-2 text-xs">
                      {i.sequence}/{i.total_count}
                    </td>
                    <td className="px-3 py-2 text-xs">
                      {due.toLocaleDateString('pt-BR')}
                      {overdue && (
                        <div className="text-[10px] text-destructive">{daysLate}d em atraso</div>
                      )}
                    </td>
                    <td className="px-3 py-2 text-right font-mono">
                      {fmt(remaining)}
                      {Number(i.amount_paid) > 0 && (
                        <div className="text-[10px] text-muted-foreground">
                          pago: {fmt(i.amount_paid)}
                        </div>
                      )}
                    </td>
                    <td className="px-3 py-2">
                      <span className={`text-xs px-2 py-0.5 rounded border ${cfg.cls}`}>
                        {cfg.label}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-xs text-muted-foreground">
                      {i.collection_stage ? (
                        <span>
                          {i.collection_stage} · {(i._count?.collection_attempts ?? 0)}x
                        </span>
                      ) : '—'}
                    </td>
                    <td className="px-3 py-2 text-right">
                      <div className="flex justify-end gap-1">
                        {i.status !== 'PAGA' && i.status !== 'CANCELADA' && i.status !== 'RENEGOCIADA' && (
                          <>
                            <button
                              onClick={() => setOpenCharge(i)}
                              title={i.gateway_charge_id ? 'Ver cobranca Asaas' : 'Cobrar via Asaas (PIX/Boleto)'}
                              className={`text-xs inline-flex items-center gap-1 px-2 py-1 rounded border ${
                                i.gateway_charge_id
                                  ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 hover:bg-emerald-500/20'
                                  : 'border-border hover:bg-accent'
                              }`}
                            >
                              <Zap size={12} />
                              {i.gateway_charge_id ? 'Ver' : 'Cobrar'}
                            </button>
                            <button
                              onClick={() => setOpenPay(i)}
                              className="text-xs inline-flex items-center gap-1 px-2 py-1 rounded bg-primary text-primary-foreground hover:bg-primary/90"
                            >
                              <DollarSign size={12} /> Receber
                            </button>
                          </>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {openPay && (
        <PayModal
          installment={openPay}
          onClose={() => setOpenPay(null)}
          onPaid={() => { setOpenPay(null); load(); }}
        />
      )}

      {openCharge && (
        <ChargeModal
          installment={openCharge}
          onClose={() => setOpenCharge(null)}
          onChanged={load}
        />
      )}
    </div>
  );
}

function PayModal({
  installment, onClose, onPaid,
}: { installment: Installment; onClose: () => void; onPaid: () => void }) {
  const remaining = Number(installment.amount) - Number(installment.amount_paid);
  const [saving, setSaving] = useState(false);
  const [amountPaid, setAmountPaid] = useState(remaining.toFixed(2));
  const [paymentMethod, setPaymentMethod] = useState('PIX');
  const [notes, setNotes] = useState('');

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const amt = parseFloat(amountPaid);
    if (!amt || amt <= 0) {
      showError('Valor invalido');
      return;
    }
    setSaving(true);
    try {
      await api.post(`/installments/${installment.id}/pay`, {
        amount_paid: amt,
        payment_method: paymentMethod,
        notes: notes.trim() || undefined,
      });
      showSuccess('Pagamento registrado');
      onPaid();
    } catch (err: any) {
      showError(err?.response?.data?.message || 'Erro ao registrar');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-[100] bg-black/50 backdrop-blur-sm flex items-center justify-center p-4"
      onClick={onClose}
    >
      <div
        className="bg-card border border-border rounded-xl w-full max-w-md shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between p-4 border-b border-border">
          <h2 className="text-lg font-semibold flex items-center gap-2">
            <DollarSign size={20} className="text-primary" /> Receber pagamento
          </h2>
          <button onClick={onClose} className="p-1 hover:bg-accent rounded">
            <X size={18} />
          </button>
        </div>

        <form onSubmit={submit} className="p-4 space-y-3">
          <div className="text-sm bg-background border border-border rounded-lg p-3">
            <p className="font-medium">{installment.patient.name}</p>
            <p className="text-xs text-muted-foreground">
              Parcela {installment.sequence}/{installment.total_count} · venc.{' '}
              {new Date(installment.due_date).toLocaleDateString('pt-BR')}
            </p>
            <p className="text-xs mt-1">
              Saldo devedor: <span className="font-mono font-bold">{fmt(remaining)}</span>
            </p>
          </div>

          <div>
            <label className="block text-xs font-medium mb-1">Valor recebido (R$) *</label>
            <input
              type="number"
              step="0.01"
              value={amountPaid}
              onChange={(e) => setAmountPaid(e.target.value)}
              max={remaining}
              autoFocus
              className="w-full px-3 py-2 rounded-lg bg-background border border-border text-sm font-mono focus:outline-none focus:ring-2 focus:ring-primary/30"
            />
            <p className="text-xs text-muted-foreground mt-1">
              Valor menor que saldo gera status PARCIAL.
            </p>
          </div>

          <div>
            <label className="block text-xs font-medium mb-1">Metodo *</label>
            <select
              value={paymentMethod}
              onChange={(e) => setPaymentMethod(e.target.value)}
              className="w-full px-3 py-2 rounded-lg bg-background border border-border text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
            >
              <option value="PIX">PIX</option>
              <option value="BOLETO">Boleto</option>
              <option value="CARTAO">Cartao</option>
              <option value="DINHEIRO">Dinheiro</option>
              <option value="TRANSFERENCIA">Transferencia</option>
              <option value="MAQUININHA">Maquininha</option>
            </select>
          </div>

          <div>
            <label className="block text-xs font-medium mb-1">Observacoes</label>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={2}
              className="w-full px-3 py-2 rounded-lg bg-background border border-border text-sm focus:outline-none focus:ring-2 focus:ring-primary/30 resize-none"
            />
          </div>

          <div className="flex justify-end gap-2 pt-3 border-t border-border">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 rounded-lg border border-border text-sm font-medium hover:bg-accent"
            >
              Cancelar
            </button>
            <button
              type="submit"
              disabled={saving}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 disabled:opacity-50"
            >
              {saving ? <Loader2 size={16} className="animate-spin" /> : <DollarSign size={16} />}
              Confirmar
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

/**
 * Modal de cobranca via gateway (Asaas) — gera PIX/Boleto/Cartao e mostra
 * QR code/codigo de barras/link da fatura. Idempotente: se ja existe charge
 * pra parcela, faz GET ao inves de POST.
 */
function ChargeModal({
  installment, onClose, onChanged,
}: { installment: Installment; onClose: () => void; onChanged: () => void }) {
  const [loading, setLoading] = useState(false);
  const [creating, setCreating] = useState(false);
  const [charge, setCharge] = useState<PaymentCharge | null>(null);
  const [billingType, setBillingType] = useState<'PIX' | 'BOLETO' | 'CREDIT_CARD'>('PIX');

  const remaining = Number(installment.amount) - Number(installment.amount_paid);

  // Carrega charge existente (se houver)
  useEffect(() => {
    if (!installment.gateway_charge_id) return;
    setLoading(true);
    api.get<{ local: PaymentCharge; gateway: any }>(`/payment-gateway/installments/${installment.id}/charge`)
      .then((r) => {
        const local = r.data.local;
        const gw = r.data.gateway;
        setCharge({
          ...local,
          // Se o gateway retornou QR/boleto fresco, usar
          pix: local.pix_qr_code ? {
            qrCode: local.pix_qr_code,
            copyPaste: local.pix_copy_paste || undefined,
          } : null,
          boleto: local.boleto_url ? { url: local.boleto_url } : null,
          invoice_url: gw?.invoiceUrl || local.invoice_url || null,
        });
      })
      .catch((e) => showError(e?.response?.data?.message || 'Erro ao carregar cobranca'))
      .finally(() => setLoading(false));
  }, [installment.id, installment.gateway_charge_id]);

  const handleCreate = async () => {
    if (!installment.patient.cpf) {
      showError('Paciente sem CPF — cadastre antes de gerar cobranca');
      return;
    }
    setCreating(true);
    try {
      const r = await api.post<PaymentCharge>(
        `/payment-gateway/installments/${installment.id}/charge`,
        { billingType },
      );
      setCharge(r.data);
      showSuccess('Cobranca gerada no Asaas');
      onChanged();
    } catch (e: any) {
      showError(e?.response?.data?.message || 'Erro ao gerar cobranca');
    } finally {
      setCreating(false);
    }
  };

  const copyToClipboard = (text: string, label: string) => {
    navigator.clipboard.writeText(text).then(() => showSuccess(`${label} copiado`));
  };

  const cfg = charge ? (CHARGE_STATUS_CFG[charge.status] || CHARGE_STATUS_CFG.PENDING) : null;

  return (
    <div
      className="fixed inset-0 z-[100] bg-black/50 backdrop-blur-sm flex items-center justify-center p-4"
      onClick={onClose}
    >
      <div
        className="bg-card border border-border rounded-xl w-full max-w-md shadow-2xl max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between p-4 border-b border-border sticky top-0 bg-card">
          <h2 className="text-lg font-semibold flex items-center gap-2">
            <Zap size={20} className="text-primary" /> Cobranca via Asaas
          </h2>
          <button onClick={onClose} className="p-1 hover:bg-accent rounded">
            <X size={18} />
          </button>
        </div>

        <div className="p-4 space-y-3">
          <div className="text-sm bg-background border border-border rounded-lg p-3">
            <p className="font-medium">{installment.patient.name}</p>
            <p className="text-xs text-muted-foreground">
              Parcela {installment.sequence}/{installment.total_count} · venc.{' '}
              {new Date(installment.due_date).toLocaleDateString('pt-BR')}
            </p>
            <p className="text-xs mt-1">
              Valor: <span className="font-mono font-bold">{fmt(remaining)}</span>
            </p>
          </div>

          {loading ? (
            <div className="p-8 flex items-center justify-center text-muted-foreground">
              <Loader2 size={20} className="animate-spin mr-2" /> Carregando cobranca...
            </div>
          ) : !charge ? (
            // ─── CRIAR NOVA COBRANÇA ───
            <>
              <div>
                <label className="block text-xs font-medium mb-1">Forma de cobranca</label>
                <div className="grid grid-cols-3 gap-2">
                  {([
                    { v: 'PIX', label: 'PIX', icon: <QrCode size={14} /> },
                    { v: 'BOLETO', label: 'Boleto', icon: <ExternalLink size={14} /> },
                    { v: 'CREDIT_CARD', label: 'Cartao', icon: <CreditCard size={14} /> },
                  ] as const).map((opt) => (
                    <button
                      key={opt.v}
                      onClick={() => setBillingType(opt.v)}
                      className={`px-2 py-2 rounded-lg border text-xs font-medium inline-flex items-center justify-center gap-1 ${
                        billingType === opt.v
                          ? 'border-primary bg-primary/10 text-primary'
                          : 'border-border hover:bg-accent'
                      }`}
                    >
                      {opt.icon} {opt.label}
                    </button>
                  ))}
                </div>
              </div>
              {!installment.patient.cpf && (
                <div className="bg-amber-500/10 border border-amber-500/30 rounded-lg p-2 text-xs text-amber-700">
                  Paciente sem CPF — cadastre na ficha antes de gerar cobranca.
                </div>
              )}
              <button
                onClick={handleCreate}
                disabled={creating || !installment.patient.cpf}
                className="w-full inline-flex items-center justify-center gap-2 px-4 py-2 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 disabled:opacity-50"
              >
                {creating ? <Loader2 size={16} className="animate-spin" /> : <Zap size={16} />}
                Gerar cobranca
              </button>
            </>
          ) : (
            // ─── COBRANÇA JÁ EXISTE ───
            <>
              <div className="flex items-center justify-between bg-background border border-border rounded-lg p-3">
                <div>
                  <div className="text-xs text-muted-foreground">Status no Asaas</div>
                  {cfg && (
                    <span className={`text-xs px-2 py-0.5 rounded border ${cfg.cls}`}>
                      {cfg.label}
                    </span>
                  )}
                </div>
                <div className="text-right">
                  <div className="text-xs text-muted-foreground">{charge.billing_type}</div>
                  <div className="text-sm font-mono font-bold">{fmt(charge.amount)}</div>
                </div>
              </div>

              {/* PIX QR Code */}
              {charge.billing_type === 'PIX' && charge.pix?.qrCode && (
                <div className="bg-background border border-border rounded-lg p-3 space-y-2">
                  <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
                    <QrCode size={14} /> QR Code PIX
                  </div>
                  <img
                    src={`data:image/png;base64,${charge.pix.qrCode}`}
                    alt="QR Code PIX"
                    className="w-48 h-48 mx-auto"
                  />
                  {charge.pix.copyPaste && (
                    <button
                      onClick={() => copyToClipboard(charge.pix!.copyPaste!, 'PIX copia-e-cola')}
                      className="w-full inline-flex items-center justify-center gap-2 px-3 py-2 rounded-lg border border-border text-xs font-medium hover:bg-accent"
                    >
                      <Copy size={12} /> Copiar PIX copia-e-cola
                    </button>
                  )}
                </div>
              )}

              {/* Boleto */}
              {charge.billing_type === 'BOLETO' && charge.boleto?.url && (
                <a
                  href={charge.boleto.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="w-full inline-flex items-center justify-center gap-2 px-4 py-2 rounded-lg border border-border text-sm font-medium hover:bg-accent"
                >
                  <ExternalLink size={16} /> Abrir boleto (PDF)
                </a>
              )}

              {/* Link da fatura (para qualquer billing_type) */}
              {charge.invoice_url && (
                <a
                  href={charge.invoice_url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="w-full inline-flex items-center justify-center gap-2 px-4 py-2 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90"
                >
                  <ExternalLink size={16} /> Abrir fatura no Asaas
                </a>
              )}

              <div className="text-[10px] text-muted-foreground text-center pt-2">
                Quando o cliente pagar, o sistema marca automaticamente a parcela como PAGA via webhook.
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

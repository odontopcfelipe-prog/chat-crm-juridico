'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  Wallet, Loader2, Search, AlertTriangle, CheckCircle, Clock, X, DollarSign, Phone,
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
  patient: { id: string; name: string; phone: string | null; email: string | null };
  quote: { id: string; total_value: string } | null;
  _count?: { collection_attempts: number };
}

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
    <div className="p-6 max-w-7xl mx-auto">
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
                      {i.status !== 'PAGA' && i.status !== 'CANCELADA' && i.status !== 'RENEGOCIADA' && (
                        <button
                          onClick={() => setOpenPay(i)}
                          className="text-xs inline-flex items-center gap-1 px-2 py-1 rounded bg-primary text-primary-foreground hover:bg-primary/90"
                        >
                          <DollarSign size={12} /> Receber
                        </button>
                      )}
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

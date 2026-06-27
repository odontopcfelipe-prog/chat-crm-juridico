'use client';

import { useCallback, useEffect, useState } from 'react';
import { Banknote, Loader2, Wallet, CheckCircle, Clock, AlertCircle, Gamepad2 } from 'lucide-react';
import api from '@/lib/api';
import { showError, showSuccess } from '@/lib/toast';
import ModoJogoView from './ModoJogoView';

interface SummaryRow {
  professional_user_id: string;
  professional_name: string;
  reference_month: string;
  devida: number;
  disponivel: number;
  paga: number;
  total: number;
}

interface PayableGroup {
  professional_user_id: string;
  name: string;
  total: number;
  count: number;
  commissions: Array<{
    id: string;
    amount: string;
    available_at: string | null;
    reference_month: string | null;
    patient_id: string;
    notes: string | null;
  }>;
}

const fmt = (v: number) =>
  new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(v);

export default function ComissoesPage() {
  // Onda 17.62 — abre no "Resumo mensal" (mostra a equipe) em vez de "A pagar" (vazio até
  // ter algo pago). Evita a impressão de "não aparece nada" numa clínica começando.
  const [view, setView] = useState<'summary' | 'payable' | 'jogo'>('summary');
  const [loading, setLoading] = useState(true);
  const [summary, setSummary] = useState<SummaryRow[]>([]);
  const [payable, setPayable] = useState<PayableGroup[]>([]);
  const [referenceMonth, setReferenceMonth] = useState('');
  const [paying, setPaying] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      if (view === 'summary') {
        const params = new URLSearchParams();
        if (referenceMonth) params.set('reference_month', referenceMonth);
        const { data } = await api.get<SummaryRow[]>(`/commissions/summary?${params}`);
        setSummary(data || []);
      } else {
        const { data } = await api.get<PayableGroup[]>('/commissions/payable');
        setPayable(data || []);
      }
    } catch (err: any) {
      showError(err?.response?.data?.message || 'Erro ao carregar comissoes');
    } finally {
      setLoading(false);
    }
  }, [view, referenceMonth]);

  useEffect(() => { load(); }, [load]);

  const payAll = async (group: PayableGroup) => {
    if (!confirm(
      `Marcar como pagas todas as ${group.count} comissoes de ${group.name} ` +
      `(${fmt(group.total)})?`,
    )) return;
    setPaying(group.professional_user_id);
    let ok = 0;
    let failed = 0;
    for (const c of group.commissions) {
      try {
        await api.post(`/commissions/${c.id}/pay`, { payment_method: 'PIX' });
        ok++;
      } catch {
        failed++;
      }
    }
    setPaying(null);
    if (ok > 0) showSuccess(`${ok} comissoes pagas`);
    if (failed > 0) showError(`${failed} falharam`);
    load();
  };

  return (
    <div className="h-full overflow-y-auto p-6 w-full">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-foreground flex items-center gap-2">
          <Banknote size={26} className="text-primary" /> Comissoes
        </h1>
        <p className="text-sm text-muted-foreground mt-1">
          Comissoes geradas pela execucao de procedimentos. Fluxo:
          DEVIDA &rarr; DISPONIVEL (paciente paga) &rarr; PAGA (clinica liquida).
        </p>
      </div>

      {/* Tabs */}
      <div className="flex flex-col sm:flex-row gap-2 mb-4">
        <div className="flex gap-1 bg-card border border-border rounded-lg p-1">
          <button
            onClick={() => setView('payable')}
            className={`px-3 py-1.5 rounded text-sm font-medium ${
              view === 'payable' ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            <Wallet size={14} className="inline mr-1" /> A pagar
          </button>
          <button
            onClick={() => setView('summary')}
            className={`px-3 py-1.5 rounded text-sm font-medium ${
              view === 'summary' ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            <Banknote size={14} className="inline mr-1" /> Resumo mensal
          </button>
          <button
            onClick={() => setView('jogo')}
            className={`px-3 py-1.5 rounded text-sm font-medium ${
              view === 'jogo' ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            <Gamepad2 size={14} className="inline mr-1" /> Modo jogo
          </button>
        </div>
        {view === 'summary' && (
          <input
            type="month"
            value={referenceMonth}
            onChange={(e) => setReferenceMonth(e.target.value)}
            className="px-3 py-2 rounded-lg bg-background border border-border text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
          />
        )}
      </div>

      {view === 'jogo' ? (
        <ModoJogoView />
      ) : loading ? (
        <div className="p-12 flex items-center justify-center text-muted-foreground">
          <Loader2 size={20} className="animate-spin mr-2" /> Carregando...
        </div>
      ) : view === 'payable' ? (
        <PayableView groups={payable} payAll={payAll} paying={paying} />
      ) : (
        <SummaryView rows={summary} />
      )}
    </div>
  );
}

function PayableView({
  groups, payAll, paying,
}: { groups: PayableGroup[]; payAll: (g: PayableGroup) => void; paying: string | null }) {
  if (groups.length === 0) {
    return (
      <div className="p-12 text-center text-sm text-muted-foreground">
        <CheckCircle size={28} className="mx-auto mb-2 opacity-50" />
        Nenhuma comissao disponivel para pagamento.
        <div className="mt-2 text-xs">
          Veja todos os profissionais cadastrados (mesmo zerados) na aba <strong>Resumo mensal</strong>.
        </div>
      </div>
    );
  }

  const grandTotal = groups.reduce((sum, g) => sum + g.total, 0);

  return (
    <>
      <div className="bg-card border border-border rounded-xl p-4 mb-4">
        <div className="flex items-center justify-between">
          <span className="text-sm text-muted-foreground">Total a pagar (todos profissionais)</span>
          <span className="text-2xl font-bold text-primary">{fmt(grandTotal)}</span>
        </div>
      </div>

      <div className="space-y-3">
        {groups.map((g) => (
          <div key={g.professional_user_id} className="bg-card border border-border rounded-xl p-4">
            <div className="flex items-start justify-between mb-3">
              <div>
                <h3 className="font-semibold text-foreground">{g.name}</h3>
                <p className="text-xs text-muted-foreground">
                  {g.count} comissao(oes) disponivel(eis)
                </p>
              </div>
              <div className="text-right">
                <div className="text-xl font-bold text-primary">{fmt(g.total)}</div>
                <button
                  onClick={() => payAll(g)}
                  disabled={paying === g.professional_user_id}
                  className="mt-2 inline-flex items-center gap-1 px-3 py-1.5 rounded-lg bg-primary text-primary-foreground text-xs font-medium hover:bg-primary/90 disabled:opacity-50"
                >
                  {paying === g.professional_user_id ? (
                    <Loader2 size={12} className="animate-spin" />
                  ) : (
                    <Wallet size={12} />
                  )}
                  Marcar como paga
                </button>
              </div>
            </div>

            {/* Lista compacta */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
              {g.commissions.slice(0, 6).map((c) => (
                <div
                  key={c.id}
                  className="text-xs bg-background border border-border rounded p-2 flex justify-between"
                >
                  <span>
                    {c.reference_month && <span className="text-muted-foreground">{c.reference_month} · </span>}
                    {c.notes || `Comissao ${c.id.slice(0, 8)}`}
                  </span>
                  <span className="font-mono font-semibold">{fmt(Number(c.amount))}</span>
                </div>
              ))}
              {g.commissions.length > 6 && (
                <div className="text-xs text-muted-foreground italic md:col-span-2">
                  + {g.commissions.length - 6} comissoes adicionais
                </div>
              )}
            </div>
          </div>
        ))}
      </div>
    </>
  );
}

function SummaryView({ rows }: { rows: SummaryRow[] }) {
  if (rows.length === 0) {
    return (
      <div className="p-12 text-center text-sm text-muted-foreground">
        <AlertCircle size={28} className="mx-auto mb-2 opacity-50" />
        Nenhuma comissao no periodo.
      </div>
    );
  }

  return (
    <div className="bg-card border border-border rounded-xl overflow-hidden">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-border bg-muted/30 text-left text-xs uppercase tracking-wide text-muted-foreground">
            <th className="px-3 py-2">Profissional</th>
            <th className="px-3 py-2">Mes</th>
            <th className="px-3 py-2 text-right">
              <Clock size={11} className="inline" /> Devida
            </th>
            <th className="px-3 py-2 text-right">
              <Wallet size={11} className="inline" /> Disponivel
            </th>
            <th className="px-3 py-2 text-right">
              <CheckCircle size={11} className="inline" /> Paga
            </th>
            <th className="px-3 py-2 text-right">Total</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr
              key={`${r.professional_user_id}-${r.reference_month}`}
              className="border-b border-border last:border-0 hover:bg-accent/30"
            >
              <td className="px-3 py-2 font-medium">{r.professional_name}</td>
              <td className="px-3 py-2 text-xs text-muted-foreground">{r.reference_month}</td>
              <td className="px-3 py-2 text-right font-mono text-amber-700">
                {r.devida > 0 ? fmt(r.devida) : '—'}
              </td>
              <td className="px-3 py-2 text-right font-mono text-blue-700">
                {r.disponivel > 0 ? fmt(r.disponivel) : '—'}
              </td>
              <td className="px-3 py-2 text-right font-mono text-green-700">
                {r.paga > 0 ? fmt(r.paga) : '—'}
              </td>
              <td className="px-3 py-2 text-right font-mono font-bold">
                {fmt(r.total)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

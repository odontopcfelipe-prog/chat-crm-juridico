'use client';

/**
 * "Minha comissão" — visão READ-ONLY do próprio dentista.
 *
 * Mostra SÓ a comissão de quem está logado (o backend resolve o profissional
 * pelo JWT em /commissions/mine/*). Diferente de /atendimento/comissoes (que
 * exige view_financial e mostra a equipe inteira + botão de pagar), aqui:
 *   - SEM botão "marcar como paga"
 *   - SEM coluna/agrupamento por outros profissionais
 *   - componentes próprios e simples (nada importado de comissoes/ que dependa
 *     de view_financial).
 */

import { useEffect, useState } from 'react';
import { Wallet, CheckCircle, Clock, Loader2, Banknote } from 'lucide-react';
import api from '@/lib/api';

// ─── Tipos (espelham o summary/payable do backend, só os campos usados) ──────
interface SummaryRow {
  reference_month: string;
  devida: number;
  disponivel: number;
  paga: number;
  total: number;
}

interface PayableCommission {
  id: string;
  amount: string | number;
  reference_month?: string | null;
  notes?: string | null;
  patient?: { id: string; name: string } | null;
}

interface PayableGroup {
  total: number;
  count: number;
  commissions: PayableCommission[];
}

const fmt = (v: number) =>
  new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(v || 0);

export default function MinhaComissaoPage() {
  const [loading, setLoading] = useState(true);
  const [summary, setSummary] = useState<SummaryRow[]>([]);
  const [payable, setPayable] = useState<PayableGroup[]>([]);

  useEffect(() => {
    let alive = true;
    (async () => {
      setLoading(true);
      try {
        const [s, p] = await Promise.all([
          api.get<SummaryRow[]>('/commissions/mine/summary'),
          api.get<PayableGroup[]>('/commissions/mine/payable'),
        ]);
        if (!alive) return;
        setSummary(Array.isArray(s.data) ? s.data : []);
        setPayable(Array.isArray(p.data) ? p.data : []);
      } catch {
        // READ-ONLY e tolerante: se um dos endpoints falhar, mostra vazio em vez
        // de toast de erro (a tela é informativa, não operacional).
        if (alive) {
          setSummary([]);
          setPayable([]);
        }
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => { alive = false; };
  }, []);

  // Totais consolidados de todos os meses pros cards de topo.
  const totals = summary.reduce(
    (acc, r) => {
      acc.devida += r.devida || 0;
      acc.disponivel += r.disponivel || 0;
      acc.paga += r.paga || 0;
      return acc;
    },
    { devida: 0, disponivel: 0, paga: 0 },
  );

  // Lista achatada de comissões a receber (todos os grupos vêm do MEU usuário).
  const payableItems = payable.flatMap((g) => g.commissions || []);
  const payableTotal = payable.reduce((s, g) => s + (g.total || 0), 0);

  const isEmpty =
    summary.length === 0 && payableItems.length === 0 &&
    totals.devida === 0 && totals.disponivel === 0 && totals.paga === 0;

  return (
    // RAIZ rolável: o <main> é overflow-hidden — sem h-full + overflow-y-auto a
    // página não rola.
    <div className="h-full overflow-y-auto p-6 w-full">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-foreground flex items-center gap-2">
          <Wallet size={26} className="text-primary" /> Minha comissão
        </h1>
        <p className="text-sm text-muted-foreground mt-1">
          Quanto você já ganhou e o que está a receber.
        </p>
      </div>

      {loading ? (
        <div className="p-12 flex items-center justify-center text-muted-foreground">
          <Loader2 size={20} className="animate-spin mr-2" /> Carregando...
        </div>
      ) : isEmpty ? (
        <div className="bg-card border border-border rounded-xl p-12 text-center text-sm text-muted-foreground">
          <Wallet size={28} className="mx-auto mb-2 opacity-50" />
          Você ainda não tem comissões.
        </div>
      ) : (
        <div className="space-y-6">
          {/* Cards de resumo */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <SummaryCard
              icon={<Wallet size={18} />}
              label="A receber (Disponível)"
              value={totals.disponivel}
              tone="blue"
            />
            <SummaryCard
              icon={<CheckCircle size={18} />}
              label="Já recebido (Paga)"
              value={totals.paga}
              tone="green"
            />
            <SummaryCard
              icon={<Clock size={18} />}
              label="Devida (aguardando pagamento)"
              value={totals.devida}
              tone="amber"
            />
          </div>

          {/* Tabela por mês */}
          {summary.length > 0 && (
            <section>
              <h2 className="text-sm font-semibold text-foreground mb-2 flex items-center gap-2">
                <Banknote size={16} className="text-muted-foreground" /> Por mês
              </h2>
              <div className="bg-card border border-border rounded-xl overflow-hidden">
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-border bg-muted/30 text-left text-xs uppercase tracking-wide text-muted-foreground">
                        <th className="px-3 py-2">Mês</th>
                        <th className="px-3 py-2 text-right">
                          <Clock size={11} className="inline" /> Devida
                        </th>
                        <th className="px-3 py-2 text-right">
                          <Wallet size={11} className="inline" /> Disponível
                        </th>
                        <th className="px-3 py-2 text-right">
                          <CheckCircle size={11} className="inline" /> Paga
                        </th>
                        <th className="px-3 py-2 text-right">Total</th>
                      </tr>
                    </thead>
                    <tbody>
                      {summary.map((r) => (
                        <tr
                          key={r.reference_month}
                          className="border-b border-border last:border-0 hover:bg-accent/30"
                        >
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
              </div>
            </section>
          )}

          {/* Comissões a receber (lista item a item) */}
          {payableItems.length > 0 && (
            <section>
              <h2 className="text-sm font-semibold text-foreground mb-2 flex items-center justify-between">
                <span className="flex items-center gap-2">
                  <Wallet size={16} className="text-muted-foreground" /> A receber
                </span>
                <span className="text-blue-700 font-bold">{fmt(payableTotal)}</span>
              </h2>
              <div className="bg-card border border-border rounded-xl divide-y divide-border">
                {payableItems.map((c) => (
                  <div key={c.id} className="flex items-center justify-between gap-3 p-3">
                    <div className="min-w-0">
                      <div className="text-sm text-foreground truncate">
                        {c.notes || c.patient?.name || `Comissão ${String(c.id).slice(0, 8)}`}
                      </div>
                      {(() => {
                        // Subtítulo: paciente (se já não foi o título) + mês de referência.
                        const parts = [
                          c.notes && c.patient?.name ? c.patient.name : null,
                          c.reference_month || null,
                        ].filter(Boolean);
                        return parts.length ? (
                          <div className="text-xs text-muted-foreground truncate">
                            {parts.join(' · ')}
                          </div>
                        ) : null;
                      })()}
                    </div>
                    <div className="font-mono font-semibold text-blue-700 whitespace-nowrap">
                      {fmt(Number(c.amount))}
                    </div>
                  </div>
                ))}
              </div>
            </section>
          )}
        </div>
      )}
    </div>
  );
}

function SummaryCard({
  icon, label, value, tone,
}: {
  icon: React.ReactNode;
  label: string;
  value: number;
  tone: 'blue' | 'green' | 'amber';
}) {
  const toneText =
    tone === 'green' ? 'text-green-700' : tone === 'amber' ? 'text-amber-700' : 'text-blue-700';
  return (
    <div className="bg-card border border-border rounded-xl p-4">
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <span className={toneText}>{icon}</span>
        <span>{label}</span>
      </div>
      <div className={`mt-2 text-2xl font-bold ${toneText}`}>{fmt(value)}</div>
    </div>
  );
}

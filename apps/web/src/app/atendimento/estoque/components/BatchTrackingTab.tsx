'use client';

import { useState } from 'react';
import {
  AlertTriangle, Calendar, Loader2, Package, Search, Syringe, User,
} from 'lucide-react';
import api from '@/lib/api';
import { showError } from '@/lib/toast';

interface BatchResult {
  batch_number: string;
  movements: Array<{
    id: string;
    type: string;
    quantity: string;
    expiration_date: string | null;
    performed_at: string;
    notes: string | null;
    product?: { id: string; name: string; brand: string | null; anvisa_registration: string | null } | null;
    supplier?: { id: string; name: string } | null;
  }>;
  esthetic_applications: Array<{
    id: string;
    application_point: string;
    applied_at: string;
    volume: string | null;
    unit: string | null;
    patient?: { id: string; name: string; phone: string | null; email: string | null } | null;
    product?: { id: string; name: string; brand: string | null } | null;
    adverse_reactions: Array<{ id: string; severity: string; reaction_type: string }>;
  }>;
  summary: {
    movements_count: number;
    applications_count: number;
    patients_affected: number;
    adverse_reactions_count: number;
  };
}

export default function BatchTrackingTab() {
  const [batch, setBatch] = useState('');
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<BatchResult | null>(null);

  const search = async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!batch.trim()) return;
    setLoading(true);
    setResult(null);
    try {
      const { data } = await api.get<BatchResult>(`/stock-movements/by-batch/${encodeURIComponent(batch.trim())}`);
      setResult(data);
    } catch (err: any) {
      showError(err?.response?.data?.message || 'Erro ao buscar lote');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div>
      <div className="bg-amber-500/10 border border-amber-500/20 rounded-xl p-4 mb-4 flex items-start gap-3">
        <AlertTriangle size={20} className="text-amber-600 dark:text-amber-400 shrink-0 mt-0.5" />
        <div className="text-sm">
          <p className="font-medium text-amber-700 dark:text-amber-400">Rastreabilidade reversa ANVISA</p>
          <p className="text-xs text-amber-700/80 dark:text-amber-400/80 mt-1">
            Dado um numero de lote, lista TODOS os movimentos de estoque + aplicacoes
            esteticas que usaram aquele lote, incluindo pacientes afetados e reacoes
            adversas relacionadas. Use em caso de recall, suspeita de falsificacao ou
            investigacao de evento adverso.
          </p>
        </div>
      </div>

      <form onSubmit={search} className="flex gap-2 mb-4">
        <div className="relative flex-1">
          <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <input
            type="text"
            value={batch}
            onChange={(e) => setBatch(e.target.value)}
            placeholder="Numero do lote..."
            className="w-full pl-9 pr-3 py-2 rounded-lg bg-background border border-border text-sm font-mono focus:outline-none focus:ring-2 focus:ring-primary/30"
          />
        </div>
        <button
          type="submit"
          disabled={loading || !batch.trim()}
          className="inline-flex items-center gap-2 px-6 py-2 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 disabled:opacity-50"
        >
          {loading ? <Loader2 size={16} className="animate-spin" /> : <Search size={16} />}
          Rastrear
        </button>
      </form>

      {!result && !loading && (
        <div className="p-12 text-center text-sm text-muted-foreground">
          <Search size={28} className="mx-auto mb-2 opacity-50" />
          Digite o numero do lote para iniciar a busca.
        </div>
      )}

      {result && (
        <>
          {/* Sumario */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
            <SummaryCard label="Movimentacoes" value={result.summary.movements_count} icon={Package} />
            <SummaryCard label="Aplicacoes" value={result.summary.applications_count} icon={Syringe} />
            <SummaryCard label="Pacientes" value={result.summary.patients_affected} icon={User} />
            <SummaryCard
              label="Reacoes adversas"
              value={result.summary.adverse_reactions_count}
              icon={AlertTriangle}
              danger={result.summary.adverse_reactions_count > 0}
            />
          </div>

          {result.summary.movements_count === 0 && result.summary.applications_count === 0 && (
            <div className="p-12 text-center text-sm text-muted-foreground">
              Nenhuma ocorrencia encontrada para o lote{' '}
              <span className="font-mono font-bold">{result.batch_number}</span>.
            </div>
          )}

          {/* Movimentos */}
          {result.movements.length > 0 && (
            <div className="bg-card border border-border rounded-xl overflow-hidden mb-4">
              <h3 className="font-semibold text-sm p-3 border-b border-border bg-muted/30">
                <Package size={14} className="inline mr-1" /> Movimentacoes do lote
              </h3>
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border bg-muted/10 text-left text-xs uppercase tracking-wide text-muted-foreground">
                    <th className="px-3 py-2">Data</th>
                    <th className="px-3 py-2">Tipo</th>
                    <th className="px-3 py-2">Produto</th>
                    <th className="px-3 py-2 text-right">Qtd</th>
                    <th className="px-3 py-2">Validade</th>
                    <th className="px-3 py-2">Origem</th>
                  </tr>
                </thead>
                <tbody>
                  {result.movements.map((m) => (
                    <tr key={m.id} className="border-b border-border last:border-0">
                      <td className="px-3 py-2 text-xs text-muted-foreground whitespace-nowrap">
                        {new Date(m.performed_at).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })}
                      </td>
                      <td className="px-3 py-2 text-xs">{m.type}</td>
                      <td className="px-3 py-2">
                        <div className="font-medium">{m.product?.name}</div>
                        {m.product?.anvisa_registration && (
                          <div className="text-[10px] text-muted-foreground font-mono">
                            ANVISA: {m.product.anvisa_registration}
                          </div>
                        )}
                      </td>
                      <td className="px-3 py-2 text-right font-mono">{m.quantity}</td>
                      <td className="px-3 py-2 text-xs">
                        {m.expiration_date ? new Date(m.expiration_date).toLocaleDateString('pt-BR') : '—'}
                      </td>
                      <td className="px-3 py-2 text-xs text-muted-foreground">
                        {m.supplier?.name || '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {/* Aplicacoes esteticas */}
          {result.esthetic_applications.length > 0 && (
            <div className="bg-card border border-border rounded-xl overflow-hidden">
              <h3 className="font-semibold text-sm p-3 border-b border-border bg-muted/30">
                <Syringe size={14} className="inline mr-1" /> Pacientes que receberam o lote
              </h3>
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border bg-muted/10 text-left text-xs uppercase tracking-wide text-muted-foreground">
                    <th className="px-3 py-2">Data</th>
                    <th className="px-3 py-2">Paciente</th>
                    <th className="px-3 py-2">Contato</th>
                    <th className="px-3 py-2">Ponto</th>
                    <th className="px-3 py-2 text-right">Volume</th>
                    <th className="px-3 py-2">Reacoes</th>
                  </tr>
                </thead>
                <tbody>
                  {result.esthetic_applications.map((a) => (
                    <tr key={a.id} className="border-b border-border last:border-0">
                      <td className="px-3 py-2 text-xs text-muted-foreground whitespace-nowrap">
                        {new Date(a.applied_at).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })}
                      </td>
                      <td className="px-3 py-2">
                        <div className="font-medium">{a.patient?.name || '—'}</div>
                      </td>
                      <td className="px-3 py-2 text-xs text-muted-foreground">
                        {a.patient?.phone || a.patient?.email || '—'}
                      </td>
                      <td className="px-3 py-2 text-xs">{a.application_point}</td>
                      <td className="px-3 py-2 text-right font-mono text-xs">
                        {a.volume ? `${a.volume} ${a.unit || ''}` : '—'}
                      </td>
                      <td className="px-3 py-2">
                        {a.adverse_reactions.length === 0 ? (
                          <span className="text-xs text-muted-foreground">—</span>
                        ) : (
                          <div className="flex flex-wrap gap-1">
                            {a.adverse_reactions.map((r) => (
                              <span
                                key={r.id}
                                className={`text-xs px-2 py-0.5 rounded ${
                                  r.severity === 'GRAVE' || r.severity === 'AMEACA_VIDA'
                                    ? 'bg-destructive/20 text-destructive'
                                    : 'bg-amber-500/20 text-amber-700'
                                }`}
                              >
                                {r.reaction_type} ({r.severity})
                              </span>
                            ))}
                          </div>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function SummaryCard({
  label, value, icon: Icon, danger = false,
}: { label: string; value: number; icon: any; danger?: boolean }) {
  return (
    <div
      className={`bg-card border rounded-xl p-3 ${
        danger && value > 0 ? 'border-destructive/40 bg-destructive/5' : 'border-border'
      }`}
    >
      <div className="flex items-center gap-2 text-xs uppercase tracking-wide text-muted-foreground mb-1">
        <Icon size={12} /> {label}
      </div>
      <p className={`text-2xl font-bold ${danger && value > 0 ? 'text-destructive' : 'text-foreground'}`}>
        {value}
      </p>
    </div>
  );
}

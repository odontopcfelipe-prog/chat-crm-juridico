'use client';

/**
 * Aba "Validar" do Financeiro — fila central de tratamentos aceitos aguardando a
 * liberação do Financeiro (gate Financeiro→Tratamento). Validar aqui é a MESMA ação
 * do botão por-paciente: seta validated_by_financial_at e libera o dentista a confirmar
 * os procedimentos no Tratamento. Só pra quem tem manage_financial (gate no backend tb).
 */
import { useEffect, useState, useCallback } from 'react';
import { Loader2, CheckCircle2, RefreshCw } from 'lucide-react';
import api from '@/lib/api';
import { showError, showSuccess } from '@/lib/toast';

interface PendingPlan {
  plan_id: string;
  patient_id: string;
  patient_name: string | null;
  patient_phone: string | null;
  quote_title: string | null;
  accepted_at: string | null;
  total: number;
  items_count: number;
}

const fmtBRL = (v: number) =>
  (Number(v) || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export default function ValidarTab() {
  const [plans, setPlans] = useState<PendingPlan[]>([]);
  const [loading, setLoading] = useState(true);
  const [validatingId, setValidatingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const { data } = await api.get<PendingPlan[]>('/treatment-plans/pending-validation');
      setPlans(Array.isArray(data) ? data : []);
    } catch (e: unknown) {
      const err = e as { response?: { data?: { message?: string } } };
      showError(err?.response?.data?.message || 'Erro ao carregar tratamentos pendentes');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const validate = async (p: PendingPlan) => {
    const ok = window.confirm(
      `Validar o tratamento de ${p.patient_name || 'paciente'} (R$ ${fmtBRL(p.total)})?\n\n` +
      'Confirme que a negociação está certa. Isso libera o dentista a confirmar os procedimentos no Tratamento.',
    );
    if (!ok) return;
    setValidatingId(p.plan_id);
    try {
      await api.post(`/treatment-plans/${p.plan_id}/validate`);
      showSuccess('Tratamento liberado pro dentista.');
      setPlans((prev) => prev.filter((x) => x.plan_id !== p.plan_id));
    } catch (e: unknown) {
      const err = e as { response?: { data?: { message?: string } } };
      showError(err?.response?.data?.message || 'Erro ao validar');
    } finally {
      setValidatingId(null);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-16 text-muted-foreground">
        <Loader2 size={20} className="animate-spin mr-2" /> Carregando tratamentos…
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          {plans.length} tratamento(s) aguardando validação
        </p>
        <button
          onClick={load}
          className="p-2 rounded-lg text-muted-foreground hover:text-foreground hover:bg-accent"
          title="Atualizar"
        >
          <RefreshCw size={14} />
        </button>
      </div>

      {plans.length === 0 ? (
        <div className="rounded-xl border border-border bg-card px-4 py-12 text-center text-muted-foreground">
          <CheckCircle2 size={32} className="mx-auto mb-2 opacity-40" />
          <p className="text-sm font-medium">Nenhum tratamento aguardando validação</p>
          <p className="text-xs mt-1">
            Quando um orçamento é encaminhado ao financeiro, ele aparece aqui pra você conferir
            e liberar pro dentista confirmar os procedimentos.
          </p>
        </div>
      ) : (
        <div className="bg-card border border-border rounded-xl overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-muted-foreground text-xs uppercase">
              <tr>
                <th className="text-left px-4 py-2 font-medium">Paciente</th>
                <th className="text-left px-4 py-2 font-medium">Aceito em</th>
                <th className="text-right px-4 py-2 font-medium">Valor</th>
                <th className="text-right px-4 py-2 font-medium">Ação</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {plans.map((p) => (
                <tr key={p.plan_id} className="hover:bg-muted/30">
                  <td className="px-4 py-3">
                    <div className="font-medium">{p.patient_name || 'Sem nome'}</div>
                    <div className="text-xs text-muted-foreground">
                      {p.quote_title || ''}
                      {p.items_count ? `${p.quote_title ? ' · ' : ''}${p.items_count} item(ns)` : ''}
                    </div>
                  </td>
                  <td className="px-4 py-3 text-xs text-muted-foreground">
                    {p.accepted_at ? new Date(p.accepted_at).toLocaleDateString('pt-BR') : '—'}
                  </td>
                  <td className="px-4 py-3 text-right font-semibold tabular-nums">R$ {fmtBRL(p.total)}</td>
                  <td className="px-4 py-3 text-right">
                    <button
                      onClick={() => validate(p)}
                      disabled={validatingId === p.plan_id}
                      className="text-xs px-3 py-1.5 rounded-md border border-blue-500/40 bg-blue-500/10 hover:bg-blue-500/20 text-blue-700 dark:text-blue-400 inline-flex items-center gap-1.5 font-bold transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                      title="Validar a negociação e liberar o tratamento pro dentista confirmar"
                    >
                      {validatingId === p.plan_id
                        ? <Loader2 size={12} className="animate-spin" />
                        : <CheckCircle2 size={12} />}
                      Validar
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

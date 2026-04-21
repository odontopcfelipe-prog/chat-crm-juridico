'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  CheckSquare, Bell, Wallet, Target, Loader2, ChevronRight, AlertTriangle,
} from 'lucide-react';
import api from '@/lib/api';

/**
 * Painel "Tarefas do dia" — agrega 4 fontes de pendencia em um unico card
 * para a recepcao/gestor saber o que precisa ser feito hoje sem clicar
 * em multiplos menus.
 *
 * Fontes:
 *  1. Retornos vencidos ou de hoje (PENDENTE)            → /return-alerts/pending-now
 *  2. Confirmacoes de agendamento sem resposta           → /appointment-confirmations/pending
 *  3. Comissoes disponiveis para pagamento (gestor)      → /commissions/payable
 *  4. Metas em vigor com baixo progresso                 → /goals/active
 */

interface ReturnAlert { id: string; patient: { name: string }; scheduled_for: string; }
interface PendingConfirmation { id: string; appointment: { id: string; title: string; start_at: string; patient: { name: string } | null } | null; }
interface PayableGroup { professional_user_id: string; name: string; total: number; count: number; }
interface Goal {
  id: string;
  metric: string;
  target_value: string;
  current_value: string | null;
  direction: string;
  professional?: { name: string } | null;
}

const fmt = (v: number) =>
  new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(v);

const METRIC_LABEL: Record<string, string> = {
  SALES_VALUE: 'Vendas',
  FIRST_CONSULTATIONS: 'Primeiras consultas',
  MISSES_PCT: 'Faltas',
  OCCUPATION_PCT: 'Ocupacao',
  NEW_PATIENTS: 'Novos pacientes',
  CONVERSIONS: 'Conversao',
};

export function TodaysTasks() {
  const router = useRouter();
  const [loading, setLoading] = useState(true);
  const [returnAlerts, setReturnAlerts] = useState<ReturnAlert[]>([]);
  const [confirmations, setConfirmations] = useState<PendingConfirmation[]>([]);
  const [payable, setPayable] = useState<PayableGroup[]>([]);
  const [goals, setGoals] = useState<Goal[]>([]);

  const load = useCallback(async () => {
    setLoading(true);
    const safe = async <T,>(p: Promise<{ data: T }>): Promise<T | null> => {
      try { return (await p).data; } catch { return null; }
    };
    const [ra, pc, py, gs] = await Promise.all([
      safe(api.get<ReturnAlert[]>('/return-alerts/pending-now')),
      safe(api.get<PendingConfirmation[]>('/appointment-confirmations/pending')),
      safe(api.get<PayableGroup[]>('/commissions/payable')),
      safe(api.get<Goal[]>('/goals/active')),
    ]);
    setReturnAlerts(ra || []);
    setConfirmations(pc || []);
    setPayable(py || []);
    setGoals(gs || []);
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  const totalPayable = payable.reduce((sum, g) => sum + g.total, 0);

  // Metas em risco: progresso < 50% para ACHIEVE ou > 80% para LIMIT
  const criticalGoals = goals.filter((g) => {
    const target = Number(g.target_value);
    const current = Number(g.current_value || 0);
    const pct = target > 0 ? (current / target) * 100 : 0;
    return g.direction === 'ACHIEVE' ? pct < 50 : pct > 80;
  });

  const totalTasks =
    returnAlerts.length + confirmations.length +
    (totalPayable > 0 ? 1 : 0) + criticalGoals.length;

  return (
    <div className="bg-card border border-border rounded-xl p-4">
      <div className="flex items-center justify-between mb-3">
        <h3 className="font-semibold text-foreground flex items-center gap-2">
          <CheckSquare size={16} className="text-primary" />
          Tarefas do dia
          {totalTasks > 0 && (
            <span className="text-xs px-2 py-0.5 rounded-full bg-primary text-primary-foreground">
              {totalTasks}
            </span>
          )}
        </h3>
      </div>

      {loading ? (
        <div className="py-8 flex items-center justify-center text-muted-foreground">
          <Loader2 size={16} className="animate-spin mr-2" /> Carregando...
        </div>
      ) : totalTasks === 0 ? (
        <div className="py-8 text-center text-sm text-muted-foreground">
          <CheckSquare size={28} className="mx-auto mb-2 opacity-50 text-green-600" />
          Tudo em dia! Nenhuma tarefa pendente.
        </div>
      ) : (
        <ul className="space-y-2">
          {/* Retornos pendentes */}
          {returnAlerts.length > 0 && (
            <li>
              <button
                onClick={() => router.push('/atendimento/return-alerts')}
                className="w-full text-left flex items-center gap-3 p-3 rounded-lg bg-amber-500/10 border border-amber-500/20 hover:bg-amber-500/15"
              >
                <Bell size={18} className="text-amber-600 shrink-0" />
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium">
                    {returnAlerts.length} {returnAlerts.length === 1 ? 'retorno pendente' : 'retornos pendentes'}
                  </p>
                  <p className="text-xs text-muted-foreground truncate">
                    {returnAlerts.slice(0, 2).map((a) => a.patient.name).join(', ')}
                    {returnAlerts.length > 2 && ` +${returnAlerts.length - 2}`}
                  </p>
                </div>
                <ChevronRight size={14} className="text-muted-foreground shrink-0" />
              </button>
            </li>
          )}

          {/* Confirmacoes pendentes */}
          {confirmations.length > 0 && (
            <li>
              <button
                onClick={() => router.push('/atendimento/agenda')}
                className="w-full text-left flex items-center gap-3 p-3 rounded-lg bg-blue-500/10 border border-blue-500/20 hover:bg-blue-500/15"
              >
                <CheckSquare size={18} className="text-blue-600 shrink-0" />
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium">
                    {confirmations.length} {confirmations.length === 1 ? 'agendamento aguardando confirmacao' : 'agendamentos aguardando confirmacao'}
                  </p>
                  <p className="text-xs text-muted-foreground truncate">
                    Pacientes nao responderam ao envio de confirmacao
                  </p>
                </div>
                <ChevronRight size={14} className="text-muted-foreground shrink-0" />
              </button>
            </li>
          )}

          {/* Comissoes a pagar */}
          {totalPayable > 0 && (
            <li>
              <button
                onClick={() => router.push('/atendimento/comissoes')}
                className="w-full text-left flex items-center gap-3 p-3 rounded-lg bg-green-500/10 border border-green-500/20 hover:bg-green-500/15"
              >
                <Wallet size={18} className="text-green-600 shrink-0" />
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium">
                    Comissoes a pagar: <span className="font-bold">{fmt(totalPayable)}</span>
                  </p>
                  <p className="text-xs text-muted-foreground truncate">
                    {payable.length} {payable.length === 1 ? 'profissional aguardando' : 'profissionais aguardando'}
                  </p>
                </div>
                <ChevronRight size={14} className="text-muted-foreground shrink-0" />
              </button>
            </li>
          )}

          {/* Metas criticas */}
          {criticalGoals.length > 0 && (
            <li>
              <button
                onClick={() => router.push('/atendimento/metas')}
                className="w-full text-left flex items-center gap-3 p-3 rounded-lg bg-red-500/10 border border-red-500/20 hover:bg-red-500/15"
              >
                <AlertTriangle size={18} className="text-red-600 shrink-0" />
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium">
                    {criticalGoals.length} {criticalGoals.length === 1 ? 'meta em alerta' : 'metas em alerta'}
                  </p>
                  <p className="text-xs text-muted-foreground truncate">
                    {criticalGoals.slice(0, 2).map((g) => METRIC_LABEL[g.metric] || g.metric).join(', ')}
                    {criticalGoals.length > 2 && ` +${criticalGoals.length - 2}`}
                  </p>
                </div>
                <ChevronRight size={14} className="text-muted-foreground shrink-0" />
              </button>
            </li>
          )}
        </ul>
      )}
    </div>
  );
}

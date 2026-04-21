'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  Target, Loader2, Plus, X, RefreshCw, TrendingUp, TrendingDown, Trash2,
} from 'lucide-react';
import api from '@/lib/api';
import { showError, showSuccess } from '@/lib/toast';

interface Goal {
  id: string;
  metric: string;
  scope: string;
  professional_user_id: string | null;
  direction: string;
  target_value: string;
  period_type: string;
  period_start: string;
  period_end: string;
  current_value: string | null;
  projected_value: string | null;
  last_calculated_at: string | null;
  active: boolean;
  notes: string | null;
  professional?: { id: string; name: string } | null;
}

const METRIC_LABELS: Record<string, string> = {
  SALES_VALUE:           'Vendas (R$)',
  FIRST_CONSULTATIONS:   'Primeiras consultas',
  MISSES_PCT:            'Faltas (%)',
  OCCUPATION_PCT:        'Ocupacao da agenda (%)',
  NEW_PATIENTS:          'Novos pacientes',
  CONVERSIONS:           'Conversao de orcamento (%)',
  CUSTOM:                'Personalizada',
};

const METRIC_FORMATTERS: Record<string, (v: number) => string> = {
  SALES_VALUE:    (v) => new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(v),
  MISSES_PCT:     (v) => `${v.toFixed(1)}%`,
  OCCUPATION_PCT: (v) => `${v.toFixed(1)}%`,
  CONVERSIONS:    (v) => `${v.toFixed(1)}%`,
};
const fmtMetric = (metric: string, value: number) => {
  const fn = METRIC_FORMATTERS[metric];
  return fn ? fn(value) : Math.round(value).toLocaleString('pt-BR');
};

export default function MetasPage() {
  const [loading, setLoading] = useState(true);
  const [goals, setGoals] = useState<Goal[]>([]);
  const [view, setView] = useState<'active' | 'all'>('active');
  const [openModal, setOpenModal] = useState(false);
  const [recalcAll, setRecalcAll] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const url = view === 'active' ? '/goals/active' : '/goals';
      const { data } = await api.get<Goal[]>(url);
      setGoals(data || []);
    } catch (err: any) {
      showError(err?.response?.data?.message || 'Erro ao carregar metas');
    } finally {
      setLoading(false);
    }
  }, [view]);

  useEffect(() => { load(); }, [load]);

  const recalculate = async (id: string) => {
    try {
      await api.post(`/goals/${id}/recalculate`);
      load();
    } catch (err: any) {
      showError(err?.response?.data?.message || 'Erro ao recalcular');
    }
  };

  const recalculateAll = async () => {
    setRecalcAll(true);
    try {
      const { data } = await api.post('/goals/recalculate-all');
      showSuccess(`${data.ok} metas recalculadas (${data.failed} falhas)`);
      load();
    } catch (err: any) {
      showError(err?.response?.data?.message || 'Erro');
    } finally {
      setRecalcAll(false);
    }
  };

  const remove = async (id: string) => {
    if (!confirm('Excluir esta meta? Esta acao nao pode ser desfeita.')) return;
    try {
      await api.delete(`/goals/${id}`);
      showSuccess('Meta excluida');
      load();
    } catch (err: any) {
      showError(err?.response?.data?.message || 'Erro ao excluir');
    }
  };

  return (
    <div className="p-6 max-w-7xl mx-auto">
      <div className="mb-6 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-foreground flex items-center gap-2">
            <Target size={26} className="text-primary" /> Metas
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            Metas com projecao "no ritmo atual" — vendas, primeiras consultas,
            faltas, ocupacao, novos pacientes, conversao.
          </p>
        </div>
        <div className="flex gap-2">
          <button
            onClick={recalculateAll}
            disabled={recalcAll}
            className="inline-flex items-center gap-1 px-3 py-2 rounded-lg border border-border text-sm hover:bg-accent disabled:opacity-50"
          >
            {recalcAll ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
            Recalcular tudo
          </button>
          <button
            onClick={() => setOpenModal(true)}
            className="inline-flex items-center gap-1 px-4 py-2 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90"
          >
            <Plus size={16} /> Nova meta
          </button>
        </div>
      </div>

      <div className="flex gap-1 bg-card border border-border rounded-lg p-1 mb-4 w-fit">
        <button
          onClick={() => setView('active')}
          className={`px-3 py-1.5 rounded text-sm font-medium ${
            view === 'active' ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground'
          }`}
        >
          Em vigor
        </button>
        <button
          onClick={() => setView('all')}
          className={`px-3 py-1.5 rounded text-sm font-medium ${
            view === 'all' ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground'
          }`}
        >
          Todas
        </button>
      </div>

      {loading ? (
        <div className="p-12 flex items-center justify-center text-muted-foreground">
          <Loader2 size={20} className="animate-spin mr-2" /> Carregando...
        </div>
      ) : goals.length === 0 ? (
        <div className="p-12 text-center text-sm text-muted-foreground">
          <Target size={28} className="mx-auto mb-2 opacity-50" />
          Nenhuma meta {view === 'active' ? 'em vigor' : 'cadastrada'}.
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {goals.map((g) => (
            <GoalCard
              key={g.id}
              goal={g}
              onRecalculate={() => recalculate(g.id)}
              onDelete={() => remove(g.id)}
            />
          ))}
        </div>
      )}

      {openModal && (
        <NewGoalModal
          onClose={() => setOpenModal(false)}
          onCreated={() => { setOpenModal(false); load(); }}
        />
      )}
    </div>
  );
}

function GoalCard({
  goal, onRecalculate, onDelete,
}: { goal: Goal; onRecalculate: () => void; onDelete: () => void }) {
  const target = Number(goal.target_value);
  const current = Number(goal.current_value || 0);
  const projected = Number(goal.projected_value || 0);
  const pct = target > 0 ? (current / target) * 100 : 0;
  const projectedPct = target > 0 ? (projected / target) * 100 : 0;

  const isAchieve = goal.direction === 'ACHIEVE';
  // Para ACHIEVE: progresso bom = verde acima de 80%
  // Para LIMIT (faltas): progresso bom = verde abaixo de 50% do limite
  const status: 'good' | 'warn' | 'bad' = isAchieve
    ? pct >= 80 ? 'good' : pct >= 50 ? 'warn' : 'bad'
    : pct < 50 ? 'good' : pct < 80 ? 'warn' : 'bad';

  const barColor = status === 'good' ? 'bg-green-500' : status === 'warn' ? 'bg-amber-500' : 'bg-red-500';
  const textColor = status === 'good' ? 'text-green-700' : status === 'warn' ? 'text-amber-700' : 'text-red-700';

  return (
    <div className="bg-card border border-border rounded-xl p-4">
      <div className="flex items-start justify-between mb-2">
        <div>
          <h3 className="font-semibold text-foreground">{METRIC_LABELS[goal.metric] || goal.metric}</h3>
          <p className="text-xs text-muted-foreground">
            {goal.scope === 'PROFESSIONAL' && goal.professional?.name ? `${goal.professional.name} · ` : 'Clinica · '}
            {new Date(goal.period_start).toLocaleDateString('pt-BR')} a {new Date(goal.period_end).toLocaleDateString('pt-BR')}
          </p>
        </div>
        <div className="flex gap-1">
          <button
            onClick={onRecalculate}
            className="p-1.5 rounded hover:bg-accent"
            title="Recalcular"
          >
            <RefreshCw size={14} />
          </button>
          <button
            onClick={onDelete}
            className="p-1.5 rounded hover:bg-destructive/10 text-destructive"
            title="Excluir"
          >
            <Trash2 size={14} />
          </button>
        </div>
      </div>

      <div className="mt-3">
        <div className="flex items-baseline justify-between mb-1">
          <span className={`text-xl font-bold ${textColor}`}>
            {fmtMetric(goal.metric, current)}
          </span>
          <span className="text-xs text-muted-foreground">
            / {fmtMetric(goal.metric, target)} ({pct.toFixed(0)}%)
          </span>
        </div>

        {/* Barra de progresso */}
        <div className="h-2 bg-muted rounded-full overflow-hidden">
          <div
            className={`h-full ${barColor} transition-all`}
            style={{ width: `${Math.min(100, pct)}%` }}
          />
        </div>

        {/* Projecao */}
        {goal.projected_value && projected !== current && (
          <div className="mt-2 text-xs text-muted-foreground flex items-center gap-1">
            {isAchieve ? (
              projectedPct >= 100 ? <TrendingUp size={12} className="text-green-600" /> : <TrendingDown size={12} className="text-amber-600" />
            ) : (
              projectedPct >= 100 ? <TrendingDown size={12} className="text-red-600" /> : <TrendingUp size={12} className="text-green-600" />
            )}
            <span>
              No ritmo atual: <strong>{fmtMetric(goal.metric, projected)}</strong>
              {' '}({projectedPct.toFixed(0)}% da meta)
            </span>
          </div>
        )}

        {goal.last_calculated_at && (
          <p className="text-[10px] text-muted-foreground mt-1">
            Calculado em {new Date(goal.last_calculated_at).toLocaleString('pt-BR')}
          </p>
        )}
      </div>
    </div>
  );
}

function NewGoalModal({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [saving, setSaving] = useState(false);
  const [metric, setMetric] = useState('SALES_VALUE');
  const [scope, setScope] = useState('CLINIC');
  const [direction, setDirection] = useState('ACHIEVE');
  const [targetValue, setTargetValue] = useState('');
  const [periodType, setPeriodType] = useState('MONTHLY');

  // Default period: mes atual
  const today = new Date();
  const [periodStart, setPeriodStart] = useState(
    new Date(today.getFullYear(), today.getMonth(), 1).toISOString().slice(0, 10),
  );
  const [periodEnd, setPeriodEnd] = useState(
    new Date(today.getFullYear(), today.getMonth() + 1, 0).toISOString().slice(0, 10),
  );

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!targetValue || parseFloat(targetValue) <= 0) {
      showError('Valor alvo deve ser positivo');
      return;
    }
    setSaving(true);
    try {
      await api.post('/goals', {
        metric,
        scope,
        direction,
        target_value: parseFloat(targetValue),
        period_type: periodType,
        period_start: new Date(periodStart).toISOString(),
        period_end: new Date(periodEnd + 'T23:59:59').toISOString(),
      });
      showSuccess('Meta criada');
      onCreated();
    } catch (err: any) {
      showError(err?.response?.data?.message || 'Erro ao criar');
    } finally {
      setSaving(false);
    }
  };

  // Auto-direction baseado em metric
  useEffect(() => {
    setDirection(metric === 'MISSES_PCT' ? 'LIMIT' : 'ACHIEVE');
  }, [metric]);

  return (
    <div
      className="fixed inset-0 z-[100] bg-black/50 backdrop-blur-sm flex items-center justify-center p-4"
      onClick={onClose}
    >
      <div
        className="bg-card border border-border rounded-xl w-full max-w-lg shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between p-4 border-b border-border">
          <h2 className="text-lg font-semibold flex items-center gap-2">
            <Target size={20} className="text-primary" /> Nova meta
          </h2>
          <button onClick={onClose} className="p-1 hover:bg-accent rounded">
            <X size={18} />
          </button>
        </div>

        <form onSubmit={submit} className="p-4 space-y-3">
          <div>
            <label className="block text-xs font-medium mb-1">Metrica *</label>
            <select
              value={metric}
              onChange={(e) => setMetric(e.target.value)}
              className="w-full px-3 py-2 rounded-lg bg-background border border-border text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
            >
              {Object.entries(METRIC_LABELS).map(([v, l]) => (
                <option key={v} value={v}>{l}</option>
              ))}
            </select>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium mb-1">Escopo</label>
              <select
                value={scope}
                onChange={(e) => setScope(e.target.value)}
                className="w-full px-3 py-2 rounded-lg bg-background border border-border text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
              >
                <option value="CLINIC">Clinica (todos)</option>
                <option value="PROFESSIONAL">Por profissional</option>
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium mb-1">Direcao</label>
              <select
                value={direction}
                onChange={(e) => setDirection(e.target.value)}
                className="w-full px-3 py-2 rounded-lg bg-background border border-border text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
              >
                <option value="ACHIEVE">Atingir (mais e melhor)</option>
                <option value="LIMIT">Nao ultrapassar (menos e melhor)</option>
              </select>
            </div>
          </div>

          <div>
            <label className="block text-xs font-medium mb-1">Valor alvo *</label>
            <input
              type="number"
              step="0.01"
              value={targetValue}
              onChange={(e) => setTargetValue(e.target.value)}
              placeholder={metric === 'SALES_VALUE' ? '100000.00' : '50'}
              required
              className="w-full px-3 py-2 rounded-lg bg-background border border-border text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
            />
          </div>

          <div className="grid grid-cols-3 gap-3">
            <div>
              <label className="block text-xs font-medium mb-1">Periodo</label>
              <select
                value={periodType}
                onChange={(e) => setPeriodType(e.target.value)}
                className="w-full px-3 py-2 rounded-lg bg-background border border-border text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
              >
                <option value="DAILY">Diario</option>
                <option value="WEEKLY">Semanal</option>
                <option value="MONTHLY">Mensal</option>
                <option value="QUARTERLY">Trimestral</option>
                <option value="YEARLY">Anual</option>
                <option value="CUSTOM">Customizado</option>
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium mb-1">Inicio</label>
              <input
                type="date"
                value={periodStart}
                onChange={(e) => setPeriodStart(e.target.value)}
                className="w-full px-3 py-2 rounded-lg bg-background border border-border text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
              />
            </div>
            <div>
              <label className="block text-xs font-medium mb-1">Fim</label>
              <input
                type="date"
                value={periodEnd}
                onChange={(e) => setPeriodEnd(e.target.value)}
                className="w-full px-3 py-2 rounded-lg bg-background border border-border text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
              />
            </div>
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
              {saving ? <Loader2 size={16} className="animate-spin" /> : <Plus size={16} />}
              Criar meta
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

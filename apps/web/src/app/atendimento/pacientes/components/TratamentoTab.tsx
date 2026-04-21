'use client';

import { useEffect, useState, useCallback } from 'react';
import { Loader2, ClipboardList, ArrowLeft, Check, CheckCircle2, Circle, XCircle, Play } from 'lucide-react';
import api from '@/lib/api';
import { showError, showSuccess } from '@/lib/toast';

interface Props {
  patientId: string;
}

type PlanStatus = 'PENDING_SIGNATURE' | 'ACTIVE' | 'PAUSED' | 'COMPLETED' | 'CANCELLED';
type ItemStatus = 'PENDING' | 'SCHEDULED' | 'IN_PROGRESS' | 'DONE' | 'CANCELLED';

interface PlanItem {
  id: string;
  procedure_id: string;
  tooth_fdi: string | null;
  quantity: number;
  unit_price: string | number;
  total_price: string | number;
  status: ItemStatus;
  scheduled_at: string | null;
  executed_at: string | null;
  notes: string | null;
  procedure?: { id: string; name: string };
  executed_by?: { id: string; name: string } | null;
}

interface PlanListItem {
  id: string;
  status: PlanStatus;
  total_value: string | number;
  created_at: string;
  start_date: string | null;
  end_date: string | null;
  _count?: { items: number };
}

interface PlanDetail extends PlanListItem {
  estimated_sessions: number | null;
  notes: string | null;
  items: PlanItem[];
  quote: { id: string; created_at: string } | null;
}

const PLAN_BADGE: Record<PlanStatus, string> = {
  PENDING_SIGNATURE: 'bg-amber-500/10 text-amber-600 border-amber-500/20',
  ACTIVE: 'bg-emerald-500/10 text-emerald-600 border-emerald-500/20',
  PAUSED: 'bg-muted text-muted-foreground border-border',
  COMPLETED: 'bg-blue-500/10 text-blue-600 border-blue-500/20',
  CANCELLED: 'bg-destructive/10 text-destructive border-destructive/20',
};

const PLAN_LABEL: Record<PlanStatus, string> = {
  PENDING_SIGNATURE: 'Aguardando assinatura',
  ACTIVE: 'Ativo',
  PAUSED: 'Pausado',
  COMPLETED: 'Concluído',
  CANCELLED: 'Cancelado',
};

const ITEM_ICON: Record<ItemStatus, { icon: React.ElementType; cls: string }> = {
  PENDING: { icon: Circle, cls: 'text-muted-foreground' },
  SCHEDULED: { icon: Circle, cls: 'text-blue-500' },
  IN_PROGRESS: { icon: Play, cls: 'text-amber-500' },
  DONE: { icon: CheckCircle2, cls: 'text-emerald-500' },
  CANCELLED: { icon: XCircle, cls: 'text-destructive' },
};

export default function TratamentoTab({ patientId }: Props) {
  const [list, setList] = useState<PlanListItem[]>([]);
  const [current, setCurrent] = useState<PlanDetail | null>(null);
  const [mode, setMode] = useState<'list' | 'detail'>('list');
  const [loading, setLoading] = useState(true);

  const loadList = useCallback(async () => {
    setLoading(true);
    try {
      const { data } = await api.get<PlanListItem[]>(`/patients/${patientId}/treatment-plans`);
      setList(data);
    } catch (err: any) {
      showError(err?.response?.data?.message || 'Erro ao carregar planos');
    } finally {
      setLoading(false);
    }
  }, [patientId]);

  useEffect(() => { loadList(); }, [loadList]);

  const openDetail = async (id: string) => {
    try {
      const { data } = await api.get<PlanDetail>(`/treatment-plans/${id}`);
      setCurrent(data);
      setMode('detail');
    } catch (err: any) {
      showError(err?.response?.data?.message || 'Erro ao carregar plano');
    }
  };

  if (loading) {
    return (
      <div className="py-12 flex items-center justify-center text-muted-foreground">
        <Loader2 size={18} className="animate-spin mr-2" /> Carregando...
      </div>
    );
  }

  if (mode === 'detail' && current) {
    return (
      <PlanDetailView
        plan={current}
        onBack={() => { setMode('list'); setCurrent(null); loadList(); }}
        onReload={async () => {
          const { data } = await api.get<PlanDetail>(`/treatment-plans/${current.id}`);
          setCurrent(data);
        }}
      />
    );
  }

  return (
    <div>
      <p className="text-sm text-muted-foreground mb-3">{list.length} plano(s) de tratamento</p>

      {list.length === 0 ? (
        <div className="bg-card border border-border border-dashed rounded-xl p-8 text-center">
          <ClipboardList size={32} className="mx-auto text-muted-foreground mb-2" />
          <p className="text-muted-foreground text-sm">Nenhum plano de tratamento ainda.</p>
          <p className="text-xs text-muted-foreground mt-1">
            Planos são criados automaticamente ao aceitar um orçamento.
          </p>
        </div>
      ) : (
        <ul className="bg-card border border-border rounded-xl divide-y divide-border">
          {list.map((p) => (
            <li
              key={p.id}
              onClick={() => openDetail(p.id)}
              className="px-4 py-3 hover:bg-accent/40 cursor-pointer flex items-center gap-3"
            >
              <ClipboardList size={18} className="text-primary shrink-0" />
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-foreground">
                  R$ {Number(p.total_value).toFixed(2)}
                  {p._count && <span className="text-xs text-muted-foreground ml-2">({p._count.items} procedimentos)</span>}
                </p>
                <p className="text-xs text-muted-foreground">
                  Criado em {new Date(p.created_at).toLocaleDateString('pt-BR')}
                  {p.start_date && ` · Iniciado em ${new Date(p.start_date).toLocaleDateString('pt-BR')}`}
                </p>
              </div>
              <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium border ${PLAN_BADGE[p.status]}`}>
                {PLAN_LABEL[p.status]}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function PlanDetailView({
  plan, onBack, onReload,
}: {
  plan: PlanDetail;
  onBack: () => void;
  onReload: () => Promise<void>;
}) {
  const [saving, setSaving] = useState(false);

  const isPending = plan.status === 'PENDING_SIGNATURE';
  const isActive = plan.status === 'ACTIVE';

  const activate = async () => {
    if (!confirm('Ativar plano? Isso marca como ACTIVE e registra a data de início.')) return;
    setSaving(true);
    try {
      await api.post(`/treatment-plans/${plan.id}/activate`);
      showSuccess('Plano ativado');
      await onReload();
    } catch (err: any) {
      showError(err?.response?.data?.message || 'Erro ao ativar');
    } finally {
      setSaving(false);
    }
  };

  const completePlan = async () => {
    if (!confirm('Marcar plano como concluído? Todos os itens devem estar DONE ou CANCELLED.')) return;
    setSaving(true);
    try {
      await api.post(`/treatment-plans/${plan.id}/complete`);
      showSuccess('Plano concluído');
      await onReload();
    } catch (err: any) {
      showError(err?.response?.data?.message || 'Erro ao concluir');
    } finally {
      setSaving(false);
    }
  };

  const executeItem = async (itemId: string) => {
    if (!confirm('Marcar procedimento como executado?')) return;
    try {
      await api.post(`/treatment-plan-items/${itemId}/execute`);
      showSuccess('Procedimento executado');
      await onReload();
    } catch (err: any) {
      showError(err?.response?.data?.message || 'Erro ao executar');
    }
  };

  const updateItemStatus = async (itemId: string, status: ItemStatus) => {
    try {
      await api.patch(`/treatment-plan-items/${itemId}`, { status });
      await onReload();
    } catch (err: any) {
      showError(err?.response?.data?.message || 'Erro ao atualizar');
    }
  };

  const doneItems = plan.items.filter((i) => i.status === 'DONE').length;
  const totalItems = plan.items.length;
  const progress = totalItems === 0 ? 0 : Math.round((doneItems / totalItems) * 100);

  return (
    <div>
      <div className="flex items-center justify-between mb-3">
        <button onClick={onBack} className="text-sm text-muted-foreground hover:text-foreground flex items-center gap-1">
          <ArrowLeft size={14} /> Voltar à lista
        </button>
        <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium border ${PLAN_BADGE[plan.status]}`}>
          {PLAN_LABEL[plan.status]}
        </span>
      </div>

      {/* Resumo */}
      <div className="bg-card border border-border rounded-xl p-4 mb-4">
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm mb-3">
          <div>
            <p className="text-xs text-muted-foreground">Total</p>
            <p className="text-xl font-bold text-primary">R$ {Number(plan.total_value).toFixed(2)}</p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">Início</p>
            <p>{plan.start_date ? new Date(plan.start_date).toLocaleDateString('pt-BR') : '—'}</p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">Progresso</p>
            <p className="font-semibold">{doneItems}/{totalItems} ({progress}%)</p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">Sessões estimadas</p>
            <p>{plan.estimated_sessions || '—'}</p>
          </div>
        </div>
        {totalItems > 0 && (
          <div className="w-full h-2 rounded-full bg-muted overflow-hidden">
            <div
              className="h-full bg-primary transition-all"
              style={{ width: `${progress}%` }}
            />
          </div>
        )}
      </div>

      {/* Ações */}
      <div className="flex flex-wrap gap-2 mb-4">
        {isPending && (
          <button
            onClick={activate}
            disabled={saving}
            className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg bg-emerald-500 text-white text-sm hover:bg-emerald-600 disabled:opacity-50"
          >
            {saving ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />}
            Ativar plano (após assinatura)
          </button>
        )}
        {isActive && doneItems === totalItems && totalItems > 0 && (
          <button
            onClick={completePlan}
            disabled={saving}
            className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg bg-blue-500 text-white text-sm hover:bg-blue-600 disabled:opacity-50"
          >
            <CheckCircle2 size={14} /> Concluir plano
          </button>
        )}
      </div>

      {/* Items */}
      <div className="bg-card border border-border rounded-xl overflow-hidden">
        <div className="px-4 py-2 border-b border-border">
          <p className="text-sm font-semibold">Procedimentos do plano</p>
        </div>
        {plan.items.length === 0 ? (
          <div className="py-6 text-center text-muted-foreground text-sm">Nenhum item.</div>
        ) : (
          <ul className="divide-y divide-border">
            {plan.items.map((it) => {
              const Icon = ITEM_ICON[it.status].icon;
              return (
                <li key={it.id} className="px-4 py-3 flex items-center gap-3 text-sm">
                  <Icon size={18} className={`shrink-0 ${ITEM_ICON[it.status].cls}`} />
                  <div className="flex-1 min-w-0">
                    <p className="font-medium">{it.procedure?.name}</p>
                    <p className="text-xs text-muted-foreground">
                      {it.tooth_fdi && `Dente ${it.tooth_fdi} · `}
                      {it.quantity}x R$ {Number(it.unit_price).toFixed(2)}
                      {it.executed_at && ` · Executado em ${new Date(it.executed_at).toLocaleDateString('pt-BR')}`}
                      {it.executed_by && ` por ${it.executed_by.name}`}
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    {isActive && it.status !== 'DONE' && it.status !== 'CANCELLED' && (
                      <button
                        onClick={() => executeItem(it.id)}
                        className="text-xs px-2 py-1 rounded bg-emerald-500/10 text-emerald-600 hover:bg-emerald-500/20"
                      >
                        Executar
                      </button>
                    )}
                    {isActive && it.status !== 'DONE' && it.status !== 'CANCELLED' && (
                      <button
                        onClick={() => updateItemStatus(it.id, 'CANCELLED')}
                        className="text-xs px-2 py-1 rounded text-destructive hover:bg-destructive/10"
                      >
                        Cancelar
                      </button>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}

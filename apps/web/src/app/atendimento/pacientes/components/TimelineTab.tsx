'use client';

/**
 * TimelineTab — histórico cronológico unificado do paciente.
 *
 * Agrega num único stream vertical: consultas, procedimentos executados,
 * pagamentos (incluindo atrasos), retornos programados/contatados e
 * anamneses preenchidas/assinadas.
 *
 * UI: linha vertical com pontinho colorido por tipo de evento, agrupado
 * por mês/ano pra facilitar leitura. Filtros toggleáveis por tipo (recepção
 * pode esconder pagamentos pra focar só em clínico, por exemplo).
 *
 * Backend: GET /patients/:id/timeline?limit=N — retorna {items, total}
 * já ordenado desc por data.
 */
import { useEffect, useMemo, useState, FormEvent } from 'react';
import {
  Loader2, Calendar, Activity, DollarSign, Bell, FileText,
  Clock, CheckCircle2, XCircle, AlertTriangle, Shield, X, RotateCcw,
} from 'lucide-react';
import api from '@/lib/api';
import { showError, showSuccess } from '@/lib/toast';
import { useRole } from '@/lib/useRole';

interface TimelineItem {
  id: string;
  source_id?: string;
  type: 'appointment' | 'procedure' | 'payment' | 'return' | 'anamnesis';
  date: string;
  title: string;
  subtitle?: string | null;
  status?: string | null;
  professional?: string | null;
  amount?: number | null;
  link?: string | null;
  // Validacao clinica (so faz sentido em type=appointment)
  assigned_user_id?: string | null;
  validated_at?: string | null;
  validated_by_name?: string | null;
}

interface TimelineResponse {
  items: TimelineItem[];
  total: number;
}

const TYPE_CFG: Record<TimelineItem['type'], {
  label: string;
  icon: React.ElementType;
  color: string; // tailwind class for dot bg
  textColor: string;
  bgColor: string;
}> = {
  appointment: {
    label: 'Consultas',
    icon: Calendar,
    color: 'bg-blue-500',
    textColor: 'text-blue-600',
    bgColor: 'bg-blue-500/10 border-blue-500/20',
  },
  procedure: {
    label: 'Procedimentos',
    icon: Activity,
    color: 'bg-emerald-500',
    textColor: 'text-emerald-600',
    bgColor: 'bg-emerald-500/10 border-emerald-500/20',
  },
  payment: {
    label: 'Pagamentos',
    icon: DollarSign,
    color: 'bg-amber-500',
    textColor: 'text-amber-600',
    bgColor: 'bg-amber-500/10 border-amber-500/20',
  },
  return: {
    label: 'Retornos',
    icon: Bell,
    color: 'bg-purple-500',
    textColor: 'text-purple-600',
    bgColor: 'bg-purple-500/10 border-purple-500/20',
  },
  anamnesis: {
    label: 'Anamneses',
    icon: FileText,
    color: 'bg-slate-500',
    textColor: 'text-slate-600',
    bgColor: 'bg-slate-500/10 border-slate-500/20',
  },
};

const STATUS_BADGE: Record<string, { label: string; cls: string }> = {
  // Consultas (Onda 17.61 — fluxo de recepção + rótulo "Desmarcou" igual à agenda)
  AGENDADO:       { label: 'Agendado',       cls: 'bg-blue-500/10 text-blue-600 border-blue-500/20' },
  CONFIRMADO:     { label: 'Confirmado',     cls: 'bg-emerald-500/10 text-emerald-600 border-emerald-500/20' },
  COMPARECEU:     { label: 'Chegou',        cls: 'bg-sky-500/10 text-sky-600 border-sky-500/20' },
  EM_ATENDIMENTO: { label: 'Em atendimento', cls: 'bg-amber-500/10 text-amber-600 border-amber-500/20' },
  CONCLUIDO:      { label: 'Atendido',      cls: 'bg-emerald-500/10 text-emerald-600 border-emerald-500/20' },
  CANCELADO:      { label: 'Desmarcou',      cls: 'bg-red-500/10 text-red-600 border-red-500/20' },
  NO_SHOW:        { label: 'Faltou',         cls: 'bg-gray-500/15 text-gray-700 border-gray-500/30' },
  ADIADO:         { label: 'Adiado',         cls: 'bg-amber-500/10 text-amber-600 border-amber-500/20' },
  // Procedimentos
  PENDING:     { label: 'Pendente',    cls: 'bg-amber-500/10 text-amber-600 border-amber-500/20' },
  SCHEDULED:   { label: 'Agendado',    cls: 'bg-blue-500/10 text-blue-600 border-blue-500/20' },
  IN_PROGRESS: { label: 'Em andamento', cls: 'bg-blue-500/10 text-blue-600 border-blue-500/20' },
  DONE:        { label: 'Executado',   cls: 'bg-emerald-500/10 text-emerald-600 border-emerald-500/20' },
  CANCELLED:   { label: 'Cancelado',   cls: 'bg-red-500/10 text-red-600 border-red-500/20' },
  // Pagamentos
  ABERTA:      { label: 'Aberta',      cls: 'bg-amber-500/10 text-amber-600 border-amber-500/20' },
  PAGA:        { label: 'Paga',        cls: 'bg-emerald-500/10 text-emerald-600 border-emerald-500/20' },
  PARCIAL:     { label: 'Parcial',     cls: 'bg-amber-500/10 text-amber-600 border-amber-500/20' },
  ATRASADA:    { label: 'Atrasada',    cls: 'bg-red-500/10 text-red-600 border-red-500/20' },
  CANCELADA:   { label: 'Cancelada',   cls: 'bg-muted text-muted-foreground border-border' },
  RENEGOCIADA: { label: 'Renegociada', cls: 'bg-purple-500/10 text-purple-600 border-purple-500/20' },
  // Retornos
  PENDENTE:    { label: 'Pendente',    cls: 'bg-amber-500/10 text-amber-600 border-amber-500/20' },
  CONTATADO:   { label: 'Contatado',   cls: 'bg-blue-500/10 text-blue-600 border-blue-500/20' },
  REJEITADO:   { label: 'Rejeitado',   cls: 'bg-red-500/10 text-red-600 border-red-500/20' },
  EXPIRADO:    { label: 'Expirado',    cls: 'bg-muted text-muted-foreground border-border' },
  // Anamnese
  RASCUNHO:           { label: 'Rascunho',  cls: 'bg-amber-500/10 text-amber-600 border-amber-500/20' },
  AGUARDANDO_PACIENTE:{ label: 'Aguarda paciente', cls: 'bg-blue-500/10 text-blue-600 border-blue-500/20' },
  PREENCHIDA:         { label: 'Preenchida', cls: 'bg-emerald-500/10 text-emerald-600 border-emerald-500/20' },
  ASSINADA:           { label: 'Assinada',   cls: 'bg-emerald-500/10 text-emerald-600 border-emerald-500/20' },
};

const MONTH_LABEL = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];

function formatBRL(value: number) {
  return value.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

function formatDateTime(iso: string) {
  const d = new Date(iso);
  return d.toLocaleString('pt-BR', {
    day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
    timeZone: 'UTC',
  });
}

function monthYearKey(iso: string) {
  const d = new Date(iso);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth()).padStart(2, '0')}`;
}

function formatMonthYear(key: string) {
  const [y, m] = key.split('-').map(Number);
  return `${MONTH_LABEL[m]} de ${y}`;
}

export default function TimelineTab({
  patientId,
  initialActiveTypes,
}: {
  patientId: string;
  /**
   * Conjunto inicial de tipos a exibir. Permite drill-down a partir de
   * outros lugares (ex: click em "Consultas: N" no Resumo Clínico abre
   * essa aba já filtrada por 'appointment'). Se não passado, mostra tudo.
   */
  initialActiveTypes?: Set<TimelineItem['type']>;
}) {
  const [data, setData] = useState<TimelineResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [activeTypes, setActiveTypes] = useState<Set<TimelineItem['type']>>(
    initialActiveTypes ||
      new Set(['appointment', 'procedure', 'payment', 'return', 'anamnesis'])
  );

  // Validacao clinica (Fase 23) — modal + permissões
  const role = useRole();
  const [validateModal, setValidateModal] = useState<TimelineItem | null>(null);

  const reload = () => {
    setLoading(true);
    api.get<TimelineResponse>(`/patients/${patientId}/timeline?limit=200`)
      .then((r) => setData(r.data))
      .catch((err) => showError(err?.response?.data?.message || 'Erro ao carregar histórico'))
      .finally(() => setLoading(false));
  };

  /**
   * Operador atual pode validar este atendimento?
   * Regras: type=appointment, ainda não validado, e (admin OU é o dentista atribuído).
   */
  const canValidate = (item: TimelineItem): boolean => {
    if (item.type !== 'appointment') return false;
    if (item.validated_at) return false;
    if (role.isAdmin) return true;
    return !!item.assigned_user_id && item.assigned_user_id === role.userId;
  };

  /** Reverter validacao — só admin */
  const handleUnvalidate = async (item: TimelineItem) => {
    if (!item.source_id) return;
    if (!confirm(`Reverter validação clínica deste atendimento?\n\nIsso permite trocar o dentista atribuído ou re-validar com outro profissional.`)) return;
    try {
      await api.post(`/calendar/events/${item.source_id}/unvalidate`);
      showSuccess('Validação revertida');
      reload();
    } catch (err: any) {
      showError(err?.response?.data?.message || 'Erro ao reverter');
    }
  };

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api.get<TimelineResponse>(`/patients/${patientId}/timeline?limit=200`)
      .then((r) => {
        if (!cancelled) setData(r.data);
      })
      .catch((err) => {
        showError(err?.response?.data?.message || 'Erro ao carregar histórico');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [patientId]);

  const toggleType = (t: TimelineItem['type']) => {
    setActiveTypes((prev) => {
      const next = new Set(prev);
      if (next.has(t)) next.delete(t);
      else next.add(t);
      return next;
    });
  };

  // Filtra + agrupa por mês
  const grouped = useMemo(() => {
    if (!data?.items) return [];
    const filtered = data.items.filter((it) => activeTypes.has(it.type));
    const map = new Map<string, TimelineItem[]>();
    for (const it of filtered) {
      const k = monthYearKey(it.date);
      if (!map.has(k)) map.set(k, []);
      map.get(k)!.push(it);
    }
    // Map mantém ordem de inserção, e items já vêm desc por data → ok
    return Array.from(map.entries());
  }, [data, activeTypes]);

  // Contadores por tipo (pra mostrar no toggle)
  const counts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const it of data?.items || []) c[it.type] = (c[it.type] || 0) + 1;
    return c;
  }, [data]);

  if (loading) {
    return (
      <div className="p-12 flex items-center justify-center text-muted-foreground">
        <Loader2 size={20} className="animate-spin mr-2" /> Carregando histórico...
      </div>
    );
  }

  const totalShown = grouped.reduce((sum, [, items]) => sum + items.length, 0);

  return (
    <div>
      {/* Toolbar de filtros por tipo */}
      <div className="bg-card border border-border rounded-xl p-3 mb-4">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-xs font-medium text-muted-foreground">Mostrar:</span>
          {(Object.keys(TYPE_CFG) as Array<TimelineItem['type']>).map((t) => {
            const cfg = TYPE_CFG[t];
            const Icon = cfg.icon;
            const active = activeTypes.has(t);
            const count = counts[t] || 0;
            return (
              <button
                key={t}
                onClick={() => toggleType(t)}
                disabled={count === 0}
                className={`text-xs inline-flex items-center gap-1 px-2.5 py-1 rounded-full border transition-colors ${
                  active
                    ? `${cfg.bgColor} ${cfg.textColor}`
                    : 'border-border text-muted-foreground hover:bg-accent'
                } ${count === 0 ? 'opacity-40 cursor-not-allowed' : 'cursor-pointer'}`}
              >
                <Icon size={11} /> {cfg.label}
                <span className="ml-0.5 text-[10px] opacity-80">({count})</span>
              </button>
            );
          })}
          <span className="ml-auto text-xs text-muted-foreground">
            {totalShown} de {data?.total ?? 0} eventos
          </span>
        </div>
      </div>

      {/* Empty state */}
      {grouped.length === 0 && (
        <div className="bg-card border border-border rounded-xl p-12 text-center">
          <Clock size={28} className="mx-auto mb-2 text-muted-foreground/50" />
          <p className="text-sm text-muted-foreground">
            {data && data.total > 0
              ? 'Nenhum evento corresponde aos filtros selecionados.'
              : 'Sem histórico registrado ainda. Quando esse paciente tiver consultas, procedimentos ou pagamentos, eles aparecerão aqui.'}
          </p>
        </div>
      )}

      {/* Timeline agrupada por mês */}
      <div className="space-y-6">
        {grouped.map(([monthKey, items]) => (
          <div key={monthKey}>
            <h3 className="text-xs font-bold uppercase tracking-wider text-muted-foreground mb-3 flex items-center gap-2">
              <span>{formatMonthYear(monthKey)}</span>
              <span className="text-[10px] font-normal opacity-70">{items.length} evento(s)</span>
              <span className="flex-1 h-px bg-border" />
            </h3>

            {/* Lista de eventos do mês com linha vertical conectora */}
            <ol className="relative border-l-2 border-border ml-3 space-y-3 pb-1">
              {items.map((item) => {
                const cfg = TYPE_CFG[item.type];
                const Icon = cfg.icon;
                const statusBadge = item.status ? STATUS_BADGE[item.status] : null;
                const isCancelled = item.status === 'CANCELADO' || item.status === 'CANCELLED' || item.status === 'CANCELADA';

                return (
                  <li key={item.id} className="ml-5 relative">
                    {/* Pontinho */}
                    <span
                      className={`absolute -left-[34px] top-1 w-5 h-5 rounded-full ${cfg.color} border-4 border-background flex items-center justify-center`}
                    >
                      <Icon size={10} className="text-white" />
                    </span>

                    {/* Card */}
                    <div className={`bg-card border border-border rounded-lg p-3 hover:border-primary/40 transition-colors ${isCancelled ? 'opacity-60' : ''}`}>
                      <div className="flex items-start justify-between gap-2 flex-wrap">
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2 flex-wrap">
                            {item.link ? (
                              <a
                                href={item.link}
                                className="text-sm font-medium text-foreground hover:text-primary truncate"
                              >
                                {item.title}
                              </a>
                            ) : (
                              <span className="text-sm font-medium text-foreground">{item.title}</span>
                            )}
                            {statusBadge && (
                              <span className={`text-[10px] px-1.5 py-0.5 rounded border ${statusBadge.cls}`}>
                                {statusBadge.label}
                              </span>
                            )}
                            {/* Badge de Validacao Clinica (Fase 23) */}
                            {item.type === 'appointment' && item.validated_at && (
                              <span
                                className="text-[10px] px-1.5 py-0.5 rounded border bg-emerald-500/10 text-emerald-600 border-emerald-500/20 inline-flex items-center gap-1"
                                title={`Validado por Dr(a). ${item.validated_by_name || '—'} em ${new Date(item.validated_at).toLocaleString('pt-BR')}`}
                              >
                                <Shield size={10} /> Validado
                              </span>
                            )}
                          </div>
                          <div className="flex items-center gap-3 text-xs text-muted-foreground mt-0.5 flex-wrap">
                            <span>{formatDateTime(item.date)}</span>
                            {item.professional && <span>Dr(a). {item.professional}</span>}
                            {item.subtitle && <span className="italic truncate">{item.subtitle}</span>}
                            {item.type === 'appointment' && item.validated_at && item.validated_by_name && (
                              <span className="text-emerald-600">
                                ✓ Validado por Dr(a). {item.validated_by_name} em {new Date(item.validated_at).toLocaleDateString('pt-BR')}
                              </span>
                            )}
                          </div>
                        </div>
                        {/* Acoes a direita: valor (pagamentos) OU botoes de validacao (consultas) */}
                        <div className="flex items-center gap-2 shrink-0">
                          {item.amount != null && (
                            <span className={`text-sm font-semibold whitespace-nowrap ${
                              item.status === 'PAGA' || item.status === 'PARCIAL'
                                ? 'text-emerald-600'
                                : item.status === 'ATRASADA'
                                  ? 'text-red-600'
                                  : 'text-foreground'
                            }`}>
                              {formatBRL(item.amount)}
                            </span>
                          )}
                          {/* Botao "Validar" — so se assigned_user OU admin, e nao validado ainda */}
                          {canValidate(item) && !isCancelled && (
                            <button
                              onClick={() => setValidateModal(item)}
                              className="text-xs inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-primary text-primary-foreground hover:bg-primary/90"
                              title="Atestar que este atendimento aconteceu"
                            >
                              <Shield size={11} /> Validar
                            </button>
                          )}
                          {/* Botao "Reverter validacao" — so admin, e somente se ja validado */}
                          {item.type === 'appointment' && item.validated_at && role.isAdmin && (
                            <button
                              onClick={() => handleUnvalidate(item)}
                              className="text-xs inline-flex items-center gap-1 px-2 py-1 rounded-lg border border-border text-muted-foreground hover:text-destructive hover:border-destructive/40"
                              title="Reverter validação (admin)"
                            >
                              <RotateCcw size={11} />
                            </button>
                          )}
                        </div>
                      </div>
                    </div>
                  </li>
                );
              })}
            </ol>
          </div>
        ))}
      </div>

      {/* Modal de validacao clinica */}
      {validateModal && (
        <ValidateModal
          item={validateModal}
          onClose={() => setValidateModal(null)}
          onValidated={() => { setValidateModal(null); reload(); }}
        />
      )}
    </div>
  );
}

// ─── Modal de validacao clinica (Fase 23) ─────────────────────

function ValidateModal({
  item, onClose, onValidated,
}: { item: TimelineItem; onClose: () => void; onValidated: () => void }) {
  const [notes, setNotes] = useState('');
  const [saving, setSaving] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!item.source_id) return;
    setSaving(true);
    try {
      await api.post(`/calendar/events/${item.source_id}/validate`, {
        notes: notes.trim() || undefined,
      });
      showSuccess('Atendimento validado');
      onValidated();
    } catch (err: any) {
      showError(err?.response?.data?.message || 'Erro ao validar');
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
          <div className="flex items-center gap-2">
            <Shield size={18} className="text-emerald-600" />
            <h2 className="text-base font-semibold">Validar atendimento</h2>
          </div>
          <button onClick={onClose} className="p-1 hover:bg-accent rounded">
            <X size={18} />
          </button>
        </div>
        <form onSubmit={submit} className="p-4 space-y-4">
          <div className="bg-background border border-border rounded-lg p-3 text-sm space-y-1">
            <div className="font-medium text-foreground">{item.title}</div>
            <div className="text-xs text-muted-foreground">
              {formatDateTime(item.date)}
              {item.professional && <span> · Dr(a). {item.professional}</span>}
            </div>
          </div>
          <div className="bg-amber-500/5 border border-amber-500/20 rounded-lg p-3 text-xs text-amber-700">
            <strong>Você está atestando que este atendimento aconteceu.</strong>{' '}
            Após validar, o paciente não poderá mais ter o dentista responsável trocado
            (apenas admin pode reverter). Use isso apenas após realmente realizar o procedimento.
          </div>
          <div>
            <label className="block text-xs font-medium mb-1">Notas clínicas (opcional)</label>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={3}
              placeholder="Observações sobre o atendimento, intercorrências, próximos passos..."
              className="w-full px-3 py-2 rounded-lg bg-background border border-border text-sm resize-none focus:outline-none focus:ring-2 focus:ring-primary/30"
            />
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="px-3 py-2 rounded-lg border border-border text-sm hover:bg-accent"
            >
              Cancelar
            </button>
            <button
              type="submit"
              disabled={saving}
              className="inline-flex items-center gap-1 px-3 py-2 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 disabled:opacity-50"
            >
              {saving ? <Loader2 size={14} className="animate-spin" /> : <Shield size={14} />}
              Validar atendimento
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

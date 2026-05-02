'use client';

/**
 * ManutencoesTab — tab Manutencoes/Recall do paciente (Fase 25 Onda 5.3).
 *
 * Mostra timeline de tasks de manutencao do paciente:
 *   - PENDING (rosa): aguardando — operadora precisa agendar
 *   - SCHEDULED (azul): consulta agendada
 *   - DONE (verde): revisita feita
 *   - MISSED (vermelho): data passou sem agendamento
 *   - CANCELLED (cinza): cancelada
 *
 * Operadora pode:
 *  - Marcar como agendada (via dropdown de status)
 *  - Marcar como feita (DONE)
 *  - Editar data (postergar)
 *  - Adicionar tasks manuais (botao + Nova manutencao)
 *  - Deletar
 */
import { useEffect, useState } from 'react';
import {
  Clock, Loader2, Plus, Calendar as CalIcon, Check, X, Trash2, AlertTriangle, Activity,
} from 'lucide-react';
import api from '@/lib/api';
import { showError, showSuccess } from '@/lib/toast';
import ModalBase from '@/components/ModalBase';

interface MaintenanceTask {
  id: string;
  title: string;
  due_date: string;
  status: 'PENDING' | 'SCHEDULED' | 'DONE' | 'MISSED' | 'CANCELLED';
  notes: string | null;
  completed_at: string | null;
  reminder_sent_at: string | null;
  created_at: string;
  procedure?: { id: string; name: string } | null;
  esthetic_application?: {
    id: string;
    applied_at: string;
    product_name_snapshot: string | null;
    application_point: string | null;
  } | null;
  scheduled_event?: { id: string; title: string; start_at: string } | null;
  completed_by?: { id: string; name: string } | null;
}

const STATUS_CFG: Record<MaintenanceTask['status'], { label: string; cls: string; icon: any }> = {
  PENDING:   { label: 'Aguardando',  cls: 'bg-rose-500/10 text-rose-600 border-rose-500/20',     icon: Clock },
  SCHEDULED: { label: 'Agendada',    cls: 'bg-blue-500/10 text-blue-600 border-blue-500/20',     icon: CalIcon },
  DONE:      { label: 'Realizada',   cls: 'bg-emerald-500/10 text-emerald-600 border-emerald-500/20', icon: Check },
  MISSED:    { label: 'Atrasada',    cls: 'bg-red-500/10 text-red-700 border-red-500/30',         icon: AlertTriangle },
  CANCELLED: { label: 'Cancelada',   cls: 'bg-muted text-muted-foreground border-border',         icon: X },
};

interface Props {
  patientId: string;
}

const formatDate = (s: string) =>
  new Date(s).toLocaleDateString('pt-BR', { day: '2-digit', month: 'short', year: 'numeric' });

const daysLeft = (iso: string): number => {
  const ms = new Date(iso).getTime() - Date.now();
  return Math.floor(ms / (1000 * 60 * 60 * 24));
};

export default function ManutencoesTab({ patientId }: Props) {
  const [tasks, setTasks] = useState<MaintenanceTask[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      const { data } = await api.get<MaintenanceTask[]>(`/patients/${patientId}/maintenance-tasks`);
      setTasks(data || []);
    } catch (err: any) {
      showError(err?.response?.data?.message || 'Erro ao carregar manutencoes');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, [patientId]);

  const updateStatus = async (id: string, status: MaintenanceTask['status']) => {
    try {
      await api.patch(`/maintenance-tasks/${id}`, { status });
      showSuccess('Status atualizado');
      await load();
    } catch (err: any) {
      showError(err?.response?.data?.message || 'Erro ao atualizar');
    }
  };

  const remove = async (id: string) => {
    if (!confirm('Remover esta manutenção?')) return;
    try {
      await api.delete(`/maintenance-tasks/${id}`);
      showSuccess('Removida');
      await load();
    } catch (err: any) {
      showError(err?.response?.data?.message || 'Erro ao remover');
    }
  };

  if (loading) {
    return (
      <div className="py-12 flex items-center justify-center text-muted-foreground">
        <Loader2 size={18} className="animate-spin mr-2" /> Carregando manutenções...
      </div>
    );
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <Clock size={18} className="text-primary" />
          <h3 className="font-semibold text-foreground">Manutenções</h3>
          {tasks.length > 0 && (
            <span className="text-xs text-muted-foreground">({tasks.length})</span>
          )}
        </div>
        <button
          onClick={() => setShowCreate(true)}
          className="text-xs inline-flex items-center gap-1 px-3 py-1.5 rounded-lg bg-primary text-primary-foreground hover:bg-primary/90 font-medium"
        >
          <Plus size={12} /> Nova manutenção
        </button>
      </div>

      {tasks.length === 0 ? (
        <div className="bg-card border border-border border-dashed rounded-xl p-10 text-center">
          <Clock size={32} className="mx-auto text-muted-foreground/40 mb-3" />
          <p className="text-sm text-muted-foreground mb-1">
            Nenhuma manutenção registrada.
          </p>
          <p className="text-xs text-muted-foreground">
            Manutenções são criadas automaticamente quando o paciente recebe procedimentos
            que precisam de revisão (ex: Botox, restaurações).
            Ou clique em <strong>"+ Nova manutenção"</strong> pra criar uma manualmente.
          </p>
        </div>
      ) : (
        <ol className="relative border-l-2 border-border ml-3 space-y-3">
          {tasks.map((t) => {
            const cfg = STATUS_CFG[t.status];
            const Icon = cfg.icon;
            const dleft = daysLeft(t.due_date);
            const isPending = t.status === 'PENDING' || t.status === 'SCHEDULED';
            const overdue = isPending && dleft < 0;
            const upcoming = isPending && dleft >= 0 && dleft <= 7;

            return (
              <li key={t.id} className="ml-5 relative">
                <span
                  className={`absolute -left-[34px] top-2 w-5 h-5 rounded-full border-4 border-background flex items-center justify-center ${
                    overdue ? 'bg-red-500/20' : upcoming ? 'bg-amber-500/20' : cfg.cls.split(' ')[0]
                  }`}
                >
                  <Icon size={10} className={overdue ? 'text-red-700' : ''} />
                </span>

                <div className="bg-card border border-border rounded-lg p-3 hover:border-primary/40 transition-colors">
                  <div className="flex items-start gap-2 flex-wrap mb-1">
                    <p className="font-medium text-sm flex-1 min-w-0">{t.title}</p>
                    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-medium border ${cfg.cls}`}>
                      {cfg.label}
                    </span>
                  </div>

                  <div className="flex items-center gap-3 text-xs text-muted-foreground flex-wrap">
                    <span className="flex items-center gap-1">
                      <CalIcon size={11} />
                      {formatDate(t.due_date)}
                    </span>
                    {isPending && dleft >= 0 && (
                      <span className={dleft <= 7 ? 'text-amber-600 font-medium' : ''}>
                        em {dleft === 0 ? 'hoje' : `${dleft}d`}
                      </span>
                    )}
                    {isPending && dleft < 0 && (
                      <span className="text-red-600 font-medium">
                        atrasada {Math.abs(dleft)}d
                      </span>
                    )}
                    {t.completed_at && (
                      <span className="text-emerald-600">
                        feita em {formatDate(t.completed_at)}
                        {t.completed_by?.name && ` por ${t.completed_by.name}`}
                      </span>
                    )}
                    {t.reminder_sent_at && (
                      <span className="text-blue-600" title={`WhatsApp enviado em ${new Date(t.reminder_sent_at).toLocaleString('pt-BR')}`}>
                        💬 lembrete enviado
                      </span>
                    )}
                    {t.esthetic_application?.product_name_snapshot && (
                      <span className="font-mono">
                        {t.esthetic_application.product_name_snapshot}
                        {t.esthetic_application.application_point && ` · ${t.esthetic_application.application_point}`}
                      </span>
                    )}
                  </div>

                  {t.notes && (
                    <p className="text-xs text-muted-foreground italic mt-1.5">
                      "{t.notes}"
                    </p>
                  )}

                  {/* Acoes */}
                  <div className="flex items-center gap-1 mt-2 flex-wrap">
                    {t.status === 'PENDING' && (
                      <button
                        onClick={() => updateStatus(t.id, 'SCHEDULED')}
                        className="text-xs px-2 py-1 rounded border border-blue-500/30 text-blue-700 hover:bg-blue-50"
                      >
                        Marcar agendada
                      </button>
                    )}
                    {(t.status === 'PENDING' || t.status === 'SCHEDULED') && (
                      <button
                        onClick={() => updateStatus(t.id, 'DONE')}
                        className="text-xs px-2 py-1 rounded border border-emerald-500/30 text-emerald-700 hover:bg-emerald-50"
                      >
                        ✓ Concluir
                      </button>
                    )}
                    {t.status !== 'CANCELLED' && t.status !== 'DONE' && (
                      <button
                        onClick={() => updateStatus(t.id, 'CANCELLED')}
                        className="text-xs px-2 py-1 rounded border border-border text-muted-foreground hover:bg-accent"
                      >
                        Cancelar
                      </button>
                    )}
                    {t.status === 'DONE' && (
                      <button
                        onClick={() => updateStatus(t.id, 'PENDING')}
                        className="text-xs px-2 py-1 rounded border border-border text-muted-foreground hover:bg-accent"
                        title="Reabrir (volta pra PENDING)"
                      >
                        Reabrir
                      </button>
                    )}
                    <button
                      onClick={() => remove(t.id)}
                      className="text-xs px-2 py-1 rounded text-destructive hover:bg-destructive/10 ml-auto"
                      title="Remover task"
                    >
                      <Trash2 size={12} />
                    </button>
                  </div>
                </div>
              </li>
            );
          })}
        </ol>
      )}

      {showCreate && (
        <CreateTaskModal
          patientId={patientId}
          onClose={() => setShowCreate(false)}
          onCreated={() => { setShowCreate(false); load(); }}
        />
      )}
    </div>
  );
}

function CreateTaskModal({
  patientId, onClose, onCreated,
}: { patientId: string; onClose: () => void; onCreated: () => void }) {
  const [title, setTitle] = useState('');
  const [dueDate, setDueDate] = useState(() => {
    const d = new Date();
    d.setMonth(d.getMonth() + 6);
    return d.toISOString().slice(0, 10);
  });
  const [notes, setNotes] = useState('');
  const [saving, setSaving] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim()) {
      showError('Título é obrigatório');
      return;
    }
    setSaving(true);
    try {
      await api.post('/maintenance-tasks', {
        patient_id: patientId,
        title: title.trim(),
        due_date: dueDate,
        notes: notes.trim() || undefined,
      });
      showSuccess('Manutenção criada');
      onCreated();
    } catch (err: any) {
      showError(err?.response?.data?.message || 'Erro ao criar');
    } finally {
      setSaving(false);
    }
  };

  return (
    <ModalBase
      open
      onClose={onClose}
      title={
        <span className="flex items-center gap-2">
          <Clock size={18} className="text-primary" />
          Nova manutenção
        </span>
      }
      footer={
        <>
          <button
            type="button"
            onClick={onClose}
            className="px-3 py-2 rounded-lg border border-border text-sm hover:bg-accent"
          >
            Cancelar
          </button>
          <button
            type="submit"
            form="create-maint-form"
            disabled={saving}
            className="inline-flex items-center gap-1 px-3 py-2 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 disabled:opacity-50"
          >
            {saving ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />}
            Criar
          </button>
        </>
      }
    >
      <form id="create-maint-form" onSubmit={submit} className="space-y-3">
        <div>
          <label className="block text-xs font-medium mb-1">Título *</label>
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            autoFocus
            placeholder="Ex: Revisão de Botox glabela"
            className="w-full px-3 py-2 rounded-lg bg-background border border-border text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
          />
        </div>
        <div>
          <label className="block text-xs font-medium mb-1">Data prevista *</label>
          <input
            type="date"
            value={dueDate}
            onChange={(e) => setDueDate(e.target.value)}
            min={new Date().toISOString().slice(0, 10)}
            className="w-full px-3 py-2 rounded-lg bg-background border border-border text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
          />
        </div>
        <div>
          <label className="block text-xs font-medium mb-1">Observações</label>
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            rows={3}
            placeholder="Detalhes da revisão, contexto, etc"
            className="w-full px-3 py-2 rounded-lg bg-background border border-border text-sm focus:outline-none focus:ring-2 focus:ring-primary/30 resize-none"
          />
        </div>
      </form>
    </ModalBase>
  );
}

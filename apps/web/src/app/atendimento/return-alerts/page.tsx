'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  Bell, Calendar, Loader2, MessageCircle, Phone, RotateCcw, X, AlertTriangle,
} from 'lucide-react';
import api from '@/lib/api';
import { showError, showSuccess } from '@/lib/toast';

interface ReturnAlert {
  id: string;
  scheduled_for: string;
  reason: string | null;
  notes: string | null;
  status: string;
  contacted_at: string | null;
  patient: { id: string; name: string; phone: string | null; email: string | null };
  professional: { id: string; name: string } | null;
  source_appointment: { id: string; title: string; start_at: string } | null;
}

const STATUS_CFG: Record<string, { label: string; cls: string }> = {
  PENDENTE:  { label: 'Pendente',  cls: 'bg-amber-500/10 text-amber-700 border-amber-500/20' },
  CONTATADO: { label: 'Contatado', cls: 'bg-blue-500/10 text-blue-700 border-blue-500/20' },
  AGENDADO:  { label: 'Agendado',  cls: 'bg-green-500/10 text-green-700 border-green-500/20' },
  REJEITADO: { label: 'Rejeitado', cls: 'bg-red-500/10 text-red-700 border-red-500/20' },
  EXPIRADO:  { label: 'Expirado',  cls: 'bg-gray-500/10 text-gray-700 border-gray-500/20' },
};

export default function ReturnAlertsPage() {
  const [loading, setLoading] = useState(true);
  const [alerts, setAlerts] = useState<ReturnAlert[]>([]);
  const [statusFilter, setStatusFilter] = useState<string>('PENDENTE');
  const [view, setView] = useState<'now' | 'all'>('now');
  const [openAlertId, setOpenAlertId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      let data: ReturnAlert[] = [];
      if (view === 'now') {
        const r = await api.get<ReturnAlert[]>('/return-alerts/pending-now');
        data = r.data || [];
      } else {
        const params = new URLSearchParams({ limit: '100' });
        if (statusFilter) params.set('status', statusFilter);
        const r = await api.get<{ data: ReturnAlert[] }>(`/return-alerts?${params}`);
        data = r.data?.data || [];
      }
      setAlerts(data);
    } catch (err: any) {
      showError(err?.response?.data?.message || 'Erro ao carregar retornos');
    } finally {
      setLoading(false);
    }
  }, [view, statusFilter]);

  useEffect(() => {
    load();
  }, [load]);

  const openAlert = alerts.find((a) => a.id === openAlertId);

  return (
    <div className="h-full overflow-y-auto p-6 w-full">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-foreground flex items-center gap-2">
          <Bell size={26} className="text-primary" /> Retornos pendentes
        </h1>
        <p className="text-sm text-muted-foreground mt-1">
          Alertas de retorno programados pelos profissionais — visao da recepcao
          para reagendar pacientes.
        </p>
      </div>

      {/* Toolbar */}
      <div className="flex flex-col sm:flex-row gap-2 mb-4">
        <div className="flex gap-1 bg-card border border-border rounded-lg p-1">
          <button
            onClick={() => setView('now')}
            className={`px-3 py-1.5 rounded text-sm font-medium ${
              view === 'now'
                ? 'bg-primary text-primary-foreground'
                : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            Agora ({view === 'now' ? alerts.length : '—'})
          </button>
          <button
            onClick={() => setView('all')}
            className={`px-3 py-1.5 rounded text-sm font-medium ${
              view === 'all'
                ? 'bg-primary text-primary-foreground'
                : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            Todos
          </button>
        </div>

        {view === 'all' && (
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
        )}
      </div>

      {/* List */}
      {loading ? (
        <div className="p-12 flex items-center justify-center text-muted-foreground">
          <Loader2 size={20} className="animate-spin mr-2" /> Carregando...
        </div>
      ) : alerts.length === 0 ? (
        <div className="p-12 text-center text-sm text-muted-foreground">
          <Bell size={28} className="mx-auto mb-2 opacity-50" />
          {view === 'now'
            ? 'Nenhum retorno pendente para hoje. Voce esta em dia!'
            : 'Nenhum retorno encontrado com esse filtro.'}
        </div>
      ) : (
        <div className="space-y-2">
          {alerts.map((a) => {
            const cfg = STATUS_CFG[a.status] || STATUS_CFG.PENDENTE;
            const date = new Date(a.scheduled_for);
            const today = new Date();
            today.setHours(0, 0, 0, 0);
            const overdue = date < today;
            const daysOverdue = Math.floor((today.getTime() - date.getTime()) / (1000 * 60 * 60 * 24));

            return (
              <div
                key={a.id}
                className="bg-card border border-border rounded-xl p-4 hover:border-primary/50 cursor-pointer"
                onClick={() => setOpenAlertId(a.id)}
              >
                <div className="flex items-start justify-between gap-4">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                      <span className="font-semibold text-foreground">{a.patient.name}</span>
                      <span className={`text-xs px-2 py-0.5 rounded border ${cfg.cls}`}>
                        {cfg.label}
                      </span>
                      {overdue && a.status === 'PENDENTE' && (
                        <span className="text-xs px-2 py-0.5 rounded bg-destructive/10 text-destructive flex items-center gap-1">
                          <AlertTriangle size={11} /> {daysOverdue}d em atraso
                        </span>
                      )}
                    </div>

                    <div className="text-xs text-muted-foreground space-y-0.5">
                      <p className="flex items-center gap-3">
                        <span className="flex items-center gap-1">
                          <Calendar size={11} />
                          {date.toLocaleDateString('pt-BR')}
                        </span>
                        {a.patient.phone && (
                          <span className="flex items-center gap-1">
                            <Phone size={11} /> {a.patient.phone}
                          </span>
                        )}
                        {a.professional && (
                          <span>Dr(a). {a.professional.name}</span>
                        )}
                      </p>
                      {a.reason && (
                        <p><strong>Motivo:</strong> {a.reason}</p>
                      )}
                      {a.source_appointment && (
                        <p className="italic">
                          Origem: {a.source_appointment.title} em{' '}
                          {new Date(a.source_appointment.start_at).toLocaleDateString('pt-BR')}
                        </p>
                      )}
                    </div>
                  </div>

                  {a.status === 'PENDENTE' && (
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        setOpenAlertId(a.id);
                      }}
                      className="text-xs inline-flex items-center gap-1 px-3 py-1.5 rounded-lg bg-primary text-primary-foreground hover:bg-primary/90 shrink-0"
                    >
                      <MessageCircle size={12} /> Contatar
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {openAlert && (
        <ContactModal
          alert={openAlert}
          onClose={() => setOpenAlertId(null)}
          onUpdated={() => {
            setOpenAlertId(null);
            load();
          }}
        />
      )}
    </div>
  );
}

// ============================================================================
// Modal: Marcar como contatado
// ============================================================================

function ContactModal({
  alert, onClose, onUpdated,
}: { alert: ReturnAlert; onClose: () => void; onUpdated: () => void }) {
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState<'CONTATADO' | 'AGENDADO' | 'REJEITADO'>('CONTATADO');
  const [scheduledAppointmentId, setScheduledAppointmentId] = useState('');
  const [notes, setNotes] = useState('');

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    try {
      await api.post(`/return-alerts/${alert.id}/contact`, {
        result,
        scheduled_appointment_id: scheduledAppointmentId || undefined,
        notes: notes.trim() || undefined,
      });
      showSuccess('Retorno atualizado');
      onUpdated();
    } catch (err: any) {
      showError(err?.response?.data?.message || 'Erro ao atualizar');
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
        className="bg-card border border-border rounded-xl w-full max-w-lg shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between p-4 border-b border-border">
          <h2 className="text-lg font-semibold flex items-center gap-2">
            <RotateCcw size={20} className="text-primary" /> Contato com {alert.patient.name}
          </h2>
          <button onClick={onClose} className="p-1 hover:bg-accent rounded">
            <X size={18} />
          </button>
        </div>

        <form onSubmit={submit} className="p-4 space-y-3">
          <div className="text-sm text-muted-foreground bg-background border border-border rounded-lg p-3">
            <p><strong>Telefone:</strong> {alert.patient.phone || 'sem telefone'}</p>
            {alert.patient.email && <p><strong>Email:</strong> {alert.patient.email}</p>}
            {alert.reason && <p className="mt-2"><strong>Motivo do retorno:</strong> {alert.reason}</p>}
          </div>

          <div>
            <label className="block text-xs font-medium mb-2">Resultado do contato *</label>
            <div className="grid grid-cols-3 gap-2">
              {(['CONTATADO', 'AGENDADO', 'REJEITADO'] as const).map((r) => (
                <button
                  type="button"
                  key={r}
                  onClick={() => setResult(r)}
                  className={`px-3 py-2 rounded-lg border text-sm font-medium ${
                    result === r
                      ? 'bg-primary text-primary-foreground border-primary'
                      : 'border-border hover:bg-accent'
                  }`}
                >
                  {STATUS_CFG[r]?.label || r}
                </button>
              ))}
            </div>
            <p className="text-xs text-muted-foreground mt-1">
              {result === 'CONTATADO' && 'Falei com o paciente, vamos retomar contato depois.'}
              {result === 'AGENDADO' && 'Paciente reagendou — informe ID do novo agendamento abaixo (opcional).'}
              {result === 'REJEITADO' && 'Paciente nao quer reagendar agora.'}
            </p>
          </div>

          {result === 'AGENDADO' && (
            <div>
              <label className="block text-xs font-medium mb-1">ID do novo agendamento (opcional)</label>
              <input
                type="text"
                value={scheduledAppointmentId}
                onChange={(e) => setScheduledAppointmentId(e.target.value)}
                placeholder="UUID do CalendarEvent recem-criado"
                className="w-full px-3 py-2 rounded-lg bg-background border border-border text-sm focus:outline-none focus:ring-2 focus:ring-primary/30 font-mono"
              />
            </div>
          )}

          <div>
            <label className="block text-xs font-medium mb-1">Anotacoes (opcional)</label>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={3}
              className="w-full px-3 py-2 rounded-lg bg-background border border-border text-sm focus:outline-none focus:ring-2 focus:ring-primary/30 resize-none"
              placeholder="Ex: paciente vai retornar em 30 dias, esta de viagem..."
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
              {saving ? <Loader2 size={16} className="animate-spin" /> : <RotateCcw size={16} />}
              Confirmar
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

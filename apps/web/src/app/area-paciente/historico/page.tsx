'use client';

import { useEffect, useState } from 'react';
import { Clock, Loader2, Calendar, FileText, Stethoscope, CheckCircle, X } from 'lucide-react';
import portalApi from '@/lib/portalApi';

type EventType = 'APPOINTMENT' | 'ANAMNESIS' | 'PROCEDURE';

interface TimelineEvent {
  type: EventType;
  id: string;
  date: string;
  title: string;
  status: string | null;
  professional: string | null;
  notes?: string | null;
}

const TYPE_CFG: Record<EventType, {
  label: string;
  Icon: typeof Calendar;
  color: string;
  bg: string;
}> = {
  APPOINTMENT: { label: 'Consulta',     Icon: Calendar,    color: 'text-blue-700',    bg: 'bg-blue-100 dark:bg-blue-900/40' },
  ANAMNESIS:   { label: 'Anamnese',     Icon: FileText,    color: 'text-amber-700',   bg: 'bg-amber-100 dark:bg-amber-900/40' },
  PROCEDURE:   { label: 'Procedimento', Icon: Stethoscope, color: 'text-emerald-700', bg: 'bg-emerald-100 dark:bg-emerald-900/40' },
};

const STATUS_LABEL: Record<string, string> = {
  AGENDADO: 'Agendado', CONFIRMADO: 'Confirmado', CONCLUIDO: 'Atendido',
  CANCELADO: 'Cancelado', ADIADO: 'Adiado',
  STAFF: 'Pela equipe', PATIENT_PORTAL: 'Pelo paciente',
  DONE: 'Finalizado',
};

export default function AreaPacienteHistoricoPage() {
  const [loading, setLoading] = useState(true);
  const [events, setEvents] = useState<TimelineEvent[]>([]);

  useEffect(() => {
    portalApi.get<{ events: TimelineEvent[] }>('/portal/timeline')
      .then(({ data }) => setEvents(data.events || []))
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-16 text-muted-foreground">
        <Loader2 size={20} className="animate-spin mr-2" /> Carregando...
      </div>
    );
  }

  return (
    <div className="space-y-4 max-w-2xl mx-auto">
      <h1 className="text-2xl font-bold flex items-center gap-2">
        <Clock size={24} className="text-primary" /> Histórico
      </h1>

      {events.length === 0 ? (
        <div className="bg-card border border-border rounded-xl p-6 text-center">
          <Clock size={28} className="mx-auto mb-2 text-muted-foreground/60" />
          <p className="text-sm text-muted-foreground">
            Voce ainda nao tem eventos no historico.
          </p>
          <p className="text-xs text-muted-foreground mt-1">
            Suas consultas, anamneses e procedimentos vao aparecer aqui.
          </p>
        </div>
      ) : (
        <ol className="relative border-l-2 border-border ml-3 space-y-4 pl-6">
          {events.map((ev) => {
            const cfg = TYPE_CFG[ev.type];
            const Icon = cfg.Icon;
            const date = new Date(ev.date);
            const statusLabel = ev.status ? (STATUS_LABEL[ev.status] || ev.status) : null;
            return (
              <li key={`${ev.type}-${ev.id}`} className="relative">
                {/* Marker */}
                <span
                  className={`absolute -left-[35px] top-0 w-6 h-6 rounded-full flex items-center justify-center ${cfg.bg} ring-2 ring-background`}
                >
                  <Icon size={12} className={cfg.color} />
                </span>

                <div className="bg-card border border-border rounded-xl p-3">
                  <div className="flex items-start justify-between gap-2 flex-wrap">
                    <div className="flex-1 min-w-0">
                      <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                        {cfg.label}
                      </p>
                      <p className="font-semibold text-sm mt-0.5">{ev.title}</p>
                      <p className="text-xs text-muted-foreground mt-0.5">
                        {date.toLocaleString('pt-BR', {
                          day: '2-digit', month: '2-digit', year: 'numeric',
                          hour: '2-digit', minute: '2-digit',
                        })}
                      </p>
                      {ev.professional && (
                        <p className="text-xs text-muted-foreground mt-0.5">
                          Dr(a). {ev.professional}
                        </p>
                      )}
                      {ev.notes && (
                        <p className="text-xs text-muted-foreground italic mt-1">
                          {ev.notes}
                        </p>
                      )}
                    </div>
                    {statusLabel && (
                      <span
                        className={`text-[10px] px-2 py-0.5 rounded border shrink-0 ${
                          ev.status === 'CANCELADO'
                            ? 'border-destructive/30 text-destructive bg-destructive/10'
                            : ev.status === 'CONCLUIDO' || ev.status === 'DONE'
                            ? 'border-green-500/30 text-green-700 bg-green-500/10'
                            : 'border-border text-muted-foreground bg-muted/30'
                        }`}
                      >
                        {ev.status === 'CANCELADO' && <X size={10} className="inline mr-0.5" />}
                        {(ev.status === 'CONCLUIDO' || ev.status === 'DONE') && (
                          <CheckCircle size={10} className="inline mr-0.5" />
                        )}
                        {statusLabel}
                      </span>
                    )}
                  </div>
                </div>
              </li>
            );
          })}
        </ol>
      )}

      <p className="text-[10px] text-muted-foreground text-center pt-2">
        Sao mostrados os ultimos 50 eventos.
      </p>
    </div>
  );
}

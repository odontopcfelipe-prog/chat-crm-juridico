'use client';

import { useEffect, useState } from 'react';
import { Calendar, Loader2, CheckCircle, X, Clock } from 'lucide-react';
import portalApi from '@/lib/portalApi';

interface Appointment {
  id: string;
  title: string;
  description: string | null;
  start_at: string;
  end_at: string | null;
  status: string;
  assigned_user: { id: string; name: string } | null;
}

const STATUS_CFG: Record<string, { label: string; cls: string }> = {
  AGENDADO:    { label: 'Agendado',    cls: 'bg-blue-500/10 text-blue-700 border-blue-500/20' },
  CONFIRMADO:  { label: 'Confirmado',  cls: 'bg-green-500/10 text-green-700 border-green-500/20' },
  CONCLUIDO:   { label: 'Concluido',   cls: 'bg-gray-500/10 text-gray-700 border-gray-500/20' },
  ADIADO:      { label: 'Adiado',      cls: 'bg-amber-500/10 text-amber-700 border-amber-500/20' },
  CANCELADO:   { label: 'Cancelado',   cls: 'bg-red-500/10 text-red-700 border-red-500/20' },
};

export default function AreaPacienteAgendamentosPage() {
  const [loading, setLoading] = useState(true);
  const [upcoming, setUpcoming] = useState<Appointment[]>([]);
  const [past, setPast] = useState<Appointment[]>([]);
  const [acting, setActing] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    try {
      const { data } = await portalApi.get<{ upcoming: Appointment[]; past: Appointment[] }>('/portal/appointments');
      setUpcoming(data.upcoming || []);
      setPast(data.past || []);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const confirm = async (id: string) => {
    setActing(id);
    try {
      await portalApi.post(`/portal/appointments/${id}/confirm`);
      await load();
    } finally { setActing(null); }
  };

  const cancel = async (id: string) => {
    if (!confirm.length) return;
    const reason = prompt('Motivo do cancelamento (opcional):') || '';
    setActing(id);
    try {
      await portalApi.post(`/portal/appointments/${id}/cancel`, { reason });
      await load();
    } finally { setActing(null); }
  };

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
        <Calendar size={24} className="text-primary" /> Meus agendamentos
      </h1>

      <section>
        <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2">
          Próximos
        </h2>
        {upcoming.length === 0 ? (
          <p className="text-sm text-muted-foreground py-6 text-center bg-card border border-border rounded-xl">
            Nenhum agendamento futuro.
          </p>
        ) : (
          <ul className="space-y-2">
            {upcoming.map((a) => {
              const cfg = STATUS_CFG[a.status] || STATUS_CFG.AGENDADO;
              return (
                <li key={a.id} className="bg-card border border-border rounded-xl p-3">
                  <div className="flex items-start justify-between gap-2 mb-2">
                    <div>
                      <p className="font-semibold">{a.title}</p>
                      <p className="text-xs text-muted-foreground">
                        {new Date(a.start_at).toLocaleString('pt-BR', {
                          weekday: 'long', day: '2-digit', month: 'long',
                          hour: '2-digit', minute: '2-digit',
                        })}
                      </p>
                      {a.assigned_user && (
                        <p className="text-xs text-muted-foreground mt-0.5">
                          Dr(a). {a.assigned_user.name}
                        </p>
                      )}
                    </div>
                    <span className={`text-xs px-2 py-0.5 rounded border ${cfg.cls}`}>{cfg.label}</span>
                  </div>
                  {a.description && (
                    <p className="text-xs text-muted-foreground italic mb-2">{a.description}</p>
                  )}
                  <div className="flex gap-2">
                    {a.status === 'AGENDADO' && (
                      <button
                        onClick={() => confirm(a.id)}
                        disabled={acting === a.id}
                        className="text-xs inline-flex items-center gap-1 px-3 py-1.5 rounded-lg bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
                      >
                        {acting === a.id ? <Loader2 size={12} className="animate-spin" /> : <CheckCircle size={12} />}
                        Confirmar
                      </button>
                    )}
                    {(a.status === 'AGENDADO' || a.status === 'CONFIRMADO') && (
                      <button
                        onClick={() => cancel(a.id)}
                        disabled={acting === a.id}
                        className="text-xs inline-flex items-center gap-1 px-3 py-1.5 rounded-lg border border-destructive/30 text-destructive hover:bg-destructive/10 disabled:opacity-50"
                      >
                        <X size={12} /> Cancelar
                      </button>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section>
        <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2 flex items-center gap-1">
          <Clock size={11} /> Histórico recente
        </h2>
        {past.length === 0 ? (
          <p className="text-sm text-muted-foreground py-3 text-center">Sem histórico.</p>
        ) : (
          <ul className="space-y-1">
            {past.map((a) => {
              const cfg = STATUS_CFG[a.status] || STATUS_CFG.CONCLUIDO;
              return (
                <li key={a.id} className="bg-card border border-border rounded p-2 flex items-center justify-between gap-2">
                  <div>
                    <p className="text-sm">{a.title}</p>
                    <p className="text-[10px] text-muted-foreground">
                      {new Date(a.start_at).toLocaleDateString('pt-BR')}
                    </p>
                  </div>
                  <span className={`text-[10px] px-2 py-0.5 rounded border ${cfg.cls}`}>{cfg.label}</span>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}

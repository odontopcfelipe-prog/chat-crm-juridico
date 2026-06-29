'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import {
  Calendar, Wallet, FileText, ChevronRight, CheckCircle, AlertTriangle, Loader2, Clock, Stethoscope,
} from 'lucide-react';
import portalApi from '@/lib/portalApi';

interface Me { id: string; name: string; phone: string | null; email: string | null }
interface Appointment {
  id: string; title: string; start_at: string; status: string;
  assigned_user: { id: string; name: string } | null;
}
interface InstallmentTotals { paid: number; open: number; overdue: number }

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

const fmtBRL = (v: number) =>
  new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(v);

export default function AreaPacienteDashboardPage() {
  const [loading, setLoading] = useState(true);
  const [me, setMe] = useState<Me | null>(null);
  const [next, setNext] = useState<Appointment | null>(null);
  const [totals, setTotals] = useState<InstallmentTotals | null>(null);
  const [timeline, setTimeline] = useState<TimelineEvent[]>([]);
  const [confirming, setConfirming] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      const [meRes, appRes, instRes, tlRes] = await Promise.all([
        portalApi.get<Me>('/portal/me'),
        portalApi.get<{ upcoming: Appointment[]; past: Appointment[] }>('/portal/appointments'),
        portalApi.get<{ installments: any[]; totals: InstallmentTotals }>('/portal/installments'),
        portalApi.get<{ events: TimelineEvent[] }>('/portal/timeline'),
      ]);
      setMe(meRes.data);
      setNext(appRes.data?.upcoming?.[0] || null);
      setTotals(instRes.data?.totals || null);
      setTimeline(tlRes.data?.events || []);
    } catch {
      // tratado pelo layout (redireciona se 401)
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const confirmNext = async () => {
    if (!next) return;
    setConfirming(true);
    try {
      await portalApi.post(`/portal/appointments/${next.id}/confirm`);
      await load();
    } finally {
      setConfirming(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-16 text-muted-foreground">
        <Loader2 size={20} className="animate-spin mr-2" /> Carregando...
      </div>
    );
  }

  const recentTimeline = timeline.slice(0, 5);

  return (
    <div className="space-y-4 max-w-2xl mx-auto">
      <div>
        <h1 className="text-2xl font-bold">Olá, {me?.name?.split(' ')[0] || 'paciente'}!</h1>
        <p className="text-sm text-muted-foreground">Bem-vindo(a) ao seu portal.</p>
      </div>

      {/* Próxima consulta */}
      <div className="bg-card border border-border rounded-xl p-4">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-3 flex items-center gap-1">
          <Calendar size={12} /> Próxima consulta
        </h3>
        {next ? (
          <>
            <p className="font-semibold">{next.title}</p>
            <p className="text-sm text-muted-foreground">
              {new Date(next.start_at).toLocaleString('pt-BR', {
                weekday: 'long', day: '2-digit', month: 'long',
                hour: '2-digit', minute: '2-digit',
              })}
            </p>
            {next.assigned_user && (
              <p className="text-xs text-muted-foreground mt-1">com Dr(a). {next.assigned_user.name}</p>
            )}
            <div className="flex gap-2 mt-3">
              {next.status === 'AGENDADO' && (
                <button
                  onClick={confirmNext}
                  disabled={confirming}
                  className="inline-flex items-center gap-1 px-3 py-2 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 disabled:opacity-50"
                >
                  {confirming ? <Loader2 size={14} className="animate-spin" /> : <CheckCircle size={14} />}
                  Confirmar presença
                </button>
              )}
              {next.status === 'CONFIRMADO' && (
                <span className="inline-flex items-center gap-1 px-3 py-2 rounded-lg bg-green-500/10 text-green-700 text-sm font-medium border border-green-500/20">
                  <CheckCircle size={14} /> Confirmado
                </span>
              )}
              <Link
                href="/area-paciente/agendamentos"
                className="inline-flex items-center gap-1 px-3 py-2 rounded-lg border border-border text-sm hover:bg-accent"
              >
                Ver todas <ChevronRight size={14} />
              </Link>
            </div>
          </>
        ) : (
          <p className="text-sm text-muted-foreground">Nenhuma consulta agendada.</p>
        )}
      </div>

      {/* Histórico — aba principal expandida */}
      <div className="bg-card border-2 border-primary/20 rounded-xl p-4">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground flex items-center gap-1">
            <Clock size={12} /> Seu histórico
          </h3>
          {timeline.length > 5 && (
            <Link
              href="/area-paciente/historico"
              className="text-xs text-primary hover:underline flex items-center gap-0.5"
            >
              Ver tudo ({timeline.length}) <ChevronRight size={12} />
            </Link>
          )}
        </div>

        {recentTimeline.length === 0 ? (
          <div className="py-6 text-center">
            <Clock size={24} className="mx-auto mb-1 text-muted-foreground/60" />
            <p className="text-sm text-muted-foreground">
              Voce ainda nao tem eventos no historico.
            </p>
            <p className="text-xs text-muted-foreground mt-1">
              Suas consultas, anamneses e procedimentos vao aparecer aqui.
            </p>
          </div>
        ) : (
          <ol className="relative border-l-2 border-border ml-3 space-y-3 pl-5">
            {recentTimeline.map((ev) => {
              const cfg = TYPE_CFG[ev.type];
              const Icon = cfg.Icon;
              const date = new Date(ev.date);
              const statusLabel = ev.status ? (STATUS_LABEL[ev.status] || ev.status) : null;
              return (
                <li key={`${ev.type}-${ev.id}`} className="relative">
                  <span
                    className={`absolute -left-[30px] top-0 w-5 h-5 rounded-full flex items-center justify-center ${cfg.bg} ring-2 ring-card`}
                  >
                    <Icon size={10} className={cfg.color} />
                  </span>
                  <div className="flex items-start justify-between gap-2 flex-wrap">
                    <div className="flex-1 min-w-0">
                      <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                        {cfg.label}
                      </p>
                      <p className="font-medium text-sm">{ev.title}</p>
                      <p className="text-[11px] text-muted-foreground">
                        {date.toLocaleDateString('pt-BR', {
                          day: '2-digit', month: '2-digit', year: 'numeric',
                        })}
                        {ev.professional && ` · Dr(a). ${ev.professional}`}
                      </p>
                    </div>
                    {statusLabel && (
                      <span
                        className={`text-[10px] px-1.5 py-0.5 rounded border shrink-0 ${
                          ev.status === 'CANCELADO'
                            ? 'border-destructive/30 text-destructive bg-destructive/10'
                            : ev.status === 'CONCLUIDO' || ev.status === 'DONE'
                            ? 'border-green-500/30 text-green-700 bg-green-500/10'
                            : 'border-border text-muted-foreground bg-muted/30'
                        }`}
                      >
                        {statusLabel}
                      </span>
                    )}
                  </div>
                </li>
              );
            })}
          </ol>
        )}
      </div>

      {/* Resumo financeiro */}
      <div className="bg-card border border-border rounded-xl p-4">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-3 flex items-center gap-1">
          <Wallet size={12} /> Suas parcelas
        </h3>
        {totals ? (
          <div className="grid grid-cols-3 gap-2 mb-3">
            <Card label="Em aberto" value={fmtBRL(totals.open)} color="text-blue-700" />
            <Card label="Em atraso" value={fmtBRL(totals.overdue)} color="text-destructive" icon={<AlertTriangle size={11} />} />
            <Card label="Já pago" value={fmtBRL(totals.paid)} color="text-green-700" icon={<CheckCircle size={11} />} />
          </div>
        ) : (
          <p className="text-sm text-muted-foreground mb-3">Sem parcelas.</p>
        )}
        <Link
          href="/area-paciente/parcelas"
          className="inline-flex items-center gap-1 px-3 py-2 rounded-lg border border-border text-sm hover:bg-accent"
        >
          Ver detalhes <ChevronRight size={14} />
        </Link>
      </div>

      {/* Anamnese */}
      <div className="bg-card border border-border rounded-xl p-4">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2 flex items-center gap-1">
          <FileText size={12} /> Anamnese
        </h3>
        <p className="text-sm text-muted-foreground mb-3">
          Mantenha seu histórico de saúde atualizado.
        </p>
        <Link
          href="/area-paciente/anamnese"
          className="inline-flex items-center gap-1 px-3 py-2 rounded-lg border border-border text-sm hover:bg-accent"
        >
          Acessar <ChevronRight size={14} />
        </Link>
      </div>
    </div>
  );
}

function Card({
  label, value, color, icon,
}: { label: string; value: string; color: string; icon?: React.ReactNode }) {
  return (
    <div className="bg-background border border-border rounded p-2">
      <div className="text-[10px] uppercase text-muted-foreground flex items-center gap-1">
        {icon} {label}
      </div>
      <div className={`text-sm font-mono font-bold ${color}`}>{value}</div>
    </div>
  );
}

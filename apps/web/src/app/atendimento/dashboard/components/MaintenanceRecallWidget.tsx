'use client';

/**
 * MaintenanceRecallWidget — widget do dashboard mostrando revisitas
 * atrasadas/proximas (Fase 25 Onda 5.5).
 *
 * Pra clinica de estetica facial isso eh PILAR: cada Botox, preenchimento,
 * Sculptra etc tem revisita programada. Revisitas atrasadas = paciente
 * provavelmente vai pra concorrente. Recepcao precisa ver isso na cara
 * e ligar.
 */
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  Clock, AlertTriangle, ChevronRight, Loader2, Phone,
} from 'lucide-react';
import api from '@/lib/api';

interface OverdueTask {
  id: string;
  title: string;
  due_date: string;
  status: string;
  patient: { id: string; name: string; phone: string | null };
  procedure?: { id: string; name: string } | null;
}

const daysFromNow = (iso: string): number => {
  const ms = new Date(iso).getTime() - Date.now();
  return Math.ceil(ms / (1000 * 60 * 60 * 24));
};

export function MaintenanceRecallWidget() {
  const router = useRouter();
  const [tasks, setTasks] = useState<OverdueTask[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.get<OverdueTask[]>('/maintenance-tasks?overdue=1')
      .then((r) => setTasks(r.data || []))
      .catch(() => { /* silent — widget some se erro */ })
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return (
      <div className="bg-card border border-border rounded-xl p-4">
        <div className="text-xs text-muted-foreground flex items-center gap-2">
          <Loader2 size={12} className="animate-spin" /> Carregando revisitas...
        </div>
      </div>
    );
  }

  if (tasks.length === 0) {
    // Nao mostra widget se nao tem nada — economiza espaco visual no dashboard
    return null;
  }

  return (
    <div className="bg-card border border-amber-500/30 rounded-xl p-4">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-semibold flex items-center gap-2">
          <AlertTriangle size={14} className="text-amber-600" />
          Revisitas atrasadas
          <span className="text-xs px-1.5 py-0.5 rounded-full bg-amber-500/10 text-amber-700 border border-amber-500/20">
            {tasks.length}
          </span>
        </h3>
      </div>
      <ul className="space-y-1.5 max-h-[280px] overflow-y-auto">
        {tasks.slice(0, 10).map((t) => {
          const daysOverdue = -daysFromNow(t.due_date);
          return (
            <li
              key={t.id}
              onClick={() => router.push(`/atendimento/pacientes/${t.patient.id}?tab=maintenance`)}
              className="px-3 py-2 rounded-lg border border-border hover:border-amber-500/40 hover:bg-amber-500/5 cursor-pointer transition-colors flex items-center gap-2"
            >
              <Clock size={12} className="text-amber-600 shrink-0" />
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium truncate">{t.patient.name}</p>
                <p className="text-xs text-muted-foreground truncate">
                  {t.title}
                  {' · '}
                  <span className="text-red-600 font-medium">{daysOverdue}d atrasada</span>
                </p>
              </div>
              {t.patient.phone && (
                <a
                  href={`https://wa.me/55${t.patient.phone.replace(/\D/g, '')}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={(e) => e.stopPropagation()}
                  className="text-emerald-600 hover:bg-emerald-500/10 p-1 rounded shrink-0"
                  title={`WhatsApp ${t.patient.phone}`}
                >
                  <Phone size={12} />
                </a>
              )}
              <ChevronRight size={12} className="text-muted-foreground shrink-0" />
            </li>
          );
        })}
      </ul>
      {tasks.length > 10 && (
        <p className="text-[10px] text-muted-foreground italic mt-2 text-center">
          Mostrando 10 de {tasks.length}. Veja todas em cada paciente.
        </p>
      )}
    </div>
  );
}

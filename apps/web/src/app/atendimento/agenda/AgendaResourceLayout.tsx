'use client';

/**
 * AgendaResourceLayout — Fase 12 PR3.
 *
 * Layout completo "estilo Clinicorp" envolvendo o AgendaResourceView:
 *   - Sidebar esquerda (~250px):
 *     - Mini-calendario (DayPilotNavigator) para selecionar dia
 *     - Lista de profissionais com checkbox (filtra colunas)
 *     - Lista de Retornos pendentes (consume /return-alerts/pending-now)
 *   - Coluna direita: AgendaResourceView com colunas filtradas
 *
 * Persiste selecao de profissionais e dia em localStorage.
 */

import { useEffect, useMemo, useState } from 'react';
import { DayPilotNavigator } from '@daypilot/daypilot-lite-react';
import { Bell, Phone, ChevronRight, Loader2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import api from '@/lib/api';
import { AgendaResourceView, type ResourceUser, type ResourceEvent } from './AgendaResourceView';

interface PendingReturnAlert {
  id: string;
  scheduled_for: string;
  reason: string | null;
  patient: { id: string; name: string; phone: string | null };
}

interface Props {
  date: Date;
  setDate: (d: Date) => void;
  professionals: ResourceUser[];
  events: ResourceEvent[];
  onEventClick?: (eventId: string) => void;
  onSlotClick?: (params: { start: string; end: string; assigned_user_id: string }) => void;
  onMove?: (params: { id: string; start: string; end: string; assigned_user_id: string }) => void;
}

const STORAGE_KEY = 'agenda_resource_filters_v1';

export function AgendaResourceLayout({
  date,
  setDate,
  professionals,
  events,
  onEventClick,
  onSlotClick,
  onMove,
}: Props) {
  const router = useRouter();
  const [selectedIds, setSelectedIds] = useState<string[]>(() => {
    if (typeof window === 'undefined') return professionals.map((p) => p.id);
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
      if (Array.isArray(saved)) return saved;
    } catch { /* ignore */ }
    return professionals.map((p) => p.id);
  });

  const [returnAlerts, setReturnAlerts] = useState<PendingReturnAlert[]>([]);
  const [loadingAlerts, setLoadingAlerts] = useState(true);

  // Quando lista de profissionais muda (load tardio), inclui novos
  useEffect(() => {
    setSelectedIds((prev) => {
      const known = new Set(prev);
      const all = professionals.map((p) => p.id);
      const merged = Array.from(new Set([...prev, ...all.filter((id) => !known.has(id))]));
      return merged;
    });
  }, [professionals]);

  // Persiste filtros
  useEffect(() => {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(selectedIds)); } catch { /* ignore */ }
  }, [selectedIds]);

  // Carrega retornos pendentes
  useEffect(() => {
    let active = true;
    setLoadingAlerts(true);
    api.get<PendingReturnAlert[]>('/return-alerts/pending-now')
      .then((r) => { if (active) setReturnAlerts(r.data || []); })
      .catch(() => { if (active) setReturnAlerts([]); })
      .finally(() => { if (active) setLoadingAlerts(false); });
    return () => { active = false; };
  }, []);

  const filteredProfessionals = useMemo(() => {
    const sel = new Set(selectedIds);
    return professionals.filter((p) => sel.has(p.id));
  }, [professionals, selectedIds]);

  const toggleProfessional = (id: string) => {
    setSelectedIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
    );
  };

  const toggleAll = () => {
    if (selectedIds.length === professionals.length) setSelectedIds([]);
    else setSelectedIds(professionals.map((p) => p.id));
  };

  return (
    <div className="flex gap-3 h-full">
      {/* Sidebar */}
      <aside className="w-[260px] shrink-0 flex flex-col gap-3 overflow-hidden">
        {/* Mini-calendario */}
        <div className="bg-card border border-border rounded-xl overflow-hidden">
          <DayPilotNavigator
            selectMode="Day"
            selectionDay={date.toISOString().slice(0, 10) as any}
            onTimeRangeSelected={(args: any) => {
              const d = new Date(args.day.toString ? args.day.toString() : args.day);
              setDate(d);
            }}
          />
        </div>

        {/* Profissionais com checkbox */}
        <div className="bg-card border border-border rounded-xl p-3 max-h-[280px] overflow-hidden flex flex-col">
          <div className="flex items-center justify-between mb-2">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Profissionais
            </h3>
            <button
              onClick={toggleAll}
              className="text-[10px] text-primary hover:underline"
            >
              {selectedIds.length === professionals.length ? 'limpar' : 'todos'}
            </button>
          </div>
          <ul className="overflow-y-auto space-y-1 flex-1">
            {professionals.length === 0 ? (
              <li className="text-xs text-muted-foreground italic">Nenhum profissional</li>
            ) : (
              professionals.map((p) => {
                const checked = selectedIds.includes(p.id);
                return (
                  <li key={p.id}>
                    <label className="flex items-center gap-2 px-2 py-1 rounded text-sm cursor-pointer hover:bg-accent">
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => toggleProfessional(p.id)}
                        className="accent-primary shrink-0"
                      />
                      <span className="truncate">{p.name}</span>
                    </label>
                  </li>
                );
              })
            )}
          </ul>
        </div>

        {/* Retornos pendentes */}
        <div className="bg-card border border-border rounded-xl p-3 flex-1 flex flex-col overflow-hidden">
          <div className="flex items-center justify-between mb-2">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground flex items-center gap-1">
              <Bell size={11} /> Retornos
              {returnAlerts.length > 0 && (
                <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-amber-500/20 text-amber-700">
                  {returnAlerts.length}
                </span>
              )}
            </h3>
            <button
              onClick={() => router.push('/atendimento/return-alerts')}
              className="text-[10px] text-primary hover:underline"
            >
              ver todos
            </button>
          </div>
          {loadingAlerts ? (
            <div className="flex items-center justify-center py-6 text-muted-foreground">
              <Loader2 size={14} className="animate-spin" />
            </div>
          ) : returnAlerts.length === 0 ? (
            <p className="text-xs text-muted-foreground py-3 text-center">Nada pendente</p>
          ) : (
            <ul className="overflow-y-auto space-y-1.5 flex-1">
              {returnAlerts.slice(0, 12).map((a) => {
                const overdueDays = Math.floor(
                  (Date.now() - new Date(a.scheduled_for).getTime()) / (1000 * 60 * 60 * 24),
                );
                return (
                  <li key={a.id}>
                    <button
                      onClick={() => router.push('/atendimento/return-alerts')}
                      className="w-full text-left p-2 rounded hover:bg-accent text-xs group"
                    >
                      <div className="flex items-start justify-between gap-1">
                        <div className="flex-1 min-w-0">
                          <p className="font-medium truncate">{a.patient.name}</p>
                          <p className="text-[10px] text-muted-foreground flex items-center gap-1">
                            {a.patient.phone && (
                              <>
                                <Phone size={9} />
                                <span className="truncate">{a.patient.phone}</span>
                              </>
                            )}
                          </p>
                          {a.reason && (
                            <p className="text-[10px] text-muted-foreground italic truncate mt-0.5">
                              {a.reason}
                            </p>
                          )}
                          {overdueDays > 0 && (
                            <p className="text-[10px] text-destructive mt-0.5">
                              {overdueDays}d em atraso
                            </p>
                          )}
                        </div>
                        <ChevronRight size={12} className="opacity-0 group-hover:opacity-50 mt-0.5 shrink-0" />
                      </div>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </aside>

      {/* Main area: navegacao + AgendaResourceView */}
      <div className="flex-1 flex flex-col gap-2 overflow-hidden">
        <div className="flex items-center gap-2">
          <button
            onClick={() => {
              const d = new Date(date);
              d.setDate(d.getDate() - 1);
              setDate(d);
            }}
            className="px-2 py-1 rounded hover:bg-accent text-xs border border-border"
          >
            ← Anterior
          </button>
          <button
            onClick={() => setDate(new Date())}
            className="px-2 py-1 rounded hover:bg-accent text-xs border border-border"
          >
            Hoje
          </button>
          <button
            onClick={() => {
              const d = new Date(date);
              d.setDate(d.getDate() + 1);
              setDate(d);
            }}
            className="px-2 py-1 rounded hover:bg-accent text-xs border border-border"
          >
            Próximo →
          </button>
          <span className="text-sm font-semibold ml-2">
            {date.toLocaleDateString('pt-BR', {
              weekday: 'long',
              day: '2-digit',
              month: 'long',
              year: 'numeric',
            })}
          </span>
          <span className="ml-auto text-xs text-muted-foreground">
            {filteredProfessionals.length}/{professionals.length} profissionais visíveis
          </span>
        </div>

        <div className="flex-1 overflow-auto">
          <AgendaResourceView
            date={date}
            professionals={filteredProfessionals}
            events={events}
            onEventClick={onEventClick}
            onSlotClick={onSlotClick}
            onMove={onMove}
          />
        </div>
      </div>
    </div>
  );
}

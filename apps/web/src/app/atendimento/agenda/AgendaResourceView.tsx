'use client';

/**
 * AgendaResourceView — Fase 12 PR2.
 *
 * Visao multi-coluna por profissional (estilo Clinicorp), usando
 * DayPilot Lite (Apache 2.0). Cada coluna representa um User
 * (dentista) e os agendamentos sao posicionados na coluna do
 * assigned_user_id.
 *
 * Coexiste com a Schedule-X (visao Semana/Mes/Dia padrao) — toggle
 * no page.tsx escolhe entre "Semana" (Schedule-X) e "Profissional"
 * (este componente).
 *
 * Eventos:
 *   - Click em evento → abre modal de edicao (callback onEventClick)
 *   - Click em slot vazio → abre modal de criar (callback onSlotClick)
 *   - Drag & drop entre colunas → atualiza assigned_user_id (callback onMove)
 *
 * Cores semanticas por status (estilo Dental Office):
 *   - rosa            AGENDADO
 *   - verde           CONFIRMADO
 *   - laranja         EM_ATENDIMENTO
 *   - verde escuro    CONCLUIDO
 *   - amarelo         CANCELADO (desmarcou)
 *   - vermelho escuro NO_SHOW (faltou)
 */

import { useEffect, useMemo, useRef } from 'react';
import { DayPilotCalendar, DayPilot } from '@daypilot/daypilot-lite-react';

export interface ResourceUser {
  id: string;
  name: string;
}

export interface ResourceEvent {
  id: string;
  title: string;
  start_at: string;
  end_at?: string | null;
  type: string;
  status: string;
  assigned_user_id?: string | null;
}

interface Props {
  date: Date;
  professionals: ResourceUser[];
  events: ResourceEvent[];
  onEventClick?: (eventId: string) => void;
  onSlotClick?: (params: { start: string; end: string; assigned_user_id: string }) => void;
  onMove?: (params: { id: string; start: string; end: string; assigned_user_id: string }) => void;
  startHour?: number;
  endHour?: number;
}

const STATUS_COLORS: Record<string, { back: string; border: string; text: string }> = {
  AGENDADO:       { back: '#FCE4EC', border: '#E91E63', text: '#5C0011' }, // rosa
  CONFIRMADO:     { back: '#D4EDDA', border: '#28A745', text: '#0F4416' }, // verde
  EM_ATENDIMENTO: { back: '#FFEDD5', border: '#f97316', text: '#7c2d12' }, // laranja
  CONCLUIDO:      { back: '#DCFCE7', border: '#15803d', text: '#14532d' }, // verde escuro
  CANCELADO:      { back: '#FEF9C3', border: '#eab308', text: '#713f12' }, // amarelo (desmarcou)
  NO_SHOW:        { back: '#FEE2E2', border: '#991b1b', text: '#7f1d1d' }, // vermelho escuro (faltou)
};

function statusOf(ev: ResourceEvent) {
  return STATUS_COLORS[ev.status] || STATUS_COLORS.AGENDADO;
}

function toLocalDpString(iso: string): string {
  // App usa UTC-naive. Pega componentes UTC e devolve "YYYY-MM-DDTHH:mm:ss".
  const d = new Date(iso);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  const h = String(d.getUTCHours()).padStart(2, '0');
  const mi = String(d.getUTCMinutes()).padStart(2, '0');
  return `${y}-${m}-${day}T${h}:${mi}:00`;
}

function dpStringToISO(dp: string): string {
  // "YYYY-MM-DDTHH:mm:ss" naive → assumimos UTC (mesmo padrao da app)
  const [datePart, timePart = '00:00:00'] = dp.split('T');
  const [y, mo, d] = datePart.split('-').map(Number);
  const [h, mi, s = 0] = timePart.split(':').map(Number);
  return new Date(Date.UTC(y, mo - 1, d, h, mi, s)).toISOString();
}

export function AgendaResourceView({
  date,
  professionals,
  events,
  onEventClick,
  onSlotClick,
  onMove,
  startHour = 7,
  endHour = 21,
}: Props) {
  const calendarRef = useRef<DayPilotCalendar>(null);

  // Filtra eventos do dia ativo + apenas com assigned_user_id de um profissional listado
  const dayEvents = useMemo(() => {
    const proIds = new Set(professionals.map((p) => p.id));
    const dayKey = date.toISOString().slice(0, 10);
    return events
      .filter((e) => e.assigned_user_id && proIds.has(e.assigned_user_id))
      .filter((e) => {
        const evDay = new Date(e.start_at).toISOString().slice(0, 10);
        return evDay === dayKey;
      })
      .map((e) => {
        const c = statusOf(e);
        return {
          id: e.id,
          text: e.title,
          start: toLocalDpString(e.start_at),
          end: toLocalDpString(e.end_at || new Date(new Date(e.start_at).getTime() + 30 * 60000).toISOString()),
          resource: e.assigned_user_id!,
          backColor: c.back,
          borderColor: c.border,
          fontColor: c.text,
        };
      });
  }, [events, date, professionals]);

  const columns = useMemo(
    () => professionals.map((p) => ({ id: p.id, name: p.name })),
    [professionals],
  );

  return (
    <div className="bg-card rounded-xl border border-border overflow-hidden">
      <DayPilotCalendar
        ref={calendarRef}
        viewType="Resources"
        startDate={date.toISOString().slice(0, 10)}
        columns={columns}
        events={dayEvents}
        cellHeight={36}
        cellDuration={30}
        businessBeginsHour={startHour}
        businessEndsHour={endHour}
        // Fora do horario comercial fica destacado nativamente pelo Lite
        timeFormat="Clock24Hours"
        headerDateFormat="dddd"
        eventBorderRadius={4}
        eventDeleteHandling="Disabled"
        onEventClick={(args) => onEventClick?.(args.e.id() as string)}
        onTimeRangeSelected={(args) => {
          if (!onSlotClick) return;
          onSlotClick({
            start: dpStringToISO(args.start.toString()),
            end: dpStringToISO(args.end.toString()),
            assigned_user_id: args.resource as string,
          });
          calendarRef.current?.control?.clearSelection();
        }}
        onEventMove={(args) => {
          if (!onMove) return;
          onMove({
            id: args.e.id() as string,
            start: dpStringToISO(args.newStart.toString()),
            end: dpStringToISO(args.newEnd.toString()),
            assigned_user_id: args.newResource as string,
          });
        }}
      />
      <div className="px-3 py-1.5 border-t border-border flex items-center gap-3 text-[10px] text-muted-foreground">
        <span>Legenda:</span>
        {Object.entries({
          AGENDADO: 'Agendado',
          CONFIRMADO: 'Confirmado',
          EM_ATENDIMENTO: 'Em atendimento',
          CONCLUIDO: 'Concluido',
          CANCELADO: 'Desmarcou',
          NO_SHOW: 'Faltou',
        }).map(([k, label]) => {
          const c = STATUS_COLORS[k];
          return (
            <span key={k} className="inline-flex items-center gap-1">
              <span
                className="inline-block w-2.5 h-2.5 rounded-sm border"
                style={{ background: c.back, borderColor: c.border }}
              />
              {label}
            </span>
          );
        })}
        <span className="ml-auto opacity-60">Powered by DayPilot (daypilot.org)</span>
      </div>
    </div>
  );
}

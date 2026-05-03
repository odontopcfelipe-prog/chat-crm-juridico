'use client';

/**
 * Editor de horarios de atendimento do dentista — REUSAVEL.
 *
 * Fase 25 (Onda 5e v10) — Substitui a UI antiga (1 horario por dia + almoco)
 * por uma UI multi-turno (N turnos por dia, sem almoco — turnos separados ja
 * cumprem esse papel). IA respeita os turnos via check_availability +
 * book_appointment.
 *
 * Usado em:
 *   - /atendimento/settings/office (config sozinha)
 *   - /atendimento/settings/users (modal de criar/editar dentista)
 *
 * Recebe value (DaySchedule[]) + onChange. Nao chama API direto — quem usa
 * decide quando salvar (botao Salvar separado, ou no submit do form).
 */

import { Trash2, Plus, Copy, Clock } from 'lucide-react';

const DAY_NAMES = ['Domingo', 'Segunda', 'Terça', 'Quarta', 'Quinta', 'Sexta', 'Sábado'];

export interface Shift {
  id: string;        // local-only (regenerado ao salvar no backend)
  start_time: string;
  end_time: string;
  label: string;
}

export interface DaySchedule {
  day_of_week: number;
  enabled: boolean;
  shifts: Shift[];
}

const newShiftId = () => Math.random().toString(36).slice(2, 10);

export const defaultShifts = (): Shift[] => [
  { id: newShiftId(), start_time: '08:00', end_time: '12:00', label: 'Manhã' },
  { id: newShiftId(), start_time: '14:00', end_time: '18:00', label: 'Tarde' },
];

export const defaultWeekSchedule = (): DaySchedule[] =>
  Array.from({ length: 7 }, (_, i) => ({
    day_of_week: i,
    enabled: i >= 1 && i <= 5,
    shifts: i >= 1 && i <= 5 ? defaultShifts() : [],
  }));

/**
 * Converte payload da API ([{day_of_week, start_time, end_time, lunch_*, label}])
 * pro modelo da UI (DaySchedule[7]). Backward compat: registros com lunch_*
 * sao expandidos em 2 turnos (manha + tarde).
 */
export function apiScheduleToDays(apiData: any[]): DaySchedule[] {
  return Array.from({ length: 7 }, (_, i) => {
    const dayShifts = apiData.filter((d: any) => d.day_of_week === i);
    if (dayShifts.length === 0) {
      return { day_of_week: i, enabled: false, shifts: [] };
    }
    const shifts: Shift[] = [];
    for (const entry of dayShifts) {
      if (entry.lunch_start && entry.lunch_end) {
        shifts.push({ id: newShiftId(), start_time: entry.start_time, end_time: entry.lunch_start, label: entry.label || 'Manhã' });
        shifts.push({ id: newShiftId(), start_time: entry.lunch_end, end_time: entry.end_time, label: 'Tarde' });
      } else {
        shifts.push({ id: newShiftId(), start_time: entry.start_time, end_time: entry.end_time, label: entry.label || '' });
      }
    }
    return { day_of_week: i, enabled: true, shifts };
  });
}

/**
 * Converte modelo da UI pro payload do PUT /calendar/schedule/:userId.
 * Achata todos os turnos de todos os dias em uma unica lista.
 */
export function daysToApiSlots(days: DaySchedule[]) {
  const slots: Array<{
    day_of_week: number;
    start_time: string;
    end_time: string;
    label: string | null;
    sort_order: number;
    lunch_start: null;
    lunch_end: null;
  }> = [];
  for (const day of days) {
    if (!day.enabled) continue;
    const valid = day.shifts.filter((s) => s.start_time && s.end_time && s.start_time < s.end_time);
    valid.forEach((shift, idx) => {
      slots.push({
        day_of_week: day.day_of_week,
        start_time: shift.start_time,
        end_time: shift.end_time,
        label: shift.label.trim() || null,
        sort_order: idx,
        lunch_start: null,
        lunch_end: null,
      });
    });
  }
  return slots;
}

interface Props {
  value: DaySchedule[];
  onChange: (next: DaySchedule[]) => void;
  /** se true, mostra hint inline + botao "copiar Segunda" */
  showHelp?: boolean;
  /** modo compacto: padding menor, fonte menor — bom pra modais embedados */
  compact?: boolean;
}

export function ScheduleEditor({ value, onChange, showHelp = true, compact = false }: Props) {
  const updateDay = (dow: number, fn: (d: DaySchedule) => DaySchedule) => {
    onChange(value.map((d) => (d.day_of_week === dow ? fn(d) : d)));
  };

  const addShift = (dow: number) => {
    updateDay(dow, (d) => {
      const last = d.shifts[d.shifts.length - 1];
      const defaultStart = last ? last.end_time : '14:00';
      const [h, m] = defaultStart.split(':').map(Number);
      const endH = Math.min(22, h + 4);
      const defaultEnd = `${String(endH).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
      return {
        ...d,
        shifts: [...d.shifts, { id: newShiftId(), start_time: defaultStart, end_time: defaultEnd, label: '' }],
      };
    });
  };

  const removeShift = (dow: number, shiftId: string) => {
    updateDay(dow, (d) => ({ ...d, shifts: d.shifts.filter((s) => s.id !== shiftId) }));
  };

  const updateShift = (dow: number, shiftId: string, patch: Partial<Shift>) => {
    updateDay(dow, (d) => ({
      ...d,
      shifts: d.shifts.map((s) => (s.id === shiftId ? { ...s, ...patch } : s)),
    }));
  };

  const copyMondayToWeekdays = () => {
    const monday = value.find((d) => d.day_of_week === 1);
    if (!monday || monday.shifts.length === 0) return;
    onChange(
      value.map((d) => {
        if (d.day_of_week >= 2 && d.day_of_week <= 5) {
          return { ...d, enabled: true, shifts: monday.shifts.map((s) => ({ ...s, id: newShiftId() })) };
        }
        return d;
      }),
    );
  };

  const inputCls = compact ? 'px-2 py-0.5 text-xs' : 'px-2 py-1 text-sm';
  const labelCls = compact ? 'text-xs' : 'text-sm';

  return (
    <div>
      {showHelp && (
        <div className="flex items-start gap-2 mb-3 p-3 rounded-lg bg-primary/5 border border-primary/20 text-xs">
          <Clock size={14} className="text-primary shrink-0 mt-0.5" />
          <div className="flex-1">
            <p className="text-foreground">
              Cada dia pode ter <strong>vários turnos</strong> (ex: Manhã 08:00-12:00 + Tarde 14:00-18:00).
              A IA respeita os intervalos entre eles.
            </p>
            <button
              type="button"
              onClick={copyMondayToWeekdays}
              className="inline-flex items-center gap-1 mt-2 px-2 py-1 rounded text-primary hover:bg-primary/10 transition-colors"
            >
              <Copy size={11} /> Copiar horário de Segunda pra Ter-Sex
            </button>
          </div>
        </div>
      )}

      <div className="space-y-2">
        {value.map((day) => (
          <div
            key={day.day_of_week}
            className={`rounded-xl border ${day.enabled ? 'border-border bg-muted/10' : 'border-border/50 bg-muted/5'} ${compact ? 'p-2' : 'p-3'}`}
          >
            <div className="flex items-center justify-between mb-2">
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={day.enabled}
                  onChange={(e) => {
                    const enabled = e.target.checked;
                    updateDay(day.day_of_week, (d) => ({
                      ...d,
                      enabled,
                      shifts: enabled && d.shifts.length === 0 ? defaultShifts() : d.shifts,
                    }));
                  }}
                  className="w-4 h-4 rounded border-border text-primary focus:ring-primary"
                />
                <span className={`font-semibold ${labelCls} ${day.enabled ? 'text-foreground' : 'text-muted-foreground'}`}>
                  {DAY_NAMES[day.day_of_week]}
                </span>
                {day.enabled && day.shifts.length > 0 && (
                  <span className="text-[10px] text-muted-foreground">
                    ({day.shifts.length} {day.shifts.length === 1 ? 'turno' : 'turnos'})
                  </span>
                )}
              </label>
              {day.enabled && (
                <button
                  type="button"
                  onClick={() => addShift(day.day_of_week)}
                  className="inline-flex items-center gap-1 px-2 py-1 text-[11px] font-semibold text-primary hover:bg-primary/10 rounded transition-colors"
                >
                  <Plus size={11} /> Turno
                </button>
              )}
            </div>

            {day.enabled ? (
              day.shifts.length === 0 ? (
                <p className="text-xs text-muted-foreground italic pl-6">Adicione um turno acima.</p>
              ) : (
                <div className="space-y-1.5 pl-6">
                  {day.shifts.map((shift) => (
                    <div key={shift.id} className="flex items-center gap-2 flex-wrap">
                      <input
                        type="time"
                        value={shift.start_time}
                        onChange={(e) => updateShift(day.day_of_week, shift.id, { start_time: e.target.value })}
                        className={`${inputCls} bg-background border border-border rounded text-foreground w-[100px]`}
                      />
                      <span className="text-muted-foreground text-xs">até</span>
                      <input
                        type="time"
                        value={shift.end_time}
                        onChange={(e) => updateShift(day.day_of_week, shift.id, { end_time: e.target.value })}
                        className={`${inputCls} bg-background border border-border rounded text-foreground w-[100px]`}
                      />
                      <input
                        type="text"
                        value={shift.label}
                        onChange={(e) => updateShift(day.day_of_week, shift.id, { label: e.target.value })}
                        placeholder="Manhã / Tarde…"
                        className={`flex-1 min-w-[120px] ${inputCls} bg-background border border-border rounded text-foreground placeholder:text-muted-foreground/60`}
                      />
                      <button
                        type="button"
                        onClick={() => removeShift(day.day_of_week, shift.id)}
                        className="p-1.5 rounded text-destructive hover:bg-destructive/10 transition-colors shrink-0"
                        title="Remover turno"
                      >
                        <Trash2 size={12} />
                      </button>
                    </div>
                  ))}
                </div>
              )
            ) : (
              <span className="text-xs text-muted-foreground italic pl-6">Não atende neste dia</span>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

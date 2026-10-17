'use client';

// Agendar o paciente SEM sair do quadro (Progresso, Ortodontia). Faz o mesmo que o
// "Novo evento" da agenda: POST /calendar/events (Consulta/Procedimento/Retorno/
// Ortodontia) + lembretes padrão da clínica, checagem de conflito do dentista e bloqueio
// de devedor (admin libera com motivo). Mostra a agenda do dentista no dia escolhido pra
// achar um horário livre sem trocar de tela. Se o save da agenda mudar, mudar aqui também.
import { useEffect, useMemo, useState } from 'react';
import { CalendarPlus, ExternalLink, Loader2 } from 'lucide-react';
import api from '@/lib/api';
import { showError, showSuccess } from '@/lib/toast';
import ModalBase from '@/components/ModalBase';

type Dentist = { id: string; name: string; ortho_days?: number[] };
type Reminder = { minutes_before: number; channel: string };
type DayEvent = {
  id: string;
  start_at: string;
  end_at: string | null;
  type: string;
  status: string;
  title: string;
  patient?: { name: string | null } | null;
  lead?: { name: string | null } | null;
};

// Mesmo fallback da agenda (config da clínica em /calendar/reminders/config).
const FALLBACK_REMINDERS: Reminder[] = [
  { minutes_before: 1440, channel: 'WHATSAPP' },
  { minutes_before: 60, channel: 'WHATSAPP' },
  { minutes_before: 15, channel: 'WHATSAPP' },
];
const DURATIONS = [20, 30, 40, 60];
const WD_SHORT = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];
const TYPE_LABEL: Record<string, string> = {
  CONSULTA: 'Consulta', PROCEDIMENTO: 'Procedimento', RETORNO: 'Retorno', ORTODONTIA: 'Ortodontia',
  BLOQUEIO: 'Bloqueio', TAREFA: 'Tarefa', OUTRO: 'Outro',
};

const p2 = (n: number) => String(n).padStart(2, '0');
// A agenda é naive-UTC: a hora de Maceió fica gravada nos campos UTC.
const ymd = (d: Date) => `${d.getUTCFullYear()}-${p2(d.getUTCMonth() + 1)}-${p2(d.getUTCDate())}`;
const hhmm = (iso: string) => { const d = new Date(iso); return `${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}`; };
const naiveIso = (date: string, time: string) => `${date}T${time}:00.000Z`;
const weekdayOf = (date: string) => new Date(`${date}T12:00:00.000Z`).getUTCDay();

/** Próximo dia (a partir de amanhã, fuso Maceió) que cai num dos dias da semana;
 *  sem dia definido, o próximo dia útil (seg–sáb — domingo a clínica não abre). */
function nextDateOn(days: number[]): string {
  const want = days.length ? days : [1, 2, 3, 4, 5, 6];
  const d = new Date(Date.now() - 3 * 60 * 60 * 1000);
  for (let i = 0; i < 7; i++) {
    d.setUTCDate(d.getUTCDate() + 1);
    if (want.includes(d.getUTCDay())) break;
  }
  return ymd(d);
}

function addMinutes(time: string, minutes: number): string {
  const [h, m] = time.split(':').map(Number);
  const total = Math.min(h * 60 + m + minutes, 23 * 60 + 59);
  return `${p2(Math.floor(total / 60))}:${p2(total % 60)}`;
}

export type ApptType = 'CONSULTA' | 'PROCEDIMENTO' | 'RETORNO' | 'ORTODONTIA';
const APPT_TYPES: ApptType[] = ['CONSULTA', 'PROCEDIMENTO', 'RETORNO', 'ORTODONTIA'];

export function AgendarPacienteModal({
  patient, dentist, defaultType, weekday = null, dentists, isAdmin, onClose, onDone, onOpenAgenda,
}: {
  patient: { id: string; name: string | null };
  dentist: { id: string; name: string } | null;
  defaultType: ApptType;
  weekday?: number | null; // dia em que o paciente costuma vir (ortô)
  dentists: Dentist[];
  isAdmin: boolean;
  onClose: () => void;
  onDone: () => void;
  onOpenAgenda: () => void;
}) {
  const [type, setType] = useState<ApptType>(defaultType);
  const [dentistId, setDentistId] = useState(dentist?.id || '');
  const selected = dentists.find((d) => d.id === dentistId);
  // Dias de ortodontia do dentista — só valem (sugestão/aviso) pra consulta de ortô.
  const orthoDays = type === 'ORTODONTIA' ? selected?.ortho_days || [] : [];
  const [date, setDate] = useState(() =>
    nextDateOn(
      weekday != null ? [weekday]
        : defaultType === 'ORTODONTIA' ? (dentists.find((d) => d.id === dentist?.id)?.ortho_days || [])
          : [],
    ),
  );
  const [time, setTime] = useState('');
  const [duration, setDuration] = useState(30);
  const [saving, setSaving] = useState(false);
  const [reminders, setReminders] = useState<Reminder[]>(FALLBACK_REMINDERS);
  const [dayEvents, setDayEvents] = useState<DayEvent[] | null>(null);

  useEffect(() => {
    // Lista VAZIA = a clínica desligou os lembretes → respeita (igual a agenda).
    api.get('/calendar/reminders/config')
      .then((r) => { if (Array.isArray(r.data?.default_antecedencias)) setReminders(r.data.default_antecedencias); })
      .catch(() => {});
  }, []);

  // Agenda do dentista no dia escolhido (pra achar horário livre).
  useEffect(() => {
    if (!dentistId || !date) { setDayEvents(null); return; }
    let alive = true;
    setDayEvents(null);
    api.get<DayEvent[]>('/calendar/events', {
      params: { start: `${date}T00:00:00.000Z`, end: `${date}T23:59:59.999Z`, userId: dentistId },
    })
      .then((r) => { if (alive) setDayEvents((r.data || []).filter((e) => e.status !== 'CANCELADO')); })
      .catch(() => { if (alive) setDayEvents([]); });
    return () => { alive = false; };
  }, [dentistId, date]);

  const endTime = time ? addMinutes(time, duration) : '';
  const foraDoDia = !!date && orthoDays.length > 0 && !orthoDays.includes(weekdayOf(date));
  const choque = useMemo(() => {
    if (!time || !dayEvents) return null;
    const s = naiveIso(date, time), e = naiveIso(date, endTime);
    return dayEvents.find((ev) => ev.start_at < e && (ev.end_at || ev.start_at) > s) || null;
  }, [dayEvents, date, time, endTime]);

  const submit = async () => {
    if (!dentistId) { showError('Escolha o dentista'); return; }
    if (!date || !time) { showError('Escolha a data e o horário'); return; }
    setSaving(true);
    const start_at = naiveIso(date, time);
    const end_at = naiveIso(date, endTime);
    try {
      // Conflito é decidido no backend (ortô "por ordem de chegada" não conflita).
      try {
        const c = await api.get('/calendar/conflicts', {
          params: { userId: dentistId, start: start_at, end: end_at, type }, timeout: 8000,
        });
        if (c.data?.length > 0) {
          const ev = c.data[0];
          showError(`Conflito com "${ev.title}" (${hhmm(ev.start_at)}–${ev.end_at ? hhmm(ev.end_at) : ''}) — escolha outro horário`);
          return;
        }
      } catch { /* checagem não-crítica — o save segue */ }

      // Lembretes que ainda cabem até a consulta (string sem "Z" = hora local de Maceió).
      const minutesUntil = Math.floor((new Date(`${date}T${time}:00`).getTime() - Date.now()) / 60_000);
      const payload: any = {
        type,
        title: `${TYPE_LABEL[type]} — ${patient.name || 'Paciente'}`,
        start_at,
        end_at,
        all_day: false,
        status: 'AGENDADO',
        assigned_user_id: dentistId,
        lead_id: null,
        patient_id: patient.id,
        reminders: reminders.filter((r) => r.minutes_before < minutesUntil),
      };
      try {
        await api.post('/calendar/events', payload, { timeout: 30000 });
      } catch (e: any) {
        const data = e?.response?.data;
        // Bloqueio de devedor: admin pode liberar com motivo (fica registrado no evento).
        if (data?.code !== 'SCHEDULING_BLOCKED_OVERDUE' || !isAdmin) throw e;
        const reason = window.prompt(
          `${data.message}\n\nVocê é ADMIN e pode LIBERAR este agendamento mesmo assim.\nDigite o MOTIVO da liberação (fica registrado):`,
          '',
        );
        if (!reason?.trim()) { showError('Liberação cancelada — informe um motivo para agendar mesmo assim.'); return; }
        await api.post('/calendar/events', { ...payload, override_overdue_block: true, override_overdue_reason: reason.trim() }, { timeout: 30000 });
      }
      showSuccess(`${patient.name || 'Paciente'} agendado(a) — ${date.split('-').reverse().slice(0, 2).join('/')} às ${time}`);
      onDone();
      onClose();
    } catch (e: any) {
      showError(e?.response?.data?.message || e?.message || 'Erro ao agendar. Tente novamente');
    } finally {
      setSaving(false);
    }
  };

  const field = 'w-full px-2.5 py-2 rounded-lg border border-border bg-background text-sm outline-none focus:ring-2 focus:ring-primary/30';

  return (
    <ModalBase
      open
      onClose={() => { if (!saving) onClose(); }}
      size="md"
      title={type === 'ORTODONTIA' ? 'Agendar ortodontia' : 'Agendar consulta'}
      subtitle={patient.name || 'Paciente'}
      footer={
        <div className="flex items-center justify-between gap-2">
          <button type="button" onClick={onOpenAgenda} disabled={saving}
            className="text-xs text-muted-foreground hover:text-foreground inline-flex items-center gap-1 disabled:opacity-50">
            <ExternalLink size={12} /> Abrir na agenda
          </button>
          <div className="flex gap-2">
            <button type="button" onClick={onClose} disabled={saving}
              className="px-4 py-2 rounded-lg border border-border text-sm hover:bg-muted disabled:opacity-50">
              Cancelar
            </button>
            <button type="button" onClick={submit} disabled={saving || !dentistId || !date || !time}
              className="px-4 py-2 rounded-lg bg-emerald-600 text-white text-sm font-medium inline-flex items-center gap-2 hover:bg-emerald-700 disabled:opacity-50">
              {saving ? <Loader2 size={14} className="animate-spin" /> : <CalendarPlus size={14} />}
              Agendar
            </button>
          </div>
        </div>
      }
    >
      <div className="space-y-3">
        <div>
          <label className="text-[11px] font-bold uppercase tracking-wider text-muted-foreground mb-1 block">Tipo</label>
          <div className="flex flex-wrap gap-1.5">
            {APPT_TYPES.map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => setType(t)}
                className={`px-2.5 py-1 rounded-lg text-xs font-semibold border transition-colors ${
                  type === t ? 'bg-primary text-primary-foreground border-primary' : 'border-border text-muted-foreground hover:bg-muted'
                }`}
              >
                {TYPE_LABEL[t]}
              </button>
            ))}
          </div>
        </div>
        <div>
          <label className="text-[11px] font-bold uppercase tracking-wider text-muted-foreground mb-1 block">Dentista</label>
          <select value={dentistId} onChange={(e) => setDentistId(e.target.value)} className={field}>
            <option value="">Escolha o dentista…</option>
            {dentists.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
          </select>
          {orthoDays.length > 0 && (
            <p className="text-[11px] text-muted-foreground mt-1">
              Atende ortodontia: {orthoDays.map((d) => WD_SHORT[d]).join(', ')}
            </p>
          )}
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
          <div className="col-span-2 sm:col-span-1">
            <label className="text-[11px] font-bold uppercase tracking-wider text-muted-foreground mb-1 block">Data</label>
            <input type="date" value={date} onChange={(e) => setDate(e.target.value)} className={field} />
          </div>
          <div>
            <label className="text-[11px] font-bold uppercase tracking-wider text-muted-foreground mb-1 block">Horário</label>
            <input type="time" step={300} value={time} onChange={(e) => setTime(e.target.value)} className={field} />
          </div>
          <div>
            <label className="text-[11px] font-bold uppercase tracking-wider text-muted-foreground mb-1 block">Duração</label>
            <select value={duration} onChange={(e) => setDuration(Number(e.target.value))} className={field}>
              {DURATIONS.map((m) => <option key={m} value={m}>{m} min</option>)}
            </select>
          </div>
        </div>

        {foraDoDia && (
          <div className="rounded-lg border border-amber-300 bg-amber-50 text-amber-900 text-xs p-2">
            {WD_SHORT[weekdayOf(date)]} não é dia de ortodontia de {selected?.name}. Pode agendar mesmo assim, se combinado.
          </div>
        )}
        {choque && (
          <div className="rounded-lg border border-amber-300 bg-amber-50 text-amber-900 text-xs p-2">
            Esse horário encosta em “{choque.patient?.name || choque.lead?.name || choque.title}” ({hhmm(choque.start_at)}).
          </div>
        )}

        {dentistId && date && (
          <div>
            <div className="text-[11px] font-bold uppercase tracking-wider text-muted-foreground mb-1">
              Agenda de {selected?.name || 'dentista'} · {WD_SHORT[weekdayOf(date)]} {date.split('-').reverse().slice(0, 2).join('/')}
            </div>
            <div className="rounded-lg border border-border max-h-48 overflow-y-auto divide-y divide-border">
              {dayEvents === null ? (
                <div className="py-3 flex items-center justify-center text-xs text-muted-foreground">
                  <Loader2 size={13} className="animate-spin mr-1.5" /> Carregando…
                </div>
              ) : dayEvents.length === 0 ? (
                <div className="py-3 text-center text-xs text-muted-foreground">Nenhum horário ocupado nesse dia.</div>
              ) : (
                dayEvents.map((ev) => (
                  <button
                    key={ev.id}
                    type="button"
                    onClick={() => setTime(ev.end_at ? hhmm(ev.end_at) : time)}
                    title="Usar o fim deste horário"
                    className="w-full flex items-center gap-2 px-2.5 py-1.5 text-left text-xs hover:bg-muted/50"
                  >
                    <span className="font-semibold tabular-nums text-foreground shrink-0">
                      {hhmm(ev.start_at)}{ev.end_at ? `–${hhmm(ev.end_at)}` : ''}
                    </span>
                    <span className="truncate text-foreground">{ev.patient?.name || ev.lead?.name || ev.title}</span>
                    <span className="ml-auto shrink-0 text-[10px] text-muted-foreground">{TYPE_LABEL[ev.type] || ev.type}</span>
                  </button>
                ))
              )}
            </div>
          </div>
        )}
      </div>
    </ModalBase>
  );
}

'use client';

/**
 * Onda 17.32.56 — Painel lateral de agendamento dentro da conversa.
 *
 * Abre slide-in a direita quando operador clica no botao "Agendar" do
 * header da conversa. Permite agendar SEM SAIR do chat (operador pode
 * continuar lendo as msgs enquanto preenche).
 *
 * Fluxo:
 *  1. Operador preenche formulario (data, hora, tipo, dentista, etc)
 *  2. Clica "Agendar"
 *  3. POST /calendar/events cria evento
 *  4. POST /messages/send manda confirmacao WhatsApp padrao pro lead
 *  5. Painel fecha, toast de sucesso
 */
import { useEffect, useState } from 'react';
import { Calendar, X, Loader2, User, Stethoscope, MapPin, Bell, FileText, Clock } from 'lucide-react';
import api from '@/lib/api';
import { showError, showSuccess } from '@/lib/toast';

interface Specialist {
  id: string;
  name: string;
  specialties?: string[];
}

interface Procedure {
  id: string;
  name: string;
  default_duration_minutes?: number | null;
}

interface Room {
  id: string;
  name: string;
}

interface Props {
  open: boolean;
  onClose: () => void;
  // Contexto da conversa
  leadId: string | null;
  patientId: string | null;
  contactName: string;
  contactPhone: string | null;
  conversationId: string | null;
}

const APPT_TYPES = [
  { value: 'CONSULTA', label: 'Consulta' },
  { value: 'PROCEDIMENTO', label: 'Procedimento' },
  { value: 'RETORNO', label: 'Retorno' },
  { value: 'OUTRO', label: 'Avaliacao' },
];

const DURATIONS = [15, 30, 45, 60, 90, 120];

const REMINDERS = [
  { minutes: 0, label: 'Sem lembrete' },
  { minutes: 15, label: '15 min antes' },
  { minutes: 30, label: '30 min antes' },
  { minutes: 60, label: '1 hora antes' },
  { minutes: 120, label: '2 horas antes' },
  { minutes: 1440, label: '1 dia antes' },
];

export function AgendaPanel({
  open,
  onClose,
  leadId,
  patientId,
  contactName,
  contactPhone,
  conversationId,
}: Props) {
  // Form state
  const today = new Date();
  const defaultDate = today.toISOString().slice(0, 10);
  const defaultHour = `${String(Math.min(today.getHours() + 1, 18)).padStart(2, '0')}:00`;

  const [date, setDate] = useState(defaultDate);
  const [time, setTime] = useState(defaultHour);
  const [duration, setDuration] = useState(60);
  const [type, setType] = useState<string>('CONSULTA');
  const [dentistId, setDentistId] = useState<string>('');
  const [procedureId, setProcedureId] = useState<string>('');
  const [roomId, setRoomId] = useState<string>('');
  const [reminderMinutes, setReminderMinutes] = useState<number>(60);
  const [notes, setNotes] = useState('');
  const [sending, setSending] = useState(false);

  // Listas
  const [dentists, setDentists] = useState<Specialist[]>([]);
  const [procedures, setProcedures] = useState<Procedure[]>([]);
  const [rooms, setRooms] = useState<Room[]>([]);
  const [loadingLists, setLoadingLists] = useState(false);

  // Carrega listas ao abrir
  useEffect(() => {
    if (!open) return;
    setLoadingLists(true);
    Promise.allSettled([
      api.get<Specialist[]>('/users?role=DENTISTA'),
      api.get<Procedure[]>('/procedures'),
      api.get<Room[]>('/rooms'),
    ])
      .then(([dResp, pResp, rResp]) => {
        if (dResp.status === 'fulfilled') {
          const data: any = dResp.value.data;
          setDentists(Array.isArray(data) ? data : (data?.data || []));
        }
        if (pResp.status === 'fulfilled') {
          const data: any = pResp.value.data;
          setProcedures(Array.isArray(data) ? data : (data?.data || []));
        }
        if (rResp.status === 'fulfilled') {
          const data: any = rResp.value.data;
          setRooms(Array.isArray(data) ? data : (data?.data || []));
        }
      })
      .finally(() => setLoadingLists(false));
  }, [open]);

  // Reseta form ao fechar
  useEffect(() => {
    if (!open) {
      setNotes('');
      setSending(false);
    }
  }, [open]);

  // Auto-ajusta duracao quando procedimento muda
  const handleProcedureChange = (id: string) => {
    setProcedureId(id);
    const proc = procedures.find((p) => p.id === id);
    if (proc?.default_duration_minutes) {
      setDuration(proc.default_duration_minutes);
    }
  };

  const handleSubmit = async () => {
    if (!dentistId) {
      showError('Selecione um dentista');
      return;
    }
    if (!date || !time) {
      showError('Informe data e horario');
      return;
    }
    setSending(true);
    try {
      // 1. Monta start_at ISO
      const startISO = new Date(`${date}T${time}:00`).toISOString();
      const endISO = new Date(new Date(`${date}T${time}:00`).getTime() + duration * 60_000).toISOString();
      const procName = procedureId ? procedures.find((p) => p.id === procedureId)?.name : null;
      const dentistName = dentists.find((d) => d.id === dentistId)?.name || 'profissional';
      const typeLabel = APPT_TYPES.find((t) => t.value === type)?.label || 'Atendimento';

      const title = procName
        ? `${typeLabel} — ${procName}`
        : `${typeLabel} — ${contactName}`;

      // 2. Cria evento
      const payload: any = {
        type,
        title,
        start_at: startISO,
        end_at: endISO,
        assigned_user_id: dentistId,
        description: notes || undefined,
      };
      if (patientId) payload.patient_id = patientId;
      else if (leadId) payload.lead_id = leadId;
      if (roomId) payload.location = rooms.find((r) => r.id === roomId)?.name || undefined;
      if (reminderMinutes > 0) {
        payload.reminders = [{ minutes_before: reminderMinutes, channel: 'WHATSAPP' }];
      }

      await api.post('/calendar/events', payload);

      // 3. Manda mensagem padrao no WhatsApp (best-effort, nao bloqueia
      //    sucesso se falhar — operador foi informado pelo toast)
      if (conversationId) {
        const dateBR = new Date(`${date}T${time}:00`).toLocaleDateString('pt-BR', {
          day: '2-digit', month: '2-digit', year: 'numeric',
        });
        const msg =
          `*Agendamento confirmado* ✅\n\n` +
          `📅 ${dateBR} as ${time}\n` +
          `👨‍⚕️ ${dentistName}\n` +
          `🦷 ${typeLabel}` +
          (procName ? ` — ${procName}` : '') +
          `\n⏱ Duracao: ${duration} minutos` +
          (notes ? `\n\n_${notes}_` : '') +
          `\n\nQualquer duvida, basta responder por aqui.`;
        api.post('/messages/send', {
          conversation_id: conversationId,
          text: msg,
        }).catch((err) => {
          console.warn('[AgendaPanel] Falha ao mandar msg confirmacao WhatsApp:', err);
        });
      }

      showSuccess('Agendamento criado e cliente notificado!');
      onClose();
    } catch (err: any) {
      const msg = err?.response?.data?.message || 'Erro ao criar agendamento';
      showError(typeof msg === 'string' ? msg : (Array.isArray(msg) ? msg.join(', ') : 'Erro ao criar agendamento'));
    } finally {
      setSending(false);
    }
  };

  if (!open) return null;

  return (
    <div className="fixed inset-y-0 right-0 z-50 w-full sm:w-[420px] bg-card border-l border-border shadow-2xl flex flex-col animate-in slide-in-from-right duration-200">
      {/* Header */}
      <div className="flex items-center justify-between gap-3 px-4 py-3 border-b border-border bg-emerald-500/5 shrink-0">
        <div className="flex items-center gap-2 min-w-0">
          <div className="w-8 h-8 rounded-lg bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 flex items-center justify-center">
            <Calendar size={16} />
          </div>
          <div className="min-w-0">
            <h2 className="text-sm font-bold text-foreground">Novo agendamento</h2>
            <p className="text-[11px] text-muted-foreground truncate">
              {contactName}
              {contactPhone && ` · ${contactPhone}`}
            </p>
          </div>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="p-1.5 rounded-md hover:bg-accent/40 text-muted-foreground hover:text-foreground transition-colors shrink-0"
          title="Fechar"
        >
          <X size={18} />
        </button>
      </div>

      {/* Form */}
      <div className="flex-1 overflow-auto p-4 space-y-3">
        {/* Data + Hora */}
        <div className="grid grid-cols-2 gap-2">
          <div>
            <label className="text-[10px] uppercase tracking-wider font-bold text-muted-foreground mb-1 block">Data</label>
            <input
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
              className="w-full px-3 py-2 text-sm border border-border rounded-md bg-background text-foreground focus:outline-none focus:ring-2 focus:ring-emerald-500/30"
            />
          </div>
          <div>
            <label className="text-[10px] uppercase tracking-wider font-bold text-muted-foreground mb-1 block">Hora</label>
            <input
              type="time"
              value={time}
              onChange={(e) => setTime(e.target.value)}
              className="w-full px-3 py-2 text-sm border border-border rounded-md bg-background text-foreground focus:outline-none focus:ring-2 focus:ring-emerald-500/30"
            />
          </div>
        </div>

        {/* Duracao */}
        <div>
          <label className="text-[10px] uppercase tracking-wider font-bold text-muted-foreground mb-1 flex items-center gap-1">
            <Clock size={10} /> Duracao
          </label>
          <div className="flex gap-1 flex-wrap">
            {DURATIONS.map((d) => (
              <button
                key={d}
                type="button"
                onClick={() => setDuration(d)}
                className={`text-xs font-semibold px-3 py-1.5 rounded-md border transition-colors ${
                  duration === d
                    ? 'bg-emerald-500/15 border-emerald-500/40 text-emerald-700 dark:text-emerald-400'
                    : 'bg-background border-border text-muted-foreground hover:bg-accent/40'
                }`}
              >
                {d < 60 ? `${d}min` : `${d / 60}h${d % 60 ? (d % 60) + 'm' : ''}`}
              </button>
            ))}
          </div>
        </div>

        {/* Tipo */}
        <div>
          <label className="text-[10px] uppercase tracking-wider font-bold text-muted-foreground mb-1 block">Tipo</label>
          <div className="grid grid-cols-2 gap-1.5">
            {APPT_TYPES.map((t) => (
              <button
                key={t.value}
                type="button"
                onClick={() => setType(t.value)}
                className={`text-xs font-semibold px-3 py-1.5 rounded-md border transition-colors ${
                  type === t.value
                    ? 'bg-sky-500/15 border-sky-500/40 text-sky-700 dark:text-sky-400'
                    : 'bg-background border-border text-muted-foreground hover:bg-accent/40'
                }`}
              >
                {t.label}
              </button>
            ))}
          </div>
        </div>

        {/* Dentista */}
        <div>
          <label className="text-[10px] uppercase tracking-wider font-bold text-muted-foreground mb-1 flex items-center gap-1">
            <User size={10} /> Dentista *
          </label>
          <select
            value={dentistId}
            onChange={(e) => setDentistId(e.target.value)}
            disabled={loadingLists}
            className="w-full px-3 py-2 text-sm border border-border rounded-md bg-background text-foreground focus:outline-none focus:ring-2 focus:ring-emerald-500/30"
          >
            <option value="">{loadingLists ? 'Carregando...' : 'Selecione...'}</option>
            {dentists.map((d) => (
              <option key={d.id} value={d.id}>{d.name}</option>
            ))}
          </select>
        </div>

        {/* Procedimento */}
        <div>
          <label className="text-[10px] uppercase tracking-wider font-bold text-muted-foreground mb-1 flex items-center gap-1">
            <Stethoscope size={10} /> Procedimento
          </label>
          <select
            value={procedureId}
            onChange={(e) => handleProcedureChange(e.target.value)}
            disabled={loadingLists}
            className="w-full px-3 py-2 text-sm border border-border rounded-md bg-background text-foreground focus:outline-none focus:ring-2 focus:ring-emerald-500/30"
          >
            <option value="">{loadingLists ? 'Carregando...' : '(opcional)'}</option>
            {procedures.map((p) => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>
        </div>

        {/* Sala */}
        <div>
          <label className="text-[10px] uppercase tracking-wider font-bold text-muted-foreground mb-1 flex items-center gap-1">
            <MapPin size={10} /> Sala
          </label>
          <select
            value={roomId}
            onChange={(e) => setRoomId(e.target.value)}
            disabled={loadingLists}
            className="w-full px-3 py-2 text-sm border border-border rounded-md bg-background text-foreground focus:outline-none focus:ring-2 focus:ring-emerald-500/30"
          >
            <option value="">{loadingLists ? 'Carregando...' : '(opcional)'}</option>
            {rooms.map((r) => (
              <option key={r.id} value={r.id}>{r.name}</option>
            ))}
          </select>
        </div>

        {/* Lembrete */}
        <div>
          <label className="text-[10px] uppercase tracking-wider font-bold text-muted-foreground mb-1 flex items-center gap-1">
            <Bell size={10} /> Lembrete
          </label>
          <select
            value={reminderMinutes}
            onChange={(e) => setReminderMinutes(Number(e.target.value))}
            className="w-full px-3 py-2 text-sm border border-border rounded-md bg-background text-foreground focus:outline-none focus:ring-2 focus:ring-emerald-500/30"
          >
            {REMINDERS.map((r) => (
              <option key={r.minutes} value={r.minutes}>{r.label}</option>
            ))}
          </select>
        </div>

        {/* Observacao */}
        <div>
          <label className="text-[10px] uppercase tracking-wider font-bold text-muted-foreground mb-1 flex items-center gap-1">
            <FileText size={10} /> Observacao
          </label>
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            rows={2}
            placeholder="Notas internas ou pra incluir na mensagem de confirmacao..."
            className="w-full px-3 py-2 text-sm border border-border rounded-md bg-background text-foreground focus:outline-none focus:ring-2 focus:ring-emerald-500/30 resize-none"
          />
        </div>
      </div>

      {/* Footer */}
      <div className="flex items-center gap-2 px-4 py-3 border-t border-border bg-muted/30 shrink-0">
        <button
          type="button"
          onClick={onClose}
          disabled={sending}
          className="flex-1 text-sm font-semibold px-3 py-2 rounded-md border border-border bg-card text-foreground hover:bg-accent/40 transition-colors disabled:opacity-50"
        >
          Cancelar
        </button>
        <button
          type="button"
          onClick={handleSubmit}
          disabled={sending || !dentistId}
          className="flex-1 text-sm font-bold px-3 py-2 rounded-md bg-emerald-600 hover:bg-emerald-700 text-white transition-colors disabled:opacity-50 inline-flex items-center justify-center gap-2"
        >
          {sending ? (
            <>
              <Loader2 size={14} className="animate-spin" />
              Agendando...
            </>
          ) : (
            <>
              <Calendar size={14} />
              Agendar
            </>
          )}
        </button>
      </div>
    </div>
  );
}

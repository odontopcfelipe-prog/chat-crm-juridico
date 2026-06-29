'use client';

import { useEffect, useState, useCallback, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useRouter } from 'next/navigation';
import { useTheme } from 'next-themes';
import { useNextCalendarApp, ScheduleXCalendar } from '@schedule-x/react';
import { AgendaResourceView } from './AgendaResourceView';
import { AgendaResourceLayout } from './AgendaResourceLayout';
import { AgendaListView } from './AgendaListView';
import ContactPicker from './ContactPicker';
import { createViewDay, createViewWeek, createViewMonthGrid } from '@schedule-x/calendar';
import { createEventsServicePlugin } from '@schedule-x/events-service';
import { createDragAndDropPlugin } from '@schedule-x/drag-and-drop';
import '@schedule-x/theme-default/dist/index.css';
// Bridge CSS: mapeia variáveis do schedule-x pras variáveis dos temas customizados
// do app (escuro, claro, rose, azul, verde, odonto). Importado APÓS o CSS default
// pra que o override funcione. Ver agenda-theme.css pra detalhes.
import './agenda-theme.css';
import {
  Plus, X, Calendar as CalendarIcon, Filter, ChevronDown,
  ChevronLeft, ChevronRight,
  Clock, User, AlertTriangle, CheckCircle2, Bell,
  Download, Copy, Users, Stethoscope,
  LayoutGrid, CalendarDays as CalendarViewIcon,
  ExternalLink, Ban, Loader2,
} from 'lucide-react';
import api, { API_BASE_URL } from '@/lib/api';
import { PatientAvatar } from '@/components/PatientAvatar';
import { useSocket } from '@/lib/SocketProvider';
import { showError, showSuccess } from '@/lib/toast';
import { swallow } from '@/lib/errors';
import { useRole } from '@/lib/useRole';
import { playNotificationSound } from '@/lib/notificationSounds';
import { TasksPanel } from './TasksPanel';
import { ScheduleBlockModal } from './ScheduleBlockModal';

// ─── Tipos ────────────────────────────────────────────

interface CalendarEvent {
  id: string;
  type: string;
  title: string;
  description?: string | null;
  start_at: string;
  end_at?: string | null;
  all_day: boolean;
  status: string;
  priority: string;
  color?: string | null;
  location?: string | null;
  lead_id?: string | null;
  patient_id?: string | null;
  conversation_id?: string | null;
  legal_case_id?: string | null;
  assigned_user_id?: string | null;
  created_by_id?: string | null;
  assigned_user?: { id: string; name: string } | null;
  created_by?: { id: string; name: string } | null;
  lead?: { id: string; name: string | null; phone: string } | null;
  patient?: { id: string; name: string | null; phone: string | null } | null;
  // Validacao clinica (Fase 23)
  validated_at?: string | null;
  validated_by_user_id?: string | null;
  validated_by?: { id: string; name: string } | null;
  validation_notes?: string | null;
  legal_case?: { id: string; case_number: string | null; specialty: string | null; lead?: { name: string | null } | null } | null;
  _count?: { comments: number };
}

interface UserOption {
  id: string;
  name: string;
}

interface LeadOption {
  id: string;
  name: string | null;
  phone: string;
}

// ─── Constantes ───────────────────────────────────────

// Tipos de evento da clínica odontológica.
// CONSULTA = avaliação inicial / consulta (criada pela IA quando lead aceita slot)
// PROCEDIMENTO = tratamento agendado pelo dentista após avaliação (cirurgia,
//                instalação de implante/lente, sessão de clareamento, etc)
// RETORNO = consulta de acompanhamento pós-tratamento (revisão, manutenção)
// BLOQUEIO = bloqueio de agenda do dentista (folga, congresso, manutenção
//            do equipamento) — não é consulta nem procedimento
// TAREFA / OUTRO = administrativas/genéricas
const EVENT_TYPES = [
  { id: 'CONSULTA', label: 'Consulta', emoji: '🟣', color: '#8b5cf6' },
  { id: 'PROCEDIMENTO', label: 'Procedimento', emoji: '🦷', color: '#14b8a6' },
  { id: 'RETORNO', label: 'Retorno', emoji: '🔁', color: '#0ea5e9' },
  { id: 'BLOQUEIO', label: 'Bloqueio', emoji: '🚫', color: '#f59e0b' },
  { id: 'TAREFA', label: 'Tarefa', emoji: '🟢', color: '#22c55e' },
  { id: 'OUTRO', label: 'Outro', emoji: '⚪', color: '#6b7280' },
] as const;

// Onda 17.61 — legenda da agenda com as cores REAIS dos cards (espelha `calendars`
// do schedule-x). CONSULTA é colorida por STATUS; os demais tipos têm cor própria.
// IMPORTANTE: usar estas cores (não EVENT_STATUSES, que tem hex diferente).
const LEGEND_STATUS = [
  { label: 'Agendado', color: '#E91E63' },
  { label: 'Confirmado', color: '#22c55e' },
  { label: 'Chegou', color: '#0ea5e9' },
  { label: 'Em atendimento', color: '#f97316' },
  { label: 'Atendido', color: '#15803d' },
  { label: 'Desmarcou', color: '#eab308' },
  { label: 'Faltou', color: '#991b1b' },
] as const;
const LEGEND_TYPE = [
  { label: 'Procedimento', color: '#14b8a6' },
  { label: 'Retorno', color: '#0ea5e9' },
  { label: 'Bloqueio', color: '#dc2626' },
  { label: 'Tarefa', color: '#22c55e' },
] as const;

// Onda 17.61 — densidade (altura por hora) + "esconder madrugada" (grade começa às
// 07:00 em vez de 00:00, cortando o vão vazio). Os dois mexem no schedule-x via
// signal ($app.config.dayBoundaries/.weekOptions) — SEM recriar o calendário.
const AGENDA_DENSITY_PER_HOUR = { compacto: 50, confortavel: 70, amplo: 100 } as const;
type AgendaDensity = keyof typeof AGENDA_DENSITY_PER_HOUR;
function agendaGridHeight(density: AgendaDensity, hideMadrugada: boolean, mobile: boolean): number {
  const perHour = mobile ? Math.round(AGENDA_DENSITY_PER_HOUR[density] * 0.72) : AGENDA_DENSITY_PER_HOUR[density];
  const visibleHours = hideMadrugada ? 17 : 24; // 24:00 − 07:00 = 17h
  return perHour * visibleHours;
}

// Estilo Dental Office — a cor do card/borda é SEMPRE pelo STATUS: todo paciente
// agendado fica IGUAL, independente do dentista. Só muda ao trocar o status
// (Agendado → Confirmado → Em atendimento → Atendido, etc), ficando mais fácil
// de ler a agenda de relance. Tipos que NÃO são paciente (Bloqueio/Tarefa/Outro)
// mantêm a cor própria do tipo.
const PATIENT_APPT_TYPES = ['CONSULTA', 'PROCEDIMENTO', 'RETORNO'];
function eventAccentColor(ev: { type: string; status: string }): string {
  if (PATIENT_APPT_TYPES.includes(ev.type)) {
    return EVENT_STATUSES.find(s => s.id === ev.status)?.color || '#E91E63';
  }
  return getEventColor(ev.type);
}

// Onda 17.61 — fluxo de recepção: Agendado → Confirmado → Chegou → Em
// atendimento → Atendido; e Desmarcou (CANCELADO) / Faltou (NO_SHOW) como saídas.
const EVENT_STATUSES = [
  { id: 'AGENDADO', label: 'Agendado', color: '#E91E63' }, // rosa Dental Office — agendado/não confirmado
  { id: 'CONFIRMADO', label: 'Confirmado', color: '#22c55e' },
  { id: 'COMPARECEU', label: 'Chegou', color: '#0ea5e9' },
  { id: 'EM_ATENDIMENTO', label: 'Em atendimento', color: '#f97316' }, // laranja
  { id: 'CONCLUIDO', label: 'Atendido', color: '#15803d' }, // verde escuro
  { id: 'CANCELADO', label: 'Desmarcou', color: '#eab308' }, // amarelo
  { id: 'NO_SHOW', label: 'Faltou', color: '#991b1b' }, // vermelho escuro
];

// (PRIORITY_COLORS / PRIORITY_LABELS removidos — Prioridade saiu do UI na Onda 17.61.)

const KANBAN_COLUMNS = [
  { id: 'AGENDADO',  label: 'A Fazer',      emoji: '📋', color: '#3b82f6' },
  { id: 'CONFIRMADO', label: 'Em Andamento', emoji: '🔄', color: '#f59e0b' },
  { id: 'CONCLUIDO', label: 'Atendido',    emoji: '✅', color: '#22c55e' },
];

function getEventColor(type: string) {
  return EVENT_TYPES.find(t => t.id === type)?.color || '#6b7280';
}

/**
 * Mapeia evento para um dos slots semanticos (estilo Dental Office):
 *   - rosa  (#E91E63): agendado, paciente nao confirmou
 *   - verde (#22c55e): paciente confirmou presenca
 *   - ciano (#0ea5e9): chegou (compareceu)
 *   - laranja (#f97316): em atendimento
 *   - verde escuro (#15803d): atendido (consulta concluida)
 *   - amarelo (#eab308): desmarcou (cancelado)
 *   - vermelho escuro (#991b1b): faltou (no_show)
 *
 * Para eventos NAO-CONSULTA (PROCEDIMENTO/RETORNO/BLOQUEIO/TAREFA/OUTRO),
 * mantem cor por tipo (preserva semantica do tipo de evento odontologico).
 */
/**
 * Onda 5e v27 (Fase 25) — defaults de lembrete agora vem da CONFIG do tenant
 * (REMINDER_CONFIG_<tenant_id> em GlobalSetting), editavel via UI da aba
 * Lembretes em Follow-up IA. Cache mantido em useRef pra acessar em callbacks
 * sem refetch a cada chamada.
 *
 * Fallback: se config nao carregou ainda OU API falhou, usa hardcoded
 * [1440, 60, 15] (mesmo do DEFAULT_REMINDER_CONFIG do shared).
 *
 * Helper getDefaultReminders(antecedencias, eventStartIso?) FILTRA
 * dinamicamente os lembretes que ainda fazem sentido (cuja antecedencia
 * eh menor que o tempo restante ate o evento).
 */
const FALLBACK_DEFAULT_ANTECEDENCIAS = [
  { minutes_before: 1440, channel: 'WHATSAPP' },
  { minutes_before: 60, channel: 'WHATSAPP' },
  { minutes_before: 15, channel: 'WHATSAPP' },
];

function getDefaultReminders(
  antecedencias: { minutes_before: number; channel: string }[] = FALLBACK_DEFAULT_ANTECEDENCIAS,
  eventStartIso?: string,
): { minutes_before: number; channel: string }[] {
  if (!eventStartIso) return [...antecedencias];
  const startMs = new Date(eventStartIso).getTime();
  if (isNaN(startMs)) return [...antecedencias];
  const minutesUntilEvent = Math.floor((startMs - Date.now()) / 60_000);
  return antecedencias.filter((r) => r.minutes_before < minutesUntilEvent);
}

function getSemanticCalendarId(ev: { type: string; status: string }): string {
  if (ev.type !== 'CONSULTA') return ev.type; // mantem comportamento antigo
  switch (ev.status) {
    case 'CONFIRMADO': return 'SLOT_CONFIRMED';
    case 'CONCLUIDO': return 'SLOT_DONE';
    case 'CANCELADO': return 'SLOT_CANCELLED';
    case 'NO_SHOW':   return 'SLOT_NOSHOW';   // Onda 5e v18: paciente faltou
    case 'COMPARECEU': return 'SLOT_ARRIVED';   // chegou — ciano (Onda 17.61)
    case 'EM_ATENDIMENTO': return 'SLOT_INSERVICE'; // em atendimento — âmbar (Onda 17.61)
    default:          return 'SLOT_BOOKED'; // AGENDADO / outros
  }
}

function toLocalDateTime(isoStr: string): string {
  // App usa UTC "naive" — horários salvos como UTC = horário local de Maceió
  const d = new Date(isoStr);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  const h = String(d.getUTCHours()).padStart(2, '0');
  const min = String(d.getUTCMinutes()).padStart(2, '0');
  return `${y}-${m}-${day} ${h}:${min}`;
}

/**
 * Converte Temporal.ZonedDateTime, Temporal.PlainDate, ou string
 * para ISO string usável como query param no backend.
 * Schedule-x v4 passa objetos Temporal nos callbacks — o Axios
 * não os serializa corretamente como query params.
 */
function temporalToISO(dt: any): string {
  if (!dt) return '';
  if (typeof dt === 'string') return dt;
  // Onda 17.59 — Temporal.ZonedDateTime: usa os COMPONENTES LOCAIS como "naive UTC"
  // (a app guarda a hora LOCAL de Maceió nos campos UTC). ANTES usava toInstant() =
  // UTC REAL, que deslocava o range +3h e escondia eventos perto da virada do dia
  // (madrugada e fim de noite) — eles caíam FORA do range buscado e sumiam da agenda.
  if (typeof dt.toInstant === 'function' && typeof dt.year === 'number') {
    const y = String(dt.year).padStart(4, '0');
    const mo = String(dt.month).padStart(2, '0');
    const d = String(dt.day).padStart(2, '0');
    const h = String(dt.hour ?? 0).padStart(2, '0');
    const mi = String(dt.minute ?? 0).padStart(2, '0');
    return `${y}-${mo}-${d}T${h}:${mi}:00.000Z`;
  }
  // Fallback: objeto com toInstant mas sem componentes locais
  if (typeof dt.toInstant === 'function') {
    return dt.toInstant().toString();
  }
  // Temporal.PlainDate / PlainDateTime — construir manualmente
  if (typeof dt.year === 'number') {
    const y = String(dt.year).padStart(4, '0');
    const mo = String(dt.month).padStart(2, '0');
    const d = String(dt.day).padStart(2, '0');
    if (typeof dt.hour === 'number') {
      const h = String(dt.hour).padStart(2, '0');
      const mi = String(dt.minute).padStart(2, '0');
      return `${y}-${mo}-${d}T${h}:${mi}:00`;
    }
    return `${y}-${mo}-${d}`;
  }
  return String(dt);
}

/**
 * Converte Temporal.ZonedDateTime ou Temporal.PlainDate
 * para "YYYY-MM-DD HH:mm" (formato que openCreateModal espera).
 */
function temporalToLocalStr(dt: any): string {
  if (!dt) return '';
  if (typeof dt === 'string') return dt;
  if (typeof dt.year === 'number') {
    const y = String(dt.year).padStart(4, '0');
    const mo = String(dt.month).padStart(2, '0');
    const d = String(dt.day).padStart(2, '0');
    if (typeof dt.hour === 'number') {
      const h = String(dt.hour).padStart(2, '0');
      const mi = String(dt.minute).padStart(2, '0');
      return `${y}-${mo}-${d} ${h}:${mi}`;
    }
    return `${y}-${mo}-${d}`;
  }
  return String(dt);
}

function toISOFromLocal(localStr: string): string {
  // App usa UTC "naive": trata o horário digitado como UTC direto (= horário de Maceió)
  // "2026-06-03 09:05" → "2026-06-03T09:05:00.000Z" (sem converter fuso)
  const [datePart, timePart = '00:00'] = localStr.replace('T', ' ').split(' ');
  const [y, mo, d] = datePart.split('-').map(Number);
  const [h, mi] = timePart.split(':').map(Number);
  return new Date(Date.UTC(y, mo - 1, d, h, mi, 0)).toISOString();
}

function formatDateInput(isoStr: string): string {
  // Lê data em UTC (horário naive = horário local de Maceió)
  const d = new Date(isoStr);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

function formatTimeInput(isoStr: string): string {
  // Lê hora em UTC (horário naive = horário local de Maceió)
  const d = new Date(isoStr);
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
}

/**
 * Onda 17.59 — "hoje" no fuso FIXO de Maceió (UTC-3) como "YYYY-MM-DD".
 * A app é naive-UTC (a hora LOCAL é guardada nos campos UTC). Usar new Date() cru
 * pega o dia do fuso do BROWSER/UTC — à noite o UTC já virou o dia seguinte, então
 * a agenda abria no dia ERRADO (vazia) enquanto os eventos ficavam no dia local.
 * Date.now()-3h lido via getUTC* dá o dia-calendário de Maceió, batendo com os eventos.
 */
function maceioTodayStr(): string {
  const d = new Date(Date.now() - 3 * 60 * 60 * 1000);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

// ─── Mini Calendário (sidebar) ────────────────────────

const MONTH_NAMES_PT = [
  'Janeiro','Fevereiro','Março','Abril','Maio','Junho',
  'Julho','Agosto','Setembro','Outubro','Novembro','Dezembro',
];
const WD_HEADERS = ['D','S','T','Q','Q','S','S'];

/**
 * Mini-calendário do sidebar.
 *
 * `eventCounts` é um Map dateStr (YYYY-MM-DD) → quantidade de eventos ativos
 * (não cancelados/concluídos) naquele dia. Usado pra renderizar um pontinho
 * colorido de ocupação abaixo do número do dia:
 *   - Sem eventos → sem pontinho
 *   - 1-2 eventos → verde (dia tranquilo)
 *   - 3-4 eventos → amarelo (dia médio)
 *   - 5+ eventos → vermelho (dia cheio)
 *
 * Permite operador identificar de relance "onde tem espaço pra encaixar
 * paciente novo" sem clicar dia por dia.
 */
function MiniCalendar({
  onDateSelect,
  eventCounts,
  holidays,
}: {
  onDateSelect: (dateStr: string) => void;
  eventCounts?: Map<string, number>;
  // Onda 5e v7 — Map<chave, nome do feriado>:
  //   - "YYYY-MM-DD" pra data exata
  //   - "MM-DD" pra recorrencia anual (Natal, Ano Novo)
  // Match no render checa os 2 formatos.
  holidays?: Map<string, string>;
}) {
  // Onda 17.59 — "hoje" no fuso de Maceió (UTC-3), lido via getUTC* (não o fuso do
  // browser/UTC, que à noite já virou o dia seguinte e marcava o dia errado).
  const today = new Date(Date.now() - 3 * 60 * 60 * 1000);
  const [viewYear, setViewYear] = useState(today.getUTCFullYear());
  const [viewMonth, setViewMonth] = useState(today.getUTCMonth());
  const [selected, setSelected] = useState<string | null>(null);

  const todayStr = `${today.getUTCFullYear()}-${String(today.getUTCMonth()+1).padStart(2,'0')}-${String(today.getUTCDate()).padStart(2,'0')}`;
  const firstDow = new Date(viewYear, viewMonth, 1).getDay();
  const daysInMonth = new Date(viewYear, viewMonth + 1, 0).getDate();

  const cells: (number | null)[] = [];
  for (let i = 0; i < firstDow; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) cells.push(d);

  const prevMonth = () => {
    if (viewMonth === 0) { setViewMonth(11); setViewYear(y => y - 1); }
    else setViewMonth(m => m - 1);
  };
  const nextMonth = () => {
    if (viewMonth === 11) { setViewMonth(0); setViewYear(y => y + 1); }
    else setViewMonth(m => m + 1);
  };

  const handleDayClick = (day: number) => {
    const ds = `${viewYear}-${String(viewMonth+1).padStart(2,'0')}-${String(day).padStart(2,'0')}`;
    setSelected(ds);
    onDateSelect(ds);
  };

  return (
    <div className="select-none px-1 py-0.5">
      {/* Cabeçalho mês — Onda 5d v5 compactado */}
      <div className="flex items-center justify-between mb-0.5">
        <span className="text-[11px] font-semibold text-foreground">
          {MONTH_NAMES_PT[viewMonth]} {viewYear}
        </span>
        <div className="flex gap-0.5">
          <button onClick={prevMonth} className="p-0.5 rounded hover:bg-accent/60 text-muted-foreground transition-colors">
            <ChevronLeft size={11} />
          </button>
          <button onClick={nextMonth} className="p-0.5 rounded hover:bg-accent/60 text-muted-foreground transition-colors">
            <ChevronRight size={11} />
          </button>
        </div>
      </div>
      {/* Cabeçalho dias da semana — Onda 5e v6: domingo (i=0) em vermelho */}
      <div className="grid grid-cols-7">
        {WD_HEADERS.map((d, i) => (
          <span
            key={i}
            className={`text-center text-[9px] font-medium h-4 flex items-center justify-center ${
              i === 0 ? 'text-red-500' : 'text-muted-foreground'
            }`}
          >
            {d}
          </span>
        ))}
      </div>
      {/* Grade de dias com pontinho de ocupação — celulas reduzidas.
          Onda 5e v6: numeros de DOMINGO em vermelho.
          Onda 5e v7: feriados tambem em vermelho + tooltip com nome. */}
      <div className="grid grid-cols-7">
        {cells.map((day, i) => {
          if (!day) return <span key={`e-${i}`} className="h-6" />;
          const ds = `${viewYear}-${String(viewMonth+1).padStart(2,'0')}-${String(day).padStart(2,'0')}`;
          const isToday = ds === todayStr;
          const isSel = ds === selected;
          // Onda 5e v6: detecta domingo via Date.getDay() (0 = domingo)
          const dateObj = new Date(viewYear, viewMonth, day);
          const isSunday = dateObj.getDay() === 0;
          // Onda 5e v7: checa feriado nos 2 formatos (data exata + recorrente anual)
          const mmdd = `${String(viewMonth+1).padStart(2,'0')}-${String(day).padStart(2,'0')}`;
          const holidayName = holidays?.get(ds) || holidays?.get(mmdd);
          const isHoliday = !!holidayName;
          const count = eventCounts?.get(ds) ?? 0;
          let dotColor = '';
          if (count >= 5) dotColor = 'bg-rose-500';
          else if (count >= 3) dotColor = 'bg-amber-500';
          else if (count >= 1) dotColor = 'bg-emerald-500';
          // Tooltip combinando feriado + contagem de eventos
          const tooltipParts: string[] = [];
          if (holidayName) tooltipParts.push(`🎉 ${holidayName}`);
          if (count > 0) tooltipParts.push(`${count} evento${count !== 1 ? 's' : ''} agendado${count !== 1 ? 's' : ''}`);
          else if (!holidayName) tooltipParts.push('Sem eventos');
          return (
            <div key={`d-${day}`} className="h-6 flex flex-col items-center justify-start">
              <button
                onClick={() => handleDayClick(day)}
                title={tooltipParts.join(' • ')}
                className={`h-5 w-5 flex items-center justify-center rounded-full text-[10px] font-medium transition-colors
                  ${isSel
                    ? 'bg-primary text-primary-foreground'
                    : isToday
                    ? 'bg-primary/15 text-primary font-bold'
                    : isHoliday || isSunday
                    ? 'text-red-500 hover:bg-accent/60'
                    : 'text-foreground hover:bg-accent/60'}
                `}
              >
                {day}
              </button>
              <span className={`w-1 h-0.5 rounded-full ${dotColor || 'invisible'}`} />
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─── Componente Principal ─────────────────────────────

export default function AgendaPage() {
  const router = useRouter();
  const { socket: sharedSocket } = useSocket();

  // Tema global (next-themes) — usado pra sincronizar a cor de fundo do calendar
  // (schedule-x) com o tema escolhido em Configurações → Aparência.
  //
  // Onda 15: 4 temas (providers.tsx + globals.css):
  //   - 'noturno' → dark (preto + dourado)
  //   - 'cyber'   → dark (roxo + ciano)
  //   - 'glacier' → light (azul gelo)
  //   - 'coral'   → light (laranja + rosa)
  //
  // Pra schedule-x só importa se o fundo é dark ou light. As cores ACENTO
  // de cada tema são aplicadas via agenda-theme.css que mapeia as CSS vars
  // do schedule-x pras vars do app — sem JS adicional.
  const { resolvedTheme } = useTheme();
  const [themeMounted, setThemeMounted] = useState(false);
  useEffect(() => setThemeMounted(true), []);
  const isDarkTheme = themeMounted
    ? resolvedTheme === 'noturno' || resolvedTheme === 'cyber'
    : true; // SSR fallback = dark

  // Lê o tab da URL no client side sem useSearchParams (evita prerender error do Next.js)
  const [activeTab, setActiveTab] = useState<'calendar' | 'tasks'>('calendar');
  // Fase 12 PR2: visualizacao multi-coluna por profissional (DayPilot Lite)
  const [calendarMode, setCalendarMode] = useState<'week' | 'professional' | 'list'>('week');
  const [resourceDate, setResourceDate] = useState<Date>(new Date());
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get('tab') === 'tasks') setActiveTab('tasks');

    // Onda 5e v30: deep-link "Agendar" da ficha do paciente abre modal
    // de novo evento ja com paciente pre-preenchido.
    // URL: /atendimento/agenda?new=1&patient_id=X&patient_name=X&phone=X
    if (params.get('new') === '1' && params.get('patient_id')) {
      const patientId = params.get('patient_id') as string;
      const patientName = params.get('patient_name') || '';
      const patientPhone = params.get('phone') || '';
      // Espera o formData inicializar antes de abrir o modal (mount completo)
      setTimeout(() => {
        openCreateModal();
        // Pre-preenche paciente + titulo sugestivo
        setFormData((f) => ({
          ...f,
          patient_id: patientId,
          title: patientName ? `Avaliação — ${patientName}` : 'Avaliação',
        }));
        // Limpa URL pra nao re-abrir em reload
        window.history.replaceState({}, '', '/atendimento/agenda');
      }, 100);
      // Log pra debug
      // eslint-disable-next-line no-console
      console.log('[Agenda] deep-link Agendar do paciente', { patientId, patientName, patientPhone });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const switchTab = (tab: 'calendar' | 'tasks') => {
    setActiveTab(tab);
    const url = tab === 'calendar' ? '/atendimento/agenda' : '/atendimento/agenda?tab=tasks';
    router.push(url, { scroll: false });
  };

  const [events, setEvents] = useState<CalendarEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [users, setUsers] = useState<UserOption[]>([]);
  const [leads, setLeads] = useState<LeadOption[]>([]);
  // v34: pre-carrega pacientes pra ContactPicker mostrar lista completa sem
  // depender de fetch lazy ao abrir popover. Resolve bug onde paciente
  // recem-cadastrado nao aparecia ao agendar via deep-link da ficha.
  const [patients, setPatients] = useState<{ id: string; name: string | null; phone: string | null; cpf?: string | null; lead_id?: string | null; status?: string }[]>([]);

  // Onda 5e v7 (Fase 25) — Feriados do tenant pra colorir vermelho.
  // Map<chave, nome>:
  //   - chave fixa "YYYY-MM-DD" pra feriados de data exata (ex: "2026-04-21")
  //   - chave "MM-DD" pra feriados recorrentes anuais (ex: "12-25" Natal)
  // Logica de match no MiniCalendar verifica os 2 formatos.
  const [holidays, setHolidays] = useState<Map<string, string>>(new Map());

  // Filtros
  const [filterTypes, setFilterTypes] = useState<string[]>(EVENT_TYPES.map(t => t.id));
  const [filterUserId, setFilterUserId] = useState<string>('');
  const [showFilters, setShowFilters] = useState(false);
  // Por padrão eventos cancelados ficam ESCONDIDOS — operador via toggle pra
  // ver histórico (ex: investigar cancelamento em massa, gerar relatório).
  // Persistido em localStorage pra preferência sobreviver reload.
  // Onda 17.61 — PADRÃO MUDOU PARA "MOSTRAR". Antes, marcar Desmarcou/Cancelado fazia o
  // evento SUMIR da agenda (parecia apagado), mas ele nunca foi removido — só escondido.
  // O usuário quer que Desmarcou FIQUE REGISTRADO na agenda. Chave nova (_v2) pra a migração
  // valer também pra quem já tinha o filtro off no localStorage antigo. Toggle segue existindo
  // (quem quiser desentulhar a tela pode esconder, mas o evento continua salvo no histórico).
  const [showCancelled, setShowCancelled] = useState<boolean>(() => {
    if (typeof window === 'undefined') return true;
    const v = localStorage.getItem('agenda_show_cancelled_v2');
    return v === null ? true : v === 'true'; // ausente → mostra
  });
  useEffect(() => {
    if (typeof window !== 'undefined') {
      localStorage.setItem('agenda_show_cancelled_v2', String(showCancelled));
    }
  }, [showCancelled]);

  // Modal de criacao/edicao
  const [showModal, setShowModal] = useState(false);
  const [editingEvent, setEditingEvent] = useState<CalendarEvent | null>(null);
  const [formData, setFormData] = useState({
    type: 'CONSULTA',
    title: '',
    description: '',
    date: '',
    startTime: '09:00',
    endTime: '10:00',
    all_day: false,
    status: 'AGENDADO',
    location: '',
    assigned_user_id: '',
    lead_id: '',
    patient_id: '',
    legal_case_id: '',
    // v27: defaults vem da config (fallback: hardcoded 1d/1h/15min)
    // Operador pode add/remover livremente no proprio modal de evento.
    reminders: getDefaultReminders() as { minutes_before: number; channel: string }[],
    recurrence_rule: '',
    recurrence_end: '',
    recurrence_days: [] as number[],
  });

  // Usuario logado + controle de acesso
  // Inicializado com valores neutros para evitar hydration mismatch (SSR ≠ client)
  // O useEffect abaixo popula os valores reais a partir do JWT no client
  const [currentUserId, setCurrentUserId] = useState<string>('');
  const [currentUserRole, setCurrentUserRole] = useState<string>('');
  const role = useRole();
  const [showAllUsers, setShowAllUsers] = useState(false);

  // Real-time & UX
  const [reminderToast, setReminderToast] = useState<{ eventId: string; title: string; type: string; start_at: string; minutesBefore: number } | null>(null);
  // Onda 5e v20: indicador visual de Salvando — operador ve feedback
  // imediato ao clicar em "Salvar alteracoes"
  const [savingEvent, setSavingEvent] = useState(false);
  const [isMobile, setIsMobile] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<CalendarEvent[]>([]);
  const [showSearch, setShowSearch] = useState(false);
  const searchTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [mounted, setMounted] = useState(false);
  const [hoverTooltip, setHoverTooltip] = useState<{ event: CalendarEvent; x: number; y: number } | null>(null);
  const [kanbanView, setKanbanView] = useState(false);
  // Onda 5e v9 (Fase 25) — modal de bloqueio de agenda do dentista
  const [showBlockModal, setShowBlockModal] = useState(false);
  // v11: cache local dos bloqueios pra renderizar como evento vermelho na
  // agenda (visualmente identifica que aquele horario nao aceita marcacao).
  const [scheduleBlocks, setScheduleBlocks] = useState<Array<{
    id: string;
    user_id: string;
    start_at: string;
    end_at: string;
    all_day: boolean;
    reason: string;
    notes?: string | null;
    user?: { id: string; name: string };
  }>>([]);

  // ─── openCreateModal — definido ANTES dos useEffects e callbacks que o usam ──
  // useCallback com [currentUserId] para evitar stale closure no atalho de teclado
  const openCreateModal = useCallback((dateTime?: string, presetUserId?: string) => {
    const now = new Date();
    // Onda 17.56 — relógio de Maceió (UTC-3) em forma "naive" (igual ao resto da
    // agenda, que guarda a hora local nos campos UTC). Antes usava now.toISOString()
    // (UTC real): à noite o padrão virava 00:00 do dia seguinte e o evento sumia.
    const nowLocalIso = new Date(now.getTime() - 3 * 60 * 60 * 1000).toISOString();
    let date: string;
    let time: string;

    if (dateTime) {
      // schedule-x pode enviar "YYYY-MM-DD HH:mm" ao clicar na célula da grid
      const parts = dateTime.split(' ');
      date = parts[0] || formatDateInput(nowLocalIso);
      if (parts[1]) {
        // Arredondar minutos para múltiplo de 30 (grid de 30min)
        const [hh, mm] = parts[1].substring(0, 5).split(':').map(Number);
        const roundedMin = Math.round(mm / 30) * 30;
        const finalH = roundedMin >= 60 ? Math.min(hh + 1, 23) : hh;
        const finalM = roundedMin >= 60 ? 0 : roundedMin;
        time = `${String(finalH).padStart(2, '0')}:${String(finalM).padStart(2, '0')}`;
      } else {
        time = formatTimeInput(nowLocalIso);
      }
    } else {
      date = formatDateInput(nowLocalIso);
      time = formatTimeInput(nowLocalIso);
    }

    // Ao clicar numa célula da grade (dateTime presente), HONRA o dia/hora clicado:
    // é o que o usuário espera ao "agendar no horário que selecionei" — inclusive um
    // encaixe/walk-in num horário que já passou hoje. Sem clique explícito (botão
    // "Novo Evento" / atalho 'N'), date/time já são "agora", então nunca cai no passado.

    const [h, m] = time.split(':').map(Number);
    // Duração padrão: 30 min (compatível com grid de 30min)
    const endMinTotal = h * 60 + m + 30;
    const endH = String(Math.min(Math.floor(endMinTotal / 60), 23)).padStart(2, '0');
    const endM = String(endMinTotal % 60).padStart(2, '0');

    // v26: filtra defaults pelo tempo restante ate o evento
    // (ex: evento daqui a 30min nao recebe lembrete de "1d antes")
    const startIsoForReminders = `${date}T${time}:00`;
    setFormData({
      type: 'CONSULTA',
      title: '',
      description: '',
      date,
      startTime: time,
      endTime: `${endH}:${endM}`,
      all_day: false,
      status: 'AGENDADO',
      location: '',
      assigned_user_id: presetUserId || currentUserId,
      lead_id: '',
      patient_id: '',
      legal_case_id: '',
      reminders: getDefaultReminders(reminderAntecedenciasRef.current, startIsoForReminders),
      recurrence_rule: '',
      recurrence_end: '',
      recurrence_days: [],
    });
    setEditingEvent(null);
    setShowModal(true);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentUserId]);

  useEffect(() => { setMounted(true); }, []);

  // Onda 17.59 — toda vez que o modal abre, garante o botão "Salvar" limpo (não
  // herda um "Salvando…" que tenha ficado preso de uma ação anterior).
  useEffect(() => { if (showModal) setSavingEvent(false); }, [showModal]);

  // Atalho de teclado: 'N' abre modal de criação
  // openCreateModal é estável via useCallback([currentUserId]) — sem stale closure
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName?.toUpperCase();
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === 'n' || e.key === 'N') {
        e.preventDefault();
        openCreateModal();
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [openCreateModal]);

  useEffect(() => {
    const check = () => setIsMobile(window.innerWidth < 768);
    check();
    window.addEventListener('resize', check);
    return () => window.removeEventListener('resize', check);
  }, []);

  // schedule-x
  const eventsServicePlugin = useState(() => createEventsServicePlugin())[0];
  const rangeRef = useRef<{ start: string; end: string } | null>(null);

  // Onda 5d v11 (Fase 25) — Helper pra navegar o calendar.
  // Schedule-x v4 NAO expoe API publica de navegacao (calendarControls
  // e calendar-controls plugin nao estao instalados). A unica forma eh
  // acessar $app.calendarState.setRange(plainDate) direto — privado mas
  // funciona enquanto a estrutura interna nao mudar.
  //
  // Versoes anteriores (v6, v9) tentavam .navigate() e .calendarControls.setDate()
  // que NAO existem na v4 atual — por isso o click no mini-calendario nao
  // fazia nada (try/catch silenciava o erro).
  const navigateCalendarTo = useCallback((dateStr: string, calendarApp: any) => {
    if (!calendarApp) {
      console.warn('[Agenda] navigateCalendarTo: calendar nao montou');
      return false;
    }

    // 1) Parse "YYYY-MM-DD" pra Temporal.PlainDate
    const T = (globalThis as any).Temporal;
    if (!T) {
      console.warn('[Agenda] Temporal nao disponivel no globalThis');
      return false;
    }
    const [year, month, day] = dateStr.split('-').map(Number);
    if (!year || !month || !day) {
      console.warn('[Agenda] dateStr invalido:', dateStr);
      return false;
    }

    let plainDate: any;
    try {
      plainDate = T.PlainDate.from({ year, month, day });
    } catch (e) {
      console.warn('[Agenda] Erro criando Temporal.PlainDate:', e);
      return false;
    }

    // 2) Acessa $app interno (campo privado mas estavel na v4)
    const $app = calendarApp.$app;
    if (!$app) {
      console.warn('[Agenda] calendar.$app nao acessivel — schedule-x mudou estrutura?');
      return false;
    }

    // 3) Onda 5d v12: combo correto descoberto inspecionando core.cjs.js:
    //    a) atualiza selectedDate signal direto via .value =
    //       (linha 943 do core: $app.datePickerState.selectedDate.value = date)
    //    b) reaplica view com a nova data
    //       (linha 1345 do core: setView(viewName, selectedDate.value))
    //
    //    Versao anterior (v11) usava SO setRange — atualizava o range
    //    mas nao a selectedDate, entao calendar navegava pra dia errado.
    try {
      // (a) Seta selectedDate no datePickerState
      const selectedDateSignal = $app.datePickerState?.selectedDate;
      if (selectedDateSignal && 'value' in selectedDateSignal) {
        selectedDateSignal.value = plainDate;
      }

      // (b) Reaplica view com a nova data
      const setView = $app.calendarState?.setView;
      const currentView = $app.calendarState?.view?.value || 'week';
      if (typeof setView === 'function') {
        setView(currentView, plainDate);
        return true;
      }

      // Fallback: setRange se setView nao existir
      const setRange = $app.calendarState?.setRange;
      if (typeof setRange === 'function') {
        setRange(plainDate);
        return true;
      }
    } catch (e) {
      console.warn('[Agenda] Erro ao navegar:', e);
    }

    console.warn('[Agenda] API de navegacao nao encontrada. Keys disponiveis:',
      Object.keys($app.calendarState || {}),
      Object.keys($app.datePickerState || {}));
    return false;
  }, []);
  // Refs para evitar stale closure nos callbacks do schedule-x
  // (useNextCalendarApp captura apenas a versão inicial das funções/estados)
  const fetchEventsRef = useRef<typeof fetchEvents | null>(null);
  const eventsRef = useRef<CalendarEvent[]>([]); // para onEventClick sempre ter a lista atualizada
  // v27: config customizavel de lembretes (carregada 1x no mount).
  // Usada em getDefaultReminders pra preencher modal de evento. Se admin
  // mudar antecedencia padrao via UI, novos eventos pegam automaticamente
  // (proximo mount carrega valor atualizado).
  const reminderAntecedenciasRef = useRef<{ minutes_before: number; channel: string }[]>(FALLBACK_DEFAULT_ANTECEDENCIAS);

  // ─── Data Fetching ──────────────────────────────────

  const fetchEvents = useCallback(async (start?: string, end?: string) => {
    try {
      const params: any = {};
      if (start) params.start = start;
      if (end) params.end = end;

      // Logica de filtragem por dentista:
      //   - DENTIST/FINANCEIRO: backend forca userId=self, nao mandamos nada
      //     (qualquer userId enviado e ignorado pelo backend mesmo).
      //   - ADMIN/OPERADOR/ASSISTANT em "Meus": forcamos userId=self pra
      //     filtrar pelos eventos do user logado.
      //   - ADMIN/OPERADOR/ASSISTANT em "Todos" + dentista escolhido:
      //     filtra pelo dentista do dropdown.
      //   - ADMIN/OPERADOR/ASSISTANT em "Todos" + sem dentista escolhido:
      //     nao mandamos userId (backend retorna tudo).
      if (role.canViewAllAgenda) {
        if (!showAllUsers && currentUserId) {
          params.userId = currentUserId;
        } else if (showAllUsers && filterUserId) {
          params.userId = filterUserId;
        }
      }

      const res = await api.get('/calendar/events', { params });
      setEvents(res.data || []);
    } catch {
      setEvents([]);
    } finally {
      setLoading(false);
    }

    // v11: paralelo, busca tambem os bloqueios (ferias/doenca) que se sobrepoem
    // ao range visivel pra renderizar como faixa vermelha na agenda. Falha
    // silenciosa — se /calendar/blocks ainda nao existir (deploy parcial),
    // agenda continua funcionando sem bloqueios visuais.
    try {
      const blockParams: any = {};
      if (start) blockParams.from = start;
      if (end) blockParams.to = end;
      if (filterUserId) blockParams.userId = filterUserId;
      const blockRes = await api.get('/calendar/blocks', { params: blockParams });
      setScheduleBlocks(blockRes.data || []);
    } catch {
      setScheduleBlocks([]);
    }
  }, [filterUserId, showAllUsers, role.canViewAllAgenda, currentUserId]);

  // Manter refs atualizados com os valores mais recentes
  useEffect(() => { fetchEventsRef.current = fetchEvents; }, [fetchEvents]);
  useEffect(() => { eventsRef.current = events; }, [events]);

  // Onda 5e v7 (Fase 25) — Marca colunas/headers de feriado no schedule-x.
  // Schedule-x v4 nao tem API publica pra customizar dia, entao fazemos DOM walk:
  //   - .sx__week-grid__date[data-date]      -> header com nome+numero do dia
  //   - .sx__time-grid-day[data-time-grid-date] -> coluna de horarios da semana
  //   - .sx__date-grid-day[data-date-grid-date] -> celula da faixa all-day
  //   - .sx__month-grid-day[data-date]       -> celula do mes
  // Adiciona class .sx__holiday + title (tooltip nativo) com nome do feriado.
  // Re-roda quando holidays/events mudam (events triggera re-render do schedule-x).
  // setTimeout 0 espera o React/schedule-x flushar o DOM antes de marcar.
  useEffect(() => {
    if (!holidays.size) return;
    const apply = () => {
      const selectors = [
        { sel: '[data-date]', attr: 'data-date' },
        { sel: '[data-time-grid-date]', attr: 'data-time-grid-date' },
        { sel: '[data-date-grid-date]', attr: 'data-date-grid-date' },
      ];
      for (const { sel, attr } of selectors) {
        document.querySelectorAll<HTMLElement>(sel).forEach(el => {
          const ds = el.getAttribute(attr);
          if (!ds || ds.length < 10) return;
          const iso = ds.slice(0, 10);
          const mmdd = iso.slice(5);
          const name = holidays.get(iso) || holidays.get(mmdd);
          if (name) {
            el.classList.add('sx__holiday');
            // Tooltip nativo — schedule-x ja usa title em alguns lugares,
            // sobrescreve sem prejudicar UX
            if (!el.title.includes(name)) el.title = `🎉 Feriado: ${name}`;
          }
        });
      }
    };
    const t = setTimeout(apply, 50);
    return () => clearTimeout(t);
    // events na deps pra re-aplicar quando schedule-x re-renderiza apos mudanca de view
  }, [holidays, events]);

  // Drag-and-drop persistence
  const handleDragUpdate = useCallback(async (updatedEvent: any) => {
    try {
      // schedule-x v4: updatedEvent.start/end são Temporal.ZonedDateTime — usar temporalToISO
      const startIso = temporalToISO(updatedEvent.start);
      const endIso = temporalToISO(updatedEvent.end);
      await api.patch(`/calendar/events/${updatedEvent.id}`, { start_at: startIso, end_at: endIso });
      // Update local state optimistically
      setEvents(prev => prev.map(e => e.id === updatedEvent.id ? { ...e, start_at: startIso, end_at: endIso } : e));
    } catch {
      // Rollback: refetch on error
      if (rangeRef.current) fetchEvents(rangeRef.current.start, rangeRef.current.end);
    }
  }, [fetchEvents]);

  // Onda 17.61 — preferências de exibição (persistidas). Lidas num effect (não no
  // initializer) pra evitar mismatch de hidratação. Default: esconde a madrugada.
  const [hideMadrugada, setHideMadrugada] = useState(true);
  const [agendaDensity, setAgendaDensity] = useState<AgendaDensity>('confortavel');
  useEffect(() => {
    try {
      setHideMadrugada(localStorage.getItem('agenda:hideMadrugada') !== 'false');
      const v = localStorage.getItem('agenda:density');
      if (v === 'compacto' || v === 'amplo') setAgendaDensity(v);
    } catch { /* localStorage indisponível — usa defaults */ }
  }, []);
  const changeDensity = useCallback((d: AgendaDensity) => {
    setAgendaDensity(d);
    try { localStorage.setItem('agenda:density', d); } catch { /* ignore */ }
  }, []);
  const toggleMadrugada = useCallback(() => {
    setHideMadrugada((v) => {
      const n = !v;
      try { localStorage.setItem('agenda:hideMadrugada', String(n)); } catch { /* ignore */ }
      return n;
    });
  }, []);

  const calendar = useNextCalendarApp({
    views: [createViewWeek(), createViewMonthGrid(), createViewDay()],
    defaultView: isMobile ? 'day' : 'week',
    // Onda 17.59 — abre no dia de MACEIÓ (não no "today" interno do schedule-x, que
    // é UTC e à noite já é o dia seguinte → agenda abria vazia no dia errado).
    // schedule-x v4 EXIGE Temporal.PlainDate aqui (não string); guarda p/ SSR.
    selectedDate: (() => {
      const T = (globalThis as any).Temporal;
      if (!T?.PlainDate) return undefined;
      const [y, mo, d] = maceioTodayStr().split('-').map(Number);
      try { return T.PlainDate.from({ year: y, month: mo, day: d }); } catch { return undefined; }
    })(),
    locale: 'pt-BR',
    firstDayOfWeek: 1,
    // Onda 17.56 — grade cobre o DIA INTEIRO (00:00–24:00) pra NUNCA esconder um
    // evento fora do horário comercial (ex.: 00:00). gridHeight maior compensa as
    // 24h pra manter as linhas legíveis; o usuário rola até o horário.
    dayBoundaries: { start: hideMadrugada ? '07:00' : '00:00', end: '24:00' },
    weekOptions: { gridHeight: agendaGridHeight(agendaDensity, hideMadrugada, isMobile), gridStep: 30 },
    isDark: isDarkTheme,
    callbacks: {
      onRangeUpdate(range) {
        try {
          // schedule-x v4 passa Temporal.ZonedDateTime — converter para ISO string
          const startISO = temporalToISO(range.start);
          const endISO = temporalToISO(range.end);
          rangeRef.current = { start: startISO, end: endISO };
          // Usar ref para ter sempre a versão mais recente de fetchEvents
          const fn = fetchEventsRef.current ?? fetchEvents;
          fn(startISO, endISO);
        } catch (e) {
          console.error('[Agenda] onRangeUpdate error:', e);
        }
      },
      onEventClick(calEvent) {
        // v11: bloqueio (id prefixado "block-") nao eh evento normal — abre
        // modal de gestao de bloqueios pra remover/editar de la
        if (typeof calEvent.id === 'string' && calEvent.id.startsWith('block-')) {
          setShowBlockModal(true);
          return;
        }
        // Usar eventsRef para ter a lista atualizada (evita stale closure)
        const ev = eventsRef.current.find(e => e.id === calEvent.id);
        if (ev) openEditModal(ev);
      },
      onClickDateTime(dateTime) {
        // schedule-x v4 passa Temporal.ZonedDateTime — converter para "YYYY-MM-DD HH:mm"
        openCreateModal(temporalToLocalStr(dateTime));
      },
      onClickDate(date) {
        // schedule-x v4 passa Temporal.PlainDate — converter para "YYYY-MM-DD"
        openCreateModal(temporalToLocalStr(date));
      },
      onEventUpdate(updatedEvent) {
        handleDragUpdate(updatedEvent);
      },
    },
    plugins: [eventsServicePlugin, createDragAndDropPlugin()],
    events: [],
    // Cores semanticas Clinicorp (Fase 12) — slots de consulta odontologica
    calendars: {
      // CONSULTA: mapeada por status via getSemanticCalendarId
      // Onda 17.61 — cores ALINHADAS ao dropdown de Status (EVENT_STATUSES): mudar o
      // status recolora o card. main = a mesma cor da opção no dropdown.
      SLOT_BOOKED: { // AGENDADO — rosa (Dental Office: agendado/não confirmado)
        colorName: 'agendado',
        lightColors: { main: '#E91E63', container: '#fce7f3', onContainer: '#831843' },
        darkColors:  { main: '#f472b6', container: '#831843', onContainer: '#fce7f3' },
      },
      SLOT_CONFIRMED: { // CONFIRMADO — verde
        colorName: 'confirmado',
        lightColors: { main: '#22c55e', container: '#dcfce7', onContainer: '#14532d' },
        darkColors:  { main: '#22c55e', container: '#14532d', onContainer: '#dcfce7' },
      },
      SLOT_ARRIVED: { // COMPARECEU (paciente chegou) — ciano
        colorName: 'compareceu',
        lightColors: { main: '#0ea5e9', container: '#e0f2fe', onContainer: '#0c4a6e' },
        darkColors:  { main: '#0ea5e9', container: '#0c4a6e', onContainer: '#e0f2fe' },
      },
      SLOT_INSERVICE: { // EM_ATENDIMENTO — laranja
        colorName: 'ematendimento',
        lightColors: { main: '#f97316', container: '#ffedd5', onContainer: '#7c2d12' },
        darkColors:  { main: '#fb923c', container: '#7c2d12', onContainer: '#ffedd5' },
      },
      SLOT_DONE: { // CONCLUIDO — verde escuro
        colorName: 'concluido',
        lightColors: { main: '#15803d', container: '#dcfce7', onContainer: '#14532d' },
        darkColors:  { main: '#4ade80', container: '#14532d', onContainer: '#dcfce7' },
      },
      SLOT_CANCELLED: { // CANCELADO (desmarcou) — amarelo
        colorName: 'cancelado',
        lightColors: { main: '#eab308', container: '#fef9c3', onContainer: '#713f12' },
        darkColors:  { main: '#facc15', container: '#713f12', onContainer: '#fef9c3' },
      },
      // Onda 5e v18: paciente faltou — preto/cinza escuro pra destacar negativo
      SLOT_NOSHOW: { // NO_SHOW (faltou) — vermelho escuro
        colorName: 'noshow',
        lightColors: { main: '#991b1b', container: '#fee2e2', onContainer: '#7f1d1d' },
        darkColors:  { main: '#f87171', container: '#7f1d1d', onContainer: '#fee2e2' },
      },
      // Tipos juridicos (mantidos por compatibilidade)
      TAREFA: {
        colorName: 'tarefa',
        lightColors: { main: '#22c55e', container: '#dcfce7', onContainer: '#14532d' },
        darkColors:  { main: '#22c55e', container: '#14532d', onContainer: '#dcfce7' },
      },
      PROCEDIMENTO: {
        colorName: 'procedimento',
        lightColors: { main: '#14b8a6', container: '#ccfbf1', onContainer: '#134e4a' },
        darkColors:  { main: '#14b8a6', container: '#134e4a', onContainer: '#ccfbf1' },
      },
      RETORNO: {
        colorName: 'retorno',
        lightColors: { main: '#0ea5e9', container: '#e0f2fe', onContainer: '#0c4a6e' },
        darkColors:  { main: '#0ea5e9', container: '#0c4a6e', onContainer: '#e0f2fe' },
      },
      // v11: BLOQUEIO em vermelho semantico — alinha com botao "Bloquear"
      // do header e com a UX de "isso impede agendamentos"
      BLOQUEIO: {
        colorName: 'bloqueio',
        lightColors: { main: '#dc2626', container: '#fee2e2', onContainer: '#7f1d1d' },
        darkColors:  { main: '#ef4444', container: '#7f1d1d', onContainer: '#fee2e2' },
      },
      OUTRO: {
        colorName: 'outro',
        lightColors: { main: '#6b7280', container: '#f3f4f6', onContainer: '#1f2937' },
        darkColors:  { main: '#6b7280', container: '#1f2937', onContainer: '#f3f4f6' },
      },
    },
  });

  // Sincroniza o tema do schedule-x com o tema global (next-themes).
  // Schedule-x não reage automaticamente quando isDark muda depois do init —
  // precisa chamar calendar.setTheme() explicitamente. Esse useEffect roda
  // toda vez que isDarkTheme muda (operador trocou tema em Configurações →
  // Aparência ou via ThemeToggle no Sidebar).
  useEffect(() => {
    if (!calendar || !themeMounted) return;
    try {
      (calendar as any).setTheme?.(isDarkTheme ? 'dark' : 'light');
    } catch (e) {
      console.warn('[Agenda] setTheme failed:', e);
    }
  }, [calendar, isDarkTheme, themeMounted]);

  // Onda 17.61 — aplica densidade + esconder-madrugada em runtime. dayBoundaries e
  // weekOptions são signals reativos no core do schedule-x (.value) → muda sem
  // recriar o calendário. Formato dos timePoints: 00:00=0, 07:00=700, 24:00=2400.
  // try/catch defensivo: se o schedule-x mudar a estrutura interna, não quebra a agenda.
  useEffect(() => {
    const cfg = (calendar as any)?.$app?.config;
    if (!cfg) return;
    try {
      if (cfg.dayBoundaries && 'value' in cfg.dayBoundaries) {
        cfg.dayBoundaries.value = { start: hideMadrugada ? 700 : 0, end: 2400 };
      }
      if (cfg.weekOptions && 'value' in cfg.weekOptions) {
        cfg.weekOptions.value = {
          ...cfg.weekOptions.value,
          gridHeight: agendaGridHeight(agendaDensity, hideMadrugada, isMobile),
        };
      }
    } catch (e) {
      console.warn('[Agenda] densidade/madrugada não aplicada:', e);
    }
  }, [calendar, hideMadrugada, agendaDensity, isMobile]);

  useEffect(() => {
    const token = localStorage.getItem('token');
    if (!token) { router.push('/atendimento/login'); return; }
    // Extrair userId e role do JWT
    try {
      const payload = JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
      if (payload?.sub) setCurrentUserId(payload.sub);
      // Multi-role: aceita roles (array) ou role (string legado)
      const roles: string[] = Array.isArray(payload?.roles)
        ? payload.roles
        : (payload?.role ? [payload.role] : []);
      if (roles.length > 0) {
        setCurrentUserRole(roles[0]);
        if (roles.includes('ADMIN')) {
          setShowAllUsers(true);
        }
      }
    } catch (e) { swallow('parse JWT do localStorage')(e); }
    // Onda 17.54 — dentistas vêm de /users/lawyers, NÃO de /users (que é
    // @Roles ADMIN → 403 pra recepção/dentista/assistente, deixando a lista
    // VAZIA pra quem não é admin). /users/lawyers é acessível a qualquer logado,
    // é tenant-scoped e já filtra: DENTIST ou (ADMIN com especialidade) — então
    // admin-puro (ex.: "Ana Alinne") não entra. Mesma lista pra todos da tenant.
    api.get('/users/lawyers').then(r => {
      const data: any[] = Array.isArray(r.data) ? r.data : (r.data?.data || r.data?.users || []);
      setUsers(data.map((u: any) => ({ id: u.id, name: u.name })));
    }).catch(swallow('lazy load filtro de dentistas (nao essencial pra renderizar agenda)'));
    api.get('/leads').then(r => setLeads((r.data || []).map((l: any) => ({ id: l.id, name: l.name, phone: l.phone })))).catch(swallow('lazy load leads pro autocomplete (agenda funciona sem)'));

    // v34: pre-carrega pacientes pra ContactPicker ja ter a lista completa
    // ao montar (resolve bug onde paciente novo nao aparecia ao abrir modal
    // via deep-link da ficha do paciente)
    api.get('/patients?limit=500').then(r => {
      const list = Array.isArray(r.data) ? r.data : (r.data?.data || r.data?.patients || []);
      setPatients(list
        .filter((p: any) => p.status !== 'ARCHIVED')
        .map((p: any) => ({
          id: p.id, name: p.name, phone: p.phone, cpf: p.cpf,
          lead_id: p.lead_id, status: p.status,
        })));
    }).catch(swallow('lazy load patients pro autocomplete (agenda funciona sem)'));

    // Onda 5e v7 (Fase 25) — Carrega feriados pra colorir vermelho no mini-calendar
    // e no proprio schedule-x. Recurring_yearly vira chave "MM-DD" (ex: "12-25" Natal),
    // data exata vira "YYYY-MM-DD" (ex: "2026-04-21" Tiradentes daquele ano).
    // Endpoint: GET /holidays — retorna array do tenant atual.
    api.get('/holidays').then(r => {
      const map = new Map<string, string>();
      (r.data || []).forEach((h: any) => {
        const dt = new Date(h.date);
        if (h.recurring_yearly) {
          const mm = String(dt.getUTCMonth() + 1).padStart(2, '0');
          const dd = String(dt.getUTCDate()).padStart(2, '0');
          map.set(`${mm}-${dd}`, h.name);
        } else {
          // h.date vem em ISO; pega só YYYY-MM-DD pra evitar drift de timezone
          const iso = typeof h.date === 'string' ? h.date.slice(0, 10)
            : `${dt.getUTCFullYear()}-${String(dt.getUTCMonth()+1).padStart(2,'0')}-${String(dt.getUTCDate()).padStart(2,'0')}`;
          map.set(iso, h.name);
        }
      });
      setHolidays(map);
    }).catch(swallow('lazy load holidays — agenda funciona sem'));

    // v27: carrega config customizavel de lembretes (antecedencias padrao
    // que vao pre-preencher o modal de evento). Cache em useRef.
    api.get('/calendar/reminders/config').then(r => {
      const ant = Array.isArray(r.data?.default_antecedencias) ? r.data.default_antecedencias : null;
      if (ant && ant.length > 0) {
        reminderAntecedenciasRef.current = ant;
      }
    }).catch(swallow('lazy load reminder config — usa fallback hardcoded'));

    // Deep link: abrir evento via alerta de tarefa vencida
    const openEventId = sessionStorage.getItem('open_event_id');
    if (openEventId) {
      sessionStorage.removeItem('open_event_id');
      api.get(`/calendar/events/${openEventId}`)
        .then(res => {
          if (res.data) {
            const ev = res.data;
            setEditingEvent(ev);
            setShowModal(true);
          }
        })
        .catch(swallow('deep link de evento — pode ja ter sido deletado'));
    }
  }, [router]);

  // Sync filtro → calendar
  // schedule-x v4 exige Temporal.ZonedDateTime (não string) em start/end
  useEffect(() => {
    if (!eventsServicePlugin) return;
    try {
      // Temporal disponível nativamente no Chrome 137+ (Mar/2026) e polyfillado pelo schedule-x
      const T = (globalThis as any).Temporal;
      const tz: string = T ? T.Now.timeZoneId() : 'America/Sao_Paulo';

      // Defesa em camadas: backend ja filtra por userId quando enviado, mas
      // garantimos a filtragem local pra que o usuario nunca veja eventos
      // de outros dentistas — mesmo se backend retornar a mais por cache,
      // race condition, ou bug. Aplica a mesma regra do backend:
      //   - assigned_user_id = filterUserId, OU
      //   - assigned_user_id is null AND created_by_id = filterUserId
      const filtered = events.filter(e => {
        if (!filterTypes.includes(e.type)) return false;
        // Esconder cancelados por padrão (operador habilita via toggle "Mostrar cancelados")
        if (!showCancelled && e.status === 'CANCELADO') return false;
        if (filterUserId) {
          const isAssigned = e.assigned_user_id === filterUserId;
          const isCreatorWithoutAssignee = e.assigned_user_id == null && e.created_by_id === filterUserId;
          if (!isAssigned && !isCreatorWithoutAssignee) return false;
        }
        return true;
      });
      const calEvents = filtered
        .filter(e => {
          // Validate dates to prevent schedule-x crashes
          const startMs = new Date(e.start_at).getTime();
          return !isNaN(startMs);
        })
        .map(e => {
          // Onda 17.61 — card no formato da referência: linha 1 = "Paciente — Procedimento"
          // (nome + título combinados numa linha só). Sem paciente, mostra só o procedimento.
          // O dentista vai numa 2ª linha (e a barra colorida à esquerda já indica de quem é).
          const clientName = e.patient?.name || e.lead?.name || '';
          const headline = clientName ? `${clientName} — ${e.title}` : e.title;
          const dentistTail = e.assigned_user ? `\n${e.assigned_user.name}` : '';
          const typeEmoji = EVENT_TYPES.find(t => t.id === e.type)?.emoji || '';
          const startLocal = toLocalDateTime(e.start_at); // "YYYY-MM-DD HH:mm"
          let endLocal: string;
          if (e.end_at && !isNaN(new Date(e.end_at).getTime())) {
            endLocal = toLocalDateTime(e.end_at);
          } else {
            endLocal = toLocalDateTime(new Date(new Date(e.start_at).getTime() + 30 * 60000).toISOString());
          }

          // Converter strings para Temporal.ZonedDateTime (obrigatório no schedule-x v4)
          // Usa forma de objeto (mais robusta que parsing de string) para evitar falhas silenciosas.
          let startSx: any = startLocal;
          let endSx: any = endLocal;
          if (T) {
            const parseLocalToZDT = (local: string) => {
              // local = "YYYY-MM-DD HH:mm"
              const [datePart, timePart = '00:00'] = local.split(' ');
              const [year, month, day] = datePart.split('-').map(Number);
              const [hour, minute] = timePart.split(':').map(Number);
              return T.ZonedDateTime.from({
                year, month, day, hour, minute, second: 0,
                timeZone: 'UTC',
              });
            };
            try { startSx = parseLocalToZDT(startLocal); } catch { /* manter string */ }
            try { endSx   = parseLocalToZDT(endLocal);   } catch { /* manter string */ }
          }

          const caseTag = e.legal_case?.case_number ? ` [${e.legal_case.case_number}]` : '';
          // Ícone de status na frente do título — operador identifica
          // imediatamente se o paciente confirmou, está atrasado, etc.
          // Convenção: ✅ confirmou | ⏰ aguardando confirmação | 🩺 compareceu
          //            🚫 não compareceu | ✖️ desmarcou
          let statusIcon = '';
          switch (e.status) {
            case 'CONFIRMADO':  statusIcon = '✅ '; break;
            case 'AGENDADO':    statusIcon = '⏰ '; break; // aguardando confirmação
            case 'COMPARECEU':  statusIcon = '🚶 '; break; // paciente chegou
            case 'EM_ATENDIMENTO': statusIcon = '🦷 '; break;
            case 'NO_SHOW':     statusIcon = '🚫 '; break;
            case 'CANCELADO':   statusIcon = '✖️ '; break;
            default:            statusIcon = ''; break;
          }
          // Sufixos secundários (recorrência, comentários) ficam no fim
          const recurringTag = (e as any).recurrence_rule || (e as any).parent_event_id ? ' 🔁' : '';
          const commentsTag  = e._count?.comments ? ` 💬${e._count.comments}` : '';
          // Estilo Dental Office — cor do card (fundo + borda esquerda) SEMPRE pelo
          // STATUS, via classe CSS ag-status-* (tinta translúcida + borda em
          // agenda-theme.css). Todo paciente agendado fica igual, INDEPENDENTE do
          // dentista; só muda ao trocar o status. É mais confiável que as cores do
          // `calendars` do schedule-x — que só são lidas na CRIAÇÃO do calendário
          // (HMR não recolore).
          const statusClass = PATIENT_APPT_TYPES.includes(e.type)
            ? `ag-status-${(e.status || 'AGENDADO').toLowerCase()}`
            : '';

          return {
            id: e.id,
            // Onda 17.61: linha 1 = "Paciente — Procedimento" (status + emoji na frente),
            // linha 2 = dentista. O horário (ex.: 08:30-09:00) o schedule-x já mostra.
            title: `${statusIcon}${typeEmoji ? typeEmoji + ' ' : ''}${headline}${caseTag}${recurringTag}${commentsTag}${dentistTail}`,
            start: startSx,
            end: endSx,
            // Fase 12: cores semanticas Clinicorp para CONSULTA, tipo legado para resto
            calendarId: getSemanticCalendarId(e),
            _customContent: {},
            _options: { additionalClasses: [statusClass].filter(Boolean) },
          };
        });

      // v11: adiciona bloqueios como events vermelhos com id "block-XXX"
      // (prefix usado em onEventClick pra distinguir e abrir modal correto).
      // Filtra pra manter consistencia com filterUserId quando setado.
      const blockCalEvents = scheduleBlocks
        .filter(b => !filterUserId || b.user_id === filterUserId)
        .map(b => {
          const startLocal = toLocalDateTime(b.start_at);
          const endLocal = toLocalDateTime(b.end_at);
          let startSx: any = startLocal;
          let endSx: any = endLocal;
          if (T) {
            const parseLocalToZDT = (local: string) => {
              const [datePart, timePart = '00:00'] = local.split(' ');
              const [year, month, day] = datePart.split('-').map(Number);
              const [hour, minute] = timePart.split(':').map(Number);
              return T.ZonedDateTime.from({
                year, month, day, hour, minute, second: 0,
                timeZone: 'UTC',
              });
            };
            try { startSx = parseLocalToZDT(startLocal); } catch { /* manter string */ }
            try { endSx   = parseLocalToZDT(endLocal);   } catch { /* manter string */ }
          }
          const userTag = b.user?.name ? `${b.user.name}\n` : '';
          return {
            id: `block-${b.id}`,
            title: `${userTag}🚫 BLOQUEADO: ${b.reason}${b.notes ? '\n' + b.notes : ''}`,
            start: startSx,
            end: endSx,
            calendarId: 'BLOQUEIO',
            _options: { additionalClasses: ['block-event'] },
          };
        });

      eventsServicePlugin.set([...calEvents, ...blockCalEvents]);
    } catch (err) {
      console.error('[Agenda] Error syncing events to calendar:', err);
    }
  }, [events, scheduleBlocks, filterTypes, eventsServicePlugin, showAllUsers, filterUserId, showCancelled]);

  // Carga inicial: schedule-x v4 não chama onRangeUpdate no mount.
  // Buscamos um range largo (semana atual ± 4 semanas = ~2 meses) para garantir
  // que eventos próximos já apareçam no sidebar e no calendário sem precisar navegar.
  useEffect(() => {
    const now = new Date();
    const day = now.getDay(); // 0=Dom, 1=Seg … 6=Sab
    const diffToMonday = day === 0 ? -6 : 1 - day;
    const monday = new Date(now);
    monday.setDate(now.getDate() + diffToMonday);
    monday.setHours(0, 0, 0, 0);
    // Range inicial: semana atual + 4 semanas à frente (cobre eventos próximos no sidebar)
    const rangeStart = new Date(monday);
    rangeStart.setDate(monday.getDate() - 7); // 1 semana atrás
    const rangeEnd = new Date(monday);
    rangeEnd.setDate(monday.getDate() + 4 * 7); // 4 semanas à frente
    rangeEnd.setHours(23, 59, 59, 999);
    const start = rangeStart.toISOString();
    const end = rangeEnd.toISOString();
    // rangeRef aponta para a semana atual (para refetch correto ao mudar filtros).
    // Onda 17.59 — em naive-UTC (componentes locais tratados como UTC) pra bater
    // com o formato dos eventos; .toISOString() jogava +3h e podia excluir um
    // evento recém-criado no refetch pós-save (antes do onRangeUpdate corrigir).
    const sunday = new Date(monday);
    sunday.setDate(monday.getDate() + 6);
    sunday.setHours(23, 59, 59, 999);
    const toNaiveISO = (dt: Date) =>
      `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}T${String(dt.getHours()).padStart(2, '0')}:${String(dt.getMinutes()).padStart(2, '0')}:00.000Z`;
    rangeRef.current = { start: toNaiveISO(monday), end: toNaiveISO(sunday) };
    fetchEvents(start, end);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // apenas no mount — onRangeUpdate atualiza o range nas navegações

  // Onda 17.59 — o botão "Hoje" do schedule-x usa o "today" INTERNO (UTC), que à
  // noite (após 21h em Maceió) já é o dia seguinte → levava a agenda pro dia errado
  // (vazio). Intercepta o clique (fase de captura) e navega pro dia de MACEIÓ.
  useEffect(() => {
    if (!calendar) return;
    const handler = (e: MouseEvent) => {
      const el = e.target as HTMLElement | null;
      const btn = el?.closest?.('button');
      if (!btn) return;
      const isTodayBtn =
        (typeof btn.className === 'string' && btn.className.includes('today')) ||
        (btn.textContent?.trim() === 'Hoje' && !!el?.closest?.('.sx-react-calendar-wrapper'));
      if (isTodayBtn) {
        e.stopImmediatePropagation();
        e.preventDefault();
        navigateCalendarTo(maceioTodayStr(), calendar);
      }
    };
    document.addEventListener('click', handler, true);
    return () => document.removeEventListener('click', handler, true);
  }, [calendar, navigateCalendarTo]);

  // Refetch quando filtro de usuario muda
  useEffect(() => {
    if (rangeRef.current) {
      fetchEvents(rangeRef.current.start, rangeRef.current.end);
    }
  }, [filterUserId, showAllUsers, fetchEvents]);

  // ─── Socket.io Real-Time (shared socket from SocketProvider) ─────
  useEffect(() => {
    if (!sharedSocket) return;

    const handleCalendarUpdate = () => {
      if (rangeRef.current) fetchEvents(rangeRef.current.start, rangeRef.current.end);
    };

    const handleCalendarReminder = (data: { eventId: string; title: string; type: string; start_at: string; minutesBefore: number }) => {
      setReminderToast(data);
      try { playNotificationSound(); } catch (e) { swallow('autoplay som notificacao bloqueado pelo navegador')(e); }
      setTimeout(() => setReminderToast(null), 10000);
    };

    sharedSocket.on('calendar_update', handleCalendarUpdate);
    sharedSocket.on('calendar_reminder', handleCalendarReminder);

    return () => {
      sharedSocket.off('calendar_update', handleCalendarUpdate);
      sharedSocket.off('calendar_reminder', handleCalendarReminder);
    };
  }, [sharedSocket, fetchEvents]);

  // ─── Modal Handlers ─────────────────────────────────

  const openEditModal = (ev: CalendarEvent) => {
    setFormData({
      type: ev.type,
      title: ev.title,
      description: ev.description || '',
      date: formatDateInput(ev.start_at),
      startTime: formatTimeInput(ev.start_at),
      endTime: ev.end_at ? formatTimeInput(ev.end_at) : '',
      all_day: ev.all_day,
      status: ev.status,
      location: ev.location || '',
      assigned_user_id: ev.assigned_user_id || '',
      lead_id: ev.lead_id || '',
      patient_id: ev.patient_id || '',
      legal_case_id: ev.legal_case_id || '',
      // v26: editar evento — preserva reminders salvos, fallback pros defaults
      // (filtrados pelo tempo restante ate o evento)
      reminders: (ev as any).reminders?.map((r: any) => ({ minutes_before: r.minutes_before, channel: r.channel })) || getDefaultReminders(reminderAntecedenciasRef.current, ev.start_at),
      recurrence_rule: (ev as any).recurrence_rule || '',
      recurrence_end: (ev as any).recurrence_end ? formatDateInput((ev as any).recurrence_end) : '',
      recurrence_days: (ev as any).recurrence_days || [],
    });
    setEditingEvent(ev);
    setShowModal(true);
  };

  const handleSave = async (forceIgnoreConflict = false) => {
    // Onda 5e v20: logs detalhados + estado saving pra debug do bug
    // "Salvar nao funciona". Console.log no inicio confirma que o handler
    // foi chamado (se nao aparece nem isso, eh problema de render do botao).
    console.log('[handleSave] iniciado', {
      forceIgnoreConflict,
      editingEvent: editingEvent?.id,
      formData: {
        title: formData.title,
        date: formData.date,
        startTime: formData.startTime,
        endTime: formData.endTime,
        type: formData.type,
        assigned_user_id: formData.assigned_user_id,
        lead_id: formData.lead_id,
        patient_id: formData.patient_id,
      },
    });

    // Onda 5e v19: feedback explicito quando validacao falha — antes era
    // silent return (operador clicava Salvar e nada acontecia).
    if (!formData.title.trim()) {
      console.warn('[handleSave] title vazio — abortando');
      showError('Informe o título do evento');
      return;
    }
    if (!formData.date) {
      console.warn('[handleSave] date vazia — abortando');
      showError('Informe a data do evento');
      return;
    }

    setSavingEvent(true);
    const startIso = toISOFromLocal(`${formData.date} ${formData.startTime}`);
    const endIso = formData.endTime ? toISOFromLocal(`${formData.date} ${formData.endTime}`) : undefined;
    console.log('[handleSave] datas convertidas', { startIso, endIso });

    // Conflict check — modal simplificado nao tem botao "salvar mesmo assim",
    // entao conflito vira hard-block (operador escolhe outro horario).
    if (formData.assigned_user_id && endIso) {
      try {
        const params: any = { userId: formData.assigned_user_id, start: startIso, end: endIso };
        if (editingEvent) params.excludeId = editingEvent.id;
        // Onda 17.61 — checagem de conflito é não-crítica (catch abaixo segue o save);
        // timeout curto pra ela nunca segurar o botão "Salvar".
        const conflicts = await api.get('/calendar/conflicts', { params, timeout: 8000 });
        if (conflicts.data?.length > 0) {
          const c = conflicts.data[0];
          const hh = (s: string) => new Date(s).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', timeZone: 'UTC' });
          showError(`Conflito com "${c.title}" (${hh(c.start_at)}–${hh(c.end_at)}) — escolha outro horario`);
          setSavingEvent(false); // Onda 17.59 — solta o botão; antes ficava preso em "Salvando…"
          return;
        }
      } catch (e) { swallow('conflict check falhou — segue com save (server valida tb)')(e); }
    }

    // Onda 17.59 — RE-ANEXA os lembretes. O modal simplificado tirou o campo de
    // reminders da UI, mas eles NÃO podem sumir do evento: sem isso o create()
    // grava o evento SEM lembrete e os disparos "Lembrete 1h/15min" NUNCA são
    // agendados. Recalcula os defaults (canal WhatsApp, filtrados pelo tempo
    // restante até o evento) com base na data/hora FINAL e envia no payload.
    // Usa a string local SEM "Z" (igual openCreateModal) pro cálculo de tempo
    // restante ficar no fuso de Maceió.
    const remindersPayload = getDefaultReminders(
      reminderAntecedenciasRef.current,
      `${formData.date}T${formData.startTime}:00`,
    );

    // Modal simplificado — só envia campos visiveis no UI. Description,
    // location e recurrence sairam da UI (decisao do usuario).
    const payload: any = {
      type: formData.type,
      title: formData.title.trim(),
      start_at: startIso,
      end_at: endIso || null,
      all_day: formData.all_day,
      status: formData.status,
      assigned_user_id: formData.assigned_user_id || null,
      lead_id: formData.lead_id || null,
      patient_id: formData.patient_id || null,
      reminders: remindersPayload,
    };

    console.log('[handleSave] enviando payload pro backend', {
      url: editingEvent ? `PATCH /calendar/events/${editingEvent.id}` : 'POST /calendar/events',
      payload,
    });

    try {
      let response: any;
      // Onda 17.61 — timeout explícito no save: se o backend travar (ex.: Redis lento
      // ao re-enfileirar lembretes), o botão volta com erro em 30s em vez de ficar preso.
      if (editingEvent) {
        response = await api.patch(`/calendar/events/${editingEvent.id}`, payload, { timeout: 30000 });
        console.log('[handleSave] PATCH success', response.data);
        showSuccess('Alterações salvas');
      } else {
        response = await api.post('/calendar/events', payload, { timeout: 30000 });
        console.log('[handleSave] POST success', response.data);
        showSuccess('Evento criado');
      }
      setShowModal(false);
      if (rangeRef.current) fetchEvents(rangeRef.current.start, rangeRef.current.end);
    } catch (e: any) {
      // v19: log no console pra debug + erro do backend pro user
      console.error('[handleSave] error', {
        status: e?.response?.status,
        data: e?.response?.data,
        message: e?.message,
        full: e,
      });
      showError(e?.response?.data?.message || e?.message || 'Erro ao salvar. Tente novamente');
    } finally {
      setSavingEvent(false);
    }
  };

  const handleStatusChange = async (newStatus: string) => {
    if (!editingEvent) return;
    try {
      await api.patch(`/calendar/events/${editingEvent.id}/status`, { status: newStatus });
      setEditingEvent({ ...editingEvent, status: newStatus });
      setFormData(f => ({ ...f, status: newStatus })); // mantém o form em sincronia (evita reverter ao salvar)
      if (rangeRef.current) fetchEvents(rangeRef.current.start, rangeRef.current.end);
    } catch (e: any) {
      showError(e?.response?.data?.message || e?.message || 'Erro ao alterar status');
    }
  };

  /** Valida atendimento clinicamente (Fase 23) — Modal pede notas opcionais */
  const handleValidate = async () => {
    if (!editingEvent) return;
    const notes = window.prompt(
      'Notas clínicas (opcional)\n\nVocê está atestando que este atendimento aconteceu. Após validar, apenas um administrador pode reverter ou trocar o dentista responsável.\n\nDeixe vazio se não tiver notas:',
      '',
    );
    if (notes === null) return; // usuário cancelou
    try {
      const { data } = await api.post(`/calendar/events/${editingEvent.id}/validate`, {
        notes: notes.trim() || undefined,
      });
      showSuccess('Atendimento validado');
      setEditingEvent({
        ...editingEvent,
        status: data.status,
        validated_at: data.validated_at,
        validated_by_user_id: data.validated_by_user_id,
        validated_by: data.validated_by,
      } as any);
      if (rangeRef.current) fetchEvents(rangeRef.current.start, rangeRef.current.end);
    } catch (e: any) {
      showError(e?.response?.data?.message || e?.message || 'Erro ao validar');
    }
  };

  /** Reverter validacao — apenas admin */
  const handleUnvalidate = async () => {
    if (!editingEvent) return;
    if (!confirm('Reverter validação clínica deste atendimento?\n\nIsso permite trocar o dentista atribuído ou re-validar com outro profissional.')) return;
    try {
      await api.post(`/calendar/events/${editingEvent.id}/unvalidate`);
      showSuccess('Validação revertida');
      setEditingEvent({
        ...editingEvent,
        validated_at: null,
        validated_by_user_id: null,
        validated_by: null,
      } as any);
      if (rangeRef.current) fetchEvents(rangeRef.current.start, rangeRef.current.end);
    } catch (e: any) {
      showError(e?.response?.data?.message || e?.message || 'Erro ao reverter');
    }
  };

  const handleDelete = async (scope: 'single' | 'all' = 'single') => {
    if (!editingEvent) return;
    const isRecurring = (editingEvent as any).parent_event_id || (editingEvent as any).recurrence_rule;

    if (isRecurring && scope === 'single') {
      // Evento recorrente: perguntar se quer deletar a série inteira ou só este
      const deleteAll = confirm('Este evento faz parte de uma série.\n\nClique OK para excluir TODA a série.\nClique Cancelar para excluir apenas este evento.');
      if (deleteAll) {
        // Usuário confirmou deleção de toda a série
        const parentId = (editingEvent as any).parent_event_id || editingEvent.id;
        try {
          await api.delete(`/calendar/events/${parentId}?deleteScope=all`);
          setShowModal(false);
          showSuccess('Série de eventos removida');
          if (rangeRef.current) fetchEvents(rangeRef.current.start, rangeRef.current.end);
        } catch (e: any) {
          showError(e?.response?.data?.message || e?.message || 'Erro ao remover série');
        }
      } else {
        // Usuário cancelou a deleção da série — perguntar se quer deletar só este
        if (!confirm('Remover apenas este evento da série?')) return;
        try {
          await api.delete(`/calendar/events/${editingEvent.id}`);
          setShowModal(false);
          showSuccess('Evento removido');
          if (rangeRef.current) fetchEvents(rangeRef.current.start, rangeRef.current.end);
        } catch (e: any) {
          showError(e?.response?.data?.message || e?.message || 'Erro ao remover evento');
        }
      }
      return; // sempre encerra aqui para eventos recorrentes
    }

    // Evento simples (não recorrente)
    if (!confirm('Remover este evento?')) return;
    try {
      await api.delete(`/calendar/events/${editingEvent.id}`);
      setShowModal(false);
      showSuccess('Evento removido');
      if (rangeRef.current) fetchEvents(rangeRef.current.start, rangeRef.current.end);
    } catch (e: any) {
      showError(e?.response?.data?.message || e?.message || 'Erro ao remover evento');
    }
  };

  const [sendingNotify, setSendingNotify] = useState(false);

  const handleNotify = async () => {
    if (!editingEvent) return;
    setSendingNotify(true);
    try {
      const res = await api.post(`/calendar/events/${editingEvent.id}/notify`);
      showSuccess(res.data?.message || 'Notificação WhatsApp enviada ao cliente!');
    } catch (e: any) {
      showError(e?.response?.data?.message || e?.message || 'Erro ao reenviar notificação');
    } finally {
      setSendingNotify(false);
    }
  };

  const handleDuplicate = () => {
    if (!editingEvent) return;
    setShowModal(false);
    setTimeout(() => {
      const now = new Date();
      setFormData({
        type: editingEvent.type,
        title: editingEvent.title + ' (cópia)',
        description: editingEvent.description || '',
        date: formatDateInput(now.toISOString()),
        startTime: formatTimeInput(editingEvent.start_at),
        endTime: editingEvent.end_at ? formatTimeInput(editingEvent.end_at) : '',
        all_day: editingEvent.all_day,
        status: 'AGENDADO', // cópia começa como novo agendamento
        location: editingEvent.location || '',
        assigned_user_id: editingEvent.assigned_user_id || '',
        lead_id: editingEvent.lead_id || '',
        patient_id: editingEvent.patient_id || '',
        legal_case_id: editingEvent.legal_case_id || '',
        // v26: duplicar -> defaults filtrados pra hoje (data nova)
        reminders: getDefaultReminders(reminderAntecedenciasRef.current, `${formatDateInput(now.toISOString())}T${formatTimeInput(editingEvent.start_at)}:00`),
        recurrence_rule: '',
        recurrence_end: '',
        recurrence_days: [],
      });
      setEditingEvent(null);
      setShowModal(true);
    }, 100);
  };

  const handleExportICS = async (eventId: string) => {
    try {
      const apiUrl = API_BASE_URL;
      const token = localStorage.getItem('token');
      const res = await fetch(`${apiUrl}/calendar/export/ics/${eventId}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `event-${eventId}.ics`;
      a.click();
      URL.revokeObjectURL(url);
    } catch {
      showError('Erro ao exportar evento');
    }
  };

  const handleExportRange = async () => {
    if (!rangeRef.current) return;
    try {
      const apiUrl = API_BASE_URL;
      const token = localStorage.getItem('token');
      const params = new URLSearchParams({
        start: rangeRef.current.start,
        end: rangeRef.current.end,
      });
      if (filterUserId) params.set('userId', filterUserId);
      const res = await fetch(`${apiUrl}/calendar/export/ics?${params}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'calendar-export.ics';
      a.click();
      URL.revokeObjectURL(url);
    } catch {
      showError('Erro ao exportar calendário');
    }
  };

  const handleSearch = (q: string) => {
    setSearchQuery(q);
    if (searchTimeout.current) clearTimeout(searchTimeout.current);
    if (!q.trim()) { setSearchResults([]); return; }
    searchTimeout.current = setTimeout(async () => {
      try {
        const res = await api.get('/calendar/search', { params: { q } });
        setSearchResults(res.data || []);
      } catch { setSearchResults([]); }
    }, 300);
  };

  const toggleFilterType = (typeId: string) => {
    setFilterTypes(prev =>
      prev.includes(typeId) ? prev.filter(t => t !== typeId) : [...prev, typeId]
    );
  };

  // ─── Proximo eventos (sidebar) ──────────────────────

  // Onda 17.59 — "agora" no fuso naive de Maceió (UTC-3). Os eventos são naive-UTC
  // (hora local guardada nos campos UTC); comparar com new Date() cru (UTC real)
  // escondia eventos da noite — após as 21h o UTC já virava o dia seguinte e o
  // evento era tratado como "passado", sumindo de "Próximos".
  const nowNaive = new Date(Date.now() - 3 * 60 * 60 * 1000);
  const upcomingEvents = events
    .filter(e => new Date(e.start_at) >= nowNaive && e.status !== 'CANCELADO' && e.status !== 'CONCLUIDO')
    .filter(e => filterTypes.includes(e.type))
    .sort((a, b) => new Date(a.start_at).getTime() - new Date(b.start_at).getTime())
    .slice(0, 8);

  // Contagem de eventos ATIVOS por dia (YYYY-MM-DD) — usado pro pontinho de
  // ocupação no mini-calendário do sidebar. Filtra cancelados, concluídos e
  // tipos não selecionados nos filtros (mesma regra de exibição do calendar).
  const eventCountsByDay = (() => {
    const map = new Map<string, number>();
    for (const e of events) {
      if (e.status === 'CANCELADO' || e.status === 'CONCLUIDO') continue;
      if (!filterTypes.includes(e.type)) continue;
      const d = new Date(e.start_at);
      const ds = `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}-${String(d.getUTCDate()).padStart(2,'0')}`;
      map.set(ds, (map.get(ds) ?? 0) + 1);
    }
    return map;
  })();

  // ─── Render ─────────────────────────────────────────

  // ── Aba "Tarefas": renderiza o painel de tarefas sem layout de calendário.
  // Onda 5d v10: removida barra de tabs Calendario/Tarefas — acesso pela
  // sidebar principal. Switch programatico via switchTab() ainda funciona
  // pra deep-links (?tab=tasks).
  if (activeTab === 'tasks') {
    return (
      <div className="flex flex-col h-full bg-background overflow-hidden">
        <div className="flex-1 overflow-hidden">
          <TasksPanel />
        </div>
      </div>
    );
  }

  return (
    // translate="no" + class notranslate: protege contra Google Tradutor.
    // Schedule-x e DayPilot manipulam o DOM diretamente, e o Tradutor troca
    // os nodes de texto por conta propria — isso causa "Failed to execute
    // 'removeChild' on 'Node'" quando o React tenta atualizar (ex: ao trocar
    // dentista no filtro). O atributo desliga a traducao so neste subtree.
    <div
      className="flex flex-col h-full bg-background overflow-hidden notranslate"
      translate="no"
    >

      {/* Onda 5d v10: tabs Calendario/Tarefas removidas — acesso pela sidebar */}

      {/* Conteúdo do Calendário */}
      <div className="flex flex-1 overflow-hidden">

      {/* ═══ Sidebar estilo Google Calendar — Onda 5d v5 (Fase 25): compactada ═══ */}
      <aside className="hidden md:flex flex-col w-52 shrink-0 border-r border-border bg-card/30 overflow-y-auto custom-scrollbar">

        {/* ── Topo: titulo + contador (compactado) ── */}
        <div className="px-2 pt-2 pb-1.5 flex items-center justify-between gap-2">
          <div className="flex items-center gap-1.5">
            <div className="w-5 h-5 rounded-md bg-primary/10 flex items-center justify-center">
              <CalendarIcon size={11} className="text-primary" />
            </div>
            <span className="font-semibold text-xs text-foreground">Agenda</span>
          </div>
          <span className="text-[10px] text-muted-foreground">
            {events.length} evento{events.length !== 1 ? 's' : ''}
          </span>
        </div>

        {/* Mini Calendário */}
        <div className="px-2 mb-1">
          <MiniCalendar
            eventCounts={eventCountsByDay}
            holidays={holidays}
            onDateSelect={(dateStr) => {
              // Onda 5d v11: removido try/catch+swallow — helper ja faz log
              // proprio se algo der errado (ajuda diagnosticar futuras
              // mudancas de API do schedule-x sem ficar silente)
              navigateCalendarTo(dateStr, calendar);
            }}
          />
        </div>

        <div className="mx-2 border-t border-border/50 my-0.5" />

        {/* Filtros por tipo — Onda 5d v5: items mais densos */}
        <div className="px-2 py-1">
          <p className="text-[9px] font-bold uppercase tracking-wider text-muted-foreground mb-1">Meus calendários</p>
          <div className="space-y-0">
            {EVENT_TYPES.map(t => (
              <label key={t.id} className="flex items-center gap-1.5 cursor-pointer py-0.5 group rounded px-1 hover:bg-accent/40 transition-colors">
                <input
                  type="checkbox"
                  checked={filterTypes.includes(t.id)}
                  onChange={() => toggleFilterType(t.id)}
                  className="sr-only"
                />
                <span
                  className={`w-3 h-3 rounded border-2 flex items-center justify-center transition-all shrink-0 ${
                    filterTypes.includes(t.id) ? '' : 'opacity-30'
                  }`}
                  style={{ borderColor: t.color, background: filterTypes.includes(t.id) ? t.color : 'transparent' }}
                >
                  {filterTypes.includes(t.id) && <CheckCircle2 size={7} className="text-white" />}
                </span>
                <span className={`text-[11px] font-medium transition-opacity ${filterTypes.includes(t.id) ? 'text-foreground' : 'text-muted-foreground opacity-50'}`}>
                  {t.emoji} {t.label}
                </span>
              </label>
            ))}
          </div>

          {/* Toggle: mostrar eventos cancelados — compactado */}
          <label className="flex items-center gap-1.5 cursor-pointer py-0.5 mt-1 pt-1 border-t border-border/40 group rounded px-1 hover:bg-accent/40 transition-colors">
            <input
              type="checkbox"
              checked={showCancelled}
              onChange={() => setShowCancelled(v => !v)}
              className="sr-only"
            />
            <span
              className={`w-3 h-3 rounded border-2 flex items-center justify-center transition-all shrink-0 ${
                showCancelled ? 'bg-rose-500 border-rose-500' : 'border-muted-foreground/40 opacity-50'
              }`}
            >
              {showCancelled && <CheckCircle2 size={7} className="text-white" />}
            </span>
            <span className={`text-[11px] font-medium transition-opacity ${showCancelled ? 'text-foreground' : 'text-muted-foreground opacity-60'}`}>
              ✖️ Cancelados
            </span>
          </label>
        </div>

        {/* Filtro por dentista — apenas pra ADMIN/OPERADOR/ASSISTANT.
            DENTIST/FINANCEIRO so veem a propria agenda (backend forca o
            filtro), entao o seletor e omitido pra evitar UX confusa. */}
        {role.canViewAllAgenda && (
          <div className="px-2 py-1">
            <div className="flex items-center justify-between mb-1">
              <p className="text-[9px] font-bold uppercase tracking-wider text-muted-foreground">Dentista</p>
              <button
                onClick={() => setShowAllUsers(v => !v)}
                className={`text-[9px] font-semibold px-1.5 py-0.5 rounded-full border transition-colors ${
                  showAllUsers
                    ? 'bg-primary/10 text-primary border-primary/30'
                    : 'text-muted-foreground border-border hover:bg-accent'
                }`}
                title={showAllUsers ? 'Mostrando todos' : 'Somente meus eventos'}
              >
                {showAllUsers ? 'Todos' : 'Meus'}
              </button>
            </div>
            {/* O seletor de dentista foi pro topo (alinhado com o header do mês).
                Aqui fica só o toggle Todos/Meus. */}
          </div>
        )}

        <div className="mx-2 border-t border-border/50 my-0.5" />

        {/* Onda 17.61 — Exibição: densidade + esconder madrugada (mexe no schedule-x
            via signal, sem recriar o calendário). */}
        <div className="px-2 py-1">
          <p className="text-[9px] font-bold uppercase tracking-wider text-muted-foreground mb-1">Exibição</p>
          <div className="space-y-0.5">
            {([['compacto', 'Compacto'], ['confortavel', 'Confortável'], ['amplo', 'Amplo']] as const).map(([id, label]) => (
              <button
                key={id}
                onClick={() => changeDensity(id)}
                className={`w-full flex items-center gap-1.5 text-left px-1.5 py-1 rounded-md text-[11px] font-medium transition-colors ${
                  agendaDensity === id ? 'bg-primary/10 text-primary' : 'text-muted-foreground hover:bg-accent/40'
                }`}
                title={`Densidade ${label}`}
              >
                <span className={`w-2.5 h-2.5 rounded-full border-2 shrink-0 ${agendaDensity === id ? 'border-primary bg-primary' : 'border-muted-foreground/40'}`} />
                {label}
              </button>
            ))}
          </div>
          <label className="flex items-center gap-1.5 cursor-pointer py-0.5 mt-1 pt-1 border-t border-border/40 rounded px-1 hover:bg-accent/40 transition-colors">
            <input type="checkbox" checked={!hideMadrugada} onChange={toggleMadrugada} className="sr-only" />
            <span className={`w-3 h-3 rounded border-2 flex items-center justify-center transition-all shrink-0 ${!hideMadrugada ? 'bg-primary border-primary' : 'border-muted-foreground/40 opacity-50'}`}>
              {!hideMadrugada && <CheckCircle2 size={7} className="text-white" />}
            </span>
            <span className="text-[11px] font-medium text-muted-foreground">🌙 Mostrar madrugada (00–07h)</span>
          </label>
        </div>

        <div className="mx-2 border-t border-border/50 my-0.5" />

        {/* Próximos eventos — Onda 5d v5 compactado */}
        <div className="px-2 py-1 flex-1">
          <p className="text-[9px] font-bold uppercase tracking-wider text-muted-foreground mb-1">Próximos</p>
          {upcomingEvents.length === 0 ? (
            <div className="flex flex-col items-center gap-2 py-6 text-center">
              <div className="w-10 h-10 rounded-full bg-accent/50 flex items-center justify-center">
                <CalendarIcon size={18} className="text-muted-foreground/50" />
              </div>
              <p className="text-xs text-muted-foreground">Nenhum evento futuro</p>
              <button
                onClick={() => openCreateModal()}
                className="text-[11px] font-semibold text-primary hover:underline"
              >
                + Criar evento
              </button>
            </div>
          ) : (
            <div className="space-y-1.5">
              {upcomingEvents.map(ev => {
                const d = new Date(ev.start_at);
                const typeColor = getEventColor(ev.type);
                const borderColor = eventAccentColor(ev); // borda pelo STATUS (Dental Office)
                const isOverdue = new Date(ev.start_at) < new Date() && ev.status === 'AGENDADO';
                return (
                  <button
                    key={ev.id}
                    onClick={() => openEditModal(ev)}
                    onMouseEnter={(e) => {
                      const rect = e.currentTarget.getBoundingClientRect();
                      setHoverTooltip({ event: ev, x: rect.right + 8, y: rect.top });
                    }}
                    onMouseLeave={() => setHoverTooltip(null)}
                    className="w-full text-left p-2 rounded-xl border border-border/40 hover:bg-accent/50 hover:border-border transition-all group overflow-hidden relative"
                    style={{ borderLeft: `3px solid ${borderColor}` }}
                  >
                    <div className="flex items-center gap-1.5 mb-0.5">
                      <span className="w-2 h-2 rounded-full shrink-0" style={{ background: typeColor }} />
                      <span className={`text-[10px] ${isOverdue ? 'text-red-400 font-semibold' : 'text-muted-foreground'}`}>
                        {isOverdue ? '⚠️ ' : ''}{d.toLocaleDateString('pt-BR', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' })}
                        {' · '}
                        {d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', timeZone: 'UTC' })}
                      </span>
                    </div>
                    <p className="text-xs font-semibold truncate text-foreground">
                      {ev.title}
                    </p>
                    {ev.lead && (
                      <p className="text-[10px] text-muted-foreground truncate mt-0.5">👤 {ev.lead.name || ev.lead.phone}</p>
                    )}
                    {ev.legal_case && (
                      <p className="text-[10px] text-primary/70 font-semibold truncate mt-0.5">
                        📂 {ev.legal_case.case_number ?? 'Processo vinculado'}
                        {ev.legal_case.specialty ? ` · ${ev.legal_case.specialty}` : ''}
                      </p>
                    )}
                    {ev.legal_case?.lead?.name && (
                      <p className="text-[10px] text-muted-foreground truncate">👤 {ev.legal_case.lead.name}</p>
                    )}
                    {ev.location && (
                      <p className="text-[10px] text-muted-foreground/70 truncate mt-0.5">📍 {ev.location}</p>
                    )}
                    {isOverdue && (() => {
                      const days = Math.max(0, Math.floor((Date.now() - new Date(ev.start_at).getTime()) / 86400000));
                      return (
                        <span className="inline-flex items-center gap-0.5 text-[9px] font-bold text-red-400 bg-red-400/10 px-1.5 py-0.5 rounded-full mt-1">
                          {days > 0 ? `${days}d atraso` : 'Venceu hoje'}
                        </span>
                      );
                    })()}
                  </button>
                );
              })}
            </div>
          )}
        </div>
      </aside>

      {/* ═══ Área principal ═══ */}
      <div className="flex-1 flex flex-col overflow-hidden relative">

        {/* Onda 5e v6 (Fase 25): top bar global REMOVIDA — Kanban + Novo
            Evento foram pra position absolute sobre o header do schedule-x
            (alinhados com "Abril – Maio 2026"), economizando ~40px verticais.
            Botoes mobile (filtros, todos/meus) viram floating se necessario. */}

        {/* Mobile-only top bar (filtros + todos/meus) */}
        <div className="shrink-0 px-3 py-1.5 border-b border-border bg-card/40 flex items-center gap-2 md:hidden">
          <button
            onClick={() => setShowFilters(v => !v)}
            className="p-1.5 rounded-md border border-border text-muted-foreground hover:bg-accent transition-colors"
          >
            <Filter size={13} />
          </button>
          <div className="flex-1" />
          {/* Toggle Todos/Meus — so pra quem pode ver agenda alheia */}
          {role.canViewAllAgenda && (
            <button
              onClick={() => setShowAllUsers(v => !v)}
              className={`inline-flex items-center gap-1 px-2 py-1 rounded-md border text-[11px] font-semibold transition-colors ${
                showAllUsers ? 'border-primary/40 bg-primary/10 text-primary' : 'border-border text-muted-foreground'
              }`}
            >
              {showAllUsers ? <Users size={11} /> : <User size={11} />}
            </button>
          )}
        </div>

        {/* Kanban + Novo Evento — POSITION ABSOLUTE alinhados com header do
            schedule-x (canto superior direito da area do calendario). z-20 pra
            ficar acima do header do schedule-x. */}
        <div className="hidden sm:flex absolute top-2 right-3 z-20 items-center gap-2 pointer-events-none">
          {/* Filtro por dentista — alinhado com o header do mês (antes ficava na
              sidebar). Some quando o operador está em "Meus eventos" (showAllUsers=false). */}
          {role.canViewAllAgenda && showAllUsers && (
            <select
              value={filterUserId}
              onChange={e => setFilterUserId(e.target.value)}
              className="pointer-events-auto inline-flex items-center px-2.5 py-1.5 rounded-lg border border-border bg-card text-xs font-medium text-foreground shadow-sm outline-none focus:ring-2 focus:ring-primary/30 hover:bg-accent transition-colors max-w-[180px]"
              title="Filtrar agenda por dentista"
            >
              <option value="">Todos os dentistas</option>
              {users.map(u => <option key={u.id} value={u.id}>{u.name}</option>)}
            </select>
          )}
          <button
            onClick={() => setKanbanView(v => !v)}
            className={`pointer-events-auto inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border text-xs font-medium transition-colors shadow-sm ${
              kanbanView
                ? 'bg-accent border-accent-foreground/20 text-foreground'
                : 'border-border bg-card text-muted-foreground hover:bg-accent'
            }`}
            title={kanbanView ? 'Ver Calendário' : 'Ver Kanban de Tarefas'}
          >
            {kanbanView ? <CalendarViewIcon size={12} /> : <LayoutGrid size={12} />}
            <span>{kanbanView ? 'Calendário' : 'Kanban'}</span>
          </button>

          {/* Bloquear agenda — apenas pra quem pode gerenciar (ADMIN/OPERADOR/ASSISTANT).
              DENTIST nao tem permissao de criar/bloquear na agenda. */}
          {role.canCreateAgendaEvent && (
            <button
              onClick={() => setShowBlockModal(true)}
              className="pointer-events-auto inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-red-600 text-white text-xs font-semibold hover:bg-red-700 transition-colors shadow-md"
              title="Bloquear agenda (férias, doença, etc)"
            >
              <Ban size={12} />
              <span>Bloquear</span>
            </button>
          )}

          {/* Novo Evento — mesma regra de Bloquear */}
          {role.canCreateAgendaEvent && (
            <button
              onClick={() => openCreateModal()}
              className="pointer-events-auto inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-primary text-primary-foreground font-semibold text-xs hover:bg-primary/90 transition-colors shadow-md"
              title="Criar evento (atalho: N)"
            >
              <Plus size={13} />
              <span>Novo Evento</span>
            </button>
          )}
        </div>

        {/* Filtros mobile (expansível) */}
        {showFilters && (
          <div className="px-3 py-2 flex flex-wrap gap-1.5 border-b border-border bg-card/30 md:hidden">
            {EVENT_TYPES.map(t => (
              <button
                key={t.id}
                onClick={() => toggleFilterType(t.id)}
                className={`inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs font-semibold border transition-all ${
                  filterTypes.includes(t.id) ? 'opacity-100 ring-1 ring-offset-1 ring-offset-background' : 'opacity-40'
                }`}
                style={{ borderColor: t.color + '40', color: t.color, background: t.color + '15' }}
              >
                {t.emoji} {t.label}
              </button>
            ))}
            {showAllUsers && (
              <select
                value={filterUserId}
                onChange={e => setFilterUserId(e.target.value)}
                className="px-2.5 py-1.5 rounded-lg border border-border bg-card text-xs text-foreground"
              >
                <option value="">Todos</option>
                {users.map(u => <option key={u.id} value={u.id}>{u.name}</option>)}
              </select>
            )}
          </div>
        )}

        {/* ══ KANBAN VIEW ══ */}
        {kanbanView ? (
          <div className="flex-1 overflow-auto p-4">
            <div className="flex gap-3 h-full" style={{ minWidth: 600 }}>
              {KANBAN_COLUMNS.map(col => {
                const colEvents = events.filter(e =>
                  e.type === 'TAREFA' && e.status === col.id
                );
                return (
                  <div key={col.id} className="flex flex-col flex-1 min-w-[220px] max-w-[320px]">
                    {/* Cabeçalho da coluna */}
                    <div
                      className="flex items-center gap-2 mb-3 px-3 py-2 rounded-xl border"
                      style={{ borderColor: col.color + '40', background: col.color + '10' }}
                    >
                      <span className="text-sm">{col.emoji}</span>
                      <span className="text-sm font-bold text-foreground">{col.label}</span>
                      <span className="ml-auto text-xs font-bold text-muted-foreground bg-background/60 px-2 py-0.5 rounded-full">
                        {colEvents.length}
                      </span>
                    </div>

                    {/* Cards */}
                    <div className="flex flex-col gap-2 flex-1 overflow-y-auto custom-scrollbar pb-4">
                      {colEvents.map(ev => {
                        const borderColor = eventAccentColor(ev); // borda pelo STATUS (Dental Office)
                        const isOverdue = new Date(ev.start_at) < new Date() && col.id !== 'CONCLUIDO';
                        const daysOverdue = isOverdue
                          ? Math.max(0, Math.floor((Date.now() - new Date(ev.start_at).getTime()) / 86400000))
                          : 0;
                        return (
                          <div
                            key={ev.id}
                            className="bg-card border border-border rounded-xl p-3 cursor-pointer hover:shadow-md hover:border-primary/30 transition-all group"
                            style={{ borderLeft: `3px solid ${borderColor}` }}
                            onClick={() => openEditModal(ev)}
                          >
                            <p className="text-sm font-semibold text-foreground mb-1 group-hover:text-primary transition-colors leading-snug">
                              {ev.title}
                            </p>
                            <div className="flex flex-wrap gap-x-2 text-[10px] text-muted-foreground mb-2">
                              <span className="flex items-center gap-0.5">
                                <Clock size={9} />
                                {new Date(ev.start_at).toLocaleDateString('pt-BR', { day: '2-digit', month: 'short', timeZone: 'UTC' })}
                              </span>
                              {ev.assigned_user && <span>· {ev.assigned_user.name}</span>}
                              {ev.lead && <span>· {ev.lead.name || ev.lead.phone}</span>}
                            </div>

                            {isOverdue && (
                              <span className="inline-flex items-center gap-0.5 text-[10px] font-bold text-red-400 bg-red-400/10 px-2 py-0.5 rounded-full mb-2">
                                ⚠️ {daysOverdue > 0 ? `${daysOverdue}d atraso` : 'Venceu hoje'}
                              </span>
                            )}

                            {/* Mover para outra coluna */}
                            <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity mt-1 flex-wrap">
                              {KANBAN_COLUMNS.filter(c => c.id !== col.id).map(target => (
                                <button
                                  key={target.id}
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    api.patch(`/calendar/events/${ev.id}`, { status: target.id })
                                      .then(() => setEvents(prev =>
                                        prev.map(x => x.id === ev.id ? { ...x, status: target.id } : x)
                                      ));
                                  }}
                                  className="text-[9px] font-bold px-2 py-0.5 rounded-full border border-border hover:bg-accent transition-colors"
                                  style={{ color: target.color }}
                                >
                                  → {target.label}
                                </button>
                              ))}
                            </div>
                          </div>
                        );
                      })}

                      {/* Estado vazio por coluna */}
                      {colEvents.length === 0 && (
                        <div className="flex flex-col items-center gap-2 py-10 rounded-xl border-2 border-dashed border-border/30">
                          <span className="text-3xl opacity-20">{col.emoji}</span>
                          <p className="text-xs text-muted-foreground/40">Nenhuma tarefa</p>
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        ) : (
        /* ══ CALENDÁRIO SCHEDULE-X ou DayPilot Resources (Fase 12 PR2) ══ */
        <div className="flex-1 overflow-auto">
          {/* Onda 5d v10: tabs Semana/Por profissional/Lista REMOVIDAS — fica
              fixo no modo definido em calendarMode (default 'week'). Pra
              reativar: descomentar bloco abaixo. setCalendarMode() ainda
              funciona programaticamente (deep-links / atalhos). */}

          {calendarMode === 'list' ? (
            <AgendaListView
              events={events}
              users={users}
              filterTypes={filterTypes}
              filterUserId={filterUserId}
              showCancelled={showCancelled}
              showAllUsers={showAllUsers}
              currentUserId={currentUserId}
              onEventClick={(eventId) => {
                const ev = eventsRef.current.find((e) => e.id === eventId);
                if (ev) openEditModal(ev);
              }}
            />
          ) : calendarMode === 'professional' ? (
            <div className="p-3 h-full">
              <AgendaResourceLayout
                date={resourceDate}
                setDate={setResourceDate}
                professionals={users.map((u) => ({ id: u.id, name: u.name }))}
                events={events as any}
                onEventClick={(eventId) => {
                  const ev = eventsRef.current.find((e) => e.id === eventId);
                  if (ev) openEditModal(ev);
                }}
                onSlotClick={({ start, assigned_user_id }) => {
                  const d = new Date(start);
                  const local = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')} ${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
                  openCreateModal(local, assigned_user_id);
                }}
                onMove={async ({ id, start, end, assigned_user_id }) => {
                  try {
                    await api.patch(`/calendar/events/${id}`, {
                      start_at: start,
                      end_at: end,
                      assigned_user_id,
                    });
                    setEvents((prev) =>
                      prev.map((e) =>
                        e.id === id ? { ...e, start_at: start, end_at: end, assigned_user_id } : e,
                      ),
                    );
                  } catch {
                    if (rangeRef.current) fetchEvents(rangeRef.current.start, rangeRef.current.end);
                  }
                }}
              />
            </div>
          ) : (
            <div className="sx-react-calendar-wrapper h-full min-h-[500px]" style={{
              ['--sx-color-primary' as any]: 'hsl(var(--primary))',
              ['--sx-color-surface' as any]: 'hsl(var(--card))',
              ['--sx-color-on-surface' as any]: 'hsl(var(--foreground))',
              ['--sx-color-surface-variant' as any]: 'hsl(var(--accent))',
            }}>
              {calendar && <ScheduleXCalendar calendarApp={calendar} />}
            </div>
          )}
        </div>
        )}

        {/* Onda 17.61 — legenda das cores (fiel ao card real). Só no calendário,
            não no Kanban. Consulta = cor por STATUS; demais tipos = cor própria;
            barra colorida à esquerda do card = dentista. */}
        {!kanbanView && (
          <div className="shrink-0 border-t border-border bg-card/40 px-3 py-1.5 flex items-center gap-x-3 gap-y-1 flex-wrap text-[10px] leading-none">
            <span className="font-bold uppercase tracking-wider text-muted-foreground/80">Consulta</span>
            {LEGEND_STATUS.map((s) => (
              <span key={s.label} className="inline-flex items-center gap-1 text-muted-foreground">
                <span className="w-2.5 h-2.5 rounded-full shrink-0 ring-1 ring-black/5" style={{ background: s.color }} />
                {s.label}
              </span>
            ))}
            <span className="w-px h-3 bg-border mx-0.5 hidden sm:block" />
            <span className="font-bold uppercase tracking-wider text-muted-foreground/80">Tipos</span>
            {LEGEND_TYPE.map((s) => (
              <span key={s.label} className="inline-flex items-center gap-1 text-muted-foreground">
                <span className="w-2.5 h-2.5 rounded-full shrink-0 ring-1 ring-black/5" style={{ background: s.color }} />
                {s.label}
              </span>
            ))}
            <span className="w-px h-3 bg-border mx-0.5 hidden md:block" />
            <span className="inline-flex items-center gap-1 text-muted-foreground/80 italic">
              <span className="w-0.5 h-3 rounded-full shrink-0 bg-gradient-to-b from-fuchsia-500 to-cyan-500" />
              barra à esquerda = dentista
            </span>
          </div>
        )}

      </div>{/* fim área principal */}

      {/* ═══ Tooltip de Evento (hover nos Próximos) ═══ */}
      {mounted && hoverTooltip && createPortal(
        <div
          style={{ position: 'fixed', top: hoverTooltip.y, left: hoverTooltip.x, zIndex: 9998, maxWidth: 240 }}
          className="bg-card border border-border rounded-xl shadow-2xl p-3 pointer-events-none animate-in fade-in-0 zoom-in-95 duration-150"
        >
          <div className="flex items-center gap-2 mb-1.5">
            <span className="text-base">{EVENT_TYPES.find(t => t.id === hoverTooltip.event.type)?.emoji}</span>
            <span className="text-xs font-bold text-foreground truncate">{hoverTooltip.event.title}</span>
          </div>
          <div className="space-y-0.5 text-[11px] text-muted-foreground">
            <p>🕐 {new Date(hoverTooltip.event.start_at).toLocaleString('pt-BR', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'UTC' })}</p>
            {hoverTooltip.event.location && <p>📍 {hoverTooltip.event.location}</p>}
            {hoverTooltip.event.lead && <p>👤 {hoverTooltip.event.lead.name || hoverTooltip.event.lead.phone}</p>}
            {hoverTooltip.event.assigned_user && <p>⚖️ {hoverTooltip.event.assigned_user.name}</p>}
            {hoverTooltip.event.legal_case && (
              <p className="text-primary/80 font-semibold truncate">
                📂 {hoverTooltip.event.legal_case.case_number ?? 'Processo vinculado'}
                {hoverTooltip.event.legal_case.specialty ? ` · ${hoverTooltip.event.legal_case.specialty}` : ''}
              </p>
            )}
            {hoverTooltip.event.legal_case?.lead?.name && (
              <p className="truncate">👤 {hoverTooltip.event.legal_case.lead.name}</p>
            )}
            <p style={{ color: EVENT_STATUSES.find(s => s.id === hoverTooltip.event.status)?.color }}>
              ● {EVENT_STATUSES.find(s => s.id === hoverTooltip.event.status)?.label ?? hoverTooltip.event.status}
            </p>
          </div>
        </div>,
        document.body
      )}

      {/* ═══ Toast de Lembrete ═══ */}
      {reminderToast && (
        <div className="fixed top-4 right-4 z-[10000] w-80 bg-card border border-primary/30 rounded-xl shadow-2xl p-4 animate-in slide-in-from-right-5 duration-300">
          <div className="flex items-start gap-3">
            <div className="w-9 h-9 rounded-lg bg-primary/10 flex items-center justify-center shrink-0">
              <Bell size={18} className="text-primary" />
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-[11px] font-bold uppercase tracking-wider text-primary mb-0.5">
                Lembrete em {reminderToast.minutesBefore} min
              </p>
              <p className="text-sm font-semibold text-foreground truncate">
                {EVENT_TYPES.find(t => t.id === reminderToast.type)?.emoji} {reminderToast.title}
              </p>
              <p className="text-[11px] text-muted-foreground">
                {new Date(reminderToast.start_at).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', timeZone: 'UTC' })}
                {' - '}
                {new Date(reminderToast.start_at).toLocaleDateString('pt-BR', { day: 'numeric', month: 'short', timeZone: 'UTC' })}
              </p>
            </div>
            <button onClick={() => setReminderToast(null)} className="p-1 text-muted-foreground hover:text-foreground">
              <X size={14} />
            </button>
          </div>
        </div>
      )}

      {/* ═══ Modal de Criacao/Edicao ═══ */}
      {showModal && (
        <div className="fixed inset-0 z-[9999] flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm">
          {/* data-modal-content: usado pelo handleSave pra fazer scroll ao topo
              quando aviso de conflito aparece (v19) */}
          <div data-modal-content className="w-full max-w-md bg-card border border-border rounded-2xl shadow-2xl max-h-[90vh] overflow-y-auto custom-scrollbar">
            {/* Modal header */}
            {(() => {
              const canEdit = !editingEvent || currentUserRole === 'ADMIN'
                || editingEvent.created_by_id === currentUserId
                || editingEvent.assigned_user_id === currentUserId
                || editingEvent.created_by?.id === currentUserId
                || editingEvent.assigned_user?.id === currentUserId;
              return (<>
            <div className="flex items-center justify-between px-5 pt-5 pb-3 border-b border-border gap-3">
              <div className="min-w-0 flex-1">
                {/* Quando o evento esta vinculado a um paciente, ele assume o
                    titulo do modal — nome grande, clicavel, abre a ficha.
                    Sem paciente (bloqueio, tarefa, novo evento) cai no titulo
                    generico "Editar Evento" / "Novo Evento". */}
                {editingEvent?.patient ? (
                  <button
                    type="button"
                    onClick={() => { setShowModal(false); router.push(`/atendimento/pacientes/${editingEvent.patient!.id}`); }}
                    title="Abrir ficha do paciente"
                    className="inline-flex items-center gap-2 text-lg font-bold text-emerald-600 hover:text-emerald-700 hover:underline group min-w-0 max-w-full"
                  >
                    <PatientAvatar
                      patientId={editingEvent.patient.id}
                      patientName={editingEvent.patient.name || 'Sem nome'}
                      avatarUrl={(editingEvent.patient as any).avatar_url ?? null}
                      size={28}
                    />
                    <span className="truncate">{editingEvent.patient.name || 'Paciente sem nome'}</span>
                    <ExternalLink size={14} className="shrink-0 opacity-60 group-hover:opacity-100" />
                  </button>
                ) : (
                  <h2 className="text-base font-bold text-foreground">
                    {editingEvent ? (canEdit ? 'Editar Evento' : 'Visualizar Evento') : 'Novo Evento'}
                  </h2>
                )}
                {editingEvent?.created_by && (
                  <p className="text-[10px] text-muted-foreground mt-0.5">
                    Criado por: {editingEvent.created_by.name}
                    {!canEdit && ' · Somente leitura'}
                  </p>
                )}
              </div>
              <button onClick={() => setShowModal(false)} className="p-1.5 rounded-lg hover:bg-accent text-muted-foreground shrink-0">
                <X size={18} />
              </button>
            </div>

            {/* Dentista — primeiro campo, vem antes das pills de status conforme layout simplificado */}
            <fieldset disabled={!canEdit} className="px-5 pt-4">
              <label className="text-[11px] font-bold uppercase tracking-wider text-muted-foreground mb-1 block">Dentista / Responsavel</label>
              <select
                value={formData.assigned_user_id}
                onChange={e => setFormData(f => ({ ...f, assigned_user_id: e.target.value }))}
                className="w-full px-3 py-2 rounded-lg border border-border bg-background text-sm text-foreground outline-none focus:ring-2 focus:ring-primary/30 disabled:opacity-60"
              >
                <option value="">Nenhum</option>
                {users.map(u => <option key={u.id} value={u.id}>{u.name}</option>)}
              </select>
            </fieldset>

            {/* (Status agora fica no slot que era da Prioridade, mais abaixo — Onda 17.61.) */}

            {/* Validacao clinica (Fase 23) — so pra eventos clinicos */}
            {editingEvent && ['CONSULTA', 'PROCEDIMENTO', 'RETORNO'].includes(editingEvent.type) && (
              <div className="px-5 pt-3">
                {editingEvent.validated_at ? (
                  // Atendimento ja validado — mostra badge e (se admin) botao reverter
                  <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-emerald-500/10 border border-emerald-500/20 text-sm">
                    <svg className="w-4 h-4 text-emerald-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />
                    </svg>
                    <div className="flex-1 min-w-0">
                      <div className="font-medium text-emerald-700">Atendimento validado</div>
                      <div className="text-xs text-emerald-600/80">
                        Por Dr(a). {editingEvent.validated_by?.name || '—'} em {new Date(editingEvent.validated_at).toLocaleString('pt-BR')}
                      </div>
                      {editingEvent.validation_notes && (
                        <div className="text-xs text-muted-foreground mt-1 italic">
                          "{editingEvent.validation_notes}"
                        </div>
                      )}
                    </div>
                    {role.isAdmin && (
                      <button
                        onClick={handleUnvalidate}
                        className="text-xs px-2 py-1 rounded border border-border text-muted-foreground hover:text-destructive hover:border-destructive/40 shrink-0"
                        title="Reverter validação (admin)"
                      >
                        Reverter
                      </button>
                    )}
                  </div>
                ) : editingEvent.assigned_user_id && (
                  editingEvent.assigned_user_id === role.userId || role.isAdmin
                ) ? (
                  // Pode validar — mostra botao
                  <button
                    onClick={handleValidate}
                    className="w-full flex items-center justify-center gap-2 px-3 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white text-sm font-medium transition-colors"
                  >
                    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />
                    </svg>
                    Validar atendimento clinicamente
                  </button>
                ) : !editingEvent.assigned_user_id ? (
                  // Sem dentista atribuido — mostra aviso
                  <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-amber-500/10 border border-amber-500/20 text-xs text-amber-700">
                    <AlertTriangle size={14} />
                    Atribua um dentista responsavel pra poder validar este atendimento
                  </div>
                ) : (
                  // Tem dentista mas nao sou eu nem admin — info silenciosa
                  <div className="text-xs text-muted-foreground px-3 py-2 italic">
                    Apenas Dr(a). {editingEvent.assigned_user?.name || '—'} (responsavel) ou um administrador pode validar este atendimento.
                  </div>
                )}
              </div>
            )}

            <fieldset disabled={!canEdit} className="contents">
            <div className="p-5 pb-0 space-y-4">
              {/* Tipo */}
              <div>
                <label className="text-[11px] font-bold uppercase tracking-wider text-muted-foreground mb-1 block">Tipo</label>
                <div className="flex flex-wrap gap-1.5">
                  {EVENT_TYPES.map(t => (
                    <button
                      key={t.id}
                      onClick={() => setFormData(f => ({ ...f, type: t.id }))}
                      className={`inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs font-semibold border transition-all ${
                        formData.type === t.id ? 'ring-2 ring-offset-1 ring-offset-background opacity-100' : 'opacity-50'
                      }`}
                      style={{ borderColor: t.color + '40', color: t.color, background: t.color + '15', ['--tw-ring-color' as any]: t.color }}
                    >
                      {t.emoji} {t.label}
                    </button>
                  ))}
                </div>
              </div>

              {/* Titulo */}
              <div>
                <label className="text-[11px] font-bold uppercase tracking-wider text-muted-foreground mb-1 block">Titulo *</label>
                <input
                  type="text"
                  value={formData.title}
                  onChange={e => setFormData(f => ({ ...f, title: e.target.value }))}
                  placeholder={formData.type === 'CONSULTA' ? 'Avaliação / consulta com...' : formData.type === 'PROCEDIMENTO' ? 'Procedimento — ex: Instalação de implante' : formData.type === 'RETORNO' ? 'Retorno pós-tratamento' : formData.type === 'BLOQUEIO' ? 'Bloqueio — ex: Folga / Congresso' : 'Titulo do evento'}
                  className="w-full px-3 py-2 rounded-lg border border-border bg-background text-sm text-foreground placeholder:text-muted-foreground/50 focus:ring-2 focus:ring-primary/30 focus:border-primary/50 outline-none"
                />
              </div>

              {/* Data + Horarios */}
              <div className="grid grid-cols-3 gap-2">
                <div>
                  <label className="text-[11px] font-bold uppercase tracking-wider text-muted-foreground mb-1 block">Data *</label>
                  <input
                    type="date"
                    value={formData.date}
                    onChange={e => setFormData(f => ({ ...f, date: e.target.value }))}
                    className="w-full px-2 py-2 rounded-lg border border-border bg-background text-sm text-foreground outline-none focus:ring-2 focus:ring-primary/30"
                  />
                </div>
                <div>
                  <label className="text-[11px] font-bold uppercase tracking-wider text-muted-foreground mb-1 block">Inicio</label>
                  <input
                    type="time"
                    value={formData.startTime}
                    onChange={e => setFormData(f => ({ ...f, startTime: e.target.value }))}
                    className="w-full px-2 py-2 rounded-lg border border-border bg-background text-sm text-foreground outline-none focus:ring-2 focus:ring-primary/30"
                  />
                </div>
                <div>
                  <label className="text-[11px] font-bold uppercase tracking-wider text-muted-foreground mb-1 block">Fim</label>
                  <input
                    type="time"
                    value={formData.endTime}
                    onChange={e => setFormData(f => ({ ...f, endTime: e.target.value }))}
                    className="w-full px-2 py-2 rounded-lg border border-border bg-background text-sm text-foreground outline-none focus:ring-2 focus:ring-primary/30"
                  />
                </div>
              </div>

              {/* Paciente / Lead — so visivel quando criando evento (na edicao
                  o paciente ja aparece em destaque no header do modal). */}
              {!editingEvent && (
                <div>
                  <label className="text-[11px] font-bold uppercase tracking-wider text-muted-foreground mb-1 block">Paciente / Lead</label>
                  <ContactPicker
                    value={{ patient_id: formData.patient_id || null, lead_id: formData.lead_id || null }}
                    onChange={(s) => setFormData((f) => ({ ...f, patient_id: s.patient_id || '', lead_id: s.lead_id || '' }))}
                    leads={leads}
                    patients={patients}
                  />
                </div>
              )}

            </div>
            </fieldset>

            {/* Status — FORA do fieldset gateado por canEdit: mudar o andamento
                (Chegou / Em atendimento / Atendido / Desmarcou / Faltou) é liberado
                pra QUALQUER pessoa com acesso à agenda — recepção e qualquer dentista
                marcam o status de qualquer paciente. A estrutura (tipo, título, datas,
                paciente, dentista) continua restrita ao dono/admin pelo fieldset acima.
                Na edição troca na hora (PATCH + lista de espera quando Desmarcou); na
                criação define o status inicial do evento. */}
            <div className="px-5 pb-5 pt-4">
              <label className="text-[11px] font-bold uppercase tracking-wider text-muted-foreground mb-1 block">Status</label>
              <select
                value={editingEvent ? editingEvent.status : formData.status}
                onChange={e => editingEvent
                  ? handleStatusChange(e.target.value)
                  : setFormData(f => ({ ...f, status: e.target.value }))}
                className="w-full px-3 py-2 rounded-lg border bg-background text-sm font-bold outline-none focus:ring-2 focus:ring-primary/30"
                style={{
                  color: EVENT_STATUSES.find(s => s.id === (editingEvent ? editingEvent.status : formData.status))?.color,
                  borderColor: (EVENT_STATUSES.find(s => s.id === (editingEvent ? editingEvent.status : formData.status))?.color || '#cbd5e1') + '60',
                }}
              >
                {EVENT_STATUSES.map(s => (
                  <option key={s.id} value={s.id} className="text-foreground font-medium">{s.label}</option>
                ))}
              </select>
            </div>

            {/* Modal footer — sticky no rodapé do modal.
                Onda 5e v18 (Fase 25) — flex-wrap pra evitar botao "Salvar"
                ser CORTADO quando os botoes secundarios (Remover, Duplicar,
                .ics, Notificar) ocuparem toda a linha. shrink-0 garante que
                Cancelar+Salvar nunca encolhem. Ordem reversa em mobile pra
                "Salvar" aparecer primeiro (mais importante). */}
            <div className="sticky bottom-0 flex flex-wrap items-center justify-between gap-2 px-5 py-3 border-t border-border bg-card rounded-b-2xl">
              <div className="flex items-center gap-1 flex-wrap order-2 sm:order-1">
                {editingEvent && canEdit && (
                  <>
                    {/* Remover — exclusivo do ADMIN. Backend tambem valida. */}
                    {role.canDeleteAgendaEvent && (
                      <button
                        onClick={() => handleDelete()}
                        className="px-2.5 py-1.5 text-xs font-semibold text-destructive hover:bg-destructive/10 rounded-lg transition-colors"
                      >
                        Remover
                      </button>
                    )}
                    {/* Duplicar — usa o mesmo POST que Novo Evento, entao
                        respeita a permissao de criar eventos. */}
                    {role.canCreateAgendaEvent && (
                      <button
                        onClick={handleDuplicate}
                        className="px-2.5 py-1.5 text-xs font-semibold text-muted-foreground hover:bg-accent rounded-lg transition-colors inline-flex items-center gap-1"
                        title="Duplicar evento"
                      >
                        <Copy size={12} /> <span className="hidden md:inline">Duplicar</span>
                      </button>
                    )}
                  </>
                )}
                {editingEvent && (
                  <button
                    onClick={() => handleExportICS(editingEvent.id)}
                    className="px-2.5 py-1.5 text-xs font-semibold text-muted-foreground hover:bg-accent rounded-lg transition-colors inline-flex items-center gap-1"
                    title="Exportar .ics"
                  >
                    <Download size={12} /> <span className="hidden md:inline">.ics</span>
                  </button>
                )}
                {editingEvent && ['CONSULTA', 'PROCEDIMENTO', 'RETORNO'].includes(editingEvent.type) && (
                  <button
                    onClick={handleNotify}
                    disabled={sendingNotify}
                    className="px-2.5 py-1.5 text-xs font-semibold text-blue-600 hover:bg-blue-50 dark:hover:bg-blue-950/30 rounded-lg transition-colors inline-flex items-center gap-1 disabled:opacity-40 disabled:pointer-events-none"
                    title="Reenviar notificação WhatsApp ao paciente"
                  >
                    <Bell size={12} /> <span className="hidden md:inline">{sendingNotify ? 'Enviando…' : 'Notificar'}</span>
                  </button>
                )}
                {/* Avaliação — abre a ficha do paciente na aba Odontograma (atalho clínico).
                    O status agora é controlado pelo dropdown de Status (Onda 17.61). */}
                {editingEvent && editingEvent.patient_id
                  && ['CONSULTA', 'PROCEDIMENTO', 'RETORNO'].includes(editingEvent.type) && (
                  <button
                    onClick={() => { setShowModal(false); router.push(`/atendimento/pacientes/${editingEvent.patient_id}?tab=odontogram`); }}
                    className="px-2.5 py-1.5 text-xs font-semibold text-emerald-600 hover:bg-emerald-50 dark:hover:bg-emerald-950/30 rounded-lg transition-colors inline-flex items-center gap-1"
                    title="Avaliação — abre odontograma do paciente"
                  >
                    <Stethoscope size={12} /> <span className="hidden md:inline">Avaliação</span>
                  </button>
                )}
              </div>
              <div className="flex gap-2 shrink-0 order-1 sm:order-2 ml-auto">
                <button
                  onClick={() => setShowModal(false)}
                  className="px-4 py-2 text-sm font-medium text-muted-foreground hover:bg-accent rounded-lg transition-colors"
                >
                  {canEdit ? 'Cancelar' : 'Fechar'}
                </button>
                {canEdit && (
                  <button
                    onClick={() => handleSave()}
                    disabled={!formData.title.trim() || !formData.date || savingEvent}
                    className="px-5 py-2 text-sm font-bold bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 transition-colors shadow-md disabled:opacity-40 disabled:pointer-events-none inline-flex items-center gap-2"
                  >
                    {savingEvent && <Loader2 size={14} className="animate-spin" />}
                    {savingEvent
                      ? 'Salvando...'
                      : editingEvent
                        ? 'Salvar alterações'
                        : 'Criar evento'}
                  </button>
                )}
              </div>
            </div>
              </>); // end canEdit IIFE
            })()}
          </div>
        </div>
      )}

      </div>{/* fim flex-1 conteúdo calendário */}

      {/* Onda 5e v9 (Fase 25) — Modal de bloqueio de agenda. Renderizado fora
          do flex-1 pra ficar acima de tudo (z-100). Refetch dos eventos ao
          fechar pra agenda refletir mudancas (eventos cancelados em bloqueios). */}
      <ScheduleBlockModal
        open={showBlockModal}
        onClose={() => {
          setShowBlockModal(false);
          // Refetch da agenda — bloqueios novos podem afetar visual no futuro
          if (rangeRef.current) fetchEvents(rangeRef.current.start, rangeRef.current.end);
        }}
        users={users}
        currentUserId={currentUserId}
        isAdmin={role.isAdmin}
      />
    </div>
  );
}

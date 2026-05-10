/**
 * View "Lista" da Agenda — alternativa ao grid horário (Semana / Por profissional).
 *
 * Mostra os eventos agrupados por dia em sequência cronológica, sem grid de
 * horas vazias. Útil pra recepção que quer responder "quem tem horário
 * marcado hoje?" sem precisar ler o grid completo.
 *
 * Comportamento:
 * - Hoje em destaque (header amarelo + scroll automático no topo)
 * - Próximos 7 dias agrupados por data (com nome do dia em pt-BR)
 * - Cada evento mostra: hora, ícone status, nome, dentista, tipo
 * - Click no evento abre o modal de edição (mesma UX da view Semana)
 * - Respeita TODOS os filtros (tipos, dentista, mostrar cancelados)
 *
 * Não usa schedule-x — render simples próprio com Tailwind. Mais rápido e
 * mais legível que o grid pra esse use case específico.
 */

'use client';

import { useMemo } from 'react';
import { useRouter } from 'next/navigation';
import { Clock, MapPin, User, Printer, Stethoscope } from 'lucide-react';

interface CalendarEventLike {
  id: string;
  title: string;
  start_at: string;
  end_at?: string | null;
  type: string;
  status: string;
  assigned_user_id?: string | null;
  assigned_user?: { id: string; name: string } | null;
  location?: string | null;
  patient_id?: string | null;
}

interface UserLike {
  id: string;
  name: string;
}

interface Props {
  events: CalendarEventLike[];
  users: UserLike[];
  filterTypes: string[];
  filterUserId: string;
  showCancelled: boolean;
  showAllUsers: boolean;
  currentUserId: string;
  onEventClick: (eventId: string) => void;
}

const STATUS_CONFIG: Record<string, { icon: string; label: string; color: string }> = {
  AGENDADO:    { icon: '⏰', label: 'Aguardando confirmação', color: 'text-pink-600' },
  CONFIRMADO:  { icon: '✅', label: 'Confirmado',             color: 'text-emerald-600' },
  COMPARECEU:  { icon: '🩺', label: 'Compareceu',             color: 'text-sky-600' },
  NO_SHOW:     { icon: '🚫', label: 'Não compareceu',         color: 'text-rose-600' },
  ADIADO:      { icon: '⏸️', label: 'Adiado',                 color: 'text-amber-600' },
  CANCELADO:   { icon: '✖️', label: 'Cancelado',              color: 'text-rose-500' },
};

const TYPE_LABEL: Record<string, string> = {
  CONSULTA: 'Consulta',
  PROCEDIMENTO: 'Procedimento',
  RETORNO: 'Retorno',
  BLOQUEIO: 'Bloqueio',
  TAREFA: 'Tarefa',
  OUTRO: 'Outro',
};

const DAYS_PT = ['Domingo', 'Segunda-feira', 'Terça-feira', 'Quarta-feira', 'Quinta-feira', 'Sexta-feira', 'Sábado'];
const MONTHS_PT = ['Jan', 'Fev', 'Mar', 'Abr', 'Mai', 'Jun', 'Jul', 'Ago', 'Set', 'Out', 'Nov', 'Dez'];

/** Formata "Segunda-feira, 28 de Abr" */
function formatDateHeader(d: Date): string {
  const dayName = DAYS_PT[d.getUTCDay()];
  const day = d.getUTCDate();
  const month = MONTHS_PT[d.getUTCMonth()];
  return `${dayName}, ${day} de ${month}`;
}

/** Retorna "HH:MM" da string ISO (mantém UTC naive — mesmo padrão do app) */
function formatTime(iso: string): string {
  const d = new Date(iso);
  const h = String(d.getUTCHours()).padStart(2, '0');
  const m = String(d.getUTCMinutes()).padStart(2, '0');
  return `${h}:${m}`;
}

/** Retorna "YYYY-MM-DD" da string ISO (UTC) — usado pra agrupar */
function getDateKey(iso: string): string {
  const d = new Date(iso);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function AgendaListView({
  events,
  users,
  filterTypes,
  filterUserId,
  showCancelled,
  showAllUsers,
  currentUserId,
  onEventClick,
}: Props) {
  const router = useRouter();

  // Agrupar eventos por dia (próximos 14 dias a partir de hoje).
  const groupedByDay = useMemo(() => {
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    const cutoff = new Date(today.getTime() + 14 * 24 * 60 * 60 * 1000);

    // Filtra eventos:
    //  - dentro da janela hoje..hoje+14d
    //  - tipo selecionado
    //  - status (esconde cancelados se showCancelled = false)
    //  - dentista (se filtrado ou se showAllUsers = false)
    const filtered = events.filter((e) => {
      const start = new Date(e.start_at);
      if (start < today || start >= cutoff) return false;
      if (!filterTypes.includes(e.type)) return false;
      if (!showCancelled && e.status === 'CANCELADO') return false;
      if (filterUserId && e.assigned_user_id !== filterUserId) return false;
      if (!showAllUsers && !filterUserId && currentUserId && e.assigned_user_id !== currentUserId) return false;
      return true;
    });

    // Ordena por start_at ASC e agrupa por dateKey (YYYY-MM-DD)
    filtered.sort((a, b) => new Date(a.start_at).getTime() - new Date(b.start_at).getTime());
    const groups: Record<string, CalendarEventLike[]> = {};
    for (const ev of filtered) {
      const key = getDateKey(ev.start_at);
      if (!groups[key]) groups[key] = [];
      groups[key].push(ev);
    }
    return groups;
  }, [events, filterTypes, filterUserId, showCancelled, showAllUsers, currentUserId]);

  const dateKeys = Object.keys(groupedByDay).sort();
  const todayKey = (() => {
    const t = new Date();
    return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`;
  })();

  const usersById = useMemo(() => {
    const m = new Map<string, string>();
    for (const u of users) m.set(u.id, u.name);
    return m;
  }, [users]);

  if (dateKeys.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-center p-8 text-muted-foreground">
        <Clock size={48} className="mb-3 opacity-40" />
        <p className="text-sm font-medium">Nenhum evento nos próximos 14 dias</p>
        <p className="text-xs mt-1 opacity-70">Use os filtros do sidebar pra ajustar a visualização.</p>
      </div>
    );
  }

  /**
   * Print da view atual. CSS @media print no agenda-theme.css cuida do
   * layout (esconde sidebar/header/botões, ajusta fonte, etc). Operador
   * pode salvar como PDF via "Imprimir → Salvar como PDF" do navegador.
   */
  const handlePrint = () => {
    if (typeof window !== 'undefined') window.print();
  };

  return (
    <div className="agenda-list-view flex flex-col h-full overflow-y-auto">
      {/* Header com botão Imprimir (esconde no print via CSS) */}
      <div className="agenda-list-header sticky top-0 z-20 px-4 py-2 bg-card/95 backdrop-blur-sm border-b border-border flex items-center justify-between">
        <h2 className="text-sm font-bold text-foreground">
          Agenda — Próximos 14 dias
        </h2>
        <button
          onClick={handlePrint}
          className="px-3 py-1.5 text-xs font-semibold text-primary border border-primary/30 rounded-lg hover:bg-primary/10 transition-colors flex items-center gap-1.5"
          title="Imprimir agenda (ou salvar como PDF via diálogo do navegador)"
        >
          <Printer size={13} />
          Imprimir / PDF
        </button>
      </div>

      {/* Cabeçalho de impressão (só aparece quando imprimindo) */}
      <div className="agenda-print-header hidden">
        <h1 className="text-2xl font-bold">Instituto Odonto Passos — Agenda</h1>
        <p className="text-sm text-gray-600">
          Próximos 14 dias — Gerado em {new Date().toLocaleString('pt-BR')}
        </p>
      </div>

      {dateKeys.map((dateKey) => {
        const eventsOfDay = groupedByDay[dateKey];
        const isToday = dateKey === todayKey;
        // Constrói Date a partir do dateKey pra exibir nome do dia
        const [y, m, d] = dateKey.split('-').map(Number);
        const dayDate = new Date(Date.UTC(y, m - 1, d));

        return (
          <div key={dateKey} className="border-b border-border last:border-b-0">
            {/* Header do dia */}
            <div
              className={`sticky top-0 z-10 px-4 py-2 backdrop-blur-sm ${
                isToday
                  ? 'bg-primary/15 border-b-2 border-primary/30'
                  : 'bg-card/80 border-b border-border'
              }`}
            >
              <h3 className={`text-sm font-bold ${isToday ? 'text-primary' : 'text-foreground'}`}>
                {isToday && '⭐ Hoje — '}{formatDateHeader(dayDate)}
              </h3>
              <p className="text-[11px] text-muted-foreground">
                {eventsOfDay.length} evento{eventsOfDay.length !== 1 ? 's' : ''}
              </p>
            </div>

            {/* Lista de eventos do dia */}
            <div className="divide-y divide-border/50">
              {eventsOfDay.map((ev) => {
                const status = STATUS_CONFIG[ev.status] ?? { icon: '', label: ev.status, color: 'text-muted-foreground' };
                const dentistName = ev.assigned_user?.name || (ev.assigned_user_id ? usersById.get(ev.assigned_user_id) : null) || '—';
                const typeLabel = TYPE_LABEL[ev.type] ?? ev.type;
                const isCancelled = ev.status === 'CANCELADO';

                // Atender so faz sentido em evento clinico com paciente vinculado.
                // Bloqueio/tarefa nao tem ficha pra abrir.
                const canAttend = !!ev.patient_id && !isCancelled
                  && ['CONSULTA', 'PROCEDIMENTO', 'RETORNO'].includes(ev.type);

                return (
                  <div
                    key={ev.id}
                    role="button"
                    tabIndex={0}
                    onClick={() => onEventClick(ev.id)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        onEventClick(ev.id);
                      }
                    }}
                    className={`w-full text-left px-4 py-3 hover:bg-accent/40 transition-colors flex items-start gap-4 group cursor-pointer ${
                      isCancelled ? 'opacity-60' : ''
                    }`}
                  >
                    {/* Coluna 1: hora + status icon */}
                    <div className="flex flex-col items-center min-w-[60px] shrink-0 pt-1">
                      <span className="text-base font-bold text-foreground tabular-nums">
                        {formatTime(ev.start_at)}
                      </span>
                      {ev.end_at && (
                        <span className="text-[10px] text-muted-foreground tabular-nums">
                          {formatTime(ev.end_at)}
                        </span>
                      )}
                    </div>

                    {/* Coluna 2: detalhes */}
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-0.5">
                        <span className="text-base">{status.icon}</span>
                        <span className={`text-[10px] font-bold uppercase tracking-wider ${status.color}`}>
                          {status.label}
                        </span>
                        <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                          • {typeLabel}
                        </span>
                      </div>
                      <p className={`text-sm font-medium text-foreground truncate ${isCancelled ? 'line-through' : ''}`}>
                        {ev.title}
                      </p>
                      <div className="flex items-center gap-3 mt-1 text-xs text-muted-foreground">
                        <span className="flex items-center gap-1">
                          <User size={11} />
                          {dentistName}
                        </span>
                        {ev.location && (
                          <span className="flex items-center gap-1 truncate">
                            <MapPin size={11} />
                            {ev.location}
                          </span>
                        )}
                      </div>
                    </div>

                    {/* Coluna 3: botao Atender — abre ficha do paciente
                        direto na aba Odontograma (mesmo destino do Kanban
                        antigo, commit 0b90a40c). stopPropagation pra nao
                        disparar o onEventClick do wrapper. */}
                    {canAttend && (
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          router.push(`/atendimento/pacientes/${ev.patient_id}?tab=odontogram`);
                        }}
                        className="shrink-0 self-center px-3 py-1.5 text-xs font-bold text-emerald-700 bg-emerald-50 hover:bg-emerald-100 dark:bg-emerald-950/30 dark:hover:bg-emerald-950/60 dark:text-emerald-400 border border-emerald-200 dark:border-emerald-800 rounded-lg transition-colors inline-flex items-center gap-1.5 opacity-0 group-hover:opacity-100 focus:opacity-100"
                        title="Avaliação — abre odontograma do paciente"
                      >
                        <Stethoscope size={12} />
                        Avaliação
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}

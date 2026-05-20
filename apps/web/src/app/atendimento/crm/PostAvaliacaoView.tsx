'use client';

/**
 * Pos-Avaliacao View — Onda 5e v31 (Fase 25).
 *
 * Sub-categoria do CRM (acessada pelo terceiro toggle no toolbar) que
 * mostra leads que JA realizaram a consulta de avaliacao clinica
 * (CONSULTA / PROCEDIMENTO / RETORNO concluido ou validado pelo dentista).
 *
 * Diferente do Kanban (funil pre-consulta), esse e um "pos-funil" focado
 * em decisao: paciente veio, foi avaliado, e agora?
 *
 * 4 buckets visuais (Onda 14.47 — alinhados com ClosingKanban):
 *   - 🟡 Avaliação Concluída  (sem quote OU quote em DRAFT — paciente
 *                              ainda nao recebeu a proposta)
 *   - 🟠 Orçamento Enviado    (quote SENT — paciente recebeu, aguarda aceite)
 *   - 🟢 Em tratamento        (Patient + tem evento futuro AGENDADO/CONFIRMADO)
 *   - ❌ Perdido              (stage com is_lost = true)
 *
 * Cada card tem acoes: Abrir chat, Ver ficha (odontograma).
 *
 * Endpoint: GET /leads/post-avaliacao?days=60
 */

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  Stethoscope, MessageSquare, ExternalLink, Clock,
  AlertCircle, FileText, Calendar, CheckCircle2, XCircle, Loader2, RefreshCw,
  HeartPulse,
} from 'lucide-react';
import api from '@/lib/api';

interface PostAvaliacaoLead {
  id: string;
  name: string | null;
  phone: string | null;
  current_stage: { id: string; slug: string; name: string; color: string | null; emoji: string | null; is_won?: boolean; is_lost?: boolean } | null;
  conversations: Array<{
    id: string;
    specialty: string | null;
    last_message_at: string | null;
    assigned_dentist: { id: string; name: string } | null;
  }>;
  calendar_events: Array<{
    id: string;
    type: string;
    title: string;
    status: string;
    start_at: string;
    validated_at: string | null;
    assigned_user: { id: string; name: string } | null;
  }>;
  post_avaliacao: {
    bucket: 'aguardando' | 'com-orcamento' | 'em-tratamento' | 'perdido';
    quote: { id: string; status: string; total_value: string | number } | null;
    upcoming_event: { id: string; start_at: string; type: string } | null;
    patient: { id: string; name: string | null } | null;
  };
}

interface Props {
  onOpenDetail: (lead: any) => void;
  onOpenChat: (lead: any) => void;
}

const BUCKETS = [
  {
    id: 'aguardando' as const,
    // Onda 14.47 — labels alinhados com ClosingKanban: paciente ainda nao
    // recebeu o orcamento (sem quote OU quote em DRAFT/rascunho interno).
    label: 'Avaliação Concluída',
    description: 'Paciente ainda não recebeu o orçamento (sem proposta ou rascunho interno).',
    icon: AlertCircle,
    color: 'text-amber-600',
    bg: 'bg-amber-50 dark:bg-amber-950/20',
    border: 'border-amber-200 dark:border-amber-900/50',
    accent: 'bg-amber-500',
  },
  {
    id: 'com-orcamento' as const,
    // Onda 14.47 — Quote SENT: paciente recebeu a proposta (via WhatsApp /
    // portal). Aguarda aceite. DRAFT NAO entra aqui — esse fica em
    // "Avaliação Concluída" ate o operador clicar "Enviar pro paciente".
    label: 'Orçamento Enviado',
    description: 'Paciente já recebeu a proposta. Aguarda aceite.',
    icon: FileText,
    color: 'text-orange-600',
    bg: 'bg-orange-50 dark:bg-orange-950/20',
    border: 'border-orange-200 dark:border-orange-900/50',
    accent: 'bg-orange-500',
  },
  {
    id: 'em-tratamento' as const,
    label: 'Em tratamento',
    description: 'Paciente confirmado, com próximo procedimento agendado.',
    icon: CheckCircle2,
    color: 'text-emerald-600',
    bg: 'bg-emerald-50 dark:bg-emerald-950/20',
    border: 'border-emerald-200 dark:border-emerald-900/50',
    accent: 'bg-emerald-500',
  },
  {
    id: 'perdido' as const,
    label: 'Perdido',
    description: 'Lead foi marcado como perdido após a avaliação.',
    icon: XCircle,
    color: 'text-rose-600',
    bg: 'bg-rose-50 dark:bg-rose-950/20',
    border: 'border-rose-200 dark:border-rose-900/50',
    accent: 'bg-rose-500',
  },
];

function formatBR(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString('pt-BR', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' });
}

function timeAgo(iso: string | null): string {
  if (!iso) return '—';
  const ms = Date.now() - new Date(iso).getTime();
  const dias = Math.floor(ms / 86400000);
  if (dias === 0) return 'hoje';
  if (dias === 1) return 'há 1 dia';
  if (dias < 30) return `há ${dias} dias`;
  const meses = Math.floor(dias / 30);
  return `há ${meses} ${meses === 1 ? 'mês' : 'meses'}`;
}

export function PostAvaliacaoView({ onOpenDetail, onOpenChat }: Props) {
  const router = useRouter();
  const [leads, setLeads] = useState<PostAvaliacaoLead[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [days, setDays] = useState<number>(60);

  const fetchData = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.get('/leads/post-avaliacao', { params: { days } });
      setLeads(Array.isArray(res.data) ? res.data : []);
    } catch (e: any) {
      setError(e?.response?.data?.message || 'Erro ao carregar leads pós-avaliação');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchData();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [days]);

  const grouped = useMemo(() => {
    const g: Record<string, PostAvaliacaoLead[]> = { aguardando: [], 'com-orcamento': [], 'em-tratamento': [], perdido: [] };
    for (const l of leads) {
      const b = l.post_avaliacao?.bucket || 'aguardando';
      g[b]?.push(l);
    }
    return g;
  }, [leads]);

  const openOdontograma = (l: PostAvaliacaoLead) => {
    const patientId = l.post_avaliacao?.patient?.id;
    if (patientId) {
      router.push(`/atendimento/pacientes/${patientId}?tab=odontogram`);
    } else {
      // Sem paciente vinculado — abre detalhe do lead pra criar
      onOpenDetail(l);
    }
  };

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center py-16 text-muted-foreground">
        <Loader2 size={20} className="animate-spin mr-2" />
        Carregando pacientes pós-avaliação…
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center gap-3 py-16">
        <p className="text-muted-foreground text-sm">{error}</p>
        <button
          onClick={fetchData}
          className="px-4 py-2 rounded-xl bg-primary text-primary-foreground text-[13px] font-semibold hover:bg-primary/90 transition-colors"
        >
          Tentar novamente
        </button>
      </div>
    );
  }

  const total = leads.length;

  return (
    <div className="flex-1 overflow-y-auto p-4 space-y-4">
      {/* Header com filtro de periodo */}
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-2">
          <Stethoscope size={18} className="text-emerald-600" />
          <h2 className="text-base font-bold text-foreground">Pós-Avaliação</h2>
          <span className="text-xs text-muted-foreground">
            ({total} {total === 1 ? 'paciente' : 'pacientes'} nos últimos {days} dias)
          </span>
        </div>
        <div className="flex items-center gap-2">
          <select
            value={days}
            onChange={(e) => setDays(parseInt(e.target.value, 10) || 60)}
            className="px-3 py-1.5 rounded-lg border border-border bg-background text-xs text-foreground outline-none focus:ring-2 focus:ring-emerald-500/30"
          >
            <option value={7}>Últimos 7 dias</option>
            <option value={30}>Últimos 30 dias</option>
            <option value={60}>Últimos 60 dias</option>
            <option value={90}>Últimos 90 dias</option>
            <option value={180}>Últimos 180 dias</option>
          </select>
          <button
            onClick={fetchData}
            className="p-1.5 rounded-lg text-muted-foreground hover:text-foreground hover:bg-accent transition-all"
            title="Atualizar"
          >
            <RefreshCw size={14} />
          </button>
        </div>
      </div>

      {total === 0 && (
        <div className="text-center py-12 text-muted-foreground text-sm">
          <Stethoscope size={32} className="mx-auto mb-3 opacity-40" />
          Nenhum paciente realizou avaliação nos últimos {days} dias.
        </div>
      )}

      {/* Buckets */}
      {BUCKETS.map((bucket) => {
        const items = grouped[bucket.id] || [];
        if (items.length === 0) return null;
        const Icon = bucket.icon;

        return (
          <section key={bucket.id} className={`rounded-xl border ${bucket.border} ${bucket.bg} overflow-hidden`}>
            <header className="flex items-center gap-2 px-4 py-2.5 border-b border-border/50 bg-card/50">
              <Icon size={16} className={bucket.color} />
              <h3 className={`text-sm font-bold ${bucket.color}`}>{bucket.label}</h3>
              <span className="text-xs font-semibold px-2 py-0.5 rounded-full bg-card border border-border text-foreground">
                {items.length}
              </span>
              <span className="text-[11px] text-muted-foreground hidden md:inline">— {bucket.description}</span>
            </header>

            <div className="divide-y divide-border/30">
              {items.map((lead) => {
                const ev = lead.calendar_events?.[0];
                const dentist = ev?.assigned_user?.name || lead.conversations?.[0]?.assigned_dentist?.name || null;
                const specialty = lead.conversations?.[0]?.specialty;
                const conv = lead.conversations?.[0];
                const upcoming = lead.post_avaliacao?.upcoming_event;
                const quote = lead.post_avaliacao?.quote;

                return (
                  <div
                    key={lead.id}
                    className="flex items-start gap-4 px-4 py-3 hover:bg-card/60 transition-colors"
                  >
                    {/* Acento colorido por bucket */}
                    <div className={`w-1 h-12 rounded-full ${bucket.accent} shrink-0 mt-0.5`} />

                    {/* Bloco principal */}
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap mb-0.5">
                        <span className="text-sm font-bold text-foreground truncate">
                          {lead.name || lead.phone || 'Sem nome'}
                        </span>
                        {/* Onda 5e v32: badge "Paciente da clinica" — sinaliza
                            que o lead JA virou Patient (auto-convertido pelo
                            backend ao validar/concluir consulta). Aparece
                            sempre que post_avaliacao.patient existe, em
                            qualquer bucket. */}
                        {lead.post_avaliacao?.patient && (
                          <span
                            className="text-[10px] font-bold uppercase tracking-wider text-emerald-700 dark:text-emerald-400 px-1.5 py-0.5 rounded bg-emerald-50 dark:bg-emerald-950/40 border border-emerald-200 dark:border-emerald-900 inline-flex items-center gap-1"
                            title="Cadastrado como paciente da clínica"
                          >
                            <HeartPulse size={10} />
                            Paciente
                          </span>
                        )}
                        {specialty && (
                          <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground px-1.5 py-0.5 rounded bg-muted">
                            {specialty}
                          </span>
                        )}
                        {lead.current_stage && (
                          <span
                            className="text-[10px] font-semibold px-1.5 py-0.5 rounded"
                            style={{
                              color: lead.current_stage.color || '#6b7280',
                              background: (lead.current_stage.color || '#6b7280') + '15',
                            }}
                          >
                            {lead.current_stage.emoji} {lead.current_stage.name}
                          </span>
                        )}
                      </div>

                      <div className="flex items-center gap-3 text-[11px] text-muted-foreground flex-wrap">
                        {ev && (
                          <span className="inline-flex items-center gap-1">
                            <Calendar size={11} />
                            Avaliação em {formatBR(ev.start_at)}
                            {ev.validated_at && ' ✓'}
                          </span>
                        )}
                        {dentist && (
                          <span className="inline-flex items-center gap-1">
                            <Stethoscope size={11} />
                            {dentist}
                          </span>
                        )}
                        {conv?.last_message_at && (
                          <span className="inline-flex items-center gap-1">
                            <Clock size={11} />
                            Última msg {timeAgo(conv.last_message_at)}
                          </span>
                        )}
                        {upcoming && (
                          <span className="inline-flex items-center gap-1 text-emerald-600 font-semibold">
                            <Calendar size={11} />
                            Próximo: {formatBR(upcoming.start_at)} ({upcoming.type.toLowerCase()})
                          </span>
                        )}
                        {quote && (
                          <span className="inline-flex items-center gap-1 text-orange-600 font-semibold">
                            <FileText size={11} />
                            Orçamento {quote.status} R$ {Number(quote.total_value).toFixed(2)}
                          </span>
                        )}
                      </div>
                    </div>

                    {/* Acoes */}
                    <div className="flex items-center gap-1 shrink-0">
                      {conv?.id && (
                        <button
                          onClick={() => onOpenChat(lead as any)}
                          className="p-1.5 rounded-lg text-muted-foreground hover:text-blue-600 hover:bg-blue-50 dark:hover:bg-blue-950/30 transition-colors"
                          title="Abrir chat"
                        >
                          <MessageSquare size={14} />
                        </button>
                      )}
                      <button
                        onClick={() => openOdontograma(lead)}
                        className="px-2.5 py-1.5 text-xs font-semibold text-emerald-700 hover:bg-emerald-100 dark:hover:bg-emerald-950/40 dark:text-emerald-400 border border-emerald-200 dark:border-emerald-900 rounded-lg transition-colors inline-flex items-center gap-1"
                        title={lead.post_avaliacao?.patient ? 'Abrir odontograma' : 'Ver ficha do lead'}
                      >
                        <ExternalLink size={12} />
                        {lead.post_avaliacao?.patient ? 'Odontograma' : 'Ver lead'}
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          </section>
        );
      })}
    </div>
  );
}

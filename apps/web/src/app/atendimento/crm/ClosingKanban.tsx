'use client';

/**
 * CRM de Fechamento — Kanban dentro da pagina /atendimento/crm
 * (Onda 5e v33, Fase 25).
 *
 * 4o modo de visualizacao do CRM (botao com icone DollarSign no toolbar,
 * apos Kanban / Lista / Pos-Avaliacao).
 *
 * Diferente do Kanban principal (funil PRE-consulta de captacao),
 * este e o funil POS-consulta — onde caem automaticamente os leads
 * que JA fizeram a avaliacao clinica e estao no processo de decisao /
 * fechamento de tratamento.
 *
 * Colunas (ordem visual):
 *   1. 🟡 Avaliacao Concluida    — bucket 'aguardando'
 *      Lead foi avaliado, sem orcamento e sem proximo evento.
 *      Acao tipica: dentista/secretaria criar orcamento.
 *
 *   2. 🟠 Orcamento Enviado      — bucket 'com-orcamento'
 *      Quote em DRAFT ou SENT. Aguardando aceite.
 *
 *   3. 🟢 Em Tratamento          — bucket 'em-tratamento'
 *      Patient + tem evento futuro AGENDADO/CONFIRMADO.
 *      Lead virou paciente da clinica oficialmente.
 *
 *   4. ❌ Perdido                 — bucket 'perdido'
 *      Stage com is_lost=true.
 *
 * Auto-popula: assim que dentista valida atendimento OU evento clinico
 * vira CONCLUIDO, o lead aparece na coluna 1 automaticamente. Hook
 * implementado em calendar.service.ts (Onda 5e v32).
 *
 * Endpoint: GET /leads/post-avaliacao?days=N (mesmo do PostAvaliacaoView)
 */

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  DollarSign, MessageSquare, ExternalLink, AlertCircle, FileText,
  Calendar, CheckCircle2, XCircle, Loader2, RefreshCw, HeartPulse,
  Stethoscope,
} from 'lucide-react';
import api from '@/lib/api';
import { PatientAvatar } from '@/components/PatientAvatar';

interface ClosingLead {
  id: string;
  name: string | null;
  phone: string | null;
  profile_picture_url?: string | null;
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

const COLUMNS = [
  {
    id: 'aguardando' as const,
    label: 'Avaliação Concluída',
    // Onda 14.48 — Trajetoria validada: dentista validou o atendimento +
    // operador ja gerou o orcamento em DRAFT. Lead segue daqui pra
    // "Orcamento Enviado" quando alguem clicar "Enviar pro paciente".
    sub: 'Validado pelo dentista · orçamento em rascunho',
    icon: AlertCircle,
    color: 'text-amber-700 dark:text-amber-400',
    headerBg: 'bg-amber-100/70 dark:bg-amber-950/40',
    border: 'border-amber-300 dark:border-amber-800',
  },
  {
    id: 'com-orcamento' as const,
    label: 'Orçamento Enviado',
    sub: 'Aguardando aceite',
    icon: FileText,
    color: 'text-orange-700 dark:text-orange-400',
    headerBg: 'bg-orange-100/70 dark:bg-orange-950/40',
    border: 'border-orange-300 dark:border-orange-800',
  },
  {
    id: 'em-tratamento' as const,
    label: 'Em Tratamento',
    sub: 'Paciente da clínica',
    icon: CheckCircle2,
    color: 'text-emerald-700 dark:text-emerald-400',
    headerBg: 'bg-emerald-100/70 dark:bg-emerald-950/40',
    border: 'border-emerald-300 dark:border-emerald-800',
  },
  {
    id: 'perdido' as const,
    label: 'Perdido',
    sub: 'Não fechou',
    icon: XCircle,
    color: 'text-rose-700 dark:text-rose-400',
    headerBg: 'bg-rose-100/70 dark:bg-rose-950/40',
    border: 'border-rose-300 dark:border-rose-800',
  },
];

function formatBR(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString('pt-BR', { day: '2-digit', month: 'short', timeZone: 'UTC' });
}

function timeAgo(iso: string | null): string {
  if (!iso) return '—';
  const ms = Date.now() - new Date(iso).getTime();
  const dias = Math.floor(ms / 86400000);
  if (dias === 0) return 'hoje';
  if (dias === 1) return '1d';
  if (dias < 30) return `${dias}d`;
  const meses = Math.floor(dias / 30);
  return `${meses}m`;
}

export function ClosingKanban({ onOpenDetail, onOpenChat }: Props) {
  const router = useRouter();
  const [leads, setLeads] = useState<ClosingLead[]>([]);
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
      setError(e?.response?.data?.message || 'Erro ao carregar funil de fechamento');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchData();
    // Auto-refresh a cada 60s pra capturar leads recem-validados
    const interval = setInterval(fetchData, 60000);
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [days]);

  const grouped = useMemo(() => {
    const g: Record<string, ClosingLead[]> = { aguardando: [], 'com-orcamento': [], 'em-tratamento': [], perdido: [] };
    for (const l of leads) {
      const b = l.post_avaliacao?.bucket || 'aguardando';
      g[b]?.push(l);
    }
    return g;
  }, [leads]);

  const totalAtivos = grouped.aguardando.length + grouped['com-orcamento'].length + grouped['em-tratamento'].length;

  // Pipeline value somatorio dos orcamentos abertos
  const pipelineValue = useMemo(() => {
    return grouped['com-orcamento'].reduce((acc, l) => {
      const v = Number(l.post_avaliacao?.quote?.total_value || 0);
      return acc + (Number.isFinite(v) ? v : 0);
    }, 0);
  }, [grouped]);

  const openCard = (lead: ClosingLead) => {
    const patientId = lead.post_avaliacao?.patient?.id;
    if (patientId) {
      router.push(`/atendimento/pacientes/${patientId}?tab=odontogram`);
    } else {
      onOpenDetail(lead);
    }
  };

  if (loading && leads.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center py-16 text-muted-foreground">
        <Loader2 size={20} className="animate-spin mr-2" />
        Carregando funil de fechamento…
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

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      {/* Header com KPIs e filtros */}
      <div className="flex items-center justify-between gap-3 flex-wrap px-4 py-3 border-b border-border">
        <div className="flex items-center gap-3">
          <DollarSign size={18} className="text-emerald-600" />
          <div>
            <h2 className="text-base font-bold text-foreground">CRC de Fechamento</h2>
            <p className="text-[11px] text-muted-foreground">
              Pacientes que fizeram avaliação — auto-populado quando consulta vira CONCLUÍDA
            </p>
          </div>
        </div>

        <div className="flex items-center gap-3 flex-wrap">
          <div className="flex items-center gap-2 text-xs">
            <span className="text-muted-foreground">Pipeline:</span>
            <span className="font-bold text-emerald-700 tabular-nums">
              R$ {pipelineValue.toLocaleString('pt-BR', { minimumFractionDigits: 2 })}
            </span>
          </div>
          <div className="flex items-center gap-2 text-xs">
            <span className="text-muted-foreground">Em jogo:</span>
            <span className="font-bold text-foreground">{totalAtivos}</span>
          </div>
          <select
            value={days}
            onChange={(e) => setDays(parseInt(e.target.value, 10) || 60)}
            className="px-3 py-1.5 rounded-lg border border-border bg-background text-xs text-foreground outline-none focus:ring-2 focus:ring-emerald-500/30"
          >
            <option value={7}>7 dias</option>
            <option value={30}>30 dias</option>
            <option value={60}>60 dias</option>
            <option value={90}>90 dias</option>
            <option value={180}>180 dias</option>
          </select>
          <button
            onClick={fetchData}
            disabled={loading}
            className="p-1.5 rounded-lg text-muted-foreground hover:text-foreground hover:bg-accent transition-all"
            title="Atualizar"
          >
            <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
          </button>
        </div>
      </div>

      {totalAtivos === 0 && grouped.perdido.length === 0 ? (
        <div className="flex-1 flex flex-col items-center justify-center text-center py-12 text-muted-foreground text-sm">
          <Stethoscope size={32} className="mb-3 opacity-40" />
          <p>Nenhum paciente realizou avaliação nos últimos {days} dias.</p>
          <p className="text-xs mt-1 opacity-70">
            Quando uma consulta for marcada como CONCLUÍDA, o lead aparece aqui automaticamente.
          </p>
        </div>
      ) : (
        /* Kanban — 4 colunas com scroll horizontal em telas pequenas */
        <div className="flex-1 overflow-x-auto overflow-y-hidden p-3">
          <div className="flex gap-3 h-full min-w-max md:min-w-0">
            {COLUMNS.map((col) => {
              // Onda 14.46 — Separacao agora e feita no backend:
              //   bucket 'aguardando'   = sem quote OU quote DRAFT (ainda nao
              //                            enviada ao paciente)
              //   bucket 'com-orcamento' = quote SENT (efetivamente enviada)
              // Lead com quote DRAFT continua em "Avaliacao Concluida"; quando
              // operador envia (DRAFT -> SENT), automaticamente migra pra
              // "Orcamento Enviado" na proxima atualizacao (auto-refresh 60s).
              const items = grouped[col.id] || [];
              const Icon = col.icon;

              return (
                <div
                  key={col.id}
                  className={`flex-1 min-w-[260px] max-w-[340px] flex flex-col rounded-xl border ${col.border} bg-card overflow-hidden`}
                >
                  {/* Header da coluna */}
                  <div className={`flex items-center gap-2 px-3 py-2 border-b ${col.border} ${col.headerBg}`}>
                    <Icon size={14} className={col.color} />
                    <h3 className={`text-xs font-bold uppercase tracking-wider ${col.color}`}>
                      {col.label}
                    </h3>
                    <span className="ml-auto text-xs font-bold px-2 py-0.5 rounded-full bg-card border border-border text-foreground">
                      {items.length}
                    </span>
                  </div>
                  <p className={`px-3 pt-1.5 text-[10px] ${col.color} opacity-70`}>
                    {col.sub}
                  </p>

                  {/* Cards (scroll vertical interno) */}
                  <div className="flex-1 overflow-y-auto p-2 space-y-2">
                    {items.length === 0 && (
                      <div className="text-center text-[11px] text-muted-foreground/60 py-6 italic">
                        Nenhum lead aqui
                      </div>
                    )}

                    {items.map((lead) => {
                      const ev = lead.calendar_events?.[0];
                      const dentist = ev?.assigned_user?.name || lead.conversations?.[0]?.assigned_dentist?.name;
                      const specialty = lead.conversations?.[0]?.specialty;
                      const conv = lead.conversations?.[0];
                      const upcoming = lead.post_avaliacao?.upcoming_event;
                      const quote = lead.post_avaliacao?.quote;

                      return (
                        <div
                          key={lead.id}
                          onClick={() => openCard(lead)}
                          className="group p-2.5 rounded-lg border border-border bg-background hover:border-primary/40 hover:shadow-sm transition-all cursor-pointer"
                        >
                          {/* Header do card: foto + nome + paciente badge */}
                          <div className="flex items-center gap-1.5 mb-1.5">
                            <PatientAvatar
                              patientId={lead.post_avaliacao?.patient?.id ?? lead.id}
                              patientName={lead.name || lead.phone || 'Sem nome'}
                              avatarUrl={null}
                              fallbackPhotoUrl={lead.profile_picture_url}
                              size={28}
                              shape="circle"
                            />
                            <span className="text-sm font-bold text-foreground truncate flex-1">
                              {lead.name || lead.phone || 'Sem nome'}
                            </span>
                            {lead.post_avaliacao?.patient && (
                              <span
                                className="shrink-0 inline-flex items-center justify-center w-5 h-5 rounded-full bg-emerald-100 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-400"
                                title="Paciente cadastrado na clínica"
                              >
                                <HeartPulse size={11} />
                              </span>
                            )}
                          </div>

                          {/* Tags */}
                          <div className="flex flex-wrap gap-1 mb-1.5">
                            {specialty && (
                              <span className="text-[9px] font-semibold uppercase tracking-wider text-muted-foreground px-1.5 py-0.5 rounded bg-muted">
                                {specialty}
                              </span>
                            )}
                          </div>

                          {/* Info principal por coluna */}
                          <div className="space-y-0.5 text-[11px] text-muted-foreground">
                            {ev && (
                              <p className="flex items-center gap-1 truncate">
                                <Calendar size={10} />
                                Aval. {formatBR(ev.start_at)}
                                {ev.validated_at && <CheckCircle2 size={10} className="text-emerald-500" />}
                              </p>
                            )}
                            {dentist && (
                              <p className="flex items-center gap-1 truncate">
                                <Stethoscope size={10} />
                                {dentist}
                              </p>
                            )}
                            {quote && (
                              <p className="flex items-center gap-1 truncate text-orange-700 dark:text-orange-400 font-semibold">
                                <FileText size={10} />
                                R$ {Number(quote.total_value).toFixed(2)} ({quote.status})
                              </p>
                            )}
                            {upcoming && (
                              <p className="flex items-center gap-1 truncate text-emerald-700 dark:text-emerald-400 font-semibold">
                                <Calendar size={10} />
                                Próx: {formatBR(upcoming.start_at)}
                              </p>
                            )}
                          </div>

                          {/* Footer: ultima msg + acoes */}
                          <div className="flex items-center justify-between mt-2 pt-1.5 border-t border-border/50">
                            <span className="text-[10px] text-muted-foreground">
                              {timeAgo(conv?.last_message_at || null)}
                            </span>
                            <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                              {conv?.id && (
                                <button
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    onOpenChat(lead as any);
                                  }}
                                  className="p-1 rounded text-muted-foreground hover:text-blue-600 hover:bg-blue-50 dark:hover:bg-blue-950/30 transition-colors"
                                  title="Abrir chat"
                                >
                                  <MessageSquare size={11} />
                                </button>
                              )}
                              <ExternalLink size={11} className="text-muted-foreground" />
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

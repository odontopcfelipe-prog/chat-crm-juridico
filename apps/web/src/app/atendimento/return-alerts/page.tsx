'use client';

// Retornos (Manutenção) — quadro de retorno de manutenção do sorriso POR ETAPA.
// Cada procedimento feito (com intervalo de revisão) começa a contar sozinho, mesmo
// no meio do tratamento. Abas: "Tratamento Concluído" + um por tipo de procedimento +
// "RETORNO ATRASADO". Agrupado por mês do retorno. Dados: GET /return-alerts/maintenance-board.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Bell, Loader2, Phone, MessageCircle, AlertTriangle, Stethoscope } from 'lucide-react';
import api from '@/lib/api';
import { PatientAvatar } from '@/components/PatientAvatar';
import { showError } from '@/lib/toast';

interface Recall {
  kind: 'procedure' | 'completion';
  type: string;
  patient: { id: string; name: string | null; phone: string | null; avatar_url?: string | null };
  last_date: string | null;
  return_date: string;
  months: number;
  executed_by_name: string | null;
}

const MESES = ['Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho', 'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro'];
const CONCLUIDO = 'Tratamento Concluído';
const ATRASADO = 'RETORNO ATRASADO';

function waLink(phone?: string | null, name?: string | null): string | null {
  if (!phone) return null;
  const digits = phone.replace(/\D/g, '');
  if (digits.length < 10) return null;
  const num = digits.startsWith('55') ? digits : `55${digits}`;
  const msg = encodeURIComponent(`Olá${name ? `, ${name.split(' ')[0]}` : ''}! Passando pra agendar seu retorno de manutenção. 😊`);
  return `https://wa.me/${num}?text=${msg}`;
}

export default function ReturnAlertsPage() {
  const [loading, setLoading] = useState(true);
  const [recalls, setRecalls] = useState<Recall[]>([]);
  const [procedures, setProcedures] = useState<string[]>([]);
  const [tab, setTab] = useState<string>(CONCLUIDO);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await api.get<{ procedures: string[]; recalls: Recall[] }>('/return-alerts/maintenance-board');
      setProcedures(r.data?.procedures || []);
      setRecalls(r.data?.recalls || []);
    } catch (e: any) {
      showError(e?.response?.data?.message || 'Erro ao carregar retornos');
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => { load(); }, [load]);

  const now = Date.now();
  const isOverdue = (r: Recall) => new Date(r.return_date).getTime() < now;

  // Abas: Tratamento Concluído + procedimentos com "meses de revisão" configurado
  // (aparecem MESMO vazios) + os que já têm recall (por garantia) + RETORNO ATRASADO.
  const procTypes = useMemo(() => {
    const s = new Set<string>(procedures);
    recalls.forEach((r) => { if (r.kind === 'procedure') s.add(r.type); });
    return Array.from(s).sort((a, b) => a.localeCompare(b, 'pt-BR'));
  }, [procedures, recalls]);
  const tabs = useMemo(() => [CONCLUIDO, ...procTypes, ATRASADO], [procTypes]);

  const counts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const r of recalls) {
      c[r.type] = (c[r.type] || 0) + 1;
      if (isOverdue(r)) c[ATRASADO] = (c[ATRASADO] || 0) + 1;
    }
    return c;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recalls]);

  // Se a aba selecionada some (dados mudaram), volta pra primeira.
  useEffect(() => { if (!tabs.includes(tab)) setTab(tabs[0] || CONCLUIDO); }, [tabs, tab]);

  const shown = useMemo(() => {
    const list = tab === ATRASADO ? recalls.filter(isOverdue) : recalls.filter((r) => r.type === tab);
    return [...list].sort((a, b) => new Date(a.return_date).getTime() - new Date(b.return_date).getTime());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recalls, tab]);

  // Agrupa por mês do retorno.
  const groups = useMemo(() => {
    const m = new Map<string, Recall[]>();
    for (const r of shown) {
      const d = new Date(r.return_date);
      const key = `${d.getFullYear()}-${String(d.getMonth()).padStart(2, '0')}`;
      if (!m.has(key)) m.set(key, []);
      m.get(key)!.push(r);
    }
    return Array.from(m.entries())
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([key, items]) => {
        const [y, mo] = key.split('-').map(Number);
        return { label: `${MESES[mo]} de ${y}`, items };
      });
  }, [shown]);

  return (
    <div className="h-full overflow-y-auto p-6 w-full">
      <div className="mb-5">
        <h1 className="text-2xl font-bold text-foreground flex items-center gap-2">
          <Bell size={26} className="text-primary" /> Retornos
          <span className="text-lg font-normal text-muted-foreground">( Manutenção )</span>
        </h1>
        <p className="text-sm text-muted-foreground mt-1">
          Retorno de manutenção do sorriso por etapa — as abas são os procedimentos com retorno ligado em Configurações → Retornos.
        </p>
      </div>

      {/* Abas por tipo de procedimento */}
      <div className="flex flex-wrap items-center gap-1.5 mb-5 border-b border-border pb-3">
        {tabs.map((t) => {
          const active = tab === t;
          const isAtraso = t === ATRASADO;
          return (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`px-3 py-1.5 rounded-lg text-sm font-medium whitespace-nowrap transition-colors ${
                active
                  ? isAtraso ? 'bg-destructive text-white' : 'bg-primary text-primary-foreground'
                  : isAtraso ? 'text-destructive hover:bg-destructive/10' : 'text-muted-foreground hover:text-foreground hover:bg-accent'
              }`}
            >
              {t}{counts[t] ? ` (${counts[t]})` : ''}
            </button>
          );
        })}
      </div>

      {loading ? (
        <div className="p-12 flex items-center justify-center text-muted-foreground">
          <Loader2 size={20} className="animate-spin mr-2" /> Carregando...
        </div>
      ) : groups.length === 0 ? (
        <div className="p-12 text-center text-sm text-muted-foreground">
          <Bell size={28} className="mx-auto mb-2 opacity-50" />
          {tab === CONCLUIDO
            ? 'Nenhum paciente com tratamento concluído ainda.'
            : tab === ATRASADO
              ? 'Nenhum retorno atrasado. Tudo em dia! 🎉'
              : 'Ninguém fez esse procedimento ainda — quando fizer, o retorno de manutenção aparece aqui.'}
        </div>
      ) : (
        <div className="space-y-6">
          {groups.map((g) => (
            <div key={g.label}>
              <h2 className="text-sm font-bold text-emerald-600 mb-2">{g.label}</h2>
              <div className="space-y-2">
                {g.items.map((r, i) => {
                  const ret = new Date(r.return_date);
                  const overdue = ret.getTime() < now;
                  const days = Math.max(0, Math.floor((now - ret.getTime()) / 86_400_000));
                  const wa = waLink(r.patient.phone, r.patient.name);
                  return (
                    <div key={`${r.patient.id}-${r.type}-${i}`} className="bg-card border border-border rounded-xl p-4 flex items-start justify-between gap-4">
                      <PatientAvatar
                        patientId={r.patient.id}
                        patientName={r.patient.name || 'Sem nome'}
                        avatarUrl={r.patient.avatar_url}
                        size={40}
                        shape="circle"
                      />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2 mb-1 flex-wrap">
                          <span className="font-semibold text-foreground">{r.patient.name || 'Sem nome'}</span>
                          {overdue ? (
                            <span className="text-xs px-2 py-0.5 rounded bg-destructive/10 text-destructive flex items-center gap-1">
                              <AlertTriangle size={11} /> atrasado {days}d
                            </span>
                          ) : (
                            <span className="text-xs px-2 py-0.5 rounded bg-amber-500/10 text-amber-700 border border-amber-500/20">Pendente</span>
                          )}
                        </div>
                        <div className="text-xs text-muted-foreground flex items-center gap-3 flex-wrap">
                          {r.patient.phone && (
                            <span className="flex items-center gap-1"><Phone size={11} /> {r.patient.phone}</span>
                          )}
                          <span className="italic">{r.type}</span>
                          {r.last_date && <span>Feito em {new Date(r.last_date).toLocaleDateString('pt-BR')}</span>}
                          {r.executed_by_name && (
                            <span className="flex items-center gap-1">
                              <Stethoscope size={11} /> Concluído por {r.executed_by_name}
                            </span>
                          )}
                        </div>
                      </div>
                      <div className="flex flex-col items-end gap-2 shrink-0">
                        <span className={`text-sm font-bold tabular-nums ${overdue ? 'text-destructive' : 'text-foreground'}`}>
                          {ret.toLocaleDateString('pt-BR')}
                        </span>
                        {wa && (
                          <a
                            href={wa}
                            target="_blank"
                            rel="noreferrer"
                            className="text-xs inline-flex items-center gap-1 px-3 py-1.5 rounded-lg bg-primary text-primary-foreground hover:bg-primary/90"
                          >
                            <MessageCircle size={12} /> Contatar
                          </a>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

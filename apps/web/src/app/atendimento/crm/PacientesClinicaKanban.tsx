'use client';

/**
 * Pacientes Clínica — Kanban dentro de /atendimento/crm (Onda 14.50).
 *
 * 3o modo de visualizacao (botao azul/sky no header, ao lado do verde
 * "CRM Fechamentos"). Funil POS-FECHAMENTO: mostra pacientes que ja
 * assinaram tratamento e estao em execucao clinica.
 *
 * Colunas:
 *   1. 🟡 Aguardando Início (FIXA) — paciente com TreatmentPlan ACTIVE/
 *      PENDING_SIGNATURE mas SEM nenhum TreatmentPlanItem SCHEDULED/
 *      IN_PROGRESS. Aguarda o operador agendar o primeiro procedimento.
 *
 *   2..N 🔵 <Procedimento> (DINAMICAS) — uma coluna por Procedure que
 *      tenha pelo menos 1 paciente com TreatmentPlanItem ativo. Ordem
 *      alfabetica. Lead aparece em CADA coluna onde tem procedimento
 *      (ex: tem Faceta + Implante agendados -> aparece nas 2).
 *
 * Endpoint: GET /patients/funil-clinica — retorna patients anotados com
 * funil.{ aguardandoInicio, procedures[], nextAppointment }.
 *
 * Auto-refresh: 60s, igual ClosingKanban — pra refletir mudancas de
 * agendamento sem o operador precisar recarregar a pagina.
 */

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  Users, Clock, Stethoscope, Calendar, Loader2, RefreshCw, DollarSign,
} from 'lucide-react';
import api from '@/lib/api';

interface ProcedureInfo {
  id: string;
  name: string;
  category: string | null;
}

interface PatientClinica {
  id: string;
  name: string | null;
  phone: string | null;
  status: 'ACTIVE' | 'INACTIVE' | 'ARCHIVED';
  last_visit_at: string | null;
  primary_dentist: { id: string; name: string } | null;
  treatment_plans_total_value: number;
  funil: {
    aguardandoInicio: boolean;
    procedures: ProcedureInfo[];
    nextAppointment: string | null;
  };
}

const AGUARDANDO_COL = {
  id: 'aguardando-inicio' as const,
  label: 'Aguardando Início',
  sub: 'Tratamento assinado, sem procedimento agendado',
  icon: Clock,
  color: 'text-amber-700 dark:text-amber-400',
  headerBg: 'bg-amber-100/70 dark:bg-amber-950/40',
  border: 'border-amber-300 dark:border-amber-800',
};

// Estilo "azul" pras colunas dinamicas de procedimentos
const PROC_COL_STYLE = {
  color: 'text-sky-700 dark:text-sky-400',
  headerBg: 'bg-sky-100/70 dark:bg-sky-950/40',
  border: 'border-sky-300 dark:border-sky-800',
};

function formatBR(iso: string | null | Date): string {
  if (!iso) return '—';
  const d = iso instanceof Date ? iso : new Date(iso);
  return d.toLocaleDateString('pt-BR', { day: '2-digit', month: 'short', timeZone: 'UTC' });
}

function fmtBRL(n: number): string {
  return n.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

interface FunilResponse {
  patients: PatientClinica[];
  availableProcedures: ProcedureInfo[];
}

export function PacientesClinicaKanban() {
  const router = useRouter();
  const [patients, setPatients] = useState<PatientClinica[]>([]);
  // Onda 14.52 — procedures usadas no tenant (TreatmentPlanItem SCHEDULED/
  // IN_PROGRESS independente do paciente ter pago). Garante que colunas
  // aparecem mesmo quando o funil ainda nao tem patients que passaram o
  // gate financeiro (primeira parcela paga).
  const [availableProcedures, setAvailableProcedures] = useState<ProcedureInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchData = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.get<FunilResponse>('/patients/funil-clinica');
      setPatients(res.data?.patients ?? []);
      setAvailableProcedures(res.data?.availableProcedures ?? []);
    } catch (e: any) {
      setError(e?.response?.data?.message || 'Erro ao carregar funil de pacientes');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchData();
    // Auto-refresh igual ClosingKanban (60s) — pra capturar agendamentos
    // novos sem precisar recarregar a pagina inteira
    const interval = setInterval(fetchData, 60000);
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Colunas dinamicas: uniao de procedures que aparecem em qualquer paciente
  // do funil + availableProcedures (procedimentos em uso no tenant mesmo sem
  // pacientes pagantes). Garante que o operador SEMPRE veja a estrutura das
  // colunas. Ordenadas alfabeticamente (estavel pt-BR).
  const dynamicColumns = useMemo(() => {
    const procs = new Map<string, ProcedureInfo>();
    // Backend já filtra availableProcedures pelo tenant
    for (const proc of availableProcedures) {
      if (!procs.has(proc.id)) procs.set(proc.id, proc);
    }
    // Garantia extra: se algum paciente tem procedure que nao apareceu em
    // availableProcedures (race condition), inclui tambem
    for (const p of patients) {
      for (const proc of p.funil.procedures) {
        if (!procs.has(proc.id)) procs.set(proc.id, proc);
      }
    }
    return Array.from(procs.values()).sort((a, b) =>
      a.name.localeCompare(b.name, 'pt-BR'),
    );
  }, [patients, availableProcedures]);

  // Conta cada paciente UMA SO VEZ pra "total em jogo" (mesmo que apareca
  // em multiplas colunas no Kanban).
  const totalPacientes = patients.length;

  // Soma total do pipeline (valor de tratamentos ativos)
  const pipelineValue = useMemo(
    () => patients.reduce((acc, p) => acc + Number(p.treatment_plans_total_value || 0), 0),
    [patients],
  );

  const openPatient = (p: PatientClinica) => {
    router.push(`/atendimento/pacientes/${p.id}?tab=odontogram`);
  };

  // Filtragem por coluna
  const patientsForColumn = (colId: string): PatientClinica[] => {
    if (colId === AGUARDANDO_COL.id) {
      return patients.filter((p) => p.funil.aguardandoInicio);
    }
    return patients.filter((p) =>
      p.funil.procedures.some((proc) => proc.id === colId),
    );
  };

  if (loading && patients.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center py-16 text-muted-foreground">
        <Loader2 size={20} className="animate-spin mr-2" />
        Carregando pacientes da clínica…
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
      {/* Header com KPIs */}
      <div className="flex items-center justify-between gap-3 flex-wrap px-4 py-3 border-b border-border">
        <div className="flex items-center gap-3">
          <Users size={18} className="text-sky-600" />
          <div>
            <h2 className="text-base font-bold text-foreground">Pacientes Clínica</h2>
            <p className="text-[11px] text-muted-foreground">
              Funil por procedimento — pacientes com primeiro pagamento confirmado
            </p>
          </div>
        </div>

        <div className="flex items-center gap-3 flex-wrap">
          <div className="flex items-center gap-2 text-xs">
            <span className="text-muted-foreground">Valor ativo:</span>
            <span className="font-bold text-sky-700 tabular-nums">
              R$ {fmtBRL(pipelineValue)}
            </span>
          </div>
          <div className="flex items-center gap-2 text-xs">
            <span className="text-muted-foreground">Pacientes:</span>
            <span className="font-bold text-foreground">{totalPacientes}</span>
          </div>
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

      {/* Onda 14.52 — Kanban SEMPRE renderiza (coluna fixa + dinamicas), mesmo
          com 0 pacientes. Antes o empty-state global escondia tudo, agora cada
          coluna mostra empty interno se nao tiver paciente. Banner extra quando
          o funil esta totalmente vazio pra explicar a regra. */}
      {totalPacientes === 0 && (
        <div className="px-4 py-2.5 bg-sky-50/60 dark:bg-sky-950/20 border-b border-sky-200/60 dark:border-sky-900/40 text-[11px] text-sky-800 dark:text-sky-300">
          <strong>Funil vazio.</strong> Paciente aparece aqui assim que a primeira parcela cair em conta (status PAGA ou PARCIAL).
        </div>
      )}

      <div className="flex-1 overflow-x-auto overflow-y-hidden p-3">
        <div className="flex gap-3 h-full min-w-max">
          {/* Coluna fixa "Aguardando Início" — sempre aparece, mesmo vazia */}
          <KanbanColumn
            col={AGUARDANDO_COL}
            patients={patientsForColumn(AGUARDANDO_COL.id)}
            onCardClick={openPatient}
            emptyText="Nenhum paciente aguardando início"
          />

          {/* Colunas dinamicas — 1 por procedimento ativo no tenant, ordem alfabetica.
              Aparecem mesmo sem pacientes (estrutura do funil sempre visivel). */}
          {dynamicColumns.map((proc) => (
            <KanbanColumn
              key={proc.id}
              col={{
                id: proc.id,
                label: proc.name,
                sub: proc.category ? `Categoria: ${proc.category}` : 'Procedimento',
                icon: Stethoscope,
                ...PROC_COL_STYLE,
              }}
              patients={patientsForColumn(proc.id)}
              onCardClick={openPatient}
              emptyText="Nenhum paciente"
            />
          ))}

          {/* Se nao ha procedimentos em uso no tenant ainda, mostra coluna
              placeholder pra orientar o operador */}
          {dynamicColumns.length === 0 && (
            <div className="flex-1 min-w-[260px] max-w-[340px] flex flex-col rounded-xl border border-dashed border-border bg-card/40 overflow-hidden p-4 text-center text-[11px] text-muted-foreground italic">
              <Stethoscope size={20} className="mx-auto mb-2 opacity-40" />
              Nenhum procedimento agendado ainda no tenant.<br />
              Ao agendar um procedimento pra qualquer paciente, ele vira uma coluna aqui.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Coluna individual + cards ────────────────────────────────────────

interface KanbanColumnProps {
  col: {
    id: string;
    label: string;
    sub: string;
    icon: any;
    color: string;
    headerBg: string;
    border: string;
  };
  patients: PatientClinica[];
  onCardClick: (p: PatientClinica) => void;
  emptyText: string;
}

function KanbanColumn({ col, patients, onCardClick, emptyText }: KanbanColumnProps) {
  const Icon = col.icon;
  return (
    <div
      className={`flex-1 min-w-[260px] max-w-[340px] flex flex-col rounded-xl border ${col.border} bg-card overflow-hidden`}
    >
      <div className={`flex items-center gap-2 px-3 py-2 border-b ${col.border} ${col.headerBg}`}>
        <Icon size={14} className={col.color} />
        <h3 className={`text-xs font-bold uppercase tracking-wider ${col.color} truncate`} title={col.label}>
          {col.label}
        </h3>
        <span className="ml-auto text-xs font-bold px-2 py-0.5 rounded-full bg-card border border-border text-foreground">
          {patients.length}
        </span>
      </div>
      <p className={`px-3 pt-1.5 text-[10px] ${col.color} opacity-70 truncate`} title={col.sub}>
        {col.sub}
      </p>

      <div className="flex-1 overflow-y-auto p-2 space-y-2">
        {patients.length === 0 && (
          <div className="text-center text-[11px] text-muted-foreground/60 py-6 italic">
            {emptyText}
          </div>
        )}

        {patients.map((p) => (
          <div
            key={`${col.id}-${p.id}`}
            onClick={() => onCardClick(p)}
            className="group p-2.5 rounded-lg border border-border bg-background hover:border-primary/40 hover:shadow-sm transition-all cursor-pointer"
          >
            <div className="flex items-start gap-1.5 mb-1.5">
              <span className="text-sm font-bold text-foreground truncate flex-1">
                {p.name || p.phone || 'Sem nome'}
              </span>
            </div>

            <div className="space-y-0.5 text-[11px] text-muted-foreground">
              {p.primary_dentist && (
                <p className="flex items-center gap-1 truncate">
                  <Stethoscope size={10} />
                  {p.primary_dentist.name}
                </p>
              )}
              {p.funil.nextAppointment && (
                <p className="flex items-center gap-1 truncate text-sky-700 dark:text-sky-400 font-semibold">
                  <Calendar size={10} />
                  Próx: {formatBR(p.funil.nextAppointment)}
                </p>
              )}
              {p.treatment_plans_total_value > 0 && (
                <p className="flex items-center gap-1 truncate text-emerald-700 dark:text-emerald-400">
                  <DollarSign size={10} />
                  R$ {fmtBRL(p.treatment_plans_total_value)}
                </p>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

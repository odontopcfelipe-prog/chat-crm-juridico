'use client';

/**
 * OverviewClinicalSection — Onda 14.54
 *
 * Secao "clinica" da aba Visao Geral do paciente. Mostra DOIS cards lado a
 * lado: odontograma (read-only) + evolucao clinica recente.
 *
 * Objetivo: dar ao operador um snapshot clinico do paciente sem ele precisar
 * pular pra aba Avaliacao (odontograma completo) ou Historico (timeline).
 *
 * Odontograma: 4 quadrantes permanentes (adulto) em ordem FDI, com cores por
 * estado (CARIE, RESTAURADO, AUSENTE, etc). Click num dente leva pra aba
 * Avaliacao com o dente pre-selecionado.
 *
 * Evolucao clinica: ultimos 5 procedimentos executados (timeline type=
 * procedure). Click no item leva pra aba Historico filtrada.
 *
 * Dados:
 *  - GET /patients/:id/odontogram → {teeth: ToothRecord[]}
 *  - GET /patients/:id/timeline?types=procedure&limit=5 → {items}
 */
import { useCallback, useEffect, useState } from 'react';
import { Loader2, Activity, Stethoscope } from 'lucide-react';
import api from '@/lib/api';

// ─── Dados ────────────────────────────────────────────────────

interface ToothRecord {
  id: string;
  tooth_fdi: string;
  state: string;
}

interface OdontogramData {
  teeth: ToothRecord[];
}

interface TimelineItem {
  id: string;
  type: string;
  date: string;
  title: string;
  subtitle?: string | null;
  professional?: string | null;
}

interface TimelineResponse {
  items: TimelineItem[];
  total: number;
}

// FDI adulto (permanente) — espelha OdontogramaTab pra manter consistencia
const FDI_SUP_DIR = ['18', '17', '16', '15', '14', '13', '12', '11'];
const FDI_SUP_ESQ = ['21', '22', '23', '24', '25', '26', '27', '28'];
const FDI_INF_ESQ = ['31', '32', '33', '34', '35', '36', '37', '38'];
const FDI_INF_DIR = ['48', '47', '46', '45', '44', '43', '42', '41'];

// Estados clinicos — espelha OdontogramaTab. Mantemos sincronizado.
const STATES = [
  { v: 'CARIE',             label: 'Cárie',           cls: 'bg-red-500/20 text-red-700 border-red-500' },
  { v: 'RESTAURADO',        label: 'Restaurado',      cls: 'bg-blue-500/20 text-blue-700 border-blue-500' },
  { v: 'AUSENTE',           label: 'Ausente',         cls: 'bg-muted text-muted-foreground border-border' },
  { v: 'PROTESE',           label: 'Prótese',         cls: 'bg-purple-500/20 text-purple-700 border-purple-500' },
  { v: 'IMPLANTE',          label: 'Implante',        cls: 'bg-indigo-500/20 text-indigo-700 border-indigo-500' },
  { v: 'ENDODONTIA',        label: 'Endodontia',      cls: 'bg-amber-500/20 text-amber-700 border-amber-500' },
  { v: 'EXTRACAO_INDICADA', label: 'Extração ind.',   cls: 'bg-orange-500/20 text-orange-700 border-orange-500' },
  { v: 'COROA',             label: 'Coroa',           cls: 'bg-teal-500/20 text-teal-700 border-teal-500' },
  { v: 'FRATURA',           label: 'Fratura',         cls: 'bg-pink-500/20 text-pink-700 border-pink-500' },
] as const;
const STATE_CLS: Record<string, string> = Object.fromEntries(STATES.map((s) => [s.v, s.cls]));

interface Props {
  patientId: string;
  /** Callback pra navegar pra aba Avaliacao quando click no dente */
  onGoToOdontogram?: () => void;
  /** Callback pra navegar pra aba Historico quando click num evento */
  onGoToTimeline?: () => void;
}

export default function OverviewClinicalSection({
  patientId, onGoToOdontogram, onGoToTimeline,
}: Props) {
  const [odonto, setOdonto] = useState<OdontogramData | null>(null);
  const [events, setEvents] = useState<TimelineItem[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [oResp, tResp] = await Promise.allSettled([
        api.get<OdontogramData>(`/patients/${patientId}/odontogram`),
        // Timeline: pega so procedimentos executados (procedure), ultimos 5.
        // Backend ignora types= se nao reconhecer — fallback seguro.
        api.get<TimelineResponse>(
          `/patients/${patientId}/timeline?types=procedure&limit=5`,
        ),
      ]);
      if (oResp.status === 'fulfilled') {
        setOdonto(oResp.value.data);
      }
      if (tResp.status === 'fulfilled') {
        const all = tResp.value.data.items || [];
        // Garante filtro client-side caso backend nao filtre por type
        const procedures = all.filter((i) => i.type === 'procedure').slice(0, 5);
        // Se backend retornou todos os tipos, ainda assim mostra os 5 mais recentes
        setEvents(procedures.length > 0 ? procedures : all.slice(0, 5));
      }
    } finally {
      setLoading(false);
    }
  }, [patientId]);

  useEffect(() => { load(); }, [load]);

  // Mapa fdi → state pra render rapido
  const stateByFdi = new Map<string, string>();
  for (const t of odonto?.teeth || []) {
    if (!stateByFdi.has(t.tooth_fdi)) {
      stateByFdi.set(t.tooth_fdi, t.state);
    }
  }

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
      {/* ─── Odontograma read-only ─── */}
      <div className="bg-card border border-border rounded-xl p-4">
        <div className="flex items-center justify-between mb-3">
          <h3 className="font-semibold text-sm text-foreground flex items-center gap-2">
            <Stethoscope size={16} className="text-primary" />
            Odontograma
          </h3>
          {onGoToOdontogram && (
            <button
              type="button"
              onClick={onGoToOdontogram}
              className="text-xs text-primary hover:underline"
            >
              Abrir avaliação →
            </button>
          )}
        </div>
        {loading ? (
          <div className="py-8 flex items-center justify-center text-muted-foreground">
            <Loader2 size={14} className="animate-spin mr-2" />
            <span className="text-xs">Carregando...</span>
          </div>
        ) : (
          <>
            {/* Arcadas — 4 rows agrupadas em 2 (sup / inf) com separador central */}
            <div className="flex flex-col items-center gap-1.5 pb-3 border-b border-border/40">
              <div className="flex items-center gap-2">
                <ToothRow fdiList={FDI_SUP_DIR} stateByFdi={stateByFdi} onClick={onGoToOdontogram} />
                <div className="w-px h-7 bg-border" />
                <ToothRow fdiList={FDI_SUP_ESQ} stateByFdi={stateByFdi} onClick={onGoToOdontogram} />
              </div>
              <div className="flex items-center gap-2">
                <ToothRow fdiList={FDI_INF_DIR} stateByFdi={stateByFdi} onClick={onGoToOdontogram} />
                <div className="w-px h-7 bg-border" />
                <ToothRow fdiList={FDI_INF_ESQ} stateByFdi={stateByFdi} onClick={onGoToOdontogram} />
              </div>
            </div>
            {/* Legenda */}
            <div className="pt-3 flex items-center gap-2 flex-wrap text-[10px]">
              <LegendDot cls="bg-background border-border text-muted-foreground" label="Hígido" />
              {STATES.slice(0, 5).map((s) => (
                <LegendDot key={s.v} cls={s.cls} label={s.label} />
              ))}
            </div>
            {stateByFdi.size === 0 && (
              <p className="text-[11px] text-muted-foreground italic mt-3">
                Sem anotações no odontograma ainda — clique em um dente pra começar.
              </p>
            )}
          </>
        )}
      </div>

      {/* ─── Evolução clínica ─── */}
      <div className="bg-card border border-border rounded-xl p-4">
        <div className="flex items-center justify-between mb-3">
          <h3 className="font-semibold text-sm text-foreground flex items-center gap-2">
            <Activity size={16} className="text-emerald-600" />
            Evolução clínica
          </h3>
          {onGoToTimeline && events.length > 0 && (
            <button
              type="button"
              onClick={onGoToTimeline}
              className="text-xs text-primary hover:underline"
            >
              Ver histórico →
            </button>
          )}
        </div>
        {loading ? (
          <div className="py-8 flex items-center justify-center text-muted-foreground">
            <Loader2 size={14} className="animate-spin mr-2" />
            <span className="text-xs">Carregando...</span>
          </div>
        ) : events.length === 0 ? (
          <p className="text-[11px] text-muted-foreground italic">
            Nenhum procedimento executado ainda.
          </p>
        ) : (
          <ul className="space-y-3">
            {events.map((ev) => (
              <li key={ev.id} className="flex items-start gap-2.5">
                {/* Dot da timeline */}
                <span className="mt-1.5 w-2 h-2 rounded-full bg-emerald-500 shrink-0" />
                <div className="flex-1 min-w-0">
                  <div className="flex items-baseline justify-between gap-2 flex-wrap">
                    <span className="text-sm font-semibold text-foreground">{ev.title}</span>
                    <span className="text-[10px] text-muted-foreground tabular-nums">
                      {formatDateShort(ev.date)}
                    </span>
                  </div>
                  {ev.subtitle && (
                    <p className="text-[11px] text-muted-foreground line-clamp-2 mt-0.5">
                      {ev.subtitle}
                    </p>
                  )}
                  {ev.professional && (
                    <p className="text-[10px] text-muted-foreground/80 italic mt-0.5">
                      {ev.professional}
                    </p>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

// ─── Sub-componentes internos ─────────────────────────────────

function ToothRow({
  fdiList, stateByFdi, onClick,
}: {
  fdiList: string[];
  stateByFdi: Map<string, string>;
  onClick?: () => void;
}) {
  return (
    <div className="flex gap-1">
      {fdiList.map((fdi) => {
        const state = stateByFdi.get(fdi);
        const cls = state
          ? STATE_CLS[state] || 'bg-background border-border text-muted-foreground'
          : 'bg-background border-border text-muted-foreground';
        return (
          <button
            key={fdi}
            type="button"
            onClick={onClick}
            className={`w-7 h-7 rounded-md border-2 text-[10px] font-bold flex items-center justify-center hover:scale-110 transition-transform ${cls}`}
            title={state ? `Dente ${fdi} — ${state}` : `Dente ${fdi}`}
          >
            {fdi}
          </button>
        );
      })}
    </div>
  );
}

function LegendDot({ cls, label }: { cls: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1">
      <span className={`w-2.5 h-2.5 rounded-sm border ${cls}`} />
      <span className="text-muted-foreground">{label}</span>
    </span>
  );
}

function formatDateShort(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });
  } catch {
    return iso;
  }
}

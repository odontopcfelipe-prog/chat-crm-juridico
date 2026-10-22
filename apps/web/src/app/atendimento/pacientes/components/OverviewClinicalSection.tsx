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
import { OdontogramaPrancha, LegendaMarcas, marcaDoEstadoClinico, MARCAS, type MarcaDente } from '@/components/odontograma/DenteReal';

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

  // Out/2026 — estados anotados viram o desenho no dente (cárie, restauração,
  // implante, canal...) na mesma prancha da avaliação.
  const marcas = new Map<string, MarcaDente[]>();
  for (const t of odonto?.teeth || []) {
    const tipo = marcaDoEstadoClinico(t.state);
    const lista = marcas.get(t.tooth_fdi) ?? [];
    if (!lista.some((m) => m.tipo === tipo)) lista.push({ tipo, nome: MARCAS[tipo].label });
    marcas.set(t.tooth_fdi, lista);
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
            <div className="overflow-x-auto pb-3 border-b border-border/40">
              <div className="flex justify-center min-w-max">
                <OdontogramaPrancha
                  altura={44}
                  marcas={marcas}
                  onToggle={onGoToOdontogram ? () => onGoToOdontogram() : undefined}
                />
              </div>
            </div>
            <div className="pt-2">
              <LegendaMarcas porDente={marcas} />
            </div>
            {marcas.size === 0 && (
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

function formatDateShort(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });
  } catch {
    return iso;
  }
}

'use client';

/**
 * Out/2026 — Painel lateral das boas-vindas (Minha agenda).
 *
 * Os atalhos do topo da tela cheia abrem aqui as abas da FICHA do paciente — os
 * MESMOS componentes da ficha, carregados sob demanda — sem sair das boas-vindas.
 * "Prontuário" mostra as anotações dos atendimentos em linha do tempo (as mesmas
 * da aba Prontuário: GET /patients/:id/clinical-notes) e "Nova anotação".
 * O painel segue o tema do app (é a ficha); a tela de fundo é que tem paleta fixa.
 */
import { useCallback, useEffect, useState } from 'react';
import dynamic from 'next/dynamic';
import { X, Plus, Loader2, ExternalLink } from 'lucide-react';
import api from '@/lib/api';
import { showError, showSuccess } from '@/lib/toast';

function Carregando() {
  return (
    <div className="flex items-center justify-center gap-2 py-10 text-sm text-muted-foreground">
      <Loader2 size={16} className="animate-spin" /> Carregando…
    </div>
  );
}
// Abas da ficha sob demanda (só baixam quando abertas). O Next exige as opções do
// dynamic() como objeto literal em CADA chamada — não dá pra reaproveitar numa const.
const OverviewClinicalSection = dynamic(() => import('@/app/atendimento/pacientes/components/OverviewClinicalSection'), { ssr: false, loading: Carregando });
const AnamneseTab = dynamic(() => import('@/app/atendimento/pacientes/components/AnamneseTab'), { ssr: false, loading: Carregando });
const OdontogramaTab = dynamic(() => import('@/app/atendimento/pacientes/components/OdontogramaTab'), { ssr: false, loading: Carregando });
const TratamentoTab = dynamic(() => import('@/app/atendimento/pacientes/components/TratamentoTab'), { ssr: false, loading: Carregando });
const ManutencoesTab = dynamic(() => import('@/app/atendimento/pacientes/components/ManutencoesTab'), { ssr: false, loading: Carregando });
const TimelineTab = dynamic(() => import('@/app/atendimento/pacientes/components/TimelineTab'), { ssr: false, loading: Carregando });
const RadiografiasTab = dynamic(() => import('@/app/atendimento/pacientes/components/RadiografiasTab'), { ssr: false, loading: Carregando });
const EsteticaFacialTab = dynamic(() => import('@/app/atendimento/pacientes/components/EsteticaFacialTab'), { ssr: false, loading: Carregando });

/** Atalhos do topo — `id` = a aba da ficha (?tab=…) que o "Abrir na ficha completa" abre. */
export const ATALHOS = [
  { id: 'medical-record', label: 'Prontuário' },
  { id: 'overview', label: 'Visão geral' },
  { id: 'anamnesis', label: 'Anamnese' },
  { id: 'odontogram', label: 'Nova avaliação' },
  { id: 'treatment', label: 'Tratamento' },
  { id: 'maintenance', label: 'Manutenções' },
  { id: 'timeline', label: 'Histórico' },
  { id: 'radiografias', label: 'Radiografias' },
  { id: 'esthetic', label: 'Estética facial' },
] as const;
export type AtalhoId = (typeof ATALHOS)[number]['id'];

interface Props {
  tab: AtalhoId;
  patientId: string;
  patientName: string;
  /** Atendimento de hoje — a "Nova anotação" fica ligada a ele no prontuário. */
  appointmentId: string;
  podeAnotar: boolean;
  onTab: (tab: AtalhoId) => void;
  onClose: () => void;
}

export function PainelFicha({ tab, patientId, patientName, appointmentId, podeAnotar, onTab, onClose }: Props) {
  const label = ATALHOS.find((a) => a.id === tab)?.label ?? '';
  return (
    <div className="bv-panel-wrap">
      <button type="button" className="bv-panel-scrim" aria-label="Fechar painel" onClick={onClose} />
      <aside className="bv-panel bg-background text-foreground border-l border-border" role="dialog" aria-label={`${label} de ${patientName}`}>
        <div className="bv-panel-head border-b border-border">
          <div className="min-w-0">
            <p className="bv-panel-eyebrow truncate">{patientName}</p>
            <h2 className="text-xl font-bold text-foreground">{label}</h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="h-10 w-10 shrink-0 inline-flex items-center justify-center rounded-full border border-border hover:bg-accent"
            aria-label="Fechar painel"
          >
            <X size={18} />
          </button>
        </div>

        <div className="bv-panel-body" key={`${patientId}:${tab}`}>
          {tab === 'medical-record' && (
            <Anotacoes patientId={patientId} appointmentId={appointmentId} podeAnotar={podeAnotar} />
          )}
          {tab === 'overview' && (
            <OverviewClinicalSection
              patientId={patientId}
              onGoToOdontogram={() => onTab('odontogram')}
              onGoToTimeline={() => onTab('timeline')}
            />
          )}
          {tab === 'anamnesis' && <AnamneseTab patientId={patientId} />}
          {tab === 'odontogram' && <OdontogramaTab patientId={patientId} patientName={patientName} />}
          {tab === 'treatment' && <TratamentoTab patientId={patientId} />}
          {tab === 'maintenance' && <ManutencoesTab patientId={patientId} />}
          {tab === 'timeline' && <TimelineTab patientId={patientId} />}
          {tab === 'radiografias' && <RadiografiasTab patientId={patientId} />}
          {tab === 'esthetic' && <EsteticaFacialTab patientId={patientId} />}
        </div>

        <div className="bv-panel-foot border-t border-border">
          <a
            href={`/atendimento/pacientes/${patientId}?tab=${tab}`}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 text-sm font-semibold text-foreground hover:underline"
          >
            Abrir na ficha completa <ExternalLink size={14} />
          </a>
        </div>
      </aside>
    </div>
  );
}

// ─── Prontuário: anotações em linha do tempo ─────────────────────────────────

interface ClinicalNote {
  id: string;
  subjective: string | null;
  objective: string | null;
  assessment: string | null;
  plan: string | null;
  addendum: string | null;
  created_at: string;
  author: { id: string; name: string } | null;
  appointment: { id: string; start_at: string; title: string } | null;
}

const MESES = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];
const SOAP = [
  ['subjective', 'Subjetivo'],
  ['objective', 'Objetivo'],
  ['assessment', 'Avaliação'],
  ['plan', 'Plano'],
] as const;

/** Dia da anotação: o da consulta (naive-UTC: hora de Maceió nos campos UTC) ou o
 *  da criação (UTC real → Maceió). Lido sempre via getUTC*. */
function quando(n: ClinicalNote): Date {
  return n.appointment?.start_at
    ? new Date(n.appointment.start_at)
    : new Date(new Date(n.created_at).getTime() - 3 * 60 * 60 * 1000);
}

function Anotacoes({ patientId, appointmentId, podeAnotar }: { patientId: string; appointmentId: string; podeAnotar: boolean }) {
  const [notes, setNotes] = useState<ClinicalNote[] | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [nova, setNova] = useState<string | null>(null); // null = formulário fechado
  const [salvando, setSalvando] = useState(false);

  const load = useCallback(async () => {
    try {
      const { data } = await api.get<ClinicalNote[]>(`/patients/${patientId}/clinical-notes`);
      setNotes(Array.isArray(data) ? data : []);
      setErro(null);
    } catch (e: any) {
      setNotes([]);
      setErro(e?.response?.data?.message || 'Não consegui carregar as anotações.');
    }
  }, [patientId]);
  useEffect(() => { load(); }, [load]);

  const salvar = async () => {
    const texto = (nova || '').trim();
    if (!texto) { showError('Escreva a anotação'); return; }
    setSalvando(true);
    try {
      await api.post(`/patients/${patientId}/clinical-notes`, { appointment_id: appointmentId, plan: texto });
      showSuccess('Anotação salva no prontuário');
      setNova(null);
      await load();
    } catch (e: any) {
      showError(e?.response?.data?.message || 'Não consegui salvar a anotação');
    } finally {
      setSalvando(false);
    }
  };

  return (
    <div>
      <div className="flex items-center justify-between gap-3 mb-4">
        <p className="text-sm text-muted-foreground">Anotações dos atendimentos, da mais recente pra mais antiga.</p>
        {podeAnotar && nova === null && (
          <button
            type="button"
            onClick={() => setNova('')}
            className="h-10 px-3.5 shrink-0 inline-flex items-center gap-1.5 rounded-xl border border-border text-sm font-semibold hover:bg-accent"
          >
            <Plus size={15} /> Nova anotação
          </button>
        )}
      </div>

      {nova !== null && (
        <div className="mb-5 rounded-2xl border border-border bg-card p-3">
          <textarea
            autoFocus
            value={nova}
            onChange={(e) => setNova(e.target.value)}
            rows={4}
            placeholder="O que você quer registrar no prontuário?"
            className="w-full resize-y rounded-lg border border-border bg-background p-2.5 text-sm text-foreground outline-none focus:border-primary"
          />
          <div className="mt-2 flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setNova(null)}
              disabled={salvando}
              className="h-9 px-3 rounded-lg text-sm font-semibold text-muted-foreground hover:bg-accent"
            >
              Cancelar
            </button>
            <button
              type="button"
              onClick={salvar}
              disabled={salvando}
              className="h-9 px-4 inline-flex items-center gap-1.5 rounded-lg bg-primary text-sm font-semibold text-primary-foreground disabled:opacity-60"
            >
              {salvando && <Loader2 size={14} className="animate-spin" />} Salvar no prontuário
            </button>
          </div>
        </div>
      )}

      {notes === null ? (
        <Carregando />
      ) : erro ? (
        <p className="rounded-2xl border border-dashed border-border p-6 text-center text-sm text-muted-foreground">{erro}</p>
      ) : notes.length === 0 ? (
        <p className="rounded-2xl border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
          Ainda não há anotações. A primeira aparece aqui assim que você confirmar este atendimento.
        </p>
      ) : (
        <ol className="bv-notes">
          {notes.map((n) => {
            const d = quando(n);
            const partes = SOAP.filter(([k]) => (n[k] || '').trim());
            // Só o "Plano" (é o que a confirmação do atendimento grava): texto corrido.
            const soPlano = partes.length === 1 && partes[0][0] === 'plan';
            return (
              <li key={n.id} className="bv-note">
                <div className="bv-note-when">
                  <b className="text-foreground">{d.getUTCDate()} {MESES[d.getUTCMonth()]}</b>
                  <span className="text-muted-foreground">{d.getUTCFullYear()}</span>
                </div>
                <div className="bv-note-rail" aria-hidden><i /></div>
                <div className="bv-note-card bg-card border border-border">
                  <div className="flex flex-wrap items-baseline gap-x-1.5 mb-1.5">
                    <span className="text-sm font-bold text-foreground">{n.appointment?.title || 'Anotação'}</span>
                    {n.author?.name && <span className="text-xs text-muted-foreground">· {n.author.name}</span>}
                  </div>
                  {soPlano ? (
                    <p className="text-sm leading-relaxed text-foreground whitespace-pre-line">{n.plan}</p>
                  ) : (
                    partes.map(([k, rotulo]) => (
                      <p key={k} className="text-sm leading-relaxed text-foreground whitespace-pre-line mt-1 first:mt-0">
                        <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mr-1.5">{rotulo}</span>
                        {n[k]}
                      </p>
                    ))
                  )}
                  {n.addendum && (
                    <p className="mt-2 border-t border-border pt-2 text-sm leading-relaxed text-foreground whitespace-pre-line">
                      <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mr-1.5">Adendo</span>
                      {n.addendum}
                    </p>
                  )}
                </div>
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}

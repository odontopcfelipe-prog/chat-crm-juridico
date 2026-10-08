'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Wand2,
  Loader2,
  AlertCircle,
  AlertTriangle,
  CheckCircle2,
  Info,
  Archive,
  ArchiveRestore,
  ChevronDown,
  X,
} from 'lucide-react';
import api from '@/lib/api';
import {
  archiveEffectText,
  memoryReviewKind,
  orgMemoryLabel,
  orgSummaryNote,
  type OrgSummaryNote,
  type OrgSummaryState,
} from './memory-categories';

/** Sugestão da revisão (POST /memories/organization/review). A revisão NÃO altera nada. */
interface ReviewSuggestion {
  id: string;
  content: string;
  subcategory: string | null;
  kind: string;
  reason: string;
  duplicate_of?: string;
}

type ReviewAiStatus = 'ok' | 'sem_chave' | 'erro' | 'nada_a_revisar';

/** Como foi a parte de IA da revisão (a checagem automática sempre roda). */
interface ReviewAiInfo {
  status: ReviewAiStatus;
  /** Memórias que a IA conferiu. */
  checked: number;
  /** Memórias que precisavam da IA e ficaram de fora (limite por revisão, falha, sem chave). */
  notChecked: number;
}

interface ReviewResponse {
  reviewed: number;
  suggestions: ReviewSuggestion[];
  ai?: { status?: string; checked?: number; not_checked?: number; model?: string; limit?: number };
}

interface ArchiveResponse {
  archived?: number;
  summary?: string;
}

interface RestoreResponse {
  restored?: number;
  summary?: string;
}

interface ArchivedItem {
  id: string;
  content: string;
  subcategory: string | null;
  created_at: string;
  updated_at: string;
  group: string;
}

/** Como a memória está AGORA na lista da página (só as ativas). */
export interface ActiveMemorySnapshot {
  content: string;
  subcategory: string | null;
}

export type ActiveMemoryMap = ReadonlyMap<string, ActiveMemorySnapshot>;

const AI_STATUSES: readonly ReviewAiStatus[] = ['ok', 'sem_chave', 'erro', 'nada_a_revisar'];

function parseAi(raw: ReviewResponse['ai']): ReviewAiInfo | null {
  if (!raw || typeof raw !== 'object') return null; // API antiga: sem o campo
  const status = AI_STATUSES.find((s) => s === raw.status);
  if (!status) return null;
  return {
    status,
    checked: Math.max(0, Number(raw.checked) || 0),
    notChecked: Math.max(0, Number(raw.not_checked) || 0),
  };
}

function sameSnapshot(a: ActiveMemorySnapshot | undefined, b: ActiveMemorySnapshot | undefined): boolean {
  if (!a || !b) return a === b;
  return a.content === b.content && (a.subcategory ?? null) === (b.subcategory ?? null);
}

const NOTE_EDITED =
  'Editada na lista depois da revisão, por isso foi desmarcada: o motivo acima pode não valer mais. Marque só se ainda quiser arquivar.';
const NOTE_KEEP_GONE =
  'A memória que ficaria no lugar desta foi apagada ou arquivada, por isso esta foi desmarcada: arquivar as duas tira a informação da base.';

interface ReconcileResult {
  list: ReviewSuggestion[];
  removed: string[];
  /** Sugestões que continuam, mas devem ser DESMARCADAS (com o aviso do porquê). */
  changed: { id: string; note: string }[];
}

/**
 * Tira da lista de sugestões o que já não vale: memória que saiu das ativas
 * (apagada/arquivada pela lista) sai; memória editada (texto ou categoria) fica,
 * mas com o texto novo e DESMARCADA — o motivo da sugestão pode não valer mais.
 * Duplicada cuja "que fica" sumiu também é desmarcada (senão some a informação).
 *
 * `base` = como a lista estava quando a revisão começou: aí só conta o que mudou
 * DURANTE a revisão (a lista da página pode estar mais velha que a revisão; uma
 * memória criada depois de a página carregar não está em `base` e não é tocada).
 *
 * O que já foi ajustado não volta a ser desmarcado (texto atualizado, duplicate_of
 * limpo) — se a pessoa marcar de novo, um recarregamento à toa não desmarca.
 */
function reconcileSuggestions(
  list: ReviewSuggestion[],
  current: ActiveMemoryMap,
  base?: ActiveMemoryMap,
): ReconcileResult {
  const out: ReviewSuggestion[] = [];
  const removed: string[] = [];
  const changed: { id: string; note: string }[] = [];
  const inScope = (id: string) => !base || base.has(id);
  for (const s of list) {
    if (!inScope(s.id)) {
      out.push(s);
      continue;
    }
    const now = current.get(s.id);
    if (!now) {
      removed.push(s.id);
      continue;
    }
    let next = s;
    let note: string | null = null;
    const touched = !base || !sameSnapshot(base.get(s.id), now);
    if (touched && (now.content !== s.content || (now.subcategory ?? null) !== (s.subcategory ?? null))) {
      next = { ...next, content: now.content, subcategory: now.subcategory ?? null };
      note = NOTE_EDITED;
    }
    if (s.duplicate_of && inScope(s.duplicate_of) && !current.has(s.duplicate_of)) {
      next = { ...next, duplicate_of: undefined };
      note = NOTE_KEEP_GONE;
    }
    if (note) changed.push({ id: s.id, note });
    out.push(next);
  }
  return { list: out, removed, changed };
}

function errMsg(e: any, fallback: string): string {
  const m = e?.response?.data?.message;
  if (Array.isArray(m)) return m.join(' ');
  return m || fallback;
}

function formatDay(iso: string | null | undefined): string {
  if (!iso) return '';
  try {
    return new Date(iso).toLocaleDateString('pt-BR', { timeZone: 'America/Maceio' });
  } catch {
    return '';
  }
}

function memoriasN(n: number): string {
  return n === 1 ? '1 memória' : `${n} memórias`;
}

/** Aviso do resumo da clínica depois de arquivar/restaurar. */
function SummaryNoteBox({ note, className = '' }: { note: OrgSummaryNote; className?: string }) {
  if (note.tone === 'warn') {
    return (
      <div
        className={`px-3 py-2 rounded-lg text-xs flex items-start gap-2 bg-amber-500/10 text-amber-700 dark:text-amber-400 border border-amber-500/20 ${className}`}
      >
        <AlertTriangle className="w-4 h-4 shrink-0 mt-px" />
        <span>{note.text}</span>
      </div>
    );
  }
  return (
    <p className={`text-[11px] text-muted-foreground flex items-center gap-1.5 ${className}`}>
      <Info className="w-3.5 h-3.5 shrink-0" />
      {note.text}
    </p>
  );
}

/**
 * Limpeza da Base de Conhecimento: a IA aponta memórias que não deveriam estar
 * aqui (dado interno, de paciente, sobra do jurídico, preço, pontual, duplicada,
 * errada) e a pessoa escolhe o que arquivar. Arquivar não apaga — dá pra
 * restaurar em "Ver arquivadas".
 *
 * onChanged: chamado depois de arquivar/restaurar, pra página recarregar a lista.
 * archivedVersion: a página incrementa quando arquiva uma memória direto na lista
 *   → recarrega as arquivadas se estiverem abertas.
 * summaryState: como está o resumo da clínica (sem / automático / editado à mão)
 *   → texto da confirmação e aviso depois de arquivar.
 * activeMemories: memórias ativas da lista da página (id → texto/categoria). Quando
 *   muda (editar, apagar, arquivar pela lista), as sugestões se ajustam.
 * onSummaryQueued: a API enfileirou a atualização do resumo (~1 min).
 */
export function MemoryReviewPanel({
  onChanged,
  archivedVersion = 0,
  summaryState = 'none',
  activeMemories,
  onSummaryQueued,
}: {
  onChanged: () => void | Promise<void>;
  archivedVersion?: number;
  summaryState?: OrgSummaryState;
  activeMemories?: ActiveMemoryMap | null;
  onSummaryQueued?: () => void;
}) {
  // Revisão com IA
  const [reviewState, setReviewState] = useState<'idle' | 'loading' | 'done' | 'error'>('idle');
  const [reviewError, setReviewError] = useState<string | null>(null);
  const [reviewed, setReviewed] = useState(0);
  const [ai, setAi] = useState<ReviewAiInfo | null>(null);
  const [suggestions, setSuggestions] = useState<ReviewSuggestion[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  // Sugestões desmarcadas porque a lista mudou depois da revisão (id → aviso)
  const [staleNotes, setStaleNotes] = useState<Map<string, string>>(new Map());
  // Sugestões que saíram porque a memória foi apagada/arquivada pela lista
  const [removedOutside, setRemovedOutside] = useState(0);
  const [confirming, setConfirming] = useState(false);
  const [archiving, setArchiving] = useState(false);
  const [archiveError, setArchiveError] = useState<string | null>(null);
  const [doneMsg, setDoneMsg] = useState<string | null>(null);
  const [summaryNote, setSummaryNote] = useState<OrgSummaryNote | null>(null);

  // Arquivadas
  const [archivedOpen, setArchivedOpen] = useState(false);
  const [archivedLoading, setArchivedLoading] = useState(false);
  const [archivedError, setArchivedError] = useState<string | null>(null);
  const [archived, setArchived] = useState<ArchivedItem[]>([]);
  const [restoring, setRestoring] = useState<Set<string>>(new Set());
  const [restoreNote, setRestoreNote] = useState<{ text: string; summary: OrgSummaryNote | null } | null>(null);

  // Refs pro efeito de "a lista da página mudou" (roda só quando a lista muda)
  const suggestionsRef = useRef<ReviewSuggestion[]>(suggestions);
  const reviewStateRef = useRef(reviewState);
  const activeRef = useRef<ActiveMemoryMap | null | undefined>(activeMemories);
  useEffect(() => {
    suggestionsRef.current = suggestions;
  }, [suggestions]);
  useEffect(() => {
    reviewStateRef.current = reviewState;
  }, [reviewState]);

  /** Aplica o ajuste das sugestões (sai o que foi apagado/arquivado; desmarca o editado). */
  const applyReconcile = useCallback((res: ReconcileResult) => {
    if (res.removed.length === 0 && res.changed.length === 0) return;
    const drop = new Set([...res.removed, ...res.changed.map((c) => c.id)]);
    suggestionsRef.current = res.list;
    setSuggestions(res.list);
    setSelected((prev) => new Set([...prev].filter((id) => !drop.has(id))));
    if (res.changed.length > 0) {
      setStaleNotes((prev) => {
        const next = new Map(prev);
        for (const c of res.changed) next.set(c.id, c.note);
        return next;
      });
    }
    if (res.removed.length > 0) setRemovedOutside((n) => n + res.removed.length);
  }, []);

  // A lista da página recarregou → sugestões velhas saem / editadas desmarcam.
  useEffect(() => {
    activeRef.current = activeMemories;
    if (!activeMemories || reviewStateRef.current !== 'done') return;
    applyReconcile(reconcileSuggestions(suggestionsRef.current, activeMemories));
  }, [activeMemories, applyReconcile]);

  const runReview = async () => {
    // Como a lista estava ao começar: o que mudar DURANTE a revisão é descontado na volta.
    const baseMap = activeRef.current;
    setReviewState('loading');
    setReviewError(null);
    setArchiveError(null);
    setDoneMsg(null);
    setSummaryNote(null);
    setConfirming(false);
    try {
      // A IA lê todas as memórias — pode demorar mais que o padrão.
      const res = await api.post<ReviewResponse>('/memories/organization/review', {}, { timeout: 180000 });
      let list = Array.isArray(res.data?.suggestions) ? res.data.suggestions : [];
      let removed = 0;
      const notes = new Map<string, string>();
      const nowMap = activeRef.current;
      if (baseMap && nowMap && nowMap !== baseMap) {
        const r = reconcileSuggestions(list, nowMap, baseMap);
        list = r.list;
        removed = r.removed.length;
        for (const c of r.changed) notes.set(c.id, c.note);
      }
      suggestionsRef.current = list;
      setReviewed(Number(res.data?.reviewed) || 0);
      setAi(parseAi(res.data?.ai));
      setSuggestions(list);
      setSelected(new Set(list.filter((s) => !notes.has(s.id)).map((s) => s.id))); // marcadas (menos as que mudaram)
      setStaleNotes(notes);
      setRemovedOutside(removed);
      setReviewState('done');
    } catch (e: any) {
      setReviewError(errMsg(e, 'Não consegui revisar agora. Tente de novo em instantes.'));
      setReviewState('error');
    }
  };

  const closeReview = () => {
    setReviewState('idle');
    setSuggestions([]);
    setSelected(new Set());
    setStaleNotes(new Map());
    setRemovedOutside(0);
    setAi(null);
    setConfirming(false);
    setArchiveError(null);
    setDoneMsg(null);
    setSummaryNote(null);
  };

  const toggleOne = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const allSelected = suggestions.length > 0 && suggestions.every((s) => selected.has(s.id));
  const toggleAll = () =>
    setSelected(allSelected ? new Set() : new Set(suggestions.map((s) => s.id)));

  const loadArchived = useCallback(async () => {
    setArchivedLoading(true);
    setArchivedError(null);
    try {
      const res = await api.get<{ groups: Record<string, any[]> }>('/memories/organization', {
        params: { status: 'archived' },
      });
      const groups = res.data?.groups || {};
      const flat: ArchivedItem[] = Object.entries(groups).flatMap(([group, items]) =>
        (Array.isArray(items) ? items : []).map((m: any) => ({
          id: m.id,
          content: m.content,
          subcategory: m.subcategory ?? null,
          created_at: m.created_at,
          updated_at: m.updated_at,
          group,
        })),
      );
      // Mais recente primeiro (arquivar mexe no updated_at)
      flat.sort((a, b) => String(b.updated_at || '').localeCompare(String(a.updated_at || '')));
      setArchived(flat);
    } catch (e: any) {
      setArchivedError(errMsg(e, 'Não consegui carregar as arquivadas.'));
    } finally {
      setArchivedLoading(false);
    }
  }, []);

  useEffect(() => {
    if (archivedOpen) loadArchived();
  }, [archivedOpen, archivedVersion, loadArchived]);

  const archiveSelected = async () => {
    const ids = suggestions.filter((s) => selected.has(s.id)).map((s) => s.id);
    if (ids.length === 0) return;
    setArchiving(true);
    setArchiveError(null);
    try {
      const res = await api.post<ArchiveResponse>('/memories/organization/archive', { ids });
      const n = Number(res.data?.archived ?? ids.length);
      const gone = new Set(ids);
      // ref já atualizado: o recarregar da página (onChanged) não pode contar estas como "saíram pela lista"
      const remaining = suggestionsRef.current.filter((s) => !gone.has(s.id));
      suggestionsRef.current = remaining;
      setSuggestions(remaining);
      setSelected(new Set());
      setConfirming(false);
      setDoneMsg(
        n === 1
          ? '1 memória arquivada. Dá pra restaurar em "Ver arquivadas".'
          : `${n} memórias arquivadas. Dá pra restaurar em "Ver arquivadas".`,
      );
      const note = orgSummaryNote(res.data?.summary, summaryState, n);
      setSummaryNote(note);
      if (note?.outcome === 'regen_queued') onSummaryQueued?.();
      await onChanged();
      if (archivedOpen) await loadArchived();
    } catch (e: any) {
      setArchiveError(errMsg(e, 'Não consegui arquivar. Nada foi alterado.'));
    } finally {
      setArchiving(false);
    }
  };

  const restoreOne = async (id: string) => {
    setRestoring((prev) => new Set(prev).add(id));
    setArchivedError(null);
    setRestoreNote(null);
    try {
      const res = await api.post<RestoreResponse>('/memories/organization/restore', { ids: [id] });
      const n = Number(res.data?.restored ?? 1);
      setArchived((prev) => prev.filter((m) => m.id !== id));
      if (n > 0) {
        const note = orgSummaryNote(res.data?.summary, summaryState, n);
        setRestoreNote({ text: 'Memória restaurada: voltou para a base.', summary: note });
        if (note?.outcome === 'regen_queued') onSummaryQueued?.();
      } else {
        setArchivedError('Essa memória não estava mais arquivada — a lista foi atualizada.');
        await loadArchived();
      }
      await onChanged();
    } catch (e: any) {
      setArchivedError(errMsg(e, 'Não consegui restaurar.'));
    } finally {
      setRestoring((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    }
  };

  const selectedCount = suggestions.filter((s) => selected.has(s.id)).length;

  // Parte de IA: sem chave/erro = só a checagem automática rodou; parcial = limite por revisão.
  const aiFailed = ai?.status === 'sem_chave' || ai?.status === 'erro';
  const aiPartial = !!ai && !aiFailed && ai.notChecked > 0;
  const aiTotal = ai ? ai.checked + ai.notChecked : 0;
  const hasNotices = aiFailed || aiPartial || removedOutside > 0 || !!doneMsg || !!summaryNote;

  return (
    <div className="bg-card border border-border rounded-xl mb-4 overflow-hidden">
      {/* Cabeçalho */}
      <div className="px-4 py-3 flex flex-col md:flex-row md:items-center md:justify-between gap-3">
        <div className="flex items-start gap-3">
          <Wand2 className="w-4 h-4 text-primary mt-0.5 shrink-0" />
          <div>
            <span className="text-sm font-medium">Limpar a base</span>
            <p className="text-[11px] text-muted-foreground mt-0.5 max-w-xl">
              A IA confere as memórias e aponta o que não deveria estar aqui: assunto interno da equipe
              (caixa, vendas, cobrança), dado de paciente, sobra do sistema jurídico, preço, coisa de um dia
              só, repetida ou errada. Nada muda até você confirmar.
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <button
            onClick={() => {
              setRestoreNote(null);
              setArchivedOpen((v) => !v);
            }}
            className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border border-border text-sm text-muted-foreground hover:text-foreground hover:bg-foreground/[0.03]"
          >
            <Archive className="w-4 h-4" />
            {archivedOpen ? 'Esconder arquivadas' : 'Ver arquivadas'}
          </button>
          <button
            onClick={runReview}
            disabled={reviewState === 'loading' || archiving}
            className="inline-flex items-center gap-2 px-3 py-2 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 disabled:opacity-50"
          >
            {reviewState === 'loading' ? <Loader2 className="w-4 h-4 animate-spin" /> : <Wand2 className="w-4 h-4" />}
            {reviewState === 'done' ? 'Revisar de novo' : 'Revisar com IA'}
          </button>
        </div>
      </div>

      {/* Revisando */}
      {reviewState === 'loading' && (
        <div className="border-t border-border bg-foreground/[0.02] px-4 py-6 flex items-center justify-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="w-4 h-4 animate-spin" />
          Revisando as memórias… pode levar até um minuto.
        </div>
      )}

      {/* Erro da revisão */}
      {reviewState === 'error' && reviewError && (
        <div className="border-t border-border px-4 py-3">
          <div className="px-3 py-2 rounded-lg text-sm flex items-center gap-2 bg-red-500/10 text-red-600 dark:text-red-400 border border-red-500/20">
            <AlertCircle className="w-4 h-4 shrink-0" />
            <span className="flex-1">{reviewError}</span>
            <button onClick={runReview} className="text-xs font-medium hover:underline">
              Tentar de novo
            </button>
          </div>
        </div>
      )}

      {/* Resultado da revisão */}
      {reviewState === 'done' && (
        <div className="border-t border-border bg-foreground/[0.02]">
          <div className="px-4 py-2 flex items-center justify-between gap-3 border-b border-border">
            <p className="text-[11px] text-muted-foreground">
              {reviewed === 1 ? '1 memória revisada' : `${reviewed} memórias revisadas`}
              {suggestions.length > 0 &&
                ` • ${suggestions.length === 1 ? '1 sugestão' : `${suggestions.length} sugestões`} pra arquivar`}
            </p>
            <button
              onClick={closeReview}
              className="p-1 text-muted-foreground hover:text-foreground rounded"
              title="Fechar revisão"
              aria-label="Fechar revisão"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>

          {hasNotices && (
            <div className="px-4 pt-3 pb-1 space-y-2">
              {/* A parte de IA não rodou: só valeu a checagem automática */}
              {aiFailed && (
                <div className="px-3 py-2 rounded-lg text-sm flex items-start gap-2 bg-amber-500/10 text-amber-700 dark:text-amber-400 border border-amber-500/20">
                  <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
                  <div className="flex-1">
                    <p>A parte de IA não rodou agora: só a checagem automática foi aplicada. Tente de novo.</p>
                    {ai?.status === 'sem_chave' && (
                      <p className="text-[11px] mt-0.5 opacity-90">Motivo: não achei a chave da IA configurada.</p>
                    )}
                  </div>
                  <button onClick={runReview} className="text-xs font-medium hover:underline shrink-0 mt-0.5">
                    Tentar de novo
                  </button>
                </div>
              )}

              {/* A IA conferiu só parte (limite por revisão) */}
              {aiPartial && ai && (
                <div className="px-3 py-2 rounded-lg text-xs flex items-start gap-2 bg-amber-500/10 text-amber-700 dark:text-amber-400 border border-amber-500/20">
                  <Info className="w-4 h-4 shrink-0 mt-px" />
                  <span>
                    A IA conferiu só {ai.checked} de {memoriasN(aiTotal)} nesta revisão (há um limite por vez). Vale
                    revisar de novo depois de arquivar, pra ela conferir o resto.
                  </span>
                </div>
              )}

              {removedOutside > 0 && (
                <p className="text-[11px] text-muted-foreground flex items-center gap-1.5">
                  <Info className="w-3.5 h-3.5 shrink-0" />
                  {removedOutside === 1
                    ? '1 sugestão saiu daqui porque a memória foi apagada ou arquivada na lista.'
                    : `${removedOutside} sugestões saíram daqui porque as memórias foram apagadas ou arquivadas na lista.`}
                </p>
              )}

              {doneMsg && (
                <div className="px-3 py-2 rounded-lg text-sm flex items-center gap-2 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border border-emerald-500/20">
                  <CheckCircle2 className="w-4 h-4 shrink-0" />
                  {doneMsg}
                </div>
              )}
              {summaryNote && <SummaryNoteBox note={summaryNote} />}
            </div>
          )}

          {suggestions.length === 0 ? (
            aiFailed ? (
              // Sem IA não dá pra dizer que está tudo limpo.
              <div className="px-4 py-6 text-center">
                <AlertTriangle className="w-6 h-6 text-amber-500 mx-auto mb-2" />
                <p className="text-sm font-medium">
                  {doneMsg || removedOutside > 0
                    ? 'O que a checagem automática apontou já foi resolvido'
                    : 'A checagem automática não apontou nada'}
                </p>
                <p className="text-[11px] text-muted-foreground mt-0.5">
                  A IA não conferiu as memórias desta vez, então pode ter coisa fora do lugar. Revise de novo.
                </p>
              </div>
            ) : (
              <div className="px-4 py-6 text-center">
                <CheckCircle2 className="w-6 h-6 text-emerald-500 mx-auto mb-2" />
                <p className="text-sm font-medium">
                  {aiPartial ? 'Nada a limpar no que foi conferido' : 'Nada a limpar'}
                </p>
                <p className="text-[11px] text-muted-foreground mt-0.5">
                  {doneMsg || removedOutside > 0
                    ? 'O que a revisão apontou já foi resolvido.'
                    : reviewed === 0
                      ? 'Não há memórias ativas pra revisar.'
                      : aiPartial
                        ? 'A IA não achou nada nas memórias que conferiu.'
                        : 'A IA não encontrou nada fora do lugar.'}
                </p>
              </div>
            )
          ) : (
            <>
              <div
                className={`px-4 py-2 flex items-center gap-3 border-b border-border ${hasNotices ? 'border-t mt-2' : ''}`}
              >
                <label className="inline-flex items-center gap-2 text-[11px] text-muted-foreground cursor-pointer select-none">
                  <input type="checkbox" checked={allSelected} onChange={toggleAll} className="accent-primary" />
                  {allSelected ? 'Desmarcar todas' : 'Marcar todas'}
                </label>
              </div>

              <div className="max-h-[480px] overflow-y-auto">
                {suggestions.map((s) => {
                  const kind = memoryReviewKind(s.kind);
                  const checked = selected.has(s.id);
                  const staleNote = staleNotes.get(s.id);
                  return (
                    <label
                      key={s.id}
                      className={`flex items-start gap-3 px-4 py-3 border-b border-border last:border-b-0 cursor-pointer transition-colors hover:bg-foreground/[0.03] ${
                        checked ? '' : 'opacity-60'
                      }`}
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => toggleOne(s.id)}
                        className="mt-1 accent-primary shrink-0"
                      />
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap mb-1">
                          <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded-full border ${kind.cls}`}>
                            {kind.label}
                          </span>
                          <span className="text-[10px] text-muted-foreground">{orgMemoryLabel(s.subcategory)}</span>
                        </div>
                        <p className="text-sm text-foreground break-words">{s.content}</p>
                        {s.reason && <p className="text-[11px] text-muted-foreground mt-1">{s.reason}</p>}
                        {staleNote && (
                          <p className="text-[11px] text-amber-700 dark:text-amber-400 mt-1">{staleNote}</p>
                        )}
                      </div>
                    </label>
                  );
                })}
              </div>

              {/* Ação: arquivar (com confirmação na própria tela) */}
              <div className="px-4 py-3 border-t border-border bg-background/40">
                {archiveError && (
                  <div className="mb-2 px-3 py-2 rounded-lg text-sm flex items-center gap-2 bg-red-500/10 text-red-600 dark:text-red-400 border border-red-500/20">
                    <AlertCircle className="w-4 h-4 shrink-0" />
                    {archiveError}
                  </div>
                )}
                {confirming ? (
                  <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
                    <p className="text-xs text-foreground">
                      Arquivar {memoriasN(selectedCount)}? {archiveEffectText(summaryState, selectedCount)}{' '}
                      <span className="text-muted-foreground">Arquivar não apaga: dá pra restaurar em Ver arquivadas.</span>
                    </p>
                    <div className="flex items-center justify-end gap-2 shrink-0">
                      <button
                        onClick={() => setConfirming(false)}
                        disabled={archiving}
                        className="px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground disabled:opacity-50"
                      >
                        Cancelar
                      </button>
                      <button
                        onClick={archiveSelected}
                        disabled={archiving || selectedCount === 0}
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-primary text-primary-foreground text-xs font-medium hover:bg-primary/90 disabled:opacity-50"
                      >
                        {archiving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Archive className="w-3.5 h-3.5" />}
                        Sim, arquivar
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="flex items-center justify-end">
                    <button
                      onClick={() => {
                        setArchiveError(null);
                        setConfirming(true);
                      }}
                      disabled={selectedCount === 0}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-primary text-primary-foreground text-xs font-medium hover:bg-primary/90 disabled:opacity-50"
                    >
                      <Archive className="w-3.5 h-3.5" />
                      Arquivar selecionadas ({selectedCount})
                    </button>
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      )}

      {/* Arquivadas */}
      {archivedOpen && (
        <div className="border-t border-border">
          <button
            onClick={() => {
              setRestoreNote(null);
              setArchivedOpen(false);
            }}
            className="w-full px-4 py-2 flex items-center gap-2 text-left hover:bg-foreground/[0.03] transition-colors"
          >
            <ChevronDown className="w-4 h-4 text-muted-foreground" />
            <span className="text-xs font-medium">Arquivadas</span>
            {!archivedLoading && <span className="text-xs text-muted-foreground">({archived.length})</span>}
            <span className="text-[11px] text-muted-foreground">— fora da base; dá pra restaurar</span>
          </button>
          <div className="border-t border-border bg-foreground/[0.02]">
            {archivedError && (
              <div className="mx-4 my-3 px-3 py-2 rounded-lg text-sm flex items-center gap-2 bg-red-500/10 text-red-600 dark:text-red-400 border border-red-500/20">
                <AlertCircle className="w-4 h-4 shrink-0" />
                <span className="flex-1">{archivedError}</span>
                <button onClick={loadArchived} className="text-xs font-medium hover:underline">
                  Tentar de novo
                </button>
              </div>
            )}
            {restoreNote && (
              <div className="mx-4 my-3 space-y-2">
                <div className="px-3 py-2 rounded-lg text-sm flex items-center gap-2 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border border-emerald-500/20">
                  <CheckCircle2 className="w-4 h-4 shrink-0" />
                  <span className="flex-1">{restoreNote.text}</span>
                  <button
                    onClick={() => setRestoreNote(null)}
                    className="p-0.5 rounded hover:bg-emerald-500/10"
                    title="Fechar aviso"
                    aria-label="Fechar aviso"
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                </div>
                {restoreNote.summary && <SummaryNoteBox note={restoreNote.summary} />}
              </div>
            )}
            {archivedLoading ? (
              <div className="px-4 py-6 flex items-center justify-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="w-4 h-4 animate-spin" />
                Carregando arquivadas…
              </div>
            ) : archived.length === 0 && !archivedError ? (
              <div className="px-4 py-6 text-center text-sm text-muted-foreground">Nenhuma memória arquivada.</div>
            ) : (
              <div className="max-h-[420px] overflow-y-auto">
                {archived.map((m) => {
                  const busy = restoring.has(m.id);
                  return (
                    <div
                      key={m.id}
                      className="px-4 py-3 border-b border-border last:border-b-0 flex items-start gap-3 hover:bg-foreground/[0.03] transition-colors"
                    >
                      <div className="flex-1 min-w-0">
                        <p className="text-sm text-muted-foreground break-words">{m.content}</p>
                        <div className="flex items-center gap-3 mt-1 text-[10px] text-muted-foreground">
                          <span>{orgMemoryLabel(m.subcategory ?? m.group)}</span>
                          {formatDay(m.updated_at) && (
                            <>
                              <span>•</span>
                              <span>{formatDay(m.updated_at)}</span>
                            </>
                          )}
                        </div>
                      </div>
                      <button
                        onClick={() => restoreOne(m.id)}
                        disabled={busy}
                        className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs text-primary hover:bg-primary/10 disabled:opacity-50 shrink-0"
                      >
                        {busy ? (
                          <Loader2 className="w-3.5 h-3.5 animate-spin" />
                        ) : (
                          <ArchiveRestore className="w-3.5 h-3.5" />
                        )}
                        Restaurar
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

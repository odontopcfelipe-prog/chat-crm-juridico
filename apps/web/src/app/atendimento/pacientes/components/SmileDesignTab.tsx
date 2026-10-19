'use client';

/**
 * Smile Design — a IA melhora SÓ o sorriso do paciente numa foto, pra
 * apresentar o resultado antes de fechar o tratamento.
 *
 * Fluxo: foto → dentista marca a boca → escolhe tratamento e cor → a API manda
 * pro modelo de edição de imagem (OpenAI) → a tela "cola" o resultado só dentro
 * da boca marcada (o resto do rosto fica idêntico) → apresentar / baixar.
 */

import { useCallback, useEffect, useId, useRef, useState } from 'react';
import {
  Sparkles, Loader2, Upload, X, Plus, AlertTriangle, Trash2, Image as ImgIcon,
  Maximize2, Download, RefreshCw, Columns2, MoveHorizontal, Film,
} from 'lucide-react';
import toast from 'react-hot-toast';
import api from '@/lib/api';
import { showError, showSuccess } from '@/lib/toast';
import {
  SmileRegion, buildBeforeAfterVideo, buildSideBySide, canvasToBlob, composeAfter, downloadBlob, loadImage,
  prepareUpload,
} from './smile-design-canvas';

interface PresentPayload {
  before: string;
  after: string;
  download: () => void;
  downloadVideo: () => void;
}

/** Um vídeo por vez (é gravado em tempo real, ~9 s). */
let videoInProgress = false;

interface Simulation {
  id: string;
  simulation_type: string;
  status: string;
  before_s3_key: string;
  after_s3_key: string | null;
  prompt: string | null;
  notes: string | null;
  patient_consent: boolean;
  patient_consent_at: string | null;
  provider: string;
  provider_metadata?: {
    treatment?: string;
    shade?: string;
    region?: SmileRegion | null;
    model?: string;
  } | null;
  error_message: string | null;
  created_at: string;
  created_by?: { id: string; name: string } | null;
}

const TREATMENTS = [
  { value: 'COMPLETO', label: 'Transformação completa', hint: 'Lentes / facetas — sorriso ideal' },
  { value: 'CLAREAMENTO', label: 'Clareamento', hint: 'Os mesmos dentes, mais brancos' },
  { value: 'ALINHAMENTO', label: 'Alinhamento', hint: 'Ortodontia / alinhadores' },
  { value: 'REABILITACAO', label: 'Reabilitação', hint: 'Repõe dentes ausentes ou quebrados' },
];

const SHADES = [
  { value: 'NATURAL', label: 'Natural', sub: 'A1', swatch: '#efe6d2' },
  { value: 'BRANCO', label: 'Branco', sub: 'BL2', swatch: '#f6f4ec' },
  { value: 'EXTRA', label: 'Extra branco', sub: 'BL1', swatch: '#ffffff' },
];

const labelOf = (list: { value: string; label: string }[], v?: string) =>
  list.find((x) => x.value === v)?.label;

const STATUS_CFG: Record<string, { label: string; cls: string }> = {
  PROCESSING: { label: 'Gerando…', cls: 'bg-amber-500/10 text-amber-700 border-amber-500/20' },
  DONE: { label: 'Pronta', cls: 'bg-green-500/10 text-green-700 border-green-500/20' },
  FAILED: { label: 'Falhou', cls: 'bg-destructive/10 text-destructive border-destructive/20' },
};

const errMsg = (err: unknown, fallback: string) => {
  const m = (err as { response?: { data?: { message?: string | string[] } } })?.response?.data?.message;
  return (Array.isArray(m) ? m.join(', ') : m) || fallback;
};

export default function SmileDesignTab({ patientId }: { patientId: string }) {
  const [loading, setLoading] = useState(true);
  const [sims, setSims] = useState<Simulation[]>([]);
  const [configured, setConfigured] = useState(true);
  const [openNew, setOpenNew] = useState(false);
  const [variationOf, setVariationOf] = useState<Simulation | null>(null);
  const [presenting, setPresenting] = useState<PresentPayload | null>(null);

  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      const { data } = await api.get<Simulation[]>(`/patients/${patientId}/smile-simulations`);
      setSims(data || []);
    } catch (err) {
      if (!silent) showError(errMsg(err, 'Erro ao carregar as simulações'));
    } finally {
      if (!silent) setLoading(false);
    }
  }, [patientId]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    api.get<{ configured: boolean }>('/smile-design/status')
      .then(({ data }) => setConfigured(data?.configured !== false))
      .catch(() => setConfigured(true));
  }, []);

  // Enquanto alguma estiver gerando, atualiza a lista sozinha.
  const processing = sims.some((s) => s.status === 'PROCESSING');
  useEffect(() => {
    if (!processing) return;
    const t = setInterval(() => load(true), 4000);
    return () => clearInterval(t);
  }, [processing, load]);

  const remove = async (id: string) => {
    if (!confirm('Excluir esta simulação?')) return;
    try {
      await api.delete(`/smile-simulations/${id}`);
      showSuccess('Simulação excluída');
      load(true);
    } catch (err) {
      showError(errMsg(err, 'Erro ao excluir'));
    }
  };

  return (
    <div>
      <div className="flex items-start justify-between mb-3 gap-3 flex-wrap">
        <div>
          <h3 className="font-semibold text-foreground flex items-center gap-2">
            <Sparkles size={16} className="text-primary" /> Smile Design
          </h3>
          <p className="text-xs text-muted-foreground mt-1">
            A IA melhora só o sorriso do paciente na foto — o resto do rosto fica igual.
            Use para mostrar o resultado antes de fechar o tratamento.
          </p>
        </div>
        <button
          onClick={() => setOpenNew(true)}
          disabled={!configured}
          className="inline-flex items-center gap-1 px-3 py-2 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 disabled:opacity-50"
        >
          <Plus size={14} /> Nova simulação
        </button>
      </div>

      {!configured && (
        <div className="bg-destructive/10 border border-destructive/20 rounded-lg p-3 mb-3 text-xs text-destructive">
          A IA de imagem ainda não está configurada. Cadastre a chave da OpenAI em <strong>Ajustes › IA</strong>.
        </div>
      )}

      <div className="bg-amber-500/10 border border-amber-500/20 rounded-lg px-3 py-2 mb-4 flex items-start gap-2 text-xs text-amber-700 dark:text-amber-400">
        <AlertTriangle size={14} className="shrink-0 mt-0.5" />
        <p>
          <strong>As imagens são simulações</strong>, não garantia de resultado (CFO, Res. 118/2012).
          Apresente sempre ao paciente nesse contexto.
        </p>
      </div>

      {loading ? (
        <div className="p-12 flex items-center justify-center text-muted-foreground">
          <Loader2 size={20} className="animate-spin mr-2" /> Carregando...
        </div>
      ) : sims.length === 0 ? (
        <div className="p-12 text-center text-sm text-muted-foreground bg-card border border-border rounded-xl">
          <ImgIcon size={28} className="mx-auto mb-2 opacity-40" />
          <p>Nenhuma simulação criada para este paciente.</p>
          <p className="text-xs mt-1">Clique em &quot;Nova simulação&quot; e envie uma foto de frente, sorrindo.</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
          {sims.map((s) => (
            <SimulationCard
              key={s.id}
              sim={s}
              onRemove={() => remove(s.id)}
              onVariation={() => setVariationOf(s)}
              onPresent={setPresenting}
            />
          ))}
        </div>
      )}

      {openNew && (
        <NewSimulationModal
          patientId={patientId}
          onClose={() => setOpenNew(false)}
          onCreated={() => { setOpenNew(false); load(true); }}
        />
      )}

      {variationOf && (
        <VariationModal
          sim={variationOf}
          onClose={() => setVariationOf(null)}
          onCreated={() => { setVariationOf(null); load(true); }}
        />
      )}

      {presenting && (
        <PresentModal
          before={presenting.before}
          after={presenting.after}
          onDownload={presenting.download}
          onDownloadVideo={presenting.downloadVideo}
          onClose={() => setPresenting(null)}
        />
      )}
    </div>
  );
}

// ─── Imagens de uma simulação (blob autenticado + "colagem" só na boca) ──────

interface SimImages {
  beforeUrl?: string;
  afterUrl?: string;
  beforeImg?: HTMLImageElement;
  afterEl?: HTMLCanvasElement | HTMLImageElement;
  error?: string;
}

function useSimImages(sim: Simulation): SimImages {
  const [state, setState] = useState<SimImages>({});
  const done = sim.status === 'DONE' && !!sim.after_s3_key;
  const region = sim.provider_metadata?.region || null;
  const regionKey = region ? JSON.stringify(region) : '';

  useEffect(() => {
    let cancelled = false;
    const urls: string[] = [];
    const fetchUrl = async (kind: 'before' | 'after') => {
      const res = await api.get(`/smile-simulations/${sim.id}/image/${kind}`, { responseType: 'blob' });
      const url = URL.createObjectURL(res.data as Blob);
      urls.push(url);
      return url;
    };
    (async () => {
      try {
        const beforeUrl = await fetchUrl('before');
        const beforeImg = await loadImage(beforeUrl);
        if (cancelled) return;
        if (!done) { setState({ beforeUrl, beforeImg }); return; }
        const afterImg = await loadImage(await fetchUrl('after'));
        // Sempre no tamanho da foto original (o slider sobrepõe as duas).
        const r: SmileRegion | null = regionKey ? JSON.parse(regionKey) : null;
        const composed = composeAfter(beforeImg, afterImg, r);
        const afterUrl = URL.createObjectURL(await canvasToBlob(composed, 'image/jpeg', 0.94));
        urls.push(afterUrl);
        if (!cancelled) setState({ beforeUrl, beforeImg, afterUrl, afterEl: composed });
      } catch {
        if (!cancelled) setState({ error: 'Não foi possível carregar a imagem' });
      }
    })();
    return () => {
      cancelled = true;
      urls.forEach((u) => URL.revokeObjectURL(u));
    };
  }, [sim.id, done, regionKey]);

  return state;
}

function SimulationCard({
  sim, onRemove, onVariation, onPresent,
}: {
  sim: Simulation;
  onRemove: () => void;
  onVariation: () => void;
  onPresent: (p: PresentPayload) => void;
}) {
  const img = useSimImages(sim);
  const cfg = STATUS_CFG[sim.status] || STATUS_CFG.PROCESSING;
  const meta = sim.provider_metadata || {};
  const title = sim.simulation_type === 'SMILE'
    ? [labelOf(TREATMENTS, meta.treatment) || 'Smile Design', labelOf(SHADES, meta.shade)].filter(Boolean).join(' · ')
    : sim.simulation_type;
  const ready = sim.status === 'DONE' && !!img.afterUrl && !!img.beforeUrl;

  const download = async () => {
    if (!img.beforeImg || !img.afterEl) return;
    try {
      const blob = await buildSideBySide(img.beforeImg, img.afterEl);
      downloadBlob(blob, `smile-design-${sim.created_at.slice(0, 10)}.jpg`);
    } catch {
      showError('Não foi possível montar a imagem');
    }
  };

  const [videoBusy, setVideoBusy] = useState(false);
  const downloadVideo = async () => {
    if (!img.beforeImg || !img.afterEl) return;
    if (videoInProgress) { showError('Já tem um vídeo sendo gerado — aguarde terminar'); return; }
    videoInProgress = true;
    setVideoBusy(true);
    const id = toast.loading('Gerando vídeo… 0% (deixe esta aba aberta)');
    let shown = 0;
    try {
      const { blob, ext } = await buildBeforeAfterVideo(img.beforeImg, img.afterEl, (p) => {
        const pct = Math.floor(p * 10) * 10;
        if (pct > shown) { shown = pct; toast.loading(`Gerando vídeo… ${pct}% (deixe esta aba aberta)`, { id }); }
      });
      downloadBlob(blob, `smile-design-${sim.created_at.slice(0, 10)}.${ext}`);
      toast.success(ext === 'mp4' ? 'Vídeo pronto' : 'Vídeo pronto (formato WebM — este navegador não grava MP4)', { id });
    } catch (e) {
      toast.error((e as Error)?.message || 'Não foi possível gerar o vídeo', { id });
    } finally {
      videoInProgress = false;
      setVideoBusy(false);
    }
  };

  return (
    <div className="bg-card border border-border rounded-xl overflow-hidden">
      <div className="px-3 py-2 border-b border-border flex items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="text-sm font-semibold truncate">{title}</p>
          <p className="text-[10px] text-muted-foreground">
            {new Date(sim.created_at).toLocaleString('pt-BR', {
              day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit',
            })}
            {sim.created_by && ` · ${sim.created_by.name}`}
          </p>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <span className={`text-[10px] px-2 py-0.5 rounded border ${cfg.cls}`}>{cfg.label}</span>
          <button onClick={onRemove} className="p-1 rounded hover:bg-destructive/10 text-destructive" title="Excluir">
            <Trash2 size={12} />
          </button>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-px bg-border">
        <div className="bg-muted/30 relative min-h-[140px]">
          {img.beforeUrl ? (
            <img src={img.beforeUrl} alt="Antes" className="w-full h-auto block" />
          ) : (
            <div className="w-full h-full min-h-[140px] flex items-center justify-center">
              {img.error
                ? <p className="text-xs text-muted-foreground p-3 text-center">{img.error}</p>
                : <Loader2 size={18} className="animate-spin text-muted-foreground" />}
            </div>
          )}
          <span className="absolute top-1 left-1 bg-black/60 text-white text-[10px] px-1.5 py-0.5 rounded">ANTES</span>
        </div>
        <div className="bg-muted/30 relative min-h-[140px]">
          {sim.status === 'DONE' && img.afterUrl ? (
            <>
              <img src={img.afterUrl} alt="Simulação" className="w-full h-auto block" />
              <span className="absolute top-1 left-1 bg-primary text-primary-foreground text-[10px] px-1.5 py-0.5 rounded font-bold">
                SIMULAÇÃO
              </span>
            </>
          ) : sim.status === 'FAILED' ? (
            <div className="w-full h-full flex flex-col items-center justify-center text-center p-3 gap-2">
              <p className="text-xs text-destructive [overflow-wrap:anywhere]">{sim.error_message || 'Erro desconhecido'}</p>
              <button
                onClick={onVariation}
                className="inline-flex items-center gap-1 text-xs px-2 py-1 rounded border border-border hover:bg-accent"
              >
                <RefreshCw size={12} /> Gerar de novo
              </button>
            </div>
          ) : (
            <div className="w-full h-full flex flex-col items-center justify-center gap-2 p-3 text-center">
              <Loader2 size={22} className="animate-spin text-primary" />
              <p className="text-[11px] text-muted-foreground">Criando o novo sorriso…<br />leva até 2 minutos</p>
            </div>
          )}
        </div>
      </div>

      {(sim.prompt || sim.notes) && (
        <div className="px-3 py-2 text-xs space-y-1 border-t border-border">
          {sim.prompt && <p><strong>Pedido:</strong> {sim.prompt}</p>}
          {sim.notes && <p className="text-muted-foreground italic">{sim.notes}</p>}
        </div>
      )}

      {sim.status === 'DONE' && (
        <div className="px-3 py-2 border-t border-border flex items-center gap-2 flex-wrap">
          <button
            disabled={!ready}
            onClick={() => img.beforeUrl && img.afterUrl && onPresent({ before: img.beforeUrl, after: img.afterUrl, download, downloadVideo })}
            className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-primary text-primary-foreground text-xs font-medium hover:bg-primary/90 disabled:opacity-50"
          >
            <Maximize2 size={12} /> Apresentar
          </button>
          <button
            disabled={!ready}
            onClick={download}
            className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg border border-border text-xs font-medium hover:bg-accent disabled:opacity-50"
          >
            <Download size={12} /> Baixar antes/depois
          </button>
          <button
            disabled={!ready || videoBusy}
            onClick={downloadVideo}
            className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg border border-border text-xs font-medium hover:bg-accent disabled:opacity-50"
          >
            {videoBusy ? <Loader2 size={12} className="animate-spin" /> : <Film size={12} />} Baixar vídeo
          </button>
          <button
            onClick={onVariation}
            className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg border border-border text-xs font-medium hover:bg-accent"
          >
            <RefreshCw size={12} /> Outra versão
          </button>
          {sim.provider === 'mock' && (
            <span className="text-[10px] text-amber-700">Modo de teste: a imagem não foi alterada.</span>
          )}
          {meta.model && sim.provider !== 'mock' && (
            <span className="ml-auto text-[10px] text-muted-foreground" title="Modelo de IA que gerou">{meta.model}</span>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Apresentação para o paciente (deslizar antes ↔ depois) ──────────────────

function PresentModal({
  before, after, onDownload, onDownloadVideo, onClose,
}: { before: string; after: string; onDownload: () => void; onDownloadVideo: () => void; onClose: () => void }) {
  const [pos, setPos] = useState(50);
  const [mode, setMode] = useState<'slider' | 'side'>('slider');
  const boxRef = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const moveTo = (clientX: number) => {
    const r = boxRef.current?.getBoundingClientRect();
    if (!r) return;
    setPos(Math.min(100, Math.max(0, ((clientX - r.left) / r.width) * 100)));
  };

  return (
    <div className="fixed inset-0 z-[110] bg-black/95 flex flex-col" onClick={onClose}>
      <div className="flex items-center justify-between gap-2 p-3 text-white" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-1 bg-white/10 rounded-lg p-0.5">
          <button
            onClick={() => setMode('slider')}
            className={`inline-flex items-center gap-1 px-2.5 py-1.5 rounded-md text-xs ${mode === 'slider' ? 'bg-white text-black' : 'text-white/80 hover:text-white'}`}
          >
            <MoveHorizontal size={13} /> Deslizar
          </button>
          <button
            onClick={() => setMode('side')}
            className={`inline-flex items-center gap-1 px-2.5 py-1.5 rounded-md text-xs ${mode === 'side' ? 'bg-white text-black' : 'text-white/80 hover:text-white'}`}
          >
            <Columns2 size={13} /> Lado a lado
          </button>
        </div>
        <div className="flex items-center gap-1">
          <button onClick={onDownload} className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-md text-xs text-white/90 hover:bg-white/10">
            <Download size={13} /> Imagem
          </button>
          <button onClick={onDownloadVideo} className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-md text-xs text-white/90 hover:bg-white/10">
            <Film size={13} /> Vídeo
          </button>
          <button onClick={onClose} className="p-1.5 rounded-md hover:bg-white/10" title="Fechar (Esc)">
            <X size={18} />
          </button>
        </div>
      </div>

      <div className="flex-1 min-h-0 flex items-center justify-center px-3" onClick={(e) => e.stopPropagation()}>
        {mode === 'slider' ? (
          <div
            ref={boxRef}
            className="relative select-none touch-none cursor-ew-resize max-w-full"
            onPointerDown={(e) => { dragging.current = true; (e.target as Element).setPointerCapture?.(e.pointerId); moveTo(e.clientX); }}
            onPointerMove={(e) => { if (dragging.current) moveTo(e.clientX); }}
            onPointerUp={() => { dragging.current = false; }}
            onPointerCancel={() => { dragging.current = false; }}
          >
            <img src={after} alt="Simulação" draggable={false} className="block max-h-[calc(100vh-130px)] max-w-full w-auto" />
            <img
              src={before}
              alt="Antes"
              draggable={false}
              className="absolute inset-0 w-full h-full"
              style={{ clipPath: `inset(0 ${100 - pos}% 0 0)` }}
            />
            <div className="absolute top-0 bottom-0 w-0.5 bg-white shadow-[0_0_8px_rgba(0,0,0,0.6)]" style={{ left: `${pos}%` }}>
              <div className="absolute top-1/2 -translate-y-1/2 -translate-x-1/2 left-1/2 w-9 h-9 rounded-full bg-white text-black flex items-center justify-center shadow-lg">
                <MoveHorizontal size={16} />
              </div>
            </div>
            <span className="absolute top-2 left-2 bg-black/60 text-white text-xs px-2 py-1 rounded font-semibold">ANTES</span>
            <span className="absolute top-2 right-2 bg-primary text-primary-foreground text-xs px-2 py-1 rounded font-semibold">SIMULAÇÃO</span>
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-2 max-w-full max-h-full">
            {[{ src: before, tag: 'ANTES', cls: 'bg-black/60 text-white' }, { src: after, tag: 'SIMULAÇÃO', cls: 'bg-primary text-primary-foreground' }].map((x) => (
              <div key={x.tag} className="relative">
                <img src={x.src} alt={x.tag} className="block max-h-[calc(100vh-130px)] w-full object-contain" />
                <span className={`absolute top-2 left-2 text-xs px-2 py-1 rounded font-semibold ${x.cls}`}>{x.tag}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      <p className="text-center text-[11px] text-white/60 p-2">
        Simulação ilustrativa gerada por IA — não é garantia de resultado (CFO, Res. 118/2012).
      </p>
    </div>
  );
}

// ─── Opções compartilhadas (tratamento, cor, pedido) ─────────────────────────

function OptionsFields({
  treatment, setTreatment, shade, setShade, prompt, setPrompt,
}: {
  treatment: string; setTreatment: (v: string) => void;
  shade: string; setShade: (v: string) => void;
  prompt: string; setPrompt: (v: string) => void;
}) {
  return (
    <>
      <div>
        <label className="block text-xs font-medium mb-1.5">O que simular</label>
        <div className="grid grid-cols-2 gap-2">
          {TREATMENTS.map((t) => (
            <button
              key={t.value}
              type="button"
              onClick={() => setTreatment(t.value)}
              className={`text-left px-3 py-2 rounded-lg border text-sm transition-colors ${treatment === t.value
                ? 'border-primary bg-primary/10 ring-1 ring-primary'
                : 'border-border hover:bg-accent'}`}
            >
              <span className="font-medium block">{t.label}</span>
              <span className="text-[11px] text-muted-foreground">{t.hint}</span>
            </button>
          ))}
        </div>
      </div>

      <div>
        <label className="block text-xs font-medium mb-1.5">Cor dos dentes</label>
        <div className="flex gap-2">
          {SHADES.map((s) => (
            <button
              key={s.value}
              type="button"
              onClick={() => setShade(s.value)}
              className={`flex-1 flex items-center gap-2 px-2.5 py-2 rounded-lg border text-sm ${shade === s.value
                ? 'border-primary bg-primary/10 ring-1 ring-primary'
                : 'border-border hover:bg-accent'}`}
            >
              <span className="w-5 h-5 rounded-full border border-black/15 shrink-0" style={{ background: s.swatch }} />
              <span className="text-left leading-tight">
                <span className="block font-medium text-xs">{s.label}</span>
                <span className="block text-[10px] text-muted-foreground">{s.sub}</span>
              </span>
            </button>
          ))}
        </div>
      </div>

      <div>
        <label className="block text-xs font-medium mb-1">Pedido extra para a IA (opcional)</label>
        <input
          type="text"
          value={prompt}
          maxLength={300}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder="Ex.: fechar o espaço entre os dentes da frente, dentes um pouco mais longos..."
          className="w-full px-3 py-2 rounded-lg bg-background border border-border text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
        />
      </div>
    </>
  );
}

// ─── Marcar a boca na foto (arrasta → elipse) ───────────────────────────────

function RegionPicker({
  src, region, onChange,
}: { src: string; region: SmileRegion | null; onChange: (r: SmileRegion | null) => void }) {
  const boxRef = useRef<HTMLDivElement>(null);
  const start = useRef<{ x: number; y: number } | null>(null);
  const maskId = useId().replace(/:/g, '');

  const norm = (e: React.PointerEvent) => {
    const r = boxRef.current!.getBoundingClientRect();
    const clamp = (n: number) => Math.min(1, Math.max(0, n));
    return { x: clamp((e.clientX - r.left) / r.width), y: clamp((e.clientY - r.top) / r.height) };
  };
  const fromDrag = (a: { x: number; y: number }, b: { x: number; y: number }): SmileRegion => ({
    cx: (a.x + b.x) / 2,
    cy: (a.y + b.y) / 2,
    rx: Math.abs(b.x - a.x) / 2,
    ry: Math.abs(b.y - a.y) / 2,
  });

  return (
    <div className="flex justify-center bg-muted/40 rounded-lg p-2">
      <div
        ref={boxRef}
        className="relative inline-block select-none touch-none cursor-crosshair"
        onPointerDown={(e) => {
          (e.target as Element).setPointerCapture?.(e.pointerId);
          start.current = norm(e);
        }}
        onPointerMove={(e) => {
          if (!start.current) return;
          onChange(fromDrag(start.current, norm(e)));
        }}
        onPointerUp={(e) => {
          if (!start.current) return;
          const r = fromDrag(start.current, norm(e));
          start.current = null;
          onChange(r.rx < 0.02 || r.ry < 0.01 ? null : r);
        }}
      >
        <img src={src} alt="Foto" draggable={false} className="block max-h-[42vh] max-w-full w-auto rounded" />
        {region && (
          <svg className="absolute inset-0 w-full h-full pointer-events-none" viewBox="0 0 100 100" preserveAspectRatio="none">
            <defs>
              <mask id={maskId}>
                <rect width="100" height="100" fill="white" />
                <ellipse cx={region.cx * 100} cy={region.cy * 100} rx={region.rx * 100} ry={region.ry * 100} fill="black" />
              </mask>
            </defs>
            <rect width="100" height="100" fill="rgba(0,0,0,0.45)" mask={`url(#${maskId})`} />
            <ellipse
              cx={region.cx * 100} cy={region.cy * 100} rx={region.rx * 100} ry={region.ry * 100}
              fill="none" stroke="#22c55e" strokeWidth="2" strokeDasharray="6 4" vectorEffect="non-scaling-stroke"
            />
          </svg>
        )}
      </div>
    </div>
  );
}

// ─── Nova simulação ──────────────────────────────────────────────────────────

function NewSimulationModal({
  patientId, onClose, onCreated,
}: { patientId: string; onClose: () => void; onCreated: () => void }) {
  const [saving, setSaving] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [region, setRegion] = useState<SmileRegion | null>(null);
  const [treatment, setTreatment] = useState('COMPLETO');
  const [shade, setShade] = useState('NATURAL');
  const [prompt, setPrompt] = useState('');
  const [consent, setConsent] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => () => { if (preview) URL.revokeObjectURL(preview); }, [preview]);

  const onFile = (f: File | null) => {
    if (f && !f.type.startsWith('image/')) { showError('Escolha uma imagem (JPG ou PNG)'); return; }
    setFile(f);
    setRegion(null);
    setPreview(f ? URL.createObjectURL(f) : null);
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!file || !preview) { showError('Escolha uma foto'); return; }
    if (!consent) { showError('Confirme a autorização do paciente'); return; }
    if (!region && !confirm('Você não marcou a boca. Sem a marcação a IA pode alterar outras partes do rosto. Gerar mesmo assim?')) return;
    setSaving(true);
    try {
      const img = await loadImage(preview);
      const { photoBlob, maskBlob } = await prepareUpload(img, region);
      const fd = new FormData();
      fd.append('file', photoBlob, 'foto.png');
      if (maskBlob && region) {
        fd.append('mask', maskBlob, 'mascara.png');
        fd.append('region', JSON.stringify(region));
      }
      fd.append('simulation_type', 'SMILE');
      fd.append('treatment', treatment);
      fd.append('shade', shade);
      if (prompt.trim()) fd.append('prompt', prompt.trim());
      fd.append('patient_consent', 'true');
      await api.post(`/patients/${patientId}/smile-simulations`, fd, {
        headers: { 'Content-Type': 'multipart/form-data' },
      });
      showSuccess('Gerando a simulação — leva até 2 minutos');
      onCreated();
    } catch (err) {
      showError(errMsg(err, 'Erro ao enviar a foto'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[100] bg-black/50 backdrop-blur-sm flex items-center justify-center p-4" onClick={onClose}>
      <div
        className="bg-card border border-border rounded-xl w-full max-w-xl shadow-2xl max-h-[92vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between p-4 border-b border-border">
          <h2 className="text-lg font-semibold flex items-center gap-2">
            <Sparkles size={20} className="text-primary" /> Nova simulação de sorriso
          </h2>
          <button onClick={onClose} className="p-1 hover:bg-accent rounded"><X size={18} /></button>
        </div>

        <form onSubmit={submit} className="p-4 space-y-4 overflow-y-auto">
          <div>
            <div className="flex items-center justify-between mb-1.5">
              <label className="block text-xs font-medium">1. Foto do paciente</label>
              {preview && (
                <button type="button" onClick={() => fileRef.current?.click()} className="text-xs text-primary hover:underline">
                  Trocar foto
                </button>
              )}
            </div>
            {preview ? (
              <>
                <p className="text-xs text-muted-foreground mb-1.5">
                  <strong className="text-foreground">2. Marque o sorriso:</strong> arraste sobre a boca.
                  Só a área marcada muda — o resto do rosto fica idêntico.
                </p>
                <RegionPicker src={preview} region={region} onChange={setRegion} />
                {region ? (
                  <button type="button" onClick={() => setRegion(null)} className="text-xs text-muted-foreground hover:underline mt-1">
                    Limpar marcação
                  </button>
                ) : (
                  <p className="text-[11px] text-amber-700 mt-1">Nenhuma área marcada ainda.</p>
                )}
              </>
            ) : (
              <button
                type="button"
                onClick={() => fileRef.current?.click()}
                className="w-full border-2 border-dashed border-border rounded-lg p-6 text-center hover:bg-accent"
              >
                <Upload size={24} className="mx-auto mb-2 text-muted-foreground" />
                <p className="text-sm">Escolher ou tirar foto</p>
                <p className="text-xs text-muted-foreground mt-1">
                  De frente, sorrindo e mostrando os dentes, com boa luz e sem filtro.
                </p>
              </button>
            )}
            <input
              ref={fileRef}
              type="file"
              accept="image/*"
              onChange={(e) => { onFile(e.target.files?.[0] || null); e.target.value = ''; }}
              className="hidden"
            />
          </div>

          <OptionsFields
            treatment={treatment} setTreatment={setTreatment}
            shade={shade} setShade={setShade}
            prompt={prompt} setPrompt={setPrompt}
          />

          <label className="flex items-start gap-2 p-3 rounded-lg bg-amber-500/10 border border-amber-500/20 cursor-pointer">
            <input
              type="checkbox"
              checked={consent}
              onChange={(e) => setConsent(e.target.checked)}
              className="accent-amber-500 mt-0.5 shrink-0"
            />
            <span className="text-xs text-amber-700 dark:text-amber-400">
              O paciente <strong>autorizou</strong> o uso da foto e sabe que é uma simulação por IA,
              não garantia de resultado (CFO, Res. 118/2012).
            </span>
          </label>

          <div className="flex justify-end gap-2 pt-3 border-t border-border">
            <button type="button" onClick={onClose} className="px-4 py-2 rounded-lg border border-border text-sm font-medium hover:bg-accent">
              Cancelar
            </button>
            <button
              type="submit"
              disabled={saving || !file || !consent}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 disabled:opacity-50"
            >
              {saving ? <Loader2 size={16} className="animate-spin" /> : <Sparkles size={16} />}
              Gerar simulação
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ─── Outra versão (mesma foto e marcação) ───────────────────────────────────

function VariationModal({
  sim, onClose, onCreated,
}: { sim: Simulation; onClose: () => void; onCreated: () => void }) {
  const meta = sim.provider_metadata || {};
  const [treatment, setTreatment] = useState(meta.treatment || 'COMPLETO');
  const [shade, setShade] = useState(meta.shade || 'NATURAL');
  const [prompt, setPrompt] = useState(sim.prompt || '');
  const [saving, setSaving] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    try {
      await api.post(`/smile-simulations/${sim.id}/regenerate`, { treatment, shade, prompt: prompt.trim() });
      showSuccess('Gerando outra versão — leva até 2 minutos');
      onCreated();
    } catch (err) {
      showError(errMsg(err, 'Erro ao gerar'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[100] bg-black/50 backdrop-blur-sm flex items-center justify-center p-4" onClick={onClose}>
      <div
        className="bg-card border border-border rounded-xl w-full max-w-lg shadow-2xl max-h-[92vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between p-4 border-b border-border">
          <h2 className="text-lg font-semibold flex items-center gap-2">
            <RefreshCw size={18} className="text-primary" /> Outra versão
          </h2>
          <button onClick={onClose} className="p-1 hover:bg-accent rounded"><X size={18} /></button>
        </div>
        <form onSubmit={submit} className="p-4 space-y-4 overflow-y-auto">
          <p className="text-xs text-muted-foreground">
            Usa a mesma foto e a mesma marcação da boca. Ajuste o que quiser e gere de novo —
            a versão anterior continua salva.
          </p>
          <OptionsFields
            treatment={treatment} setTreatment={setTreatment}
            shade={shade} setShade={setShade}
            prompt={prompt} setPrompt={setPrompt}
          />
          <div className="flex justify-end gap-2 pt-3 border-t border-border">
            <button type="button" onClick={onClose} className="px-4 py-2 rounded-lg border border-border text-sm font-medium hover:bg-accent">
              Cancelar
            </button>
            <button
              type="submit"
              disabled={saving}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 disabled:opacity-50"
            >
              {saving ? <Loader2 size={16} className="animate-spin" /> : <Sparkles size={16} />}
              Gerar
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

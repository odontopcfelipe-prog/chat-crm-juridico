'use client';

/**
 * Editor da logo da clínica (Configurações › Identidade), no estilo da foto de
 * perfil do WhatsApp, com duas abas:
 *  - Enquadrar: arrastar pra posicionar, zoom (barra, botões ou rodinha) e
 *    "Recorte redondo" (cantos transparentes);
 *  - Fundo: remover o fundo POR COR (detecta sozinho pela borda ou conta-gotas;
 *    sensibilidade; opção de tirar também o miolo das letras) e escolher a cor
 *    que fica atrás da logo (transparente, cores prontas ou qualquer cor).
 * Gera PNG 512×512 — se ficar pesado, JPG com fundo branco. Sem dependência.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { X, ZoomIn, ZoomOut, RotateCcw, Check, Pipette, Crop, Eraser, Wand2 } from 'lucide-react';
import {
  estimateBorderColor, removeBackground, detectLogoBounds, padBounds, rgbToHex,
  type RGB, type LogoBounds,
} from '@/lib/logoBackground';

const VIEW = 288;            // lado do quadro de recorte na tela (px)
const OUT = 512;             // lado da logo final (px)
const WORK_MAX = 1600;       // lado máx. da imagem de trabalho da remoção de fundo
const MAX_CHARS = 500_000;   // teto do data URL (o servidor aceita até 400 KB de imagem)
const ZMIN = 1;              // 1 = imagem inteira cabendo no quadro
const ZMAX = 8;

/** Cores prontas pra ficar atrás da logo (null = transparente). */
const BG_SWATCHES: Array<{ color: string | null; label: string }> = [
  { color: null, label: 'Transparente' },
  { color: '#ffffff', label: 'Branco' },
  { color: '#000000', label: 'Preto' },
  { color: '#f5f0e6', label: 'Creme' },
  { color: '#12423a', label: 'Verde-escuro' },
  { color: '#0f766e', label: 'Verde-água' },
  { color: '#1e3a8a', label: 'Azul' },
  { color: '#7c3aed', label: 'Roxo' },
  { color: '#b91c1c', label: 'Vermelho' },
  { color: '#c9a227', label: 'Dourado' },
];

const CHECKER = {
  backgroundImage: 'linear-gradient(45deg,#e5e7eb 25%,transparent 25%),linear-gradient(-45deg,#e5e7eb 25%,transparent 25%),linear-gradient(45deg,transparent 75%,#e5e7eb 75%),linear-gradient(-45deg,transparent 75%,#e5e7eb 75%)',
  backgroundSize: '16px 16px',
  backgroundPosition: '0 0,0 8px,8px -8px,-8px 0',
  backgroundColor: '#fff',
} as const;

/** Margem em volta da logo no encaixe automático (protege contorno fino e claro). */
const FIT_MARGIN = 0.035;

interface Props {
  /** URL da imagem a ajustar (blob: do arquivo escolhido ou data: da logo atual). */
  src: string;
  /** Nome da clínica — só pra prévia da barra lateral. */
  clinicName?: string;
  onCancel: () => void;
  onConfirm: (dataUrl: string) => void;
}

interface WorkImage { w: number; h: number; base: Uint8ClampedArray }

export default function LogoCropModal({ src, clinicName, onCancel, onConfirm }: Props) {
  const [img, setImg] = useState<HTMLImageElement | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<'frame' | 'bg'>('frame');
  // Enquadrar
  const [zoom, setZoom] = useState(ZMIN);
  const [offset, setOffset] = useState({ x: 0, y: 0 }); // centro da imagem vs centro do quadro (px do quadro)
  const [round, setRound] = useState(false);
  const drag = useRef<{ px: number; py: number; ox: number; oy: number } | null>(null);
  // Fundo
  const [work, setWork] = useState<WorkImage | null>(null);
  const [bgError, setBgError] = useState<string | null>(null);
  const [bgRemove, setBgRemove] = useState(false);
  const [tolerance, setTolerance] = useState(30);
  const [refColor, setRefColor] = useState<RGB | null>(null); // null = automático (borda)
  const [everywhere, setEverywhere] = useState(false);
  const [picking, setPicking] = useState(false);
  const [processed, setProcessed] = useState<HTMLCanvasElement | null>(null);
  const [removedPct, setRemovedPct] = useState(0);
  const [bgColor, setBgColor] = useState<string | null>(null);
  const previewCanvasRef = useRef<HTMLCanvasElement>(null);
  // Encaixe automático (onde está a logo dentro da foto) + prévia da barra lateral.
  const [autoBounds, setAutoBounds] = useState<LogoBounds | null>(null);
  const [autoFitted, setAutoFitted] = useState(false);
  const autoFitFor = useRef<string | null>(null);
  const [sidebarPreview, setSidebarPreview] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    const el = new Image();
    el.onload = () => { if (alive) setImg(el); };
    el.onerror = () => { if (alive) setError('Não consegui abrir essa imagem — tente PNG ou JPG.'); };
    el.src = src;
    return () => { alive = false; };
  }, [src]);

  // Imagem de trabalho (pixels originais, no máx. WORK_MAX) pra remoção de fundo
  // e conta-gotas. Logo antiga vinda de link externo não deixa ler os pixels.
  useEffect(() => {
    if (!img) return;
    const s = Math.min(1, WORK_MAX / Math.max(img.naturalWidth || 1, img.naturalHeight || 1));
    const w = Math.max(1, Math.round((img.naturalWidth || 1) * s));
    const h = Math.max(1, Math.round((img.naturalHeight || 1) * s));
    try {
      const c = document.createElement('canvas');
      c.width = w;
      c.height = h;
      const ctx = c.getContext('2d', { willReadFrequently: true });
      if (!ctx) throw new Error('sem canvas');
      ctx.drawImage(img, 0, 0, w, h);
      setWork({ w, h, base: ctx.getImageData(0, 0, w, h).data });
      setBgError(null);
    } catch {
      setWork(null);
      setBgError('Não dá pra editar o fundo dessa logo aqui — envie o arquivo da imagem de novo.');
    }
  }, [img]);

  const autoRef: RGB | null = work ? estimateBorderColor(work.base, work.w, work.h) : null;
  const effectiveRef = refColor ?? autoRef;

  // Reprocessa a remoção de fundo (com um pequeno atraso enquanto arrasta a sensibilidade).
  useEffect(() => {
    if (!bgRemove || !work || !effectiveRef) { setProcessed(null); return; }
    const t = setTimeout(() => {
      const data = new Uint8ClampedArray(work.base);
      const removed = removeBackground(data, work.w, work.h, { ref: effectiveRef, tolerance, everywhere });
      const c = document.createElement('canvas');
      c.width = work.w;
      c.height = work.h;
      c.getContext('2d')?.putImageData(new ImageData(data, work.w, work.h), 0, 0);
      setRemovedPct(Math.round((removed / (work.w * work.h)) * 100));
      setProcessed(c);
    }, 90);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bgRemove, work, tolerance, everywhere, effectiveRef?.[0], effectiveRef?.[1], effectiveRef?.[2]]);

  // Copia o resultado pro canvas visível do quadro.
  useEffect(() => {
    const view = previewCanvasRef.current;
    if (!view || !processed) return;
    view.width = processed.width;
    view.height = processed.height;
    const ctx = view.getContext('2d');
    ctx?.clearRect(0, 0, view.width, view.height);
    ctx?.drawImage(processed, 0, 0);
  }, [processed]);

  // Fonte atual (imagem original ou com fundo removido) e suas dimensões.
  const usingProcessed = bgRemove && !!processed;
  const srcW = usingProcessed ? processed!.width : (img?.naturalWidth || 1);
  const srcH = usingProcessed ? processed!.height : (img?.naturalHeight || 1);
  // Escala base: imagem inteira cabendo no quadro ("contain").
  const base = VIEW / Math.max(srcW, srcH);
  const dims = (z: number) => ({ w: img ? srcW * base * z : 0, h: img ? srcH * base * z : 0 });
  const { w: dispW, h: dispH } = dims(zoom);
  const imgLeft = VIEW / 2 + offset.x - dispW / 2;
  const imgTop = VIEW / 2 + offset.y - dispH / 2;

  // Imagem maior que o quadro: não deixa aparecer borda vazia. Menor: não deixa sair.
  const clamp = useCallback((o: { x: number; y: number }, w: number, h: number) => {
    const lx = Math.abs(w - VIEW) / 2;
    const ly = Math.abs(h - VIEW) / 2;
    return { x: Math.max(-lx, Math.min(lx, o.x)), y: Math.max(-ly, Math.min(ly, o.y)) };
  }, []);

  const applyZoom = (next: number) => {
    const z = Math.max(ZMIN, Math.min(ZMAX, next));
    const { w, h } = dims(z);
    const ratio = z / zoom; // mantém o mesmo ponto da imagem no centro do quadro
    setOffset((o) => clamp({ x: o.x * ratio, y: o.y * ratio }, w, h));
    setZoom(z);
  };

  // Conta-gotas: lê a cor do pixel ORIGINAL sob o clique.
  const pickAt = (clientX: number, clientY: number, rect: DOMRect) => {
    if (!work) return;
    const u = (clientX - rect.left - imgLeft) / dispW;
    const v = (clientY - rect.top - imgTop) / dispH;
    if (u < 0 || u >= 1 || v < 0 || v >= 1) return;
    const i = (Math.floor(v * work.h) * work.w + Math.floor(u * work.w)) * 4;
    setRefColor([work.base[i], work.base[i + 1], work.base[i + 2]]);
    setBgRemove(true);
    setPicking(false);
  };

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!img) return;
    if (picking) { pickAt(e.clientX, e.clientY, e.currentTarget.getBoundingClientRect()); return; }
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { px: e.clientX, py: e.clientY, ox: offset.x, oy: offset.y };
  };
  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d) return;
    setOffset(clamp({ x: d.ox + (e.clientX - d.px), y: d.oy + (e.clientY - d.py) }, dispW, dispH));
  };
  const onPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    drag.current = null;
    try { e.currentTarget.releasePointerCapture(e.pointerId); } catch { /* já solto */ }
  };
  const onWheel = (e: React.WheelEvent<HTMLDivElement>) => {
    applyZoom(zoom * (e.deltaY < 0 ? 1.1 : 1 / 1.1));
  };

  const resetFrame = () => { setZoom(ZMIN); setOffset({ x: 0, y: 0 }); setAutoFitted(false); };
  const resetBg = () => { setBgRemove(false); setRefColor(null); setTolerance(30); setEverywhere(false); setPicking(false); setBgColor(null); };

  /** Enquadra a caixa da logo (em pixels da imagem de trabalho) preenchendo o
   *  quadro; logo redonda liga o recorte redondo. */
  const applyFit = (b: LogoBounds) => {
    if (!work) return;
    const d1W = srcW * base;           // tamanho na tela com zoom 1 ("caber inteiro")
    const d1H = srcH * base;
    const fx0 = b.x0 / work.w, fx1 = (b.x1 + 1) / work.w;
    const fy0 = b.y0 / work.h, fy1 = (b.y1 + 1) / work.h;
    const z = Math.max(ZMIN, Math.min(ZMAX, VIEW / Math.max((fx1 - fx0) * d1W, (fy1 - fy0) * d1H)));
    const dW = d1W * z;
    const dH = d1H * z;
    setZoom(z);
    setOffset(clamp({ x: -(((fx0 + fx1) / 2) - 0.5) * dW, y: -(((fy0 + fy1) / 2) - 0.5) * dH }, dW, dH));
    if (b.round) setRound(true);
    setAutoFitted(true);
  };

  // Ao abrir: acha a logo dentro da foto e já enquadra (1× por imagem).
  useEffect(() => {
    if (!work || !img || autoFitFor.current === src) return;
    autoFitFor.current = src;
    const found = detectLogoBounds(work.base, work.w, work.h, { ref: estimateBorderColor(work.base, work.w, work.h), tolerance: 30 });
    const padded = found ? padBounds(found, work.w, work.h, FIT_MARGIN) : null;
    setAutoBounds(padded);
    if (padded) applyFit(padded);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [work, img, src]);

  /** Monta a logo final num canvas size×size (mesma conta da tela, escalada). */
  const compose = (size: number, jpeg: boolean) => {
    if (!img) throw new Error('sem imagem');
    const source: CanvasImageSource = usingProcessed ? processed! : img;
    const k = size / VIEW;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Seu navegador não conseguiu processar a imagem.');
    // JPG não tem transparência: branco ANTES do recorte redondo (cantos brancos, não pretos).
    if (jpeg) { ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, size, size); }
    if (round) {
      ctx.beginPath();
      ctx.arc(size / 2, size / 2, size / 2, 0, Math.PI * 2);
      ctx.closePath();
      ctx.clip();
    }
    if (bgColor) { ctx.fillStyle = bgColor; ctx.fillRect(0, 0, size, size); }
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(source, imgLeft * k, imgTop * k, dispW * k, dispH * k);
    return canvas;
  };

  // Prévia ao vivo de como a logo fica na barra lateral.
  useEffect(() => {
    if (!img) return;
    const t = setTimeout(() => {
      try { setSidebarPreview(compose(96, false).toDataURL('image/png')); } catch { setSidebarPreview(null); }
    }, 60);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [img, processed, usingProcessed, zoom, offset.x, offset.y, round, bgColor]);

  const confirm = () => {
    if (!img) return;
    try {
      let out = compose(OUT, false).toDataURL('image/png');
      if (out.length > MAX_CHARS) out = compose(OUT, true).toDataURL('image/jpeg', 0.88);
      if (out.length > MAX_CHARS) {
        setError('Imagem muito pesada mesmo reduzida — use uma logo mais simples.');
        return;
      }
      onConfirm(out);
    } catch {
      // Logo antiga vinda de link externo: o navegador não deixa reprocessar.
      setError('Não dá pra ajustar essa logo aqui — envie o arquivo da imagem de novo.');
    }
  };

  if (typeof document === 'undefined') return null;
  const tabBtn = (id: 'frame' | 'bg', label: string, Icon: typeof Crop) => (
    <button
      type="button"
      onClick={() => { setTab(id); if (id === 'frame') setPicking(false); }}
      className={`flex-1 text-xs font-bold py-2 inline-flex items-center justify-center gap-1.5 border-b-2 transition-colors ${tab === id ? 'border-violet-600 text-violet-700 dark:text-violet-400' : 'border-transparent text-muted-foreground hover:text-foreground'}`}
    >
      <Icon size={13} />
      {label}
    </button>
  );

  return createPortal(
    <div className="fixed inset-0 z-[100] bg-black/60 flex items-center justify-center p-4 overflow-y-auto" onClick={onCancel}>
      <div
        className="bg-card border border-border rounded-2xl shadow-2xl w-full max-w-sm overflow-hidden my-4"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-5 py-4 border-b border-border flex items-center justify-between gap-3">
          <div className="min-w-0">
            <h3 className="text-base font-bold text-foreground">Ajustar logo</h3>
            <p className="text-[11px] text-muted-foreground mt-0.5">Enquadre a logo e, se quiser, troque o fundo.</p>
          </div>
          <button type="button" onClick={onCancel} className="p-1.5 rounded-md hover:bg-accent/50 text-muted-foreground shrink-0" aria-label="Fechar">
            <X size={18} />
          </button>
        </div>

        <div className="p-5 pb-3 flex flex-col items-center gap-3">
          {error ? (
            <p className="text-sm text-red-600 text-center py-10">{error}</p>
          ) : (
            <div
              data-testid="logo-crop-view"
              className={`relative overflow-hidden touch-none select-none ring-2 ${picking ? 'ring-amber-500 cursor-crosshair' : 'ring-violet-500/40'} ${round ? 'rounded-full' : 'rounded-2xl'} ${img && !picking ? 'cursor-grab active:cursor-grabbing' : ''}`}
              style={{ width: VIEW, height: VIEW, ...(bgColor ? { backgroundColor: bgColor } : CHECKER) }}
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onPointerCancel={onPointerUp}
              onWheel={onWheel}
            >
              {img && (usingProcessed ? (
                <canvas
                  ref={previewCanvasRef}
                  data-testid="logo-crop-processed"
                  className="absolute max-w-none pointer-events-none"
                  style={{ width: dispW, height: dispH, left: imgLeft, top: imgTop }}
                />
              ) : (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={src}
                  alt=""
                  draggable={false}
                  className="absolute max-w-none pointer-events-none"
                  style={{ width: dispW, height: dispH, left: imgLeft, top: imgTop }}
                />
              ))}
            </div>
          )}
          {picking && !error && (
            <p className="text-[11px] font-semibold text-amber-700 dark:text-amber-400">Clique no FUNDO da imagem pra escolher a cor a remover.</p>
          )}
          {!picking && !error && autoFitted && (
            <p className="text-[11px] text-emerald-700 dark:text-emerald-400 inline-flex items-center gap-1">
              <Wand2 size={12} />
              Enquadramos a logo sozinho{round ? ' (recorte redondo)' : ''} — ajuste se quiser.
            </p>
          )}
          {!error && sidebarPreview && (
            // Prévia ao vivo: mesma caixa (40px, cantos arredondados) sobre o roxo da barra lateral.
            <div className="w-full flex items-center gap-2">
              <span className="text-[10px] uppercase tracking-wider font-bold text-muted-foreground shrink-0">Na barra lateral</span>
              <div data-testid="logo-sidebar-preview" className="flex-1 min-w-0 h-14 px-3 rounded-lg bg-primary flex items-center gap-2.5">
                <div className="w-10 h-10 rounded-xl overflow-hidden shrink-0 shadow-lg ring-1 ring-primary-foreground/20">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={sidebarPreview} alt="" className="w-full h-full object-contain" />
                </div>
                {clinicName && (
                  <div className="flex flex-col leading-none min-w-0">
                    <span className="text-[13px] font-extrabold text-primary-foreground truncate">{clinicName.split(' ')[0].toUpperCase()}</span>
                    {clinicName.split(' ').length > 1 && (
                      <span className="text-[8px] font-bold tracking-[0.18em] text-primary-foreground/70 mt-0.5 truncate">
                        {clinicName.split(' ').slice(1).join(' ').toUpperCase()}
                      </span>
                    )}
                  </div>
                )}
              </div>
            </div>
          )}
        </div>

        {!error && (
          <>
            <div className="flex border-b border-border px-5">
              {tabBtn('frame', 'Enquadrar', Crop)}
              {tabBtn('bg', 'Fundo', Eraser)}
            </div>

            {tab === 'frame' ? (
              <div className="p-5 pt-4 space-y-3">
                <div className="w-full flex items-center gap-2">
                  <button type="button" onClick={() => applyZoom(zoom / 1.2)} className="p-1.5 rounded-md hover:bg-accent/50 text-muted-foreground" aria-label="Diminuir zoom">
                    <ZoomOut size={16} />
                  </button>
                  <input
                    type="range" min={ZMIN} max={ZMAX} step={0.01} value={zoom}
                    onChange={(e) => applyZoom(Number(e.target.value))}
                    className="flex-1 accent-violet-600" aria-label="Zoom"
                  />
                  <button type="button" onClick={() => applyZoom(zoom * 1.2)} className="p-1.5 rounded-md hover:bg-accent/50 text-muted-foreground" aria-label="Aumentar zoom">
                    <ZoomIn size={16} />
                  </button>
                </div>
                <div className="w-full flex items-center justify-between gap-3">
                  <label className="inline-flex items-center gap-2 text-xs font-semibold text-foreground cursor-pointer">
                    <input type="checkbox" checked={round} onChange={(e) => setRound(e.target.checked)} className="w-4 h-4 accent-violet-600" />
                    Recorte redondo
                  </label>
                  <button type="button" onClick={resetFrame} className="text-xs text-muted-foreground hover:text-foreground inline-flex items-center gap-1">
                    <RotateCcw size={12} />
                    Recomeçar
                  </button>
                </div>
                {autoBounds && (
                  <button
                    type="button"
                    onClick={() => applyFit(autoBounds)}
                    className="w-full text-xs font-semibold py-2 rounded-md border border-violet-500/30 bg-violet-500/10 hover:bg-violet-500/20 text-violet-700 dark:text-violet-400 inline-flex items-center justify-center gap-1.5"
                  >
                    <Wand2 size={13} />
                    Encaixar automaticamente
                  </button>
                )}
              </div>
            ) : (
              <div className="p-5 pt-4 space-y-4">
                <p className="text-[11px] text-muted-foreground bg-muted/40 rounded-md px-3 py-2">
                  <b className="text-foreground">Dica:</b> logo redonda fica mais bonita só com o recorte redondo (aba Enquadrar).
                  Remover fundo apaga tudo da cor do fundo — pode levar junto contornos e letras claras da logo.
                </p>
                {bgError ? (
                  <p className="text-[11px] text-amber-700 dark:text-amber-400">{bgError}</p>
                ) : (
                  <div className="space-y-2.5">
                    <label className="inline-flex items-center gap-2 text-xs font-bold text-foreground cursor-pointer">
                      <input type="checkbox" checked={bgRemove} onChange={(e) => setBgRemove(e.target.checked)} className="w-4 h-4 accent-violet-600" aria-label="Remover fundo" />
                      Remover fundo
                      {bgRemove && <span className="font-normal text-muted-foreground">({removedPct}% removido)</span>}
                    </label>
                    <div className={`space-y-2.5 pl-6 ${bgRemove ? '' : 'opacity-50 pointer-events-none'}`}>
                      <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5 text-[11px] text-muted-foreground">
                        <span className="whitespace-nowrap">Cor do fundo:</span>
                        <span className="w-5 h-5 rounded border border-border shrink-0" style={{ backgroundColor: effectiveRef ? rgbToHex(effectiveRef) : '#fff' }} />
                        <span>{refColor ? 'escolhida' : 'automática'}</span>
                        <button
                          type="button"
                          onClick={() => setPicking((p) => !p)}
                          className={`ml-auto whitespace-nowrap inline-flex items-center gap-1 px-2 py-1 rounded-md border text-[11px] font-semibold ${picking ? 'border-amber-500 bg-amber-500/10 text-amber-700' : 'border-border hover:bg-accent/40 text-foreground'}`}
                          title="Clique e depois clique no fundo da imagem"
                        >
                          <Pipette size={12} />
                          Conta-gotas
                        </button>
                        {refColor && (
                          <button type="button" onClick={() => setRefColor(null)} className="text-[11px] underline hover:text-foreground">auto</button>
                        )}
                      </div>
                      <div>
                        <div className="flex items-center justify-between text-[11px] text-muted-foreground">
                          <span>Sensibilidade</span>
                          <span>{tolerance}</span>
                        </div>
                        <input
                          type="range" min={1} max={100} step={1} value={tolerance}
                          onChange={(e) => setTolerance(Number(e.target.value))}
                          className="w-full accent-violet-600" aria-label="Sensibilidade"
                        />
                        <p className="text-[10px] text-muted-foreground">Mais alto apaga tons parecidos (sombra, papel); se começar a comer a logo, abaixe.</p>
                      </div>
                      <label className="inline-flex items-center gap-2 text-[11px] text-foreground cursor-pointer">
                        <input type="checkbox" checked={everywhere} onChange={(e) => setEverywhere(e.target.checked)} className="w-3.5 h-3.5 accent-violet-600" />
                        Também nas áreas internas (ex.: miolo das letras)
                      </label>
                    </div>
                  </div>
                )}

                <div>
                  <p className="text-xs font-bold text-foreground mb-2">Cor atrás da logo</p>
                  <div className="flex flex-wrap items-center gap-1.5">
                    {BG_SWATCHES.map((s) => (
                      <button
                        key={s.label}
                        type="button"
                        onClick={() => setBgColor(s.color)}
                        title={s.label}
                        aria-label={`Fundo ${s.label}`}
                        className={`w-7 h-7 rounded-full border-2 ${bgColor === s.color ? 'border-violet-600 ring-2 ring-violet-500/30' : 'border-border'}`}
                        style={s.color ? { backgroundColor: s.color } : CHECKER}
                      />
                    ))}
                    <label
                      title="Outra cor"
                      className={`w-7 h-7 rounded-full border-2 cursor-pointer overflow-hidden relative ${bgColor && !BG_SWATCHES.some((s) => s.color === bgColor) ? 'border-violet-600 ring-2 ring-violet-500/30' : 'border-border'}`}
                      style={{ background: bgColor && !BG_SWATCHES.some((s) => s.color === bgColor) ? bgColor : 'conic-gradient(red,yellow,lime,cyan,blue,magenta,red)' }}
                    >
                      <input
                        type="color"
                        value={bgColor ?? '#ffffff'}
                        onChange={(e) => setBgColor(e.target.value)}
                        className="absolute inset-0 opacity-0 cursor-pointer"
                        aria-label="Outra cor de fundo"
                      />
                    </label>
                  </div>
                </div>

                <div className="flex justify-end">
                  <button type="button" onClick={resetBg} className="text-xs text-muted-foreground hover:text-foreground inline-flex items-center gap-1">
                    <RotateCcw size={12} />
                    Desfazer mudanças de fundo
                  </button>
                </div>
              </div>
            )}
          </>
        )}

        <div className="px-5 py-3 border-t border-border bg-muted/20 flex justify-end gap-2">
          <button type="button" onClick={onCancel} className="text-xs font-semibold px-3 py-2 rounded-md border border-border bg-card hover:bg-accent/40 text-foreground">
            Cancelar
          </button>
          <button
            type="button"
            onClick={confirm}
            disabled={!img || !!error || (bgRemove && !processed && !bgError)}
            className="text-xs font-bold px-4 py-2 rounded-md bg-violet-600 hover:bg-violet-700 text-white inline-flex items-center gap-1.5 disabled:opacity-50"
          >
            <Check size={12} />
            Usar esta logo
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

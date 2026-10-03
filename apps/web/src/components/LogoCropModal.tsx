'use client';

/**
 * Ajuste/recorte da logo da clínica (Configurações › Identidade), no estilo da
 * foto de perfil do WhatsApp: quadro quadrado, arrastar pra posicionar, zoom
 * (barra, botões ou rodinha do mouse) e "Recorte redondo" opcional (cantos
 * transparentes). Gera um PNG 512×512 — se ficar pesado, JPG com fundo branco.
 * Sem dependência externa.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { X, ZoomIn, ZoomOut, RotateCcw, Check } from 'lucide-react';

const VIEW = 288;            // lado do quadro de recorte na tela (px)
const OUT = 512;             // lado da logo final (px)
const MAX_CHARS = 500_000;   // teto do data URL (o servidor aceita até 400 KB de imagem)
const ZMIN = 1;              // 1 = imagem inteira cabendo no quadro
const ZMAX = 8;

interface Props {
  /** URL da imagem a ajustar (blob: do arquivo escolhido ou data: da logo atual). */
  src: string;
  onCancel: () => void;
  onConfirm: (dataUrl: string) => void;
}

export default function LogoCropModal({ src, onCancel, onConfirm }: Props) {
  const [img, setImg] = useState<HTMLImageElement | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [zoom, setZoom] = useState(ZMIN);
  // Centro da imagem em relação ao centro do quadro (px do quadro).
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [round, setRound] = useState(false);
  const drag = useRef<{ px: number; py: number; ox: number; oy: number } | null>(null);

  useEffect(() => {
    let alive = true;
    const el = new Image();
    el.onload = () => { if (alive) setImg(el); };
    el.onerror = () => { if (alive) setError('Não consegui abrir essa imagem — tente PNG ou JPG.'); };
    el.src = src;
    return () => { alive = false; };
  }, [src]);

  // Escala base: imagem inteira cabendo no quadro ("contain").
  const base = img ? VIEW / Math.max(img.naturalWidth || 1, img.naturalHeight || 1) : 1;
  const dims = (z: number) => ({
    w: img ? img.naturalWidth * base * z : 0,
    h: img ? img.naturalHeight * base * z : 0,
  });
  const { w: dispW, h: dispH } = dims(zoom);

  // Imagem maior que o quadro: não deixa aparecer borda vazia. Menor: não deixa
  // sair do quadro.
  const clamp = useCallback((o: { x: number; y: number }, w: number, h: number) => {
    const lx = Math.abs(w - VIEW) / 2;
    const ly = Math.abs(h - VIEW) / 2;
    return { x: Math.max(-lx, Math.min(lx, o.x)), y: Math.max(-ly, Math.min(ly, o.y)) };
  }, []);

  const applyZoom = (next: number) => {
    const z = Math.max(ZMIN, Math.min(ZMAX, next));
    const { w, h } = dims(z);
    // Mantém o mesmo ponto da imagem no centro do quadro.
    const ratio = z / zoom;
    setOffset((o) => clamp({ x: o.x * ratio, y: o.y * ratio }, w, h));
    setZoom(z);
  };

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!img) return;
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

  const reset = () => { setZoom(ZMIN); setOffset({ x: 0, y: 0 }); };

  const confirm = () => {
    if (!img) return;
    const k = OUT / VIEW;
    const draw = (bg?: string) => {
      const canvas = document.createElement('canvas');
      canvas.width = OUT;
      canvas.height = OUT;
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('Seu navegador não conseguiu processar a imagem.');
      // Fundo ANTES do recorte redondo: no JPG os cantos ficam brancos (não pretos).
      if (bg) { ctx.fillStyle = bg; ctx.fillRect(0, 0, OUT, OUT); }
      if (round) {
        ctx.beginPath();
        ctx.arc(OUT / 2, OUT / 2, OUT / 2, 0, Math.PI * 2);
        ctx.closePath();
        ctx.clip();
      }
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(
        img,
        (VIEW / 2 + offset.x - dispW / 2) * k,
        (VIEW / 2 + offset.y - dispH / 2) * k,
        dispW * k,
        dispH * k,
      );
      return canvas;
    };
    try {
      let out = draw().toDataURL('image/png');
      if (out.length > MAX_CHARS) out = draw('#ffffff').toDataURL('image/jpeg', 0.88);
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
  return createPortal(
    <div className="fixed inset-0 z-[100] bg-black/60 flex items-center justify-center p-4" onClick={onCancel}>
      <div
        className="bg-card border border-border rounded-2xl shadow-2xl w-full max-w-sm overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-5 py-4 border-b border-border flex items-center justify-between gap-3">
          <div className="min-w-0">
            <h3 className="text-base font-bold text-foreground">Ajustar logo</h3>
            <p className="text-[11px] text-muted-foreground mt-0.5">Arraste pra posicionar e use o zoom até a logo preencher o quadro.</p>
          </div>
          <button type="button" onClick={onCancel} className="p-1.5 rounded-md hover:bg-accent/50 text-muted-foreground shrink-0" aria-label="Fechar">
            <X size={18} />
          </button>
        </div>

        <div className="p-5 flex flex-col items-center gap-4">
          {error ? (
            <p className="text-sm text-red-600 text-center py-10">{error}</p>
          ) : (
            <div
              data-testid="logo-crop-view"
              className={`relative overflow-hidden touch-none select-none ring-2 ring-violet-500/40 ${round ? 'rounded-full' : 'rounded-2xl'} ${img ? 'cursor-grab active:cursor-grabbing' : ''}`}
              style={{
                width: VIEW,
                height: VIEW,
                // Xadrez = área transparente (o que sobrar fica sem fundo).
                backgroundImage: 'linear-gradient(45deg,#e5e7eb 25%,transparent 25%),linear-gradient(-45deg,#e5e7eb 25%,transparent 25%),linear-gradient(45deg,transparent 75%,#e5e7eb 75%),linear-gradient(-45deg,transparent 75%,#e5e7eb 75%)',
                backgroundSize: '16px 16px',
                backgroundPosition: '0 0,0 8px,8px -8px,-8px 0',
                backgroundColor: '#fff',
              }}
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onPointerCancel={onPointerUp}
              onWheel={onWheel}
            >
              {img && (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={src}
                  alt=""
                  draggable={false}
                  className="absolute max-w-none pointer-events-none"
                  style={{
                    width: dispW,
                    height: dispH,
                    left: VIEW / 2 + offset.x - dispW / 2,
                    top: VIEW / 2 + offset.y - dispH / 2,
                  }}
                />
              )}
            </div>
          )}

          {!error && (
            <>
              <div className="w-full flex items-center gap-2">
                <button type="button" onClick={() => applyZoom(zoom / 1.2)} className="p-1.5 rounded-md hover:bg-accent/50 text-muted-foreground" aria-label="Diminuir zoom">
                  <ZoomOut size={16} />
                </button>
                <input
                  type="range"
                  min={ZMIN}
                  max={ZMAX}
                  step={0.01}
                  value={zoom}
                  onChange={(e) => applyZoom(Number(e.target.value))}
                  className="flex-1 accent-violet-600"
                  aria-label="Zoom"
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
                <button type="button" onClick={reset} className="text-xs text-muted-foreground hover:text-foreground inline-flex items-center gap-1">
                  <RotateCcw size={12} />
                  Recomeçar
                </button>
              </div>
            </>
          )}
        </div>

        <div className="px-5 py-3 border-t border-border bg-muted/20 flex justify-end gap-2">
          <button type="button" onClick={onCancel} className="text-xs font-semibold px-3 py-2 rounded-md border border-border bg-card hover:bg-accent/40 text-foreground">
            Cancelar
          </button>
          <button
            type="button"
            onClick={confirm}
            disabled={!img || !!error}
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

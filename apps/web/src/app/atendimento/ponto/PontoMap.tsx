'use client';

/**
 * Mapa leve do relógio de ponto (blocos do OpenStreetMap, sem biblioteca — a CSP
 * não deixa carregar script de fora e o mapa é simples): arrastar, zoom (+/−,
 * roda do mouse), tocar pra marcar (`onPick`), círculo da área da clínica e a
 * posição de quem está batendo com a margem de erro do GPS.
 */
import { useEffect, useRef, useState } from 'react';
import { Minus, Plus } from 'lucide-react';

type LatLng = { lat: number; lng: number };
const TILE = 256;
const MIN_Z = 3;
const MAX_Z = 19;

function project(p: LatLng, z: number) {
  const scale = TILE * 2 ** z;
  const sin = Math.min(Math.max(Math.sin((p.lat * Math.PI) / 180), -0.9999), 0.9999);
  return {
    x: ((p.lng + 180) / 360) * scale,
    y: (0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)) * scale,
  };
}

function unproject(x: number, y: number, z: number): LatLng {
  const scale = TILE * 2 ** z;
  const lng = (x / scale) * 360 - 180;
  const n = Math.PI - (2 * Math.PI * y) / scale;
  const lat = (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
  return { lat, lng };
}

const metersPerPixel = (lat: number, z: number) => (156543.03392 * Math.cos((lat * Math.PI) / 180)) / 2 ** z;

export function PontoMap({
  center,
  recenterKey,
  zoom = 17,
  clinic,
  you,
  onPick,
  height = 280,
}: {
  center: LatLng;
  /** Mudou → o mapa volta pro `center` (ex.: buscou endereço, usou a localização). */
  recenterKey?: string;
  zoom?: number;
  clinic?: { lat: number; lng: number; raio_m: number } | null;
  you?: { lat: number; lng: number; accuracy: number } | null;
  onPick?: (p: LatLng) => void;
  height?: number;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(0);
  const [view, setView] = useState({ ...center, z: zoom });
  const drag = useRef<{ x: number; y: number; cx: number; cy: number; moved: boolean } | null>(null);

  // Volta pro centro quando o chamador pede (busca, localização, colar) — ajuste
  // de estado durante o render, o padrão do React pra "props mudaram".
  const [seenKey, setSeenKey] = useState(recenterKey);
  if (recenterKey !== seenKey) {
    setSeenKey(recenterKey);
    setView((v) => ({ lat: center.lat, lng: center.lng, z: v.z }));
  }

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    // O ResizeObserver já dispara uma vez ao observar (tamanho inicial).
    const ro = new ResizeObserver(() => setW(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Roda do mouse = zoom (listener nativo pra poder impedir a rolagem da página).
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      setView((v) => ({ ...v, z: Math.min(MAX_Z, Math.max(MIN_Z, v.z + (e.deltaY < 0 ? 1 : -1))) }));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  const h = height;
  const c = project(view, view.z);
  const left = c.x - w / 2;
  const top = c.y - h / 2;
  const n = 2 ** view.z;

  const tiles: { key: string; src: string; x: number; y: number }[] = [];
  if (w > 0) {
    for (let ty = Math.floor(top / TILE); ty <= Math.floor((top + h) / TILE); ty++) {
      if (ty < 0 || ty >= n) continue;
      for (let tx = Math.floor(left / TILE); tx <= Math.floor((left + w) / TILE); tx++) {
        const wx = ((tx % n) + n) % n;
        tiles.push({
          key: `${view.z}/${tx}/${ty}`,
          src: `https://tile.openstreetmap.org/${view.z}/${wx}/${ty}.png`,
          x: tx * TILE - left,
          y: ty * TILE - top,
        });
      }
    }
  }

  const toScreen = (p: LatLng) => {
    const q = project(p, view.z);
    return { x: q.x - left, y: q.y - top };
  };
  const mpp = metersPerPixel(view.lat, view.z);

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.currentTarget.setPointerCapture?.(e.pointerId);
    drag.current = { x: e.clientX, y: e.clientY, cx: c.x, cy: c.y, moved: false };
  };
  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d) return;
    const dx = e.clientX - d.x;
    const dy = e.clientY - d.y;
    if (Math.abs(dx) + Math.abs(dy) > 5) d.moved = true;
    if (d.moved) setView((v) => ({ ...unproject(d.cx - dx, d.cy - dy, v.z), z: v.z }));
  };
  const onPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    drag.current = null;
    if (!d || d.moved || !onPick || !box.current) return;
    const r = box.current.getBoundingClientRect();
    onPick(unproject(left + (e.clientX - r.left), top + (e.clientY - r.top), view.z));
  };
  const zoomBy = (delta: number) => setView((v) => ({ ...v, z: Math.min(MAX_Z, Math.max(MIN_Z, v.z + delta)) }));

  const cl = clinic ? toScreen(clinic) : null;
  const yo = you ? toScreen(you) : null;

  return (
    <div
      ref={box}
      className={`relative overflow-hidden rounded-xl border border-slate-200 bg-slate-100 select-none ${onPick ? 'cursor-crosshair' : 'cursor-grab'}`}
      style={{ height: h, touchAction: 'none' }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={() => { drag.current = null; }}
    >
      {tiles.map((t) => (
        // eslint-disable-next-line @next/next/no-img-element -- bloco de mapa externo, sem otimização
        <img
          key={t.key}
          src={t.src}
          alt=""
          draggable={false}
          className="absolute max-w-none pointer-events-none"
          style={{ left: t.x, top: t.y, width: TILE, height: TILE }}
        />
      ))}
      <svg className="absolute inset-0 pointer-events-none" width={w} height={h}>
        {cl && clinic && (
          <>
            <circle cx={cl.x} cy={cl.y} r={Math.max(3, clinic.raio_m / mpp)} fill="rgba(14,165,233,0.15)" stroke="#0284c7" strokeWidth={2} />
            <circle cx={cl.x} cy={cl.y} r={6} fill="#0284c7" stroke="#fff" strokeWidth={2} />
          </>
        )}
        {yo && you && (
          <>
            <circle cx={yo.x} cy={yo.y} r={Math.max(4, you.accuracy / mpp)} fill="rgba(16,185,129,0.15)" stroke="#059669" strokeWidth={1.5} strokeDasharray="4 3" />
            <circle cx={yo.x} cy={yo.y} r={6} fill="#059669" stroke="#fff" strokeWidth={2} />
          </>
        )}
      </svg>
      <div className="absolute top-2 right-2 flex flex-col rounded-lg overflow-hidden shadow border border-slate-200 bg-white" onPointerDown={(e) => e.stopPropagation()} onPointerUp={(e) => e.stopPropagation()}>
        <button type="button" onClick={() => zoomBy(1)} className="p-1.5 hover:bg-slate-50" aria-label="Aproximar"><Plus className="w-4 h-4" /></button>
        <button type="button" onClick={() => zoomBy(-1)} className="p-1.5 hover:bg-slate-50 border-t border-slate-200" aria-label="Afastar"><Minus className="w-4 h-4" /></button>
      </div>
      <div className="absolute bottom-0 right-0 bg-white/80 px-1.5 text-[10px] text-slate-600">
        © <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer" className="underline" onPointerDown={(e) => e.stopPropagation()}>OpenStreetMap</a>
      </div>
    </div>
  );
}

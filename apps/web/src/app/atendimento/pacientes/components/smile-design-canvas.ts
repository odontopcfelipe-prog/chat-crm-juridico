/**
 * Smile Design — trabalho de imagem feito no navegador (canvas):
 *  - prepara a foto no tamanho que a IA aceita + a máscara da boca;
 *  - "cola" o resultado da IA só dentro da boca marcada, com borda suave,
 *    pra garantir que o resto do rosto fique IDÊNTICO à foto original;
 *  - monta a imagem antes/depois pra baixar (com o aviso de simulação).
 */

export interface SmileRegion {
  /** Centro e raios da elipse da boca, em fração (0..1) da largura/altura. */
  cx: number;
  cy: number;
  rx: number;
  ry: number;
}

/** A IA pode mexer um pouco além da marcação (pra borda ficar natural)... */
const MASK_GROW = 1.25;
/** ...e o resultado entra 100% até a marcação, sumindo suave até 1,2×. */
const BLEND_OUTER = 1.2;

const TARGET_LONG_SIDE = 1536;

export function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Não foi possível abrir a imagem'));
    img.src = src;
  });
}

export function canvasToBlob(canvas: HTMLCanvasElement, type: string, quality?: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Falha ao gerar a imagem'))), type, quality);
  });
}

/** Lado maior = 1536 e lados múltiplos de 16 (regra de tamanho livre da OpenAI). */
export function targetSize(width: number, height: number): { width: number; height: number } {
  const scale = TARGET_LONG_SIDE / Math.max(width, height);
  const round16 = (n: number) => Math.max(16, Math.round(n / 16) * 16);
  return { width: round16(width * scale), height: round16(height * scale) };
}

function fillEllipse(ctx: CanvasRenderingContext2D, w: number, h: number, r: SmileRegion, grow: number) {
  ctx.beginPath();
  ctx.ellipse(r.cx * w, r.cy * h, r.rx * w * grow, r.ry * h * grow, 0, 0, Math.PI * 2);
  ctx.fill();
}

/**
 * Foto pronta pro envio: PNG no tamanho da IA + máscara PNG do mesmo tamanho
 * (opaca no rosto, transparente na boca = onde a IA pode mexer).
 */
export async function prepareUpload(img: HTMLImageElement, region: SmileRegion | null) {
  const { width, height } = targetSize(img.naturalWidth, img.naturalHeight);
  const photo = document.createElement('canvas');
  photo.width = width;
  photo.height = height;
  const pctx = photo.getContext('2d')!;
  pctx.imageSmoothingQuality = 'high';
  pctx.drawImage(img, 0, 0, width, height);
  const photoBlob = await canvasToBlob(photo, 'image/png');

  let maskBlob: Blob | null = null;
  if (region) {
    const mask = document.createElement('canvas');
    mask.width = width;
    mask.height = height;
    const mctx = mask.getContext('2d')!;
    mctx.fillStyle = '#000';
    mctx.fillRect(0, 0, width, height);
    mctx.globalCompositeOperation = 'destination-out';
    fillEllipse(mctx, width, height, region, MASK_GROW);
    maskBlob = await canvasToBlob(mask, 'image/png');
  }
  return { photoBlob, maskBlob, width, height };
}

/**
 * Antes + resultado da IA → só a boca vem do resultado (borda suave); o resto
 * é a foto original pixel a pixel. Sem marcação → resultado puro da IA.
 */
export function composeAfter(
  before: HTMLImageElement,
  after: HTMLImageElement,
  region: SmileRegion | null,
): HTMLCanvasElement {
  const w = before.naturalWidth;
  const h = before.naturalHeight;
  const out = document.createElement('canvas');
  out.width = w;
  out.height = h;
  const ctx = out.getContext('2d')!;
  if (!region) {
    ctx.drawImage(after, 0, 0, w, h);
    return out;
  }
  ctx.drawImage(before, 0, 0, w, h);

  const layer = document.createElement('canvas');
  layer.width = w;
  layer.height = h;
  const lctx = layer.getContext('2d')!;
  lctx.imageSmoothingQuality = 'high';
  lctx.drawImage(after, 0, 0, w, h);
  lctx.globalCompositeOperation = 'destination-in';
  lctx.save();
  lctx.translate(region.cx * w, region.cy * h);
  lctx.scale(region.rx * w * BLEND_OUTER, region.ry * h * BLEND_OUTER);
  const g = lctx.createRadialGradient(0, 0, 0, 0, 0, 1);
  g.addColorStop(0, 'rgba(0,0,0,1)');
  g.addColorStop(1 / BLEND_OUTER, 'rgba(0,0,0,1)');
  g.addColorStop(1, 'rgba(0,0,0,0)');
  lctx.fillStyle = g;
  lctx.beginPath();
  lctx.arc(0, 0, 1, 0, Math.PI * 2);
  lctx.fill();
  lctx.restore();

  ctx.drawImage(layer, 0, 0);
  return out;
}

/** Antes | Depois lado a lado, com rótulos e o aviso do CFO gravados na imagem. */
export async function buildSideBySide(
  before: HTMLImageElement,
  after: HTMLCanvasElement | HTMLImageElement,
): Promise<Blob> {
  const h = Math.min(1200, before.naturalHeight);
  const w = Math.round((before.naturalWidth / before.naturalHeight) * h);
  const gap = Math.round(h * 0.015);
  const footer = Math.round(h * 0.07);
  const canvas = document.createElement('canvas');
  canvas.width = w * 2 + gap;
  canvas.height = h + footer;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(before, 0, 0, w, h);
  ctx.drawImage(after, w + gap, 0, w, h);

  const label = (text: string, x: number, bg: string) => {
    const fs = Math.round(h * 0.032);
    ctx.font = `700 ${fs}px system-ui, -apple-system, Segoe UI, Roboto, sans-serif`;
    const pad = Math.round(fs * 0.5);
    const tw = ctx.measureText(text).width;
    ctx.fillStyle = bg;
    ctx.fillRect(x + pad, pad, tw + pad * 2, fs + pad * 1.4);
    ctx.fillStyle = '#ffffff';
    ctx.textBaseline = 'top';
    ctx.fillText(text, x + pad * 2, pad * 1.7);
  };
  label('ANTES', 0, 'rgba(0,0,0,0.65)');
  label('SIMULAÇÃO', w + gap, 'rgba(0,128,105,0.92)');

  const fs = Math.round(footer * 0.32);
  ctx.font = `500 ${fs}px system-ui, -apple-system, Segoe UI, Roboto, sans-serif`;
  ctx.fillStyle = '#555555';
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'center';
  ctx.fillText(
    'Simulação ilustrativa gerada por IA — não é garantia de resultado (CFO, Res. 118/2012).',
    canvas.width / 2,
    h + footer / 2,
  );
  return canvasToBlob(canvas, 'image/jpeg', 0.92);
}

export function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

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

// ─── Vídeo antes → depois ────────────────────────────────────────────────────

/** MP4 primeiro (abre no WhatsApp e no iPhone); WebM só no navegador que não grava MP4. */
const VIDEO_TYPES = [
  'video/mp4;codecs=avc1.42E01E',
  'video/mp4;codecs=avc1',
  'video/mp4',
  'video/webm;codecs=vp9',
  'video/webm;codecs=vp8',
  'video/webm',
];

export function pickVideoType(): string | null {
  if (typeof MediaRecorder === 'undefined') return null;
  return VIDEO_TYPES.find((t) => MediaRecorder.isTypeSupported(t)) || null;
}

export const VIDEO_SECONDS = 9;

const easeInOut = (x: number) => (x < 0.5 ? 2 * x * x : 1 - Math.pow(-2 * x + 2, 2) / 2);

/**
 * Posição do divisor no tempo t (1 = tudo ANTES, 0 = tudo SIMULAÇÃO):
 * mostra o antes → desliza até a simulação → segura → volta pro meio e
 * termina comparando os dois.
 */
export function wipeAt(t: number): number {
  if (t < 1.5) return 1;
  if (t < 3.5) return 1 - easeInOut((t - 1.5) / 2);
  if (t < 5.5) return 0;
  if (t < 7) return 0.5 * easeInOut((t - 5.5) / 1.5);
  return 0.5;
}

function drawVideoFrame(
  ctx: CanvasRenderingContext2D,
  before: HTMLImageElement,
  after: HTMLCanvasElement | HTMLImageElement,
  w: number,
  h: number,
  footer: number,
  pos: number,
) {
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, w, h + footer);
  ctx.drawImage(after, 0, 0, w, h);
  if (pos > 0) {
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, w * pos, h);
    ctx.clip();
    ctx.drawImage(before, 0, 0, w, h);
    ctx.restore();
  }

  if (pos > 0 && pos < 1) {
    const x = w * pos;
    const r = Math.round(Math.min(w, h) * 0.045);
    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,0.45)';
    ctx.shadowBlur = 8;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(x - 1.5, 0, 3, h);
    ctx.beginPath();
    ctx.arc(x, h / 2, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
    ctx.fillStyle = '#222222';
    const a = r * 0.42;
    ctx.beginPath();
    ctx.moveTo(x - a * 1.6, h / 2);
    ctx.lineTo(x - a * 0.4, h / 2 - a);
    ctx.lineTo(x - a * 0.4, h / 2 + a);
    ctx.closePath();
    ctx.moveTo(x + a * 1.6, h / 2);
    ctx.lineTo(x + a * 0.4, h / 2 - a);
    ctx.lineTo(x + a * 0.4, h / 2 + a);
    ctx.closePath();
    ctx.fill();
  }

  const fs = Math.round(Math.min(w, h) * 0.045);
  const pad = Math.round(fs * 0.5);
  ctx.font = `700 ${fs}px system-ui, -apple-system, Segoe UI, Roboto, sans-serif`;
  ctx.textBaseline = 'top';
  ctx.textAlign = 'left';
  const label = (text: string, alignRight: boolean, bg: string) => {
    const tw = ctx.measureText(text).width;
    const boxW = tw + pad * 2;
    const x = alignRight ? w - pad - boxW : pad;
    ctx.fillStyle = bg;
    ctx.fillRect(x, pad, boxW, fs + pad * 1.4);
    ctx.fillStyle = '#ffffff';
    ctx.fillText(text, x + pad, pad * 1.7);
  };
  if (pos > 0.02) label('ANTES', false, 'rgba(0,0,0,0.65)');
  if (pos < 0.98) label('SIMULAÇÃO', true, 'rgba(0,128,105,0.92)');

  // Aviso do CFO em 2 linhas, encolhendo a fonte se a largura não couber.
  const lines = ['Simulação ilustrativa gerada por IA —', 'não é garantia de resultado (CFO, Res. 118/2012).'];
  let ffs = Math.round(footer * 0.26);
  ctx.font = `500 ${ffs}px system-ui, -apple-system, Segoe UI, Roboto, sans-serif`;
  while (ffs > 8 && Math.max(...lines.map((l) => ctx.measureText(l).width)) > w * 0.94) {
    ffs -= 1;
    ctx.font = `500 ${ffs}px system-ui, -apple-system, Segoe UI, Roboto, sans-serif`;
  }
  ctx.fillStyle = '#555555';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(lines[0], w / 2, h + footer * 0.34);
  ctx.fillText(lines[1], w / 2, h + footer * 0.68);
}

/**
 * Grava o vídeo antes → depois (~9 s) direto do canvas. É gravado em tempo
 * real, então leva os mesmos ~9 s — a aba precisa ficar aberta.
 */
export async function buildBeforeAfterVideo(
  before: HTMLImageElement,
  after: HTMLCanvasElement | HTMLImageElement,
  onProgress?: (fraction: number) => void,
): Promise<{ blob: Blob; ext: 'mp4' | 'webm' }> {
  const type = pickVideoType();
  if (!type) throw new Error('Este navegador não grava vídeo — use o Chrome, Edge ou Safari atualizado.');

  const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);
  const scale = Math.min(1, 1080 / before.naturalWidth, 1200 / before.naturalHeight);
  const w = even(before.naturalWidth * scale);
  const h = even(before.naturalHeight * scale);
  const footer = even(h * 0.11);
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h + footer;
  const ctx = canvas.getContext('2d')!;
  ctx.imageSmoothingQuality = 'high';
  drawVideoFrame(ctx, before, after, w, h, footer, 1);

  const stream = canvas.captureStream(30);
  const rec = new MediaRecorder(stream, { mimeType: type, videoBitsPerSecond: 8_000_000 });
  const chunks: Blob[] = [];
  rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
  const stopped = new Promise<void>((resolve) => { rec.onstop = () => resolve(); });
  rec.start(250);

  // setTimeout (e não requestAnimationFrame): continua mesmo se a aba sair de foco.
  await new Promise<void>((resolve) => {
    const t0 = performance.now();
    const tick = () => {
      const t = (performance.now() - t0) / 1000;
      drawVideoFrame(ctx, before, after, w, h, footer, wipeAt(Math.min(t, VIDEO_SECONDS)));
      onProgress?.(Math.min(1, t / VIDEO_SECONDS));
      if (t >= VIDEO_SECONDS + 0.3) { resolve(); return; }
      setTimeout(tick, 1000 / 30);
    };
    tick();
  });

  rec.stop();
  await stopped;
  stream.getTracks().forEach((t) => t.stop());
  const mime = type.split(';')[0];
  if (!chunks.length) throw new Error('O navegador não gravou o vídeo — tente de novo.');
  return { blob: new Blob(chunks, { type: mime }), ext: mime === 'video/mp4' ? 'mp4' : 'webm' };
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

/**
 * Utilitários de imagem do Smile Design — sem biblioteca nativa (a API não
 * tem sharp). A tela já manda a foto em PNG no tamanho certo; aqui só lemos
 * o cabeçalho pra validar e escolher o `size` da OpenAI.
 */

export interface SmileRegion {
  /** Centro e raios da elipse da boca, em fração (0..1) da largura/altura da foto. */
  cx: number;
  cy: number;
  rx: number;
  ry: number;
}

/** Largura/altura de um PNG pelo cabeçalho IHDR (null se não for PNG). */
export function readPngSize(buf: Buffer | null | undefined): { width: number; height: number } | null {
  if (!buf || buf.length < 24) return null;
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  for (let i = 0; i < 8; i++) if (buf[i] !== sig[i]) return null;
  if (buf.toString('ascii', 12, 16) !== 'IHDR') return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

/**
 * `size` aceito pela família gpt-image-2: lados múltiplos de 16, proporção até
 * 3:1, lado máx. 3840, total entre 655.360 e 8.294.400 px. Fora disso → null
 * (a chamada usa 'auto').
 */
export function openAiSizeFor(width: number, height: number): string | null {
  if (!width || !height) return null;
  if (width % 16 || height % 16) return null;
  if (Math.max(width, height) > 3840) return null;
  if (Math.max(width, height) / Math.min(width, height) > 3) return null;
  const px = width * height;
  if (px < 655_360 || px > 8_294_400) return null;
  return `${width}x${height}`;
}

/** Valida a elipse vinda da tela (JSON). Inválida → null (gera sem máscara). */
export function parseRegion(raw: unknown): SmileRegion | null {
  let v: any = raw;
  if (typeof raw === 'string') {
    if (!raw.trim()) return null;
    try { v = JSON.parse(raw); } catch { return null; }
  }
  if (!v || typeof v !== 'object') return null;
  const nums = ['cx', 'cy', 'rx', 'ry'].map((k) => Number(v[k]));
  if (nums.some((n) => !Number.isFinite(n) || n < 0 || n > 1)) return null;
  const [cx, cy, rx, ry] = nums;
  if (rx < 0.01 || ry < 0.01) return null;
  return { cx, cy, rx, ry };
}

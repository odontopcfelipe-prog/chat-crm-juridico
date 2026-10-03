/**
 * Remoção de fundo POR COR pra logos (editor de logo em Configurações ›
 * Identidade). Funciona com fundo liso ou quase liso (foto de logo em papel,
 * logo com fundo branco): apaga os pixels parecidos com a cor do fundo que
 * estão LIGADOS à borda da imagem (flood fill) — ou em toda a imagem, pra
 * pegar também o miolo de letras. Puro (só mexe no Uint8ClampedArray RGBA),
 * sem canvas e sem dependência — testável no Node.
 */

export type RGB = [number, number, number];

/** Cor do fundo estimada pela MEDIANA dos pixels da borda (resiste a sombra/ruído). */
export function estimateBorderColor(data: Uint8ClampedArray, w: number, h: number): RGB {
  const rs: number[] = [];
  const gs: number[] = [];
  const bs: number[] = [];
  const push = (x: number, y: number) => {
    const i = (y * w + x) * 4;
    if (data[i + 3] < 8) return; // já transparente: não conta
    rs.push(data[i]);
    gs.push(data[i + 1]);
    bs.push(data[i + 2]);
  };
  const step = Math.max(1, Math.floor(Math.max(w, h) / 400));
  for (let x = 0; x < w; x += step) { push(x, 0); push(x, h - 1); }
  for (let y = 0; y < h; y += step) { push(0, y); push(w - 1, y); }
  const med = (a: number[]) => {
    if (!a.length) return 255;
    a.sort((p, q) => p - q);
    return a[a.length >> 1];
  };
  return [med(rs), med(gs), med(bs)];
}

export interface RemoveBackgroundOptions {
  /** Cor do fundo a remover. */
  ref: RGB;
  /** Sensibilidade 0..100 (quanto de variação da cor ainda conta como fundo). */
  tolerance: number;
  /** true = remove essa cor em TODA a imagem (miolo das letras); false = só o
   *  que está ligado à borda (não fura a logo). */
  everywhere?: boolean;
}

/** Distância RGB máxima que a sensibilidade 100 alcança. */
const MAX_DIST = 180;

/**
 * Remove o fundo IN-PLACE (alpha → 0). Faixa de transição (tol..1,5×tol) vira
 * semi-transparente, pra borda da logo não ficar serrilhada.
 * Retorna quantos pixels ficaram totalmente transparentes.
 */
export function removeBackground(data: Uint8ClampedArray, w: number, h: number, opts: RemoveBackgroundOptions): number {
  const tol = (Math.max(0, Math.min(100, opts.tolerance)) / 100) * MAX_DIST;
  const soft = Math.max(tol * 1.5, tol + 1);
  const [rr, rg, rb] = opts.ref;
  const n = w * h;
  let removed = 0;

  const dist = (p: number) => {
    const i = p * 4;
    const dr = data[i] - rr;
    const dg = data[i + 1] - rg;
    const db = data[i + 2] - rb;
    return Math.sqrt(dr * dr + dg * dg + db * db);
  };
  /** Aplica a transparência; true se o pixel é fundo "cheio" (pode espalhar). */
  const apply = (p: number, d: number): boolean => {
    const ai = p * 4 + 3;
    if (d <= tol) {
      if (data[ai] !== 0) { data[ai] = 0; removed++; }
      return true;
    }
    if (d < soft) {
      const a = Math.round((255 * (d - tol)) / (soft - tol));
      if (a < data[ai]) data[ai] = a;
    }
    return false;
  };

  if (opts.everywhere) {
    for (let p = 0; p < n; p++) apply(p, dist(p));
    return removed;
  }

  // Flood fill a partir de TODA a borda; só atravessa pixels de fundo "cheio".
  const seen = new Uint8Array(n);
  const stack = new Int32Array(n);
  let sp = 0;
  const visit = (p: number) => {
    if (seen[p]) return;
    seen[p] = 1;
    if (apply(p, dist(p))) stack[sp++] = p;
  };
  for (let x = 0; x < w; x++) { visit(x); visit((h - 1) * w + x); }
  for (let y = 0; y < h; y++) { visit(y * w); visit(y * w + w - 1); }
  while (sp > 0) {
    const p = stack[--sp];
    const x = p % w;
    if (x > 0) visit(p - 1);
    if (x < w - 1) visit(p + 1);
    if (p >= w) visit(p - w);
    if (p < n - w) visit(p + w);
  }
  return removed;
}

/** "#rrggbb" ← RGB */
export function rgbToHex([r, g, b]: RGB): string {
  return `#${[r, g, b].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')}`;
}

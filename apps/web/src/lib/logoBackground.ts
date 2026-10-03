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
    // Já transparente (ex.: cantos de uma logo recortada redonda, ao reeditar):
    // é fundo e o preenchimento atravessa — senão travava na borda.
    if (data[ai] < 8) return true;
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

export interface LogoBounds {
  /** Caixa da logo em pixels (inclusive). */
  x0: number; y0: number; x1: number; y1: number;
  /** A logo é um círculo (selo redondo) — vale ligar o recorte redondo. */
  round: boolean;
}

/**
 * Acha ONDE está a logo dentro da imagem (tudo que não é o fundo ligado à
 * borda) e se ela é redonda. Usado pra enquadrar sozinho: foto de logo com
 * muito fundo em volta abre já com zoom na logo. Não altera `data`.
 * null = não achou fundo (a logo já ocupa a imagem toda) ou não achou logo.
 */
export function detectLogoBounds(data: Uint8ClampedArray, w: number, h: number, opts: { ref: RGB; tolerance: number }): LogoBounds | null {
  const copy = new Uint8ClampedArray(data);
  removeBackground(copy, w, h, opts);
  let x0 = w, y0 = h, x1 = -1, y1 = -1, fg = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (copy[(y * w + x) * 4 + 3] > 128) {
        fg++;
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  if (x1 < 0 || fg < 16) return null;
  const bw = x1 - x0 + 1;
  const bh = y1 - y0 + 1;
  // Fundo quase inexistente: nada a enquadrar.
  if (bw >= w * 0.97 && bh >= h * 0.97) return null;

  // Redonda? Caixa ~quadrada, quase nada fora do círculo inscrito e o círculo
  // bem preenchido (selo maciço, não um traço solto).
  let round = false;
  const aspect = bw / bh;
  if (aspect > 0.92 && aspect < 1.08) {
    const cx = (x0 + x1) / 2;
    const cy = (y0 + y1) / 2;
    const r = Math.min(bw, bh) / 2;
    let outside = 0, inside = 0, insideArea = 0;
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const dd = Math.hypot(x - cx, y - cy);
        const isFg = copy[(y * w + x) * 4 + 3] > 128;
        if (dd > r * 1.03) { if (isFg) outside++; }
        else if (dd <= r * 0.97) { insideArea++; if (isFg) inside++; }
      }
    }
    round = outside / fg < 0.02 && insideArea > 0 && inside / insideArea > 0.85;
  }
  return { x0, y0, x1, y1, round };
}

/**
 * Margem de segurança em volta da logo detectada: contorno fino e CLARO (ex.:
 * aro creme de um selo verde sobre foto bege) tem cor quase igual ao fundo e
 * a detecção por cor não separa — sem margem, o enquadramento cortaria esse
 * contorno. `frac` = fração do maior lado da logo, em cada lado.
 */
export function padBounds(b: LogoBounds, w: number, h: number, frac: number): LogoBounds {
  const pad = Math.round(Math.max(b.x1 - b.x0 + 1, b.y1 - b.y0 + 1) * frac);
  return {
    x0: Math.max(0, b.x0 - pad),
    y0: Math.max(0, b.y0 - pad),
    x1: Math.min(w - 1, b.x1 + pad),
    y1: Math.min(h - 1, b.y1 + pad),
    round: b.round,
  };
}

/** "#rrggbb" ← RGB */
export function rgbToHex([r, g, b]: RGB): string {
  return `#${[r, g, b].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')}`;
}

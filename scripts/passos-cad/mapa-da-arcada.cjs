// Passos CAD — acha os 32 dentes na imagem da arcada da ficha: separa o cinza de cada dente, tira o
// contorno e dá o número FDI pela posição na arcada. Recorta a imagem (sem a moldura), deixa o fundo
// branco transparente e escreve o mapa de clique.
// Uso: node scripts/passos-cad/mapa-da-arcada.cjs <imagem.png> apps/web/public/passos-cad/arcada.png apps/web/src/app/atendimento/passos-cad/mapa-da-arcada.ts [--info]
const sharp = require('sharp');
const fs = require('fs');

const [entrada, saidaPng, saidaTs] = process.argv.slice(2);
const info = process.argv.includes('--info');

(async () => {
  const { data, info: im } = await sharp(entrada).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const W = im.width;
  const H = im.height;
  const L = new Float32Array(W * H);
  for (let i = 0; i < W * H; i++) {
    const a = data[4 * i + 3] / 255;
    // Transparente conta como branco.
    L[i] = (0.299 * data[4 * i] + 0.587 * data[4 * i + 1] + 0.114 * data[4 * i + 2]) * a + 255 * (1 - a);
  }
  if (info) {
    const hist = new Array(26).fill(0);
    for (let i = 0; i < W * H; i++) hist[Math.min(25, Math.floor(L[i] / 10))]++;
    console.log('histograma (luminância/10):', hist.map((n, k) => `${k * 10}:${n}`).join(' '));
    console.log('cantos:', L[0], L[W - 1], L[(H - 1) * W], L[W * H - 1], 'meio:', L[Math.floor(H / 2) * W + Math.floor(W / 2)]);
  }
  // Cinza do dente: entre o traço escuro e o fundo claro.
  const FILL_MIN = 170;
  const FILL_MAX = 228;
  const rot = new Int32Array(W * H).fill(-1);
  const comps = [];
  for (let s = 0; s < W * H; s++) {
    if (rot[s] !== -1 || L[s] < FILL_MIN || L[s] > FILL_MAX) continue;
    const id = comps.length;
    const fila = [s];
    rot[s] = id;
    let n = 0;
    let sx = 0;
    let sy = 0;
    const pix = [];
    while (fila.length) {
      const p = fila.pop();
      n++;
      const x = p % W;
      const y = (p - x) / W;
      sx += x;
      sy += y;
      pix.push(p);
      for (const q of [p - 1, p + 1, p - W, p + W]) {
        if (q < 0 || q >= W * H) continue;
        if (Math.abs((q % W) - x) > 1) continue;
        if (rot[q] !== -1 || L[q] < FILL_MIN || L[q] > FILL_MAX) continue;
        rot[q] = id;
        fila.push(q);
      }
    }
    comps.push({ id, n, cx: sx / n, cy: sy / n, pix });
  }
  comps.sort((a, b) => b.n - a.n);
  if (info) console.log('maiores componentes:', comps.slice(0, 40).map((c) => `${c.n}@(${c.cx.toFixed(0)},${c.cy.toFixed(0)})`).join(' '));
  const dentes = comps.filter((c) => c.n > 400);
  console.log('dentes achados:', dentes.length);
  if (dentes.length !== 32) {
    console.log('tamanhos:', dentes.map((c) => c.n).join(' '));
    process.exit(1);
  }
  // Centro da arcada e o meio entre a de cima e a de baixo.
  const cx = dentes.reduce((s, c) => s + c.cx, 0) / 32;
  const ys = dentes.map((c) => c.cy).sort((a, b) => a - b);
  // O maior salto vertical entre dentes vizinhos separa as arcadas... na lateral; usa a mediana.
  const meioY = (ys[15] + ys[16]) / 2;
  for (const c of dentes) {
    const cima = c.cy < meioY;
    c.cima = cima;
    c.ang = cima ? Math.atan2(c.cx - cx, meioY - c.cy) : Math.atan2(c.cx - cx, c.cy - meioY);
  }
  const numerar = (lista, q) => lista.sort((a, b) => Math.abs(a.ang) - Math.abs(b.ang)).forEach((c, k) => (c.fdi = q * 10 + k + 1));
  numerar(dentes.filter((c) => c.cima && c.cx < cx), 1);
  numerar(dentes.filter((c) => c.cima && c.cx >= cx), 2);
  numerar(dentes.filter((c) => !c.cima && c.cx >= cx), 3);
  numerar(dentes.filter((c) => !c.cima && c.cx < cx), 4);
  const porQ = [1, 2, 3, 4].map((q) => dentes.filter((c) => Math.floor(c.fdi / 10) === q).length);
  console.log('por quadrante:', porQ.join(' '));

  // Contorno: raios a partir do centro do dente até o último pixel do dente (com 2 px de folga para o traço).
  const doDente = new Uint8Array(W * H);
  const mapa = [];
  for (const c of dentes) {
    doDente.fill(0);
    for (const p of c.pix) doDente[p] = 1;
    const pts = [];
    const N = 72;
    const raios = [];
    for (let k = 0; k < N; k++) {
      const a = (2 * Math.PI * k) / N;
      let ultimo = 0;
      for (let r = 0; r < 120; r += 0.5) {
        const x = Math.round(c.cx + r * Math.cos(a));
        const y = Math.round(c.cy + r * Math.sin(a));
        if (x < 0 || y < 0 || x >= W || y >= H) break;
        if (doDente[y * W + x]) ultimo = r;
      }
      raios.push(ultimo);
    }
    // Alisa os raios (o número e os sulcos dentro não mudam o contorno de fora).
    const lisos = raios.map((_, k) => (raios[(k + N - 1) % N] + 2 * raios[k] + raios[(k + 1) % N]) / 4 + 2);
    for (let k = 0; k < N; k++) {
      const a = (2 * Math.PI * k) / N;
      pts.push([c.cx + lisos[k] * Math.cos(a), c.cy + lisos[k] * Math.sin(a)]);
    }
    mapa.push({ fdi: c.fdi, cx: c.cx, cy: c.cy, pts });
  }
  // Recorte: só a arcada, com margem, sem a moldura do cartão.
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const m of mapa) for (const [x, y] of m.pts) {
    x0 = Math.min(x0, x);
    y0 = Math.min(y0, y);
    x1 = Math.max(x1, x);
    y1 = Math.max(y1, y);
  }
  const M = 10;
  const rx = Math.max(0, Math.floor(x0 - M));
  const ry = Math.max(0, Math.floor(y0 - M));
  const rw = Math.min(W, Math.ceil(x1 + M)) - rx;
  const rh = Math.min(H, Math.ceil(y1 + M)) - ry;
  const recorte = await sharp(entrada).extract({ left: rx, top: ry, width: rw, height: rh }).ensureAlpha().raw().toBuffer();
  // Fundo claro some; a borda suave entre o traço e o fundo fica parcial, sem halo branco.
  for (let i = 0; i < rw * rh; i++) {
    const l = 0.299 * recorte[4 * i] + 0.587 * recorte[4 * i + 1] + 0.114 * recorte[4 * i + 2];
    const a = Math.max(0, Math.min(1, (250 - l) / 36));
    if (a > 0 && a < 1) for (let k = 0; k < 3; k++) recorte[4 * i + k] = Math.max(0, Math.min(255, Math.round((recorte[4 * i + k] - 255 * (1 - a)) / a)));
    recorte[4 * i + 3] = Math.round(a * 255);
  }
  await sharp(recorte, { raw: { width: rw, height: rh, channels: 4 } }).png({ compressionLevel: 9 }).toFile(saidaPng);
  mapa.sort((a, b) => a.fdi - b.fdi);
  const f = (v) => Math.round(v * 10) / 10;
  const linhas = mapa.map((m) => {
    const d = 'M' + m.pts.map(([x, y]) => `${f(x - rx)} ${f(y - ry)}`).join('L') + 'Z';
    return `  { fdi: ${m.fdi}, x: ${f(m.cx - rx)}, y: ${f(m.cy - ry)}, contorno: '${d}' },`;
  });
  const ts = `/**
 * Passos CAD — mapa da imagem da arcada da ficha (public/passos-cad/arcada.png): onde fica cada
 * dente na imagem, em pixels dela. Gerado a partir da própria imagem por
 * scripts/passos-cad/mapa-da-arcada.cjs (cinza de cada dente, contorno pelos raios a partir do
 * centro). Trocou a imagem: gere de novo.
 */
export const LARGURA_DA_IMAGEM = ${rw};
export const ALTURA_DA_IMAGEM = ${rh};

export interface DenteNaImagem {
  fdi: number;
  /** Centro do dente, em pixels da imagem. */
  x: number;
  y: number;
  /** Contorno do dente (caminho SVG em pixels da imagem): área do clique e do destaque. */
  contorno: string;
}

export const DENTES_DA_IMAGEM: readonly DenteNaImagem[] = Object.freeze([
${linhas.join('\n')}
]);
`;
  fs.writeFileSync(saidaTs, ts);
  console.log('recorte', rx, ry, rw, rh, '→', saidaPng, saidaTs);
})();

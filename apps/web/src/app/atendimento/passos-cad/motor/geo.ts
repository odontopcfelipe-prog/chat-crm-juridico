/**
 * Passos CAD — base geométrica: vetores, malha indexada e BVH (raio e ponto mais próximo).
 * Módulo puro: roda no navegador (Web Worker) e nos testes. Unidades em milímetros.
 */

// Math em nomes locais: no jest (que roda o código isolado), cada acesso a Math dentro de um laço
// custava centenas de vezes mais (medido: 10,6 s contra 0,03 s). No navegador tanto faz.
const { abs, floor, hypot, max, min, sqrt } = Math;

export type V3 = readonly [number, number, number];

export interface Malha {
  pos: Float64Array;
  tri: Uint32Array;
}

export const soma = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const mul = (a: V3, s: number): V3 => [a[0] * s, a[1] * s, a[2] * s];
export const dot = (a: V3, b: V3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
export const norma = (a: V3): number => hypot(a[0], a[1], a[2]);
export const unit = (a: V3): V3 => mul(a, 1 / (norma(a) || 1));
export const vert = (m: Malha, i: number): V3 => [m.pos[3 * i], m.pos[3 * i + 1], m.pos[3 * i + 2]];
export const passoSuave = (a: number, b: number, x: number): number => {
  const t = min(max((x - a) / (b - a), 0), 1);
  return t * t * (3 - 2 * t);
};

export function centroide(pos: ArrayLike<number>): V3 {
  const s = [0, 0, 0];
  for (let i = 0; i < pos.length; i++) s[i % 3] += pos[i];
  const n = pos.length / 3 || 1;
  return [s[0] / n, s[1] / n, s[2] / n];
}

export function juntar(...malhas: Malha[]): Malha {
  const np = malhas.reduce((s, m) => s + m.pos.length, 0);
  const nt = malhas.reduce((s, m) => s + m.tri.length, 0);
  const pos = new Float64Array(np);
  const tri = new Uint32Array(nt);
  let op = 0;
  let ot = 0;
  for (const m of malhas) {
    pos.set(m.pos, op);
    const base = op / 3;
    for (let k = 0; k < m.tri.length; k++) tri[ot + k] = m.tri[k] + base;
    op += m.pos.length;
    ot += m.tri.length;
  }
  return { pos, tri };
}

/** Só os triângulos que `manter` aceita; os vértices sem uso saem. */
export function filtrarTriangulos(m: Malha, manter: (a: V3, b: V3, c: V3) => boolean): Malha {
  const novo = new Int32Array(m.pos.length / 3).fill(-1);
  const pos: number[] = [];
  const tri: number[] = [];
  for (let t = 0; t < m.tri.length; t += 3) {
    const ids = [m.tri[t], m.tri[t + 1], m.tri[t + 2]];
    if (!manter(vert(m, ids[0]), vert(m, ids[1]), vert(m, ids[2]))) continue;
    for (const v of ids) {
      if (novo[v] < 0) {
        novo[v] = pos.length / 3;
        pos.push(m.pos[3 * v], m.pos[3 * v + 1], m.pos[3 * v + 2]);
      }
      tri.push(novo[v]);
    }
  }
  return { pos: Float64Array.from(pos), tri: Uint32Array.from(tri) };
}

export function recortarCaixa(m: Malha, c: V3, r: number): Malha {
  const dentro = (p: V3) => abs(p[0] - c[0]) < r && abs(p[1] - c[1]) < r && abs(p[2] - c[2]) < r;
  return filtrarTriangulos(m, (a, b, d) => dentro(a) || dentro(b) || dentro(d));
}

export function normaisDeVertice(m: Malha): Float64Array {
  const n = new Float64Array(m.pos.length);
  const p = m.pos;
  for (let t = 0; t < m.tri.length; t += 3) {
    const a = m.tri[t] * 3;
    const b = m.tri[t + 1] * 3;
    const c = m.tri[t + 2] * 3;
    const ux = p[b] - p[a];
    const uy = p[b + 1] - p[a + 1];
    const uz = p[b + 2] - p[a + 2];
    const vx = p[c] - p[a];
    const vy = p[c + 1] - p[a + 1];
    const vz = p[c + 2] - p[a + 2];
    const nx = uy * vz - uz * vy;
    const ny = uz * vx - ux * vz;
    const nz = ux * vy - uy * vx;
    for (const i of [a, b, c]) {
      n[i] += nx;
      n[i + 1] += ny;
      n[i + 2] += nz;
    }
  }
  for (let i = 0; i < n.length; i += 3) {
    const l = hypot(n[i], n[i + 1], n[i + 2]) || 1;
    n[i] /= l;
    n[i + 1] /= l;
    n[i + 2] /= l;
  }
  return n;
}

export interface Conferencia {
  vertices: number;
  triangulos: number;
  arestasAbertas: number;
  arestasRepetidas: number;
  degenerados: number;
  volume: number;
}

/** Malha fechada e sem dobra de orientação? Volume positivo = normais para fora. */
export function conferirMalha(m: Malha): Conferencia {
  const nv = m.pos.length / 3;
  const arestas = new Set<number>();
  let repetidas = 0;
  let degenerados = 0;
  let volume = 0;
  for (let t = 0; t < m.tri.length; t += 3) {
    const ids = [m.tri[t], m.tri[t + 1], m.tri[t + 2]];
    for (let e = 0; e < 3; e++) {
      const k = ids[e] * nv + ids[(e + 1) % 3];
      if (arestas.has(k)) repetidas++;
      arestas.add(k);
    }
    const [a, b, c] = ids.map((i) => vert(m, i));
    const n = cross(sub(b, a), sub(c, a));
    if (norma(n) < 1e-12) degenerados++;
    volume += dot(a, cross(b, c)) / 6;
  }
  let abertas = 0;
  for (const k of arestas) {
    const a = floor(k / nv);
    const b = k - a * nv;
    if (!arestas.has(b * nv + a)) abertas++;
  }
  return { vertices: nv, triangulos: m.tri.length / 3, arestasAbertas: abertas, arestasRepetidas: repetidas, degenerados, volume };
}

export interface Acerto {
  t: number;
  tri: number;
  u: number;
  v: number;
  ponto: V3;
  normal: V3;
}

export interface Proximo {
  d: number;
  tri: number;
  ponto: V3;
  normal: V3;
}

/** BVH por mediana do maior eixo; folhas de até 6 triângulos. */
export class Bvh {
  readonly m: Malha;
  readonly normais: Float64Array;
  private readonly ordem: Uint32Array;
  private readonly caixaTri: Float64Array;
  // nós: min(3) max(3) esq dir inicio qtd
  private caixas: number[] = [];
  private filhos: number[] = [];

  constructor(m: Malha) {
    this.m = m;
    this.normais = normaisDeVertice(m);
    const nt = m.tri.length / 3;
    const cen = new Float64Array(nt * 3);
    this.caixaTri = new Float64Array(nt * 6);
    for (let t = 0; t < nt; t++) {
      const a = m.tri[3 * t] * 3;
      const b = m.tri[3 * t + 1] * 3;
      const c = m.tri[3 * t + 2] * 3;
      for (let e = 0; e < 3; e++) {
        const x = m.pos[a + e];
        const y = m.pos[b + e];
        const z = m.pos[c + e];
        this.caixaTri[6 * t + e] = min(x, y, z);
        this.caixaTri[6 * t + 3 + e] = max(x, y, z);
        cen[3 * t + e] = (x + y + z) / 3;
      }
    }
    this.ordem = Uint32Array.from({ length: nt }, (_, i) => i);
    if (nt > 0) this.construir(0, nt, cen);
  }

  private construir(ini: number, fim: number, cen: Float64Array): number {
    const id = this.filhos.length / 4;
    const cx = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
    for (let i = ini; i < fim; i++) {
      const t = this.ordem[i];
      for (let e = 0; e < 3; e++) {
        cx[e] = min(cx[e], this.caixaTri[6 * t + e]);
        cx[3 + e] = max(cx[3 + e], this.caixaTri[6 * t + 3 + e]);
      }
    }
    this.caixas.push(...cx);
    this.filhos.push(-1, -1, ini, fim - ini);
    if (fim - ini <= 6) return id;
    const ext = [cx[3] - cx[0], cx[4] - cx[1], cx[5] - cx[2]];
    const eixo = ext.indexOf(max(...ext));
    const parte = Array.from(this.ordem.subarray(ini, fim)).sort((p, q) => cen[3 * p + eixo] - cen[3 * q + eixo]);
    this.ordem.set(parte, ini);
    const meio = (ini + fim) >> 1;
    const esq = this.construir(ini, meio, cen);
    const dir = this.construir(meio, fim, cen);
    this.filhos[4 * id] = esq;
    this.filhos[4 * id + 1] = dir;
    this.filhos[4 * id + 3] = 0;
    return id;
  }

  /** Os vértices mudaram de lugar, a ligação não: refaz as caixas, dos nós mais fundos para a raiz. */
  ajustarCaixas(): void {
    const c = this.caixas;
    const f = this.filhos;
    const p = this.m.pos;
    const tri = this.m.tri;
    for (let n = f.length / 4 - 1; n >= 0; n--) {
      const b = 6 * n;
      if (f[4 * n + 3] === 0) {
        const e = 6 * f[4 * n];
        const d = 6 * f[4 * n + 1];
        for (let k = 0; k < 3; k++) {
          c[b + k] = min(c[e + k], c[d + k]);
          c[b + 3 + k] = max(c[e + 3 + k], c[d + 3 + k]);
        }
        continue;
      }
      for (let k = 0; k < 3; k++) {
        c[b + k] = Infinity;
        c[b + 3 + k] = -Infinity;
      }
      const ini = f[4 * n + 2];
      const fim = ini + f[4 * n + 3];
      for (let i = ini; i < fim; i++) {
        const t = this.ordem[i];
        for (let q = 0; q < 3; q++) {
          const v = tri[3 * t + q] * 3;
          for (let k = 0; k < 3; k++) {
            const x = p[v + k];
            if (x < c[b + k]) c[b + k] = x;
            if (x > c[b + 3 + k]) c[b + 3 + k] = x;
          }
        }
      }
    }
  }

  normalEm(t: number, u: number, v: number): V3 {
    const a = this.m.tri[3 * t] * 3;
    const b = this.m.tri[3 * t + 1] * 3;
    const c = this.m.tri[3 * t + 2] * 3;
    const w = 1 - u - v;
    const n = this.normais;
    return unit([w * n[a] + u * n[b] + v * n[c], w * n[a + 1] + u * n[b + 1] + v * n[c + 1], w * n[a + 2] + u * n[b + 2] + v * n[c + 2]]);
  }

  /** Primeiro cruzamento de o + t·d (d unitário) com t em (0, tMax). */
  raio(o: V3, d: V3, tMax = Infinity): Acerto | null {
    if (!this.filhos.length) return null;
    const ix = 1 / (d[0] || 1e-300);
    const iy = 1 / (d[1] || 1e-300);
    const iz = 1 / (d[2] || 1e-300);
    const pos = this.m.pos;
    const tri = this.m.tri;
    const pilha = [0];
    let melhorT = tMax;
    let melhor = -1;
    let mu = 0;
    let mv = 0;
    while (pilha.length) {
      const n = pilha.pop() as number;
      const c = this.caixas;
      const b = 6 * n;
      let t0 = 0;
      let t1 = melhorT;
      let a1 = (c[b] - o[0]) * ix;
      let a2 = (c[b + 3] - o[0]) * ix;
      t0 = max(t0, min(a1, a2));
      t1 = min(t1, max(a1, a2));
      if (t0 > t1) continue;
      a1 = (c[b + 1] - o[1]) * iy;
      a2 = (c[b + 4] - o[1]) * iy;
      t0 = max(t0, min(a1, a2));
      t1 = min(t1, max(a1, a2));
      if (t0 > t1) continue;
      a1 = (c[b + 2] - o[2]) * iz;
      a2 = (c[b + 5] - o[2]) * iz;
      t0 = max(t0, min(a1, a2));
      t1 = min(t1, max(a1, a2));
      if (t0 > t1) continue;
      if (this.filhos[4 * n + 3] === 0) {
        pilha.push(this.filhos[4 * n], this.filhos[4 * n + 1]);
        continue;
      }
      const ini = this.filhos[4 * n + 2];
      const fim = ini + this.filhos[4 * n + 3];
      for (let i = ini; i < fim; i++) {
        const t = this.ordem[i];
        const A = tri[3 * t] * 3;
        const B = tri[3 * t + 1] * 3;
        const C = tri[3 * t + 2] * 3;
        const e1x = pos[B] - pos[A];
        const e1y = pos[B + 1] - pos[A + 1];
        const e1z = pos[B + 2] - pos[A + 2];
        const e2x = pos[C] - pos[A];
        const e2y = pos[C + 1] - pos[A + 1];
        const e2z = pos[C + 2] - pos[A + 2];
        const px = d[1] * e2z - d[2] * e2y;
        const py = d[2] * e2x - d[0] * e2z;
        const pz = d[0] * e2y - d[1] * e2x;
        const det = e1x * px + e1y * py + e1z * pz;
        if (abs(det) < 1e-12) continue;
        const sx = o[0] - pos[A];
        const sy = o[1] - pos[A + 1];
        const sz = o[2] - pos[A + 2];
        const u = (sx * px + sy * py + sz * pz) / det;
        if (u < 0 || u > 1) continue;
        const qx = sy * e1z - sz * e1y;
        const qy = sz * e1x - sx * e1z;
        const qz = sx * e1y - sy * e1x;
        const v = (d[0] * qx + d[1] * qy + d[2] * qz) / det;
        if (v < 0 || u + v > 1) continue;
        const tt = (e2x * qx + e2y * qy + e2z * qz) / det;
        if (tt > 1e-7 && tt < melhorT) {
          melhorT = tt;
          melhor = t;
          mu = u;
          mv = v;
        }
      }
    }
    if (melhor < 0) return null;
    return { t: melhorT, tri: melhor, u: mu, v: mv, ponto: soma(o, mul(d, melhorT)), normal: this.normalEm(melhor, mu, mv) };
  }

  /** Ponto mais próximo até maxD; d com sinal pela normal (positivo = do lado de fora). */
  proximo(p: V3, maxD = Infinity): Proximo | null {
    if (!this.filhos.length) return null;
    const m = this.m;
    const c = this.caixas;
    const pilha = [0];
    let melhor2 = maxD === Infinity ? Infinity : maxD * maxD;
    let melhorT = -1;
    let melhorP: V3 = [0, 0, 0];
    let mu = 0;
    let mv = 0;
    while (pilha.length) {
      const n = pilha.pop() as number;
      if (distCaixa2(c, n, p) > melhor2) continue;
      if (this.filhos[4 * n + 3] === 0) {
        // A caixa mais perto primeiro (fica no topo da pilha): acha cedo um ponto bom e corta o resto.
        const e = this.filhos[4 * n];
        const d = this.filhos[4 * n + 1];
        if (distCaixa2(c, e, p) < distCaixa2(c, d, p)) pilha.push(d, e);
        else pilha.push(e, d);
        continue;
      }
      const ini = this.filhos[4 * n + 2];
      const fim = ini + this.filhos[4 * n + 3];
      for (let i = ini; i < fim; i++) {
        const t = this.ordem[i];
        const r = pontoNoTriangulo(p, vert(m, m.tri[3 * t]), vert(m, m.tri[3 * t + 1]), vert(m, m.tri[3 * t + 2]));
        const dx = r.p[0] - p[0];
        const dy = r.p[1] - p[1];
        const dz = r.p[2] - p[2];
        const d2 = dx * dx + dy * dy + dz * dz;
        if (d2 < melhor2) {
          melhor2 = d2;
          melhorT = t;
          melhorP = r.p;
          mu = r.u;
          mv = r.v;
        }
      }
    }
    if (melhorT < 0) return null;
    const normal = this.normalEm(melhorT, mu, mv);
    const dist = sqrt(melhor2);
    return { d: dot(sub(p, melhorP), normal) >= 0 ? dist : -dist, tri: melhorT, ponto: melhorP, normal };
  }
}

/** Distância² de p até a caixa do nó (0 se estiver dentro). */
function distCaixa2(c: number[], n: number, p: V3): number {
  const b = 6 * n;
  let dd = 0;
  for (let e = 0; e < 3; e++) {
    const q = max(c[b + e] - p[e], 0, p[e] - c[b + 3 + e]);
    dd += q * q;
  }
  return dd;
}

/** Ponto do triângulo mais perto de p; u e v são os pesos de b e c. */
function pontoNoTriangulo(p: V3, a: V3, b: V3, c: V3): { p: V3; u: number; v: number } {
  const ab = sub(b, a);
  const ac = sub(c, a);
  const ap = sub(p, a);
  const d1 = dot(ab, ap);
  const d2 = dot(ac, ap);
  if (d1 <= 0 && d2 <= 0) return { p: a, u: 0, v: 0 };
  const bp = sub(p, b);
  const d3 = dot(ab, bp);
  const d4 = dot(ac, bp);
  if (d3 >= 0 && d4 <= d3) return { p: b, u: 1, v: 0 };
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) {
    const v = d1 / (d1 - d3);
    return { p: soma(a, mul(ab, v)), u: v, v: 0 };
  }
  const cp = sub(p, c);
  const d5 = dot(ab, cp);
  const d6 = dot(ac, cp);
  if (d6 >= 0 && d5 <= d6) return { p: c, u: 0, v: 1 };
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) {
    const w = d2 / (d2 - d6);
    return { p: soma(a, mul(ac, w)), u: 0, v: w };
  }
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
    const w = (d4 - d3) / (d4 - d3 + (d5 - d6));
    return { p: soma(b, mul(sub(c, b), w)), u: 1 - w, v: w };
  }
  const den = 1 / (va + vb + vc);
  const v = vb * den;
  const w = vc * den;
  return { p: soma(a, soma(mul(ab, v), mul(ac, w))), u: v, v: w };
}

/** Grade (colunas × J+1) com polo único na linha 0: superfície aberta na margem. */
export function malhaDaGrade(col: V3[][], J: number): Malha {
  const NT = col.length;
  const pos: number[] = [...col[0][0]];
  const tri: number[] = [];
  const id = (i: number, j: number) => (j === 0 ? 0 : 1 + i * J + (j - 1));
  for (let i = 0; i < NT; i++) for (let j = 1; j <= J; j++) pos.push(...col[i][j]);
  for (let i = 0; i < NT; i++) {
    const k = (i + 1) % NT;
    tri.push(0, id(k, 1), id(i, 1));
    for (let j = 1; j < J; j++) tri.push(id(i, j), id(k, j), id(k, j + 1), id(i, j), id(k, j + 1), id(i, j + 1));
  }
  const m = { pos: Float64Array.from(pos), tri: Uint32Array.from(tri) };
  // Normais para fora do troquel: confere no polo.
  const n = cross(sub(vert(m, m.tri[1]), vert(m, m.tri[0])), sub(vert(m, m.tri[2]), vert(m, m.tri[0])));
  const fora = sub(col[0][0], centroide(m.pos));
  if (dot(n, fora) < 0) {
    for (let t = 0; t < m.tri.length; t += 3) {
      const x = m.tri[t + 1];
      m.tri[t + 1] = m.tri[t + 2];
      m.tri[t + 2] = x;
    }
  }
  return m;
}

/**
 * Passos CAD — encaixe pela oclusão. Quando a arcada e o antagonista não chegam na posição da mordida,
 * o escaneamento da oclusão (as duas arcadas mordendo, vistas por fora) diz onde cada uma fica. A
 * oclusão é encaixada em cada arcada: primeiro pela forma (descritores de superfície e sorteio de
 * trios), depois pelo ajuste fino (ponto a plano). O antagonista vai para as coordenadas da arcada; a
 * arcada não se move, porque a coroa sai nas coordenadas dela.
 */

// Math em nomes locais: no jest (que roda o código isolado), cada acesso a Math dentro de um laço
// custava centenas de vezes mais (medido: 10,6 s contra 0,03 s). No navegador tanto faz.
const { PI, abs, acos, atan2, cos, floor, hypot, max, min, sign, sin, sqrt } = Math;
import {
  Bvh,
  cross,
  dot,
  norma,
  normaisDeVertice,
  sub,
  type Malha,
  type V3,
} from "./geo";

/** Rotação (linha a linha, 3 × 3) e translação. */
export interface Rigida {
  R: number[];
  t: V3;
}

export const IDENTIDADE: Rigida = {
  R: [1, 0, 0, 0, 1, 0, 0, 0, 1],
  t: [0, 0, 0],
};

const girar = (R: number[], p: V3): V3 => [
  R[0] * p[0] + R[1] * p[1] + R[2] * p[2],
  R[3] * p[0] + R[4] * p[1] + R[5] * p[2],
  R[6] * p[0] + R[7] * p[1] + R[8] * p[2],
];

export function aplicar(T: Rigida, p: V3): V3 {
  const q = girar(T.R, p);
  return [q[0] + T.t[0], q[1] + T.t[1], q[2] + T.t[2]];
}

/** A depois de B. */
export function compor(A: Rigida, B: Rigida): Rigida {
  const R: number[] = [];
  for (let i = 0; i < 3; i++)
    for (let j = 0; j < 3; j++)
      R.push(
        A.R[3 * i] * B.R[j] +
          A.R[3 * i + 1] * B.R[3 + j] +
          A.R[3 * i + 2] * B.R[6 + j],
      );
  const t = girar(A.R, B.t);
  return { R, t: [t[0] + A.t[0], t[1] + A.t[1], t[2] + A.t[2]] };
}

export function inversa(T: Rigida): Rigida {
  const R = [
    T.R[0],
    T.R[3],
    T.R[6],
    T.R[1],
    T.R[4],
    T.R[7],
    T.R[2],
    T.R[5],
    T.R[8],
  ];
  const t = girar(R, T.t);
  return { R, t: [-t[0], -t[1], -t[2]] };
}

/** Rotação e translação não mudam o sentido dos triângulos: só os pontos andam. */
export function moverMalha(m: Malha, T: Rigida): Malha {
  const pos = new Float64Array(m.pos.length);
  for (let i = 0; i < pos.length; i += 3) {
    const q = aplicar(T, [m.pos[i], m.pos[i + 1], m.pos[i + 2]]);
    pos[i] = q[0];
    pos[i + 1] = q[1];
    pos[i + 2] = q[2];
  }
  return { pos, tri: Uint32Array.from(m.tri) };
}

// ---------------------------------------------------------------- nuvem de pontos

interface Nuvem {
  pos: Float64Array;
  nor: Float64Array;
  qtd: number;
}

const ponto = (n: Nuvem, i: number): V3 => [
  n.pos[3 * i],
  n.pos[3 * i + 1],
  n.pos[3 * i + 2],
];
const normal = (n: Nuvem, i: number): V3 => [
  n.nor[3 * i],
  n.nor[3 * i + 1],
  n.nor[3 * i + 2],
];

/** Chave da célula: cabe em 2^53 com até 65 mil células para cada lado. */
const chave = (x: number, y: number, z: number): number =>
  ((x + 65536) * 131072 + (y + 65536)) * 131072 + (z + 65536);

/** Um ponto por cubo de lado `voxel`: a média dos vértices e das normais dele. */
function nuvemDaMalha(m: Malha, voxel: number): Nuvem {
  const nv = normaisDeVertice(m);
  const idx = new Map<number, number>();
  const sp: number[] = [];
  const sn: number[] = [];
  const cont: number[] = [];
  for (let v = 0; v < m.pos.length; v += 3) {
    const k = chave(
      floor(m.pos[v] / voxel),
      floor(m.pos[v + 1] / voxel),
      floor(m.pos[v + 2] / voxel),
    );
    let i = idx.get(k);
    if (i === undefined) {
      i = cont.length;
      idx.set(k, i);
      sp.push(0, 0, 0);
      sn.push(0, 0, 0);
      cont.push(0);
    }
    for (let e = 0; e < 3; e++) {
      sp[3 * i + e] += m.pos[v + e];
      sn[3 * i + e] += nv[v + e];
    }
    cont[i]++;
  }
  const pos: number[] = [];
  const nor: number[] = [];
  for (let i = 0; i < cont.length; i++) {
    const l = hypot(sn[3 * i], sn[3 * i + 1], sn[3 * i + 2]);
    if (l < 1e-9) continue;
    pos.push(
      sp[3 * i] / cont[i],
      sp[3 * i + 1] / cont[i],
      sp[3 * i + 2] / cont[i],
    );
    nor.push(sn[3 * i] / l, sn[3 * i + 1] / l, sn[3 * i + 2] / l);
  }
  return {
    pos: Float64Array.from(pos),
    nor: Float64Array.from(nor),
    qtd: pos.length / 3,
  };
}

/** Grade espacial para achar os vizinhos de um ponto sem olhar a nuvem inteira. */
class Grade {
  private readonly celulas = new Map<number, number[]>();

  constructor(
    private readonly n: Nuvem,
    private readonly lado: number,
  ) {
    for (let i = 0; i < n.qtd; i++) {
      const k = chave(
        floor(n.pos[3 * i] / lado),
        floor(n.pos[3 * i + 1] / lado),
        floor(n.pos[3 * i + 2] / lado),
      );
      const c = this.celulas.get(k);
      if (c) c.push(i);
      else this.celulas.set(k, [i]);
    }
  }

  /** Os pontos a até `raio` (no máximo o lado da célula) de p, sem ele mesmo. */
  perto(
    p: V3,
    raio: number,
    menos: number,
    saida: number[],
    dist: number[],
  ): void {
    saida.length = 0;
    dist.length = 0;
    const cx = floor(p[0] / this.lado);
    const cy = floor(p[1] / this.lado);
    const cz = floor(p[2] / this.lado);
    const r2 = raio * raio;
    for (let a = -1; a <= 1; a++) {
      for (let b = -1; b <= 1; b++) {
        for (let c = -1; c <= 1; c++) {
          const cel = this.celulas.get(chave(cx + a, cy + b, cz + c));
          if (!cel) continue;
          for (const i of cel) {
            if (i === menos) continue;
            const dx = this.n.pos[3 * i] - p[0];
            const dy = this.n.pos[3 * i + 1] - p[1];
            const dz = this.n.pos[3 * i + 2] - p[2];
            const d2 = dx * dx + dy * dy + dz * dz;
            if (d2 <= r2) {
              saida.push(i);
              dist.push(d2);
            }
          }
        }
      }
    }
  }
}

// ---------------------------------------------------------------- descritor da superfície (FPFH)

const BINS = 11;
const TAMANHO_DO_DESCRITOR = 3 * BINS;

/** Os três ângulos entre dois pontos com normal (Rusu, 2009), já na casa do histograma. */
function casasDoPar(
  ps: V3,
  ns: V3,
  pt: V3,
  nt: V3,
): [number, number, number] | null {
  let d = sub(pt, ps);
  const dist = norma(d);
  if (dist < 1e-9) return null;
  let n1 = ns;
  let n2 = nt;
  let f3 = dot(ns, d) / dist;
  const a2 = dot(nt, d) / dist;
  if (
    acos(min(1, abs(f3))) > acos(min(1, abs(a2)))
  ) {
    n1 = nt;
    n2 = ns;
    d = [-d[0], -d[1], -d[2]];
    f3 = -a2;
  }
  const v0 = cross(d, n1);
  const lv = norma(v0);
  if (lv < 1e-12) return null;
  const v: V3 = [v0[0] / lv, v0[1] / lv, v0[2] / lv];
  const w = cross(n1, v);
  const f2 = dot(v, n2);
  const f1 = atan2(dot(w, n2), dot(n1, n2));
  const casa = (x: number) =>
    min(BINS - 1, max(0, floor(x * BINS)));
  return [
    casa((f1 + PI) / (2 * PI)),
    BINS + casa((f2 + 1) / 2),
    2 * BINS + casa((f3 + 1) / 2),
  ];
}

/** Descritor de cada ponto: como as normais em volta se inclinam, num raio de alguns milímetros. */
function descritores(n: Nuvem, raio: number, sinal: 1 | -1): Float64Array {
  const grade = new Grade(n, raio);
  const nor = (i: number): V3 => {
    const v = normal(n, i);
    return sinal === 1 ? v : [-v[0], -v[1], -v[2]];
  };
  const spfh = new Float64Array(n.qtd * TAMANHO_DO_DESCRITOR);
  const vizinhos: Int32Array[] = [];
  const distancias: Float64Array[] = [];
  const viz: number[] = [];
  const d2: number[] = [];
  for (let i = 0; i < n.qtd; i++) {
    grade.perto(ponto(n, i), raio, i, viz, d2);
    vizinhos.push(Int32Array.from(viz));
    distancias.push(Float64Array.from(d2));
    if (!viz.length) continue;
    const passo = 100 / viz.length;
    const pi = ponto(n, i);
    const ni = nor(i);
    for (const j of viz) {
      const c = casasDoPar(pi, ni, ponto(n, j), nor(j));
      if (!c) continue;
      for (const k of c) spfh[i * TAMANHO_DO_DESCRITOR + k] += passo;
    }
  }
  const fpfh = new Float64Array(n.qtd * TAMANHO_DO_DESCRITOR);
  const soma = new Float64Array(TAMANHO_DO_DESCRITOR);
  for (let i = 0; i < n.qtd; i++) {
    soma.fill(0);
    const vi = vizinhos[i];
    for (let k = 0; k < vi.length; k++) {
      const w = 1 / max(distancias[i][k], 1e-6);
      const j = vi[k];
      for (let b = 0; b < TAMANHO_DO_DESCRITOR; b++)
        soma[b] += w * spfh[j * TAMANHO_DO_DESCRITOR + b];
    }
    for (let bloco = 0; bloco < 3; bloco++) {
      let s = 0;
      for (let b = 0; b < BINS; b++) s += soma[bloco * BINS + b];
      for (let b = 0; b < BINS; b++) {
        const k = bloco * BINS + b;
        fpfh[i * TAMANHO_DO_DESCRITOR + k] =
          spfh[i * TAMANHO_DO_DESCRITOR + k] +
          (s > 0 ? (100 * soma[k]) / s : 0);
      }
    }
  }
  return fpfh;
}

/**
 * Pontos longe da borda do escaneamento. Perto da borda, metade da vizinhança falta, e o descritor
 * não se parece com o do mesmo lugar na arcada inteira. A oclusão é uma faixa estreita: quase tudo
 * nela está perto de alguma borda. Com o consenso e a triagem, eles não mudam o acerto (24 de 24 com e
 * sem), mas tiram metade dos pares errados: a recusa de uma oclusão de outra boca cai de 82 para 37 s.
 */
function longeDaBorda(n: Nuvem, raio: number): number[] {
  const grade = new Grade(n, raio);
  const viz: number[] = [];
  const d2: number[] = [];
  const dentro: number[] = [];
  for (let i = 0; i < n.qtd; i++) {
    const p = ponto(n, i);
    grade.perto(p, raio, i, viz, d2);
    if (viz.length < 8) continue;
    const m = [0, 0, 0];
    for (const j of viz)
      for (let e = 0; e < 3; e++)
        m[e] += (n.pos[3 * j + e] - p[e]) / viz.length;
    const nr = normal(n, i);
    const ao = dot(m as unknown as V3, nr);
    // Só o deslocamento ao longo da superfície conta: a curvatura empurra para dentro sem ser borda.
    const lateral = hypot(
      m[0] - ao * nr[0],
      m[1] - ao * nr[1],
      m[2] - ao * nr[2],
    );
    if (lateral < 0.25 * raio) dentro.push(i);
  }
  return dentro;
}

/** Para cada ponto de `quais`, os `k` descritores mais parecidos em B: [ponto, lugar em B, posição no ranking]. */
function paresParecidos(
  A: Float64Array,
  quais: number[],
  B: Float64Array,
  nB: number,
  k: number,
): [number, number, number][] {
  const D = TAMANHO_DO_DESCRITOR;
  const pares: [number, number, number][] = [];
  const melhores: number[] = [];
  const dist: number[] = [];
  for (const i of quais) {
    melhores.length = 0;
    dist.length = 0;
    for (let j = 0; j < nB; j++) {
      const limite = dist.length < k ? Infinity : dist[dist.length - 1];
      let s = 0;
      for (let c = 0; c < D && s < limite; c++) {
        const x = A[i * D + c] - B[j * D + c];
        s += x * x;
      }
      if (s >= limite) continue;
      let pos = dist.length;
      while (pos > 0 && dist[pos - 1] > s) pos--;
      dist.splice(pos, 0, s);
      melhores.splice(pos, 0, j);
      if (dist.length > k) {
        dist.pop();
        melhores.pop();
      }
    }
    melhores.forEach((j, r) => pares.push([i, j, r]));
  }
  return pares;
}

// ---------------------------------------------------------------- álgebra pequena

/** Autovalores e autovetores (colunas) de uma matriz simétrica pequena, por Jacobi. */
function jacobi(M: number[][]): { valores: number[]; vetores: number[][] } {
  const n = M.length;
  const a = M.map((l) => [...l]);
  const v = Array.from({ length: n }, (_, i) =>
    Array.from({ length: n }, (_, j): number => (i === j ? 1 : 0)),
  );
  for (let volta = 0; volta < 60; volta++) {
    let fora = 0;
    for (let p = 0; p < n; p++)
      for (let q = p + 1; q < n; q++) fora += a[p][q] * a[p][q];
    if (fora < 1e-22) break;
    for (let p = 0; p < n; p++) {
      for (let q = p + 1; q < n; q++) {
        if (abs(a[p][q]) < 1e-30) continue;
        const th = (a[q][q] - a[p][p]) / (2 * a[p][q]);
        const t = sign(th || 1) / (abs(th) + sqrt(th * th + 1));
        const c = 1 / sqrt(t * t + 1);
        const s = t * c;
        for (let k = 0; k < n; k++) {
          const akp = a[k][p];
          const akq = a[k][q];
          a[k][p] = c * akp - s * akq;
          a[k][q] = s * akp + c * akq;
        }
        for (let k = 0; k < n; k++) {
          const apk = a[p][k];
          const aqk = a[q][k];
          a[p][k] = c * apk - s * aqk;
          a[q][k] = s * apk + c * aqk;
        }
        for (let k = 0; k < n; k++) {
          const vkp = v[k][p];
          const vkq = v[k][q];
          v[k][p] = c * vkp - s * vkq;
          v[k][q] = s * vkp + c * vkq;
        }
      }
    }
  }
  return { valores: a.map((l, i) => l[i]), vetores: v };
}

/** A rígida que leva os pontos `de` para os pontos `para` com o menor erro (Horn, por quatérnio). */
export function melhorRigida(de: V3[], para: V3[]): Rigida {
  const n = de.length;
  const ca = [0, 0, 0];
  const cb = [0, 0, 0];
  for (let i = 0; i < n; i++)
    for (let e = 0; e < 3; e++) {
      ca[e] += de[i][e] / n;
      cb[e] += para[i][e] / n;
    }
  const S = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ];
  for (let i = 0; i < n; i++)
    for (let r = 0; r < 3; r++)
      for (let c = 0; c < 3; c++)
        S[r][c] += (de[i][r] - ca[r]) * (para[i][c] - cb[c]);
  const [[xx, xy, xz], [yx, yy, yz], [zx, zy, zz]] = S;
  const N = [
    [xx + yy + zz, yz - zy, zx - xz, xy - yx],
    [yz - zy, xx - yy - zz, xy + yx, zx + xz],
    [zx - xz, xy + yx, -xx + yy - zz, yz + zy],
    [xy - yx, zx + xz, yz + zy, -xx - yy + zz],
  ];
  const { valores, vetores } = jacobi(N);
  const k = valores.indexOf(max(...valores));
  const [w, x, y, z] = vetores.map((l) => l[k]);
  const R = [
    w * w + x * x - y * y - z * z,
    2 * (x * y - w * z),
    2 * (x * z + w * y),
    2 * (x * y + w * z),
    w * w - x * x + y * y - z * z,
    2 * (y * z - w * x),
    2 * (x * z - w * y),
    2 * (y * z + w * x),
    w * w - x * x - y * y + z * z,
  ];
  const rc = girar(R, ca as unknown as V3);
  return { R, t: [cb[0] - rc[0], cb[1] - rc[1], cb[2] - rc[2]] };
}

/** Sistema 6 × 6 por eliminação com pivô. */
function resolver(A: number[][], b: number[]): number[] | null {
  const n = b.length;
  const M = A.map((l, i) => [...l, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++)
      if (abs(M[r][c]) > abs(M[p][c])) p = r;
    if (abs(M[p][c]) < 1e-12) return null;
    [M[c], M[p]] = [M[p], M[c]];
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = M[r][c] / M[c][c];
      for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  return M.map((l, i) => l[n] / l[i]);
}

function rotacaoPequena(w: V3): number[] {
  const th = norma(w);
  if (th < 1e-12) return [...IDENTIDADE.R];
  const [x, y, z] = [w[0] / th, w[1] / th, w[2] / th];
  const c = cos(th);
  const s = sin(th);
  const C = 1 - c;
  return [
    c + x * x * C,
    x * y * C - z * s,
    x * z * C + y * s,
    y * x * C + z * s,
    c + y * y * C,
    y * z * C - x * s,
    z * x * C - y * s,
    z * y * C + x * s,
    c + z * z * C,
  ];
}

// ---------------------------------------------------------------- ajuste fino (ponto a plano)

/** Distância (mm) abaixo da qual o ponto da oclusão conta como em cima da arcada. */
const ENCOSTADO = 0.2;
/** O menor alcance da busca no ajuste fino: abaixo disso, o ruído do escaneamento manda. */
const ALCANCE_MINIMO = 0.3;

export interface Ajuste {
  T: Rigida;
  /** Erro médio (mm) dos pontos que encaixaram. */
  erro: number;
  /** Fração dos pontos da oclusão em cima da arcada (a até 0,2 mm). */
  cobertura: number;
}

function ajusteFino(
  fonte: Nuvem,
  alvo: Bvh,
  T0: Rigida,
  alcance: number,
  voltas = 40,
): Ajuste {
  let T = T0;
  let erro = Infinity;
  for (let volta = 0; volta < voltas; volta++) {
    const A = Array.from({ length: 6 }, () => new Array<number>(6).fill(0));
    const b = new Array<number>(6).fill(0);
    let n = 0;
    let soma2 = 0;
    for (let i = 0; i < fonte.qtd; i++) {
      const p = aplicar(T, ponto(fonte, i));
      const r = alvo.proximo(p, alcance);
      if (!r) continue;
      const nr = r.normal;
      const res = dot(sub(p, r.ponto), nr);
      const J = [...cross(p, nr), ...nr];
      for (let a = 0; a < 6; a++) {
        b[a] -= J[a] * res;
        for (let c = 0; c < 6; c++) A[a][c] += J[a] * J[c];
      }
      soma2 += res * res;
      n++;
    }
    if (n < 12) break;
    for (let a = 0; a < 6; a++) A[a][a] += 1e-6 * n;
    const x = resolver(A, b);
    if (!x) break;
    T = compor(
      { R: rotacaoPequena([x[0], x[1], x[2]]), t: [x[3], x[4], x[5]] },
      T,
    );
    erro = sqrt(soma2 / n);
    alcance = max(ALCANCE_MINIMO, min(alcance, 3 * erro));
    if (
      hypot(x[0], x[1], x[2]) < 1e-6 &&
      hypot(x[3], x[4], x[5]) < 1e-5
    )
      break;
  }
  let dentro = 0;
  let soma = 0;
  for (let i = 0; i < fonte.qtd; i++) {
    const r = alvo.proximo(aplicar(T, ponto(fonte, i)), ENCOSTADO);
    if (!r) continue;
    dentro++;
    soma += r.d * r.d;
  }
  return {
    T,
    erro: dentro ? sqrt(soma / dentro) : Infinity,
    cobertura: dentro / max(1, fonte.qtd),
  };
}

// ---------------------------------------------------------------- encaixe global (consenso geométrico)

/**
 * Quantas posições saem do consenso para a triagem. Dentes vizinhos se parecem: uma posição um dente
 * ao lado junta mais votos que a certa (41 contra 25 na arcada de cima sintética). Quem decide é o ajuste fino.
 */
const CANDIDATOS = 40;
/** Pontos e voltas da triagem: o bastante para a posição certa encostar e as erradas não. */
const PONTOS_DA_TRIAGEM = 400;
const VOLTAS_DA_TRIAGEM = 8;
/** Quantas posições da triagem vão para o ajuste fino completo. */
const FINALISTAS = 3;
/** Pares mais longe que isso (mm) entram no consenso; mais perto, a distância entre eles não diz nada. */
const MENOR_DISTANCIA_NO_CONSENSO = 3;

/**
 * Os melhores encaixes de `fonte` em `alvo` pelos pares de pontos parecidos. Poucos pares estão certos
 * (1 a 3% na oclusão), e sortear trios quase nunca acerta. Mas a peça é rígida: dois pares certos
 * guardam a mesma distância nos dois lados, e os certos concordam todos entre si. Para cada par, os
 * que concordam com ele; entre esses, os que também concordam uns com os outros formam o grupo, e o
 * grupo dá a rígida (consenso de segunda ordem).
 */
function candidatos(
  fonte: Nuvem,
  alvo: Nuvem,
  pares: [number, number][],
  tolerancia: number,
): Rigida[] {
  const n = pares.length;
  const S = pares.map(([i]) => ponto(fonte, i));
  const A = pares.map(([, j]) => ponto(alvo, j));
  const viz: number[][] = Array.from({ length: n }, () => []);
  for (let a = 0; a < n; a++) {
    for (let b = a + 1; b < n; b++) {
      const ds = norma(sub(S[a], S[b]));
      const da = norma(sub(A[a], A[b]));
      if (
        min(ds, da) < MENOR_DISTANCIA_NO_CONSENSO ||
        abs(ds - da) > tolerancia
      )
        continue;
      viz[a].push(b);
      viz[b].push(a);
    }
  }
  const marca = new Int32Array(n);
  const tol2 = tolerancia * tolerancia;
  const achados: { T: Rigida; votos: number; centro: V3 }[] = [];
  const centroDaFonte = ponto(fonte, floor(fonte.qtd / 2));
  for (let a = 0; a < n; a++) {
    if (viz[a].length < 3) continue;
    for (const b of viz[a]) marca[b] = a + 1;
    // Quantos do grupo de a cada vizinho também enxerga: os certos se enxergam todos.
    const grupo: number[] = [a];
    const cont = viz[a].map((b) =>
      viz[b].reduce((s, c) => s + (marca[c] === a + 1 ? 1 : 0), 0),
    );
    const maior = max(...cont);
    if (maior < 2) continue;
    viz[a].forEach((b, k) => {
      if (cont[k] >= max(2, 0.5 * maior)) grupo.push(b);
    });
    if (grupo.length < 3) continue;
    const T = melhorRigida(
      grupo.map((g) => S[g]),
      grupo.map((g) => A[g]),
    );
    let votos = 0;
    for (let k = 0; k < n; k++) {
      const p = aplicar(T, S[k]);
      const dx = p[0] - A[k][0];
      const dy = p[1] - A[k][1];
      const dz = p[2] - A[k][2];
      if (dx * dx + dy * dy + dz * dz < tol2) votos++;
    }
    if (votos < 6) continue;
    // Guarda os melhores que caem em lugares diferentes: o primeiro pode ser um dente ao lado.
    const centro = aplicar(T, centroDaFonte);
    const igual = achados.findIndex((x) => norma(sub(x.centro, centro)) < 2);
    if (igual >= 0) {
      if (achados[igual].votos < votos) achados[igual] = { T, votos, centro };
    } else achados.push({ T, votos, centro });
    achados.sort((x, y) => y.votos - x.votos);
    if (achados.length > CANDIDATOS) achados.length = CANDIDATOS;
  }
  return achados.map((x) => x.T);
}

// ---------------------------------------------------------------- o encaixe

/** Voxel da nuvem dos descritores e raio deles (mm): meio dente cabe no raio. */
const VOXEL_DA_FORMA = 1;
const RAIO_DA_FORMA = 5;
/** Voxel da nuvem do ajuste fino. */
const VOXEL_DO_AJUSTE = 0.5;
/** Pontos da oclusão no ajuste fino: mais que isso só deixa mais lento. */
const PONTOS_DO_AJUSTE = 3000;
/** Cada arcada cobre cerca de metade da oclusão; bem menos que isso não é encaixe. */
export const COBERTURA_MINIMA = 0.15;
/** Erro médio aceito entre dois escaneamentos da mesma boca. */
export const ERRO_MAXIMO = 0.1;

/**
 * Cada ponto da oclusão entra com os lugares mais parecidos da arcada: o certo raramente é o primeiro.
 * Com 4 sobram menos pares certos; com 8, mais pares errados. Um acerta onde o outro falha (medido em
 * 24 posições sintéticas), então tenta 4 e, se não der, 8.
 */
const PARECIDOS_POR_PONTO = [4, 8];

interface Preparada {
  forma: Nuvem;
  ajuste: Nuvem;
  desc: Partial<Record<1 | -1, Float64Array>>;
  longe?: number[];
}

function preparar(m: Malha): Preparada {
  const ajuste = nuvemDaMalha(m, VOXEL_DO_AJUSTE);
  return {
    forma: nuvemDaMalha(m, VOXEL_DA_FORMA),
    ajuste: rarear(ajuste, PONTOS_DO_AJUSTE),
    desc: {},
  };
}

/** No máximo `max` pontos, espalhados pela nuvem toda. */
function rarear(n: Nuvem, limite: number): Nuvem {
  if (n.qtd <= limite) return n;
  const passo = n.qtd / limite;
  const pos: number[] = [];
  const nor: number[] = [];
  for (let k = 0; k < limite; k++) {
    const i = floor(k * passo);
    pos.push(...ponto(n, i));
    nor.push(...normal(n, i));
  }
  return { pos: Float64Array.from(pos), nor: Float64Array.from(nor), qtd: limite };
}

const descritor = (p: Preparada, sinal: 1 | -1): Float64Array =>
  (p.desc[sinal] ??= descritores(p.forma, RAIO_DA_FORMA, sinal));

const bom = (a: Ajuste | null): a is Ajuste =>
  !!a && a.cobertura >= COBERTURA_MINIMA && a.erro <= ERRO_MAXIMO;
const melhor = (a: Ajuste | null, b: Ajuste | null): Ajuste | null =>
  !a ? b : !b ? a : b.cobertura > a.cobertura ? b : a;

/** Onde a oclusão fica nesta arcada: a rígida leva a oclusão para as coordenadas da arcada. */
function oclusaoNaArcada(
  oclusao: Preparada,
  arcada: Preparada,
  arcadaB: Bvh,
): Ajuste | null {
  // Scanner que exporta tudo junto: a oclusão já está nas coordenadas desta arcada.
  const direto = ajusteFino(oclusao.ajuste, arcadaB, IDENTIDADE, 1);
  if (bom(direto)) return direto;
  let achado: Ajuste | null = null;
  const descArcada = descritor(arcada, 1);
  const longe = (oclusao.longe ??= longeDaBorda(oclusao.forma, RAIO_DA_FORMA));
  // O sentido das normais depende do programa que exportou: tenta a oclusão nos dois.
  const triagem = rarear(oclusao.ajuste, PONTOS_DA_TRIAGEM);
  for (const sinal of [1, -1] as const) {
    // Os 8 mais parecidos de uma vez: os 4 primeiros de cada ponto são a primeira tentativa.
    const ranking = paresParecidos(
      descritor(oclusao, sinal),
      longe,
      descArcada,
      arcada.forma.qtd,
      max(...PARECIDOS_POR_PONTO),
    );
    for (const k of PARECIDOS_POR_PONTO) {
      const pares = ranking
        .filter(([, , r]) => r < k)
        .map(([i, j]) => [i, j] as [number, number]);
      const finalistas = candidatos(
        oclusao.forma,
        arcada.forma,
        pares,
        1.5 * VOXEL_DA_FORMA,
      )
        .map((T) => ajusteFino(triagem, arcadaB, T, 2, VOLTAS_DA_TRIAGEM))
        .sort((a, b) => b.cobertura - a.cobertura)
        .slice(0, FINALISTAS);
      for (const f of finalistas)
        achado = melhor(achado, ajusteFino(oclusao.ajuste, arcadaB, f.T, 1));
      if (bom(achado)) return achado;
    }
  }
  return null;
}

export interface Encaixe {
  /** Leva o antagonista para as coordenadas da arcada. */
  T: Rigida;
  /** O maior dos dois erros médios (mm). */
  erro: number;
}

/**
 * Encaixa a arcada e o antagonista na oclusão e devolve onde o antagonista fica nas coordenadas da
 * arcada. Null quando a oclusão não encaixa nas duas: arquivo de outro caso ou sem dentes suficientes.
 */
export function encaixarPelaOclusao(
  arcadaB: Bvh,
  antagonista: Malha,
  oclusao: Malha,
): Encaixe | null {
  const oc = preparar(oclusao);
  const arc = preparar(arcadaB.m);
  const ant = preparar(antagonista);
  const antB = new Bvh(antagonista);
  // A busca pela forma acha primeiro a arcada que tem mais pontos na oclusão; a outra se confunde
  // com ela. Achada uma, o que ela explica sai, e a outra é procurada só no que sobrou.
  let naArcada = oclusaoNaArcada(oc, arc, arcadaB);
  let noAntagonista = naArcada
    ? oclusaoNaArcada(semOQueEncaixou(oc, arcadaB, naArcada.T), ant, antB)
    : null;
  // Na outra ordem: o antagonista na oclusão inteira, e a arcada no que ele não explica.
  noAntagonista ??= oclusaoNaArcada(oc, ant, antB);
  if (noAntagonista && !naArcada)
    naArcada = oclusaoNaArcada(
      semOQueEncaixou(oc, antB, noAntagonista.T),
      arc,
      arcadaB,
    );
  if (!naArcada || !noAntagonista) return null;
  return {
    T: compor(naArcada.T, inversa(noAntagonista.T)),
    erro: max(naArcada.erro, noAntagonista.erro),
  };
}

/** Longe disso (mm) da arcada já encaixada, o ponto da oclusão é da outra. */
const DA_OUTRA_ARCADA = 0.5;

/** A oclusão sem os pontos que a arcada já encaixada explica: sobra a parte da outra. */
function semOQueEncaixou(oc: Preparada, arcadaB: Bvh, T: Rigida): Preparada {
  const daOutra = (p: V3) => !arcadaB.proximo(aplicar(T, p), DA_OUTRA_ARCADA);
  const longe = (oc.longe ??= longeDaBorda(oc.forma, RAIO_DA_FORMA)).filter(
    (i) => daOutra(ponto(oc.forma, i)),
  );
  const pos: number[] = [];
  const nor: number[] = [];
  for (let i = 0; i < oc.ajuste.qtd; i++) {
    if (!daOutra(ponto(oc.ajuste, i))) continue;
    pos.push(...ponto(oc.ajuste, i));
    nor.push(...normal(oc.ajuste, i));
  }
  // A mesma nuvem da forma (e os mesmos descritores, que viram a vizinhança inteira); só a lista muda.
  return {
    forma: oc.forma,
    desc: oc.desc,
    longe,
    ajuste: {
      pos: Float64Array.from(pos),
      nor: Float64Array.from(nor),
      qtd: pos.length / 3,
    },
  };
}

/**
 * Passos CAD — eixo de inserção e linha de margem do preparo.
 *
 * Tudo parte de um ponto O dentro do troquel: raios em leque, por meridiano θ e ângulo φ
 * medido a partir do eixo oclusal. A margem é o caminho fechado, um ponto por meridiano,
 * que passa pela crista mais convexa da superfície e anda o mínimo possível entre um
 * meridiano e o seguinte (Viterbi). Os cliques do técnico viram pontos obrigatórios.
 */
import { Bvh, cross, dot, mul, norma, soma, sub, unit, vert, type Malha, type V3 } from './geo';

const GRAU = Math.PI / 180;

export interface Preparo {
  /** Eixo de inserção, apontando para o lado oclusal. */
  a: V3;
  /** Ponto dentro do troquel de onde saem os raios. */
  O: V3;
  topo: V3;
  e1: V3;
  e2: V3;
}

export interface PontoMargem {
  th: number;
  ph: number;
  ponto: V3;
  normal: V3;
}

export function direcao(p: Pick<Preparo, 'a' | 'e1' | 'e2'>, th: number, ph: number): V3 {
  const lado = soma(mul(p.e1, Math.cos(th)), mul(p.e2, Math.sin(th)));
  return unit(soma(mul(p.a, Math.cos(ph)), mul(lado, Math.sin(ph))));
}

/** Base perpendicular ao eixo. */
function baseDoEixo(a: V3): { e1: V3; e2: V3 } {
  const ref: V3 = Math.abs(a[0]) < 0.8 ? [1, 0, 0] : [0, 1, 0];
  const e1 = unit(sub(ref, mul(a, dot(ref, a))));
  return { e1, e2: cross(a, e1) };
}

/** Autovetor do menor autovalor de uma matriz simétrica 3×3 (Jacobi). */
function menorAutovetor(S: number[][]): V3 {
  const A = S.map((l) => l.slice());
  const Q = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  for (let it = 0; it < 50; it++) {
    let p = 0;
    let q = 1;
    for (const [i, j] of [[0, 1], [0, 2], [1, 2]]) if (Math.abs(A[i][j]) > Math.abs(A[p][q])) { p = i; q = j; }
    if (Math.abs(A[p][q]) < 1e-12) break;
    const th = 0.5 * Math.atan2(2 * A[p][q], A[q][q] - A[p][p]);
    const c = Math.cos(th);
    const s = Math.sin(th);
    for (let k = 0; k < 3; k++) { const x = A[k][p]; const y = A[k][q]; A[k][p] = c * x - s * y; A[k][q] = s * x + c * y; }
    for (let k = 0; k < 3; k++) { const x = A[p][k]; const y = A[q][k]; A[p][k] = c * x - s * y; A[q][k] = s * x + c * y; }
    for (let k = 0; k < 3; k++) { const x = Q[k][p]; const y = Q[k][q]; Q[k][p] = c * x - s * y; Q[k][q] = s * x + c * y; }
  }
  let i = 0;
  for (let k = 1; k < 3; k++) if (A[k][k] < A[i][i]) i = k;
  return unit([Q[0][i], Q[1][i], Q[2][i]]);
}

/**
 * Acha o preparo a partir do ponto clicado. `ladoOclusal` só precisa apontar para o lado do
 * antagonista: a direção real vem da normal média da superfície e das paredes axiais.
 */
export function acharPreparo(arco: Bvh, clique: V3, ladoOclusal: V3): Preparo {
  const perto = arco.proximo(clique, 6);
  if (!perto) throw new Error('Não há superfície perto do ponto clicado.');
  // Direção inicial: a superfície em volta do clique, do lado do antagonista.
  const a0 = normalMediaEmVolta(arco.m, clique, 4, unit(ladoOclusal));
  let a = a0;
  // Para dentro do dente a partir do ponto clicado: serve para o topo e para a parede.
  const paraFora = normalMediaEmVolta(arco.m, perto.ponto, 1, perto.normal);
  let O = centralizar(arco, sub(perto.ponto, mul(paraFora, 2.5)), a);
  let topo = arco.raio(soma(O, mul(a, 0.01)), a, 9)?.ponto ?? perto.ponto;
  // Eixo de inserção: a direção mais perpendicular às paredes axiais do troquel.
  for (let it = 0; it < 3; it++) {
    const novo = eixoDasParedes(arco, O, a, a0);
    if (!novo) break;
    a = novo;
    const t2 = arco.raio(soma(O, mul(a, 0.01)), a, 9);
    if (t2) topo = t2.ponto;
    O = centralizar(arco, sub(topo, mul(a, 2.5)), a);
  }
  const semRetencao = eixoComMenosRetencao(arco, O, a);
  if (anguloEntre(semRetencao, a0) <= DESVIO_MAXIMO) a = semRetencao;
  const noTopo = arco.raio(soma(O, mul(a, 0.01)), a, 9);
  if (noTopo) topo = noTopo.ponto;
  // Mais baixo: de perto do nível da margem o chanfro é visto de frente, não de raspão.
  O = centralizar(arco, sub(topo, mul(a, ALTURA_DE_O)), a);
  const inicial: Preparo = { a, O, topo, ...baseDoEixo(a) };
  // A crista é lida depois de centrar: do preparo do clique, fora do centro, ela parece outra.
  const comLinha = centrarPelaMargem(arco, inicial);
  return temCrista(arco, comLinha) ? comLinha : centrarSemCrista(arco, inicial, ladoOclusal);
}

/**
 * Preparo sem crista, como um coto liso que entra no sulco. A primeira estimativa pode vir longe: no
 * anterior, a face palatina inclinada domina a média das normais (51° do eixo do dente no 11 do caso
 * 031). As paredes dão o eixo sozinhas, e a linha dá o centro. Tudo a partir de O.
 */
function centrarSemCrista(arco: Bvh, inicial: Preparo, lado: V3): Preparo {
  let a = inicial.a;
  let O = inicial.O;
  for (let it = 0; it < VOLTAS_DO_EIXO_LIVRE; it++) {
    const novo = eixoLivreDasParedes(arco, O, a, lado);
    if (!novo) break;
    const parou = anguloEntre(novo, a) < PLANO_ACEITO;
    a = novo;
    const topo = topoDoPreparo(arco, O, a);
    if (topo) O = centralizar(arco, sub(topo, mul(a, ALTURA_DE_O)), a);
    if (parou) break;
  }
  // A parede de trás do anterior é baixa: na altura de O o anel de raios só vê a da frente, e O encosta
  // nela. O centro da linha fica no meio de verdade.
  for (let it = 0; it < VOLTAS_PELO_CENTRO; it++) {
    const topo = topoDoPreparo(arco, O, a) ?? inicial.topo;
    const prep: Preparo = { a, O, topo, ...baseDoEixo(a) };
    let margem: PontoMargem[];
    try {
      // Sem a conferência: com O ainda encostado numa parede, a linha sai torta, e o centro dela já serve.
      margem = linhaDeMargem(arco, prep, 120);
    } catch {
      break;
    }
    const centro = centroDaMargem(margem, prep);
    const desvio = norma(sub(centro, O));
    O = centro;
    a = eixoLivreDasParedes(arco, O, a, lado) ?? a;
    const topoNovo = topoDoPreparo(arco, O, a);
    if (topoNovo) O = soma(O, mul(a, dot(sub(topoNovo, O), a) - ALTURA_DE_O));
    if (desvio < CENTRO_ACEITO) break;
  }
  const semRetencao = eixoComMenosRetencao(arco, O, a);
  if (anguloEntre(semRetencao, a) <= DESVIO_MAXIMO) a = semRetencao;
  return { a, O, topo: topoDoPreparo(arco, O, a) ?? inicial.topo, ...baseDoEixo(a) };
}

/** O autovetor das paredes sem exigir que fique perto de nada. Null se não há parede para contar. */
function eixoLivreDasParedes(arco: Bvh, O: V3, a: V3, lado: V3): V3 | null {
  const b = baseDoEixo(a);
  const S = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  let paredes = 0;
  for (let i = 0; i < 72; i++) {
    for (let ph = 55; ph <= 130; ph += 5) {
      const d = direcao({ a, ...b }, (2 * Math.PI * i) / 72, ph * GRAU);
      const h = arco.raio(O, d, 7.5);
      if (!h || dot(h.normal, d) < 0.3 || Math.abs(dot(h.normal, a)) > 0.75) continue;
      paredes++;
      for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) S[r][c] += h.normal[r] * h.normal[c];
    }
  }
  if (paredes < 120) return null;
  const novo = menorAutovetor(S);
  return dot(novo, lado) < 0 ? mul(novo, -1) : novo;
}

/** O ponto mais alto de verdade: no anterior ele fica perto da face vestibular, não em cima de O. */
function topoDoPreparo(arco: Bvh, O: V3, a: V3): V3 | null {
  const b = baseDoEixo(a);
  let melhor: V3 | null = null;
  let maior = -Infinity;
  for (let ph = 0; ph <= 60; ph += 5) {
    for (let i = 0; i < (ph === 0 ? 1 : 24); i++) {
      const d = direcao({ a, ...b }, (2 * Math.PI * i) / 24, ph * GRAU);
      const h = arco.raio(O, d, 9);
      if (!h || dot(h.normal, d) < 0.2) continue;
      const alt = dot(sub(h.ponto, O), a);
      if (alt > maior) {
        maior = alt;
        melhor = h.ponto;
      }
    }
  }
  return melhor;
}

/**
 * O clique pode cair em qualquer lugar do dente. A referência certa é a própria linha de margem,
 * que é a mesma para qualquer clique: o centro dela e o plano dela. Com isso, centro e eixo
 * deixam de depender de onde o técnico clicou.
 */
function centrarPelaMargem(arco: Bvh, inicial: Preparo): Preparo {
  let prep = inicial;
  let ultimoPlano = inicial.a;
  // O preparo do clique só fica se nenhuma volta fechar a linha: ele é o que depende do clique.
  let melhor = inicial;
  let menorDesvio = Infinity;
  for (let it = 0; it <= VOLTAS_PELO_CENTRO; it++) {
    let margem: PontoMargem[];
    try {
      margem = proporMargem(arco, prep, { meridianos: 120 });
    } catch {
      break;
    }
    const centro = centroDaMargem(margem, prep);
    const plano = normalDaMargem(margem, prep.a);
    const desvio = norma(sub(centro, prep.O));
    if (it > 0 && desvio < menorDesvio) {
      melhor = prep;
      menorDesvio = desvio;
    }
    if (it === VOLTAS_PELO_CENTRO) break;
    if (it > 0 && desvio < CENTRO_ACEITO && anguloEntre(plano, ultimoPlano) < PLANO_ACEITO) break;
    ultimoPlano = plano;
    // Tudo a partir da linha, nada herdado da volta anterior: o eixo não fica oscilando.
    const alvo = arco.raio(soma(centro, mul(plano, 0.01)), plano, 9);
    if (!alvo) break;
    const O = sub(alvo.ponto, mul(plano, ALTURA_DE_O));
    let a = eixoDasParedes(arco, O, plano, plano) ?? plano;
    const semRetencao = eixoComMenosRetencao(arco, O, a);
    if (anguloEntre(semRetencao, plano) <= DESVIO_MAXIMO) a = semRetencao;
    const topo = arco.raio(soma(O, mul(a, 0.01)), a, 9)?.ponto ?? alvo.ponto;
    prep = { a, O, topo, ...baseDoEixo(a) };
  }
  return melhor;
}

/** Normal do plano que melhor passa pela linha, do lado oclusal. */
function normalDaMargem(margem: PontoMargem[], lado: V3): V3 {
  const c = [0, 0, 0];
  for (const m of margem) for (let k = 0; k < 3; k++) c[k] += m.ponto[k] / margem.length;
  const S = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  for (const m of margem) {
    for (let r = 0; r < 3; r++) for (let k = 0; k < 3; k++) S[r][k] += (m.ponto[r] - c[r]) * (m.ponto[k] - c[k]);
  }
  const n = menorAutovetor(S);
  return dot(n, lado) < 0 ? mul(n, -1) : n;
}

/** Centro da área dentro da linha, na altura de O (os meridianos não têm espaçamento igual). */
function centroDaMargem(margem: PontoMargem[], p: Preparo): V3 {
  let area = 0;
  let x = 0;
  let y = 0;
  for (let i = 0; i < margem.length; i++) {
    const u = sub(margem[i].ponto, p.O);
    const w = sub(margem[(i + 1) % margem.length].ponto, p.O);
    const [x0, y0] = [dot(u, p.e1), dot(u, p.e2)];
    const [x1, y1] = [dot(w, p.e1), dot(w, p.e2)];
    const c = x0 * y1 - x1 * y0;
    area += c;
    x += (x0 + x1) * c;
    y += (y0 + y1) * c;
  }
  if (Math.abs(area) < 1e-6) return p.O;
  return soma(p.O, soma(mul(p.e1, x / (3 * area)), mul(p.e2, y / (3 * area))));
}

/** Uma passada do autovetor das paredes visto de O. Null se não há parede ou se fugiu demais de a0. */
function eixoDasParedes(arco: Bvh, O: V3, a: V3, a0: V3): V3 | null {
  const b = baseDoEixo(a);
  const S = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  let paredes = 0;
  for (let i = 0; i < 72; i++) {
    for (let ph = 70; ph <= 105; ph += 5) {
      const d = direcao({ a, ...b }, (2 * Math.PI * i) / 72, ph * GRAU);
      // Longe demais = o raio saiu por um furo da valeta e pegou outra superfície.
      const h = arco.raio(O, d, 7.5);
      if (!h || Math.abs(dot(h.normal, a)) > 0.6 || dot(h.normal, d) < 0.4) continue;
      paredes++;
      for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) S[r][c] += h.normal[r] * h.normal[c];
    }
  }
  if (paredes < 120) return null;
  let novo = menorAutovetor(S);
  if (dot(novo, a0) < 0) novo = mul(novo, -1);
  // Preparo curto dá paredes demais de um lado só: o eixo não pode fugir da superfície do dente.
  return anguloEntre(novo, a0) > DESVIO_MAXIMO ? null : novo;
}

const anguloEntre = (x: V3, y: V3): number => Math.acos(Math.min(1, Math.max(-1, dot(x, y))));

/** Normal média da superfície num raio em volta do ponto, do lado indicado. */
function normalMediaEmVolta(m: Malha, centro: V3, raio: number, lado: V3): V3 {
  const acc = [0, 0, 0];
  for (let t = 0; t < m.tri.length; t += 3) {
    const A = vert(m, m.tri[t]);
    if (norma(sub(A, centro)) > raio) continue;
    const n = cross(sub(vert(m, m.tri[t + 1]), A), sub(vert(m, m.tri[t + 2]), A));
    if (dot(n, lado) > 0) { acc[0] += n[0]; acc[1] += n[1]; acc[2] += n[2]; }
  }
  return norma([acc[0], acc[1], acc[2]]) > 0 ? unit([acc[0], acc[1], acc[2]]) : lado;
}

/** Leva o ponto para o meio do troquel naquela altura: perto da parede os raios não servem. */
function centralizar(arco: Bvh, ponto: V3, a: V3): V3 {
  const b = baseDoEixo(a);
  let O = ponto;
  for (let it = 0; it < 4; it++) {
    let x = 0;
    let y = 0;
    let n = 0;
    for (let i = 0; i < 24; i++) {
      const th = (2 * Math.PI * i) / 24;
      const d = direcao({ a, ...b }, th, Math.PI / 2);
      const h = arco.raio(O, d, 7.5);
      if (!h || dot(h.normal, d) < 0.3) continue;
      x += dot(sub(h.ponto, O), b.e1);
      y += dot(sub(h.ponto, O), b.e2);
      n++;
    }
    if (n < 12) break;
    O = soma(O, soma(mul(b.e1, x / n), mul(b.e2, y / n)));
  }
  return O;
}

/** Procura até 7,5° em volta do eixo: só inclina se a retenção cair mais do que a inclinação custa. */
function eixoComMenosRetencao(arco: Bvh, O: V3, a: V3): V3 {
  const b = baseDoEixo(a);
  const normais: V3[] = [];
  for (let i = 0; i < 72; i++) {
    for (let ph = 50; ph <= 110; ph += 5) {
      const d = direcao({ a, ...b }, (2 * Math.PI * i) / 72, ph * GRAU);
      const h = arco.raio(O, d, 7.5);
      if (h && dot(h.normal, d) > 0.4 && Math.abs(dot(h.normal, a)) < 0.7) normais.push(h.normal);
    }
  }
  if (normais.length < 40) return a;
  let melhor = a;
  let menor = Infinity;
  for (let inc = 0; inc <= 7.5; inc += 2.5) {
    for (let g = 0; g < (inc === 0 ? 1 : 16); g++) {
      const c = direcao({ a, ...b }, (g * 2 * Math.PI) / 16, inc * GRAU);
      let custo = 0.002 * inc;
      for (const n of normais) {
        const x = dot(n, c);
        if (x < 0) custo += (x * x) / normais.length;
      }
      if (custo < menor) {
        menor = custo;
        melhor = c;
      }
    }
  }
  return melhor;
}

/** Convexidade por vértice (curvatura média positiva, suavizada). Sulcos e valetas dão zero. */
export function convexidade(m: Malha, normais: Float64Array): Float64Array {
  const nv = m.pos.length / 3;
  const soma3 = new Float64Array(nv * 3);
  const e2 = new Float64Array(nv);
  const grau = new Uint32Array(nv);
  const p = m.pos;
  for (let t = 0; t < m.tri.length; t += 3) {
    for (let k = 0; k < 3; k++) {
      const a = m.tri[t + k];
      const b = m.tri[t + ((k + 1) % 3)];
      const dx = p[3 * b] - p[3 * a];
      const dy = p[3 * b + 1] - p[3 * a + 1];
      const dz = p[3 * b + 2] - p[3 * a + 2];
      const d2 = dx * dx + dy * dy + dz * dz;
      soma3[3 * a] += dx; soma3[3 * a + 1] += dy; soma3[3 * a + 2] += dz; e2[a] += d2; grau[a]++;
      soma3[3 * b] -= dx; soma3[3 * b + 1] -= dy; soma3[3 * b + 2] -= dz; e2[b] += d2; grau[b]++;
    }
  }
  let c = new Float64Array(nv);
  for (let v = 0; v < nv; v++) {
    if (!grau[v]) continue;
    const l = -2 * (soma3[3 * v] * normais[3 * v] + soma3[3 * v + 1] * normais[3 * v + 1] + soma3[3 * v + 2] * normais[3 * v + 2]);
    c[v] = Math.max(l / Math.max(e2[v], 1e-9), 0);
  }
  for (let it = 0; it < 2; it++) {
    const s = new Float64Array(nv);
    const g = new Uint32Array(nv);
    for (let t = 0; t < m.tri.length; t += 3) {
      for (let k = 0; k < 3; k++) {
        const a = m.tri[t + k];
        const b = m.tri[t + ((k + 1) % 3)];
        s[a] += c[b]; g[a]++;
        s[b] += c[a]; g[b]++;
      }
    }
    for (let v = 0; v < nv; v++) if (g[v]) s[v] = 0.5 * c[v] + (0.5 * s[v]) / g[v];
    c = s;
  }
  return c;
}

export interface OpcoesMargem {
  meridianos?: number;
  /** Pontos que o técnico marcou: a linha passa por eles. */
  fixos?: V3[];
}

const DESVIO_MAXIMO = 20 * GRAU;
const VOLTAS_PELO_CENTRO = 3;
const VOLTAS_DO_EIXO_LIVRE = 6;
const CENTRO_ACEITO = 0.2;
const PLANO_ACEITO = 2 * GRAU;
const ALTURA_DE_O = 3.8;
const RAIO_MAXIMO_MARGEM = 8.5;
const DESNIVEL_MAXIMO_MARGEM = 7;
const PASSO_PHI = 0.5;
const PHI_MIN = 40;
const PHI_MAX = 150;

/**
 * Abaixo disso, na mediana dos meridianos, não há crista: é ruído do escaneamento numa parede lisa
 * (1/mm). Medido: 0,35 a 0,46 nos preparos lisos do caso 031, 1,15 a 1,34 nos com término do caso 042.
 */
const CRISTA_MINIMA = 0.7;
/** Um raio para o outro: mais que isso é o raio que passou da borda, não a mesma parede (mm). */
const SALTO_DA_PAREDE = 1;
/** Até onde o fim da parede atrai a linha (mm, ao longo dela). */
const ALCANCE_DO_FIM_DA_PAREDE = 2.5;
/** Fica um pouco antes do fim: o fundo do sulco é a parte mais ruidosa do escaneamento (mm). */
const RECUO_DO_FIM_DA_PAREDE = 0.15;
/** Meridianos em volta usados para o fim da parede: um furo no escaneamento não puxa a linha. */
const VIZINHOS_DO_FIM_DA_PAREDE = 6;

const CURVATURAS = new WeakMap<Bvh, Float64Array>();

const medianaDe = (v: ArrayLike<number>): number => {
  const a = Array.from(v).sort((x, y) => x - y);
  return a.length ? a[Math.floor(a.length / 2)] : 0;
};

/**
 * Preparo sem degrau: a parede lisa entra direto no sulco da gengiva, e a convexidade nela é só ruído,
 * que faz a linha cortar a parede em zigue-zague. O término, então, é onde a parede acaba. A nota sobe
 * aos poucos até lá, para o caminho continuar liso entre os meridianos.
 */
function notaPeloFimDaParede(nota: Float32Array, fim: Int32Array, pts: Float64Array, NT: number, K: number): void {
  const fimLiso = new Int32Array(NT);
  for (let i = 0; i < NT; i++) {
    const volta: number[] = [];
    for (let q = -VIZINHOS_DO_FIM_DA_PAREDE; q <= VIZINHOS_DO_FIM_DA_PAREDE; q++) {
      const f = fim[(i + q + NT) % NT];
      if (f >= 0) volta.push(f);
    }
    fimLiso[i] = volta.length ? medianaDe(volta) : fim[i];
  }
  for (let i = 0; i < NT; i++) {
    nota.fill(0, i * K, (i + 1) * K);
    if (fimLiso[i] < 0) continue;
    let andou = 0;
    for (let k = fimLiso[i]; k >= 0; k--) {
      if (k < fimLiso[i]) {
        const a = 3 * (i * K + k);
        const b = 3 * (i * K + k + 1);
        andou += Math.hypot(pts[a] - pts[b], pts[a + 1] - pts[b + 1], pts[a + 2] - pts[b + 2]);
      }
      const longe = Math.abs(andou - RECUO_DO_FIM_DA_PAREDE);
      if (longe >= ALCANCE_DO_FIM_DA_PAREDE) break;
      nota[i * K + k] = 1 - longe / ALCANCE_DO_FIM_DA_PAREDE;
    }
  }
}

/** A curvatura é da superfície, não da linha: refazer a linha não precisa recalcular. */
function curvaturaDe(arco: Bvh): Float64Array {
  let c = CURVATURAS.get(arco);
  if (!c) {
    c = convexidade(arco.m, arco.normais);
    CURVATURAS.set(arco, c);
  }
  return c;
}

/** Cada raio de cada meridiano: onde bate, quanto vale, e até onde a parede vai sem interrupção. */
function lerColunas(arco: Bvh, prep: Preparo, NT: number, K: number) {
  const curva = curvaturaDe(arco);
  const nota = new Float32Array(NT * K);
  const pts = new Float64Array(NT * K * 3);
  const vale = new Uint8Array(NT * K);
  const alturaTopo = dot(sub(prep.topo, prep.O), prep.a);
  const fimDaParede = new Int32Array(NT).fill(-1);
  const maiorDaColuna = new Float64Array(NT);

  for (let i = 0; i < NT; i++) {
    const th = (2 * Math.PI * i) / NT;
    let anterior: number | null = null;
    let raioMax = 0;
    let naParede: number | null = null;
    let paredeAcabou = false;
    for (let k = 0; k < K; k++) {
      const d = direcao(prep, th, (PHI_MIN + k * PASSO_PHI) * GRAU);
      const h = arco.raio(prep.O, d, 10);
      if (!h) { anterior = null; continue; }
      const v = sub(h.ponto, prep.O);
      const alt = dot(v, prep.a);
      const rho = norma(sub(v, mul(prep.a, alt)));
      raioMax = Math.max(raioMax, rho);
      pts.set(h.ponto, 3 * (i * K + k));
      if (rho > RAIO_MAXIMO_MARGEM - 0.5) break;
      if (!paredeAcabou) {
        if (dot(h.normal, d) < 0 || (naParede !== null && Math.abs(h.t - naParede) > SALTO_DA_PAREDE)) {
          paredeAcabou = true;
        } else {
          naParede = h.t;
          fimDaParede[i] = k;
        }
      }
      // Saiu do troquel: entrou numa superfície por fora, ou a margem ficaria alta demais.
      if (dot(h.normal, d) < 0 || alturaTopo - alt < 2) { anterior = h.t; continue; }
      const t = m3(arco, h.tri);
      const c = (1 - h.u - h.v) * curva[t[0]] + h.u * curva[t[1]] + h.v * curva[t[2]];
      // Só vale até o primeiro salto grande: depois dele o raio já passou para a gengiva.
      const salto = anterior !== null && Math.abs(h.t - anterior) > 2.5;
      anterior = h.t;
      if (salto) break;
      vale[i * K + k] = 1;
      nota[i * K + k] = Math.min(c, 3);
      if (!paredeAcabou) maiorDaColuna[i] = Math.max(maiorDaColuna[i], c);
    }
  }
  return { nota, pts, vale, fimDaParede, maiorDaColuna };
}

/** Existe um término marcado no preparo, ou só a parede lisa? */
function temCrista(arco: Bvh, prep: Preparo): boolean {
  return medianaDe(lerColunas(arco, prep, 72, Math.round((PHI_MAX - PHI_MIN) / PASSO_PHI) + 1).maiorDaColuna) >= CRISTA_MINIMA;
}

/** Linha de margem conferida: fora de qualquer dente, avisa em vez de desenhar. */
export function proporMargem(arco: Bvh, prep: Preparo, opcoes: OpcoesMargem = {}): PontoMargem[] {
  const saida = linhaDeMargem(arco, prep, opcoes.meridianos ?? 360, opcoes.fixos);
  conferirMargem(saida, prep);
  return saida;
}

/** Linha de margem por Viterbi sobre a grade (meridiano × φ). */
function linhaDeMargem(arco: Bvh, prep: Preparo, NT: number, fixos: V3[] = []): PontoMargem[] {
  const K = Math.round((PHI_MAX - PHI_MIN) / PASSO_PHI) + 1;
  const { nota, pts, vale, fimDaParede, maiorDaColuna } = lerColunas(arco, prep, NT, K);
  if (medianaDe(maiorDaColuna) < CRISTA_MINIMA) notaPeloFimDaParede(nota, fimDaParede, pts, NT, K);

  const fixoPorColuna = new Map<number, number>();
  for (const f of fixos) {
    const v = sub(f, prep.O);
    const alt = dot(v, prep.a);
    const lado = sub(v, mul(prep.a, alt));
    const th = (Math.atan2(dot(lado, prep.e2), dot(lado, prep.e1)) + 2 * Math.PI) % (2 * Math.PI);
    const ph = Math.atan2(norma(lado), alt) / GRAU;
    const col = Math.round((th / (2 * Math.PI)) * NT) % NT;
    fixoPorColuna.set(col, Math.min(K - 1, Math.max(0, Math.round((ph - PHI_MIN) / PASSO_PHI))));
  }

  // Duas voltas: a metade do meio não depende de onde o caminho começou.
  const JANELA = 6;
  const PESO_CAMINHO = 1.2;
  const cols = NT * 2;
  const custo = new Float64Array(K);
  const volta = new Int16Array(cols * K);
  const notaDe = (i: number, k: number): number => {
    const col = i % NT;
    const fx = fixoPorColuna.get(col);
    if (fx !== undefined) return Math.abs(k - fx) <= 1 ? 1000 : -1000;
    return vale[col * K + k] ? nota[col * K + k] : -5;
  };
  for (let k = 0; k < K; k++) custo[k] = notaDe(0, k);
  for (let c = 1; c < cols; c++) {
    const novo = new Float64Array(K).fill(-Infinity);
    const col = c % NT;
    const ant = (c - 1) % NT;
    for (let k = 0; k < K; k++) {
      const n = notaDe(c, k);
      const px = pts[3 * (col * K + k)];
      const py = pts[3 * (col * K + k) + 1];
      const pz = pts[3 * (col * K + k) + 2];
      for (let q = Math.max(0, k - JANELA); q <= Math.min(K - 1, k + JANELA); q++) {
        const dx = px - pts[3 * (ant * K + q)];
        const dy = py - pts[3 * (ant * K + q) + 1];
        const dz = pz - pts[3 * (ant * K + q) + 2];
        const v = custo[q] + n - PESO_CAMINHO * Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (v > novo[k]) { novo[k] = v; volta[c * K + k] = q; }
      }
    }
    custo.set(novo);
  }
  let k = 0;
  for (let q = 1; q < K; q++) if (custo[q] > custo[k]) k = q;
  const caminho = new Int32Array(cols);
  for (let c = cols - 1; c >= 0; c--) {
    caminho[c] = k;
    k = volta[c * K + k];
  }
  const phis = new Float64Array(NT);
  for (let c = Math.floor(NT / 2); c < Math.floor(NT / 2) + NT; c++) phis[c % NT] = PHI_MIN + caminho[c] * PASSO_PHI;

  // Suaviza de leve, sem tirar a linha dos pontos marcados.
  const suave = new Float64Array(NT);
  for (let i = 0; i < NT; i++) {
    if (fixoPorColuna.has(i)) { suave[i] = phis[i]; continue; }
    let s = 0;
    for (let q = -2; q <= 2; q++) s += phis[(i + q + NT) % NT];
    suave[i] = s / 5;
  }
  const saida: PontoMargem[] = [];
  for (let i = 0; i < NT; i++) {
    const th = (2 * Math.PI * i) / NT;
    let achou: PontoMargem | null = null;
    for (let ph = suave[i]; ph > 20 && !achou; ph -= 0.2) {
      const h = arco.raio(prep.O, direcao(prep, th, ph * GRAU), 12);
      if (h) achou = { th, ph: ph * GRAU, ponto: h.ponto, normal: h.normal };
    }
    if (!achou) throw new Error('Não foi possível fechar a linha de margem. Confira o ponto clicado no preparo.');
    saida.push(achou);
  }
  return saida;
}


/** Linha fora de qualquer dente é erro: melhor avisar do que desenhar sobre ela. */
export function conferirMargem(margem: PontoMargem[], prep: Preparo): void {
  let hMin = Infinity;
  let hMax = -Infinity;
  let rMax = 0;
  for (const m of margem) {
    const v = sub(m.ponto, prep.O);
    const h = dot(v, prep.a);
    hMin = Math.min(hMin, h);
    hMax = Math.max(hMax, h);
    rMax = Math.max(rMax, norma(sub(v, mul(prep.a, h))));
  }
  if (rMax > RAIO_MAXIMO_MARGEM || hMax - hMin > DESNIVEL_MAXIMO_MARGEM) {
    throw new Error('A linha de margem saiu do preparo. Clique no topo do dente preparado de novo ou marque pontos no término.');
  }
}

function m3(arco: Bvh, t: number): [number, number, number] {
  const tri = arco.m.tri;
  return [tri[3 * t], tri[3 * t + 1], tri[3 * t + 2]];
}

/** Margem pronta (de outro desenho ou de teste): só projeta os pontos na grade de raios. */
export function margemDePontos(arco: Bvh, prep: Preparo, pontos: V3[], NT = 360): PontoMargem[] {
  const porColuna: (number | null)[] = new Array(NT).fill(null);
  for (const f of pontos) {
    const v = sub(f, prep.O);
    const alt = dot(v, prep.a);
    const lado = sub(v, mul(prep.a, alt));
    const th = (Math.atan2(dot(lado, prep.e2), dot(lado, prep.e1)) + 2 * Math.PI) % (2 * Math.PI);
    porColuna[Math.round((th / (2 * Math.PI)) * NT) % NT] = Math.atan2(norma(lado), alt);
  }
  const saida: PontoMargem[] = [];
  for (let i = 0; i < NT; i++) {
    let ph = porColuna[i];
    if (ph === null) {
      let e = i;
      let d = i;
      let n = 0;
      while (porColuna[(e + NT) % NT] === null && n < NT) { e--; n++; }
      n = 0;
      while (porColuna[d % NT] === null && n < NT) { d++; n++; }
      const pe = porColuna[(e + NT) % NT] as number;
      const pd = porColuna[d % NT] as number;
      ph = pe + ((pd - pe) * (i - e)) / Math.max(d - e, 1);
    }
    const th = (2 * Math.PI * i) / NT;
    let achou: PontoMargem | null = null;
    for (let q = ph; q > 0.35 && !achou; q -= 0.2 * GRAU) {
      const h = arco.raio(prep.O, direcao(prep, th, q), 12);
      if (h) achou = { th, ph: q, ponto: h.ponto, normal: h.normal };
    }
    if (!achou) throw new Error('Linha de margem fora do preparo.');
    saida.push(achou);
  }
  return saida;
}

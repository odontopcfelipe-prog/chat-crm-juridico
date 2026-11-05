/**
 * Passos CAD — o plano do dente: onde ficam as cúspides, as cristas e os sulcos. É o "desenho" que a
 * IA devolve e o que forma-do-plano.ts transforma em superfície. A IA não mexe em malha: mesmo com
 * uma resposta ruim, os limites abaixo mantêm o dente dentro do que o motor sabe construir.
 *
 * Coordenadas normalizadas pelo contorno do dente: u vai de -1 (distal) a 1 (mesial), w vai de -1
 * (lingual ou palatina) a 1 (vestibular), h vai de 0 (margem) a 1 (altura natural do dente).
 */

export type P2 = [number, number];

/** Tudo o que sai do computador do técnico no Desenhar com IA: número do dente e medidas em mm. */
export interface PedidoDesenhoIa {
  fdi: number;
  medidas: {
    mdMm: number;
    vlMm: number;
    topoDoPreparoMm: number;
    folgaAntagonistaMm: number;
    espessuraMinimaMm: number;
    vizinhoMesialMm: number | null;
    vizinhoDistalMm: number | null;
  };
  /** 11 × 11: primeira linha w = 1, primeira coluna u = -1; alturas em mm acima da margem. */
  mapaAntagonista: (number | null)[][];
  mapaPreparo: (number | null)[][];
  planoInicial: PlanoDoDente;
}

export interface Cuspide {
  nome: string;
  u: number;
  w: number;
  h: number;
}

export interface Crista {
  de: P2;
  ate: P2;
  hDe: number;
  hMeio: number;
  hAte: number;
  /** Largura em relação ao tamanho do dente (1 = normal). */
  largura: number;
}

export interface Sulco {
  /** u, w e a profundidade em mm. */
  pontos: Array<[number, number, number]>;
}

export interface PlanoDoDente {
  cuspides: Cuspide[];
  cristas: Crista[];
  sulcos: Sulco[];
  /** Fossa central, para onde as cúspides descem. */
  centro: P2;
  /** Altura natural do dente, da margem à cúspide mais alta (mm). */
  alturaMm: number;
  /** Largura natural de mesial a distal (mm): o contato não estica o dente muito além disso. */
  larguraMm: number;
  /** Quanto o contorno passa da margem em cada lado (mm). */
  bojoVestibular: number;
  bojoLingual: number;
  /** Altura do ponto mais largo, de 0 (margem) a 1 (topo). */
  contornoVestibular: number;
  contornoLingual: number;
  /** Largura da face oclusal em relação ao contorno (0,5 a 0,95). */
  mesa: number;
}

const limita = (x: number, a: number, b: number) => (x < a ? a : x > b ? b : x);

/** Dente em cada lado do arco é o mesmo em u, w: o motor espelha pelos eixos do caso. */
const lobo = (nome: string, u: number, w: number, h: number): Cuspide => ({ nome, u, w, h });

/** Crista triangular: da ponta da cúspide em direção à fossa. */
function triangular(c: Cuspide, centro: P2, alcance: number, sobra = 0.04): Crista {
  const ate: P2 = [c.u + (centro[0] - c.u) * alcance, c.w + (centro[1] - c.w) * alcance];
  const fim = c.h * (1 - 0.42 * alcance);
  return { de: [c.u, c.w], ate, hDe: c.h - 0.05, hMeio: (c.h + fim) / 2 + sobra - 0.04, hAte: fim, largura: 0.8 };
}

/** Crista marginal: fecha a oclusal entre duas cúspides, numa altura pouco abaixo delas. */
function marginal(a: Cuspide, b: Cuspide, queda = 0.1, sela = 0.04): Crista {
  return { de: [a.u, a.w], ate: [b.u, b.w], hDe: a.h - queda, hMeio: Math.min(a.h, b.h) - queda - sela, hAte: b.h - queda, largura: 0.7 };
}

function molarSuperior(unidade: number): Omit<PlanoDoDente, 'larguraMm'> {
  const centro: P2 = [0.1, 0.05];
  const MV = lobo('mesio-vestibular', 0.56, 0.6, 0.96);
  const DV = lobo('disto-vestibular', -0.42, 0.6, 0.91);
  const MP = lobo('mesio-palatina', 0.26, -0.52, 1);
  const DP = lobo('disto-palatina', -0.56, -0.56, unidade === 8 ? 0.72 : unidade === 7 ? 0.78 : 0.84);
  const cristas: Crista[] = [
    { de: [MP.u, MP.w], ate: [DV.u, DV.w], hDe: 0.94, hMeio: 0.82, hAte: 0.87, largura: 0.95 },
    marginal(MV, MP, 0.1),
    marginal(DV, DP, 0.11),
    triangular(MV, centro, 0.62),
    triangular(DV, centro, 0.5),
    triangular(MP, centro, 0.45),
    triangular(DP, [-0.3, -0.12], 0.55),
  ];
  const sulcos: Sulco[] = [
    { pontos: [[0.62, 0.02, 0.4], [0.32, 0.05, 0.4], centroComProfundidade(centro, 0.6)] },
    { pontos: [centroComProfundidade(centro, 0.6), [0.1, 0.42, 0.4], [0.08, 0.72, 0.28], [0.07, 0.96, 0.12]] },
    { pontos: [[-0.38, -0.14, 0.52], [-0.55, 0.06, 0.38], [-0.68, 0.16, 0.32]] },
    { pontos: [[-0.38, -0.14, 0.52], [-0.28, -0.42, 0.38], [-0.24, -0.72, 0.28], [-0.22, -0.96, 0.12]] },
  ];
  return { cuspides: [MV, DV, MP, DP], cristas, sulcos, centro, alturaMm: 7.6, bojoVestibular: 0.55, bojoLingual: 0.55, contornoVestibular: 0.32, contornoLingual: 0.5, mesa: 0.8 };
}

const centroComProfundidade = (c: P2, p: number): [number, number, number] => [c[0], c[1], p];

function molarInferior(unidade: number): Omit<PlanoDoDente, 'larguraMm'> {
  const centro: P2 = [0.02, 0.02];
  const ML = lobo('mesio-lingual', 0.52, -0.56, 1);
  const DL = lobo('disto-lingual', -0.42, -0.58, 0.96);
  const MV = lobo('mesio-vestibular', 0.54, 0.54, 0.92);
  const DV = lobo(unidade === 6 ? 'disto-vestibular' : 'disto-vestibular', unidade === 6 ? -0.08 : -0.46, 0.58, 0.89);
  const cuspides = [ML, DL, MV, DV];
  if (unidade === 6) cuspides.push(lobo('distal', -0.68, 0.14, 0.8));
  const cristas: Crista[] = [
    marginal(MV, ML, 0.1),
    unidade === 6 ? marginal(cuspides[4], DL, 0.1) : marginal(DV, DL, 0.1),
    triangular(ML, centro, 0.55),
    triangular(DL, centro, 0.5),
    triangular(MV, centro, 0.58),
    triangular(DV, centro, 0.52),
  ];
  if (unidade === 6) cristas.push(triangular(cuspides[4], centro, 0.45));
  const sulcos: Sulco[] = [
    { pontos: [[0.66, 0, 0.36], [0.32, 0.01, 0.42], centroComProfundidade(centro, 0.6), [-0.32, -0.01, 0.42], [-0.62, -0.05, 0.36]] },
    { pontos: [centroComProfundidade(centro, 0.6), [0.2, 0.36, 0.38], [0.26, 0.7, 0.26], [0.28, 0.96, 0.1]] },
    { pontos: [centroComProfundidade(centro, 0.6), [0.04, -0.36, 0.36], [0.05, -0.72, 0.24], [0.05, -0.96, 0.08]] },
  ];
  if (unidade === 6) sulcos.push({ pontos: [[-0.32, -0.01, 0.42], [-0.4, 0.3, 0.32], [-0.44, 0.62, 0.22], [-0.46, 0.92, 0.08]] });
  return { cuspides, cristas, sulcos, centro, alturaMm: 7, bojoVestibular: 0.6, bojoLingual: 0.45, contornoVestibular: 0.3, contornoLingual: 0.5, mesa: 0.78 };
}

function preMolarSuperior(unidade: number): Omit<PlanoDoDente, 'larguraMm'> {
  const centro: P2 = [0, 0];
  const V = lobo('vestibular', 0.04, 0.54, 1);
  const P = lobo('palatina', -0.02, -0.52, unidade === 4 ? 0.84 : 0.92);
  const cristas = [
    marginal(V, P, 0.14, 0.08),
    triangular(V, centro, 0.66),
    triangular(P, centro, 0.62),
  ];
  // As duas cristas marginais ficam nas pontas do sulco central, uma de cada lado.
  cristas.push({ de: [0.74, 0.32], ate: [0.72, -0.3], hDe: 0.8, hMeio: 0.72, hAte: 0.74, largura: 0.75 });
  cristas.push({ de: [-0.74, 0.32], ate: [-0.72, -0.3], hDe: 0.78, hMeio: 0.7, hAte: 0.72, largura: 0.75 });
  // As arestas de cada cúspide descem até as marginais: sem elas, o dente fica com um ombro em cada lado.
  cristas.push({ de: [V.u, V.w], ate: [0.74, 0.32], hDe: 0.97, hMeio: 0.9, hAte: 0.79, largura: 0.8 });
  cristas.push({ de: [V.u, V.w], ate: [-0.74, 0.32], hDe: 0.97, hMeio: 0.89, hAte: 0.77, largura: 0.8 });
  cristas.push({ de: [P.u, P.w], ate: [0.72, -0.3], hDe: P.h - 0.03, hMeio: (P.h + 0.74) / 2, hAte: 0.73, largura: 0.8 });
  cristas.push({ de: [P.u, P.w], ate: [-0.72, -0.3], hDe: P.h - 0.03, hMeio: (P.h + 0.72) / 2, hAte: 0.71, largura: 0.8 });
  const sulcos: Sulco[] = [{ pontos: [[0.5, 0, 0.42], [0.16, 0, 0.5], [-0.16, 0, 0.5], [-0.5, 0, 0.42]] }];
  return { cuspides: [V, P], cristas, sulcos, centro, alturaMm: unidade === 4 ? 8 : 7.6, bojoVestibular: 0.55, bojoLingual: 0.5, contornoVestibular: 0.32, contornoLingual: 0.5, mesa: 0.76 };
}

function preMolarInferior(unidade: number): Omit<PlanoDoDente, 'larguraMm'> {
  const centro: P2 = [0, -0.02];
  const V = lobo('vestibular', 0.02, 0.4, 1);
  if (unidade === 4) {
    const L = lobo('lingual', 0.02, -0.56, 0.68);
    const cristas = [
      { de: [V.u, V.w] as P2, ate: [L.u, L.w] as P2, hDe: 0.98, hMeio: 0.72, hAte: 0.66, largura: 0.95 },
      { de: [0.72, 0.2] as P2, ate: [0.68, -0.3] as P2, hDe: 0.72, hMeio: 0.62, hAte: 0.58, largura: 0.75 },
      { de: [-0.72, 0.2] as P2, ate: [-0.68, -0.3] as P2, hDe: 0.7, hMeio: 0.6, hAte: 0.56, largura: 0.75 },
      { de: [V.u, V.w] as P2, ate: [0.72, 0.2] as P2, hDe: 0.97, hMeio: 0.86, hAte: 0.71, largura: 0.8 },
      { de: [V.u, V.w] as P2, ate: [-0.72, 0.2] as P2, hDe: 0.97, hMeio: 0.85, hAte: 0.69, largura: 0.8 },
    ];
    const sulcos: Sulco[] = [
      { pontos: [[0.5, -0.02, 0.32], [0.3, -0.04, 0.42]] },
      { pontos: [[-0.5, -0.02, 0.32], [-0.3, -0.04, 0.42]] },
    ];
    return { cuspides: [V, L], cristas, sulcos, centro, alturaMm: 8, bojoVestibular: 0.6, bojoLingual: 0.4, contornoVestibular: 0.3, contornoLingual: 0.5, mesa: 0.72 };
  }
  const ML = lobo('mesio-lingual', 0.32, -0.56, 0.84);
  const DL = lobo('disto-lingual', -0.36, -0.56, 0.74);
  const cristas: Crista[] = [
    triangular(V, centro, 0.62),
    triangular(ML, centro, 0.55),
    triangular(DL, centro, 0.5),
    { de: [0.7, 0.24], ate: [0.62, -0.32], hDe: 0.76, hMeio: 0.68, hAte: 0.7, largura: 0.75 },
    { de: [-0.7, 0.24], ate: [-0.62, -0.32], hDe: 0.72, hMeio: 0.64, hAte: 0.64, largura: 0.75 },
    { de: [V.u, V.w], ate: [0.7, 0.24], hDe: 0.97, hMeio: 0.88, hAte: 0.75, largura: 0.8 },
    { de: [V.u, V.w], ate: [-0.7, 0.24], hDe: 0.97, hMeio: 0.86, hAte: 0.71, largura: 0.8 },
  ];
  const sulcos: Sulco[] = [
    { pontos: [[0.5, 0, 0.36], [0.18, -0.02, 0.46], [-0.02, -0.08, 0.5], [-0.46, 0, 0.36]] },
    { pontos: [[-0.02, -0.08, 0.5], [-0.02, -0.42, 0.34], [-0.02, -0.8, 0.14]] },
  ];
  return { cuspides: [V, ML, DL], cristas, sulcos, centro, alturaMm: 7.6, bojoVestibular: 0.6, bojoLingual: 0.42, contornoVestibular: 0.3, contornoLingual: 0.5, mesa: 0.74 };
}

function canino(superior: boolean): Omit<PlanoDoDente, 'larguraMm'> {
  const ponta = lobo('ponta', 0.08, 0.2, 1);
  const cristas: Crista[] = [
    { de: [ponta.u, ponta.w], ate: [0.82, 0.14], hDe: 0.99, hMeio: 0.88, hAte: 0.74, largura: 0.75 },
    { de: [ponta.u, ponta.w], ate: [-0.82, 0.12], hDe: 0.99, hMeio: 0.82, hAte: 0.66, largura: 0.75 },
    { de: [ponta.u, ponta.w], ate: [0, -0.74], hDe: 0.98, hMeio: 0.62, hAte: 0.36, largura: 0.9 },
    { de: [0.82, 0.14], ate: [0.2, -0.76], hDe: 0.72, hMeio: 0.56, hAte: 0.34, largura: 0.7 },
    { de: [-0.82, 0.12], ate: [-0.2, -0.76], hDe: 0.64, hMeio: 0.5, hAte: 0.34, largura: 0.7 },
  ];
  return { cuspides: [ponta, lobo('cingulo', 0, -0.76, 0.34)], cristas, sulcos: [], centro: [0, -0.3], alturaMm: superior ? 10.5 : 10, bojoVestibular: 0.55, bojoLingual: 0.5, contornoVestibular: 0.28, contornoLingual: 0.25, mesa: 0.62 };
}

function incisivo(superior: boolean, lateral: boolean): Omit<PlanoDoDente, 'larguraMm'> {
  const w = superior ? 0.46 : 0.12;
  const alto = lobo('borda incisal mesial', 0.72, w, 1);
  const meio = lobo('borda incisal central', 0.02, w, 1);
  const baixo = lobo('borda incisal distal', -0.72, w, lateral ? 0.94 : 0.97);
  const cristas: Crista[] = [
    { de: [alto.u, alto.w], ate: [meio.u, meio.w], hDe: 0.99, hMeio: 0.98, hAte: 0.99, largura: 0.5 },
    { de: [meio.u, meio.w], ate: [baixo.u, baixo.w], hDe: 0.99, hMeio: 0.97, hAte: baixo.h - 0.01, largura: 0.5 },
    { de: [alto.u, alto.w], ate: [0.22, -0.72], hDe: 0.97, hMeio: 0.68, hAte: 0.3, largura: 0.65 },
    { de: [baixo.u, baixo.w], ate: [-0.22, -0.72], hDe: 0.92, hMeio: 0.64, hAte: 0.3, largura: 0.65 },
  ];
  const altura = superior ? (lateral ? 9.5 : 10.5) : 9;
  return { cuspides: [alto, meio, baixo, lobo('cingulo', 0, -0.76, 0.3)], cristas, sulcos: [], centro: [0, -0.2], alturaMm: altura, bojoVestibular: 0.45, bojoLingual: 0.45, contornoVestibular: 0.25, contornoLingual: 0.22, mesa: 0.82 };
}

/** Largura de mesial a distal, em mm, do dente 1 ao dente 8: médias dos livros de anatomia dental. */
const LARGURAS_SUPERIORES = [8.5, 6.5, 7.5, 7, 7, 10, 9.5, 8.5];
const LARGURAS_INFERIORES = [5, 5.5, 7, 7, 7, 11, 10.5, 10];

function desenhoDoDente(unidade: number, superior: boolean): Omit<PlanoDoDente, 'larguraMm'> {
  if (unidade >= 6) return superior ? molarSuperior(unidade) : molarInferior(unidade);
  if (unidade >= 4) return superior ? preMolarSuperior(unidade) : preMolarInferior(unidade);
  if (unidade === 3) return canino(superior);
  return incisivo(superior, unidade === 2);
}

/** O desenho de partida de cada dente, pela anatomia descrita nos livros de escultura dental. */
export function planoPadrao(fdi: number): PlanoDoDente {
  const quadrante = Math.floor(fdi / 10);
  const unidade = fdi % 10;
  const superior = quadrante === 1 || quadrante === 2;
  return { ...desenhoDoDente(unidade, superior), larguraMm: (superior ? LARGURAS_SUPERIORES : LARGURAS_INFERIORES)[unidade - 1] };
}

const numero = (v: unknown, padrao: number, a: number, b: number): number => (typeof v === 'number' && Number.isFinite(v) ? limita(v, a, b) : padrao);
const NORMAL = 1.05;

/** Até onde a resposta da IA pode mudar o dente. Fora disso é engano: fica o padrão daquele campo. */
const MAIS_CUSPIDES = 6;
const MAIS_CRISTAS = 16;
const MAIS_SULCOS = 8;
const MAIS_PONTOS = 12;
const MAIOR_SULCO = 0.8;
const MENOR_CUSPIDE_MAIS_ALTA = 0.45;

/** Aceita os dois jeitos de escrever um ponto: [u, w] no plano de partida e {u, w} na resposta da IA. */
const ponto2 = (v: unknown): P2 | null => {
  const obj = v as { u?: unknown; w?: unknown } | null;
  const u = Array.isArray(v) ? v[0] : obj?.u;
  const w = Array.isArray(v) ? v[1] : obj?.w;
  if (typeof u !== 'number' || typeof w !== 'number' || !Number.isFinite(u) || !Number.isFinite(w)) return null;
  return [limita(u, -NORMAL, NORMAL), limita(w, -NORMAL, NORMAL)];
};

/**
 * Transforma a resposta da IA num plano que o motor consegue construir. Nada de fora passa sem ser
 * conferido, e o que estiver errado ou faltar vem do desenho de partida daquele dente.
 */
export function validarPlano(bruto: unknown, fdi: number): PlanoDoDente {
  const base = planoPadrao(fdi);
  if (typeof bruto !== 'object' || bruto === null) return base;
  const r = bruto as Record<string, unknown>;

  const cuspides: Cuspide[] = [];
  if (Array.isArray(r.cuspides)) {
    for (const c of r.cuspides.slice(0, MAIS_CUSPIDES) as Array<Record<string, unknown>>) {
      if (typeof c !== 'object' || c === null || typeof c.u !== 'number' || typeof c.w !== 'number' || typeof c.h !== 'number') continue;
      if (![c.u, c.w, c.h].every(Number.isFinite)) continue;
      cuspides.push({ nome: typeof c.nome === 'string' ? c.nome.slice(0, 40) : 'cuspide', u: limita(c.u, -0.95, 0.95), w: limita(c.w, -0.95, 0.95), h: limita(c.h, 0.2, 1.05) });
    }
  }
  const cristas: Crista[] = [];
  if (Array.isArray(r.cristas)) {
    for (const c of r.cristas.slice(0, MAIS_CRISTAS) as Array<Record<string, unknown>>) {
      if (typeof c !== 'object' || c === null) continue;
      const de = ponto2(c.de);
      const ate = ponto2(c.ate);
      if (!de || !ate) continue;
      cristas.push({
        de,
        ate,
        hDe: numero(c.hDe, 0.8, 0.2, 1.05),
        hMeio: numero(c.hMeio, 0.7, 0.2, 1.05),
        hAte: numero(c.hAte, 0.6, 0.2, 1.05),
        largura: numero(c.largura, 0.8, 0.4, 1.3),
      });
    }
  }
  const sulcos: Sulco[] = [];
  if (Array.isArray(r.sulcos)) {
    for (const s of r.sulcos.slice(0, MAIS_SULCOS) as Array<Record<string, unknown>>) {
      const pontos: Array<[number, number, number]> = [];
      const candidato = (s as { pontos?: unknown } | null)?.pontos;
      const lista: unknown[] = Array.isArray(candidato) ? candidato : [];
      for (const p of lista.slice(0, MAIS_PONTOS)) {
        const xy = ponto2(p);
        const prof = Array.isArray(p) ? p[2] : (p as { prof?: unknown } | null)?.prof;
        if (xy) pontos.push([xy[0], xy[1], numero(prof, 0.3, 0, MAIOR_SULCO)]);
      }
      if (pontos.length >= 2) sulcos.push({ pontos });
    }
  }
  const centro = ponto2(r.centro) ?? base.centro;
  // Sem cúspide, ou com todas achatadas, não existe dente: fica a forma de partida.
  const maisAlta = Math.max(0, ...cuspides.map((c) => c.h));
  const valeu = maisAlta >= MENOR_CUSPIDE_MAIS_ALTA;
  // Crista acima das cúspides viraria uma torre no meio do dente.
  const tetoDaCrista = maisAlta * 1.05;
  return {
    cuspides: valeu ? cuspides : base.cuspides,
    cristas: valeu ? cristas.map((c) => ({ ...c, hDe: Math.min(c.hDe, tetoDaCrista), hMeio: Math.min(c.hMeio, tetoDaCrista), hAte: Math.min(c.hAte, tetoDaCrista) })) : base.cristas,
    sulcos: valeu ? sulcos : base.sulcos,
    centro: [limita(centro[0], -0.5, 0.5), limita(centro[1], -0.5, 0.5)],
    alturaMm: numero(r.alturaMm, base.alturaMm, base.alturaMm * 0.8, base.alturaMm * 1.2),
    larguraMm: numero(r.larguraMm, base.larguraMm, base.larguraMm * 0.8, base.larguraMm * 1.2),
    bojoVestibular: numero(r.bojoVestibular, base.bojoVestibular, 0.1, 1.2),
    bojoLingual: numero(r.bojoLingual, base.bojoLingual, 0.1, 1.2),
    contornoVestibular: numero(r.contornoVestibular, base.contornoVestibular, 0.15, 0.65),
    contornoLingual: numero(r.contornoLingual, base.contornoLingual, 0.15, 0.65),
    mesa: numero(r.mesa, base.mesa, 0.5, 0.95),
  };
}

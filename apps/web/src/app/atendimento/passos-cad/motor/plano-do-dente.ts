/**
 * Passos CAD — o plano do dente: onde ficam as cúspides, as cristas e os sulcos. É o "desenho" que a
 * IA devolve e o que forma-do-plano.ts transforma em superfície. A IA não mexe em malha: mesmo com
 * uma resposta ruim, os limites abaixo mantêm o dente dentro do que o motor sabe construir.
 *
 * Coordenadas normalizadas pelo contorno do dente: u vai de -1 (distal) a 1 (mesial), w vai de -1
 * (lingual ou palatina) a 1 (vestibular), h vai de 0 (margem) a 1 (altura natural do dente).
 *
 * Medidas e morfologia: médias de Wheeler e de Ash & Nelson. Valem como ponto de partida: o espaço do
 * caso vem primeiro.
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
    espessuraOclusalMm: number;
    espessuraAxialMm: number;
    /** Altura, na mesma escala dos mapas, em que fica h = 1. */
    alturaDoDenteMm: number;
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
  /** Crista marginal: fica na altura da crista do vizinho desse lado. */
  lado?: 'mesial' | 'distal';
}

export interface Sulco {
  /** u, w e a profundidade em mm. */
  pontos: Array<[number, number, number]>;
  /** Largura em mm. O motor alarga se o fundo ficar fechado demais para fresar. */
  largura?: number;
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
  /** Largura natural de vestibular a lingual (mm): o bojo se ajusta para chegar perto dela. */
  vlMm: number;
  /** Quanto o contorno passa da margem em cada lado (mm). */
  bojoVestibular: number;
  bojoLingual: number;
  /** Altura do ponto mais largo, de 0 (margem) a 1 (topo). */
  contornoVestibular: number;
  contornoLingual: number;
  /** Altura do contato com cada vizinho, de 0 (margem) a 1 (topo). */
  contatoMesial: number;
  contatoDistal: number;
  /** Largura da face oclusal em relação ao contorno (0,5 a 0,95). */
  mesa: number;
  /** Incisivo ou canino: a altura conta da margem vestibular, e a borda anda mais para fugir do dente oposto. */
  anterior?: boolean;
}

type Anatomia = Omit<PlanoDoDente, 'alturaMm' | 'larguraMm' | 'vlMm'>;

const limita = (x: number, a: number, b: number) => (x < a ? a : x > b ? b : x);

const lobo = (nome: string, u: number, w: number, h: number): Cuspide => ({ nome, u, w, h });

/** Sulco principal: profundo, liga as fossas. */
const principal = (...pontos: Array<[number, number, number]>): Sulco => ({ pontos, largura: 0.5 });
/** Sulco secundário: raso e fino, sai das fossetas. É ele que tira o aspecto de plástico da oclusal. */
const secundario = (...pontos: Array<[number, number, number]>): Sulco => ({ pontos, largura: 0.3 });
/** Fossa larga e rasa: a face palatina dos anteriores é côncava, não riscada. */
const fossa = (...pontos: Array<[number, number, number]>): Sulco => ({ pontos, largura: 0.85 });

/** Crista triangular: da ponta da cúspide em direção à fossa. */
function triangular(c: Cuspide, centro: P2, alcance: number, sobra = 0.04): Crista {
  const ate: P2 = [c.u + (centro[0] - c.u) * alcance, c.w + (centro[1] - c.w) * alcance];
  const fim = c.h * (1 - 0.42 * alcance);
  return { de: [c.u, c.w], ate, hDe: c.h - 0.05, hMeio: (c.h + fim) / 2 + sobra - 0.04, hAte: fim, largura: 0.8 };
}

/** Crista marginal: fecha a oclusal entre duas cúspides, numa altura pouco abaixo delas. */
function marginal(a: Cuspide, b: Cuspide, lado: 'mesial' | 'distal', queda = 0.1, sela = 0.04): Crista {
  return { de: [a.u, a.w], ate: [b.u, b.w], hDe: a.h - queda, hMeio: Math.min(a.h, b.h) - queda - sela, hAte: b.h - queda, largura: 0.7, lado };
}

function molarSuperior(unidade: number): Anatomia {
  const centro: P2 = [0.1, 0.05];
  const MV = lobo('mesio-vestibular', 0.56, 0.58, 0.95);
  const DV = lobo('disto-vestibular', -0.42, 0.58, 0.9);
  const MP = lobo('mesio-palatina', 0.26, -0.54, 1);
  const DP = lobo('disto-palatina', -0.56, -0.56, unidade === 8 ? 0.72 : unidade === 7 ? 0.76 : 0.84);
  const cristas: Crista[] = [
    // A crista oblíqua é a marca do molar superior; no 17 e no 18 ela é menos nítida.
    { de: [MP.u, MP.w], ate: [DV.u, DV.w], hDe: 0.94, hMeio: unidade === 6 ? 0.82 : 0.76, hAte: 0.86, largura: 0.95 },
    marginal(MV, MP, 'mesial', 0.1),
    marginal(DV, DP, 'distal', 0.11),
    triangular(MV, centro, 0.62),
    triangular(DV, centro, 0.5),
    triangular(MP, centro, 0.45),
    triangular(DP, [-0.3, -0.12], 0.55),
  ];
  const sulcos: Sulco[] = [
    principal([0.62, 0.02, 0.55], [0.32, 0.05, 0.6], [0.1, 0.05, 0.85]),
    principal([0.1, 0.05, 0.85], [0.1, 0.42, 0.6], [0.08, 0.72, 0.42], [0.07, 0.96, 0.15]),
    principal([-0.38, -0.14, 0.75], [-0.55, 0.06, 0.55], [-0.68, 0.16, 0.5]),
    principal([-0.38, -0.14, 0.75], [-0.28, -0.42, 0.55], [-0.24, -0.72, 0.38], [-0.22, -0.96, 0.12]),
    secundario([0.58, 0.04, 0.3], [0.68, 0.32, 0.18]),
    secundario([0.58, 0.04, 0.3], [0.64, -0.26, 0.18]),
    secundario([0.1, 0.05, 0.32], [0.34, 0.3, 0.2]),
    secundario([0.1, 0.05, 0.32], [-0.14, 0.34, 0.2]),
    secundario([0.1, 0.05, 0.3], [0.34, -0.2, 0.18]),
    secundario([-0.38, -0.14, 0.28], [-0.2, 0.08, 0.15]),
    secundario([-0.6, 0.08, 0.28], [-0.66, -0.2, 0.16]),
    secundario([-0.28, -0.42, 0.25], [-0.44, -0.3, 0.15]),
  ];
  return { cuspides: [MV, DV, MP, DP], cristas, sulcos, centro, bojoVestibular: 0.55, bojoLingual: 0.55, contornoVestibular: 0.32, contornoLingual: 0.5, contatoMesial: 0.62, contatoDistal: 0.52, mesa: 0.8 };
}

function molarInferior(unidade: number): Anatomia {
  const centro: P2 = [0.02, 0.02];
  // As linguais são mais altas e mais pontiagudas.
  const ML = lobo('mesio-lingual', 0.5, -0.58, 1);
  const DL = lobo('disto-lingual', -0.4, -0.6, 0.97);
  const MV = lobo('mesio-vestibular', 0.52, 0.52, 0.92);
  const cincoCuspides = unidade === 6;
  const DV = lobo('disto-vestibular', cincoCuspides ? -0.08 : -0.46, 0.56, 0.89);
  const cuspides = [ML, DL, MV, DV];
  if (cincoCuspides) cuspides.push(lobo('distal', -0.68, 0.14, 0.8));
  const cristas: Crista[] = [
    marginal(MV, ML, 'mesial', 0.1),
    cincoCuspides ? marginal(cuspides[4], DL, 'distal', 0.1) : marginal(DV, DL, 'distal', 0.1),
    triangular(ML, centro, 0.55),
    triangular(DL, centro, 0.5),
    triangular(MV, centro, 0.58),
    triangular(DV, centro, 0.52),
  ];
  if (cincoCuspides) cristas.push(triangular(cuspides[4], centro, 0.45));
  const central = principal([0.66, 0, 0.5], [0.32, 0.01, 0.6], [centro[0], centro[1], 0.85], [-0.32, -0.01, 0.6], [-0.62, -0.05, 0.5]);
  // O 36 tem sulcos em Y, com cinco cúspides; o 37 e o 38, em cruz, com quatro.
  const sulcos: Sulco[] = cincoCuspides
    ? [
        central,
        principal([centro[0], centro[1], 0.85], [0.2, 0.36, 0.6], [0.26, 0.7, 0.42], [0.28, 0.96, 0.12]),
        principal([centro[0], centro[1], 0.85], [0.04, -0.36, 0.55], [0.05, -0.72, 0.36], [0.05, -0.96, 0.1]),
        principal([-0.32, -0.01, 0.6], [-0.4, 0.3, 0.45], [-0.44, 0.62, 0.3], [-0.46, 0.92, 0.1]),
        secundario([0.6, 0, 0.28], [0.68, 0.28, 0.16]),
        secundario([0.6, 0, 0.28], [0.66, -0.26, 0.16]),
        secundario([0.02, 0.02, 0.32], [-0.22, 0.26, 0.18]),
        secundario([0.02, 0.02, 0.32], [0.28, -0.22, 0.2]),
        secundario([0.02, 0.02, 0.3], [-0.2, -0.26, 0.18]),
        secundario([-0.56, -0.04, 0.28], [-0.62, -0.3, 0.16]),
      ]
    : [
        central,
        principal([centro[0], centro[1], 0.85], [0.03, 0.36, 0.55], [0.03, 0.7, 0.38], [0.03, 0.96, 0.1]),
        principal([centro[0], centro[1], 0.85], [0.03, -0.36, 0.55], [0.03, -0.72, 0.36], [0.03, -0.96, 0.1]),
        secundario([0.6, 0, 0.28], [0.68, 0.28, 0.16]),
        secundario([0.6, 0, 0.28], [0.66, -0.26, 0.16]),
        secundario([-0.56, -0.04, 0.28], [-0.62, 0.26, 0.16]),
        secundario([-0.56, -0.04, 0.28], [-0.62, -0.3, 0.16]),
        secundario([0.02, 0.02, 0.3], [0.28, 0.24, 0.18]),
        secundario([0.02, 0.02, 0.3], [-0.24, -0.24, 0.18]),
      ];
  return { cuspides, cristas, sulcos, centro, bojoVestibular: 0.6, bojoLingual: 0.45, contornoVestibular: 0.3, contornoLingual: 0.5, contatoMesial: 0.6, contatoDistal: 0.5, mesa: 0.78 };
}

function preMolarSuperior(unidade: number): Anatomia {
  const centro: P2 = [0, 0];
  const primeiro = unidade === 4;
  const V = lobo('vestibular', 0.04, 0.58, 1);
  // No 14 a vestibular é cerca de 1 mm mais alta; no 15 as duas têm quase a mesma altura.
  const P = lobo('palatina', -0.02, -0.56, primeiro ? 0.88 : 0.96);
  const marginalMesial: P2[] = [[0.74, 0.32], [0.72, -0.3]];
  const marginalDistal: P2[] = [[-0.74, 0.32], [-0.72, -0.3]];
  const cristas: Crista[] = [
    triangular(V, centro, 0.66),
    triangular(P, centro, 0.62),
    // As duas cristas marginais ficam nas pontas do sulco central, uma de cada lado.
    { de: marginalMesial[0], ate: marginalMesial[1], hDe: 0.8, hMeio: 0.72, hAte: 0.74, largura: 0.75, lado: 'mesial' },
    { de: marginalDistal[0], ate: marginalDistal[1], hDe: 0.78, hMeio: 0.7, hAte: 0.72, largura: 0.75, lado: 'distal' },
    // As arestas de cada cúspide descem até as marginais: sem elas, o dente fica com um ombro em cada lado.
    { de: [V.u, V.w], ate: marginalMesial[0], hDe: 0.97, hMeio: 0.9, hAte: 0.79, largura: 0.8 },
    { de: [V.u, V.w], ate: marginalDistal[0], hDe: 0.97, hMeio: 0.89, hAte: 0.77, largura: 0.8 },
    { de: [P.u, P.w], ate: marginalMesial[1], hDe: P.h - 0.03, hMeio: (P.h + 0.74) / 2, hAte: 0.73, largura: 0.8 },
    { de: [P.u, P.w], ate: marginalDistal[1], hDe: P.h - 0.03, hMeio: (P.h + 0.72) / 2, hAte: 0.71, largura: 0.8 },
  ];
  const sulcos: Sulco[] = primeiro
    ? [
        // Sulco central longo, e o que cruza a crista marginal mesial, que identifica o 14.
        principal([0.54, 0, 0.55], [0.16, 0, 0.7], [-0.16, 0, 0.7], [-0.54, 0, 0.55]),
        principal([0.54, 0, 0.5], [0.76, -0.04, 0.32], [0.96, -0.06, 0.1]),
        secundario([0.5, 0, 0.26], [0.6, 0.28, 0.15]),
        secundario([0.5, 0, 0.26], [0.56, -0.26, 0.15]),
        secundario([-0.5, 0, 0.26], [-0.6, 0.28, 0.15]),
        secundario([-0.5, 0, 0.26], [-0.56, -0.26, 0.15]),
      ]
    : [
        // Sulco central curto, com mais sulcos secundários saindo dele.
        principal([0.32, 0, 0.55], [0, 0, 0.65], [-0.32, 0, 0.55]),
        secundario([0.32, 0, 0.3], [0.52, 0.26, 0.17]),
        secundario([0.32, 0, 0.3], [0.5, -0.24, 0.17]),
        secundario([-0.32, 0, 0.3], [-0.52, 0.26, 0.17]),
        secundario([-0.32, 0, 0.3], [-0.5, -0.24, 0.17]),
        secundario([0, 0, 0.28], [0.14, 0.3, 0.16]),
        secundario([0, 0, 0.28], [-0.14, -0.3, 0.16]),
      ];
  return { cuspides: [V, P], cristas, sulcos, centro, bojoVestibular: 0.55, bojoLingual: 0.5, contornoVestibular: 0.32, contornoLingual: 0.5, contatoMesial: 0.67, contatoDistal: 0.62, mesa: 0.76 };
}

function preMolarInferior(unidade: number): Anatomia {
  const centro: P2 = [0, -0.04];
  const V = lobo('vestibular', 0.02, 0.48, 1);
  if (unidade === 4) {
    // Vestibular dominante e lingual pequena, ligadas por uma crista transversa.
    const L = lobo('lingual', 0.02, -0.62, 0.68);
    const cristas: Crista[] = [
      { de: [V.u, V.w], ate: [L.u, L.w], hDe: 0.98, hMeio: 0.72, hAte: 0.66, largura: 0.95 },
      { de: [0.72, 0.2], ate: [0.68, -0.3], hDe: 0.72, hMeio: 0.62, hAte: 0.58, largura: 0.75, lado: 'mesial' },
      { de: [-0.72, 0.2], ate: [-0.68, -0.3], hDe: 0.7, hMeio: 0.6, hAte: 0.56, largura: 0.75, lado: 'distal' },
      { de: [V.u, V.w], ate: [0.72, 0.2], hDe: 0.97, hMeio: 0.86, hAte: 0.71, largura: 0.8 },
      { de: [V.u, V.w], ate: [-0.72, 0.2], hDe: 0.97, hMeio: 0.85, hAte: 0.69, largura: 0.8 },
    ];
    const sulcos: Sulco[] = [
      principal([0.52, -0.04, 0.4], [0.3, -0.08, 0.6]),
      principal([-0.52, -0.04, 0.4], [-0.3, -0.08, 0.6]),
      secundario([0.3, -0.08, 0.26], [0.42, 0.14, 0.15]),
      secundario([0.3, -0.08, 0.26], [0.36, -0.34, 0.15]),
      secundario([-0.3, -0.08, 0.26], [-0.42, 0.14, 0.15]),
      secundario([-0.3, -0.08, 0.26], [-0.36, -0.34, 0.15]),
    ];
    return { cuspides: [V, L], cristas, sulcos, centro, bojoVestibular: 0.6, bojoLingual: 0.4, contornoVestibular: 0.3, contornoLingual: 0.5, contatoMesial: 0.67, contatoDistal: 0.62, mesa: 0.72 };
  }
  // Tipo Y, com três cúspides, que é o mais comum no 35 e no 45.
  const ML = lobo('mesio-lingual', 0.34, -0.62, 0.84);
  const DL = lobo('disto-lingual', -0.38, -0.62, 0.76);
  const cristas: Crista[] = [
    triangular(V, centro, 0.62),
    triangular(ML, centro, 0.55),
    triangular(DL, centro, 0.5),
    { de: [0.7, 0.24], ate: [0.62, -0.32], hDe: 0.76, hMeio: 0.68, hAte: 0.7, largura: 0.75, lado: 'mesial' },
    { de: [-0.7, 0.24], ate: [-0.62, -0.32], hDe: 0.72, hMeio: 0.64, hAte: 0.64, largura: 0.75, lado: 'distal' },
    { de: [V.u, V.w], ate: [0.7, 0.24], hDe: 0.97, hMeio: 0.88, hAte: 0.75, largura: 0.8 },
    { de: [V.u, V.w], ate: [-0.7, 0.24], hDe: 0.97, hMeio: 0.86, hAte: 0.71, largura: 0.8 },
  ];
  const sulcos: Sulco[] = [
    principal([0.5, 0, 0.5], [0.18, -0.02, 0.6], [-0.02, -0.1, 0.75], [-0.46, -0.02, 0.5]),
    principal([-0.02, -0.1, 0.75], [-0.02, -0.44, 0.5], [-0.02, -0.82, 0.18]),
    secundario([0.42, 0, 0.26], [0.52, 0.22, 0.15]),
    secundario([0.42, 0, 0.26], [0.5, -0.24, 0.15]),
    secundario([-0.4, -0.02, 0.26], [-0.5, 0.22, 0.15]),
    secundario([-0.4, -0.02, 0.26], [-0.5, -0.24, 0.15]),
  ];
  return { cuspides: [V, ML, DL], cristas, sulcos, centro, bojoVestibular: 0.6, bojoLingual: 0.42, contornoVestibular: 0.3, contornoLingual: 0.5, contatoMesial: 0.67, contatoDistal: 0.62, mesa: 0.74 };
}

function canino(superior: boolean): Anatomia {
  // A ponta fica para a mesial: a aresta mesial é mais curta que a distal.
  const ponta = lobo('ponta', superior ? 0.12 : 0.18, superior ? 0.36 : 0.1, 1);
  const cingulo = lobo('cingulo', 0, -0.76, superior ? 0.38 : 0.28);
  const cristas: Crista[] = [
    { de: [ponta.u, ponta.w], ate: [0.86, 0.12], hDe: 0.99, hMeio: 0.9, hAte: 0.8, largura: 0.85 },
    { de: [ponta.u, ponta.w], ate: [-0.86, 0.1], hDe: 0.99, hMeio: 0.85, hAte: 0.7, largura: 0.85 },
    { de: [ponta.u, ponta.w], ate: [0, -0.74], hDe: 0.98, hMeio: 0.62, hAte: cingulo.h + 0.02, largura: 0.9 },
    { de: [0.86, 0.12], ate: [0.2, -0.76], hDe: 0.78, hMeio: 0.58, hAte: cingulo.h, largura: 0.7 },
    { de: [-0.86, 0.1], ate: [-0.2, -0.76], hDe: 0.68, hMeio: 0.52, hAte: cingulo.h, largura: 0.7 },
    // A crista vestibular que desce da ponta, mais evidente no canino superior.
    { de: [ponta.u, ponta.w], ate: [ponta.u * 0.6, 0.86], hDe: 0.98, hMeio: 0.82, hAte: 0.62, largura: superior ? 0.9 : 0.7 },
  ];
  const sulcos: Sulco[] = [
    fossa([0.34, -0.3, 0.2], [0.26, -0.56, 0.12]),
    fossa([-0.34, -0.3, 0.2], [-0.26, -0.56, 0.12]),
  ];
  return { cuspides: [ponta, cingulo], cristas, sulcos, centro: [0, -0.3], bojoVestibular: 0.5, bojoLingual: 0.5, contornoVestibular: 0.28, contornoLingual: 0.25, contatoMesial: 0.68, contatoDistal: 0.5, mesa: 0.72 };
}

function incisivo(superior: boolean, lateral: boolean): Anatomia {
  const w = superior ? 0.46 : 0.12;
  // Central superior: ângulo mésio-incisal quase reto e disto-incisal mais arredondado. O lateral é
  // mais arredondado nos dois. O inferior tem a borda reta e é quase simétrico.
  const mesial = lobo('borda incisal mesial', superior && !lateral ? 0.82 : 0.76, w, superior ? (lateral ? 0.97 : 1) : 1);
  const meio = lobo('borda incisal central', 0.02, w, superior ? 0.99 : 1);
  const distal = lobo('borda incisal distal', superior ? (lateral ? -0.64 : -0.72) : -0.76, w, superior ? (lateral ? 0.89 : 0.94) : 0.98);
  const cingulo = lobo('cingulo', superior ? -0.05 : 0, -0.76, superior ? 0.32 : 0.26);
  const cristas: Crista[] = [
    // Borda incisal contínua: crista estreita aqui deixaria as três pontas parecendo chifres.
    { de: [mesial.u, mesial.w], ate: [meio.u, meio.w], hDe: mesial.h - 0.01, hMeio: 0.99, hAte: 0.99, largura: 1 },
    { de: [meio.u, meio.w], ate: [distal.u, distal.w], hDe: 0.99, hMeio: Math.min(0.98, distal.h + 0.03), hAte: distal.h - 0.01, largura: 1 },
    { de: [mesial.u, mesial.w], ate: [0.22, -0.72], hDe: mesial.h - 0.03, hMeio: 0.68, hAte: cingulo.h, largura: 0.65 },
    { de: [distal.u, distal.w], ate: [-0.22, -0.72], hDe: distal.h - 0.03, hMeio: 0.64, hAte: cingulo.h, largura: 0.65 },
  ];
  // Fosseta palatina: mais funda no lateral superior; a face lingual do inferior é lisa.
  const sulcos: Sulco[] = superior ? [fossa([0, -0.26, lateral ? 0.32 : 0.2], [0, -0.52, lateral ? 0.22 : 0.12])] : [];
  return { cuspides: [mesial, meio, distal, cingulo], cristas, sulcos, centro: [0, -0.2], bojoVestibular: 0.4, bojoLingual: 0.4, contornoVestibular: 0.25, contornoLingual: 0.22, contatoMesial: 0.82, contatoDistal: 0.74, mesa: 0.82 };
}

function anatomiaDoDente(unidade: number, superior: boolean): Anatomia {
  if (unidade >= 6) return superior ? molarSuperior(unidade) : molarInferior(unidade);
  if (unidade >= 4) return superior ? preMolarSuperior(unidade) : preMolarInferior(unidade);
  if (unidade === 3) return canino(superior);
  return incisivo(superior, unidade === 2);
}

/** Altura, largura mesio-distal e largura vestíbulo-lingual em mm, do dente 1 ao 8. */
const MEDIDAS_SUPERIORES: ReadonlyArray<readonly [number, number, number]> = [
  [10.5, 8.5, 7],
  [9, 6.5, 6],
  [10, 7.5, 8],
  [8.5, 7, 9],
  [8.5, 6.5, 9],
  [7.5, 10, 11],
  [7, 9, 11],
  [6.5, 8.5, 10],
];
const MEDIDAS_INFERIORES: ReadonlyArray<readonly [number, number, number]> = [
  [9, 5, 6],
  [9.5, 5.5, 6.5],
  [11, 7, 7.5],
  [8.5, 7, 7.5],
  [8, 7, 8],
  [7.5, 11, 10.5],
  [7, 10.5, 10],
  [7, 10, 9.5],
];

/** O desenho de partida de cada dente, pela anatomia descrita nos livros de escultura dental. */
export function planoPadrao(fdi: number): PlanoDoDente {
  const quadrante = Math.floor(fdi / 10);
  const unidade = fdi % 10;
  const superior = quadrante === 1 || quadrante === 2;
  const [alturaMm, larguraMm, vlMm] = (superior ? MEDIDAS_SUPERIORES : MEDIDAS_INFERIORES)[unidade - 1];
  return { ...anatomiaDoDente(unidade, superior), alturaMm, larguraMm, vlMm, anterior: unidade <= 3 };
}

const numero = (v: unknown, padrao: number, a: number, b: number): number => (typeof v === 'number' && Number.isFinite(v) ? limita(v, a, b) : padrao);
const NORMAL = 1.05;

/** Até onde a resposta da IA pode mudar o dente. Fora disso é engano: fica o padrão daquele campo. */
const MAIS_CUSPIDES = 6;
const MAIS_CRISTAS = 16;
const MAIS_SULCOS = 16;
const MAIS_PONTOS = 12;
const MAIOR_SULCO = 1;
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
        // Crista marginal é de dente posterior: no anterior, mexeria na borda incisal.
        ...(fdi % 10 >= 4 && (c.lado === 'mesial' || c.lado === 'distal') ? { lado: c.lado } : {}),
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
      if (pontos.length >= 2) sulcos.push({ pontos, largura: numero((s as { largura?: unknown } | null)?.largura, 0.5, 0.2, 0.9) });
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
    vlMm: numero(r.vlMm, base.vlMm, base.vlMm * 0.8, base.vlMm * 1.2),
    // Sobrecontorno é erro comum: bojo só dentro do que um dente natural tem.
    bojoVestibular: numero(r.bojoVestibular, base.bojoVestibular, 0.2, 0.7),
    bojoLingual: numero(r.bojoLingual, base.bojoLingual, 0.3, 1),
    contornoVestibular: numero(r.contornoVestibular, base.contornoVestibular, 0.15, 0.65),
    contornoLingual: numero(r.contornoLingual, base.contornoLingual, 0.15, 0.65),
    contatoMesial: numero(r.contatoMesial, base.contatoMesial, 0.4, 0.9),
    contatoDistal: numero(r.contatoDistal, base.contatoDistal, 0.4, 0.9),
    mesa: numero(r.mesa, base.mesa, 0.5, 0.95),
    anterior: base.anterior,
  };
}

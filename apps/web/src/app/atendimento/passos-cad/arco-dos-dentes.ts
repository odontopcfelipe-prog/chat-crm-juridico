/**
 * Passos CAD — a arcada da ficha do caso: onde fica cada dente e que forma ele tem. Geometria
 * própria, sem imagem de nenhum outro programa. Numeração FDI, vista como no consultório: o
 * quadrante 1 em cima à esquerda, o 2 em cima à direita, o 3 embaixo à direita e o 4 embaixo à esquerda.
 */

export type TipoDeDente = 'incisivo' | 'canino' | 'premolar' | 'molar';

export interface DenteNoArco {
  fdi: number;
  /** Centro do dente e tamanho, nas unidades de LARGURA_DO_ARCO × ALTURA_DO_ARCO. */
  x: number;
  y: number;
  largura: number;
  altura: number;
  /** Graus: a parte de cima do desenho fica virada para fora da arcada. */
  rotacao: number;
  tipo: TipoDeDente;
}

export const LARGURA_DO_ARCO = 300;
export const ALTURA_DO_ARCO = 400;

const CENTRO_X = LARGURA_DO_ARCO / 2;
const RAIO_X = 118;
const RAIO_Y = 168;
/** As duas metades ficam um pouco separadas no meio, como nos modelos em oclusão abertos. */
const CENTRO_Y_CIMA = 193;
const CENTRO_Y_BAIXO = 207;
const FOLGA_ENTRE_DENTES = 0.5;
/** O contorno não enche a caixa: um pouco maior, os dentes ficam encostados como numa arcada de verdade. */
const ENCHER_LARGURA = 1.1;
const ENCHER_ALTURA = 1.28;

/** Medidas típicas em mm (ao longo da arcada, de dentro para fora dela), da linha média para trás. */
const MEDIDAS_CIMA: readonly (readonly [number, number])[] = [[8.5, 7], [6.5, 6.2], [7.5, 8], [7, 9], [7, 9], [10.2, 11], [9.6, 11], [8.8, 10.2]];
const MEDIDAS_BAIXO: readonly (readonly [number, number])[] = [[5.4, 6], [5.9, 6.2], [6.9, 7.6], [7, 8], [7.1, 8.2], [11, 10.4], [10.4, 10], [9.6, 9.6]];
const TIPOS: readonly TipoDeDente[] = ['incisivo', 'incisivo', 'canino', 'premolar', 'premolar', 'molar', 'molar', 'molar'];

/** Um quarto de arcada: da linha média (linha 0) até o fundo, com cada dente no meio do seu trecho. */
function quartoDeArco(medidas: readonly (readonly [number, number])[]) {
  const PASSOS = 2000;
  const comprimento: number[] = [0];
  let x0 = 0;
  let y0 = RAIO_Y;
  for (let k = 1; k <= PASSOS; k++) {
    const t = (k / PASSOS) * (Math.PI / 2);
    const x = RAIO_X * Math.sin(t);
    const y = RAIO_Y * Math.cos(t);
    comprimento.push(comprimento[k - 1] + Math.hypot(x - x0, y - y0));
    x0 = x;
    y0 = y;
  }
  const total = comprimento[PASSOS];
  const somaLarguras = medidas.reduce((s, m) => s + m[0], 0);
  const escala = (total - FOLGA_ENTRE_DENTES * medidas.length) / somaLarguras;
  let andado = 0;
  let cursor = 0;
  return medidas.map(([largura, altura]) => {
    const metade = (largura * escala) / 2;
    const alvo = andado + FOLGA_ENTRE_DENTES / 2 + metade;
    andado += largura * escala + FOLGA_ENTRE_DENTES;
    while (cursor < PASSOS && comprimento[cursor] < alvo) cursor++;
    const t = (cursor / PASSOS) * (Math.PI / 2);
    return {
      /** Distância da linha média e do centro da arcada (positivos). */
      lado: RAIO_X * Math.sin(t),
      frente: RAIO_Y * Math.cos(t),
      /** Graus da tangente: 0 na linha média, 90 no fundo. */
      giro: (Math.atan2(RAIO_Y * Math.sin(t), RAIO_X * Math.cos(t)) * 180) / Math.PI,
      largura: largura * escala * ENCHER_LARGURA,
      altura: altura * escala * ENCHER_ALTURA,
    };
  });
}

export function dentesDoArco(): DenteNoArco[] {
  const cima = quartoDeArco(MEDIDAS_CIMA);
  const baixo = quartoDeArco(MEDIDAS_BAIXO);
  const saida: DenteNoArco[] = [];
  for (let k = 0; k < 8; k++) {
    const c = cima[k];
    const b = baixo[k];
    const tipo = TIPOS[k];
    const n = k + 1;
    saida.push({ fdi: 10 + n, x: CENTRO_X - c.lado, y: CENTRO_Y_CIMA - c.frente, largura: c.largura, altura: c.altura, rotacao: -c.giro, tipo });
    saida.push({ fdi: 20 + n, x: CENTRO_X + c.lado, y: CENTRO_Y_CIMA - c.frente, largura: c.largura, altura: c.altura, rotacao: c.giro, tipo });
    saida.push({ fdi: 30 + n, x: CENTRO_X + b.lado, y: CENTRO_Y_BAIXO + b.frente, largura: b.largura, altura: b.altura, rotacao: 180 - b.giro, tipo });
    saida.push({ fdi: 40 + n, x: CENTRO_X - b.lado, y: CENTRO_Y_BAIXO + b.frente, largura: b.largura, altura: b.altura, rotacao: b.giro - 180, tipo });
  }
  return saida;
}

/** Contorno e sulcos de cada tipo, numa caixa de 100 × 100, com a face vestibular para cima. */
export const FORMA_DO_DENTE: Readonly<Record<TipoDeDente, { contorno: string; sulcos: string }>> = Object.freeze({
  incisivo: {
    contorno: 'M10 22C28 8 72 8 90 22C98 30 94 48 84 62C74 78 62 92 50 92C38 92 26 78 16 62C6 48 2 30 10 22Z',
    sulcos: 'M22 28Q50 20 78 28',
  },
  canino: {
    contorno: 'M50 3C70 8 92 30 94 52C96 74 74 97 50 97C26 97 4 74 6 52C8 30 30 8 50 3Z',
    sulcos: 'M50 20L50 58',
  },
  premolar: {
    contorno: 'M50 4C78 4 96 24 96 50C96 76 78 96 50 96C22 96 4 76 4 50C4 24 22 4 50 4Z',
    sulcos: 'M22 50Q50 38 78 50',
  },
  molar: {
    contorno: 'M20 10C35 2 65 2 80 10C95 18 98 38 94 50C98 62 95 82 80 90C65 98 35 98 20 90C5 82 2 62 6 50C2 38 5 18 20 10Z',
    sulcos: 'M28 34L50 50L72 34M50 50L50 80M28 66L50 50L72 66',
  },
});

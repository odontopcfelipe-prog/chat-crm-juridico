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
const RAIO_Y = 165;
/** As duas metades ficam separadas no meio, como no odontograma em papel. */
const CENTRO_Y_CIMA = 189;
const CENTRO_Y_BAIXO = 211;
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

/**
 * Contorno e sulcos de cada tipo, numa caixa de 100 × 100, com a face vestibular para cima. Estilo de
 * odontograma em traço: os sulcos são linhas curtas e curvas, como num desenho à mão.
 */
export const FORMA_DO_DENTE: Readonly<Record<TipoDeDente, { contorno: string; sulcos: string }>> = Object.freeze({
  incisivo: {
    contorno: 'M14 16C30 6 70 6 86 16C95 22 94 40 86 58C78 76 64 92 50 92C36 92 22 76 14 58C6 40 5 22 14 16Z',
    sulcos: 'M30 24Q50 18 70 24M36 31Q42 50 46 66M64 31Q58 50 54 66',
  },
  canino: {
    contorno: 'M50 4C66 8 88 24 92 46C96 70 76 94 50 96C24 94 4 70 8 46C12 24 34 8 50 4Z',
    sulcos: 'M50 18Q48 40 50 60M50 60Q40 64 34 74M50 60Q60 64 66 74M30 36Q38 44 44 42M70 36Q62 44 56 42',
  },
  premolar: {
    contorno: 'M50 5C76 5 95 24 95 50C95 76 76 95 50 95C24 95 5 76 5 50C5 24 24 5 50 5Z',
    sulcos: 'M26 50Q38 42 50 50Q62 58 74 50M40 26Q44 37 42 44M60 26Q56 37 58 44M42 74Q44 63 42 56M58 74Q56 63 58 56',
  },
  molar: {
    contorno: 'M22 8C34 3 46 6 50 8C54 6 66 3 78 8C92 14 97 30 94 44C97 56 97 72 90 84C82 96 64 97 50 93C36 97 18 96 10 84C3 72 3 56 6 44C3 30 8 14 22 8Z',
    sulcos: 'M26 44Q36 52 46 46Q52 40 50 26M46 46Q54 58 66 54Q76 52 82 58M50 26Q62 20 74 28M46 46Q42 62 34 76M66 54Q64 68 70 80M28 26Q36 32 42 40',
  },
});

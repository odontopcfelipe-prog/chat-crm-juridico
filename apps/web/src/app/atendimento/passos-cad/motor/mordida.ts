/**
 * Passos CAD — conferência da mordida. O scanner grava as duas arcadas na posição da mordida, e o
 * desenho confia nisso: o antagonista é o teto da coroa. Aqui só se mede se elas se tocam, se estão
 * afastadas ou se uma entra na outra. A mordida não é mexida: ela é o registro do caso, e quem decide é
 * o técnico.
 */
import { Bvh, centroide, cross, dot, mul, norma, soma, sub, vert, type Malha, type V3 } from './geo';
import type { Preparo } from './margem';

export type SituacaoDaMordida = 'encaixada' | 'afastada' | 'invadindo' | 'mesma';

export interface Mordida {
  situacao: SituacaoDaMordida;
  /** Menor folga entre as arcadas, sem os pontos soltos (mm). Negativa quando uma entra na outra. */
  menor: number;
}

/** Pontos do antagonista medidos: dão as regiões de contato com folga, em menos de um segundo. */
const AMOSTRAS = 20000;
/** Só conta o que está até aqui da arcada: mais longe é base do modelo, gengiva ou palato. */
const ALCANCE = 10;
/** Pontos isolados (ruído do escaneamento) que a medida ignora antes de dizer a menor folga. */
const PONTOS_SOLTOS = 4;
/** Mais afastadas que isso, a coroa encosta no antagonista aberto e sai alta. */
export const FOLGA_MAXIMA = 0.5;
/** Registro de mordida costuma entrar um pouco; mais que isso, ele está errado. */
export const INVASAO_MAXIMA = 0.5;
/** Mesmo arquivo nas duas: os pontos caem em cima da outra superfície. */
const COINCIDE = 0.02;

/**
 * As normais da arcada apontam para fora? O sinal da distância depende disso, e o sentido dos
 * triângulos vem do programa que exportou. Escaneamento aberto embaixo: a soma das áreas aponta para a
 * oclusal, que é o lado do antagonista. Modelo fechado, com base: a soma some, e o volume diz.
 */
export function normaisParaFora(arco: Malha, paraOAntagonista: V3): boolean {
  const c = centroide(arco.pos);
  let s: V3 = [0, 0, 0];
  let area = 0;
  let volume = 0;
  for (let t = 0; t < arco.tri.length; t += 3) {
    const a = vert(arco, arco.tri[t]);
    const n = cross(sub(vert(arco, arco.tri[t + 1]), a), sub(vert(arco, arco.tri[t + 2]), a));
    s = soma(s, n);
    area += norma(n);
    volume += dot(sub(a, c), n);
  }
  if (norma(s) > 0.05 * area) return dot(s, paraOAntagonista) >= 0;
  return volume >= 0;
}

/** Arcadas sem nenhum ponto perto: a distância de verdade, por uma amostra menor. */
function menorDistancia(arcoB: Bvh, antagonista: Malha): number {
  const nv = antagonista.pos.length / 3;
  const passo = Math.max(1, Math.floor(nv / 2000));
  let menor = Infinity;
  for (let v = 0; v < nv; v += passo) {
    const r = arcoB.proximo(vert(antagonista, v), menor);
    if (r) menor = Math.min(menor, Math.abs(r.d));
  }
  return menor;
}

/** Mede a mordida pelos pontos do antagonista contra a superfície da arcada. */
export function medirMordida(arcoB: Bvh, antagonista: Malha): Mordida {
  const arco = arcoB.m;
  const sinal = normaisParaFora(arco, sub(centroide(antagonista.pos), centroide(arco.pos))) ? 1 : -1;
  const nv = antagonista.pos.length / 3;
  const passo = Math.max(1, Math.floor(nv / AMOSTRAS));
  const perto: number[] = [];
  let coincidem = 0;
  for (let v = 0; v < nv; v += passo) {
    const r = arcoB.proximo(vert(antagonista, v), ALCANCE);
    if (!r) continue;
    perto.push(sinal * r.d);
    if (Math.abs(r.d) < COINCIDE) coincidem++;
  }
  if (perto.length <= PONTOS_SOLTOS) return { situacao: 'afastada', menor: menorDistancia(arcoB, antagonista) };
  if (coincidem > perto.length / 2) return { situacao: 'mesma', menor: 0 };
  perto.sort((a, b) => a - b);
  const menor = perto[PONTOS_SOLTOS];
  if (menor > FOLGA_MAXIMA) return { situacao: 'afastada', menor };
  if (-menor > INVASAO_MAXIMA) return { situacao: 'invadindo', menor };
  return { situacao: 'encaixada', menor };
}

/** Acima disso, o antagonista não cobre o dente: a coroa sai sem contato com ele. */
export const ANTAGONISTA_SOBRE_O_DENTE = 5;
/** Alturas acima do topo do preparo onde se procura o antagonista (mm): a coroa vive aí. */
const ALTURAS_SOBRE_O_PREPARO = [0, 1.5, 3, 4.5, 6];

/**
 * Distância do antagonista até a coluna sobre o preparo (mm). Num posterior ele fica logo acima; num
 * anterior, atrás da borda, a poucos milímetros. Longe disso, o arquivo do antagonista não cobre o
 * dente, e o desenho seguiria como se ele não existisse.
 */
export function antagonistaSobreODente(antB: Bvh | null, prep: Preparo): number {
  if (!antB) return Infinity;
  let menor = Infinity;
  for (const h of ALTURAS_SOBRE_O_PREPARO) {
    const r = antB.proximo(soma(prep.topo, mul(prep.a, h)), menor);
    if (r) menor = Math.min(menor, Math.abs(r.d));
  }
  return menor;
}

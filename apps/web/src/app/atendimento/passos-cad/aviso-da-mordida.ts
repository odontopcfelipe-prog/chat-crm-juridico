/**
 * Passos CAD — o que a tela diz da mordida e do antagonista sobre o dente escolhido.
 */
import { ANTAGONISTA_SOBRE_O_DENTE, type Mordida } from './motor/mordida';
import { TEXTOS as T } from './textos';

/** Uma casa decimal, com vírgula. */
const mm = (x: number): string => `${String(Math.round(Math.abs(x) * 10) / 10).replace('.', ',')} mm`;

export function avisoDaMordida(m: Mordida): { texto: string; ok: boolean } {
  switch (m.situacao) {
    case 'encaixada':
      return { texto: T.mordidaEncaixada, ok: true };
    case 'afastada':
      return { texto: `${T.mordidaAfastada} ${mm(m.menor)} ${T.mordidaAfastadaFim}`, ok: false };
    case 'invadindo':
      return { texto: `${T.mordidaInvadindo} ${mm(m.menor)} ${T.mordidaInvadindoFim}`, ok: false };
    case 'mesma':
      return { texto: T.mordidaMesma, ok: false };
  }
}

/** null quando não há o que avisar: sem antagonista aberto, ou com ele sobre o dente. */
export function avisoDoAntagonistaNoDente(distancia: number | null): string | null {
  if (distancia === null || distancia <= ANTAGONISTA_SOBRE_O_DENTE) return null;
  const onde = Number.isFinite(distancia) ? ` (${T.antagonistaMaisPerto} ${mm(distancia)})` : '';
  return `${T.antagonistaNaoCobre}${onde}. ${T.antagonistaNaoCobreFim}`;
}

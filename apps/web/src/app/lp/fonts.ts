/**
 * Onda 17.32.90 — Fontes da landing escopadas (next/font).
 *
 * Bricolage Grotesque pra display (headings) e Plus Jakarta Sans pra
 * corpo. As variaveis CSS (--font-bricolage, --font-jakarta) so sao
 * aplicadas dentro de .odlp no layout.tsx desta rota, entao NAO trocam
 * a tipografia do app autenticado.
 */
import { Bricolage_Grotesque, Plus_Jakarta_Sans } from 'next/font/google';

export const bricolage = Bricolage_Grotesque({
  subsets: ['latin'],
  display: 'swap',
  variable: '--font-bricolage',
  weight: ['400', '500', '600', '700', '800'],
});

export const jakarta = Plus_Jakarta_Sans({
  subsets: ['latin'],
  display: 'swap',
  variable: '--font-jakarta',
  weight: ['300', '400', '500', '600', '700', '800'],
});

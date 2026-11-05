/**
 * Onda 17.32.90 — Fontes da landing escopadas (next/font).
 *
 * Bricolage Grotesque pra display (headings) e Plus Jakarta Sans pra
 * corpo. As variaveis CSS (--font-bricolage, --font-jakarta) so sao
 * aplicadas dentro de .odlp no layout.tsx desta rota, entao NAO trocam
 * a tipografia do app autenticado.
 *
 * Sem `weight`: as duas são variáveis e o arquivo cobre de 200 a 800. A lista de pesos
 * derrubava 1 em cada 5 builds no Turbopack do Next 16.1.6 ("next/font/google queries have
 * exactly one entry"), sempre nestas duas fontes. Trava em web-fontes-google.spec.ts.
 */
import { Bricolage_Grotesque, Plus_Jakarta_Sans } from 'next/font/google';

export const bricolage = Bricolage_Grotesque({
  subsets: ['latin'],
  display: 'swap',
  variable: '--font-bricolage',
});

export const jakarta = Plus_Jakarta_Sans({
  subsets: ['latin'],
  display: 'swap',
  variable: '--font-jakarta',
});

/**
 * Onda 17.32.90 — Layout da landing page (escopo isolado).
 *
 * Cuidados pra NAO afetar o resto do app:
 *  1. Importa fontes (next/font) e aplica via variavel CSS no wrapper
 *     com class .odlp — NAO no <html> raiz.
 *  2. Importa odonto-landing.css aqui — TODOS os seletores ja vem
 *     prefixados com .odlp, entao mesmo sendo "global", nada escapa.
 *  3. Nao mexe em <html>/<body> (esses ficam no RootLayout).
 *
 * Atenção: a pasta /lp ja tem [slug]/page.tsx (notFound). Este layout
 * tambem aplica nessa rota, mas como ela so chama notFound() nao tem
 * impacto pratico.
 */
import type { Metadata } from 'next';
import { bricolage, jakarta } from './fonts';
import './odonto-landing.css';

export const metadata: Metadata = {
  title: 'Odonto System — Sistema completo pra sua clínica odontológica',
  description:
    'Pacientes, agenda, WhatsApp, cobrança Asaas, contratos digitais e relatórios — tudo num lugar. Comece grátis com 14 dias de teste, sem cartão.',
  openGraph: {
    title: 'Odonto System',
    description:
      'Sistema completo pra clínica odontológica. WhatsApp + IA, cobrança Asaas, ClickSign e mais. 14 dias grátis.',
    type: 'website',
    locale: 'pt_BR',
    siteName: 'Odonto System',
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Odonto System',
    description: 'Sistema completo pra clínica odontológica. 14 dias grátis.',
  },
};

export default function LandingLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // Aplica as variaveis de fonte (--font-bricolage, --font-jakarta)
  // SO neste wrapper. O CSS .odlp { font-family: var(--font-jakarta) }
  // pega as variaveis aqui — nada vaza pro RootLayout.
  return <div className={`${bricolage.variable} ${jakarta.variable}`}>{children}</div>;
}

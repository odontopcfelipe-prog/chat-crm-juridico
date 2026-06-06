/**
 * Onda 17.32.98 — Home publica do SaaS Odonto System.
 *
 * Promovida da rota /lp pra / com paleta unificada com o login
 * (acento emerald + glow violet). Antes esta rota servia a landing
 * antiga do Instituto Odonto Passos / Andre Lustosa Advogados —
 * agora vira a porta de entrada do produto.
 *
 * Os arquivos da landing continuam em apps/web/src/app/lp/* e
 * a rota /lp ainda funciona como espelho (mesmo Server Component).
 * O HomeTemplate antigo segue arquivado em components/lp/templates/
 * caso precise recuperar a landing institucional no futuro.
 *
 * Isolamento de CSS: a regra .odlp escopa TODO o estilo da landing
 * (zero vazamento pro app autenticado). Garantido pela skill
 * odonto-landing-page e ja validado em /lp em producao.
 */
import type { Metadata } from 'next';
import Script from 'next/script';
import { OdontoLanding } from './lp/OdontoLanding';
import { bricolage, jakarta } from './lp/fonts';
import './lp/odonto-landing.css';

const baseUrl = process.env.NEXT_PUBLIC_APP_URL || '';

export const metadata: Metadata = {
  title: 'Odonto System — Sistema completo pra sua clínica odontológica',
  description:
    'Pacientes, agenda, WhatsApp, cobrança Asaas, contratos digitais e relatórios — tudo num lugar. Comece grátis com 14 dias de teste, sem cartão.',
  alternates: { canonical: `${baseUrl}/` },
  openGraph: {
    title: 'Odonto System',
    description:
      'Sistema completo pra clínica odontológica. WhatsApp + IA, cobrança Asaas, ClickSign. 14 dias grátis.',
    url: `${baseUrl}/`,
    type: 'website',
    locale: 'pt_BR',
    siteName: 'Odonto System',
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Odonto System',
    description: 'Sistema completo pra clínica odontológica. 14 dias grátis.',
  },
  robots: { index: true, follow: true },
};

const jsonLd = {
  '@context': 'https://schema.org',
  '@type': 'SoftwareApplication',
  name: 'Odonto System',
  applicationCategory: 'BusinessApplication',
  operatingSystem: 'Web',
  description:
    'Sistema de gestão odontológica multi-clínica com WhatsApp + IA, cobrança Asaas, contratos digitais ClickSign, agenda e prontuário.',
  url: baseUrl,
  offers: [
    { '@type': 'Offer', name: 'Starter',    price: '60',  priceCurrency: 'BRL' },
    { '@type': 'Offer', name: 'Pro',        price: '90',  priceCurrency: 'BRL' },
    { '@type': 'Offer', name: 'Enterprise', price: '150', priceCurrency: 'BRL' },
  ],
  aggregateRating: {
    '@type': 'AggregateRating',
    ratingValue: '4.9',
    ratingCount: '120',
  },
};

export default function Home() {
  return (
    <div className={`${bricolage.variable} ${jakarta.variable}`}>
      <Script
        id="odonto-saas-jsonld"
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
        strategy="afterInteractive"
      />
      <OdontoLanding />
    </div>
  );
}

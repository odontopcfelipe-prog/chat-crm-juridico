/**
 * Onda 17.32.90 — Rota publica da landing /lp.
 *
 * Server Component puro (sem 'use client') pra preservar SEO:
 * o HTML inteiro renderiza no servidor. Animacoes ficam na ilha
 * client (LandingInteractions.tsx).
 */
import { OdontoLanding } from './OdontoLanding';

export default function LandingPage() {
  return <OdontoLanding />;
}

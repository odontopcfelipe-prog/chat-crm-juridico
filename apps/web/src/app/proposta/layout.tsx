import type { Metadata } from 'next';
import { LAB_PROPOSTA_PUBLICA } from './lab-proposta-textos';

// A página é do laboratório: título e prévia do link não herdam o texto da clínica do
// layout raiz, e a página não entra em buscador.
export const metadata: Metadata = {
  title: LAB_PROPOSTA_PUBLICA.tituloDaAba,
  description: LAB_PROPOSTA_PUBLICA.descricaoDaAba,
  robots: { index: false, follow: false },
  openGraph: {
    title: LAB_PROPOSTA_PUBLICA.tituloDaAba,
    description: LAB_PROPOSTA_PUBLICA.descricaoDaAba,
  },
};

export default function PropostaLayout({ children }: { children: React.ReactNode }) {
  return children;
}

import type { Metadata } from 'next';
import { PaginaLegal } from '@/components/legal/PaginaLegal';
import { POLITICA_DE_PRIVACIDADE } from '@/components/legal/politica-de-privacidade';

export const metadata: Metadata = {
  title: 'Política de privacidade | Odonto System',
  description: 'Como a plataforma Odonto System trata dados pessoais, de acordo com a LGPD.',
};

export default function PrivacidadePage() {
  return <PaginaLegal documento={POLITICA_DE_PRIVACIDADE} atual="privacidade" />;
}

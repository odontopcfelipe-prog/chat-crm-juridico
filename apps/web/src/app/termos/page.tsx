import type { Metadata } from 'next';
import { PaginaLegal } from '@/components/legal/PaginaLegal';
import { TERMOS_DE_USO } from '@/components/legal/termos-de-uso';

export const metadata: Metadata = {
  title: 'Termos de uso | Odonto System',
  description: 'Termos de uso da plataforma Odonto System para clínicas odontológicas e laboratórios de prótese.',
};

export default function TermosPage() {
  return <PaginaLegal documento={TERMOS_DE_USO} atual="termos" />;
}

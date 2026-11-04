'use client';

/**
 * Admin SaaS → conta → usuário: a tela da pessoa ao vivo.
 * O Visor só existe no navegador: a biblioteca que remonta a tela não roda no servidor.
 */
import dynamic from 'next/dynamic';
import { useParams } from 'next/navigation';
import { Loader2 } from 'lucide-react';

const Visor = dynamic(() => import('./Visor'), {
  ssr: false,
  loading: () => (
    <div className="p-12 flex items-center justify-center text-muted-foreground">
      <Loader2 size={18} className="animate-spin mr-2" />
      Carregando...
    </div>
  ),
});

export default function TelaDoUsuarioPage() {
  const params = useParams<{ id: string; userId: string }>();
  return <Visor contaId={params.id} usuarioId={params.userId} />;
}

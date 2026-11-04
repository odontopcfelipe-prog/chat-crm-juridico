'use client';

/**
 * Foto do item da Venda Rápida. A rota exige login, então a imagem vem como blob
 * (useAuthedImage). Sem foto, ou enquanto carrega, mostra o que vier em `children`.
 */
import { API_BASE_URL } from '@/lib/api';
import { useAuthedImage } from '@/lib/use-authed-image';

export default function FotoProduto({
  id,
  temFoto,
  versao,
  children,
}: {
  id: string;
  temFoto: boolean;
  /** updated_at do item: trocar a foto muda a URL e fura o cache. */
  versao?: string;
  children?: React.ReactNode;
}) {
  const url = temFoto ? `${API_BASE_URL}/procedures/${id}/photo?v=${encodeURIComponent(versao ?? '')}` : null;
  const { src } = useAuthedImage(url);
  if (!src) return <>{children}</>;
  // eslint-disable-next-line @next/next/no-img-element -- blob local, sem otimização do next/image
  return <img src={src} alt="" className="absolute inset-0 h-full w-full object-cover" />;
}

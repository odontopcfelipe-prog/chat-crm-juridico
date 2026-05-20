'use client';

/**
 * Carrega imagem protegida por JWT e retorna blob URL pra tag <img>.
 *
 * Por que: tags <img src=...> NÃO enviam header Authorization. Endpoints
 * protegidos (todos os /avatar do app) retornam 401 e o navegador mostra
 * o alt text no lugar da imagem.
 *
 * Solução: fetch via axios (interceptor injeta Bearer token) → blob →
 * URL.createObjectURL → usável em <img>. Cleanup automático ao desmontar
 * ou trocar URL — sem memory leak.
 */
import { useEffect, useRef, useState } from 'react';
import api from './api';

export interface AuthedImage {
  src: string | null;
  loading: boolean;
  error: boolean;
}

export function useAuthedImage(url: string | null): AuthedImage {
  const [src, setSrc] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const lastBlobRef = useRef<string | null>(null);

  useEffect(() => {
    if (!url) {
      // Limpa blob anterior se URL ficou null
      if (lastBlobRef.current) {
        URL.revokeObjectURL(lastBlobRef.current);
        lastBlobRef.current = null;
      }
      setSrc(null);
      setLoading(false);
      setError(false);
      return;
    }

    let cancelled = false;
    setLoading(true);
    setError(false);

    api
      .get(url, { responseType: 'blob' })
      .then((res) => {
        if (cancelled) return;
        const objUrl = URL.createObjectURL(res.data as Blob);
        // Revoga blob antigo ANTES de setar o novo
        if (lastBlobRef.current) URL.revokeObjectURL(lastBlobRef.current);
        lastBlobRef.current = objUrl;
        setSrc(objUrl);
      })
      .catch(() => {
        if (cancelled) return;
        setError(true);
        setSrc(null);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [url]);

  // Cleanup do último blob ao desmontar (efeito separado pra rodar só no unmount)
  useEffect(() => {
    return () => {
      if (lastBlobRef.current) {
        URL.revokeObjectURL(lastBlobRef.current);
        lastBlobRef.current = null;
      }
    };
  }, []);

  return { src, loading, error };
}

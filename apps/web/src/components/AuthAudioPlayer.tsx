'use client';

import { useEffect, useRef, useState } from 'react';
import { Loader2 } from 'lucide-react';
import api from '@/lib/api';

interface Props {
  audioId: string;
  className?: string;
  style?: React.CSSProperties;
}

/**
 * Reproduz um áudio do endpoint /transfer-audios/:id/stream
 * usando axios autenticado (Bearer token) para contornar a restrição
 * do elemento <audio> nativo que não envia headers de autorização.
 */
export function AuthAudioPlayer({ audioId, className, style }: Props) {
  const [srcUrl, setSrcUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const urlRef = useRef<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(false);
    setSrcUrl(null);

    api
      .get(`/transfer-audios/${audioId}/stream`, { responseType: 'blob' })
      .then((res) => {
        if (cancelled) return;
        const blobUrl = URL.createObjectURL(res.data as Blob);
        urlRef.current = blobUrl;
        setSrcUrl(blobUrl);
        setLoading(false);
      })
      .catch(() => {
        if (!cancelled) {
          setError(true);
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
      if (urlRef.current) {
        URL.revokeObjectURL(urlRef.current);
        urlRef.current = null;
      }
    };
  }, [audioId]);

  if (loading) {
    return (
      <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground py-1">
        <Loader2 size={11} className="animate-spin shrink-0" />
        Carregando áudio...
      </div>
    );
  }

  if (error) {
    return (
      <span className="text-[10px] text-destructive">Falha ao carregar áudio</span>
    );
  }

  return (
    <audio
      controls
      src={srcUrl ?? undefined}
      className={className}
      style={style}
    />
  );
}

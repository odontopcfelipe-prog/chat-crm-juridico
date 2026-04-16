'use client';

import { useEffect, useState } from 'react';
import api from '@/lib/api';

interface PreviewData {
  url: string;
  title: string | null;
  description: string | null;
  image: string | null;
  domain: string;
}

interface LinkPreviewProps {
  url: string;
  isOut?: boolean;
}

// In-memory cache to avoid repeated API calls when scrolling through messages
const previewCache = new Map<string, PreviewData | null>();

export function LinkPreview({ url, isOut = false }: LinkPreviewProps) {
  const [preview, setPreview] = useState<PreviewData | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    // Check cache first
    if (previewCache.has(url)) {
      setPreview(previewCache.get(url)!);
      setLoading(false);
      return;
    }

    let cancelled = false;
    api
      .get('/messages/link-preview', { params: { url } })
      .then((res) => {
        previewCache.set(url, res.data);
        if (!cancelled) setPreview(res.data);
      })
      .catch(() => {
        previewCache.set(url, null);
        if (!cancelled) setPreview(null);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [url]);

  if (loading) {
    return (
      <a
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        className="text-xs underline opacity-70 break-all block mt-1"
      >
        {url}
      </a>
    );
  }

  if (!preview || (!preview.title && !preview.description && !preview.image)) {
    return (
      <a
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        className="text-xs underline opacity-70 break-all block mt-1"
      >
        {url}
      </a>
    );
  }

  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      className={`block mt-2 rounded-xl overflow-hidden border no-underline transition-opacity hover:opacity-90 ${
        isOut
          ? 'border-white/20 bg-white/10'
          : 'border-border bg-muted/50'
      }`}
    >
      {preview.image && (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={preview.image}
          alt=""
          className="w-full max-h-40 object-cover"
          onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }}
        />
      )}
      <div className="px-3 py-2 space-y-0.5">
        <p className="text-[10px] font-medium opacity-60 uppercase tracking-wide">{preview.domain}</p>
        {preview.title && (
          <p className="text-[13px] font-semibold leading-tight line-clamp-2">{preview.title}</p>
        )}
        {preview.description && (
          <p className="text-[11px] opacity-70 leading-snug line-clamp-2">{preview.description}</p>
        )}
      </div>
    </a>
  );
}

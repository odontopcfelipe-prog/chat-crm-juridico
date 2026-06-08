'use client';

/**
 * Onda 17.32.126 — Hook que carrega os chips reais do bloco em
 * destaque da home por setor.
 *
 * Cache 60s em memoria + refresh em visibilitychange. Se a API falha,
 * o componente cai pro mock da config (fallback transparente).
 */
import { useEffect, useState, useCallback } from 'react';
import api from './api';
import type { Sector } from '@crm/shared';

export interface HomeChip {
  value: string | number;
  label: string;
  tone?: 'violet' | 'emerald' | 'amber' | 'sky' | 'rose';
}

export interface HomeHighlightsData {
  chips: HomeChip[];
  cta?: { label: string; href: string };
}

interface CachedEntry {
  data: HomeHighlightsData;
  fetchedAt: number;
}

const CACHE_TTL_MS = 60_000; // 60s
const cache = new Map<Sector, CachedEntry>();

export interface UseHomeHighlightsResult {
  data: HomeHighlightsData | null;
  loading: boolean;
  error: boolean;
  refresh: () => void;
}

export function useHomeHighlights(sector: Sector): UseHomeHighlightsResult {
  const [data, setData] = useState<HomeHighlightsData | null>(() => {
    const cached = cache.get(sector);
    return cached?.data ?? null;
  });
  const [loading, setLoading] = useState<boolean>(() => !cache.has(sector));
  const [error, setError] = useState<boolean>(false);

  const fetchData = useCallback(async (force = false) => {
    const cached = cache.get(sector);
    if (!force && cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
      setData(cached.data);
      setLoading(false);
      return;
    }
    setLoading(!data);
    setError(false);
    try {
      const res = await api.get<HomeHighlightsData>('/home/highlights', {
        params: { sector },
      });
      const payload = res.data ?? { chips: [] };
      cache.set(sector, { data: payload, fetchedAt: Date.now() });
      setData(payload);
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }, [sector, data]);

  // Carga inicial / quando setor muda
  useEffect(() => {
    fetchData();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sector]);

  // Refresh em volta da aba (user voltou de outra tela)
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === 'visible') fetchData(true);
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sector]);

  return { data, loading, error, refresh: () => fetchData(true) };
}

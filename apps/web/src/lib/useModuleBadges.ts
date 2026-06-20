'use client';

/**
 * Onda 17.58 — Hook dos badges de contagem ao vivo dos cards "MÓDULOS" da home.
 *
 * Espelha o useHomeHighlights: cache 60s em memória + refresh em visibilitychange.
 * Falha de rede → cards renderizam sem badge (sem crash).
 */
import { useEffect, useState, useCallback } from 'react';
import api from './api';
import type { Sector } from '@crm/shared';

export interface ModuleBadge {
  value: string;
  tone?: 'violet' | 'emerald' | 'amber' | 'sky' | 'rose';
}

export interface ModuleBadgesData {
  badges: Record<string, ModuleBadge>;
}

interface CachedEntry {
  data: ModuleBadgesData;
  fetchedAt: number;
}

const CACHE_TTL_MS = 60_000; // 60s
const cache = new Map<Sector, CachedEntry>();

export interface UseModuleBadgesResult {
  data: ModuleBadgesData | null;
  loading: boolean;
  error: boolean;
  refresh: () => void;
}

export function useModuleBadges(sector: Sector): UseModuleBadgesResult {
  const [data, setData] = useState<ModuleBadgesData | null>(() => {
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
      const res = await api.get<ModuleBadgesData>('/home/module-badges', {
        params: { sector },
      });
      const payload = res.data ?? { badges: {} };
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

  // Refresh ao voltar pra aba
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

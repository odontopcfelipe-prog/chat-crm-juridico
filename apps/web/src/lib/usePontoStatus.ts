'use client';

/**
 * Relógio de ponto — o usuário logado está na equipe do ponto? Decide se o balão
 * "Meu ponto", o item do menu e o "Mais" do celular aparecem. Só UX: quem não está
 * na equipe é barrado no backend (POST /ponto/punch).
 *
 * Cache em módulo amarrado ao token (troca de conta refaz a consulta).
 */
import { useEffect, useState } from 'react';
import api from './api';

export interface PontoStatus {
  member: boolean;
  active: boolean;
}

let cached: PontoStatus | null = null;
let cachedToken: string | null = null;
let inflight: Promise<PontoStatus | null> | null = null;

const currentToken = () => {
  try {
    return typeof window === 'undefined' ? null : localStorage.getItem('token');
  } catch {
    return null;
  }
};

async function fetchStatus(): Promise<PontoStatus | null> {
  const token = currentToken();
  if (!token) return null;
  if (cached && cachedToken === token) return cached;
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- flag do interceptor (lib/api.ts)
      const { data } = await api.get<PontoStatus>('/ponto/status', { _silent401: true } as any);
      cached = { member: !!data?.member, active: !!data?.active };
      cachedToken = token;
      return cached;
    } catch {
      return null;
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

/** Chamar depois de mudar a equipe do ponto (o próprio adm pode ter entrado/saído). */
export function resetPontoStatusCache() {
  cached = null;
  cachedToken = null;
}

/** `tokenKey` (layout): refaz a consulta quando a conta muda (o layout não remonta no login). */
export function usePontoStatus(tokenKey?: string | null): PontoStatus & { ready: boolean } {
  const [state, setState] = useState<PontoStatus | null>(() =>
    cached && cachedToken === currentToken() ? cached : null,
  );
  useEffect(() => {
    if (tokenKey === null) return; // deslogado: o retorno abaixo já diz "não é da equipe"
    let alive = true;
    void fetchStatus().then((s) => {
      if (alive && s) setState(s);
    });
    return () => {
      alive = false;
    };
  }, [tokenKey]);
  const s = tokenKey === null ? null : state;
  return { member: !!s?.member, active: !!s?.active, ready: !!s };
}

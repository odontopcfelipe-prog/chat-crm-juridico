'use client';

/**
 * Onda 17.32.120 — Hook que resolve as permissoes efetivas do user
 * logado, combinando setor (do banco) + extra_grants + extra_revokes.
 *
 * Cacheia /users/me em memoria por instancia (igual useTenant). Se a
 * resposta ainda nao chegou, faz fallback otimista: deriva setor das
 * roles do JWT via mapBackendRole.
 *
 * Out/2026 — o cache e AMARRADO ao token: trocar de conta (logout → login)
 * no mesmo SPA refaz o /users/me em vez de reaproveitar as permissoes da
 * conta anterior. O layout passa `tokenKey` (token reativo) pra reavaliar no
 * login → dashboard, ja que o layout persiste e o hook nao remonta.
 *
 * IMPORTANTE: este hook eh APENAS pra UX (esconder atalhos / abas
 * que o user nao acessa). Autorizacao DE VERDADE precisa estar nos
 * endpoints do backend.
 */
import { useEffect, useState } from 'react';
import api from './api';
import { useRole } from './useRole';
import {
  mapBackendRole,
  resolvePermissions,
  type Permission,
  type Sector,
} from '@crm/shared';

interface MeFromApi {
  id: string;
  name: string;
  email: string;
  roles: string[];
  sector: string | null;
  extra_grants:  string[] | null;
  extra_revokes: string[] | null;
}

interface CachedState {
  sector: Sector;
  grants:  Permission[];
  revokes: Permission[];
  ready: boolean;
}

let cached: MeFromApi | null = null;
let cachedToken: string | null = null;
let inflight: Promise<MeFromApi | null> | null = null;
let inflightToken: string | null = null;

function currentToken(): string | null {
  try {
    return typeof window === 'undefined' ? null : localStorage.getItem('token');
  } catch {
    return null;
  }
}

/** Roles do payload do JWT (sem validar assinatura — so pro fallback de UX). */
function rolesFromJwt(token: string | null | undefined): string[] {
  if (!token) return [];
  try {
    const b64 = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    const payload = JSON.parse(atob(b64));
    const raw: unknown = Array.isArray(payload?.roles) ? payload.roles : (payload?.role ? [payload.role] : []);
    return (raw as string[]).map((r) => String(r).toUpperCase());
  } catch {
    return [];
  }
}

function isFresh(): boolean {
  return !!cached && cachedToken === currentToken();
}

async function fetchMe(): Promise<MeFromApi | null> {
  const token = currentToken();
  if (!token) return null;
  if (cached && cachedToken === token) return cached;
  if (inflight && inflightToken === token) return inflight;
  inflightToken = token;
  inflight = (async () => {
    try {
      const { data } = await api.get<MeFromApi>('/users/me');
      cached = data ?? null;
      cachedToken = token;
      return cached;
    } catch {
      return null;
    } finally {
      inflight = null;
      inflightToken = null;
    }
  })();
  return inflight;
}

export function resetUserPermissionsCache() {
  cached = null;
  cachedToken = null;
  inflight = null;
  inflightToken = null;
}

export interface UserPermissions {
  sector: Sector;
  /** True quando /users/me carregou (false = usando fallback otimista) */
  ready: boolean;
  /** Verifica se o user tem a permissao (sector default + overrides) */
  hasPermission: (perm: Permission) => boolean;
}

export function useUserPermissions(opts?: { tokenKey?: string | null }): UserPermissions {
  const role = useRole();
  const tokenKey = opts?.tokenKey;
  // Com tokenKey (layout), o fallback vem do token ATUAL; sem, do useRole (montagem).
  const fallbackRoles = tokenKey !== undefined ? rolesFromJwt(tokenKey) : (role?.roles ?? []);
  const fallbackSector: Sector = mapBackendRole(fallbackRoles);
  const [state, setState] = useState<CachedState>(() => ({
    sector:  fallbackSector,
    grants:  [],
    revokes: [],
    ready:   isFresh(), // se ja tem cache DESTE token em memoria, ja considera pronto
  }));

  useEffect(() => {
    let cancelled = false;
    // Token mudou desde o cache (login/troca de conta): volta pro fallback do
    // token atual até o /users/me novo chegar — nunca usa permissão da conta anterior.
    if (!isFresh()) {
      setState({ sector: fallbackSector, grants: [], revokes: [], ready: false });
    }
    fetchMe().then((me) => {
      if (cancelled) return;
      if (!me) {
        setState((s) => ({ ...s, ready: true }));
        return;
      }
      const sec = (me.sector as Sector) || mapBackendRole(me.roles ?? []);
      setState({
        sector:  sec,
        grants:  (me.extra_grants  as Permission[]) ?? [],
        revokes: (me.extra_revokes as Permission[]) ?? [],
        ready:   true,
      });
    });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tokenKey]);

  const effective = resolvePermissions(state.sector, state.grants, state.revokes);

  return {
    sector: state.sector,
    ready:  state.ready,
    hasPermission: (perm: Permission) => effective.has(perm),
  };
}

'use client';

/**
 * Onda 17.32.120 — Hook que resolve as permissoes efetivas do user
 * logado, combinando setor (do banco) + extra_grants + extra_revokes.
 *
 * Cacheia /users/me em memoria por instancia (igual useTenant). Se a
 * resposta ainda nao chegou, faz fallback otimista: deriva setor das
 * roles do JWT via mapBackendRole.
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
let inflight: Promise<MeFromApi | null> | null = null;

async function fetchMe(): Promise<MeFromApi | null> {
  if (cached) return cached;
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const { data } = await api.get<MeFromApi>('/users/me');
      cached = data ?? null;
      return cached;
    } catch {
      return null;
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

export function resetUserPermissionsCache() {
  cached = null;
  inflight = null;
}

export interface UserPermissions {
  sector: Sector;
  /** True quando /users/me carregou (false = usando fallback otimista) */
  ready: boolean;
  /** Verifica se o user tem a permissao (sector default + overrides) */
  hasPermission: (perm: Permission) => boolean;
}

export function useUserPermissions(): UserPermissions {
  const role = useRole();
  const fallbackSector: Sector = mapBackendRole(role?.roles ?? []);
  const [state, setState] = useState<CachedState>(() => ({
    sector:  fallbackSector,
    grants:  [],
    revokes: [],
    ready:   !!cached, // se ja tem cache em memoria, ja considera pronto
  }));

  useEffect(() => {
    let cancelled = false;
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
  }, []);

  const effective = resolvePermissions(state.sector, state.grants, state.revokes);

  return {
    sector: state.sector,
    ready:  state.ready,
    hasPermission: (perm: Permission) => effective.has(perm),
  };
}

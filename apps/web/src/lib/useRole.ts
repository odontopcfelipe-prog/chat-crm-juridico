'use client';

import { useMemo } from 'react';

export type AppRole = 'ADMIN' | 'DENTIST' | 'OPERADOR' | 'COMERCIAL' | 'ASSISTANT' | 'FINANCEIRO';

export interface RoleInfo {
  role: AppRole | null;       // Primeiro role (backward compat)
  roles: AppRole[];           // Todos os roles do usuário
  userId: string | null;
  isAdmin: boolean;
  isDentist: boolean;
  isOperador: boolean;
  isComercial: boolean;
  isAssistant: boolean;
  isFinanceiro: boolean;
  /** @deprecated alias de `isDentist` durante a migração jurídico→odonto. */
  isAdvogado: boolean;
  /** @deprecated alias de `isAssistant` durante a migração jurídico→odonto. */
  isEstagiario: boolean;
  canManageSettings: boolean;    // configurações do sistema
  canViewDashboard: boolean;     // dashboard
  canViewAnalytics: boolean;     // analytics/marketing
  canViewFinanceiro: boolean;    // módulo financeiro
}

/**
 * Normaliza roles legados do domínio jurídico (ADVOGADO/ESTAGIARIO) para o novo
 * domínio odontológico (DENTIST/ASSISTANT). Permite que tokens emitidos antes da
 * migração SQL continuem funcionando — o backend faz a mesma normalização.
 */
function normalizeLegacyRole(raw: string): AppRole {
  const upper = (raw || '').toUpperCase().trim();
  if (upper === 'ADVOGADO' || upper === 'ADVOGADOS' || upper === 'DENTIST' || upper === 'DENTISTS') return 'DENTIST';
  if (upper === 'ESTAGIARIO' || upper === 'ESTAGIÁRIO' || upper === 'ESTAGIARIOS' || upper === 'ESTAGIÁRIOS' || upper === 'ASSISTANT' || upper === 'ASSISTANTS') return 'ASSISTANT';
  return upper as AppRole;
}

/** Lê os roles do JWT salvo no localStorage e retorna helpers de permissão. */
export function useRole(): RoleInfo {
  return useMemo(() => {
    if (typeof window === 'undefined') return buildInfo([], null);
    try {
      const token = localStorage.getItem('token');
      if (!token) {
        console.warn('[useRole] Sem token no localStorage — roles=[]');
        return buildInfo([], null);
      }
      // JWT base64url → base64 standard para atob()
      const b64 = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
      const payload = JSON.parse(atob(b64));
      // Backward compat: tokens antigos têm 'role' (string), novos têm 'roles' (array)
      const rawRoles: string[] = Array.isArray(payload?.roles)
        ? payload.roles
        : (payload?.role ? [payload.role] : []);
      if (rawRoles.length === 0) {
        console.warn('[useRole] Token decodificado mas sem roles:', payload);
      }
      // Normaliza legados (ADVOGADO → DENTIST, ESTAGIARIO → ASSISTANT) para
      // que o resto do app só veja os valores canônicos.
      const roles = rawRoles.map(normalizeLegacyRole);
      return buildInfo(roles, payload?.sub ?? null);
    } catch (e) {
      console.error('[useRole] ERRO ao decodificar token:', e);
      return buildInfo([], null);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}

function buildInfo(roles: AppRole[], userId: string | null): RoleInfo {
  const has = (allowed: AppRole[]) => roles.some(r => allowed.includes(r));
  const isDentist = roles.includes('DENTIST');
  const isAssistant = roles.includes('ASSISTANT');

  return {
    role: roles[0] || null,  // Backward compat: primeiro role
    roles,
    userId,
    isAdmin: roles.includes('ADMIN'),
    isDentist,
    isOperador: roles.includes('OPERADOR') || roles.includes('COMERCIAL'),
    isComercial: roles.includes('COMERCIAL'),
    isAssistant,
    isFinanceiro: roles.includes('FINANCEIRO'),
    // Aliases legados — remover após varredura completa do frontend na migração.
    isAdvogado: isDentist,
    isEstagiario: isAssistant,
    canManageSettings: roles.includes('ADMIN'),
    canViewDashboard: has(['ADMIN', 'DENTIST', 'OPERADOR', 'COMERCIAL']),
    canViewAnalytics: has(['ADMIN']),
    canViewFinanceiro: has(['ADMIN', 'FINANCEIRO', 'DENTIST']),
  };
}

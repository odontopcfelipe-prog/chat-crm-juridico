/**
 * Utilitário centralizado de permissões por roles (multi-role).
 * Use estas funções para checagens em services e controllers.
 * Para guards de rota, prefira o decorador @Roles().
 *
 * Todas as funções aceitam string[] (array de roles) ou string (backward compat).
 */

export const ROLES = {
  ADMIN: 'ADMIN',
  DENTIST: 'DENTIST',
  OPERADOR: 'OPERADOR',
  ASSISTANT: 'ASSISTANT',
  FINANCEIRO: 'FINANCEIRO',
} as const;

export type AppRole = (typeof ROLES)[keyof typeof ROLES];

/** Normaliza role(s) para array — aceita string ou string[] */
export function normalizeRoles(roles: string | string[] | null | undefined): string[] {
  if (Array.isArray(roles)) return roles;
  if (typeof roles === 'string' && roles) return [roles];
  return ['OPERADOR'];
}

/** Verifica se tem role ADMIN */
export function isAdmin(roles: string | string[]): boolean {
  return normalizeRoles(roles).includes(ROLES.ADMIN);
}

/** Verifica se pode gerenciar leads/clientes */
export function canManageLeads(roles: string | string[]): boolean {
  const r = normalizeRoles(roles);
  return r.some(role => ['ADMIN', 'DENTIST', 'OPERADOR'].includes(role));
}

/** Verifica se tem acesso ao modo cliente no chat */
export function canViewClients(roles: string | string[]): boolean {
  const r = normalizeRoles(roles);
  return r.some(role => ['ADMIN', 'DENTIST', 'OPERADOR'].includes(role));
}

/** Verifica se pode gerenciar configurações do sistema */
export function canManageSettings(roles: string | string[]): boolean {
  return normalizeRoles(roles).includes(ROLES.ADMIN);
}

/** Verifica se pode gerenciar usuários */
export function canManageUsers(roles: string | string[]): boolean {
  return normalizeRoles(roles).includes(ROLES.ADMIN);
}

/** Verifica se pode visualizar o módulo financeiro */
export function canViewFinanceiro(roles: string | string[]): boolean {
  const r = normalizeRoles(roles);
  return r.some(role => ['ADMIN', 'FINANCEIRO'].includes(role));
}

/**
 * Retorna o role de maior privilégio para decisões de visibilidade.
 * Ordem: ADMIN > DENTIST > OPERADOR > ASSISTANT > FINANCEIRO
 */
export function effectiveRole(roles: string | string[]): string {
  const r = normalizeRoles(roles);
  const priority = [ROLES.ADMIN, ROLES.DENTIST, ROLES.OPERADOR, ROLES.ASSISTANT, ROLES.FINANCEIRO];
  return priority.find(p => r.includes(p)) || r[0] || 'OPERADOR';
}

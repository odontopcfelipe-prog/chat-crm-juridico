/**
 * Acesso do dono do sistema (SUPER_ADMIN) às contas (clínicas e laboratórios)
 * sem ter usuário em cada uma: o login dele é reemitido com a conta escolhida
 * no tenant_id — o sistema inteiro já filtra por ele — e com a marca
 * `acesso_clinica` { modo, nome }.
 *
 * Modos:
 *   - 'ver'   → nada é salvo, enviado ou apagado na conta (ModoSoVerGuard);
 *   - 'mexer' → igual a um administrador da conta; o que ele fizer fica no nome dele.
 * A volta para a própria conta é o login de sempre (sem a marca). Entrada e
 * volta ficam no AuditLog (entity ACESSO_CLINICA). O acesso vale 12 h.
 */
export const MODOS_DE_ACESSO = ['ver', 'mexer'] as const;
export type ModoDeAcesso = (typeof MODOS_DE_ACESSO)[number];

export interface AcessoClinica {
  modo: ModoDeAcesso;
  /** Nome da conta, para a faixa "Vendo: <nome>" na tela. */
  nome: string;
}

export const VALIDADE_DO_ACESSO = '12h';
export const CODIGO_SO_VER = 'SO_VER';
export const ENTIDADE_DO_ACESSO = 'ACESSO_CLINICA';

export function eModoDeAcesso(v: unknown): v is ModoDeAcesso {
  return (MODOS_DE_ACESSO as readonly unknown[]).includes(v);
}

/** A marca do token, ou null (login normal ou marca malformada). */
export function lerAcessoClinica(v: unknown): AcessoClinica | null {
  if (!v || typeof v !== 'object') return null;
  const a = v as Record<string, unknown>;
  if (!eModoDeAcesso(a.modo)) return null;
  return { modo: a.modo, nome: typeof a.nome === 'string' ? a.nome : '' };
}

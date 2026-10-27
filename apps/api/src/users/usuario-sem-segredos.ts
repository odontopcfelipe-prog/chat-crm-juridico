/**
 * Campos do usuário que NUNCA saem do servidor: a senha criptografada e os
 * códigos de troca de senha e de confirmação de e-mail (e as datas de envio).
 */
export const CAMPOS_SECRETOS_DO_USUARIO = [
  'password_hash',
  'password_reset_token',
  'password_reset_sent_at',
  'email_verify_token',
  'email_verify_sent_at',
] as const;

/** Pagamento do profissional: só a tela de equipe do ADMIN usa (GET /users). */
export const CAMPOS_DE_PAGAMENTO_DO_USUARIO = [
  'commission_sale_type',
  'commission_sale_value',
  'commission_exec_type',
  'commission_exec_value',
  'daily_rate',
] as const;

function sem<T extends object>(user: T, campos: readonly string[]): T {
  const copia: Record<string, unknown> = { ...(user as Record<string, unknown>) };
  for (const campo of campos) delete copia[campo];
  return copia as T;
}

/** Cópia do usuário sem os campos secretos. */
export function semSegredos<T extends object>(user: T): T {
  return sem(user, CAMPOS_SECRETOS_DO_USUARIO);
}

/** Cópia do usuário sem os campos secretos e sem o pagamento do profissional. */
export function semSegredosNemPagamento<T extends object>(user: T): T {
  return sem(user, [...CAMPOS_SECRETOS_DO_USUARIO, ...CAMPOS_DE_PAGAMENTO_DO_USUARIO]);
}

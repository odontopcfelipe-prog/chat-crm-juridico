/**
 * Sessão da EQUIPE: o token do login e o mcp_token (auth.service.ts), sempre com
 * { email, sub, roles, tenant_id } — e-mail e papel do usuário, sem `kind`.
 * Token antigo pode ter `role` (texto) em vez de `roles`.
 *
 * Outros tokens assinados com o mesmo segredo têm `kind` e valem só no lugar
 * deles (o do portal do paciente, kind 'patient', vale só nas rotas do portal,
 * pelo PortalJwtGuard).
 *
 * Usado na API da equipe (JwtStrategy), no tempo real (socket.io, main.ts) e no
 * MCP. Função pura, sem dependência de módulo.
 */
export function eSessaoDaEquipe(payload: unknown): boolean {
  if (!payload || typeof payload !== 'object') return false;
  const p = payload as Record<string, unknown>;
  if (p.kind !== undefined || p.patient_id !== undefined) return false;
  const texto = (v: unknown) => typeof v === 'string' && v !== '';
  const temPapel = (Array.isArray(p.roles) && p.roles.length > 0) || texto(p.role);
  return texto(p.sub) && texto(p.email) && temPapel;
}

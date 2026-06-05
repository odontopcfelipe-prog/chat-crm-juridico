/**
 * Onda 17.32.77 — Decorator @SuperAdmin() pra rotas de gestao de tenants.
 *
 * Diferente de @Roles('ADMIN') (que protege rotas dentro de um tenant),
 * @SuperAdmin() exige role='SUPER_ADMIN' (cross-tenant — ve todos os
 * tenants do SaaS).
 *
 * Implementado via SuperAdminGuard que valida req.user.roles inclui
 * 'SUPER_ADMIN'. Aplica no controller ou em rota especifica.
 */
import { CanActivate, ExecutionContext, Injectable, ForbiddenException, SetMetadata, applyDecorators, UseGuards } from '@nestjs/common';

export const IS_SUPER_ADMIN_KEY = 'isSuperAdmin';

@Injectable()
export class SuperAdminGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest();
    const roles: string[] = req.user?.roles || [];
    if (!roles.includes('SUPER_ADMIN')) {
      throw new ForbiddenException('Acesso restrito a SUPER_ADMIN');
    }
    return true;
  }
}

export function SuperAdmin() {
  return applyDecorators(
    SetMetadata(IS_SUPER_ADMIN_KEY, true),
    UseGuards(SuperAdminGuard),
  );
}

/**
 * Onda 17.32.128 — Fase 6: autorizacao real no backend.
 *
 * Decorator + guard que checa se o usuario tem uma permissao especifica
 * (das 16 definidas em @crm/shared:PERMISSIONS).
 *
 * Logica: SUPER_ADMIN passa direto (cross-tenant). Pra demais, busca
 * sector + extra_grants + extra_revokes do banco e resolve via
 * `resolvePermissions()` do shared. Cache 30s em memoria por user_id
 * pra nao martelar prisma a cada request.
 *
 * Uso:
 *   @Get('dashboard')
 *   @RequiresPermission('view_financial')
 *   async dashboard() { ... }
 */
import {
  CanActivate, ExecutionContext, Injectable, ForbiddenException,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import {
  mapBackendRole, resolvePermissions,
  type Permission, type Sector,
} from '@crm/shared';
import { PrismaService } from '../../prisma/prisma.service.js';

export const REQUIRES_PERMISSION_KEY = 'requiresPermission';

interface CachedPerms {
  perms: Set<Permission>;
  fetchedAt: number;
}

@Injectable()
export class PermissionsGuard implements CanActivate {
  private readonly cache = new Map<string, CachedPerms>();
  private static readonly TTL_MS = 30_000;

  constructor(
    private readonly reflector: Reflector,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const required = this.reflector.getAllAndOverride<Permission>(
      REQUIRES_PERMISSION_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (!required) return true;

    const req = context.switchToHttp().getRequest();
    const user = req.user;
    if (!user?.id) throw new ForbiddenException('Nao autenticado');

    const roles: string[] = Array.isArray(user.roles) ? user.roles : [];
    // SUPER_ADMIN passa em tudo — cross-tenant
    if (roles.includes('SUPER_ADMIN')) return true;

    const perms = await this.resolveUserPermissions(user.id, roles);
    if (perms.has(required)) return true;

    throw new ForbiddenException(
      `Sem permissao "${required}" — fale com o admin do tenant`,
    );
  }

  private async resolveUserPermissions(
    userId: string,
    fallbackRoles: string[],
  ): Promise<Set<Permission>> {
    const cached = this.cache.get(userId);
    if (cached && Date.now() - cached.fetchedAt < PermissionsGuard.TTL_MS) {
      return cached.perms;
    }

    const u = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { sector: true, extra_grants: true, extra_revokes: true },
    });

    // Se sector ainda nao foi backfillado, mapeia das roles legadas
    const sector: Sector = (u?.sector as Sector) ?? mapBackendRole(fallbackRoles);
    const grants  = (u?.extra_grants  ?? []) as Permission[];
    const revokes = (u?.extra_revokes ?? []) as Permission[];
    const perms = resolvePermissions(sector, grants, revokes);

    this.cache.set(userId, { perms, fetchedAt: Date.now() });
    return perms;
  }

  /**
   * Invalida cache pra um user — chamar quando admin muda
   * sector/extra_grants/extra_revokes via PATCH /users/:id.
   */
  invalidate(userId: string) {
    this.cache.delete(userId);
  }
}

/**
 * Aplica nas rotas que exigem uma permissao especifica:
 *
 *   @RequiresPermission('view_financial')
 *
 * Funciona porque PermissionsGuard esta registrado como APP_GUARD
 * global em AppModule e checa essa metadata. Rotas sem essa metadata
 * passam direto.
 */
export const RequiresPermission = (perm: Permission) =>
  SetMetadata(REQUIRES_PERMISSION_KEY, perm);

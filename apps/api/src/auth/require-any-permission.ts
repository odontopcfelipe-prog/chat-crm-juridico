/**
 * Fase 0 — checagem de permissão DENTRO do handler/serviço (semântica OU).
 *
 * Por que não só `@RequiresPermission`: o guard libera SUPER_ADMIN sem checar e lê
 * `User.sector`, então um ADMIN com setor diferente seria barrado. Aqui ADMIN =
 * isAdminRole (ADMIN ou SUPER_ADMIN) e passa sempre; os demais usam o mesmo cache
 * e a mesma regra do guard (PermissionsGuard.permissionsFor).
 *
 * Funções puras (sem DI): quem chama passa o próprio prisma — não cria ciclo.
 */
import { ForbiddenException } from '@nestjs/common';
import type { Permission } from '@crm/shared';
import { PermissionsGuard } from './decorators/requires-permission.decorator';
import { isAdminRole } from './patient-scope';
import type { PrismaService } from '../prisma/prisma.service';

type UsuarioAuth = { id?: string; roles?: string[] } | null | undefined;

/** 403 que o admin pode liberar: o front mostra o toast global de "sem autorização". */
export function negarPermissao(message: string) {
  return new ForbiddenException({ message, code: 'PERMISSION_DENIED' });
}

/** O usuário tem QUALQUER uma das permissões? ADMIN/SUPER_ADMIN sempre tem. */
export async function temAlgumaPermissao(
  prisma: PrismaService,
  user: UsuarioAuth,
  perms: Permission[],
): Promise<boolean> {
  if (!user?.id) return false;
  if (isAdminRole(user.roles)) return true;
  const p = await PermissionsGuard.permissionsFor(prisma, user.id, user.roles ?? []);
  return perms.some((x) => p.has(x));
}

/** Lança 403 (PERMISSION_DENIED) se o usuário não tiver nenhuma das permissões. */
export async function assertAnyPermission(
  prisma: PrismaService,
  user: UsuarioAuth,
  perms: Permission[],
  mensagem?: string,
): Promise<void> {
  if (!user?.id) throw new ForbiddenException('Nao autenticado');
  if (await temAlgumaPermissao(prisma, user, perms)) return;
  throw negarPermissao(mensagem ?? `Sem permissão "${perms.join('" ou "')}" — fale com o admin da clínica`);
}

import { Injectable, CanActivate, ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ROLES_KEY } from '../decorators/roles.decorator';

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const requiredRoles = this.reflector.getAllAndOverride<string[]>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    
    if (!requiredRoles) {
      return true;
    }
    
    const { user } = context.switchToHttp().getRequest();
    // Multi-role: verifica se QUALQUER role do usuário está na lista requerida
    const userRoles: string[] = Array.isArray(user?.roles) ? user.roles : (user?.role ? [user.role] : []);
    const hasRole = requiredRoles.some((role) => userRoles.includes(role));
    if (!hasRole) {
      // Antes retornava `false`, e o Nest respondia 403 com "Forbidden resource"
      // (inglês cru). Lançamos com code:'PERMISSION_DENIED' pra o frontend
      // mostrar a mensagem amigável de falta de autorização.
      throw new ForbiddenException({
        message: `Sem o papel necessario (${requiredRoles.join(', ')}) para esta acao`,
        code: 'PERMISSION_DENIED',
      });
    }
    return true;
  }
}

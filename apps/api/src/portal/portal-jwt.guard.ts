import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';

/**
 * Guard JWT proprio do portal do paciente. Valida tokens com claim
 * `kind: 'patient'` e popula req.patient = { patient_id, tenant_id }.
 *
 * Diferente do JwtAuthGuard global (que valida tokens de User
 * funcionario), este guard so aceita tokens de paciente para evitar
 * que um JWT de funcionario acesse rotas do portal e vice-versa.
 */
@Injectable()
export class PortalJwtGuard implements CanActivate {
  constructor(private jwt: JwtService) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest();
    const auth = req.headers?.authorization || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
    if (!token) throw new UnauthorizedException('Token ausente');

    try {
      const payload = await this.jwt.verifyAsync(token);
      if (payload?.kind !== 'patient' || !payload.patient_id || !payload.tenant_id) {
        throw new UnauthorizedException('Token nao e do portal do paciente');
      }
      req.patient = {
        patient_id: payload.patient_id,
        tenant_id: payload.tenant_id,
      };
      return true;
    } catch {
      throw new UnauthorizedException('Token invalido ou expirado');
    }
  }
}

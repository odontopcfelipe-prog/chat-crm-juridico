import { ExtractJwt, Strategy } from 'passport-jwt';
import { PassportStrategy } from '@nestjs/passport';
import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { BT_LABORATORIO, isLab } from '@crm/shared';
import { eSessaoDaEquipe } from './sessao-da-equipe';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor() {
    const secret = process.env.JWT_SECRET;
    if (!secret && process.env.NODE_ENV === 'production') {
      new Logger('JwtStrategy').error('FATAL: JWT_SECRET não definido em produção!');
      process.exit(1);
    }
    if (!secret) {
      new Logger('JwtStrategy').warn('⚠️  JWT_SECRET não definido! Usando fallback INSEGURO.');
    }
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: secret || '__INSECURE_DEV_FALLBACK_CHANGE_ME__',
      // Onda 17.61 (segurança/JWT) — fixa HS256 (evita ataque de confusão de algoritmo).
      algorithms: ['HS256'],
    });
  }

  async validate(payload: any) {
    // Só sessão da equipe (login / mcp_token). Token de outro tipo assinado com o
    // mesmo segredo (ex.: o do portal do paciente) vale só no lugar dele.
    if (!eSessaoDaEquipe(payload)) throw new UnauthorizedException();
    // Backward compat: tokens antigos têm role (string), novos têm roles (array)
    const roles: string[] = Array.isArray(payload.roles)
      ? payload.roles
      : (payload.role ? [payload.role] : ['OPERADOR']);
    const user = { id: payload.sub, email: payload.email, roles, role: roles[0], tenant_id: payload.tenant_id };
    // F3 do laboratório — bt só no token de conta de laboratório; clínica sem chave nova.
    return isLab(payload.bt) ? { ...user, bt: BT_LABORATORIO } : user;
  }
}

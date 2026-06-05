import { Injectable, UnauthorizedException, ForbiddenException } from '@nestjs/common';
import { UsersService } from '../users/users.service';
import { JwtService } from '@nestjs/jwt';
import { PrismaService } from '../prisma/prisma.service';
import * as argon2 from 'argon2';

@Injectable()
export class AuthService {
  constructor(
    private usersService: UsersService,
    private jwtService: JwtService,
    // Onda 17.32.77 — Pra consultar status do tenant no gate de login
    private prisma: PrismaService,
  ) {}

  async validateUser(email: string, pass: string): Promise<any> {
    const user = await this.usersService.findOne(email);
    if (user && await argon2.verify(user.password_hash, pass)) {
      // Onda 17.32.77 — Gate SaaS: bloqueia login se tenant suspenso.
      // SUPER_ADMIN bypassa (precisa entrar pra reativar). Tenant sem id
      // (legacy) tambem bypassa pra nao quebrar sistema antigo.
      const roles: string[] = Array.isArray(user.roles) ? user.roles : [];
      if (!roles.includes('SUPER_ADMIN') && user.tenant_id) {
        const tenant = await this.prisma.tenant.findUnique({
          where: { id: user.tenant_id },
          select: { status: true, suspended_reason: true, trial_ends_at: true, name: true },
        });
        if (tenant?.status === 'SUSPENDED') {
          throw new ForbiddenException(
            `Acesso suspenso${tenant.suspended_reason ? `: ${tenant.suspended_reason}` : ''}. Entre em contato com o suporte.`,
          );
        }
        if (tenant?.status === 'DELETED') {
          throw new ForbiddenException('Conta encerrada. Entre em contato com o suporte.');
        }
        // TRIAL expirado vira SUSPENDED implicito
        if (tenant?.status === 'TRIAL' && tenant.trial_ends_at && tenant.trial_ends_at < new Date()) {
          throw new ForbiddenException(
            'Periodo de avaliacao expirado. Entre em contato pra contratar.',
          );
        }
      }
      const { password_hash, ...result } = user;
      return result;
    }
    return null;
  }

  async login(user: any) {
    // Multi-role: roles é array. Fallback se vazio ou ausente.
    const roles: string[] = (Array.isArray(user.roles) && user.roles.length > 0)
      ? user.roles
      : (user.role ? [user.role] : ['OPERADOR']);
    const payload = { email: user.email, sub: user.id, roles, tenant_id: user.tenant_id };
    return {
      access_token: this.jwtService.sign(payload),
      user: payload
    };
  }

  async generateMcpToken(user: any) {
    const roles: string[] = (Array.isArray(user.roles) && user.roles.length > 0)
      ? user.roles
      : (user.role ? [user.role] : ['OPERADOR']);
    const payload = { email: user.email, sub: user.id, roles, tenant_id: user.tenant_id };
    const mcp_token = this.jwtService.sign(payload, { expiresIn: '365d' });
    return { mcp_token };
  }
}

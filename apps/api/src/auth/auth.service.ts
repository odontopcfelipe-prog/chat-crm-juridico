import { Injectable, UnauthorizedException, ForbiddenException, BadRequestException, Logger } from '@nestjs/common';
import { UsersService } from '../users/users.service';
import { JwtService } from '@nestjs/jwt';
import { PrismaService } from '../prisma/prisma.service';
import { MailService, publicWebUrl } from '../common/mail/mail.service';
import * as argon2 from 'argon2';
import { randomBytes } from 'crypto';

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);
  constructor(
    private usersService: UsersService,
    private jwtService: JwtService,
    // Onda 17.32.77 — Pra consultar status do tenant no gate de login
    private prisma: PrismaService,
    private mail: MailService,
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

  // ─── Redefinicao de senha (Onda 17.32.179) ──────────────────────

  /**
   * Gera token de reset e envia o e-mail com o link.
   * SEMPRE responde ok — nao revela se o e-mail existe (anti-enumeracao).
   * Token expira em 1 hora.
   */
  async forgotPassword(email: string): Promise<{ ok: true }> {
    const normalized = (email || '').trim().toLowerCase();
    if (!normalized) return { ok: true };

    const user = await this.prisma.user.findUnique({
      where: { email: normalized },
      select: { id: true, name: true, email: true, tenant_id: true },
    });
    if (!user) {
      this.logger.warn(`[RESET-SENHA] Pedido pra e-mail desconhecido: ${normalized}`);
      return { ok: true };
    }

    const token = randomBytes(32).toString('hex');
    await this.prisma.user.update({
      where: { id: user.id },
      data: { password_reset_token: token, password_reset_sent_at: new Date() },
    });

    let clinicName = 'Odonto System';
    if (user.tenant_id) {
      const tenant = await this.prisma.tenant.findUnique({
        where: { id: user.tenant_id },
        select: { name: true },
      });
      if (tenant?.name) clinicName = tenant.name;
    }

    const link = `${publicWebUrl()}/redefinir-senha?token=${token}`;
    try {
      await this.mail.send({
        to: user.email,
        subject: `Redefinição de senha — ${clinicName}`,
        html: this.mail.renderTemplate({
          title: `Redefinir sua senha, ${user.name.split(' ')[0]}?`,
          bodyHtml: `Recebemos um pedido pra redefinir a senha do seu acesso ao sistema da <b style="color:#3f3f46;">${clinicName}</b>. O link vale por <b>1 hora</b>:`,
          ctaLabel: 'Criar nova senha',
          ctaUrl: link,
          footerNote: 'Se você não pediu a redefinição, ignore esta mensagem — sua senha continua a mesma.',
          brandName: clinicName,
        }),
      });
      this.logger.log(`[RESET-SENHA] E-mail de redefinicao enviado pra ${user.email}`);
    } catch (e: any) {
      // Nao vaza erro pro caller (anti-enumeracao) — so registra
      this.logger.error(`[RESET-SENHA] Falha ao enviar pra ${user.email}: code=${e?.code} ${e?.message}`);
    }
    return { ok: true };
  }

  /** Valida o token (1h) e define a nova senha. */
  async resetPassword(token: string, newPassword: string): Promise<{ ok: true }> {
    if (!token || token.length < 32) {
      throw new BadRequestException('Link inválido.');
    }
    if (!newPassword || newPassword.trim().length < 6) {
      throw new BadRequestException('A nova senha precisa ter pelo menos 6 caracteres.');
    }
    const user = await this.prisma.user.findFirst({
      where: { password_reset_token: token },
      select: { id: true, email: true, password_reset_sent_at: true, email_verified_at: true },
    });
    if (!user) {
      throw new BadRequestException('Link inválido ou já utilizado. Peça uma nova redefinição.');
    }
    const sentAt = user.password_reset_sent_at ? new Date(user.password_reset_sent_at).getTime() : 0;
    if (Date.now() - sentAt > 60 * 60 * 1000) {
      throw new BadRequestException('Link expirado (vale 1 hora). Peça uma nova redefinição.');
    }

    const password_hash = await argon2.hash(newPassword.trim());
    await this.prisma.user.update({
      where: { id: user.id },
      data: {
        password_hash,
        password_reset_token: null,
        password_reset_sent_at: null,
        // Redefinir pela caixa de e-mail prova a posse do endereco
        email_verified_at: user.email_verified_at ?? new Date(),
        email_verify_token: null,
      },
    });
    this.logger.log(`[RESET-SENHA] Senha redefinida pra ${user.email}`);
    return { ok: true };
  }
}

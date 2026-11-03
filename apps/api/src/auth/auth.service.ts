import { Injectable, UnauthorizedException, ForbiddenException, BadRequestException, NotFoundException, Logger } from '@nestjs/common';
import { UsersService } from '../users/users.service';
import { JwtService } from '@nestjs/jwt';
import { PrismaService } from '../prisma/prisma.service';
import { MailService, publicWebUrl } from '../common/mail/mail.service';
import * as argon2 from 'argon2';
import { randomBytes } from 'crypto';
import { BT_LABORATORIO, isLab } from '@crm/shared';
import type { OrigemDaRequisicao } from '../common/utils/origem-da-requisicao';
import { dadosDoAcesso } from './registro-de-acesso';
import { registrarAuditoria } from '../common/utils/audit-log.util';
import { ENTIDADE_DO_ACESSO, VALIDADE_DO_ACESSO, eModoDeAcesso, type AcessoClinica } from './acesso-clinica';

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
      let laboratorio = false;
      if (!roles.includes('SUPER_ADMIN') && user.tenant_id) {
        // F3 do laboratório — o tipo da conta vem nesta mesma leitura (sem
        // consulta a mais). Conta sem perfil = clínica.
        const tenant = await this.prisma.tenant.findUnique({
          where: { id: user.tenant_id },
          select: {
            status: true, suspended_reason: true, trial_ends_at: true, name: true,
            business_profile: { select: { business_type: true } },
          },
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
        laboratorio = isLab(tenant?.business_profile?.business_type);
      }
      const { password_hash, ...result } = user;
      // Clínica: o mesmo objeto de hoje, sem chave nova.
      return laboratorio ? { ...result, bt: BT_LABORATORIO } : result;
    }
    return null;
  }

  /**
   * Payload da sessão da equipe. Clínica: { email, sub, roles, tenant_id }, como
   * sempre (retrato __guards__/auth-payload). Conta de laboratório: + bt.
   */
  private payloadDaSessao(user: any) {
    // Multi-role: roles é array. Fallback se vazio ou ausente.
    const roles: string[] = (Array.isArray(user.roles) && user.roles.length > 0)
      ? user.roles
      : (user.role ? [user.role] : ['OPERADOR']);
    const payload = { email: user.email, sub: user.id, roles, tenant_id: user.tenant_id };
    return isLab(user.bt) ? { ...payload, bt: BT_LABORATORIO } : payload;
  }

  async login(user: any) {
    const payload = this.payloadDaSessao(user);
    return {
      access_token: this.jwtService.sign(payload),
      user: payload
    };
  }

  /** Registro de acesso (auth/registro-de-acesso.ts). Se falhar, o login segue. */
  async registrarAcesso(user: any, origem: OrigemDaRequisicao): Promise<void> {
    if (!user?.id) return;
    try {
      await this.prisma.accessLog.create({ data: dadosDoAcesso(user, origem) });
    } catch (e: any) {
      this.logger.warn(`[ACESSO] registro de acesso não gravado: ${e?.message}`);
    }
  }

  /**
   * Dono do sistema entra numa conta (clínica ou laboratório) sem usuário nela, ou
   * volta para a dele (tenantId vazio ou a própria). Ver auth/acesso-clinica.ts.
   * Papel conferido no BANCO (token antigo não basta); conta encerrada = 404.
   */
  async acessarClinica(userId: string, tenantId: string | null | undefined, modo: unknown, origem: OrigemDaRequisicao) {
    const dono = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, email: true, roles: true, tenant_id: true },
    });
    if (!dono || !(dono.roles ?? []).includes('SUPER_ADMIN')) {
      throw new ForbiddenException('Acesso restrito ao dono do sistema.');
    }
    const meta = { ip: origem.ip, navegador: origem.user_agent };

    if (!tenantId || tenantId === dono.tenant_id) {
      const sessao = await this.login({ ...dono, bt: await this.tipoDaConta(dono.tenant_id) });
      await registrarAuditoria(
        this.prisma,
        { tenantId: dono.tenant_id, actorUserId: dono.id, entity: ENTIDADE_DO_ACESSO, entityId: dono.tenant_id ?? '-', action: 'VOLTOU', meta },
        this.logger,
      );
      return sessao;
    }

    if (!eModoDeAcesso(modo)) throw new BadRequestException('Escolha "ver" ou "mexer".');
    const conta = await this.prisma.tenant.findUnique({ where: { id: tenantId }, select: { id: true, name: true, status: true } });
    if (!conta || conta.status === 'DELETED') throw new NotFoundException('Conta não encontrada.');

    const acesso_clinica: AcessoClinica = { modo, nome: conta.name };
    const payload = {
      ...this.payloadDaSessao({ ...dono, tenant_id: conta.id, bt: await this.tipoDaConta(conta.id) }),
      acesso_clinica,
    };
    const access_token = this.jwtService.sign(payload, { expiresIn: VALIDADE_DO_ACESSO });
    await registrarAuditoria(
      this.prisma,
      {
        tenantId: conta.id, actorUserId: dono.id, entity: ENTIDADE_DO_ACESSO, entityId: conta.id,
        action: modo === 'ver' ? 'ENTROU_SO_VER' : 'ENTROU_VER_E_MEXER', meta,
      },
      this.logger,
    );
    return { access_token, user: payload };
  }

  /** bt da conta: BT_LABORATORIO no laboratório; clínica (ou sem conta) = undefined. */
  private async tipoDaConta(tenantId: string | null | undefined): Promise<string | undefined> {
    if (!tenantId) return undefined;
    const perfil = await this.prisma.tenantBusinessProfile.findUnique({
      where: { tenant_id: tenantId },
      select: { business_type: true },
    });
    return isLab(perfil?.business_type) ? BT_LABORATORIO : undefined;
  }

  async generateMcpToken(user: any) {
    // Token de 1 ano só da própria conta, nunca de uma conta visitada.
    if (user?.acesso_clinica) throw new ForbiddenException('Gere o token do MCP na sua própria conta.');
    // user = req.user (JwtStrategy): o bt, quando existe, veio do token assinado no login.
    const payload = this.payloadDaSessao(user);
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
    // Onda 17.61 (segurança) — piso de 8 caracteres pra senha nova (antes 6).
    if (!newPassword || newPassword.trim().length < 8) {
      throw new BadRequestException('A nova senha precisa ter pelo menos 8 caracteres.');
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

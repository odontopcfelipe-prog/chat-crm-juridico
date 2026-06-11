import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { SettingsService } from '../../settings/settings.service';
import { createSmtpTransport } from '../utils/smtp.util';

/**
 * Onda 17.32.179 — Servico CENTRAL de e-mail do sistema.
 *
 * Todo envio de e-mail passa por aqui: confirmacao de equipe, reset
 * de senha, boas-vindas de tenant, lembretes — um unico lugar com
 * template padrao, logs e o transporte resiliente (smtp.util).
 *
 * Contrato de erro:
 *  - SMTP nao configurado -> send() retorna false (nao lanca)
 *  - Falha de transporte (DNS/porta/auth) -> LANCA o erro original,
 *    pra quem chamou mapear a mensagem certa pro usuario
 */

export interface MailContent {
  to: string;
  subject: string;
  html: string;
  /** Nome de exibicao do remetente (ex: nome da clinica) */
  fromName?: string;
  /** Respostas do destinatario vao pra este endereco (ex: e-mail da clinica) */
  replyTo?: string;
}

export interface TemplateOptions {
  /** Titulo grande do card */
  title: string;
  /** Paragrafo(s) do corpo — pode conter HTML simples (<b>, <br>) */
  bodyHtml: string;
  /** Botao de acao (opcional) */
  ctaLabel?: string;
  ctaUrl?: string;
  /** Nota pequena no pe do card (opcional) */
  footerNote?: string;
  /** Nome exibido no rodape — clinica ou "Odonto System" */
  brandName?: string;
}

export function publicWebUrl(): string {
  return (process.env.PUBLIC_WEB_URL || 'https://sistema.institutoodontopassos.com.br').replace(/\/+$/, '');
}

@Injectable()
export class MailService {
  private readonly logger = new Logger(MailService.name);

  constructor(
    private prisma: PrismaService,
    private settings: SettingsService,
  ) {}

  /** true se o SMTP global esta configurado */
  async isConfigured(): Promise<boolean> {
    const smtp = await this.settings.getSmtpConfig();
    return !!smtp.host;
  }

  /**
   * Envia um e-mail. Retorna false (sem lancar) quando SMTP nao esta
   * configurado; LANCA erros de transporte pro caller tratar.
   */
  async send({ to, subject, html, fromName, replyTo }: MailContent): Promise<boolean> {
    const smtp = await this.settings.getSmtpConfig();
    if (!smtp.host) {
      this.logger.warn(`[MAIL] SMTP nao configurado — "${subject}" pra ${to} ignorado`);
      return false;
    }
    const transporter = await createSmtpTransport(smtp);
    const fromAddress = smtp.from || smtp.user;
    await transporter.sendMail({
      // Com fromName, o destinatario ve "Nome da Clinica <email-da-plataforma>"
      from: fromName ? { name: fromName, address: fromAddress } : fromAddress,
      to,
      subject,
      html,
      ...(replyTo ? { replyTo } : {}),
    });
    this.logger.log(`[MAIL] Enviado "${subject}" pra ${to}`);
    return true;
  }

  /**
   * Template padrao do sistema: card branco, botao emerald, rodape.
   * Mesmo visual em todos os e-mails (confirmacao, reset, boas-vindas).
   */
  renderTemplate(opts: TemplateOptions): string {
    const brand = opts.brandName || 'Odonto System';
    const cta = opts.ctaLabel && opts.ctaUrl
      ? `
          <p style="text-align: center; margin: 0 0 18px;">
            <a href="${opts.ctaUrl}" style="display: inline-block; background: #059669; color: #fff; text-decoration: none; font-weight: 600; font-size: 14px; padding: 12px 24px; border-radius: 12px;">
              ${opts.ctaLabel}
            </a>
          </p>`
      : '';
    const footer = opts.footerNote
      ? `<p style="margin: 0; color: #a1a1aa; font-size: 12px;">${opts.footerNote}</p>`
      : '';
    return `
      <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 480px; margin: 0 auto; padding: 24px;">
        <div style="background: #ffffff; border: 1px solid #e4e4e7; border-radius: 16px; padding: 28px; color: #3f3f46;">
          <h2 style="margin: 0 0 6px; color: #18181b; font-size: 19px;">${opts.title}</h2>
          <p style="margin: 0 0 18px; color: #71717a; font-size: 14px; line-height: 1.55;">${opts.bodyHtml}</p>
          ${cta}
          ${footer}
        </div>
        <p style="text-align: center; color: #a1a1aa; font-size: 11px; margin-top: 14px;">
          Enviado automaticamente pelo Odonto System — ${brand}
        </p>
      </div>
    `;
  }

  /**
   * Envia o mesmo e-mail pra TODOS os ADMINs de um tenant.
   * Best-effort por destinatario (uma falha nao para os demais).
   * Retorna quantos receberam.
   */
  async sendToTenantAdmins(tenantId: string, content: Omit<MailContent, 'to'>): Promise<number> {
    const admins = await this.prisma.user.findMany({
      where: { tenant_id: tenantId, roles: { has: 'ADMIN' } },
      select: { email: true, name: true },
    });
    let sent = 0;
    for (const admin of admins) {
      try {
        if (await this.send({ to: admin.email, ...content })) sent++;
      } catch (e: any) {
        this.logger.warn(`[MAIL] Falha pra admin ${admin.email}: ${e?.message}`);
      }
    }
    return sent;
  }
}

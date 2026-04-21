import { Injectable, Logger, NotFoundException, BadRequestException, UnauthorizedException, GoneException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { randomBytes } from 'crypto';
import axios from 'axios';
import { PrismaService } from '../prisma/prisma.service';
import { SettingsService } from '../settings/settings.service';

@Injectable()
export class PortalAuthService {
  private readonly logger = new Logger(PortalAuthService.name);
  private readonly TOKEN_TTL_DAYS = 7;
  // JWT que paciente carrega depois de trocar o magic link
  private readonly SESSION_TTL = '30d';

  constructor(
    private prisma: PrismaService,
    private jwt: JwtService,
    private settings: SettingsService,
  ) {}

  /**
   * Recepcao chama com tenantId+patientId+(opcional) channel.
   * Gera token aleatorio, salva e — se canal=WHATSAPP e Evolution
   * configurada — dispara mensagem com o link automaticamente.
   *
   * Retorna token + url + status do envio (para feedback na UI).
   */
  async createMagicLink(
    tenantId: string,
    patientId: string,
    channel: string = 'WHATSAPP',
  ) {
    const patient = await this.prisma.patient.findFirst({
      where: { id: patientId, tenant_id: tenantId },
      select: { id: true, name: true, phone: true, email: true },
    });
    if (!patient) throw new NotFoundException('Paciente nao encontrado');

    const token = randomBytes(32).toString('base64url');
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + this.TOKEN_TTL_DAYS);

    const created = await this.prisma.portalToken.create({
      data: {
        tenant_id: tenantId,
        patient_id: patientId,
        token,
        expires_at: expiresAt,
        channel,
      },
    });

    // Monta URL completa do magic link
    const publicUrl =
      process.env.PORTAL_PUBLIC_URL ||
      process.env.PUBLIC_WEB_URL ||
      'https://sistema.institutoodontopassos.com.br';
    const link = `${publicUrl.replace(/\/+$/, '')}/area-paciente/login?token=${created.token}`;

    // Auto-dispatch via WhatsApp (best-effort)
    let dispatch: { status: 'SENT' | 'SKIPPED' | 'FAILED'; reason?: string } = {
      status: 'SKIPPED',
    };

    if (channel === 'WHATSAPP' && patient.phone) {
      dispatch = await this.dispatchWhatsApp(tenantId, patient.phone, patient.name, link);
    } else if (channel === 'WHATSAPP' && !patient.phone) {
      dispatch = { status: 'SKIPPED', reason: 'Paciente sem telefone' };
    }

    return {
      token: created.token,
      expires_at: created.expires_at,
      link,
      patient: {
        id: patient.id,
        name: patient.name,
        phone: patient.phone,
        email: patient.email,
      },
      dispatch,
    };
  }

  /**
   * Dispara mensagem WhatsApp via Evolution. Resolve instance do tenant
   * (primeira ativa). Best-effort: nunca derruba o fluxo de criacao do
   * token — falhas viram dispatch.status=FAILED.
   */
  private async dispatchWhatsApp(
    tenantId: string,
    phone: string,
    name: string,
    link: string,
  ): Promise<{ status: 'SENT' | 'FAILED'; reason?: string }> {
    try {
      const cfg = await this.settings.getWhatsAppConfig();
      if (!cfg.apiUrl || !cfg.apiKey) {
        return { status: 'FAILED', reason: 'Evolution API nao configurada' };
      }
      const instance = await this.prisma.instance.findFirst({
        where: { tenant_id: tenantId },
        select: { name: true },
        orderBy: { name: 'asc' },
      });
      if (!instance) {
        return { status: 'FAILED', reason: 'Sem Evolution instance no tenant' };
      }

      const firstName = name.split(' ')[0];
      const text =
        `Ola ${firstName}! 👋\n\n` +
        `Seu portal do paciente esta pronto. Acesse para ver:\n` +
        `📅 Agendamentos\n` +
        `💰 Parcelas\n` +
        `📋 Anamnese\n\n` +
        `${link}\n\n` +
        `Link valido por 7 dias e de uso unico.`;

      await axios.post(
        `${cfg.apiUrl}/message/sendText/${instance.name}`,
        { number: phone, text },
        {
          headers: { 'Content-Type': 'application/json', apikey: cfg.apiKey },
          timeout: 15000,
        },
      );
      this.logger.log(`[Portal] Magic link enviado para ${name} (${phone})`);
      return { status: 'SENT' };
    } catch (err: any) {
      const reason = err?.response?.data?.message || err?.message || 'erro';
      this.logger.warn(`[Portal] Falha ao enviar WhatsApp para ${phone}: ${reason}`);
      return { status: 'FAILED', reason };
    }
  }

  /**
   * Valida token (publico, sem auth) e troca por JWT do paciente.
   * Marca token como consumido — nao pode ser reusado.
   */
  async exchangeToken(token: string, ip?: string, userAgent?: string) {
    if (!token || token.length < 10) {
      throw new BadRequestException('Token invalido');
    }

    const row = await this.prisma.portalToken.findUnique({
      where: { token },
      include: {
        patient: { select: { id: true, name: true, tenant_id: true, status: true } },
      },
    });
    if (!row) throw new UnauthorizedException('Token nao encontrado');
    if (row.consumed_at) throw new GoneException('Token ja foi usado — solicite novo link');
    if (row.expires_at < new Date()) throw new GoneException('Token expirado — solicite novo link');
    if (row.patient.status === 'ARCHIVED') {
      throw new UnauthorizedException('Paciente arquivado');
    }

    // Marca consumido + grava metadata
    await this.prisma.portalToken.update({
      where: { id: row.id },
      data: {
        consumed_at: new Date(),
        ip_address: ip,
        user_agent: userAgent?.slice(0, 200),
      },
    });

    const jwt = await this.jwt.signAsync(
      {
        sub: row.patient.id,
        kind: 'patient',
        patient_id: row.patient.id,
        tenant_id: row.patient.tenant_id,
      },
      { expiresIn: this.SESSION_TTL },
    );

    return {
      jwt,
      patient: { id: row.patient.id, name: row.patient.name },
    };
  }
}

import { Injectable, Logger, NotFoundException, BadRequestException, UnauthorizedException, GoneException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { randomBytes } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class PortalAuthService {
  private readonly logger = new Logger(PortalAuthService.name);
  private readonly TOKEN_TTL_DAYS = 7;
  // JWT que paciente carrega depois de trocar o magic link
  private readonly SESSION_TTL = '30d';

  constructor(
    private prisma: PrismaService,
    private jwt: JwtService,
  ) {}

  /**
   * Recepcao chama com tenantId+patientId+(opcional) channel.
   * Gera token aleatorio, salva, retorna token + url do portal.
   *
   * O envio do WhatsApp e responsabilidade do worker/servico
   * separado — esta funcao apenas registra o token.
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

    return {
      token: created.token,
      expires_at: created.expires_at,
      patient: {
        id: patient.id,
        name: patient.name,
        phone: patient.phone,
        email: patient.email,
      },
    };
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

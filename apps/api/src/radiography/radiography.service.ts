import {
  Injectable, Logger, NotFoundException, BadRequestException, UnauthorizedException, ConflictException,
} from '@nestjs/common';
import { randomBytes } from 'crypto';
import * as argon2 from 'argon2';
import axios from 'axios';
import { PrismaService } from '../prisma/prisma.service';
import { S3Service } from '../s3/s3.service';
import { WebhookPayloadDto, CreateProviderDto, LinkPatientDto } from './dto/webhook.dto';

@Injectable()
export class RadiographyService {
  private readonly logger = new Logger(RadiographyService.name);

  constructor(
    private prisma: PrismaService,
    private s3: S3Service,
  ) {}

  // ─── Provider management ────────────────────────────────────────────

  async createProvider(tenantId: string, dto: CreateProviderDto) {
    if (!tenantId) throw new BadRequestException('tenant_id ausente');
    const apiKeyHash = await argon2.hash(dto.api_key);
    return this.prisma.radiographyProvider.create({
      data: {
        tenant_id: tenantId,
        name: dto.name,
        source_slug: dto.source_slug.toLowerCase(),
        api_key_hash: apiKeyHash,
        notes: dto.notes,
      },
    });
  }

  async listProviders(tenantId: string) {
    return this.prisma.radiographyProvider.findMany({
      where: { tenant_id: tenantId },
      orderBy: { name: 'asc' },
      select: {
        id: true, name: true, source_slug: true, active: true,
        webhook_count: true, last_received_at: true, notes: true,
        created_at: true,
        // api_key_hash NUNCA retornado
      },
    });
  }

  async toggleProvider(tenantId: string, id: string, active: boolean) {
    const provider = await this.prisma.radiographyProvider.findFirst({
      where: { id, tenant_id: tenantId },
    });
    if (!provider) throw new NotFoundException('Provider nao encontrado');
    return this.prisma.radiographyProvider.update({
      where: { id },
      data: { active },
    });
  }

  // ─── Webhook (publico, autenticado por header) ──────────────────────

  /**
   * Recebe payload de centro radiologico parceiro.
   * Auth via header X-Radiography-Provider-Key (validado contra
   * api_key_hash do provider identificado por tenant_slug).
   *
   * Idempotencia via UNIQUE (source, source_external_id) — se o mesmo
   * exame chegar 2x, retorna o existente.
   */
  async webhook(headerKey: string, payload: WebhookPayloadDto) {
    if (!headerKey) throw new UnauthorizedException('Header X-Radiography-Provider-Key obrigatorio');
    if (!payload.image_url && !payload.image_base64) {
      throw new BadRequestException('image_url ou image_base64 obrigatorio');
    }

    // Resolve tenant via slug (nome do tenant) — primeiro tenant com slug case-insensitive
    const tenant = await this.prisma.tenant.findFirst({
      where: { name: { equals: payload.tenant_slug, mode: 'insensitive' } },
      select: { id: true, name: true },
    });
    if (!tenant) throw new UnauthorizedException('tenant_slug invalido');

    // Resolve provider ativo neste tenant; valida hash contra a chave do header
    const providers = await this.prisma.radiographyProvider.findMany({
      where: { tenant_id: tenant.id, active: true },
    });

    let matchedProvider: typeof providers[number] | null = null;
    for (const p of providers) {
      try {
        if (await argon2.verify(p.api_key_hash, headerKey)) {
          matchedProvider = p;
          break;
        }
      } catch { /* ignore */ }
    }
    if (!matchedProvider) {
      this.logger.warn(`[Radiography] Webhook rejeitado tenant=${tenant.name}: chave nao bate com nenhum provider`);
      throw new UnauthorizedException('Chave de provider invalida');
    }

    // Idempotencia
    const existing = await this.prisma.radiographyExam.findUnique({
      where: {
        source_source_external_id: {
          source: matchedProvider.source_slug,
          source_external_id: payload.source_external_id,
        },
      },
    });
    if (existing) {
      this.logger.log(`[Radiography] Exame ja existente (idempotencia): ${existing.id}`);
      return existing;
    }

    // Baixa/decodifica imagem
    let buffer: Buffer;
    let mime = payload.image_mime || 'image/jpeg';
    try {
      if (payload.image_url) {
        const r = await axios.get(payload.image_url, { responseType: 'arraybuffer', timeout: 30000 });
        buffer = Buffer.from(r.data);
        mime = (r.headers['content-type'] as string) || mime;
      } else {
        const b64 = payload.image_base64!.replace(/^data:image\/\w+;base64,/, '');
        buffer = Buffer.from(b64, 'base64');
      }
    } catch (e: any) {
      throw new BadRequestException(`Falha ao baixar imagem: ${e.message}`);
    }

    const ext = mime.split('/')[1] || 'jpg';
    const s3Key = `radiography/${tenant.id}/${matchedProvider.source_slug}/${payload.source_external_id}-${randomBytes(4).toString('hex')}.${ext}`;
    await this.s3.uploadBuffer(s3Key, buffer, mime);

    // Auto-match com paciente via CPF
    let patientId: string | null = null;
    if (payload.patient_cpf) {
      const p = await this.prisma.patient.findFirst({
        where: { tenant_id: tenant.id, cpf: payload.patient_cpf.replace(/\D/g, '') },
        select: { id: true },
      });
      if (p) patientId = p.id;
    }

    const exam = await this.prisma.radiographyExam.create({
      data: {
        tenant_id: tenant.id,
        patient_id: patientId,
        provider_id: matchedProvider.id,
        source: matchedProvider.source_slug,
        source_external_id: payload.source_external_id,
        exam_type: payload.exam_type,
        tooth_fdi: payload.tooth_fdi,
        image_s3_key: s3Key,
        mime_type: mime,
        report_text: payload.report_text,
        report_html: payload.report_html,
        performed_at: payload.performed_at ? new Date(payload.performed_at) : undefined,
        external_patient_cpf: payload.patient_cpf,
        external_patient_name: payload.patient_name,
        status: patientId ? 'LINKED' : 'RECEIVED',
        linked_at: patientId ? new Date() : undefined,
      },
    });

    // Atualiza contadores no provider
    await this.prisma.radiographyProvider.update({
      where: { id: matchedProvider.id },
      data: { webhook_count: { increment: 1 }, last_received_at: new Date() },
    });

    this.logger.log(
      `[Radiography] Recebido ${exam.id} provider=${matchedProvider.source_slug} ` +
      `paciente=${patientId || 'NAO_VINCULADO'}`,
    );
    return exam;
  }

  // ─── Listing / leitura (autenticado pelo CRM) ───────────────────────

  async findByPatient(tenantId: string, patientId: string) {
    const patient = await this.prisma.patient.findFirst({
      where: { id: patientId, tenant_id: tenantId },
    });
    if (!patient) throw new NotFoundException('Paciente nao encontrado');

    return this.prisma.radiographyExam.findMany({
      where: { tenant_id: tenantId, patient_id: patientId },
      orderBy: [{ performed_at: 'desc' }, { received_at: 'desc' }],
      include: {
        provider: { select: { id: true, name: true, source_slug: true } },
      },
    });
  }

  /** Backlog: exames recebidos sem patient_id vinculado. */
  async backlog(tenantId: string) {
    return this.prisma.radiographyExam.findMany({
      where: { tenant_id: tenantId, status: 'RECEIVED', patient_id: null },
      orderBy: { received_at: 'desc' },
      take: 100,
      include: { provider: { select: { id: true, name: true } } },
    });
  }

  async findOne(tenantId: string, id: string) {
    const exam = await this.prisma.radiographyExam.findFirst({
      where: { id, tenant_id: tenantId },
      include: {
        provider: { select: { id: true, name: true } },
        patient: { select: { id: true, name: true } },
      },
    });
    if (!exam) throw new NotFoundException('Exame nao encontrado');
    return exam;
  }

  /** Vincula exame do backlog a um paciente. */
  async linkPatient(tenantId: string, examId: string, userId: string, dto: LinkPatientDto) {
    const exam = await this.findOne(tenantId, examId);
    if (exam.patient_id) throw new ConflictException('Exame ja vinculado a paciente');

    const patient = await this.prisma.patient.findFirst({
      where: { id: dto.patient_id, tenant_id: tenantId },
    });
    if (!patient) throw new NotFoundException('Paciente nao encontrado');

    return this.prisma.radiographyExam.update({
      where: { id: examId },
      data: {
        patient_id: dto.patient_id,
        status: 'LINKED',
        linked_at: new Date(),
        linked_by_user_id: userId,
      },
    });
  }

  async discard(tenantId: string, examId: string) {
    await this.findOne(tenantId, examId);
    return this.prisma.radiographyExam.update({
      where: { id: examId },
      data: { status: 'DISCARDED' },
    });
  }
}

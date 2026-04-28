import { Injectable, Logger, NotFoundException, ForbiddenException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { FileStorageService } from '../media/filesystem.service';
import { Prisma } from '@crm/shared';

@Injectable()
export class PatientsService {
  private readonly logger = new Logger(PatientsService.name);

  constructor(
    private prisma: PrismaService,
    private fileStorage: FileStorageService,
  ) {}

  /** Cria novo paciente. Valida CPF unico por tenant quando preenchido. */
  async create(tenantId: string, data: Omit<Prisma.PatientUncheckedCreateInput, 'tenant_id'>) {
    if (!tenantId) throw new BadRequestException('tenant_id ausente no contexto');

    if (data.cpf) {
      const existing = await this.prisma.patient.findUnique({
        where: { tenant_id_cpf: { tenant_id: tenantId, cpf: data.cpf } },
      });
      if (existing) throw new BadRequestException('Ja existe um paciente com este CPF neste tenant');
    }

    return this.prisma.patient.create({
      data: { ...data, tenant_id: tenantId },
    });
  }

  /** Lista pacientes com busca, filtro de status e paginacao. */
  async findAll(
    tenantId: string,
    opts: {
      search?: string;
      status?: string;
      dentistId?: string;
      page?: number;
      limit?: number;
    } = {},
  ) {
    const page = Math.max(1, opts.page || 1);
    const limit = Math.min(100, Math.max(1, opts.limit || 20));
    const skip = (page - 1) * limit;

    const where: Prisma.PatientWhereInput = {
      tenant_id: tenantId,
      ...(opts.status ? { status: opts.status } : {}),
      ...(opts.dentistId ? { primary_dentist_id: opts.dentistId } : {}),
      ...(opts.search
        ? {
            OR: [
              { name: { contains: opts.search, mode: 'insensitive' } },
              { phone: { contains: opts.search } },
              { cpf: { contains: opts.search } },
              { email: { contains: opts.search, mode: 'insensitive' } },
            ],
          }
        : {}),
    };

    const [data, total] = await Promise.all([
      this.prisma.patient.findMany({
        where,
        orderBy: { created_at: 'desc' },
        skip,
        take: limit,
        include: {
          primary_dentist: { select: { id: true, name: true, email: true } },
          _count: { select: { anamneses: true, treatment_plans: true, appointments: true } },
        },
      }),
      this.prisma.patient.count({ where }),
    ]);

    return { data, total, page, totalPages: Math.ceil(total / limit) };
  }

  /** Detalhe completo do paciente — inclui alergias, medicacoes, prontuario, odontograma. */
  async findOne(id: string, tenantId: string) {
    const patient = await this.prisma.patient.findUnique({
      where: { id },
      include: {
        primary_dentist: { select: { id: true, name: true, email: true } },
        lead: { select: { id: true, phone: true, stage: true } },
        // Indicador (paciente que indicou esse) — mostra nome no overview
        referred_by_patient: { select: { id: true, name: true, phone: true } },
        allergies: { orderBy: { created_at: 'desc' } },
        medications: { orderBy: { created_at: 'desc' } },
        medical_record: true,
        odontogram: { include: { teeth: true } },
        anamneses: {
          orderBy: { filled_at: 'desc' },
          take: 5,
          select: { id: true, filled_at: true, filled_by_user_id: true },
        },
        treatment_plans: {
          orderBy: { created_at: 'desc' },
          take: 5,
          select: { id: true, status: true, start_date: true, total_value: true, created_at: true },
        },
        _count: {
          select: {
            appointments: true,
            clinical_images: true,
            consents: true,
            quotes: true,
            referrals: true, // quantos pacientes esse aqui indicou
          },
        },
      },
    });

    if (!patient) throw new NotFoundException('Paciente nao encontrado');
    if (patient.tenant_id !== tenantId) throw new ForbiddenException('Acesso negado');

    return patient;
  }

  async update(id: string, tenantId: string, data: Prisma.PatientUncheckedUpdateInput) {
    await this.assertBelongsToTenant(id, tenantId);

    if (data.cpf && typeof data.cpf === 'string') {
      const conflict = await this.prisma.patient.findFirst({
        where: { tenant_id: tenantId, cpf: data.cpf, NOT: { id } },
        select: { id: true },
      });
      if (conflict) throw new BadRequestException('Outro paciente ja usa este CPF');
    }

    return this.prisma.patient.update({ where: { id }, data });
  }

  /** Soft delete — marca como ARCHIVED. Use para preservar historico clinico. */
  async archive(id: string, tenantId: string) {
    await this.assertBelongsToTenant(id, tenantId);
    return this.prisma.patient.update({ where: { id }, data: { status: 'ARCHIVED' } });
  }

  /** Converte um Lead em Patient. Se o paciente ja existe (lead_id ja vinculado), retorna o existente. */
  async convertFromLead(leadId: string, tenantId: string, extraData: Partial<Prisma.PatientUncheckedCreateInput> = {}) {
    const lead = await this.prisma.lead.findUnique({ where: { id: leadId } });
    if (!lead) throw new NotFoundException('Lead nao encontrado');
    if (lead.tenant_id !== tenantId) throw new ForbiddenException('Acesso negado a este lead');

    const existing = await this.prisma.patient.findUnique({ where: { lead_id: leadId } });
    if (existing) return existing;

    return this.prisma.patient.create({
      data: {
        tenant_id: tenantId,
        lead_id: leadId,
        name: lead.name || 'Paciente sem nome',
        phone: lead.phone,
        email: lead.email || null,
        referred_by: lead.origin || null,
        ...extraData,
      },
    });
  }

  /** Estatisticas rapidas (para dashboard). */
  async getStats(tenantId: string) {
    const [total, active, inactive, archived, withActivePlan] = await Promise.all([
      this.prisma.patient.count({ where: { tenant_id: tenantId } }),
      this.prisma.patient.count({ where: { tenant_id: tenantId, status: 'ACTIVE' } }),
      this.prisma.patient.count({ where: { tenant_id: tenantId, status: 'INACTIVE' } }),
      this.prisma.patient.count({ where: { tenant_id: tenantId, status: 'ARCHIVED' } }),
      this.prisma.patient.count({
        where: {
          tenant_id: tenantId,
          treatment_plans: { some: { status: 'ACTIVE' } },
        },
      }),
    ]);

    return { total, active, inactive, archived, with_active_plan: withActivePlan };
  }

  // ─── Allergies ────────────────────────────────────────────────

  async addAllergy(
    patientId: string,
    tenantId: string,
    data: { allergen: string; severity?: string; notes?: string },
  ) {
    await this.assertBelongsToTenant(patientId, tenantId);
    return this.prisma.patientAllergy.create({ data: { patient_id: patientId, ...data } });
  }

  async removeAllergy(id: string, tenantId: string) {
    const allergy = await this.prisma.patientAllergy.findUnique({
      where: { id },
      select: { id: true, patient: { select: { tenant_id: true } } },
    });
    if (!allergy) throw new NotFoundException('Alergia nao encontrada');
    if (allergy.patient.tenant_id !== tenantId) throw new ForbiddenException('Acesso negado');
    return this.prisma.patientAllergy.delete({ where: { id } });
  }

  // ─── Medications ──────────────────────────────────────────────

  async addMedication(
    patientId: string,
    tenantId: string,
    data: {
      medication: string;
      dosage?: string;
      frequency?: string;
      reason?: string;
      started_at?: Date;
      ended_at?: Date;
    },
  ) {
    await this.assertBelongsToTenant(patientId, tenantId);
    return this.prisma.patientMedication.create({ data: { patient_id: patientId, ...data } });
  }

  async removeMedication(id: string, tenantId: string) {
    const med = await this.prisma.patientMedication.findUnique({
      where: { id },
      select: { id: true, patient: { select: { tenant_id: true } } },
    });
    if (!med) throw new NotFoundException('Medicacao nao encontrada');
    if (med.patient.tenant_id !== tenantId) throw new ForbiddenException('Acesso negado');
    return this.prisma.patientMedication.delete({ where: { id } });
  }

  // ─── Avatar / Foto do paciente ────────────────────────────────

  private static readonly ALLOWED_AVATAR_MIMES: Record<string, string> = {
    'image/jpeg': 'jpg',
    'image/jpg': 'jpg',
    'image/png': 'png',
    'image/webp': 'webp',
  };

  /**
   * Salva imagem em filesystem e atualiza avatar_url do paciente.
   * Aceita JPEG/PNG/WebP. Limite 2 MB.
   */
  async updateAvatar(patientId: string, tenantId: string, buffer: Buffer, mimeType: string) {
    await this.assertBelongsToTenant(patientId, tenantId);

    const ext = PatientsService.ALLOWED_AVATAR_MIMES[mimeType?.toLowerCase()];
    if (!ext) throw new BadRequestException('Tipo de imagem nao suportado. Use JPEG, PNG ou WebP.');
    if (buffer.length > 2 * 1024 * 1024) {
      throw new BadRequestException('Imagem muito grande. Maximo 2 MB.');
    }

    // Limpa versoes anteriores em outras extensoes
    for (const oldExt of Object.values(PatientsService.ALLOWED_AVATAR_MIMES)) {
      if (oldExt !== ext) {
        await this.fileStorage.delete(`patients/${patientId}.${oldExt}`).catch(() => {});
      }
    }

    const relativePath = `patients/${patientId}.${ext}`;
    await this.fileStorage.write(relativePath, buffer);

    await this.prisma.patient.update({
      where: { id: patientId },
      data: { avatar_url: relativePath },
    });

    this.logger.log(`[AVATAR] Foto atualizada para paciente ${patientId}`);
    return { avatar_url: relativePath };
  }

  /** Retorna buffer + mimeType da foto pra servir via HTTP. */
  async getAvatarBuffer(patientId: string): Promise<{ buffer: Buffer; mimeType: string } | null> {
    const patient = await this.prisma.patient.findUnique({
      where: { id: patientId },
      select: { avatar_url: true },
    });
    if (!patient?.avatar_url) return null;

    const ext = patient.avatar_url.split('.').pop()?.toLowerCase() || 'jpg';
    const mimeMap: Record<string, string> = {
      jpg: 'image/jpeg',
      jpeg: 'image/jpeg',
      png: 'image/png',
      webp: 'image/webp',
    };
    const mimeType = mimeMap[ext] ?? 'image/jpeg';

    const buffer = await this.fileStorage.read(patient.avatar_url);
    if (!buffer) return null;
    return { buffer, mimeType };
  }

  /** Remove foto do paciente. */
  async removeAvatar(patientId: string, tenantId: string) {
    await this.assertBelongsToTenant(patientId, tenantId);
    const patient = await this.prisma.patient.findUnique({
      where: { id: patientId },
      select: { avatar_url: true },
    });
    if (patient?.avatar_url) {
      await this.fileStorage.delete(patient.avatar_url).catch(() => {});
    }
    await this.prisma.patient.update({
      where: { id: patientId },
      data: { avatar_url: null },
    });
    return { ok: true };
  }

  // ─── Helpers ──────────────────────────────────────────────────

  private async assertBelongsToTenant(patientId: string, tenantId: string) {
    const row = await this.prisma.patient.findUnique({
      where: { id: patientId },
      select: { tenant_id: true },
    });
    if (!row) throw new NotFoundException('Paciente nao encontrado');
    if (row.tenant_id !== tenantId) throw new ForbiddenException('Acesso negado');
  }
}

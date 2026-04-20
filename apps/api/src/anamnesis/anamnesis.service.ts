import { Injectable, NotFoundException, ForbiddenException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AnamnesisTemplatesService } from './anamnesis-templates.service';

@Injectable()
export class AnamnesisService {
  constructor(
    private prisma: PrismaService,
    private templatesService: AnamnesisTemplatesService,
  ) {}

  /** Cria anamnese preenchida. Captura snapshot do schema do template usado. */
  async create(
    patientId: string,
    tenantId: string,
    data: { answers: Record<string, any>; template_id?: string },
    userId?: string,
  ) {
    await this.assertPatientBelongsToTenant(patientId, tenantId);

    const template = data.template_id
      ? await this.templatesService.findOne(data.template_id, tenantId)
      : await this.templatesService.findActive(tenantId);

    return this.prisma.anamnesis.create({
      data: {
        patient_id: patientId,
        template_id: template.id,
        template_schema: template.schema as any,
        answers: data.answers,
        filled_by_user_id: userId || null,
      },
    });
  }

  async findByPatient(patientId: string, tenantId: string) {
    await this.assertPatientBelongsToTenant(patientId, tenantId);
    return this.prisma.anamnesis.findMany({
      where: { patient_id: patientId },
      orderBy: { filled_at: 'desc' },
      include: { template: { select: { id: true, version: true } } },
    });
  }

  async findOne(id: string, tenantId: string) {
    const anm = await this.prisma.anamnesis.findUnique({
      where: { id },
      include: {
        patient: { select: { id: true, name: true, tenant_id: true } },
        template: { select: { id: true, version: true, schema: true } },
      },
    });
    if (!anm) throw new NotFoundException('Anamnese nao encontrada');
    if (anm.patient.tenant_id !== tenantId) throw new ForbiddenException('Acesso negado');
    return anm;
  }

  /** Atualiza respostas. Nao permite trocar de template — snapshot preservado. */
  async update(id: string, tenantId: string, answers: Record<string, any>) {
    await this.findOne(id, tenantId);
    if (!answers || typeof answers !== 'object') throw new BadRequestException('answers obrigatorio');
    return this.prisma.anamnesis.update({
      where: { id },
      data: { answers },
    });
  }

  private async assertPatientBelongsToTenant(patientId: string, tenantId: string) {
    const row = await this.prisma.patient.findUnique({
      where: { id: patientId },
      select: { tenant_id: true },
    });
    if (!row) throw new NotFoundException('Paciente nao encontrado');
    if (row.tenant_id !== tenantId) throw new ForbiddenException('Acesso negado');
  }
}

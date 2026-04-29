/**
 * PatientTagsService — CRUD de tags + atribuição a pacientes (Fase 20).
 *
 * Tags são por tenant (isolamento multi-tenant). Operadores podem criar/editar
 * tags livremente (ex: "VIP", "Alergia critica", "Sem revisao 6m") com cor
 * customizada pra badge. Atribuição é via tabela join PatientTagOnPatient.
 */
import { Injectable, NotFoundException, ForbiddenException, BadRequestException, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

export interface CreateTagDto {
  name: string;
  color?: string | null;
  description?: string | null;
}

export interface UpdateTagDto extends Partial<CreateTagDto> {}

@Injectable()
export class PatientTagsService {
  private readonly logger = new Logger(PatientTagsService.name);

  constructor(private prisma: PrismaService) {}

  // ─── CRUD de tags ─────────────────────────────────────────────

  async list(tenantId: string) {
    return (this.prisma as any).patientTag.findMany({
      where: { tenant_id: tenantId },
      orderBy: { name: 'asc' },
      include: {
        _count: { select: { patients: true } }, // quantos pacientes têm essa tag
      },
    });
  }

  async create(tenantId: string, data: CreateTagDto) {
    if (!data.name?.trim()) throw new BadRequestException('Nome da tag é obrigatório');
    // Valida unicidade dentro do tenant
    const existing = await (this.prisma as any).patientTag.findUnique({
      where: { tenant_id_name: { tenant_id: tenantId, name: data.name.trim() } },
    });
    if (existing) throw new BadRequestException('Já existe uma tag com esse nome');

    return (this.prisma as any).patientTag.create({
      data: {
        tenant_id: tenantId,
        name: data.name.trim(),
        color: data.color || null,
        description: data.description?.trim() || null,
      },
    });
  }

  async update(id: string, tenantId: string, data: UpdateTagDto) {
    await this.assertBelongsToTenant(id, tenantId);
    if (data.name && !data.name.trim()) {
      throw new BadRequestException('Nome não pode ser vazio');
    }
    return (this.prisma as any).patientTag.update({
      where: { id },
      data: {
        ...(data.name !== undefined ? { name: data.name.trim() } : {}),
        ...(data.color !== undefined ? { color: data.color || null } : {}),
        ...(data.description !== undefined ? { description: data.description?.trim() || null } : {}),
      },
    });
  }

  async remove(id: string, tenantId: string) {
    await this.assertBelongsToTenant(id, tenantId);
    // O Cascade no relacionamento M2M cuida das atribuicoes — paciente nao some
    return (this.prisma as any).patientTag.delete({ where: { id } });
  }

  // ─── Atribuição de tags a pacientes ──────────────────────────

  /**
   * Substitui o conjunto de tags do paciente pelo conjunto enviado.
   * Idempotente — operador pode chamar várias vezes com o mesmo set.
   */
  async setTagsForPatient(patientId: string, tenantId: string, tagIds: string[]) {
    // Valida que paciente é do tenant
    const patient = await this.prisma.patient.findUnique({
      where: { id: patientId },
      select: { tenant_id: true },
    });
    if (!patient) throw new NotFoundException('Paciente não encontrado');
    if (patient.tenant_id !== tenantId) throw new ForbiddenException('Acesso negado');

    // Valida que todas as tags são do mesmo tenant (segurança)
    if (tagIds.length > 0) {
      const tags = await (this.prisma as any).patientTag.findMany({
        where: { id: { in: tagIds }, tenant_id: tenantId },
        select: { id: true },
      });
      if (tags.length !== tagIds.length) {
        throw new BadRequestException('Uma ou mais tags são inválidas ou de outro tenant');
      }
    }

    // Apaga atual e recria — transação pra atomicidade
    await this.prisma.$transaction([
      (this.prisma as any).patientTagOnPatient.deleteMany({ where: { patient_id: patientId } }),
      ...(tagIds.length > 0
        ? [(this.prisma as any).patientTagOnPatient.createMany({
            data: tagIds.map((tag_id) => ({ patient_id: patientId, tag_id })),
            skipDuplicates: true,
          })]
        : []),
    ]);

    return this.getTagsForPatient(patientId);
  }

  async getTagsForPatient(patientId: string) {
    return (this.prisma as any).patientTagOnPatient.findMany({
      where: { patient_id: patientId },
      include: { tag: true },
      orderBy: { tag: { name: 'asc' } },
    });
  }

  // ─── Helpers ──────────────────────────────────────────────────

  private async assertBelongsToTenant(tagId: string, tenantId: string) {
    const tag = await (this.prisma as any).patientTag.findUnique({
      where: { id: tagId },
      select: { tenant_id: true },
    });
    if (!tag) throw new NotFoundException('Tag não encontrada');
    if (tag.tenant_id !== tenantId) throw new ForbiddenException('Acesso negado');
  }
}

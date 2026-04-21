import { Injectable, NotFoundException, ForbiddenException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class OdontogramService {
  constructor(private prisma: PrismaService) {}

  /** Busca ou cria lazy o Odontogram do paciente. Retorna com todos os ToothRecords. */
  async getOrCreate(patientId: string, tenantId: string) {
    await this.assertPatientBelongsToTenant(patientId, tenantId);

    const existing = await this.prisma.odontogram.findUnique({
      where: { patient_id: patientId },
      include: { teeth: { orderBy: { tooth_fdi: 'asc' } } },
    });
    if (existing) return existing;

    return this.prisma.odontogram.create({
      data: { patient_id: patientId },
      include: { teeth: true },
    });
  }

  async updateMeta(patientId: string, tenantId: string, meta: Record<string, any>, userId?: string) {
    const odo = await this.getOrCreate(patientId, tenantId);
    return this.prisma.odontogram.update({
      where: { id: odo.id },
      data: {
        meta,
        last_updated_by_user_id: userId || null,
      },
    });
  }

  // ─── ToothRecord ──────────────────────────────────────────────

  async addTooth(
    patientId: string,
    tenantId: string,
    userId: string,
    data: { tooth_fdi: string; face?: string; state: string; material?: string; notes?: string },
  ) {
    const odo = await this.getOrCreate(patientId, tenantId);
    const tooth = await this.prisma.toothRecord.create({
      data: {
        odontogram_id: odo.id,
        tooth_fdi: data.tooth_fdi,
        face: data.face || null,
        state: data.state,
        material: data.material || null,
        notes: data.notes || null,
      },
    });
    await this.prisma.odontogram.update({
      where: { id: odo.id },
      data: { last_updated_by_user_id: userId },
    });
    return tooth;
  }

  async updateTooth(
    toothId: string,
    tenantId: string,
    userId: string,
    data: { face?: string; state?: string; material?: string; notes?: string },
  ) {
    const tooth = await this.getToothEnsuringTenant(toothId, tenantId);
    const updated = await this.prisma.toothRecord.update({
      where: { id: tooth.id },
      data,
    });
    await this.prisma.odontogram.update({
      where: { id: tooth.odontogram_id },
      data: { last_updated_by_user_id: userId },
    });
    return updated;
  }

  async removeTooth(toothId: string, tenantId: string, userId: string) {
    const tooth = await this.getToothEnsuringTenant(toothId, tenantId);
    await this.prisma.toothRecord.delete({ where: { id: tooth.id } });
    await this.prisma.odontogram.update({
      where: { id: tooth.odontogram_id },
      data: { last_updated_by_user_id: userId },
    });
    return { ok: true };
  }

  // ─── Helpers ──────────────────────────────────────────────────

  private async assertPatientBelongsToTenant(patientId: string, tenantId: string) {
    const row = await this.prisma.patient.findUnique({
      where: { id: patientId },
      select: { tenant_id: true },
    });
    if (!row) throw new NotFoundException('Paciente nao encontrado');
    if (row.tenant_id !== tenantId) throw new ForbiddenException('Acesso negado');
  }

  private async getToothEnsuringTenant(toothId: string, tenantId: string) {
    const tooth = await this.prisma.toothRecord.findUnique({
      where: { id: toothId },
      select: {
        id: true,
        odontogram_id: true,
        odontogram: { select: { patient: { select: { tenant_id: true } } } },
      },
    });
    if (!tooth) throw new NotFoundException('Registro dentario nao encontrado');
    if (tooth.odontogram.patient.tenant_id !== tenantId) {
      throw new ForbiddenException('Acesso negado');
    }
    return tooth;
  }
}

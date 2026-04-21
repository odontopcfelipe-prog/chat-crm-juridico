import { Injectable, NotFoundException, ForbiddenException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class MedicalRecordsService {
  constructor(private prisma: PrismaService) {}

  /** Busca ou cria (lazy) o MedicalRecord do paciente. */
  async getOrCreate(patientId: string, tenantId: string) {
    await this.assertPatientBelongsToTenant(patientId, tenantId);

    const existing = await this.prisma.medicalRecord.findUnique({
      where: { patient_id: patientId },
    });
    if (existing) return existing;

    return this.prisma.medicalRecord.create({
      data: { patient_id: patientId },
    });
  }

  async update(
    patientId: string,
    tenantId: string,
    data: { chief_complaint?: string; history?: string },
  ) {
    const mr = await this.getOrCreate(patientId, tenantId);
    return this.prisma.medicalRecord.update({
      where: { id: mr.id },
      data,
    });
  }

  async close(patientId: string, tenantId: string) {
    const mr = await this.getOrCreate(patientId, tenantId);
    return this.prisma.medicalRecord.update({
      where: { id: mr.id },
      data: { closed_at: new Date() },
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

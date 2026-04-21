import { Injectable, NotFoundException, ForbiddenException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { MedicalRecordsService } from './medical-records.service';

@Injectable()
export class ClinicalNotesService {
  constructor(
    private prisma: PrismaService,
    private medicalRecordsService: MedicalRecordsService,
  ) {}

  /** Cria nova nota vinculada ao prontuario do paciente. Auto-cria MedicalRecord se necessario. */
  async create(
    patientId: string,
    tenantId: string,
    authorUserId: string,
    data: {
      appointment_id?: string;
      subjective?: string;
      objective?: string;
      assessment?: string;
      plan?: string;
      executed_items?: string[];
    },
  ) {
    const mr = await this.medicalRecordsService.getOrCreate(patientId, tenantId);

    return this.prisma.clinicalNote.create({
      data: {
        medical_record_id: mr.id,
        appointment_id: data.appointment_id || null,
        author_user_id: authorUserId,
        subjective: data.subjective || null,
        objective: data.objective || null,
        assessment: data.assessment || null,
        plan: data.plan || null,
        executed_items: data.executed_items || [],
      },
      include: {
        author: { select: { id: true, name: true } },
        appointment: { select: { id: true, start_at: true, title: true } },
      },
    });
  }

  async findByPatient(patientId: string, tenantId: string) {
    const mr = await this.medicalRecordsService.getOrCreate(patientId, tenantId);
    return this.prisma.clinicalNote.findMany({
      where: { medical_record_id: mr.id },
      orderBy: { created_at: 'desc' },
      include: {
        author: { select: { id: true, name: true } },
        appointment: { select: { id: true, start_at: true, title: true } },
        _count: { select: { clinical_images: true } },
      },
    });
  }

  async findOne(id: string, tenantId: string) {
    const note = await this.prisma.clinicalNote.findUnique({
      where: { id },
      include: {
        author: { select: { id: true, name: true } },
        appointment: { select: { id: true, start_at: true, title: true } },
        clinical_images: true,
        medical_record: {
          select: { id: true, patient: { select: { id: true, name: true, tenant_id: true } } },
        },
      },
    });
    if (!note) throw new NotFoundException('Nota clinica nao encontrada');
    if (note.medical_record.patient.tenant_id !== tenantId) {
      throw new ForbiddenException('Acesso negado');
    }
    return note;
  }

  /** Atualiza campos SOAP. Bloqueado apos is_finalized=true (so aceita addendum). */
  async update(
    id: string,
    tenantId: string,
    userId: string,
    data: {
      subjective?: string;
      objective?: string;
      assessment?: string;
      plan?: string;
      executed_items?: string[];
    },
  ) {
    const note = await this.findOne(id, tenantId);
    if (note.is_finalized) {
      throw new BadRequestException('Nota finalizada — use /addendum para acrescentar correcao');
    }
    if (note.author_user_id !== userId) {
      throw new ForbiddenException('Apenas o autor pode editar a nota antes de finalizar');
    }
    return this.prisma.clinicalNote.update({
      where: { id },
      data,
    });
  }

  /** Finaliza a nota — vira imutavel. */
  async finalize(id: string, tenantId: string, userId: string) {
    const note = await this.findOne(id, tenantId);
    if (note.is_finalized) return note; // idempotente
    if (note.author_user_id !== userId) {
      throw new ForbiddenException('Apenas o autor pode finalizar a nota');
    }
    return this.prisma.clinicalNote.update({
      where: { id },
      data: { is_finalized: true, finalized_at: new Date() },
    });
  }

  /** Adiciona addendum apos finalizacao. Preserva o texto original. */
  async addAddendum(id: string, tenantId: string, userId: string, addendum: string) {
    const note = await this.findOne(id, tenantId);
    if (note.author_user_id !== userId) {
      throw new ForbiddenException('Apenas o autor pode adicionar addendum');
    }
    return this.prisma.clinicalNote.update({
      where: { id },
      data: {
        addendum: note.addendum ? `${note.addendum}\n\n---\n\n${addendum}` : addendum,
        addendum_at: new Date(),
      },
    });
  }
}

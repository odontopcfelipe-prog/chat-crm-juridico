import {
  Injectable, Logger, NotFoundException, BadRequestException,
} from '@nestjs/common';
import { randomBytes } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { S3Service } from '../s3/s3.service';
import { getImageProvider } from './image-provider';

interface CreateSimulationInput {
  patient_id: string;
  simulation_type: string;
  prompt?: string;
  patient_consent: boolean;
  notes?: string;
  before_buffer: Buffer;
  before_mime: string;
}

const VALID_TYPES = ['SMILE', 'FACE_HARMONY', 'LIPS', 'RHINOMODULATION', 'OTHER'];

@Injectable()
export class SmileDesignService {
  private readonly logger = new Logger(SmileDesignService.name);

  constructor(
    private prisma: PrismaService,
    private s3: S3Service,
  ) {}

  async create(
    tenantId: string,
    userId: string,
    input: CreateSimulationInput,
  ) {
    if (!tenantId) throw new BadRequestException('tenant_id ausente');
    if (!input.patient_consent) {
      throw new BadRequestException(
        'Consentimento do paciente obrigatorio (CFO Resolucao 118/2012)',
      );
    }
    if (!VALID_TYPES.includes(input.simulation_type)) {
      throw new BadRequestException(`simulation_type invalido. Use: ${VALID_TYPES.join(', ')}`);
    }

    const patient = await this.prisma.patient.findFirst({
      where: { id: input.patient_id, tenant_id: tenantId },
    });
    if (!patient) throw new NotFoundException('Paciente nao encontrado');

    // Upload da foto original
    const ext = input.before_mime.split('/')[1] || 'jpg';
    const beforeKey = `smile-simulations/${tenantId}/${input.patient_id}/${Date.now()}-${randomBytes(4).toString('hex')}-before.${ext}`;
    await this.s3.uploadBuffer(beforeKey, input.before_buffer, input.before_mime);

    // Cria registro PROCESSING
    const sim = await this.prisma.smileSimulation.create({
      data: {
        tenant_id: tenantId,
        patient_id: input.patient_id,
        created_by_user_id: userId,
        simulation_type: input.simulation_type,
        before_s3_key: beforeKey,
        prompt: input.prompt,
        status: 'PROCESSING',
        patient_consent: true,
        patient_consent_at: new Date(),
        notes: input.notes,
      },
    });

    // Best-effort: gera 'after' via provider, atualiza registro
    this.generateAndUpdate(sim.id, tenantId, input).catch((e) =>
      this.logger.warn(`[SmileDesign] Falha ao gerar simulacao ${sim.id}: ${e.message}`),
    );

    return sim;
  }

  /** Roda em background (nao bloqueia o POST) */
  private async generateAndUpdate(
    simulationId: string,
    tenantId: string,
    input: CreateSimulationInput,
  ) {
    try {
      const provider = getImageProvider();
      const result = await provider.generate({
        before: input.before_buffer,
        beforeMime: input.before_mime,
        simulationType: input.simulation_type,
        prompt: input.prompt,
      });

      const ext = result.mime.split('/')[1] || 'jpg';
      const afterKey = `smile-simulations/${tenantId}/${input.patient_id}/${Date.now()}-${randomBytes(4).toString('hex')}-after.${ext}`;
      await this.s3.uploadBuffer(afterKey, result.buffer, result.mime);

      await this.prisma.smileSimulation.update({
        where: { id: simulationId },
        data: {
          after_s3_key: afterKey,
          provider: provider.name,
          provider_metadata: result.metadata,
          status: 'DONE',
        },
      });
    } catch (e: any) {
      await this.prisma.smileSimulation.update({
        where: { id: simulationId },
        data: { status: 'FAILED', error_message: e.message?.slice(0, 500) },
      });
    }
  }

  async findByPatient(tenantId: string, patientId: string) {
    const patient = await this.prisma.patient.findFirst({
      where: { id: patientId, tenant_id: tenantId },
    });
    if (!patient) throw new NotFoundException('Paciente nao encontrado');

    return this.prisma.smileSimulation.findMany({
      where: { tenant_id: tenantId, patient_id: patientId },
      orderBy: { created_at: 'desc' },
      include: {
        created_by: { select: { id: true, name: true } },
      },
    });
  }

  async findOne(tenantId: string, id: string) {
    const sim = await this.prisma.smileSimulation.findFirst({
      where: { id, tenant_id: tenantId },
      include: {
        patient: { select: { id: true, name: true } },
        created_by: { select: { id: true, name: true } },
      },
    });
    if (!sim) throw new NotFoundException('Simulacao nao encontrada');
    return sim;
  }

  async remove(tenantId: string, id: string) {
    const sim = await this.findOne(tenantId, id);
    // Best-effort delete S3
    try {
      await this.s3.deleteObject(sim.before_s3_key);
      if (sim.after_s3_key) await this.s3.deleteObject(sim.after_s3_key);
    } catch { /* ignore */ }
    await this.prisma.smileSimulation.delete({ where: { id } });
    return { ok: true };
  }
}

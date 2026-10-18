import {
  Injectable, Logger, NotFoundException, BadRequestException,
} from '@nestjs/common';
import { randomUUID } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { S3Service } from '../s3/s3.service';
import { FileStorageService } from '../media/filesystem.service';
import { SettingsService } from '../settings/settings.service';
import {
  ImageProvider, MockImageProvider, OpenAiImageProvider, buildModelChain,
} from './image-provider';
import {
  SmileShade, SmileTreatment, buildSmilePrompt, isSmileShade, isSmileTreatment,
} from './smile-prompt';
import { SmileRegion, openAiSizeFor, readPngSize } from './smile-image.util';

interface CreateSimulationInput {
  patient_id: string;
  simulation_type?: string;
  treatment?: string;
  shade?: string;
  /** Pedido livre do dentista pra IA. */
  prompt?: string;
  patient_consent: boolean;
  notes?: string;
  before_buffer: Buffer;
  before_mime: string;
  mask_buffer?: Buffer | null;
  region?: SmileRegion | null;
}

interface GenerationJob {
  simulationId: string;
  before: Buffer;
  beforeMime: string;
  mask: Buffer | null;
  prompt: string;
  size: string | null;
}

const VALID_TYPES = ['SMILE', 'FACE_HARMONY', 'LIPS', 'RHINOMODULATION', 'OTHER'];
const ACCEPTED_MIMES: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/webp': 'webp',
};
/** Geração que passou disso sem terminar (API reiniciou no meio) vira FAILED. */
const STALE_PROCESSING_MS = 12 * 60_000;

@Injectable()
export class SmileDesignService {
  private readonly logger = new Logger(SmileDesignService.name);

  constructor(
    private prisma: PrismaService,
    private s3: S3Service,
    private fileStorage: FileStorageService,
    private settings: SettingsService,
  ) {}

  /** Status pra tela: tem IA configurada? */
  async status() {
    const forced = (await this.settings.get('SMILE_DESIGN_PROVIDER'))?.trim().toLowerCase();
    if (forced === 'mock') return { configured: true, provider: 'mock' };
    const key = (await this.settings.get('OPENAI_API_KEY')) || process.env.OPENAI_API_KEY;
    return { configured: !!key, provider: 'openai' };
  }

  async create(tenantId: string, userId: string, input: CreateSimulationInput) {
    if (!tenantId) throw new BadRequestException('tenant_id ausente');
    if (!input.patient_consent) {
      throw new BadRequestException(
        'Consentimento do paciente obrigatorio (CFO Resolucao 118/2012)',
      );
    }
    const simulationType = input.simulation_type || 'SMILE';
    if (!VALID_TYPES.includes(simulationType)) {
      throw new BadRequestException(`simulation_type invalido. Use: ${VALID_TYPES.join(', ')}`);
    }
    const beforeExt = ACCEPTED_MIMES[input.before_mime];
    if (!beforeExt) throw new BadRequestException('Formato de foto não suportado — use JPG, PNG ou WEBP');
    const treatment: SmileTreatment = isSmileTreatment(input.treatment) ? input.treatment : 'COMPLETO';
    const shade: SmileShade = isSmileShade(input.shade) ? input.shade : 'NATURAL';

    const patient = await this.prisma.patient.findFirst({
      where: { id: input.patient_id, tenant_id: tenantId },
      select: { id: true },
    });
    if (!patient) throw new NotFoundException('Paciente nao encontrado');

    // Máscara só vale se for PNG do MESMO tamanho da foto (regra da OpenAI).
    const beforeSize = readPngSize(input.before_buffer);
    const maskSize = readPngSize(input.mask_buffer);
    let mask = input.mask_buffer || null;
    if (mask && (!beforeSize || !maskSize
      || beforeSize.width !== maskSize.width || beforeSize.height !== maskSize.height)) {
      this.logger.warn(`[SmileDesign] máscara descartada: tamanho difere da foto`);
      mask = null;
    }
    const region = mask ? input.region || null : null;
    const size = beforeSize ? openAiSizeFor(beforeSize.width, beforeSize.height) : null;

    const base = `smile-simulations/${tenantId}/${input.patient_id}/${randomUUID()}`;
    const beforePath = `${base}-before.${beforeExt}`;
    await this.fileStorage.write(beforePath, input.before_buffer);
    const maskPath = mask ? `${base}-mask.png` : null;
    if (mask && maskPath) await this.fileStorage.write(maskPath, mask);

    const prompt = buildSmilePrompt({ treatment, shade, extra: input.prompt, hasMask: !!mask });
    const sim = await this.prisma.smileSimulation.create({
      data: {
        tenant_id: tenantId,
        patient_id: input.patient_id,
        created_by_user_id: userId,
        simulation_type: simulationType,
        before_s3_key: beforePath,
        prompt: input.prompt?.trim() || null,
        provider: 'openai',
        provider_metadata: {
          storage: 'fs',
          treatment,
          shade,
          region: region ? { ...region } : null,
          mask_path: maskPath,
          before_mime: input.before_mime,
          width: beforeSize?.width ?? null,
          height: beforeSize?.height ?? null,
        },
        status: 'PROCESSING',
        patient_consent: true,
        patient_consent_at: new Date(),
        notes: input.notes?.trim() || null,
      },
    });

    // Roda em background (a OpenAI leva de 20s a 2min) — a tela faz polling.
    this.generateAndUpdate(tenantId, input.patient_id, {
      simulationId: sim.id,
      before: input.before_buffer,
      beforeMime: input.before_mime,
      mask,
      prompt,
      size,
    }).catch((e) =>
      this.logger.warn(`[SmileDesign] Falha ao gerar simulacao ${sim.id}: ${e.message}`),
    );

    return sim;
  }

  /**
   * "Gerar outra versão": mesma foto e mesma marcação da boca, com o
   * tratamento/cor/pedido escolhidos agora (ou os da simulação original).
   */
  async regenerate(
    tenantId: string,
    userId: string,
    id: string,
    body: { treatment?: string; shade?: string; prompt?: string; notes?: string },
  ) {
    const sim = await this.findOne(tenantId, id);
    const meta: any = sim.provider_metadata || {};
    const before = await this.readStored(sim.before_s3_key);
    if (!before) throw new BadRequestException('A foto original desta simulação não está mais disponível');
    const mask = meta.mask_path ? await this.fileStorage.tryRead(meta.mask_path) : null;
    const beforeMime = meta.before_mime || guessMime(sim.before_s3_key);
    return this.create(tenantId, userId, {
      patient_id: sim.patient_id,
      simulation_type: sim.simulation_type,
      treatment: body.treatment ?? meta.treatment,
      shade: body.shade ?? meta.shade,
      prompt: body.prompt !== undefined ? body.prompt : sim.prompt || undefined,
      notes: body.notes !== undefined ? body.notes : sim.notes || undefined,
      patient_consent: true,
      before_buffer: before,
      before_mime: beforeMime,
      mask_buffer: mask,
      region: meta.region || null,
    });
  }

  private async resolveProvider(): Promise<ImageProvider> {
    const forced = (await this.settings.get('SMILE_DESIGN_PROVIDER'))?.trim().toLowerCase();
    if (forced === 'mock') return new MockImageProvider();
    const key = (await this.settings.get('OPENAI_API_KEY')) || process.env.OPENAI_API_KEY;
    if (!key) throw new Error('Chave da OpenAI não configurada — cadastre em Ajustes › IA.');
    const model = await this.settings.get('SMILE_DESIGN_MODEL');
    const quality = (await this.settings.get('SMILE_DESIGN_QUALITY'))?.trim().toLowerCase() || 'high';
    return new OpenAiImageProvider(key, buildModelChain(model), quality);
  }

  private async generateAndUpdate(tenantId: string, patientId: string, job: GenerationJob) {
    try {
      const provider = await this.resolveProvider();
      const result = await provider.generate({
        before: job.before,
        beforeMime: job.beforeMime,
        mask: job.mask,
        prompt: job.prompt,
        size: job.size,
      });

      const ext = ACCEPTED_MIMES[result.mime] || 'jpg';
      const afterPath = `smile-simulations/${tenantId}/${patientId}/${randomUUID()}-after.${ext}`;
      await this.fileStorage.write(afterPath, result.buffer);

      const current = await this.prisma.smileSimulation.findUnique({
        where: { id: job.simulationId },
        select: { provider_metadata: true },
      });
      if (!current) {
        // Excluída enquanto gerava — não deixa arquivo órfão.
        await this.fileStorage.delete(afterPath).catch(() => undefined);
        return;
      }
      await this.prisma.smileSimulation.update({
        where: { id: job.simulationId },
        data: {
          after_s3_key: afterPath,
          provider: provider.name,
          provider_metadata: { ...((current.provider_metadata as any) || {}), ...result.metadata },
          status: 'DONE',
          error_message: null,
        },
      });
    } catch (e: any) {
      this.logger.warn(`[SmileDesign] simulação ${job.simulationId} falhou: ${e?.message}`);
      await this.prisma.smileSimulation.updateMany({
        where: { id: job.simulationId },
        data: { status: 'FAILED', error_message: String(e?.message || e).slice(0, 500) },
      });
    }
  }

  async findByPatient(tenantId: string, patientId: string) {
    const patient = await this.prisma.patient.findFirst({
      where: { id: patientId, tenant_id: tenantId },
      select: { id: true },
    });
    if (!patient) throw new NotFoundException('Paciente nao encontrado');

    await this.prisma.smileSimulation.updateMany({
      where: {
        tenant_id: tenantId,
        patient_id: patientId,
        status: 'PROCESSING',
        created_at: { lt: new Date(Date.now() - STALE_PROCESSING_MS) },
      },
      data: { status: 'FAILED', error_message: 'A geração foi interrompida — clique em "Gerar de novo".' },
    });

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

  /** Bytes da foto antes/depois — disco da API; simulações antigas ficavam no S3. */
  async getImage(tenantId: string, id: string, kind: 'before' | 'after') {
    const sim = await this.findOne(tenantId, id);
    const key = kind === 'after' ? sim.after_s3_key : sim.before_s3_key;
    if (!key) throw new NotFoundException(`Imagem '${kind}' indisponivel`);
    const buffer = await this.readStored(key);
    if (!buffer) throw new NotFoundException('Arquivo da imagem não encontrado');
    return { buffer, contentType: guessMime(key) };
  }

  private async readStored(key: string): Promise<Buffer | null> {
    const fromDisk = await this.fileStorage.tryRead(key).catch(() => null);
    if (fromDisk) return fromDisk;
    try {
      return (await this.s3.getObjectBuffer(key)).buffer;
    } catch {
      return null;
    }
  }

  async remove(tenantId: string, id: string) {
    const sim = await this.findOne(tenantId, id);
    const meta: any = sim.provider_metadata || {};
    const keys = [sim.before_s3_key, sim.after_s3_key, meta.mask_path].filter(Boolean) as string[];
    for (const key of keys) {
      await this.fileStorage.delete(key).catch(() => undefined);
      if (meta.storage !== 'fs') await this.s3.deleteObject(key).catch(() => undefined);
    }
    await this.prisma.smileSimulation.delete({ where: { id: sim.id } });
    return { ok: true };
  }
}

function guessMime(key: string): string {
  const ext = key.split('.').pop()?.toLowerCase();
  if (ext === 'png') return 'image/png';
  if (ext === 'webp') return 'image/webp';
  return 'image/jpeg';
}

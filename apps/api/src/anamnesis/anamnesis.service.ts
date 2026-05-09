import { Injectable, NotFoundException, ForbiddenException, BadRequestException } from '@nestjs/common';
import { createHash } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { AnamnesisTemplatesService } from './anamnesis-templates.service';

interface UpsertInput {
  answers: Record<string, any>;
  template_id?: string;
  submitted_via?: 'STAFF' | 'PATIENT_PORTAL';
  ip?: string;
  user_agent?: string;
  consent_text?: string;
  signature_method?: 'TYPED_NAME' | 'DRAWN';
  signature_data?: string;
  selfie_data?: string;
}

/**
 * Calcula hash SHA-256 de fingerprint forense da anamnese.
 * Qualquer mudanca em answers, IP, UA, signature, selfie ou timestamp produz hash diferente.
 * Para selfie/signature usa-se sub-hash em vez do data-url completo (evita inflar payload).
 */
export function computeAnamneseAuditHash(input: {
  answers: Record<string, any>;
  ip?: string | null;
  user_agent?: string | null;
  signature_data?: string | null;
  selfie_data?: string | null;
  filled_at: Date;
}): string {
  const sigHash = input.signature_data
    ? createHash('sha256').update(input.signature_data).digest('hex')
    : '';
  const selfieHash = input.selfie_data
    ? createHash('sha256').update(input.selfie_data).digest('hex')
    : '';
  const payload = JSON.stringify({
    answers: input.answers,
    ip: input.ip || '',
    user_agent: input.user_agent || '',
    signature_hash: sigHash,
    selfie_hash: selfieHash,
    filled_at: input.filled_at.toISOString(),
  });
  return createHash('sha256').update(payload).digest('hex');
}

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

    const filled_at = new Date();
    const audit_hash = computeAnamneseAuditHash({
      answers: data.answers,
      filled_at,
    });

    return this.prisma.anamnesis.create({
      data: {
        patient_id: patientId,
        template_id: template.id,
        template_schema: template.schema as any,
        answers: data.answers,
        filled_by_user_id: userId || null,
        submitted_via: 'STAFF',
        filled_at,
        audit_hash,
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

  /**
   * Retorna a anamnese ativa do paciente (mais recente) com template_schema embutido.
   * Se nao existe ainda, retorna { exists: false, template } com o template ATIVO
   * para o frontend renderizar form vazio.
   */
  async findActiveByPatient(patientId: string, tenantId: string) {
    await this.assertPatientBelongsToTenant(patientId, tenantId);

    const anm = await this.prisma.anamnesis.findFirst({
      where: { patient_id: patientId },
      orderBy: { filled_at: 'desc' },
      include: {
        template: { select: { id: true, version: true, schema: true } },
      },
    });

    if (anm) {
      // Busca nome do usuario que preencheu (relation nao existe no schema, lookup manual)
      let filled_by_user: { id: string; name: string } | null = null;
      if (anm.filled_by_user_id) {
        filled_by_user = await this.prisma.user.findUnique({
          where: { id: anm.filled_by_user_id },
          select: { id: true, name: true },
        });
      }
      return {
        exists: true,
        anamnesis: { ...anm, filled_by_user },
      };
    }

    // Sem anamnese ainda — devolve template ativo pro form (ou null se admin
    // ainda nao cadastrou template; frontend mostra mensagem amigavel).
    const template = await this.prisma.anamnesisTemplate.findFirst({
      where: { tenant_id: tenantId, active: true },
      orderBy: { version: 'desc' },
    });
    return {
      exists: false,
      template: template
        ? { id: template.id, version: template.version, schema: template.schema }
        : null,
    };
  }

  /**
   * Upsert: se ja existe anamnese pro paciente, atualiza; senao cria.
   * Usado por preenchimento da equipe (PUT /patients/:id/anamnesis) e
   * por preenchimento do paciente via portal (POST /portal/anamnesis/submit).
   */
  async upsertByPatient(
    patientId: string,
    tenantId: string,
    input: UpsertInput,
    userId?: string,
  ) {
    await this.assertPatientBelongsToTenant(patientId, tenantId);
    if (!input.answers || typeof input.answers !== 'object') {
      throw new BadRequestException('answers obrigatorio');
    }

    const existing = await this.prisma.anamnesis.findFirst({
      where: { patient_id: patientId },
      orderBy: { filled_at: 'desc' },
    });

    const submitted_via = input.submitted_via || 'STAFF';
    const filled_at = new Date();
    const consent_accepted_at = submitted_via === 'PATIENT_PORTAL' ? filled_at : null;

    // TRAVA: paciente nao pode re-confirmar uma anamnese ja confirmada por ele.
    // Equipe (STAFF) pode atualizar a qualquer momento.
    if (
      existing &&
      submitted_via === 'PATIENT_PORTAL' &&
      existing.consent_accepted_at != null
    ) {
      throw new BadRequestException(
        'Sua anamnese ja foi confirmada eletronicamente. Para alterar, ' +
        'entre em contato com a clinica.',
      );
    }

    const audit_hash = computeAnamneseAuditHash({
      answers: input.answers,
      ip: input.ip,
      user_agent: input.user_agent,
      signature_data: input.signature_data,
      selfie_data: input.selfie_data,
      filled_at,
    });

    if (existing) {
      // Atualiza existente — preserva template_id original (snapshot imutavel)
      return this.prisma.anamnesis.update({
        where: { id: existing.id },
        data: {
          answers: input.answers,
          filled_by_user_id: userId ?? existing.filled_by_user_id,
          filled_at,
          submitted_via,
          submitted_ip: input.ip || null,
          submitted_user_agent: input.user_agent?.slice(0, 500) || null,
          consent_text: input.consent_text || existing.consent_text,
          consent_accepted_at: consent_accepted_at || existing.consent_accepted_at,
          signature_method: input.signature_method || null,
          signature_data: input.signature_data || null,
          selfie_data: input.selfie_data || existing.selfie_data,
          audit_hash,
        },
      });
    }

    // Primeira anamnese — pega template ativo
    const template = input.template_id
      ? await this.templatesService.findOne(input.template_id, tenantId)
      : await this.templatesService.findActive(tenantId);

    return this.prisma.anamnesis.create({
      data: {
        patient_id: patientId,
        template_id: template.id,
        template_schema: template.schema as any,
        answers: input.answers,
        filled_by_user_id: userId || null,
        filled_at,
        submitted_via,
        submitted_ip: input.ip || null,
        submitted_user_agent: input.user_agent?.slice(0, 500) || null,
        consent_text: input.consent_text || null,
        consent_accepted_at,
        signature_method: input.signature_method || null,
        signature_data: input.signature_data || null,
        selfie_data: input.selfie_data || null,
        audit_hash,
      },
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
    const filled_at = new Date();
    const audit_hash = computeAnamneseAuditHash({ answers, filled_at });
    return this.prisma.anamnesis.update({
      where: { id },
      data: {
        answers,
        filled_at,
        submitted_via: 'STAFF',
        audit_hash,
      },
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

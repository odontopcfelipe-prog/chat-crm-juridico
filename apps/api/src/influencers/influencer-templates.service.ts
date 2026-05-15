/**
 * Templates de mensagem pra influenciadores. Textos com variáveis
 * ({{nome}}, {{handle}}, {{cupom}}) interpoladas no envio pelo worker.
 */
import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

export interface CreateTemplateDto {
  name: string;
  body: string;
}
export interface UpdateTemplateDto {
  name?: string;
  body?: string;
}

/**
 * Variáveis suportadas no body do template. Mantida aqui pra ser referência
 * única — o worker importa este array pra fazer interpolação.
 */
export const SUPPORTED_VARS = ['nome', 'handle', 'cupom', 'plataforma', 'nicho'] as const;

@Injectable()
export class InfluencerTemplatesService {
  constructor(private prisma: PrismaService) {}

  async list(tenantId: string) {
    return (this.prisma as any).influencerMessageTemplate.findMany({
      where: { tenant_id: tenantId },
      orderBy: { name: 'asc' },
    });
  }

  async findOne(id: string, tenantId: string) {
    const t = await (this.prisma as any).influencerMessageTemplate.findFirst({
      where: { id, tenant_id: tenantId },
    });
    if (!t) throw new NotFoundException('Template não encontrado');
    return t;
  }

  async create(tenantId: string, data: CreateTemplateDto) {
    if (!data.name?.trim()) throw new BadRequestException('Nome é obrigatório');
    if (!data.body?.trim()) throw new BadRequestException('Corpo da mensagem é obrigatório');
    return (this.prisma as any).influencerMessageTemplate.create({
      data: {
        tenant_id: tenantId,
        name: data.name.trim(),
        body: data.body,
      },
    });
  }

  async update(id: string, tenantId: string, data: UpdateTemplateDto) {
    await this.findOne(id, tenantId);
    const patch: any = {};
    if (data.name !== undefined) {
      if (!data.name.trim()) throw new BadRequestException('Nome não pode ser vazio');
      patch.name = data.name.trim();
    }
    if (data.body !== undefined) {
      if (!data.body.trim()) throw new BadRequestException('Corpo não pode ser vazio');
      patch.body = data.body;
    }
    return (this.prisma as any).influencerMessageTemplate.update({
      where: { id },
      data: patch,
    });
  }

  async remove(id: string, tenantId: string) {
    await this.findOne(id, tenantId);
    // ON DELETE RESTRICT na FK do schedule — bloqueia se houver schedule usando.
    // Damos uma mensagem amigável pro frontend.
    const using = await (this.prisma as any).influencerSchedule.count({
      where: { template_id: id, tenant_id: tenantId },
    });
    if (using > 0) {
      throw new BadRequestException(
        `Template está em uso por ${using} agendamento(s). Remova ou troque o template dos agendamentos primeiro.`,
      );
    }
    await (this.prisma as any).influencerMessageTemplate.delete({ where: { id } });
    return { ok: true };
  }
}

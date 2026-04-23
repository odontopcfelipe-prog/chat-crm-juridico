import { Injectable, BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Templates de funil — usados pelo endpoint POST /pipelines/from-template
 * para acelerar setup. Cada template gera 1 Pipeline + N Stages em bloco.
 * Admin pode editar tudo depois via UI.
 */
const PIPELINE_TEMPLATES = {
  'odonto-clinico': {
    name: 'Odontologia Clínica',
    slug: 'odonto',
    description:
      'Funil padrão para tratamentos odontológicos (clareamento, limpeza, prótese, canal, etc). Usar este funil para qualquer lead que chega com demanda de procedimento dentário convencional.',
    color: '#3b82f6',
    stages: [
      { name: 'Inicial', slug: 'inicial', emoji: '👋', color: '#6b7280', position: 0, is_initial: true, description: 'Primeiro contato — ainda não sabemos o que o paciente precisa.' },
      { name: 'Qualificando', slug: 'qualificando', emoji: '🔍', color: '#3b82f6', position: 1, description: 'Conversando pra identificar o procedimento desejado.' },
      { name: 'Consulta Agendada', slug: 'consulta-agendada', emoji: '📅', color: '#8b5cf6', position: 2, description: 'Lead marcou horário de avaliação na clínica.' },
      { name: 'Avaliação Feita', slug: 'avaliacao-feita', emoji: '🩺', color: '#06b6d4', position: 3, description: 'Paciente compareceu à avaliação, orçamento será gerado.' },
      { name: 'Orçamento Enviado', slug: 'orcamento-enviado', emoji: '📄', color: '#f59e0b', position: 4, description: 'Orçamento enviado, aguardando decisão.' },
      { name: 'Tratamento Iniciado', slug: 'tratamento-iniciado', emoji: '✅', color: '#10b981', position: 5, is_won: true, description: 'Paciente aceitou e iniciou o tratamento. É cliente.' },
      { name: 'Perdido', slug: 'perdido', emoji: '❌', color: '#ef4444', position: 6, is_lost: true, description: 'Lead desistiu ou não respondeu.' },
    ],
  },
  'estetica-facial': {
    name: 'Estética Facial',
    slug: 'estetica',
    description:
      'Funil para harmonização facial, botox, preenchimento, bichectomia. Use este funil quando o lead menciona interesse estético (não odontológico puro).',
    color: '#ec4899',
    stages: [
      { name: 'Inicial', slug: 'inicial', emoji: '👋', color: '#6b7280', position: 0, is_initial: true, description: 'Primeiro contato estético.' },
      { name: 'Qualificando', slug: 'qualificando', emoji: '🔍', color: '#ec4899', position: 1, description: 'Identificando procedimento desejado (botox, preenchimento, etc).' },
      { name: 'Consulta Agendada', slug: 'consulta-agendada', emoji: '📅', color: '#a855f7', position: 2, description: 'Avaliação marcada.' },
      { name: 'Avaliação Feita', slug: 'avaliacao-feita', emoji: '🩺', color: '#06b6d4', position: 3, description: 'Paciente avaliado, orçamento sendo preparado.' },
      { name: 'Orçamento Enviado', slug: 'orcamento-enviado', emoji: '📄', color: '#f59e0b', position: 4, description: 'Aguardando decisão do paciente.' },
      { name: 'Procedimento Feito', slug: 'procedimento-feito', emoji: '✨', color: '#10b981', position: 5, is_won: true, description: 'Aplicação realizada. Cliente efetivado.' },
      { name: 'Perdido', slug: 'perdido', emoji: '❌', color: '#ef4444', position: 6, is_lost: true, description: 'Desistência ou sem resposta.' },
    ],
  },
  'comercial-b2b': {
    name: 'Comercial B2B',
    slug: 'b2b',
    description:
      'Funil genérico para parcerias, convênios empresariais, fornecedores. Use quando o contato é PJ (empresa), não paciente final.',
    color: '#10b981',
    stages: [
      { name: 'Inicial', slug: 'inicial', emoji: '👋', color: '#6b7280', position: 0, is_initial: true },
      { name: 'Qualificando', slug: 'qualificando', emoji: '🔍', color: '#3b82f6', position: 1 },
      { name: 'Proposta Enviada', slug: 'proposta-enviada', emoji: '📄', color: '#f59e0b', position: 2 },
      { name: 'Negociando', slug: 'negociando', emoji: '💬', color: '#8b5cf6', position: 3 },
      { name: 'Contrato Fechado', slug: 'contrato-fechado', emoji: '✅', color: '#10b981', position: 4, is_won: true },
      { name: 'Perdido', slug: 'perdido', emoji: '❌', color: '#ef4444', position: 5, is_lost: true },
    ],
  },
} as const;

export type PipelineTemplateKey = keyof typeof PIPELINE_TEMPLATES;

/**
 * Gerencia os funis (Pipeline) e suas etapas (PipelineStage) por tenant.
 * Cada tenant pode ter vários funis (ex: Odontologia, Estética Facial) e
 * cada funil tem etapas configuráveis via UI. A IA carrega os funis
 * dinamicamente antes de cada resposta e sabe mover o lead entre etapas.
 */
@Injectable()
export class PipelinesService {
  constructor(private prisma: PrismaService) {}

  private get pipeline() {
    return (this.prisma as any).pipeline;
  }

  private get stage() {
    return (this.prisma as any).pipelineStage;
  }

  // ─── Pipelines ───────────────────────────────────────────────────────────

  async findAll(tenantId?: string) {
    return this.pipeline.findMany({
      where: { tenant_id: tenantId },
      include: {
        stages: { orderBy: { position: 'asc' } },
        _count: { select: { leads: true, stages: true } },
      },
      orderBy: [{ position: 'asc' }, { created_at: 'asc' }],
    });
  }

  async findOne(id: string, tenantId?: string) {
    const pipeline = await this.pipeline.findUnique({
      where: { id },
      include: {
        stages: { orderBy: { position: 'asc' } },
        _count: { select: { leads: true, stages: true } },
      },
    });
    if (!pipeline) throw new NotFoundException('Funil não encontrado');
    if (tenantId && pipeline.tenant_id && pipeline.tenant_id !== tenantId) {
      throw new NotFoundException('Funil não encontrado');
    }
    return pipeline;
  }

  async create(data: {
    name: string;
    slug: string;
    description?: string | null;
    color?: string | null;
    is_default?: boolean;
    position?: number;
    tenant_id?: string;
  }) {
    if (!data.name?.trim()) throw new BadRequestException('name é obrigatório');
    if (!data.slug?.trim()) throw new BadRequestException('slug é obrigatório');
    const slug = this.normalizeSlug(data.slug);

    const existing = await this.pipeline.findFirst({
      where: { tenant_id: data.tenant_id ?? null, slug },
    });
    if (existing) throw new ConflictException(`Já existe um funil com slug "${slug}"`);

    // Se for is_default, desmarca outros
    if (data.is_default) {
      await this.pipeline.updateMany({
        where: { tenant_id: data.tenant_id ?? null, is_default: true },
        data: { is_default: false },
      });
    }

    return this.pipeline.create({
      data: {
        name: data.name.trim(),
        slug,
        description: data.description ?? null,
        color: data.color ?? null,
        is_default: data.is_default ?? false,
        position: data.position ?? 0,
        tenant_id: data.tenant_id ?? null,
      },
      include: {
        stages: { orderBy: { position: 'asc' } },
        _count: { select: { leads: true, stages: true } },
      },
    });
  }

  async update(
    id: string,
    data: {
      name?: string;
      slug?: string;
      description?: string | null;
      color?: string | null;
      is_default?: boolean;
      is_active?: boolean;
      position?: number;
    },
    tenantId?: string,
  ) {
    const pipeline = await this.findOne(id, tenantId);

    const updateData: any = {};
    if (data.name !== undefined) updateData.name = data.name.trim();
    if (data.slug !== undefined) {
      const newSlug = this.normalizeSlug(data.slug);
      if (newSlug !== pipeline.slug) {
        const existing = await this.pipeline.findFirst({
          where: { tenant_id: pipeline.tenant_id, slug: newSlug, NOT: { id } },
        });
        if (existing) throw new ConflictException(`Slug "${newSlug}" já em uso`);
        updateData.slug = newSlug;
      }
    }
    if (data.description !== undefined) updateData.description = data.description;
    if (data.color !== undefined) updateData.color = data.color;
    if (data.position !== undefined) updateData.position = data.position;
    if (data.is_active !== undefined) updateData.is_active = data.is_active;
    if (data.is_default === true) {
      await this.pipeline.updateMany({
        where: { tenant_id: pipeline.tenant_id, is_default: true, NOT: { id } },
        data: { is_default: false },
      });
      updateData.is_default = true;
    } else if (data.is_default === false) {
      updateData.is_default = false;
    }

    return this.pipeline.update({
      where: { id },
      data: updateData,
      include: {
        stages: { orderBy: { position: 'asc' } },
        _count: { select: { leads: true, stages: true } },
      },
    });
  }

  async remove(id: string, tenantId?: string) {
    const pipeline = await this.findOne(id, tenantId);
    const leadCount = pipeline._count?.leads ?? 0;
    if (leadCount > 0) {
      throw new BadRequestException(
        `Não é possível excluir: ${leadCount} lead(s) vinculado(s). Mova-os para outro funil primeiro.`,
      );
    }
    await this.pipeline.delete({ where: { id } });
    return { ok: true };
  }

  /** Cria Pipeline + Stages numa transação única. Usado pelo modal "Novo Funil" da UI. */
  async createFull(data: {
    name: string;
    slug: string;
    description?: string | null;
    color?: string | null;
    is_default?: boolean;
    position?: number;
    tenant_id?: string;
    stages: Array<{
      name: string;
      slug: string;
      color?: string | null;
      emoji?: string | null;
      description?: string | null;
      position?: number;
      is_initial?: boolean;
      is_won?: boolean;
      is_lost?: boolean;
      auto_actions?: any;
    }>;
  }) {
    if (!data.name?.trim()) throw new BadRequestException('name é obrigatório');
    if (!data.slug?.trim()) throw new BadRequestException('slug é obrigatório');
    if (!Array.isArray(data.stages) || data.stages.length === 0) {
      throw new BadRequestException('Crie pelo menos 1 etapa');
    }

    const slug = this.normalizeSlug(data.slug);
    const existing = await this.pipeline.findFirst({
      where: { tenant_id: data.tenant_id ?? null, slug },
    });
    if (existing) throw new ConflictException(`Já existe um funil com slug "${slug}"`);

    // Valida slugs únicos dentro das stages
    const stageSlugs = data.stages.map(s => this.normalizeSlug(s.slug));
    if (new Set(stageSlugs).size !== stageSlugs.length) {
      throw new BadRequestException('Slugs de etapas duplicadas no funil');
    }
    // Só uma is_initial/is_won/is_lost
    const initialCount = data.stages.filter(s => s.is_initial).length;
    const wonCount = data.stages.filter(s => s.is_won).length;
    const lostCount = data.stages.filter(s => s.is_lost).length;
    if (initialCount > 1) throw new BadRequestException('Apenas uma etapa pode ser "inicial"');
    if (wonCount > 1) throw new BadRequestException('Apenas uma etapa pode ser "ganho"');
    if (lostCount > 1) throw new BadRequestException('Apenas uma etapa pode ser "perdido"');

    return (this.prisma as any).$transaction(async (tx: any) => {
      if (data.is_default) {
        await tx.pipeline.updateMany({
          where: { tenant_id: data.tenant_id ?? null, is_default: true },
          data: { is_default: false },
        });
      }

      const pipeline = await tx.pipeline.create({
        data: {
          name: data.name.trim(),
          slug,
          description: data.description ?? null,
          color: data.color ?? null,
          is_default: data.is_default ?? false,
          position: data.position ?? 0,
          tenant_id: data.tenant_id ?? null,
          stages: {
            create: data.stages.map((s, idx) => ({
              name: s.name.trim(),
              slug: stageSlugs[idx],
              color: s.color ?? null,
              emoji: s.emoji ?? null,
              description: s.description ?? null,
              position: s.position ?? idx,
              is_initial: s.is_initial ?? false,
              is_won: s.is_won ?? false,
              is_lost: s.is_lost ?? false,
              auto_actions: s.auto_actions ?? null,
            })),
          },
        },
        include: {
          stages: { orderBy: { position: 'asc' } },
          _count: { select: { leads: true, stages: true } },
        },
      });

      return pipeline;
    });
  }

  /** Lista templates disponíveis (usado pela UI pra mostrar "Usar template..."). */
  listTemplates() {
    return Object.entries(PIPELINE_TEMPLATES).map(([key, tpl]) => ({
      key,
      name: tpl.name,
      slug: tpl.slug,
      description: tpl.description,
      color: tpl.color,
      stage_count: tpl.stages.length,
    }));
  }

  /** Cria Pipeline+Stages a partir de um template predefinido. */
  async createFromTemplate(
    templateKey: string,
    overrides: { name?: string; slug?: string; is_default?: boolean; tenant_id?: string } = {},
  ) {
    const tpl = (PIPELINE_TEMPLATES as any)[templateKey] as (typeof PIPELINE_TEMPLATES)[PipelineTemplateKey] | undefined;
    if (!tpl) {
      throw new BadRequestException(
        `Template "${templateKey}" não existe. Disponíveis: ${Object.keys(PIPELINE_TEMPLATES).join(', ')}`,
      );
    }
    return this.createFull({
      name: overrides.name ?? tpl.name,
      slug: overrides.slug ?? tpl.slug,
      description: tpl.description,
      color: tpl.color,
      is_default: overrides.is_default ?? false,
      tenant_id: overrides.tenant_id,
      stages: tpl.stages.map(s => ({ ...s })),
    });
  }

  // ─── Stages ──────────────────────────────────────────────────────────────

  async createStage(
    pipelineId: string,
    data: {
      name: string;
      slug: string;
      color?: string | null;
      emoji?: string | null;
      description?: string | null;
      position?: number;
      is_initial?: boolean;
      is_won?: boolean;
      is_lost?: boolean;
      auto_actions?: any;
    },
    tenantId?: string,
  ) {
    await this.findOne(pipelineId, tenantId); // valida acesso

    if (!data.name?.trim()) throw new BadRequestException('name é obrigatório');
    if (!data.slug?.trim()) throw new BadRequestException('slug é obrigatório');
    const slug = this.normalizeSlug(data.slug);

    const existing = await this.stage.findFirst({
      where: { pipeline_id: pipelineId, slug },
    });
    if (existing) throw new ConflictException(`Já existe uma etapa com slug "${slug}" neste funil`);

    // is_initial / is_won / is_lost são exclusivos dentro de um pipeline
    if (data.is_initial) await this.clearFlag(pipelineId, 'is_initial');
    if (data.is_won) await this.clearFlag(pipelineId, 'is_won');
    if (data.is_lost) await this.clearFlag(pipelineId, 'is_lost');

    return this.stage.create({
      data: {
        pipeline_id: pipelineId,
        name: data.name.trim(),
        slug,
        color: data.color ?? null,
        emoji: data.emoji ?? null,
        description: data.description ?? null,
        position: data.position ?? 0,
        is_initial: data.is_initial ?? false,
        is_won: data.is_won ?? false,
        is_lost: data.is_lost ?? false,
        auto_actions: data.auto_actions ?? null,
      },
    });
  }

  async updateStage(
    pipelineId: string,
    stageId: string,
    data: {
      name?: string;
      slug?: string;
      color?: string | null;
      emoji?: string | null;
      description?: string | null;
      position?: number;
      is_initial?: boolean;
      is_won?: boolean;
      is_lost?: boolean;
      auto_actions?: any;
    },
    tenantId?: string,
  ) {
    await this.findOne(pipelineId, tenantId);
    const stage = await this.stage.findUnique({ where: { id: stageId } });
    if (!stage || stage.pipeline_id !== pipelineId) {
      throw new NotFoundException('Etapa não encontrada neste funil');
    }

    const updateData: any = {};
    if (data.name !== undefined) updateData.name = data.name.trim();
    if (data.slug !== undefined) {
      const newSlug = this.normalizeSlug(data.slug);
      if (newSlug !== stage.slug) {
        const existing = await this.stage.findFirst({
          where: { pipeline_id: pipelineId, slug: newSlug, NOT: { id: stageId } },
        });
        if (existing) throw new ConflictException(`Slug "${newSlug}" já em uso neste funil`);
        updateData.slug = newSlug;
      }
    }
    if (data.color !== undefined) updateData.color = data.color;
    if (data.emoji !== undefined) updateData.emoji = data.emoji;
    if (data.description !== undefined) updateData.description = data.description;
    if (data.position !== undefined) updateData.position = data.position;
    if (data.auto_actions !== undefined) updateData.auto_actions = data.auto_actions;

    if (data.is_initial === true) {
      await this.clearFlag(pipelineId, 'is_initial', stageId);
      updateData.is_initial = true;
    } else if (data.is_initial === false) {
      updateData.is_initial = false;
    }
    if (data.is_won === true) {
      await this.clearFlag(pipelineId, 'is_won', stageId);
      updateData.is_won = true;
    } else if (data.is_won === false) {
      updateData.is_won = false;
    }
    if (data.is_lost === true) {
      await this.clearFlag(pipelineId, 'is_lost', stageId);
      updateData.is_lost = true;
    } else if (data.is_lost === false) {
      updateData.is_lost = false;
    }

    return this.stage.update({ where: { id: stageId }, data: updateData });
  }

  async removeStage(pipelineId: string, stageId: string, tenantId?: string) {
    await this.findOne(pipelineId, tenantId);
    const stage = await this.stage.findUnique({ where: { id: stageId } });
    if (!stage || stage.pipeline_id !== pipelineId) {
      throw new NotFoundException('Etapa não encontrada neste funil');
    }
    const leadCount = await (this.prisma as any).lead.count({ where: { stage_id: stageId } });
    if (leadCount > 0) {
      throw new BadRequestException(
        `Não é possível excluir: ${leadCount} lead(s) nesta etapa. Mova-os para outra primeiro.`,
      );
    }
    await this.stage.delete({ where: { id: stageId } });
    return { ok: true };
  }

  /** Reordena etapas via array [{ id, position }]. */
  async reorderStages(
    pipelineId: string,
    items: Array<{ id: string; position: number }>,
    tenantId?: string,
  ) {
    await this.findOne(pipelineId, tenantId);
    if (!Array.isArray(items) || items.length === 0) {
      throw new BadRequestException('items vazio');
    }
    await this.prisma.$transaction(
      items.map(({ id, position }) =>
        this.stage.update({
          where: { id },
          data: { position },
        }),
      ),
    );
    return { ok: true };
  }

  // ─── Helpers ─────────────────────────────────────────────────────────────

  private async clearFlag(
    pipelineId: string,
    flag: 'is_initial' | 'is_won' | 'is_lost',
    exceptStageId?: string,
  ) {
    await this.stage.updateMany({
      where: {
        pipeline_id: pipelineId,
        [flag]: true,
        ...(exceptStageId ? { NOT: { id: exceptStageId } } : {}),
      },
      data: { [flag]: false },
    });
  }

  private normalizeSlug(raw: string): string {
    return raw
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 50);
  }
}

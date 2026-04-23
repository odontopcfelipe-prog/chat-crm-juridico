import type { PrismaClient } from '@prisma/client';

/**
 * Pipeline Context — Fase 4 do CRM dinâmico.
 *
 * Carrega os funis e etapas configurados pelo admin (via tela Settings →
 * Funis de CRM) e produz:
 *   1. Um bloco de texto para injetar no system prompt da IA
 *   2. Um resolver que traduz `stage_slug` / `pipeline_slug` devolvidos
 *      pela IA em `stage_id` / `pipeline_id` concretos no Lead
 *
 * A IA NÃO precisa mais saber os valores hardcoded de stage — lê do
 * bloco injetado e devolve o slug. Isso permite:
 *   - Múltiplos funis por tenant (odonto / estética / B2B)
 *   - Stages customizadas pelo admin sem deploy
 *   - IA classifica lead no funil correto no primeiro contato
 */

export interface PipelineStageLite {
  id: string;
  slug: string;
  name: string;
  emoji: string | null;
  color: string | null;
  description: string | null;
  position: number;
  is_initial: boolean;
  is_won: boolean;
  is_lost: boolean;
}

export interface PipelineLite {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  is_default: boolean;
  stages: PipelineStageLite[];
}

/**
 * Carrega pipelines ativos do tenant com stages ordenadas.
 * Retorna array vazio se o tenant não configurou nenhum funil
 * (modo legado — IA opera apenas no campo `Lead.stage` String).
 */
export async function loadPipelinesForTenant(
  prisma: PrismaClient,
  tenantId: string | null | undefined,
): Promise<PipelineLite[]> {
  const pipelines = await (prisma as any).pipeline.findMany({
    where: {
      tenant_id: tenantId ?? null,
      is_active: true,
    },
    include: {
      stages: { orderBy: { position: 'asc' } },
    },
    orderBy: [{ is_default: 'desc' }, { position: 'asc' }, { created_at: 'asc' }],
  });
  return pipelines as PipelineLite[];
}

/**
 * Monta o bloco de texto que vai no system prompt da IA descrevendo
 * os funis e etapas disponíveis. A IA lê isso e escolhe slugs válidos
 * nas tools `respond_to_client` (updates.stage_slug) ou `update_lead`.
 *
 * Retorna string vazia se não há pipelines (modo legado).
 */
export function buildPipelinesPromptBlock(pipelines: PipelineLite[]): string {
  if (!pipelines || pipelines.length === 0) return '';

  const lines: string[] = [];
  lines.push('## FUNIS DISPONÍVEIS (CRM dinâmico)\n');
  lines.push(
    'O admin configurou os seguintes funis de atendimento. Identifique em qual o lead se encaixa',
    '(pelo tipo de demanda) e avance-o pelas etapas conforme a conversa progride.\n',
  );

  for (const p of pipelines) {
    lines.push(`### ${p.name} (slug: \`${p.slug}\`${p.is_default ? ', padrão' : ''})`);
    if (p.description) lines.push(p.description);
    lines.push('\n**Etapas** (ordem do atendimento):');
    for (const s of p.stages) {
      const flags: string[] = [];
      if (s.is_initial) flags.push('inicial');
      if (s.is_won) flags.push('ganho');
      if (s.is_lost) flags.push('perdido');
      const flagStr = flags.length ? ` [${flags.join(', ')}]` : '';
      const emoji = s.emoji ? `${s.emoji} ` : '';
      const desc = s.description ? ` — ${s.description}` : '';
      lines.push(`  - \`${s.slug}\` ${emoji}**${s.name}**${flagStr}${desc}`);
    }
    lines.push('');
  }

  lines.push('---');
  lines.push('**Regras de uso**:');
  lines.push(
    '- Ao receber o PRIMEIRO contato, classifique o lead escolhendo `pipeline_slug` apropriado.',
  );
  lines.push(
    '- Ao avançar a conversa, use `stage_slug` com o slug EXATO da próxima etapa do funil atual.',
  );
  lines.push(
    '- Só troque de funil se o interesse do lead mudar claramente (ex: veio buscando odonto mas agora só quer botox).',
  );
  lines.push('- Etapas marcadas `[ganho]` indicam conversão (cliente ativo); `[perdido]` é desistência.');
  lines.push('');

  return lines.join('\n');
}

/**
 * Resolve `stage_slug` / `pipeline_slug` retornados pela IA em IDs
 * concretos, e retorna o objeto de update pronto pro `prisma.lead.update`.
 *
 * Comportamento:
 *   - Se `pipeline_slug` informado: acha pipeline pelo slug no tenant.
 *     Se não achar, loga warning e usa o pipeline atual do lead.
 *   - Se `stage_slug` informado: acha stage pelo slug no pipeline resolvido
 *     (novo ou atual). Se não achar, retorna null (caller decide erro).
 *   - Mantém `Lead.stage` String legado sincronizado com slug.UPPERCASE
 *     para não quebrar código que ainda filtra por Lead.stage.
 *
 * Retorna `null` se não há nada pra atualizar OU se algum slug inválido.
 */
export async function resolveStageUpdate(
  prisma: PrismaClient,
  leadId: string,
  updates: { stage_slug?: string | null; pipeline_slug?: string | null },
): Promise<{
  pipeline_id?: string;
  stage_id?: string;
  stage?: string; // legado
  stage_entered_at?: Date;
} | null> {
  const hasStage = !!updates.stage_slug?.trim();
  const hasPipeline = !!updates.pipeline_slug?.trim();
  if (!hasStage && !hasPipeline) return null;

  const lead = await (prisma as any).lead.findUnique({
    where: { id: leadId },
    select: { tenant_id: true, pipeline_id: true, stage_id: true },
  });
  if (!lead) return null;

  let targetPipelineId = lead.pipeline_id;

  // Se IA trocou o pipeline, resolve
  if (hasPipeline) {
    const pipe = await (prisma as any).pipeline.findFirst({
      where: { slug: updates.pipeline_slug!.trim(), tenant_id: lead.tenant_id },
      select: { id: true },
    });
    if (pipe) targetPipelineId = pipe.id;
  }

  const result: any = {};
  if (targetPipelineId && targetPipelineId !== lead.pipeline_id) {
    result.pipeline_id = targetPipelineId;
  }

  if (hasStage) {
    if (!targetPipelineId) return Object.keys(result).length ? result : null;
    const stage = await (prisma as any).pipelineStage.findFirst({
      where: { slug: updates.stage_slug!.trim(), pipeline_id: targetPipelineId },
      select: { id: true, slug: true, name: true },
    });
    if (!stage) {
      // Slug inválido — caller decide como lidar (erro pra IA ver e retry).
      return Object.keys(result).length ? result : null;
    }
    if (stage.id !== lead.stage_id) {
      result.stage_id = stage.id;
      result.stage = stage.slug.toUpperCase().replace(/-/g, '_'); // legado sync
      result.stage_entered_at = new Date();
    }
  }

  return Object.keys(result).length ? result : null;
}

import type { PrismaClient } from '@prisma/client';
import {
  nearestStageIn,
  generalStageFromLegacy,
  generalStageFromSlug,
  generalStageOf,
  type GeneralStageKey,
} from '@crm/shared';

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
  is_hidden_from_kanban?: boolean;
}

export interface PipelineLite {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  is_default: boolean;
  stages: PipelineStageLite[];
}

/** Onde o contato está hoje no CRC — vai no prompt pra IA não reclassificar à toa. */
export interface LeadPipelinePosition {
  pipelineSlug: string | null;
  pipelineName: string | null;
  stageSlug: string | null;
  stageName: string | null;
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
 * Entra DEPOIS do texto da skill — as regras daqui corrigem slugs velhos que
 * as skills citam (endodontia, avaliacao-realizada...) e não existem.
 *
 * Retorna string vazia se não há pipelines (modo legado).
 */
export function buildPipelinesPromptBlock(
  pipelines: PipelineLite[],
  current?: LeadPipelinePosition | null,
): string {
  if (!pipelines || pipelines.length === 0) return '';

  const lines: string[] = [];
  lines.push('## FUNIS DISPONÍVEIS (CRC)\n');
  lines.push(
    'Cada tipo de tratamento tem o seu funil no CRC da clínica. Identifique a NECESSIDADE do paciente',
    'e lance o contato no funil certo; depois avance pelas etapas conforme a conversa progride.\n',
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
      if (s.is_hidden_from_kanban) flags.push('oculta');
      const flagStr = flags.length ? ` [${flags.join(', ')}]` : '';
      const emoji = s.emoji ? `${s.emoji} ` : '';
      const desc = s.description ? ` — ${s.description}` : '';
      lines.push(`  - \`${s.slug}\` ${emoji}**${s.name}**${flagStr}${desc}`);
    }
    lines.push('');
  }

  lines.push('---');
  if (current?.pipelineSlug) {
    lines.push(
      `**Onde este contato está agora:** funil \`${current.pipelineSlug}\` (${current.pipelineName ?? current.pipelineSlug})` +
        (current.stageSlug ? `, etapa \`${current.stageSlug}\` (${current.stageName ?? current.stageSlug}).` : ', sem etapa.'),
    );
  } else {
    lines.push('**Onde este contato está agora:** ainda sem funil — classifique nesta resposta.');
  }
  lines.push('**Regras de uso**:');
  lines.push(
    '- Assim que o paciente disser o que precisa (ex.: implante, aparelho, prótese, lente, faceta, clareamento, harmonização), mande `pipeline_slug` do funil daquele tratamento NA MESMA resposta — não espere o agendamento. Dor, limpeza, consulta, restauração ou dúvida geral → funil padrão.',
  );
  lines.push('- Se ele já está no funil certo, NÃO mande `pipeline_slug`.');
  lines.push(
    '- Só troque de funil se o interesse mudar claramente (ex.: veio por limpeza e agora quer implante).',
  );
  lines.push(
    '- Ao avançar a conversa, use `stage_slug` com o slug EXATO de uma etapa do funil em que o contato fica.',
  );
  lines.push(
    '- Use SÓ os slugs desta lista. Slugs citados em outras instruções que não aparecem aqui (ex.: endodontia, clinica_geral, periodontia, avaliacao-agendada, avaliacao-realizada, assinatura-contrato) NÃO existem — escolha o equivalente daqui.',
  );
  lines.push(
    '- Não mova para etapas `[ganho]` nem `[oculta]`: quem marca é a equipe/sistema quando o tratamento é fechado. `[perdido]` é desistência clara.',
  );
  lines.push('');

  return lines.join('\n');
}

/**
 * Acha o funil pelo slug que a IA devolveu. Tolera variação comum do modelo
 * ("implante" → `implantes`, "estetica" → `estetica-facial`), já que as skills
 * antigas citam slugs que não batem com os funis reais.
 */
export function findPipelineBySlug(
  pipelines: PipelineLite[],
  raw: string | null | undefined,
): PipelineLite | null {
  const slug = String(raw ?? '').trim();
  if (!slug) return null;
  const n = normSlug(slug);
  const exact = pipelines.find(p => p.slug === slug) ?? pipelines.find(p => normSlug(p.slug) === n);
  if (exact) return exact;
  if (n.length < 4) return null;
  return (
    pipelines.find(p => {
      const ps = normSlug(p.slug);
      return ps.length >= 4 && (ps.startsWith(n) || n.startsWith(ps));
    }) ??
    pipelines.find(p => normSlug(p.name).includes(n)) ??
    null
  );
}

function normSlug(s: string | null | undefined): string {
  return String(s ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .trim()
    .toLowerCase()
    .replace(/[_\s]+/g, '-');
}

/**
 * `Lead.stage` String legado a partir da etapa do funil. As etapas do funil
 * padrão usam o MESMO mapa do `legacyStageFromPipelineStage` da API (o arrastar
 * do kanban grava igual); o resto continua como antes (slug em maiúsculas).
 *
 * Etapa [ganho] NÃO vira FINALIZADO aqui: FINALIZADO com is_client=false some
 * com a conversa das abas do inbox, e quem gradua o paciente é a API.
 */
function legacyStageFor(stage: PipelineStageLite): string {
  if (stage.is_lost) return 'PERDIDO';
  if (stage.is_initial) return 'INICIAL';
  switch (stage.slug) {
    case 'qualificando': return 'QUALIFICANDO';
    case 'consulta-agendada': return 'REUNIAO_AGENDADA';
    case 'avaliacao-feita': return 'AGUARDANDO_DOCS';
    case 'orcamento-enviado': return 'AGUARDANDO_PROC';
    case 'em-fechamento': return 'EM_FECHAMENTO';
    default: return stage.slug.toUpperCase().replace(/-/g, '_');
  }
}

async function loadPipelineById(prisma: PrismaClient, id: string): Promise<PipelineLite | null> {
  return (prisma as any).pipeline.findUnique({
    where: { id },
    include: { stages: { orderBy: { position: 'asc' } } },
  });
}

/** O modelo às vezes preenche campo opcional com "null"/"none" em texto. */
function cleanSlug(raw: string | null | undefined): string {
  const s = String(raw ?? '').trim();
  return /^(null|none|undefined|n\/?a|-)$/i.test(s) ? '' : s;
}

/**
 * Etapa do funil `stages` pro slug que a IA mandou:
 *   - slug exato (ou só diferente em acento/_) → essa etapa;
 *   - slug de OUTRO funil conhecido (ex.: "qualificando" em Implantes) → a
 *     etapa equivalente (`inferred`);
 *   - slug inventado → null + aviso (NÃO vira a etapa inicial).
 * [ganho]/[oculta] quem marca é a equipe/sistema (tratamento fechado, orçamento
 * criado) — a IA mandando isso tirava o card do kanban sem ninguém fechar nada.
 */
function pickStageForSlug(
  stages: PipelineStageLite[],
  stageSlug: string,
  pipelineSlug: string,
): { stage: PipelineStageLite | null; inferred: boolean; warning: string | null } {
  let stage =
    stages.find(s => s.slug === stageSlug) ??
    stages.find(s => normSlug(s.slug) === normSlug(stageSlug)) ??
    null;
  let inferred = false;
  if (!stage) {
    const key = generalStageFromSlug(stageSlug);
    stage = key ? nearestStageIn(stages, key) : null;
    inferred = !!stage;
    if (!stage) return { stage: null, inferred, warning: `etapa "${stageSlug}" não existe no funil ${pipelineSlug}` };
  }
  if (stage.is_won || stage.is_hidden_from_kanban) {
    return { stage: null, inferred, warning: `etapa "${stage.slug}" é marcada pela equipe — ignorada` };
  }
  return { stage, inferred, warning: null };
}

export interface StageUpdateResult {
  /** Pronto pro `prisma.lead.update`; null = nada a mudar. */
  data: {
    pipeline_id?: string;
    stage_id?: string;
    stage?: string; // legado
    stage_entered_at?: Date;
  } | null;
  /** Funil/etapa de destino quando mudaram (pro log). */
  pipelineName?: string | null;
  stageName?: string | null;
  /** Slug que a IA mandou e não existe / foi ignorado. */
  warnings: string[];
}

/**
 * Resolve `stage_slug` / `pipeline_slug` devolvidos pela IA em `pipeline_id` /
 * `stage_id` concretos do Lead.
 *
 *   - `pipeline_slug`: acha o funil (tolerante, ver findPipelineBySlug). Slug
 *     que não existe → aviso e o lead fica no funil atual.
 *   - `stage_slug`: ver pickStageForSlug. Etapa só INFERIDA (slug de outro
 *     funil) nunca faz o lead voltar dentro do mesmo funil.
 *   - Trocou de funil sem etapa válida → etapa EQUIVALENTE à atual no funil
 *     novo (senão a inicial). Antes o `stage_id` ficava apontando pro funil
 *     antigo e o card sumia de todos os kanbans.
 *   - Lead sem funil (criado fora do WhatsApp) → funil padrão do tenant.
 *   - Contato em fechamento/ganho (etapa OU `Lead.stage` legado) → a IA não mexe.
 */
export async function resolveStageUpdate(
  prisma: PrismaClient,
  leadId: string,
  updates: { stage_slug?: string | null; pipeline_slug?: string | null },
): Promise<StageUpdateResult> {
  const warnings: string[] = [];
  const stageSlug = cleanSlug(updates.stage_slug);
  const pipelineSlug = cleanSlug(updates.pipeline_slug);
  if (!stageSlug && !pipelineSlug) return { data: null, warnings };

  const lead = await (prisma as any).lead.findUnique({
    where: { id: leadId },
    select: {
      tenant_id: true,
      pipeline_id: true,
      stage_id: true,
      stage: true,
      current_stage: {
        select: {
          id: true, slug: true, name: true, position: true, pipeline_id: true,
          is_initial: true, is_won: true, is_lost: true, is_hidden_from_kanban: true,
        },
      },
    },
  });
  if (!lead) return { data: null, warnings: ['lead não encontrado'] };

  // Contato já em fechamento (orçamento criado) ou ganho (tratamento/paciente
  // graduado): saiu do CRC pela mão da equipe/sistema — a IA não puxa de volta
  // nem troca de funil. Olha a etapa E o legado (lead antigo sem stage_id, ou
  // graduado pelo pagamento, que grava FINALIZADO sem mexer na etapa).
  const legacyKey = generalStageFromLegacy(lead.stage);
  if (
    lead.current_stage?.is_won ||
    lead.current_stage?.is_hidden_from_kanban ||
    legacyKey === 'ganho' ||
    legacyKey === 'fechamento'
  ) {
    return { data: null, warnings: [`contato em "${lead.current_stage?.slug ?? lead.stage}" — a IA não move`] };
  }

  const pipelines = await loadPipelinesForTenant(prisma, lead.tenant_id);
  const current: PipelineLite | null = lead.pipeline_id
    ? pipelines.find(p => p.id === lead.pipeline_id) ?? (await loadPipelineById(prisma, lead.pipeline_id))
    : null;

  let target: PipelineLite | null = current;
  if (pipelineSlug) {
    const found = findPipelineBySlug(pipelines, pipelineSlug);
    if (found) target = found;
    else warnings.push(`funil "${pipelineSlug}" não existe`);
  }
  if (!target) target = pipelines.find(p => p.is_default) ?? pipelines[0] ?? null;
  if (!target?.stages?.length) {
    warnings.push('nenhum funil ativo com etapas');
    return { data: null, warnings };
  }
  const targetStages = target.stages;
  const currentInTarget = lead.stage_id ? targetStages.find(s => s.id === lead.stage_id) ?? null : null;

  let stage: PipelineStageLite | null = null;
  if (stageSlug) {
    const pick = pickStageForSlug(targetStages, stageSlug, target.slug);
    if (pick.warning) warnings.push(pick.warning);
    stage = pick.stage;
    // Equivalente inferido que fica ANTES da etapa atual no mesmo funil: a IA
    // usou um slug velho/de outro funil — não é motivo pra regredir o card.
    if (stage && pick.inferred && currentInTarget && stage.position < currentInTarget.position) {
      warnings.push(`etapa "${stageSlug}" ≈ "${stage.slug}" fica antes da atual — ignorada`);
      stage = null;
    }
  }

  // Sem etapa válida e a etapa atual não é deste funil (troca de funil, ou o
  // card já estava "perdido" entre funis) → equivalente da atual, senão a inicial.
  if (!stage && !currentInTarget) {
    let key: GeneralStageKey = lead.current_stage
      ? generalStageOf(
          lead.current_stage,
          current && current.id === lead.current_stage.pipeline_id ? current.stages : undefined,
        )
      : legacyKey;
    // Lead perdido que voltou a falar (o webhook reativa só o `Lead.stage`; a
    // etapa continua na de perdido): reclassificado, vai pra conversa — não pro
    // "perdido" do funil novo, que o esconderia do inbox de novo.
    if (key === 'perdido' && legacyKey !== 'perdido') key = 'conversa';
    stage =
      nearestStageIn(targetStages, key) ??
      targetStages.find(s => s.is_initial) ??
      targetStages[0];
  }

  const data: NonNullable<StageUpdateResult['data']> = {};
  if (target.id !== lead.pipeline_id) data.pipeline_id = target.id;
  if (stage && stage.id !== lead.stage_id) {
    data.stage_id = stage.id;
    data.stage = legacyStageFor(stage);
    data.stage_entered_at = new Date();
  }

  return {
    data: Object.keys(data).length ? data : null,
    pipelineName: data.pipeline_id ? target.name : null,
    stageName: data.stage_id ? stage?.name ?? null : null,
    warnings,
  };
}

/**
 * Chat de teste (Ajustes › IA): em qual funil/etapa a IA lançaria um contato
 * NOVO (funil padrão, etapa inicial). Mesmas regras de slug do resolveStageUpdate;
 * não grava nada — só traduz pros nomes que a clínica vê no CRC.
 */
export function describeFunnelChoice(
  pipelines: PipelineLite[],
  updates: { stage_slug?: string | null; pipeline_slug?: string | null } | null | undefined,
): { pipeline: string | null; stage: string | null } | null {
  const pipelineSlug = cleanSlug(updates?.pipeline_slug);
  const stageSlug = cleanSlug(updates?.stage_slug);
  if (!pipelineSlug && !stageSlug) return null;
  const def = pipelines.find(p => p.is_default) ?? pipelines[0] ?? null;
  const found = pipelineSlug ? findPipelineBySlug(pipelines, pipelineSlug) : null;
  const target = found ?? def;
  let stageLabel: string | null = null;
  if (stageSlug && target) {
    const pick = pickStageForSlug(target.stages, stageSlug, target.slug);
    stageLabel = pick.stage
      ? pick.stage.name
      : `"${stageSlug}" (${pick.warning?.includes('equipe') ? 'só a equipe marca' : 'não existe'})`;
  } else if (found && found.id !== def?.id) {
    // Só trocou o funil: entra na etapa inicial do funil novo (contato novo).
    stageLabel = (found.stages.find(s => s.is_initial) ?? found.stages[0])?.name ?? null;
  }
  return {
    pipeline: pipelineSlug ? (found ? found.name : `"${pipelineSlug}" (não existe)`) : null,
    stage: stageLabel,
  };
}

import { Injectable, Logger, ConflictException, NotFoundException, BadRequestException } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { createHash } from 'crypto';
import OpenAI from 'openai';
import { PrismaService } from '../prisma/prisma.service';
import { SettingsService } from '../settings/settings.service';
import {
  DEFAULT_ORG_PROFILE_INCREMENTAL_PROMPT,
  DEFAULT_ORG_PROFILE_REBUILD_PROMPT,
  DEFAULT_ORG_MODEL,
  AVAILABLE_ORG_MODELS,
} from './memory-prompts-defaults';
import { applyMemoryVarsMigration } from './skill-migration.util';
import { cleanHardcodedOrgInfo } from './skill-cleanup.util';
import {
  ORG_MEMORY_SUBCATEGORIES,
  LEGACY_ORG_MEMORY_SUBCATEGORIES,
  internalOrgMemoryReason,
  orgMemoryPriceReason,
} from '@crm/shared';

const ORG_PROFILE_DEBOUNCE_MS = 60_000; // 60s — evita regenerar a cada edit

// Base de Conhecimento da clínica — contrato em packages/shared/src/memory-categories.ts.
// Criar: só as categorias novas. Editar: aceita também as antigas do sistema
// jurídico (fees, court_info, legal_knowledge, contacts) — memórias já gravadas.
const CREATE_ORG_SUBCATEGORIES = new Set<string>(ORG_MEMORY_SUBCATEGORIES);
const EDIT_ORG_SUBCATEGORIES = new Set<string>([
  ...ORG_MEMORY_SUBCATEGORIES,
  ...LEGACY_ORG_MEMORY_SUBCATEGORIES,
]);

const DUPLICATE_THRESHOLD = 0.9;

// ─── Revisão da Base de Conhecimento (POST /memories/organization/review) ────

export type OrgMemoryReviewKind =
  | 'interno'
  | 'paciente'
  | 'juridico'
  | 'preco'
  | 'pontual'
  | 'duplicada'
  | 'errada';

export interface OrgMemoryReviewSuggestion {
  id: string;
  content: string;
  subcategory: string | null;
  kind: OrgMemoryReviewKind;
  reason: string;
  /** Só em kind='duplicada': id da memória que FICA (a outra cópia). */
  duplicate_of?: string;
}

const REVIEW_KINDS = new Set<OrgMemoryReviewKind>([
  'interno',
  'paciente',
  'juridico',
  'preco',
  'pontual',
  'duplicada',
  'errada',
]);
const REVIEW_MODEL = 'gpt-4.1-mini';
const REVIEW_MAX_AI_MEMORIES = 200; // por chamada — o resto fica só no filtro determinístico
const REVIEW_MAX_CONTENT_CHARS = 600; // corta memória gigante antes de mandar pra IA
const REVIEW_AI_TIMEOUT_MS = 60_000;
// Preço no texto: mesma regra da extração (orgMemoryPriceReason em @crm/shared).
// Esta constante só é o motivo padrão quando a IA aponta "preco" sem motivo.
const PRICE_REASON = 'Tem preço — preços ficam em Ajustes IA › Valores';
const MAX_BULK_IDS = 500;

/** O que o CRUD fez com o resumo da clínica (OrganizationProfile) — a tela avisa. */
export type OrgProfileRegenOutcome = 'regen_queued' | 'skipped_manual' | 'none';

/**
 * Motivo do filtro determinístico (internalOrgMemoryReason) → kind da revisão.
 * Casa por trecho do texto do motivo (packages/shared/src/memory-categories.ts).
 */
function reviewKindForInternalReason(reason: string): OrgMemoryReviewKind {
  if (/jur[ií]dic/i.test(reason)) return 'juridico';
  if (/paciente/i.test(reason)) return 'paciente';
  if (/agenda de um dia/i.test(reason)) return 'pontual';
  if (/assistente virtual/i.test(reason)) return 'errada';
  return 'interno';
}

const REVIEW_AI_PROMPT = `Você revisa a BASE DE CONHECIMENTO de uma CLÍNICA ODONTOLÓGICA. Cada memória deveria ser um fato
DURÁVEL da clínica que ajuda a assistente virtual a atender QUALQUER paciente (endereço, equipe,
como atendemos, tratamentos, formas de pagamento, regras).

Recebe { "memories": [ { "n": número, "subcategory": "...", "content": "..." } ] }.

Aponte APENAS as memórias que devem sair, com um destes "kind":
- "pontual": agenda ou fato de um dia específico (ex.: "hoje só a Dra. X atende", "amanhã não tem horário",
  "dia 12 a clínica fecha mais cedo") — não é regra da clínica.
- "duplicada": diz a mesma coisa que outra memória da lista. Informe em "keep" o "n" da memória que FICA
  (a mais completa). Nunca aponte as duas cópias.
- "errada": claramente errada, sem sentido ou que contradiz outra memória mais confiável/completa.
- "paciente": fato sobre UM paciente específico (nome, caso, consulta dele).
- "interno": dado interno da equipe (caixa, vendas, cobrança, estoque, RH, recados internos).
- "preco": traz preço/valor/desconto (preços ficam em outro lugar). Forma de pagamento ou parcelamento
  SEM valor não é preço.
- "juridico": sobra de sistema jurídico (advogado, fórum, processo, honorários, OAB).

Na dúvida, NÃO aponte. Não reescreva nada.

Responda APENAS JSON:
{ "suggestions": [ { "n": 3, "kind": "pontual", "reason": "motivo curto em português", "keep": null } ] }
Se nada deve sair: { "suggestions": [] }`;

/**
 * MemoriesService (API)
 * ─────────────────────
 * CRUD de memorias (lead + organization) e LeadProfile.
 * Usa o mesmo modelo de embedding do worker (text-embedding-3-small).
 *
 * Nota: para manualmente disparar a extracao batch, dispomos de um endpoint
 * que enfileira um job na queue 'memory-jobs' (consumida pelo worker).
 */
@Injectable()
export class MemoriesService {
  private readonly logger = new Logger(MemoriesService.name);
  private openaiClient: OpenAI | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
    @InjectQueue('memory-jobs') private readonly memoryQueue: Queue,
  ) {}

  /**
   * Enfileira regeneracao debounced do OrganizationProfile apos CRUD.
   * Usa jobId com minuto truncado: varias edicoes em 60s resultam no mesmo
   * jobId (BullMQ deduplica e mantem so o primeiro).
   *
   * Resumo EDITADO À MÃO (manually_edited_at) não é tocado: o job do worker
   * ('consolidate-org-profile' → consolidateIncremental) NÃO olha esse flag (só o
   * cron das 02h olha), então enfileirar aqui reescrevia o texto do admin ~60s
   * depois de criar/editar/apagar/arquivar memória. As mudanças não se perdem:
   * last_incorporated_at não avança, e o "Regenerar" (que limpa o flag) aplica
   * tudo de uma vez.
   *
   * Devolve o que fez: 'regen_queued' | 'skipped_manual' | 'none'. Com
   * `requireProfile` (arquivar/restaurar), sem perfil gerado não enfileira
   * ('none') — não há resumo a atualizar; o cron das 02h gera o primeiro.
   * Sem a opção (criar/editar/apagar) segue enfileirando: gera o 1º resumo.
   */
  private async triggerOrgProfileRegen(
    tenantId: string,
    reason: string,
    opts: { requireProfile?: boolean } = {},
  ): Promise<OrgProfileRegenOutcome> {
    try {
      const profile = await this.prisma.organizationProfile.findUnique({
        where: { tenant_id: tenantId },
        select: { manually_edited_at: true },
      });
      if (profile?.manually_edited_at) {
        this.logger.log(
          `[OrgProfile] Tenant ${tenantId}: resumo editado à mão — regen automática pulada (${reason})`,
        );
        return 'skipped_manual';
      }
      if (!profile && opts.requireProfile) return 'none';
      const bucket = Math.floor(Date.now() / ORG_PROFILE_DEBOUNCE_MS);
      const jobId = `org-profile-${tenantId}-${bucket}`;
      await this.memoryQueue.add(
        'consolidate-org-profile',
        { tenant_id: tenantId, reason },
        {
          jobId,
          delay: ORG_PROFILE_DEBOUNCE_MS,
          removeOnComplete: true,
          attempts: 2,
        },
      );
      return 'regen_queued';
    } catch (e: any) {
      // Nao bloqueia o CRUD se a fila falhar
      this.logger.warn(`[OrgProfile] Falha ao enfileirar regen: ${e.message}`);
      return 'none';
    }
  }

  /**
   * Cancela a regen debounced ainda PENDENTE desta clínica (criada no minuto
   * atual ou no anterior — o delay é 60s). Usado quando o admin salva o resumo à
   * mão: sem isso, um job enfileirado segundos antes (ex.: arquivou memórias)
   * rodaria depois e reescreveria o texto recém-editado. Job já em execução
   * (locked) não sai — remove() devolve 0.
   */
  private async cancelPendingOrgProfileRegen(tenantId: string) {
    const bucket = Math.floor(Date.now() / ORG_PROFILE_DEBOUNCE_MS);
    for (const b of [bucket, bucket - 1]) {
      try {
        await this.memoryQueue.remove(`org-profile-${tenantId}-${b}`);
      } catch (e: any) {
        this.logger.warn(`[OrgProfile] Falha ao cancelar regen pendente: ${e.message}`);
      }
    }
  }

  /** Cliente OpenAI ou null quando não há chave (sem lançar — a revisão segue sem IA). */
  private async getOpenAIOrNull(): Promise<OpenAI | null> {
    try {
      return await this.getOpenAI();
    } catch {
      return null;
    }
  }

  /** ids do corpo das rotas em lote: array de strings, sem repetição, máx. 500. */
  private normalizeIds(ids: unknown): string[] {
    if (!Array.isArray(ids)) throw new BadRequestException('ids deve ser uma lista');
    if (ids.length === 0) throw new BadRequestException('Informe ao menos 1 id');
    if (ids.length > MAX_BULK_IDS) {
      throw new BadRequestException(`Máximo de ${MAX_BULK_IDS} ids por vez`);
    }
    const out = new Set<string>();
    for (const raw of ids) {
      if (typeof raw !== 'string' || !raw.trim() || raw.length > 64) {
        throw new BadRequestException('ids inválidos');
      }
      out.add(raw.trim());
    }
    return [...out];
  }

  private async getOpenAI(): Promise<OpenAI> {
    if (this.openaiClient) return this.openaiClient;
    const key = (await this.settings.get('OPENAI_API_KEY')) || process.env.OPENAI_API_KEY || null;
    if (!key) throw new BadRequestException('OPENAI_API_KEY nao configurado nas settings');
    this.openaiClient = new OpenAI({ apiKey: key });
    return this.openaiClient;
  }

  private async generateEmbedding(text: string): Promise<number[]> {
    const client = await this.getOpenAI();
    const response = await client.embeddings.create({
      model: 'text-embedding-3-small',
      input: text,
      dimensions: 1536,
    });
    return response.data[0].embedding;
  }

  private toVectorLiteral(emb: number[]): string {
    return `[${emb.join(',')}]`;
  }

  private async findDuplicate(params: {
    tenantId: string;
    scope: 'lead' | 'organization';
    scopeId: string;
    embedding: number[];
  }): Promise<{ id: string; content: string } | null> {
    const vec = this.toVectorLiteral(params.embedding);
    const rows = await this.prisma.$queryRawUnsafe<any[]>(
      `
      SELECT id, content, 1 - (embedding <=> $1::vector) AS similarity
      FROM "Memory"
      WHERE tenant_id = $2
        AND scope = $3
        AND scope_id = $4
        AND status = 'active'
        AND embedding IS NOT NULL
      ORDER BY embedding <=> $1::vector
      LIMIT 1
      `,
      vec,
      params.tenantId,
      params.scope,
      params.scopeId,
    );
    if (rows.length === 0) return null;
    if (Number(rows[0].similarity) < DUPLICATE_THRESHOLD) return null;
    return { id: rows[0].id, content: rows[0].content };
  }

  // ─── Organization memories ────────────────────────────────

  /**
   * Lista as memórias da clínica agrupadas por subcategoria.
   * `status`: 'active' (padrão) ou 'archived' (aba "Arquivadas" — dá pra restaurar).
   */
  async listOrganization(tenantId: string, status: string = 'active') {
    if (status !== 'active' && status !== 'archived') {
      throw new BadRequestException('status invalido. Opcoes: active, archived');
    }
    if (!tenantId) return { groups: {}, total: 0 };
    const memories = await this.prisma.memory.findMany({
      where: {
        tenant_id: tenantId,
        scope: 'organization',
        scope_id: tenantId,
        status,
      },
      orderBy: [{ subcategory: 'asc' }, { created_at: 'desc' }],
      select: {
        id: true,
        content: true,
        subcategory: true,
        confidence: true,
        source_type: true,
        created_at: true,
        updated_at: true,
      },
    });

    const groups: Record<string, typeof memories> = {};
    for (const m of memories) {
      const key = m.subcategory || 'geral';
      if (!groups[key]) groups[key] = [];
      groups[key].push(m);
    }

    return { groups, total: memories.length };
  }

  async createOrganization(tenantId: string, body: { content: string; subcategory: string; confidence?: number }) {
    if (!tenantId) throw new BadRequestException('tenant_id obrigatorio');
    const content = (body.content || '').trim();
    if (content.length < 5) throw new BadRequestException('content muito curto');
    const subcategory = (body.subcategory || '').trim();
    if (!CREATE_ORG_SUBCATEGORIES.has(subcategory)) {
      throw new BadRequestException(`subcategory invalida. Opcoes: ${[...CREATE_ORG_SUBCATEGORIES].join(', ')}`);
    }

    const embedding = await this.generateEmbedding(content);
    const dup = await this.findDuplicate({
      tenantId,
      scope: 'organization',
      scopeId: tenantId,
      embedding,
    });
    if (dup) {
      throw new ConflictException(`Ja existe memoria similar: "${dup.content}"`);
    }

    const confidence = typeof body.confidence === 'number' ? body.confidence : 1.0;
    await this.prisma.$executeRawUnsafe(
      `
      INSERT INTO "Memory" (
        id, tenant_id, scope, scope_id, type, subcategory, content, embedding,
        source_type, confidence, status, created_at, updated_at
      ) VALUES (
        gen_random_uuid(), $1, 'organization', $1, 'semantic', $2, $3, $4::vector,
        'manual', $5, 'active', NOW(), NOW()
      )
      `,
      tenantId,
      subcategory,
      content,
      this.toVectorLiteral(embedding),
      confidence,
    );
    await this.triggerOrgProfileRegen(tenantId, 'create-org');
    return { success: true };
  }

  async updateMemory(id: string, tenantId: string, body: { content?: string; subcategory?: string }) {
    const existing = await this.prisma.memory.findFirst({
      where: { id, tenant_id: tenantId },
    });
    if (!existing) throw new NotFoundException('Memoria nao encontrada');

    const patch: any = { updated_at: new Date() };
    if (typeof body.content === 'string' && body.content.trim().length >= 5) {
      patch.content = body.content.trim();
    }
    if (typeof body.subcategory === 'string' && existing.scope === 'organization') {
      const sub = body.subcategory.trim();
      if (!EDIT_ORG_SUBCATEGORIES.has(sub)) {
        throw new BadRequestException('subcategory invalida');
      }
      patch.subcategory = sub;
    }

    // Se content mudou, regenera embedding
    if (patch.content) {
      const emb = await this.generateEmbedding(patch.content);
      await this.prisma.$executeRawUnsafe(
        `
        UPDATE "Memory" SET
          content = $1,
          subcategory = COALESCE($2, subcategory),
          embedding = $3::vector,
          updated_at = NOW()
        WHERE id = $4 AND tenant_id = $5
        `,
        patch.content,
        patch.subcategory ?? null,
        this.toVectorLiteral(emb),
        id,
        tenantId,
      );
    } else {
      await this.prisma.memory.update({ where: { id }, data: patch });
    }
    if (existing.scope === 'organization') {
      await this.triggerOrgProfileRegen(tenantId, 'update-org');
    }
    return { success: true };
  }

  async deleteMemory(id: string, tenantId: string) {
    const existing = await this.prisma.memory.findFirst({
      where: { id, tenant_id: tenantId },
    });
    if (!existing) throw new NotFoundException('Memoria nao encontrada');
    await this.prisma.memory.delete({ where: { id } });
    if (existing.scope === 'organization') {
      await this.triggerOrgProfileRegen(tenantId, 'delete-org');
    }
    return { success: true };
  }

  // ─── Arquivar / restaurar em lote (limpeza da Base de Conhecimento) ──────

  /**
   * Arquiva memórias da clínica (status active → archived). Só toca ids DESTA
   * clínica, scope organization, ainda ativos — id de outra clínica/lead é
   * ignorado em silêncio. Arquivada sai do prompt da IA e a regen incremental a
   * trata como "removida" (retira do resumo), salvo resumo editado à mão.
   */
  async archiveOrganizationMemories(tenantId: string, ids: unknown) {
    if (!tenantId) throw new BadRequestException('tenant_id obrigatorio');
    const clean = this.normalizeIds(ids);
    const res = await this.prisma.memory.updateMany({
      where: {
        id: { in: clean },
        tenant_id: tenantId,
        scope: 'organization',
        scope_id: tenantId,
        status: 'active',
      },
      data: { status: 'archived', updated_at: new Date() },
    });
    const summary: OrgProfileRegenOutcome =
      res.count > 0
        ? await this.triggerOrgProfileRegen(tenantId, 'archive-org', { requireProfile: true })
        : 'none';
    return { archived: res.count, summary };
  }

  /**
   * Restaura memórias arquivadas (archived → active), mesmas travas do arquivar.
   * Superseded (substituída pela extração) não volta por aqui.
   */
  async restoreOrganizationMemories(tenantId: string, ids: unknown) {
    if (!tenantId) throw new BadRequestException('tenant_id obrigatorio');
    const clean = this.normalizeIds(ids);
    const res = await this.prisma.memory.updateMany({
      where: {
        id: { in: clean },
        tenant_id: tenantId,
        scope: 'organization',
        scope_id: tenantId,
        status: 'archived',
      },
      data: { status: 'active', updated_at: new Date() },
    });
    const summary: OrgProfileRegenOutcome =
      res.count > 0
        ? await this.triggerOrgProfileRegen(tenantId, 'restore-org', { requireProfile: true })
        : 'none';
    return { restored: res.count, summary };
  }

  /**
   * Revisão da Base de Conhecimento — NÃO altera nada, só sugere o que arquivar.
   *   1) filtro determinístico (internalOrgMemoryReason, com a subcategoria):
   *      interno / paciente / jurídico / agenda de um dia (pontual) / IA na
   *      equipe (errada);
   *   2) categoria antiga court_info → jurídico; preço no texto
   *      (orgMemoryPriceReason — mesma regra da extração) ou fees → preço;
   *   3) se houver chave OpenAI: UMA chamada (gpt-4.1-mini, JSON) com o resto,
   *      apontando pontual / duplicada / errada (e o que escapou do filtro).
   * O admin escolhe o que arquivar (POST /memories/organization/archive).
   */
  async reviewOrganizationMemories(tenantId: string) {
    if (!tenantId) throw new BadRequestException('tenant_id obrigatorio');
    const memories = await this.prisma.memory.findMany({
      where: {
        tenant_id: tenantId,
        scope: 'organization',
        scope_id: tenantId,
        status: 'active',
      },
      orderBy: [{ subcategory: 'asc' }, { created_at: 'desc' }],
      select: { id: true, content: true, subcategory: true },
    });

    const flagged = new Map<string, OrgMemoryReviewSuggestion>();
    const flag = (
      m: { id: string; content: string; subcategory: string | null },
      kind: OrgMemoryReviewKind,
      reason: string,
      duplicateOf?: string,
    ) => {
      flagged.set(m.id, {
        id: m.id,
        content: m.content,
        subcategory: m.subcategory,
        kind,
        reason,
        ...(duplicateOf ? { duplicate_of: duplicateOf } : {}),
      });
    };

    // Passos 1 e 2 — determinísticos
    for (const m of memories) {
      const internal = internalOrgMemoryReason(m.content, m.subcategory);
      const price = internal ? null : orgMemoryPriceReason(m.content);
      if (internal) {
        flag(m, reviewKindForInternalReason(internal), internal);
      } else if (m.subcategory === 'court_info') {
        flag(m, 'juridico', 'Categoria antiga do sistema jurídico (fóruns) — não serve para a clínica');
      } else if (price) {
        flag(m, 'preco', price);
      } else if (m.subcategory === 'fees') {
        flag(m, 'preco', 'Categoria antiga "Valores" — preços ficam em Ajustes IA › Valores');
      }
    }

    // Passo 3 — IA (opcional)
    const rest = memories.filter((m) => !flagged.has(m.id));
    const ai = { status: 'ok' as 'ok' | 'sem_chave' | 'erro' | 'nada_a_revisar', checked: 0 };
    if (rest.length === 0) {
      ai.status = 'nada_a_revisar';
    } else {
      const client = await this.getOpenAIOrNull();
      if (!client) {
        ai.status = 'sem_chave';
      } else {
        const batch = rest.slice(0, REVIEW_MAX_AI_MEMORIES);
        try {
          const aiItems = await this.reviewWithAI(client, batch);
          ai.checked = batch.length;
          const byN = new Map(batch.map((m, i) => [i + 1, m]));
          const dupes: { m: (typeof batch)[number]; keep: (typeof batch)[number]; reason: string }[] = [];
          for (const it of aiItems) {
            const m = byN.get(it.n);
            if (!m || flagged.has(m.id)) continue;
            if (it.kind === 'duplicada') {
              const keep = it.keep != null ? byN.get(it.keep) : undefined;
              if (keep && keep.id !== m.id) dupes.push({ m, keep, reason: it.reason });
              continue;
            }
            flag(m, it.kind, it.reason || this.defaultReviewReason(it.kind));
          }
          // Duplicadas por último: nunca arquivar a cópia que deveria ficar
          // (nem as duas de um par A↔B). Se a "que fica" já saiu como duplicada
          // de outra, aponta pra essa outra.
          const kept = new Set<string>();
          const dupOf = new Map<string, string>();
          for (const d of dupes) {
            if (flagged.has(d.m.id) || kept.has(d.m.id)) continue;
            let keepId = d.keep.id;
            if (dupOf.has(keepId)) keepId = dupOf.get(keepId)!;
            if (keepId === d.m.id || flagged.has(keepId)) continue;
            const keepMem = memories.find((x) => x.id === keepId);
            if (!keepMem) continue;
            const snippet = keepMem.content.length > 80 ? `${keepMem.content.slice(0, 80)}…` : keepMem.content;
            const base = d.reason || this.defaultReviewReason('duplicada');
            flag(d.m, 'duplicada', `${base} (fica: "${snippet}")`, keepId);
            dupOf.set(d.m.id, keepId);
            kept.add(keepId);
          }
        } catch (e: any) {
          ai.status = 'erro';
          this.logger.warn(`[OrgReview] Tenant ${tenantId}: revisão por IA falhou: ${e.message}`);
        }
      }
    }

    // Ordem da lista (subcategoria, mais recente primeiro)
    const suggestions = memories.filter((m) => flagged.has(m.id)).map((m) => flagged.get(m.id)!);
    return {
      reviewed: memories.length,
      suggestions,
      ai: { ...ai, model: REVIEW_MODEL, limit: REVIEW_MAX_AI_MEMORIES, not_checked: rest.length - ai.checked },
    };
  }

  private defaultReviewReason(kind: OrgMemoryReviewKind): string {
    switch (kind) {
      case 'pontual':
        return 'Fato de um dia específico, não é regra da clínica';
      case 'duplicada':
        return 'Repete outra memória';
      case 'errada':
        return 'Parece errada ou contraditória';
      case 'paciente':
        return 'Sobre um paciente específico';
      case 'interno':
        return 'Dado interno da equipe';
      case 'preco':
        return PRICE_REASON;
      case 'juridico':
        return 'Sobra do sistema jurídico';
    }
  }

  /**
   * Uma chamada à IA com as memórias (numeradas 1..N — o modelo não vê o uuid).
   * Devolve só itens válidos: n existente, kind conhecido, motivo curto.
   */
  private async reviewWithAI(
    client: OpenAI,
    batch: { id: string; content: string; subcategory: string | null }[],
  ): Promise<{ n: number; kind: OrgMemoryReviewKind; reason: string; keep: number | null }[]> {
    const payload = {
      memories: batch.map((m, i) => ({
        n: i + 1,
        subcategory: m.subcategory || null,
        content:
          m.content.length > REVIEW_MAX_CONTENT_CHARS
            ? `${m.content.slice(0, REVIEW_MAX_CONTENT_CHARS)}…`
            : m.content,
      })),
    };
    const response = await client.chat.completions.create(
      {
        model: REVIEW_MODEL,
        messages: [
          { role: 'system', content: REVIEW_AI_PROMPT },
          { role: 'user', content: JSON.stringify(payload) },
        ],
        response_format: { type: 'json_object' },
        max_completion_tokens: 4000,
        temperature: 0.1,
      },
      { timeout: REVIEW_AI_TIMEOUT_MS, maxRetries: 0 },
    );
    const raw = response.choices[0]?.message?.content;
    if (!raw) throw new Error('resposta vazia');
    const parsed = JSON.parse(raw);
    const list: any[] = Array.isArray(parsed?.suggestions) ? parsed.suggestions : [];
    const out: { n: number; kind: OrgMemoryReviewKind; reason: string; keep: number | null }[] = [];
    const seen = new Set<number>();
    for (const s of list) {
      const n = Number(s?.n);
      const kind = typeof s?.kind === 'string' ? (s.kind.trim().toLowerCase() as OrgMemoryReviewKind) : null;
      if (!Number.isInteger(n) || n < 1 || n > batch.length || seen.has(n)) continue;
      if (!kind || !REVIEW_KINDS.has(kind)) continue;
      const keepNum = Number(s?.keep);
      const keep = Number.isInteger(keepNum) && keepNum >= 1 && keepNum <= batch.length ? keepNum : null;
      const reason = typeof s?.reason === 'string' ? s.reason.trim().slice(0, 200) : '';
      seen.add(n);
      out.push({ n, kind, reason, keep });
    }
    return out;
  }

  // ─── Organization Profile (consolidado em prosa) ─────────

  async getOrganizationProfile(tenantId: string) {
    if (!tenantId) return null;
    const profile = await this.prisma.organizationProfile.findUnique({
      where: { tenant_id: tenantId },
    });
    return profile || null;
  }

  /**
   * Regen INCREMENTAL imediata (modo padrao).
   * Se houver edicao manual, limpa o flag primeiro — admin abdicou dela ao
   * clicar "Regenerar". Atualizacao cirurgica: LLM recebe summary + mudancas
   * desde a ultima incorporacao.
   */
  async regenerateOrganizationProfile(tenantId: string) {
    if (!tenantId) throw new BadRequestException('tenant_id obrigatorio');
    await this.prisma.organizationProfile.updateMany({
      where: { tenant_id: tenantId, manually_edited_at: { not: null } },
      data: { manually_edited_at: null },
    });
    const jobId = `org-profile-force-${tenantId}-${Date.now()}`;
    await this.memoryQueue.add(
      'consolidate-org-profile',
      { tenant_id: tenantId, reason: 'manual-force' },
      { jobId, removeOnComplete: true, attempts: 2 },
    );
    return { success: true, job_id: jobId, mode: 'incremental' };
  }

  /**
   * Refazer do ZERO — descarta summary atual e regenera a partir de todas
   * as memorias ativas. Usado pelo botao "Refazer do zero" (operacao cara
   * e irreversivel — perde qualquer edicao manual e o texto atual).
   */
  async rebuildOrganizationProfile(tenantId: string) {
    if (!tenantId) throw new BadRequestException('tenant_id obrigatorio');
    await this.prisma.organizationProfile.updateMany({
      where: { tenant_id: tenantId, manually_edited_at: { not: null } },
      data: { manually_edited_at: null },
    });
    const jobId = `org-profile-rebuild-${tenantId}-${Date.now()}`;
    await this.memoryQueue.add(
      'rebuild-org-profile',
      { tenant_id: tenantId, reason: 'manual-rebuild' },
      { jobId, removeOnComplete: true, attempts: 2 },
    );
    return { success: true, job_id: jobId, mode: 'from-scratch' };
  }

  /**
   * Atualiza o texto do OrganizationProfile manualmente (edicao do admin).
   * Marca `manually_edited_at` para proteger contra sobrescrita (cron das 02h e
   * regen apos mexer em memoria). Se o perfil ainda nao existe (clinica sem
   * memorias, ou nunca gerado), CRIA com o texto do admin.
   */
  async updateOrganizationProfileSummary(tenantId: string, summary: string) {
    if (!tenantId) throw new BadRequestException('tenant_id obrigatorio');
    const clean = (typeof summary === 'string' ? summary : '').trim();
    if (clean.length < 50) {
      throw new BadRequestException('Resumo muito curto (min. 50 caracteres)');
    }
    if (clean.length > 10000) {
      throw new BadRequestException('Resumo muito longo (max. 10.000 caracteres)');
    }
    const now = new Date();
    const updated = await this.prisma.organizationProfile.upsert({
      where: { tenant_id: tenantId },
      create: {
        tenant_id: tenantId,
        summary: clean,
        generated_at: now,
        manually_edited_at: now,
        // Resumo escrito à mão do zero não incorporou memória nenhuma: o 1º
        // "Regenerar" (incremental, since = last_incorporated_at) precisa
        // mesclar TODAS as que já existiam, não só as criadas depois de agora.
        last_incorporated_at: new Date(0),
      },
      update: {
        summary: clean,
        version: { increment: 1 },
        generated_at: now,
        manually_edited_at: now,
      },
    });
    // Regen debounced que ja estava na fila (ex.: arquivou memorias segundos
    // antes) reescreveria o texto recem-salvo — cancela.
    await this.cancelPendingOrgProfileRegen(tenantId);
    return updated;
  }

  async getOrganizationStats(tenantId: string) {
    if (!tenantId) return { total: 0, by_subcategory: {}, last_extraction: null };
    const memories = await this.prisma.memory.findMany({
      where: {
        tenant_id: tenantId,
        scope: 'organization',
        scope_id: tenantId,
        status: 'active',
      },
      select: { subcategory: true, source_type: true, created_at: true },
    });

    const bySubcategory: Record<string, number> = {};
    let lastBatch: Date | null = null;
    for (const m of memories) {
      const key = m.subcategory || 'geral';
      bySubcategory[key] = (bySubcategory[key] || 0) + 1;
      if (m.source_type === 'batch' && (!lastBatch || m.created_at > lastBatch)) {
        lastBatch = m.created_at;
      }
    }
    return { total: memories.length, by_subcategory: bySubcategory, last_extraction: lastBatch };
  }

  // ─── Lead memories ────────────────────────────────────────

  async listLead(tenantId: string, leadId: string) {
    const memories = await this.prisma.memory.findMany({
      where: {
        tenant_id: tenantId,
        scope: 'lead',
        scope_id: leadId,
        status: 'active',
      },
      orderBy: { created_at: 'desc' },
      select: {
        id: true,
        content: true,
        type: true,
        confidence: true,
        source_type: true,
        created_at: true,
      },
    });
    return { memories, total: memories.length };
  }

  async getLeadProfile(tenantId: string, leadId: string) {
    const profile = await this.prisma.leadProfile.findFirst({
      where: { tenant_id: tenantId, lead_id: leadId },
    });
    return profile || null;
  }

  async createLeadMemory(tenantId: string, leadId: string, body: { content: string; type?: string }) {
    const content = (body.content || '').trim();
    if (content.length < 5) throw new BadRequestException('content muito curto');
    const type = body.type === 'episodic' ? 'episodic' : 'semantic';

    const embedding = await this.generateEmbedding(content);
    const dup = await this.findDuplicate({
      tenantId,
      scope: 'lead',
      scopeId: leadId,
      embedding,
    });
    if (dup) throw new ConflictException(`Ja existe memoria similar: "${dup.content}"`);

    await this.prisma.$executeRawUnsafe(
      `
      INSERT INTO "Memory" (
        id, tenant_id, scope, scope_id, type, content, embedding,
        source_type, confidence, status, created_at, updated_at
      ) VALUES (
        gen_random_uuid(), $1, 'lead', $2, $3, $4, $5::vector,
        'manual', 1.0, 'active', NOW(), NOW()
      )
      `,
      tenantId,
      leadId,
      type,
      content,
      this.toVectorLiteral(embedding),
    );
    return { success: true };
  }

  async deleteAllLeadMemories(tenantId: string, leadId: string) {
    const deleted = await this.prisma.memory.deleteMany({
      where: { tenant_id: tenantId, scope: 'lead', scope_id: leadId },
    });
    await this.prisma.leadProfile.deleteMany({
      where: { tenant_id: tenantId, lead_id: leadId },
    });
    return { success: true, deleted_count: deleted.count };
  }

  // ─── Configuracoes do OrganizationProfile (prompt + modelo) ──────

  /**
   * Le configuracoes atuais do pipeline de consolidacao do OrgProfile.
   * Retorna valores customizados (se admin editou via UI) + defaults (sempre
   * expostos para o frontend mostrar "restaurar padrao").
   *
   * Keys GlobalSetting:
   *   - MEMORY_ORG_MODEL: modelo usado (ex: gpt-4.1). Fallback: MEMORY_EXTRACTION_MODEL
   *   - MEMORY_ORG_INCREMENTAL_PROMPT: prompt da atualizacao incremental
   *   - MEMORY_ORG_REBUILD_PROMPT: prompt do "Refazer do zero"
   */
  async getOrganizationProfileSettings() {
    const [modelPrimary, modelLegacy, customIncremental, customRebuild] =
      await Promise.all([
        this.prisma.globalSetting.findUnique({ where: { key: 'MEMORY_ORG_MODEL' } }),
        this.prisma.globalSetting.findUnique({ where: { key: 'MEMORY_EXTRACTION_MODEL' } }),
        this.prisma.globalSetting.findUnique({ where: { key: 'MEMORY_ORG_INCREMENTAL_PROMPT' } }),
        this.prisma.globalSetting.findUnique({ where: { key: 'MEMORY_ORG_REBUILD_PROMPT' } }),
      ]);

    return {
      model: modelPrimary?.value || modelLegacy?.value || DEFAULT_ORG_MODEL,
      model_default: DEFAULT_ORG_MODEL,
      available_models: AVAILABLE_ORG_MODELS,
      incremental_prompt: customIncremental?.value || '',
      incremental_prompt_default: DEFAULT_ORG_PROFILE_INCREMENTAL_PROMPT,
      incremental_is_custom: !!(customIncremental?.value && customIncremental.value.trim()),
      rebuild_prompt: customRebuild?.value || '',
      rebuild_prompt_default: DEFAULT_ORG_PROFILE_REBUILD_PROMPT,
      rebuild_is_custom: !!(customRebuild?.value && customRebuild.value.trim()),
    };
  }

  /**
   * Migra em lote leads que ainda so tem AiMemory (sistema antigo) para gerar
   * LeadProfile (sistema novo). Enfileira um job `consolidate-profile` por lead
   * — o ProfileConsolidationProcessor agora le AiMemory como fonte adicional
   * quando existe, permitindo a consolidacao sem perder historico.
   *
   * Idempotente: pula leads que ja tem LeadProfile.
   * Custo estimado: ~$0.04 por lead (GPT-4.1 ~500 tokens saida).
   *
   * @param limit Maximo de leads a enfileirar (default 500)
   * @param activeSince Apenas leads com conversa desde essa data (ISO string)
   *                     — default: 90 dias atras
   */
  async migrateLegacyLeadsToProfile(params?: { limit?: number; activeSince?: string }) {
    const limit = params?.limit ?? 500;
    const since = params?.activeSince
      ? new Date(params.activeSince)
      : new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);

    // Leads com AiMemory mas SEM LeadProfile, ativos desde `since`
    const candidates = await this.prisma.$queryRawUnsafe<
      Array<{ id: string; tenant_id: string | null; name: string | null }>
    >(
      `
      SELECT DISTINCT l.id, l.tenant_id, l.name
      FROM "Lead" l
      JOIN "AiMemory" am ON am.lead_id = l.id
      LEFT JOIN "LeadProfile" lp ON lp.lead_id = l.id
      WHERE lp.id IS NULL
        AND EXISTS (
          SELECT 1 FROM "Conversation" c
          JOIN "Message" m ON m.conversation_id = c.id
          WHERE c.lead_id = l.id AND m.created_at >= $1
        )
      ORDER BY l.id
      LIMIT $2
      `,
      since,
      limit,
    );

    let enqueued = 0;
    let skipped = 0;

    for (const lead of candidates) {
      if (!lead.tenant_id) {
        skipped++;
        continue;
      }
      const jobId = `migrate-legacy-${lead.id}-${Date.now()}`;
      await this.memoryQueue.add(
        'consolidate-profile',
        { tenant_id: lead.tenant_id, lead_id: lead.id, reason: 'legacy-migration' },
        { jobId, removeOnComplete: true, attempts: 2 },
      );
      enqueued++;
    }

    return {
      summary: {
        candidates_found: candidates.length,
        enqueued,
        skipped_no_tenant: skipped,
        active_since: since.toISOString(),
        limit,
      },
    };
  }

  /**
   * Remove linhas hardcoded do corpo das skills que duplicam dados institucionais
   * agora providos pela variavel {{office_memories}} (numeros oficiais e endereco).
   *
   * @param dryRun Se true (default), apenas mostra o que SERIA removido sem aplicar.
   */
  async cleanSkillHardcodedOrgInfo(dryRun = true) {
    const skills = await (this.prisma as any).promptSkill.findMany({
      select: { id: true, name: true, area: true, system_prompt: true, active: true },
      orderBy: { order: 'asc' },
    });

    const report: Array<{
      id: string;
      name: string;
      area: string;
      active: boolean;
      changed: boolean;
      chars_removed: number;
      matches: Array<{ rule: string; matched_text: string; line_number: number }>;
      old_length: number;
      new_length: number;
      applied: boolean;
    }> = [];

    for (const skill of skills) {
      const result = cleanHardcodedOrgInfo(skill.system_prompt || '');
      const entry = {
        id: skill.id,
        name: skill.name,
        area: skill.area,
        active: skill.active,
        changed: result.changed,
        chars_removed: result.chars_removed,
        matches: result.matches,
        old_length: (skill.system_prompt || '').length,
        new_length: result.updated.length,
        applied: false,
      };
      if (result.changed && !dryRun) {
        await (this.prisma as any).promptSkill.update({
          where: { id: skill.id },
          data: { system_prompt: result.updated },
        });
        entry.applied = true;
      }
      report.push(entry);
    }

    const summary = {
      dry_run: dryRun,
      total_skills: skills.length,
      would_change: report.filter((r) => r.changed).length,
      applied_changes: report.filter((r) => r.applied).length,
      total_chars_removed: report.reduce((sum, r) => sum + (r.applied ? r.chars_removed : 0), 0),
    };

    return { summary, report };
  }

  /**
   * Migra skills ativas: injeta o bloco de variaveis de memoria no topo do
   * system_prompt de cada skill que ainda nao as use. Idempotente e seguro —
   * so ADICIONA o header, nao toca no corpo.
   *
   * Retorna lista de skills processadas com flag `changed`.
   */
  async migrateSkillsToMemoryVars() {
    const skills = await (this.prisma as any).promptSkill.findMany({
      select: { id: true, name: true, area: true, system_prompt: true, active: true },
      orderBy: { order: 'asc' },
    });

    const report: Array<{
      id: string;
      name: string;
      area: string;
      active: boolean;
      changed: boolean;
      reason: string;
      old_length: number;
      new_length: number;
    }> = [];

    for (const skill of skills) {
      const result = applyMemoryVarsMigration(skill.system_prompt || '');
      const entry = {
        id: skill.id,
        name: skill.name,
        area: skill.area,
        active: skill.active,
        changed: result.changed,
        reason: result.reason || 'unknown',
        old_length: (skill.system_prompt || '').length,
        new_length: result.updated.length,
      };
      if (result.changed) {
        await (this.prisma as any).promptSkill.update({
          where: { id: skill.id },
          data: { system_prompt: result.updated },
        });
      }
      report.push(entry);
    }

    const summary = {
      total_skills: skills.length,
      migrated: report.filter((r) => r.changed).length,
      already_migrated: report.filter((r) => r.reason === 'already_migrated').length,
    };

    return { summary, report };
  }

  /**
   * Atualiza configuracoes do pipeline. Cada campo e opcional.
   * Passar string vazia em *_prompt equivale a "restaurar padrao" (apaga a key).
   */
  async updateOrganizationProfileSettings(body: {
    model?: string;
    incremental_prompt?: string;
    rebuild_prompt?: string;
  }) {
    const ops: Promise<any>[] = [];

    if (typeof body.model === 'string') {
      const m = body.model.trim();
      if (!m) throw new BadRequestException('model nao pode ser vazio');
      const isValid = AVAILABLE_ORG_MODELS.some((opt) => opt.value === m);
      if (!isValid) {
        throw new BadRequestException(
          `modelo invalido. Opcoes: ${AVAILABLE_ORG_MODELS.map((o) => o.value).join(', ')}`,
        );
      }
      ops.push(
        this.prisma.globalSetting.upsert({
          where: { key: 'MEMORY_ORG_MODEL' },
          create: { key: 'MEMORY_ORG_MODEL', value: m },
          update: { value: m },
        }),
      );
    }

    if (typeof body.incremental_prompt === 'string') {
      const p = body.incremental_prompt.trim();
      if (p === '') {
        // Restaurar padrao — apaga a key
        ops.push(
          this.prisma.globalSetting.deleteMany({ where: { key: 'MEMORY_ORG_INCREMENTAL_PROMPT' } }),
        );
      } else {
        if (p.length < 100) {
          throw new BadRequestException('incremental_prompt muito curto (min. 100 chars)');
        }
        ops.push(
          this.prisma.globalSetting.upsert({
            where: { key: 'MEMORY_ORG_INCREMENTAL_PROMPT' },
            create: { key: 'MEMORY_ORG_INCREMENTAL_PROMPT', value: p },
            update: { value: p },
          }),
        );
      }
    }

    if (typeof body.rebuild_prompt === 'string') {
      const p = body.rebuild_prompt.trim();
      if (p === '') {
        ops.push(
          this.prisma.globalSetting.deleteMany({ where: { key: 'MEMORY_ORG_REBUILD_PROMPT' } }),
        );
      } else {
        if (p.length < 100) {
          throw new BadRequestException('rebuild_prompt muito curto (min. 100 chars)');
        }
        ops.push(
          this.prisma.globalSetting.upsert({
            where: { key: 'MEMORY_ORG_REBUILD_PROMPT' },
            create: { key: 'MEMORY_ORG_REBUILD_PROMPT', value: p },
            update: { value: p },
          }),
        );
      }
    }

    await Promise.all(ops);
    return this.getOrganizationProfileSettings();
  }
}

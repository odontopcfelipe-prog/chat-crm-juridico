import { InjectQueue } from '@nestjs/bullmq';
import { Cron } from '@nestjs/schedule';
import { Injectable, Logger } from '@nestjs/common';
import { Job, Queue } from 'bullmq';
import OpenAI from 'openai';
import { PrismaService } from '../prisma/prisma.service';
import { SettingsService } from '../settings/settings.service';
import { EmbeddingService } from './embedding.service';
import { MemoryRetrievalService } from './memory-retrieval.service';
import { BATCH_EXTRACTION_PROMPT } from './memory-prompts';
import { screenExtractedOrgMemory } from '@crm/shared';

const DEFAULT_BATCH_SIZE = 30;
const MIN_MESSAGE_LEN = 3;
const MAX_EXISTING_MEMORIES_LEAD = 15;
const MAX_EXISTING_MEMORIES_ORG = 20;
const DUPLICATE_THRESHOLD = 0.9;

interface ExtractedMemory {
  content: string;
  scope: 'lead' | 'organization';
  subcategory?: string | null;
  type?: 'semantic' | 'episodic';
  confidence?: number;
}

interface SupersededMemory {
  old_memory_id: string;
  reason: string;
}

interface ExtractionResult {
  memories: ExtractedMemory[];
  superseded: SupersededMemory[];
}

/** Memorias "da clinica" barradas antes de gravar (so contagem — nunca o conteudo). */
interface OrgDiscards {
  internal: number; // dado interno (caixa, vendas, cobranca, lista de pacientes...)
  subcategory: number; // categoria antiga/invalida (fees, court_info, contacts, vazia)
  financeiro: number; // conversa do chip FINANCEIRO nao ensina nada sobre a clinica
}

/**
 * DailyMemoryBatchProcessor
 * ─────────────────────────
 * Cron noturno (00:00 America/Maceio) que analisa mensagens do dia e
 * extrai memorias de lead + organizacionais em lotes via GPT-4.1.
 *
 * Pipeline:
 *   1. scheduleDailyExtraction() — cron enfileira 1 job por tenant
 *   2. processTenantBatch() — varre conversas do dia em lotes de 30 msgs
 *   3. extractFromBatch() — chama LLM, dedupe, insere memorias
 *   4. Ao final: enfileira consolidate-profiles-after-batch
 *
 * Memoria da CLINICA (scope=organization) vai pro prompt da IA que fala com
 * paciente, entao passa por uma peneira antes de gravar: dado interno
 * (relatorios automaticos de caixa/vendas/cobranca que chegam pelo WhatsApp)
 * e categoria antiga sao descartados, e conversa do chip FINANCEIRO nao gera
 * memoria da clinica (a do paciente continua).
 */
@Injectable()
export class DailyMemoryBatchProcessor {
  private readonly logger = new Logger(DailyMemoryBatchProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
    private readonly embedding: EmbeddingService,
    private readonly retrieval: MemoryRetrievalService,
    @InjectQueue('memory-jobs') private readonly memoryQueue: Queue,
  ) {}

  // ─── Cron: agenda todos os tenants meia-noite ─────────────

  @Cron('0 0 * * *', { timeZone: 'America/Maceio' })
  async scheduleDailyExtraction() {
    const enabled = await this.isEnabled();
    if (!enabled) {
      this.logger.log('[MemoryBatch] MEMORY_BATCH_ENABLED=false — pulando extracao diaria');
      return;
    }

    this.logger.log('=== Inicio da extracao diaria de memorias ===');
    const tenants = await this.prisma.tenant.findMany({ select: { id: true } });
    const today = new Date().toISOString().split('T')[0];

    for (const tenant of tenants) {
      await this.memoryQueue.add(
        'daily-batch-extract',
        { tenant_id: tenant.id },
        {
          jobId: `daily-batch-${tenant.id}-${today}`,
          removeOnComplete: true,
          attempts: 3,
          backoff: { type: 'exponential', delay: 60000 },
        },
      );
    }
    this.logger.log(`[MemoryBatch] Agendada extracao para ${tenants.length} tenants`);
  }

  private async isEnabled(): Promise<boolean> {
    const row = await this.prisma.globalSetting.findUnique({
      where: { key: 'MEMORY_BATCH_ENABLED' },
    });
    return (row?.value ?? 'true').toLowerCase() !== 'false';
  }

  /** Processa um tenant inteiro: itera conversas do dia e extrai memorias. */
  async processTenantBatch(job: Job): Promise<{ conversations: number; messages: number; leadMemories: number; orgMemories: number }> {
    const { tenant_id } = job.data as { tenant_id: string };
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);

    const conversations = await this.prisma.conversation.findMany({
      where: {
        tenant_id,
        messages: { some: { created_at: { gte: since } } },
      },
      select: {
        id: true,
        lead_id: true,
        instance_name: true,
        inbox: { select: { purpose: true } },
        messages: {
          where: { created_at: { gte: since } },
          orderBy: { created_at: 'asc' },
          select: {
            text: true,
            direction: true,
            type: true,
            created_at: true,
            skill_id: true,
            // Chip que de fato recebeu/enviou a msg (a conversa flutua entre chips).
            instance_name: true,
          },
        },
      },
    });

    const totalMessages = conversations.reduce((sum, c) => sum + c.messages.length, 0);
    this.logger.log(
      `[MemoryBatch] Tenant ${tenant_id}: ${conversations.length} conversas, ${totalMessages} mensagens`,
    );

    // Funcao do chip, resolvida UMA vez (Conversation.instance_name e
    // Message.instance_name -> Instance.purpose). Instance.name e unico, entao
    // nao mistura clinicas.
    const instanceNames = [
      ...new Set(
        conversations
          .flatMap((c) => [c.instance_name, ...c.messages.map((m) => m.instance_name)])
          .filter((n): n is string => !!n),
      ),
    ];
    const financeiroInstances = instanceNames.length
      ? await this.prisma.instance.findMany({
          where: { name: { in: instanceNames }, purpose: 'FINANCEIRO' },
          select: { name: true },
        })
      : [];
    const financeiroNames = new Set(financeiroInstances.map((i) => i.name));

    let leadMemories = 0;
    let orgMemories = 0;
    let orgDiscardedTotal = 0;

    for (const conv of conversations) {
      const useful = conv.messages.filter((m) => m.text && m.text.trim().length > MIN_MESSAGE_LEN);
      if (useful.length === 0) continue;

      // Chip FINANCEIRO (cobranca/boletos): so memoria do paciente, nunca da clinica.
      // Inbox.purpose espelha Instance.purpose — cobre conversa antiga sem instance_name.
      const isFinanceiro =
        (!!conv.instance_name && financeiroNames.has(conv.instance_name)) ||
        conv.inbox?.purpose === 'FINANCEIRO';
      const discarded: OrgDiscards = { internal: 0, subcategory: 0, financeiro: 0 };

      for (const batch of this.chunk(useful, DEFAULT_BATCH_SIZE)) {
        // Msg do lote que passou por um chip FINANCEIRO (conversa flutuou de chip):
        // o lote inteiro nao gera memoria da clinica (a do paciente continua).
        const batchTouchesFinanceiro = batch.some(
          (m) => !!m.instance_name && financeiroNames.has(m.instance_name),
        );
        try {
          const result = await this.extractFromBatch(
            tenant_id,
            conv.lead_id,
            conv.id,
            batch,
            !isFinanceiro && !batchTouchesFinanceiro,
          );
          leadMemories += result.leadCount;
          orgMemories += result.orgCount;
          discarded.internal += result.discarded.internal;
          discarded.subcategory += result.discarded.subcategory;
          discarded.financeiro += result.discarded.financeiro;
        } catch (e: any) {
          this.logger.error(
            `[MemoryBatch] Falha em batch (conv=${conv.id}): ${e.message}`,
          );
          // Continua processando outros batches — nao propaga a falha
        }
      }

      const convDiscarded = discarded.internal + discarded.subcategory + discarded.financeiro;
      if (convDiscarded > 0) {
        orgDiscardedTotal += convDiscarded;
        // So contagens — o conteudo pode ter dado de paciente/financeiro.
        this.logger.log(
          `[MemoryBatch] conv=${conv.id}: ${convDiscarded} memorias da clinica descartadas (dado interno=${discarded.internal}, categoria invalida=${discarded.subcategory}, chip financeiro=${discarded.financeiro})`,
        );
      }
    }

    this.logger.log(
      `[MemoryBatch] Tenant ${tenant_id}: ${leadMemories} memorias lead + ${orgMemories} organizacionais (${orgDiscardedTotal} da clinica descartadas)`,
    );

    // Reconsolida perfis dos leads afetados — executa apos 5s para dar tempo
    // dos embeddings serem persistidos antes de consultar
    await this.memoryQueue.add(
      'consolidate-profiles-after-batch',
      { tenant_id },
      { delay: 5000, removeOnComplete: true, attempts: 2 },
    );

    return {
      conversations: conversations.length,
      messages: totalMessages,
      leadMemories,
      orgMemories,
    };
  }

  /**
   * Chama LLM, dedupe, persiste memorias.
   * `orgAllowed=false` (conversa ou msg do lote no chip FINANCEIRO): nao manda as memorias da clinica pro LLM
   * (nem pra marcar como superadas) e descarta qualquer memoria organization.
   */
  private async extractFromBatch(
    tenantId: string,
    leadId: string,
    conversationId: string,
    messages: Array<{
      text: string | null;
      direction: string;
      type: string;
      created_at: Date;
      skill_id: string | null;
    }>,
    orgAllowed: boolean,
  ): Promise<{ leadCount: number; orgCount: number; discarded: OrgDiscards }> {
    const discarded: OrgDiscards = { internal: 0, subcategory: 0, financeiro: 0 };
    const [existingLead, existingOrg] = await Promise.all([
      this.prisma.memory.findMany({
        where: { tenant_id: tenantId, scope: 'lead', scope_id: leadId, status: 'active' },
        orderBy: { created_at: 'desc' },
        take: MAX_EXISTING_MEMORIES_LEAD,
        select: { id: true, content: true },
      }),
      orgAllowed
        ? this.prisma.memory.findMany({
            where: { tenant_id: tenantId, scope: 'organization', scope_id: tenantId, status: 'active' },
            orderBy: { created_at: 'desc' },
            take: MAX_EXISTING_MEMORIES_ORG,
            select: { id: true, content: true, subcategory: true },
          })
        : Promise.resolve([] as Array<{ id: string; content: string; subcategory: string | null }>),
    ]);

    const payload = {
      // Saida sem skill = equipe OU mensagem automatica do sistema (lembrete,
      // cobranca, relatorio de caixa/vendas) — o LLM precisa saber que nem toda
      // saida "humana" e fala da equipe.
      conversation_messages: messages.map((m) => ({
        sender:
          m.direction === 'in'
            ? 'CLIENTE'
            : m.skill_id
              ? 'IA'
              : 'EQUIPE_OU_SISTEMA',
        text: m.text,
        time: m.created_at,
      })),
      existing_lead_memories: existingLead,
      existing_org_memories: existingOrg,
      organization_allowed: orgAllowed,
    };

    const result = await this.callLLM(payload);
    if (!result) return { leadCount: 0, orgCount: 0, discarded };

    let leadCount = 0;
    let orgCount = 0;

    for (const memory of result.memories) {
      if (!memory || typeof memory.content !== 'string' || memory.content.trim().length < 5) continue;
      const scopeId = memory.scope === 'organization' ? tenantId : leadId;

      // Peneira da memoria da CLINICA (antes do embedding — nao gasta a chamada).
      let subcategory: string | null = memory.subcategory ?? null;
      if (memory.scope === 'organization') {
        if (!orgAllowed) {
          discarded.financeiro++;
          continue;
        }
        const screen = screenExtractedOrgMemory(memory.content, memory.subcategory);
        if (!screen.ok) {
          discarded[screen.reason]++;
          continue;
        }
        subcategory = screen.subcategory;
      }

      let embedding: number[];
      try {
        embedding = await this.embedding.generate(memory.content);
      } catch (e: any) {
        this.logger.warn(`[MemoryBatch] Falha ao gerar embedding: ${e.message}`);
        continue;
      }

      const dup = await this.retrieval.findDuplicate({
        tenant_id: tenantId,
        scope: memory.scope,
        scope_id: scopeId,
        content: memory.content,
        embedding,
        threshold: DUPLICATE_THRESHOLD,
      });
      if (dup) continue;

      try {
        await this.prisma.$executeRawUnsafe(
          `
          INSERT INTO "Memory" (
            id, tenant_id, scope, scope_id, type, subcategory, content,
            embedding, source_type, source_id, confidence, status,
            created_at, updated_at
          ) VALUES (
            gen_random_uuid(), $1, $2, $3, $4, $5, $6,
            $7::vector, 'batch', $8, $9, 'active',
            NOW(), NOW()
          )
          `,
          tenantId,
          memory.scope,
          scopeId,
          memory.type ?? 'semantic',
          subcategory,
          memory.content,
          this.embedding.toVectorLiteral(embedding),
          conversationId,
          memory.confidence ?? 0.9,
        );
        if (memory.scope === 'lead') leadCount++;
        else orgCount++;
      } catch (e: any) {
        this.logger.warn(`[MemoryBatch] Falha ao inserir memoria: ${e.message}`);
      }
    }

    // Superseded: so vale id que FOI ENVIADO ao LLM neste lote (id inventado ou
    // de outra clinica/lead e ignorado). Memoria da CLINICA so e aposentada se o
    // lote podia gerar organization E gravou de fato uma memoria organization
    // nova (senao a clinica perderia a info sem ganhar a substituta).
    const sentLeadIds = new Set(existingLead.map((m) => m.id));
    const sentOrgIds = new Set(existingOrg.map((m) => m.id));
    let supIgnored = 0;
    for (const sup of result.superseded) {
      const oldId = typeof sup?.old_memory_id === 'string' ? sup.old_memory_id.trim() : '';
      if (!oldId) continue;
      const isLead = sentLeadIds.has(oldId);
      const isOrg = !isLead && sentOrgIds.has(oldId);
      if (!isLead && (!isOrg || !orgAllowed || orgCount === 0)) {
        supIgnored++;
        continue;
      }
      try {
        await this.prisma.memory.updateMany({
          where: { id: oldId, tenant_id: tenantId, scope: isLead ? 'lead' : 'organization' },
          data: {
            status: 'superseded',
            superseded_by: typeof sup.reason === 'string' ? sup.reason : null,
          },
        });
      } catch {
        // Ignora se memoria nao existir mais
      }
    }
    if (supIgnored > 0) {
      this.logger.log(
        `[MemoryBatch] conv=${conversationId}: ${supIgnored} superseded ignorados (id fora do lote ou sem memoria da clinica nova gravada)`,
      );
    }

    return { leadCount, orgCount, discarded };
  }

  /** Chamada ao GPT-4.1 com response_format=json_object. */
  private async callLLM(payload: any): Promise<ExtractionResult | null> {
    const apiKey = await this.settings.getOpenAiKey();
    if (!apiKey) {
      this.logger.warn('[MemoryBatch] OPENAI_API_KEY ausente — abortando');
      return null;
    }
    const modelRow = await this.prisma.globalSetting.findUnique({
      where: { key: 'MEMORY_EXTRACTION_MODEL' },
    });
    const model = modelRow?.value || 'gpt-4.1';

    const client = new OpenAI({ apiKey });
    try {
      const response = await client.chat.completions.create({
        model,
        messages: [
          { role: 'system', content: BATCH_EXTRACTION_PROMPT },
          { role: 'user', content: JSON.stringify(payload) },
        ],
        response_format: { type: 'json_object' },
        max_completion_tokens: 1500,
        temperature: 0.3,
      });
      const content = response.choices[0]?.message?.content;
      if (!content) return null;
      const parsed = JSON.parse(content);
      return {
        memories: Array.isArray(parsed.memories) ? parsed.memories : [],
        superseded: Array.isArray(parsed.superseded) ? parsed.superseded : [],
      };
    } catch (e: any) {
      this.logger.error(`[MemoryBatch] Erro no LLM: ${e.message}`);
      return null;
    }
  }

  private chunk<T>(arr: T[], size: number): T[][] {
    const out: T[][] = [];
    for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
    return out;
  }
}

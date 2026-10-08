/**
 * Script one-shot para extrair memorias ORGANIZACIONAIS a partir de
 * mensagens OUTBOUND historicas dos operadores (ultimos 6 meses).
 *
 * Como rodar:
 *   ts-node apps/worker/src/memory/retroactive-extraction.ts <tenantId>
 *
 * Nao roda automaticamente — precisa ser executado manualmente apos o deploy
 * para popular a base de conhecimento organizacional com o que ja foi dito.
 *
 * Nota: este script nao depende do BullMQ nem do AppModule. Ele instancia
 * suas proprias dependencias e conecta direto ao Prisma. Use apenas em
 * manutencao — nao chame de dentro de jobs normais.
 */

import { PrismaClient, screenExtractedOrgMemory } from '@crm/shared';
import OpenAI from 'openai';
import { createHash } from 'crypto';
import { RETROACTIVE_ORG_PROMPT } from './memory-prompts';

const BATCH_SIZE = 30;
const LOOKBACK_MONTHS = 6;
const DUPLICATE_THRESHOLD = 0.9;
const MAX_MESSAGES = 500;

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function toVectorLiteral(emb: number[]): string {
  return `[${emb.join(',')}]`;
}

async function main() {
  const tenantId = process.argv[2];
  if (!tenantId) {
    console.error('USO: ts-node retroactive-extraction.ts <tenantId>');
    process.exit(1);
  }

  const openaiKey = process.env.OPENAI_API_KEY;
  if (!openaiKey) {
    console.error('OPENAI_API_KEY ausente no ambiente');
    process.exit(1);
  }

  const prisma = new PrismaClient();
  const openai = new OpenAI({ apiKey: openaiKey });

  console.log(`[Retroactive] tenant=${tenantId} — buscando mensagens...`);

  const since = new Date();
  since.setMonth(since.getMonth() - LOOKBACK_MONTHS);

  // Chip FINANCEIRO (cobranca/boletos/relatorios) nao ensina nada sobre a
  // clinica — fora da extracao. Instance.name e unico; inclui instancia sem
  // tenant (legado) por seguranca, ja que so filtra msgs DESTA clinica.
  const financeiroInstances = await prisma.instance.findMany({
    where: { purpose: 'FINANCEIRO', OR: [{ tenant_id: tenantId }, { tenant_id: null }] },
    select: { name: true },
  });
  const financeiroNames = financeiroInstances.map((i) => i.name);
  // Campo nullable: `notIn` sozinho descartaria NULL no Prisma — por isso o OR.
  const notFinanceiroChip = financeiroNames.length
    ? [{ OR: [{ instance_name: null }, { instance_name: { notIn: financeiroNames } }] }]
    : [];
  console.log(`[Retroactive] ${financeiroNames.length} chip(s) FINANCEIRO excluido(s)`);

  const messages = await prisma.message.findMany({
    where: {
      conversation: {
        tenant_id: tenantId,
        AND: [
          // Inbox FINANCEIRO fora; conversa sem inbox / inbox sem purpose fica.
          {
            OR: [
              { inbox_id: null },
              { inbox: { is: { OR: [{ purpose: null }, { purpose: { not: 'FINANCEIRO' } }] } } },
            ],
          },
          // Conversa presa ao chip FINANCEIRO (msg antiga sem instance_name).
          ...notFinanceiroChip,
        ],
      },
      // Msg que saiu pelo chip FINANCEIRO.
      AND: notFinanceiroChip,
      direction: 'out',
      type: 'text',
      skill_id: null, // apenas humanos, nao IA
      created_at: { gte: since },
      text: { not: null },
    },
    orderBy: { created_at: 'desc' },
    take: MAX_MESSAGES,
    select: { text: true, created_at: true },
  });

  console.log(`[Retroactive] ${messages.length} mensagens OUTBOUND encontradas`);
  if (messages.length === 0) {
    await prisma.$disconnect();
    return;
  }

  const batches = chunk(messages, BATCH_SIZE);
  let totalInserted = 0;
  // Memorias da clinica barradas pela peneira (so contagem — nunca o conteudo)
  let discardedInternal = 0;
  let discardedSubcategory = 0;

  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i];
    const texts = batch.map((m) => m.text).filter((t): t is string => !!t);
    if (texts.length === 0) continue;

    try {
      const response = await openai.chat.completions.create({
        model: 'gpt-4.1',
        messages: [
          { role: 'system', content: RETROACTIVE_ORG_PROMPT },
          { role: 'user', content: JSON.stringify(texts) },
        ],
        response_format: { type: 'json_object' },
        max_completion_tokens: 1500,
        temperature: 0.3,
      });

      const content = response.choices[0]?.message?.content;
      if (!content) continue;

      let parsed: any;
      try {
        parsed = JSON.parse(content);
      } catch {
        console.warn(`[Retroactive] Batch ${i + 1}: JSON invalido, pulando`);
        continue;
      }
      const memories = Array.isArray(parsed.memories) ? parsed.memories : [];

      for (const memory of memories) {
        if (!memory?.content || typeof memory.content !== 'string') continue;
        const content = memory.content.trim();
        if (content.length < 5) continue;

        // Peneira (antes do embedding): dado interno (caixa, vendas, cobranca,
        // lista de pacientes) e categoria antiga/invalida nao viram memoria da
        // clinica; legal_knowledge vira treatments.
        const screen = screenExtractedOrgMemory(content, memory.subcategory);
        if (!screen.ok) {
          if (screen.reason === 'internal') discardedInternal++;
          else discardedSubcategory++;
          continue;
        }

        const embResp = await openai.embeddings.create({
          model: 'text-embedding-3-small',
          input: content,
          dimensions: 1536,
        });
        const embedding = embResp.data[0].embedding;
        const vec = toVectorLiteral(embedding);

        const dup = await prisma.$queryRawUnsafe<any[]>(
          `
          SELECT id FROM "Memory"
          WHERE tenant_id = $1 AND scope = 'organization' AND status = 'active'
            AND embedding IS NOT NULL
            AND 1 - (embedding <=> $2::vector) > $3
          LIMIT 1
          `,
          tenantId,
          vec,
          DUPLICATE_THRESHOLD,
        );

        if (dup.length > 0) continue;

        await prisma.$executeRawUnsafe(
          `
          INSERT INTO "Memory" (
            id, tenant_id, scope, scope_id, type, subcategory, content, embedding,
            source_type, confidence, status, created_at, updated_at
          ) VALUES (
            gen_random_uuid(), $1, 'organization', $1, 'semantic', $2, $3, $4::vector,
            'retroactive', $5, 'active', NOW(), NOW()
          )
          `,
          tenantId,
          screen.subcategory,
          content,
          vec,
          typeof memory.confidence === 'number' ? memory.confidence : 0.8,
        );
        totalInserted++;
      }

      console.log(`[Retroactive] Batch ${i + 1}/${batches.length}: +${memories.length} candidatas (total inserido: ${totalInserted})`);
    } catch (e: any) {
      console.error(`[Retroactive] Erro no batch ${i + 1}: ${e.message}`);
    }
  }

  console.log(
    `[Retroactive] Concluido. ${totalInserted} memorias organizacionais inseridas; descartadas: dado interno=${discardedInternal}, categoria invalida=${discardedSubcategory}.`,
  );
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

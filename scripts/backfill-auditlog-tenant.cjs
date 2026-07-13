#!/usr/bin/env node
/**
 * BACKFILL — preenche AuditLog.tenant_id nas linhas antigas do Log Financeiro
 * (que eram GLOBAIS e vazavam entre clínicas — IDOR).
 *
 * A partir do fix, o Log filtra por tenant_id; linhas antigas sem tenant_id ficam
 * ocultas (fail-safe). Este script recupera o histórico de CADA clínica ligando
 * AuditLog.entity_id -> FinancialTransaction.id -> tenant_id.
 *
 * As linhas ALERTA_VENCIDOS antigas (entity_id='sistema') não têm transação e
 * ficam null (some do Log) — o cron do worker passa a gerar 1 alerta por tenant.
 *
 * Roda DENTRO do container da API (DATABASE_URL no ambiente). Só Prisma ORM.
 *   node backfill-auditlog-tenant.cjs            # DRY-RUN
 *   node backfill-auditlog-tenant.cjs --apply    # aplica
 */
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const APPLY = process.argv.includes('--apply');

async function main() {
  const rows = await prisma.auditLog.findMany({
    where: { entity: 'FINANCEIRO', tenant_id: null, NOT: { entity_id: 'sistema' } },
    select: { id: true, entity_id: true },
  });
  console.log(`\n=== BACKFILL tenant_id do Log financeiro (${APPLY ? 'APLICANDO' : 'DRY-RUN'}) — ${rows.length} linhas ===`);

  const txIds = [...new Set(rows.map((r) => r.entity_id).filter(Boolean))];
  const txs = txIds.length
    ? await prisma.financialTransaction.findMany({ where: { id: { in: txIds } }, select: { id: true, tenant_id: true } })
    : [];
  const tByTx = new Map(txs.map((t) => [t.id, t.tenant_id]));

  let fixed = 0, semTx = 0;
  for (const r of rows) {
    const tid = tByTx.get(r.entity_id);
    if (!tid) { semTx++; continue; }
    if (APPLY) await prisma.auditLog.update({ where: { id: r.id }, data: { tenant_id: tid } });
    fixed++;
  }

  console.log(`\nResumo: ${fixed} ${APPLY ? 'corrigidas' : 'a corrigir'} | sem transação vinculada: ${semTx}`);
  console.log('(ALERTA_VENCIDOS antigas com entity_id="sistema" ficam null — serão regeradas por tenant pelo cron)');
  if (!APPLY && fixed > 0) console.log('\n→ Rode de novo com  --apply  pra gravar.');
}

main().catch((e) => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());

#!/usr/bin/env node
/**
 * BACKFILL — preenche FinancialTransaction.lead_id nas RECEITAS antigas (cobrança/clínica)
 * que ficaram SEM cliente (a coluna "Cliente" da aba Entradas mostrava "—").
 *
 * O fix novo (payment-gateway.service.ts: ensureChargeReceita / ensureChargeReceitaSplit)
 * já grava lead_id nas receitas FUTURAS; este script corrige o HISTÓRICO.
 *
 * Como liga: receita.reference_id == PaymentGatewayCharge.external_id
 *            -> charge.treatment_plan.patient.lead_id  (é o valor que falta em lead_id).
 *
 * Roda DENTRO do container da API (usa o DATABASE_URL do ambiente). NÃO usa SQL cru
 * (só Prisma ORM), então não cai no quirk de "$queryRawUnsafe FROM patients volta vazio".
 *
 *   node backfill-receita-cliente.cjs            # DRY-RUN (só mostra o que faria)
 *   node backfill-receita-cliente.cjs --apply    # aplica
 *   node backfill-receita-cliente.cjs --apply --tenant=<uuid>   # limita a um tenant
 */
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const argv = process.argv.slice(2);
const has = (n) => argv.includes(`--${n}`);
const arg = (n) => { const p = argv.find((a) => a.startsWith(`--${n}=`)); return p ? p.slice(n.length + 3) : undefined; };
const APPLY = has('apply');
const TENANT = arg('tenant');

async function main() {
  const where = { type: 'RECEITA', lead_id: null, reference_id: { not: null } };
  if (TENANT) where.tenant_id = TENANT;

  const txs = await prisma.financialTransaction.findMany({
    where,
    select: { id: true, tenant_id: true, reference_id: true },
  });

  console.log(`\n=== BACKFILL cliente das entradas (${APPLY ? 'APLICANDO' : 'DRY-RUN'}) ===`);
  console.log(`Receitas sem cliente com reference_id: ${txs.length}\n`);

  let fixed = 0, semCobranca = 0, semLead = 0;
  for (const tx of txs) {
    const charge = await prisma.paymentGatewayCharge.findFirst({
      where: { external_id: tx.reference_id, tenant_id: tx.tenant_id },
      select: { treatment_plan: { select: { patient: { select: { lead_id: true, name: true } } } } },
    });
    if (!charge) { semCobranca++; continue; }
    const leadId = charge.treatment_plan?.patient?.lead_id || null;
    if (!leadId) { semLead++; continue; }
    const nome = charge.treatment_plan?.patient?.name || '?';
    if (APPLY) {
      await prisma.financialTransaction.update({ where: { id: tx.id }, data: { lead_id: leadId } });
    }
    fixed++;
    console.log(`  ${APPLY ? '✔' : '•'} ${tx.id.slice(0, 8)} -> ${nome} (lead ${leadId.slice(0, 8)})`);
  }

  console.log(`\nResumo: ${fixed} ${APPLY ? 'corrigidas' : 'a corrigir'} | sem cobrança vinculada: ${semCobranca} | cobrança sem paciente/lead: ${semLead}`);
  if (!APPLY && fixed > 0) console.log('\n→ Rode de novo com  --apply  pra gravar.');
}

main().catch((e) => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());

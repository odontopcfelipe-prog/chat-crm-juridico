#!/usr/bin/env node
/**
 * DIAGNÓSTICO (read-only) — por que o card do contrato mostra "venda + juros"
 * estourado (ex.: R$ 304.803,20) enquanto o KPI de cima mostra ~R$ 14.616,80.
 *
 * NÃO altera nada. Só lê e imprime as cobranças (PaymentGatewayCharge) do
 * paciente + como o card as somaria, pra achar a causa (parents duplicados /
 * deletados que o card ainda expande, valores inflados, etc).
 *
 * Roda DENTRO do container da API (DATABASE_URL já no ambiente).
 *   --patient=<uuid>   (default: Anthony 29384f08-c1fc-4203-a0c8-23e17ca92fe4)
 */
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const argv = process.argv.slice(2);
const arg = (n) => { const p = argv.find((a) => a.startsWith(`--${n}=`)); return p ? p.slice(n.length + 3) : undefined; };
const PATIENT = arg('patient');
const NAME = arg('name');

const brl = (v) => `R$ ${Number(v || 0).toFixed(2)}`;
const CANCELLED = new Set(['DELETED', 'REFUNDED', 'CANCELLED']);
const PAID = new Set(['RECEIVED', 'CONFIRMED', 'RECEIVED_IN_CASH']);

async function main() {
  // Seleção: --patient=<uuid> OU --name="Rodrigo" OU (default) o Anthony do #016.
  let patient;
  if (NAME) {
    patient = await prisma.patient.findFirst({ where: { name: { contains: NAME, mode: 'insensitive' } }, select: { id: true, name: true, lead_id: true, tenant_id: true } });
  } else {
    patient = await prisma.patient.findUnique({ where: { id: PATIENT || '29384f08-c1fc-4203-a0c8-23e17ca92fe4' }, select: { id: true, name: true, lead_id: true, tenant_id: true } });
  }
  if (!patient) { console.log(`Paciente não encontrado (${NAME || PATIENT})`); return; }
  console.log(`\n=== ${patient.name} (${patient.id}) ===`);

  // planos do paciente
  const plans = await prisma.treatmentPlan.findMany({ where: { patient_id: patient.id }, select: { id: true, quote_id: true } }).catch(() => []);
  const planIds = plans.map((p) => p.id);
  console.log(`Planos: ${planIds.length} -> ${planIds.join(', ') || '(nenhum)'}`);

  // customer_external_id via lead
  let customerExtIds = [];
  if (patient.lead_id) {
    const custs = await prisma.paymentGatewayCustomer.findMany({ where: { lead_id: patient.lead_id, gateway: 'ASAAS' }, select: { external_id: true } }).catch(() => []);
    customerExtIds = custs.map((c) => c.external_id);
  }
  console.log(`Customers Asaas: ${customerExtIds.join(', ') || '(nenhum)'}`);

  // charges por TODOS os caminhos (plan_id, description plan:, customer_external_id)
  const orFilters = [];
  if (planIds.length) orFilters.push({ treatment_plan_id: { in: planIds } });
  for (const pid of planIds) orFilters.push({ description: { contains: `plan:${pid}` } });
  if (customerExtIds.length) orFilters.push({ customer_external_id: { in: customerExtIds } });
  const charges = orFilters.length
    ? await prisma.paymentGatewayCharge.findMany({ where: { OR: orFilters }, orderBy: { created_at: 'asc' } })
    : [];

  console.log(`\n--- ${charges.length} cobrança(s) (PaymentGatewayCharge) ---`);
  const hdr = ['#', 'kind', 'billing', 'amount', 'status', 'due', 'created', 'external_id', 'desc'].join(' | ');
  console.log(hdr);
  let i = 0;
  for (const c of charges) {
    console.log([
      ++i,
      c.kind || '-',
      c.billing_type,
      brl(c.amount),
      c.status,
      c.due_date ? new Date(c.due_date).toISOString().slice(0, 10) : '-',
      c.created_at ? new Date(c.created_at).toISOString().slice(0, 10) : '-',
      (c.external_id || '').slice(0, 14),
      (c.description || '').slice(0, 40),
    ].join(' | '));
  }

  // somas como o KPI de cima faria (por AMOUNT do parent, pulando cancelada)
  let kpiPaid = 0, kpiOpen = 0, kpiCancel = 0;
  for (const c of charges) {
    const amt = Number(c.amount);
    if (CANCELLED.has(c.status)) { kpiCancel += amt; continue; }
    if (PAID.has(c.status)) { kpiPaid += amt; continue; }
    kpiOpen += amt;
  }
  console.log(`\n--- SOMA por AMOUNT do parent (como o KPI de cima) ---`);
  console.log(`  Pago:      ${brl(kpiPaid)}`);
  console.log(`  Em aberto: ${brl(kpiOpen)}`);
  console.log(`  Cancelado (não conta): ${brl(kpiCancel)}`);
  console.log(`  ATIVAS (pago+aberto): ${brl(kpiPaid + kpiOpen)}`);

  // duplicidade / acumulo
  const byKey = {};
  for (const c of charges) {
    const k = `${c.billing_type}|${Number(c.amount).toFixed(2)}|${c.due_date ? new Date(c.due_date).toISOString() : ''}|${c.kind || ''}`;
    (byKey[k] = byKey[k] || []).push(c);
  }
  const dupGroups = Object.entries(byKey).filter(([, v]) => v.length > 1);
  console.log(`\n--- Grupos de chave DUPLICADA (billing|amount|due|kind): ${dupGroups.length} ---`);
  for (const [k, v] of dupGroups) console.log(`  ${v.length}x  ${k}  (status: ${v.map((c) => c.status).join(',')})`);

  const alive = charges.filter((c) => !CANCELLED.has(c.status));
  const deleted = charges.filter((c) => CANCELLED.has(c.status));
  console.log(`\n>>> ${alive.length} viva(s), ${deleted.length} cancelada(s).`);
  console.log(`>>> O card EXPANDE as filhas (sub-parcelas do Asaas) de CADA cobrança em relatedCharges — inclusive as CANCELADAS localmente cujas filhas no Asaas ainda estejam PENDENTES. Se ha varias parents aqui, ai esta o estouro.`);
  console.log(`>>> Se so ha 1 parent viva (~14.616) e o card mostra ~304.803, o excesso vem de: (a) parents cancelados ainda expandidos, ou (b) filhas infladas no proprio Asaas.\n`);
}

main().catch((e) => { console.error('ERRO:', e?.message || e); process.exitCode = 1; }).finally(() => prisma.$disconnect());

/*
EXECUÇÃO (VPS):
  API=$(docker ps -qf name=chatcrm_api | head -1)
  docker cp scripts/diag-contrato-charges.cjs $API:/app/diag-contrato-charges.cjs
  docker exec $API node /app/diag-contrato-charges.cjs
*/

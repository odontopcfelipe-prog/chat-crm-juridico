#!/usr/bin/env node
/**
 * PURGA EM LOTE (keep-patient) de pacientes de TESTE — mesma logica do
 * purge-test-patient.cjs, mas processa varios de uma vez. Mantem o cadastro
 * do Patient + Lead + conversas; apaga so o comercial/financeiro (orcamentos,
 * planos, parcelas, cobrancas, receitas, comissoes, agenda, radiografia).
 *
 * Roda DENTRO do container da API (usa DATABASE_URL do ambiente).
 *
 * SELECAO:
 *   --names="Lustosa|Alinne|shirlyanne|zezinho"   (separador = | ; contains, case-insensitive)
 *   --ids=<uuid>,<uuid>                            (mais seguro pro --confirm)
 *   --tenant=<uuid>                                (opcional — escopa a busca a 1 clinica)
 *
 * SEGURANCA:
 *   - Sem --confirm => DRY-RUN: tabela do que cada um perderia, NAO apaga.
 *   - Nome que casar >1 paciente NAO e apagado — e LISTADO (use --ids).
 *   - Sinaliza quem tem RECEITA JA RECEBIDA (pra voce conferir se e teste mesmo).
 *   - Cada paciente numa transacao propria (um erro nao derruba os outros).
 */
let PrismaClient;
try { ({ PrismaClient } = require('@prisma/client')); }
catch { ({ PrismaClient } = require('/app/apps/api/node_modules/@prisma/client')); }
const prisma = new PrismaClient();

const argv = process.argv.slice(2);
const arg = (n) => { const p = argv.find((a) => a.startsWith('--' + n + '=')); return p ? p.slice(n.length + 3) : undefined; };
const CONFIRM = argv.includes('--confirm');
const TENANT = arg('tenant');
const NAMES = (arg('names') || '').split('|').map((s) => s.trim()).filter(Boolean);
const IDS = (arg('ids') || '').split(',').map((s) => s.trim()).filter(Boolean);
const num = (v) => (v == null ? 0 : Number(v));
const brl = (v) => 'R$ ' + num(v).toFixed(2);
const sel = { id: true, name: true, cpf: true, phone: true, tenant_id: true, lead_id: true };

async function collect(p) {
  const plans = await prisma.treatmentPlan.findMany({ where: { patient_id: p.id }, select: { id: true } });
  const insts = await prisma.installment.findMany({ where: { patient_id: p.id }, select: { id: true } });
  const planIds = plans.map((x) => x.id), instIds = insts.map((x) => x.id);
  const chOr = [];
  if (planIds.length) chOr.push({ treatment_plan_id: { in: planIds } });
  if (instIds.length) chOr.push({ installment_id: { in: instIds } });
  const charges = chOr.length ? await prisma.paymentGatewayCharge.findMany({ where: { OR: chOr }, select: { id: true, external_id: true, transaction_id: true, amount: true } }) : [];
  const extIds = charges.map((c) => c.external_id).filter(Boolean);
  const chTx = charges.map((c) => c.transaction_id).filter(Boolean);
  const txOr = [];
  if (chTx.length) txOr.push({ id: { in: chTx } });
  if (extIds.length) txOr.push({ reference_id: { in: extIds } });
  if (p.lead_id) txOr.push({ lead_id: p.lead_id });
  const txs = txOr.length ? await prisma.financialTransaction.findMany({ where: { OR: txOr }, select: { id: true, type: true, amount: true } }) : [];
  const [quotes, comms] = await Promise.all([
    prisma.quote.count({ where: { patient_id: p.id } }),
    prisma.commission.count({ where: { patient_id: p.id } }),
  ]);
  return {
    planIds, instIds, chargeIds: charges.map((c) => c.id), txIds: txs.map((t) => t.id),
    quotes, comms, chargesN: charges.length, txN: txs.length,
    totCh: charges.reduce((s, c) => s + num(c.amount), 0),
    rec: txs.filter((t) => t.type === 'RECEITA').reduce((s, t) => s + num(t.amount), 0),
  };
}

async function purgeOne(p, d) {
  await prisma.$transaction(async (tx) => {
    if (d.txIds.length) await tx.financialTransaction.deleteMany({ where: { id: { in: d.txIds } } });
    if (d.chargeIds.length) await tx.paymentGatewayCharge.deleteMany({ where: { id: { in: d.chargeIds } } });
    await tx.calendarEvent.deleteMany({ where: { patient_id: p.id } });
    await tx.radiographyExam.deleteMany({ where: { patient_id: p.id } });
    await tx.treatmentPlan.deleteMany({ where: { patient_id: p.id } });
    await tx.installment.deleteMany({ where: { patient_id: p.id } });
    await tx.quote.deleteMany({ where: { patient_id: p.id } });
    await tx.commission.deleteMany({ where: { patient_id: p.id } });
    await tx.maintenanceTask.deleteMany({ where: { patient_id: p.id } });
    await tx.returnAlert.deleteMany({ where: { patient_id: p.id } });
  }, { timeout: 120000 });
}

(async () => {
  try {
    const targets = []; const seen = new Set(); const notes = [];
    const push = (p) => { if (!seen.has(p.id)) { seen.add(p.id); targets.push(p); } };

    for (const id of IDS) {
      const w = { id }; if (TENANT) w.tenant_id = TENANT;
      const p = await prisma.patient.findFirst({ where: w, select: sel });
      if (p) push(p); else notes.push('id nao encontrado: ' + id);
    }
    for (const nm of NAMES) {
      const w = { name: { contains: nm, mode: 'insensitive' } }; if (TENANT) w.tenant_id = TENANT;
      const found = await prisma.patient.findMany({ where: w, select: sel });
      if (found.length === 0) { notes.push('0 matches: "' + nm + '"'); continue; }
      if (found.length > 1) {
        notes.push(found.length + ' matches p/ "' + nm + '" (AMBIGUO — use --ids):');
        found.forEach((f) => notes.push('   - ' + f.id + '  ' + f.name + '  cpf=' + (f.cpf || '-') + '  tenant=' + f.tenant_id));
        continue;
      }
      push(found[0]);
    }

    if (!targets.length) { console.log('\nNenhum alvo resolvido.'); notes.forEach((n) => console.log(n)); return; }

    const data = [];
    for (const p of targets) data.push({ p, d: await collect(p) });

    console.log('\n=== ALVOS (' + targets.length + ') ===');
    console.table(data.map(({ p, d }) => ({
      nome: p.name, cpf: p.cpf || '-', tenant: (p.tenant_id || '').slice(0, 8),
      cobrancas: d.chargesN, cob_total: brl(d.totCh), RECEBIDO: brl(d.rec),
      orcamentos: d.quotes, planos: d.planIds.length, comissoes: d.comms,
    })));
    console.log('TOTAL: ' + brl(data.reduce((s, x) => s + x.d.totCh, 0)) + ' em cobrancas | ' + brl(data.reduce((s, x) => s + x.d.rec, 0)) + ' em RECEITA recebida');

    const withRec = data.filter((x) => x.d.rec > 0);
    if (withRec.length) { console.log('\n[!] ATENCAO — estes tem RECEITA JA RECEBIDA (confirme que e teste):'); withRec.forEach((x) => console.log('   - ' + x.p.name + ': ' + brl(x.d.rec) + '  (id=' + x.p.id + ')')); }
    if (notes.length) { console.log('\n--- observacoes ---'); notes.forEach((n) => console.log(n)); }

    if (!CONFIRM) { console.log('\n[DRY-RUN] nada apagado. Confira e rode com --confirm (de preferencia por --ids).\n'); return; }

    console.log('\n[APAGANDO ' + targets.length + ' pacientes...]');
    for (const { p, d } of data) { await purgeOne(p, d); console.log('  zerado: ' + p.name); }
    console.log('\n[OK] batch keep-patient concluido. Relatorio financeiro limpo desses testes.\n');
  } catch (e) { console.error('\n[ERRO]', e.message); process.exit(1); }
  finally { await prisma.$disconnect(); }
})();

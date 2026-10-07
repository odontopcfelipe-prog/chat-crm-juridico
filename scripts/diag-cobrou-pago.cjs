// Diagnóstico READ-ONLY: "paciente com parcela PAGA recebeu cobrança". Não altera nada.
// Escopo: UMA clínica (--tenant, default Instituto) e UM contrato (--quote = nº do contrato).
// Mostra TODAS as cobranças do paciente (por plano, parcela OU vínculo direto) com status,
// baixa (quando/como), a cobrança que a régua escolheu (AuditLog/DispatchLog) e as
// entradas do caixa — pra saber se: (a) foi pago FORA do Asaas e ninguém deu baixa na
// cobrança, (b) a baixa veio DEPOIS do disparo, (c) existe cobrança DUPLICADA.
//
//   node diag-cobrou-pago.cjs --quote=519 [--tenant=<uuid>]
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const argv = process.argv.slice(2);
const arg = (n) => { const p = argv.find((a) => a.startsWith(`--${n}=`)); return p ? p.slice(n.length + 3) : undefined; };
const TENANT = arg('tenant') || '00000000-0000-0000-0000-000000000000';
const QN = Number(arg('quote'));
const br = (d) => (d ? new Date(new Date(d).getTime() - 3 * 3600e3).toISOString().slice(0, 16).replace('T', ' ') : '-');

(async () => {
  if (!QN) { console.error('Informe --quote=<nº do contrato>'); process.exitCode = 1; return; }
  const q = await prisma.quote.findFirst({
    where: { quote_number: QN, patient: { tenant_id: TENANT } },
    select: { id: true, status: true, accepted_at: true, total_value: true, chosen_payment_key: true,
      patient: { select: { id: true, name: true, lead_id: true } }, treatment_plan: { select: { id: true } } },
  });
  if (!q) { console.log(`Contrato #${QN} não encontrado nesta clínica.`); return; }
  const p = q.patient;
  console.log(`\n=== Contrato #${QN} — ${p.name} | ${q.status} aceito ${br(q.accepted_at)} | R$${q.total_value} | forma ${q.chosen_payment_key} ===`);

  const plans = await prisma.treatmentPlan.findMany({ where: { patient_id: p.id }, select: { id: true } });
  const planIds = plans.map((x) => x.id);
  const charges = await prisma.paymentGatewayCharge.findMany({
    where: { OR: [
      { patient_id: p.id },
      { treatment_plan_id: { in: planIds } },
      ...planIds.map((id) => ({ description: { contains: 'plan:' + id } })),
      { installment: { patient_id: p.id } },
    ] },
    select: { id: true, external_id: true, gateway: true, status: true, received_in_cash: true, received_at: true,
      received_by_user_id: true, paid_at: true, payment_date: true, amount: true, due_date: true, billing_type: true,
      kind: true, treatment_plan_id: true, patient_id: true, installment_id: true, created_at: true, updated_at: true,
      description: true, pix_copy_paste: true, transaction_id: true, cancelled_at: true },
    orderBy: { created_at: 'asc' },
  });
  console.log(`\n--- Cobranças do paciente (${charges.length}) ---`);
  for (const c of charges) {
    console.log(`• ${c.id.slice(0, 8)} ext=${c.external_id} ${c.gateway} ${c.billing_type} R$${c.amount} venc ${String(c.due_date).slice(0, 10)} | STATUS=${c.status}` +
      ` em_espécie=${c.received_in_cash} recebido_em=${br(c.received_at)} paid_at=${br(c.paid_at)} payment_date=${br(c.payment_date)}` +
      ` | criada ${br(c.created_at)} alterada ${br(c.updated_at)} | plano=${c.treatment_plan_id ? 'sim' : 'NÃO'} paciente_direto=${c.patient_id ? 'sim' : 'não'} parcela=${c.installment_id ? 'sim' : 'não'}` +
      ` | caixa=${c.transaction_id ? 'sim' : 'não'} | pix…${(c.pix_copy_paste || '').slice(-8)} | "${(c.description || '').slice(0, 60)}"`);
  }

  const ids = charges.map((c) => c.id);
  const alerts = await prisma.auditLog.findMany({
    where: { OR: [{ entity: 'PAYMENT_ALERT', entity_id: p.id }, { entity_id: { in: ids } }] },
    select: { entity: true, entity_id: true, action: true, created_at: true, actor_user_id: true, meta_json: true },
    orderBy: { created_at: 'asc' },
  });
  console.log(`\n--- AuditLog (régua / baixas) (${alerts.length}) ---`);
  for (const a of alerts) console.log(`  ${br(a.created_at)} ${a.entity}/${a.action} ref=${a.entity_id.slice(0, 8)} ${a.actor_user_id ? 'por user ' + a.actor_user_id.slice(0, 8) : ''} ${JSON.stringify(a.meta_json || {}).slice(0, 120)}`);

  const dl = await prisma.dispatchLog.findMany({
    where: { tenant_id: TENANT, OR: [{ ref_patient_id: p.id }, { recipient_name: { contains: p.name.split(' ')[0] } }], sent_at: { gte: new Date(Date.now() - 20 * 864e5) } },
    select: { type: true, status: true, sent_at: true, recipient_name: true, error: true },
    orderBy: { sent_at: 'asc' },
  });
  console.log(`\n--- DispatchLog últimos 20d (${dl.length}) ---`);
  for (const d of dl) console.log(`  ${br(d.sent_at)} ${d.type} ${d.status} ${d.recipient_name || ''} ${d.error ? '· ' + d.error.slice(0, 80) : ''}`);

  if (p.lead_id) {
    const tx = await prisma.financialTransaction.findMany({
      where: { lead_id: p.lead_id, created_at: { gte: new Date(Date.now() - 30 * 864e5) } },
      select: { id: true, type: true, status: true, amount: true, created_at: true, description: true, payment_method: true },
      orderBy: { created_at: 'asc' },
    }).catch((e) => { console.log('  (caixa: ' + e.message + ')'); return []; });
    console.log(`\n--- Caixa (FinancialTransaction do lead, 30d) (${tx.length}) ---`);
    for (const t of tx) console.log(`  ${br(t.created_at)} ${t.type}/${t.status} R$${t.amount} ${t.payment_method || ''} "${(t.description || '').slice(0, 70)}" tx=${t.id.slice(0, 8)}`);
  }
  console.log('\n=== fim ===');
})()
  .catch((e) => { console.error('DIAG ERRO:', e); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());

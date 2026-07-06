#!/usr/bin/env node
/**
 * PURGA UM PACIENTE DE TESTE + todo o rastro dele — inclusive os registros
 * FINANCEIROS que num delete normal ficam ORFAOS (FK SetNull) e continuam
 * contando nos relatorios: PaymentGatewayCharge (cobranca) e FinancialTransaction
 * (receita/caixa). O botao "Excluir" da tela NAO limpa esses dois.
 *
 * Roda DENTRO do container da API (DATABASE_URL ja esta no ambiente — nao
 * hardcoda senha). Ver instrucoes de execucao no fim do arquivo.
 *
 * SELECAO do paciente (um dos):
 *   --patient-id=<uuid>          mais seguro/preciso
 *   --cpf=096.422.624-36         (contains — tolera mascara)
 *   --name="Fellipe passos"      (contains, case-insensitive)
 *   --tenant=<uuid>              opcional, desambigua entre clinicas
 *
 * MODO (o que apagar alem do financeiro):
 *   --mode=full          (padrao) apaga Patient + Lead + conversas WhatsApp + tudo
 *   --mode=keep-contact  apaga Patient e os dados dele, MANTEM o Lead + conversas
 *   --mode=keep-patient  MANTEM Patient/Lead/conversas/clinico; apaga so o
 *                        comercial+financeiro (orcamentos, planos, parcelas,
 *                        cobrancas, receitas, comissoes) — "zera os dados"
 *
 * SEGURANCA:
 *   - Sem --confirm => DRY-RUN: so conta e mostra, NAO apaga nada.
 *   - Tudo numa transacao unica (all-or-nothing).
 *   - Se mais de 1 paciente casar o filtro, LISTA e aborta (use --patient-id).
 */
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient(); // usa DATABASE_URL do ambiente

const argv = process.argv.slice(2);
const arg = (n) => {
  const p = argv.find((a) => a.startsWith(`--${n}=`));
  return p ? p.slice(n.length + 3) : undefined;
};
const has = (n) => argv.includes(`--${n}`);

const CONFIRM = has('confirm');
const MODE = arg('mode') || 'full';
const SEL = {
  patientId: arg('patient-id'),
  cpf: arg('cpf'),
  name: arg('name'),
  tenant: arg('tenant'),
};

const num = (v) => (v == null ? 0 : Number(v));
const brl = (v) => `R$ ${num(v).toFixed(2)}`;

async function resolvePatient() {
  if (!['full', 'keep-contact', 'keep-patient'].includes(MODE)) {
    throw new Error(`--mode invalido: ${MODE} (use full | keep-contact | keep-patient)`);
  }
  const where = {};
  if (SEL.patientId) where.id = SEL.patientId;
  else if (SEL.cpf) where.cpf = { contains: SEL.cpf };
  else if (SEL.name) where.name = { contains: SEL.name, mode: 'insensitive' };
  else throw new Error('Informe --patient-id, --cpf ou --name');
  if (SEL.tenant) where.tenant_id = SEL.tenant;

  const found = await prisma.patient.findMany({
    where,
    select: { id: true, name: true, cpf: true, phone: true, tenant_id: true, lead_id: true, status: true, created_at: true },
  });
  if (found.length === 0) throw new Error('Nenhum paciente casou o filtro.');
  if (found.length > 1) {
    console.log('\n⚠️  MAIS DE UM paciente casou o filtro — abortando por seguranca.');
    console.log('    Rode de novo com --patient-id=<uuid> de UM deles:\n');
    console.table(found.map((p) => ({ id: p.id, name: p.name, cpf: p.cpf, tenant_id: p.tenant_id })));
    process.exit(3);
  }
  return found[0];
}

async function collect(p) {
  const [plans, installments] = await Promise.all([
    prisma.treatmentPlan.findMany({ where: { patient_id: p.id }, select: { id: true } }),
    prisma.installment.findMany({ where: { patient_id: p.id }, select: { id: true } }),
  ]);
  const planIds = plans.map((x) => x.id);
  const installmentIds = installments.map((x) => x.id);

  // Cobrancas (nao tem patient_id) — achadas por plan OU installment
  const chargeOr = [];
  if (planIds.length) chargeOr.push({ treatment_plan_id: { in: planIds } });
  if (installmentIds.length) chargeOr.push({ installment_id: { in: installmentIds } });
  const charges = chargeOr.length
    ? await prisma.paymentGatewayCharge.findMany({
        where: { OR: chargeOr },
        select: { id: true, external_id: true, transaction_id: true, amount: true, status: true, description: true },
      })
    : [];
  const chargeIds = charges.map((c) => c.id);
  const chargeExternalIds = charges.map((c) => c.external_id).filter(Boolean);
  const chargeTxIds = charges.map((c) => c.transaction_id).filter(Boolean);

  // Receitas/caixa (nao tem patient_id) — achadas por: charge.transaction_id,
  // reference_id = external_id do charge, ou lead_id do paciente.
  const txOr = [];
  if (chargeTxIds.length) txOr.push({ id: { in: chargeTxIds } });
  if (chargeExternalIds.length) txOr.push({ reference_id: { in: chargeExternalIds } });
  if (p.lead_id) txOr.push({ lead_id: p.lead_id });
  const transactions = txOr.length
    ? await prisma.financialTransaction.findMany({
        where: { OR: txOr },
        select: { id: true, type: true, category: true, amount: true, description: true, reference_id: true, lead_id: true },
      })
    : [];
  const transactionIds = transactions.map((t) => t.id);

  // Counts do que cai por CASCADE (so pro relatorio)
  const [quotes, commissions, maintenance, returnAlerts, calendarEvents, radiographs, conversations, tasks] = await Promise.all([
    prisma.quote.count({ where: { patient_id: p.id } }),
    prisma.commission.count({ where: { patient_id: p.id } }),
    prisma.maintenanceTask.count({ where: { patient_id: p.id } }),
    prisma.returnAlert.count({ where: { patient_id: p.id } }),
    prisma.calendarEvent.count({ where: { patient_id: p.id } }),
    prisma.radiographyExam.count({ where: { patient_id: p.id } }),
    p.lead_id ? prisma.conversation.count({ where: { lead_id: p.lead_id } }) : Promise.resolve(0),
    p.lead_id ? prisma.task.count({ where: { lead_id: p.lead_id } }) : Promise.resolve(0),
  ]);

  return {
    planIds, installmentIds, charges, chargeIds, transactions, transactionIds,
    counts: { quotes, commissions, maintenance, returnAlerts, calendarEvents, radiographs, conversations, tasks },
  };
}

function report(p, d) {
  console.log('\n===================================================================');
  console.log(`  PACIENTE: ${p.name}   (cpf=${p.cpf || '—'}  tel=${p.phone || '—'})`);
  console.log(`  id=${p.id}`);
  console.log(`  tenant=${p.tenant_id}   lead=${p.lead_id || '— (sem lead vinculado)'}`);
  console.log(`  MODO: ${MODE}`);
  console.log('===================================================================');

  const totalCharges = d.charges.reduce((s, c) => s + num(c.amount), 0);
  const totalRec = d.transactions.filter((t) => t.type === 'RECEITA').reduce((s, t) => s + num(t.amount), 0);
  const totalDesp = d.transactions.filter((t) => t.type === 'DESPESA').reduce((s, t) => s + num(t.amount), 0);

  console.log('\n💰 FINANCEIRO (apagado EXPLICITO — some do relatorio):');
  console.log(`   • PaymentGatewayCharge (cobrancas): ${d.charges.length}  =  ${brl(totalCharges)}`);
  if (d.charges.length) console.table(d.charges.map((c) => ({ status: c.status, valor: brl(c.amount), desc: (c.description || '').slice(0, 40), external_id: c.external_id })));
  console.log(`   • FinancialTransaction (caixa): ${d.transactions.length}  =  RECEITA ${brl(totalRec)} | DESPESA ${brl(totalDesp)}`);
  if (d.transactions.length) console.table(d.transactions.map((t) => ({ tipo: t.type, cat: t.category, valor: brl(t.amount), desc: (t.description || '').slice(0, 40) })));

  console.log('\n🦷 CLINICO/COMERCIAL (cai por cascade do Patient):');
  console.table([{
    orcamentos: d.counts.quotes, planos: d.planIds.length, parcelas: d.installmentIds.length,
    comissoes: d.counts.commissions, manutencoes: d.counts.maintenance, retornos: d.counts.returnAlerts,
    agenda: d.counts.calendarEvents, radiografias: d.counts.radiographs,
  }]);

  console.log('\n💬 CONTATO/WHATSAPP (Lead):');
  console.log(`   • Conversas: ${d.counts.conversations}   Tarefas: ${d.counts.tasks}`);
  if (MODE === 'full') console.log('   → MODO full: Lead + conversas + mensagens SERAO apagados.');
  if (MODE === 'keep-contact') console.log('   → MODO keep-contact: Lead + conversas PRESERVADOS.');
  if (MODE === 'keep-patient') console.log('   → MODO keep-patient: Patient + Lead + conversas + clinico PRESERVADOS (so zera comercial/financeiro).');
  console.log('');
}

async function purge(p, d) {
  await prisma.$transaction(async (tx) => {
    // 1) FINANCEIRO orfao — SEMPRE (e o objetivo). Transacoes antes das charges.
    if (d.transactionIds.length) await tx.financialTransaction.deleteMany({ where: { id: { in: d.transactionIds } } });
    if (d.chargeIds.length) await tx.paymentGatewayCharge.deleteMany({ where: { id: { in: d.chargeIds } } });

    // 2) Orfaos SetNull do paciente (agenda + radiografia) — apaga explicito
    await tx.calendarEvent.deleteMany({ where: { patient_id: p.id } });
    if (d.counts.radiographs) await tx.radiographyExam.deleteMany({ where: { patient_id: p.id } });

    if (MODE === 'keep-patient') {
      // Zera so o comercial/financeiro; mantem Patient/Lead/clinico/conversas.
      await tx.treatmentPlan.deleteMany({ where: { patient_id: p.id } }); // items caem por cascade
      await tx.installment.deleteMany({ where: { patient_id: p.id } });
      await tx.quote.deleteMany({ where: { patient_id: p.id } });
      await tx.commission.deleteMany({ where: { patient_id: p.id } });
      await tx.maintenanceTask.deleteMany({ where: { patient_id: p.id } });
      await tx.returnAlert.deleteMany({ where: { patient_id: p.id } });
      return;
    }

    // MODO full ou keep-contact => apaga o Patient (cascade: quotes, planos,
    // parcelas, comissoes, clinico, anamnese, prontuario, etc.)
    await tx.patient.delete({ where: { id: p.id } });

    if (MODE === 'full' && p.lead_id) {
      // Orfaos SetNull do lead antes de apaga-lo
      await tx.task.deleteMany({ where: { lead_id: p.lead_id } });
      // Lead => cascade: conversas, mensagens, notas, honorarios, customer do gateway
      await tx.lead.delete({ where: { id: p.lead_id } });
    }
  }, { timeout: 60000 });
}

(async () => {
  try {
    const p = await resolvePatient();
    const d = await collect(p);
    report(p, d);

    if (!CONFIRM) {
      console.log('🟡 DRY-RUN — NADA foi apagado.');
      console.log('   Confira os numeros acima. Pra APAGAR de verdade, rode o MESMO comando + --confirm\n');
      return;
    }

    console.log('🔴 APAGANDO (--confirm)…');
    await purge(p, d);
    console.log(`\n✅ Pronto. Paciente "${p.name}" purgado no modo ${MODE}.`);
    console.log('   Cobrancas e receitas removidas — relatorio financeiro limpo desse teste.\n');
  } catch (e) {
    console.error('\n❌ ERRO:', e.message);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
})();

/*
 * ─── COMO RODAR (na VPS, via agente) ────────────────────────────────────────
 *   # 1) atualiza o repo na VPS (pra ter este arquivo)
 *   git fetch origin && git checkout master && git reset --hard origin/master
 *
 *   # 2) descobre o container da API (Swarm) e copia o script pra /app
 *   CID=$(docker ps -qf name=chatcrm_api | head -1)
 *   docker cp scripts/purge-test-patient.cjs "$CID":/app/purge-test-patient.cjs
 *
 *   # 3) DRY-RUN (nao apaga — so mostra o que existe)
 *   docker exec "$CID" node /app/purge-test-patient.cjs --name="Fellipe passos"
 *
 *   # 4) conferiu? APAGA (escolha o --mode; full = clean slate)
 *   docker exec "$CID" node /app/purge-test-patient.cjs --name="Fellipe passos" --mode=full --confirm
 * ────────────────────────────────────────────────────────────────────────────
 */

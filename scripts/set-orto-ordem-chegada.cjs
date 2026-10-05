// Liga/desliga a REGRA DA CLÍNICA "Ortodontia por ordem de chegada" (ORTO_ORDEM_CHEGADA_<tenant>)
// — a mesma chave do card na Central de Disparos. Rodar ANTES do deploy que introduz a regra,
// pra clínica que atende ortô em FLUXO (Pra Sorrir) não perder o comportamento: no código
// novo, sem a chave, ortô vira "hora marcada" (padrão).
//
// Sem --confirm = só mostra (DRY-RUN). Também lista, só leitura, os toggles de ortô da clínica.
//
//   node set-orto-ordem-chegada.cjs --tenant=<uuid> [--off] [--confirm]
//
// Rodar DENTRO do container da API (DATABASE_URL vem do ambiente):
//   docker cp set-orto-ordem-chegada.cjs <api>:/app/set-orto.cjs && docker exec <api> node /app/set-orto.cjs --tenant=... --confirm
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const argv = process.argv.slice(2);
const arg = (n) => { const p = argv.find((a) => a.startsWith(`--${n}=`)); return p ? p.slice(n.length + 3) : undefined; };
const TENANT = arg('tenant');
const CONFIRM = argv.includes('--confirm');
const VALUE = argv.includes('--off') ? 'false' : 'true';

(async () => {
  if (!TENANT) { console.error('Informe --tenant=<uuid> (sem padrão de propósito).'); process.exitCode = 1; return; }
  const t = await prisma.tenant.findUnique({ where: { id: TENANT }, select: { name: true } });
  if (!t) { console.error(`Clínica ${TENANT} não encontrada.`); process.exitCode = 1; return; }
  console.log(`\n=== Regra "ortodontia por ordem de chegada" — ${t.name} (${TENANT}) ===`);

  const keys = ['ORTO_ORDEM_CHEGADA', 'APPOINTMENT_ORTO_IMMEDIATE_ENABLED', 'APPOINTMENT_CONFIRMATION_ORTO_ENABLED', 'APPOINTMENT_ORTO_REMINDER_ENABLED', 'APPOINTMENT_CONFIRMATION_ENABLED'];
  for (const k of keys) {
    const s = await prisma.globalSetting.findUnique({ where: { key: `${k}_${TENANT}` } });
    console.log(`  ${k}: ${s ? s.value : '(não setado)'}`);
  }

  const key = `ORTO_ORDEM_CHEGADA_${TENANT}`;
  if (!CONFIRM) {
    console.log(`\nDRY-RUN: gravaria ${key} = ${VALUE}. Rode com --confirm pra aplicar.`);
    return;
  }
  await prisma.globalSetting.upsert({ where: { key }, create: { key, value: VALUE }, update: { value: VALUE } });
  const after = await prisma.globalSetting.findUnique({ where: { key } });
  console.log(`\nOK: ${key} = ${after?.value}`);
})()
  .catch((e) => { console.error('ERRO:', e); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());

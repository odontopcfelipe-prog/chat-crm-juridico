#!/usr/bin/env node
/**
 * SETUP DOS DISPAROS DE ORTODONTIA (por ordem de chegada) — Onda 18.x
 *
 * O que faz (por tenant):
 *   1) REVERTE a "Confirmação de agendamento" pro texto PADRÃO (genérico). Antes
 *      alguém colou "POR ORDEM DE CHEGADA / a partir das 14h" nela — isso ia pra
 *      TODO paciente (consulta/procedimento/retorno), não só ortô. O texto atual é
 *      IMPRESSO aqui (backup) antes de resetar, pra nada se perder.
 *   2) LIGA os 2 disparos novos de ortodontia (só valem pra eventos ORTODONTIA):
 *      - Confirmação de ortodontia (ordem de chegada)  ~24h antes
 *      - Lembrete de ortodontia · 1h antes (portões)
 *   Os TEXTOS dos disparos de ortô ficam no padrão do sistema (o editor já mostra
 *   um texto pronto com "por ordem de chegada"); a clínica ajusta na Central de
 *   Disparos quando quiser. Só liga/mexe nas keys — não seeda template de ortô.
 *
 * Roda DENTRO do container da API (DATABASE_URL já está no ambiente — não hardcoda
 * senha). Instruções de execução no fim do arquivo.
 *
 *   --tenant=<uuid>   clínica alvo (default: 00000000-0000-0000-0000-000000000000)
 *   --confirm         aplica de verdade. SEM ele = DRY-RUN (só mostra o que faria).
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
const TENANT = arg('tenant') || '00000000-0000-0000-0000-000000000000';

const K = {
  mainTpl: `APPOINTMENT_CONFIRMATION_TEMPLATE_${TENANT}`,
  ortoConfEnabled: `APPOINTMENT_CONFIRMATION_ORTO_ENABLED_${TENANT}`,
  ortoRemEnabled: `APPOINTMENT_ORTO_REMINDER_ENABLED_${TENANT}`,
};

async function readVal(key) {
  const row = await prisma.globalSetting.findUnique({ where: { key } });
  if (!row?.value) return null;
  try { const p = JSON.parse(row.value); return p?.template ?? row.value; }
  catch { return row.value; }
}

async function main() {
  console.log(`\n=== SETUP DISPAROS ORTODONTIA — tenant ${TENANT} ===`);
  console.log(CONFIRM ? '>>> MODO REAL (--confirm)\n' : '>>> DRY-RUN (nada será alterado — use --confirm pra aplicar)\n');

  const curMain = await readVal(K.mainTpl);
  const curOrtoConf = await prisma.globalSetting.findUnique({ where: { key: K.ortoConfEnabled } });
  const curOrtoRem = await prisma.globalSetting.findUnique({ where: { key: K.ortoRemEnabled } });

  console.log('1) Confirmação de agendamento (NORMAL) — texto atual salvo:');
  if (curMain) {
    console.log('   ┌─ BACKUP do texto atual (copie se quiser guardar algo) ─');
    curMain.split('\n').forEach((l) => console.log(`   │ ${l}`));
    console.log('   └────────────────────────────────────────────────────────');
    console.log('   → AÇÃO: apagar esta key ⇒ volta pro texto PADRÃO (genérico, com {hora}, SEM "ordem de chegada").');
  } else {
    console.log('   (já está no padrão — nenhuma key salva. Nada a reverter.)');
  }

  console.log('\n2) Disparos de ortodontia (OPT-IN):');
  console.log(`   - Confirmação de ortodontia: ${curOrtoConf?.value === 'true' ? 'JÁ LIGADA' : 'desligada'} → LIGAR`);
  console.log(`   - Lembrete de ortodontia 1h: ${curOrtoRem?.value === 'true' ? 'JÁ LIGADO' : 'desligado'} → LIGAR`);

  if (!CONFIRM) {
    console.log('\nDRY-RUN concluído. Rode de novo com --confirm pra aplicar.\n');
    return;
  }

  await prisma.$transaction(async (tx) => {
    // 1) reverte a confirmação normal (apaga a key ⇒ código usa o default genérico)
    if (curMain) {
      await tx.globalSetting.deleteMany({ where: { key: K.mainTpl } });
    }
    // 2) liga os 2 disparos de ortô
    for (const key of [K.ortoConfEnabled, K.ortoRemEnabled]) {
      await tx.globalSetting.upsert({
        where: { key },
        create: { key, value: 'true' },
        update: { value: 'true' },
      });
    }
  });

  console.log('\n✅ Aplicado:');
  console.log('   - Confirmação NORMAL revertida pro padrão (ortô não vaza mais pros demais).');
  console.log('   - Confirmação de ortodontia: LIGADA.');
  console.log('   - Lembrete de ortodontia 1h: LIGADO.');
  console.log('   Ajuste os textos de ortô em Configurações › Disparos quando quiser.\n');
}

main()
  .catch((e) => { console.error('ERRO:', e?.message || e); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());

/*
EXECUÇÃO (VPS — a imagem NÃO leva scripts/; copia o conteúdo pro container da API):

  # 1) copie este arquivo pro container
  docker cp scripts/setup-orto-disparos.cjs $(docker ps -qf name=chatcrm_api | head -1):/app/setup-orto-disparos.cjs

  # 2) DRY-RUN (não altera nada)
  docker exec $(docker ps -qf name=chatcrm_api | head -1) node /app/setup-orto-disparos.cjs

  # 3) aplicar de verdade
  docker exec $(docker ps -qf name=chatcrm_api | head -1) node /app/setup-orto-disparos.cjs --confirm
*/

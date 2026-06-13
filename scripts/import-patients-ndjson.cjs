#!/usr/bin/env node
/**
 * Onda 17.43 — Importação de pacientes (migração de base) a partir de um NDJSON.
 *
 * Cadastra pacientes em UM tenant, aplicando uma tag. Pensado pra migração de
 * sistema (ex: importar a base antiga da Clínica Pra Sorrir). Roda DIRETO no
 * Prisma — bypassa o limite de plano de propósito (é importação de base real).
 *
 * SEGURANÇA:
 *   - DRY-RUN por padrão: resolve o tenant, conta o que faria, NÃO escreve nada.
 *     Só escreve com a flag --commit.
 *   - Idempotente: dedup por `record_number` (prontuário). Rodar 2x não duplica.
 *     Sem prontuário, dedup por CPF. CPF que colide com existente vira null
 *     (mantém o paciente, só não grava o CPF repetido).
 *   - Escopo de 1 tenant só (resolvido por id OU por nome — exige match único).
 *
 * Cada linha do NDJSON: {"name","record_number","cpf","phone"} (cpf/phone/rn
 * podem ser null). PII fica SÓ no arquivo (nunca no git).
 *
 * Rodar DENTRO do container da API (tem @crm/shared + DATABASE_URL):
 *   node import-patients-ndjson.cjs <arquivo.ndjson> --tenant "<id|nome>" \
 *        [--tag "Paciente novo"] [--commit]
 */
const fs = require('fs');
const { PrismaClient } = require('@crm/shared');

function getFlag(args, key, def) {
  const i = args.indexOf(key);
  return i >= 0 ? args[i + 1] : def;
}

async function main() {
  const args = process.argv.slice(2);
  const file = args[0] && !args[0].startsWith('--') ? args[0] : null; // 1º arg = arquivo
  const tenantArg = getFlag(args, '--tenant');
  const tagName = getFlag(args, '--tag', 'Paciente novo');
  const commit = args.includes('--commit');

  if (!file || !tenantArg) {
    console.error('uso: node import-patients-ndjson.cjs <ndjson> --tenant "<id|nome>" [--tag "Paciente novo"] [--commit]');
    process.exit(1);
  }

  const prisma = new PrismaClient();
  try {
    // ── Resolve tenant (por id exato OU por nome com match único) ──────────
    let tenant;
    if (/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(tenantArg)) {
      tenant = await prisma.tenant.findUnique({
        where: { id: tenantArg },
        select: { id: true, name: true, plan: true },
      });
    } else {
      const matches = await prisma.tenant.findMany({
        where: { name: { contains: tenantArg, mode: 'insensitive' } },
        select: { id: true, name: true, plan: true },
      });
      if (matches.length !== 1) {
        console.error(`tenant "${tenantArg}" -> ${matches.length} resultado(s):`, matches.map((m) => `${m.id} (${m.name})`));
        console.error('Refine o --tenant (use o id exato).');
        process.exit(2);
      }
      tenant = matches[0];
    }
    if (!tenant) {
      console.error('tenant não encontrado');
      process.exit(2);
    }
    console.log(`TENANT: ${tenant.id} | "${tenant.name}" | plano ${tenant.plan}`);
    console.log(`TAG:    "${tagName}"`);
    console.log(`MODO:   ${commit ? '*** COMMIT (vai escrever) ***' : 'DRY-RUN (não escreve)'}`);

    // ── Lê o arquivo: aceita NDJSON ({...} por linha) OU TSV colado da
    // planilha (Paciente \t Prontuário \t Idade \t Documento \t Celular) ──────
    const raw = fs.readFileSync(file, 'utf8');
    const lines = raw.split(/\r?\n/).filter((l) => l.trim() !== '');
    const recs = [];
    const isJson = lines[0] && lines[0].trim().startsWith('{');
    if (isJson) {
      for (const l of lines) { try { recs.push(JSON.parse(l)); } catch { /* skip */ } }
      console.log(`Formato: NDJSON | ${recs.length} registros`);
    } else {
      const digits = (s) => (s || '').replace(/\D/g, '');
      for (const l of lines) {
        // pula o cabeçalho (linha que tem "Documento" e "Celular")
        if (/documento/i.test(l) && /celular/i.test(l)) continue;
        const cols = l.split('\t');
        const name = (cols[0] || '').trim();
        if (!name) continue;
        const rn = (cols[1] || '').trim() || null;       // Prontuário
        let cpf = digits(cols[3]); cpf = cpf.length === 11 ? cpf : null; // Documento
        let phone = digits(cols[4]); phone = phone.length >= 10 ? phone : null; // Celular
        recs.push({ name, record_number: rn, cpf, phone });
      }
      console.log(`Formato: TSV (planilha) | ${recs.length} registros`);
    }

    // ── Existentes (dedup idempotente) ─────────────────────────────────────
    const existing = await prisma.patient.findMany({
      where: { tenant_id: tenant.id },
      select: { record_number: true, cpf: true },
    });
    const recSet = new Set(existing.map((e) => e.record_number).filter(Boolean));
    const cpfSet = new Set(existing.map((e) => e.cpf).filter(Boolean));
    console.log(`Já no tenant: ${existing.length} pacientes (${recSet.size} c/ prontuário, ${cpfSet.size} c/ CPF)`);

    // ── Monta o plano (o que criar) ────────────────────────────────────────
    const plan = [];
    let skipExisting = 0, cpfDropped = 0;
    for (const r of recs) {
      const name = (r.name || '').trim();
      if (!name) continue;
      const rn = r.record_number || null;
      let cpf = r.cpf || null;

      if (rn && recSet.has(rn)) { skipExisting++; continue; }      // já importado
      if (cpf && cpfSet.has(cpf)) {
        if (!rn) { skipExisting++; continue; }                     // sem prontuário + CPF repetido = mesmo paciente
        cpf = null; cpfDropped++;                                  // novo paciente, mas CPF colide -> sem CPF
      }
      if (rn) recSet.add(rn);
      if (cpf) cpfSet.add(cpf);
      plan.push({ name, record_number: rn, cpf, phone: r.phone || null });
    }
    console.log(`PLANO: criar ${plan.length} | pular (já existe) ${skipExisting} | CPF removido por colisão ${cpfDropped}`);

    if (!commit) {
      console.log('\n*** DRY-RUN — nada foi escrito. Confira o TENANT acima e rode de novo com --commit. ***');
      return;
    }

    // ── Tag (upsert por tenant_id+name) ────────────────────────────────────
    const tag = await prisma.patientTag.upsert({
      where: { tenant_id_name: { tenant_id: tenant.id, name: tagName } },
      update: {},
      create: { tenant_id: tenant.id, name: tagName, color: '#22c55e' },
    });
    console.log(`TAG OK: ${tag.id}`);

    // ── Cria os pacientes (com a tag), resiliente por linha ────────────────
    let created = 0, errors = 0;
    for (let i = 0; i < plan.length; i++) {
      const p = plan[i];
      try {
        await prisma.patient.create({
          data: {
            tenant_id: tenant.id,
            name: p.name,
            record_number: p.record_number,
            cpf: p.cpf,
            phone: p.phone,
            tags: { create: { tag_id: tag.id } },
          },
        });
        created++;
      } catch (e) {
        errors++;
        if (errors <= 25) console.warn(`  ERRO linha ${i} (${p.name}): ${e.code || ''} ${e.message?.split('\n')[0]}`);
      }
      if ((i + 1) % 500 === 0) console.log(`  ... ${i + 1}/${plan.length} (criados ${created}, erros ${errors})`);
    }
    console.log(`\nFIM: criados ${created} | erros ${errors} | pulados (já existiam) ${skipExisting}`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });

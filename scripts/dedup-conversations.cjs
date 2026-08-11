/*
 * Limpeza de conversas duplicadas (mesmo lead, mesmo inbox) — NÃO-financeiro.
 *
 * Contexto: um mesmo lead acumula 2+ Conversation no MESMO inbox (ex.: uma "real"
 * com a instância do tenant t<tenant>-N + tráfego humano, e uma FANTASMA com
 * instance_name='whatsapp' genérico, ai_mode ligado, que só pega lembrete). O
 * lembrete (findFirst por last_message_at) oscila entre as duas → paciente/CRM
 * mostra duplicado, e a Sophia responde numa conversa que ninguém lê.
 *
 * Cobre TODOS os inboxes — INCLUSIVE Financeiro — pra casar o escopo do índice único
 * "Conversation_lead_inbox_active_uq" (que também cobre financeiro). O agrupamento é
 * por (lead_id, inbox_id): financeiro só funde com financeiro (mesmo inbox), NUNCA com
 * clínica/comercial (inbox diferente) → o mundo isolado do financeiro é preservado.
 *
 * Estratégia por grupo (lead_id + inbox_id):
 *   - Canônica = MAIS mensagens > instância REAL (≠ 'whatsapp'/null) > last_message_at
 *     mais recente > id (desempate estável).
 *   - Move as mensagens das duplicadas → canônica. Idêntica (mesmo texto+direção, ≤5min,
 *     type 'text') é DELETADA em vez de movida (evita 2 lembretes iguais na canônica).
 *   - Duplicada esvaziada → status 'ENCERRADO' + ai_mode=false (não hard-delete).
 *   - last_message_at da canônica = max do grupo.
 *
 * Uso (dentro do container da API):
 *   node dedup-conversations.cjs                       # DRY-RUN (só relata)
 *   node dedup-conversations.cjs --commit              # aplica
 *   node dedup-conversations.cjs --commit --tenant <T> # só um tenant
 */
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const COMMIT = process.argv.includes('--commit');
const tenantArgIdx = process.argv.indexOf('--tenant');
const ONLY_TENANT = tenantArgIdx >= 0 ? process.argv[tenantArgIdx + 1] : null;
const DEDUP_WINDOW_MS = 5 * 60 * 1000;
const isRealInstance = (n) => !!n && n !== 'whatsapp';

async function main() {
  console.log(`\n=== DEDUP CONVERSAS (geral, exceto FINANCEIRO) ${COMMIT ? '(COMMIT)' : '(DRY-RUN)'} ===`);
  if (ONLY_TENANT) console.log(`Filtro de tenant: ${ONLY_TENANT}`);

  const convs = await prisma.conversation.findMany({
    where: { status: { not: 'ENCERRADO' }, ...(ONLY_TENANT ? { tenant_id: ONLY_TENANT } : {}) },
    select: { id: true, lead_id: true, tenant_id: true, inbox_id: true, assigned_user_id: true, ai_mode: true, instance_name: true, last_message_at: true },
  });

  const groups = new Map();
  for (const c of convs) {
    if (!c.inbox_id || !c.lead_id) continue; // sem inbox/lead não entra (índice também exige inbox_id)
    const k = `${c.lead_id}::${c.inbox_id}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(c);
  }
  const dupGroups = [...groups.values()].filter((g) => g.length > 1);
  console.log(`Grupos com duplicata: ${dupGroups.length} (de ${groups.size} lead+inbox)`);

  const perTenant = new Map();
  const bump = (t, f, n = 1) => { if (!perTenant.has(t)) perTenant.set(t, { groups: 0, closed: 0, moved: 0, dedup: 0 }); perTenant.get(t)[f] += n; };

  for (const g of dupGroups) {
    const tenant = g[0].tenant_id || 'null';
    const counts = new Map();
    for (const c of g) counts.set(c.id, await prisma.message.count({ where: { conversation_id: c.id } }));

    const sorted = [...g].sort((a, b) => {
      const cm = counts.get(b.id) - counts.get(a.id); if (cm) return cm;
      const ir = (isRealInstance(b.instance_name) ? 1 : 0) - (isRealInstance(a.instance_name) ? 1 : 0); if (ir) return ir;
      const lm = new Date(b.last_message_at).getTime() - new Date(a.last_message_at).getTime(); if (lm) return lm;
      return a.id.localeCompare(b.id);
    });
    const canon = sorted[0];
    const dups = sorted.slice(1);
    bump(tenant, 'groups');
    console.log(`\n[lead ${g[0].lead_id}] tenant ${tenant} — ${g.length} conversas | CANONICA ${canon.id} (msgs=${counts.get(canon.id)}, inst=${canon.instance_name || '-'}, ai=${canon.ai_mode})`);

    // Se a canônica ganhou por VOLUME mas ficou com instância PLACEHOLDER ('whatsapp'/
    // null), adota a instância REAL de alguma duplicata do grupo — senão a conversa viva
    // NÃO CONSEGUE ENVIAR (foi a raiz da Bianca: inst='whatsapp' → sends viravam
    // sys_reminder_ sem id do provedor). Mantém as mensagens da canônica + passa a enviar.
    if (!isRealInstance(canon.instance_name)) {
      const realInst = dups.find((d) => isRealInstance(d.instance_name))?.instance_name;
      if (realInst) {
        console.log(`  ⚠ canônica com inst='${canon.instance_name || '-'}' → ADOTA instância real '${realInst}'`);
        if (COMMIT) await prisma.conversation.update({ where: { id: canon.id }, data: { instance_name: realInst } });
      }
    }

    let maxLast = new Date(canon.last_message_at).getTime();
    for (const d of dups) {
      const dMsgs = await prisma.message.findMany({ where: { conversation_id: d.id }, select: { id: true, text: true, direction: true, type: true, created_at: true } });
      let moved = 0, deduped = 0;
      for (const m of dMsgs) {
        let identical = null;
        if (m.type === 'text' && m.text) {
          const lo = new Date(new Date(m.created_at).getTime() - DEDUP_WINDOW_MS);
          const hi = new Date(new Date(m.created_at).getTime() + DEDUP_WINDOW_MS);
          identical = await prisma.message.findFirst({ where: { conversation_id: canon.id, direction: m.direction, text: m.text, created_at: { gte: lo, lte: hi } }, select: { id: true } });
        }
        if (identical) { deduped++; if (COMMIT) await prisma.message.delete({ where: { id: m.id } }).catch(() => {}); }
        else { moved++; if (COMMIT) await prisma.message.update({ where: { id: m.id }, data: { conversation_id: canon.id } }).catch(() => {}); }
      }
      maxLast = Math.max(maxLast, new Date(d.last_message_at).getTime());
      console.log(`  dup ${d.id} (msgs=${counts.get(d.id)}, inst=${d.instance_name || '-'}, ai=${d.ai_mode}) -> mover ${moved}, dedup ${deduped}; ENCERRAR + ai_mode off`);
      bump(tenant, 'moved', moved); bump(tenant, 'dedup', deduped); bump(tenant, 'closed');
      if (COMMIT) await prisma.conversation.update({ where: { id: d.id }, data: { status: 'ENCERRADO', ai_mode: false } });
    }
    if (COMMIT && maxLast > new Date(canon.last_message_at).getTime())
      await prisma.conversation.update({ where: { id: canon.id }, data: { last_message_at: new Date(maxLast) } });
  }

  console.log(`\n=== RESUMO POR TENANT ===`);
  for (const [t, s] of perTenant) console.log(`tenant ${t}: ${s.groups} grupos | ${s.closed} encerradas | ${s.moved} msgs movidas | ${s.dedup} msgs dedup`);
  console.log(COMMIT ? '\nOK (aplicado).' : '\nDRY-RUN (nada mudou). Rode com --commit para aplicar.');
}
main().catch((e) => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());

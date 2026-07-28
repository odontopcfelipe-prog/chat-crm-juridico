/*
 * Limpeza de conversas FINANCEIRO duplicadas (mesmo lead, mesmo inbox financeiro).
 *
 * Contexto: o webhook do Asaas disparava "Pagamento Confirmado" 2x (CONFIRMED +
 * RECEIVED) e o find-or-create nao-atomico criava DUAS Conversation financeiras
 * pro mesmo paciente (uma SOPHIA, outra ATRIBUIDA pelo eco). O fix no codigo
 * impede novas; este script consolida as que JA existem.
 *
 * Estrategia por grupo (lead_id dentro de um inbox purpose=FINANCEIRO):
 *   - Canonica = a que tem assigned_user_id (a que o operador ve). Empate/nenhuma
 *     atribuida -> a de last_message_at mais recente.
 *   - Move as mensagens das duplicadas -> canonica. Mensagem identica (mesmo texto,
 *     mesma direcao, ate 5 min de diferenca, tipo 'text') e DELETADA em vez de movida
 *     (evita duas "Pagamento Confirmado" iguais na canonica).
 *   - last_message_at da canonica = max do grupo.
 *   - Duplicada esvaziada -> status 'ENCERRADO' (soft-close, NAO hard-delete).
 *
 * Uso (dentro do container da API):
 *   node dedup-financeiro-conversations.cjs            # DRY-RUN (so relata)
 *   node dedup-financeiro-conversations.cjs --commit   # aplica
 *   node dedup-financeiro-conversations.cjs --commit --tenant <TENANT_ID>  # so um tenant
 *
 * NAO mistura tenants: a acao e por lead (lead_id e unico por tenant) e o relatorio
 * sai agrupado por tenant.
 */
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const COMMIT = process.argv.includes('--commit');
const tenantArgIdx = process.argv.indexOf('--tenant');
const ONLY_TENANT = tenantArgIdx >= 0 ? process.argv[tenantArgIdx + 1] : null;
const DEDUP_WINDOW_MS = 5 * 60 * 1000;

function log(...a) { console.log(...a); }

async function main() {
  log(`\n=== DEDUP CONVERSAS FINANCEIRO ${COMMIT ? '(COMMIT)' : '(DRY-RUN)'} ===`);
  if (ONLY_TENANT) log(`Filtro de tenant: ${ONLY_TENANT}`);

  // 1) Inboxes financeiros
  const finInboxes = await prisma.inbox.findMany({
    where: { purpose: 'FINANCEIRO', ...(ONLY_TENANT ? { tenant_id: ONLY_TENANT } : {}) },
    select: { id: true, tenant_id: true },
  });
  if (!finInboxes.length) { log('Nenhum inbox FINANCEIRO encontrado.'); return; }
  const finInboxIds = finInboxes.map((i) => i.id);
  log(`Inboxes FINANCEIRO: ${finInboxIds.length}`);

  // 2) Conversas nesses inboxes (nao encerradas)
  const convs = await prisma.conversation.findMany({
    where: { inbox_id: { in: finInboxIds }, status: { not: 'ENCERRADO' } },
    // NB: Conversation NAO tem created_at no schema (so last_message_at).
    select: {
      id: true, lead_id: true, tenant_id: true, inbox_id: true,
      assigned_user_id: true, ai_mode: true, status: true, last_message_at: true,
    },
  });

  // 3) Agrupa por (lead_id + inbox_id)
  const groups = new Map();
  for (const c of convs) {
    const k = `${c.lead_id}::${c.inbox_id}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(c);
  }

  const dupGroups = [...groups.values()].filter((g) => g.length > 1);
  log(`Grupos com duplicata: ${dupGroups.length} (de ${groups.size} leads com conversa financeira)`);

  // relatorio por tenant
  const perTenant = new Map();
  const bump = (t, field, n = 1) => {
    if (!perTenant.has(t)) perTenant.set(t, { groups: 0, closed: 0, moved: 0, dedup: 0 });
    perTenant.get(t)[field] += n;
  };

  for (const g of dupGroups) {
    const tenant = g[0].tenant_id || 'null';
    bump(tenant, 'groups');

    // canonica: assigned primeiro, depois last_message_at desc, depois created_at asc
    const sorted = [...g].sort((a, b) => {
      const aa = a.assigned_user_id ? 1 : 0;
      const bb = b.assigned_user_id ? 1 : 0;
      if (aa !== bb) return bb - aa;
      const lm = new Date(b.last_message_at).getTime() - new Date(a.last_message_at).getTime();
      if (lm !== 0) return lm;
      return a.id.localeCompare(b.id); // desempate estavel (Conversation nao tem created_at)
    });
    const canon = sorted[0];
    const dups = sorted.slice(1);

    log(`\n[lead ${g[0].lead_id}] tenant ${tenant} — ${g.length} conversas`);
    log(`  canonica: ${canon.id} (assigned=${canon.assigned_user_id || '-'}, ai_mode=${canon.ai_mode}, last=${canon.last_message_at.toISOString?.() || canon.last_message_at})`);

    let maxLast = new Date(canon.last_message_at).getTime();

    for (const d of dups) {
      const dMsgs = await prisma.message.findMany({
        where: { conversation_id: d.id },
        select: { id: true, text: true, direction: true, type: true, created_at: true },
      });
      let moved = 0, deduped = 0;
      for (const m of dMsgs) {
        // procura identica na canonica
        let identical = null;
        if (m.type === 'text' && m.text) {
          const lo = new Date(new Date(m.created_at).getTime() - DEDUP_WINDOW_MS);
          const hi = new Date(new Date(m.created_at).getTime() + DEDUP_WINDOW_MS);
          identical = await prisma.message.findFirst({
            where: {
              conversation_id: canon.id, direction: m.direction, text: m.text,
              created_at: { gte: lo, lte: hi },
            },
            select: { id: true },
          });
        }
        if (identical) {
          deduped++;
          if (COMMIT) await prisma.message.delete({ where: { id: m.id } }).catch(() => {});
        } else {
          moved++;
          if (COMMIT) await prisma.message.update({ where: { id: m.id }, data: { conversation_id: canon.id } }).catch(() => {});
        }
      }
      maxLast = Math.max(maxLast, new Date(d.last_message_at).getTime());
      log(`  dup ${d.id}: ${dMsgs.length} msgs -> mover ${moved}, dedup ${deduped}; encerrar`);
      bump(tenant, 'moved', moved);
      bump(tenant, 'dedup', deduped);
      bump(tenant, 'closed');
      if (COMMIT) {
        await prisma.conversation.update({ where: { id: d.id }, data: { status: 'ENCERRADO' } });
      }
    }

    if (COMMIT && maxLast > new Date(canon.last_message_at).getTime()) {
      await prisma.conversation.update({ where: { id: canon.id }, data: { last_message_at: new Date(maxLast) } });
    }
  }

  log(`\n=== RESUMO POR TENANT ===`);
  for (const [t, s] of perTenant) {
    log(`tenant ${t}: ${s.groups} grupos | ${s.closed} conversas encerradas | ${s.moved} msgs movidas | ${s.dedup} msgs dedup`);
  }
  log(COMMIT ? '\nOK (aplicado).' : '\nDRY-RUN (nada mudou). Rode com --commit para aplicar.');
}

main().catch((e) => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());

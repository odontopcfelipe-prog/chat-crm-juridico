// Script para limpar contatos com LID (identificadores do WhatsApp) ao invés de número real
// LIDs têm 14+ dígitos e não são números de telefone válidos

const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient({
  datasources: {
    db: { url: 'postgresql://crm_user:lustosa1125180124@69.62.93.186:45432/lexcrm?schema=public' }
  }
});

async function main() {
  // 1. Busca todos os leads com phone (sem filtro de tamanho, vamos filtrar em JS)
  const allLeads = await prisma.lead.findMany({
    where: { phone: { not: '' } },
    select: {
      id: true,
      phone: true,
      name: true,
      conversations: {
        select: {
          id: true,
          status: true,
          _count: { select: { messages: true } }
        }
      }
    }
  });

  // LIDs têm 14+ dígitos
  const lidLeads = allLeads.filter(l => l.phone && l.phone.replace(/\D/g, '').length > 13);

  console.log(`\n=== CONTATOS LID ENCONTRADOS: ${lidLeads.length} ===\n`);

  if (lidLeads.length === 0) {
    console.log('Nenhum contato LID encontrado. Nada a fazer.');
    await prisma.$disconnect();
    return;
  }

  for (const lead of lidLeads) {
    const totalMsgs = lead.conversations.reduce((sum, c) => sum + c._count.messages, 0);
    console.log(`Lead: ${lead.name || '(sem nome)'}`);
    console.log(`  Phone (LID): ${lead.phone}`);
    console.log(`  Conversas: ${lead.conversations.length} | Mensagens: ${totalMsgs}`);
    console.log(`  IDs das conversas: ${lead.conversations.map(c => c.id).join(', ') || 'nenhuma'}`);
    console.log('');
  }

  const lidIds = lidLeads.map(l => l.id);
  const convIds = lidLeads.flatMap(l => l.conversations.map(c => c.id));

  console.log(`\nVai deletar:`);
  console.log(`  ${lidIds.length} lead(s) com LID`);
  console.log(`  ${convIds.length} conversa(s) vinculada(s)`);

  // 2. Deleta em cascata: mensagens → conversas → leads
  if (convIds.length > 0) {
    // Deleta reações das mensagens (via Prisma para evitar problemas de tipo)
    const msgs = await prisma.message.findMany({
      where: { conversation_id: { in: convIds } },
      select: { id: true }
    });
    const msgIds = msgs.map(m => m.id);
    let reactDel = { count: 0 };
    if (msgIds.length > 0) {
      reactDel = await prisma.$executeRawUnsafe(
        `DELETE FROM "MessageReaction" WHERE message_id::text = ANY($1::text[])`,
        msgIds
      ).then(n => ({ count: n })).catch(() => ({ count: 0 }));
    }
    console.log(`\nReações deletadas: ${reactDel.count}`);

    // Deleta mensagens
    const msgDel = await prisma.message.deleteMany({
      where: { conversation_id: { in: convIds } }
    });
    console.log(`Mensagens deletadas: ${msgDel.count}`);

    // Deleta conversas
    const convDel = await prisma.conversation.deleteMany({
      where: { id: { in: convIds } }
    });
    console.log(`Conversas deletadas: ${convDel.count}`);
  }

  // 3. Deleta os leads LID
  const leadDel = await prisma.lead.deleteMany({
    where: { id: { in: lidIds } }
  });
  console.log(`Leads LID deletados: ${leadDel.count}`);

  console.log('\n✅ Limpeza concluída! Todos os contatos LID foram removidos.');
  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error('Erro:', e.message);
  await prisma.$disconnect();
  process.exit(1);
});

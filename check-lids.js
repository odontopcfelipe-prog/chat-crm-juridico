const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient({
  datasources: { db: { url: 'postgresql://crm_user:lustosa1125180124@69.62.93.186:45432/lexcrm' } }
});
async function main() {
  const all = await prisma.lead.findMany({ select: { phone: true, name: true } });
  const lids = all.filter(l => l.phone && l.phone.replace(/\D/g,'').length > 13);
  console.log('Total leads no banco:', all.length);
  console.log('LIDs restantes:', lids.length);
  if (lids.length > 0) lids.forEach(l => console.log(' LID:', l.phone, '|', l.name));
  else console.log('Banco limpo — nenhum LID encontrado.');

  const g = await prisma.lead.findFirst({
    where: { name: { contains: 'Guilherme', mode: 'insensitive' } },
    include: { conversations: { select: { id: true, status: true, external_id: true } } }
  });
  if (g) {
    console.log('\nGuilherme Porto:', g.phone, '| convs:', g.conversations.length);
    g.conversations.forEach(c => console.log('  conv:', c.id, c.status, c.external_id));
  }
  await prisma.$disconnect();
}
main().catch(e => console.error(e.message));

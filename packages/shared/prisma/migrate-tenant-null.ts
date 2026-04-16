/**
 * migrate-tenant-null.ts
 *
 * Popula tenant_id = null em todas as tabelas que possuem esse campo,
 * usando o tenant padrão (id fixo do seed).
 *
 * Executar com:
 *   cd packages/shared && npx ts-node prisma/migrate-tenant-null.ts
 */

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const DEFAULT_TENANT_ID = '00000000-0000-0000-0000-000000000000';

type MigrationResult = { table: string; updated: number };

async function main() {
  console.log('🔍 Verificando tenant padrão...');
  const tenant = await prisma.tenant.findUnique({ where: { id: DEFAULT_TENANT_ID } });
  if (!tenant) {
    console.error(`❌ Tenant padrão (${DEFAULT_TENANT_ID}) não encontrado no banco.`);
    console.error('   Execute primeiro: npx prisma db seed');
    process.exit(1);
  }
  console.log(`✅ Tenant padrão encontrado: "${tenant.name}"`);

  const results: MigrationResult[] = [];

  // ── Tabelas com tenant_id opcional ────────────────────────────────────────
  const tables: Array<{ name: string; update: () => Promise<{ count: number }> }> = [
    {
      name: 'Conversation',
      update: () => prisma.conversation.updateMany({ where: { tenant_id: null }, data: { tenant_id: DEFAULT_TENANT_ID } }),
    },
    {
      name: 'Lead',
      update: () => prisma.lead.updateMany({ where: { tenant_id: null }, data: { tenant_id: DEFAULT_TENANT_ID } }),
    },
    {
      name: 'User',
      update: () => prisma.user.updateMany({ where: { tenant_id: null }, data: { tenant_id: DEFAULT_TENANT_ID } }),
    },
    {
      name: 'Task',
      update: () => prisma.task.updateMany({ where: { tenant_id: null }, data: { tenant_id: DEFAULT_TENANT_ID } }),
    },
    {
      name: 'Inbox',
      update: () => prisma.inbox.updateMany({ where: { tenant_id: null }, data: { tenant_id: DEFAULT_TENANT_ID } }),
    },
    {
      name: 'Instance',
      update: () => prisma.instance.updateMany({ where: { tenant_id: null }, data: { tenant_id: DEFAULT_TENANT_ID } }),
    },
    {
      name: 'LegalCase',
      update: () => prisma.legalCase.updateMany({ where: { tenant_id: null }, data: { tenant_id: DEFAULT_TENANT_ID } }),
    },
    {
      name: 'CalendarEvent',
      update: () => prisma.calendarEvent.updateMany({ where: { tenant_id: null }, data: { tenant_id: DEFAULT_TENANT_ID } }),
    },
    {
      name: 'AppointmentType',
      update: () => prisma.appointmentType.updateMany({ where: { tenant_id: null }, data: { tenant_id: DEFAULT_TENANT_ID } }),
    },
    {
      name: 'Holiday',
      update: () => prisma.holiday.updateMany({ where: { tenant_id: null }, data: { tenant_id: DEFAULT_TENANT_ID } }),
    },
    {
      name: 'CaseDocument',
      update: () => prisma.caseDocument.updateMany({ where: { tenant_id: null }, data: { tenant_id: DEFAULT_TENANT_ID } }),
    },
    {
      name: 'CaseDeadline',
      update: () => prisma.caseDeadline.updateMany({ where: { tenant_id: null }, data: { tenant_id: DEFAULT_TENANT_ID } }),
    },
    {
      name: 'LegalTemplate',
      update: () => prisma.legalTemplate.updateMany({ where: { tenant_id: null }, data: { tenant_id: DEFAULT_TENANT_ID } }),
    },
    {
      name: 'AiChat',
      update: () => prisma.aiChat.updateMany({ where: { tenant_id: null }, data: { tenant_id: DEFAULT_TENANT_ID } }),
    },
    // FollowupSequence: não existe no cliente Prisma gerado atualmente — pular
  ];

  console.log('\n📦 Iniciando migração...\n');

  let totalUpdated = 0;
  for (const t of tables) {
    try {
      const result = await t.update();
      results.push({ table: t.name, updated: result.count });
      if (result.count > 0) {
        console.log(`  ✅ ${t.name}: ${result.count} registro(s) atualizado(s)`);
        totalUpdated += result.count;
      } else {
        console.log(`  ⬜ ${t.name}: nenhum registro com tenant_id null`);
      }
    } catch (e: any) {
      console.warn(`  ⚠️  ${t.name}: erro - ${e.message}`);
    }
  }

  console.log(`\n🎉 Migração concluída! Total atualizado: ${totalUpdated} registro(s)`);
  console.log('\nAgora é seguro aplicar tenant isolation estrito no código.');
}

main()
  .catch((e) => {
    console.error('Erro fatal na migração:', e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());

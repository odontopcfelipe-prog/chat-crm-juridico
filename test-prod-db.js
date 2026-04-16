const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient({
  datasources: {
    db: {
      url: "postgresql://crm_user:lustosa1125180124@69.62.93.186:45432/lexcrm?schema=public"
    }
  }
});

async function main() {
  console.log('Testing connection to production database...');
  try {
    const result = await prisma.$queryRaw`SELECT 1 as connected`;
    console.log('Successfully connected:', result);
  } catch (err) {
    console.error('Connection failed:', err.message);
  } finally {
    await prisma.$disconnect();
  }
}

main();

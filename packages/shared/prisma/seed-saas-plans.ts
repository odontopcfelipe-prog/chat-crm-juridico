/**
 * Onda 17.32.86 — Seed inicial dos planos SaaS.
 *
 * Roda manualmente apos migration:
 *   npx ts-node packages/shared/prisma/seed-saas-plans.ts
 *
 * Idempotente: upsert por slug.
 */
import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

const PLANS = [
  {
    slug: 'starter',
    name: 'Starter',
    description: 'Pra clínicas pequenas começando',
    price_monthly: 199,
    max_users: 5,
    max_patients: 300,
    max_inboxes: 1,
    max_charges_month: 100,
    features_json: JSON.stringify([
      'Até 5 usuários',
      'Até 300 pacientes',
      '1 WhatsApp conectado',
      'Cobranças Asaas',
      'Agenda + prontuário',
    ]),
    display_order: 1,
  },
  {
    slug: 'pro',
    name: 'Pro',
    description: 'Pra clínicas em crescimento',
    price_monthly: 399,
    max_users: 20,
    max_patients: 3000,
    max_inboxes: 3,
    max_charges_month: 1000,
    features_json: JSON.stringify([
      'Tudo do Starter',
      'Até 20 usuários',
      'Até 3000 pacientes',
      '3 WhatsApps conectados',
      'ClickSign integrado',
      'Relatórios avançados',
    ]),
    display_order: 2,
  },
  {
    slug: 'enterprise',
    name: 'Enterprise',
    description: 'Pra redes e franquias',
    price_monthly: 999,
    max_users: -1,
    max_patients: -1,
    max_inboxes: 10,
    max_charges_month: -1,
    features_json: JSON.stringify([
      'Tudo do Pro',
      'Usuários ilimitados',
      'Pacientes ilimitados',
      'Até 10 WhatsApps',
      'Multi-unidade',
      'Suporte prioritário',
    ]),
    display_order: 3,
  },
];

async function main() {
  for (const p of PLANS) {
    await prisma.saasPlan.upsert({
      where: { slug: p.slug },
      create: p,
      update: p,
    });
    console.log(`✓ Plano ${p.slug} (${p.name}) — R$ ${p.price_monthly}/mês`);
  }
  console.log('\nDone.');
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

// ============================================================================
// Seed — Estetica Facial Avancada (Fase 6)
// ============================================================================
//
// Adiciona ~30 procedimentos esteticos faciais ao tenant existente.
// Idempotente: usa upsert por (tenant_id, name).
//
// Uso:
//   cd packages/shared && npx ts-node prisma/seed-estetica-facial.ts
//
// Pre-requisitos:
//   1. Migration 2026-04-21-schema-estetica-facial.sql aplicada
//   2. Existe pelo menos 1 Tenant + Specialty "Estetica" (criada pelo seed.ts)

type EstheticProcedureSeed = {
  name: string;
  category: string;
  duration: number;
  price: number;
  default_revisit_months?: number;
  description?: string;
  post_procedure_instructions?: string;
};

// ============================================================================
// Procedimentos esteticos faciais (categoria detalhada por tipo de tratamento)
// ============================================================================
const ESTHETIC_PROCEDURES: EstheticProcedureSeed[] = [
  // -- Toxina Botulinica (validade media 4-6 meses)
  {
    name: 'Toxina botulinica - terco superior (frontal + glabela + pe-de-galinha)',
    category: 'TOXINA_BOTULINICA',
    duration: 30,
    price: 1200,
    default_revisit_months: 5,
    description: 'Aplicacao de toxina botulinica nas regioes frontal, glabela e periocular para suavizacao de rugas dinamicas.',
    post_procedure_instructions: 'Nao deitar nas primeiras 4h. Evitar exercicios fisicos por 24h. Nao massagear a regiao por 48h. Resultado completo em 7-14 dias.',
  },
  {
    name: 'Toxina botulinica - bruxismo (masseter)',
    category: 'TOXINA_BOTULINICA',
    duration: 20,
    price: 900,
    default_revisit_months: 6,
    description: 'Aplicacao bilateral em masseter para tratamento de bruxismo, cefaleia tensional e contorno mandibular.',
    post_procedure_instructions: 'Mastigacao normal apos 24h. Pode haver leve fadiga muscular nos primeiros dias.',
  },
  {
    name: 'Toxina botulinica - sorriso gengival',
    category: 'TOXINA_BOTULINICA',
    duration: 15,
    price: 600,
    default_revisit_months: 4,
    description: 'Aplicacao no labio superior para reducao da exposicao gengival ao sorrir.',
  },
  {
    name: 'Toxina botulinica - hiperidrose axilar',
    category: 'TOXINA_BOTULINICA',
    duration: 30,
    price: 1800,
    default_revisit_months: 6,
    description: 'Aplicacao bilateral em axilas para controle de sudorese excessiva.',
  },

  // -- Preenchimento com Acido Hialuronico (validade 12-18 meses)
  {
    name: 'Preenchimento labial com acido hialuronico (1mL)',
    category: 'PREENCHIMENTO_AH',
    duration: 45,
    price: 1800,
    default_revisit_months: 12,
    description: 'Hidratacao, contorno e/ou volume labial com acido hialuronico.',
    post_procedure_instructions: 'Compressas frias nas primeiras 24h. Evitar exposicao solar e calor (sauna, hammam) por 7 dias. Edema pode durar 3-7 dias.',
  },
  {
    name: 'Preenchimento de olheiras (1mL)',
    category: 'PREENCHIMENTO_AH',
    duration: 45,
    price: 2200,
    default_revisit_months: 15,
    description: 'Preenchimento da regiao palpebral inferior para correcao do sulco lacrimal.',
    post_procedure_instructions: 'Compressas frias 48h. Evitar dormir de bruco. Resultado final em 30 dias.',
  },
  {
    name: 'Preenchimento de sulco nasolabial (1mL)',
    category: 'PREENCHIMENTO_AH',
    duration: 30,
    price: 1700,
    default_revisit_months: 14,
    description: 'Suavizacao das linhas nasogeneanas (do nariz a comissura labial).',
  },
  {
    name: 'Preenchimento de marionete (1mL)',
    category: 'PREENCHIMENTO_AH',
    duration: 30,
    price: 1700,
    default_revisit_months: 14,
    description: 'Correcao das linhas verticais da comissura labial em direcao ao mento.',
  },
  {
    name: 'Preenchimento malar / malocao (1mL)',
    category: 'PREENCHIMENTO_AH',
    duration: 45,
    price: 2400,
    default_revisit_months: 18,
    description: 'Projecao da regiao zigomatica para harmonizacao do terco medio facial.',
  },
  {
    name: 'Preenchimento de mento (1mL)',
    category: 'PREENCHIMENTO_AH',
    duration: 30,
    price: 2000,
    default_revisit_months: 16,
    description: 'Projecao do queixo para equilibrio do perfil facial.',
  },
  {
    name: 'Preenchimento de mandibula / contorno (1mL)',
    category: 'PREENCHIMENTO_AH',
    duration: 45,
    price: 2200,
    default_revisit_months: 16,
    description: 'Definicao do angulo mandibular e linha do contorno facial.',
  },
  {
    name: 'Rinomodelacao com acido hialuronico (1mL)',
    category: 'PREENCHIMENTO_AH',
    duration: 45,
    price: 2500,
    default_revisit_months: 14,
    description: 'Correcao de assimetrias e elevacao da ponta nasal sem cirurgia.',
    post_procedure_instructions: 'Procedimento de risco vascular — qualquer alteracao de coloracao da pele, dor intensa ou alteracao visual: contatar imediatamente.',
  },

  // -- Bioestimuladores (validade 18-24 meses)
  {
    name: 'Bioestimulador de colageno - Sculptra (frasco)',
    category: 'BIOESTIMULADOR',
    duration: 60,
    price: 3500,
    default_revisit_months: 24,
    description: 'Acido poli-L-latico para estimulo de neocolagenese facial. Resultado progressivo em 60-90 dias.',
    post_procedure_instructions: 'Massagem facial (5-5-5: 5min, 5x/dia, 5 dias). Compressas frias nas primeiras 24h.',
  },
  {
    name: 'Bioestimulador de colageno - Radiesse (seringa)',
    category: 'BIOESTIMULADOR',
    duration: 45,
    price: 2800,
    default_revisit_months: 18,
    description: 'Hidroxiapatita de calcio para volume imediato + bioestimulacao tardia.',
  },
  {
    name: 'Bioestimulador de colageno - Ellanse (seringa)',
    category: 'BIOESTIMULADOR',
    duration: 45,
    price: 3200,
    default_revisit_months: 24,
    description: 'Policaprolactona — duracao prolongada com estimulo colagenico.',
  },

  // -- Fios (validade 12-18 meses)
  {
    name: 'Fios de sustentacao PDO (10 fios)',
    category: 'FIOS_PDO',
    duration: 60,
    price: 2500,
    default_revisit_months: 12,
    description: 'Lifting facial nao-cirurgico com fios de polidioxanona — efeito mecanico + bioestimulo.',
    post_procedure_instructions: 'Evitar movimentos faciais bruscos por 7 dias. Dormir de barriga para cima por 7 dias. Sem exercicios fisicos por 14 dias.',
  },
  {
    name: 'Fios de sustentacao PLLA (5 fios)',
    category: 'FIOS_PLLA',
    duration: 90,
    price: 4500,
    default_revisit_months: 18,
    description: 'Fios de acido poli-L-latico — efeito de tracao mais intenso e duradouro.',
  },

  // -- Peelings Quimicos
  {
    name: 'Peeling quimico superficial (acido glicolico)',
    category: 'PEELING_QUIMICO',
    duration: 45,
    price: 350,
    description: 'Renovacao celular suave para uniformizar tom e textura.',
    post_procedure_instructions: 'Filtro solar FPS 50+ obrigatorio. Hidratacao intensiva. Sem exposicao solar direta por 7 dias.',
  },
  {
    name: 'Peeling quimico medio (TCA 15-25%)',
    category: 'PEELING_QUIMICO',
    duration: 60,
    price: 800,
    description: 'Tratamento de manchas, cicatrizes superficiais de acne e fotoenvelhecimento.',
    post_procedure_instructions: 'Descamacao por 5-7 dias. Nao retirar peles soltas. FPS 50+ rigoroso por 30 dias.',
  },
  {
    name: 'Peeling de fenol (cabine)',
    category: 'PEELING_QUIMICO',
    duration: 120,
    price: 4500,
    description: 'Peeling profundo para fotoenvelhecimento severo e cicatrizes profundas. Procedimento ambulatorial.',
  },

  // -- Microagulhamento / Drug Delivery
  {
    name: 'Microagulhamento facial (sessao)',
    category: 'MICROAGULHAMENTO',
    duration: 60,
    price: 450,
    description: 'Inducao de neocolagenese por estimulo mecanico. Pode ser combinado com drug delivery.',
    post_procedure_instructions: 'Pele sensivel por 24-48h. Sem maquiagem por 24h. Hidratacao + FPS rigoroso.',
  },
  {
    name: 'Microagulhamento + drug delivery vitamina C',
    category: 'MICROAGULHAMENTO',
    duration: 75,
    price: 600,
    description: 'Microagulhamento associado a aplicacao topica de vitamina C para luminosidade.',
  },

  // -- Skinbooster (hidratacao profunda)
  {
    name: 'Skinbooster facial (1 sessao)',
    category: 'SKINBOOSTER',
    duration: 45,
    price: 1500,
    default_revisit_months: 6,
    description: 'Acido hialuronico nao reticulado para hidratacao profunda. Protocolo: 3 sessoes mensais.',
  },
  {
    name: 'Skinbooster colo / decote (1 sessao)',
    category: 'SKINBOOSTER',
    duration: 45,
    price: 1800,
    default_revisit_months: 6,
    description: 'Tratamento da textura e flacidez da regiao do colo.',
  },

  // -- Laser
  {
    name: 'Laser de CO2 fracionado - face completa',
    category: 'LASER',
    duration: 90,
    price: 2800,
    description: 'Renovacao cutanea profunda — manchas, rugas, cicatrizes.',
    post_procedure_instructions: 'Eritema e descamacao por 5-10 dias. FPS 50+ obrigatorio por 60 dias. Sem exposicao solar direta.',
  },
  {
    name: 'Laser de Erbium (Yag) - rejuvenescimento',
    category: 'LASER',
    duration: 75,
    price: 2200,
    description: 'Laser ablativo mais suave — recuperacao mais rapida que CO2.',
  },
  {
    name: 'Luz Intensa Pulsada (IPL) - manchas',
    category: 'LASER',
    duration: 45,
    price: 600,
    description: 'Tratamento de melasma, melanose solar e vasos faciais.',
  },

  // -- Radiofrequencia / Ultrassom
  {
    name: 'Radiofrequencia facial (sessao)',
    category: 'RADIOFREQUENCIA',
    duration: 45,
    price: 450,
    description: 'Estimulo de colageno por aquecimento controlado da derme. Protocolo: 6-10 sessoes semanais.',
  },
  {
    name: 'Ultrassom microfocado - Ulthera (face)',
    category: 'ULTRASSOM_MICROFOCADO',
    duration: 90,
    price: 6500,
    default_revisit_months: 18,
    description: 'Lifting nao-cirurgico de SMAS. Resultado progressivo em 90-180 dias.',
  },

  // -- Lipo Enzimatica
  {
    name: 'Enzimas para gordura submentoniana (papada)',
    category: 'LIPO_ENZIMATICA',
    duration: 30,
    price: 800,
    description: 'Aplicacao de enzimas lipoliticas (desoxicolato/L-carnitina) para reducao de gordura localizada.',
    post_procedure_instructions: 'Edema importante por 5-10 dias. Compressas frias. Pode necessitar 2-4 sessoes mensais.',
  },

  // -- Limpeza de pele
  {
    name: 'Limpeza de pele profunda',
    category: 'LIMPEZA_PELE',
    duration: 90,
    price: 250,
    description: 'Higienizacao, esfoliacao, extracao de comedoes, mascara e finalizacao com FPS.',
  },
];

async function main() {
  console.log('Seedando procedimentos esteticos faciais...');

  // Pega o primeiro tenant disponivel (cenario tipico: 1 tenant ja existe)
  const tenant = await prisma.tenant.findFirst();
  if (!tenant) {
    throw new Error('Nenhum Tenant encontrado. Rode npm run db:seed primeiro.');
  }
  console.log(`Tenant alvo: ${tenant.name} (${tenant.id})`);

  // Garante que existe Specialty "Estetica"
  let specialty = await prisma.specialty.findFirst({
    where: { tenant_id: tenant.id, name: 'Estética' },
  });
  if (!specialty) {
    console.log('Specialty "Estética" nao existe — criando...');
    specialty = await prisma.specialty.create({
      data: {
        tenant_id: tenant.id,
        name: 'Estética',
        description: 'Procedimentos esteticos faciais e harmonizacao orofacial',
        active: true,
      },
    });
  }

  let created = 0;
  let updated = 0;

  for (const p of ESTHETIC_PROCEDURES) {
    const existing = await prisma.procedure.findUnique({
      where: { tenant_id_name: { tenant_id: tenant.id, name: p.name } },
    });

    if (existing) {
      await prisma.procedure.update({
        where: { id: existing.id },
        data: {
          specialty_id: specialty.id,
          category: p.category,
          duration_minutes: p.duration,
          base_price: p.price,
          is_facial_application: true,
          default_revisit_months: p.default_revisit_months,
          description: p.description,
          post_procedure_instructions: p.post_procedure_instructions,
        },
      });
      updated++;
    } else {
      await prisma.procedure.create({
        data: {
          tenant_id: tenant.id,
          specialty_id: specialty.id,
          name: p.name,
          category: p.category,
          duration_minutes: p.duration,
          base_price: p.price,
          is_facial_application: true,
          default_revisit_months: p.default_revisit_months,
          description: p.description,
          post_procedure_instructions: p.post_procedure_instructions,
          active: true,
        },
      });
      created++;
    }
  }

  console.log(`OK — ${created} criados, ${updated} atualizados, total ${ESTHETIC_PROCEDURES.length}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

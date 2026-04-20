import { PrismaClient } from '@prisma/client';
import * as argon2 from 'argon2';

const prisma = new PrismaClient();

// ============================================================================
// Seed data — Odontologia (Fase 2)
// ============================================================================

const SPECIALTIES = [
  { name: 'Clínica Geral', description: 'Atendimento geral odontológico' },
  { name: 'Ortodontia', description: 'Correção de posicionamento dentário' },
  { name: 'Endodontia', description: 'Tratamento de canal' },
  { name: 'Implantodontia', description: 'Implantes dentários' },
  { name: 'Prótese', description: 'Próteses fixas e removíveis' },
  { name: 'Estética', description: 'Clareamento, facetas e procedimentos cosméticos' },
  { name: 'Periodontia', description: 'Tratamento de tecidos gengivais e de sustentação' },
  { name: 'Cirurgia Oral', description: 'Extrações e cirurgias menores' },
  { name: 'Odontopediatria', description: 'Atendimento infantil (dentição decídua e mista)' },
];

type ProcedureSeed = {
  name: string;
  specialty: string;
  duration: number;
  price: number;
  xray?: boolean;
  anesthesia?: boolean;
};

const PROCEDURES: ProcedureSeed[] = [
  // Clínica Geral
  { name: 'Avaliação inicial', specialty: 'Clínica Geral', duration: 30, price: 0 },
  { name: 'Profilaxia (limpeza)', specialty: 'Clínica Geral', duration: 45, price: 150 },
  { name: 'Aplicação tópica de flúor', specialty: 'Clínica Geral', duration: 15, price: 50 },
  { name: 'Restauração em resina — 1 face', specialty: 'Clínica Geral', duration: 40, price: 200 },
  { name: 'Restauração em resina — 2 faces', specialty: 'Clínica Geral', duration: 60, price: 300 },
  { name: 'Restauração em resina — 3+ faces', specialty: 'Clínica Geral', duration: 75, price: 400 },
  { name: 'Selante', specialty: 'Clínica Geral', duration: 20, price: 80 },
  { name: 'Consulta de urgência', specialty: 'Clínica Geral', duration: 30, price: 150 },
  // Endodontia
  { name: 'Tratamento endodôntico — unirradicular', specialty: 'Endodontia', duration: 90, price: 800, xray: true },
  { name: 'Tratamento endodôntico — birradicular', specialty: 'Endodontia', duration: 120, price: 1000, xray: true },
  { name: 'Tratamento endodôntico — multirradicular', specialty: 'Endodontia', duration: 150, price: 1300, xray: true },
  // Periodontia
  { name: 'Raspagem supragengival', specialty: 'Periodontia', duration: 45, price: 200 },
  { name: 'Raspagem subgengival (1 quadrante)', specialty: 'Periodontia', duration: 60, price: 350 },
  { name: 'Cirurgia periodontal', specialty: 'Periodontia', duration: 90, price: 800, anesthesia: true },
  // Cirurgia Oral
  { name: 'Extração simples', specialty: 'Cirurgia Oral', duration: 30, price: 200, anesthesia: true },
  { name: 'Extração de siso', specialty: 'Cirurgia Oral', duration: 60, price: 500, anesthesia: true, xray: true },
  { name: 'Biópsia oral', specialty: 'Cirurgia Oral', duration: 45, price: 400, anesthesia: true },
  { name: 'Sutura de ferida', specialty: 'Cirurgia Oral', duration: 20, price: 100 },
  // Prótese
  { name: 'Coroa protética cerâmica', specialty: 'Prótese', duration: 90, price: 1500, xray: true },
  { name: 'Prótese total', specialty: 'Prótese', duration: 180, price: 2500 },
  { name: 'Prótese parcial removível', specialty: 'Prótese', duration: 150, price: 1800 },
  // Implantodontia
  { name: 'Implante dentário — por unidade', specialty: 'Implantodontia', duration: 120, price: 3500, anesthesia: true, xray: true },
  { name: 'Coroa sobre implante', specialty: 'Implantodontia', duration: 90, price: 2000 },
  { name: 'Enxerto ósseo', specialty: 'Implantodontia', duration: 120, price: 1500, anesthesia: true, xray: true },
  // Ortodontia
  { name: 'Instalação de aparelho fixo', specialty: 'Ortodontia', duration: 90, price: 2500 },
  { name: 'Manutenção mensal de aparelho', specialty: 'Ortodontia', duration: 30, price: 250 },
  { name: 'Alinhador ortodôntico transparente — tratamento completo', specialty: 'Ortodontia', duration: 60, price: 12000 },
  // Estética
  { name: 'Clareamento dental de consultório', specialty: 'Estética', duration: 90, price: 1200 },
  { name: 'Clareamento dental com moldeira', specialty: 'Estética', duration: 30, price: 600 },
  { name: 'Faceta de porcelana — por unidade', specialty: 'Estética', duration: 120, price: 2500 },
];

const ANAMNESIS_TEMPLATE_V1 = {
  sections: [
    {
      id: 'general',
      title: 'Dados Gerais',
      questions: [
        { id: 'height', type: 'number', label: 'Altura (cm)', required: false },
        { id: 'weight', type: 'number', label: 'Peso (kg)', required: false },
      ],
    },
    {
      id: 'medical_history',
      title: 'Histórico Médico',
      questions: [
        {
          id: 'chronic_diseases',
          type: 'multiselect',
          label: 'Possui alguma doença crônica?',
          options: [
            'Diabetes',
            'Hipertensão',
            'Doença cardíaca',
            'Doença renal',
            'Doença hepática',
            'Problema de tireoide',
            'Outra',
          ],
          required: false,
        },
        { id: 'chronic_disease_other', type: 'text', label: 'Se outra, especifique', required: false },
        { id: 'surgeries', type: 'textarea', label: 'Já fez alguma cirurgia? Qual(is)?', required: false },
        { id: 'hospitalizations', type: 'textarea', label: 'Esteve hospitalizado nos últimos 2 anos?', required: false },
      ],
    },
    {
      id: 'allergies_meds',
      title: 'Alergias e Medicamentos',
      questions: [
        { id: 'allergies_known', type: 'boolean', label: 'Possui alergias conhecidas?', required: true },
        { id: 'allergies_list', type: 'textarea', label: 'Se sim, quais?', required: false },
        { id: 'medications_current', type: 'textarea', label: 'Medicamentos em uso (nome, dose, frequência)', required: false },
      ],
    },
    {
      id: 'lifestyle',
      title: 'Hábitos e Estilo de Vida',
      questions: [
        {
          id: 'smoker',
          type: 'select',
          label: 'Fuma?',
          options: ['Nunca', 'Ex-fumante', 'Fumante ocasional', 'Fumante diário'],
          required: true,
        },
        {
          id: 'alcohol',
          type: 'select',
          label: 'Consome álcool?',
          options: ['Não', 'Socialmente', 'Frequentemente', 'Diariamente'],
          required: false,
        },
        { id: 'bruxism', type: 'boolean', label: 'Aperta ou range os dentes (bruxismo)?', required: false },
      ],
    },
    {
      id: 'dental_history',
      title: 'Histórico Odontológico',
      questions: [
        {
          id: 'last_visit',
          type: 'select',
          label: 'Quando foi sua última consulta odontológica?',
          options: ['Menos de 6 meses', '6 a 12 meses', '1 a 2 anos', 'Mais de 2 anos', 'Nunca'],
          required: true,
        },
        {
          id: 'brushing_frequency',
          type: 'select',
          label: 'Frequência de escovação',
          options: ['1x ao dia', '2x ao dia', '3x ao dia', 'Mais de 3x ao dia'],
          required: true,
        },
        { id: 'floss_use', type: 'boolean', label: 'Usa fio dental diariamente?', required: true },
        { id: 'pain_current', type: 'boolean', label: 'Sente dor em algum dente agora?', required: true },
        { id: 'pain_description', type: 'textarea', label: 'Se sim, descreva a dor e localização', required: false },
        {
          id: 'sensitivity',
          type: 'multiselect',
          label: 'Sensibilidade a:',
          options: ['Frio', 'Calor', 'Doces', 'Pressão', 'Nenhuma'],
          required: false,
        },
      ],
    },
    {
      id: 'pregnancy',
      title: 'Gravidez (se aplicável)',
      questions: [
        { id: 'pregnant', type: 'boolean', label: 'Está gestante?', required: false },
        { id: 'pregnancy_weeks', type: 'number', label: 'Se sim, quantas semanas?', required: false },
        { id: 'breastfeeding', type: 'boolean', label: 'Está amamentando?', required: false },
      ],
    },
  ],
};

// ============================================================================
// Main seed
// ============================================================================

async function main() {
  console.log('Iniciando o Seed do Banco de Dados...');

  // 1. Tenant + Admin (mantidos por compatibilidade com dev existente)
  const tenant = await prisma.tenant.upsert({
    where: { id: '00000000-0000-0000-0000-000000000000' },
    update: {},
    create: {
      id: '00000000-0000-0000-0000-000000000000',
      name: 'Escritório Padrão',
    },
  });

  const passwordHash = await argon2.hash('admin123');

  await prisma.user.upsert({
    where: { email: 'admin@lexcrm.com.br' },
    update: {},
    create: {
      email: 'admin@lexcrm.com.br',
      name: 'Admin Master',
      roles: ['ADMIN'],
      password_hash: passwordHash,
      tenant_id: tenant.id,
    },
  });

  // 2. Specialties (9)
  console.log('Seedando Specialties...');
  const specialtyByName: Record<string, string> = {};
  for (const s of SPECIALTIES) {
    const spec = await prisma.specialty.upsert({
      where: { tenant_id_name: { tenant_id: tenant.id, name: s.name } },
      update: { description: s.description },
      create: {
        tenant_id: tenant.id,
        name: s.name,
        description: s.description,
      },
    });
    specialtyByName[s.name] = spec.id;
  }
  console.log(`  ${SPECIALTIES.length} especialidades OK`);

  // 3. Procedures (~30)
  console.log('Seedando Procedures...');
  for (const p of PROCEDURES) {
    await prisma.procedure.upsert({
      where: { tenant_id_name: { tenant_id: tenant.id, name: p.name } },
      update: {
        specialty_id: specialtyByName[p.specialty],
        duration_minutes: p.duration,
        base_price: p.price,
        requires_x_ray: p.xray ?? false,
        requires_anesthesia: p.anesthesia ?? false,
      },
      create: {
        tenant_id: tenant.id,
        specialty_id: specialtyByName[p.specialty],
        name: p.name,
        duration_minutes: p.duration,
        base_price: p.price,
        requires_x_ray: p.xray ?? false,
        requires_anesthesia: p.anesthesia ?? false,
      },
    });
  }
  console.log(`  ${PROCEDURES.length} procedimentos OK`);

  // 4. AnamnesisTemplate v1
  console.log('Seedando AnamnesisTemplate v1...');
  await prisma.anamnesisTemplate.upsert({
    where: { tenant_id_version: { tenant_id: tenant.id, version: 1 } },
    update: {},
    create: {
      tenant_id: tenant.id,
      version: 1,
      schema: ANAMNESIS_TEMPLATE_V1,
      active: true,
      notes: 'Template inicial — 6 seções padrão de anamnese odontológica.',
    },
  });
  console.log('  AnamnesisTemplate v1 OK');

  console.log('\nSeed completo ✅');
  console.log('Usuário: admin@lexcrm.com.br | Senha: admin123');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

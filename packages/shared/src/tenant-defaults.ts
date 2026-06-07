/**
 * Onda 17.32.109 — Defaults plantados em CADA tenant novo.
 *
 * O que tem aqui:
 *  - DEFAULT_SPECIALTIES       — 9 especialidades odontologicas
 *  - DEFAULT_PROCEDURES        — 30 procedimentos com precos base sugeridos
 *  - DEFAULT_ANAMNESIS_TEMPLATE — V3 odontologico (9 secoes, gestacao
 *                                 condicional ao sexo, todos opcionais)
 *  - seedTenantDefaults(prisma, tenantId) — funcao idempotente que faz
 *                                            upsert dessas 3 categorias
 *                                            no tenant.
 *
 * Usado em 2 lugares:
 *  1. apps/api/src/tenants/tenants.service.ts — ao criar um tenant via
 *     signup ou pelo admin do SaaS, popula automaticamente.
 *  2. packages/shared/prisma/seed.ts — seed do Instituto continua usando
 *     pra manter os dados em dia (DRY: uma fonte de verdade).
 *
 * Eh idempotente — upsert por (tenant_id, nome) na Procedure/Specialty
 * e por (tenant_id, version) no AnamnesisTemplate. Pode rodar de novo
 * sem duplicar.
 */
import type { PrismaClient } from '@prisma/client';

// ─── Especialidades padrao ───────────────────────────────────────
export const DEFAULT_SPECIALTIES = [
  { name: 'Clínica Geral',  description: 'Atendimento geral odontológico' },
  { name: 'Ortodontia',     description: 'Correção de posicionamento dentário' },
  { name: 'Endodontia',     description: 'Tratamento de canal' },
  { name: 'Implantodontia', description: 'Implantes dentários' },
  { name: 'Prótese',        description: 'Próteses fixas e removíveis' },
  { name: 'Estética',       description: 'Clareamento, facetas e procedimentos cosméticos' },
  { name: 'Periodontia',    description: 'Tratamento de tecidos gengivais e de sustentação' },
  { name: 'Cirurgia Oral',  description: 'Extrações e cirurgias menores' },
  { name: 'Odontopediatria',description: 'Atendimento infantil (dentição decídua e mista)' },
] as const;

// ─── Tabela de precos padrao (30 procedimentos) ──────────────────
export interface ProcedureDefault {
  name: string;
  specialty: string;     // bate com DEFAULT_SPECIALTIES[i].name
  duration: number;
  price: number;
  xray?: boolean;
  anesthesia?: boolean;
}

export const DEFAULT_PROCEDURES: ProcedureDefault[] = [
  // Clínica Geral
  { name: 'Avaliação inicial',                       specialty: 'Clínica Geral', duration: 30, price: 0 },
  { name: 'Profilaxia (limpeza)',                    specialty: 'Clínica Geral', duration: 45, price: 150 },
  { name: 'Aplicação tópica de flúor',               specialty: 'Clínica Geral', duration: 15, price: 50 },
  { name: 'Restauração em resina — 1 face',          specialty: 'Clínica Geral', duration: 40, price: 200 },
  { name: 'Restauração em resina — 2 faces',         specialty: 'Clínica Geral', duration: 60, price: 300 },
  { name: 'Restauração em resina — 3+ faces',        specialty: 'Clínica Geral', duration: 75, price: 400 },
  { name: 'Selante',                                  specialty: 'Clínica Geral', duration: 20, price: 80 },
  { name: 'Consulta de urgência',                    specialty: 'Clínica Geral', duration: 30, price: 150 },
  // Endodontia
  { name: 'Tratamento endodôntico — unirradicular',  specialty: 'Endodontia', duration:  90, price:  800, xray: true },
  { name: 'Tratamento endodôntico — birradicular',   specialty: 'Endodontia', duration: 120, price: 1000, xray: true },
  { name: 'Tratamento endodôntico — multirradicular',specialty: 'Endodontia', duration: 150, price: 1300, xray: true },
  // Periodontia
  { name: 'Raspagem supragengival',                  specialty: 'Periodontia', duration: 45, price: 200 },
  { name: 'Raspagem subgengival (1 quadrante)',      specialty: 'Periodontia', duration: 60, price: 350 },
  { name: 'Cirurgia periodontal',                    specialty: 'Periodontia', duration: 90, price: 800, anesthesia: true },
  // Cirurgia Oral
  { name: 'Extração simples',                        specialty: 'Cirurgia Oral', duration: 30, price: 200, anesthesia: true },
  { name: 'Extração de siso',                        specialty: 'Cirurgia Oral', duration: 60, price: 500, anesthesia: true, xray: true },
  { name: 'Biópsia oral',                            specialty: 'Cirurgia Oral', duration: 45, price: 400, anesthesia: true },
  { name: 'Sutura de ferida',                        specialty: 'Cirurgia Oral', duration: 20, price: 100 },
  // Prótese
  { name: 'Coroa protética cerâmica',                specialty: 'Prótese', duration:  90, price: 1500, xray: true },
  { name: 'Prótese total',                           specialty: 'Prótese', duration: 180, price: 2500 },
  { name: 'Prótese parcial removível',               specialty: 'Prótese', duration: 150, price: 1800 },
  // Implantodontia
  { name: 'Implante dentário — por unidade',         specialty: 'Implantodontia', duration: 120, price: 3500, anesthesia: true, xray: true },
  { name: 'Coroa sobre implante',                    specialty: 'Implantodontia', duration:  90, price: 2000 },
  { name: 'Enxerto ósseo',                           specialty: 'Implantodontia', duration: 120, price: 1500, anesthesia: true, xray: true },
  // Ortodontia
  { name: 'Instalação de aparelho fixo',             specialty: 'Ortodontia', duration: 90, price:  2500 },
  { name: 'Manutenção mensal de aparelho',           specialty: 'Ortodontia', duration: 30, price:   250 },
  { name: 'Alinhador ortodôntico transparente — tratamento completo', specialty: 'Ortodontia', duration: 60, price: 12000 },
  // Estética
  { name: 'Clareamento dental de consultório',       specialty: 'Estética', duration:  90, price: 1200 },
  { name: 'Clareamento dental com moldeira',         specialty: 'Estética', duration:  30, price:  600 },
  { name: 'Faceta de porcelana — por unidade',       specialty: 'Estética', duration: 120, price: 2500 },
];

// ─── Template de Anamnese V3 ──────────────────────────────────────
export const DEFAULT_ANAMNESIS_TEMPLATE = {
  sections: [
    {
      id: 'general',
      title: 'Dados Gerais',
      questions: [
        { id: 'sex', type: 'select', label: 'Sexo biológico',
          options: ['Feminino','Masculino','Outro','Prefiro não informar'], required: false },
        { id: 'height',     type: 'number', label: 'Altura (cm)', required: false },
        { id: 'weight',     type: 'number', label: 'Peso (kg)', required: false },
        { id: 'blood_type', type: 'select', label: 'Tipo sanguíneo',
          options: ['A+','A-','B+','B-','AB+','AB-','O+','O-','Não sei'], required: false },
      ],
    },
    {
      id: 'medical_history',
      title: 'Histórico Médico',
      questions: [
        { id: 'chronic_diseases', type: 'multiselect', label: 'Possui alguma doença crônica?',
          options: ['Diabetes','Hipertensão','Doença cardíaca','Doença renal','Doença hepática','Problema de tireoide','Epilepsia','Asma','Anemia','Outra','Nenhuma'],
          required: false },
        { id: 'chronic_disease_other',  type: 'text',     label: 'Se outra, especifique', required: false },
        { id: 'had_surgery',            type: 'boolean',  label: 'Já fez alguma cirurgia?', required: false },
        { id: 'surgeries_detail',       type: 'textarea', label: 'Se sim, qual(is)?', required: false },
        { id: 'was_hospitalized',       type: 'boolean',  label: 'Esteve hospitalizado nos últimos 2 anos?', required: false },
        { id: 'hospitalizations_detail',type: 'textarea', label: 'Se sim, motivo?', required: false },
      ],
    },
    {
      id: 'allergies_meds',
      title: 'Alergias e Medicamentos',
      questions: [
        { id: 'allergies_known',     type: 'boolean',  label: 'Possui alergias conhecidas?', required: false },
        { id: 'allergies_list',      type: 'textarea', label: 'Se sim, quais? (medicamentos, látex, anestésicos, etc.)', required: false },
        { id: 'uses_medication',     type: 'boolean',  label: 'Usa algum medicamento atualmente?', required: false },
        { id: 'medications_current', type: 'textarea', label: 'Se sim, quais? (nome, dose, frequência)', required: false },
        { id: 'uses_anticoagulant',  type: 'boolean',  label: 'Usa anticoagulante (AAS, varfarina, rivaroxabana, etc.)?', required: false },
      ],
    },
    {
      id: 'lifestyle',
      title: 'Hábitos e Estilo de Vida',
      questions: [
        { id: 'smoker',     type: 'select',  label: 'Fuma?',
          options: ['Nunca','Ex-fumante','Fumante ocasional','Fumante diário'], required: false },
        { id: 'alcohol',    type: 'select',  label: 'Consome álcool?',
          options: ['Não','Socialmente','Frequentemente','Diariamente'], required: false },
        { id: 'uses_drugs', type: 'boolean', label: 'Faz uso de drogas recreativas?', required: false },
        { id: 'snoring',    type: 'boolean', label: 'Costuma roncar ou tem apneia?', required: false },
      ],
    },
    {
      id: 'dental_history',
      title: 'Histórico Odontológico',
      questions: [
        { id: 'last_visit',                 type: 'select',  label: 'Quando foi sua última consulta odontológica?',
          options: ['Menos de 6 meses','6 a 12 meses','1 a 2 anos','Mais de 2 anos','Nunca'], required: false },
        { id: 'brushing_frequency',         type: 'select',  label: 'Frequência de escovação',
          options: ['1x ao dia','2x ao dia','3x ao dia','Mais de 3x ao dia','Irregular'], required: false },
        { id: 'floss_use',                  type: 'boolean', label: 'Usa fio dental diariamente?', required: false },
        { id: 'uses_mouthwash',             type: 'boolean', label: 'Usa enxaguante bucal?', required: false },
        { id: 'had_orthodontic',            type: 'boolean', label: 'Já usou aparelho ortodôntico?', required: false },
        { id: 'had_extraction',             type: 'boolean', label: 'Já extraiu algum dente?', required: false },
        { id: 'anesthesia_reaction',        type: 'boolean', label: 'Já teve reação a anestesia odontológica?', required: false },
        { id: 'anesthesia_reaction_detail', type: 'textarea',label: 'Se sim, descreva', required: false },
      ],
    },
    {
      id: 'oral_health',
      title: 'Saúde Bucal Atual',
      questions: [
        { id: 'pain_current',     type: 'boolean',     label: 'Sente dor em algum dente agora?', required: false },
        { id: 'pain_description', type: 'textarea',    label: 'Se sim, descreva a dor e localização', required: false },
        { id: 'gum_bleeding',     type: 'boolean',     label: 'Suas gengivas sangram ao escovar?', required: false },
        { id: 'bad_breath',       type: 'boolean',     label: 'Tem mau hálito persistente?', required: false },
        { id: 'dry_mouth',        type: 'boolean',     label: 'Sente boca seca com frequência?', required: false },
        { id: 'mouth_sores',      type: 'boolean',     label: 'Aparecem feridas/aftas na boca com frequência?', required: false },
        { id: 'bruxism',          type: 'boolean',     label: 'Aperta ou range os dentes (bruxismo)?', required: false },
        { id: 'jaw_pain',         type: 'boolean',     label: 'Sente estalos ou dor na ATM (mandíbula)?', required: false },
        { id: 'sensitivity',      type: 'multiselect', label: 'Sensibilidade a:',
          options: ['Frio','Calor','Doces','Pressão','Nenhuma'], required: false },
      ],
    },
    {
      id: 'pregnancy',
      title: 'Gestação e Hormônios',
      show_if: { question_id: 'sex', equals: 'Feminino' },
      questions: [
        { id: 'pregnant',           type: 'boolean', label: 'Está gestante?', required: false },
        { id: 'pregnancy_weeks',    type: 'number',  label: 'Se sim, quantas semanas?', required: false },
        { id: 'breastfeeding',      type: 'boolean', label: 'Está amamentando?', required: false },
        { id: 'uses_contraceptive', type: 'boolean', label: 'Usa anticoncepcional?', required: false },
        { id: 'menopause',          type: 'boolean', label: 'Está na menopausa?', required: false },
      ],
    },
    {
      id: 'family_history',
      title: 'Histórico Familiar',
      questions: [
        { id: 'family_diseases', type: 'multiselect', label: 'Parentes próximos com:',
          options: ['Diabetes','Hipertensão','Câncer','Doença cardíaca','Problemas dentários graves','Nenhum'],
          required: false },
      ],
    },
    {
      id: 'notes',
      title: 'Observações Livres',
      questions: [
        { id: 'patient_notes', type: 'textarea', label: 'Algo mais que considera importante informar?', required: false },
      ],
    },
  ],
};

// ─── Funcao principal ────────────────────────────────────────────
export interface SeedResult {
  specialties: number;
  procedures:  number;
  anamnesis_template: boolean;
}

/**
 * Popula um tenant com os defaults (especialidades + tabela de
 * precos + ficha de anamnese). Idempotente — pode rodar varias
 * vezes sem duplicar dados (usa upsert por chaves unicas).
 *
 * Aceita transaction client OU PrismaClient diretamente.
 */
export async function seedTenantDefaults(
  prisma: PrismaClient | any,
  tenantId: string,
): Promise<SeedResult> {
  // 1) Especialidades — upsert por (tenant_id, name)
  const specialtyByName: Record<string, string> = {};
  for (const s of DEFAULT_SPECIALTIES) {
    const spec = await prisma.specialty.upsert({
      where:  { tenant_id_name: { tenant_id: tenantId, name: s.name } },
      update: { description: s.description },
      create: { tenant_id: tenantId, name: s.name, description: s.description },
    });
    specialtyByName[s.name] = spec.id;
  }

  // 2) Procedimentos — Onda 17.32.113: re-seed NAO sobrescreve preco
  //    nem duracao customizados pelo tenant. Cada clinica gerencia
  //    sua propria tabela de precos livremente. So o primeiro create
  //    seeda os defaults; chamadas subsequentes acrescentam apenas o
  //    que falta. O update so faz "preenchimento defensivo" de
  //    specialty_id quando estava nulo — nunca toca em base_price
  //    nem duration_minutes nem nos flags.
  for (const p of DEFAULT_PROCEDURES) {
    const existing = await prisma.procedure.findUnique({
      where:  { tenant_id_name: { tenant_id: tenantId, name: p.name } },
      select: { id: true, specialty_id: true },
    });
    if (existing) {
      // Procedimento ja existia — preserva tudo do tenant.
      // So vincula a specialty se ainda estava nula (auto-cura defensiva).
      if (!existing.specialty_id && specialtyByName[p.specialty]) {
        await prisma.procedure.update({
          where: { id: existing.id },
          data:  { specialty_id: specialtyByName[p.specialty] },
        });
      }
      continue;
    }
    // Procedimento novo — cria com defaults.
    await prisma.procedure.create({
      data: {
        tenant_id:           tenantId,
        specialty_id:        specialtyByName[p.specialty],
        name:                p.name,
        duration_minutes:    p.duration,
        base_price:          p.price,
        requires_x_ray:      p.xray ?? false,
        requires_anesthesia: p.anesthesia ?? false,
      },
    });
  }

  // 3) Template de anamnese V3 — upsert por (tenant_id, version=3).
  //    Desativa versoes antigas pra so haver UMA ativa por vez.
  await prisma.anamnesisTemplate.upsert({
    where:  { tenant_id_version: { tenant_id: tenantId, version: 3 } },
    update: {
      schema: DEFAULT_ANAMNESIS_TEMPLATE as any,
      active: true,
      notes:  'Template V3 odontológico — 9 seções, todos opcionais, gestação condicional ao sexo.',
    },
    create: {
      tenant_id: tenantId,
      version:   3,
      schema:    DEFAULT_ANAMNESIS_TEMPLATE as any,
      active:    true,
      notes:     'Template V3 odontológico — 9 seções, todos opcionais, gestação condicional ao sexo.',
    },
  });
  await prisma.anamnesisTemplate.updateMany({
    where: { tenant_id: tenantId, version: { lt: 3 } },
    data:  { active: false },
  });

  return {
    specialties:        DEFAULT_SPECIALTIES.length,
    procedures:         DEFAULT_PROCEDURES.length,
    anamnesis_template: true,
  };
}

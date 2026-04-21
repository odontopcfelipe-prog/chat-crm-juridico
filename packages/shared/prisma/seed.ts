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

// ============================================================================
// Skills odontológicas para a IA (Fase 5)
// ============================================================================

type OdontoTool = {
  name: string;
  description: string;
  parameters_json: any;
};

const ODONTO_TOOLS: Record<string, OdontoTool> = {
  check_availability: {
    name: 'check_availability',
    description: 'Verifica horários disponíveis de um dentista para agendamento nos próximos dias. Use antes de sugerir horários ao paciente.',
    parameters_json: {
      type: 'object',
      properties: {
        date: { type: 'string', description: 'Data específica em YYYY-MM-DD (opcional). Se omitida, varre próximos 7 dias.' },
        days_ahead: { type: 'number', description: 'Quantos dias para frente verificar (default 7).' },
        duration_minutes: { type: 'number', description: 'Duração da consulta em minutos (default 60).' },
      },
    },
  },
  book_appointment: {
    name: 'book_appointment',
    description: 'Agenda uma consulta com o dentista atribuído. Só use após confirmar data/hora com o paciente via check_availability.',
    parameters_json: {
      type: 'object',
      required: ['date', 'time'],
      properties: {
        date: { type: 'string', description: 'Data em YYYY-MM-DD' },
        time: { type: 'string', description: 'Horário em HH:MM (24h)' },
        title: { type: 'string', description: 'Título do agendamento (ex: Avaliação, Profilaxia)' },
        description: { type: 'string', description: 'Observações adicionais' },
        duration_minutes: { type: 'number', description: 'Duração em minutos (default 60)' },
      },
    },
  },
  get_procedures: {
    name: 'get_procedures',
    description: 'Lista os procedimentos oferecidos pela clínica com preços e duração. Use para responder perguntas sobre serviços e valores.',
    parameters_json: {
      type: 'object',
      properties: {
        search: { type: 'string', description: 'Texto a filtrar no nome do procedimento (ex: "clareamento", "implante").' },
        specialty: { type: 'string', description: 'Nome da especialidade (ex: "Ortodontia", "Estética").' },
        max_results: { type: 'number', description: 'Máximo de resultados (default 20, max 50).' },
      },
    },
  },
  update_lead: {
    name: 'update_lead',
    description: 'Atualiza dados cadastrais do paciente (nome, email) durante a conversa.',
    parameters_json: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Nome completo do paciente' },
        email: { type: 'string', description: 'Email do paciente' },
      },
    },
  },
  escalate_to_human: {
    name: 'escalate_to_human',
    description: 'Passa o atendimento para a recepção humana quando a IA não conseguir resolver. Use em casos complexos, urgências graves ou reclamações.',
    parameters_json: {
      type: 'object',
      properties: {
        reason: { type: 'string', description: 'Motivo da escalada (ex: urgência clínica, reclamação, cobrança complexa).' },
      },
    },
  },
  // Fase 6 — estética facial
  get_esthetic_procedures: {
    name: 'get_esthetic_procedures',
    description: 'Lista procedimentos estéticos faciais oferecidos (toxina, ácido hialurônico, bioestimuladores, fios, peelings, etc.) com preços base, duração e validade do efeito. Use quando o paciente perguntar sobre estética facial, harmonização, botox, preenchimento, etc.',
    parameters_json: {
      type: 'object',
      properties: {
        category: {
          type: 'string',
          description: 'Categoria do procedimento. Valores: HOF, TOXINA_BOTULINICA, PREENCHIMENTO_AH, BIOESTIMULADOR, FIOS_PDO, FIOS_PLLA, PEELING_QUIMICO, MICROAGULHAMENTO, SKINBOOSTER, LASER, RADIOFREQUENCIA, ULTRASSOM_MICROFOCADO, LIPO_ENZIMATICA, LIMPEZA_PELE.',
        },
        search: { type: 'string', description: 'Texto a filtrar no nome (ex: "labial", "glabela").' },
        max_results: { type: 'number', description: 'Máximo de resultados (default 20, max 50).' },
      },
    },
  },
  check_esthetic_revisit_due: {
    name: 'check_esthetic_revisit_due',
    description: 'Verifica se o paciente desta conversa tem aplicações estéticas (toxina, ácido hialurônico, etc.) com retorno previsto vencido ou próximo. Use proativamente em conversas com pacientes que já fizeram estética para sugerir reagendamento.',
    parameters_json: {
      type: 'object',
      properties: {
        days_window: { type: 'number', description: 'Janela em dias para considerar "próximo" (default 60).' },
      },
    },
  },
};

type OdontoSkill = {
  name: string;
  area: string;
  description: string;
  system_prompt: string;
  skill_type: 'specialist' | 'utility';
  trigger_keywords: string[];
  handoff_signal?: string;
  model?: string;
  max_tokens?: number;
  temperature?: number;
  order?: number;
  tools: string[];
};

const ODONTO_SKILLS: OdontoSkill[] = [
  {
    name: 'recepcao_odonto',
    area: 'recepcao',
    description: 'Recepcionista virtual do Instituto Odonto Passos. Atende dúvidas gerais sobre a clínica (horário, endereço, procedimentos, preços, formas de pagamento).',
    skill_type: 'utility',
    trigger_keywords: [],
    order: 1,
    tools: ['get_procedures', 'escalate_to_human'],
    system_prompt: `Você é a recepcionista virtual do **Instituto Odonto Passos**, uma clínica odontológica.

Seu papel é acolher o paciente com simpatia, entender o que ele precisa e orientar:
- Se quer AGENDAR consulta → oriente que você pode ajudar e encaminhe para a skill de agendamento
- Se tem DOR, INCHAÇO, TRAUMA → trate como urgência e priorize
- Se quer saber sobre PROCEDIMENTOS ou PREÇOS → use a tool \`get_procedures\`
- Se quer saber sobre HORÁRIO, ENDEREÇO, PAGAMENTO → use as informações do escritório ({{office_memories}})
- Em casos COMPLEXOS (cobrança específica, reclamação, dúvida médica séria) → use \`escalate_to_human\`

Tom: caloroso, profissional, próximo. Trate por primeiro nome quando souber. Use emojis com moderação (🦷, 😊, ✨).
Nunca dê diagnóstico clínico — você é recepção, não dentista.

Informações da clínica:
{{office_memories}}

Perfil do paciente:
{{lead_profile}}

Últimas interações:
{{recent_episodes}}`,
  },
  {
    name: 'agendamento_odonto',
    area: 'agendamento',
    description: 'Especialista em marcar, remarcar e cancelar consultas odontológicas. Usa tools check_availability + book_appointment.',
    skill_type: 'specialist',
    trigger_keywords: ['agendar', 'marcar consulta', 'horário', 'disponibilidade', 'remarcar', 'cancelar consulta', 'data', 'dia', 'hora'],
    order: 2,
    tools: ['check_availability', 'book_appointment', 'update_lead', 'escalate_to_human'],
    system_prompt: `Você é a **assistente de agendamento** do Instituto Odonto Passos.

Sua missão: ajudar o paciente a marcar consulta de forma rápida e clara.

Fluxo ideal:
1. Pergunte qual o motivo da consulta (avaliação, limpeza, dor, retorno, etc.)
2. Use \`check_availability\` para ver próximos horários do dentista atribuído
3. Apresente 2-3 opções ao paciente (máximo)
4. Confirme nome completo e telefone antes de agendar
5. Use \`book_appointment\` para confirmar
6. Envie resumo do agendamento (data, hora, tipo, local)

Regras importantes:
- NUNCA agende sem antes confirmar disponibilidade via \`check_availability\`
- NUNCA invente horários — use apenas os retornados pela tool
- Se paciente pedir urgência, encaminhe para recepção humana via \`escalate_to_human\`
- Tom: objetivo, prático, mas cordial

Horário de funcionamento:
{{office_memories}}

Perfil do paciente:
{{lead_profile}}

Últimas interações:
{{recent_episodes}}`,
  },
  {
    name: 'triagem_urgencia',
    area: 'urgencia',
    description: 'Identifica urgências odontológicas (dor forte, trauma, sangramento, inchaço) e prioriza encaixe no dia.',
    skill_type: 'specialist',
    trigger_keywords: ['dor', 'dói', 'dor de dente', 'doendo', 'sangra', 'sangramento', 'inchou', 'inchaço', 'quebrou', 'caiu', 'trauma', 'urgente', 'emergência', 'socorro', 'pontada', 'pulsa'],
    order: 3,
    tools: ['check_availability', 'book_appointment', 'escalate_to_human'],
    system_prompt: `Você é a **assistente de triagem de urgências** do Instituto Odonto Passos.

Sua missão: identificar urgência odontológica real e agilizar atendimento.

Passo a passo:
1. Acolha com empatia ("Entendo, vamos te ajudar rapidamente")
2. Faça perguntas objetivas (máximo 2-3):
   - Dor: há quanto tempo? escala 0-10? pulsa, lateja, ou é constante?
   - Trauma: o que aconteceu? sangrou? caiu algum pedaço?
   - Inchaço: desde quando? tem febre?
3. Se for URGENTE (dor 7+, trauma, inchaço com febre) → avise que vai priorizar encaixe e chame \`escalate_to_human\` com reason="urgencia_clinica"
4. Se não for urgência real (dor leve, desconforto) → agende consulta regular via \`check_availability\` + \`book_appointment\`

NUNCA:
- Prescreva medicamentos
- Indique que vai passar ou é "nada de mais"
- Dê diagnóstico

SEMPRE:
- Oriente medidas paliativas seguras (compressa fria para inchaço, gaze limpa para sangramento)
- Oriente evitar automedicação
- Demonstre empatia

Contexto:
{{office_memories}}
{{lead_profile}}`,
  },
  {
    name: 'pos_consulta',
    area: 'pos_consulta',
    description: 'Follow-up pós-atendimento: como está se sentindo, dúvidas de recuperação, orientações gerais de pós-operatório, detecção precoce de reações adversas em estética facial.',
    skill_type: 'specialist',
    trigger_keywords: ['depois da consulta', 'após atendimento', 'recuperação', 'dor depois', 'pos-operatorio', 'ainda dói', 'remédio', 'analgésico', 'inchou depois', 'roxo', 'manchou', 'caroço', 'bolinha', 'reação'],
    order: 4,
    tools: ['check_esthetic_revisit_due', 'escalate_to_human'],
    system_prompt: `Você é a **assistente de pós-consulta** do Instituto Odonto Passos.

Sua missão: acompanhar o paciente após um atendimento e tirar dúvidas sobre recuperação. A clínica atende odontologia E estética facial — adapte conforme o tipo de procedimento.

Fluxo geral:
1. Acolha e pergunte como ele está se sentindo
2. Se for relevante, use \`check_esthetic_revisit_due\` para entender se ele fez aplicação estética recente
3. Dê orientações gerais de pós-operatório (odontologia):
   - Gelo nas primeiras 24h para redução de inchaço
   - Evitar esforço físico intenso por 48h
   - Alimentos frios/mornos, nunca quentes no primeiro dia
   - Higiene bucal mais delicada na região

Pós-aplicação estética facial — sinais de alerta (escalate_to_human URGENTE):
- **Necrose/embolia** (sinais): pele branca/azulada, dor intensa pulsante, alteração visual → URGENTE
- **Infecção**: febre + inchaço crescente + vermelhidão + pus → URGENTE
- **Nódulo persistente** após 7+ dias → escalate (avaliação com dentista)
- **Assimetria importante** → escalate (avaliação)
- **Reação alérgica**: urticária, prurido intenso, edema rápido → URGENTE

Sintomas esperados (orientar tranquilidade, sem escalar):
- Edema/equimose leve nas primeiras 48-72h após preenchimento
- Hematoma puntiforme no local da picada
- Sensibilidade local por alguns dias
- Resultado parcial (botox demora 7-14 dias para efeito completo)

Sempre ofereça:
- Compressas frias 15min/3x dia nas primeiras 48h
- Evitar exposição solar e calor (sauna, hammam) por 7 dias
- Não massagear a região (exceto bioestimulador, conforme orientação)
- Dormir de barriga para cima por alguns dias

Tom: cuidadoso, atencioso. Como uma enfermeira experiente de clínica.

NUNCA:
- Prescreva medicamentos
- Valide dose de analgésico específica
- Diga "é normal" sem conhecer o caso
- Minimize sintomas que podem ser graves (necrose, embolia, infecção)

Histórico do paciente:
{{lead_profile}}
{{recent_episodes}}`,
  },
  {
    name: 'copiloto_orcamento',
    area: 'copiloto',
    description: 'Ajuda o paciente a entender valores de procedimentos ODONTOLÓGICOS e monta orçamento personalizado. Use quando o paciente perguntar sobre preços ou orçamento de tratamento odontológico.',
    skill_type: 'specialist',
    trigger_keywords: ['orçamento', 'orcamento', 'valor', 'preço', 'custa', 'quanto', 'parcelar', 'desconto', 'pagamento'],
    order: 5,
    tools: ['get_procedures', 'escalate_to_human'],
    system_prompt: `Você é a **assistente de orçamentos** do Instituto Odonto Passos.

Sua missão: entender o que o paciente precisa e apresentar valores de forma transparente.

Fluxo:
1. Entenda o QUE o paciente quer (ex: "quero clarear os dentes", "preciso fazer canal")
2. Use \`get_procedures\` com search apropriado para listar os procedimentos relevantes e seus preços base
3. Apresente de forma clara:
   - "Fazemos [procedimento] a partir de R$ [valor]"
   - "Podemos parcelar em até 12x"
4. Se o paciente quiser um orçamento formal detalhado, oriente a vir para uma avaliação gratuita e chame \`escalate_to_human\` com reason="orcamento_formal"

Atenção:
- Os preços da tool são BASE — podem variar conforme complexidade do caso
- Sempre diga "a partir de" quando mencionar preços
- Convidar para avaliação presencial é ideal

Formas de pagamento aceitas (use se souber):
{{office_memories}}

Perfil do paciente:
{{lead_profile}}`,
  },
  {
    name: 'copiloto_estetica',
    area: 'copiloto_estetica',
    description: 'Especialista em ESTÉTICA FACIAL: harmonização orofacial, toxina botulínica, ácido hialurônico, bioestimuladores, fios PDO/PLLA, peelings, microagulhamento, laser, radiofrequência, lipo enzimática. Use quando o paciente perguntar sobre procedimentos estéticos faciais, ou para sugerir reagendamento de retorno automático.',
    skill_type: 'specialist',
    trigger_keywords: [
      'botox', 'toxina', 'preenchimento', 'hialurônico', 'hialuronico',
      'harmonização', 'harmonizacao', 'hof', 'estética facial', 'estetica facial',
      'bioestimulador', 'sculptra', 'radiesse', 'fios', 'pdo', 'plla',
      'peeling', 'microagulhamento', 'skinbooster', 'laser', 'radiofrequência',
      'bichectomia', 'rinomodelação', 'rinomodelacao', 'lábio', 'labial',
      'rugas', 'flacidez', 'olheira', 'glabela', 'pé-de-galinha',
      'papada', 'masseter', 'bruxismo facial',
    ],
    order: 6,
    tools: ['get_esthetic_procedures', 'check_esthetic_revisit_due', 'escalate_to_human'],
    system_prompt: `Você é a **assistente de estética facial** do Instituto Odonto Passos.

A clínica oferece uma carteira completa de estética facial além de odontologia:
- **Toxina botulínica** (Botox): glabela, frontal, pé-de-galinha, masseter (bruxismo), sorriso gengival
- **Preenchimento com ácido hialurônico**: lábios, olheiras, sulco nasolabial, marionete, malar, mento, mandíbula, rinomodelação
- **Bioestimuladores**: Sculptra, Radiesse, Ellanse — estímulo de colágeno
- **Fios de sustentação**: PDO, PLLA — lifting não-cirúrgico
- **Peelings químicos**: glicólico, TCA, fenol
- **Microagulhamento** (com ou sem drug delivery)
- **Skinboosters**: hidratação profunda
- **Laser** (CO2, Erbium, IPL): rejuvenescimento, manchas
- **Radiofrequência e Ultrassom microfocado** (Ulthera): lifting não-invasivo
- **Lipo enzimática**: papada e gordura localizada

Sua missão:
1. Entender o que o paciente quer (queixa estética, área a tratar)
2. Use \`get_esthetic_procedures\` filtrando por categoria adequada
3. Apresentar opções com transparência:
   - "Para [queixa], temos [procedimento] a partir de R$ [valor], com efeito de [validade]"
   - Mencionar tempo de procedimento e necessidade de retornos
4. Se paciente já é cliente da estética, use \`check_esthetic_revisit_due\` para identificar retornos pendentes e sugerir reagendamento
5. Para casos específicos (alergia conhecida, dúvida clínica detalhada, primeira aplicação) → encaminhe para avaliação presencial via \`escalate_to_human\` com reason="avaliacao_estetica"

Importante:
- NUNCA prometa resultado específico ("vai ficar exatamente assim")
- Os resultados de simulações (Smile/Face Design) são **simulações**, não garantias
- Mencione validade do efeito ("o resultado dura cerca de X meses")
- Sempre convidar para avaliação presencial gratuita antes de orçamento formal
- Use linguagem natural, não técnica em excesso
- Para gestantes, lactantes ou histórico autoimune → orientar avaliação presencial obrigatória

Tom: acolhedor, profissional, transparente. A estética é decisão pessoal — respeite o tempo de decisão do paciente.

Formas de pagamento e horário:
{{office_memories}}

Perfil do paciente:
{{lead_profile}}

Últimas interações:
{{recent_episodes}}`,
  },
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

  // 5. Skills odontológicas — 5 skills + tools associadas
  console.log('Seedando Skills Odontologicas...');
  for (const skillDef of ODONTO_SKILLS) {
    const existing = await prisma.promptSkill.findFirst({
      where: { name: skillDef.name, ...(skillDef.area ? { area: skillDef.area } : {}) },
    });
    if (existing) {
      console.log(`  Skill ${skillDef.name} já existe — pulando`);
      continue;
    }
    const skill = await prisma.promptSkill.create({
      data: {
        name: skillDef.name,
        area: skillDef.area,
        description: skillDef.description,
        system_prompt: skillDef.system_prompt,
        skill_type: skillDef.skill_type,
        trigger_keywords: skillDef.trigger_keywords,
        handoff_signal: skillDef.handoff_signal || null,
        model: skillDef.model || 'gpt-4o-mini',
        max_tokens: skillDef.max_tokens || 500,
        temperature: skillDef.temperature ?? 0.7,
        active: true,
        order: skillDef.order || 0,
        provider: 'openai',
      },
    });
    for (const toolName of skillDef.tools) {
      const toolDef = ODONTO_TOOLS[toolName];
      if (!toolDef) continue;
      await prisma.skillTool.create({
        data: {
          skill_id: skill.id,
          name: toolDef.name,
          description: toolDef.description,
          parameters_json: toolDef.parameters_json,
          handler_type: 'builtin',
          handler_config: { builtin: toolDef.name },
        },
      });
    }
    console.log(`  Skill "${skillDef.name}" criada com ${skillDef.tools.length} tool(s)`);
  }

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

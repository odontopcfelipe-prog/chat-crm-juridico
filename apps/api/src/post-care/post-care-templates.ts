/**
 * Templates de mensagem do Pos-Atendimento.
 *
 * 3 estilos pre-definidos + opcao 'custom' (texto livre editavel).
 * Admin escolhe qual estilo usar via Configurar (Settings).
 *
 * Placeholders suportados:
 *   {patient_name}   — primeiro nome do paciente
 *   {dentist_name}   — nome do dentista (com prefixo Dr/Dra)
 *   {procedure}      — resumo do procedimento (vem do CalendarEvent.title)
 */

export type InitialChoice = 'descontraido' | 'formal' | 'breve' | 'custom';

export interface PostCareTemplates {
  initial: Record<Exclude<InitialChoice, 'custom'>, string>;
  thanks: string;
  apology: string;
}

export const DEFAULT_TEMPLATES: PostCareTemplates = {
  initial: {
    descontraido:
      'Olá {patient_name}! Passando aqui pra perguntar o que achou do atendimento com {dentist_name} referente ao procedimento de {procedure}. O que você achou? 😊',
    formal:
      'Olá, {patient_name}. Esperamos que esteja bem. Gostaríamos de saber sua opinião sobre o atendimento realizado por {dentist_name} referente ao procedimento de {procedure}. Como foi sua experiência?',
    breve:
      'Oi {patient_name}! Como foi seu atendimento com {dentist_name} hoje? Manda um feedback rapidinho 💛',
  },
  thanks:
    'Que bom que gostou, {patient_name}! 💛 Seu feedback nos ajuda muito. Se quiser nos ajudar ainda mais, deixa uma avaliação no Google!',
  apology:
    'Sentimos muito que sua experiência não tenha sido a esperada, {patient_name}. Nossa equipe vai entrar em contato com você em breve pra entender e resolver. Obrigada pelo retorno!',
};

export const INITIAL_CHOICES: { value: InitialChoice; label: string; preview: string }[] = [
  { value: 'descontraido', label: 'Descontraído', preview: DEFAULT_TEMPLATES.initial.descontraido },
  { value: 'formal',       label: 'Formal',       preview: DEFAULT_TEMPLATES.initial.formal },
  { value: 'breve',        label: 'Breve',        preview: DEFAULT_TEMPLATES.initial.breve },
  { value: 'custom',       label: 'Personalizado', preview: '' },
];

export interface PostCareConfig {
  enabled: boolean;
  delay_hours: number;        // 1-24
  initial_choice: InitialChoice;
  initial_custom: string;     // usado se initial_choice === 'custom'
  thanks_text: string;
  apology_text: string;
  send_thanks_on_positive: boolean;
  send_apology_on_negative: boolean;
}

export const DEFAULT_CONFIG: PostCareConfig = {
  enabled: true,
  delay_hours: 2,
  initial_choice: 'descontraido',
  initial_custom: DEFAULT_TEMPLATES.initial.descontraido,
  thanks_text: DEFAULT_TEMPLATES.thanks,
  apology_text: DEFAULT_TEMPLATES.apology,
  send_thanks_on_positive: true,
  send_apology_on_negative: true,
};

/** Resolve qual template inicial usar com base na config + interpola placeholders. */
export function renderInitialMessage(
  cfg: PostCareConfig,
  ctx: { patient_name: string; dentist_name: string; procedure: string },
): string {
  const tpl =
    cfg.initial_choice === 'custom'
      ? cfg.initial_custom || DEFAULT_TEMPLATES.initial.descontraido
      : DEFAULT_TEMPLATES.initial[cfg.initial_choice];
  return interpolate(tpl, ctx);
}

export function renderThanks(
  cfg: PostCareConfig,
  ctx: { patient_name: string },
): string {
  return interpolate(cfg.thanks_text || DEFAULT_TEMPLATES.thanks, {
    ...ctx,
    dentist_name: '',
    procedure: '',
  });
}

export function renderApology(
  cfg: PostCareConfig,
  ctx: { patient_name: string },
): string {
  return interpolate(cfg.apology_text || DEFAULT_TEMPLATES.apology, {
    ...ctx,
    dentist_name: '',
    procedure: '',
  });
}

function interpolate(tpl: string, ctx: { patient_name: string; dentist_name: string; procedure: string }): string {
  return tpl
    .replace(/\{patient_name\}/g, ctx.patient_name || 'paciente')
    .replace(/\{dentist_name\}/g, ctx.dentist_name || 'o(a) profissional')
    .replace(/\{procedure\}/g, ctx.procedure || 'sua consulta');
}

// ─── Sentiment analysis (PT-BR) ──────────────────────────────────────────────

const NEG_KEYWORDS = [
  'ruim', 'péssimo', 'pessimo', 'péssima', 'pessima', 'horrível', 'horrivel',
  'terrível', 'terrivel', 'detestei', 'odiei', 'decepção', 'decepcao',
  'decepcionado', 'decepcionada', 'demorou muito', 'muito demorado', 'demorada',
  'dor', 'dolorido', 'machucou', 'reclamar', 'reclamação', 'reclamacao',
  'insatisfeit', 'irritad', 'frustrad', 'chato', 'chata', 'frio', 'fria',
  'mal atendid', 'não gostei', 'nao gostei', 'não recomend', 'nao recomend',
  'cancelar', 'cancelamento', 'devolver', 'reembolso', 'processo', 'absurdo',
  'erro', 'errado', 'errada', 'esperar muito', 'esperando muito',
];

const POS_KEYWORDS = [
  'ótim', 'otim', 'excelent', 'perfeit', 'amei', 'adorei', 'gostei muito',
  'gostei', 'maravilho', 'incrível', 'incrivel', 'fantástic', 'fantastic',
  'show', 'top', '10/10', 'nota mil', 'muito bom', 'muito boa', 'satisfeit',
  'feliz', 'indicaria', 'recomendaria', 'indicar', 'recomendar', 'obrigad',
  'agradeço', 'agradeco', 'carinhos', 'atencios', 'cuidados', 'maravilhoso',
  'sensacional', 'espetacular', 'parabens', 'parabéns', 'gentil',
  'profissional', 'competent', 'bom', 'boa', 'gostoso', 'gostosa',
];

export interface SentimentResult {
  score: number | null;          // 1-10 se mencionado pelo paciente
  sentiment: 'POSITIVE' | 'NEGATIVE' | 'NEUTRAL';
}

/** Analisa texto da resposta. Score numerico tem prioridade sobre keywords. */
export function analyzeSentiment(text: string): SentimentResult {
  const lower = (text || '').toLowerCase().trim();
  if (!lower) return { score: null, sentiment: 'NEUTRAL' };

  // Captura nota numerica (1-10) se mencionada como palavra isolada
  let score: number | null = null;
  const scoreMatch = lower.match(/(?:^|[\s.,!])(\d{1,2})(?:[\s.,!]|\/(?:5|10)|$)/);
  if (scoreMatch) {
    const n = parseInt(scoreMatch[1], 10);
    if (n >= 0 && n <= 10) score = n;
  }

  let sentiment: 'POSITIVE' | 'NEGATIVE' | 'NEUTRAL' = 'NEUTRAL';

  if (score !== null) {
    if (score <= 2) sentiment = 'NEGATIVE';
    else if (score <= 6) sentiment = 'NEUTRAL';
    else sentiment = 'POSITIVE';
  } else {
    const hasNeg = NEG_KEYWORDS.some((k) => lower.includes(k));
    const hasPos = POS_KEYWORDS.some((k) => lower.includes(k));
    if (hasNeg && !hasPos) sentiment = 'NEGATIVE';
    else if (hasPos && !hasNeg) sentiment = 'POSITIVE';
    else if (hasPos && hasNeg) sentiment = 'NEUTRAL'; // misto
  }

  return { score, sentiment };
}

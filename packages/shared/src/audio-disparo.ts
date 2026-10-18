// Disparo em ÁUDIO (teste) — o texto do lembrete vira mensagem de voz (texto→fala).
//
// Card "Lembrete em áudio (teste)" na Central › Agendamento: a clínica escolhe o MOTOR
// (voz do ChatGPT, leitor da OpenAI ou Google Gemini — as chaves que a IA já usa), a VOZ, o SOTAQUE e a
// VELOCIDADE, ouve ali mesmo e manda o áudio de teste pro próprio número. Não envia
// sozinho pra paciente. Regras puras (API e web); sem banco.

// chatgpt = gpt-audio-1.5 (a família da voz do ChatGPT: fala "interpretando", bem natural);
// openai = gpt-4o-mini-tts (leitor de texto, velocidade exata); gemini = a voz atual da IA.
export const AUDIO_MOTORES = ['chatgpt', 'openai', 'gemini'] as const;
export type AudioMotor = (typeof AUDIO_MOTORES)[number];

export const AUDIO_MOTOR_LABEL: Record<AudioMotor, string> = {
  chatgpt: 'OpenAI — voz do ChatGPT (mais natural)',
  openai: 'OpenAI — leitor de texto (gpt-4o-mini-tts)',
  gemini: 'Google Gemini (a voz da IA no WhatsApp)',
};

/** Vozes de cada motor, com o estilo de cada uma (ouça pra escolher). */
export const AUDIO_VOZES: Record<AudioMotor, { id: string; label: string }[]> = {
  // marin e cedar = as vozes que a OpenAI recomenda como de melhor qualidade.
  chatgpt: [
    { id: 'marin', label: 'Marin — a mais natural (recomendada)' },
    { id: 'cedar', label: 'Cedar — a mais natural (recomendada)' },
    { id: 'coral', label: 'Coral — calorosa' },
    { id: 'sage', label: 'Sage — calma' },
    { id: 'shimmer', label: 'Shimmer — suave' },
    { id: 'alloy', label: 'Alloy — neutra' },
    { id: 'ballad', label: 'Ballad — expressiva' },
    { id: 'ash', label: 'Ash — clara' },
    { id: 'echo', label: 'Echo — firme' },
    { id: 'verse', label: 'Verse — versátil' },
  ],
  openai: [
    { id: 'marin', label: 'Marin — a mais natural (recomendada)' },
    { id: 'cedar', label: 'Cedar — a mais natural (recomendada)' },
    { id: 'coral', label: 'Coral — calorosa' },
    { id: 'nova', label: 'Nova — animada' },
    { id: 'shimmer', label: 'Shimmer — suave' },
    { id: 'sage', label: 'Sage — calma' },
    { id: 'alloy', label: 'Alloy — neutra' },
    { id: 'ballad', label: 'Ballad — expressiva' },
    { id: 'ash', label: 'Ash — clara' },
    { id: 'echo', label: 'Echo — firme' },
    { id: 'onyx', label: 'Onyx — grave' },
    { id: 'fable', label: 'Fable — narradora' },
    { id: 'verse', label: 'Verse — versátil' },
  ],
  gemini: [
    { id: 'Kore', label: 'Kore — firme (a voz atual da IA)' },
    { id: 'Zephyr', label: 'Zephyr — alegre' },
    { id: 'Aoede', label: 'Aoede — leve' },
    { id: 'Leda', label: 'Leda — jovem' },
    { id: 'Sulafat', label: 'Sulafat — calorosa' },
    { id: 'Achernar', label: 'Achernar — suave' },
    { id: 'Vindemiatrix', label: 'Vindemiatrix — gentil' },
    { id: 'Despina', label: 'Despina — macia' },
    { id: 'Puck', label: 'Puck — animada' },
    { id: 'Charon', label: 'Charon — informativa' },
    { id: 'Orus', label: 'Orus — firme' },
    { id: 'Achird', label: 'Achird — amigável' },
    { id: 'Iapetus', label: 'Iapetus — clara' },
    { id: 'Algieba', label: 'Algieba — macia' },
  ],
};

export const AUDIO_SOTAQUES = [
  { id: 'neutro', label: 'Brasil — neutro', instrucao: 'Português do Brasil com sotaque neutro, de telejornal.' },
  { id: 'nordestino', label: 'Nordestino (Alagoas)', instrucao: 'Português do Brasil com sotaque nordestino de Alagoas (Maceió), caloroso e próximo.' },
  { id: 'carioca', label: 'Carioca', instrucao: 'Português do Brasil com sotaque carioca, do Rio de Janeiro.' },
  { id: 'paulista', label: 'Paulista', instrucao: 'Português do Brasil com sotaque paulistano, de São Paulo.' },
  { id: 'mineiro', label: 'Mineiro', instrucao: 'Português do Brasil com sotaque mineiro, de Minas Gerais.' },
  { id: 'gaucho', label: 'Gaúcho', instrucao: 'Português do Brasil com sotaque gaúcho, do Rio Grande do Sul.' },
  { id: 'portugal', label: 'Português de Portugal', instrucao: 'Português europeu, com sotaque de Lisboa.' },
] as const;
export type AudioSotaque = (typeof AUDIO_SOTAQUES)[number]['id'];

export const AUDIO_VELOCIDADE_MIN = 0.7;
export const AUDIO_VELOCIDADE_MAX = 1.5;
export const AUDIO_TEXTO_MAX = 600;

export interface AudioTesteConfig {
  texto: string;
  motor: AudioMotor;
  voz: string;
  sotaque: AudioSotaque;
  velocidade: number;
}

export const DEFAULT_AUDIO_TESTE_TEXTO =
  'Oi, {nome}! Aqui é da equipe {clinica}. Passando pra lembrar da sua consulta amanhã, dia {data}, às {hora}, com {dentista}. ' +
  'Se precisar remarcar, é só responder essa mensagem. Até amanhã!';

export const AUDIO_TESTE_VARIAVEIS: { key: string; desc: string }[] = [
  { key: 'nome', desc: 'Primeiro nome do paciente' },
  { key: 'clinica', desc: 'Nome da clínica' },
  { key: 'data', desc: 'Data da consulta (ex.: 22/06)' },
  { key: 'hora', desc: 'Horário (ex.: 15:00)' },
  { key: 'dentista', desc: 'Profissional' },
];

export const DEFAULT_AUDIO_TESTE: AudioTesteConfig = {
  texto: DEFAULT_AUDIO_TESTE_TEXTO,
  motor: 'chatgpt',
  voz: 'marin',
  sotaque: 'neutro',
  velocidade: 1,
};

/** Normaliza o que vem da tela/banco: valores fora da lista voltam ao padrão. */
export function normalizarAudioConfig(c: any): AudioTesteConfig {
  const motor: AudioMotor = (AUDIO_MOTORES as readonly string[]).includes(c?.motor) ? c.motor : DEFAULT_AUDIO_TESTE.motor;
  const vozes = AUDIO_VOZES[motor];
  const voz = vozes.some((v) => v.id === c?.voz) ? c.voz : vozes[0].id;
  const sotaque = (AUDIO_SOTAQUES.find((s) => s.id === c?.sotaque)?.id ?? DEFAULT_AUDIO_TESTE.sotaque) as AudioSotaque;
  const v = Number(c?.velocidade);
  const velocidade = Number.isFinite(v)
    ? Math.round(Math.min(AUDIO_VELOCIDADE_MAX, Math.max(AUDIO_VELOCIDADE_MIN, v)) * 100) / 100
    : 1;
  const texto = typeof c?.texto === 'string' && c.texto.trim() ? c.texto.slice(0, AUDIO_TEXTO_MAX) : DEFAULT_AUDIO_TESTE_TEXTO;
  return { texto, motor, voz, sotaque, velocidade };
}

/** Ritmo em palavras (voz do ChatGPT e Gemini só obedecem por instrução; o leitor recebe o número também). */
export function instrucaoRitmo(velocidade: number): string {
  if (velocidade < 0.85) return 'Fale devagar, com calma e pequenas pausas.';
  if (velocidade < 0.95) return 'Fale num ritmo um pouco mais calmo que o normal.';
  if (velocidade <= 1.05) return 'Ritmo normal de conversa.';
  if (velocidade <= 1.2) return 'Fale um pouco mais rápido que o normal, sem atropelar as palavras.';
  return 'Fale rápido, mas com dicção bem clara.';
}

/** Como a voz deve soar: atendente de clínica + sotaque + ritmo. */
export function instrucaoVoz(cfg: Pick<AudioTesteConfig, 'sotaque' | 'velocidade'>): string {
  const sot = AUDIO_SOTAQUES.find((s) => s.id === cfg.sotaque) ?? AUDIO_SOTAQUES[0];
  return [
    'Voz de atendente de clínica odontológica: simpática, acolhedora e profissional.',
    'Natural, como um áudio de WhatsApp gravado por uma pessoa — nunca robótica.',
    sot.instrucao,
    instrucaoRitmo(cfg.velocidade),
  ].join(' ');
}

/** Texto pronto pra FALAR: troca as variáveis e tira emoji, asterisco e quebras. */
export function textoParaFala(tpl: string, vars: Record<string, string>): string {
  return (tpl || '')
    .replace(/\{(\w+)\}/g, (_m, k) => vars[k] ?? '')
    .replace(/[*_~`]/g, '')
    .replace(/\p{Extended_Pictographic}|️|‍/gu, '')
    .replace(/\s*\n+\s*/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim()
    .slice(0, AUDIO_TEXTO_MAX);
}

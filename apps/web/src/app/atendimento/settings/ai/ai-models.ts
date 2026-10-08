// Modelos de IA oferecidos nas telas de Ajustes › IA (skills, padrão e chat de teste).
export const OPENAI_MODELS = [
  { value: 'gpt-5.4-mini', label: 'GPT-5.4 Mini — rápido, inteligente' },
  { value: 'gpt-5.1', label: 'GPT-5.1 — conversacional avançado' },
  { value: 'gpt-4.1', label: 'GPT-4.1 — analítico' },
  { value: 'gpt-4.1-mini', label: 'GPT-4.1 Mini — balanceado' },
  { value: 'gpt-4o-mini', label: 'GPT-4o Mini — rápido, econômico' },
  { value: 'gpt-4o', label: 'GPT-4o — capaz' },
  { value: 'o1-mini', label: 'o1 Mini — raciocínio' },
];

export const ANTHROPIC_MODELS = [
  { value: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6 — balanceado' },
  { value: 'claude-haiku-4-5', label: 'Claude Haiku 4.5 — rápido, econômico' },
  { value: 'claude-opus-4-6', label: 'Claude Opus 4.6 — máxima capacidade' },
];

export const AVAILABLE_MODELS = [...OPENAI_MODELS, ...ANTHROPIC_MODELS];

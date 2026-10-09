/**
 * Funil geral — colunas comuns a TODOS os funis do CRC.
 *
 * Cada funil (Odontologia Clínica, Implantes, Ortodontia, Comercial B2B...) tem
 * etapas próprias; o "Funil geral" junta todos numa visão só. Cada etapa cai numa
 * coluna geral por, nesta ordem:
 *   1. flags da etapa (inicial / ganho / perdido / oculta do kanban);
 *   2. slug conhecido (templates de pipelines.service.ts + slugs legados);
 *   3. palavra-chave no slug/nome (funil criado à mão pelo admin);
 *   4. posição relativa no funil (último recurso).
 * NÃO usar só a posição: o SQL manual de 2026-05 deixou posições com buraco.
 *
 * A IA usa o mesmo mapa: quando o lead troca de funil, ele vai pra etapa
 * EQUIVALENTE do funil novo — antes ficava com a etapa do funil antigo e sumia
 * do kanban.
 *
 * Cópia em apps/web/src/lib/pipeline-general.ts (componente client não pode
 * importar '@crm/shared') — manter igual.
 */

export type GeneralStageKey =
  | 'novo'
  | 'conversa'
  | 'convite'
  | 'agendado'
  | 'orcamento'
  | 'fechamento'
  | 'ganho'
  | 'perdido';

export interface GeneralStageDef {
  key: GeneralStageKey;
  label: string;
  emoji: string;
  color: string;
  /** Vira coluna no kanban. Ganho/perdido/fechamento ficam fora, como em cada funil. */
  visible: boolean;
}

export const GENERAL_STAGES: GeneralStageDef[] = [
  { key: 'novo', label: 'Novo contato', emoji: '👋', color: '#6b7280', visible: true },
  { key: 'conversa', label: 'Em conversa', emoji: '💬', color: '#3b82f6', visible: true },
  { key: 'convite', label: 'Convite p/ avaliação', emoji: '📨', color: '#06b6d4', visible: true },
  { key: 'agendado', label: 'Avaliação agendada', emoji: '📅', color: '#8b5cf6', visible: true },
  { key: 'orcamento', label: 'Avaliação / orçamento', emoji: '📄', color: '#f97316', visible: true },
  { key: 'fechamento', label: 'Em fechamento', emoji: '✍️', color: '#d97706', visible: false },
  { key: 'ganho', label: 'Ganho', emoji: '✅', color: '#10b981', visible: false },
  { key: 'perdido', label: 'Perdido', emoji: '❌', color: '#ef4444', visible: false },
];

export interface StageLike {
  slug: string;
  name?: string | null;
  position?: number | null;
  is_initial?: boolean | null;
  is_won?: boolean | null;
  is_lost?: boolean | null;
  is_hidden_from_kanban?: boolean | null;
}

const SLUG_TO_GENERAL: Record<string, GeneralStageKey> = {
  inicial: 'novo',
  novo: 'novo',
  new: 'novo',
  'novo-contato': 'novo',
  qualificando: 'conversa',
  qualificado: 'conversa',
  qualified: 'conversa',
  contatado: 'conversa',
  contacted: 'conversa',
  descoberta: 'conversa',
  educando: 'conversa',
  'gestao-expectativa': 'conversa',
  'contornando-objecao': 'conversa',
  triagem: 'conversa',
  'em-conversa': 'conversa',
  'aguardando-form': 'conversa',
  'convite-avaliacao': 'convite',
  'consulta-agendada': 'agendado',
  'avaliacao-agendada': 'agendado',
  'avaliacao-aceita': 'agendado',
  'reuniao-agendada': 'agendado',
  'avaliacao-feita': 'orcamento',
  'avaliacao-realizada': 'orcamento',
  'orcamento-enviado': 'orcamento',
  'proposta-enviada': 'orcamento',
  proposta: 'orcamento',
  proposal: 'orcamento',
  negociando: 'orcamento',
  negociacao: 'orcamento',
  'aguardando-docs': 'orcamento',
  'aguardando-proc': 'orcamento',
  'assinatura-contrato': 'orcamento',
  // Etapa "em-fechamento" VISÍVEL (funil antigo) fica na coluna de orçamento; a
  // oculta do kanban cai em 'fechamento' pela flag, antes de chegar aqui.
  'em-fechamento': 'orcamento',
  'tratamento-iniciado': 'ganho',
  'procedimento-feito': 'ganho',
  'contrato-fechado': 'ganho',
  'contrato-assinado': 'ganho',
  finalizado: 'ganho',
  ganho: 'ganho',
  won: 'ganho',
  perdido: 'perdido',
  lost: 'perdido',
};

function normalizeSlug(s: string | null | undefined): string {
  return String(s ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .trim()
    .toLowerCase()
    .replace(/[_\s]+/g, '-');
}

function byKeyword(text: string): GeneralStageKey | null {
  if (!text) return null;
  if (/agend|marcad/.test(text)) return 'agendado';
  if (/convit|convid/.test(text)) return 'convite';
  if (/orcament|propost|negoci|avalia|contrat|fechament/.test(text)) return 'orcamento';
  if (/qualific|convers|descobert|educa|objec|expectativ|interess|contat|triag|duvid/.test(text)) return 'conversa';
  return null;
}

/** Coluna geral de uma etapa de funil. `siblings` = etapas do MESMO funil (pro último recurso por posição). */
export function generalStageOf(stage: StageLike, siblings?: StageLike[]): GeneralStageKey {
  if (stage.is_lost) return 'perdido';
  if (stage.is_won) return 'ganho';
  if (stage.is_initial) return 'novo';
  if (stage.is_hidden_from_kanban) return 'fechamento';

  const slug = normalizeSlug(stage.slug);
  const known = SLUG_TO_GENERAL[slug];
  // Flags mandam: um slug "inicial"/"perdido" sem a flag (admin trocou) não rouba a coluna.
  if (known && known !== 'novo' && known !== 'ganho' && known !== 'perdido') return known;

  const kw = byKeyword(slug) ?? byKeyword(normalizeSlug(stage.name));
  if (kw) return kw;

  // Último recurso: posição entre as etapas "de trabalho" do funil.
  const work = (siblings ?? [])
    .filter(s => !s.is_initial && !s.is_won && !s.is_lost && !s.is_hidden_from_kanban)
    .slice()
    .sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
  const idx = work.findIndex(s => s.slug === stage.slug);
  if (idx >= 0 && work.length > 1 && idx / (work.length - 1) > 0.5) return 'orcamento';
  return 'conversa';
}

/**
 * Coluna geral de um slug solto (ex.: o que a IA devolveu). Diferente do
 * generalStageFromLegacy, slug desconhecido = null (não vira "novo" — senão um
 * slug inventado pela IA jogava o lead de volta pra etapa inicial).
 */
export function generalStageFromSlug(slug: string | null | undefined): GeneralStageKey | null {
  const s = normalizeSlug(slug);
  if (!s) return null;
  if (s === 'em-fechamento') return 'fechamento';
  return SLUG_TO_GENERAL[s] ?? byKeyword(s) ?? null;
}

/** Coluna geral de um lead que só tem o `Lead.stage` String legado (sem stage_id). */
export function generalStageFromLegacy(legacy: string | null | undefined): GeneralStageKey {
  const slug = normalizeSlug(legacy);
  if (!slug) return 'novo';
  if (slug === 'em-fechamento') return 'fechamento';
  return SLUG_TO_GENERAL[slug] ?? byKeyword(slug) ?? 'novo';
}

/**
 * Primeira etapa (por posição) do funil `stages` que cai na coluna geral `key`.
 * `workOnly`: só etapas que aparecem no kanban (sem ganho/perdido/oculta).
 */
export function equivalentStageIn<T extends StageLike>(
  stages: T[],
  key: GeneralStageKey,
  opts?: { workOnly?: boolean },
): T | null {
  const sorted = stages.slice().sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
  for (const s of sorted) {
    if (opts?.workOnly && (s.is_won || s.is_lost || s.is_hidden_from_kanban)) continue;
    if (generalStageOf(s, stages) === key) return s;
  }
  return null;
}


const WALK_BACK: GeneralStageKey[] = ['novo', 'conversa', 'convite', 'agendado', 'orcamento', 'fechamento'];

/**
 * Como equivalentStageIn, mas se o funil não tem aquela coluna usa a mais
 * próxima ANTERIOR (ex.: Odontologia Clínica não tem "convite" → "em conversa";
 * Implantes não tem "orçamento" visível → "avaliação agendada"). Ganho/perdido
 * só valem exatos. null = nada antes (caller usa a etapa inicial).
 */
export function nearestStageIn<T extends StageLike>(
  stages: T[],
  key: GeneralStageKey,
  opts?: { workOnly?: boolean },
): T | null {
  const exact = equivalentStageIn(stages, key, opts);
  if (exact) return exact;
  for (let i = WALK_BACK.indexOf(key) - 1; i >= 0; i--) {
    const s = equivalentStageIn(stages, WALK_BACK[i], opts);
    if (s) return s;
  }
  return null;
}

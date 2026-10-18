/**
 * Out/2026 — Direcionar cada procedimento pro dentista da ÁREA (decisão do dono).
 *
 * Um paciente pode ser de vários dentistas: cada procedimento vai pra quem tem a
 * especialidade (canal → Endodontia, aparelho → Ortodontia...). Especialidade do
 * dentista é texto livre (User.specialties) e a do procedimento vem de
 * Procedure.specialty.name / category / nome — por isso o casamento é por FAMÍLIA
 * de palavras (sem acento, minúsculo), não por igualdade de texto.
 *
 * Regra (pickDentistForProcedure):
 *   1. dentistas cuja especialidade é da mesma área do procedimento;
 *      se quem está lançando (preferUserId) é um deles → ele; senão o 1º por nome;
 *   2. ninguém da área → quem está lançando, se for dentista;
 *   3. senão → null (fica sem dentista; dá pra escolher na tela).
 * Puro (sem I/O): usado na API (lançar item, organizar dados antigos) e testável.
 */

export interface RoutingDentist {
  id: string;
  name?: string | null;
  specialties?: string[] | null;
}

export interface RoutingProcedure {
  name?: string | null;
  category?: string | null;
  /** Procedure.specialty.name */
  specialty?: string | null;
}

/** Áreas → palavras-chave (sem acento, minúsculas; casamento por "contém"). */
const AREAS: Record<string, string[]> = {
  endodontia:   ['endodont', 'canal', 'pulp'],
  ortodontia:   ['ortodont', 'aparelho', 'alinhador', 'invisalign', 'ortopedia funcional'],
  implante:     ['implant', 'protocolo', 'enxerto', 'carga imediata'],
  protese:      ['protes', 'protetic', 'coroa', 'faceta', 'lente', 'porcelana', 'reabilit', 'onlay', 'inlay', 'nucleo'],
  periodontia:  ['periodont', 'raspagem', 'gengiv', 'periodonto'],
  odontopediatria: ['odontoped', 'pediatr', 'infantil', 'crianca', 'bebe'],
  cirurgia:     ['cirurg', 'extrac', 'exodont', 'siso', 'bucomax', 'frenectom'],
  harmonizacao: ['harmoniz', 'botox', 'toxina', 'preench', 'bioestim', 'facial'],
  estetica:     ['estetic', 'clarea', 'resina composta', 'microabras'],
  dentistica:   ['dentistic', 'restaura', 'clinic', 'geral', 'limpeza', 'profilax'],
};

export function normalizeText(s: string | null | undefined): string {
  return String(s ?? '')
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/_/g, ' ')
    .trim();
}

/** Áreas que um texto menciona. */
export function areasOf(text: string | null | undefined): Set<string> {
  const t = normalizeText(text);
  const out = new Set<string>();
  if (!t) return out;
  for (const [area, kws] of Object.entries(AREAS)) {
    if (kws.some((k) => t.includes(k))) out.add(area);
  }
  return out;
}

/** Áreas do procedimento: especialidade/categoria primeiro; o nome só se elas não disserem nada. */
export function procedureAreas(p: RoutingProcedure): Set<string> {
  const byTag = new Set<string>([...areasOf(p.specialty), ...areasOf(p.category)]);
  return byTag.size > 0 ? byTag : areasOf(p.name);
}

/** Áreas de um dentista (união das especialidades dele). */
export function dentistAreas(d: RoutingDentist): Set<string> {
  const out = new Set<string>();
  for (const s of d.specialties ?? []) areasOf(s).forEach((a) => out.add(a));
  return out;
}

/** Dentistas da área do procedimento (ordem por nome). */
export function dentistsForProcedure(p: RoutingProcedure, dentists: RoutingDentist[]): RoutingDentist[] {
  const areas = procedureAreas(p);
  if (areas.size === 0) return [];
  return dentists
    .filter((d) => [...dentistAreas(d)].some((a) => areas.has(a)))
    .sort((a, b) => String(a.name ?? '').localeCompare(String(b.name ?? ''), 'pt-BR'));
}

export function pickDentistForProcedure(
  p: RoutingProcedure,
  dentists: RoutingDentist[],
  opts: { preferUserId?: string | null } = {},
): string | null {
  const prefer = opts.preferUserId ?? null;
  const matches = dentistsForProcedure(p, dentists);
  if (matches.length > 0) {
    if (prefer && matches.some((d) => d.id === prefer)) return prefer;
    return matches[0].id;
  }
  if (prefer && dentists.some((d) => d.id === prefer)) return prefer;
  return null;
}

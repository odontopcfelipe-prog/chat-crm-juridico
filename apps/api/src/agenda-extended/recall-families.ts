// Retornos (Manutenção) — FAMÍLIAS de procedimento. A aba de uma família (limpeza,
// clareamento, faceta de resina) junta TODO paciente que fez aquele tipo de procedimento, não só quem tem item
// de plano do procedimento exato da aba: o catálogo costuma ter vários ("Limpeza",
// "Profilaxia (limpeza + raspagem)", "Clareamento caseiro", antigos arquivados...).
// Funções puras (testáveis) usadas pelo getMaintenanceBoard em return-alerts.service.ts.

const norm = (s: string | null | undefined) =>
  (s || '').normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();

/** Categorias da estética FACIAL — nunca entram numa família odontológica. */
const FACIAL_CATEGORIES = new Set([
  'HOF', 'TOXINA_BOTULINICA', 'PREENCHIMENTO_AH', 'BIOESTIMULADOR', 'FIOS_PDO', 'FIOS_PLLA',
  'PEELING_QUIMICO', 'MICROAGULHAMENTO', 'SKINBOOSTER', 'LASER', 'RADIOFREQUENCIA',
  'ULTRASSOM_MICROFOCADO', 'LIPO_ENZIMATICA', 'LIMPEZA_PELE',
]);

export type RecallFamily = {
  key: string;
  /** Texto (nome do procedimento, título/tipo da consulta) que é dessa família. */
  match: RegExp;
  /** Texto que parece mas NÃO é (estética de pele etc.). */
  exclude: RegExp;
  /** Categoria do catálogo que já define a família (e tem preferência na escolha da aba). */
  category: string | null;
  /** Termos do filtro grosso no banco (ILIKE) da agenda — o fino é o `match`/`exclude`. */
  agendaTerms: string[];
};

export const RECALL_FAMILIES: RecallFamily[] = [
  {
    key: 'limpeza',
    match: /limpeza|profilaxia/,
    exclude: /limpeza\s+(de\s+)?pele|limpeza\s+facial/,
    category: 'PROFILAXIA',
    agendaTerms: ['limpeza', 'profilaxia'],
  },
  {
    key: 'clareamento',
    match: /clareamento/,
    exclude: /clareamento\s+(de\s+|da\s+|das\s+)?(pele|axilas?|virilha|manchas?|facial|intimo|olheiras?|melasma)/,
    category: null,
    agendaTerms: ['clareamento'],
  },
  {
    // Faceta de RESINA (direta). "Faceta" sem material conta como resina; porcelana/cerâmica/
    // lente é outro tratamento, e remoção/retirada não deixa faceta pra manter.
    key: 'faceta_resina',
    match: /faceta/,
    exclude: /porcelana|ceramica|dissilicato|e-?max|zirconia|lente|remocao|retirada/,
    category: null,
    agendaTerms: ['faceta'],
  },
];

/** Texto é dessa família (ex.: limpeza DENTAL — "limpeza de pele" é estética, fica fora). */
export function isFamilyText(fam: RecallFamily, s: string | null | undefined): boolean {
  const t = norm(s);
  if (fam.exclude.test(t)) return false;
  return fam.match.test(t);
}

/** Procedimento do catálogo que é dessa família (categoria da família ou nome). */
export function isFamilyProcedure(fam: RecallFamily, p: { name: string; category?: string | null }): boolean {
  if (p.category && FACIAL_CATEGORIES.has(p.category)) return false;
  return (!!fam.category && p.category === fam.category) || isFamilyText(fam, p.name);
}

export type FamilyProc = {
  id: string;
  name: string;
  category?: string | null;
  active: boolean;
  default_revisit_months: number | null;
};

/**
 * A aba que recebe a família inteira: o procedimento da família ATIVO com retorno ligado
 * (>=1). Se houver mais de um, prefere a categoria da família, depois o nome. Nenhum ligado
 * → null (o retorno é OPT-IN: sem nenhum ligado em Configurações → Retornos, não há aba).
 */
export function pickFamilyHome(fam: RecallFamily, procs: FamilyProc[]): FamilyProc | null {
  const isCat = (p: FamilyProc) => Number(!!fam.category && p.category === fam.category);
  const on = procs
    .filter((p) => p.active && (p.default_revisit_months ?? 0) >= 1 && isFamilyProcedure(fam, p))
    .sort((a, b) => isCat(b) - isCat(a) || a.name.localeCompare(b.name, 'pt-BR'));
  return on[0] || null;
}

export type FamilyEvidence = {
  patient_id: string;
  date: Date;
  by_name: string | null;
  source: 'plano' | 'agenda';
};

/** 1 por paciente = a execução MAIS RECENTE (de qualquer fonte); retorno = essa data + N meses. */
export function latestPerPatient(
  evidences: FamilyEvidence[],
  months: number,
): Array<FamilyEvidence & { return_date: Date }> {
  const best = new Map<string, FamilyEvidence>();
  for (const e of evidences) {
    const cur = best.get(e.patient_id);
    if (!cur || e.date.getTime() > cur.date.getTime()) best.set(e.patient_id, e);
  }
  return Array.from(best.values()).map((e) => {
    const ret = new Date(e.date);
    ret.setMonth(ret.getMonth() + months);
    return { ...e, return_date: ret };
  });
}

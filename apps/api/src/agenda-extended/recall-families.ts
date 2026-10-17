// Retornos (Manutenção) — FAMÍLIAS de procedimento. A aba de uma família (limpeza,
// clareamento, faceta de resina, lentes, implante, protocolo) junta TODO paciente que fez
// aquele tipo de procedimento, não só quem tem item de plano do procedimento exato da aba: o
// catálogo costuma ter vários ("Limpeza", "Profilaxia (limpeza + raspagem)", "Clareamento
// caseiro", antigos arquivados...). Procedimento ligado FORA de família vira uma família de
// um só (procedureFamily) — toda aba segue a mesma regra (plano + agenda).
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
    // Faceta de RESINA (direta). "Faceta" sem material conta como resina; "lente de resina"
    // também. Porcelana/cerâmica/lente sem resina é a família de lentes, e remoção/retirada
    // não deixa faceta pra manter.
    key: 'faceta_resina',
    match: /faceta|lente/,
    exclude: /porcelana|ceramica|dissilicato|e-?max|zirconia|remocao|retirada|^(?!.*resina).*lente/,
    category: null,
    agendaTerms: ['faceta', 'lente'],
  },
  {
    // LENTES DE PORCELANA: lente de contato dental, ou faceta de porcelana/cerâmica/e.max/
    // dissilicato/zircônia. Coroa/prótese de porcelana NÃO (não tem faceta nem lente no nome).
    key: 'lentes_porcelana',
    match: /lente|faceta.*(porcelana|ceramica|dissilicato|e-?max|zirconia)|(porcelana|ceramica|dissilicato|e-?max|zirconia).*faceta/,
    exclude: /resina|remocao|retirada/,
    category: null,
    // ILIKE do banco não ignora acento: "cerâmica" e "ceramica" vão os dois.
    agendaTerms: ['lente', 'porcelana', 'cerâmica', 'ceramica', 'e.max', 'emax', 'dissilicato', 'zircônia', 'zirconia'],
  },
  {
    // IMPLANTE (unitário, coroa/prótese sobre implante, manutenção). Protocolo é família
    // própria; remoção/explante não deixa implante; avaliação/planejamento/enxerto/tomografia
    // é antes do implante (o item do implante em si entra separado).
    key: 'implante',
    match: /implante|implantossuport/,
    exclude: /protocolo|all.?on|branemark|remocao|retirada|explante|avaliacao|planejamento|enxerto|tomografia|orcamento/,
    category: null,
    agendaTerms: ['implante', 'implantossuport'],
  },
  {
    // PROTOCOLO (prótese fixa sobre implantes), cerâmica OU resina. "Protocolo" também é
    // palavra genérica ("protocolo de clareamento") — esses ficam fora. Remoção do protocolo
    // pra higienização É a manutenção, então conta.
    key: 'protocolo',
    match: /protocolo|all.?on.?(4|6|four|six|quatro|seis)|branemark/,
    exclude: /clareamento|ortodont|toxina|botox|harmoniza|preenchimento|bioestimul|peeling|dessensibiliz|fluor/,
    category: null,
    agendaTerms: ['protocolo', 'all on', 'all-on', 'branemark'],
  },
];

/** Texto é dessa família (ex.: limpeza DENTAL — "limpeza de pele" é estética, fica fora). */
export function isFamilyText(fam: RecallFamily, s: string | null | undefined): boolean {
  const t = norm(s);
  if (fam.exclude.test(t)) return false;
  return fam.match.test(t);
}

/**
 * Família de UM procedimento só (ligado em Retornos, fora das famílias): a consulta conta se o
 * título/tipo trouxer o nome dele (sem acento/caixa) ou se estiver vinculada ao item dele.
 */
export function procedureFamily(p: { id: string; name: string }): RecallFamily {
  const n = norm(p.name).trim();
  return {
    key: `proc:${p.id}`,
    match: n ? new RegExp(n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')) : /(?!)/,
    exclude: /(?!)/, // nunca casa
    category: null,
    // ILIKE do banco não ignora acento: vai o nome como está e sem acento.
    agendaTerms: Array.from(new Set([p.name.trim(), n])),
  };
}

/**
 * Consulta SÓ de avaliação/orçamento/planejamento ("Avaliação para clareamento") não prova
 * que o procedimento foi FEITO. Com junção ("Avaliação + limpeza", "avaliação e limpeza")
 * os dois foram feitos na mesma visita, então conta.
 */
export function isEvaluationOnly(title: string | null | undefined): boolean {
  const t = norm(title);
  if (!/avaliac|orcamento|planejamento/.test(t)) return false;
  return !/\+|&|\/|,|\s+e\s+/.test(t);
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

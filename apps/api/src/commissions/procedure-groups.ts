/**
 * "Procedimentos do mês" do painel do dentista — agrupa os procedimentos que ele
 * EXECUTOU em famílias que a clínica reconhece (Limpeza, Restauração, Extração…).
 *
 * Ordem: palavra-chave no NOME (mais específico — "Lente de porcelana" é Lentes,
 * não "Estética"), depois a categoria do cadastro, por último o próprio nome.
 * Só contagem — nada de valor (regra do dono: com o profissional não se fala
 * em dinheiro).
 */

const norm = (s: string) =>
  s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();

/** [rótulo, palavras-chave no nome (sem acento, minúsculas)] — a 1ª que bater vence. */
const NAME_GROUPS: [string, string[]][] = [
  ['Limpeza', ['limpeza', 'profilaxia', 'raspagem', 'tartaro']],
  ['Clareamento', ['clareamento']],
  ['Lentes e facetas', ['lente', 'faceta', 'porcelana', 'laminado']],
  ['Implante', ['implante', 'enxerto', 'carga imediata']],
  ['Prótese', ['protese', 'protocolo', 'coroa', 'ponte fixa', 'dentadura', 'pino']],
  ['Endodontia', ['canal', 'endodont', 'pulpotomia', 'pulpectomia']],
  ['Extração', ['extracao', 'exodontia', 'siso', 'cirurgia']],
  ['Ortodontia', ['ortodont', 'aparelho', 'alinhador', 'contencao']],
  ['Restauração', ['restaura', 'resina', 'obturacao', 'amalgama', 'ionomero']],
  ['Periodontia', ['periodont', 'gengiv']],
  ['Avaliação', ['avaliacao', 'consulta', 'radiografia', 'raio-x', 'raio x']],
];

const CATEGORY_LABEL: Record<string, string> = {
  PROFILAXIA: 'Limpeza',
  DENTISTICA: 'Restauração',
  ENDODONTIA: 'Endodontia',
  PERIODONTIA: 'Periodontia',
  ORTODONTIA: 'Ortodontia',
  IMPLANTE: 'Implante',
  PROTESE: 'Prótese',
  CIRURGIA: 'Extração',
  ESTETICA_DENTAL: 'Estética',
  HOF: 'Harmonização',
  TOXINA_BOTULINICA: 'Toxina botulínica',
  PREENCHIMENTO_AH: 'Preenchimento',
};

export function procedureGroup(p: { name?: string | null; category?: string | null }): string {
  const name = norm(p.name || '');
  for (const [label, keys] of NAME_GROUPS) {
    if (keys.some((k) => name.includes(k))) return label;
  }
  const cat = (p.category || '').trim().toUpperCase();
  if (cat && CATEGORY_LABEL[cat]) return CATEGORY_LABEL[cat];
  const raw = (p.name || '').trim();
  return raw ? raw.charAt(0).toUpperCase() + raw.slice(1).toLowerCase() : 'Outros';
}

/** Conta por família, maiores primeiro; depois das `max` primeiras o resto vira "Outros". */
export function groupProcedures(
  procs: { name?: string | null; category?: string | null }[],
  max = 6,
): { total: number; items: { label: string; count: number }[] } {
  const counts = new Map<string, number>();
  for (const p of procs) {
    const g = procedureGroup(p);
    counts.set(g, (counts.get(g) ?? 0) + 1);
  }
  const sorted = [...counts.entries()]
    .map(([label, count]) => ({ label, count }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label, 'pt-BR'));
  const items = sorted.slice(0, max);
  const rest = sorted.slice(max).reduce((n, x) => n + x.count, 0);
  if (rest > 0) {
    const outros = items.find((x) => x.label === 'Outros');
    if (outros) outros.count += rest;
    else items.push({ label: 'Outros', count: rest });
  }
  return { total: procs.length, items };
}

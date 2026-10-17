// Retornos (Manutenção) — a aba de LIMPEZA junta TODO paciente que fez limpeza, não só
// quem tem item de plano do procedimento exato da aba. Funções puras (testáveis) usadas
// pelo getMaintenanceBoard em return-alerts.service.ts.

const norm = (s: string | null | undefined) =>
  (s || '').normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();

/** Texto fala de limpeza DENTAL (limpeza/profilaxia) — "limpeza de pele"/facial é estética, fica fora. */
export function isLimpezaText(s: string | null | undefined): boolean {
  const t = norm(s);
  if (/limpeza\s+(de\s+)?pele|limpeza\s+facial/.test(t)) return false;
  return /limpeza|profilaxia/.test(t);
}

/** Procedimento do catálogo que é limpeza dental (categoria PROFILAXIA ou nome com limpeza/profilaxia). */
export function isLimpezaProcedure(p: { name: string; category?: string | null }): boolean {
  if (p.category === 'LIMPEZA_PELE') return false;
  return p.category === 'PROFILAXIA' || isLimpezaText(p.name);
}

export type LimpezaProc = {
  id: string;
  name: string;
  category?: string | null;
  active: boolean;
  default_revisit_months: number | null;
};

/**
 * A aba que recebe TODAS as limpezas: o procedimento de limpeza ATIVO com retorno ligado
 * (>=1). Se houver mais de um, prefere a categoria PROFILAXIA, depois o nome. Nenhum ligado
 * → null (o retorno é OPT-IN: sem limpeza ligada em Configurações → Retornos, não há aba).
 */
export function pickLimpezaHome(procs: LimpezaProc[]): LimpezaProc | null {
  const on = procs
    .filter((p) => p.active && (p.default_revisit_months ?? 0) >= 1 && isLimpezaProcedure(p))
    .sort(
      (a, b) =>
        Number(b.category === 'PROFILAXIA') - Number(a.category === 'PROFILAXIA') ||
        a.name.localeCompare(b.name, 'pt-BR'),
    );
  return on[0] || null;
}

export type LimpezaEvidence = {
  patient_id: string;
  date: Date;
  by_name: string | null;
  source: 'plano' | 'agenda';
};

/** 1 por paciente = a limpeza MAIS RECENTE (de qualquer fonte); retorno = essa data + N meses. */
export function latestLimpezaPerPatient(
  evidences: LimpezaEvidence[],
  months: number,
): Array<LimpezaEvidence & { return_date: Date }> {
  const best = new Map<string, LimpezaEvidence>();
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

// Categorias da Base de Conhecimento da CLÍNICA (memórias scope=organization).
//
// cópia — manter igual a packages/shared/src/memory-categories.ts
// (client component não importa '@crm/shared'). Se mudar lá, mude aqui.
//
// Antes era um CRM jurídico (court_info, legal_knowledge, "honorários"...). As
// categorias antigas continuam LEGÍVEIS (memórias já gravadas), mas não são mais
// oferecidas para criar.

export const ORG_MEMORY_SUBCATEGORIES = ['office_info', 'team', 'procedures', 'treatments', 'payment', 'rules'] as const;
export type OrgMemorySubcategory = (typeof ORG_MEMORY_SUBCATEGORIES)[number];

/** Categorias do sistema antigo — só leitura/arquivamento. */
export const LEGACY_ORG_MEMORY_SUBCATEGORIES = ['fees', 'court_info', 'legal_knowledge', 'contacts'] as const;

export const ORG_MEMORY_LABELS: Record<string, { label: string; hint: string }> = {
  office_info: { label: 'Clínica', hint: 'Endereço, contatos, estrutura, Instagram' },
  team: { label: 'Equipe', hint: 'Dentistas, especialidades e quem faz o quê' },
  procedures: { label: 'Como atendemos', hint: 'Avaliação, anamnese, agendamento, faltas' },
  treatments: { label: 'Tratamentos', hint: 'Como funciona cada tratamento (sem preço)' },
  payment: { label: 'Pagamento', hint: 'Formas de pagamento, parcelamento, convênios (sem valores)' },
  rules: { label: 'Regras', hint: 'O que a clínica faz e não faz, políticas' },
  fees: { label: 'Valores (antigo)', hint: 'Preços agora ficam em Ajustes IA › Valores' },
  court_info: { label: 'Fóruns (antigo, jurídico)', hint: 'Sobra do sistema jurídico — pode arquivar' },
  legal_knowledge: { label: 'Conhecimento (antigo)', hint: 'Categoria antiga — revise e reclassifique' },
  contacts: { label: 'Contatos (antigo)', hint: 'Categoria antiga' },
};

export function isOrgMemorySubcategory(v: unknown): v is OrgMemorySubcategory {
  return typeof v === 'string' && (ORG_MEMORY_SUBCATEGORIES as readonly string[]).includes(v);
}

/** Preço/valor/desconto — a clínica configura em Ajustes IA › Valores, não na memória. */
export const ORG_MEMORY_PRICE_RE = /r\$|\d+(?:[.,]\d+)?\s*reais\b|\d+\s*%\s*(de )?desconto|desconto de \d/i;

export function orgMemoryPriceReason(content: string | null | undefined): string | null {
  return ORG_MEMORY_PRICE_RE.test(String(content || '')) ? 'Tem preço — preços ficam em Ajustes IA › Valores' : null;
}

// (internalOrgMemoryReason fica só no shared: a tela não usa — a revisão roda na API.)

// ─── Só da tela (não existe no shared) ──────────────────────────────────

/**
 * Como está o "Resumo da clínica" (OrganizationProfile) — decide o que arquivar
 * muda pra IA: sem resumo a IA lê as memórias cruas; com resumo ela lê o resumo,
 * que só se atualiza sozinho se NÃO foi editado à mão.
 */
export type OrgSummaryState = 'none' | 'auto' | 'manual';

/** O que acontece com a IA ao arquivar `count` memórias (texto da confirmação). */
export function archiveEffectText(state: OrgSummaryState, count: number): string {
  const one = count === 1;
  if (state === 'manual') {
    return `${one ? 'Ela sai' : 'Elas saem'} da base, mas o resumo da clínica foi editado à mão e não muda sozinho: se o resumo falar disso, a IA continua usando até você editar o texto ou clicar em Atualizar/Regenerar.`;
  }
  if (state === 'auto') {
    return `A IA deixa de ${one ? 'usá-la' : 'usá-las'} quando o resumo da clínica se atualizar (cerca de 1 minuto).`;
  }
  return `A IA deixa de ${one ? 'usá-la' : 'usá-las'}.`;
}

/** Retorno de POST /memories/organization/archive|restore sobre o resumo da clínica. */
export type OrgSummaryOutcome = 'regen_queued' | 'skipped_manual' | 'none';

export interface OrgSummaryNote {
  outcome: Exclude<OrgSummaryOutcome, 'none'>;
  text: string;
  tone: 'warn' | 'info';
}

/**
 * Aviso sobre o resumo depois de arquivar/restaurar. Usa o `summary` da API; se a
 * API ainda não manda o campo (versão antiga), deduz pelo estado do resumo.
 */
export function orgSummaryNote(
  summary: unknown,
  state: OrgSummaryState,
  changed: number,
): OrgSummaryNote | null {
  let outcome: OrgSummaryOutcome;
  if (summary === 'regen_queued' || summary === 'skipped_manual' || summary === 'none') outcome = summary;
  else if (changed <= 0 || state === 'none') outcome = 'none';
  else outcome = state === 'manual' ? 'skipped_manual' : 'regen_queued';

  if (outcome === 'skipped_manual') {
    return {
      outcome,
      tone: 'warn',
      text: 'O resumo da clínica foi editado à mão e não muda sozinho: edite o texto ou clique em Atualizar/Regenerar para aplicar.',
    };
  }
  if (outcome === 'regen_queued') {
    return { outcome, tone: 'info', text: 'O resumo será atualizado em cerca de 1 minuto.' };
  }
  return null;
}

/** Rótulo de qualquer subcategoria, inclusive desconhecida ('geral' = sem categoria). */
export function orgMemoryLabel(key: string | null | undefined): string {
  if (!key || key === 'geral') return 'Sem categoria';
  return ORG_MEMORY_LABELS[key]?.label ?? key;
}

/** Tipos de sugestão da revisão com IA (POST /memories/organization/review). */
export type MemoryReviewKind = 'interno' | 'paciente' | 'juridico' | 'preco' | 'pontual' | 'duplicada' | 'errada';

/** Selo de cada tipo de sugestão: texto + cor (classes Tailwind). */
export const MEMORY_REVIEW_KINDS: Record<MemoryReviewKind, { label: string; cls: string }> = {
  interno: { label: 'Interno', cls: 'bg-red-500/10 text-red-600 dark:text-red-400 border-red-500/20' },
  paciente: { label: 'Dado de paciente', cls: 'bg-rose-500/10 text-rose-600 dark:text-rose-400 border-rose-500/20' },
  juridico: { label: 'Sobra do jurídico', cls: 'bg-slate-500/10 text-slate-600 dark:text-slate-300 border-slate-500/20' },
  preco: { label: 'Preço', cls: 'bg-amber-500/10 text-amber-700 dark:text-amber-400 border-amber-500/20' },
  pontual: { label: 'Pontual', cls: 'bg-sky-500/10 text-sky-600 dark:text-sky-400 border-sky-500/20' },
  duplicada: { label: 'Duplicada', cls: 'bg-violet-500/10 text-violet-600 dark:text-violet-400 border-violet-500/20' },
  errada: { label: 'Errada', cls: 'bg-orange-500/10 text-orange-600 dark:text-orange-400 border-orange-500/20' },
};

export function memoryReviewKind(kind: string): { label: string; cls: string } {
  return (
    MEMORY_REVIEW_KINDS[kind as MemoryReviewKind] ?? {
      label: kind || 'Revisar',
      cls: 'bg-muted text-muted-foreground border-border',
    }
  );
}

// Base de Conhecimento da CLÍNICA (memórias scope=organization) — contrato único
// entre worker (extração noturna), API (CRUD/revisão) e tela (cópia em
// apps/web/.../settings/knowledge/memory-categories.ts — manter igual).
//
// Antes era um CRM jurídico (court_info, legal_knowledge, "honorários"...). As
// categorias antigas continuam LEGÍVEIS (memórias já gravadas), mas não são mais
// geradas nem oferecidas para criar.

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

/**
 * Motivo pelo qual uma memória "da clínica" parece dado INTERNO (não serve pra
 * atender paciente e não pode ir pro prompt da IA) — ou null se parece ok.
 * Rede de segurança determinística: a extração (LLM) já é instruída a não gerar
 * isso, mas relatórios automáticos que chegam pelo WhatsApp (fechamento de caixa,
 * listas de pacientes, cobrança) escapavam como se fossem fala da equipe.
 */
export function internalOrgMemoryReason(
  content: string | null | undefined,
  subcategory?: string | null,
): string | null {
  const t = String(content || '').toLowerCase();
  if (!t.trim()) return null;
  const rules: [RegExp, string][] = [
    [/fechamento d[oe] (dia|caixa)|entradas? (financeiras?|totais)|sa[ií]das? financeiras?|caixa do dia|faturamento|receita do m[eê]s/, 'Fechamento de caixa / financeiro interno'],
    [/boletos? (em|com) atraso|boletos? vencid|inadimpl|em atraso totalizando|totalizando r\$|devem r\$/, 'Cobrança / inadimplência (dado interno)'],
    [/realizou (uma |as seguintes )?vendas?|vendas? (em boleto|para|do dia)|negocia[cç][oõ]es fechadas|fechou (\S+ )?negocia|vendedor(a)?:/, 'Vendas do dia (dado interno)'],
    [/estoque|em falta|sem (papel|folha)|pedidos? (desses|de) materia|fornecedor|faltam? .{0,40}comprar/, 'Estoque / compras (dado interno)'],
    [/holerite|consignad|fgts|inss|desconto em folha|folha de pagamento|aluguel de laborat|sal[aá]rio/, 'Folha de pagamento / administrativo'],
    // Só NÚMERO de documento/chave (pedir "RG e CPF" na consulta é regra legítima).
    [/\d{3}\.\d{3}\.\d{3}-\d{2}|\d{2}\.\d{3}\.\d{3}\/\d{4}-\d{2}|cpf[: ]*\d|cnpj[: ]*\d|chave pix[^.]{0,30}\d/, 'Número de documento ou chave de pagamento'],
    [/(\d+ dias? sem agendar)|stand ?by|aguardando para ver as tomografias|chegaram ao instituto/, 'Lista de pacientes (dado pessoal)'],
    // (\b do JS não entende acento: "amanhã" precisa de lookaround próprio)
    [/(^|[^a-zà-ú])(hoje|amanh[ãa])(?![a-zà-ú]).{0,50}\b(atende|atendendo|atendimentos?|agenda|hor[aá]rios?)\b|no dia \d{1,2}\/\d{1,2}/, 'Agenda de um dia específico'],
    [/advogad|honor[aá]rio|f[oó]rum|\bvaras?\b|processo judicial|escrit[oó]rio de advocacia|andr[eé] lustosa/, 'Sobra do sistema jurídico'],
    [/pend[eê]ncias? a serem resolvidas|precisa verificar o motivo|conferir os provis[oó]rios/, 'Pendência interna da equipe'],
  ];
  for (const [re, reason] of rules) if (re.test(t)) return reason;
  // A assistente virtual (Sophia ou outro nome) nunca é pessoa da equipe.
  if (subcategory === 'team' && /assistente virtual|\bsophia\b|intelig[eê]ncia artificial|\bia\b/.test(t)) {
    return 'A assistente virtual não é da equipe';
  }
  return null;
}

/** Preço/valor/desconto — a clínica configura em Ajustes IA › Valores, não na memória. */
export const ORG_MEMORY_PRICE_RE = /r\$|\d+(?:[.,]\d+)?\s*reais\b|\d+\s*%\s*(de )?desconto|desconto de \d/i;

export function orgMemoryPriceReason(content: string | null | undefined): string | null {
  return ORG_MEMORY_PRICE_RE.test(String(content || '')) ? 'Tem preço — preços ficam em Ajustes IA › Valores' : null;
}

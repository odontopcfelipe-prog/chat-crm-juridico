// Triagem NÃO-PACIENTE (IA): quem escreve no canal de pacientes mas é fornecedor,
// candidato a vaga, parceiro, negociação comercial ou propaganda. A IA não tenta
// vender nem marcar consulta: avisa que vai repassar ao responsável, pausa na
// conversa e avisa os ADMs. Lead.non_patient_category / Lead.non_patient_at guardam
// a classificação (nunca entra na régua de reativação; arquivos que chegarem depois
// são encaminhados aos ADMs pelo webhook da API).
//
// Fonte ÚNICA dos rótulos — worker (ai.processor) e API (webhook) usam estes.

export const NON_PATIENT_CATEGORIES = ['FORNECEDOR', 'CURRICULO', 'PARCERIA', 'NEGOCIO', 'SPAM', 'OUTRO'] as const;
export type NonPatientCategory = (typeof NON_PATIENT_CATEGORIES)[number];

export function isNonPatientCategory(v: unknown): v is NonPatientCategory {
  return typeof v === 'string' && (NON_PATIENT_CATEGORIES as readonly string[]).includes(v);
}

const NON_PATIENT_LABEL: Record<NonPatientCategory, string> = {
  FORNECEDOR: 'Fornecedor / proposta comercial',
  CURRICULO: 'Currículo / vaga de emprego',
  PARCERIA: 'Proposta de parceria',
  NEGOCIO: 'Negociação / contrato / reunião comercial',
  SPAM: 'Propaganda / spam',
  OUTRO: 'Outro assunto (não-paciente)',
};

/** Rótulo legível da categoria ("Currículo / vaga de emprego"). Desconhecida → ela mesma. */
export function nonPatientCategoryLabel(category: string | null | undefined): string {
  const c = String(category || '').trim().toUpperCase();
  return isNonPatientCategory(c) ? NON_PATIENT_LABEL[c] : c || 'Não-paciente';
}

/** Janela em que arquivos que a pessoa manda DEPOIS da triagem vão pros ADMs (72h). */
export const NAO_PACIENTE_ANEXO_JANELA_MS = 72 * 60 * 60 * 1000;

/** Toggle por clínica (Central de Disparos › Equipe › Triagem não-paciente). Só 'true' liga. */
export const naoPacienteTriageKey = (tenantId: string) => `NAO_PACIENTE_TRIAGE_ENABLED_${tenantId}`;

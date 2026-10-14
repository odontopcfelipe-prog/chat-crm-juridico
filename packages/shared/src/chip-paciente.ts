// Chip de WhatsApp pra disparo de PACIENTE/LEAD, escolhido pela FUNÇÃO (out/2026).
//
// Regra única (API e worker):
//  - envio COMERCIAL (lead) → chip COMERCIAL; na falta dele, o CLINICA;
//  - envio de PACIENTE/CLÍNICA → chip CLINICA; na falta dele, o COMERCIAL;
//  - NUNCA o FINANCEIRO (mundo isolado, número de cobrança).
//
// A lista de chips TEM que vir filtrada pelo tenant do envio (tenant_id no where) —
// este helper é puro e não consulta o banco, então não tem como "pular" de clínica.
//
// Por que não "a primeira Instance": linhas órfãs com purpose NULL (ex.: 'whatsapp',
// que nem existe mais na Evolution, e 'Comercial') vêm antes de 't00000000-*' na
// ordenação por nome — e o envio saía por elas e falhava calado.
//
// Clínica LEGADA (nenhum chip COMERCIAL/CLINICA) → { tipo: 'LEGADO' }: o chamador
// mantém o comportamento antigo, mas só com `naoFinanceiros` (mesma ordem da lista).

export type FuncaoChipPaciente = 'COMERCIAL' | 'CLINICA';

export interface ChipLinha {
  name: string;
  purpose?: string | null;
}

export type ChipPacienteEscolhido =
  | { tipo: 'FUNCAO'; instance: string; funcao: FuncaoChipPaciente; usouIrmao: boolean }
  | { tipo: 'LEGADO'; naoFinanceiros: string[]; financeiros: string[] };

const normPurpose = (p?: string | null) => (p || '').trim().toUpperCase();

export function escolherChipPaciente(
  chips: ChipLinha[] | null | undefined,
  funcao: FuncaoChipPaciente,
): ChipPacienteEscolhido {
  const validos = (chips || []).filter((c) => !!c?.name);
  const ordem: FuncaoChipPaciente[] =
    funcao === 'COMERCIAL' ? ['COMERCIAL', 'CLINICA'] : ['CLINICA', 'COMERCIAL'];
  for (const f of ordem) {
    const hit = validos.find((c) => normPurpose(c.purpose) === f);
    if (hit) return { tipo: 'FUNCAO', instance: hit.name, funcao: f, usouIrmao: f !== funcao };
  }
  return {
    tipo: 'LEGADO',
    naoFinanceiros: validos.filter((c) => normPurpose(c.purpose) !== 'FINANCEIRO').map((c) => c.name),
    financeiros: validos.filter((c) => normPurpose(c.purpose) === 'FINANCEIRO').map((c) => c.name),
  };
}

/** Chip pro envio: o da função, senão o 1º não-financeiro do tenant (legado), senão null. */
export function chipPacienteOuLegado(escolha: ChipPacienteEscolhido): string | null {
  return escolha.tipo === 'FUNCAO' ? escolha.instance : escolha.naoFinanceiros[0] ?? null;
}

/** O tenant só tem chip FINANCEIRO: disparo de paciente NÃO sai (melhor pausar que trocar o número). */
export function soTemChipFinanceiro(escolha: ChipPacienteEscolhido): boolean {
  return escolha.tipo === 'LEGADO' && escolha.naoFinanceiros.length === 0 && escolha.financeiros.length > 0;
}

import { LAB_CRM } from '@/app/atendimento/crm/lab-crm-textos';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Laboratório: nome legível de uma etapa guardada no histórico do contato. Procura
 * primeiro no funil da conta (id → nome), depois nos códigos antigos conhecidos; o que
 * sobrar vira texto corrido (sem maiúsculas nem sublinhado) ou um rótulo genérico.
 */
export function rotuloEtapaLab(
  etapa?: string | null,
  etapasDaConta: ReadonlyArray<{ id: string; label: string }> = [],
): string {
  if (!etapa) return '';
  const daConta = etapasDaConta.find((s) => s.id === etapa);
  if (daConta) return daConta.label;
  const conhecido = (LAB_CRM.etapasLegado as Record<string, string>)[etapa.toUpperCase()];
  if (conhecido) return conhecido;
  if (UUID.test(etapa)) return LAB_CRM.etapaSemNome;
  const texto = etapa.replace(/[_-]+/g, ' ').trim().toLowerCase();
  return texto ? texto.charAt(0).toUpperCase() + texto.slice(1) : LAB_CRM.etapaSemNome;
}

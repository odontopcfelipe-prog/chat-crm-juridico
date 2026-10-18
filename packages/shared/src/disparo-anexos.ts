// Anexos (fotos/áudio) nos disparos AUTOMÁTICOS da Central de Disparos — regras puras.
//
// O ADM anexa até DISPARO_ANEXO_MAX arquivos no editor de um card; quando o motor daquele
// disparo manda o texto e ele SAI, manda os anexos logo depois (fotos, depois áudio). O
// texto não muda; falha num anexo nunca desfaz nem repete o texto. Os arquivos ficam no
// banco (tabela DisparoAnexo) porque a API e o worker enviam e só a API enxerga o disco.
import { COMERCIAL_AGENDA_IDS, comercialLembreteIdFor } from './comercial-agenda';
import { RETORNO_DISPARO_IDS } from './retorno-disparos';
import { campanhaMidiaTipo, type CampanhaMidiaTipo } from './campanha-manual';

/** Cards que aceitam anexo (os que falam com paciente/lead e já foram ligados ao envio). */
export const DISPARO_ANEXO_IDS: string[] = [
  // Agendamento (clínica)
  'confirmacao', 'confirmacao_48h', 'lembrete_1dia', 'lembrete_1h', 'lembrete_15min', 'reagendamento',
  // Ortodontia
  'confirmacao_orto_imediata', 'confirmacao_orto', 'lembrete_orto_1h',
  // Agendamento do lead (chip Comercial)
  ...COMERCIAL_AGENDA_IDS,
  // Relacionamento e manutenção
  'aniversario_classica', 'aniversario_desejo', 'aniversario_presente', 'recall_preventivo',
  ...RETORNO_DISPARO_IDS,
];

export function isDisparoComAnexo(id: string | null | undefined): boolean {
  return !!id && DISPARO_ANEXO_IDS.includes(id);
}

export const DISPARO_ANEXO_MAX = 2;
/** Guardado no banco: menor que na campanha manual. */
export const DISPARO_ANEXO_LIMITE_BYTES: Record<CampanhaMidiaTipo, number> = {
  image: 3 * 1024 * 1024,
  audio: 5 * 1024 * 1024,
};
export const disparoAnexoTipo = campanhaMidiaTipo;

/** Card da Central do lembrete clínico pela antecedência (mesmas faixas do EventReminder). */
export function lembreteClinicoIdFor(minutesBefore: number): string {
  if (minutesBefore >= 2880) return 'confirmacao_48h';
  if (minutesBefore >= 1440) return 'lembrete_1dia';
  if (minutesBefore >= 60) return 'lembrete_1h';
  return 'lembrete_15min';
}

/** Card do lembrete pela antecedência, na versão clínica ou na do lead (chip Comercial). */
export function lembreteIdFor(minutesBefore: number, comercial: boolean): string {
  return comercial ? comercialLembreteIdFor(minutesBefore) : lembreteClinicoIdFor(minutesBefore);
}

/** Ordem de envio depois do texto: fotos primeiro, áudio por último (mensagem de voz). */
export function ordenarAnexos<T extends { kind: string; position: number }>(anexos: T[]): T[] {
  return [...anexos].sort(
    (a, b) => Number(a.kind === 'audio') - Number(b.kind === 'audio') || a.position - b.position,
  );
}

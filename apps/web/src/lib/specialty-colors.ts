/**
 * Paleta de cores estavel pra especialidades odontologicas.
 *
 * Hash do ID/nome -> indice 0-7 garante que a MESMA especialidade SEMPRE
 * receba a mesma cor (consistencia entre sessoes/telas). Usado em:
 *  - Tabela de Precos (settings/procedures) — cabecalho colorido por grupo
 *  - Orcamento — borda esquerda colorida em cada item
 *  - Modal Adicionar procedimento — pilula colorida
 *  - (futuro) Dashboard, agenda, relatorios
 *
 * Decisao de design: cores tinted (8% alpha) pra fundo + cor solida pra borda.
 * Mantem leitura facil em dark mode E light mode.
 */

export interface SpecialtyColor {
  bar: string;
  tint: string;
}

export const SPECIALTY_COLORS: SpecialtyColor[] = [
  { bar: '#a855f7', tint: 'rgba(168, 85, 247, 0.08)' }, // roxo (Cirurgia)
  { bar: '#3b82f6', tint: 'rgba(59, 130, 246, 0.08)' }, // azul (Clinica Geral)
  { bar: '#22c55e', tint: 'rgba(34, 197, 94, 0.08)' },  // verde (Profilaxia)
  { bar: '#f97316', tint: 'rgba(249, 115, 22, 0.08)' }, // laranja (Endodontia)
  { bar: '#ec4899', tint: 'rgba(236, 72, 153, 0.08)' }, // rosa (Estetica)
  { bar: '#14b8a6', tint: 'rgba(20, 184, 166, 0.08)' }, // teal (Implantes)
  { bar: '#eab308', tint: 'rgba(234, 179, 8, 0.08)' },  // amarelo (Ortodontia)
  { bar: '#06b6d4', tint: 'rgba(6, 182, 212, 0.08)' },  // ciano (Periodontia)
];

const NEUTRAL: SpecialtyColor = {
  bar: '#94a3b8',
  tint: 'rgba(148, 163, 184, 0.06)',
};

/**
 * Retorna cor estavel pra uma especialidade dada sua chave (id ou nome).
 * - key '__none__' ou null/undefined → cinza neutro
 * - qualquer outra chave → uma das 8 cores via hash
 */
export function colorForSpecialty(key: string | null | undefined): SpecialtyColor {
  if (!key || key === '__none__') return NEUTRAL;
  let hash = 0;
  for (let i = 0; i < key.length; i++) {
    hash = (hash * 31 + key.charCodeAt(i)) | 0;
  }
  return SPECIALTY_COLORS[Math.abs(hash) % SPECIALTY_COLORS.length];
}

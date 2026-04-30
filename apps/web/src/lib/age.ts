/**
 * Helpers de idade do paciente — calculo + formatacao.
 *
 * Uso: import { calculateAge, formatBirthDateWithAge } from '@/lib/age';
 *
 * Centraliza pra evitar inconsistencia (anteriormente cada tela calculava
 * de um jeito diferente — alguns usavam apenas year diff, outros consideravam
 * mes/dia, gerando "1 ano de diferenca" entre paginas).
 */

/**
 * Calcula idade em anos completos a partir de uma data de nascimento.
 * Retorna null se a data for invalida ou ausente.
 *
 * Considera mes/dia — paciente nascido em 30/04/1975 vira 51 anos APENAS
 * apos 30/04/2026 (nao no dia 01/01).
 */
export function calculateAge(birthDate: string | null | undefined): number | null {
  if (!birthDate) return null;
  const b = new Date(birthDate);
  if (isNaN(b.getTime())) return null;
  const now = new Date();
  let age = now.getFullYear() - b.getFullYear();
  const m = now.getMonth() - b.getMonth();
  if (m < 0 || (m === 0 && now.getDate() < b.getDate())) age--;
  return age;
}

/**
 * Formata data de nascimento como "DD/MM/YYYY (X anos)".
 * Retorna string vazia se data invalida.
 */
export function formatBirthDateWithAge(birthDate: string | null | undefined): string {
  if (!birthDate) return '';
  const d = birthDate.slice(0, 10);
  const parts = d.split('-');
  if (parts.length !== 3) return d;
  const [y, m, day] = parts;
  const fmt = `${day}/${m}/${y}`;
  const age = calculateAge(birthDate);
  return age !== null ? `${fmt} (${age} anos)` : fmt;
}

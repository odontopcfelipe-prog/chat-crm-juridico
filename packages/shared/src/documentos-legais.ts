/**
 * Versão em vigor dos termos de uso e da política de privacidade: a data
 * (AAAA-MM-DD) da última mudança do texto. As páginas /termos e /privacidade
 * mostram esta data, e o aceite do cadastro grava estas versões. Ao mudar um dos
 * textos (apps/web/src/components/legal), mude a data dele aqui.
 */
export const VERSAO_TERMOS_DE_USO = '2026-11-04';
export const VERSAO_POLITICA_DE_PRIVACIDADE = '2026-11-04';

const MESES = [
  'janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho',
  'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro',
] as const;

/** '2026-11-02' → '2 de novembro de 2026' (sem fuso: lê só o texto da data). */
export function versaoPorExtenso(versao: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(versao);
  const mes = m ? MESES[Number(m[2]) - 1] : undefined;
  if (!m || !mes) return versao;
  return `${Number(m[3])} de ${mes} de ${m[1]}`;
}

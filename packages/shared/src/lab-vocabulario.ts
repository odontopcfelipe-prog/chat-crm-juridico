/**
 * Laboratório de prótese — o detector de vocabulário de clínica dos envios ao cliente.
 *
 * Mora no shared porque a API (confirmação, textos da Central) e o worker (régua de
 * cobrança) decidem com a mesma lista: texto salvo que passa aqui com palavra de clínica
 * não vai ao cliente do laboratório, sai o padrão do laboratório.
 *
 * Funções puras. A clínica nunca passa por aqui: quem chama só usa depois de saber que a
 * conta é laboratório.
 */

// Palavras de clínica (sem acento, minúsculas, palavra inteira). "clínica" e
// "dentista" ficam de fora de propósito: são os clientes do laboratório.
const VOCABULARIO_DE_CLINICA = [
  'pacientes?',
  'consultas?',
  'prontuarios?',
  'anamneses?',
  'odontogramas?',
  'tratamentos?',
  'odontologic[oa]s?',
  'tcle',
  'banco passos',
  'instituto odonto passos',
];

// Frases do laboratório que contêm uma palavra da lista e são permitidas.
const PERMITIDAS = ['pacientes? do caso'];

const palavra = (padrao: string, flags = '') =>
  new RegExp(`(?<![\\p{L}\\p{N}])(?:${padrao})(?![\\p{L}\\p{N}])`, `u${flags}`);

const RE_VOCABULARIO = palavra(VOCABULARIO_DE_CLINICA.join('|'));
const RE_PERMITIDAS = PERMITIDAS.map((p) => palavra(p, 'g'));

function normalizar(texto: string): string {
  return texto
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

/** O texto tem palavra de clínica (paciente, consulta, tratamento, odontológico…)? */
export function temVocabularioDeClinica(texto: string | null | undefined): boolean {
  if (!texto) return false;
  let t = normalizar(texto);
  for (const re of RE_PERMITIDAS) t = t.replace(re, ' ');
  return RE_VOCABULARIO.test(t);
}

/** Tira as variáveis de template ({{nome}} e {nome}): sobra só o texto fixo. */
export function semVariaveis(template: string | null | undefined): string {
  return (template || '').replace(/\{\{\s*\w+\s*\}\}/g, ' ').replace(/\{\s*\w+\s*\}/g, ' ');
}

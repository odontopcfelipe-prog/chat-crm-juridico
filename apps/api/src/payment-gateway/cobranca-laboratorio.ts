/**
 * Laboratório de prótese — o texto de cobrança que chega ao CLIENTE do laboratório.
 *
 * O laboratório usa os mesmos fluxos de cobrança da clínica (proposta, venda rápida,
 * boleto, carnê, caixa) e recebe do mesmo jeito: baixa da cobrança e receita no caixa.
 * O cliente dele é um dentista ou uma clínica, então o texto que volta para ele
 * (descrição da cobrança na confirmação e no cancelamento, e-mails automáticos) não
 * pode falar de paciente, consulta ou tratamento odontológico. O mesmo vale para a
 * descrição que vai ao Asaas na emissão (boleto, carnê, PIX, cartão).
 *
 * Funções puras (sem Nest, sem Prisma). A clínica nunca passa por aqui: quem chama
 * só usa estas funções depois de saber que a conta é laboratório.
 */

/** Nome que entra no lugar de {clinica} quando a conta de laboratório não tem nome. */
export const NOME_PADRAO_DO_LABORATORIO = 'o laboratório';

/** Texto neutro que substitui "plano de tratamento (odontológico)" na descrição. */
export const TRABALHO_DO_LABORATORIO = 'Trabalho de prótese';

/**
 * Começo da descrição que o laboratório manda ao Asaas quando emite a cobrança (o
 * cliente lê esse texto no boleto e na fatura). O resto da descrição segue o formato
 * da clínica, " — <nome> (<detalhe>) [plan:<id>]": quem chama mantém a tag
 * [plan:<id>] no fim, porque é ela que liga a cobrança ao plano. "Entrada" e
 * "Parcelado" continuam no começo de propósito: a emissão do parcelamento com entrada
 * procura essas palavras na descrição para não emitir a mesma parte duas vezes. São
 * os mesmos textos que a confirmação de pagamento mostra ao cliente do laboratório.
 */
export const DESCRICAO_DE_EMISSAO_DO_LABORATORIO = {
  /** Cobrança do trabalho inteiro (parcelada no boleto/cartão ou à vista). */
  trabalho: TRABALHO_DO_LABORATORIO,
  /** Boleto da entrada do parcelamento com entrada. */
  entrada: 'Entrada',
  /** Carnê das parcelas do parcelamento com entrada. */
  parcelado: 'Parcelado',
} as const;

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

/**
 * Descrição da cobrança (já sem as tags internas) como o cliente do laboratório lê.
 * "Plano de tratamento odontológico — X (3x)" vira "Trabalho de prótese — X (3x)";
 * "Entrada Financiamento Banco PASSOS — X" vira "Entrada — X". Se ainda sobrar
 * palavra de clínica, a descrição sai vazia (a mensagem fica sem os parênteses).
 */
export function descricaoParaClienteDoLaboratorio(descricao: string | null | undefined): string {
  let d = (descricao || '').trim();
  if (!d) return '';
  d = d
    .replace(/\s*financiamento\s+banco\s+passos/giu, '')
    .replace(/planos?\s+de\s+tratamentos?(?:\s+odontol[oó]gic[oa]s?)?/giu, TRABALHO_DO_LABORATORIO)
    .replace(/tratamentos?\s+odontol[oó]gic[oa]s?/giu, TRABALHO_DO_LABORATORIO)
    .replace(/\s{2,}/g, ' ')
    .trim();
  return temVocabularioDeClinica(d) ? '' : d;
}

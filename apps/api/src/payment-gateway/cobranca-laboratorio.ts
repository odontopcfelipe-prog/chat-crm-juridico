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

// ─── F5: caixa, venda de balcão e envio do boleto do mês ─────────────────────
// Os nomes não começam com LAB_ de propósito: este arquivo não é marcado pela trava
// de textos (scripts/ci/check-pick-literals.mjs) e os textos são cobertos pelo spec
// cobranca.laboratorio.spec.ts (temVocabularioDeClinica).

/** Nome que entra quando o cadastro do cliente do laboratório não tem nome. */
export const NOME_PADRAO_DO_CLIENTE = 'Cliente';

/** Começo da receita no caixa quando o laboratório recebe na hora (balcão, maquineta, PIX). */
export const RECEBIDO_NO_LABORATORIO = 'Recebido no laboratório';

/**
 * Detalhe entre parênteses da cobrança local do balcão no laboratório (o mesmo
 * desenho do texto da clínica):
 *   - cartão que o Financeiro confirma depois: "cartão 3x · a receber";
 *   - só cartão, passado na hora: "cartão 3x na maquineta · recebido no laboratório";
 *   - várias formas: "recebido no laboratório · 2 formas";
 *   - o resto: "recebido no laboratório".
 * `nx` chega pronto (" 3x" ou ""), igual ao da clínica.
 */
export function rotuloDoBalcaoDoLaboratorio(p: { receiveNow: boolean; soCartao: boolean; nx: string; formas: number }): string {
  const recebido = RECEBIDO_NO_LABORATORIO.toLowerCase();
  if (!p.receiveNow) return `cartão${p.nx} · a receber`;
  if (p.soCartao) return `cartão${p.nx} na maquineta · ${recebido}`;
  if (p.formas > 1) return `${recebido} · ${p.formas} formas`;
  return recebido;
}

/**
 * Descrição da RECEITA no caixa do laboratório (Caixa e Entradas):
 * "Recebido no laboratório — <cliente> · <descrição da cobrança> · <forma><parcelas>".
 * Recebimento online (webhook do Asaas) continua "Recebimento — …". A descrição da
 * cobrança passa por descricaoParaClienteDoLaboratorio: "Plano de tratamento" vira
 * "Trabalho de prótese" e, se sobrar palavra de clínica, ela sai da receita.
 */
export function descricaoDaReceitaDoLaboratorio(p: {
  inClinic: boolean;
  nome: string;
  descricao: string;
  parcelaSuffix: string;
  forma?: string;
}): string {
  const descricao = descricaoParaClienteDoLaboratorio(p.descricao);
  return `${p.inClinic ? RECEBIDO_NO_LABORATORIO : 'Recebimento'} — ${p.nome}${descricao ? ` · ${descricao}` : ''}${p.forma ? ` · ${p.forma}` : ''}${p.parcelaSuffix}`;
}

/** Observação da RECEITA no caixa do laboratório. */
export const NOTAS_DA_RECEITA_DO_LABORATORIO = Object.freeze({
  /** Recebido na hora (uma forma). */
  caixa: 'Venda recebida no laboratório (fechamento de caixa)',
  /** Recebido na hora em várias formas (uma receita por forma). */
  split: 'Venda recebida no laboratório — pagamento dividido em várias formas (fechamento de caixa)',
});

/** Respostas e nome do "Enviar boleto do mês" no laboratório. */
export const ENVIO_DE_BOLETO_DO_LABORATORIO = Object.freeze({
  nomePadrao: NOME_PADRAO_DO_CLIENTE,
  semTelefone: 'Cliente sem telefone cadastrado.',
  enviado: (phone: string) => `Boleto enviado ao cliente (${phone}).`,
});

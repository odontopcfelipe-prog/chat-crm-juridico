/**
 * Pagamento da venda rápida (recebido no balcão): regras PURAS, sem React e sem import,
 * para apps/api/src/__guards__/venda-rapida-pagamento.spec.ts carregar este arquivo direto.
 *
 * Uma pergunta por vez, como num checkout de loja: escolhe a forma, responde o detalhe
 * dela (onde foi o PIX, quantas parcelas) e, se dividir, digita a parte da primeira forma;
 * o resto vai inteiro para a segunda. Até 2 formas (2 cartões são 2 formas). Nada vem
 * marcado de início: gravar "dinheiro" por reflexo é o erro que isso evita.
 *
 * Valores em CENTAVOS inteiros; só viram R$ na saída (paraPayments).
 */

export type Forma = 'DINHEIRO' | 'PIX' | 'DEBITO' | 'CREDITO';
export type LocalPix = 'CHAVE' | 'MAQUINETA';

export interface Escolha {
  forma: Forma | null;
  localPix: LocalPix | null;
  parcelas: number | null;
}

export interface Linha extends Escolha {
  forma: Forma;
  centavos: number;
}

export interface EstadoPagamento {
  duasFormas: boolean;
  /** Texto digitado da parte da primeira forma ("500,00"). */
  valorPrimeira: string;
  /** Primeira forma já fechada: o valor dela nunca muda sozinho. */
  primeira: Linha | null;
  /** A forma que está sendo escolhida agora. */
  atual: Escolha;
}

export type Pendencia = 'VALOR' | 'FORMA' | 'LOCAL_PIX' | 'PARCELAS';

export interface Analise {
  /** O que seria gravado agora (só o que já está completo). */
  linhas: Linha[];
  /** Quanto a forma que está sendo escolhida vai receber. */
  baseCentavos: number;
  faltaCentavos: number;
  pendencia: Pendencia | null;
  acao: 'CONTINUAR' | 'FINALIZAR' | null;
}

export const MAX_PARCELAS = 12;

export const ESCOLHA_VAZIA: Escolha = Object.freeze({ forma: null, localPix: null, parcelas: null });

export const PAGAMENTO_VAZIO: EstadoPagamento = Object.freeze({
  duasFormas: false,
  valorPrimeira: '',
  primeira: null,
  atual: ESCOLHA_VAZIA,
});

export const TEXTO_PENDENCIA: Readonly<Record<Pendencia, string>> = Object.freeze({
  VALOR: 'Digite o valor da primeira forma',
  FORMA: 'Escolha a forma de pagamento',
  LOCAL_PIX: 'Escolha onde foi o PIX',
  PARCELAS: 'Escolha as parcelas',
});

export function fmtCentavos(centavos: number): string {
  return (centavos / 100).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/**
 * Texto em pt-BR → centavos. O ÚLTIMO separador é o decimal: "1.800,00" = 1800, "350.50" =
 * 350,50, "1.200" = 1200 (ponto com 3 casas é milhar). Texto inválido ou com mais de 2
 * casas devolve null: arredondar calado mudaria o valor que a recepção digitou.
 */
export function paraCentavos(texto: string): number | null {
  const limpo = String(texto ?? '').replace(/R\$|\s/g, '');
  if (!/^\d[\d.,]*$/.test(limpo)) return null;
  const virgula = limpo.lastIndexOf(',');
  const ponto = limpo.lastIndexOf('.');
  let inteiro = limpo;
  let decimal = '';
  if (virgula > ponto) {
    inteiro = limpo.slice(0, virgula);
    decimal = limpo.slice(virgula + 1);
  } else if (ponto > virgula && limpo.length - ponto - 1 <= 2) {
    inteiro = limpo.slice(0, ponto);
    decimal = limpo.slice(ponto + 1);
  }
  // Milhar só em grupos de 3: "1,2,3" e "1.2,50" são erro de digitação, não R$ 12,30.
  if (!/^(\d+|\d{1,3}([.,]\d{3})+)$/.test(inteiro) || decimal.length > 2 || !/^\d*$/.test(decimal)) return null;
  const centavos = Number(inteiro.replace(/[.,]/g, '')) * 100 + Number(decimal.padEnd(2, '0') || '0');
  return Number.isSafeInteger(centavos) ? centavos : null;
}

function pendenciaDa(e: Escolha): Pendencia | null {
  if (!e.forma) return 'FORMA';
  if (e.forma === 'PIX' && !e.localPix) return 'LOCAL_PIX';
  if (e.forma === 'CREDITO' && !(Number(e.parcelas) >= 1 && Number(e.parcelas) <= MAX_PARCELAS)) return 'PARCELAS';
  return null;
}

function linhaDa(e: Escolha, centavos: number): Linha {
  return { forma: e.forma as Forma, localPix: e.localPix, parcelas: e.parcelas, centavos };
}

export function analisar(p: EstadoPagamento, totalCentavos: number): Analise {
  const pendenciaAtual = pendenciaDa(p.atual);
  const fechar = (linhas: Linha[], baseCentavos: number, pendencia: Pendencia | null, acao: Analise['acao']): Analise => ({
    linhas,
    baseCentavos,
    faltaCentavos: totalCentavos - linhas.reduce((soma, l) => soma + l.centavos, 0),
    pendencia,
    acao: pendencia ? null : acao,
  });

  if (p.primeira) {
    const resto = totalCentavos - p.primeira.centavos;
    if (resto <= 0) return fechar([p.primeira], 0, 'VALOR', null);
    const linhas = pendenciaAtual ? [p.primeira] : [p.primeira, linhaDa(p.atual, resto)];
    return fechar(linhas, resto, pendenciaAtual, 'FINALIZAR');
  }
  if (p.duasFormas) {
    const parte = paraCentavos(p.valorPrimeira);
    const valida = parte !== null && parte > 0 && parte < totalCentavos;
    if (!valida) return fechar([], 0, 'VALOR', null);
    return fechar(pendenciaAtual ? [] : [linhaDa(p.atual, parte as number)], parte as number, pendenciaAtual, 'CONTINUAR');
  }
  if (totalCentavos <= 0) return fechar([], 0, 'FORMA', null);
  return fechar(pendenciaAtual ? [] : [linhaDa(p.atual, totalCentavos)], totalCentavos, pendenciaAtual, 'FINALIZAR');
}

/** Tocar de novo na forma já escolhida não apaga o detalhe que foi respondido. */
export function escolherForma(p: EstadoPagamento, forma: Forma): EstadoPagamento {
  if (p.atual.forma === forma) return p;
  return { ...p, atual: { ...ESCOLHA_VAZIA, forma } };
}

export function ligarDuasFormas(): EstadoPagamento {
  return { ...PAGAMENTO_VAZIO, duasFormas: true };
}

/** Fecha a primeira forma com o valor digitado; a próxima pergunta é a do resto. */
export function fecharPrimeira(p: EstadoPagamento, totalCentavos: number): EstadoPagamento {
  const a = analisar(p, totalCentavos);
  if (a.acao !== 'CONTINUAR') return p;
  return { ...p, primeira: a.linhas[0], atual: ESCOLHA_VAZIA };
}

/** Reabre a primeira forma como estava; o que foi escolhido para o resto sai. */
export function trocarPrimeira(p: EstadoPagamento): EstadoPagamento {
  if (!p.primeira) return p;
  const { forma, localPix, parcelas, centavos } = p.primeira;
  return { ...p, primeira: null, valorPrimeira: fmtCentavos(centavos), atual: { forma, localPix, parcelas } };
}

/** Duas formas de dinheiro não existem: é a mesma gaveta. PIX e cartão podem repetir. */
export function formasDaSegunda(p: EstadoPagamento, formas: Forma[]): Forma[] {
  return p.primeira?.forma === 'DINHEIRO' ? formas.filter((f) => f !== 'DINHEIRO') : formas;
}

/**
 * Linha → payment do POST /venda-rapida/balcao (VendaBalcaoPaymentDto). O servidor recusa
 * campo a mais: nada de installments no débito, no PIX ou no dinheiro.
 */
export function paraPayments(linhas: Linha[]): Array<{ method: string; value: number; installments?: number; debit?: boolean }> {
  return linhas.map((l) => {
    const value = l.centavos / 100;
    if (l.forma === 'DINHEIRO') return { method: 'DINHEIRO', value };
    if (l.forma === 'PIX') return { method: l.localPix === 'MAQUINETA' ? 'PIX_MAQUININHA' : 'PIX', value };
    if (l.forma === 'DEBITO') return { method: 'CARTAO', value, debit: true };
    return { method: 'CARTAO', value, installments: Number(l.parcelas) };
  });
}

export function rotuloLinha(l: Pick<Linha, 'forma' | 'localPix' | 'parcelas'>): string {
  if (l.forma === 'DINHEIRO') return 'Dinheiro';
  if (l.forma === 'PIX') return l.localPix === 'MAQUINETA' ? 'PIX na maquineta' : 'PIX na chave';
  if (l.forma === 'DEBITO') return 'Débito';
  return Number(l.parcelas) === 1 ? 'Crédito à vista' : `Crédito ${l.parcelas}x`;
}

/**
 * Onde o dinheiro cai, com o mapeamento REAL do servidor (caixa.service): o PIX na
 * maquineta cai no Banco junto com o PIX da chave. Nunca prometer Maquininha para PIX.
 */
export function destinoDaForma(forma: Forma): string {
  if (forma === 'DINHEIRO') return 'Caixa';
  if (forma === 'PIX') return 'Banco';
  return 'Maquininha';
}

/** O botão diz o que vai gravar: "Finalizar · R$ 450,00 em Débito" ou "· 2 formas". */
export function textoFinalizar(linhas: Linha[]): string {
  if (linhas.length === 1) return `Finalizar · R$ ${fmtCentavos(linhas[0].centavos)} em ${rotuloLinha(linhas[0])}`;
  return `Finalizar · ${linhas.length} formas`;
}

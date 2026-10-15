/**
 * Carnê montado AQUI (plano B do envio de boletos pós-venda).
 *
 * O plano A é o carnê que o próprio Asaas gera (GET /installments/{id}/paymentBook).
 * Quando ele falha (tempo esgotado, parcelas que não são de um parcelamento Asaas…),
 * o envio caía num TEXTO com 24 links — e o dono quer os boletos em PDF ("link gera
 * desconfiança"). Aqui baixamos o PDF de cada parcela (bankSlipUrl, o mesmo PDF que o
 * paciente abriria) e juntamos tudo num único PDF.
 *
 * pdf-lib: documento NOVO + copyPages + useObjectStreams:false (mesma receita do
 * contrato — carregar um PDF de fora como BASE corrompe e o Edge abre "0 páginas").
 */
import { PDFDocument } from 'pdf-lib';

export type BaixarPdf = (url: string) => Promise<Buffer>;

export interface CarneLocal {
  pdf: Buffer;
  /** Quantas parcelas entraram no PDF. */
  incluidas: number;
  /** Índices (0-based, na ordem recebida) das parcelas que não deu pra baixar/ler. */
  faltando: number[];
}

const ehPdf = (b: Buffer) => b.length > 4 && b.subarray(0, 5).toString('latin1') === '%PDF-';

/**
 * Junta os PDFs das parcelas (na ordem) num único PDF. Parcela que falhar fica em
 * `faltando` (quem chama decide o que fazer com ela). Se NENHUMA entrar, lança.
 */
export async function montarCarneLocal(
  urls: (string | null | undefined)[],
  baixar: BaixarPdf,
  /** Asaas fora do ar: depois de N falhas SEGUIDAS para de tentar (o resto fica em
   *  `faltando`) — senão 24 downloads × timeout seguravam o cron por minutos. */
  maxFalhasSeguidas = 3,
): Promise<CarneLocal> {
  const carne = await PDFDocument.create();
  const faltando: number[] = [];
  let incluidas = 0;
  let falhasSeguidas = 0;
  for (let i = 0; i < urls.length; i++) {
    const url = urls[i];
    if (!url) { faltando.push(i); continue; }
    if (falhasSeguidas >= maxFalhasSeguidas) { faltando.push(i); continue; }
    try {
      const bytes = await baixar(url);
      if (!ehPdf(bytes)) throw new Error('resposta não é PDF');
      // PDF criptografado não é copiado (sairia ilegível) → vira `faltando` (vai por link).
      const src = await PDFDocument.load(bytes);
      const pages = await carne.copyPages(src, src.getPageIndices());
      for (const p of pages) carne.addPage(p);
      incluidas++;
      falhasSeguidas = 0;
    } catch {
      faltando.push(i);
      falhasSeguidas++;
    }
  }
  if (incluidas === 0) throw new Error('nenhuma parcela deu pra baixar/ler');
  const pdf = Buffer.from(await carne.save({ useObjectStreams: false }));
  return { pdf, incluidas, faltando };
}

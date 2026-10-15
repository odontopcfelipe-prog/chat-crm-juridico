import { PDFDocument } from 'pdf-lib';
import { montarCarneLocal } from './carne-local';

async function pdfDeUmaPagina(texto: string): Promise<Buffer> {
  const d = await PDFDocument.create();
  const p = d.addPage([200, 100]);
  p.drawText(texto, { x: 10, y: 50, size: 12 });
  return Buffer.from(await d.save());
}

describe('carnê montado localmente (plano B do envio de boletos)', () => {
  it('caso Neilza: junta os PDFs das parcelas na ordem, num PDF só', async () => {
    const fontes: Record<string, Buffer> = {};
    for (let i = 1; i <= 24; i++) fontes[`https://www.asaas.com/b/pdf/p${i}`] = await pdfDeUmaPagina(`Parcela ${i}`);
    const urls = Object.keys(fontes);
    const r = await montarCarneLocal(urls, async (u) => fontes[u]);
    expect(r.incluidas).toBe(24);
    expect(r.faltando).toEqual([]);
    const lido = await PDFDocument.load(r.pdf); // abre de novo = não corrompeu
    expect(lido.getPageCount()).toBe(24);
    expect(r.pdf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
  });

  it('parcela que falha (erro, HTML no lugar do PDF, sem URL) fica de fora e é reportada', async () => {
    const ok = await pdfDeUmaPagina('ok');
    const r = await montarCarneLocal(
      ['a', null, 'b', 'c'],
      async (u) => {
        if (u === 'a') return ok;
        if (u === 'b') return Buffer.from('<html>erro</html>');
        throw new Error('timeout');
      },
    );
    expect(r.incluidas).toBe(1);
    expect(r.faltando).toEqual([1, 2, 3]);
  });

  it('nenhuma parcela baixou → lança (quem chama cai no próximo plano)', async () => {
    await expect(montarCarneLocal(['a', 'b'], async () => { throw new Error('fora do ar'); })).rejects.toThrow();
  });
});

describe('carnê local — Asaas fora do ar', () => {
  it('para de baixar após 3 falhas seguidas (não segura o cron)', async () => {
    let chamadas = 0;
    await expect(
      montarCarneLocal(Array.from({ length: 24 }, (_, i) => `u${i}`), async () => { chamadas++; throw new Error('timeout'); }),
    ).rejects.toThrow();
    expect(chamadas).toBe(3);
  });
});

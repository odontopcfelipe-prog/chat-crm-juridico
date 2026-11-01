/**
 * F6 do laboratório — PDF do orçamento de trabalho.
 *
 * Mesmo layout do PDF da clínica (QuotePdfService.renderPdf): A4, margens 60,
 * tabela, totais, caixa da proposta de pagamento, observações, anexos, quadro de
 * assinatura e rodapé. O que muda é o conteúdo:
 *   - cabeçalho com a logo e o nome da PRÓPRIA conta (sem nome: o padrão de
 *     LAB_ORCAMENTO_PDF), a linha de contato e o CNPJ da conta;
 *   - bloco CLIENTE (o cliente do laboratório pode ser um dentista ou uma clínica):
 *     nome, CPF/CNPJ formatado, telefone, e-mail e endereço;
 *   - tabela de SERVIÇOS: Serviço | Elemento | Qtd | Unitário | Total;
 *   - número = quote_number (sem número, o id curto);
 *   - a caixa da proposta faz a MESMA conta da clínica (ofertaDePagamentoDoLaboratorio).
 *
 * Função pura (sem provider Nest, sem DI): QuotePdfService.generatePdf chama daqui
 * só para conta de laboratório. Todo texto que vai para o papel vem de
 * LAB_ORCAMENTO_PDF (lab-orcamento-textos.ts).
 *
 * A logo só é embutida quando é imagem PNG/JPG em data URI (como a Identidade
 * grava). Link http(s) ou logo inválida = PDF sem logo, com log: o PDF não baixa
 * nada na hora do envio.
 */
import { Logger } from '@nestjs/common';
import PDFDocument from 'pdfkit';
import { formatCpfCnpj, tipoDoDocumento } from '@crm/shared';
import { normalizeTenantLogo } from '../tenants/tenant-logo.util';
import { LAB_ORCAMENTO_PDF } from './lab-orcamento-textos';

/** Dados da conta (Tenant) que o cabeçalho do PDF usa. */
export type ContaDoPdf = {
  name: string | null;
  logo_url: string | null;
  phone: string | null;
  email: string | null;
  cpf_cnpj: string | null;
  city: string | null;
  state: string | null;
};

const logger = new Logger('QuotePdfLaboratorio');

const LOGO_W = 120;
const LOGO_H = 50;

function formatBRL(v: unknown): string {
  return Number(v).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

function dataBR(d: unknown): string {
  return new Date(d as any).toLocaleDateString('pt-BR');
}

/** Número do orçamento para o papel: quote_number; sem número (0/nulo), o id curto. */
export function numeroDoOrcamento(quote: { id: string; quote_number?: number | null }): string {
  const n = Number(quote.quote_number);
  return Number.isFinite(n) && n > 0 ? String(n) : String(quote.id).slice(0, 8).toUpperCase();
}

/** Buffer da logo da conta, só para PNG/JPG em data URI; qualquer outra coisa = null (com log). */
export function logoDaConta(raw: unknown): Buffer | null {
  let logo: string | null;
  try {
    logo = normalizeTenantLogo(raw);
  } catch (e) {
    logger.warn(`[LAB-PDF] logo da conta inválida, PDF sai sem logo: ${(e as Error)?.message ?? e}`);
    return null;
  }
  if (!logo) return null;
  const m = logo.match(/^data:image\/(png|jpeg);base64,([A-Za-z0-9+/]+={0,2})$/);
  if (!m) {
    logger.log('[LAB-PDF] logo da conta é um link: o PDF não baixa imagem, sai sem logo');
    return null;
  }
  return Buffer.from(m[2], 'base64');
}

/**
 * Caixa "proposta de pagamento" do laboratório: a MESMA conta de
 * QuotePdfService.buildPaymentOfferText (mesmas taxas, entradas e arredondamentos),
 * com os textos de LAB_ORCAMENTO_PDF.oferta.
 */
export function ofertaDePagamentoDoLaboratorio(
  total: number,
  paymentKey: string,
  downPayment: number,
  avistaDiscountPct: number = 0,
): { headline: string; lines: string[] } | null {
  const T = LAB_ORCAMENTO_PDF.oferta;
  const brl = (n: number) => formatBRL(n);

  if (paymentKey === 'pix') {
    if (avistaDiscountPct > 0) {
      const discount = total * (avistaDiscountPct / 100);
      const finalValue = total - discount;
      return {
        headline: T.pixHeadline(brl(finalValue)),
        lines: [T.pixDesconto(String(avistaDiscountPct), brl(discount)), T.valorOriginal(brl(total))],
      };
    }
    return { headline: T.pixHeadline(brl(total)), lines: [] };
  }

  if (paymentKey === 'boleto-avista') {
    if (avistaDiscountPct > 0) {
      const discount = total * (avistaDiscountPct / 100);
      const finalValue = total - discount;
      return {
        headline: T.boletoAvistaHeadline(brl(finalValue)),
        lines: [T.boletoAvistaDesconto(String(avistaDiscountPct), brl(discount)), T.valorOriginal(brl(total))],
      };
    }
    return { headline: T.boletoAvistaHeadline(brl(total)), lines: [T.boletoAvistaSemDesconto] };
  }

  const cartaoMatch = paymentKey.match(/^cartao-(\d+)x$/);
  if (cartaoMatch) {
    const n = Number(cartaoMatch[1]);
    const TAXA_CARTAO = 3.59 / 100;
    const hasInterest = n > 6;
    const downValue = Math.min(downPayment, total - 0.01);
    const financed = total - downValue;
    let installmentValue: number;
    let extraInterest = 0;
    if (hasInterest) {
      installmentValue = financed * TAXA_CARTAO / (1 - Math.pow(1 + TAXA_CARTAO, -n));
      extraInterest = installmentValue * n - financed;
    } else {
      installmentValue = financed / n;
    }
    const finalValue = downValue + installmentValue * n;
    const lines: string[] = [];
    if (downValue > 0) lines.push(T.entradaAvista(brl(downValue)));
    lines.push(T.cartaoParcelas(n, brl(installmentValue), hasInterest));
    lines.push(T.cartaoTotalParcelado(brl(installmentValue * n), hasInterest ? brl(extraInterest) : null));
    lines.push(T.valorFinal(brl(finalValue), downValue > 0));
    return { headline: T.cartaoHeadline(n, brl(installmentValue)), lines };
  }

  const parceladoMatch = paymentKey.match(/^parcelado-(\d+)x$/);
  if (parceladoMatch) {
    const n = Number(parceladoMatch[1]);
    const TAXA_BOLETO = 1.5 / 100;
    const downValue = downPayment > 0 ? Math.min(downPayment, total - 0.01) : 0;
    const financed = total - downValue;
    const installmentValue = financed * TAXA_BOLETO / (1 - Math.pow(1 + TAXA_BOLETO, -n));
    const extraInterest = installmentValue * n - financed;
    const finalValue = downValue + installmentValue * n;
    const lines: string[] = [];
    if (downValue > 0) lines.push(T.entrada(brl(downValue)));
    lines.push(T.boletoParcelas(n, brl(installmentValue)));
    lines.push(T.boletoTotalParcelas(brl(installmentValue * n), brl(extraInterest)));
    lines.push(T.valorFinal(brl(finalValue), false));
    return { headline: T.boletoHeadline(n, brl(installmentValue)), lines };
  }

  return null;
}

/** Desenha o PDF do orçamento de trabalho (conta de laboratório). */
export async function desenharOrcamentoDoLaboratorio(
  quote: any,
  conta: ContaDoPdf | null,
  withValues: boolean,
): Promise<Buffer> {
  const L = LAB_ORCAMENTO_PDF;
  const numero = numeroDoOrcamento(quote);
  const cliente = quote.patient || {};
  const nomeDaConta = (conta?.name || '').trim() || L.nomePadraoDaConta;
  const logo = logoDaConta(conta?.logo_url ?? null);

  return new Promise<Buffer>((resolve, reject) => {
    const doc = new PDFDocument({
      size: 'A4',
      margins: { top: 60, bottom: 60, left: 60, right: 60 },
      info: { Title: L.tituloDoc(numero, cliente.name || '') },
    });

    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const left = doc.page.margins.left;
    const W = doc.page.width - doc.page.margins.left - doc.page.margins.right;

    // ── Cabeçalho da conta: logo, nome, subtítulo, contato e CNPJ
    if (logo) {
      try {
        const topo = doc.y;
        doc.image(logo, left + (W - LOGO_W) / 2, topo, { fit: [LOGO_W, LOGO_H], align: 'center', valign: 'center' });
        doc.y = topo + LOGO_H + 6;
        doc.x = left;
      } catch (e) {
        logger.warn(`[LAB-PDF] não deu para desenhar a logo, PDF segue sem ela: ${(e as Error)?.message ?? e}`);
      }
    }
    doc.font('Helvetica-Bold').fontSize(18).text(nomeDaConta, left, doc.y, { width: W, align: 'center' });
    doc.font('Helvetica').fontSize(10).text(L.subtitulo, { width: W, align: 'center' });
    const cidadeUf = conta?.city && conta?.state ? `${conta.city}/${conta.state}` : conta?.city || conta?.state || '';
    const contato = [conta?.phone, conta?.email, cidadeUf].filter((x) => !!x && String(x).trim()).join(' · ');
    if (contato) doc.fontSize(9).fillColor('#444').text(contato, { width: W, align: 'center' });
    const docDaConta = formatCpfCnpj(conta?.cpf_cnpj ?? null);
    if (docDaConta) {
      const linha = tipoDoDocumento(conta?.cpf_cnpj ?? null) === 'CLINICA' ? L.cnpjDaConta(docDaConta) : L.cpfCnpjLinha(docDaConta);
      doc.fontSize(9).fillColor('#444').text(linha, { width: W, align: 'center' });
    }
    doc.fillColor('#000');
    doc.moveDown(1.5);

    // ── Título do documento
    doc.font('Helvetica-Bold').fontSize(15).text(L.titulo, { align: 'center' });
    doc.font('Helvetica').fontSize(10).text(L.numero(numero), { align: 'center' });
    doc.moveDown(1.5);

    // ── Dados do orçamento
    const issued = dataBR(quote.created_at);
    const validUntil = quote.valid_until ? dataBR(quote.valid_until) : L.semPrazo;
    doc.font('Helvetica-Bold').fontSize(10).text(L.dadosDoOrcamento);
    doc.font('Helvetica').fontSize(10);
    doc.text(L.emitidoEValidade(issued, validUntil));
    if (quote.created_by?.name) doc.text(L.atendidoPor(quote.created_by.name));
    doc.moveDown(1);

    // ── Cliente (sem RG nem nascimento: o cadastro do laboratório não usa)
    doc.font('Helvetica-Bold').fontSize(10).text(L.cliente);
    doc.moveDown(0.3);
    doc.font('Helvetica').fontSize(10);
    doc.text(L.nome(cliente.name || ''));
    const documento = formatCpfCnpj(cliente.cpf ?? null);
    if (documento) doc.text(L.cpfCnpjLinha(documento));
    if (cliente.phone) doc.text(L.telefone(cliente.phone));
    if (cliente.email) doc.text(L.email(cliente.email));
    const enderecoFmt = [
      cliente.address && cliente.address_number ? `${cliente.address}, ${cliente.address_number}` : cliente.address,
      cliente.neighborhood,
      cliente.city && cliente.state ? `${cliente.city}/${cliente.state}` : cliente.city,
    ]
      .filter(Boolean)
      .join(' — ');
    if (enderecoFmt) doc.text(L.endereco(enderecoFmt));
    doc.moveDown(1);

    // ── Tabela de serviços
    doc.font('Helvetica-Bold').fontSize(11).text(L.servicos);
    doc.moveDown(0.5);

    const colW = withValues
      ? { serv: W * 0.5, elem: W * 0.1, qty: W * 0.07, unit: W * 0.16, total: W * 0.17 }
      : { serv: W * 0.72, elem: W * 0.13, qty: W * 0.15, unit: 0, total: 0 };
    let cursorY = doc.y;
    const drawHeaderRow = () => {
      doc.font('Helvetica-Bold').fontSize(9);
      doc.text(L.colServico, left, cursorY, { width: colW.serv });
      doc.text(L.colElemento, left + colW.serv, cursorY, { width: colW.elem, align: 'center' });
      doc.text(L.colQtd, left + colW.serv + colW.elem, cursorY, { width: colW.qty, align: 'right' });
      if (withValues) {
        doc.text(L.colUnitario, left + colW.serv + colW.elem + colW.qty, cursorY, { width: colW.unit, align: 'right' });
        doc.text(L.colTotal, left + colW.serv + colW.elem + colW.qty + colW.unit, cursorY, { width: colW.total, align: 'right' });
      }
      doc.moveDown(0.4);
      doc.moveTo(left, doc.y).lineTo(left + W, doc.y).stroke();
      doc.moveDown(0.3);
      cursorY = doc.y;
    };
    drawHeaderRow();

    doc.font('Helvetica').fontSize(9.5);
    for (const item of quote.items || []) {
      if (doc.y > doc.page.height - 200) {
        doc.addPage();
        cursorY = doc.y;
        drawHeaderRow();
        doc.font('Helvetica').fontSize(9.5);
      }
      cursorY = doc.y;
      doc.text(item.procedure?.name || L.servicoSemNome, left, cursorY, { width: colW.serv });
      doc.text(item.tooth_fdi || L.semElemento, left + colW.serv, cursorY, { width: colW.elem, align: 'center' });
      doc.text(String(item.quantity), left + colW.serv + colW.elem, cursorY, { width: colW.qty, align: 'right' });
      if (withValues) {
        doc.text(formatBRL(item.unit_price), left + colW.serv + colW.elem + colW.qty, cursorY, { width: colW.unit, align: 'right' });
        doc.text(formatBRL(item.total_price), left + colW.serv + colW.elem + colW.qty + colW.unit, cursorY, { width: colW.total, align: 'right' });
      }
      if (item.notes) {
        doc.moveDown(0.2);
        doc.font('Helvetica-Oblique').fontSize(8).fillColor('#666').text(L.obs(item.notes), left + 12);
        doc.fillColor('#000').font('Helvetica').fontSize(9.5);
      }
      doc.moveDown(0.4);
    }

    doc.moveTo(left, doc.y).lineTo(left + W, doc.y).stroke();
    doc.moveDown(0.5);

    // ── Totais (só com valores)
    const subtotal = Number(quote.subtotal);
    const discountValue = Number(quote.discount_value);
    const discountPercent = Number(quote.discount_percent);
    const total = Number(quote.total_value);
    if (withValues) {
      const totalsX = left + W * 0.55;
      const totalsW = W * 0.45;
      doc.font('Helvetica').fontSize(10);
      doc.text(L.subtotal, totalsX, doc.y, { width: totalsW * 0.6, align: 'right' });
      doc.text(formatBRL(subtotal), totalsX + totalsW * 0.6, doc.y - doc.currentLineHeight(), { width: totalsW * 0.4, align: 'right' });
      doc.moveDown(0.3);
      if (discountValue > 0) {
        doc.text(L.desconto(discountPercent > 0 ? String(discountPercent) : ''), totalsX, doc.y, { width: totalsW * 0.6, align: 'right' });
        doc.text(L.descontoValor(formatBRL(discountValue)), totalsX + totalsW * 0.6, doc.y - doc.currentLineHeight(), {
          width: totalsW * 0.4,
          align: 'right',
        });
        doc.moveDown(0.3);
      }
      doc.font('Helvetica-Bold').fontSize(12);
      doc.text(L.total, totalsX, doc.y, { width: totalsW * 0.6, align: 'right' });
      doc.text(formatBRL(total), totalsX + totalsW * 0.6, doc.y - doc.currentLineHeight(), { width: totalsW * 0.4, align: 'right' });
      doc.moveDown(1.5);
    } else {
      doc.moveDown(0.5);
    }

    // ── Condições de pagamento (só com valores)
    if (quote.payment_terms && withValues) {
      doc.font('Helvetica-Bold').fontSize(10).text(L.condicoes, left, doc.y);
      doc.moveDown(0.3);
      doc.font('Helvetica').fontSize(10).text(quote.payment_terms);
      doc.moveDown(1);
    }

    // ── Proposta de pagamento apresentada (só com valores)
    if (quote.chosen_payment_key && withValues) {
      const avistaPct = quote.avista_discount_enabled ? Number(quote.avista_discount_pct) || 0 : 0;
      const offer = ofertaDePagamentoDoLaboratorio(total, quote.chosen_payment_key, Number(quote.chosen_down_payment) || 0, avistaPct);
      if (offer) {
        const boxY = doc.y;
        const boxH = 65 + offer.lines.length * 14;
        doc.save();
        doc.rect(left, boxY, W, boxH).lineWidth(1.5).strokeColor('#D97706').fillColor('#FFFBEB').fillAndStroke();
        doc.restore();
        doc.fillColor('#000');
        doc.font('Helvetica-Bold').fontSize(10).fillColor('#92400E').text(L.propostaApresentada, left + 12, boxY + 10, { width: W - 24 });
        doc.font('Helvetica-Bold').fontSize(13).fillColor('#000').text(offer.headline, left + 12, doc.y + 4);
        doc.moveDown(0.3);
        doc.font('Helvetica').fontSize(10);
        for (const line of offer.lines) doc.text(line, left + 12, doc.y, { width: W - 24 });
        doc.y = boxY + boxH + 12;
        doc.x = left;
        doc.fillColor('#000');
      }
    }

    // ── Observações
    if (quote.notes) {
      doc.font('Helvetica-Bold').fontSize(10).text(L.observacoes, left, doc.y);
      doc.moveDown(0.3);
      doc.font('Helvetica').fontSize(10).text(quote.notes);
      doc.moveDown(1);
    }

    // ── Anexos
    const attachments = quote.attachments || [];
    if (attachments.length > 0) {
      doc.font('Helvetica-Bold').fontSize(10).text(L.anexos, left, doc.y);
      doc.moveDown(0.3);
      doc.font('Helvetica').fontSize(9.5);
      for (const att of attachments) doc.text(L.anexo(att.filename, att.category || ''));
      doc.moveDown(0.5);
      doc.fontSize(8).fillColor('#666').text(L.anexosNota);
      doc.fillColor('#000');
      doc.moveDown(1);
    }

    // ── Assinatura — quadro perto do rodapé
    const sigBoxW = 320;
    const sigBoxH = 60;
    const sigBoxX = left + (W - sigBoxW) / 2;
    const sigBoxTop = doc.page.height - 155;
    if (doc.y > sigBoxTop - 26) doc.addPage();
    doc.font('Helvetica').fontSize(8).fillColor('#666').text(L.assinatura, sigBoxX, sigBoxTop - 14, { width: sigBoxW, align: 'center' });
    doc.lineWidth(0.8).strokeColor('#333').roundedRect(sigBoxX, sigBoxTop, sigBoxW, sigBoxH, 6).stroke();
    doc.strokeColor('#000');
    doc.font('Helvetica').fontSize(9).fillColor('#000').text(cliente.name || '', sigBoxX, sigBoxTop + sigBoxH + 6, {
      width: sigBoxW,
      align: 'center',
    });
    doc.fontSize(7.5).fillColor('#666').text(L.ciente(withValues), left, sigBoxTop + sigBoxH + 20, { width: W, align: 'center' });
    doc.fillColor('#000');

    // ── Rodapé — na mesma página do quadro de assinatura: o rodapé fica dentro da margem de
    // baixo, então a margem é zerada só para este texto (senão o pdfkit abre uma página só
    // com o rodapé).
    const footerY = doc.page.height - 50;
    const margemDeBaixo = doc.page.margins.bottom;
    doc.page.margins.bottom = 0;
    doc.font('Helvetica').fontSize(8).fillColor('#999').text(L.rodape(numero, issued, validUntil), left, footerY, {
      width: W,
      align: 'center',
    });
    doc.page.margins.bottom = margemDeBaixo;

    doc.end();
  });
}

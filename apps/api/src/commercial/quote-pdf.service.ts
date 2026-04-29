/**
 * QuotePdfService — gera PDF profissional do orcamento (Fase 24 — Onda 2).
 *
 * Layout:
 *  - Header: logo + nome da clinica + dados (CRO, endereco, telefone)
 *  - Identificacao do paciente (nome, CPF, telefone)
 *  - Tabela de procedimentos (procedimento + dente + qty + unitario + total)
 *  - Totais (subtotal, desconto, total)
 *  - Condicoes de pagamento (se preenchido)
 *  - Espaco pra assinatura
 *  - Rodape com validade + numero do orcamento
 *
 * Usa pdfkit (mesma lib do TCLE — consistencia visual). Buffer retornado
 * pelo controller via res.end(buffer) com Content-Type: application/pdf.
 */
import { Injectable, NotFoundException, Logger } from '@nestjs/common';
import PDFDocument from 'pdfkit';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class QuotePdfService {
  private readonly logger = new Logger(QuotePdfService.name);

  constructor(private prisma: PrismaService) {}

  async generatePdf(quoteId: string, tenantId: string): Promise<Buffer> {
    const quote = await this.prisma.quote.findUnique({
      where: { id: quoteId },
      include: {
        patient: {
          select: {
            id: true, name: true, cpf: true, rg: true,
            birth_date: true, phone: true, email: true, tenant_id: true,
            address: true, address_number: true, neighborhood: true,
            city: true, state: true, zip_code: true,
          },
        },
        created_by: { select: { name: true } },
        items: {
          orderBy: { order_index: 'asc' },
          include: {
            procedure: { select: { name: true, code_tuss: true } },
          },
        },
        attachments: {
          orderBy: { created_at: 'asc' },
          select: { id: true, filename: true, category: true, mime_type: true },
        },
      },
    });

    if (!quote) throw new NotFoundException('Orcamento nao encontrado');
    if (quote.patient.tenant_id !== tenantId) {
      throw new NotFoundException('Orcamento nao pertence ao tenant');
    }

    return this.renderPdf(quote);
  }

  private renderPdf(quote: any): Promise<Buffer> {
    return new Promise<Buffer>((resolve, reject) => {
      const doc = new PDFDocument({
        size: 'A4',
        margins: { top: 60, bottom: 60, left: 60, right: 60 },
        info: { Title: `Orcamento — ${quote.patient.name}` },
      });

      const chunks: Buffer[] = [];
      doc.on('data', (c: Buffer) => chunks.push(c));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      const W = doc.page.width - doc.page.margins.left - doc.page.margins.right;

      // ── Header da clinica
      doc.font('Helvetica-Bold').fontSize(18)
        .text('INSTITUTO ODONTO PASSOS', { align: 'center' });
      doc.font('Helvetica').fontSize(10)
        .text('Clinica Odontologica', { align: 'center' });
      doc.moveDown(1.5);

      // ── Titulo do documento
      doc.font('Helvetica-Bold').fontSize(15)
        .text('ORÇAMENTO', { align: 'center' });
      doc.font('Helvetica').fontSize(10)
        .text(`#${quote.id.slice(0, 8).toUpperCase()}`, { align: 'center' });
      doc.moveDown(1.5);

      // ── Dados do orcamento
      const issued = new Date(quote.created_at).toLocaleDateString('pt-BR');
      const validUntil = quote.valid_until
        ? new Date(quote.valid_until).toLocaleDateString('pt-BR')
        : 'Sem prazo definido';
      doc.font('Helvetica-Bold').fontSize(10).text('DADOS DO ORÇAMENTO');
      doc.font('Helvetica').fontSize(10);
      doc.text(`Emitido em: ${issued}    |    Válido até: ${validUntil}`);
      if (quote.created_by?.name) {
        doc.text(`Atendido por: ${quote.created_by.name}`);
      }
      doc.moveDown(1);

      // ── Identificacao do paciente
      doc.font('Helvetica-Bold').fontSize(10).text('PACIENTE');
      doc.moveDown(0.3);
      doc.font('Helvetica').fontSize(10);
      doc.text(`Nome: ${quote.patient.name}`);
      if (quote.patient.cpf) doc.text(`CPF: ${quote.patient.cpf}`);
      if (quote.patient.rg) doc.text(`RG: ${quote.patient.rg}`);
      if (quote.patient.phone) doc.text(`Telefone: ${quote.patient.phone}`);
      if (quote.patient.email) doc.text(`E-mail: ${quote.patient.email}`);
      const enderecoFmt = [
        quote.patient.address && quote.patient.address_number
          ? `${quote.patient.address}, ${quote.patient.address_number}`
          : quote.patient.address,
        quote.patient.neighborhood,
        quote.patient.city && quote.patient.state
          ? `${quote.patient.city}/${quote.patient.state}`
          : quote.patient.city,
      ].filter(Boolean).join(' — ');
      if (enderecoFmt) doc.text(`Endereço: ${enderecoFmt}`);
      doc.moveDown(1);

      // ── Tabela de procedimentos
      doc.font('Helvetica-Bold').fontSize(11).text('PROCEDIMENTOS');
      doc.moveDown(0.5);

      const colW = { proc: W * 0.50, dente: W * 0.10, qty: W * 0.07, unit: W * 0.16, total: W * 0.17 };
      let cursorY = doc.y;
      const drawHeaderRow = () => {
        doc.font('Helvetica-Bold').fontSize(9);
        doc.text('Procedimento', doc.page.margins.left, cursorY, { width: colW.proc });
        doc.text('Dente', doc.page.margins.left + colW.proc, cursorY, { width: colW.dente, align: 'center' });
        doc.text('Qtd', doc.page.margins.left + colW.proc + colW.dente, cursorY, { width: colW.qty, align: 'right' });
        doc.text('Unitário', doc.page.margins.left + colW.proc + colW.dente + colW.qty, cursorY, { width: colW.unit, align: 'right' });
        doc.text('Total', doc.page.margins.left + colW.proc + colW.dente + colW.qty + colW.unit, cursorY, { width: colW.total, align: 'right' });
        doc.moveDown(0.4);
        doc.moveTo(doc.page.margins.left, doc.y).lineTo(doc.page.margins.left + W, doc.y).stroke();
        doc.moveDown(0.3);
        cursorY = doc.y;
      };
      drawHeaderRow();

      doc.font('Helvetica').fontSize(9.5);
      const formatBRL = (v: any) =>
        Number(v).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

      for (const item of quote.items) {
        // quebra de pagina se necessario
        if (doc.y > doc.page.height - 200) {
          doc.addPage();
          cursorY = doc.y;
          drawHeaderRow();
        }
        cursorY = doc.y;
        const procName = item.procedure?.name || 'Procedimento';
        const procFull = item.procedure?.code_tuss
          ? `${procName} (TUSS ${item.procedure.code_tuss})`
          : procName;
        doc.text(procFull, doc.page.margins.left, cursorY, { width: colW.proc });
        doc.text(item.tooth_fdi || '-', doc.page.margins.left + colW.proc, cursorY, { width: colW.dente, align: 'center' });
        doc.text(String(item.quantity), doc.page.margins.left + colW.proc + colW.dente, cursorY, { width: colW.qty, align: 'right' });
        doc.text(formatBRL(item.unit_price), doc.page.margins.left + colW.proc + colW.dente + colW.qty, cursorY, { width: colW.unit, align: 'right' });
        doc.text(formatBRL(item.total_price), doc.page.margins.left + colW.proc + colW.dente + colW.qty + colW.unit, cursorY, { width: colW.total, align: 'right' });
        if (item.notes) {
          doc.moveDown(0.2);
          doc.font('Helvetica-Oblique').fontSize(8).fillColor('#666')
            .text(`  obs: ${item.notes}`, doc.page.margins.left + 12);
          doc.fillColor('#000').font('Helvetica').fontSize(9.5);
        }
        doc.moveDown(0.4);
      }

      // Linha separadora
      doc.moveTo(doc.page.margins.left, doc.y).lineTo(doc.page.margins.left + W, doc.y).stroke();
      doc.moveDown(0.5);

      // ── Totais
      const subtotal = Number(quote.subtotal);
      const discountValue = Number(quote.discount_value);
      const discountPercent = Number(quote.discount_percent);
      const total = Number(quote.total_value);

      const totalsX = doc.page.margins.left + W * 0.55;
      const totalsW = W * 0.45;
      doc.font('Helvetica').fontSize(10);
      doc.text('Subtotal:', totalsX, doc.y, { width: totalsW * 0.6, align: 'right' });
      doc.text(formatBRL(subtotal), totalsX + totalsW * 0.6, doc.y - doc.currentLineHeight(), { width: totalsW * 0.4, align: 'right' });
      doc.moveDown(0.3);
      if (discountValue > 0) {
        doc.text(
          `Desconto${discountPercent > 0 ? ` (${discountPercent}%)` : ''}:`,
          totalsX, doc.y, { width: totalsW * 0.6, align: 'right' },
        );
        doc.text(`- ${formatBRL(discountValue)}`, totalsX + totalsW * 0.6, doc.y - doc.currentLineHeight(), { width: totalsW * 0.4, align: 'right' });
        doc.moveDown(0.3);
      }
      doc.font('Helvetica-Bold').fontSize(12);
      doc.text('TOTAL:', totalsX, doc.y, { width: totalsW * 0.6, align: 'right' });
      doc.text(formatBRL(total), totalsX + totalsW * 0.6, doc.y - doc.currentLineHeight(), { width: totalsW * 0.4, align: 'right' });
      doc.moveDown(1.5);

      // ── Condicoes de pagamento
      if (quote.payment_terms) {
        doc.font('Helvetica-Bold').fontSize(10).text('CONDIÇÕES DE PAGAMENTO');
        doc.moveDown(0.3);
        doc.font('Helvetica').fontSize(10).text(quote.payment_terms);
        doc.moveDown(1);
      }

      // ── Notas
      if (quote.notes) {
        doc.font('Helvetica-Bold').fontSize(10).text('OBSERVAÇÕES');
        doc.moveDown(0.3);
        doc.font('Helvetica').fontSize(10).text(quote.notes);
        doc.moveDown(1);
      }

      // ── Anexos (Onda 3) — lista nomes + categoria pra paciente saber o que vem junto
      const attachments = (quote as any).attachments || [];
      if (attachments.length > 0) {
        doc.font('Helvetica-Bold').fontSize(10).text('ANEXOS DESTE ORÇAMENTO');
        doc.moveDown(0.3);
        doc.font('Helvetica').fontSize(9.5);
        for (const att of attachments) {
          const cat = att.category ? ` [${att.category}]` : '';
          doc.text(`• ${att.filename}${cat}`);
        }
        doc.moveDown(0.5);
        doc.fontSize(8).fillColor('#666').text(
          'Os arquivos podem ser visualizados no portal do paciente ou solicitados à recepção.',
        );
        doc.fillColor('#000');
        doc.moveDown(1);
      }

      // ── Espaco pra assinatura
      doc.moveDown(2);
      const sigY = Math.min(doc.y, doc.page.height - 130);
      doc.moveTo(doc.page.margins.left + 60, sigY).lineTo(doc.page.margins.left + W - 60, sigY).stroke();
      doc.font('Helvetica').fontSize(9).text(
        `Assinatura: ${quote.patient.name}`,
        doc.page.margins.left + 60, sigY + 5,
        { width: W - 120, align: 'center' },
      );
      doc.moveDown(0.3);
      doc.fontSize(8).fillColor('#666').text(
        `Ao assinar, declaro estar ciente dos procedimentos, valores e condições descritos neste orçamento.`,
        doc.page.margins.left, doc.y,
        { width: W, align: 'center' },
      );
      doc.fillColor('#000');

      // ── Rodape
      const footerY = doc.page.height - 50;
      doc.font('Helvetica').fontSize(8).fillColor('#999').text(
        `Orçamento #${quote.id.slice(0, 8).toUpperCase()} · Emitido em ${issued} · Válido até ${validUntil}`,
        doc.page.margins.left, footerY,
        { width: W, align: 'center' },
      );

      doc.end();
    });
  }
}

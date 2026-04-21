import { Injectable, Logger, NotFoundException, BadRequestException, ForbiddenException } from '@nestjs/common';
import PDFDocument from 'pdfkit';
import { PrismaService } from '../prisma/prisma.service';
import { ClicksignService } from '../clicksign/clicksign.service';

@Injectable()
export class TreatmentPlanContractService {
  private readonly logger = new Logger(TreatmentPlanContractService.name);

  constructor(
    private prisma: PrismaService,
    private clicksign: ClicksignService,
  ) {}

  /**
   * Gera o TCLE (Termo de Consentimento Livre e Esclarecido) do plano de
   * tratamento, sobe pra ClickSign, envia link via WhatsApp e vincula o
   * ContractSignature criado ao TreatmentPlan.
   *
   * Quando o paciente assinar, o webhook do ClickSign ativa o plano
   * automaticamente (status PENDING_SIGNATURE -> ACTIVE).
   */
  async sendForSignature(planId: string, tenantId: string): Promise<{ signingUrl: string }> {
    const plan = await this.prisma.treatmentPlan.findUnique({
      where: { id: planId },
      include: {
        patient: true,
        items: { include: { procedure: { select: { name: true } } }, orderBy: { order_index: 'asc' } },
      },
    });
    if (!plan) throw new NotFoundException('Plano nao encontrado');
    if (plan.patient.tenant_id !== tenantId) throw new ForbiddenException('Acesso negado');

    if (plan.contract_signature_id) {
      throw new BadRequestException('Plano ja tem assinatura digital iniciada');
    }
    if (plan.status !== 'PENDING_SIGNATURE') {
      throw new BadRequestException(`Plano esta em status ${plan.status} — so PENDING_SIGNATURE pode iniciar assinatura`);
    }

    // Paciente precisa estar vinculado a um Lead (ContractSignature exige lead_id)
    if (!plan.patient.lead_id) {
      throw new BadRequestException(
        'Paciente nao vinculado a Lead. Para enviar TCLE digital, primeiro vincule este paciente a um Lead (ou cadastre via WhatsApp).'
      );
    }

    // Garante uma conversation pra ContractSignature.conversation_id (FK obrigatoria).
    const conversation = await this.ensureConversation(plan.patient.lead_id, plan.patient.tenant_id);

    // Gera o PDF do TCLE
    const buffer = await this.generateTclePdf(plan);

    // Identificacao do signatario
    const signerName = plan.patient.name;
    const signerPhone = plan.patient.phone || '';
    const signerEmail = plan.patient.email || `${signerPhone.replace(/\D/g, '')}@noreply.placeholder`;

    if (!signerPhone) {
      throw new BadRequestException('Paciente sem telefone — cadastre antes de enviar TCLE');
    }

    const safeName = signerName.replace(/[^\w\s-]/g, '').replace(/\s+/g, '_');
    const filename = `TCLE_${safeName}_${Date.now()}.pdf`;

    const whatsappMessage =
      `🦷 *Plano de Tratamento — Instituto Odonto Passos*\n\n` +
      `Olá ${signerName.split(' ')[0]}!\n\n` +
      `Seu plano de tratamento odontológico está pronto. Para iniciarmos, ` +
      `precisamos da sua assinatura digital no Termo de Consentimento (TCLE).\n\n` +
      `🔒 Assinatura segura e válida juridicamente (Lei 14.063/2020).\n` +
      `📱 Você confirmará sua identidade via WhatsApp.\n\n` +
      `✍️ *Clique aqui para assinar:*\n[link]`;

    const { signingUrl, contractSignatureId } = await this.clicksign.createGenericSignature({
      leadId: plan.patient.lead_id,
      conversationId: conversation.id,
      buffer,
      filename,
      signerName,
      signerEmail,
      signerPhone,
      signerMessage: 'Por favor, leia o plano de tratamento e assine o Termo de Consentimento Livre e Esclarecido.',
      whatsappMessage: whatsappMessage.replace('[link]', '{will-be-replaced}'), // ClickSign envia link separado
      whatsappInstance: conversation.instance_name || undefined,
    });

    // Vincula ContractSignature -> TreatmentPlan (campo no plan)
    await this.prisma.treatmentPlan.update({
      where: { id: plan.id },
      data: { contract_signature_id: contractSignatureId },
    });

    this.logger.log(`[TCLE] Plano ${plan.id} enviado para assinatura — signature ${contractSignatureId}`);
    return { signingUrl };
  }

  // ─── Geracao do PDF do TCLE ──────────────────────────────────

  private async generateTclePdf(plan: any): Promise<Buffer> {
    return new Promise<Buffer>((resolve, reject) => {
      const doc = new PDFDocument({
        size: 'A4',
        margins: { top: 60, bottom: 60, left: 60, right: 60 },
        info: { Title: `TCLE — Plano de Tratamento — ${plan.patient.name}` },
      });

      const chunks: Buffer[] = [];
      doc.on('data', (c: Buffer) => chunks.push(c));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      const W = doc.page.width - doc.page.margins.left - doc.page.margins.right;

      // ── Header
      doc.font('Helvetica-Bold').fontSize(16).text('INSTITUTO ODONTO PASSOS', { align: 'center' });
      doc.font('Helvetica').fontSize(9).text('Clínica Odontológica', { align: 'center' });
      doc.moveDown(1.5);

      doc.font('Helvetica-Bold').fontSize(14)
         .text('TERMO DE CONSENTIMENTO LIVRE E ESCLARECIDO', { align: 'center' });
      doc.moveDown(0.3);
      doc.font('Helvetica').fontSize(11).text('Plano de Tratamento Odontológico', { align: 'center' });
      doc.moveDown(1.5);

      // ── Identificacao
      doc.font('Helvetica-Bold').fontSize(11).text('IDENTIFICAÇÃO DO PACIENTE');
      doc.moveDown(0.3);
      doc.font('Helvetica').fontSize(10);
      doc.text(`Nome: ${plan.patient.name}`);
      if (plan.patient.cpf) doc.text(`CPF: ${plan.patient.cpf}`);
      if (plan.patient.rg) doc.text(`RG: ${plan.patient.rg}`);
      if (plan.patient.birth_date) {
        doc.text(`Data de nascimento: ${new Date(plan.patient.birth_date).toLocaleDateString('pt-BR')}`);
      }
      if (plan.patient.phone) doc.text(`Telefone: ${plan.patient.phone}`);
      if (plan.patient.email) doc.text(`Email: ${plan.patient.email}`);
      doc.moveDown(1);

      // ── Plano de tratamento
      doc.font('Helvetica-Bold').fontSize(11).text('PLANO DE TRATAMENTO PROPOSTO');
      doc.moveDown(0.5);

      // Tabela de items
      doc.font('Helvetica-Bold').fontSize(9);
      const colW = { proc: W * 0.55, qty: W * 0.1, unit: W * 0.18, total: W * 0.17 };
      const startY = doc.y;
      doc.text('Procedimento', doc.page.margins.left, startY, { width: colW.proc });
      doc.text('Qtd', doc.page.margins.left + colW.proc, startY, { width: colW.qty, align: 'right' });
      doc.text('Unitário', doc.page.margins.left + colW.proc + colW.qty, startY, { width: colW.unit, align: 'right' });
      doc.text('Total', doc.page.margins.left + colW.proc + colW.qty + colW.unit, startY, { width: colW.total, align: 'right' });
      doc.moveDown(0.3);
      doc.moveTo(doc.page.margins.left, doc.y).lineTo(doc.page.margins.left + W, doc.y).stroke();
      doc.moveDown(0.3);

      doc.font('Helvetica').fontSize(9);
      for (const item of plan.items) {
        const y = doc.y;
        const procName = item.procedure?.name || 'Procedimento';
        const procText = item.tooth_fdi ? `${procName} (dente ${item.tooth_fdi})` : procName;
        doc.text(procText, doc.page.margins.left, y, { width: colW.proc });
        const lineH = doc.y - y; // altura usada pelo nome
        doc.text(String(item.quantity), doc.page.margins.left + colW.proc, y, { width: colW.qty, align: 'right' });
        doc.text(`R$ ${Number(item.unit_price).toFixed(2)}`, doc.page.margins.left + colW.proc + colW.qty, y, { width: colW.unit, align: 'right' });
        doc.text(`R$ ${Number(item.total_price).toFixed(2)}`, doc.page.margins.left + colW.proc + colW.qty + colW.unit, y, { width: colW.total, align: 'right' });
        doc.y = y + Math.max(lineH, 12);
        doc.moveDown(0.2);
      }

      doc.moveDown(0.5);
      doc.moveTo(doc.page.margins.left, doc.y).lineTo(doc.page.margins.left + W, doc.y).stroke();
      doc.moveDown(0.4);
      doc.font('Helvetica-Bold').fontSize(11)
         .text(`VALOR TOTAL: R$ ${Number(plan.total_value).toFixed(2)}`, { align: 'right' });
      doc.moveDown(1.5);

      // ── TCLE corpo
      doc.font('Helvetica-Bold').fontSize(11).text('TERMO DE CONSENTIMENTO');
      doc.moveDown(0.3);
      doc.font('Helvetica').fontSize(10).text(
        'Eu, paciente acima identificado, declaro que:',
        { align: 'justify' }
      );
      doc.moveDown(0.3);

      const items = [
        '1. Fui devidamente informado(a) sobre o diagnóstico, plano de tratamento, alternativas terapêuticas, riscos, complicações possíveis e prognóstico.',
        '2. Tive oportunidade de fazer perguntas e todas foram respondidas de forma clara e completa.',
        '3. Compreendo que a Odontologia não é uma ciência exata e que os resultados podem variar conforme resposta biológica individual, condições de saúde, hábitos de higiene e adesão às orientações pós-operatórias.',
        '4. Estou ciente do valor total do tratamento e das condições de pagamento acordadas.',
        '5. Comprometo-me a comparecer às consultas agendadas, seguir as recomendações dos profissionais e comunicar qualquer intercorrência.',
        '6. Autorizo o registro fotográfico e a documentação clínica necessária ao tratamento, com o devido sigilo profissional.',
        '7. Tenho direito a interromper o tratamento a qualquer momento, ciente das possíveis consequências clínicas e financeiras.',
        '8. Esta autorização está em conformidade com o Código de Ética Odontológica (CFO 118/2012) e com a Lei Geral de Proteção de Dados (LGPD — Lei 13.709/2018).',
      ];

      for (const it of items) {
        doc.text(it, { align: 'justify' });
        doc.moveDown(0.4);
      }

      doc.moveDown(1);
      doc.font('Helvetica').fontSize(10).text(
        `Por estar de acordo, assino digitalmente o presente termo, com validade jurídica nos termos da Lei 14.063/2020.`,
        { align: 'justify' }
      );
      doc.moveDown(2);
      doc.text(`Data: ${new Date().toLocaleDateString('pt-BR')}`, { align: 'left' });
      doc.moveDown(2);
      doc.text('________________________________________', { align: 'center' });
      doc.text(`${plan.patient.name} — Paciente`, { align: 'center' });

      doc.end();
    });
  }

  /** Garante que existe uma Conversation para o lead — cria phantom se nao houver. */
  private async ensureConversation(leadId: string, tenantId: string | null) {
    const existing = await this.prisma.conversation.findFirst({
      where: { lead_id: leadId },
      orderBy: { last_message_at: 'desc' },
      select: { id: true, instance_name: true },
    });
    if (existing) return existing;

    const created = await this.prisma.conversation.create({
      data: {
        lead_id: leadId,
        tenant_id: tenantId,
        channel: 'internal',
        status: 'ABERTO',
        ai_mode: false,
      },
      select: { id: true, instance_name: true },
    });
    this.logger.log(`[TCLE] Conversation phantom criada (${created.id}) para lead ${leadId}`);
    return created;
  }
}

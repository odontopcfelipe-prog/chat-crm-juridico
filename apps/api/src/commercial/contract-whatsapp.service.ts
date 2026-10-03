import {
  Injectable,
  Logger,
  NotFoundException,
  ForbiddenException,
  BadRequestException,
  ConflictException,
  InternalServerErrorException,
} from '@nestjs/common';
import { toBrazilWhatsappNumber, brazilPhoneMatchVariants } from '@crm/shared';
import { PrismaService } from '../prisma/prisma.service';
import { ConversationsService } from '../conversations/conversations.service';
import { MessagesService } from '../messages/messages.service';
import { ContractPdfService, isPdfBuffer } from './contract-pdf.service';
import { QuotesService } from './quotes.service';
import { ContractsService } from './contracts.service';

type SendProblem = 'NO_PHONE' | 'PHONE_MISMATCH' | 'NO_CLINICAL_CHIP' | 'CONTRACT_INACTIVE' | 'LEAD_WILL_LINK';

const CHIP_LABEL: Record<'CLINICA' | 'COMERCIAL', string> = { CLINICA: 'Clínica', COMERCIAL: 'Comercial' };

/**
 * "Enviar no WhatsApp" do card do contrato: gera o PDF do contrato CRIADO e
 * manda como documento na conversa de PACIENTE (nunca a do Financeiro), pelo
 * chip Clínica/Comercial — aparece no histórico do chat como qualquer arquivo.
 *
 * Não muda o status do contrato (o ClickSign continua disponível, ele exige
 * DRAFT); só registra um ContractEvent WHATSAPP_SENT.
 */
@Injectable()
export class ContractWhatsappService {
  private readonly logger = new Logger(ContractWhatsappService.name);

  constructor(
    private prisma: PrismaService,
    private contractPdf: ContractPdfService,
    private conversations: ConversationsService,
    private messages: MessagesService,
    private quotes: QuotesService,
    private contracts: ContractsService,
  ) {}

  private async loadContract(contractId: string, tenantId: string) {
    const contract = await this.prisma.contract.findUnique({
      where: { id: contractId },
      select: {
        id: true,
        status: true,
        quote: {
          select: {
            patient: {
              select: {
                id: true, name: true, phone: true, tenant_id: true, lead_id: true,
                lead: { select: { id: true, phone: true, tenant_id: true, is_client: true } },
              },
            },
          },
        },
      },
    });
    if (!contract) throw new NotFoundException('Contrato nao encontrado');
    if (contract.quote.patient.tenant_id !== tenantId) throw new ForbiddenException('Contrato de outro tenant');
    return contract;
  }

  private samePhone(a?: string | null, b?: string | null): boolean {
    if (!a || !b) return false;
    const vb = new Set(brazilPhoneMatchVariants(b));
    return brazilPhoneMatchVariants(a).some((v) => vb.has(v));
  }

  private last4(phone?: string | null): string {
    return (phone || '').replace(/\D/g, '').slice(-4);
  }

  private async defaultCaption(tenantId: string, patientName?: string | null): Promise<string> {
    const tenant = await this.prisma.tenant.findUnique({ where: { id: tenantId }, select: { name: true } }).catch(() => null);
    const clinica = tenant?.name?.trim() || 'a clínica';
    const first = (patientName || '').trim().split(/\s+/)[0] || '';
    return (
      `Olá${first ? `, ${first}` : ''}! 😊\n\n` +
      `Segue em PDF o seu contrato de tratamento com ${clinica}, para você ler com calma.\n\n` +
      `Qualquer dúvida, é só responder esta mensagem.`
    );
  }

  private problemMessage(problem: SendProblem | null, patientPhone?: string | null, leadPhone?: string | null): string | null {
    switch (problem) {
      case 'CONTRACT_INACTIVE': return 'Contrato cancelado/expirado — não dá pra enviar.';
      case 'NO_PHONE': return 'Paciente sem telefone válido no cadastro — adicione o telefone antes de enviar.';
      case 'PHONE_MISMATCH': return `O telefone do cadastro (final ${this.last4(patientPhone)}) é diferente do contato do WhatsApp (final ${this.last4(leadPhone)}) — corrija o cadastro do paciente antes de enviar.`;
      case 'NO_CLINICAL_CHIP': return 'Nenhum WhatsApp Clínica/Comercial cadastrado — o contrato não sai pelo número do Financeiro. Configure em Configurações › WhatsApp.';
      case 'LEAD_WILL_LINK': return 'Paciente ainda sem contato no WhatsApp — o sistema vincula/cria pelo telefone ao enviar.';
      default: return null;
    }
  }

  /** Só leitura (não cria lead nem conversa): o que o modal mostra antes de enviar. */
  async preview(contractId: string, tenantId: string) {
    const contract = await this.loadContract(contractId, tenantId);
    const patient = contract.quote.patient;
    const defaultCaption = await this.defaultCaption(tenantId, patient.name);
    const phoneDigits = toBrazilWhatsappNumber(patient.phone || '');

    let problem: SendProblem | null = null;
    let chip: { purpose: 'CLINICA' | 'COMERCIAL'; label: string } | null = null;
    if (contract.status === 'CANCELLED' || contract.status === 'EXPIRED') problem = 'CONTRACT_INACTIVE';
    else if (!phoneDigits) problem = 'NO_PHONE';
    else {
      if (patient.lead && !this.samePhone(patient.lead.phone, patient.phone)) problem = 'PHONE_MISMATCH';
      // Sem lead ainda: o lead criado no envio nasce cliente → Clínica primeiro.
      const chips = await this.messages.resolvePatientChips(tenantId, patient.lead ? !!patient.lead.is_client : true);
      if (chips[0]) chip = { purpose: chips[0].purpose, label: CHIP_LABEL[chips[0].purpose] };
      if (!problem && !chips.length) problem = 'NO_CLINICAL_CHIP';
      if (!problem && !patient.lead_id) problem = 'LEAD_WILL_LINK';
    }
    return {
      defaultCaption,
      patientName: patient.name,
      phoneLast4: this.last4(patient.phone),
      chip,
      problem,
      problemMessage: this.problemMessage(problem, patient.phone, patient.lead?.phone),
      blocking: !!problem && problem !== 'LEAD_WILL_LINK',
    };
  }

  /** Gera o PDF e envia na conversa de paciente. Lança erro com motivo claro se não sair. */
  async send(contractId: string, tenantId: string, userId: string | undefined, caption: string) {
    const text = (caption || '').trim();
    if (!text) throw new BadRequestException('Escreva a mensagem que vai junto do contrato.');

    const contract = await this.loadContract(contractId, tenantId);
    if (contract.status === 'CANCELLED' || contract.status === 'EXPIRED') {
      throw new BadRequestException(this.problemMessage('CONTRACT_INACTIVE'));
    }
    const patient = contract.quote.patient;
    if (!toBrazilWhatsappNumber(patient.phone || '')) throw new BadRequestException(this.problemMessage('NO_PHONE'));
    // Telefone do cadastro ≠ contato do WhatsApp já vinculado: recusa sem tocar
    // no banco (rechecado depois do vínculo, pro caso de lead novo).
    if (patient.lead && !this.samePhone(patient.lead.phone, patient.phone)) {
      throw new ConflictException(this.problemMessage('PHONE_MISMATCH', patient.phone, patient.lead.phone));
    }
    // Sem nenhum chip clínico não adianta criar lead/conversa — recusa antes.
    if (!(await this.messages.resolvePatientChips(tenantId, true)).length) {
      throw new BadRequestException(this.problemMessage('NO_CLINICAL_CHIP'));
    }

    // Trava ATÔMICA anti-reenvio (clique duplo, dois operadores, duas abas): sob
    // lock por contrato, reserva o envio com um evento WHATSAPP_SENDING ANTES do
    // trabalho lento. Quem chega depois (≤60s) leva 409.
    const claim = await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${contract.id}), 7)`;
      const recent = await tx.contractEvent.findFirst({
        where: {
          contract_id: contract.id,
          event_type: { in: ['WHATSAPP_SENT', 'WHATSAPP_SENDING'] },
          occurred_at: { gte: new Date(Date.now() - 60_000) },
        },
        select: { id: true },
      });
      if (recent) return null;
      return tx.contractEvent.create({
        data: {
          contract_id: contract.id,
          event_type: 'WHATSAPP_SENDING',
          description: 'Enviando PDF no WhatsApp…',
          triggered_by_user_id: userId || null,
        },
        select: { id: true },
      });
    });
    if (!claim) throw new ConflictException('Este contrato acabou de ser enviado — confira na conversa antes de reenviar.');

    try {
      const result = await this.sendClaimed(contract, patient, tenantId, text);
      await this.prisma.contractEvent.update({
        where: { id: claim.id },
        data: {
          event_type: 'WHATSAPP_SENT',
          description: `PDF enviado no WhatsApp (${result.chip.label})`,
          occurred_at: new Date(),
        },
      }).catch((e) => this.logger.warn(`[CONTRACT-WHATSAPP] evento não atualizado (${contract.id}): ${e?.message}`));
      return result;
    } catch (e: any) {
      if (e?.mayHaveBeenDelivered) {
        // Timeout/5xx: pode ter chegado — mantém a trava por mais 60s a partir
        // de AGORA (evita 2×; o operador confere a conversa antes de reenviar).
        await this.prisma.contractEvent.update({
          where: { id: claim.id },
          data: { description: 'Sem resposta do WhatsApp — confira na conversa antes de reenviar', occurred_at: new Date() },
        }).catch(() => {});
      } else {
        // Não saiu com certeza: libera pra tentar de novo.
        await this.prisma.contractEvent.delete({ where: { id: claim.id } }).catch(() => {});
      }
      throw e;
    }
  }

  /**
   * "Enviar via ClickSign": sobe o contrato no ClickSign (ContractsService — status
   * SENT) e manda o link de assinatura na conversa de PACIENTE pelo chip
   * Clínica/Comercial (sendPatientText). Tudo que barra o envio (sem telefone, sem
   * chip clínico, conversa do Financeiro, telefone divergente) é checado ANTES do
   * ClickSign — não deixa contrato SENT sem link. Se o WhatsApp falhar DEPOIS
   * (chip caiu, timeout), o contrato já está no ClickSign: devolve o motivo em
   * `whatsapp` (o link continua no card pra mandar à mão).
   */
  async sendClickSign(contractId: string, tenantId: string, userId: string) {
    const contract = await this.loadContract(contractId, tenantId);
    const patient = contract.quote.patient;
    if (!toBrazilWhatsappNumber(patient.phone || '')) {
      throw new BadRequestException('Paciente sem telefone cadastrado — ClickSign exige WhatsApp pra assinatura');
    }
    if (!(await this.messages.resolvePatientChips(tenantId, true)).length) {
      throw new BadRequestException(this.problemMessage('NO_CLINICAL_CHIP'));
    }
    const leadId = await this.quotes.resolvePatientWhatsappLead(patient.id, tenantId);
    const conversationId = await this.conversations.findOrCreatePatientConversationId(leadId, tenantId);
    if (!conversationId) throw new BadRequestException('Sem caixa de entrada Clínica/Comercial pra esse paciente — configure o WhatsApp da clínica.');
    await this.messages.assertPatientSendable({ conversationId, tenantId, expectedPhone: patient.phone });

    const updated = await this.contracts.sendToClickSign(contractId, tenantId, userId);

    const first = (patient.name || '').trim().split(/\s+/)[0] || 'paciente';
    const text =
      `📝 *Contrato de tratamento*\n\nOlá ${first}!\n\n` +
      `Seu contrato está pronto para assinatura digital.\n\n` +
      `🔒 Assinatura segura e válida juridicamente (Lei 14.063/2020).\n\n` +
      `✍️ *Clique aqui para assinar:*\n${updated.signing_url}`;
    try {
      const sent = await this.messages.sendPatientText({ conversationId, tenantId, text, expectedPhone: patient.phone });
      this.logger.log(`[CONTRACT-CLICKSIGN] link do contrato ${contractId} enviado na conversa ${conversationId} (${sent.purpose})`);
      return { ...updated, whatsapp: { sent: true, conversationId, chip: CHIP_LABEL[sent.purpose] } };
    } catch (e: any) {
      this.logger.warn(`[CONTRACT-CLICKSIGN] contrato ${contractId} no ClickSign, mas o link não saiu no WhatsApp: ${e?.message}`);
      return { ...updated, whatsapp: { sent: false, conversationId, error: e?.message || 'Falha ao enviar pelo WhatsApp' } };
    }
  }

  /** Trabalho do envio (já com a trava pega): lead, conversa, PDF, WhatsApp. */
  private async sendClaimed(
    contract: { id: string },
    patient: { id: string; name: string; phone: string | null },
    tenantId: string,
    text: string,
  ) {
    const leadId = await this.quotes.ensurePatientLead(patient.id, tenantId, 'whatsapp');
    const lead = await this.prisma.lead.findUnique({
      where: { id: leadId },
      select: { id: true, phone: true, tenant_id: true, is_client: true },
    });
    if (!lead || lead.tenant_id !== tenantId) throw new ForbiddenException('Acesso negado a este recurso');
    // Nunca reescreve o telefone salvo: se o cadastro diverge do contato do
    // WhatsApp, o contrato iria pra outro número — bloqueia com o motivo.
    if (!this.samePhone(lead.phone, patient.phone)) {
      throw new ConflictException(this.problemMessage('PHONE_MISMATCH', patient.phone, lead.phone));
    }
    const chips = await this.messages.resolvePatientChips(tenantId, !!lead.is_client);
    if (!chips.length) throw new BadRequestException(this.problemMessage('NO_CLINICAL_CHIP'));

    const conversationId = await this.conversations.findOrCreatePatientConversationId(lead.id, tenantId);
    if (!conversationId) throw new BadRequestException('Sem caixa de entrada Clínica/Comercial pra esse paciente — configure o WhatsApp da clínica.');

    const buffer = await this.contractPdf.generatePdf(contract.id, tenantId);
    if (!isPdfBuffer(buffer)) throw new InternalServerErrorException('Falha ao gerar o PDF do contrato.');
    const slug = (patient.name || 'paciente')
      .normalize('NFD').replace(/[̀-ͯ]/g, '')
      .replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase() || 'paciente';

    const sent = await this.messages.sendPatientFile({
      conversationId,
      tenantId,
      caption: text,
      file: { buffer, mimetype: 'application/pdf', originalname: `contrato-${slug}.pdf`, size: buffer.length },
    });

    this.logger.log(`[CONTRACT-WHATSAPP] contrato ${contract.id} enviado na conversa ${conversationId} (${sent.purpose})`);
    return {
      conversationId,
      messageId: sent.message?.id ?? null,
      chip: { purpose: sent.purpose, label: CHIP_LABEL[sent.purpose] },
    };
  }
}

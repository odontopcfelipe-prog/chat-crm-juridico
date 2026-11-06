/**
 * F6 do laboratório — envio do orçamento de trabalho pelo WhatsApp.
 *
 * No laboratório não há portal do cliente: a mensagem leva o PDF do orçamento
 * (QuotePdfService.generatePdf, que já desenha o orçamento de trabalho para a conta
 * de laboratório) e a legenda com o nome do cliente, o número do orçamento e o nome
 * da conta. A legenda leva também o link da página de aceite on-line do orçamento
 * (proposta-online-laboratorio.ts); se o link não puder ser criado, o PDF sai sozinho. Sai SÓ pela conversa do cliente no chip Atendimento/Comercial
 * (MessagesService.sendPatientFile), nunca pelo chip do Financeiro.
 *
 * Mesma ordem do envio da clínica (QuotesService.sendByWhatsapp): status, telefone,
 * chip, contato e conversa, conferência do envio, PDF, envio, status SENT e versão.
 * Diferenças: sem o PDF o envio é recusado (o PDF é o conteúdo) e as mensagens de
 * erro já saem no texto do laboratório.
 *
 * Função pura (sem provider Nest, sem DI): os serviços chegam por parâmetro, e os
 * imports de serviço são só de tipo.
 */
import { BadRequestException, type Logger } from '@nestjs/common';
import { toBrazilWhatsappNumber } from '@crm/shared';
import type { PrismaService } from '../prisma/prisma.service';
import type { MessagesService } from '../messages/messages.service';
import type { ConversationsService } from '../conversations/conversations.service';
import type { QuotePdfService } from './quote-pdf.service';
import type { QuoteVersionsService } from './quote-versions.service';
import { LAB_API_MESSAGES } from '../business-type/lab-api-messages';
import { trocarTexto } from '../business-type/lab-vocab.interceptor';
import { LAB_ORCAMENTO_WHATSAPP } from './lab-orcamento-textos';
import { LAB_PROPOSTA_ONLINE_WHATSAPP } from './lab-proposta-online-textos';
import { numeroDoOrcamento } from './quote-pdf-laboratorio';

export type DepsDoEnvioDoLaboratorio = {
  prisma: PrismaService;
  messages: MessagesService;
  conversations: ConversationsService;
  pdfService?: QuotePdfService;
  versions?: QuoteVersionsService;
  logger: Logger;
  resolverLead: (patientId: string, tenantId: string) => Promise<string>;
  /** Link da página de aceite do orçamento (proposta-online-laboratorio.ts). */
  criarLink?: (quote: any, tenantId: string) => Promise<string>;
};

function formatBRL(v: unknown): string {
  return Number(v).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

/** Legenda do PDF no WhatsApp (sem link). */
export function legendaDoOrcamentoDoLaboratorio(
  quote: any,
  numero: string,
  nomeDaConta: string | null,
  link: string | null = null,
): string {
  const T = LAB_ORCAMENTO_WHATSAPP;
  const nome = String(quote.patient?.name || '').trim();
  const itens = quote.items?.length || 0;
  const anexos = quote._count?.attachments || 0;
  const validade = quote.valid_until ? new Date(quote.valid_until).toLocaleDateString('pt-BR') : null;
  const linhas = [
    nome ? T.saudacao(nome) : T.saudacaoSemNome,
    '',
    T.pronto(numero, nomeDaConta),
    '',
    T.servicos(itens),
    T.total(formatBRL(quote.total_value)),
  ];
  if (Number(quote.discount_value) > 0) linhas.push(T.desconto(formatBRL(quote.discount_value)));
  if (validade) linhas.push(T.validade(validade));
  if (anexos > 0) linhas.push(T.anexos(anexos));
  if (link) linhas.push(LAB_PROPOSTA_ONLINE_WHATSAPP.linkAntes, link);
  linhas.push(T.fecho);
  return linhas.join('\n');
}

/**
 * Envia o orçamento de trabalho (conta de laboratório). `quote` é o do
 * QuotesService.findOne (paciente com nome e telefone, itens e _count dos anexos).
 */
export async function enviarOrcamentoDoLaboratorio(
  deps: DepsDoEnvioDoLaboratorio,
  quote: any,
  quoteId: string,
  tenantId: string,
  userId?: string,
): Promise<{ ok: true; link: string | null; sent_to: string; status: 'SENT'; conversationId: string }> {
  const { prisma, messages, conversations, pdfService, versions, logger, resolverLead, criarLink } = deps;

  if (!['DRAFT', 'SENT'].includes(quote.status)) {
    throw new BadRequestException(LAB_ORCAMENTO_WHATSAPP.statusNaoReenvia(String(quote.status)));
  }
  if (!toBrazilWhatsappNumber(quote.patient?.phone || '')) {
    throw new BadRequestException(LAB_API_MESSAGES.semTelefoneOrcamento);
  }
  // Sem chip Atendimento/Comercial: recusa ANTES de criar contato/conversa.
  if (!(await messages.resolvePatientChips(tenantId, true)).length) {
    throw new BadRequestException(LAB_API_MESSAGES.semChipOrcamento);
  }
  const leadId = await resolverLead(quote.patient_id, tenantId);
  const conversationId = await conversations.findOrCreatePatientConversationId(leadId, tenantId);
  if (!conversationId) {
    throw new BadRequestException(LAB_API_MESSAGES.semCaixaDeEntrada);
  }
  // Conversa do Financeiro / telefone do cadastro diferente do contato: recusa antes do PDF.
  await messages.assertPatientSendable({ conversationId, tenantId, expectedPhone: quote.patient.phone });

  // O PDF é o conteúdo do envio: sem ele, não manda só o texto.
  let pdf: Buffer | null = null;
  try {
    if (pdfService) pdf = await pdfService.generatePdf(quoteId, tenantId);
  } catch (e) {
    logger.warn(`[LAB-ORCAMENTO] falha ao gerar o PDF do orçamento ${quoteId}: ${(e as Error)?.message ?? e}`);
  }
  if (!pdf || !pdf.length) {
    throw new BadRequestException(LAB_ORCAMENTO_WHATSAPP.semPdf);
  }

  const numero = numeroDoOrcamento(quote);
  const nomeDaConta =
    (await prisma.tenant.findUnique({ where: { id: tenantId }, select: { name: true } }))?.name?.trim() || null;
  // Link de aceite: se falhar, o PDF segue sozinho (o link é um extra, não o conteúdo).
  let link: string | null = null;
  if (criarLink) {
    try {
      link = await criarLink(quote, tenantId);
    } catch (e) {
      logger.warn(`[LAB-ORCAMENTO] link de aceite do orçamento ${quoteId} não saiu: ${(e as Error)?.message ?? e}`);
    }
  }
  const caption = legendaDoOrcamentoDoLaboratorio(quote, numero, nomeDaConta, link);

  let sent: { message: any; instance: string; purpose: 'CLINICA' | 'COMERCIAL' };
  try {
    sent = await messages.sendPatientFile({
      conversationId,
      tenantId,
      caption,
      expectedPhone: quote.patient.phone,
      file: { buffer: pdf, mimetype: 'application/pdf', originalname: `orcamento-${numero}.pdf`, size: pdf.length },
    });
  } catch (e: any) {
    const motivo = trocarTexto(String(e?.message || LAB_ORCAMENTO_WHATSAPP.erroDesconhecido));
    const err = new BadRequestException(LAB_ORCAMENTO_WHATSAPP.falhaEnvio(motivo));
    (err as any).mayHaveBeenDelivered = !!e?.mayHaveBeenDelivered;
    throw err;
  }
  const extId: string | null = sent.message?.external_message_id || null;
  const whatsappMessageId = extId && !extId.startsWith('out_') ? extId : null;

  const wasDraft = quote.status === 'DRAFT';
  await prisma.quote.update({
    where: { id: quoteId },
    data: {
      ...(wasDraft ? { status: 'SENT', sent_at: new Date() } : {}),
      ...(whatsappMessageId ? { whatsapp_message_id: whatsappMessageId } : {}),
    },
  });
  if (wasDraft && versions && userId) {
    await versions
      .createSnapshot(quoteId, userId, 'SEND', LAB_ORCAMENTO_WHATSAPP.versaoEnviada)
      .catch((e: any) => logger.warn(`[VERSION] snapshot SEND-WhatsApp falhou: ${e?.message}`));
  }

  logger.log(
    `[LAB-ORCAMENTO] orçamento ${quoteId} enviado via WhatsApp (conversa ${conversationId}, chip ${sent.instance}/${sent.purpose})`,
  );
  return { ok: true, link, sent_to: quote.patient.phone, status: 'SENT', conversationId };
}

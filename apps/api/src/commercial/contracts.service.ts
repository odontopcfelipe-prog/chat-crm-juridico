import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
  Optional,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ContractPdfService } from './contract-pdf.service';
import { ClicksignService } from '../clicksign/clicksign.service';

/**
 * Onda 14.24 — Servico de gestao de contratos vinculados a Quote.
 *
 * Fluxo (Fase 1, manual):
 *   1. Operador clica "Aprovar e enviar contrato" no painel da proposta aceita
 *      → POST /quotes/:id/contract
 *      → Cria Contract status=DRAFT com template_type inferido pela especialidade
 *      → Cria ContractEvent CREATED
 *
 *   2. Operador clica "Marcar enviado" (manual no Fase 1)
 *      → POST /contracts/:id/send
 *      → status=SENT + ContractEvent SENT
 *
 *   3. Operador opcionalmente marca: "Paciente abriu" / "Paciente assinou" / "Clinica assinou"
 *      → POST /contracts/:id/sign-patient (PATIENT_SIGNED)
 *      → POST /contracts/:id/sign-clinic (SIGNED — final, libera cobranca)
 *
 *   4. Atalho pra valores baixos: "Pular contrato"
 *      → POST /contracts/:id/skip
 *      → skipped=true, cobranca liberada sem assinatura
 *
 * Fase 2 vai trocar os PATCH manuais por webhooks do ClickSign.
 */
@Injectable()
export class ContractsService {
  private readonly logger = new Logger(ContractsService.name);

  constructor(
    private prisma: PrismaService,
    private pdfService: ContractPdfService,
    // Onda 14.24 Fase 2 — ClickSign opcional. Quando configurado, permite
    // sendToClickSign() subir doc + enviar via WhatsApp. Sem ClickSign,
    // contratos sao gerenciados manualmente (Fase 1).
    @Optional() private clicksign?: ClicksignService,
  ) {}

  /**
   * Onda 14.24 — Limiar (em centavos? nao — em reais) abaixo do qual o
   * sistema sugere pular contrato. Operador ainda pode forcar assinatura
   * pra valores baixos. Pode virar config por tenant na Fase 3.
   */
  static SKIP_SUGGESTED_BELOW_BRL = 500;

  /** Infere o tipo de template a partir dos items do quote. Fallback: CLINICO_BASICO. */
  private inferTemplateType(items: Array<{ procedure?: { specialty?: { name?: string | null } | null } | null }>): string {
    const specialtyCounts = new Map<string, number>();
    for (const item of items) {
      const name = item.procedure?.specialty?.name?.toUpperCase() || '';
      if (!name) continue;
      specialtyCounts.set(name, (specialtyCounts.get(name) || 0) + 1);
    }
    // Encontra a especialidade mais frequente
    let maxName = '';
    let maxCount = 0;
    for (const [name, count] of specialtyCounts.entries()) {
      if (count > maxCount) {
        maxName = name;
        maxCount = count;
      }
    }
    if (maxName.includes('ORTOD')) return 'ORTODONTIA';
    if (maxName.includes('IMPLANTE') || maxName.includes('IMPLANTOLOGIA')) return 'IMPLANTE';
    if (maxName.includes('LENTE') || maxName.includes('FACETA')) return 'LENTES';
    return 'CLINICO_BASICO';
  }

  /** Valida que o quote pertence ao tenant e retorna ele com o contrato (se existir). */
  private async assertQuoteAndGet(quoteId: string, tenantId: string) {
    const quote = await this.prisma.quote.findUnique({
      where: { id: quoteId },
      include: {
        patient: { select: { id: true, tenant_id: true } },
        contract: { include: { events: { orderBy: { occurred_at: 'asc' } } } },
        items: {
          select: {
            procedure: { select: { specialty: { select: { name: true } } } },
          },
        },
      },
    });
    if (!quote) throw new NotFoundException('Orcamento nao encontrado');
    if (quote.patient.tenant_id !== tenantId) {
      throw new ForbiddenException('Orcamento de outro tenant');
    }
    return quote;
  }

  private async assertContractAndGet(contractId: string, tenantId: string) {
    const contract = await this.prisma.contract.findUnique({
      where: { id: contractId },
      include: {
        quote: { include: { patient: { select: { tenant_id: true } } } },
        events: { orderBy: { occurred_at: 'asc' } },
      },
    });
    if (!contract) throw new NotFoundException('Contrato nao encontrado');
    if (contract.quote.patient.tenant_id !== tenantId) {
      throw new ForbiddenException('Contrato de outro tenant');
    }
    return contract;
  }

  /** Cria contrato DRAFT pra um Quote ACCEPTED. Falha se ja tem contrato.
   *  Onda 14.30 — aceita opcoes adicionais: selected_documents (extras como
   *  TCLE/USO_IMAGEM/LGPD/GARANTIA/RESPONSAVEL_LEGAL). Contrato principal
   *  (template_type inferido) e sempre incluido. */
  async createForQuote(
    quoteId: string,
    tenantId: string,
    userId: string,
    opts?: { selected_documents?: string[] },
  ) {
    const quote = await this.assertQuoteAndGet(quoteId, tenantId);
    if (quote.status !== 'ACCEPTED') {
      throw new BadRequestException(
        `Contrato so pode ser criado pra orcamento ACEITO (status atual: ${quote.status})`,
      );
    }
    if (quote.contract) {
      throw new BadRequestException('Este orcamento ja tem um contrato — abra o existente');
    }

    const templateType = this.inferTemplateType(quote.items);
    // Onda 14.30 — sanitiza array: aceita so strings, dedup, max 20 itens
    // pra evitar payload abusivo.
    const docs = Array.isArray(opts?.selected_documents)
      ? Array.from(new Set(
          opts!.selected_documents.filter((d): d is string => typeof d === 'string').slice(0, 20),
        ))
      : [];

    const contract = await this.prisma.contract.create({
      data: {
        quote_id: quoteId,
        template_type: templateType,
        selected_documents: docs,
        status: 'DRAFT',
        created_by_user_id: userId,
        events: {
          create: {
            event_type: 'CREATED',
            description: docs.length > 0
              ? `Documento gerado: ${templateType} + ${docs.length} extras (${docs.join(', ')})`
              : `Documento gerado a partir do template ${templateType}`,
            triggered_by_user_id: userId,
          },
        },
      },
      include: { events: { orderBy: { occurred_at: 'asc' } } },
    });

    this.logger.log(`[Contract] created ${contract.id} pra quote ${quoteId} (template=${templateType}, docs=[${docs.join(',')}])`);
    return contract;
  }

  /**
   * Onda 14.24 — Transicao generica de status com evento associado.
   * Centraliza validacao (transicoes invalidas viram BadRequest).
   */
  private async transitionStatus(
    contractId: string,
    tenantId: string,
    userId: string | null,
    targetStatus: string,
    eventType: string,
    description: string,
    extraData: Record<string, unknown> = {},
  ) {
    const contract = await this.assertContractAndGet(contractId, tenantId);

    // Cancelled/Expired sao terminais — nao da pra voltar
    if (contract.status === 'CANCELLED' || contract.status === 'EXPIRED') {
      throw new BadRequestException(
        `Contrato esta ${contract.status} — nao pode mais ser alterado. Crie um novo.`,
      );
    }
    // Skipped tambem e terminal pra fins de assinatura
    if (contract.skipped && eventType !== 'CANCELLED') {
      throw new BadRequestException('Contrato foi pulado — nao precisa mais de assinatura');
    }

    const now = new Date();
    const data: Record<string, unknown> = { status: targetStatus, ...extraData };

    const updated = await this.prisma.contract.update({
      where: { id: contractId },
      data: {
        ...data,
        events: {
          create: {
            event_type: eventType,
            description,
            triggered_by_user_id: userId,
            occurred_at: now,
          },
        },
      },
      include: { events: { orderBy: { occurred_at: 'asc' } } },
    });

    this.logger.log(
      `[Contract] ${contractId} ${contract.status} -> ${targetStatus} (event=${eventType})`,
    );
    return updated;
  }

  /** Marca como enviado (operador clica "Marcar enviado" manualmente). */
  async markSent(contractId: string, tenantId: string, userId: string) {
    return this.transitionStatus(
      contractId,
      tenantId,
      userId,
      'SENT',
      'SENT',
      'Enviado ao paciente (manual)',
      { sent_at: new Date() },
    );
  }

  /**
   * Onda 14.24 Fase 2 — Envia contrato via ClickSign:
   *   1. Gera PDF via ContractPdfService (template por especialidade)
   *   2. Sobe pro ClickSign + cria signer (paciente) com phone + selfie
   *   3. Persiste clicksign_document_id, signing_url, sent_at, status=SENT
   *   4. Cria ContractEvent SENT
   *   5. Tenta enviar link via WhatsApp pro paciente
   *
   * Quando paciente assina, webhook ClickSign chega em
   * ClicksignService.handleNewContractWebhook → marca SIGNED automaticamente.
   *
   * Pre-condicoes:
   *   - Contract status DRAFT (nao reenviar SENT/OPENED/etc — usar cancel + criar novo)
   *   - Paciente com phone valido (ClickSign exige whatsapp auth)
   *   - ClickSign configurado no tenant (apiToken setado)
   */
  async sendToClickSign(contractId: string, tenantId: string, userId: string) {
    if (!this.clicksign) {
      throw new BadRequestException('ClickSign nao esta disponivel neste ambiente');
    }
    const contract = await this.assertContractAndGet(contractId, tenantId);
    if (contract.status !== 'DRAFT') {
      throw new BadRequestException(
        `Contrato ja foi enviado (status: ${contract.status}). Cancele e crie um novo se precisar reenviar.`,
      );
    }
    if (contract.skipped) {
      throw new BadRequestException('Contrato foi pulado — nao precisa enviar');
    }

    // Le paciente pra obter dados do signer
    const quote = await this.prisma.quote.findUnique({
      where: { id: contract.quote_id },
      include: {
        patient: { select: { id: true, name: true, email: true, phone: true } },
      },
    });
    if (!quote) throw new NotFoundException('Orcamento do contrato sumiu');
    if (!quote.patient.phone) {
      throw new BadRequestException(
        'Paciente sem telefone cadastrado — ClickSign exige WhatsApp pra assinatura',
      );
    }
    const signerEmail = quote.patient.email || `paciente-${quote.patient.id}@noemail.local`;

    // Gera o PDF do contrato
    const pdfBuffer = await this.pdfService.generatePdf(contractId, tenantId);
    const filename = `contrato-${contractId.substring(0, 8)}.pdf`;

    // Sobe no ClickSign + cria signer + envia WhatsApp
    const csResult = await this.clicksign.sendDocumentForSignature({
      buffer: pdfBuffer,
      filename,
      signerName: quote.patient.name || 'Paciente',
      signerEmail,
      signerPhone: quote.patient.phone,
      signerMessage:
        'Por favor, leia e assine o contrato de prestacao de servicos odontologicos.',
      whatsappMessage:
        `📝 *Contrato de tratamento*\n\nOlá ${(quote.patient.name || 'paciente').split(' ')[0]}!\n\n` +
        `Seu contrato está pronto para assinatura digital.\n\n` +
        `🔒 Assinatura segura e válida juridicamente (Lei 14.063/2020).\n\n` +
        `✍️ *Clique aqui para assinar:*\n{{signingUrl}}`.replace('{{signingUrl}}', ''), // signingUrl preenchido pelo metodo abaixo
    });

    // Persiste os keys ClickSign + marca como SENT (atomico)
    const now = new Date();
    const updated = await this.prisma.contract.update({
      where: { id: contractId },
      data: {
        status: 'SENT',
        sent_at: now,
        clicksign_document_id: csResult.documentKey,
        signing_url: csResult.signingUrl,
        events: {
          create: {
            event_type: 'SENT',
            description: `Enviado via ClickSign (doc: ${csResult.documentKey.substring(0, 8)})`,
            triggered_by_user_id: userId,
            occurred_at: now,
          },
        },
      },
      include: { events: { orderBy: { occurred_at: 'asc' } } },
    });

    this.logger.log(
      `[Contract] ${contractId} enviado via ClickSign (doc=${csResult.documentKey})`,
    );
    return updated;
  }

  /** Marca que o paciente abriu o documento. Fase 2: webhook ClickSign. */
  async markOpened(contractId: string, tenantId: string, userId: string) {
    return this.transitionStatus(
      contractId,
      tenantId,
      userId,
      'OPENED',
      'OPENED',
      'Paciente abriu o documento (manual)',
      { opened_at: new Date() },
    );
  }

  /** Marca que o paciente assinou (falta a clinica). */
  async markPatientSigned(contractId: string, tenantId: string, userId: string) {
    return this.transitionStatus(
      contractId,
      tenantId,
      userId,
      'PATIENT_SIGNED',
      'PATIENT_SIGNED',
      'Paciente assinou (manual)',
      { patient_signed_at: new Date() },
    );
  }

  /** Marca que a clinica assinou — final. Libera geracao de cobranca. */
  async markClinicSigned(contractId: string, tenantId: string, userId: string) {
    const now = new Date();
    return this.transitionStatus(
      contractId,
      tenantId,
      userId,
      'SIGNED',
      'CLINIC_SIGNED',
      'Clinica assinou — contrato finalizado',
      { clinic_signed_at: now, signed_at: now },
    );
  }

  /** Cancela o contrato (operador clica "Cancelar e refazer"). */
  async cancel(contractId: string, tenantId: string, userId: string, reason?: string) {
    return this.transitionStatus(
      contractId,
      tenantId,
      userId,
      'CANCELLED',
      'CANCELLED',
      reason ? `Cancelado: ${reason}` : 'Cancelado',
      {
        cancelled_at: new Date(),
        cancellation_reason: reason || null,
      },
    );
  }

  /**
   * Pula o contrato pra valores baixos (operador assume risco). Libera
   * geracao de cobranca direto. Audit: skipped_reason preserva justificativa.
   */
  async skip(contractId: string, tenantId: string, userId: string, reason?: string) {
    const contract = await this.assertContractAndGet(contractId, tenantId);
    if (contract.status === 'SIGNED') {
      throw new BadRequestException('Contrato ja esta assinado — nao precisa pular');
    }
    if (contract.skipped) {
      throw new BadRequestException('Contrato ja foi pulado');
    }

    const updated = await this.prisma.contract.update({
      where: { id: contractId },
      data: {
        skipped: true,
        skipped_at: new Date(),
        skipped_reason: reason || null,
        events: {
          create: {
            event_type: 'SKIPPED',
            description: reason ? `Pulado: ${reason}` : 'Pulado pelo operador',
            triggered_by_user_id: userId,
          },
        },
      },
      include: { events: { orderBy: { occurred_at: 'asc' } } },
    });

    this.logger.log(`[Contract] ${contractId} SKIPPED by user ${userId} (reason=${reason || 'none'})`);
    return updated;
  }

  /** Retorna o contrato + events. */
  async findOne(contractId: string, tenantId: string) {
    return this.assertContractAndGet(contractId, tenantId);
  }

  /** Retorna o contrato vinculado a um quote (ou null se nao tiver). */
  async findByQuote(quoteId: string, tenantId: string) {
    const quote = await this.assertQuoteAndGet(quoteId, tenantId);
    return quote.contract; // pode ser null
  }

  /**
   * Onda 14.24 — Helper usado pelo treatment-plan-billing (gate antes de
   * gerar cobranca). Permite cobrar se:
   *  - Nao ha contrato (operador escolheu nao criar nenhum)
   *  - Contrato SIGNED (assinado)
   *  - Contrato SKIPPED (operador pulou explicitamente)
   * Bloqueia se contrato esta em qualquer estado pendente (DRAFT/SENT/OPENED/PATIENT_SIGNED).
   */
  async isBillingAllowed(quoteId: string): Promise<{ allowed: boolean; reason?: string }> {
    const contract = await this.prisma.contract.findUnique({
      where: { quote_id: quoteId },
    });
    if (!contract) return { allowed: true }; // sem contrato = livre
    if (contract.skipped) return { allowed: true };
    if (contract.status === 'SIGNED') return { allowed: true };
    if (contract.status === 'CANCELLED' || contract.status === 'EXPIRED') {
      return {
        allowed: false,
        reason: `Contrato esta ${contract.status} — crie um novo ou pule pra liberar cobranca`,
      };
    }
    return {
      allowed: false,
      reason: `Contrato precisa ser assinado antes de cobrar (status atual: ${contract.status})`,
    };
  }
}

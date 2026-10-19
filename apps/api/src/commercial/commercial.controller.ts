import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  Query,
  UseGuards,
  Request,
  Res,
  BadRequestException,
  NotFoundException,
  ForbiddenException,
  InternalServerErrorException,
  UseInterceptors,
  UploadedFile,
  Logger,
} from '@nestjs/common';
import type { Response } from 'express';
import { FileInterceptor } from '@nestjs/platform-express';
// Onda 17.52 — Etapa 1 do enforcement: escrita de orçamento/proposta/venda
// exige a permissão `manage_proposals` (antes qualquer logado escrevia/aprovava).
import { RequiresPermission, PermissionsGuard } from '../auth/decorators/requires-permission.decorator';
// Out/2026 — Dentista monta a avaliação (create_evaluation) só dos pacientes dele.
import { PrismaService } from '../prisma/prisma.service';
import { isAdminRole, isOwnPatient, restrictedPatientOwner } from '../auth/patient-scope';
// Fase 0 — permissão OU (ADMIN sempre passa), checada dentro do handler.
import { assertAnyPermission, negarPermissao, temAlgumaPermissao } from '../auth/require-any-permission';
// Fase 0 — rotas de plano só para ADMIN (RolesGuard é APP_GUARD global).
import { Roles } from '../auth/decorators/roles.decorator';
import { registrarAuditoria } from '../common/utils/audit-log.util';
import { Throttle } from '@nestjs/throttler';
import { QuotesService } from './quotes.service';
import { QuotePdfService } from './quote-pdf.service';
import { QuoteTemplatesService } from './quote-templates.service';
import type {
  CreateTemplateDto,
  UpdateTemplateDto,
} from './quote-templates.service';
import { QuoteCouponsService } from './quote-coupons.service';
import type { CreateCouponDto, UpdateCouponDto } from './quote-coupons.service';
import { QuoteAttachmentsService } from './quote-attachments.service';
import { QuoteVersionsService } from './quote-versions.service';
import { TreatmentPlansService } from './treatment-plans.service';
import { TreatmentPlanContractService } from './treatment-plan-contract.service';
import { TreatmentPlanBillingService } from './treatment-plan-billing.service';
import { DownPaymentFlowService } from './down-payment-flow.service';
import { AsaasClient } from '../payment-gateway/asaas/asaas-client';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { Authenticated } from '../auth/decorators/authenticated.decorator';
import type { AuthUser } from '../auth/decorators/authenticated.decorator';
import { Public } from '../auth/decorators/public.decorator';
import {
  CreateQuoteDto,
  UpdateQuoteDto,
  CreateQuoteItemDto,
  UpdateQuoteItemDto,
  OverrideItemPriceDto,
  RejectQuoteDto,
  SendContractWhatsappDto,
  SaveCounterProposalDto,
  CreditCheckSimulateDto,
  ApplyFinancingDto,
  ApproveAndBillDto,
  VendaBalcaoDto,
  AddBonusDto,
  UpdateTreatmentPlanDto,
  UpdateTreatmentPlanItemDto,
  ExecuteTreatmentPlanItemDto,
} from './dto/commercial.dto';
import { CreditCheckService } from './credit-check.service';
import { ContractsService } from './contracts.service';
import { ContractPdfService, isPdfBuffer } from './contract-pdf.service';
import { ContractWhatsappService } from './contract-whatsapp.service';

/**
 * Onda 2.1 — Migracao progressiva @Request() req: any -> @Authenticated() user.
 *
 * Endpoints de Quote ja migrados (servem de modelo):
 *   createQuote, listQuotes, findQuote, updateQuote, removeQuote,
 *   listDeletedQuotes, restoreQuote
 *
 * TODO migrar restante do controller (templates, coupons, attachments,
 * versions, treatment-plans). Padrao:
 *   - Trocar @Request() req: any por @Authenticated() user: AuthUser
 *   - Remover boilerplate "if (!tenantId) throw" (decorator ja garante)
 *   - Usar user.tenant_id e user.id direto
 */

@UseGuards(JwtAuthGuard)
@Controller()
export class CommercialController {
  // Fase 0 — só pra registrar campos ignorados (não é provider: não mexe no grafo de DI).
  private readonly logger = new Logger(CommercialController.name);

  constructor(
    private readonly quotesService: QuotesService,
    private readonly pdfService: QuotePdfService,
    private readonly templatesService: QuoteTemplatesService,
    private readonly couponsService: QuoteCouponsService,
    private readonly attachmentsService: QuoteAttachmentsService,
    private readonly versionsService: QuoteVersionsService,
    private readonly plansService: TreatmentPlansService,
    private readonly contractService: TreatmentPlanContractService,
    private readonly billingService: TreatmentPlanBillingService,
    private readonly downPaymentFlow: DownPaymentFlowService,
    private readonly creditCheckService: CreditCheckService,
    private readonly contractsService: ContractsService,
    private readonly contractPdfService: ContractPdfService,
    private readonly contractWhatsapp: ContractWhatsappService,
    // Onda 17.32.71 — era da "Venda Rapida com Especie" (POST /venda-rapida, apagado na
    // Fase 0). Fica injetado de propósito: tirar mexeria no grafo de DI.
    private readonly asaasClient: AsaasClient,
    private readonly prisma: PrismaService,
  ) {}

  // ─── Out/2026 — Avaliação do Dentista (create_evaluation) ─────────────────
  //
  // O dentista MONTA o orçamento pela aba Avaliação (procedimentos/dentes) mas
  // não negocia: sem manage_proposals ele não vê valores (SensitiveDataInterceptor),
  // não mexe em preço/desconto/pagamento, só apaga rascunho, e só nos pacientes
  // da carteira dele. As rotas de avaliação aceitam manage_proposals OU
  // create_evaluation; as de negociação/envio continuam só manage_proposals.

  /** true = só monta avaliação (tem create_evaluation, não tem manage_proposals). */
  private async isEvaluationOnly(user: { id: string; roles?: string[] }): Promise<boolean> {
    if (isAdminRole(user?.roles)) return false;
    const perms = await PermissionsGuard.permissionsFor(this.prisma, user.id, user.roles ?? []);
    return !perms.has('manage_proposals') && perms.has('create_evaluation');
  }

  /** Usuário restrito à carteira: o orçamento tem que ser de paciente dele. */
  private async assertQuoteInScope(user: AuthUser, quoteId: string) {
    const owner = await restrictedPatientOwner(this.prisma, user);
    if (!owner) return;
    const q = await this.prisma.quote.findUnique({ where: { id: quoteId }, select: { patient_id: true } });
    if (!q) return; // o service devolve o 404 de sempre
    if (!(await isOwnPatient(this.prisma, user.tenant_id, owner, q.patient_id))) {
      throw new ForbiddenException('Orçamento de paciente fora da sua carteira');
    }
  }

  private async assertQuoteItemInScope(user: AuthUser, itemId: string) {
    const owner = await restrictedPatientOwner(this.prisma, user);
    if (!owner) return;
    const it = await this.prisma.quoteItem.findUnique({
      where: { id: itemId },
      select: { quote: { select: { patient_id: true } } },
    });
    if (!it) return;
    if (!(await isOwnPatient(this.prisma, user.tenant_id, owner, it.quote.patient_id))) {
      throw new ForbiddenException('Orçamento de paciente fora da sua carteira');
    }
  }

  /** Campos de preço/pagamento que quem só monta avaliação não pode mandar. */
  private static readonly EVAL_ITEM_BLOCKED = ['unit_price', 'payment_method', 'installments_count'] as const;

  private stripItemPricing<T extends object>(dto: T): T {
    const clean: Record<string, unknown> = { ...(dto as Record<string, unknown>) };
    for (const k of CommercialController.EVAL_ITEM_BLOCKED) delete clean[k];
    return clean as T;
  }

  // ─── Quotes ───────────────────────────────────────────────────

  // ─── Quote endpoints — Onda 2.1: migrados pra @Authenticated() ────────

  @RequiresPermission('manage_proposals', 'create_evaluation')
  @Post('patients/:patientId/quotes')
  async createQuote(
    @Param('patientId') patientId: string,
    @Body() body: CreateQuoteDto,
    @Authenticated() user: AuthUser,
  ) {
    let dto = body;
    if (await this.isEvaluationOnly(user)) {
      // Só monta: título/observação + procedimentos (preço sai da tabela).
      dto = {
        title: body.title,
        notes: body.notes,
        items: body.items?.map((i) => this.stripItemPricing(i)),
      } as CreateQuoteDto;
    }
    return this.quotesService.create(patientId, user.tenant_id, user.id, dto);
  }

  /**
   * Onda 3.1 (Fase 25) — Pega DRAFT existente do paciente ou cria novo.
   * Usado pelo OdontogramaTab quando dentista adiciona procedimento via
   * click em dente. Evita race condition + descoberta manual.
   */
  @RequiresPermission('manage_proposals', 'create_evaluation')
  @Post('patients/:patientId/quotes/draft-or-create')
  getOrCreateDraft(
    @Param('patientId') patientId: string,
    @Authenticated() user: AuthUser,
  ) {
    return this.quotesService.getOrCreateDraft(
      patientId,
      user.tenant_id,
      user.id,
    );
  }

  @RequiresPermission('manage_proposals', 'view_proposals', 'create_evaluation')
  @Get('patients/:patientId/quotes')
  listQuotes(
    @Param('patientId') patientId: string,
    @Authenticated() user: AuthUser,
  ) {
    return this.quotesService.findByPatient(patientId, user.tenant_id);
  }

  /**
   * Closing Board — kanban dedicado à fase de fechamento (orçamentos SENT)
   * agrupados em 6 colunas: LENTES_PORCELANA, FACETAS_RESINA, IMPLANTE,
   * ORTODONTIA, HARMONIZACAO_FACIAL, OUTROS. Frontend: /atendimento/fechamentos.
   *
   * ⚠️ DEVE vir ANTES de @Get('quotes/:id') — caso contrário 'closing-board'
   * é capturado como :id e o handler retorna "Orçamento não encontrado".
   */
  @RequiresPermission('manage_proposals', 'view_proposals')
  @Get('quotes/closing-board')
  quotesClosingBoard(@Authenticated() user: AuthUser) {
    return this.quotesService.getClosingBoard(user.tenant_id);
  }

  /**
   * Dashboard funil — counts/valores por status + conversao + expirando.
   *
   * ⚠️ Onda 15 (etapa 19.1) — DEVE vir ANTES de @Get('quotes/:id'), pelo
   * mesmo motivo do closing-board. Antes estava la embaixo (linha ~439)
   * e era capturado como :id='dashboard' → "Orcamento nao encontrado".
   */
  @RequiresPermission('manage_proposals', 'view_proposals')
  @Get('quotes/dashboard')
  quotesDashboard(
    @Request() req: any,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    const tenantId = req.user?.tenant_id;
    if (!tenantId) throw new BadRequestException('tenant_id ausente');
    return this.quotesService.getDashboardStats(tenantId, { from, to });
  }

  /**
   * Rotas LITERAIS de quotes — DEVEM vir ANTES de @Get('quotes/:id').
   * No NestJS as rotas casam por ORDEM de declaracao; se 'quotes/deleted' ou
   * 'quotes/archived' ficarem depois de :id, a request bate em findQuote
   * (id='deleted'/'archived') → "Orcamento nao encontrado" e as listas nunca
   * carregam. (Mesmo bug do dashboard de afiliados, commit 86d1f4ef.)
   */
  /** Onda 25.6 — Lista orcamentos soft-deletados nos ultimos 30 dias (admin) */
  @RequiresPermission('manage_proposals')
  @Get('quotes/deleted')
  listDeletedQuotes(@Authenticated() user: AuthUser) {
    return this.quotesService.listDeleted(user.tenant_id);
  }

  /** Onda 17.32.38 — Lista orçamentos arquivados do tenant. */
  @RequiresPermission('manage_proposals', 'view_proposals')
  @Get('quotes/archived')
  listArchivedQuotes(@Authenticated() user: AuthUser) {
    return this.quotesService.listArchivedQuotes(user.tenant_id);
  }

  /**
   * Journey Board — pipeline pós-venda (Jornada do paciente → "Progresso").
   * Vendas FECHADAS (ACCEPTED) agrupadas por etapa do tratamento (a agendar /
   * agendado / em tratamento / concluído). Frontend: /atendimento/progresso.
   *
   * ⚠️ DEVE vir ANTES de @Get('quotes/:id') — senão 'journey-board' é
   * capturado como :id e retorna "Orçamento não encontrado".
   */
  @RequiresPermission('manage_proposals', 'view_proposals')
  @Get('quotes/journey-board')
  quotesJourneyBoard(@Authenticated() user: AuthUser) {
    return this.quotesService.getJourneyBoard(user.tenant_id);
  }

  // Ala de Ortodontia (Jornada do paciente) — quadro por dentista responsável.
  // ⚠️ Também DEVE vir ANTES de @Get('quotes/:id') (senão vira :id).
  @RequiresPermission('manage_proposals', 'view_proposals')
  @Get('quotes/ortho-board')
  quotesOrthoBoard(@Authenticated() user: AuthUser) {
    return this.quotesService.getOrthoBoard(user.tenant_id);
  }

  // Alta de ortodontia pra paciente SEM plano de ortô (veio só pela agenda) — botão ✓
  // da Ortodontia. Quem tem plano finaliza por POST /treatment-plans/finalize.
  @RequiresPermission('manage_proposals')
  @Post('quotes/ortho-board/alta')
  orthoAlta(@Body() body: { patient_id?: string }, @Authenticated() user: AuthUser) {
    if (!body?.patient_id) throw new BadRequestException('Informe o paciente');
    return this.quotesService.markOrthoAlta(user.tenant_id, body.patient_id, user.id);
  }

  // Stand by de ortodontia (⏸/▶ no card da Ortodontia): pausa/retoma o plano de ortô
  // (ou marca o paciente sem plano). pausar=false retoma.
  @RequiresPermission('manage_proposals')
  @Post('quotes/ortho-board/pausa')
  orthoPausa(@Body() body: { patient_id?: string; pausar?: boolean }, @Authenticated() user: AuthUser) {
    if (!body?.patient_id) throw new BadRequestException('Informe o paciente');
    return this.quotesService.setOrthoPause(user.tenant_id, body.patient_id, body.pausar !== false, user.id, isAdminRole(user.roles));
  }

  // Disparos "Equipe → Pacientes sem agendamento" (geral e ?kind=orto): prévia + teste.
  // A prévia também abre pra quem usa o Progresso/Ortodontia (botão "Avisar ADMs") —
  // mostra os mesmos pacientes que esses quadros já mostram.
  @RequiresPermission('view_marketing', 'manage_proposals', 'view_proposals')
  @Get('pacientes-sem-agendamento/preview')
  semAgendamentoPreview(@Query('kind') kind: string | undefined, @Authenticated() user: AuthUser) {
    return kind === 'orto'
      ? this.quotesService.buildOrtoSemAgendamentoDigest(user.tenant_id)
      : this.quotesService.buildSemAgendamentoDigest(user.tenant_id);
  }

  @RequiresPermission('view_marketing')
  @Post('pacientes-sem-agendamento/test')
  semAgendamentoTest(@Body() body: { phone?: string; kind?: string }, @Authenticated() user: AuthUser) {
    if (!body?.phone) throw new BadRequestException('Informe um número pra testar');
    return this.quotesService.sendSemAgendamentoTest(user.tenant_id, body.phone, body.kind);
  }

  // Botão manual "Avisar ADMs" (Progresso / Ortodontia): ADMs que recebem + envio agora
  // pra todos ou um (admin_id). Independe do toggle do disparo automático.
  @RequiresPermission('manage_proposals', 'view_proposals', 'view_marketing')
  @Get('pacientes-sem-agendamento/admins')
  semAgendamentoAdmins(@Authenticated() user: AuthUser) {
    return this.quotesService.listResumoAdmins(user.tenant_id);
  }

  @RequiresPermission('manage_proposals', 'view_marketing')
  @Throttle({ default: { ttl: 60000, limit: 5 } })
  @Post('pacientes-sem-agendamento/send')
  semAgendamentoSend(
    @Body() body: { kind?: string; admin_id?: string },
    @Authenticated() user: AuthUser,
  ) {
    return this.quotesService.sendSemAgendamentoManual(user.tenant_id, body?.kind, body?.admin_id || undefined);
  }

  @RequiresPermission('manage_proposals', 'view_proposals', 'create_evaluation')
  @Get('quotes/:id')
  async findQuote(@Param('id') id: string, @Authenticated() user: AuthUser) {
    await this.assertQuoteInScope(user, id);
    return this.quotesService.findOne(id, user.tenant_id);
  }

  @RequiresPermission('manage_proposals', 'create_evaluation')
  @Patch('quotes/:id')
  async updateQuote(
    @Param('id') id: string,
    @Body() body: UpdateQuoteDto,
    @Authenticated() user: AuthUser,
  ) {
    let dto: UpdateQuoteDto = body;
    if (await this.isEvaluationOnly(user)) {
      await this.assertQuoteInScope(user, id);
      // Só nome/prioridade/observação — desconto, pagamento, validade, afiliado
      // e visibilidade em Propostas são da negociação (manage_proposals).
      dto = {} as UpdateQuoteDto;
      if (body.title !== undefined) dto.title = body.title;
      if (body.priority !== undefined) dto.priority = body.priority;
      if (body.notes !== undefined) dto.notes = body.notes;
    }
    return this.quotesService.update(id, user.tenant_id, dto as any);
  }

  @RequiresPermission('manage_proposals', 'create_evaluation')
  @Delete('quotes/:id')
  async removeQuote(@Param('id') id: string, @Authenticated() user: AuthUser) {
    if (await this.isEvaluationOnly(user)) {
      await this.assertQuoteInScope(user, id);
      const q = await this.prisma.quote.findUnique({ where: { id }, select: { status: true } });
      if (q && q.status !== 'DRAFT') {
        throw new ForbiddenException('Só dá pra apagar orçamento em rascunho — os enviados ficam com a recepção');
      }
    }
    return this.quotesService.remove(id, user.tenant_id, user.id);
  }

  /** Onda 25.6 — Restaura orcamento soft-deletado (volta pra listagem normal) */
  @RequiresPermission('manage_proposals')
  @Post('quotes/:id/restore')
  restoreQuote(@Param('id') id: string, @Authenticated() user: AuthUser) {
    return this.quotesService.restore(id, user.tenant_id);
  }

  @RequiresPermission('manage_proposals')
  @Post('quotes/:id/send')
  sendQuote(@Param('id') id: string, @Request() req: any) {
    const tenantId = req.user?.tenant_id;
    if (!tenantId) throw new BadRequestException('tenant_id ausente');
    return this.quotesService.send(id, tenantId, req.user?.id);
  }

  @RequiresPermission('manage_proposals')
  @Post('quotes/:id/accept')
  acceptQuote(@Param('id') id: string, @Request() req: any) {
    const tenantId = req.user?.tenant_id;
    if (!tenantId) throw new BadRequestException('tenant_id ausente');
    return this.quotesService.accept(id, tenantId, req.user?.id);
  }

  /**
   * Onda 18.x — MIGRACAO ASAAS: aceita a proposta e ativa o plano SEM gerar
   * cobranca (paciente ja tem os boletos importados). So registra os
   * procedimentos pro dentista validar. Nao conta como venda/afiliado.
   */
  @RequiresPermission('manage_proposals')
  @Post('quotes/:id/accept-no-charge')
  acceptQuoteNoCharge(@Param('id') id: string, @Request() req: any) {
    const tenantId = req.user?.tenant_id;
    if (!tenantId) throw new BadRequestException('tenant_id ausente');
    return this.quotesService.acceptNoCharge(id, tenantId, req.user?.id);
  }

  /**
   * Onda 4.3 (Fase 25) — Track view do portal (publico, sem auth).
   * Chamado pelo frontend do portal quando paciente abre orcamento.
   * Incrementa portal_view_count + atualiza portal_last_viewed_at.
   */
  @Public()
  @Post('quotes/:id/track-view')
  trackQuoteView(@Param('id') id: string) {
    return this.quotesService.trackPortalView(id);
  }

  /**
   * Onda 4.1 (Fase 25) — Aprovar SO ALGUNS items do orcamento.
   * Body: { item_ids: string[] }
   * Cria novo Quote ACCEPTED + TreatmentPlan com items selecionados.
   * Original vira REJECTED com motivo automatico (preserva historico).
   */
  @RequiresPermission('manage_proposals')
  @Post('quotes/:id/accept-partial')
  acceptPartialQuote(
    @Param('id') id: string,
    @Body() body: { item_ids?: string[] },
    @Authenticated() user: AuthUser,
  ) {
    if (!Array.isArray(body?.item_ids) || body.item_ids.length === 0) {
      throw new BadRequestException(
        'item_ids[] eh obrigatorio (selecione ao menos 1)',
      );
    }
    return this.quotesService.acceptPartial(
      id,
      user.tenant_id,
      body.item_ids,
      user.id,
    );
  }

  /**
   * Onda 7.2 — Aprovar items IN-PLACE (no MESMO orcamento, sem split).
   * Body: { item_ids: string[] }
   * Marca approved_at = now() nos items selecionados. Items pendentes
   * ficam visiveis na lista pra aprovacao futura. Sem criar novo quote,
   * sem mexer em TreatmentPlan/Installments. Substitui o fluxo antigo
   * (accept-partial) que dividia em 2 quotes.
   */
  @RequiresPermission('manage_proposals')
  @Post('quotes/:id/approve-items')
  approveItems(
    @Param('id') id: string,
    @Body() body: { item_ids?: string[] },
    @Authenticated() user: AuthUser,
  ) {
    if (!Array.isArray(body?.item_ids) || body.item_ids.length === 0) {
      throw new BadRequestException(
        'item_ids[] eh obrigatorio (selecione ao menos 1)',
      );
    }
    return this.quotesService.approveItems(
      id,
      user.tenant_id,
      body.item_ids,
    );
  }

  /**
   * Onda 10 — Salva contraproposta como linha em Quote.notes.
   * Frontend envia payment_label (ex: "PIX à vista", "6x no cartão") e
   * final_value (ja com desconto/juros aplicados). Note e opcional.
   */
  @RequiresPermission('manage_proposals')
  @Post('quotes/:id/counter-proposal')
  saveCounterProposal(
    @Param('id') id: string,
    @Body() dto: SaveCounterProposalDto,
    @Authenticated() user: AuthUser,
  ) {
    return this.quotesService.saveCounterProposal(id, user.tenant_id, {
      payment_label: dto.payment_label,
      final_value: Number(dto.final_value),
      note: dto.note,
    });
  }

  /**
   * Onda 12 — Simula consulta de credito pro Financiamento Banco PASSOS.
   * MVP mock — decisao em ~1.5s baseada em regras renda × parcela.
   * Em producao: substituir credit-check.service por integracao Serasa.
   */
  @RequiresPermission('manage_proposals')
  @Post('credit-check/simulate')
  simulateCreditCheck(@Body() dto: CreditCheckSimulateDto, @Authenticated() user: AuthUser) {
    return this.creditCheckService.simulate({
      cpf: dto.cpf,
      tenantId: user.tenant_id,
      nome: dto.nome,
      data_nascimento: dto.data_nascimento,
      renda_mensal: Number(dto.renda_mensal),
      telefone: dto.telefone,
      profissao: dto.profissao,
      parcela_alvo: Number(dto.parcela_alvo),
      parcelas: dto.parcelas,
      valor_total: Number(dto.valor_total),
    });
  }

  /**
   * Onda 13 — Adiciona bônus de fechamento ao quote.
   * Quando type=DESCONTO_EXTRA, aplica desconto adicional ao quote (recalcula
   * total). Demais tipos ficam como texto no historico.
   */
  @RequiresPermission('manage_proposals')
  @Post('quotes/:id/bonus')
  addBonus(
    @Param('id') id: string,
    @Body() dto: AddBonusDto,
    @Authenticated() user: AuthUser,
  ) {
    return this.quotesService.addBonus(id, user.tenant_id, {
      type: dto.type,
      description: dto.description,
      valid_until: dto.valid_until,
      discount_percent_delta:
        dto.discount_percent_delta !== undefined
          ? Number(dto.discount_percent_delta)
          : undefined,
    });
  }

  /**
   * Onda 14.5 — Aprova proposta + gera cobranca direta (PIX/Cartao/Boleto a vista).
   * Pra Boleto parcelado com entrada, usar /apply-financing.
   */
  @RequiresPermission('manage_proposals')
  @Post('quotes/:id/approve-and-bill')
  approveAndBill(
    @Param('id') id: string,
    @Body() dto: ApproveAndBillDto,
    @Authenticated() user: AuthUser,
  ) {
    // Fase 0 — auto_execute_items/executed_by_dentist_id não são mais repassados:
    // quem vende não marca procedimento como feito (o front em cache ainda manda).
    if (dto.auto_execute_items === true) {
      this.logger.warn('[APPROVE-AND-BILL] auto_execute_items ignorado (Fase 0)');
    }
    return this.quotesService.approveAndBill(id, user.tenant_id, user.id, {
      billing_type: dto.billing_type as 'PIX' | 'CREDIT_CARD' | 'BOLETO',
      value: Number(dto.value),
      installment_count: dto.installment_count,
      manual_payment_method: dto.manual_payment_method,
      received_in_clinic: dto.received_in_clinic,
      received_method: dto.received_method,
      quick_sale: dto.quick_sale,
    });
  }

  /** Venda de BALCÃO recebida na clínica, em UMA operação: total calculado no servidor, soma das formas = total,
   *  cobrança LOCAL (nunca Asaas), baixa + receita no caixa, dentista obrigatório, plano auto-liberado,
   *  compensação se falhar no meio. PIX online continua em /patients/:id/quotes + /quotes/:id/approve-and-bill.
   *  Fase 0 — substitui o POST /venda-rapida antigo (sem chamador; criava PIX no Asaas e baixava "em espécie" lá).
   *  CRC e recepção vendem: a baixa é interna à venda e NÃO exige operate_cash. */
  @RequiresPermission('manage_proposals')
  @Post('venda-rapida/balcao')
  vendaBalcao(@Body() dto: VendaBalcaoDto, @Authenticated() user: AuthUser) {
    if (!user.tenant_id) throw new BadRequestException('tenant_id ausente');
    return this.quotesService.vendaBalcao(user.tenant_id, user.id, dto);
  }

  /**
   * Onda 12.2 — Aplica financiamento aprovado (chamado pelo botao "Aplicar
   * essa proposta" no modal Banco PASSOS apos credit-check approved).
   *
   * Cadeia: accept quote → cria TreatmentPlan → marca ACTIVE → gera boletos
   * (entrada +3d, parcelas +33d) via Asaas. Retorna URLs dos boletos.
   */
  @RequiresPermission('manage_proposals')
  @Post('quotes/:id/apply-financing')
  applyFinancing(
    @Param('id') id: string,
    @Body() dto: ApplyFinancingDto,
    @Authenticated() user: AuthUser,
  ) {
    return this.quotesService.applyFinancing(id, user.tenant_id, user.id, {
      down_payment_value: Number(dto.down_payment_value),
      installment_count: dto.installment_count,
      installment_value: Number(dto.installment_value),
      decision_id: dto.decision_id,
      source: dto.source,
      // Onda 14.58 — sinal + datas customizadas (opcionais)
      signal_value: dto.signal_value !== undefined ? Number(dto.signal_value) : undefined,
      signal_method: dto.signal_method,
      entrada_due_date: dto.entrada_due_date,
      installments_start_date: dto.installments_start_date,
    });
  }

  @RequiresPermission('manage_proposals')
  @Post('quotes/:id/reject')
  rejectQuote(
    @Param('id') id: string,
    @Body() dto: RejectQuoteDto,
    @Request() req: any,
  ) {
    const tenantId = req.user?.tenant_id;
    if (!tenantId) throw new BadRequestException('tenant_id ausente');
    return this.quotesService.reject(
      id,
      tenantId,
      dto?.rejection_reason,
      req.user?.id,
    );
  }

  /**
   * Onda 14.33 — Marca proposta como "escolhida pra aguardar decisao do
   * paciente". Exclusiva por paciente: ao marcar uma, qualquer outra do
   * mesmo paciente que estivesse marcada e desmarcada. UI destaca a chosen
   * e esmaece as demais.
   *
   * Onda 14.38 — Body opcional aceita { payment_key, down_payment } pra
   * persistir a forma de pagamento + entrada apresentada pelo operador.
   * Esses dados aparecem na secao "Proposta de pagamento" do PDF gerado
   * (que e anexado ao WhatsApp em /send-whatsapp). */
  @RequiresPermission('manage_proposals')
  @Post('quotes/:id/choose-as-proposal')
  chooseQuoteAsProposal(
    @Param('id') id: string,
    @Body() body: {
      payment_key?: string | null;
      down_payment?: number | null;
      // Onda 15 (etapa 16.8) — Persistir tambem o "Plano de cobranca da
      // entrada" inteiro, pra operador nao perder a configuracao ao salvar.
      signal_value?: number | null;
      signal_method?: string | null;
      entrada_due_date?: string | null;
      installments_start_date?: string | null;
      avista_discount_enabled?: boolean | null;
      sem_juros_enabled?: boolean | null;
    },
    @Authenticated() user: AuthUser,
  ) {
    return this.quotesService.markAsChosenProposal(id, user.tenant_id, {
      payment_key: body?.payment_key,
      down_payment: body?.down_payment,
      signal_value: body?.signal_value,
      signal_method: body?.signal_method,
      entrada_due_date: body?.entrada_due_date,
      installments_start_date: body?.installments_start_date,
      avista_discount_enabled: body?.avista_discount_enabled,
      sem_juros_enabled: body?.sem_juros_enabled,
    });
  }

  /** Onda 18 — config do desconto à vista (% por clínica) pro front montar o toggle. */
  @RequiresPermission('manage_proposals', 'view_proposals')
  @Get('quotes/config/avista-discount')
  getAvistaDiscountConfig(@Authenticated() user: AuthUser) {
    return this.quotesService.getAvistaDiscountConfig(user.tenant_id);
  }

  /** Onda 18 — clínica ajusta o % do desconto à vista (0 desliga geral). */
  @RequiresPermission('manage_proposals')
  @Patch('quotes/config/avista-discount')
  setAvistaDiscountConfig(@Body() body: { pct: number }, @Authenticated() user: AuthUser) {
    return this.quotesService.setAvistaDiscountPct(user.tenant_id, Number(body?.pct));
  }

  /** Onda 14.33 — Desmarca proposta escolhida (volta ao estado neutro). */
  @RequiresPermission('manage_proposals')
  @Post('quotes/:id/unchoose-as-proposal')
  unchooseQuoteAsProposal(@Param('id') id: string, @Authenticated() user: AuthUser) {
    return this.quotesService.unmarkChosenProposal(id, user.tenant_id);
  }

  /** Onda 17.32.38 — Arquivar orçamento (some de Propostas, vai pra Financeiro). */
  @RequiresPermission('manage_proposals')
  @Post('quotes/:id/archive')
  archiveQuote(@Param('id') id: string, @Authenticated() user: AuthUser) {
    return this.quotesService.archiveQuote(id, user.tenant_id, user.id);
  }

  /** Onda 17.32.38 — Desarquivar orçamento (volta pra Propostas). */
  @RequiresPermission('manage_proposals')
  @Post('quotes/:id/unarchive')
  unarchiveQuote(@Param('id') id: string, @Authenticated() user: AuthUser) {
    return this.quotesService.unarchiveQuote(id, user.tenant_id);
  }

  // ─── Onda 1 (Fase 24) — Listagem global + funil + WhatsApp ──────

  /** Lista TODOS os orcamentos do tenant (pagina /atendimento/orcamentos) */
  @RequiresPermission('manage_proposals')
  @Get('quotes')
  listAllQuotes(
    @Request() req: any,
    @Query('status') status?: string,
    @Query('createdById') createdById?: string,
    @Query('patientId') patientId?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('search') search?: string,
    @Query('limit') limit?: string,
  ) {
    const tenantId = req.user?.tenant_id;
    if (!tenantId) throw new BadRequestException('tenant_id ausente');
    return this.quotesService.findAll(tenantId, {
      status,
      createdById,
      patientId,
      from,
      to,
      search,
      limit: limit ? parseInt(limit, 10) : undefined,
    });
  }

  /** Envia orcamento por WhatsApp com link do portal */
  @RequiresPermission('manage_proposals')
  @Post('quotes/:id/send-whatsapp')
  sendQuoteByWhatsapp(@Param('id') id: string, @Request() req: any) {
    const tenantId = req.user?.tenant_id;
    if (!tenantId) throw new BadRequestException('tenant_id ausente');
    return this.quotesService.sendByWhatsapp(id, tenantId, req.user?.id);
  }

  /** Admin: forca auto-expiracao agora (idempotente) */
  @RequiresPermission('manage_proposals')
  @Post('quotes/expire-old')
  expireOldQuotes(@Request() req: any) {
    const tenantId = req.user?.tenant_id;
    if (!tenantId) throw new BadRequestException('tenant_id ausente');
    return this.quotesService.expireOldQuotes(tenantId);
  }

  // ─── Onda 2 (Fase 24) — PDF + Templates + Cupons ───────────────

  /** Gera PDF profissional do orcamento */
  @RequiresPermission('manage_proposals')
  @Get('quotes/:id/pdf')
  async quotePdf(
    @Param('id') id: string,
    @Request() req: any,
    @Res() res: Response,
    @Query('values') values?: string,
  ) {
    const tenantId = req.user?.tenant_id;
    if (!tenantId) throw new BadRequestException('tenant_id ausente');
    // ?values=false → PDF só com os procedimentos (sem valores/total/condições).
    const withValues = values !== 'false';
    const buffer = await this.pdfService.generatePdf(id, tenantId, withValues);
    res.set('Content-Type', 'application/pdf');
    res.set(
      'Content-Disposition',
      `inline; filename="${withValues ? 'orcamento' : 'procedimentos'}-${id.slice(0, 8)}.pdf"`,
    );
    res.set('Content-Length', String(buffer.length));
    res.end(buffer);
  }

  // Templates
  @RequiresPermission('manage_proposals')
  @Get('quote-templates')
  listTemplates(@Request() req: any, @Query('activeOnly') activeOnly?: string) {
    const tenantId = req.user?.tenant_id;
    if (!tenantId) throw new BadRequestException('tenant_id ausente');
    return this.templatesService.list(tenantId, {
      activeOnly: activeOnly === 'true' || activeOnly === '1',
    });
  }

  @RequiresPermission('manage_proposals')
  @Get('quote-templates/:id')
  findTemplate(@Param('id') id: string, @Request() req: any) {
    const tenantId = req.user?.tenant_id;
    if (!tenantId) throw new BadRequestException('tenant_id ausente');
    return this.templatesService.findOne(id, tenantId);
  }

  @RequiresPermission('manage_proposals')
  @Post('quote-templates')
  createTemplate(@Request() req: any, @Body() dto: CreateTemplateDto) {
    const tenantId = req.user?.tenant_id;
    if (!tenantId) throw new BadRequestException('tenant_id ausente');
    return this.templatesService.create(tenantId, dto);
  }

  @RequiresPermission('manage_proposals')
  @Patch('quote-templates/:id')
  updateTemplate(
    @Param('id') id: string,
    @Request() req: any,
    @Body() dto: UpdateTemplateDto,
  ) {
    const tenantId = req.user?.tenant_id;
    if (!tenantId) throw new BadRequestException('tenant_id ausente');
    return this.templatesService.update(id, tenantId, dto);
  }

  @RequiresPermission('manage_proposals')
  @Delete('quote-templates/:id')
  removeTemplate(@Param('id') id: string, @Request() req: any) {
    const tenantId = req.user?.tenant_id;
    if (!tenantId) throw new BadRequestException('tenant_id ausente');
    return this.templatesService.remove(id, tenantId);
  }

  /** Aplica template a um orcamento existente — copia items */
  @RequiresPermission('manage_proposals')
  @Post('quotes/:id/apply-template')
  applyTemplate(
    @Param('id') quoteId: string,
    @Body() body: { template_id: string },
    @Request() req: any,
  ) {
    const tenantId = req.user?.tenant_id;
    if (!tenantId) throw new BadRequestException('tenant_id ausente');
    if (!body?.template_id)
      throw new BadRequestException('template_id obrigatorio');
    return this.templatesService.applyToQuote(
      quoteId,
      body.template_id,
      tenantId,
    );
  }

  // Cupons
  @RequiresPermission('manage_proposals')
  @Get('quote-coupons')
  listCoupons(@Request() req: any, @Query('activeOnly') activeOnly?: string) {
    const tenantId = req.user?.tenant_id;
    if (!tenantId) throw new BadRequestException('tenant_id ausente');
    return this.couponsService.list(tenantId, {
      activeOnly: activeOnly === 'true' || activeOnly === '1',
    });
  }

  @RequiresPermission('manage_proposals')
  @Get('quote-coupons/:id')
  findCoupon(@Param('id') id: string, @Request() req: any) {
    const tenantId = req.user?.tenant_id;
    if (!tenantId) throw new BadRequestException('tenant_id ausente');
    return this.couponsService.findOne(id, tenantId);
  }

  @RequiresPermission('manage_proposals')
  @Post('quote-coupons')
  createCoupon(@Request() req: any, @Body() dto: CreateCouponDto) {
    const tenantId = req.user?.tenant_id;
    if (!tenantId) throw new BadRequestException('tenant_id ausente');
    return this.couponsService.create(tenantId, dto);
  }

  @RequiresPermission('manage_proposals')
  @Patch('quote-coupons/:id')
  updateCoupon(
    @Param('id') id: string,
    @Request() req: any,
    @Body() dto: UpdateCouponDto,
  ) {
    const tenantId = req.user?.tenant_id;
    if (!tenantId) throw new BadRequestException('tenant_id ausente');
    return this.couponsService.update(id, tenantId, dto);
  }

  @RequiresPermission('manage_proposals')
  @Delete('quote-coupons/:id')
  removeCoupon(@Param('id') id: string, @Request() req: any) {
    const tenantId = req.user?.tenant_id;
    if (!tenantId) throw new BadRequestException('tenant_id ausente');
    return this.couponsService.remove(id, tenantId);
  }

  /** Aplica cupom a um orcamento — valida + atualiza desconto + incrementa used_count */
  @RequiresPermission('manage_proposals')
  @Post('quotes/:id/apply-coupon')
  applyCoupon(
    @Param('id') quoteId: string,
    @Body() body: { code: string },
    @Request() req: any,
  ) {
    const tenantId = req.user?.tenant_id;
    if (!tenantId) throw new BadRequestException('tenant_id ausente');
    if (!body?.code) throw new BadRequestException('code obrigatorio');
    return this.couponsService.applyToQuote(quoteId, body.code, tenantId);
  }

  /** Remove cupom do orcamento */
  @RequiresPermission('manage_proposals')
  @Delete('quotes/:id/coupon')
  removeCouponFromQuote(@Param('id') quoteId: string, @Request() req: any) {
    const tenantId = req.user?.tenant_id;
    if (!tenantId) throw new BadRequestException('tenant_id ausente');
    return this.couponsService.removeFromQuote(quoteId, tenantId);
  }

  // ─── Onda 3 (Fase 24) — Anexos do orcamento ──────────────────

  /** Lista anexos do orcamento (metadata, sem o binário) */
  @RequiresPermission('manage_proposals')
  @Get('quotes/:id/attachments')
  listAttachments(@Param('id') quoteId: string, @Request() req: any) {
    const tenantId = req.user?.tenant_id;
    if (!tenantId) throw new BadRequestException('tenant_id ausente');
    return this.attachmentsService.list(quoteId, tenantId);
  }

  /** Upload de anexo (multipart, campo "file" + opcional category/description) */
  @RequiresPermission('manage_proposals')
  @Post('quotes/:id/attachments')
  @UseInterceptors(
    FileInterceptor('file', { limits: { fileSize: 10 * 1024 * 1024 } }),
  )
  uploadAttachment(
    @Param('id') quoteId: string,
    @UploadedFile() file: any,
    @Body() body: { category?: string; description?: string },
    @Request() req: any,
  ) {
    const tenantId = req.user?.tenant_id;
    const userId = req.user?.id;
    if (!tenantId || !userId) throw new BadRequestException('Contexto ausente');
    if (!file) throw new BadRequestException('Arquivo nao recebido');
    return this.attachmentsService.upload(quoteId, tenantId, userId, file, {
      category: body?.category,
      description: body?.description,
    });
  }

  /** Serve o arquivo binario inline (preview/download) */
  @RequiresPermission('manage_proposals')
  @Get('quote-attachments/:attachmentId/file')
  async getAttachmentFile(
    @Param('attachmentId') attachmentId: string,
    @Request() req: any,
    @Res() res: Response,
  ) {
    const tenantId = req.user?.tenant_id;
    if (!tenantId) throw new BadRequestException('tenant_id ausente');
    const { buffer, mime_type, filename } =
      await this.attachmentsService.getFileBuffer(attachmentId, tenantId);
    res.set('Content-Type', mime_type);
    res.set(
      'Content-Disposition',
      `inline; filename="${encodeURIComponent(filename)}"`,
    );
    res.set('Content-Length', String(buffer.length));
    res.set('Cache-Control', 'private, max-age=3600');
    res.end(buffer);
  }

  /** Remove anexo (apaga arquivo + registro) */
  @RequiresPermission('manage_proposals')
  @Delete('quote-attachments/:attachmentId')
  removeAttachment(
    @Param('attachmentId') attachmentId: string,
    @Request() req: any,
  ) {
    const tenantId = req.user?.tenant_id;
    if (!tenantId) throw new BadRequestException('tenant_id ausente');
    return this.attachmentsService.remove(attachmentId, tenantId);
  }

  // ─── Onda 3b (Fase 24) — Versions + Renegotiate ──────────────

  /** Lista versoes (snapshots) do orcamento — timeline pra UI */
  @RequiresPermission('manage_proposals')
  @Get('quotes/:id/versions')
  listVersions(@Param('id') quoteId: string, @Request() req: any) {
    const tenantId = req.user?.tenant_id;
    if (!tenantId) throw new BadRequestException('tenant_id ausente');
    return this.versionsService.list(quoteId, tenantId);
  }

  /** Detalhe de uma versao com snapshot completo (pra modal de comparar) */
  @RequiresPermission('manage_proposals')
  @Get('quote-versions/:versionId')
  findVersion(@Param('versionId') versionId: string, @Request() req: any) {
    const tenantId = req.user?.tenant_id;
    if (!tenantId) throw new BadRequestException('tenant_id ausente');
    return this.versionsService.findOne(versionId, tenantId);
  }

  /**
   * Renegociar: cria duplicata DRAFT + marca atual REJECTED.
   * Operador edita o novo, envia v2.
   */
  @RequiresPermission('manage_proposals')
  @Post('quotes/:id/renegotiate')
  renegotiateQuote(
    @Param('id') quoteId: string,
    @Body() body: { note?: string },
    @Request() req: any,
  ) {
    const tenantId = req.user?.tenant_id;
    const userId = req.user?.id;
    if (!tenantId || !userId) throw new BadRequestException('Contexto ausente');
    return this.versionsService.renegotiate(
      quoteId,
      tenantId,
      userId,
      body?.note,
    );
  }

  /**
   * Onda 3.4 — Duplicar como nova OPCAO paralela. Original permanece ativo.
   * Ideal para apresentar varias condicoes comerciais (a vista, parcelado)
   * com os mesmos procedimentos clinicos.
   */
  @RequiresPermission('manage_proposals', 'create_evaluation')
  @Post('quotes/:id/duplicate-as-option')
  async duplicateAsOption(@Param('id') quoteId: string, @Request() req: any) {
    const tenantId = req.user?.tenant_id;
    const userId = req.user?.id;
    if (!tenantId || !userId) throw new BadRequestException('Contexto ausente');
    await this.assertQuoteInScope(req.user, quoteId);
    return this.versionsService.duplicateAsOption(quoteId, tenantId, userId);
  }

  // ─── QuoteItems ───────────────────────────────────────────────

  @RequiresPermission('manage_proposals', 'create_evaluation')
  @Post('quotes/:id/items')
  async addQuoteItem(
    @Param('id') id: string,
    @Body() body: CreateQuoteItemDto,
    @Request() req: any,
  ) {
    const tenantId = req.user?.tenant_id;
    if (!tenantId) throw new BadRequestException('tenant_id ausente');
    await this.assertQuoteInScope(req.user, id);
    // Quem só monta avaliação não manda preço: sai da tabela do procedimento.
    const dto = (await this.isEvaluationOnly(req.user)) ? this.stripItemPricing(body) : body;
    // Out/2026 — quem lança entra como preferência no direcionamento por especialidade.
    return this.quotesService.addItem(id, tenantId, dto, req.user?.id);
  }

  @RequiresPermission('manage_proposals', 'create_evaluation')
  @Patch('quote-items/:id')
  async updateQuoteItem(
    @Param('id') id: string,
    @Body() body: UpdateQuoteItemDto,
    @Request() req: any,
  ) {
    const tenantId = req.user?.tenant_id;
    if (!tenantId) throw new BadRequestException('tenant_id ausente');
    await this.assertQuoteItemInScope(req.user, id);
    const dto = (await this.isEvaluationOnly(req.user)) ? this.stripItemPricing(body) : body;
    return this.quotesService.updateItem(id, tenantId, dto);
  }

  // Onda 18.6 — Editar o preco de um item da proposta. SO ADMIN/SUPER_ADMIN
  // (ajustar valor mexe no total e na cobranca futura; dentista/CRC tem
  // override_price pra montar orcamento, mas ajustar preco de PROPOSTA e
  // restrito a admin). Gate de role aqui + status DRAFT/SENT no service; o
  // front tambem esconde o controle (defense in depth).
  @Patch('quote-items/:id/override-price')
  overrideItemPrice(
    @Param('id') id: string,
    @Body() dto: OverrideItemPriceDto,
    @Request() req: any,
  ) {
    const tenantId = req.user?.tenant_id;
    if (!tenantId) throw new BadRequestException('tenant_id ausente');
    const roles: string[] = req.user?.roles ?? [];
    if (!roles.includes('ADMIN') && !roles.includes('SUPER_ADMIN')) {
      throw new ForbiddenException('Apenas administradores podem editar o preco da proposta');
    }
    return this.quotesService.overrideItemPrice(id, tenantId, dto.total_price);
  }

  @RequiresPermission('manage_proposals', 'create_evaluation')
  @Delete('quote-items/:id')
  async removeQuoteItem(@Param('id') id: string, @Request() req: any) {
    const tenantId = req.user?.tenant_id;
    if (!tenantId) throw new BadRequestException('tenant_id ausente');
    await this.assertQuoteItemInScope(req.user, id);
    return this.quotesService.removeItem(id, tenantId);
  }

  // ─── TreatmentPlans ───────────────────────────────────────────

  @Get('patients/:patientId/treatment-plans')
  listPlans(@Param('patientId') patientId: string, @Request() req: any) {
    const tenantId = req.user?.tenant_id;
    if (!tenantId) throw new BadRequestException('tenant_id ausente');
    return this.plansService.findByPatient(patientId, tenantId);
  }

  /**
   * Onda 5e v38 — items achatados de todos os planos do paciente, usado
   * pela aba "Tratamento" da ficha. Retorna { kpis, items[] } com cada
   * item ja resolvido (procedure name, plano vinculado, executor).
   */
  @Get('patients/:patientId/treatment-items')
  listPatientTreatmentItems(@Param('patientId') patientId: string, @Request() req: any) {
    const tenantId = req.user?.tenant_id;
    if (!tenantId) throw new BadRequestException('tenant_id ausente');
    return this.plansService.findItemsByPatient(patientId, tenantId);
  }

  // Fila central do Financeiro: planos aceitos aguardando validação (libera o tratamento).
  // DEVE vir ANTES de @Get('treatment-plans/:id') senão 'pending-validation' vira :id.
  @RequiresPermission('manage_financial')
  @Get('treatment-plans/pending-validation')
  pendingValidation(@Request() req: any) {
    const tenantId = req.user?.tenant_id;
    if (!tenantId) throw new BadRequestException('tenant_id ausente');
    return this.plansService.findPendingFinancialValidation(tenantId);
  }

  @Get('treatment-plans/:id')
  findPlan(@Param('id') id: string, @Request() req: any) {
    const tenantId = req.user?.tenant_id;
    if (!tenantId) throw new BadRequestException('tenant_id ausente');
    return this.plansService.findOne(id, tenantId);
  }

  @Patch('treatment-plans/:id')
  async updatePlan(
    @Param('id') id: string,
    @Body() dto: UpdateTreatmentPlanDto,
    @Request() req: any,
  ) {
    const tenantId = req.user?.tenant_id;
    if (!tenantId) throw new BadRequestException('tenant_id ausente');
    // Fase 0 — F6: status do plano (cancelar, concluir, reativar…) só o ADMIN; o resto
    // (datas, sessões, notas) continua pra quem já podia. A troca fica no AuditLog.
    if (dto.status !== undefined && !isAdminRole(req.user?.roles)) {
      throw negarPermissao('Só o administrador pode mudar o status do plano.');
    }
    return this.plansService.update(id, tenantId, dto as any, req.user?.id ?? null);
  }

  @Post('treatment-plans/:id/send-for-signature')
  sendPlanForSignature(@Param('id') id: string, @Request() req: any) {
    const tenantId = req.user?.tenant_id;
    if (!tenantId) throw new BadRequestException('tenant_id ausente');
    return this.contractService.sendForSignature(id, tenantId);
  }

  @Post('treatment-plans/:id/create-charges')
  createInstallmentCharges(
    @Param('id') id: string,
    @Body()
    dto: {
      billingType: 'PIX' | 'BOLETO' | 'CREDIT_CARD';
      installmentCount: number;
      firstDueDate?: string;
    },
    @Request() req: any,
  ) {
    const tenantId = req.user?.tenant_id;
    if (!tenantId) throw new BadRequestException('tenant_id ausente');
    if (!dto?.billingType)
      throw new BadRequestException(
        'billingType obrigatorio (PIX, BOLETO, CREDIT_CARD)',
      );
    if (!dto?.installmentCount)
      throw new BadRequestException('installmentCount obrigatorio (1-24)');
    return this.billingService.createInstallmentCharges(id, tenantId, dto);
  }

  @Get('treatment-plans/:id/charges')
  listPlanCharges(@Param('id') id: string, @Request() req: any) {
    const tenantId = req.user?.tenant_id;
    if (!tenantId) throw new BadRequestException('tenant_id ausente');
    return this.billingService.listCharges(id, tenantId);
  }

  /**
   * Onda 14.59 — Emite cobranca da ENTRADA (sinal + restante) com auto-trigger.
   *
   * 1-2 cobrancas geradas no Asaas (ou registro CASH local se metodo=CASH).
   * Quando todas confirmadas (via webhook Asaas ou markCashReceived), trigger
   * automatico gera as parcelas + aprova proposta.
   *
   * Permissao: ADMIN ou FINANCEIRO.
   */
  @Post('treatment-plans/:id/emit-down-payment')
  emitDownPayment(
    @Param('id') id: string,
    @Body()
    dto: {
      signalValue: number;
      signalMethod: 'PIX' | 'BOLETO' | 'CASH';
      signalDueDate?: string;
      restValue: number;
      restMethod: 'PIX' | 'BOLETO' | 'CASH';
      restDueDate?: string;
      clicksignSendTiming?: 'BEFORE' | 'AFTER' | null;
      // Onda 14.60 — params EXATOS do parcelado (modelo DEFERIDO): persistidos
      // no plano pra o trigger gerar as parcelas sem recalcular.
      installmentCount?: number;
      installmentValue?: number;
    },
    @Authenticated() user: AuthUser,
  ) {
    if (!user.tenant_id) throw new BadRequestException('tenant_id ausente');
    const roles = user.roles ?? [];
    if (!roles.includes('ADMIN') && !roles.includes('FINANCEIRO')) {
      throw new ForbiddenException('Apenas ADMIN ou FINANCEIRO podem emitir cobranca da entrada');
    }
    return this.downPaymentFlow.emitDownPayment(id, user.tenant_id, dto);
  }

  /**
   * Onda 14.59 — Wrapper que aceita quote_id (mais comodo pro frontend).
   * Resolve internamente o treatment_plan_id e chama emit-down-payment.
   */
  @Post('quotes/:id/emit-down-payment')
  emitDownPaymentByQuote(
    @Param('id') id: string,
    @Body()
    dto: {
      signalValue: number;
      signalMethod: 'PIX' | 'BOLETO' | 'CASH';
      signalDueDate?: string;
      restValue: number;
      restMethod: 'PIX' | 'BOLETO' | 'CASH';
      restDueDate?: string;
      clicksignSendTiming?: 'BEFORE' | 'AFTER' | null;
      parts?: ('SIGNAL' | 'REST')[];
      // Onda 14.60 — params EXATOS do parcelado (modelo DEFERIDO): persistidos
      // no plano pra o trigger gerar as parcelas sem recalcular.
      installmentCount?: number;
      installmentValue?: number;
    },
    @Authenticated() user: AuthUser,
  ) {
    if (!user.tenant_id) throw new BadRequestException('tenant_id ausente');
    const roles = user.roles ?? [];
    if (!roles.includes('ADMIN') && !roles.includes('FINANCEIRO')) {
      throw new ForbiddenException('Apenas ADMIN ou FINANCEIRO podem emitir cobranca da entrada');
    }
    return this.downPaymentFlow.emitDownPaymentByQuote(id, user.tenant_id, dto);
  }

  /**
   * Onda 14.59.2 — Emite as PARCELAS do plano (alternativa ao trigger automatico
   * do webhook). Util quando operador quer disparar manualmente ao confirmar
   * entrada em especie, ou quando quer revisar antes de gerar.
   *
   * Backend valida que sinal+entrada estao pagos antes de criar parcelas.
   * Permissao: ADMIN ou FINANCEIRO.
   */
  @Post('quotes/:id/emit-installments')
  emitInstallmentsByQuote(
    @Param('id') id: string,
    @Body()
    dto: {
      installmentCount: number;
      installmentValue: number;
      firstDueDate?: string;
    },
    @Authenticated() user: AuthUser,
  ) {
    if (!user.tenant_id) throw new BadRequestException('tenant_id ausente');
    const roles = user.roles ?? [];
    if (!roles.includes('ADMIN') && !roles.includes('FINANCEIRO')) {
      throw new ForbiddenException('Apenas ADMIN ou FINANCEIRO podem emitir parcelas');
    }
    return this.downPaymentFlow.emitInstallmentsByQuote(id, user.tenant_id, dto);
  }

  /**
   * Onda 14.59 — Marca cobranca CASH como recebida em especie.
   * Equivale ao webhook do Asaas avisando PAYMENT_RECEIVED. Dispara o trigger
   * automatico (se for sinal/entrada e completar o ciclo).
   *
   * Permissao: ADMIN, papel FINANCEIRO, ou quem tem operate_cash/manage_financial.
   */
  @Post('charges/:id/mark-cash-received')
  async markCashReceived(@Param('id') id: string, @Authenticated() user: AuthUser) {
    if (!user.tenant_id) throw new BadRequestException('tenant_id ausente');
    // Fase 0 — B3: por PERMISSÃO (a recepção com operate_cash passa a poder), sem
    // tirar ninguém: o papel FINANCEIRO continua passando mesmo com setor diferente.
    const ok = (user.roles ?? []).includes('FINANCEIRO')
      || await temAlgumaPermissao(this.prisma, user, ['operate_cash', 'manage_financial']);
    if (!ok) {
      throw negarPermissao('Sem permissão para marcar recebimento em espécie — só Caixa/Financeiro ou o administrador.');
    }
    return this.downPaymentFlow.markCashReceived(id, user.id, user.tenant_id);
  }

  // Fase 0 — F7: STAND BY continua com quem vê o Progresso (manage_proposals) e com o
  // Financeiro; agora com registro. A trava de PENDING_SIGNATURE fica AQUI na rota (não
  // no service): setOrthoPause chama activate() direto e não pode ser barrado.
  @Post('treatment-plans/:id/activate')
  async activatePlan(@Param('id') id: string, @Request() req: any) {
    const tenantId = req.user?.tenant_id;
    if (!tenantId) throw new BadRequestException('tenant_id ausente');
    await assertAnyPermission(this.prisma, req.user, ['manage_proposals', 'manage_financial'], 'Sem permissão para pausar/retomar tratamento.');
    const antes = await this.plansService.findOne(id, tenantId);
    if (antes.status === 'PENDING_SIGNATURE' && !isAdminRole(req.user?.roles)) {
      throw negarPermissao('Plano aguardando assinatura — só o administrador ativa.');
    }
    const plan = await this.plansService.activate(id, tenantId);
    await this.auditarStandBy(tenantId, req.user?.id, id, 'REATIVADO', antes.status, plan.status);
    return plan;
  }

  @Post('treatment-plans/:id/pause')
  async pausePlan(@Param('id') id: string, @Request() req: any) {
    const tenantId = req.user?.tenant_id;
    if (!tenantId) throw new BadRequestException('tenant_id ausente');
    await assertAnyPermission(this.prisma, req.user, ['manage_proposals', 'manage_financial'], 'Sem permissão para pausar/retomar tratamento.');
    const antes = await this.plansService.findOne(id, tenantId);
    // Fase 0 — pausar e retomar viraria PENDING_SIGNATURE → PAUSED → ACTIVE sem o ADMIN:
    // a pausa de plano aguardando assinatura também é só dele.
    if (antes.status === 'PENDING_SIGNATURE' && !isAdminRole(req.user?.roles)) {
      throw negarPermissao('Plano aguardando assinatura — só o administrador pausa ou ativa.');
    }
    const plan = await this.plansService.pause(id, tenantId);
    await this.auditarStandBy(tenantId, req.user?.id, id, 'PAUSADO', antes.status, plan.status);
    return plan;
  }

  /** Fase 0 — F7: registra a pausa/retomada só quando o status mudou de fato. */
  private async auditarStandBy(
    tenantId: string,
    actorId: string | undefined,
    planId: string,
    action: 'PAUSADO' | 'REATIVADO',
    antes: string,
    depois: string,
  ) {
    if (antes === depois) return;
    await registrarAuditoria(this.prisma, {
      tenantId,
      actorUserId: actorId ?? null,
      entity: 'TREATMENT_PLAN',
      entityId: planId,
      action,
      before: { status: antes },
      after: { status: depois },
      meta: { via: 'progresso' },
    }, this.logger);
  }

  // Onda 17.72 — Validação financeira: SÓ o Financeiro (manage_financial) libera o
  // tratamento. Seta a flag que destrava a confirmação dos procedimentos pelo dentista.
  @RequiresPermission('manage_financial')
  @Post('treatment-plans/:id/validate')
  validatePlan(@Param('id') id: string, @Request() req: any) {
    const tenantId = req.user?.tenant_id;
    if (!tenantId) throw new BadRequestException('tenant_id ausente');
    return this.plansService.validate(id, tenantId, req.user.id);
  }

  // Fase 0 — F6: concluir plano direto só o ADMIN (o finalizePlans usa complete() por
  // dentro, por isso a trava é na rota e não no service).
  @Roles('ADMIN', 'SUPER_ADMIN')
  @Post('treatment-plans/:id/complete')
  async completePlan(@Param('id') id: string, @Request() req: any) {
    const tenantId = req.user?.tenant_id;
    if (!tenantId) throw new BadRequestException('tenant_id ausente');
    const antes = await this.plansService.findOne(id, tenantId);
    const plan = await this.plansService.complete(id, tenantId);
    await registrarAuditoria(this.prisma, {
      tenantId,
      actorUserId: req.user?.id ?? null,
      entity: 'TREATMENT_PLAN',
      entityId: id,
      action: 'CONCLUIDO',
      before: { status: antes.status },
      after: { status: plan.status },
    }, this.logger);
    return plan;
  }

  // Botão ✓ "Finalizar tratamento" (Progresso / Ortodontia): resolve os procedimentos
  // em aberto (feito por <responsável> ou não realizado) e conclui os planos do paciente.
  // (Não colide com os POST por id — todos têm sufixo: /activate, /complete…)
  // Fase 0 — F4: só ADMIN (antes manage_proposals: o CRC dava "feito por" qualquer um).
  @Roles('ADMIN', 'SUPER_ADMIN')
  @Post('treatment-plans/finalize')
  finalizePlans(
    @Body() body: {
      plan_ids?: string[];
      executions?: Array<{ item_id?: string; executed_by_user_id?: string | null; not_done?: boolean }>;
    },
    @Request() req: any,
  ) {
    const tenantId = req.user?.tenant_id;
    if (!tenantId) throw new BadRequestException('tenant_id ausente');
    return this.plansService.finalizePlans(tenantId, req.user?.id ?? null, body?.plan_ids || [], body?.executions || []);
  }

  // ─── TreatmentPlanItems ───────────────────────────────────────

  @Patch('treatment-plan-items/:id')
  updatePlanItem(
    @Param('id') id: string,
    @Body() dto: UpdateTreatmentPlanItemDto,
    @Request() req: any,
  ) {
    const tenantId = req.user?.tenant_id;
    if (!tenantId) throw new BadRequestException('tenant_id ausente');
    // Fase 0 — F5: o service decide pelo ATOR (status só ADMIN; DONE só pelo /execute).
    return this.plansService.updateItem(id, tenantId, dto, { id: req.user.id, roles: req.user.roles ?? [] });
  }

  // Fase 0 — F1: checa o ATOR (dentista do item, qualquer dentista se o item não tem
  // dono, ou ADMIN) antes do núcleo executeItem.
  @Post('treatment-plan-items/:id/execute')
  executePlanItem(
    @Param('id') id: string,
    @Body() dto: ExecuteTreatmentPlanItemDto,
    @Authenticated() user: AuthUser,
  ) {
    return this.plansService.executeItemAsActor(id, user.tenant_id, { id: user.id, roles: user.roles ?? [] }, dto);
  }

  // ─── Contracts (Onda 14.24) ────────────────────────────────────
  // Gate entre proposta aceita e geracao de cobranca. Fase 1: transicoes
  // manuais via cliques do operador. Fase 2: trocar PATCH manuais por
  // webhooks ClickSign (sem mudar API publica).

  /** Pega o contrato de um quote (ou null se nao existe). */
  @Get('quotes/:id/contract')
  getQuoteContract(@Param('id') id: string, @Authenticated() user: AuthUser) {
    return this.contractsService.findByQuote(id, user.tenant_id);
  }

  /** Cria contrato DRAFT pra um Quote ACCEPTED.
   *  Onda 14.30 — aceita body { selected_documents: string[] } com docs
   *  extras pra incluir junto com o contrato principal (TCLE, LGPD, etc). */
  @Post('quotes/:id/contract')
  createQuoteContract(
    @Param('id') id: string,
    @Body() body: { selected_documents?: string[]; dentist_user_id?: string | null },
    @Authenticated() user: AuthUser,
  ) {
    return this.contractsService.createForQuote(id, user.tenant_id, user.id, {
      selected_documents: body?.selected_documents,
      dentist_user_id: body?.dentist_user_id ?? undefined,
    });
  }

  /** Checklist de completude do contrato (o que falta pra gerar). Aceita
   *  ?dentistId= pra avaliar o dentista escolhido no seletor antes de criar. */
  @Get('quotes/:id/contract-completeness')
  getContractCompleteness(
    @Param('id') id: string,
    @Query('dentistId') dentistId: string | undefined,
    @Authenticated() user: AuthUser,
  ) {
    return this.contractsService.assessCompleteness(id, user.tenant_id, (dentistId || '').trim() || undefined);
  }

  /**
   * Preview do contrato ANTES de criar (transitorio, nao persiste nada). Recebe
   * os docs marcados via ?docs=A,B,C. Permite o operador conferir/imprimir a
   * previa direto do orcamento, sem precisar clicar "Criar contrato" primeiro.
   */
  @Get('quotes/:id/contract-preview-pdf')
  async previewQuoteContractPdf(
    @Param('id') id: string,
    @Query('docs') docs: string | undefined,
    @Query('dentistId') dentistId: string | undefined,
    @Authenticated() user: AuthUser,
    @Res() res: Response,
  ) {
    const selected = (docs || '').split(',').map((s) => s.trim()).filter(Boolean);
    const buffer = await this.contractPdfService.generatePreviewForQuote(id, user.tenant_id, selected, (dentistId || '').trim() || undefined);
    this.sendPdf(res, buffer, 'contrato-previa.pdf');
  }

  /** Envia um Buffer de PDF (Content-Length explícito + res.end, igual ao PDF
   *  do orçamento) e valida o magic byte %PDF — se vier algo que não é PDF,
   *  devolve 500 (toast no front) em vez de servir bytes que o visor abriria
   *  como "arquivo corrompido". Obs.: o "0 páginas" que o Edge mostrava NÃO era
   *  transporte — era o próprio PDF corrompido pelo pdf-lib (ver buildPdf). */
  private sendPdf(res: Response, buffer: Buffer, filename: string) {
    if (!isPdfBuffer(buffer)) {
      throw new InternalServerErrorException('Falha ao gerar o PDF (conteúdo inválido).');
    }
    res.set('Content-Type', 'application/pdf');
    res.set('Content-Disposition', `inline; filename="${filename}"`);
    res.set('Content-Length', String(buffer.length));
    res.end(buffer);
  }

  /** Detalhe do contrato + events. */
  @Get('contracts/:id')
  getContract(@Param('id') id: string, @Authenticated() user: AuthUser) {
    return this.contractsService.findOne(id, user.tenant_id);
  }

  /** Atualiza os documentos extras de um contrato AINDA EM RASCUNHO (DRAFT).
   *  Permite marcar/desmarcar termos depois de criado, sem cancelar + recriar. */
  @Patch('contracts/:id/documents')
  updateContractDocuments(
    @Param('id') id: string,
    @Body() body: { selected_documents?: string[] },
    @Authenticated() user: AuthUser,
  ) {
    return this.contractsService.updateDocuments(id, user.tenant_id, user.id, body?.selected_documents || []);
  }

  /** Troca o dentista responsável de um contrato em RASCUNHO. dentist_user_id
   *  null volta pra resolução automática (dentista do orçamento). */
  @Patch('contracts/:id/dentist')
  setContractDentist(
    @Param('id') id: string,
    @Body() body: { dentist_user_id?: string | null },
    @Authenticated() user: AuthUser,
  ) {
    return this.contractsService.setDentist(id, user.tenant_id, user.id, body?.dentist_user_id ?? null);
  }

  /** Marca como enviado (Fase 1: manual). */
  @Post('contracts/:id/send')
  sendContract(@Param('id') id: string, @Authenticated() user: AuthUser) {
    return this.contractsService.markSent(id, user.tenant_id, user.id);
  }

  /**
   * Onda 14.24 Fase 2 — Envia contrato via ClickSign:
   *   - Gera PDF + sobe no ClickSign + envia WhatsApp
   *   - Persiste clicksign_document_id + signing_url
   *   - Webhook auto_close vai marcar como SIGNED quando paciente + clinica assinarem
   */
  @Post('contracts/:id/send-clicksign')
  sendContractViaClickSign(@Param('id') id: string, @Authenticated() user: AuthUser) {
    // Link de assinatura sai pela conversa de PACIENTE (chip Clínica/Comercial).
    return this.contractWhatsapp.sendClickSign(id, user.tenant_id, user.id);
  }

  /** Marca que o paciente abriu o documento (Fase 1: manual). */
  @Post('contracts/:id/mark-opened')
  markContractOpened(@Param('id') id: string, @Authenticated() user: AuthUser) {
    return this.contractsService.markOpened(id, user.tenant_id, user.id);
  }

  /** Marca que o paciente assinou (falta a clinica). */
  @Post('contracts/:id/sign-patient')
  signContractPatient(@Param('id') id: string, @Authenticated() user: AuthUser) {
    return this.contractsService.markPatientSigned(id, user.tenant_id, user.id);
  }

  /** Marca que a clinica assinou — final. Libera geracao de cobranca. */
  @Post('contracts/:id/sign-clinic')
  signContractClinic(@Param('id') id: string, @Authenticated() user: AuthUser) {
    return this.contractsService.markClinicSigned(id, user.tenant_id, user.id);
  }

  /** Cancela o contrato (operador desiste e quer refazer). */
  @Post('contracts/:id/cancel')
  cancelContract(
    @Param('id') id: string,
    @Body() body: { reason?: string },
    @Authenticated() user: AuthUser,
  ) {
    return this.contractsService.cancel(id, user.tenant_id, user.id, body?.reason);
  }

  /** Pula o contrato (operador assume risco — geralmente pra valores baixos). */
  @Post('contracts/:id/skip')
  skipContract(
    @Param('id') id: string,
    @Body() body: { reason?: string },
    @Authenticated() user: AuthUser,
  ) {
    return this.contractsService.skip(id, user.tenant_id, user.id, body?.reason);
  }

  /**
   * Onda 14.24 Fase 1.5 — Preview PDF do contrato. Stream do PDF gerado
   * a partir do template apropriado (por especialidade). Permite operador
   * conferir conteudo antes de enviar pro paciente. Fase 2 vai reusar
   * mesmo PDF pra subir no ClickSign.
   */
  /** O que o modal "Enviar no WhatsApp" mostra: pra quem, por qual chip,
   *  legenda padrão e se há algo que impede o envio (só leitura). */
  @RequiresPermission('manage_proposals')
  @Get('contracts/:id/whatsapp-preview')
  previewContractWhatsapp(@Param('id') id: string, @Authenticated() user: AuthUser) {
    return this.contractWhatsapp.preview(id, user.tenant_id);
  }

  /** Gera o PDF do contrato e envia na conversa de PACIENTE (Clínica/Comercial,
   *  nunca Financeiro), com a legenda escrita pelo operador. */
  @RequiresPermission('manage_proposals')
  @Throttle({ default: { ttl: 60000, limit: 10 } })
  @Post('contracts/:id/send-whatsapp')
  sendContractWhatsapp(
    @Param('id') id: string,
    @Body() dto: SendContractWhatsappDto,
    @Authenticated() user: AuthUser,
  ) {
    return this.contractWhatsapp.send(id, user.tenant_id, user.id, dto.caption);
  }

  @Get('contracts/:id/preview-pdf')
  async previewContractPdf(
    @Param('id') id: string,
    @Authenticated() user: AuthUser,
    @Res() res: Response,
  ) {
    const buffer = await this.contractPdfService.generatePdf(id, user.tenant_id);
    this.sendPdf(res, buffer, `contrato-${id.substring(0, 8)}.pdf`);
  }

  /**
   * Onda 17.32.30 — Serve o PDF de um template de termo (clareamento,
   * facetas, implante, etc) direto do diretorio contract-templates/.
   * Permite o operador PRE-VISUALIZAR o termo antes de marcar o checkbox,
   * pra saber o que cada termo cobre.
   *
   * Whitelist via EXTRA_DOCUMENT_PDF_MAP (no servico) — nao da pra acessar
   * arquivos arbitrarios fora do mapeamento.
   */
  @Get('contract-templates/:docId/pdf')
  async previewContractTemplate(
    @Param('docId') docId: string,
    @Res() res: Response,
  ) {
    const buffer = await this.contractPdfService.readTemplatePdf(docId);
    this.sendPdf(res, buffer, `termo-${docId.toLowerCase()}.pdf`);
  }
}

import { Injectable, Logger, NotFoundException, ForbiddenException, BadRequestException } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { PrismaService } from '../prisma/prisma.service';
import { ChatGateway } from '../gateway/chat.gateway';
import { Prisma, Lead } from '@crm/shared';
import { AutomationsService } from '../automations/automations.service';
import { FollowupService } from '../followup/followup.service';
import { GoogleDriveService } from '../google-drive/google-drive.service';
import { effectiveRole, normalizeRoles } from '../common/utils/permissions.util';
import OpenAI from 'openai';

/**
 * Remove o nono digito de celulares brasileiros.
 * 13 digitos (55+DD+9+8dig) -> 12 digitos (55+DD+8dig)
 * Ex: 5582999130127 -> 558299130127
 */
function to12Digits(phone: string): string {
  const d = phone.replace(/\D/g, '');
  if (d.length === 13 && d.startsWith('55') && d[4] === '9') {
    return d.slice(0, 4) + d.slice(5); // remove o 5o caractere (o 9)
  }
  return d;
}

@Injectable()
export class LeadsService {
  private readonly logger = new Logger(LeadsService.name);

  constructor(
    private prisma: PrismaService,
    private chatGateway: ChatGateway,
    private automationsService: AutomationsService,
    private moduleRef: ModuleRef,
    private googleDriveService: GoogleDriveService,
  ) {}

  async create(data: Prisma.LeadCreateInput, inboxId?: string | null): Promise<Lead> {
    if (data.phone) data = { ...data, phone: to12Digits(data.phone) };
    const lead = await this.prisma.lead.create({ data });
    // Fire automation hooks asynchronously (don't block the response)
    this.automationsService.onNewLead(lead.id, lead.tenant_id ?? undefined).catch(err =>
      this.logger.warn(`onNewLead automation error for lead ${lead.id}: ${err}`),
    );
    this.notifyNewLead(lead, inboxId);
    return lead;
  }

  /** Dispara notificação de novo lead: atendente vinculado > inbox > operators do tenant. */
  private notifyNewLead(lead: Lead, inboxId?: string | null): void {
    this.chatGateway.emitNewLeadNotification(
      lead.tenant_id ?? null,
      lead.cs_user_id ?? null,
      inboxId ?? null,
      {
        leadId: lead.id,
        leadName: lead.name,
        phone: lead.phone,
        origin: lead.origin,
      },
    ).catch(err => this.logger.warn(`[notifyNewLead] ${lead.id}: ${err}`));
  }

  async findAll(tenant_id?: string, inbox_id?: string, page?: number, limit?: number, search?: string, stage?: string, userId?: string, pipeline_id?: string) {
    const baseWhere: any = tenant_id
      ? { OR: [{ tenant_id }, { tenant_id: null }] }
      : {};

    // Filtro por pipeline (CRM dinâmico). Quando passado, a view só mostra
    // leads do funil selecionado. Quando omitido, mantém comportamento legado
    // (todos os leads do tenant).
    if (pipeline_id) {
      baseWhere.pipeline_id = pipeline_id;
    }

    // Filtro por stage:
    //  - stage=PERDIDO  → busca arquivados
    //  - stage=<outro>  → filtra pelo stage específico
    //  - sem stage      → exclui PERDIDO (visão ativa, paginação correta)
    if (stage) {
      baseWhere.stage = stage;
    } else {
      baseWhere.stage = { not: 'PERDIDO' };
    }

    // Busca server-side por nome ou telefone
    if (search && search.trim()) {
      const s = search.trim();
      baseWhere.AND = [
        {
          OR: [
            { name: { contains: s, mode: 'insensitive' } },
            { phone: { contains: s } },
            { email: { contains: s, mode: 'insensitive' } },
          ],
        },
      ];
    }

    const where = inbox_id
      ? {
          ...baseWhere,
          conversations: { some: { inbox_id } },
        }
      : baseWhere;

    // ─── Controle de acesso por role (mesmo padrão de conversations) ────
    if (userId) {
      const user = await this.prisma.user.findUnique({
        where: { id: userId },
        select: { roles: true, inboxes: { select: { id: true } } },
      });

      const userRoles = normalizeRoles(user?.roles as any);
      const isAdminUser = userRoles.includes('ADMIN');
      // Aceita DENTIST e o role legado ADVOGADO (banco pré-migração).
      const isDentistUser = userRoles.includes('DENTIST') || userRoles.includes('ADVOGADO');
      const isOperadorUser = userRoles.includes('OPERADOR') || userRoles.includes('COMERCIAL');
      const userInboxIds = (user?.inboxes ?? []).map((i: any) => i.id);

      if (!isAdminUser) {
        // CRM Pipeline: operador/dentista vê apenas leads explicitamente atribuídos.
        // Diferente do chat inbox (que mostra fila da inbox), aqui só mostra leads
        // onde o usuário é assigned_user, assigned_dentist, cs_user ou dentist do caso.
        const orConditions: any[] = [];

        if (isDentistUser) {
          orConditions.push({ conversations: { some: { assigned_dentist_id: userId } } });
        }

        if (isOperadorUser || isDentistUser) {
          orConditions.push({ conversations: { some: { assigned_user_id: userId } } });
          orConditions.push({ cs_user_id: userId });
        }

        // Fallback: se nenhuma condição (ex: estagiário), ver só os atribuídos
        if (orConditions.length === 0) {
          orConditions.push({ conversations: { some: { assigned_user_id: userId } } });
        }

        // Combina com AND para manter os filtros de tenant/stage/search
        if (!where.AND) where.AND = [];
        if (!Array.isArray(where.AND)) where.AND = [where.AND];
        where.AND.push({ OR: orConditions });
      }
    }

    const includeOpts = {
      _count: {
        select: { conversations: true },
      },
      current_stage: {
        select: { id: true, slug: true, name: true, color: true, emoji: true, is_initial: true, is_won: true, is_lost: true, position: true, pipeline_id: true },
      },
      conversations: {
        where: inbox_id ? { inbox_id } : undefined,
        orderBy: { last_message_at: 'desc' as const },
        take: 1,
        include: {
          messages: {
            orderBy: { created_at: 'desc' as const },
            take: 1,
          },
          assigned_user: { select: { id: true, name: true } },
          assigned_dentist: { select: { id: true, name: true } },
        },
      },
      calendar_events: {
        where: { start_at: { gte: new Date() } },
        orderBy: { start_at: 'asc' as const },
        take: 3,
        select: { id: true, type: true, title: true, start_at: true },
      },
    };

    if (page && limit) {
      const [data, total] = await this.prisma.$transaction([
        this.prisma.lead.findMany({
          where,
          include: includeOpts,
          orderBy: { created_at: 'desc' },
          skip: (page - 1) * limit,
          take: limit,
        }),
        this.prisma.lead.count({ where }),
      ]);
      return { data, total, page, limit };
    }

    return this.prisma.lead.findMany({
      where,
      include: includeOpts,
      orderBy: { created_at: 'desc' },
    }) as any;
  }

  async findOne(id: string, tenantId?: string): Promise<Lead | null> {
    const lead = await this.prisma.lead.findUnique({
      where: { id },
      include: {
        memory: true,
        conversations: {
          orderBy: { last_message_at: 'desc' },
          include: {
            assigned_user: { select: { id: true, name: true } },
            messages: {
              orderBy: { created_at: 'desc' },
              take: 1,
            },
          },
        },
        tasks: {
          orderBy: { created_at: 'desc' },
          take: 10,
        },
        _count: {
          select: { conversations: true },
        },
      },
    }) as any;
    if (lead && tenantId && lead.tenant_id && lead.tenant_id !== tenantId) {
      throw new ForbiddenException('Acesso negado a este recurso');
    }
    return lead;
  }

  async upsert(data: Prisma.LeadCreateInput, inboxId?: string | null): Promise<Lead> {
    const phone = to12Digits(data.phone);
    // No UPDATE nunca sobrescreve nome, stage nem foto com valores piores:
    // - nome: só atualiza se o lead ainda não tem nome (null/vazio) E veio um nome no payload.
    //   Evita sobrescrever o nome real do cliente com o pushName do escritório.
    // - stage: webhook sempre envia 'NOVO', mas o stage é gerenciado pela IA.
    // - profile_picture_url: só atualiza se o lead não tem foto OU se chegou uma URL válida.
    // - tenant_id: jamais sobrescreve tenant de lead existente (isolamento multi-tenant);
    //   só é preenchido quando o lead atual está com tenant_id nulo.
    const {
      phone: _phone,
      name: incomingName,
      stage: _stage,
      profile_picture_url: incomingPhoto,
      tenant_id: tenantIdFlat,
      tenant: tenantRel,
      ...updateData
    } = data as any;
    // tenant pode vir como { tenant_id } (plano) ou { tenant: { connect: { id } } } (relacional)
    const incomingTenantId: string | null =
      tenantIdFlat || tenantRel?.connect?.id || null;

    this.logger.debug(`Upsert lead: raw=${data.phone} → stored=${phone}`);

    // Tenta atualizar o nome apenas se o lead existente não tiver nome
    if (incomingName) {
      await this.prisma.lead.updateMany({
        where: { phone, name: null },
        data: { name: incomingName },
      });
    }

    // Preenche tenant_id apenas se o lead existente estiver sem tenant (backfill defensivo)
    if (incomingTenantId) {
      await this.prisma.lead.updateMany({
        where: { phone, tenant_id: null },
        data: { tenant_id: incomingTenantId },
      });
    }

    // profile_picture_url: só incluir no update quando vier URL válida.
    // URLs do WhatsApp expiram (~24-48h) — URL nova é sempre melhor que a guardada.
    // Nunca limpar foto existente com null (se webhook não enviou foto, não toca no campo).
    if (incomingPhoto) {
      updateData.profile_picture_url = incomingPhoto;
    }

    // Detecta se é criação (lead novo) para disparar notificação ao atendente
    const existing = await this.prisma.lead.findUnique({ where: { phone }, select: { id: true } });

    const lead = await this.prisma.lead.upsert({
      where: { phone },
      update: updateData,
      create: { ...data, phone },
    });

    if (!existing) {
      // Lead realmente novo — atribui ao funil padrão pra que apareça no Kanban dinâmico.
      // Falha silenciosa: se não houver funil configurado, lead fica sem pipeline_id
      // (ainda aparece via fallback de slug no frontend).
      await this.assignDefaultPipeline(lead).catch(err =>
        this.logger.warn(`Falha ao atribuir funil padrão ao lead ${lead.id}: ${err?.message}`),
      );
      this.notifyNewLead(lead, inboxId);
    }

    return lead;
  }

  /**
   * Atribui ao lead o pipeline `is_default` do tenant (ou o mais antigo se
   * nenhum for default), e o stage `is_initial` desse pipeline. Idempotente:
   * só aplica se o lead ainda não tem pipeline_id.
   */
  private async assignDefaultPipeline(lead: Lead): Promise<void> {
    if ((lead as any).pipeline_id) return;

    const tenantWhere = (lead as any).tenant_id
      ? { tenant_id: (lead as any).tenant_id }
      : { tenant_id: null };

    let pipeline = await (this.prisma as any).pipeline.findFirst({
      where: { ...tenantWhere, is_default: true },
      include: { stages: { orderBy: { position: 'asc' } } },
    });
    if (!pipeline) {
      pipeline = await (this.prisma as any).pipeline.findFirst({
        where: tenantWhere,
        include: { stages: { orderBy: { position: 'asc' } } },
        orderBy: { created_at: 'asc' },
      });
    }
    if (!pipeline?.stages?.length) return;

    const initialStage = pipeline.stages.find((s: any) => s.is_initial) ?? pipeline.stages[0];
    await this.prisma.lead.update({
      where: { id: lead.id },
      data: {
        pipeline_id: pipeline.id,
        stage_id: initialStage.id,
      },
    });
  }

  async findByPhone(phone: string): Promise<Lead | null> {
    const normalized = to12Digits(phone);
    return this.prisma.lead.findFirst({
      where: { OR: [{ phone: normalized }, { phone }] },
    });
  }

  async checkPhone(phone: string): Promise<{ exists: boolean; lead?: Lead }> {
    const found = await this.findByPhone(phone);
    if (!found) return { exists: false };
    return { exists: true, lead: found };
  }

  async update(id: string, data: { name?: string; email?: string; cpf_cnpj?: string; tags?: string[] }, tenantId?: string): Promise<Lead> {
    if (tenantId) {
      const existing = await this.prisma.lead.findUnique({ where: { id }, select: { tenant_id: true } });
      if (existing?.tenant_id && existing.tenant_id !== tenantId) {
        throw new ForbiddenException('Acesso negado a este recurso');
      }
    }
    return this.prisma.lead.update({
      where: { id },
      data,
    });
  }

  /**
   * Mapa reverso para dual-write: o slug/flag da PipelineStage nova vira
   * um valor do enum legado `stage` String. Mantém rotinas que ainda
   * dependem do enum funcionando (automations, Drive folder, etc).
   */
  private legacyStageFromPipelineStage(st: { slug: string; is_initial?: boolean; is_won?: boolean; is_lost?: boolean }): string {
    if (st.is_won) return 'FINALIZADO';
    if (st.is_lost) return 'PERDIDO';
    if (st.is_initial) return 'INICIAL';
    switch (st.slug) {
      case 'inicial': return 'INICIAL';
      case 'qualificando': return 'QUALIFICANDO';
      case 'consulta-agendada': return 'REUNIAO_AGENDADA';
      case 'avaliacao-feita': return 'AGUARDANDO_DOCS';
      case 'orcamento-enviado': return 'AGUARDANDO_PROC';
      case 'tratamento-iniciado':
      case 'procedimento-feito':
      case 'contrato-fechado': return 'FINALIZADO';
      case 'perdido': return 'PERDIDO';
      default: return 'QUALIFICANDO';
    }
  }

  /**
   * Quando o cliente envia stage String legado e o lead já tem pipeline_id,
   * tenta resolver o stage_id correspondente no funil do lead — assim
   * dual-write mantém os dois campos sincronizados mesmo via drag antigo.
   */
  private async resolveStageIdFromLegacy(pipelineId: string, legacy: string): Promise<string | undefined> {
    const upper = legacy.toUpperCase();
    const p: any = this.prisma as any;
    if (upper === 'FINALIZADO' || upper === 'GANHO' || upper === 'WON') {
      const st = await p.pipelineStage.findFirst({ where: { pipeline_id: pipelineId, is_won: true } });
      return st?.id;
    }
    if (upper === 'PERDIDO') {
      const st = await p.pipelineStage.findFirst({ where: { pipeline_id: pipelineId, is_lost: true } });
      return st?.id;
    }
    const legacyToSlug: Record<string, string> = {
      INICIAL: 'inicial',
      NOVO: 'inicial',
      QUALIFICANDO: 'qualificando',
      AGUARDANDO_FORM: 'qualificando',
      REUNIAO_AGENDADA: 'consulta-agendada',
      AGUARDANDO_DOCS: 'consulta-agendada',
      AGUARDANDO_PROC: 'orcamento-enviado',
    };
    const slug = legacyToSlug[upper];
    if (!slug) return undefined;
    const st = await p.pipelineStage.findFirst({ where: { pipeline_id: pipelineId, slug } });
    return st?.id;
  }

  async updateStatus(
    id: string,
    stageArg: string | undefined,
    tenantId?: string,
    lossReason?: string,
    actorId?: string,
    stageIdArg?: string,
  ): Promise<Lead> {
    if (!stageArg && !stageIdArg) {
      throw new ForbiddenException('Informe `stage` ou `stage_id`');
    }

    if (tenantId) {
      const existing = await this.prisma.lead.findUnique({ where: { id }, select: { tenant_id: true } });
      if (existing?.tenant_id && existing.tenant_id !== tenantId) {
        throw new ForbiddenException('Acesso negado a este recurso');
      }
    }

    // Resolve os dois representações: (stage String legado) e (stage_id UUID novo)
    let stage: string;
    let stageId: string | undefined = stageIdArg;
    let resolvedPipelineId: string | undefined;

    if (stageIdArg) {
      const st = await (this.prisma as any).pipelineStage.findUnique({
        where: { id: stageIdArg },
        select: { id: true, slug: true, is_initial: true, is_won: true, is_lost: true, pipeline_id: true },
      });
      if (!st) throw new ForbiddenException('stage_id inválido');
      stage = this.legacyStageFromPipelineStage(st);
      resolvedPipelineId = st.pipeline_id;
    } else {
      stage = stageArg as string;
      // Dual-write best-effort: se o lead já está vinculado a um pipeline,
      // tenta achar o stage_id correspondente a essa string legada.
      const leadPipe = await this.prisma.lead.findUnique({
        where: { id },
        select: { pipeline_id: true },
      });
      if (leadPipe?.pipeline_id) {
        stageId = await this.resolveStageIdFromLegacy(leadPipe.pipeline_id, stage);
      }
    }

    // Stage gate: PERDIDO exige motivo
    if (stage === 'PERDIDO' && !lossReason) {
      throw new ForbiddenException('Motivo de perda é obrigatório ao marcar como PERDIDO');
    }

    // Stage gate: FINALIZADO exige especialidade definida
    if (stage === 'FINALIZADO') {
      const conv = await this.prisma.conversation.findFirst({
        where: { lead_id: id },
        orderBy: { last_message_at: 'desc' },
        select: { specialty: true, assigned_dentist_id: true },
      });
      if (!conv?.specialty) {
        throw new ForbiddenException('Lead precisa ter especialidade definida para ser finalizado');
      }
    }

    // Captura o stage atual antes de alterar (para o histórico)
    const current = await this.prisma.lead.findUnique({ where: { id }, select: { stage: true } });

    // Ao finalizar: busca o operador que fechou a venda para registrar como CS
    let csUserId: string | undefined;
    if (stage === 'FINALIZADO') {
      const lastConv = await this.prisma.conversation.findFirst({
        where: { lead_id: id },
        orderBy: { last_message_at: 'desc' },
        select: { assigned_user_id: true },
      });
      csUserId = lastConv?.assigned_user_id ?? undefined;
    }

    const lead = await this.prisma.lead.update({
      where: { id },
      data: {
        stage,
        stage_entered_at: new Date(),
        ...(stageId ? { stage_id: stageId } : {}),
        ...(resolvedPipelineId ? { pipeline_id: resolvedPipelineId } : {}),
        ...(stage === 'PERDIDO' && lossReason ? { loss_reason: lossReason } : {}),
        // Marcar como cliente ao FINALIZAR
        ...(stage === 'FINALIZADO' ? {
          is_client: true,
          became_client_at: new Date(),
          ...(csUserId ? { cs_user_id: csUserId } : {}),
        } : {}),
      },
    });

    // Registra o histórico de mudança de stage
    this.prisma.leadStageHistory.create({
      data: {
        lead_id: id,
        from_stage: current?.stage ?? null,
        to_stage: stage,
        actor_id: actorId ?? null,
        loss_reason: lossReason ?? null,
      },
    }).catch(err => this.logger.warn(`Failed to record stage history for lead ${id}: ${err}`));

    // Salva avanço de etapa na memória do lead (contexto para IA)
    this.appendLeadStageToMemory(id, current?.stage ?? null, stage, lossReason ?? null).catch(err =>
      this.logger.warn(`[MEMORY] Falha ao registrar etapa CRM na memória do lead ${id}: ${err}`),
    );

    // Broadcast: notificar outros clientes sobre mudanca de stage do lead
    this.chatGateway.emitConversationsUpdate(tenantId ?? null);

    // Criar pasta no Google Drive ao atingir AGUARDANDO_DOCS
    if (stage === 'AGUARDANDO_DOCS') {
      this.googleDriveService.isConfigured().then(configured => {
        if (!configured) return;
        return this.googleDriveService.ensureLeadFolder(id, lead.name || 'Lead');
      }).then(folderId => {
        if (folderId) this.logger.log(`[DRIVE] Pasta criada/garantida para lead ${id}: ${folderId}`);
      }).catch(err =>
        this.logger.warn(`[DRIVE] Falha ao criar pasta para lead ${id} em AGUARDANDO_DOCS: ${err.message}`),
      );
    }

    // Fire stage-change automation hooks asynchronously
    this.automationsService.onStageChange(id, stage, tenantId).catch(err =>
      this.logger.warn(`onStageChange automation error for lead ${id}: ${err}`),
    );

    // Auto-enroll em sequências de follow-up configuradas para o novo stage
    // Resolve via ModuleRef para evitar dependência circular na inicialização do módulo
    try {
      const followupService = this.moduleRef.get(FollowupService, { strict: false });
      if (followupService) {
        followupService.autoEnrollByStage(id, stage).catch((err: Error) =>
          this.logger.warn(`[FOLLOWUP] Auto-enroll falhou: ${err.message}`),
        );
      }
    } catch {
      // FollowupModule pode não estar carregado em contextos de teste — ignorar silenciosamente
    }

    return lead;
  }

  async resetMemory(id: string, tenantId?: string): Promise<{ ok: boolean }> {
    if (tenantId) {
      const lead = await this.prisma.lead.findUnique({ where: { id }, select: { tenant_id: true } });
      if (lead?.tenant_id && lead.tenant_id !== tenantId) {
        throw new ForbiddenException('Acesso negado a este recurso');
      }
    }
    await this.prisma.aiMemory.deleteMany({ where: { lead_id: id } });
    return { ok: true };
  }

  // ─── DELETE CONTACT (somente ADMIN) ──────────────────────────────────────
  // Exclui o contato e TODOS os seus dados: conversas, mensagens, memória IA,
  // casos jurídicos, tarefas, eventos, publicações DJEN.
  async deleteContact(id: string): Promise<{ ok: boolean }> {
    const lead = await this.prisma.lead.findUnique({ where: { id }, select: { id: true } });
    if (!lead) throw new NotFoundException('Contato não encontrado');

    await this.prisma.$transaction(async (tx) => {
      // 1. Coleta todos os IDs relacionados
      const conversations = await tx.conversation.findMany({
        where: { lead_id: id },
        select: { id: true },
      });
      const convIds = conversations.map(c => c.id);

      const messages = convIds.length > 0
        ? await tx.message.findMany({
            where: { conversation_id: { in: convIds } },
            select: { id: true },
          })
        : [];
      const msgIds = messages.map(m => m.id);

      const allTasks = await tx.task.findMany({
        where: {
          OR: [
            { lead_id: id },
            ...(convIds.length > 0 ? [{ conversation_id: { in: convIds } }] : []),
          ],
        },
        select: { id: true },
      });
      const taskIds = allTasks.map(t => t.id);

      // 2. Exclui na ordem correta (filhos antes de pais)

      // Comentários de tarefas
      if (taskIds.length > 0) {
        await tx.taskComment.deleteMany({ where: { task_id: { in: taskIds } } });
      }

      // Tarefas (do lead e das conversas)
      if (taskIds.length > 0) {
        await tx.task.deleteMany({ where: { id: { in: taskIds } } });
      }

      // Mídia das mensagens
      if (msgIds.length > 0) {
        await tx.media.deleteMany({ where: { message_id: { in: msgIds } } });
        await tx.message.deleteMany({ where: { id: { in: msgIds } } });
      }

      // Conversas
      if (convIds.length > 0) {
        await tx.conversation.deleteMany({ where: { id: { in: convIds } } });
      }

      // Memória IA
      await tx.aiMemory.deleteMany({ where: { lead_id: id } });

      // Lead em si
      await tx.lead.delete({ where: { id } });
    }, { timeout: 30000 }); // timeout generoso para contatos com muito histórico

    this.logger.log(`[deleteContact] Contato ${id} e todos os seus dados foram excluídos.`);
    return { ok: true };
  }

  // ─── TIMELINE ─────────────────────────────────────────────────────────────
  async getTimeline(leadId: string, tenantId?: string): Promise<any[]> {
    if (tenantId) {
      const lead = await this.prisma.lead.findUnique({ where: { id: leadId }, select: { tenant_id: true } });
      if (lead?.tenant_id && lead.tenant_id !== tenantId) {
        throw new ForbiddenException('Acesso negado a este recurso');
      }
    }

    const [stageHistory, notes, memory] = await Promise.all([
      this.prisma.leadStageHistory.findMany({
        where: { lead_id: leadId },
        orderBy: { created_at: 'desc' },
        take: 100,
        include: { actor: { select: { id: true, name: true } } },
      }),
      this.prisma.leadNote.findMany({
        where: { lead_id: leadId },
        orderBy: { created_at: 'desc' },
        take: 100,
        include: { user: { select: { id: true, name: true } } },
      }),
      this.prisma.aiMemory.findUnique({ where: { lead_id: leadId } }),
    ]);

    let facts: any = {};
    try { facts = memory?.facts_json ? (typeof memory.facts_json === 'string' ? JSON.parse(memory.facts_json as string) : memory.facts_json) : {}; } catch { facts = {}; }

    const items: any[] = [
      ...stageHistory.map(h => ({
        type: 'stage_change',
        id: h.id,
        from_stage: h.from_stage,
        to_stage: h.to_stage,
        actor: (h as any).actor ?? null,
        loss_reason: h.loss_reason,
        created_at: h.created_at,
      })),
      ...notes.map(n => ({
        type: 'note',
        id: n.id,
        text: n.text,
        author: (n as any).user ?? null,
        created_at: n.created_at,
      })),
      // Etapas do processo judicial (de AiMemory)
      ...(facts.case_timeline || []).map((e: any, i: number) => ({
        type: 'case_stage',
        id: `case_${i}`,
        from_stage: e.from,
        to_stage: e.to,
        case_number: e.case_number,
        specialty: e.specialty,
        created_at: new Date(e.date + 'T12:00:00Z'),
      })),
      // Petições aprovadas/protocoladas (de AiMemory)
      ...(facts.petitions || []).map((p: any, i: number) => ({
        type: 'petition',
        id: `petition_${i}`,
        petition_type: p.type,
        title: p.title,
        status: p.status,
        case_number: p.case_number,
        created_at: new Date(p.date + 'T12:00:00Z'),
      })),
      // Publicações DJEN analisadas (de AiMemory)
      ...(facts.djen_publications || []).map((d: any, i: number) => ({
        type: 'djen',
        id: `djen_${i}`,
        djen_tipo: d.tipo,
        djen_assunto: d.assunto,
        resumo: d.resumo,
        urgencia: d.urgencia,
        created_at: new Date(d.date + 'T12:00:00Z'),
      })),
    ];

    return items.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
  }

  // ─── IA SUMMARY ───────────────────────────────────────────────────────────
  async summarizeLead(leadId: string, tenantId?: string): Promise<{ summary: string }> {
    const lead = await this.prisma.lead.findUnique({
      where: { id: leadId },
      include: {
        conversations: {
          include: {
            messages: {
              where: { type: 'text' },
              orderBy: { created_at: 'desc' },
              take: 30,
              select: { text: true, direction: true, created_at: true },
            },
          },
          take: 1,
        },
      },
    });
    if (!lead) throw new NotFoundException('Lead não encontrado');
    if (tenantId && lead.tenant_id && lead.tenant_id !== tenantId) {
      throw new ForbiddenException('Acesso negado');
    }

    const conv = lead.conversations?.[0];
    const messages = (conv?.messages ?? []).reverse();
    const messagesText = messages
      .filter((m) => m.text)
      .map((m) => `${m.direction === 'out' ? 'Atendente' : 'Cliente'}: ${m.text}`)
      .join('\n');

    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) throw new BadRequestException('API key OpenAI não configurada.');

    const openai = new OpenAI({ apiKey });
    const completion = await openai.chat.completions.create({
      model: 'gpt-4.1-mini',
      max_tokens: 300,
      messages: [
        {
          role: 'system',
          content: 'Você é um assistente jurídico. Produza um briefing conciso (3-5 linhas) sobre o lead: quem é, qual é o problema jurídico, o que já foi tratado e qual o próximo passo recomendado. Responda em português, sem tópicos, em texto corrido.',
        },
        {
          role: 'user',
          content: `Lead: ${lead.name || 'Sem nome'} | Etapa: ${lead.stage} | Especialidade: ${(conv as any)?.specialty || 'não definida'}\n\nConversa:\n${messagesText || 'Sem mensagens registradas.'}`,
        },
      ],
    });

    return { summary: completion.choices[0]?.message?.content ?? 'Não foi possível gerar o resumo.' };
  }

  // ─── EXPORT CSV ───────────────────────────────────────────────────────────
  async exportCsv(tenantId?: string, search?: string, userId?: string): Promise<string> {
    const where: any = {};
    if (tenantId) where.tenant_id = tenantId;
    if (search) {
      where.OR = [
        { name: { contains: search, mode: 'insensitive' } },
        { phone: { contains: search } },
      ];
    }

    // Controle de acesso por role (mesmo padrão do findAll)
    if (userId) {
      const user = await this.prisma.user.findUnique({
        where: { id: userId },
        select: { roles: true },
      });
      const userRoles = normalizeRoles(user?.roles as any);
      const isAdminUser = userRoles.includes('ADMIN');
      // Aceita DENTIST e o role legado ADVOGADO (banco pré-migração).
      const isDentistUser = userRoles.includes('DENTIST') || userRoles.includes('ADVOGADO');
      const isOperadorUser = userRoles.includes('OPERADOR') || userRoles.includes('COMERCIAL');

      if (!isAdminUser) {
        const orConditions: any[] = [];
        if (isDentistUser) {
          orConditions.push({ conversations: { some: { assigned_dentist_id: userId } } });
        }
        if (isOperadorUser || isDentistUser) {
          orConditions.push({ conversations: { some: { assigned_user_id: userId } } });
          orConditions.push({ cs_user_id: userId });
        }
        if (orConditions.length === 0) {
          orConditions.push({ conversations: { some: { assigned_user_id: userId } } });
        }
        if (!where.AND) where.AND = [];
        if (!Array.isArray(where.AND)) where.AND = [where.AND];
        where.AND.push({ OR: orConditions });
      }
    }

    const leads = await this.prisma.lead.findMany({
      where,
      orderBy: { created_at: 'desc' },
      include: {
        conversations: {
          orderBy: { last_message_at: 'desc' },
          take: 1,
          select: { specialty: true, assigned_dentist: { select: { name: true } } },
        },
      },
    });

    const escape = (v: string | null | undefined) => {
      if (!v) return '';
      const s = String(v).replace(/"/g, '""');
      return s.includes(',') || s.includes('"') || s.includes('\n') ? `"${s}"` : s;
    };

    const msPerDay = 86400000;
    const daysInStage = (d: Date | string) =>
      Math.floor((Date.now() - new Date(d).getTime()) / msPerDay);

    const header = ['Nome', 'Telefone', 'Email', 'Estágio', 'Especialidade', 'Dentista', 'Tags', 'Dias no Estágio', 'Criado em'];
    const rows = leads.map(l => {
      const conv = (l as any).conversations?.[0];
      return [
        escape(l.name),
        escape(l.phone),
        escape(l.email),
        escape(l.stage),
        escape(conv?.specialty),
        escape(conv?.assigned_dentist?.name),
        escape((l.tags || []).join('; ')),
        escape(String(daysInStage(l.stage_entered_at))),
        escape(new Date(l.created_at).toLocaleDateString('pt-BR')),
      ].join(',');
    });

    return [header.join(','), ...rows].join('\n');
  }

  // ─── Memória: registra avanço de etapa CRM ────────────────────────────────

  private async appendLeadStageToMemory(leadId: string, fromStage: string | null, toStage: string, lossReason: string | null): Promise<void> {
    const STAGE_LABELS: Record<string, string> = {
      NOVO: 'Novo', INICIAL: 'Inicial', QUALIFICANDO: 'Qualificando',
      AGUARDANDO_FORM: 'Aguardando Formulário', REUNIAO_AGENDADA: 'Reunião Agendada',
      AGUARDANDO_DOCS: 'Aguardando Documentos', AGUARDANDO_PROC: 'Aguardando Processo',
      FINALIZADO: 'Finalizado', PERDIDO: 'Perdido',
    };
    const today = new Date().toISOString().slice(0, 10);
    const entry = {
      from: fromStage, to: toStage, date: today,
      ...(lossReason ? { loss_reason: lossReason } : {}),
    };
    const existing = await this.prisma.aiMemory.findUnique({ where: { lead_id: leadId } });
    let facts: any = {};
    try { facts = existing?.facts_json ? (typeof existing.facts_json === 'string' ? JSON.parse(existing.facts_json as string) : existing.facts_json) : {}; } catch { facts = {}; }
    const timeline: any[] = facts.crm_timeline || [];
    timeline.push(entry);
    if (timeline.length > 30) timeline.splice(0, timeline.length - 30);
    facts.crm_timeline = timeline;

    const fromLabel = STAGE_LABELS[fromStage ?? ''] || fromStage || 'início';
    const toLabel = STAGE_LABELS[toStage] || toStage;
    const summaryLine = `[CRM ${today}] ${fromLabel} → ${toLabel}${lossReason ? ` (Motivo: ${lossReason})` : ''}`;
    const newSummary = (summaryLine + (existing?.summary ? '\n' + existing.summary : '')).slice(0, 2000);

    if (existing) {
      await this.prisma.aiMemory.update({
        where: { lead_id: leadId },
        data: { facts_json: facts, summary: newSummary, last_updated_at: new Date(), version: { increment: 1 } },
      });
    } else {
      await this.prisma.aiMemory.create({ data: { lead_id: leadId, summary: newSummary, facts_json: facts } });
    }
  }
}

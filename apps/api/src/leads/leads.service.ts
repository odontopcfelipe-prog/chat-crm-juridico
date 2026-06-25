import { Injectable, Logger, NotFoundException, ForbiddenException, BadRequestException } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { PrismaService } from '../prisma/prisma.service';
import { ChatGateway } from '../gateway/chat.gateway';
import { Prisma, Lead } from '@crm/shared';
import { AutomationsService } from '../automations/automations.service';
import { FollowupService } from '../followup/followup.service';
import { GoogleDriveService } from '../google-drive/google-drive.service';
import { PatientsService } from '../patients/patients.service';
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

  /**
   * Pos-Avaliacao (Onda 5e v31) — Fase 25.
   *
   * Lista leads que JA realizaram a consulta de avaliacao (ou procedimento/
   * retorno). Criterio: tem pelo menos um CalendarEvent com type clinico
   * (CONSULTA/PROCEDIMENTO/RETORNO) e que ja aconteceu, considerado
   * "concluido" se:
   *   - status = CONCLUIDO    (operador marcou) OU
   *   - validated_at != null  (dentista validou clinicamente — Fase 23)
   *
   * Janela default: ultimos 60 dias. Fora disso o lead vira historico.
   *
   * Usado pela aba "Pos-Avaliacao" do CRM pra acompanhar pacientes que
   * vieram pra avaliacao mas ainda nao tem decisao final (orcamento /
   * fechamento / perdeu).
   */
  async findPostAvaliacao(
    tenantId?: string,
    days: number = 60,
  ) {
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    const now = new Date();

    // Onda 14.42 — Operador relatou que leads no stage "avaliacao-feita"
    // (movidos manualmente no Kanban tradicional, sem ter um evento de
    // calendario CONCLUIDO/validado) nao caiam na coluna "Avaliacao
    // Concluida" do funil de Propostas. Agora a query aceita QUALQUER um
    // dos 2 criterios:
    //   A) calendar_event clinico CONCLUIDO/validado na janela de N dias OU
    //   B) lead.current_stage.slug = 'avaliacao-feita' (movido manualmente)
    // Assim o operador pode marcar a avaliacao como feita de qualquer um
    // dos 2 fluxos sem o lead sumir do funil de fechamento.
    const leads = await this.prisma.lead.findMany({
      where: {
        ...(tenantId ? { tenant_id: tenantId } : {}),
        OR: [
          {
            calendar_events: {
              some: {
                type: { in: ['CONSULTA', 'PROCEDIMENTO', 'RETORNO'] },
                start_at: { gte: since, lte: now },
                OR: [
                  { status: 'CONCLUIDO' },
                  { validated_at: { not: null } },
                ],
              },
            },
          },
          {
            current_stage: { slug: 'avaliacao-feita' },
          },
        ],
      },
      include: {
        current_stage: {
          select: { id: true, slug: true, name: true, color: true, emoji: true, is_won: true, is_lost: true },
        },
        conversations: {
          orderBy: { last_message_at: 'desc' },
          take: 1,
          select: {
            id: true,
            inbox_id: true,
            specialty: true,
            last_message_at: true,
            assigned_dentist: { select: { id: true, name: true } },
          },
        },
        // Apenas o evento de avaliacao mais recente concluido (pra exibir
        // data/dentista que atendeu no card)
        calendar_events: {
          where: {
            type: { in: ['CONSULTA', 'PROCEDIMENTO', 'RETORNO'] },
            start_at: { gte: since, lte: now },
            OR: [
              { status: 'CONCLUIDO' },
              { validated_at: { not: null } },
            ],
          },
          orderBy: { start_at: 'desc' },
          take: 1,
          select: {
            id: true,
            type: true,
            title: true,
            status: true,
            start_at: true,
            validated_at: true,
            assigned_user: { select: { id: true, name: true } },
          },
        },
      },
      orderBy: { updated_at: 'desc' },
    });

    // Anota cada lead com um "post_avaliacao_status" calculado pra o
    // frontend agrupar facilmente. 4 buckets (Onda 14.48 — refinado):
    //   - 'em-tratamento'  : virou Patient + tem evento futuro AGENDADO/CONFIRMADO
    //   - 'com-orcamento'  : tem quote SENT (paciente recebeu a proposta)
    //   - 'aguardando'     : "Avaliação Concluída" — TRAJETORIA validada do lead:
    //                        ja foi validado pelo dentista (calendar_event com
    //                        validated_at != null) E ja tem orcamento gerado
    //                        em DRAFT (operador criou mas ainda nao enviou).
    //                        Sem essas 2 condicoes o lead nao entra no funil
    //                        de fechamento — fica no Kanban tradicional na
    //                        coluna "Avaliação Feita" ate alguem validar +
    //                        gerar orcamento.
    //   - 'perdido'        : stage com is_lost=true
    //
    // Leads que nao se encaixam em nenhum bucket sao FILTRADOS FORA do
    // retorno (bucket = null) — evita poluir o funil de fechamento com
    // leads que ainda nao tem trajetoria comercial definida.
    const leadIds = leads.map((l) => l.id);

    // Carrega Patients vinculados aos leads (Quote pertence a Patient, nao Lead direto)
    const patients = await this.prisma.patient.findMany({
      where: { lead_id: { in: leadIds } },
      select: { id: true, lead_id: true, name: true },
    });
    const patientIds = patients.map((p) => p.id);

    const [activeQuotes, futureEvents] = await Promise.all([
      patientIds.length > 0
        ? this.prisma.quote.findMany({
            where: {
              patient_id: { in: patientIds },
              status: { in: ['DRAFT', 'SENT'] },
            },
            select: { id: true, patient_id: true, status: true, total_value: true },
          }).catch(() => [] as any[])
        : Promise.resolve([] as any[]),
      this.prisma.calendarEvent.findMany({
        where: {
          lead_id: { in: leadIds },
          start_at: { gte: now },
          status: { in: ['AGENDADO', 'CONFIRMADO'] },
          type: { in: ['CONSULTA', 'PROCEDIMENTO', 'RETORNO'] },
        },
        select: { lead_id: true, id: true, start_at: true, type: true },
        orderBy: { start_at: 'asc' },
      }),
    ]);

    const patientByLead = new Map<string, any>();
    for (const p of patients) if (p.lead_id) patientByLead.set(p.lead_id, p);
    // Quote pertence a Patient — encadeia patient_id -> lead_id pra agrupar por lead
    const patientToLead = new Map<string, string>();
    for (const p of patients) if (p.lead_id) patientToLead.set(p.id, p.lead_id);
    // Onda 14.46 — Se o lead tem 2+ quotes ativas (raro mas possivel: 1 DRAFT
    // + 1 SENT), prefere SENT no map. Sem isso o bucket dependia da ordem do
    // retorno do Prisma — instavel. SENT tem prioridade porque eh o estado
    // "mais avancado" no funil de fechamento.
    const quotesByLead = new Map<string, any>();
    for (const q of activeQuotes) {
      const leadId = patientToLead.get(q.patient_id);
      if (!leadId) continue;
      const existing = quotesByLead.get(leadId);
      if (!existing || (existing.status === 'DRAFT' && q.status === 'SENT')) {
        quotesByLead.set(leadId, q);
      }
    }
    const eventByLead = new Map<string, any>();
    for (const e of futureEvents) if (e.lead_id && !eventByLead.has(e.lead_id)) eventByLead.set(e.lead_id, e);

    const enriched = leads.flatMap((l) => {
      const quote = quotesByLead.get(l.id) ?? null;
      const upcoming = eventByLead.get(l.id) ?? null;
      const patient = patientByLead.get(l.id) ?? null;
      // Onda 14.48 — Lead so conta como "validado pelo dentista" se o
      // CalendarEvent clinico mais recente (CONSULTA/PROCEDIMENTO/RETORNO)
      // tem validated_at preenchido — flag setada quando o dentista valida
      // o atendimento via aba de Avaliacao/Prontuario. Status CONCLUIDO
      // sozinho nao basta (pode ser secretaria marcando, nao tem peso
      // clinico). Como a query ja inclui calendar_events com take:1
      // ordenados por start_at desc, basta checar o primeiro.
      const wasValidatedByDentist = (l.calendar_events ?? [])
        .some((e: any) => e.validated_at !== null);

      let bucket: 'em-tratamento' | 'com-orcamento' | 'aguardando' | 'perdido' | null = null;
      if (l.current_stage?.is_lost) bucket = 'perdido';
      else if (patient && upcoming) bucket = 'em-tratamento';
      // Onda 14.46 — SO conta como "com-orcamento" quando a quote ja foi
      // efetivamente enviada (SENT). DRAFT eh rascunho interno do operador,
      // paciente ainda nao recebeu a proposta.
      else if (quote?.status === 'SENT') bucket = 'com-orcamento';
      // Onda 14.48 — "Avaliação Concluída" agora exige a TRAJETORIA completa:
      //   1. Foi VALIDADO pelo dentista (validated_at != null) — comprova que
      //      o atendimento clinico teve peso, nao foi so "compareceu"
      //   2. Operador JA gerou orcamento (quote DRAFT) — comprova intencao
      //      comercial real, lead ja foi processado pos-consulta
      //   3. Ainda nao virou paciente em tratamento (cai aqui pq nao bateu
      //      em-tratamento acima)
      // Sem esses 2 marcos confirmados, o lead nao tem trajetoria comercial
      // suficiente pra ocupar espaco visual no funil de fechamento.
      else if (quote?.status === 'DRAFT' && wasValidatedByDentist) {
        bucket = 'aguardando';
      }
      // bucket === null → lead filtrado fora (volta abaixo)

      if (!bucket) return [];

      return [{
        ...l,
        post_avaliacao: {
          bucket,
          quote,
          upcoming_event: upcoming,
          patient,
        },
      }];
    });

    return enriched;
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

    this.logger.debug(`Upsert lead: raw=${data.phone} → stored=${phone} tenant=${incomingTenantId ?? 'null'}`);

    // Onda 17.36 — ISOLAMENTO MULTI-TENANT. O lead agora é resolvido por
    // (tenant_id, phone), NUNCA mais só pelo phone global: antes, mensagem
    // chegando pela instância da clínica B grudava no lead da clínica A se o
    // telefone já existisse lá (vazamento de conversa entre clínicas).

    // Backfill defensivo: lead órfão (tenant_id null, pré-multi-tenant) com
    // este phone é adotado pelo tenant da instância que recebeu a mensagem.
    // Roda ANTES da resolução pra que o lead adotado seja encontrado abaixo.
    if (incomingTenantId) {
      const adopted = await this.prisma.lead.updateMany({
        where: { phone, tenant_id: null },
        data: { tenant_id: incomingTenantId },
      });
      if (adopted.count > 0) {
        this.logger.log(
          `[UPSERT] Lead órfão ${phone} adotado pelo tenant ${incomingTenantId} (backfill legado)`,
        );
      }
    }

    // Resolve o lead DENTRO do tenant. tenant null = escopo dos órfãos
    // (webhook de instância legada sem vínculo) — nunca casa lead de clínica.
    const scope = { phone, tenant_id: incomingTenantId };

    // Atualiza o nome apenas se o lead existente (deste tenant) não tiver nome
    if (incomingName) {
      await this.prisma.lead.updateMany({
        where: { ...scope, name: null },
        data: { name: incomingName },
      });
    }

    // profile_picture_url: só incluir no update quando vier URL válida.
    // URLs do WhatsApp expiram (~24-48h) — URL nova é sempre melhor que a guardada.
    // Nunca limpar foto existente com null (se webhook não enviou foto, não toca no campo).
    if (incomingPhoto) {
      updateData.profile_picture_url = incomingPhoto;
    }

    // Detecta se é criação (lead novo) para disparar notificação ao atendente
    let existing = await this.prisma.lead.findFirst({ where: scope, select: { id: true } });

    let lead: Lead;
    if (existing) {
      lead = await this.prisma.lead.update({ where: { id: existing.id }, data: updateData });
    } else {
      try {
        lead = await this.prisma.lead.create({ data: { ...data, phone } });
      } catch (e: any) {
        // Corrida: dois webhooks simultâneos do mesmo numero — o segundo create
        // bate na @@unique([tenant_id, phone]); re-resolve e atualiza.
        if (e?.code !== 'P2002') throw e;
        const raced = await this.prisma.lead.findFirst({ where: scope, select: { id: true } });
        if (!raced) throw e;
        existing = raced;
        lead = await this.prisma.lead.update({ where: { id: raced.id }, data: updateData });
      }
    }

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

  /**
   * Onda 17.36 — busca por telefone com escopo de tenant:
   *   - string  → só leads daquele tenant
   *   - null    → só leads órfãos (tenant_id null, legado pré-multi-tenant)
   *   - undefined → sem filtro (NÃO usar em fluxo de webhook/tenant — só em
   *     rotinas administrativas globais conscientes do vazamento)
   */
  async findByPhone(phone: string, tenantId?: string | null): Promise<Lead | null> {
    const normalized = to12Digits(phone);
    return this.prisma.lead.findFirst({
      where: {
        OR: [{ phone: normalized }, { phone }],
        ...(tenantId !== undefined ? { tenant_id: tenantId } : {}),
      },
    });
  }

  async checkPhone(phone: string, tenantId?: string | null): Promise<{ exists: boolean; lead?: Lead }> {
    const found = await this.findByPhone(phone, tenantId);
    if (!found) return { exists: false };
    return { exists: true, lead: found };
  }

  async update(id: string, data: { name?: string; email?: string; cpf_cnpj?: string; tags?: string[]; origin?: string }, tenantId?: string): Promise<Lead> {
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
      // Funil 2 — orcamento criado, lead saiu do Kanban, vive em /fechamentos
      case 'em-fechamento': return 'EM_FECHAMENTO';
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
    let stageSlug: string | undefined;

    if (stageIdArg) {
      const st = await (this.prisma as any).pipelineStage.findUnique({
        where: { id: stageIdArg },
        select: { id: true, slug: true, is_initial: true, is_won: true, is_lost: true, pipeline_id: true },
      });
      if (!st) throw new ForbiddenException('stage_id inválido');
      stage = this.legacyStageFromPipelineStage(st);
      resolvedPipelineId = st.pipeline_id;
      stageSlug = st.slug;
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
        if (stageId) {
          const st = await (this.prisma as any).pipelineStage.findUnique({
            where: { id: stageId },
            select: { slug: true },
          });
          stageSlug = st?.slug;
        }
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

    // Lead virou CLIENTE → religa IA automaticamente em todas as conversations
    // pra que a skill "Sophia — Pós-Venda" (area='Acompanhamento') assuma.
    // Não trata de aba (já é automático via lead.is_client=true em conversations);
    // só garante que a IA esteja ON pra atender o cliente.
    //
    // Não filtramos por ai_mode_source='MANUAL': o ciclo de venda terminou,
    // a Pós-Venda é o novo estado natural. Operador que quiser manter manual
    // pode desligar de novo via toggle do chat.
    if (stage === 'FINALIZADO') {
      this.prisma.conversation.updateMany({
        where: { lead_id: id },
        data: {
          ai_mode: true,
          ai_mode_source: 'POS_VENDA',
          ai_mode_disabled_at: null,
        },
      }).then((res) => {
        if (res.count > 0) {
          this.logger.log(`[POS_VENDA] Religou IA em ${res.count} conversation(s) do lead ${id} ao virar cliente`);
        }
      }).catch((err) =>
        this.logger.warn(`[POS_VENDA] Falha ao religar IA do lead ${id}: ${err.message}`),
      );
    }

    // ─── HOOK Lead → Patient ───────────────────────────────────────────
    // Quando o lead avança pra "Avaliação Aceita" (agendou) ou "Avaliação
    // Realizada" (compareceu), criar Patient automaticamente. Sem isso, o
    // dentista atende e não consegue criar Quote (que exige Patient existir).
    //
    // Idempotente: PatientsService.convertFromLead retorna o existente se
    // já houver Patient com lead_id vinculado (não duplica).
    //
    // Best-effort: se falhar, não bloqueia o setStage. O log avisa pra
    // investigação posterior. Roda em background com .then/.catch.
    const PATIENT_TRIGGER_SLUGS = new Set([
      'avaliacao-aceita',     // marcou avaliação
      'avaliacao-realizada',  // compareceu (dentista vai atender)
      'assinatura-contrato',  // entrou em fase de fechamento
      'contrato-assinado',    // fechou venda (is_won)
      'tratamento-iniciado',  // funil simples (odonto-clinico)
    ]);
    const shouldEnsurePatient =
      (stageSlug && PATIENT_TRIGGER_SLUGS.has(stageSlug)) || stage === 'FINALIZADO';
    if (shouldEnsurePatient) {
      const tid = tenantId ?? lead.tenant_id ?? undefined;
      if (tid) {
        // Resolve via ModuleRef pra evitar dependência circular no boot do módulo
        // (mesmo padrão usado acima pra FollowupService).
        try {
          const patientsService = this.moduleRef.get(PatientsService, { strict: false });
          if (patientsService) {
            patientsService.convertFromLead(id, tid).then((p: { id: string }) => {
              this.logger.log(`[LEAD→PATIENT] Lead ${id} (stage=${stageSlug || stage}) garantido Patient ${p.id}`);
            }).catch((err: Error) =>
              this.logger.warn(`[LEAD→PATIENT] Falha ao converter lead ${id}: ${err.message}`),
            );
          }
        } catch {
          // PatientsModule pode não estar carregado em contextos de teste — ignorar
        }
      }
    }

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

  /**
   * Garante (cria se não existir) o Patient vinculado a este lead.
   * Idempotente. Endpoint público pra reparar leads antigos ou como
   * fallback do hook em updateStatus. Resolve PatientsService via
   * ModuleRef pra evitar dependência circular.
   */
  async ensurePatient(leadId: string, tenantId?: string) {
    const lead = await this.prisma.lead.findUnique({
      where: { id: leadId },
      select: { id: true, tenant_id: true },
    });
    if (!lead) throw new NotFoundException('Lead não encontrado');
    const tid = tenantId ?? lead.tenant_id ?? undefined;
    if (!tid) throw new ForbiddenException('Tenant ausente — não é possível criar Patient');

    const patientsService = this.moduleRef.get(PatientsService, { strict: false });
    if (!patientsService) {
      throw new BadRequestException('PatientsService indisponível no contexto');
    }
    return patientsService.convertFromLead(leadId, tid);
  }

  /**
   * Funil 2 — gradua o lead vinculado ao paciente pra "Em Fechamento"
   * (etapa oculta do Kanban CRM, visivel em /atendimento/fechamentos).
   *
   * Usado por:
   *  - QuotesService.create / getOrCreateDraft (dra criou orcamento)
   *  - PatientsController.startAttending (dra clicou "Atender" na ficha)
   *
   * Idempotente, best-effort. Pula sem erro quando:
   *   - Patient nao tem lead vinculado (cadastro direto, sem captacao)
   *   - Lead nao tem pipeline_id (lead legado puro)
   *   - Pipeline nao tem stage 'em-fechamento' (ex: odonto-clinico, b2b)
   *   - Lead ja esta em won/lost/em-fechamento (nao regride)
   *
   * Retorna o lead atualizado se moveu, ou null se nao precisou mover.
   */
  async graduateLeadToEmFechamento(
    patientId: string,
    tenantId: string,
    userId?: string,
  ): Promise<Lead | null> {
    const patient = await this.prisma.patient.findUnique({
      where: { id: patientId },
      select: { lead_id: true },
    });
    if (!patient?.lead_id) return null;

    const lead = await this.prisma.lead.findUnique({
      where: { id: patient.lead_id },
      select: { id: true, pipeline_id: true, stage_id: true },
    });
    if (!lead?.pipeline_id) return null;

    const currentStage = lead.stage_id
      ? await (this.prisma as any).pipelineStage.findUnique({
          where: { id: lead.stage_id },
          select: { slug: true, is_won: true, is_lost: true },
        })
      : null;
    if (currentStage?.is_won || currentStage?.is_lost) return null;
    if (currentStage?.slug === 'em-fechamento') return null;

    const targetStage = await (this.prisma as any).pipelineStage.findFirst({
      where: { pipeline_id: lead.pipeline_id, slug: 'em-fechamento' },
      select: { id: true },
    });
    if (!targetStage) return null;

    const updated = await this.updateStatus(
      lead.id,
      undefined,        // stage (legado) — resolvido via stage_id
      tenantId,
      undefined,        // loss_reason
      userId,
      targetStage.id,
    );
    this.logger.log(`[GRADUATE→EM_FECHAMENTO] Lead ${lead.id} graduado (patient ${patientId})`);
    return updated;
  }

  /**
   * Onda 14.53 — Promove Lead a Cliente apos primeiro pagamento.
   * Onda 14.54 — Tambem migra stage do Lead pra FINALIZADO ("deixa de ser
   * lead totalmente"): sumir de qualquer filtro/view de lead, religar IA com
   * skill POS_VENDA, gravar historico de stage.
   *
   * Idempotente: se ja eh cliente (is_client=true), retorna alreadyClient:true
   * sem efeito colateral. Best-effort: exceções logam mas nao falham o caller
   * (webhook de pagamento — nao pode quebrar o fluxo financeiro).
   *
   * Disparado pelo PaymentGatewayService quando Installment vira PAGA via
   * webhook Asaas. Estrategia em 2 passos:
   *
   *   PASSO 1 (sempre, garantido):
   *     SET Lead.is_client = true, became_client_at = now()
   *     -> WhatsApp: conversa do lead some da aba "Leads", aparece em "Clientes"
   *        (InboxSidebar filtra por Lead.is_client via clientMode toggle)
   *     -> IA: ai.processor.ts detecta is_client=true e força skill
   *        'Acompanhamento' (pos-venda) em vez da skill comercial padrao
   *     -> Memory: memory-prompts.ts injeta { is_client: true } no contexto
   *
   *   PASSO 2 (best-effort, pode falhar):
   *     updateStatus(stage='FINALIZADO') que ALEM de re-setar is_client (idem),
   *     muda stage do lead pra FINALIZADO -> lead some de QUALQUER view de
   *     lead (Kanban tradicional ja oculta FINALIZADO/PERDIDO), cria
   *     LeadStageHistory, religa IA com ai_mode_source='POS_VENDA'.
   *     Pode falhar se Conversation nao tem specialty (gate existente em
   *     updateStatus linha ~688). Nesse caso, lead fica is_client=true mas
   *     stage continua o que era — operador pode finalizar manualmente depois.
   */
  async graduateLeadToClient(
    patientId: string,
    tenantId: string,
    userId?: string,
  ): Promise<{ ok: boolean; leadId?: string; alreadyClient?: boolean; stageFinalized?: boolean }> {
    const patient = await this.prisma.patient.findUnique({
      where: { id: patientId },
      select: { id: true, tenant_id: true, lead_id: true },
    });
    if (!patient) return { ok: false };
    if (patient.tenant_id !== tenantId) return { ok: false };
    if (!patient.lead_id) return { ok: false };

    const lead = await this.prisma.lead.findUnique({
      where: { id: patient.lead_id },
      select: { id: true, is_client: true, stage: true },
    });
    if (!lead) return { ok: false };
    if (lead.is_client) {
      // Idempotente — varias parcelas pagas no mesmo lead nao fazem efeito extra
      return { ok: true, leadId: lead.id, alreadyClient: true };
    }

    // PASSO 1: Sempre seta is_client=true imediatamente (garantido).
    // Mesmo se PASSO 2 falhar, o paciente ja eh tratado como cliente nas
    // demais visualizacoes (WhatsApp, IA).
    await this.prisma.lead.update({
      where: { id: lead.id },
      data: {
        is_client: true,
        became_client_at: new Date(),
        // cs_user_id so atualiza se foi fornecido (operador manual). Webhook
        // nao passa userId, fica null. Sem regredir cs_user_id ja existente.
        ...(userId ? { cs_user_id: userId } : {}),
      },
    });
    this.logger.log(
      `[LEAD→CLIENT] Lead ${lead.id} (patient ${patientId}) promovido a cliente (is_client=true)`,
    );

    // Onda 17.64 — virou paciente → cancela follow-ups de LEAD em andamento (não
    // recebe mais nutrição comercial). Só sequências 'LEADS' — mantém 'CLIENTS'
    // (manutenção) e 'COBRANCA'. Best-effort: não derruba a conversão.
    // (updateMany não filtra por relação no where → findMany por categoria + updateMany por id.)
    try {
      const leadEnrolls = await this.prisma.followupEnrollment.findMany({
        where: {
          lead_id: lead.id,
          status: { in: ['ATIVO', 'PAUSADO'] },
          sequence: { category: { in: ['LEADS', 'REENGAJAMENTO'] } },
        },
        select: { id: true },
      });
      if (leadEnrolls.length) {
        const ids = leadEnrolls.map((e) => e.id);
        await this.prisma.followupEnrollment.updateMany({
          where: { id: { in: ids } },
          data: { status: 'CANCELADO', paused_reason: 'Lead virou paciente' },
        });
        // Limpa mensagens PENDENTES DE APROVAÇÃO desses enrollments — senão o operador
        // poderia aprovar e enviar nutrição de lead pro paciente (path fora do processStep).
        await this.prisma.followupMessage.updateMany({
          where: { enrollment_id: { in: ids }, status: 'PENDENTE_APROVACAO' },
          data: { status: 'REJEITADO' },
        });
        this.logger.log(
          `[LEAD→CLIENT] ${leadEnrolls.length} follow-up(s) de lead cancelado(s) pro lead ${lead.id}`,
        );
      }
    } catch (e: any) {
      this.logger.warn(`[LEAD→CLIENT] Falha ao cancelar follow-ups de lead: ${e?.message}`);
    }

    // PASSO 2: Tenta tambem mover stage pra FINALIZADO (best-effort).
    // Se ja esta em FINALIZADO/PERDIDO, skip. Se falhar (ex: gate de
    // specialty), apenas loga — is_client ja garantiu o essencial.
    let stageFinalized = false;
    if (lead.stage !== 'FINALIZADO' && lead.stage !== 'PERDIDO') {
      try {
        await this.updateStatus(
          lead.id,
          'FINALIZADO',     // stage legado
          tenantId,
          undefined,        // lossReason — nao aplica
          userId,           // actorId opcional
          undefined,        // stageIdArg — resolvido via dual-write do updateStatus
        );
        stageFinalized = true;
        this.logger.log(
          `[LEAD→CLIENT] Lead ${lead.id} tambem migrado pro stage FINALIZADO`,
        );
      } catch (err: any) {
        this.logger.warn(
          `[LEAD→CLIENT] Stage transition pra FINALIZADO falhou (lead.is_client=true permanece): ${err?.message}`,
        );
      }
    }

    return { ok: true, leadId: lead.id, stageFinalized };
  }

  /**
   * Onda 17.32.55 — Demove um cliente de volta a Lead.
   *
   * Usado quando TODAS as cobrancas ativas do paciente sao canceladas/
   * estornadas (operador cancelou no Asaas, ou refund). Reverte:
   *   - is_client=false, became_client_at=null
   *   - stage volta pra NEGOCIACAO (ou o que era antes — best-effort, nao
   *     temos historico facil de qual stage estava ANTES do FINALIZADO).
   *     Usa NEGOCIACAO como default sensato.
   *   - Religa IA em modo COMERCIAL (volta pra negociacao)
   *
   * Idempotente: se ja eh is_client=false, retorna sem efeito.
   */
  async demoteLeadFromClient(
    patientId: string,
    tenantId: string,
  ): Promise<{ ok: boolean; leadId?: string; alreadyLead?: boolean }> {
    const patient = await this.prisma.patient.findUnique({
      where: { id: patientId },
      select: { id: true, tenant_id: true, lead_id: true },
    });
    if (!patient) return { ok: false };
    if (patient.tenant_id !== tenantId) return { ok: false };
    if (!patient.lead_id) return { ok: false };

    const lead = await this.prisma.lead.findUnique({
      where: { id: patient.lead_id },
      select: { id: true, is_client: true, stage: true },
    });
    if (!lead) return { ok: false };
    if (!lead.is_client) {
      return { ok: true, leadId: lead.id, alreadyLead: true };
    }

    await this.prisma.lead.update({
      where: { id: lead.id },
      data: {
        is_client: false,
        became_client_at: null,
        // Volta pra NEGOCIACAO so se estava em FINALIZADO (efeito da
        // graduacao). Se ja estava em outro stage, preserva — operador
        // pode ter mudado manualmente.
        ...(lead.stage === 'FINALIZADO' ? {
          stage: 'NEGOCIACAO',
          stage_entered_at: new Date(),
        } : {}),
      },
    });

    this.logger.log(
      `[CLIENT→LEAD] Lead ${lead.id} (patient ${patientId}) demovido a lead (is_client=false)`,
    );

    // Religa IA em modo COMERCIAL se estava em POS_VENDA (volta pra
    // negociacao). Se operador colocou MANUAL, respeita.
    this.prisma.conversation.updateMany({
      where: {
        lead_id: lead.id,
        ai_mode_source: 'POS_VENDA',
      },
      data: {
        ai_mode_source: 'COMERCIAL',
        // Mantem ai_mode como estava
      },
    }).catch((err) =>
      this.logger.warn(`[CLIENT→LEAD] Falha ao reverter ai_mode_source: ${err.message}`),
    );

    return { ok: true, leadId: lead.id };
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
  async deleteContact(id: string, tenantId?: string): Promise<{ ok: boolean }> {
    const lead = await this.prisma.lead.findUnique({ where: { id }, select: { id: true, tenant_id: true } });
    if (!lead) throw new NotFoundException('Contato não encontrado');
    // Onda 17.61 (segurança/CRÍTICO) — isolamento de tenant ANTES do cascade. Destrutivo
    // e irreversível: chamador escopado só apaga contato do PRÓPRIO tenant (null-tenant
    // legado também bloqueado). SUPER_ADMIN (tenantId undefined) segue cross-tenant.
    if (tenantId && lead.tenant_id !== tenantId) {
      throw new ForbiddenException('Acesso negado a este recurso');
    }

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

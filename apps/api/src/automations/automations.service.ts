import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { Cron, CronExpression } from '@nestjs/schedule';
import { excludeLabWhere, getLabTenantIds, isLabTenant, type Prisma } from '@crm/shared';
import { PrismaService } from '../prisma/prisma.service';
import { FollowupService } from '../followup/followup.service';
import { LAB_AUTOMACAO_ERROS } from './lab-automacoes-textos';

/**
 * Regra de uma clínica só age nas conversas dela; regra global (sem tenant) vale
 * para todas. Conversa sem clínica (legado): como antes — mesmo critério do
 * onNewLead/onStageChange sem tenantId.
 */
export function regraValeParaConversa(
  rule: { tenant_id?: string | null },
  conv: { tenant_id?: string | null },
): boolean {
  return !rule.tenant_id || !conv.tenant_id || rule.tenant_id === conv.tenant_id;
}

@Injectable()
export class AutomationsService {
  private readonly logger = new Logger(AutomationsService.name);

  constructor(
    private prisma: PrismaService,
    private moduleRef: ModuleRef,
  ) {}

  // ─── CRUD ──────────────────────────────────────────────────────

  async findAll(tenantId?: string) {
    // F2 [LAB-GATE] — o ADMIN do laboratório vê só as regras da conta dele: as globais
    // (sem conta) são das clínicas. Clínica: o mesmo where (só a leitura cacheada).
    const lab = await isLabTenant(this.prisma, tenantId, (m) => this.logger.warn(m));
    return this.prisma.automationRule.findMany({
      where: tenantId ? (lab ? { tenant_id: tenantId } : { OR: [{ tenant_id: tenantId }, { tenant_id: null }] }) : {},
      orderBy: { created_at: 'asc' },
    });
  }

  async create(data: { name: string; trigger: string; action: string; action_value: string; tenant_id?: string }) {
    await this.conferirSequencia(data.action, data.action_value, data.tenant_id);
    return this.prisma.automationRule.create({ data });
  }

  async update(id: string, data: { name?: string; trigger?: string; action?: string; action_value?: string; enabled?: boolean }, tenantId?: string) {
    const regra = await this.regraDaConta(id, tenantId);
    // Ligar e desligar não passa pela conferência: só muda o alvo quem muda ação ou valor.
    if (data.action !== undefined || data.action_value !== undefined) {
      await this.conferirSequencia(data.action ?? regra.action, data.action_value ?? regra.action_value, tenantId);
    }
    // Lista fechada: conta e id da regra não mudam por esta rota.
    const { name, trigger, action, action_value, enabled } = data;
    return this.prisma.automationRule.update({ where: { id }, data: { name, trigger, action, action_value, enabled } });
  }

  async remove(id: string, tenantId?: string) {
    await this.regraDaConta(id, tenantId);
    await this.prisma.automationRule.delete({ where: { id } });
    return { ok: true };
  }

  /**
   * A regra que quem chama pode editar ou apagar: a da própria conta e, na clínica, a
   * global (é a que a tela lista). Regra de outra conta responde como inexistente; no
   * laboratório a global também (ela é das clínicas).
   */
  private async regraDaConta(id: string, tenantId?: string) {
    const regra = await this.prisma.automationRule.findUnique({
      where: { id },
      select: { tenant_id: true, action: true, action_value: true },
    });
    if (!regra) throw new NotFoundException('Regra de automação não encontrada');
    const globalNaClinica = !regra.tenant_id && !(await isLabTenant(this.prisma, tenantId, (m) => this.logger.warn(m)));
    if (tenantId && regra.tenant_id !== tenantId && !globalNaClinica) throw new NotFoundException('Regra de automação não encontrada');
    return regra;
  }

  /**
   * A regra que inicia sequência aponta para sequência da própria conta. Clínica: também
   * vale a global; valor que não é sequência conhecida segue como antes (o envio ignora).
   */
  private async conferirSequencia(action: string, actionValue: string, tenantId?: string): Promise<void> {
    if (action !== 'ENROLL_FOLLOWUP' || !tenantId) return;
    const seq = await this.prisma.followupSequence.findUnique({ where: { id: actionValue }, select: { tenant_id: true } });
    if (await isLabTenant(this.prisma, tenantId, (m) => this.logger.warn(m))) {
      if (seq?.tenant_id !== tenantId) throw new BadRequestException(LAB_AUTOMACAO_ERROS.sequenciaDeOutraConta);
      return;
    }
    if (seq?.tenant_id && seq.tenant_id !== tenantId) throw new BadRequestException('Escolha uma sequência de follow-up desta clínica.');
  }

  /**
   * F2 [LAB-GATE] — lead de laboratório: só as regras da conta dele agem. As globais
   * (sem conta, feitas para as clínicas) e as de outra conta ficam fora. Clínica: as
   * mesmas regras (o mesmo array). Sem conta no gancho, vale a do lead.
   */
  private async semRegrasDeClinicaNoLab<R extends { tenant_id: string | null }>(
    rules: R[],
    leadId: string,
    tenantId?: string,
  ): Promise<R[]> {
    if (!rules.length) return rules;
    const labs = await getLabTenantIds(this.prisma, (m) => this.logger.warn(m));
    if (!labs.size) return rules;
    const conta =
      tenantId || (await this.prisma.lead.findUnique({ where: { id: leadId }, select: { tenant_id: true } }))?.tenant_id;
    if (!conta || !labs.has(conta)) {
      // Lead de clínica ou legado sem conta: regra de LABORATÓRIO nunca age fora dele.
      const semDeLab = rules.filter((r) => !(r.tenant_id && labs.has(r.tenant_id)));
      if (semDeLab.length === rules.length) return rules;
      this.logger.log(`[LAB-GATE] automacoes — lead ${leadId} não é do laboratório: ${rules.length - semDeLab.length} regra(s) de laboratório fora`);
      return semDeLab;
    }
    const daConta = rules.filter((r) => r.tenant_id === conta);
    this.logger.log(`[LAB-GATE] automacoes — lead ${leadId} é de laboratório: ${rules.length - daConta.length} regra(s) de clínica fora`);
    return daConta;
  }

  // ─── Execution helpers ─────────────────────────────────────────

  /** Clínica do lead/conversa da automação (a tarefa nasce nela); senão, a da regra. */
  private async clinicaDoContexto(
    rule: { tenant_id?: string | null },
    context: { leadId?: string; conversationId?: string },
  ): Promise<string | null> {
    if (context.leadId) {
      const l = await this.prisma.lead.findUnique({ where: { id: context.leadId }, select: { tenant_id: true } });
      if (l?.tenant_id) return l.tenant_id;
    }
    if (context.conversationId) {
      const c = await this.prisma.conversation.findUnique({ where: { id: context.conversationId }, select: { tenant_id: true } });
      if (c?.tenant_id) return c.tenant_id;
    }
    return rule.tenant_id ?? null;
  }

  private async executeAction(
    rule: { action: string; action_value: string; tenant_id?: string | null },
    context: { leadId?: string; conversationId?: string },
  ) {
    try {
      if (rule.action === 'ADD_TAG' && context.leadId) {
        const lead = await this.prisma.lead.findUnique({
          where: { id: context.leadId },
          select: { tags: true },
        });
        if (lead) {
          const tags = lead.tags as string[];
          if (!tags.includes(rule.action_value)) {
            await this.prisma.lead.update({
              where: { id: context.leadId },
              data: { tags: [...tags, rule.action_value] },
            });
          }
        }
      }

      if (rule.action === 'SEND_INTERNAL_NOTE' && context.conversationId) {
        await this.prisma.message.create({
          data: {
            conversation_id: context.conversationId,
            text: `Automação: ${rule.action_value}`,
            type: 'note',
            direction: 'OUTBOUND',
            status: 'SENT',
          },
        });
      }

      if (rule.action === 'CHANGE_STAGE' && context.leadId) {
        await this.prisma.lead.update({
          where: { id: context.leadId },
          data: { stage: rule.action_value },
        });
      }

      // ENROLL_FOLLOWUP — enrola o lead em uma sequência de follow-up pelo ID
      if (rule.action === 'ENROLL_FOLLOWUP' && context.leadId) {
        try {
          const followupService = this.moduleRef.get(FollowupService, { strict: false });
          if (followupService) {
            await followupService.enrollLead(context.leadId, rule.action_value);
          }
        } catch (e: any) {
          this.logger.warn(`[AUTO] Falha ao enrolar lead em followup: ${e.message}`);
        }
      }

      // Sprint 5: CREATE_TASK — cria tarefa vinculada ao lead/conversa
      if (rule.action === 'CREATE_TASK') {
        let cfg: { title?: string; description?: string; due_hours?: number } = {};
        try { cfg = JSON.parse(rule.action_value); } catch {
          cfg = { title: rule.action_value };
        }
        if (cfg.title) {
          const dueAt = cfg.due_hours
            ? new Date(Date.now() + cfg.due_hours * 3_600_000)
            : null;
          // Sem tenant_id a tarefa aparecia na lista de tarefas de TODAS as clínicas.
          const tenantId = await this.clinicaDoContexto(rule, context);
          await this.prisma.task.create({
            data: {
              ...(tenantId ? { tenant_id: tenantId } : {}),
              title: cfg.title,
              description: cfg.description,
              lead_id: context.leadId ?? null,
              conversation_id: context.conversationId ?? null,
              due_at: dueAt,
              status: 'A_FAZER',
            },
          });
        }
      }
    } catch (err) {
      this.logger.error(`Erro ao executar automação (action=${rule.action}): ${err}`);
    }
  }

  // ─── Hook: NEW_LEAD ────────────────────────────────────────────

  async onNewLead(leadId: string, tenantId?: string) {
    const todas = await this.prisma.automationRule.findMany({
      where: {
        trigger: 'NEW_LEAD',
        enabled: true,
        ...(tenantId ? { OR: [{ tenant_id: tenantId }, { tenant_id: null }] } : {}),
      },
    });
    const rules = await this.semRegrasDeClinicaNoLab(todas, leadId, tenantId);
    for (const rule of rules) {
      await this.executeAction(rule, { leadId });
    }
  }

  // ─── Hook: STAGE_CHANGE ────────────────────────────────────────

  async onStageChange(leadId: string, newStage: string, tenantId?: string) {
    const todas = await this.prisma.automationRule.findMany({
      where: {
        trigger: 'STAGE_CHANGE',
        enabled: true,
        ...(tenantId ? { OR: [{ tenant_id: tenantId }, { tenant_id: null }] } : {}),
      },
    });
    const rules = await this.semRegrasDeClinicaNoLab(todas, leadId, tenantId);
    for (const rule of rules) {
      // action_value can be 'ANY' or a specific stage
      if (rule.action_value === 'ANY' || rule.action === 'ADD_TAG' || rule.action === 'SEND_INTERNAL_NOTE') {
        await this.executeAction(rule, { leadId });
      } else if (rule.action === 'CHANGE_STAGE' && rule.action_value === newStage) {
        await this.executeAction(rule, { leadId });
      }
    }
  }

  // ─── Cron: NO_RESPONSE_24H e 48H ─────────────────────────────

  @Cron(CronExpression.EVERY_HOUR)
  async checkNoResponse() {
    this.logger.log('Checking no-response automations...');
    const now = new Date();
    const h24 = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const h25 = new Date(now.getTime() - 25 * 60 * 60 * 1000);
    const h48 = new Date(now.getTime() - 48 * 60 * 60 * 1000);
    const h49 = new Date(now.getTime() - 49 * 60 * 60 * 1000);

    const rules24 = await this.prisma.automationRule.findMany({
      where: { trigger: 'NO_RESPONSE_24H', enabled: true },
    });
    const rules48 = await this.prisma.automationRule.findMany({
      where: { trigger: 'NO_RESPONSE_48H', enabled: true },
    });

    // Laboratório: a conversa dele só entra se a PRÓPRIA conta tem regra ligada para o
    // gatilho (a regra é o opt-in; ENROLL_FOLLOWUP ainda exige sequência da conta e
    // ligada). Conversa de laboratório sem regra própria não entra. Regra de laboratório
    // vale só na conversa dele; regra global ou de outra conta nunca atinge conversa de
    // laboratório. Clínica: sem laboratório o where é o mesmo objeto; com laboratório, a
    // conversa sem conta (tenant_id NULL) de contato de clínica continua entrando.
    const labs = await getLabTenantIds(this.prisma, (m) => this.logger.warn(m));
    const comRegraPropria = new Set<string>();
    for (const r of [...rules24, ...rules48]) if (r.tenant_id && labs.has(r.tenant_id)) comRegraPropria.add(r.tenant_id);
    const labsFora: ReadonlySet<string> = comRegraPropria.size ? new Set([...labs].filter((id) => !comRegraPropria.has(id))) : labs;
    if (labsFora.size) this.logger.log(`[LAB] no-response — ${labsFora.size} laboratório(s) sem regra própria fora da busca`);
    const foraDoLab = (where: Prisma.ConversationWhereInput): Prisma.ConversationWhereInput =>
      labsFora.size ? excludeLabWhere('conversation', { ...where, lead: excludeLabWhere('lead', {}, labsFora) }, labsFora) : where;
    // A conta da conversa: a dela e, na legada sem conta, a do contato.
    const contaDaConversa = async (conv: { tenant_id?: string | null; lead_id?: string | null }): Promise<string | null> => {
      if (conv.tenant_id) return conv.tenant_id;
      if (!labs.size || !conv.lead_id) return null;
      return (await this.prisma.lead.findUnique({ where: { id: conv.lead_id }, select: { tenant_id: true } }))?.tenant_id ?? null;
    };
    const vale = async (rule: { tenant_id?: string | null }, conv: { tenant_id?: string | null; lead_id?: string | null }) => {
      if (!regraValeParaConversa(rule, conv)) return false;
      // Sem laboratório com regra própria, nenhum laboratório está na busca: nada a conferir.
      if (!comRegraPropria.size) return true;
      const conta = await contaDaConversa(conv);
      if (rule.tenant_id && labs.has(rule.tenant_id)) return conta === rule.tenant_id;
      return !(conta && labs.has(conta));
    };

    if (rules24.length > 0) {
      // Conversations last active between 25h and 24h ago (1-hour window to avoid re-triggering)
      const convs = await this.prisma.conversation.findMany({
        where: foraDoLab({
          status: { not: 'FECHADO' },
          last_message_at: { gte: h25, lte: h24 },
        }),
        select: { id: true, lead_id: true, tenant_id: true },
      });
      for (const conv of convs) {
        for (const rule of rules24) {
          if (!(await vale(rule, conv))) continue;
          await this.executeAction(rule, { conversationId: conv.id, leadId: conv.lead_id ?? undefined });
        }
      }
      if (convs.length > 0) this.logger.log(`NO_RESPONSE_24H: executado em ${convs.length} conversa(s)`);
    }

    if (rules48.length > 0) {
      const convs = await this.prisma.conversation.findMany({
        where: foraDoLab({
          status: { not: 'FECHADO' },
          last_message_at: { gte: h49, lte: h48 },
        }),
        select: { id: true, lead_id: true, tenant_id: true },
      });
      for (const conv of convs) {
        for (const rule of rules48) {
          if (!(await vale(rule, conv))) continue;
          await this.executeAction(rule, { conversationId: conv.id, leadId: conv.lead_id ?? undefined });
        }
      }
      if (convs.length > 0) this.logger.log(`NO_RESPONSE_48H: executado em ${convs.length} conversa(s)`);
    }
  }

  // ─── Cron: PAYMENT_OVERDUE ─────────────────────────────────────
  // Cron desativado na transição para odontologia. A Fase 2 vai
  // reimplementar baseado em Installment (parcelamento odonto).
  @Cron(CronExpression.EVERY_DAY_AT_9AM)
  async checkPaymentOverdue() {
    const rules = await this.prisma.automationRule.findMany({
      where: { trigger: 'PAYMENT_OVERDUE', enabled: true },
    });
    if (rules.length === 0) return;
    this.logger.warn('[AUTOMATIONS] PAYMENT_OVERDUE desativado temporariamente na transição odonto. Será reativado com Installment.');
  }
}

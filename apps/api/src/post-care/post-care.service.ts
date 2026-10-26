import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { SettingsService } from '../settings/settings.service';
import { isLabTenant } from '@crm/shared';
import {
  PostCareConfig, DEFAULT_CONFIG, analyzeSentiment, renderInitialMessage,
  renderThanks, renderApology, InitialChoice,
} from './post-care-templates';
import { escolherCamposPostCare, gravarPostCareConfigDaConta, lerPostCareConfigBruta } from './post-care-config';

@Injectable()
export class PostCareService {
  private readonly logger = new Logger(PostCareService.name);

  constructor(
    private prisma: PrismaService,
    private settings: SettingsService,
  ) {}

  // ─── Config (GlobalSetting POR CONTA: POST_CARE_CONFIG_<tenantId>) ──────────

  /**
   * Config da conta: a chave da conta; sem ela, a global antiga se a conta for
   * legada; senão o padrão. Sem conta: a global antiga (como antes).
   */
  async getConfig(tenantId?: string | null): Promise<PostCareConfig> {
    let raw: Record<string, any> | null = null;
    try {
      raw = await lerPostCareConfigBruta(this.prisma, tenantId, (m) => this.logger.warn(m));
    } catch (e: any) {
      // Como antes (settings.get): erro de leitura = padrão.
      this.logger.error(`Erro ao buscar POST_CARE_CONFIG (tenant ${tenantId ?? '-'}): ${e?.message}`);
    }
    return raw ? { ...DEFAULT_CONFIG, ...raw } : { ...DEFAULT_CONFIG };
  }

  /**
   * Grava SÓ na chave da conta. A base é a config que a conta estava vendo (com a
   * herança da global antiga), então o 1º salvamento não perde nada. Do corpo, só
   * os 8 campos conhecidos (o resto é ignorado: a tela manda o objeto inteiro).
   */
  async updateConfig(tenantId: string | null | undefined, patch: unknown): Promise<PostCareConfig> {
    if (!tenantId) throw new BadRequestException('tenant_id ausente');
    const current = await this.getConfig(tenantId);
    const next = { ...current, ...escolherCamposPostCare(patch) };
    if (next.delay_hours < 1) next.delay_hours = 1;
    if (next.delay_hours > 48) next.delay_hours = 48;
    const validChoices: InitialChoice[] = ['descontraido', 'formal', 'breve', 'custom'];
    if (!validChoices.includes(next.initial_choice)) next.initial_choice = 'descontraido';
    await gravarPostCareConfigDaConta(this.prisma, tenantId, next as unknown as Record<string, unknown>);
    return next;
  }

  // ─── Listagem + stats ───────────────────────────────────────────────────────

  async listSurveys(
    tenantId: string,
    filters: {
      status?: string; sentiment?: string;
      from?: Date; to?: Date;
      dentist_id?: string;
      take?: number;
    } = {},
  ) {
    return this.prisma.postCareSurvey.findMany({
      where: {
        tenant_id: tenantId,
        ...(filters.status ? { status: filters.status } : {}),
        ...(filters.sentiment ? { sentiment: filters.sentiment } : {}),
        ...(filters.dentist_id ? { dentist_id: filters.dentist_id } : {}),
        ...(filters.from || filters.to
          ? {
              trigger_at: {
                ...(filters.from ? { gte: filters.from } : {}),
                ...(filters.to ? { lte: filters.to } : {}),
              },
            }
          : {}),
      },
      orderBy: { trigger_at: 'desc' },
      take: filters.take ?? 100,
      include: {
        patient: { select: { id: true, name: true, phone: true } },
        dentist: { select: { id: true, name: true } },
        appointment: { select: { id: true, title: true, start_at: true } },
      },
    });
  }

  async getStats(tenantId: string, days: number = 30) {
    const since = new Date();
    since.setDate(since.getDate() - days);

    const surveys = await this.prisma.postCareSurvey.findMany({
      where: { tenant_id: tenantId, created_at: { gte: since } },
      select: { status: true, sentiment: true, score: true, responded_at: true, sent_at: true },
    });

    const total = surveys.length;
    const sent = surveys.filter((s) => s.sent_at != null).length;
    const responded = surveys.filter((s) => s.responded_at != null).length;
    const positive = surveys.filter((s) => s.sentiment === 'POSITIVE').length;
    const negative = surveys.filter((s) => s.sentiment === 'NEGATIVE').length;
    const neutral = surveys.filter((s) => s.sentiment === 'NEUTRAL').length;

    const scores = surveys.map((s) => s.score).filter((n): n is number => n != null);
    const avg_score = scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : null;

    // NPS-like: % positivos - % negativos (entre os que responderam)
    const nps = responded > 0
      ? Math.round(((positive - negative) / responded) * 100)
      : null;

    return {
      total, sent, responded,
      response_rate: sent > 0 ? Math.round((responded / sent) * 100) : 0,
      positive, negative, neutral,
      avg_score: avg_score != null ? Number(avg_score.toFixed(1)) : null,
      nps,
      pending: surveys.filter((s) => s.status === 'PENDING').length,
      failed: surveys.filter((s) => s.status === 'FAILED').length,
    };
  }

  // ─── Criacao automatica (chamada pelo cron / hook) ──────────────────────────

  /**
   * Cria PostCareSurvey PENDING para um CalendarEvent CONCLUIDO se ainda nao existir.
   * Retorna a survey criada (ou existente).
   */
  async ensureSurveyForAppointment(
    appointmentId: string,
    cfg?: PostCareConfig,
    escopoTenantId?: string | null,
  ): Promise<{ survey_id: string; created: boolean } | null> {
    const event = await this.prisma.calendarEvent.findUnique({
      where: { id: appointmentId },
      select: {
        id: true, tenant_id: true, patient_id: true, assigned_user_id: true,
        title: true, start_at: true, end_at: true, status: true, type: true,
      },
    });
    if (!event || !event.tenant_id || !event.patient_id) return null;
    // Chamada de uma conta (test-send): consulta de OUTRA conta não cria nada —
    // mesma resposta da consulta inexistente.
    if (escopoTenantId && event.tenant_id !== escopoTenantId) return null;
    if (event.status !== 'CONCLUIDO') return null;
    if (event.type !== 'CONSULTA') return null; // so consultas
    // F2 [LAB-GATE] — pesquisa pós-atendimento (NPS da consulta) é de clínica: evento de
    // laboratório não ganha pesquisa (cobre o cron e o test-send). Clínica: só a leitura.
    if (await isLabTenant(this.prisma, event.tenant_id, (m) => this.logger.warn(m))) {
      this.logger.log(`[LAB-GATE] pesquisa-pos-atendimento — evento ${event.id} é de laboratório: sem pesquisa`);
      return null;
    }

    const config = cfg || (await this.getConfig(event.tenant_id));
    if (!config.enabled) return null;

    // Ja existe?
    const existing = await this.prisma.postCareSurvey.findUnique({
      where: { appointment_id: event.id },
    });
    if (existing) return { survey_id: existing.id, created: false };

    const baseAt = event.end_at || event.start_at;
    const triggerAt = new Date(baseAt.getTime() + config.delay_hours * 60 * 60 * 1000);

    const created = await this.prisma.postCareSurvey.create({
      data: {
        tenant_id: event.tenant_id,
        patient_id: event.patient_id,
        appointment_id: event.id,
        dentist_id: event.assigned_user_id,
        procedure_summary: event.title,
        trigger_at: triggerAt,
        status: 'PENDING',
      },
    });

    this.logger.log(
      `[PostCare] Survey criada appointment=${appointmentId} trigger_at=${triggerAt.toISOString()}`,
    );
    return { survey_id: created.id, created: true };
  }

  // ─── Captura de resposta (chamado pelo webhook Evolution) ───────────────────

  /**
   * Procura survey SENT recente desse paciente (ultimas 48h) e grava resposta.
   * Retorna a survey atualizada se encontrar match.
   */
  async tryCaptureResponse(
    tenantId: string,
    patientId: string,
    text: string,
  ): Promise<{ survey_id: string; sentiment: string; escalated: boolean } | null> {
    if (!text || !text.trim()) return null;

    const cutoff = new Date();
    cutoff.setHours(cutoff.getHours() - 48);

    const survey = await this.prisma.postCareSurvey.findFirst({
      where: {
        tenant_id: tenantId,
        patient_id: patientId,
        status: 'SENT',
        sent_at: { gte: cutoff },
        responded_at: null,
      },
      orderBy: { sent_at: 'desc' },
    });
    if (!survey) return null;

    const { score, sentiment } = analyzeSentiment(text);

    await this.prisma.postCareSurvey.update({
      where: { id: survey.id },
      data: {
        status: 'RESPONDED',
        responded_at: new Date(),
        comment: text.slice(0, 2000),
        score,
        sentiment,
      },
    });

    let escalated = false;
    const config = await this.getConfig(tenantId);

    if (sentiment === 'NEGATIVE') {
      escalated = await this.escalateToAdmins(tenantId, survey.id, text);
      if (config.send_apology_on_negative) {
        await this.queueAutoReply(survey.id, 'apology');
      }
    } else if (sentiment === 'POSITIVE' && config.send_thanks_on_positive) {
      await this.queueAutoReply(survey.id, 'thanks');
    }

    return { survey_id: survey.id, sentiment, escalated };
  }

  // ─── Escalacao admins via Notification ──────────────────────────────────────

  private async escalateToAdmins(
    tenantId: string,
    surveyId: string,
    text: string,
  ): Promise<boolean> {
    const survey = await this.prisma.postCareSurvey.findUnique({
      where: { id: surveyId },
      include: {
        patient: { select: { id: true, name: true } },
        dentist: { select: { name: true } },
      },
    });
    if (!survey) return false;

    // Busca admins do tenant
    const admins = await this.prisma.user.findMany({
      where: {
        tenant_id: tenantId,
        roles: { has: 'ADMIN' },
      },
      select: { id: true },
    });

    if (admins.length === 0) {
      this.logger.warn(`[PostCare] Nenhum ADMIN no tenant ${tenantId} para notificar`);
      return false;
    }

    const title = `Feedback negativo de ${survey.patient.name}`;
    const body =
      survey.dentist?.name
        ? `Atendimento com ${survey.dentist.name}: "${text.slice(0, 120)}"`
        : `"${text.slice(0, 120)}"`;

    await this.prisma.notification.createMany({
      data: admins.map((u) => ({
        user_id: u.id,
        tenant_id: tenantId,
        notification_type: 'post_care_negative',
        title,
        body,
        data: {
          survey_id: surveyId,
          patient_id: survey.patient.id,
          appointment_id: survey.appointment_id,
        },
      })),
    });

    await this.prisma.postCareSurvey.update({
      where: { id: surveyId },
      data: { escalated_at: new Date() },
    });

    this.logger.log(`[PostCare] Survey ${surveyId} escalada pra ${admins.length} admin(s)`);
    return true;
  }

  /**
   * Stub: enfileira auto-reply (thanks/apology) — implementacao real fica
   * no worker, que pega config + dispara via Evolution. Aqui so deixa marcado
   * num campo extra do JSON pra worker pegar. Pra MVP simples, vou deixar
   * um TODO e o worker manda direto sem enfileiramento separado.
   */
  private async queueAutoReply(surveyId: string, kind: 'thanks' | 'apology') {
    // Implementacao via campo data extra ou nova fila — placeholder por enquanto
    this.logger.log(`[PostCare] Auto-reply ${kind} pendente para survey ${surveyId} (worker dispara)`);
  }

  // ─── Helpers para o worker ──────────────────────────────────────────────────

  /** Lista surveys prontas pra disparar (status=PENDING e trigger_at <= now). */
  async findReadyToSend(limit: number = 50) {
    const now = new Date();
    return this.prisma.postCareSurvey.findMany({
      where: { status: 'PENDING', trigger_at: { lte: now } },
      orderBy: { trigger_at: 'asc' },
      take: limit,
      include: {
        patient: { select: { id: true, name: true, phone: true, tenant_id: true } },
        dentist: { select: { name: true } },
      },
    });
  }

  async markSent(surveyId: string, evolutionMessageId?: string) {
    return this.prisma.postCareSurvey.update({
      where: { id: surveyId },
      data: {
        status: 'SENT',
        sent_at: new Date(),
        evolution_message_id: evolutionMessageId || null,
      },
    });
  }

  async markFailed(surveyId: string, error: string) {
    return this.prisma.postCareSurvey.update({
      where: { id: surveyId },
      data: { status: 'FAILED', last_error: error.slice(0, 500) },
    });
  }

  /** Escaneia consultas concluidas recentes sem survey e cria. Chamado pelo cron. */
  async scanCompletedAppointments(): Promise<number> {
    const since = new Date();
    since.setDate(since.getDate() - 1); // ultimas 24h
    const events = await this.prisma.calendarEvent.findMany({
      where: {
        status: 'CONCLUIDO',
        type: 'CONSULTA',
        updated_at: { gte: since },
        post_care_survey: null, // ainda sem survey
        patient_id: { not: null },
      },
      select: { id: true, tenant_id: true },
      take: 200,
    });

    let created = 0;
    for (const ev of events) {
      if (!ev.tenant_id) continue;
      const result = await this.ensureSurveyForAppointment(ev.id);
      if (result?.created) created++;
    }
    if (created > 0) {
      this.logger.log(`[PostCare] Cron: ${created} survey(s) criada(s)`);
    }
    return created;
  }

  /** Renderiza mensagem inicial pra um survey (usado pelo worker). */
  async renderInitialFor(surveyId: string): Promise<{ phone: string; text: string } | null> {
    const survey = await this.prisma.postCareSurvey.findUnique({
      where: { id: surveyId },
      include: {
        patient: { select: { id: true, name: true, phone: true } },
        dentist: { select: { name: true } },
      },
    });
    if (!survey || !survey.patient.phone) return null;

    const cfg = await this.getConfig(survey.tenant_id);
    const firstName = survey.patient.name.split(' ')[0];
    const dentistName = survey.dentist?.name
      ? `Dr(a). ${survey.dentist.name.split(' ').slice(0, 2).join(' ')}`
      : 'a equipe';
    const procedure = (survey.procedure_summary || 'sua consulta').toLowerCase();

    const text = renderInitialMessage(cfg, {
      patient_name: firstName,
      dentist_name: dentistName,
      procedure,
    });

    return { phone: survey.patient.phone, text };
  }
}

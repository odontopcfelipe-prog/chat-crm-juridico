import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { PrismaService } from '../prisma/prisma.service';
import { SettingsService } from '../settings/settings.service';
import axios from 'axios';

interface StaleConfig {
  stage: string; days: number; msg: string;
}

@Injectable()
export class FollowupCronService {
  private readonly logger = new Logger(FollowupCronService.name);

  constructor(
    private prisma: PrismaService,
    private settings: SettingsService,
    @InjectQueue('followup-jobs') private followupQueue: Queue,
  ) {}

  /**
   * Seg-Sex 9h — Processa enrollments com next_send_at vencido + legacy follow-up de estágios
   */
  @Cron('0 9 * * 1-5', { timeZone: 'America/Maceio' })
  async checkStaleLeads() {
    this.logger.log('[FOLLOWUP] Iniciando verificação...');
    await Promise.all([
      this.processEnrollments(),
      this.legacyStageFollowup(),
    ]);
  }

  /**
   * A cada hora — processa enrollments prontos para envio
   */
  @Cron('0 * * * *', { timeZone: 'America/Maceio' })
  async processEnrollments() {
    const now = new Date();
    const enrollments = await this.prisma.followupEnrollment.findMany({
      where: { status: 'ATIVO', next_send_at: { lte: now } },
      select: { id: true },
      take: 50,
    });

    this.logger.log(`[FOLLOWUP] ${enrollments.length} enrollment(s) prontos para processamento`);

    for (const e of enrollments) {
      await this.followupQueue.add('process-step', { enrollment_id: e.id }, {
        jobId: `enroll-${e.id}-${Date.now()}`, removeOnComplete: true,
      });
    }
  }

  /**
   * Legacy: follow-up básico para stages hardcoded (fallback sem sequência configurada)
   */
  private async legacyStageFollowup() {
    const staleConfigs: StaleConfig[] = [
      { stage: 'AGUARDANDO_DOCS', days: 3, msg: 'Olá {{name}}, tudo bem? Estamos aguardando os documentos para dar continuidade ao seu caso. Precisa de ajuda com isso?' },
      { stage: 'AGUARDANDO_PROC', days: 3, msg: 'Olá {{name}}, a procuração ainda não foi assinada. Precisa de alguma orientação para finalizar?' },
      { stage: 'AGUARDANDO_FORM', days: 2, msg: 'Olá {{name}}, você ainda não concluiu o formulário. Precisa de ajuda para preencher?' },
      { stage: 'QUALIFICANDO', days: 5, msg: 'Olá {{name}}, estamos à disposição para continuar o atendimento do seu caso. Podemos prosseguir?' },
    ];

    let totalSent = 0;
    for (const config of staleConfigs) {
      try {
        const cutoff = new Date(Date.now() - config.days * 24 * 60 * 60 * 1000);
        const leads = await this.prisma.lead.findMany({
          where: {
            stage: config.stage, updated_at: { lt: cutoff },
            OR: [{ last_followup_at: null }, { last_followup_at: { lt: cutoff } }],
            // Pular leads que já estão em alguma sequência ativa
            followup_enrollments: { none: { status: 'ATIVO' } },
          },
          include: { conversations: { where: { status: 'ABERTO' }, take: 1, orderBy: { last_message_at: 'desc' } } },
        });

        for (const lead of leads) {
          if (!lead.conversations?.length) continue;
          const convo = lead.conversations[0];
          if (convo.last_message_at) {
            const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
            if (convo.last_message_at > oneDayAgo) continue;
          }
          try { await this.sendLegacyFollowup(lead, convo, config.msg); totalSent++; } catch { /**/ }
        }
      } catch (e: any) {
        this.logger.error(`[FOLLOWUP-LEGACY] Erro stage ${config.stage}: ${e.message}`);
      }
    }
    if (totalSent > 0) this.logger.log(`[FOLLOWUP-LEGACY] ${totalSent} follow-up(s) legacy enviado(s)`);
  }

  private async sendLegacyFollowup(lead: any, convo: any, template: string) {
    const { apiUrl, apiKey } = await this.settings.getEvolutionConfig();
    if (!apiUrl) return;
    const instanceName = convo.instance_name || process.env.EVOLUTION_INSTANCE_NAME || '';
    const msg = template.replace(/\{\{name\}\}/g, lead.name || 'cliente');
    await axios.post(`${apiUrl}/message/sendText/${instanceName}`, { number: lead.phone, text: `*Sophia:* ${msg}` }, { headers: { 'Content-Type': 'application/json', apikey: apiKey }, timeout: 15000 });
    await this.prisma.message.create({ data: { conversation_id: convo.id, direction: 'out', type: 'text', text: msg, external_message_id: `sys_followup_legacy_${Date.now()}`, status: 'enviado' } });
    await Promise.all([
      this.prisma.conversation.update({ where: { id: convo.id }, data: { last_message_at: new Date() } }),
      this.prisma.lead.update({ where: { id: lead.id }, data: { last_followup_at: new Date() } }),
    ]);
    this.logger.log(`[FOLLOWUP-LEGACY] Enviado para ${lead.phone}`);
  }
}

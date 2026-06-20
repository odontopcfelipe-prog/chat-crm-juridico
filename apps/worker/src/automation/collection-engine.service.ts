import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import axios from 'axios';
import { PrismaService } from '../prisma/prisma.service';
import { SettingsService } from '../settings/settings.service';
import { toBrazilWhatsappNumber } from '@crm/shared';

/**
 * Engine de regua de cobranca — Fase 11.
 *
 * Cron diario 09:00 (Maceio): para cada Installment ABERTA/PARCIAL/ATRASADA,
 * determina se atingiu uma das etapas (PRE_DUE_3D | DUE_DAY | D_PLUS_1 |
 * D_PLUS_7 | D_PLUS_15 | D_PLUS_30) e ainda nao foi processada (campo
 * collection_stage). Se sim:
 *  1. Marca status=ATRASADA quando due_date < now (a partir de DUE_DAY)
 *  2. Cria CollectionAttempt com mensagem padrao da etapa
 *  3. Tenta enviar via Evolution API
 *  4. Atualiza collection_stage + last_collection_at no Installment
 *
 * Idempotencia: a verificacao de collection_stage evita reenvio na mesma
 * etapa. Se cron rodar 2x no mesmo dia, segunda execucao nao faz nada.
 */
@Injectable()
export class CollectionEngineService {
  private readonly logger = new Logger(CollectionEngineService.name);

  constructor(
    private prisma: PrismaService,
    private settings: SettingsService,
  ) {}

  @Cron('0 9 * * *', { timeZone: 'America/Maceio' })
  async run() {
    try {
      const now = new Date();

      // Janela: parcelas com due_date entre 30 dias antes e 3 dias depois
      const windowStart = new Date(now); windowStart.setDate(windowStart.getDate() - 30);
      const windowEnd = new Date(now); windowEnd.setDate(windowEnd.getDate() + 3);

      const installments = await this.prisma.installment.findMany({
        where: {
          status: { in: ['ABERTA', 'PARCIAL', 'ATRASADA'] },
          due_date: { gte: windowStart, lte: windowEnd },
        },
        include: {
          patient: { select: { id: true, name: true, phone: true, tenant_id: true } },
        },
        take: 200,
      });

      if (installments.length === 0) return;

      // Cache config Evolution + instances por tenant
      const { apiUrl, apiKey } = await this.settings.getEvolutionConfig();
      const evolutionOk = !!(apiUrl && apiKey);
      const instanceByTenant = new Map<string, string | null>();

      let processed = 0;
      let sent = 0;
      let skipped = 0;

      for (const inst of installments) {
        const stage = this.computeStage(inst.due_date, now);
        if (!stage) { skipped++; continue; }
        if (inst.collection_stage === stage) { skipped++; continue; }

        // Marca ATRASADA se passou do vencimento
        const shouldMarkOverdue =
          inst.status !== 'ATRASADA' &&
          (stage === 'D_PLUS_1' || stage === 'D_PLUS_7' || stage === 'D_PLUS_15' || stage === 'D_PLUS_30');

        const message = this.buildMessage(stage, inst.patient.name, inst.amount, inst.due_date);

        await this.prisma.installment.update({
          where: { id: inst.id },
          data: {
            collection_stage: stage,
            last_collection_at: now,
            ...(shouldMarkOverdue ? { status: 'ATRASADA' } : {}),
          },
        });

        const attempt = await this.prisma.collectionAttempt.create({
          data: {
            installment_id: inst.id,
            stage,
            channel: 'WHATSAPP',
            message_text: message,
            sent_at: now,
            delivery_status: inst.patient.phone && evolutionOk ? 'PENDING' : 'FAILED',
          },
        });

        processed++;

        // Tenta enviar via Evolution
        if (!inst.patient.phone) {
          await this.markFailed(attempt.id, 'Paciente sem telefone');
          continue;
        }
        if (!evolutionOk) {
          await this.markFailed(attempt.id, 'Evolution API nao configurada');
          continue;
        }

        // Resolve instance do tenant (cache)
        let instance = instanceByTenant.get(inst.patient.tenant_id);
        if (instance === undefined) {
          const inst2 = await this.prisma.instance.findFirst({
            where: { tenant_id: inst.patient.tenant_id },
            select: { name: true },
          });
          instance = inst2?.name || null;
          instanceByTenant.set(inst.patient.tenant_id, instance);
        }
        if (!instance) {
          await this.markFailed(attempt.id, 'Sem Evolution instance no tenant');
          continue;
        }

        try {
          await axios.post(
            `${apiUrl}/message/sendText/${instance}`,
            { number: toBrazilWhatsappNumber(inst.patient.phone), text: message },
            { headers: { 'Content-Type': 'application/json', apikey: apiKey }, timeout: 15000 },
          );
          await this.prisma.collectionAttempt.update({
            where: { id: attempt.id },
            data: { delivery_status: 'SENT' },
          });
          sent++;
        } catch (err: any) {
          const reason = err?.response?.data?.message || err?.message || 'erro';
          await this.markFailed(attempt.id, reason);
        }
      }

      this.logger.log(
        `[CollectionEngine] ${processed} parcela(s) processada(s), ${sent} mensagem(ns) enviada(s), ` +
        `${skipped} pulada(s)`,
      );
    } catch (e: any) {
      this.logger.error(`[CollectionEngine] Erro: ${e.message}`);
    }
  }

  /** Calcula stage baseado na diferenca entre due_date e now em dias. */
  private computeStage(dueDate: Date, now: Date): string | null {
    const ms = now.getTime() - new Date(dueDate).getTime();
    const days = Math.floor(ms / (1000 * 60 * 60 * 24));
    if (days === -3) return 'PRE_DUE_3D';
    if (days === 0) return 'DUE_DAY';
    if (days === 1) return 'D_PLUS_1';
    if (days === 7) return 'D_PLUS_7';
    if (days === 15) return 'D_PLUS_15';
    if (days === 30) return 'D_PLUS_30';
    return null;
  }

  private buildMessage(stage: string, patientName: string, amount: any, dueDate: Date): string {
    const firstName = patientName.split(' ')[0];
    const value = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(Number(amount));
    const date = new Date(dueDate).toLocaleDateString('pt-BR');

    switch (stage) {
      case 'PRE_DUE_3D':
        return `Ola ${firstName}! Lembrete amigavel: sua parcela de ${value} vence em 3 dias (${date}). ` +
               `Para evitar juros, garanta o pagamento ate la. Qualquer duvida estamos aqui!`;
      case 'DUE_DAY':
        return `Ola ${firstName}! Sua parcela de ${value} vence HOJE (${date}). ` +
               `Caso ja tenha pago, ignore esta mensagem. Precisa do PIX/boleto?`;
      case 'D_PLUS_1':
        return `Ola ${firstName}, identificamos que sua parcela de ${value} ` +
               `(venc. ${date}) ainda nao foi paga. Pode regularizar hoje?`;
      case 'D_PLUS_7':
        return `Oi ${firstName}, ja se passou 1 semana do vencimento da parcela de ${value} ` +
               `(${date}). Vamos resolver? Podemos te ajudar com renegociacao.`;
      case 'D_PLUS_15':
        return `Ola ${firstName}, sua parcela de ${value} esta com 15 dias de atraso. ` +
               `Precisamos urgentemente combinar uma forma de pagamento — entre em contato.`;
      case 'D_PLUS_30':
        return `${firstName}, ultima notificacao antes de tomarmos medidas adicionais. ` +
               `Parcela de ${value} esta com 30 dias de atraso. Por favor, regularize ou ` +
               `entre em contato para renegociar.`;
      default:
        return `Lembrete: voce tem uma parcela de ${value} pendente.`;
    }
  }

  private async markFailed(attemptId: string, reason: string) {
    await this.prisma.collectionAttempt.update({
      where: { id: attemptId },
      data: {
        delivery_status: 'FAILED',
        message_text: `[ERRO: ${reason.slice(0, 200)}]`,
      },
    });
  }
}

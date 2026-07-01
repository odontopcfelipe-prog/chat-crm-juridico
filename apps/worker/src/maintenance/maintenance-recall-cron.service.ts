import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { SettingsService } from '../settings/settings.service';
import { toBrazilWhatsappNumber } from '@crm/shared';
import axios from 'axios';

/**
 * Mensagem padrao do recall. A clinica pode sobrescrever setando a chave
 * RECALL_MESSAGE_TEMPLATE (TenantSetting por clinica, ou GlobalSetting).
 * Placeholders: {nome} {procedimento} {data}. Aqui e o lugar de adicionar
 * o upsell (ex: "aproveite pra avaliar um clareamento") — sem mexer no codigo.
 */
const DEFAULT_RECALL_TEMPLATE =
  'Olá, {nome}! 👋\n\n' +
  'Aqui é da clínica — está chegando a data da sua revisão de *{procedimento}*: {data}.\n\n' +
  'Quer que eu agende para você? É só responder esta mensagem com o melhor dia/horário e a gente confirma. 😊';

/**
 * Worker cron de recall de manutencao — PACED / marca-passo (Onda 18).
 *
 * ANTES: rodava 2x/dia (8h/14h) e mandava ate 200 WhatsApp DE UMA VEZ (rajada)
 *   -> risco alto de BANIR o chip da clinica.
 * AGORA: roda a cada minuto no horario comercial e solta NO MAXIMO 1 recall por
 *   vez, respeitando um intervalo ALEATORIO de 3-7 min entre envios. Da ~1 msg a
 *   cada 3-7 min = ~90-120 recalls/dia no horario comercial, sem rajada. O
 *   excedente escorre pro dia seguinte (reminder_sent_at continua null).
 *
 * Idempotente: filtro reminder_sent_at IS NULL + marca na TENTATIVA (sucesso OU
 * falha de envio) pra nao travar a fila num numero invalido — recall nao e
 * critico e a task segue visivel no widget de Manutencoes de qualquer forma.
 *
 * NOTA: o cooldown e em memoria (assume 1 replica do worker — cron em N replicas
 * ja duplicaria TODOS os crons, entao o worker roda unico). Se um dia escalar o
 * worker, mover lastRecallSentAt pra Redis/DB (chave compartilhada).
 */
@Injectable()
export class MaintenanceRecallCronService {
  private readonly logger = new Logger(MaintenanceRecallCronService.name);

  /** Marca-passo: quando saiu o ultimo recall + gap sorteado ate o proximo. */
  private lastRecallSentAt = 0;
  private nextGapMs = 0;

  private static readonly PACE_MIN_MS = 3 * 60_000; // 3 min
  private static readonly PACE_MAX_MS = 7 * 60_000; // 7 min

  constructor(
    private prisma: PrismaService,
    private settings: SettingsService,
  ) {}

  // ─── Marca-passo: 1 recall por tick, a cada minuto no horario comercial ──
  //   8-17h (ultimo envio ~17:59), seg-sabado, fuso Maceio. O cooldown interno
  //   (3-7 min) e quem controla o ritmo — o cron so "bate o ponto" de minuto.

  @Cron('*/1 8-17 * * 1-6', { timeZone: 'America/Maceio' })
  async pacerTick() {
    await this.sendOnePacedRecall();
  }

  // ─── Varredura diaria de MISSED (fora do horario, 1x/dia) ───────────────

  @Cron('0 3 * * *', { timeZone: 'America/Maceio' })
  async dailyMissedSweep() {
    await this.autoMarkMissed();
  }

  /**
   * Solta NO MAXIMO 1 recall, respeitando o intervalo aleatorio desde o ultimo.
   * Chamado a cada minuto; a maioria das chamadas so checa o cooldown e sai.
   */
  async sendOnePacedRecall(): Promise<'sent' | 'failed' | 'cooldown' | 'empty'> {
    const nowMs = Date.now();
    if (nowMs - this.lastRecallSentAt < this.nextGapMs) return 'cooldown';

    const now = new Date();
    const in7days = new Date();
    in7days.setDate(in7days.getDate() + 7);

    const task = await (this.prisma as any).maintenanceTask.findFirst({
      where: {
        status: { in: ['PENDING', 'SCHEDULED'] },
        due_date: { gte: now, lte: in7days },
        reminder_sent_at: null,
        patient: { phone: { not: null } },
      },
      include: {
        patient: { select: { id: true, name: true, phone: true, tenant_id: true } },
        procedure: { select: { name: true } },
      },
      orderBy: { due_date: 'asc' }, // o mais proximo de vencer primeiro
    });

    if (!task) return 'empty'; // nada pra mandar — NAO mexe no cooldown

    // Telefone vazio (passou pelo not:null como string vazia) — marca e sai
    // pra nao travar a fila numa task sem telefone.
    if (!task.patient.phone?.trim()) {
      await this.markAttempted(task.id, null);
      return 'failed';
    }

    const dueDateStr = new Date(task.due_date).toLocaleDateString('pt-BR', {
      day: '2-digit', month: 'long',
    });
    const firstName = task.patient.name.split(' ')[0];
    const procName = task.procedure?.name || task.title;
    const template = await this.resolveRecallTemplate(task.patient.tenant_id);
    const msg = template
      .replace(/\{nome\}/g, firstName)
      .replace(/\{procedimento\}/g, procName)
      .replace(/\{data\}/g, dueDateStr);

    const messageId = await this.sendWhatsApp(task.patient.phone, msg);

    // Config do Evolution ausente: NAO gasta o slot, tenta de novo no proximo tick.
    if (messageId === 'NO_CONFIG') return 'cooldown';

    // Marca na TENTATIVA (sucesso OU falha) e avanca o marca-passo — assim um
    // numero invalido nao trava os proximos recalls.
    await this.markAttempted(task.id, typeof messageId === 'string' ? messageId : null);
    this.lastRecallSentAt = nowMs;
    this.nextGapMs = this.randomGapMs();

    if (messageId === false) {
      this.logger.warn(`[RECALL] Envio falhou pra task ${task.id} — pulando (marcado como tentado).`);
      return 'failed';
    }
    this.logger.log(
      `[RECALL] Recall enviado (task ${task.id}); proximo em ~${Math.round(this.nextGapMs / 60000)}min`,
    );
    return 'sent';
  }

  /** Marca o recall como tratado (evita reenvio na proxima varredura). */
  private async markAttempted(taskId: string, messageId: string | null): Promise<void> {
    try {
      await (this.prisma as any).maintenanceTask.update({
        where: { id: taskId },
        data: { reminder_sent_at: new Date(), reminder_message_id: messageId },
      });
    } catch (e: any) {
      this.logger.warn(`[RECALL] Falha ao marcar reminder em task ${taskId}: ${e.message}`);
    }
  }

  /** Sorteia o proximo intervalo (3-7 min) — jitter humano, ritmo nao-robotico. */
  private randomGapMs(): number {
    const { PACE_MIN_MS, PACE_MAX_MS } = MaintenanceRecallCronService;
    return Math.floor(PACE_MIN_MS + Math.random() * (PACE_MAX_MS - PACE_MIN_MS));
  }

  /**
   * Resolve o template do recall: TenantSetting da clinica -> GlobalSetting ->
   * default. A clinica edita a chave RECALL_MESSAGE_TEMPLATE pra customizar o
   * convite + upsell, sem deploy.
   */
  private async resolveRecallTemplate(tenantId: string): Promise<string> {
    try {
      const ts = await (this.prisma as any).tenantSetting.findUnique({
        where: { tenant_id_key: { tenant_id: tenantId, key: 'RECALL_MESSAGE_TEMPLATE' } },
      });
      if (ts?.value?.trim()) return ts.value;
      const gs = await this.prisma.globalSetting.findUnique({
        where: { key: 'RECALL_MESSAGE_TEMPLATE' },
      });
      if (gs?.value?.trim()) return gs.value;
    } catch {
      // tabela/registro ausente — cai no default
    }
    return DEFAULT_RECALL_TEMPLATE;
  }

  /**
   * Marca como MISSED tasks PENDING/SCHEDULED com due_date >= 1 dia atrasada.
   * Tolera 1 dia de "graca" pra evitar marcar overnight (ex: due hoje 23:50).
   */
  async autoMarkMissed(): Promise<number> {
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);

    const result = await (this.prisma as any).maintenanceTask.updateMany({
      where: {
        status: { in: ['PENDING', 'SCHEDULED'] },
        due_date: { lt: yesterday },
      },
      data: { status: 'MISSED' },
    });

    if (result.count > 0) {
      this.logger.log(`[RECALL] ${result.count} task(s) marcada(s) como MISSED (atraso > 1d)`);
    }
    return result.count;
  }

  // ─── Helpers ─────────────────────────────────────────────────────────

  /**
   * Envia mensagem WhatsApp via Evolution API.
   * Retorna: messageId (string) em sucesso, false em falha de envio, ou
   * 'NO_CONFIG' se o Evolution nao esta configurado (pra nao gastar o slot).
   */
  private async sendWhatsApp(phone: string, text: string): Promise<string | false | 'NO_CONFIG'> {
    const { apiUrl, apiKey } = await this.settings.getEvolutionConfig();
    if (!apiUrl) {
      this.logger.warn('[RECALL] Evolution apiUrl nao configurada — pulando');
      return 'NO_CONFIG';
    }
    try {
      const instance = process.env.EVOLUTION_INSTANCE_NAME || 'whatsapp';
      const cleanPhone = toBrazilWhatsappNumber(phone);
      const res = await axios.post(
        `${apiUrl}/message/sendText/${instance}`,
        { number: cleanPhone, text },
        { headers: { apikey: apiKey }, timeout: 15000 },
      );
      return res.data?.key?.id || res.data?.messageId || (true as any);
    } catch (e: any) {
      this.logger.warn(`[RECALL] Falha WhatsApp para ${phone}: ${e.message}`);
      return false;
    }
  }
}

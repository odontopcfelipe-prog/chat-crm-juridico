import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { SettingsService } from '../settings/settings.service';
import { toBrazilWhatsappNumber, DEFAULT_RECALL_TEMPLATE } from '@crm/shared';
import axios from 'axios';

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

    // Toggle da Central (card "Recall de revisão"): default LIGADO — o motor já
    // rodava pra todo mundo; o card permite DESLIGAR (só 'false' desliga). Excluímos
    // as clínicas OFF DIRETO no banco (não no take): a fila é CROSS-tenant e ordenada
    // por vencimento — sem isso, uma clínica OFF com muitas tasks na frente
    // ENTUPIRIA a fila e zeraria o recall de TODAS as outras (starvation).
    const offRows = await this.prisma.globalSetting.findMany({
      where: { key: { startsWith: 'RECALL_PREVENTIVO_ENABLED_' }, value: 'false' },
      select: { key: true },
    }).catch(() => [] as { key: string }[]);
    const offTenants = offRows
      .map((r) => r.key.slice('RECALL_PREVENTIVO_ENABLED_'.length))
      .filter(Boolean);

    const task = await (this.prisma as any).maintenanceTask.findFirst({
      where: {
        status: { in: ['PENDING', 'SCHEDULED'] },
        due_date: { gte: now, lte: in7days },
        reminder_sent_at: null,
        patient: {
          phone: { not: null },
          ...(offTenants.length ? { tenant_id: { notIn: offTenants } } : {}),
        },
      },
      include: {
        patient: { select: { id: true, name: true, phone: true, tenant_id: true } },
        procedure: { select: { name: true } },
      },
      orderBy: { due_date: 'asc' }, // o mais proximo de vencer primeiro
    });
    if (!task) return 'empty'; // nada pra mandar — NAO mexe no cooldown

    // Defesa em profundidade: se o toggle foi desligado ENTRE as duas queries (ou a
    // lista de OFF falhou), reconfere a task escolhida. OFF → pula o tick (sem marcar;
    // o próximo tick já exclui no banco). Cobre a corrida sem reabrir o starvation.
    if (!(await this.isRecallEnabled(task.patient?.tenant_id || ''))) return 'empty';

    // Telefone vazio (passou pelo not:null como string vazia) — marca e sai
    // pra nao travar a fila numa task sem telefone.
    if (!task.patient.phone?.trim()) {
      await this.markAttempted(task.id, null);
      return 'failed';
    }

    // CLAIM ATOMICO (anti-duplicidade) — reivindica reminder_sent_at ANTES de enviar.
    // Antes era read-then-send-then-mark: 2 execucoes concorrentes (sobreposicao de
    // deploy/restart, ou >1 replica no futuro) liam reminder_sent_at:null e enviavam 2x
    // ao paciente. Agora so quem vira null->agora (count===1) envia; a outra ve count===0
    // e pula. Em NO_CONFIG (nao enviou) o claim e LIBERADO abaixo pra tentar no proximo tick.
    const claim = await (this.prisma as any).maintenanceTask.updateMany({
      where: { id: task.id, reminder_sent_at: null },
      data: { reminder_sent_at: new Date() },
    });
    if (claim.count === 0) return 'empty'; // outra execucao ja reivindicou — nao duplica

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

    const messageId = await this.sendWhatsApp(task.patient.phone, msg, task.patient.tenant_id);

    // Config do Evolution ausente: NAO enviou → LIBERA o claim (reminder_sent_at volta
    // a null) pra tentar no proximo tick, e NAO gasta o slot do marca-passo.
    if (messageId === 'NO_CONFIG') {
      await (this.prisma as any).maintenanceTask
        .updateMany({ where: { id: task.id }, data: { reminder_sent_at: null } })
        .catch(() => undefined);
      return 'cooldown';
    }

    // Marca na TENTATIVA (sucesso OU falha) e avanca o marca-passo — assim um
    // numero invalido nao trava os proximos recalls.
    await this.markAttempted(task.id, typeof messageId === 'string' ? messageId : null);
    // Central 2.0 — registro unificado (métrica + resumo "pra quem mandou").
    await this.logDispatchUnificado(task.patient.tenant_id, task.patient.name, task.patient.phone, messageId);
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

  /** Toggle da Central: RECALL_PREVENTIVO_ENABLED_<tenant>. Default LIGADO (o motor
   *  sempre rodou pra todo mundo) — só o valor 'false' desliga. */
  private async isRecallEnabled(tenantId: string): Promise<boolean> {
    if (!tenantId) return true;
    try {
      const row = await this.prisma.globalSetting.findUnique({
        where: { key: `RECALL_PREVENTIVO_ENABLED_${tenantId}` },
      });
      return (row?.value ?? 'true') !== 'false';
    } catch {
      return true;
    }
  }

  /** Central 2.0 — registro unificado no DispatchLog (best-effort, nunca lança). */
  private async logDispatchUnificado(
    tenantId: string,
    name: string,
    phone: string,
    sendResult: string | boolean | 'NO_CONFIG',
  ): Promise<void> {
    try {
      await this.prisma.dispatchLog.create({
        data: {
          tenant_id: tenantId || '',
          type: 'recall_preventivo',
          channel: 'WHATSAPP',
          recipient_name: name,
          recipient_phone: phone,
          status: sendResult === false ? 'FAILED' : 'SENT',
          error: sendResult === false ? 'Evolution recusou o envio (número/chip)' : null,
          external_message_id: typeof sendResult === 'string' ? sendResult : null,
          sent_at: new Date(),
        },
      });
    } catch (e: any) {
      this.logger.warn(`[DISPATCH-LOG] recall_preventivo não registrou: ${e?.message}`);
    }
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
  private async sendWhatsApp(phone: string, text: string, tenantId?: string): Promise<string | false | 'NO_CONFIG'> {
    const { apiUrl, apiKey } = await this.settings.getEvolutionConfig();
    if (!apiUrl) {
      this.logger.warn('[RECALL] Evolution apiUrl nao configurada — pulando');
      return 'NO_CONFIG';
    }
    try {
      // Recall é mensagem CLÍNICA: sai pelo chip CLINICA do tenant (fallback:
      // qualquer chip que não seja o FINANCEIRO → env). Antes usava a instância
      // única do env — errada em tenant com chips separados por função.
      const instance = (await this.resolveClinicaInstance(tenantId)) || process.env.EVOLUTION_INSTANCE_NAME || 'whatsapp';
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

  /** Chip CLINICA do tenant → qualquer chip NÃO-financeiro → null (cai no env). */
  private async resolveClinicaInstance(tenantId?: string): Promise<string | null> {
    if (!tenantId) return null;
    try {
      const clinica = await this.prisma.instance.findFirst({
        where: { type: 'whatsapp', tenant_id: tenantId, purpose: 'CLINICA' },
        orderBy: { created_at: 'asc' },
        select: { name: true },
      });
      if (clinica?.name) return clinica.name;
      const naoFin = await this.prisma.instance.findFirst({
        where: { type: 'whatsapp', tenant_id: tenantId, NOT: { purpose: 'FINANCEIRO' } },
        orderBy: { created_at: 'asc' },
        select: { name: true },
      });
      return naoFin?.name ?? null;
    } catch {
      return null;
    }
  }
}

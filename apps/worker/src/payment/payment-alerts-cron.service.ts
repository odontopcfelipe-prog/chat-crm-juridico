import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { SettingsService } from '../settings/settings.service';
import { toBrazilWhatsappNumber } from '@crm/shared';
import axios from 'axios';

/**
 * Cron de COBRANÇA financeira — PACED / marca-passo (Onda 18.16).
 *
 * O quê: varre as cobranças EM ABERTO (PENDING/OVERDUE, não recebidas em espécie)
 * e, conforme o vencimento, dispara o lembrete + link do boleto pelo chip
 * FINANCEIRO. Cada estágio (1 dia antes / no dia / atraso 1d / 15d / 30d) liga e
 * desliga sozinho na Central de Disparos (GlobalSetting BOLETO_*_${tenant}).
 *
 * Anti-ban: roda a cada minuto no horário comercial (seg-sex 8h-18h, fuso Maceió)
 * e solta NO MÁXIMO 1 cobrança por vez, com intervalo ALEATÓRIO de 3-7 min entre
 * envios (mesmo marca-passo do recall). O excedente escorre pro próximo tick/dia.
 *
 * Idempotência POR ESTÁGIO: registra um AuditLog (entity=PAYMENT_ALERT,
 * entity_id=charge.id, action=stage) — cada boleto recebe no MÁXIMO uma vez cada
 * estágio, pra nunca mandar "atraso 15d" duas vezes. Marca na TENTATIVA (sucesso
 * OU falha de envio) pra um número inválido não travar a fila.
 *
 * NOTA: cooldown em memória (assume 1 réplica do worker, como os outros crons).
 */

type Stage =
  | 'boleto_1d_antes'
  | 'boleto_no_dia'
  | 'boleto_atraso_1d'
  | 'boleto_atraso_15d'
  | 'boleto_atraso_30d';

const STAGES: Stage[] = [
  'boleto_1d_antes',
  'boleto_no_dia',
  'boleto_atraso_1d',
  'boleto_atraso_15d',
  'boleto_atraso_30d',
];

/** diffDays (hoje Maceió − vencimento) → estágio. -1 = vence amanhã; 0 = hoje. */
const STAGE_BY_DIFF: Record<number, Stage> = {
  [-1]: 'boleto_1d_antes',
  0: 'boleto_no_dia',
  1: 'boleto_atraso_1d',
  15: 'boleto_atraso_15d',
  30: 'boleto_atraso_30d',
};

/** Prefixo da GlobalSetting por estágio (sufixo _${tenantId}). */
const STAGE_SETTING_PREFIX: Record<Stage, string> = {
  boleto_1d_antes: 'BOLETO_1D_ANTES',
  boleto_no_dia: 'BOLETO_NO_DIA',
  boleto_atraso_1d: 'BOLETO_ATRASO_1D',
  boleto_atraso_15d: 'BOLETO_ATRASO_15D',
  boleto_atraso_30d: 'BOLETO_ATRASO_30D',
};

/** Rascunhos aprovados pelo cliente (gentil → firme). {nome} {valor} {data} {link}. */
const STAGE_TEMPLATE: Record<Stage, string> = {
  boleto_1d_antes:
    'Oi {nome}! 😊 Passando pra lembrar que sua parcela de *{valor}* vence *amanhã ({data})*.\n\n' +
    'Segue o boleto/pix pra facilitar: {link}\n\nQualquer dúvida, é só chamar aqui!',
  boleto_no_dia:
    'Oi {nome}! 📅 Sua parcela de *{valor}* vence *hoje ({data})*.\n\n' +
    'Pra não perder o prazo, segue o boleto/pix: {link}\n\nSe já pagou, pode desconsiderar 🙏',
  boleto_atraso_1d:
    'Oi {nome}, tudo bem? Notamos que sua parcela de *{valor}* venceu ontem ({data}) e ainda consta em aberto — ' +
    'deve ser só um esquecimento 😉\n\nSegue o boleto atualizado: {link}\n\nSe já pagou, é só desconsiderar!',
  boleto_atraso_15d:
    'Oi {nome}, sua parcela de *{valor}* está em aberto há *15 dias* (venceu em {data}).\n\n' +
    'Pra regularizar e evitar juros maiores, segue o boleto atualizado: {link}\n\n' +
    'Precisa de ajuda ou quer renegociar? É só chamar a gente aqui.',
  boleto_atraso_30d:
    'Oi {nome}, sua parcela de *{valor}* está com *30 dias* de atraso (venceu em {data}).\n\n' +
    'Pedimos a gentileza de regularizar pra manter seu tratamento em dia: {link}\n\n' +
    'Se estiver com dificuldade, fale com a gente — podemos encontrar uma solução juntos.',
};

interface ChargeCandidate {
  chargeId: string;
  tenantId: string;
  stage: Stage;
  phone: string;
  name: string;
  amount: number;
  dueDate: Date;
  link: string;
}

@Injectable()
export class PaymentAlertsCronService {
  private readonly logger = new Logger(PaymentAlertsCronService.name);

  /** Marca-passo: quando saiu a última cobrança + gap sorteado até a próxima. */
  private lastSentAt = 0;
  private nextGapMs = 0;

  private static readonly PACE_MIN_MS = 3 * 60_000; // 3 min
  private static readonly PACE_MAX_MS = 7 * 60_000; // 7 min

  constructor(
    private prisma: PrismaService,
    private settings: SettingsService,
  ) {}

  // ─── Marca-passo: 1 cobrança por tick, a cada minuto no horário comercial ──
  //   seg-sex 8-17h (último envio ~17:59), fuso Maceió. O cooldown interno (3-7
  //   min) é quem controla o ritmo — o cron só "bate o ponto" de minuto.

  @Cron('*/1 8-17 * * 1-5', { timeZone: 'America/Maceio' })
  async pacerTick() {
    await this.sendOnePacedCharge();
  }

  /**
   * Solta NO MÁXIMO 1 cobrança, respeitando o intervalo aleatório desde a última.
   * Chamado a cada minuto; a maioria das chamadas só checa o cooldown e sai.
   */
  async sendOnePacedCharge(): Promise<'sent' | 'failed' | 'cooldown' | 'empty'> {
    const nowMs = Date.now();
    if (nowMs - this.lastSentAt < this.nextGapMs) return 'cooldown';

    const pick = await this.findNextCharge();
    if (!pick) return 'empty'; // nada pra mandar — NÃO mexe no cooldown

    const instanceName = await this.resolveFinanceiroInstance(pick.tenantId);
    const message = this.buildMessage(pick);
    const messageId = await this.sendWhatsApp(pick.phone, message, instanceName);

    // Evolution não configurado: NÃO gasta o slot, tenta de novo no próximo tick.
    if (messageId === 'NO_CONFIG') return 'cooldown';

    // Marca na TENTATIVA (sucesso OU falha) e avança o marca-passo — assim um
    // número inválido não trava as próximas cobranças.
    await this.logSent(pick.chargeId, pick.stage, pick.tenantId, typeof messageId === 'string' ? messageId : null);
    this.lastSentAt = nowMs;
    this.nextGapMs = this.randomGapMs();

    if (messageId === false) {
      this.logger.warn(`[COBRANCA] Envio falhou pra charge ${pick.chargeId} (${pick.stage}) — marcado como tentado.`);
      return 'failed';
    }
    this.logger.log(
      `[COBRANCA] ${pick.stage} enviado (charge ${pick.chargeId}); próximo em ~${Math.round(this.nextGapMs / 60000)}min`,
    );
    return 'sent';
  }

  /**
   * Escolhe a PRÓXIMA cobrança a lembrar: em aberto, num estágio LIGADO, com
   * telefone e link, ainda não enviada naquele estágio. A mais antiga primeiro.
   */
  private async findNextCharge(): Promise<ChargeCandidate | null> {
    const todayIdx = this.dayIndexUTC(new Date(Date.now() - 3 * 3_600_000)); // hoje Maceió
    // Janela: só o que pode bater num estágio (−31d atraso até +2d antes).
    const lo = new Date(Date.now() - 33 * 86_400_000);
    const hi = new Date(Date.now() + 3 * 86_400_000);

    const charges = await this.prisma.paymentGatewayCharge.findMany({
      where: {
        status: { in: ['PENDING', 'OVERDUE'] },
        received_in_cash: false,
        due_date: { gte: lo, lte: hi },
      },
      select: {
        id: true,
        tenant_id: true,
        amount: true,
        due_date: true,
        invoice_url: true,
        boleto_url: true,
        pix_copy_paste: true,
        treatment_plan: { select: { patient: { select: { name: true, phone: true } } } },
        installment: { select: { patient: { select: { name: true, phone: true } } } },
      },
      orderBy: { due_date: 'asc' }, // a mais antiga (mais atrasada) primeiro
      take: 500,
    });
    if (charges.length === 0) return null;

    const stageCache = new Map<string, Set<Stage>>(); // tenantId → estágios ligados
    const candidates: ChargeCandidate[] = [];
    for (const c of charges) {
      const diff = todayIdx - this.dayIndexUTC(new Date(c.due_date));
      const stage = STAGE_BY_DIFF[diff];
      if (!stage) continue;

      const patient = c.treatment_plan?.patient || c.installment?.patient;
      const phone = patient?.phone?.trim();
      if (!patient || !phone) continue;

      const link =
        c.invoice_url ||
        c.boleto_url ||
        (c.pix_copy_paste ? `Pix copia e cola:\n${c.pix_copy_paste}` : '');
      if (!link) continue; // sem link não dá pra cobrar — pula (não trava a fila)

      const tid = c.tenant_id || '';
      if (!stageCache.has(tid)) stageCache.set(tid, await this.loadEnabledStages(tid));
      if (!stageCache.get(tid)!.has(stage)) continue; // estágio desligado pro tenant

      candidates.push({
        chargeId: c.id,
        tenantId: tid,
        stage,
        phone,
        name: patient.name,
        amount: Number(c.amount),
        dueDate: new Date(c.due_date),
        link,
      });
    }
    if (candidates.length === 0) return null;

    // Anti-repetição por estágio: 1 query batch no AuditLog pros candidatos.
    const ids = candidates.map((c) => c.chargeId);
    const already = await this.prisma.auditLog.findMany({
      where: { entity: 'PAYMENT_ALERT', entity_id: { in: ids }, action: { in: STAGES } },
      select: { entity_id: true, action: true },
    });
    const sentSet = new Set(already.map((a) => `${a.entity_id}:${a.action}`));

    return candidates.find((c) => !sentSet.has(`${c.chargeId}:${c.stage}`)) || null;
  }

  /** Estágios LIGADOS pro tenant (GlobalSetting BOLETO_*_${tenant} === 'true'). */
  private async loadEnabledStages(tenantId: string): Promise<Set<Stage>> {
    const set = new Set<Stage>();
    if (!tenantId) return set;
    const keys = STAGES.map((s) => `${STAGE_SETTING_PREFIX[s]}_${tenantId}`);
    const rows = await this.prisma.globalSetting.findMany({ where: { key: { in: keys } } });
    const val = new Map(rows.map((r) => [r.key, r.value]));
    for (const s of STAGES) {
      if (val.get(`${STAGE_SETTING_PREFIX[s]}_${tenantId}`) === 'true') set.add(s);
    }
    return set;
  }

  /** Instância do chip FINANCEIRO do tenant → fallback CLINICA → env default. */
  private async resolveFinanceiroInstance(tenantId: string): Promise<string> {
    const fallback = process.env.EVOLUTION_INSTANCE_NAME || 'whatsapp';
    if (!tenantId) return fallback;
    try {
      const fin = await this.prisma.instance.findFirst({
        where: { tenant_id: tenantId, type: 'whatsapp', purpose: 'FINANCEIRO' },
        orderBy: { created_at: 'asc' },
        select: { name: true },
      });
      if (fin?.name) return fin.name;
      const clinica = await this.prisma.instance.findFirst({
        where: { tenant_id: tenantId, type: 'whatsapp', purpose: 'CLINICA' },
        orderBy: { created_at: 'asc' },
        select: { name: true },
      });
      if (clinica?.name) return clinica.name;
    } catch (e: any) {
      this.logger.warn(`[COBRANCA] Falha ao resolver instância do tenant ${tenantId}: ${e.message}`);
    }
    return fallback;
  }

  /** Monta a mensagem do estágio com nome/valor/data/link. */
  private buildMessage(c: ChargeCandidate): string {
    const firstName = c.name.split(' ')[0];
    const valor = c.amount.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
    const dd = String(c.dueDate.getUTCDate()).padStart(2, '0');
    const mm = String(c.dueDate.getUTCMonth() + 1).padStart(2, '0');
    return STAGE_TEMPLATE[c.stage]
      .replace(/\{nome\}/g, firstName)
      .replace(/\{valor\}/g, valor)
      .replace(/\{data\}/g, `${dd}/${mm}`)
      .replace(/\{link\}/g, c.link);
  }

  /** Índice do dia calendário (UTC) — vencimento vem do Asaas como data UTC. */
  private dayIndexUTC(d: Date): number {
    return Math.floor(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) / 86_400_000);
  }

  /** Sorteia o próximo intervalo (3-7 min) — jitter humano, ritmo não-robótico. */
  private randomGapMs(): number {
    const { PACE_MIN_MS, PACE_MAX_MS } = PaymentAlertsCronService;
    return Math.floor(PACE_MIN_MS + Math.random() * (PACE_MAX_MS - PACE_MIN_MS));
  }

  // ─── Helpers ───────────────────────────────────────────────────────────

  /**
   * Envia WhatsApp via Evolution numa instância específica (o chip Financeiro).
   * Retorna messageId (string) em sucesso, false em falha, 'NO_CONFIG' se o
   * Evolution não está configurado (pra não gastar o slot do marca-passo).
   */
  private async sendWhatsApp(phone: string, text: string, instance: string): Promise<string | false | 'NO_CONFIG'> {
    const { apiUrl, apiKey } = await this.settings.getEvolutionConfig();
    if (!apiUrl) {
      this.logger.warn('[COBRANCA] Evolution apiUrl não configurada — pulando');
      return 'NO_CONFIG';
    }
    try {
      const cleanPhone = toBrazilWhatsappNumber(phone);
      const res = await axios.post(
        `${apiUrl}/message/sendText/${instance}`,
        { number: cleanPhone, text },
        { headers: { apikey: apiKey }, timeout: 15000 },
      );
      return res.data?.key?.id || res.data?.messageId || (true as any);
    } catch (e: any) {
      this.logger.warn(`[COBRANCA] Falha WhatsApp para ${phone}: ${e.message}`);
      return false;
    }
  }

  /** Registra o envio do estágio (idempotência exactly-once por charge+estágio). */
  private async logSent(chargeId: string, stage: Stage, tenantId: string, messageId: string | null): Promise<void> {
    try {
      await this.prisma.auditLog.create({
        data: {
          entity: 'PAYMENT_ALERT',
          entity_id: chargeId,
          action: stage,
          meta_json: { tenant_id: tenantId, message_id: messageId, sent_at: new Date().toISOString() },
        },
      });
    } catch (e: any) {
      this.logger.warn(`[COBRANCA] Falha ao registrar AuditLog da charge ${chargeId}: ${e.message}`);
    }
  }
}

import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { SettingsService } from '../settings/settings.service';
import {
  toBrazilWhatsappNumber,
  DEFAULT_COBRANCA_TEMPLATES,
  DEFAULT_BOLETO_INTRO,
  COBRANCA_STAGES,
  cobrancaTemplateKey,
  type CobrancaStage,
} from '@crm/shared';
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

type Stage = CobrancaStage;
const STAGES = COBRANCA_STAGES;

/** diffDays (hoje Maceió − vencimento) → estágio. -1 = vence amanhã; 0 = hoje. */
const STAGE_BY_DIFF: Record<number, Stage> = {
  [-1]: 'boleto_1d_antes',
  0: 'boleto_no_dia',
  1: 'boleto_atraso_1d',
  15: 'boleto_atraso_15d',
  30: 'boleto_atraso_30d',
};

/** Prefixo da GlobalSetting do TOGGLE on/off por estágio (sufixo _${tenantId}). */
const STAGE_SETTING_PREFIX: Record<Stage, string> = {
  boleto_1d_antes: 'BOLETO_1D_ANTES',
  boleto_no_dia: 'BOLETO_NO_DIA',
  boleto_atraso_1d: 'BOLETO_ATRASO_1D',
  boleto_atraso_15d: 'BOLETO_ATRASO_15D',
  boleto_atraso_30d: 'BOLETO_ATRASO_30D',
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
  /** URL do PDF do boleto (só quando billing_type=BOLETO) — manda como documento. */
  pdfUrl: string | null;
}

/** Parte 1 — apresentação do Financeiro, 1 por VENDA (treatment_plan) fechada ontem. */
interface IntroCandidate {
  planId: string;
  tenantId: string;
  phone: string;
  name: string;
}

@Injectable()
export class PaymentAlertsCronService {
  private readonly logger = new Logger(PaymentAlertsCronService.name);

  /** Marca-passo: quando saiu a última cobrança + gap sorteado até a próxima. */
  private lastSentAt = 0;
  private nextGapMs = 0;
  /** Guard de reentrância: 1 envio por vez, mesmo se um tick passar de 60s. */
  private busy = false;

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
    // Guard de reentrância: se um tick anterior ainda está enviando (Evolution/DB
    // lentos > 60s), não deixa o próximo tick escolher o MESMO alvo e duplicar.
    if (this.busy) return 'cooldown';
    this.busy = true;
    try {
    const nowMs = Date.now();
    if (nowMs - this.lastSentAt < this.nextGapMs) return 'cooldown';

    // Parte 1 (apresentação D+1): no dia SEGUINTE ao fechamento da venda, o
    // Financeiro se apresenta e avisa que amanhã manda os boletos. Tem prioridade
    // (é sensível ao dia) e compartilha o MESMO marca-passo das cobranças, pra não
    // abrir um 2º ritmo no chip (anti-ban). Opt-in por tenant (default OFF).
    // return AWAIT: mantém o busy=true durante o envio da intro (senão o finally
    // limparia o guard antes da Promise resolver).
    const intro = await this.findNextIntro();
    if (intro) return await this.sendIntro(intro, nowMs);

    const pick = await this.findNextCharge();
    if (!pick) return 'empty'; // nada pra mandar — NÃO mexe no cooldown

    const instanceName = await this.resolveFinanceiroInstance(pick.tenantId);
    const template = await this.resolveTemplate(pick.tenantId, pick.stage);
    const clinica = await this.resolveClinicName(pick.tenantId);
    const message = this.buildMessage(pick, template, clinica);
    // Boleto → manda o PDF anexo (a mensagem vira legenda); PIX/sem-boleto seguem texto+link.
    const messageId = pick.pdfUrl
      ? await this.sendWhatsAppMedia(pick.phone, pick.pdfUrl, message, instanceName)
      : await this.sendWhatsApp(pick.phone, message, instanceName);

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
    // Onda 18.32 — registra o disparo na conversa PRÓPRIA do Financeiro (best-
    // effort): o operador vê a cobrança enviada na aba Financeiro, e a resposta
    // do paciente (chegando pelo chip financeiro) cai na MESMA conversa.
    await this.registerInFinanceiroConversation(
      pick.tenantId,
      pick.phone,
      message,
      typeof messageId === 'string' ? messageId : null,
      instanceName,
    );
    this.logger.log(
      `[COBRANCA] ${pick.stage} enviado (charge ${pick.chargeId}); próximo em ~${Math.round(this.nextGapMs / 60000)}min`,
    );
    return 'sent';
    } finally {
      this.busy = false;
    }
  }

  /**
   * Acha/cria a conversa do lead no inbox FINANCEIRO e grava a mensagem enviada.
   * Best-effort: sem inbox financeiro, sem lead pelo telefone ou qualquer erro →
   * só loga e segue (o envio já aconteceu).
   */
  private async registerInFinanceiroConversation(
    tenantId: string,
    phone: string,
    text: string,
    messageId: string | null,
    instanceName: string,
  ): Promise<void> {
    try {
      if (!tenantId) return;
      const finInbox = await this.prisma.inbox.findFirst({
        where: { tenant_id: tenantId, purpose: 'FINANCEIRO' },
        select: { id: true },
      });
      if (!finInbox) return; // tenant sem inbox financeiro — nada a registrar

      // Lead pelo telefone (mesma normalização do envio) — sem lead, não registra.
      const clean = toBrazilWhatsappNumber(phone).replace(/\D/g, '');
      const last11 = clean.slice(-11);
      const lead = await this.prisma.lead.findFirst({
        where: { tenant_id: tenantId, phone: { endsWith: last11 } },
        select: { id: true },
      });
      if (!lead) return;

      let conv = await this.prisma.conversation.findFirst({
        where: {
          lead_id: lead.id,
          channel: 'whatsapp',
          status: { not: 'ENCERRADO' },
          inbox: { purpose: 'FINANCEIRO' },
        },
        orderBy: { last_message_at: 'desc' },
        select: { id: true },
      });
      if (!conv) {
        conv = await this.prisma.conversation.create({
          data: {
            lead_id: lead.id,
            channel: 'whatsapp',
            status: 'ABERTO',
            external_id: `${clean}@s.whatsapp.net`,
            inbox_id: finInbox.id,
            instance_name: instanceName,
            tenant_id: tenantId,
            last_message_at: new Date(),
          },
          select: { id: true },
        });
      }
      await this.prisma.message.create({
        data: {
          conversation_id: conv.id,
          direction: 'out',
          type: 'text',
          text,
          external_message_id: messageId || `sys_cobranca_${Date.now()}`,
          status: 'enviado',
        },
      });
      await this.prisma.conversation.update({
        where: { id: conv.id },
        data: { last_message_at: new Date() },
      });
    } catch (e: any) {
      this.logger.warn(`[COBRANCA] Falha ao registrar na conversa do financeiro: ${e.message}`);
    }
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
        billing_type: true,
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
        pdfUrl: c.billing_type === 'BOLETO' && c.boleto_url ? c.boleto_url : null,
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
  private buildMessage(c: ChargeCandidate, template: string, clinica: string): string {
    const firstName = c.name.split(' ')[0];
    const valor = c.amount.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
    const dd = String(c.dueDate.getUTCDate()).padStart(2, '0');
    const mm = String(c.dueDate.getUTCMonth() + 1).padStart(2, '0');
    return template
      .replace(/\{nome\}/g, firstName)
      .replace(/\{valor\}/g, valor)
      .replace(/\{data\}/g, `${dd}/${mm}`)
      .replace(/\{link\}/g, c.link)
      .replace(/\{clinica\}/g, clinica);
  }

  /** Nome da clínica (Tenant.name) pra usar como {clinica} no template. */
  private async resolveClinicName(tenantId: string): Promise<string> {
    if (!tenantId) return 'a clínica';
    try {
      const t = await this.prisma.tenant.findUnique({ where: { id: tenantId }, select: { name: true } });
      return t?.name || 'a clínica';
    } catch {
      return 'a clínica';
    }
  }

  /**
   * Template do estágio: o que a clínica salvou na Central de Disparos
   * (GlobalSetting via cobrancaTemplateKey) → senão o default aprovado. Mesma
   * chave que a API grava, então editar na tela muda o que sai daqui.
   */
  private async resolveTemplate(tenantId: string, stage: Stage): Promise<string> {
    const fallback = DEFAULT_COBRANCA_TEMPLATES[stage];
    if (!tenantId) return fallback;
    try {
      const row = await this.prisma.globalSetting.findUnique({
        where: { key: cobrancaTemplateKey(stage, tenantId) },
      });
      if (row?.value) {
        const parsed = JSON.parse(row.value);
        if (typeof parsed?.template === 'string' && parsed.template.trim()) return parsed.template;
      }
    } catch (e: any) {
      this.logger.warn(`[COBRANCA] Falha ao ler template ${stage} do tenant ${tenantId}: ${e.message}`);
    }
    return fallback;
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

  /**
   * Envia o boleto como DOCUMENTO PDF (a Evolution baixa a URL pública do Asaas —
   * sem base64). `caption` é a mensagem do estágio. Mesmo contrato de retorno do
   * sendWhatsApp (messageId | false | 'NO_CONFIG').
   */
  private async sendWhatsAppMedia(
    phone: string,
    pdfUrl: string,
    caption: string,
    instance: string,
  ): Promise<string | false | 'NO_CONFIG'> {
    const { apiUrl, apiKey } = await this.settings.getEvolutionConfig();
    if (!apiUrl) {
      this.logger.warn('[COBRANCA] Evolution apiUrl não configurada — pulando');
      return 'NO_CONFIG';
    }
    try {
      const cleanPhone = toBrazilWhatsappNumber(phone);
      const res = await axios.post(
        `${apiUrl}/message/sendMedia/${instance}`,
        {
          number: cleanPhone,
          mediatype: 'document',
          media: pdfUrl,
          fileName: 'boleto.pdf',
          mimetype: 'application/pdf',
          caption,
        },
        { headers: { apikey: apiKey }, timeout: 20000 },
      );
      return res.data?.key?.id || res.data?.messageId || (true as any);
    } catch (e: any) {
      this.logger.warn(`[COBRANCA] Falha WhatsApp (boleto PDF) para ${phone}: ${e.message}`);
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

  // ─── Parte 1 — Apresentação do Financeiro (D+1 da venda) ─────────────────────
  //   No dia SEGUINTE ao fechamento da venda (que gerou boletos), o setor
  //   financeiro se apresenta e avisa que amanhã manda os boletos em PDF. Opt-in
  //   por tenant (BOLETO_INTRO_ENABLED_${tenant}). 1 por VENDA (treatment_plan),
  //   dedup via AuditLog(entity=BOLETO_INTRO). Compartilha o marca-passo acima.

  /**
   * Próxima apresentação a enviar: uma venda com BOLETO fechada ONTEM (dia de
   * Maceió), do tenant que ligou a apresentação, ainda não apresentada. 1 por plano.
   */
  private async findNextIntro(): Promise<IntroCandidate | null> {
    // Vendas fechadas a partir do dia SEGUINTE (nunca no mesmo dia). created_at é
    // instante UTC real; os limites do dia local de Maceió (UTC-3) viram UTC +3h.
    // Janela de 5 dias (não só "ontem"): o cron só roda seg-sex, então venda de
    // sexta/sábado/feriado precisa ser pega no próximo dia útil. O dedup por
    // AuditLog garante 1 apresentação por venda, então alargar é inofensivo.
    const LOOKBACK_DAYS = 5;
    const maceioNow = new Date(Date.now() - 3 * 3_600_000);
    const todayStartUtcMs =
      Date.UTC(maceioNow.getUTCFullYear(), maceioNow.getUTCMonth(), maceioNow.getUTCDate()) + 3 * 3_600_000;
    const yStart = new Date(todayStartUtcMs - LOOKBACK_DAYS * 86_400_000); // início da janela
    const yEnd = new Date(todayStartUtcMs); // hoje 00:00 Maceió — exclui vendas de HOJE (só D+1+)

    // groupBy = 1 registro por VENDA (plano), NÃO por boleto — assim o volume aqui
    // é o nº de vendas, e uma venda de 20 boletos não ocupa 20 slots. Mais antiga
    // primeiro. (findMany+take por charge deixava planos novos invisíveis sob volume.)
    const sales = await this.prisma.paymentGatewayCharge.groupBy({
      by: ['treatment_plan_id', 'tenant_id'],
      where: {
        billing_type: 'BOLETO',
        created_at: { gte: yStart, lt: yEnd },
        treatment_plan_id: { not: null },
        // Só venda com boleto EM ABERTO. Sem isto, venda cancelada/estornada ou já
        // paga (inclusive em espécie na clínica) recebia "amanhã te envio todos os
        // seus boletos" — e no dia seguinte não ia boleto nenhum, porque a entrega
        // (findPendingDeliveries→sendBoletos) filtra o que aqui passava batido.
        status: { in: ['PENDING', 'OVERDUE'] },
        received_in_cash: false,
      },
      orderBy: { _min: { created_at: 'asc' } },
    });
    if (sales.length === 0) return null;

    // Só tenants com a apresentação LIGADA (default OFF), 1 lookup por tenant.
    const enabledCache = new Map<string, boolean>();
    const eligible: { planId: string; tenantId: string }[] = [];
    for (const s of sales) {
      const planId = s.treatment_plan_id;
      const tenantId = s.tenant_id || '';
      if (!planId) continue;
      if (!enabledCache.has(tenantId)) enabledCache.set(tenantId, await this.isIntroEnabled(tenantId));
      if (enabledCache.get(tenantId)) eligible.push({ planId, tenantId });
    }
    if (eligible.length === 0) return null;

    // Anti-repetição: exclui as vendas JÁ apresentadas (AuditLog entity=BOLETO_INTRO)
    // ANTES de buscar paciente — planos já enviados não ocupam a lista nem bloqueiam.
    const already = await this.prisma.auditLog.findMany({
      where: { entity: 'BOLETO_INTRO', entity_id: { in: eligible.map((e) => e.planId) }, action: 'intro' },
      select: { entity_id: true },
    });
    const sent = new Set(already.map((a) => a.entity_id));
    const unsent = eligible.filter((e) => !sent.has(e.planId));
    if (unsent.length === 0) return null;

    // Busca os pacientes das vendas ainda-não-apresentadas numa query só e devolve a
    // 1ª (mais antiga) COM telefone. Sem telefone é PULADA — não bloqueia as outras.
    const plans = await this.prisma.treatmentPlan.findMany({
      where: { id: { in: unsent.map((e) => e.planId) } },
      select: { id: true, patient_id: true, patient: { select: { name: true, phone: true } } },
    });
    const planById = new Map(plans.map((p) => [p.id, p]));

    // Dedup por PACIENTE (a do AuditLog é por VENDA). O texto SE APRESENTA ("seja
    // muito bem-vindo, a partir de agora é por aqui que a gente cuida dos seus
    // pagamentos") — quem tinha 2 vendas na janela recebia isso 2x, a 2ª se
    // apresentando a quem já conhecia o financeiro.
    const jaApresentados = await this.pacientesJaApresentados(
      plans.map((p) => p.patient_id).filter((x): x is string => !!x),
    );

    for (const e of unsent) {
      const p = planById.get(e.planId);
      const phone = p?.patient?.phone?.trim();
      if (!p?.patient || !phone) continue;
      if (p.patient_id && jaApresentados.has(p.patient_id)) {
        // Já se apresentou numa venda anterior. Grava a âncora MESMO ASSIM (sem
        // mandar nada): é ela que libera a entrega dos boletos desta venda no dia
        // seguinte — pular a âncora deixaria esta venda sem boleto pra sempre.
        await this.logIntroSent(e.planId, e.tenantId, null);
        this.logger.log(
          `[BOLETO_INTRO] Plano ${e.planId}: paciente já foi apresentado numa venda anterior — ` +
          `não repito a apresentação; boletos seguem liberados pra amanhã.`,
        );
        continue;
      }
      return { planId: e.planId, tenantId: e.tenantId, phone, name: p.patient.name };
    }
    return null;
  }

  /** Quais destes pacientes JÁ receberam a apresentação (em qualquer venda). */
  private async pacientesJaApresentados(patientIds: string[]): Promise<Set<string>> {
    const out = new Set<string>();
    if (patientIds.length === 0) return out;
    try {
      const todosOsPlanos = await this.prisma.treatmentPlan.findMany({
        where: { patient_id: { in: patientIds } },
        select: { id: true, patient_id: true },
      });
      if (todosOsPlanos.length === 0) return out;
      const anchors = await this.prisma.auditLog.findMany({
        where: {
          entity: 'BOLETO_INTRO',
          entity_id: { in: todosOsPlanos.map((p) => p.id) },
          action: 'intro',
        },
        select: { entity_id: true },
      });
      const comAncora = new Set(anchors.map((a) => a.entity_id));
      for (const p of todosOsPlanos) {
        if (p.patient_id && comAncora.has(p.id)) out.add(p.patient_id);
      }
    } catch (e: any) {
      // Falha aqui não pode travar a fila; no pior caso volta ao comportamento antigo.
      this.logger.warn(`[BOLETO_INTRO] Falha na dedup por paciente: ${e?.message}`);
    }
    return out;
  }

  /** Envia a apresentação, marca no AuditLog e avança o marca-passo compartilhado. */
  private async sendIntro(cand: IntroCandidate, nowMs: number): Promise<'sent' | 'failed' | 'cooldown'> {
    const instanceName = await this.resolveFinanceiroInstance(cand.tenantId);
    const template = await this.resolveIntroTemplate(cand.tenantId);
    const clinica = await this.resolveClinicName(cand.tenantId);
    const firstName = cand.name.split(' ')[0];
    const message = template.replace(/\{nome\}/g, firstName).replace(/\{clinica\}/g, clinica);
    const messageId = await this.sendWhatsApp(cand.phone, message, instanceName);

    // Evolution não configurado: NÃO gasta o slot, tenta no próximo tick.
    if (messageId === 'NO_CONFIG') return 'cooldown';

    // Marca na TENTATIVA (sucesso OU falha) pra um número inválido não travar a fila.
    await this.logIntroSent(cand.planId, cand.tenantId, typeof messageId === 'string' ? messageId : null);
    this.lastSentAt = nowMs;
    this.nextGapMs = this.randomGapMs();

    if (messageId === false) {
      this.logger.warn(`[BOLETO_INTRO] Envio falhou pro plano ${cand.planId} — marcado como tentado.`);
      return 'failed';
    }
    await this.registerInFinanceiroConversation(
      cand.tenantId,
      cand.phone,
      message,
      typeof messageId === 'string' ? messageId : null,
      instanceName,
    );
    this.logger.log(
      `[BOLETO_INTRO] Apresentação enviada (plano ${cand.planId}); próximo em ~${Math.round(this.nextGapMs / 60000)}min`,
    );
    return 'sent';
  }

  /** Apresentação LIGADA pro tenant? (GlobalSetting BOLETO_INTRO_ENABLED_${tenant}). */
  private async isIntroEnabled(tenantId: string): Promise<boolean> {
    if (!tenantId) return false;
    try {
      const row = await this.prisma.globalSetting.findUnique({ where: { key: `BOLETO_INTRO_ENABLED_${tenantId}` } });
      return row?.value === 'true';
    } catch {
      return false;
    }
  }

  /** Texto da apresentação: o que a clínica salvou (mesma chave da API) → default. */
  private async resolveIntroTemplate(tenantId: string): Promise<string> {
    const fallback = DEFAULT_BOLETO_INTRO;
    if (!tenantId) return fallback;
    try {
      const row = await this.prisma.globalSetting.findUnique({
        where: { key: cobrancaTemplateKey('boleto_intro', tenantId) },
      });
      if (row?.value) {
        const parsed = JSON.parse(row.value);
        if (typeof parsed?.template === 'string' && parsed.template.trim()) return parsed.template;
      }
    } catch (e: any) {
      this.logger.warn(`[BOLETO_INTRO] Falha ao ler template do tenant ${tenantId}: ${e.message}`);
    }
    return fallback;
  }

  /** Registra a apresentação (idempotência exactly-once por venda/plano). */
  private async logIntroSent(planId: string, tenantId: string, messageId: string | null): Promise<void> {
    try {
      await this.prisma.auditLog.create({
        data: {
          entity: 'BOLETO_INTRO',
          entity_id: planId,
          action: 'intro',
          meta_json: { tenant_id: tenantId, message_id: messageId, sent_at: new Date().toISOString() },
        },
      });
    } catch (e: any) {
      this.logger.warn(`[BOLETO_INTRO] Falha ao registrar AuditLog do plano ${planId}: ${e.message}`);
    }
  }
}

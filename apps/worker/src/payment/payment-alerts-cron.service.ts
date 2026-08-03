import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { SettingsService } from '../settings/settings.service';
import {
  toBrazilWhatsappNumber,
  defaultCobrancaTemplate,
  DEFAULT_BOLETO_INTRO,
  COBRANCA_STAGES,
  cobrancaTemplateKey,
  type CobrancaStage,
  type CobrancaTipo,
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
  boleto_atrasado: 'BOLETO_ATRASADO',
};

// ─── "Cobrar atrasados (recorrente)" — carteira antiga ──────────────────────
//   Os marcos acima (1/15/30d) disparam UMA vez, em datas exatas e numa janela
//   curta (−33d). A carteira MIGRADA do Asaas está toda fora disso (meses/anos de
//   atraso). Este passe SECUNDÁRIO pega QUALQUER boleto vencido e re-toca o
//   paciente 1×/semana até regularizar — mesmo marca-passo/anti-ban, agrupado.
/** Quão pra trás varrer a carteira vencida (piso: evita puxar histórico infinito). */
const OVERDUE_LOOKBACK_DAYS = 1095; // ~3 anos
/** Cadência: re-toca o MESMO paciente no máx 1× a cada N dias (recorrência semanal). */
const OVERDUE_REPEAT_DAYS = 7;
/** Teto da varredura por tick. Precisa caber a carteira vencida INTEIRA da(s)
 *  clínica(s) com o toggle ligado — senão o take corta nos boletos mais antigos
 *  ANTES do dedup por recência e os pacientes além do corte nunca são cobrados
 *  (starvation). 4000 cobre com folga uma clínica; se estourar, loga aviso. */
const OVERDUE_SCAN_CAP = 4000;

interface ChargeCandidate {
  /** Boleto REPRESENTANTE do grupo (o mais atrasado). Só métrica/log. */
  chargeId: string;
  /** Onda 18.x — chave de dedup e agrupamento é o PACIENTE (não o boleto), pra
   *  paciente com N parcelas atrasadas receber 1 aviso por estágio (não N). */
  patientId: string;
  tenantId: string;
  stage: Stage;
  phone: string;
  name: string;
  /** TOTAL do grupo (soma dos N boletos daquele paciente+estágio). */
  amount: number;
  /** Quantos boletos no grupo (>1 = mensagem agrupada, sem PDF). */
  count: number;
  dueDate: Date;
  link: string;
  /** Todos os links do grupo (usados no texto agrupado quando count > 1). */
  links: string[];
  /** URL do PDF do boleto (só quando billing_type=BOLETO E count===1) — manda como documento. */
  pdfUrl: string | null;
  /** Disparo ANTECIPADO pra sexta (vencimento cai dom/seg, dias sem cron): o dia da
   *  semana do vencimento, pra trocar o "amanhã" do template e não mentir. */
  venceEm?: string;
  /** Tipo de pagamento da cobrança → escolhe a variante do texto (PIX não é
   *  "parcela"/"boleto", boleto 1× não é "parcela"). */
  tipo: CobrancaTipo;
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

    // 1º os MARCOS exatos (1/15/30d — prioridade, são sensíveis à data); se não há
    // nenhum pendente, drena a CARTEIRA de atrasados (recorrente, janela larga).
    // O findNextOverdue só custa uma query quando algum tenant ligou o toggle.
    const pick = (await this.findNextCharge()) || (await this.findNextOverdue());
    if (!pick) return 'empty'; // nada pra mandar — NÃO mexe no cooldown

    return await this.sendPacedCharge(pick, nowMs);
    } finally {
      this.busy = false;
    }
  }

  /**
   * Envia UMA cobrança já escolhida (marco ou atrasado-recorrente) e avança o
   * marca-passo. Extraído pra ser reusado pelos dois passes (marcos + carteira).
   */
  private async sendPacedCharge(pick: ChargeCandidate, nowMs: number): Promise<'sent' | 'failed' | 'cooldown'> {
    const instanceName = await this.resolveFinanceiroInstance(pick.tenantId);
    const template = await this.resolveTemplate(pick.tenantId, pick.stage, pick.tipo);
    const clinica = await this.resolveClinicName(pick.tenantId);
    const message = this.buildMessage(pick, template, clinica);
    // Boleto → manda o PDF anexo (a mensagem vira legenda); PIX/sem-boleto seguem texto+link.
    const messageId = pick.pdfUrl
      ? await this.sendWhatsAppMedia(pick.phone, pick.pdfUrl, message, instanceName)
      : await this.sendWhatsApp(pick.phone, message, instanceName);

    // Evolution não configurado: NÃO gasta o slot, tenta de novo no próximo tick.
    if (messageId === 'NO_CONFIG') return 'cooldown';

    // Marca na TENTATIVA (sucesso OU falha) e avança o marca-passo — assim um
    // número inválido não trava as próximas cobranças. Onda 18.x — dedup por
    // PACIENTE (não por boleto): grava o patientId no AuditLog.
    await this.logSent(pick.patientId, pick.stage, pick.tenantId, typeof messageId === 'string' ? messageId : null);
    // Central de Disparos 2.0 — registro unificado (métrica/resumo por disparo).
    await this.logDispatchUnificado(pick.tenantId, pick.stage, pick.name, pick.phone, messageId, pick.chargeId);
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
      // ANTI-CASCA: NÃO criar a conversa com last_message_at=agora ANTES da msg.
      // O echo (fromMe) do próprio envio chega pelo webhook com o MESMO
      // external_message_id (@unique GLOBAL) e pode gravar a msg primeiro → o
      // create daqui estoura P2002. Se a conversa fosse criada antes, sobraria uma
      // CASCA vazia com timestamp recente (a que o operador abre e vê "Nenhuma
      // mensagem"). Então: conversa existente → tenta gravar (P2002 = echo já
      // gravou, ok); conversa nova → cria conversa + msg numa TRANSAÇÃO, e se a msg
      // colidir a tx desfaz a conversa também (nunca deixa casca).
      const externalId = messageId || `sys_cobranca_${Date.now()}`;
      const isDupKey = (err: any) => err?.code === 'P2002';

      if (conv) {
        try {
          await this.prisma.message.create({
            data: {
              conversation_id: conv.id,
              direction: 'out',
              type: 'text',
              text,
              external_message_id: externalId,
              status: 'enviado',
            },
          });
        } catch (e: any) {
          if (!isDupKey(e)) throw e; // erro real → catch externo
          return; // echo já registrou a mesma mensagem — não duplica
        }
        await this.prisma.conversation.update({
          where: { id: conv.id },
          data: { last_message_at: new Date() },
        });
        return;
      }

      try {
        await this.prisma.$transaction(async (tx) => {
          const created = await tx.conversation.create({
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
          await tx.message.create({
            data: {
              conversation_id: created.id,
              direction: 'out',
              type: 'text',
              text,
              external_message_id: externalId,
              status: 'enviado',
            },
          });
        });
      } catch (e: any) {
        if (!isDupKey(e)) throw e; // erro real → catch externo
        // echo já criou conversa+msg dele; a tx desfez a nossa (sem casca vazia).
      }
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
    // Janela: só o que pode bater num estágio (−33d atraso até +3d antes — o +3d
    // cobre a antecipação de sexta pra vencimento na segunda).
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
        treatment_plan: { select: { patient: { select: { id: true, name: true, phone: true } } } },
        installment: { select: { patient: { select: { id: true, name: true, phone: true } } } },
        // Onda 18.x — boleto IMPORTADO do Asaas não tem plano/parcela; tem só o
        // paciente vinculado DIRETO. Sem isto, a régua nunca cobra os importados.
        patient: { select: { id: true, name: true, phone: true } },
      },
      orderBy: { due_date: 'asc' }, // a mais antiga (mais atrasada) primeiro
      take: 500,
    });
    if (charges.length === 0) return null;

    const stageCache = new Map<string, Set<Stage>>(); // tenantId → estágios ligados
    // Dia da semana de HOJE em Maceió (5 = sexta) — pra antecipação de fim de semana.
    const todayDow = new Date(Date.now() - 3 * 3_600_000).getUTCDay();
    const candidates: ChargeCandidate[] = [];
    for (const c of charges) {
      const diff = todayIdx - this.dayIndexUTC(new Date(c.due_date));
      let stage = STAGE_BY_DIFF[diff];
      let venceEm: string | undefined;
      // O cron só roda seg-sex: o "1 dia antes" de um boleto que vence DOMINGO cai no
      // sábado, e o de SEGUNDA cai no domingo — dias sem cron. Sem isto, esses boletos
      // NUNCA recebiam o lembrete (e a janela é exata, não há retry depois). Antecipa
      // pra SEXTA (último dia útil antes do vencimento); a dedup por charge+stage
      // garante que não repete. Feriado em dia útil continua descoberto (o cron não
      // conhece feriado) — limitação documentada.
      if (!stage && todayDow === 5 && (diff === -2 || diff === -3)) {
        // Na sexta: diff -1 = sábado (fluxo normal já cobre), -2 = domingo, -3 = segunda.
        stage = 'boleto_1d_antes';
        venceEm = diff === -2 ? 'no domingo' : 'na segunda-feira';
      }
      if (!stage) continue;

      // Onda 18.x — resolve o paciente por plano, parcela OU vínculo DIRETO
      // (boleto importado do Asaas). O id é a chave de agrupamento/dedup.
      const patient = c.treatment_plan?.patient || c.installment?.patient || c.patient;
      const phone = patient?.phone?.trim();
      if (!patient || !patient.id || !phone) continue;

      const link =
        c.invoice_url ||
        c.boleto_url ||
        (c.pix_copy_paste ? `Pix copia e cola:\n${c.pix_copy_paste}` : '');
      if (!link) continue; // sem link não dá pra cobrar — pula (não trava a fila)

      const tid = c.tenant_id || '';
      if (!stageCache.has(tid)) stageCache.set(tid, await this.loadEnabledStages(tid));
      if (!stageCache.get(tid)!.has(stage)) continue; // estágio desligado pro tenant

      // Tipo de pagamento: parcela (tem installment) → 'parcelado'; senão PIX →
      // 'pix'; boleto/cartão → 'boleto'. Escolhe a variante do texto no disparo.
      const tipo: CobrancaTipo = c.installment
        ? 'parcelado'
        : c.billing_type === 'PIX'
          ? 'pix'
          : 'boleto';

      candidates.push({
        chargeId: c.id,
        patientId: patient.id,
        tenantId: tid,
        stage,
        phone,
        name: patient.name,
        amount: Number(c.amount),
        count: 1,
        dueDate: new Date(c.due_date),
        link,
        links: [link],
        pdfUrl: c.billing_type === 'BOLETO' && c.boleto_url ? c.boleto_url : null,
        venceEm,
        tipo,
      });
    }
    if (candidates.length === 0) return null;

    // Onda 18.x — AGRUPA por (tenant, paciente, estágio): paciente com N boletos
    // atrasados no mesmo estágio recebe UM aviso (total + todos os links), não N
    // (anti-spam/anti-ban). A ordem por due_date asc garante que o REPRESENTANTE
    // (1º do grupo) é o mais atrasado.
    const groups = new Map<string, ChargeCandidate>();
    for (const cand of candidates) {
      const key = `${cand.tenantId}::${cand.patientId}::${cand.stage}`;
      const g = groups.get(key);
      if (!g) {
        groups.set(key, { ...cand, links: [...cand.links] });
      } else {
        g.amount += cand.amount;
        g.count += 1;
        if (!g.links.includes(cand.link)) g.links.push(cand.link);
        g.pdfUrl = null; // grupo > 1 vai como TEXTO com os N links, não 1 PDF
      }
    }
    const grouped = [...groups.values()];

    // Anti-repetição por PACIENTE+estágio (não por boleto): 1 query batch no
    // AuditLog. (Antes era por charge; a chave agora é o patientId.)
    const ids = grouped.map((g) => g.patientId);
    const already = await this.prisma.auditLog.findMany({
      where: { entity: 'PAYMENT_ALERT', entity_id: { in: ids }, action: { in: STAGES } },
      select: { entity_id: true, action: true },
    });
    const sentSet = new Set(already.map((a) => `${a.entity_id}:${a.action}`));

    return grouped.find((g) => !sentSet.has(`${g.patientId}:${g.stage}`)) || null;
  }

  /**
   * "Cobrar atrasados (recorrente)" — passe SECUNDÁRIO da carteira vencida. Pega
   * QUALQUER boleto vencido (diff >= 1), sem exigir o marco exato nem a janela
   * curta dos marcos — é isto que alcança a carteira ANTIGA migrada do Asaas
   * (meses/anos de atraso) e quem caiu ENTRE os marcos. Agrupa por paciente
   * (1 aviso com o total + todos os links) e RE-TOCA no máx 1×/semana por paciente
   * (dedup por janela de tempo, não once-ever) — assim a cobrança recorre até
   * regularizar, sempre dentro do marca-passo/anti-ban. Opt-in por tenant.
   */
  private async findNextOverdue(): Promise<ChargeCandidate | null> {
    // Só varre se ALGUM tenant ligou o "cobrar atrasados" — senão nem toca no banco.
    const enabledTenants = await this.loadOverdueEnabledTenants();
    if (enabledTenants.size === 0) return null;

    const todayIdx = this.dayIndexUTC(new Date(Date.now() - 3 * 3_600_000)); // hoje Maceió
    // Janela LARGA: do piso (−OVERDUE_LOOKBACK_DAYS) até agora. O filtro real de
    // "vencido" é o diff >= 1 no loop (due de hoje = diff 0 = NÃO é atraso).
    const lo = new Date(Date.now() - OVERDUE_LOOKBACK_DAYS * 86_400_000);
    const hi = new Date(Date.now());

    const charges = await this.prisma.paymentGatewayCharge.findMany({
      where: {
        status: { in: ['PENDING', 'OVERDUE'] },
        received_in_cash: false,
        due_date: { gte: lo, lte: hi },
        tenant_id: { in: [...enabledTenants] },
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
        treatment_plan: { select: { patient: { select: { id: true, name: true, phone: true } } } },
        installment: { select: { patient: { select: { id: true, name: true, phone: true } } } },
        patient: { select: { id: true, name: true, phone: true } },
      },
      orderBy: { due_date: 'asc' }, // a mais antiga (mais atrasada) primeiro
      take: OVERDUE_SCAN_CAP,
    });
    if (charges.length === 0) return null;
    // Cap estourado: a carteira vencida excede a janela de varredura → os boletos
    // mais ANTIGOS além do corte podem esperar mais pra serem cobrados. NÃO é
    // silencioso (evita "cobri tudo" enganoso); subir OVERDUE_SCAN_CAP se recorrente.
    if (charges.length >= OVERDUE_SCAN_CAP) {
      this.logger.warn(
        `[COBRANCA] Carteira vencida atingiu o teto de varredura (${OVERDUE_SCAN_CAP}); ` +
        `boletos mais antigos além do corte podem demorar mais. Considere subir OVERDUE_SCAN_CAP.`,
      );
    }

    const candidates: ChargeCandidate[] = [];
    for (const c of charges) {
      const diff = todayIdx - this.dayIndexUTC(new Date(c.due_date));
      if (diff < 1) continue; // vence hoje/no futuro → não é atraso (marcos cuidam)

      const patient = c.treatment_plan?.patient || c.installment?.patient || c.patient;
      const phone = patient?.phone?.trim();
      if (!patient || !patient.id || !phone) continue;

      const link =
        c.invoice_url ||
        c.boleto_url ||
        (c.pix_copy_paste ? `Pix copia e cola:\n${c.pix_copy_paste}` : '');
      if (!link) continue;

      const tipo: CobrancaTipo = c.installment
        ? 'parcelado'
        : c.billing_type === 'PIX'
          ? 'pix'
          : 'boleto';

      candidates.push({
        chargeId: c.id,
        patientId: patient.id,
        tenantId: c.tenant_id || '',
        stage: 'boleto_atrasado',
        phone,
        name: patient.name,
        amount: Number(c.amount),
        count: 1,
        dueDate: new Date(c.due_date),
        link,
        links: [link],
        pdfUrl: c.billing_type === 'BOLETO' && c.boleto_url ? c.boleto_url : null,
        tipo,
      });
    }
    if (candidates.length === 0) return null;

    // Agrupa por (tenant, paciente): 1 aviso com o TOTAL da carteira do paciente +
    // todos os links (não 1 msg por boleto — anti-spam/anti-ban).
    const groups = new Map<string, ChargeCandidate>();
    for (const cand of candidates) {
      const key = `${cand.tenantId}::${cand.patientId}`;
      const g = groups.get(key);
      if (!g) {
        groups.set(key, { ...cand, links: [...cand.links] });
      } else {
        g.amount += cand.amount;
        g.count += 1;
        if (!g.links.includes(cand.link)) g.links.push(cand.link);
        g.pdfUrl = null; // grupo > 1 vai como TEXTO com os N links, não 1 PDF
      }
    }
    const grouped = [...groups.values()];

    // Dedup por JANELA DE TEMPO (não once-ever): re-toca no máx 1× a cada
    // OVERDUE_REPEAT_DAYS por paciente. É o que faz a cobrança RECORRER até pagar,
    // sem virar spam. (Os marcos usam dedup once-ever; este usa created_at recente.)
    // ANTI-BAN CRÍTICO: olha QUALQUER estágio (action in STAGES), não só
    // 'boleto_atrasado'. Senão a carteira re-cobra no MESMO dia quem acabou de
    // receber um marco (boleto_atraso_1d/15d/30d escrevem outra action) → 2
    // cobranças da mesma dívida em minutos. Incluir os marcos na recência garante
    // 1 toque/semana somando TUDO que o paciente recebeu pelo chip Financeiro.
    const cutoff = new Date(Date.now() - OVERDUE_REPEAT_DAYS * 86_400_000);
    const ids = grouped.map((g) => g.patientId);
    const already = await this.prisma.auditLog.findMany({
      where: {
        entity: 'PAYMENT_ALERT',
        entity_id: { in: ids },
        action: { in: STAGES },
        created_at: { gte: cutoff },
      },
      select: { entity_id: true },
    });
    const recent = new Set(already.map((a) => a.entity_id));
    return grouped.find((g) => !recent.has(g.patientId)) || null;
  }

  /** Tenants com o "cobrar atrasados (recorrente)" LIGADO (BOLETO_ATRASADO_${tenant}
   *  === 'true'). Uma query só — devolve o conjunto de tenantIds habilitados. */
  private async loadOverdueEnabledTenants(): Promise<Set<string>> {
    const out = new Set<string>();
    try {
      const prefix = 'BOLETO_ATRASADO_';
      const rows = await this.prisma.globalSetting.findMany({
        where: { key: { startsWith: prefix }, value: 'true' },
        select: { key: true },
      });
      for (const r of rows) out.add(r.key.slice(prefix.length));
    } catch (e: any) {
      this.logger.warn(`[COBRANCA] Falha ao carregar tenants de atrasados: ${e.message}`);
    }
    return out;
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
    // Onda 18.x — AGRUPADO: paciente com VÁRIOS boletos no mesmo estágio recebe
    // UMA mensagem com o TOTAL + todos os links (não uma por boleto). Formato
    // próprio (o template do estágio é singular "seu boleto"); {valor} = total.
    if (c.count > 1) {
      const linksTxt = c.links.join('\n');
      return (
        `Olá ${firstName}, você tem ${c.count} boletos em aberto na ${clinica}, ` +
        `no total de ${valor}.\n\nAcesse pelos links abaixo:\n${linksTxt}\n\n` +
        `Se já pagou algum, é só desconsiderar. Qualquer dúvida, estamos à disposição.`
      );
    }
    let base = template;
    // Disparo antecipado pra sexta (vencimento dom/seg): o template do 1d_antes diz
    // "amanhã" — troca pelo dia real pra não mentir. Best-effort: se a clínica editou
    // o texto sem a palavra "amanhã", a {data} correta continua entre parênteses.
    if (c.venceEm) base = base.replace(/amanhã/gi, c.venceEm);
    return base
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
  private async resolveTemplate(tenantId: string, stage: Stage, tipo: CobrancaTipo): Promise<string> {
    const fallback = defaultCobrancaTemplate(stage, tipo);
    if (!tenantId) return fallback;
    // Mesma resolução do editor (followup.service): 1) variante do TIPO editada →
    // 2) texto ÚNICO legado (pré-split, editado antes) → 3) default type-aware.
    for (const key of [cobrancaTemplateKey(stage, tenantId, tipo), cobrancaTemplateKey(stage, tenantId)]) {
      try {
        const row = await this.prisma.globalSetting.findUnique({ where: { key } });
        if (row?.value) {
          const parsed = JSON.parse(row.value);
          if (typeof parsed?.template === 'string' && parsed.template.trim()) return parsed.template;
        }
      } catch (e: any) {
        this.logger.warn(`[COBRANCA] Falha ao ler template ${stage}/${tipo} do tenant ${tenantId}: ${e.message}`);
      }
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
  private async logSent(dedupKey: string, stage: Stage, tenantId: string, messageId: string | null): Promise<void> {
    // Onda 18.x — dedupKey = patientId (idempotência 1 aviso/paciente/estágio).
    try {
      await this.prisma.auditLog.create({
        data: {
          entity: 'PAYMENT_ALERT',
          entity_id: dedupKey,
          action: stage,
          meta_json: { tenant_id: tenantId, message_id: messageId, sent_at: new Date().toISOString() },
        },
      });
    } catch (e: any) {
      this.logger.warn(`[COBRANCA] Falha ao registrar AuditLog (${dedupKey}): ${e.message}`);
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

    // Tenants com a APRESENTAÇÃO (D+1) ou a ENTREGA (D+2) ligada — são toggles
    // separados. Entram na lista os dois casos: a apresentação precisa mandar msg;
    // a entrega-sem-apresentação precisa só ANCORAR a venda (pra liberar os boletos
    // amanhã) sem mandar nada. 1 lookup por flag por tenant.
    const flagCache = new Map<string, { intro: boolean; delivery: boolean }>();
    const flagsDo = async (t: string) => {
      let f = flagCache.get(t);
      if (!f) {
        f = { intro: await this.isIntroEnabled(t), delivery: await this.isDeliveryEnabled(t) };
        flagCache.set(t, f);
      }
      return f;
    };
    const eligible: { planId: string; tenantId: string }[] = [];
    for (const s of sales) {
      const planId = s.treatment_plan_id;
      const tenantId = s.tenant_id || '';
      if (!planId) continue;
      const f = await flagsDo(tenantId);
      if (f.intro || f.delivery) eligible.push({ planId, tenantId });
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
      const f = await flagsDo(e.tenantId);
      const jaApres = !!(p.patient_id && jaApresentados.has(p.patient_id));

      // Manda a apresentação SÓ quando: apresentação (D+1) ligada E entrega (D+2)
      // ligada — sem a entrega, o "amanhã te mando os boletos" seria mentira — E o
      // paciente ainda não foi apresentado numa venda anterior.
      if (f.intro && f.delivery && !jaApres) {
        return { planId: e.planId, tenantId: e.tenantId, phone, name: p.patient.name };
      }

      // Não vai apresentar. Se a ENTREGA está ligada, grava a âncora mesmo assim (sem
      // mandar nada): é ela que libera os boletos amanhã — cobre "entrega ligada mas
      // apresentação desligada" e "paciente já apresentado". Entrega desligada → nem
      // ancora (não há o que liberar) e a apresentação sozinha não sai (não promete).
      if (f.delivery) {
        await this.logIntroSent(e.planId, e.tenantId, null);
        this.logger.log(
          `[BOLETO_INTRO] Plano ${e.planId}: ${jaApres ? 'paciente já apresentado' : 'apresentação desligada'} — ` +
          `só liberando os boletos pra amanhã (sem repetir/mandar a apresentação).`,
        );
      }
      continue;
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
    // Central de Disparos 2.0 — registro unificado (métrica/resumo por disparo).
    await this.logDispatchUnificado(cand.tenantId, 'boleto_intro', cand.name, cand.phone, messageId, cand.planId);
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

  /** Apresentação (D+1) LIGADA pro tenant? (GlobalSetting BOLETO_INTRO_ENABLED_${tenant}). */
  private async isIntroEnabled(tenantId: string): Promise<boolean> {
    if (!tenantId) return false;
    try {
      const row = await this.prisma.globalSetting.findUnique({ where: { key: `BOLETO_INTRO_ENABLED_${tenantId}` } });
      return row?.value === 'true';
    } catch {
      return false;
    }
  }

  /** Entrega dos boletos (D+2) LIGADA? Toggle separado da apresentação; quando NUNCA
   *  foi setado, HERDA a apresentação (compat: antes era 1 toggle só pro fluxo todo). */
  private async isDeliveryEnabled(tenantId: string): Promise<boolean> {
    if (!tenantId) return false;
    try {
      const row = await this.prisma.globalSetting.findUnique({ where: { key: `BOLETO_DELIVERY_ENABLED_${tenantId}` } });
      if (row) return row.value === 'true';
      return this.isIntroEnabled(tenantId);
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

  /** Central de Disparos 2.0 — registro UNIFICADO no DispatchLog (tenant na coluna,
   *  não em meta_json): é daqui que a Central tira "enviados hoje/mês" e o resumo
   *  "pra quem mandou" de cada disparo financeiro. Best-effort, nunca lança. */
  private async logDispatchUnificado(
    tenantId: string,
    type: string,
    name: string,
    phone: string,
    sendResult: string | boolean | 'NO_CONFIG',
    refId?: string,
  ): Promise<void> {
    try {
      await this.prisma.dispatchLog.create({
        data: {
          tenant_id: tenantId,
          type,
          channel: 'WHATSAPP',
          recipient_name: name,
          recipient_phone: phone,
          status: sendResult === false ? 'FAILED' : 'SENT',
          error: sendResult === false ? 'Evolution recusou o envio (número/chip)' : null,
          external_message_id: typeof sendResult === 'string' ? sendResult : null,
          ref_patient_id: null,
          sent_at: new Date(),
        },
      });
    } catch (e: any) {
      this.logger.warn(`[DISPATCH-LOG] Falha ao registrar ${type}: ${e?.message}`);
    }
  }
}

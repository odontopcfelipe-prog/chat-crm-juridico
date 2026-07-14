import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { AsaasClient } from './asaas/asaas-client';
import { WhatsappService } from '../whatsapp/whatsapp.service';

/**
 * Parte 2 — ENVIO DOS BOLETOS no dia seguinte à apresentação (Central de Disparos).
 *
 * Fluxo (opt-in, gate BOLETO_INTRO_ENABLED_${tenant} — o MESMO da apresentação):
 *   venda fechada (D) → apresentação D+1 (worker payment-alerts-cron, entity=BOLETO_INTRO)
 *   → ESTE serviço, no dia SEGUINTE à apresentação, manda os boletos em PDF.
 *
 * "Todos os boletos num único envio" = o CARNÊ do Asaas (1 PDF com todas as
 * parcelas, cada uma numa página) + o boleto da entrada/sinal (quando boleto).
 * Sai pelo chip FINANCEIRO (fallback CLINICA).
 *
 * Por que na API (e não no worker como a apresentação): o carnê exige chamada
 * AUTENTICADA ao Asaas (AsaasClient, com o isolamento por tenant correto) e o
 * WhatsappService.sendMedia — ambos vivem aqui.
 *
 * SEM marca-passo: o chip FINANCEIRO é dedicado a essas demandas e de baixo
 * volume, então os boletos saem IMEDIATOS — cada rodada processa TODAS as
 * entregas pendentes de uma vez (no horário comercial Maceió), sem intervalo
 * entre envios. Dedup POR VENDA (AuditLog entity=BOLETO_DELIVERY) + POR PEÇA
 * (entity=BOLETO_DELIVERY_PIECE): retry reenvia só a peça que falhou, sem
 * duplicar, e a venda só é marcada entregue quando TODAS as peças saíram de fato.
 */
@Injectable()
export class BoletoDeliveryService {
  private readonly logger = new Logger(BoletoDeliveryService.name);

  /** Guard de reentrância: evita que duas rodadas do cron se sobreponham. */
  private busy = false;

  /** Só entrega boletos de apresentações dos últimos N dias (evita entregar venda velha). */
  private static readonly LOOKBACK_DAYS = 10;
  /** Teto de segurança por rodada. O chip FINANCEIRO é dedicado/baixo volume, então
   *  NÃO há marca-passo entre envios (imediato); este cap só evita uma rajada anormal
   *  (ex.: backlog no 1º deploy) — o excedente escorre pra rodada seguinte. */
  private static readonly MAX_PER_RUN = 30;

  constructor(
    private prisma: PrismaService,
    private asaas: AsaasClient,
    private whatsapp: WhatsappService,
  ) {}

  // Roda no horário comercial (seg-sex 8-17h, Maceió). SEM marca-passo: cada
  // rodada processa TODAS as entregas pendentes de uma vez (imediato), até o teto.
  @Cron('*/1 8-17 * * 1-5', { timeZone: 'America/Maceio' })
  async tick() {
    if (this.busy) return;
    this.busy = true;
    try {
      const pending = await this.findPendingDeliveries();
      for (const target of pending) {
        await this.deliverOne(target);
      }
    } catch (e: any) {
      this.logger.error(`[BOLETO_DELIVERY] Erro no tick: ${e?.message || e}`);
    } finally {
      this.busy = false;
    }
  }

  /** Entrega os boletos de UMA venda, imediatamente (sem cooldown). */
  private async deliverOne(target: { planId: string; tenantId: string }): Promise<void> {
    try {
      const plan = await this.prisma.treatmentPlan.findUnique({
        where: { id: target.planId },
        select: { patient: { select: { name: true, phone: true } } },
      });
      const phone = plan?.patient?.phone?.trim();
      if (!plan?.patient || !phone) {
        // Sem telefone: NÃO marca — se corrigirem o telefone dentro da janela, o
        // próximo tick entrega. Sai da fila sozinho após LOOKBACK_DAYS. (O loop do
        // tick segue processando os outros planos, então não bloqueia ninguém.)
        this.logger.warn(`[BOLETO_DELIVERY] Plano ${target.planId} sem telefone — pulando (retry na janela).`);
        return;
      }
      const ok = await this.sendBoletos(target.planId, target.tenantId, plan.patient.name, phone);
      if (ok) {
        await this.logDelivered(target.planId, target.tenantId, 'sent');
        this.logger.log(`[BOLETO_DELIVERY] Boletos enviados (plano ${target.planId}).`);
      } else {
        // Entrega INCOMPLETA (Evolution recusou/caiu) — NÃO marca a venda entregue,
        // pra o próximo tick reenviar SÓ as peças que faltaram (dedup por peça). A
        // janela LOOKBACK_DAYS é o backstop: falha persistente sai da fila em N dias.
        this.logger.warn(`[BOLETO_DELIVERY] Entrega incompleta do plano ${target.planId} — retry no próximo tick.`);
      }
    } catch (e: any) {
      // Falha transiente (Asaas/Evolution/DB) → NÃO marca entregue: tenta de novo
      // no próximo tick. Só um erro persistente ficaria reprocessando (visível no log).
      this.logger.error(`[BOLETO_DELIVERY] Falha ao entregar plano ${target.planId}: ${e?.message || e}`);
    }
  }

  /**
   * Próxima venda a entregar: teve apresentação (BOLETO_INTRO) num dia ANTERIOR
   * (Maceió) dentro da janela, do tenant com o disparo LIGADO, e ainda não
   * entregue (sem BOLETO_DELIVERY). A mais antiga primeiro.
   */
  private async findPendingDeliveries(): Promise<{ planId: string; tenantId: string }[]> {
    const maceioNow = new Date(Date.now() - 3 * 3_600_000);
    const startOfTodayUtcMs =
      Date.UTC(maceioNow.getUTCFullYear(), maceioNow.getUTCMonth(), maceioNow.getUTCDate()) + 3 * 3_600_000;
    const startOfToday = new Date(startOfTodayUtcMs); // hoje 00:00 Maceió
    const windowStart = new Date(startOfTodayUtcMs - BoletoDeliveryService.LOOKBACK_DAYS * 86_400_000);

    // Apresentações feitas em dia ANTERIOR (created_at < hoje 00:00 Maceió), recentes.
    // Janela de LOOKBACK_DAYS limita o volume; take alto (>> throughput diário de
    // ~100/dia) pra as apresentações NOVAS nunca ficarem invisíveis atrás das já
    // entregues (o bug de acumulação que corrigimos na Parte 1).
    const CAP = 2000;
    const introLogs = await this.prisma.auditLog.findMany({
      where: {
        entity: 'BOLETO_INTRO',
        action: 'intro',
        created_at: { gte: windowStart, lt: startOfToday },
      },
      select: { entity_id: true, meta_json: true },
      orderBy: { created_at: 'asc' },
      take: CAP,
    });
    if (introLogs.length === 0) return [];
    if (introLogs.length === CAP) {
      this.logger.warn(`[BOLETO_DELIVERY] Janela atingiu o teto de ${CAP} apresentações — algumas podem atrasar.`);
    }

    const planIds = introLogs.map((l) => l.entity_id).filter((x): x is string => !!x);
    if (planIds.length === 0) return [];

    // Já entregues → exclui.
    const delivered = await this.prisma.auditLog.findMany({
      where: { entity: 'BOLETO_DELIVERY', entity_id: { in: planIds } },
      select: { entity_id: true },
    });
    const done = new Set(delivered.map((d) => d.entity_id));

    // Apresentações pendentes de tenants com o disparo LIGADO — até o teto por rodada.
    const enabledCache = new Map<string, boolean>();
    const out: { planId: string; tenantId: string }[] = [];
    for (const log of introLogs) {
      const planId = log.entity_id;
      if (!planId || done.has(planId)) continue;
      const tenantId = ((log.meta_json as any)?.tenant_id as string) || '';
      if (!tenantId) continue;
      if (!enabledCache.has(tenantId)) enabledCache.set(tenantId, await this.isEnabled(tenantId));
      if (!enabledCache.get(tenantId)) continue;
      out.push({ planId, tenantId });
      if (out.length >= BoletoDeliveryService.MAX_PER_RUN) break;
    }
    return out;
  }

  /** Envia os boletos do plano: texto + carnê (parcelas, 1 PDF) + entrada/sinal.
   *  Dedup POR PEÇA (retry reenvia só o que falhou, sem duplicar) + checagem do
   *  sucesso REAL (a Evolution não lança — devolve {statusCode,error} em falha).
   *  Retorna true só se TODAS as peças foram entregues (agora ou antes). */
  private async sendBoletos(planId: string, tenantId: string, name: string, phone: string): Promise<boolean> {
    const charges = await this.prisma.paymentGatewayCharge.findMany({
      where: {
        treatment_plan_id: planId,
        tenant_id: tenantId,
        billing_type: 'BOLETO',
        received_in_cash: false,
        status: { in: ['PENDING', 'OVERDUE'] },
      },
      select: { kind: true, external_id: true, boleto_url: true, due_date: true },
      orderBy: { due_date: 'asc' },
    });
    if (charges.length === 0) {
      // Nada em aberto (ex.: já quitado) — considera entregue pra não reprocessar.
      this.logger.warn(`[BOLETO_DELIVERY] Plano ${planId} sem boletos em aberto — nada a enviar.`);
      return true;
    }

    const parcelas = charges.filter((c) => c.kind === 'INSTALLMENT');
    const avulsos = charges.filter((c) => c.kind === 'ENTRADA' || c.kind === 'SINAL'); // upfront
    const instance = await this.resolveInstance(tenantId);
    const firstName = name.split(' ')[0];
    let allOk = true;

    // 1) Texto de abertura.
    const textOk = await this.sendPiece(`${planId}:text`, tenantId, () =>
      this.whatsapp.sendText(
        phone,
        `Olá, ${firstName}! 📄 Como combinei ontem, aqui estão os seus boletos. ` +
          `Qualquer dúvida, é só me chamar por aqui! 💙`,
        instance,
      ),
    );
    if (!textOk) allOk = false;

    // 2) Carnê das parcelas (1 PDF com todas). Fallback: links num texto.
    if (parcelas.length > 0) {
      const carneOk = await this.sendPiece(`${planId}:carne`, tenantId, async () => {
        let installmentId: string | null = null;
        try {
          installmentId = await this.resolveInstallmentId(parcelas, tenantId);
        } catch {
          /* cai no fallback de links */
        }
        if (installmentId) {
          try {
            const pdf = await this.asaas.getInstallmentPaymentBook(installmentId, tenantId);
            return await this.whatsapp.sendMedia(
              phone, 'document', pdf.toString('base64'),
              `Carnê — ${parcelas.length} parcelas`, instance, 'carne-boletos.pdf', 'application/pdf',
            );
          } catch (e: any) {
            this.logger.warn(`[BOLETO_DELIVERY] Carnê falhou p/ plano ${planId}: ${e?.message || e} — fallback links.`);
          }
        }
        // Fallback: os links das parcelas num único texto.
        const linhas = parcelas.map((p, i) => (p.boleto_url ? `Parcela ${i + 1}: ${p.boleto_url}` : '')).filter(Boolean);
        if (linhas.length === 0) throw new Error('sem carnê e sem links de parcela');
        return await this.whatsapp.sendText(phone, `Aqui estão os boletos das suas parcelas:\n\n${linhas.join('\n')}`, instance);
      });
      if (!carneOk) allOk = false;
    }

    // 3) Entrada/sinal (boletos avulsos) — PDF direto pela URL pública do Asaas.
    for (const c of avulsos) {
      if (!c.boleto_url) continue;
      const label = c.kind === 'ENTRADA' ? 'Entrada' : 'Sinal';
      const ok = await this.sendPiece(`${planId}:${c.external_id}`, tenantId, () =>
        this.whatsapp.sendMedia(
          phone, 'document', c.boleto_url as string, label, instance,
          `boleto-${(c.kind || 'boleto').toLowerCase()}.pdf`, 'application/pdf',
        ),
      );
      if (!ok) allOk = false;
    }

    return allOk;
  }

  /** Resolve o id do GRUPO de parcelamento do Asaas — não é salvo; getCharge de
   *  uma parcela devolve `.installment`. Tenta as parcelas até achar. */
  private async resolveInstallmentId(
    parcelas: { external_id: string | null }[],
    tenantId: string,
  ): Promise<string | null> {
    for (const p of parcelas) {
      if (!p.external_id) continue;
      try {
        const detail = await this.asaas.getCharge(p.external_id, tenantId);
        if (detail?.installment) return String(detail.installment);
      } catch {
        /* tenta a próxima parcela */
      }
    }
    return null;
  }

  /** Chip FINANCEIRO → fallback CLINICA → default (undefined = env do WhatsappService). */
  private async resolveInstance(tenantId: string): Promise<string | undefined> {
    try {
      const fin = await this.whatsapp.getInstanceForPurpose(tenantId, 'FINANCEIRO');
      if (fin) return fin;
      const clinica = await this.whatsapp.getInstanceForPurpose(tenantId, 'CLINICA');
      if (clinica) return clinica;
    } catch (e: any) {
      this.logger.warn(`[BOLETO_DELIVERY] Falha ao resolver instância do tenant ${tenantId}: ${e?.message || e}`);
    }
    return undefined;
  }

  /** Disparo LIGADO pro tenant? (MESMA key da apresentação — 1 toggle p/ o fluxo). */
  private async isEnabled(tenantId: string): Promise<boolean> {
    if (!tenantId) return false;
    try {
      const row = await this.prisma.globalSetting.findUnique({ where: { key: `BOLETO_INTRO_ENABLED_${tenantId}` } });
      return row?.value === 'true';
    } catch {
      return false;
    }
  }

  /** Registra a entrega (idempotência exactly-once por venda). Best-effort. */
  private async logDelivered(planId: string, tenantId: string, outcome: string): Promise<void> {
    try {
      await this.prisma.auditLog.create({
        data: {
          entity: 'BOLETO_DELIVERY',
          entity_id: planId,
          action: outcome,
          meta_json: { tenant_id: tenantId, at: new Date().toISOString() },
        },
      });
    } catch (e: any) {
      this.logger.warn(`[BOLETO_DELIVERY] Falha ao registrar AuditLog do plano ${planId}: ${e?.message || e}`);
    }
  }

  /** Envia UMA peça só se ainda não foi (dedup por peça); marca no sucesso REAL.
   *  Retorna true se a peça está entregue (agora ou antes), false se falhou/recusada. */
  private async sendPiece(pieceId: string, tenantId: string, fn: () => Promise<any>): Promise<boolean> {
    if (await this.alreadySentPiece(pieceId)) return true;
    let res: any;
    try {
      res = await fn();
    } catch (e: any) {
      this.logger.warn(`[BOLETO_DELIVERY] Falha de envio (${pieceId}): ${e?.message || e}`);
      return false;
    }
    if (!this.wasSent(res)) {
      this.logger.warn(`[BOLETO_DELIVERY] Evolution recusou o envio (${pieceId}): ${JSON.stringify(res).slice(0, 200)}`);
      return false;
    }
    await this.markPiece(pieceId, tenantId);
    return true;
  }

  /** A Evolution NÃO lança em erro: request() devolve {statusCode,error} (ou 408 no
   *  timeout) em falha, e a resposta com key.id em sucesso. Só é sucesso REAL quando
   *  veio um id de mensagem e nenhum statusCode de erro. */
  private wasSent(res: any): boolean {
    if (!res || typeof res !== 'object') return false;
    if (typeof res.statusCode === 'number' && res.statusCode >= 400) return false;
    if (res.error && !res.key) return false;
    if (res.exists === false) return false; // número não está no WhatsApp
    return !!(res.key?.id || res.messageId || res.id);
  }

  /** Essa peça já foi entregue? (dedup granular via AuditLog BOLETO_DELIVERY_PIECE). */
  private async alreadySentPiece(pieceId: string): Promise<boolean> {
    try {
      const row = await this.prisma.auditLog.findFirst({
        where: { entity: 'BOLETO_DELIVERY_PIECE', entity_id: pieceId, action: 'sent' },
        select: { id: true },
      });
      return !!row;
    } catch {
      return false;
    }
  }

  private async markPiece(pieceId: string, tenantId: string): Promise<void> {
    try {
      await this.prisma.auditLog.create({
        data: { entity: 'BOLETO_DELIVERY_PIECE', entity_id: pieceId, action: 'sent', meta_json: { tenant_id: tenantId } },
      });
    } catch (e: any) {
      this.logger.warn(`[BOLETO_DELIVERY] Falha ao registrar peça ${pieceId}: ${e?.message || e}`);
    }
  }
}

import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { AsaasClient } from './asaas/asaas-client';
import { WhatsappService } from '../whatsapp/whatsapp.service';

/**
 * Parte 2 — ENVIO DOS BOLETOS no dia seguinte à apresentação (Central de Disparos).
 *
 * Fluxo (opt-in, gate BOLETO_DELIVERY_ENABLED_${tenant} — toggle próprio; sem valor
 * herda a apresentação BOLETO_INTRO_ENABLED):
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
 * Ritmo: dentro de UM cliente os boletos saem IMEDIATOS (texto + carnê + entrada,
 * back-to-back); ENTRE clientes diferentes há um gap curto (GAP_*_MS) pra não
 * disparar pra várias pessoas ao mesmo tempo. Não é anti-ban pesado (o chip
 * FINANCEIRO é dedicado/baixo volume) — é só pra não ser simultâneo. Cada rodada
 * (horário comercial Maceió) processa as entregas pendentes até o teto por rodada.
 * Dedup POR VENDA (AuditLog entity=BOLETO_DELIVERY) + POR PEÇA
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
  /** Teto de segurança por rodada (o excedente escorre pra rodada seguinte). */
  private static readonly MAX_PER_RUN = 30;
  /** Gap ENTRE clientes (não dentro de um cliente): dentro de UM cliente os boletos
   *  saem imediatos (texto+carnê+entrada); entre clientes DIFERENTES espera um tempo
   *  pra não disparar pra várias pessoas ao mesmo tempo. Chip dedicado → gap curto. */
  private static readonly GAP_MIN_MS = 20_000; // 20s
  private static readonly GAP_MAX_MS = 45_000; // 45s

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
      for (let i = 0; i < pending.length; i++) {
        // Gap ENTRE clientes (o 1º sai na hora; os seguintes esperam um tempo) — pra
        // não disparar pra várias pessoas simultaneamente. Dentro de cada cliente o
        // envio (texto+carnê+entrada) continua imediato.
        if (i > 0) await this.sleep(this.randomGapMs());
        await this.deliverOne(pending[i]);
      }
    } catch (e: any) {
      this.logger.error(`[BOLETO_DELIVERY] Erro no tick: ${e?.message || e}`);
    } finally {
      this.busy = false;
    }
  }

  /**
   * TESTE — envia os boletos de uma venda AGORA, pro telefone informado (não pro
   * paciente), SEM gastar a dedup do fluxo real (força reenvio). Escopo por tenant.
   */
  async deliverNow(planId: string, tenantId: string, testPhone: string): Promise<{ ok: boolean; detail: string }> {
    const phone = (testPhone || '').trim();
    if (!phone) return { ok: false, detail: 'Informe um telefone de teste.' };
    // Isolamento: a venda tem boleto DESTE tenant? (não vaza venda de outra clínica)
    // O filtro tem que ser o MESMO do sendBoletos (em aberto, não recebido na clínica):
    // sem isso o precheck passava numa venda já quitada, o sendBoletos não achava nada,
    // devolvia true ("nada a reprocessar") e o operador via um toast VERDE de sucesso
    // sem nenhuma mensagem ter saído.
    const anyCharge = await this.prisma.paymentGatewayCharge.findFirst({
      where: {
        tenant_id: tenantId,
        billing_type: 'BOLETO',
        received_in_cash: false,
        status: { in: ['PENDING', 'OVERDUE'] },
        // As cobranças se ligam ao plano pela DESCRIÇÃO (plan:{id}) — igual ao front;
        // treatment_plan_id como fallback (financiamento seta a coluna).
        OR: [{ treatment_plan_id: planId }, { description: { contains: `plan:${planId}` } }],
      },
      select: { treatment_plan: { select: { patient: { select: { name: true } } } } },
    });
    if (!anyCharge) {
      return { ok: false, detail: 'Esta venda não tem boleto em aberto para enviar (já quitado ou recebido na clínica).' };
    }
    const name = anyCharge.treatment_plan?.patient?.name || 'Paciente';
    const ok = await this.sendBoletos(planId, tenantId, name, phone, { dedup: false });
    return {
      ok,
      detail: ok
        ? `Boletos de teste enviados para ${phone}.`
        : 'Falha no envio de teste — veja os logs [BOLETO_DELIVERY] (chip/telefone/Asaas).',
    };
  }

  /**
   * ON-DEMAND: manda o PRÓXIMO boleto a vencer (o "do mês") de uma venda, em PDF,
   * pro PACIENTE (número real). Usado pelo botão "Enviar boleto do mês". Escopo
   * por tenant. boleto_url nulo é enriquecido via Asaas antes de enviar.
   */
  async sendCurrentBoleto(planId: string, tenantId: string): Promise<{ ok: boolean; detail: string }> {
    const charges = await this.prisma.paymentGatewayCharge.findMany({
      where: {
        tenant_id: tenantId,
        billing_type: 'BOLETO',
        received_in_cash: false,
        status: { in: ['PENDING', 'OVERDUE'] },
        OR: [{ treatment_plan_id: planId }, { description: { contains: `plan:${planId}` } }],
      },
      select: {
        id: true,
        external_id: true,
        boleto_url: true,
        due_date: true,
        customer_external_id: true,
        treatment_plan: { select: { patient: { select: { name: true, phone: true } } } },
      },
      orderBy: { due_date: 'asc' }, // o mais próximo a vencer (ou o mais atrasado) primeiro
    });
    if (charges.length === 0) return { ok: false, detail: 'Esta venda não tem boleto em aberto.' };

    const next = charges[0];
    // Telefone/nome: pelo treatment_plan.patient; fallback via customer Asaas → lead
    // (cobrança ligada só pela descrição, sem treatment_plan_id preenchido).
    let name = next.treatment_plan?.patient?.name || 'Paciente';
    let phone = (next.treatment_plan?.patient?.phone || '').trim();
    if (!phone && next.customer_external_id) {
      const cust = await this.prisma.paymentGatewayCustomer.findFirst({
        where: { external_id: next.customer_external_id, gateway: 'ASAAS' },
        select: { lead: { select: { name: true, phone: true } } },
      });
      if (cust?.lead) {
        name = cust.lead.name || name;
        phone = (cust.lead.phone || '').trim();
      }
    }
    if (!phone) return { ok: false, detail: 'Paciente sem telefone cadastrado.' };

    // boleto_url pode vir null (parcela recém-criada) → enriquece via Asaas.
    let url = next.boleto_url;
    if (!url && next.external_id) {
      try {
        const d = await this.asaas.getCharge(next.external_id, tenantId);
        url = d?.bankSlipUrl || null;
      } catch {
        /* segue sem url → mensagem de erro abaixo */
      }
    }
    if (!url) return { ok: false, detail: 'O boleto ainda não tem PDF disponível — tente em instantes.' };

    const instance = await this.resolveInstance(tenantId);
    const firstName = name.split(' ')[0];
    const due = new Date(next.due_date);
    const dd = String(due.getUTCDate()).padStart(2, '0');
    const mm = String(due.getUTCMonth() + 1).padStart(2, '0');
    const caption = `Oi ${firstName}! 👋 Segue o seu boleto (vence ${dd}/${mm}). Qualquer dúvida, é só responder por aqui. 😊`;

    let res: any;
    try {
      res = await this.whatsapp.sendMedia(phone, 'document', url, caption, instance, 'boleto.pdf', 'application/pdf');
    } catch (e: any) {
      this.logger.warn(`[BOLETO_DELIVERY] send-current falhou (plano ${planId}): ${e?.message || e}`);
      return { ok: false, detail: 'Falha ao enviar o boleto.' };
    }
    const ok = this.wasSent(res);
    return { ok, detail: ok ? `Boleto enviado ao paciente (${phone}).` : 'A Evolution recusou o envio (número/chip).' };
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
  private async sendBoletos(planId: string, tenantId: string, name: string, phone: string, opts?: { dedup?: boolean }): Promise<boolean> {
    const dedup = opts?.dedup !== false; // teste passa dedup:false → força reenvio, sem marcar
    const charges = await this.prisma.paymentGatewayCharge.findMany({
      where: {
        tenant_id: tenantId,
        billing_type: 'BOLETO',
        received_in_cash: false,
        status: { in: ['PENDING', 'OVERDUE'] },
        OR: [{ treatment_plan_id: planId }, { description: { contains: `plan:${planId}` } }],
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
    // Tudo que NÃO é parcela (entrada, sinal, boleto avulso 1×, kind legado null) vai
    // como PDF individual — assim venda de 1 boleto só também é entregue.
    const avulsos = charges.filter((c) => c.kind !== 'INSTALLMENT');
    const instance = await this.resolveInstance(tenantId);
    const firstName = name.split(' ')[0];
    let allOk = true;

    // 1) Texto de abertura — editável na Central de Disparos (card "Envio dos
    // boletos"); cai no default se a clínica não editou. NÃO cita prazo ("ontem"):
    // a entrega pode sair D+1 ou dias depois (janela larga).
    const abertura = await this.resolveDeliveryText(tenantId, firstName);
    const textOk = await this.sendPiece(`${planId}:text`, tenantId, () =>
      this.whatsapp.sendText(phone, abertura, instance), dedup,
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
      }, dedup);
      if (!carneOk) allOk = false;
    }

    // 3) Entrada/sinal (boletos avulsos) — PDF direto pela URL pública do Asaas.
    for (const c of avulsos) {
      if (!c.boleto_url) continue;
      const label = c.kind === 'ENTRADA' ? 'Entrada' : c.kind === 'SINAL' ? 'Sinal' : 'Boleto';
      const ok = await this.sendPiece(`${planId}:${c.external_id}`, tenantId, () =>
        this.whatsapp.sendMedia(
          phone, 'document', c.boleto_url as string, label, instance,
          `boleto-${(c.kind || 'boleto').toLowerCase()}.pdf`, 'application/pdf',
        ), dedup,
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

  /** Entrega (D+2) LIGADA pro tenant? Toggle próprio (BOLETO_DELIVERY_ENABLED); quando
   *  nunca foi setado, HERDA a apresentação (compat: antes era 1 toggle só). */
  private async isEnabled(tenantId: string): Promise<boolean> {
    if (!tenantId) return false;
    try {
      const row = await this.prisma.globalSetting.findUnique({ where: { key: `BOLETO_DELIVERY_ENABLED_${tenantId}` } });
      if (row) return row.value === 'true';
      const intro = await this.prisma.globalSetting.findUnique({ where: { key: `BOLETO_INTRO_ENABLED_${tenantId}` } });
      return intro?.value === 'true';
    } catch {
      return false;
    }
  }

  /** Texto de abertura da entrega — editável na Central de Disparos (mesma infra dos
   *  boletos, cobrancaTemplateKey 'boleto_delivery'); cai no default se não editado.
   *  Resolve {nome} e {clinica}. */
  private async resolveDeliveryText(tenantId: string, firstName: string): Promise<string> {
    const { cobrancaTemplateKey, DEFAULT_BOLETO_DELIVERY } = await import('@crm/shared');
    let template = DEFAULT_BOLETO_DELIVERY;
    try {
      const row = await this.prisma.globalSetting.findUnique({ where: { key: cobrancaTemplateKey('boleto_delivery', tenantId) } });
      if (row?.value) {
        const parsed = JSON.parse(row.value);
        if (typeof parsed?.template === 'string' && parsed.template.trim()) template = parsed.template;
      }
    } catch { /* valor corrompido / sem template → default */ }
    let clinica = 'a clínica';
    if (template.includes('{clinica}')) {
      const t = await this.prisma.tenant.findUnique({ where: { id: tenantId }, select: { name: true } }).catch(() => null);
      if (t?.name) clinica = t.name;
    }
    return template.replace(/\{nome\}/g, firstName).replace(/\{clinica\}/g, clinica);
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
  private async sendPiece(pieceId: string, tenantId: string, fn: () => Promise<any>, dedup = true): Promise<boolean> {
    if (dedup && (await this.alreadySentPiece(pieceId))) return true;
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
    if (dedup) await this.markPiece(pieceId, tenantId);
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

  /** Gap sorteado (com leve variação) ENTRE clientes — não robótico, não simultâneo. */
  private randomGapMs(): number {
    const { GAP_MIN_MS, GAP_MAX_MS } = BoletoDeliveryService;
    return Math.floor(GAP_MIN_MS + Math.random() * (GAP_MAX_MS - GAP_MIN_MS));
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
  Logger,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

/**
 * AffiliateService — Onda 5e v34 (Fase 25).
 *
 * Gerencia o programa de afiliado: lead/paciente parceiro que recebe 3%
 * (configuravel) de cada tratamento fechado por indicacao dele. Saldo
 * acumula automaticamente e pode ser sacado (PIX/dinheiro) ou usado como
 * credito em tratamentos proprios.
 *
 * Calcula saldo em runtime via:
 *   disponivel = sum(referral.commission_value WHERE status='creditado')
 *              - sum(withdrawal.amount WHERE status IN ('pago','solicitado'))
 *
 * Hook: QuotesService.markAccepted chama `recordReferralFromAcceptedQuote()`
 * quando uma Quote vira ACCEPTED, e cria AffiliateReferral se o paciente
 * tem `referred_by_id` apontando pra um Patient afiliado.
 */

const VALID_METHODS = ['PIX', 'DINHEIRO', 'CREDITO_TRATAMENTO'] as const;
type WithdrawalMethod = (typeof VALID_METHODS)[number];

// ─── Faixas de afiliado por VOLUME (Onda 17.63) ──────────────────────────────
// Decisão do dono: o % do afiliado SOBE conforme ele acumula indicações que
// fecham — e o % maior vale só pras PRÓXIMAS indicações (não-retroativo,
// garantido pelo snapshot de `commission_pct` gravado em cada AffiliateReferral).
// Config por tenant em GlobalSetting `AFFILIATE_TIERS_<tenant>`. `enabled=false`
// por padrão: a clínica confere os números e LIGA — não trocamos % de comissão
// caladamente num deploy (skill: "default conservador + confirmar").
export type AffiliateTier = { label: string; min: number; pct: number };
type AffiliateTiersConfig = { enabled: boolean; tiers: AffiliateTier[] };

const DEFAULT_AFFILIATE_TIERS: AffiliateTiersConfig = {
  enabled: false,
  tiers: [
    { label: 'Bronze', min: 0, pct: 3 },
    { label: 'Prata', min: 5, pct: 4 },
    { label: 'Ouro', min: 12, pct: 5 },
    { label: 'Diamante', min: 25, pct: 6 },
  ],
};

/** Faixa atual = a de maior `min` que o volume já alcançou. */
function resolveAffiliateTier(volume: number, tiers: AffiliateTier[]): AffiliateTier {
  const sorted = [...tiers].sort((a, b) => a.min - b.min);
  let cur: AffiliateTier = sorted[0] ?? { label: '—', min: 0, pct: 3 };
  for (const t of sorted) if (volume >= t.min) cur = t;
  return cur;
}

/** Próxima faixa (menor `min` ainda acima do volume), ou null se já no topo. */
function nextAffiliateTier(volume: number, tiers: AffiliateTier[]): AffiliateTier | null {
  const above = [...tiers].filter((t) => t.min > volume).sort((a, b) => a.min - b.min);
  return above[0] ?? null;
}

@Injectable()
export class AffiliateService {
  private readonly logger = new Logger(AffiliateService.name);

  constructor(private prisma: PrismaService) {}

  /**
   * Retorna o dashboard completo de afiliado de um paciente:
   * saldo (disponivel/acumulado/sacado/pendente), lista de indicacoes
   * e historico de saques.
   */
  async getDashboard(patientId: string, tenantId: string) {
    const patient = await this.prisma.patient.findFirst({
      where: { id: patientId, tenant_id: tenantId },
      select: {
        id: true,
        name: true,
        is_affiliate: true,
        affiliate_code: true,
        affiliate_commission_pct: true,
        affiliate_notes: true,
      },
    });
    if (!patient) throw new NotFoundException('Paciente nao encontrado');

    const [referrals, withdrawals] = await Promise.all([
      this.prisma.affiliateReferral.findMany({
        where: { tenant_id: tenantId, referrer_id: patientId },
        orderBy: { closed_at: 'desc' },
        include: {
          referred: { select: { id: true, name: true, phone: true } },
        },
      }),
      this.prisma.affiliateWithdrawal.findMany({
        where: { tenant_id: tenantId, patient_id: patientId },
        orderBy: { requested_at: 'desc' },
      }),
    ]);

    // Saldo calculado em runtime
    const totalAcumulado = referrals
      .filter((r) => r.status === 'creditado')
      .reduce((a, r) => a + Number(r.commission_value), 0);
    const totalSacado = withdrawals
      .filter((w) => w.status === 'pago')
      .reduce((a, w) => a + Number(w.amount), 0);
    const pendenteSaque = withdrawals
      .filter((w) => w.status === 'solicitado')
      .reduce((a, w) => a + Number(w.amount), 0);
    const disponivel = Math.max(0, totalAcumulado - totalSacado - pendenteSaque);

    // Faixa por volume (nº de indicações creditadas). Quando as faixas estão
    // ligadas, mostramos a faixa atual + quanto falta pra próxima; senão, o %
    // fixo do cadastro.
    const tiersCfg = await this.getTiers(tenantId);
    const indicacoesCreditadas = referrals.filter((r) => r.status === 'creditado').length;
    const faixa = tiersCfg.enabled
      ? (() => {
          const atual = resolveAffiliateTier(indicacoesCreditadas, tiersCfg.tiers);
          const proxima = nextAffiliateTier(indicacoesCreditadas, tiersCfg.tiers);
          return {
            ativo: true,
            atual,
            proxima,
            faltam: proxima ? Math.max(0, proxima.min - indicacoesCreditadas) : 0,
            indicacoesCreditadas,
          };
        })()
      : {
          ativo: false,
          pctFixo: Number(patient.affiliate_commission_pct ?? 3),
          indicacoesCreditadas,
        };

    return {
      patient: {
        id: patient.id,
        name: patient.name,
        is_affiliate: patient.is_affiliate,
        affiliate_code: patient.affiliate_code,
        affiliate_commission_pct: Number(patient.affiliate_commission_pct),
        affiliate_notes: patient.affiliate_notes,
      },
      stats: { disponivel, totalAcumulado, totalSacado, pendenteSaque },
      faixa,
      referrals: referrals.map((r) => ({
        id: r.id,
        indicated_name: r.referred?.name ?? '—',
        indicated_phone: r.referred?.phone ?? null,
        indicated_id: r.referred_id,
        closed_at: r.closed_at.toISOString(),
        treatment_value: Number(r.treatment_value),
        commission_value: Number(r.commission_value),
        commission_pct: Number(r.commission_pct),
        status: r.status as 'creditado' | 'pendente' | 'cancelado',
        quote_id: r.quote_id,
      })),
      withdrawals: withdrawals.map((w) => ({
        id: w.id,
        amount: Number(w.amount),
        method: w.method,
        pix_key: w.pix_key,
        status: w.status as 'solicitado' | 'pago' | 'recusado',
        requested_at: w.requested_at.toISOString(),
        paid_at: w.paid_at?.toISOString() ?? null,
        notes: w.notes,
      })),
    };
  }

  /**
   * Solicita saque do saldo. Valida valor contra saldo disponivel.
   * Cria AffiliateWithdrawal com status='solicitado'.
   *
   * Admin/financeiro depois confirma pagamento via `confirmWithdrawalPaid()`.
   */
  async requestWithdrawal(
    patientId: string,
    tenantId: string,
    data: {
      amount: number;
      method: WithdrawalMethod;
      pix_key?: string;
      notes?: string;
    },
  ) {
    if (!data.amount || data.amount <= 0) {
      throw new BadRequestException('Valor invalido');
    }
    if (!VALID_METHODS.includes(data.method)) {
      throw new BadRequestException(
        `method deve ser um de: ${VALID_METHODS.join(', ')}`,
      );
    }
    if (data.method === 'PIX' && !data.pix_key?.trim()) {
      throw new BadRequestException('PIX requer pix_key');
    }

    const dashboard = await this.getDashboard(patientId, tenantId);
    if (!dashboard.patient.is_affiliate) {
      throw new ForbiddenException('Paciente nao e afiliado ativo');
    }
    if (data.amount > dashboard.stats.disponivel) {
      throw new BadRequestException(
        `Saldo insuficiente. Disponivel: R$ ${dashboard.stats.disponivel.toFixed(2)}`,
      );
    }

    const withdrawal = await this.prisma.affiliateWithdrawal.create({
      data: {
        tenant_id: tenantId,
        patient_id: patientId,
        amount: data.amount,
        method: data.method,
        pix_key: data.method === 'PIX' ? (data.pix_key?.trim() || null) : null,
        notes: data.notes?.trim() || null,
        status: 'solicitado',
      },
    });

    this.logger.log(
      `[AFFILIATE_WITHDRAWAL] Solicitado: patient=${patientId} amount=${data.amount} method=${data.method} id=${withdrawal.id}`,
    );

    return { id: withdrawal.id, status: withdrawal.status };
  }

  /**
   * Admin confirma que pagou o saque. Marca paid_at + paid_by_user_id.
   * Idempotente: se ja esta pago, retorna sem erro.
   */
  async confirmWithdrawalPaid(
    withdrawalId: string,
    tenantId: string,
    paidByUserId: string,
  ) {
    const w = await this.prisma.affiliateWithdrawal.findFirst({
      where: { id: withdrawalId, tenant_id: tenantId },
    });
    if (!w) throw new NotFoundException('Saque nao encontrado');
    if (w.status === 'pago') return { ok: true, idempotent: true };
    if (w.status === 'recusado') {
      throw new BadRequestException('Saque ja foi recusado — nao pode pagar');
    }

    const paidAt = new Date();
    // ATÔMICO contra corrida (duplo-clique / 2 admins / 2 abas): só o vencedor
    // que muda 'solicitado'→'pago' segue e lança a DESPESA. O updateMany
    // condicional por status fecha a janela TOCTOU sem precisar de transação —
    // `UPDATE ... WHERE status='solicitado'` afeta exatamente 1 linha no Postgres.
    const res = await this.prisma.affiliateWithdrawal.updateMany({
      where: { id: withdrawalId, tenant_id: tenantId, status: 'solicitado' },
      data: { status: 'pago', paid_at: paidAt, paid_by_user_id: paidByUserId },
    });
    if (res.count === 0) {
      // Outra requisição concorrente já pagou (ou recusou) — NÃO lança 2ª DESPESA.
      return { ok: true, idempotent: true };
    }

    this.logger.log(
      `[AFFILIATE_WITHDRAWAL] Pago: id=${withdrawalId} by=${paidByUserId}`,
    );

    // Onda 17.63 — saída REAL de dinheiro pro afiliado vira DESPESA no caixa
    // (mesma regra das comissões dos dentistas: toda saída repassada entra no
    // financeiro). CREDITO_TRATAMENTO NÃO entra: é abatimento no próprio
    // tratamento do afiliado (encontro de contas), não saída de espécie.
    // Best-effort: não derruba o pagamento se o lançamento falhar.
    if (w.method === 'PIX' || w.method === 'DINHEIRO') {
      try {
        const aff = await this.prisma.patient.findUnique({
          where: { id: w.patient_id },
          select: { name: true },
        });
        await this.prisma.financialTransaction.create({
          data: {
            tenant_id: tenantId,
            type: 'DESPESA',
            category: 'COMISSAO_AFILIADO',
            description: `Saque afiliado — ${aff?.name || 'Paciente'}`,
            amount: w.amount,
            date: paidAt,
            paid_at: paidAt,
            payment_method: w.method,
            status: 'PAGO',
            reference_id: w.id,
            visible_to_dentist: false,
            notes: w.notes ?? `Pagamento de saque de afiliado (ref. ${w.id.slice(0, 8)})`,
          },
        });
        this.logger.log(
          `[AFFILIATE_WITHDRAWAL] DESPESA lançada no caixa p/ saque ${withdrawalId} (R$ ${Number(w.amount)})`,
        );
      } catch (e: any) {
        this.logger.warn(
          `[AFFILIATE_WITHDRAWAL] Falha ao lançar DESPESA do saque ${withdrawalId}: ${e?.message ?? e}`,
        );
      }
    }
    return { ok: true };
  }

  /**
   * Lista global de afiliados do tenant + KPIs agregados.
   * Usado pela pagina /atendimento/afiliados (dashboard admin).
   *
   * Retorna:
   *   - kpis: total ativos, indicacoes do mes, saldo total acumulado, saques pendentes
   *   - top5: ranking de afiliados por # de indicacoes fechadas no mes
   *   - affiliates: lista completa com nome, codigo, qtd indicacoes,
   *     saldo, ultimo saque, status
   */
  async listAffiliatesDashboard(tenantId: string) {
    const monthStart = new Date();
    monthStart.setUTCDate(1);
    monthStart.setUTCHours(0, 0, 0, 0);

    const [affiliates, allReferrals, allWithdrawals] = await Promise.all([
      this.prisma.patient.findMany({
        where: { tenant_id: tenantId, is_affiliate: true, status: 'ACTIVE' },
        select: {
          id: true,
          name: true,
          phone: true,
          affiliate_code: true,
          affiliate_commission_pct: true,
          created_at: true,
        },
      }),
      this.prisma.affiliateReferral.findMany({
        where: { tenant_id: tenantId },
        select: {
          referrer_id: true,
          commission_value: true,
          status: true,
          closed_at: true,
        },
      }),
      this.prisma.affiliateWithdrawal.findMany({
        where: { tenant_id: tenantId },
        select: {
          patient_id: true,
          amount: true,
          status: true,
          requested_at: true,
        },
      }),
    ]);

    // Agrega por referrer_id
    type Agg = {
      indicacoes_total: number;
      indicacoes_mes: number;
      creditado_total: number;
      sacado_total: number;
      pendente_saque: number;
    };
    const agg = new Map<string, Agg>();
    for (const a of affiliates) {
      agg.set(a.id, {
        indicacoes_total: 0,
        indicacoes_mes: 0,
        creditado_total: 0,
        sacado_total: 0,
        pendente_saque: 0,
      });
    }
    for (const r of allReferrals) {
      const row = agg.get(r.referrer_id);
      if (!row) continue;
      if (r.status === 'creditado') {
        row.indicacoes_total += 1;
        row.creditado_total += Number(r.commission_value);
        if (r.closed_at >= monthStart) row.indicacoes_mes += 1;
      }
    }
    for (const w of allWithdrawals) {
      const row = agg.get(w.patient_id);
      if (!row) continue;
      if (w.status === 'pago') row.sacado_total += Number(w.amount);
      if (w.status === 'solicitado') row.pendente_saque += Number(w.amount);
    }

    const tiersCfg = await this.getTiers(tenantId);
    const enriched = affiliates.map((a) => {
      const ag = agg.get(a.id) ?? {
        indicacoes_total: 0,
        indicacoes_mes: 0,
        creditado_total: 0,
        sacado_total: 0,
        pendente_saque: 0,
      };
      const saldo_disponivel = Math.max(
        0,
        ag.creditado_total - ag.sacado_total - ag.pendente_saque,
      );
      // Faixa atual quando ligada: o % vigente sai do volume de indicações.
      const tier = tiersCfg.enabled
        ? resolveAffiliateTier(ag.indicacoes_total, tiersCfg.tiers)
        : null;
      return {
        id: a.id,
        name: a.name,
        phone: a.phone,
        affiliate_code: a.affiliate_code,
        commission_pct: tier ? tier.pct : Number(a.affiliate_commission_pct ?? 3),
        faixa_label: tier ? tier.label : null,
        created_at: a.created_at.toISOString(),
        indicacoes_total: ag.indicacoes_total,
        indicacoes_mes: ag.indicacoes_mes,
        creditado_total: ag.creditado_total,
        sacado_total: ag.sacado_total,
        pendente_saque: ag.pendente_saque,
        saldo_disponivel,
      };
    });

    // KPIs agregados
    const kpis = {
      total_ativos: enriched.length,
      indicacoes_mes: enriched.reduce((a, e) => a + e.indicacoes_mes, 0),
      saldo_total: enriched.reduce((a, e) => a + e.saldo_disponivel, 0),
      saques_pendentes_qtd: allWithdrawals.filter((w) => w.status === 'solicitado').length,
      saques_pendentes_valor: allWithdrawals
        .filter((w) => w.status === 'solicitado')
        .reduce((a, w) => a + Number(w.amount), 0),
    };

    // Top 5 do mes (ordenado por indicacoes_mes desc, creditado_total como tiebreak)
    const top5 = [...enriched]
      .filter((e) => e.indicacoes_mes > 0)
      .sort((a, b) => {
        if (b.indicacoes_mes !== a.indicacoes_mes) return b.indicacoes_mes - a.indicacoes_mes;
        return b.creditado_total - a.creditado_total;
      })
      .slice(0, 5);

    return {
      kpis,
      top5,
      tiers: tiersCfg,
      affiliates: enriched.sort((a, b) => b.saldo_disponivel - a.saldo_disponivel),
    };
  }

  /**
   * Lista de saques solicitados (admin pra aprovar/recusar em massa).
   */
  async listPendingWithdrawals(tenantId: string) {
    const rows = await this.prisma.affiliateWithdrawal.findMany({
      where: { tenant_id: tenantId, status: 'solicitado' },
      orderBy: { requested_at: 'asc' },
      include: {
        patient: { select: { id: true, name: true, phone: true, affiliate_code: true } },
      },
    });
    return rows.map((w) => ({
      id: w.id,
      patient_id: w.patient_id,
      patient_name: w.patient?.name ?? '—',
      patient_phone: w.patient?.phone ?? null,
      affiliate_code: w.patient?.affiliate_code ?? null,
      amount: Number(w.amount),
      method: w.method,
      pix_key: w.pix_key,
      requested_at: w.requested_at.toISOString(),
      notes: w.notes,
    }));
  }

  /**
   * Admin recusa o saque (ex: dados PIX invalidos, saldo retroativamente
   * cancelado, etc). Libera o valor pra voltar pro saldo disponivel.
   */
  async refuseWithdrawal(
    withdrawalId: string,
    tenantId: string,
    notes?: string,
  ) {
    const w = await this.prisma.affiliateWithdrawal.findFirst({
      where: { id: withdrawalId, tenant_id: tenantId },
    });
    if (!w) throw new NotFoundException('Saque nao encontrado');
    if (w.status !== 'solicitado') {
      throw new BadRequestException('So saques solicitados podem ser recusados');
    }
    await this.prisma.affiliateWithdrawal.update({
      where: { id: withdrawalId },
      data: { status: 'recusado', notes: notes?.trim() || w.notes },
    });
    return { ok: true };
  }

  /**
   * Lê a config de faixas do tenant. Default: faixas sugeridas, DESLIGADAS
   * (a clínica confere os números e liga). enabled=true é o que faz o % sair
   * da faixa no momento do crédito.
   */
  async getTiers(tenantId: string): Promise<AffiliateTiersConfig> {
    try {
      const row = await this.prisma.globalSetting.findUnique({
        where: { key: `AFFILIATE_TIERS_${tenantId}` },
      });
      if (!row?.value) return DEFAULT_AFFILIATE_TIERS;
      const parsed = JSON.parse(row.value);
      if (!parsed || !Array.isArray(parsed.tiers) || !parsed.tiers.length) {
        return DEFAULT_AFFILIATE_TIERS;
      }
      return { enabled: !!parsed.enabled, tiers: parsed.tiers };
    } catch {
      return DEFAULT_AFFILIATE_TIERS;
    }
  }

  /** Salva a config de faixas (saneada e ordenada por `min`). */
  async setTiers(
    tenantId: string,
    cfg: { enabled?: boolean; tiers: AffiliateTier[] },
  ): Promise<AffiliateTiersConfig> {
    const tiers = (Array.isArray(cfg.tiers) ? cfg.tiers : [])
      .map((t) => ({
        label: String(t?.label ?? '').trim() || '—',
        min: Math.max(0, Math.floor(Number(t?.min) || 0)),
        pct: Math.max(0, Number(t?.pct) || 0),
      }))
      .sort((a, b) => a.min - b.min);
    if (!tiers.length) throw new BadRequestException('Defina ao menos uma faixa');
    if (tiers.some((t) => t.pct > 100)) {
      throw new BadRequestException('Percentual de faixa não pode passar de 100%');
    }
    const key = `AFFILIATE_TIERS_${tenantId}`;
    const value = JSON.stringify({ enabled: !!cfg.enabled, tiers });
    await this.prisma.globalSetting.upsert({
      where: { key },
      create: { key, value },
      update: { value },
    });
    return this.getTiers(tenantId);
  }

  /** Volume do afiliado = nº de indicações já creditadas (resolve a faixa). */
  private async affiliateVolume(
    tenantId: string,
    referrerId: string,
  ): Promise<number> {
    return this.prisma.affiliateReferral.count({
      where: { tenant_id: tenantId, referrer_id: referrerId, status: 'creditado' },
    });
  }

  /**
   * Hook chamado pelo QuotesService quando uma Quote vira ACCEPTED.
   *
   * Cria um AffiliateReferral pro afiliado que indicou o paciente,
   * calculando a comissao baseado no `affiliate_commission_pct` do
   * referrer (snapshot do % na hora — protege contra mudancas futuras
   * de percentual nao afetarem comissoes ja geradas).
   *
   * Idempotente: nao cria duplicado se ja existe AffiliateReferral
   * com o mesmo quote_id.
   *
   * Best-effort: erros sao logados mas nao bloqueiam a aceitacao da Quote.
   */
  async recordReferralFromAcceptedQuote(params: {
    quoteId: string;
    patientId: string;
    treatmentValue: number;
    tenantId: string;
  }): Promise<void> {
    try {
      // Ja existe referral pra essa Quote? (idempotente)
      const existing = await this.prisma.affiliateReferral.findFirst({
        where: { quote_id: params.quoteId },
      });
      if (existing) {
        this.logger.log(
          `[AFFILIATE] Quote ${params.quoteId} ja gerou referral — skip`,
        );
        return;
      }

      const patient = await this.prisma.patient.findUnique({
        where: { id: params.patientId },
        select: { referred_by_id: true, cpf: true, phone: true },
      });
      if (!patient?.referred_by_id) return; // sem indicador

      const referrer = await this.prisma.patient.findUnique({
        where: { id: patient.referred_by_id },
        select: {
          id: true,
          is_affiliate: true,
          affiliate_commission_pct: true,
          cpf: true,
          phone: true,
        },
      });
      if (!referrer?.is_affiliate) {
        this.logger.log(
          `[AFFILIATE] Referrer ${patient.referred_by_id} nao e afiliado — skip`,
        );
        return;
      }

      // ── ANTI-FRAUDE (skill, regra mínima): sem auto-indicação.
      //    CPF igual = literalmente a mesma pessoa indicando a si mesma → BLOQUEIA.
      //    Telefone igual NÃO bloqueia: nesta clínica famílias dividem o mesmo
      //    número de contato no cadastro (caso real Clavio/Amanda) — bloquear por
      //    telefone barraria indicação legítima de parente. Vira só ALERTA pra revisão.
      const digits = (s?: string | null) => (s || '').replace(/\D/g, '');
      const cpfReferred = digits(patient.cpf);
      const cpfReferrer = digits(referrer.cpf);
      const sameCpf = cpfReferred.length >= 11 && cpfReferred === cpfReferrer;
      if (sameCpf) {
        this.logger.warn(
          `[AFFILIATE] Auto-indicação BLOQUEADA (mesmo CPF): referrer=${referrer.id} referred=${params.patientId} — sem comissão`,
        );
        return;
      }
      const foneReferred = digits(patient.phone);
      const foneReferrer = digits(referrer.phone);
      const samePhone = foneReferred.length >= 10 && foneReferred === foneReferrer;
      if (samePhone) {
        this.logger.warn(
          `[AFFILIATE] Indicação com telefone IGUAL ao do afiliado: referrer=${referrer.id} referred=${params.patientId} — creditando (famílias dividem número), mas REVISAR possível auto-indicação`,
        );
      }

      // ── FAIXA POR VOLUME (não-retroativa): se a clínica ligou as faixas, o %
      //    sai da faixa ATUAL do afiliado (nº de indicações já creditadas);
      //    senão, mantém o % fixo do cadastro. O snapshot em `commission_pct`
      //    garante que subir de faixa não recalcula as indicações antigas.
      const tiersCfg = await this.getTiers(params.tenantId);
      let pct = Number(referrer.affiliate_commission_pct ?? 3);
      let faixaLabel: string | null = null;
      if (tiersCfg.enabled) {
        const volume = await this.affiliateVolume(params.tenantId, referrer.id);
        const tier = resolveAffiliateTier(volume, tiersCfg.tiers);
        pct = tier.pct;
        faixaLabel = tier.label;
      }
      const commission = +(params.treatmentValue * (pct / 100)).toFixed(2);

      const referral = await this.prisma.affiliateReferral.create({
        data: {
          tenant_id: params.tenantId,
          referrer_id: referrer.id,
          referred_id: params.patientId,
          quote_id: params.quoteId,
          treatment_value: params.treatmentValue,
          commission_pct: pct,
          commission_value: commission,
          status: 'creditado',
        },
      });

      this.logger.log(
        `[AFFILIATE] Referral criado: id=${referral.id} referrer=${referrer.id} pct=${pct}%${faixaLabel ? ` (faixa ${faixaLabel})` : ''} commission=R$${commission} (quote=${params.quoteId})`,
      );
    } catch (e: any) {
      this.logger.warn(
        `[AFFILIATE] Falha ao registrar referral pra quote ${params.quoteId}: ${e?.message}`,
      );
    }
  }
}

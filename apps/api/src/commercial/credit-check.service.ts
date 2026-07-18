import { Injectable, BadRequestException, Logger } from '@nestjs/common';
import { AsaasClient } from '../payment-gateway/asaas/asaas-client';

/**
 * Onda 12 — Simulacao de consulta de credito pro Financiamento Banco PASSOS.
 *
 * Implementa o caminho B1 + estrutura pronta pra Serasa (caminho A).
 *
 * ┌─ DECISAO ────────────────────────────────────────────────────────┐
 * │ 1. Tenta lookup do CPF no Asaas (gateway que ja temos plugado)   │
 * │    - Cliente recorrente: usa historico de pagamentos como fator  │
 * │    - Cliente novo: ignora essa etapa (sem dados)                 │
 * │                                                                   │
 * │ 2. Calcula ratio renda / parcela (regra base sempre roda)        │
 * │                                                                   │
 * │ 3. Score final = ratio × ajuste_asaas                            │
 * │    - on_time_rate > 80% → +0.5 no ratio (boost)                  │
 * │    - on_time_rate < 50% → −0.5 no ratio (penalty)                │
 * │    - sem historico → ratio neutro                                │
 * │                                                                   │
 * │ 4. Decisao final baseada no score:                               │
 * │    - score >= 3.0 → approved                                     │
 * │    - 2.0 <= score < 3.0 → pending                                │
 * │    - score < 2.0 → denied                                        │
 * └──────────────────────────────────────────────────────────────────┘
 *
 * STUB pra Serasa Crediscore: ver simulateViaSerasa() abaixo (comentado).
 * Quando contratar Serasa, é so trocar a chamada em simulate() pra esse
 * metodo e plugar SERASA_API_KEY/SERASA_BASE_URL nas settings.
 *
 * Custo Serasa em prod: ~R$ 0,50-2,00 por consulta
 * Sandbox gratuito: https://developers.serasaexperian.com.br
 */

export type CreditDecision = 'approved' | 'pending' | 'denied';

export interface CreditCheckRequest {
  cpf: string;
  /** Tenant da clínica que roda a consulta — isola a leitura do histórico Asaas
   *  (senão lê o histórico da conta do dono/matriz de OUTRA clínica). */
  tenantId?: string;
  nome: string;
  data_nascimento: string;
  renda_mensal: number;
  telefone: string;
  profissao: string;
  parcela_alvo: number;
  parcelas: number;
  valor_total: number;
}

interface AsaasHistorico {
  isCustomer: boolean;
  customerId?: string;
  totalPaid?: number;
  totalOverdue?: number;
  onTimeRate?: number; // 0-1
  chargesCount?: number;
}

export interface CreditCheckResult {
  status: CreditDecision;
  decision_id: string;
  ratio: number;
  message: string;
  motivo?: string;
  suggestion?: string;
  conditions?: {
    max_parcelas: number;
    parcela_aprovada: number;
    total_aprovado: number;
    juros_mes: number;
    entrada_pct: number;
  };
  /** Onda 12.1 — fonte da decisao pro front mostrar "Validado por Asaas" etc */
  source: 'internal' | 'asaas_history' | 'serasa';
  /** Onda 12.1 — dados do historico Asaas (se houver) — pra audit/debug */
  asaas_summary?: {
    is_recurring: boolean;
    on_time_rate?: number;
    charges_count?: number;
  };
  checked_at: string;
}

@Injectable()
export class CreditCheckService {
  private readonly logger = new Logger(CreditCheckService.name);

  constructor(private readonly asaas: AsaasClient) {}

  /** Valida CPF (digito verificador). Em prod, Serasa rejeita CPFs invalidos. */
  private isValidCpf(cpf: string): boolean {
    const c = cpf.replace(/\D/g, '');
    if (c.length !== 11) return false;
    if (/^(\d)\1+$/.test(c)) return false;
    let sum = 0;
    for (let i = 0; i < 9; i++) sum += parseInt(c[i], 10) * (10 - i);
    let rest = (sum * 10) % 11;
    if (rest === 10) rest = 0;
    if (rest !== parseInt(c[9], 10)) return false;
    sum = 0;
    for (let i = 0; i < 10; i++) sum += parseInt(c[i], 10) * (11 - i);
    rest = (sum * 10) % 11;
    if (rest === 10) rest = 0;
    return rest === parseInt(c[10], 10);
  }

  /**
   * Onda 12.1 — Lookup do CPF no Asaas. Se for cliente recorrente, puxa o
   * historico de pagamentos pra usar como fator de decisao.
   *
   * Funciona apenas pra pacientes que JA pagaram alguma coisa pela clinica
   * via Asaas (PIX, boleto, cartao). Paciente novo retorna isCustomer=false.
   */
  private async lookupAsaasHistory(cpf: string, tenantId?: string): Promise<AsaasHistorico> {
    try {
      // 1. Busca o customer no Asaas pelo CPF (na conta DA CLÍNICA, não do dono)
      const customersResp = await this.asaas.listCustomers({
        cpfCnpj: cpf,
        limit: 1,
      }, tenantId);
      const customer = customersResp?.data?.[0];
      if (!customer) {
        return { isCustomer: false };
      }

      // 2. Busca os pagamentos desse customer (ultimos 100)
      const chargesResp = await this.asaas.listCharges({
        customer: customer.id,
        limit: 100,
      }, tenantId);
      const charges: any[] = chargesResp?.data ?? [];

      if (charges.length === 0) {
        return { isCustomer: true, customerId: customer.id, chargesCount: 0 };
      }

      // 3. Calcula stats
      // Status do Asaas: CONFIRMED/RECEIVED (pago), OVERDUE (vencido), PENDING (em aberto)
      let totalPaid = 0;
      let totalOverdue = 0;
      let onTimeCount = 0;
      let resolvedCount = 0;

      for (const ch of charges) {
        const value = Number(ch.value || 0);
        const status: string = ch.status;
        if (status === 'RECEIVED' || status === 'CONFIRMED' || status === 'RECEIVED_IN_CASH') {
          totalPaid += value;
          // Pago em dia? Compara dueDate com paymentDate (se ambos existirem)
          const due = ch.dueDate ? new Date(ch.dueDate) : null;
          const paid = ch.paymentDate ? new Date(ch.paymentDate) : null;
          if (due && paid && paid <= due) onTimeCount++;
          resolvedCount++;
        } else if (status === 'OVERDUE') {
          totalOverdue += value;
          resolvedCount++;
        }
      }

      const onTimeRate = resolvedCount > 0 ? onTimeCount / resolvedCount : undefined;

      return {
        isCustomer: true,
        customerId: customer.id,
        totalPaid,
        totalOverdue,
        onTimeRate,
        chargesCount: charges.length,
      };
    } catch (err) {
      // Asaas indisponivel ou nao configurado: nao bloqueia a consulta.
      this.logger.warn(`[CREDIT-CHECK] Asaas lookup falhou: ${(err as Error).message}`);
      return { isCustomer: false };
    }
  }

  /**
   * Onda 12.1 — Stub pronto pra Serasa Crediscore API.
   *
   * Pra ativar:
   * 1. Adicionar settings: serasa_api_key, serasa_environment (sandbox|prod)
   * 2. Injetar HttpService ou usar axios direto aqui
   * 3. Trocar a chamada em simulate() de this.simulateMockWithAsaas pra esta
   *
   * Doc: https://developers.serasaexperian.com.br
   */
  // private async simulateViaSerasa(req: CreditCheckRequest): Promise<CreditCheckResult> {
  //   const apiKey = await this.settingsService.get('serasa_api_key');
  //   const baseUrl = (await this.settingsService.get('serasa_environment')) === 'prod'
  //     ? 'https://api.serasaexperian.com.br/credit-decision/v1'
  //     : 'https://sandbox-api.serasaexperian.com.br/credit-decision/v1';
  //
  //   const response = await axios.post(`${baseUrl}/score`, {
  //     document: req.cpf,
  //     name: req.nome,
  //     birthDate: req.data_nascimento,
  //     monthlyIncome: req.renda_mensal,
  //   }, { headers: { Authorization: `Bearer ${apiKey}` } });
  //
  //   const serasaScore = response.data.score; // 0-1000
  //   const ratio = req.renda_mensal / req.parcela_alvo;
  //
  //   // Regra hibrida: Serasa score >= 600 AND ratio >= 2.5 → approved
  //   const status: CreditDecision =
  //     serasaScore >= 600 && ratio >= 2.5 ? 'approved' :
  //     serasaScore >= 400 && ratio >= 2.0 ? 'pending' :
  //     'denied';
  //
  //   return { status, source: 'serasa', ratio, /* ... */ };
  // }

  async simulate(req: CreditCheckRequest): Promise<CreditCheckResult> {
    // Validacao basica
    if (!this.isValidCpf(req.cpf)) {
      throw new BadRequestException('CPF inválido');
    }
    if (req.renda_mensal <= 0) {
      throw new BadRequestException('Renda mensal deve ser maior que zero');
    }
    if (req.parcela_alvo <= 0 || req.parcelas <= 0) {
      throw new BadRequestException('Dados da proposta inválidos');
    }

    // Onda 12.1 — lookup historico Asaas (silencioso se nao for cliente)
    const asaasHist = await this.lookupAsaasHistory(req.cpf, req.tenantId);

    // Latencia artificial pra UX (Serasa real demora ~2s mesmo)
    await new Promise((r) => setTimeout(r, asaasHist.isCustomer ? 800 : 1500));

    // Regra base: renda / parcela
    const baseRatio = req.renda_mensal / req.parcela_alvo;
    let adjustedRatio = baseRatio;
    let source: CreditCheckResult['source'] = 'internal';

    // Onda 12.1 — Ajuste baseado em historico Asaas
    if (asaasHist.isCustomer && asaasHist.onTimeRate !== undefined) {
      source = 'asaas_history';
      if (asaasHist.onTimeRate >= 0.8) {
        adjustedRatio += 0.5;  // boost: bom pagador
        this.logger.debug(`[CREDIT-CHECK] Boost +0.5 (onTimeRate=${asaasHist.onTimeRate})`);
      } else if (asaasHist.onTimeRate < 0.5) {
        adjustedRatio -= 0.5;  // penalty: mau pagador
        this.logger.debug(`[CREDIT-CHECK] Penalty -0.5 (onTimeRate=${asaasHist.onTimeRate})`);
      }
    } else if (asaasHist.isCustomer) {
      source = 'asaas_history';
    }

    const decisionId = `BP${Date.now().toString(36).toUpperCase()}`;
    const checkedAt = new Date().toISOString();
    const asaasSummary = asaasHist.isCustomer
      ? {
          is_recurring: true,
          on_time_rate: asaasHist.onTimeRate,
          charges_count: asaasHist.chargesCount,
        }
      : undefined;

    // Aprovado: ratio ajustado >= 3
    if (adjustedRatio >= 3) {
      return {
        status: 'approved',
        decision_id: decisionId,
        ratio: Number(adjustedRatio.toFixed(2)),
        message: asaasHist.isCustomer && (asaasHist.onTimeRate ?? 0) >= 0.8
          ? 'Aprovado! Cliente com excelente histórico'
          : 'Aprovado! Financiamento Banco PASSOS liberado.',
        conditions: {
          max_parcelas: req.parcelas,
          parcela_aprovada: req.parcela_alvo,
          total_aprovado: req.valor_total,
          juros_mes: 1.5,
          entrada_pct: 20,
        },
        source,
        asaas_summary: asaasSummary,
        checked_at: checkedAt,
      };
    }

    // Pendente: 2 <= ratio < 3
    if (adjustedRatio >= 2) {
      return {
        status: 'pending',
        decision_id: decisionId,
        ratio: Number(adjustedRatio.toFixed(2)),
        message: 'Análise complementar necessária',
        motivo: asaasHist.isCustomer && (asaasHist.onTimeRate ?? 1) < 0.5
          ? 'Histórico de pagamentos com atrasos frequentes — exige comprovação extra'
          : 'Renda na zona de atenção — comprometeria mais de 33% da renda',
        suggestion: 'Solicite comprovante de renda (último contracheque ou IR) e envie pelo WhatsApp pro paciente assinar',
        source,
        asaas_summary: asaasSummary,
        checked_at: checkedAt,
      };
    }

    // Recusado: ratio < 2
    return {
      status: 'denied',
      decision_id: decisionId,
      ratio: Number(adjustedRatio.toFixed(2)),
      message: 'Não aprovado nas condições atuais',
      motivo: asaasHist.isCustomer && (asaasHist.onTimeRate ?? 1) < 0.5
        ? `Histórico de inadimplência (${Math.round((asaasHist.onTimeRate ?? 0) * 100)}% pago em dia) + comprometimento de renda alto`
        : 'Comprometimento de renda muito alto (acima de 50%)',
      suggestion: `Sugira parcelar em mais vezes (ex: ${Math.ceil(req.parcelas * 1.5)}x) ou apresentar avalista`,
      source,
      asaas_summary: asaasSummary,
      checked_at: checkedAt,
    };
  }
}

import { Injectable, BadRequestException } from '@nestjs/common';

/**
 * Onda 12 — Simulacao de consulta de credito pro Financiamento Banco PASSOS.
 *
 * MVP MOCK: regras de aprovacao baseadas em renda × parcela. Sem integracao
 * externa, sem persistencia. Decisao toma ~1-2s (delay artificial pra simular
 * latencia real de birô).
 *
 * Em producao, substituir simulateInternal() por integracao Serasa Crediscore:
 *   https://developers.serasaexperian.com.br
 * (sandbox gratuito; ~R$ 0,50-2,00 por consulta em prod)
 */

export type CreditDecision = 'approved' | 'pending' | 'denied';

export interface CreditCheckRequest {
  cpf: string;
  nome: string;
  data_nascimento: string; // ISO YYYY-MM-DD
  renda_mensal: number;
  telefone: string;
  profissao: string;
  // Contexto da proposta (vem do front)
  parcela_alvo: number;     // valor de cada parcela R$
  parcelas: number;         // qtd de parcelas
  valor_total: number;      // total financiado R$
}

export interface CreditCheckResult {
  status: CreditDecision;
  decision_id: string;
  ratio: number;        // renda / parcela
  message: string;
  motivo?: string;
  suggestion?: string;
  // Condicoes liberadas (quando aprovado)
  conditions?: {
    max_parcelas: number;
    parcela_aprovada: number;
    total_aprovado: number;
    juros_mes: number;
    entrada_pct: number;
  };
  checked_at: string;
}

@Injectable()
export class CreditCheckService {
  /**
   * Valida CPF (dígito verificador) pra evitar lixo no mock.
   * Em prod, a propria API Serasa rejeita CPFs invalidos.
   */
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

    // Simula latencia de bir̂o (1.5s)
    await new Promise((r) => setTimeout(r, 1500));

    // Regras: renda / parcela
    const ratio = req.renda_mensal / req.parcela_alvo;
    const decisionId = `BP${Date.now().toString(36).toUpperCase()}`;
    const checkedAt = new Date().toISOString();

    // Aprovado: renda >= parcela × 3 (comprometimento <= 33%)
    if (ratio >= 3) {
      return {
        status: 'approved',
        decision_id: decisionId,
        ratio: Number(ratio.toFixed(2)),
        message: 'Aprovado! Financiamento Banco PASSOS liberado.',
        conditions: {
          max_parcelas: req.parcelas,
          parcela_aprovada: req.parcela_alvo,
          total_aprovado: req.valor_total,
          juros_mes: 1.5,
          entrada_pct: 20,
        },
        checked_at: checkedAt,
      };
    }

    // Analise complementar: 2 <= ratio < 3 (33% a 50% de comprometimento)
    if (ratio >= 2) {
      return {
        status: 'pending',
        decision_id: decisionId,
        ratio: Number(ratio.toFixed(2)),
        message: 'Análise complementar necessária',
        motivo: 'Renda na zona de atenção — comprometeria mais de 33% da renda',
        suggestion: 'Solicite comprovante de renda (último contracheque ou IR) e envie pelo WhatsApp pro paciente assinar',
        checked_at: checkedAt,
      };
    }

    // Recusado: ratio < 2 (mais de 50% de comprometimento)
    return {
      status: 'denied',
      decision_id: decisionId,
      ratio: Number(ratio.toFixed(2)),
      message: 'Não aprovado nas condições atuais',
      motivo: 'Comprometimento de renda muito alto (acima de 50%)',
      suggestion: `Sugira parcelar em mais vezes (ex: ${Math.ceil(req.parcelas * 1.5)}x) ou apresentar avalista`,
      checked_at: checkedAt,
    };
  }
}

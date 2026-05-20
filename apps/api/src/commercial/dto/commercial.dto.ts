import { IsString, IsOptional, IsInt, IsNumber, IsUUID, IsIn, IsDateString, Min, Max, IsArray, ValidateNested, IsBoolean } from 'class-validator';
import { Type } from 'class-transformer';

// ─── Quote ─────────────────────────────────────────────────────

const QUOTE_STATUS = ['DRAFT', 'SENT', 'ACCEPTED', 'REJECTED', 'EXPIRED'] as const;

// Onda 4.2 (Fase 25) — metodos de pagamento permitidos por item
const PAYMENT_METHODS = ['PIX', 'CASH', 'CARD', 'INSTALLMENTS', 'BOLETO', 'TRANSFER'] as const;

export class CreateQuoteItemDto {
  @IsUUID('4') procedure_id: string;
  @IsOptional() @IsString() tooth_fdi?: string;
  @IsOptional() @IsInt() @Min(1) quantity?: number;
  @IsOptional() @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) unit_price?: number;
  @IsOptional() @IsString() notes?: string;
  // Onda 3.2 (Fase 25) — dentista responsavel pelo procedimento
  @IsOptional() @IsUUID('4') dentist_id?: string;
  // Onda 4.2 (Fase 25) — pagamento por procedimento (NULL = default do quote)
  @IsOptional() @IsString() @IsIn(PAYMENT_METHODS) payment_method?: string;
  @IsOptional() @IsInt() @Min(1) @Max(24) installments_count?: number;
}

export class CreateQuoteDto {
  @IsOptional() @IsDateString() valid_until?: string;

  @IsOptional() @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) @Max(100)
  discount_percent?: number;

  @IsOptional() @IsString() payment_terms?: string;
  @IsOptional() @IsString() notes?: string;
  // Onda 3.9 — Nome customizavel do orcamento
  @IsOptional() @IsString() title?: string;

  @IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => CreateQuoteItemDto)
  items?: CreateQuoteItemDto[];
}

export class UpdateQuoteDto {
  @IsOptional() @IsDateString() valid_until?: string;
  @IsOptional() @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) @Max(100) discount_percent?: number;
  @IsOptional() @IsString() payment_terms?: string;
  @IsOptional() @IsString() notes?: string;
  @IsOptional() @IsString() title?: string;
  /// Onda 6 — prioridade clinica: COMPLETO | ESSENCIAL | URGENTE | null
  @IsOptional() @IsString() priority?: string | null;
  /// Onda 14.21 — Visibilidade na aba Propostas. false esconde da aba
  /// Propostas mas mantem em Avaliacao/Orcamentos/Financeiro. Default true.
  @IsOptional() @IsBoolean() visible_in_proposals?: boolean;
  /// Onda 14.26 — Se parcelados desta venda exigem credit-check. Default
  /// true. Operador seta false pra dispensar consulta em vendas VIP / valor
  /// baixo. Metadata de UI, igual visible_in_proposals.
  @IsOptional() @IsBoolean() requires_credit_check?: boolean;
}

export class RejectQuoteDto {
  @IsOptional() @IsString() rejection_reason?: string;
}

// Onda 10 — contraproposta registrada como linha estruturada em Quote.notes.
// payment_label e final_value sao calculados no front (PIX, 6x, etc) e
// salvos como historico textual pro operador acompanhar a negociacao.
export class SaveCounterProposalDto {
  @IsString() payment_label!: string;
  @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) final_value!: number;
  @IsOptional() @IsString() note?: string;
}

// Onda 12 — Simulacao de consulta de credito (Financiamento Banco PASSOS).
// MVP mock; em producao integrar com Serasa Crediscore API.
export class CreditCheckSimulateDto {
  @IsString() cpf!: string;
  @IsString() nome!: string;
  @IsDateString() data_nascimento!: string;
  @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) renda_mensal!: number;
  @IsString() telefone!: string;
  @IsString() profissao!: string;
  @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) parcela_alvo!: number;
  @IsInt() @Min(1) @Max(36) parcelas!: number;
  @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) valor_total!: number;
}

// Onda 12.2 — Aplica financiamento aprovado pelo credit-check.
// Aceita o quote + cria TreatmentPlan ACTIVE + gera boletos no Asaas.
export class ApplyFinancingDto {
  @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) down_payment_value!: number;
  @IsInt() @Min(1) @Max(36) installment_count!: number;
  @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) installment_value!: number;
  @IsOptional() @IsString() decision_id?: string;
  @IsOptional() @IsString() source?: 'internal' | 'asaas_history' | 'serasa';
}

// Onda 14.5 — Aprova proposta e gera cobranca (PIX/Cartao/Boleto a vista).
// Pra Boleto parcelado com entrada, usar ApplyFinancingDto.
export class ApproveAndBillDto {
  @IsString() @IsIn(['PIX', 'CREDIT_CARD', 'BOLETO']) billing_type!: string;
  @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) value!: number;
  @IsOptional() @IsInt() @Min(1) @Max(24) installment_count?: number;
}

// Onda 13 — Bônus de fechamento (segura proposta + valida).
// 6 tipos suportados; quando type=DESCONTO_EXTRA, applica discount_percent_delta
// no quote (recalcula total_value). Demais tipos sao texto + validade.
const BONUS_TYPES = [
  'CORTESIA',
  'DESCONTO_EXTRA',
  'GARANTIA_ESTENDIDA',
  'PROCEDIMENTO_ADICIONAL',
  'CARENCIA',
  'PERSONALIZADO',
] as const;

export class AddBonusDto {
  @IsString() @IsIn(BONUS_TYPES as unknown as string[]) type!: string;
  @IsString() description!: string;
  @IsDateString() valid_until!: string;
  /** Apenas pro type=DESCONTO_EXTRA — % a somar no discount_percent atual */
  @IsOptional() @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) @Max(100) discount_percent_delta?: number;
}

export class UpdateQuoteItemDto {
  @IsOptional() @IsString() tooth_fdi?: string;
  @IsOptional() @IsInt() @Min(1) quantity?: number;
  @IsOptional() @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) unit_price?: number;
  @IsOptional() @IsString() notes?: string;
  @IsOptional() @IsInt() order_index?: number;
  // Onda 3.2 (Fase 25) — permite reatribuir procedimento a outro dentista
  // (ex: paciente trocou de profissional). Aceita string vazia pra
  // limpar (sem dentista atribuido).
  @IsOptional() @IsString() dentist_id?: string | null;
  // Onda 4.2 (Fase 25) — pagamento por procedimento. String vazia limpa.
  @IsOptional() @IsString() payment_method?: string | null;
  @IsOptional() @IsInt() @Min(1) @Max(24) installments_count?: number | null;
}

// ─── TreatmentPlan ─────────────────────────────────────────────

const PLAN_STATUS = ['PENDING_SIGNATURE', 'ACTIVE', 'PAUSED', 'COMPLETED', 'CANCELLED'] as const;
const ITEM_STATUS = ['PENDING', 'SCHEDULED', 'IN_PROGRESS', 'DONE', 'CANCELLED'] as const;

export class UpdateTreatmentPlanDto {
  @IsOptional() @IsString() @IsIn(PLAN_STATUS) status?: string;
  @IsOptional() @IsDateString() start_date?: string;
  @IsOptional() @IsDateString() end_date?: string;
  @IsOptional() @IsInt() estimated_sessions?: number;
  @IsOptional() @IsString() notes?: string;
}

export class UpdateTreatmentPlanItemDto {
  @IsOptional() @IsString() @IsIn(ITEM_STATUS) status?: string;
  @IsOptional() @IsDateString() scheduled_at?: string;
  @IsOptional() @IsUUID('4') scheduled_appointment_id?: string;
  @IsOptional() @IsString() notes?: string;
  @IsOptional() @IsInt() order_index?: number;
}

export class ExecuteTreatmentPlanItemDto {
  @IsOptional() @IsUUID('4') appointment_id?: string;
  @IsOptional() @IsString() notes?: string;
}

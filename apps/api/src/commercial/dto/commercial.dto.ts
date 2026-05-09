import { IsString, IsOptional, IsInt, IsNumber, IsUUID, IsIn, IsDateString, Min, Max, IsArray, ValidateNested } from 'class-validator';
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
}

export class RejectQuoteDto {
  @IsOptional() @IsString() rejection_reason?: string;
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

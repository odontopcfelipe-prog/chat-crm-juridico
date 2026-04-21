import { IsString, IsOptional, IsInt, IsNumber, IsUUID, IsIn, IsDateString, Min, Max, IsArray, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';

// ─── Quote ─────────────────────────────────────────────────────

const QUOTE_STATUS = ['DRAFT', 'SENT', 'ACCEPTED', 'REJECTED', 'EXPIRED'] as const;

export class CreateQuoteItemDto {
  @IsUUID('4') procedure_id: string;
  @IsOptional() @IsString() tooth_fdi?: string;
  @IsOptional() @IsInt() @Min(1) quantity?: number;
  @IsOptional() @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) unit_price?: number;
  @IsOptional() @IsString() notes?: string;
}

export class CreateQuoteDto {
  @IsOptional() @IsDateString() valid_until?: string;

  @IsOptional() @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) @Max(100)
  discount_percent?: number;

  @IsOptional() @IsString() payment_terms?: string;
  @IsOptional() @IsString() notes?: string;

  @IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => CreateQuoteItemDto)
  items?: CreateQuoteItemDto[];
}

export class UpdateQuoteDto {
  @IsOptional() @IsDateString() valid_until?: string;
  @IsOptional() @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) @Max(100) discount_percent?: number;
  @IsOptional() @IsString() payment_terms?: string;
  @IsOptional() @IsString() notes?: string;
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

import {
  IsString, IsOptional, IsUUID, IsInt, IsNumber, IsIn, IsDateString, Min,
} from 'class-validator';
import { Type } from 'class-transformer';

const VALID_PAYMENT_METHODS = ['PIX', 'BOLETO', 'CARTAO', 'DINHEIRO', 'TRANSFERENCIA', 'MAQUININHA'] as const;

export class CreateInstallmentDto {
  @IsUUID('4') patient_id: string;
  @IsOptional() @IsUUID('4') quote_id?: string;

  @IsOptional() @Type(() => Number) @IsInt() @Min(1) sequence?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) total_count?: number;

  @Type(() => Number) @IsNumber({ maxDecimalPlaces: 2 }) @Min(0.01) amount: number;

  @IsDateString({}, { message: 'due_date ISO' })
  due_date: string;

  @IsOptional() @IsString() @IsIn(VALID_PAYMENT_METHODS) payment_method?: string;
  @IsOptional() @IsString() notes?: string;
}

export class GenerateFromQuoteDto {
  @Type(() => Number) @IsInt() @Min(1) total_count: number;

  @IsDateString({}, { message: 'first_due_date ISO' })
  first_due_date: string;

  // Espacamento entre parcelas em dias (default 30)
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) interval_days?: number;

  // Valor de entrada (se houver) — abate do total antes de dividir o restante
  @IsOptional() @Type(() => Number) @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) entry_value?: number;
}

export class PayInstallmentDto {
  @Type(() => Number) @IsNumber({ maxDecimalPlaces: 2 }) @Min(0.01) amount_paid: number;

  @IsString() @IsIn(VALID_PAYMENT_METHODS) payment_method: string;

  @IsOptional() @IsDateString() paid_at?: string;
  @IsOptional() @IsString() notes?: string;
}

export class UpdateInstallmentDto {
  @IsOptional() @Type(() => Number) @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) amount?: number;
  @IsOptional() @IsDateString() due_date?: string;
  @IsOptional() @Type(() => Number) @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) discount_value?: number;
  @IsOptional() @Type(() => Number) @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) fee_value?: number;
  @IsOptional() @IsString() notes?: string;
}

export class RenegotiateDto {
  @Type(() => Number) @IsInt() @Min(1) new_total_count: number;

  @IsDateString() new_first_due_date: string;

  @IsOptional() @Type(() => Number) @IsInt() @Min(1) interval_days?: number;
  @IsOptional() @Type(() => Number) @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) entry_value?: number;
  @IsOptional() @IsString() reason?: string;
}

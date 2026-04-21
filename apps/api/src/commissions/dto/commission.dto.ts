import {
  IsString, IsOptional, IsUUID, IsNumber, IsIn, IsDateString, Min,
} from 'class-validator';
import { Type } from 'class-transformer';

export class CreateCommissionDto {
  @IsUUID('4') professional_user_id: string;
  @IsUUID('4') patient_id: string;

  @IsOptional() @IsUUID('4') procedure_id?: string;
  @IsOptional() @IsUUID('4') treatment_plan_item_id?: string;
  @IsOptional() @IsUUID('4') quote_id?: string;

  @Type(() => Number) @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) base_value: number;

  @IsOptional() @Type(() => Number) @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) percentage?: number;
  @IsOptional() @Type(() => Number) @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) fixed_value?: number;

  // Se omitido, o servico calcula a partir de base_value + percentage/fixed_value
  @IsOptional() @Type(() => Number) @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) amount?: number;

  @IsOptional() @IsString() reference_month?: string; // "2026-04"
  @IsOptional() @IsString() notes?: string;
}

export class PayCommissionDto {
  @IsOptional() @IsString() payment_method?: string;
  @IsOptional() @IsDateString() paid_at?: string;
  @IsOptional() @IsString() notes?: string;
}

export class UpdateCommissionDto {
  @IsOptional()
  @IsString()
  @IsIn(['DEVIDA', 'DISPONIVEL', 'PAGA', 'CANCELADA'])
  status?: string;

  @IsOptional() @IsString() notes?: string;
}

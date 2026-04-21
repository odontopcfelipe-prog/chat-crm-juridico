import {
  IsString, IsOptional, IsUUID, IsBoolean, IsNumber, IsIn, IsDateString, Min,
} from 'class-validator';
import { Type } from 'class-transformer';

const VALID_TRIGGER = ['ON_EXECUTION', 'ON_PAYMENT'] as const;

export class CreateCommissionRuleDto {
  @IsUUID('4', { message: 'professional_user_id deve ser UUID' })
  professional_user_id: string;

  @IsOptional() @IsUUID('4') procedure_id?: string;
  @IsOptional() @IsString() procedure_category?: string;

  @IsOptional() @Type(() => Number) @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) percentage?: number;
  @IsOptional() @Type(() => Number) @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) fixed_value?: number;

  @IsOptional()
  @IsString()
  @IsIn(VALID_TRIGGER, { message: `trigger deve ser ${VALID_TRIGGER.join(' | ')}` })
  trigger?: string;

  @IsOptional() @IsBoolean() active?: boolean;
  @IsOptional() @IsDateString() starts_at?: string;
  @IsOptional() @IsDateString() ends_at?: string;
  @IsOptional() @IsString() notes?: string;
}

export class UpdateCommissionRuleDto {
  @IsOptional() @IsUUID('4') procedure_id?: string;
  @IsOptional() @IsString() procedure_category?: string;
  @IsOptional() @Type(() => Number) @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) percentage?: number;
  @IsOptional() @Type(() => Number) @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) fixed_value?: number;
  @IsOptional() @IsString() @IsIn(VALID_TRIGGER) trigger?: string;
  @IsOptional() @IsBoolean() active?: boolean;
  @IsOptional() @IsDateString() starts_at?: string;
  @IsOptional() @IsDateString() ends_at?: string;
  @IsOptional() @IsString() notes?: string;
}

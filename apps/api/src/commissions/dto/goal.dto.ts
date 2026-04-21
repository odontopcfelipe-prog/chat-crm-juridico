import {
  IsString, IsOptional, IsUUID, IsBoolean, IsNumber, IsIn, IsDateString, Min,
} from 'class-validator';
import { Type } from 'class-transformer';

const VALID_METRIC = [
  'SALES_VALUE', 'FIRST_CONSULTATIONS', 'MISSES_PCT',
  'OCCUPATION_PCT', 'NEW_PATIENTS', 'CONVERSIONS', 'CUSTOM',
] as const;

const VALID_SCOPE = ['CLINIC', 'PROFESSIONAL'] as const;
const VALID_DIRECTION = ['ACHIEVE', 'LIMIT'] as const;
const VALID_PERIOD = ['DAILY', 'WEEKLY', 'MONTHLY', 'QUARTERLY', 'YEARLY', 'CUSTOM'] as const;

export class CreateGoalDto {
  @IsString()
  @IsIn(VALID_METRIC, { message: `metric deve ser ${VALID_METRIC.join(' | ')}` })
  metric: string;

  @IsOptional() @IsString() @IsIn(VALID_SCOPE) scope?: string;
  @IsOptional() @IsUUID('4') professional_user_id?: string;
  @IsOptional() @IsString() @IsIn(VALID_DIRECTION) direction?: string;

  @Type(() => Number) @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) target_value: number;

  @IsOptional() @IsString() @IsIn(VALID_PERIOD) period_type?: string;

  @IsDateString({}, { message: 'period_start ISO' })
  period_start: string;

  @IsDateString({}, { message: 'period_end ISO' })
  period_end: string;

  @IsOptional() @IsBoolean() active?: boolean;
  @IsOptional() @IsString() notes?: string;
}

export class UpdateGoalDto {
  @IsOptional() @IsString() @IsIn(VALID_METRIC) metric?: string;
  @IsOptional() @IsString() @IsIn(VALID_SCOPE) scope?: string;
  @IsOptional() @IsUUID('4') professional_user_id?: string;
  @IsOptional() @IsString() @IsIn(VALID_DIRECTION) direction?: string;
  @IsOptional() @Type(() => Number) @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) target_value?: number;
  @IsOptional() @IsString() @IsIn(VALID_PERIOD) period_type?: string;
  @IsOptional() @IsDateString() period_start?: string;
  @IsOptional() @IsDateString() period_end?: string;
  @IsOptional() @IsBoolean() active?: boolean;
  @IsOptional() @IsString() notes?: string;
}

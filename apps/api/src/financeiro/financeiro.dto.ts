import {
  IsString,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsBoolean,
  IsIn,
} from 'class-validator';

// ─── Transaction DTOs ─────────────────────────────────────

export class CreateTransactionDto {
  @IsString()
  @IsNotEmpty()
  @IsIn(['RECEITA', 'DESPESA'])
  type: string;

  @IsString()
  @IsNotEmpty()
  category: string;

  @IsString()
  @IsNotEmpty()
  description: string;

  @IsNumber()
  amount: number;

  @IsOptional()
  @IsString()
  date?: string;

  @IsOptional()
  @IsString()
  due_date?: string;

  @IsOptional()
  @IsString()
  paid_at?: string;

  @IsOptional()
  @IsString()
  payment_method?: string;

  @IsOptional()
  @IsString()
  @IsIn(['PENDENTE', 'PAGO', 'CANCELADO'])
  status?: string;

  @IsOptional()
  @IsString()
  legal_case_id?: string;

  @IsOptional()
  @IsString()
  lead_id?: string;

  @IsOptional()
  @IsString()
  lawyer_id?: string;

  @IsOptional()
  @IsString()
  honorario_payment_id?: string;

  @IsOptional()
  @IsString()
  reference_id?: string;

  @IsOptional()
  @IsString()
  notes?: string;

  @IsOptional()
  @IsBoolean()
  visible_to_lawyer?: boolean;

  @IsOptional()
  @IsBoolean()
  is_recurring?: boolean;

  @IsOptional()
  @IsString()
  recurrence_pattern?: string; // MENSAL, TRIMESTRAL, SEMESTRAL, ANUAL

  @IsOptional()
  @IsNumber()
  recurrence_day?: number; // Dia do mês (1-31)

  @IsOptional()
  @IsString()
  recurrence_end_date?: string;
}

export class UpdateTransactionDto {
  @IsOptional()
  @IsString()
  @IsIn(['RECEITA', 'DESPESA'])
  type?: string;

  @IsOptional()
  @IsString()
  category?: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsNumber()
  amount?: number;

  @IsOptional()
  @IsString()
  date?: string;

  @IsOptional()
  @IsString()
  due_date?: string;

  @IsOptional()
  @IsString()
  paid_at?: string;

  @IsOptional()
  @IsString()
  payment_method?: string;

  @IsOptional()
  @IsString()
  @IsIn(['PENDENTE', 'PAGO', 'CANCELADO'])
  status?: string;

  @IsOptional()
  @IsString()
  legal_case_id?: string;

  @IsOptional()
  @IsString()
  lead_id?: string;

  @IsOptional()
  @IsString()
  lawyer_id?: string;

  @IsOptional()
  @IsString()
  honorario_payment_id?: string;

  @IsOptional()
  @IsString()
  reference_id?: string;

  @IsOptional()
  @IsString()
  notes?: string;
}

// ─── Category DTOs ────────────────────────────────────────

export class CreateCategoryDto {
  @IsString()
  @IsNotEmpty()
  @IsIn(['RECEITA', 'DESPESA'])
  type: string;

  @IsString()
  @IsNotEmpty()
  name: string;

  @IsOptional()
  @IsString()
  icon?: string;
}

export class UpdateCategoryDto {
  @IsOptional()
  @IsString()
  name?: string;

  @IsOptional()
  @IsString()
  icon?: string;

  @IsOptional()
  @IsBoolean()
  active?: boolean;
}

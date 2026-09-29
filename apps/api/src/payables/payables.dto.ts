import {
  IsString,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsInt,
  IsBoolean,
  IsIn,
  Min,
  Max,
} from 'class-validator';

/**
 * Criar uma DESPESA de Contas a Pagar (gasto do dia OU conta recorrente).
 * DTO PRÓPRIO (sem type/dentist_id/lead_id/reference_id) — o módulo só cria
 * DESPESA e NUNCA referencia dentista/lead/cobrança de outro tenant (fecha
 * o vazamento de PII cross-tenant por id forjado).
 */
export class CreatePayableDto {
  @IsString()
  @IsNotEmpty()
  category: string;

  @IsString()
  @IsNotEmpty()
  description: string;

  @IsNumber()
  @Min(0.01)
  amount: number;

  @IsOptional() @IsString() date?: string;
  @IsOptional() @IsString() due_date?: string;
  @IsOptional() @IsString() paid_at?: string;
  @IsOptional() @IsString() payment_method?: string;

  @IsOptional() @IsString() @IsIn(['PENDENTE', 'PAGO', 'CANCELADO'])
  status?: string;

  @IsOptional() @IsString() notes?: string;

  // Conciliação de caixa: se vier account_id + status PAGO, o gasto entra no
  // fechamento de caixa do dia (debita a conta escolhida). Sem account_id = só
  // despesa gerencial (não passa pela gaveta).
  @IsOptional() @IsString() account_id?: string;

  // Recorrência (conta fixa mensal variável — água/luz/internet)
  @IsOptional() @IsBoolean() is_recurring?: boolean;
  @IsOptional() @IsString() recurrence_pattern?: string;
  @IsOptional() @IsInt() @Min(1) @Max(31) recurrence_day?: number;
  @IsOptional() @IsString() recurrence_end_date?: string;
}

/** Pagar uma conta a pagar debitando o caixa do dia (conta + forma). */
export class PayViaCaixaDto {
  @IsString() @IsNotEmpty() account_id: string;

  @IsString() @IsIn(['DINHEIRO', 'CARTAO', 'PIX', 'TRANSFERENCIA'])
  payment_method: string;
}

/** Editar/pagar uma conta a pagar. Sem `type` (não pode virar RECEITA). */
export class UpdatePayableDto {
  @IsOptional() @IsString() category?: string;
  @IsOptional() @IsString() description?: string;
  @IsOptional() @IsNumber() amount?: number;
  @IsOptional() @IsString() date?: string;
  @IsOptional() @IsString() due_date?: string;
  @IsOptional() @IsString() paid_at?: string;
  @IsOptional() @IsString() payment_method?: string;
  @IsOptional() @IsString() @IsIn(['PENDENTE', 'PAGO', 'CANCELADO']) status?: string;
  @IsOptional() @IsString() notes?: string;
}

/**
 * Contas a Pagar — cadastro de compra PARCELADA de valor EXATO (ex.: R$10.000 em 10x).
 * Gera N FinancialTransaction (DESPESA/PENDENTE), uma por parcela, com vencimentos
 * mensais a partir de `first_due_date` e valores exatos persistidos (a sobra de
 * centavos vai na ÚLTIMA parcela — nunca recalcula na leitura).
 */
export class CreateInstallmentPlanDto {
  @IsString()
  @IsNotEmpty()
  description: string;

  @IsString()
  @IsNotEmpty()
  category: string;

  @IsNumber()
  @Min(0.01)
  total_amount: number;

  @IsInt()
  @Min(1)
  @Max(60)
  installments: number;

  /** Vencimento da 1ª parcela (YYYY-MM-DD). As demais somam 1 mês. */
  @IsString()
  @IsNotEmpty()
  first_due_date: string;

  @IsOptional()
  @IsString()
  payment_method?: string;

  @IsOptional()
  @IsString()
  notes?: string;
}

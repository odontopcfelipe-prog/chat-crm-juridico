import {
  IsString,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsBoolean,
  IsIn,
} from 'class-validator';

// ─── Contas ───────────────────────────────────────────────
export class CreateAccountDto {
  @IsString() @IsNotEmpty()
  name: string;

  @IsString() @IsIn(['CAIXA', 'BANCO', 'CARTAO'])
  kind: string;

  @IsOptional() @IsBoolean()
  is_gateway?: boolean;

  @IsOptional() @IsNumber()
  sort_order?: number;
}

export class UpdateAccountDto {
  @IsOptional() @IsString() @IsNotEmpty()
  name?: string;

  @IsOptional() @IsString() @IsIn(['CAIXA', 'BANCO', 'CARTAO'])
  kind?: string;

  @IsOptional() @IsBoolean()
  active?: boolean;

  @IsOptional() @IsBoolean()
  is_gateway?: boolean;

  @IsOptional() @IsNumber()
  sort_order?: number;
}

// ─── Movimentos (entrada/saída) ───────────────────────────
export class AddMovementDto {
  @IsString() @IsIn(['ENTRADA', 'SAIDA'])
  direction: string; // ENTRADA = RECEITA, SAIDA = DESPESA (sangria/troco)

  @IsNumber()
  amount: number;

  @IsString() @IsIn(['DINHEIRO', 'CARTAO', 'PIX', 'TRANSFERENCIA'])
  method: string;

  @IsString() @IsNotEmpty()
  account_id: string;

  @IsOptional() @IsString()
  description?: string;

  @IsOptional() @IsString()
  category?: string;

  @IsOptional() @IsString()
  lead_id?: string;
}

// ─── Fechamento / validação ───────────────────────────────
export class CloseDayDto {
  @IsOptional() @IsNumber() counted_cash?: number;
  @IsOptional() @IsNumber() counted_card?: number;
  @IsOptional() @IsNumber() counted_pix?: number;
  @IsOptional() @IsNumber() counted_transfer?: number;

  @IsOptional() @IsString() closing_notes?: string;
}

export class ValidateDayDto {
  @IsOptional() @IsString() validation_notes?: string;
}

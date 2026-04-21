import {
  IsString,
  IsOptional,
  IsNumber,
  IsUUID,
  IsIn,
  IsDateString,
  Min,
} from 'class-validator';
import { Type } from 'class-transformer';

const VALID_TYPE = ['ENTRADA', 'SAIDA', 'AJUSTE', 'DESCARTE_VENCIMENTO', 'PERDA'] as const;

export class CreateStockMovementDto {
  @IsUUID('4', { message: 'product_id deve ser UUID' })
  product_id: string;

  @IsOptional()
  @IsUUID('4', { message: 'supplier_id deve ser UUID' })
  supplier_id?: string;

  @IsString()
  @IsIn(VALID_TYPE, { message: `type deve ser um de: ${VALID_TYPE.join(', ')}` })
  type: string;

  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 3 }, { message: 'quantity deve ser numero (3 casas decimais)' })
  @Min(0.001, { message: 'quantity deve ser positivo' })
  quantity: number;

  @IsOptional() @Type(() => Number) @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) unit_cost?: number;
  @IsOptional() @Type(() => Number) @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) total_cost?: number;

  @IsOptional() @IsString() batch_number?: string;
  @IsOptional() @IsDateString() expiration_date?: string;

  @IsOptional() @IsUUID('4') appointment_id?: string;
  @IsOptional() @IsString() notes?: string;
}

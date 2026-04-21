import {
  IsString,
  IsOptional,
  IsBoolean,
  IsNumber,
  IsUUID,
  IsIn,
  Min,
} from 'class-validator';
import { Type } from 'class-transformer';

const VALID_UNIT = ['UN', 'ML', 'MG', 'UI', 'CAIXA', 'KIT', 'G', 'L'] as const;

const VALID_CATEGORY = [
  // Odonto
  'ANESTESICO', 'RESINA', 'BRACKETS', 'EQUIPAMENTO', 'DESCARTAVEL',
  // Estetica facial
  'TOXINA_BOTULINICA', 'ACIDO_HIALURONICO', 'BIOESTIMULADOR',
  'FIO_PDO', 'FIO_PLLA', 'ENZIMA', 'PEELING_QUIMICO',
  'SKINBOOSTER', 'ANESTESICO_TOPICO', 'COSMETICO', 'OUTRO',
] as const;

export class CreateProductDto {
  @IsOptional()
  @IsUUID('4', { message: 'supplier_id deve ser UUID' })
  supplier_id?: string;

  @IsString({ message: 'Nome e obrigatorio' })
  name: string;

  @IsOptional() @IsString() brand?: string;
  @IsOptional() @IsString() sku?: string;
  @IsOptional() @IsString() barcode?: string;

  @IsOptional()
  @IsString()
  @IsIn(VALID_CATEGORY, { message: `category invalida. Use: ${VALID_CATEGORY.join(', ')}` })
  category?: string;

  @IsOptional()
  @IsString()
  @IsIn(VALID_UNIT, { message: `unit deve ser um de: ${VALID_UNIT.join(', ')}` })
  unit?: string;

  @IsOptional() @IsString() description?: string;

  // Regulatorio (ANVISA)
  @IsOptional() @IsString() anvisa_registration?: string;
  @IsOptional() @IsBoolean() is_injectable?: boolean;
  @IsOptional() @IsBoolean() is_controlled?: boolean;
  @IsOptional() @IsBoolean() requires_lot_tracking?: boolean;

  // Estoque
  @IsOptional() @Type(() => Number) @IsNumber() @Min(0) current_stock?: number;
  @IsOptional() @Type(() => Number) @IsNumber() @Min(0) min_stock?: number;
  @IsOptional() @Type(() => Number) @IsNumber() @Min(0) max_stock?: number;

  // Preco
  @IsOptional() @Type(() => Number) @IsNumber() @Min(0) cost_price?: number;
  @IsOptional() @Type(() => Number) @IsNumber() @Min(0) sale_price?: number;

  @IsOptional() @IsBoolean() has_expiration?: boolean;
  @IsOptional() @IsBoolean() active?: boolean;
}

export class UpdateProductDto {
  @IsOptional() @IsUUID('4') supplier_id?: string;
  @IsOptional() @IsString() name?: string;
  @IsOptional() @IsString() brand?: string;
  @IsOptional() @IsString() sku?: string;
  @IsOptional() @IsString() barcode?: string;
  @IsOptional() @IsString() @IsIn(VALID_CATEGORY) category?: string;
  @IsOptional() @IsString() @IsIn(VALID_UNIT) unit?: string;
  @IsOptional() @IsString() description?: string;
  @IsOptional() @IsString() anvisa_registration?: string;
  @IsOptional() @IsBoolean() is_injectable?: boolean;
  @IsOptional() @IsBoolean() is_controlled?: boolean;
  @IsOptional() @IsBoolean() requires_lot_tracking?: boolean;
  @IsOptional() @Type(() => Number) @IsNumber() @Min(0) min_stock?: number;
  @IsOptional() @Type(() => Number) @IsNumber() @Min(0) max_stock?: number;
  @IsOptional() @Type(() => Number) @IsNumber() @Min(0) cost_price?: number;
  @IsOptional() @Type(() => Number) @IsNumber() @Min(0) sale_price?: number;
  @IsOptional() @IsBoolean() has_expiration?: boolean;
  @IsOptional() @IsBoolean() active?: boolean;
}

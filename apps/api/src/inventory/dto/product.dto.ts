import {
  IsString,
  IsOptional,
  IsBoolean,
  IsNumber,
  IsUUID,
  IsIn,
  IsDateString,
  Min,
  MaxLength,
} from 'class-validator';
import { Type } from 'class-transformer';
import { NOME_CATEGORIA_MAX } from '../product-categories';

const VALID_UNIT = ['UN', 'ML', 'MG', 'UI', 'CAIXA', 'KIT', 'G', 'L'] as const;

/** Nome de uma categoria da conta (Estoque → Categorias). */
export class ProductCategoryDto {
  @IsString({ message: 'Nome da categoria e obrigatorio' })
  @MaxLength(NOME_CATEGORIA_MAX, { message: `Nome da categoria com no maximo ${NOME_CATEGORIA_MAX} caracteres` })
  name: string;
}

export class CreateProductDto {
  @IsOptional()
  @IsUUID('4', { message: 'supplier_id deve ser UUID' })
  supplier_id?: string;

  @IsString({ message: 'Nome e obrigatorio' })
  name: string;

  @IsOptional() @IsString() brand?: string;
  @IsOptional() @IsString() sku?: string;
  @IsOptional() @IsString() barcode?: string;

  // Nome da categoria da conta (antes: lista fixa de códigos)
  @IsOptional()
  @IsString()
  @MaxLength(NOME_CATEGORIA_MAX)
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

  // Estoque — a quantidade inicial entra como ENTRADA "Estoque inicial" em Movimentações
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 3 }, { message: 'Quantidade em estoque com no maximo 3 casas decimais' })
  @Min(0, { message: 'Quantidade em estoque nao pode ser negativa' })
  current_stock?: number;
  // Lote/validade dessa entrada inicial (mesmas regras de uma entrada comum)
  @IsOptional() @IsString() initial_batch_number?: string;
  @IsOptional() @IsDateString() initial_expiration_date?: string;
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
  @IsOptional() @IsString() @MaxLength(NOME_CATEGORIA_MAX) category?: string;
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

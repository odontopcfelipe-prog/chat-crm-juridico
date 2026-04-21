import { IsUUID, IsNumber, IsOptional, IsString, Min } from 'class-validator';
import { Type } from 'class-transformer';

export class CreateProcedureConsumableDto {
  @IsUUID('4', { message: 'product_id deve ser UUID' })
  product_id: string;

  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 3 })
  @Min(0.001, { message: 'quantity deve ser positivo' })
  quantity: number;

  @IsOptional() @IsString() notes?: string;
}

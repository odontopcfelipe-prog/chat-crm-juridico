import { IsString, IsOptional, IsBoolean, IsInt, IsUUID, IsNumber, Min } from 'class-validator';

export class CreateProcedureDto {
  @IsString({ message: 'Nome e obrigatorio' })
  name: string;

  @IsOptional() @IsUUID('4') specialty_id?: string;
  @IsOptional() @IsString() code_tuss?: string;
  @IsOptional() @IsString() internal_code?: string;
  @IsOptional() @IsString() description?: string;

  @IsOptional() @IsInt() @Min(5) duration_minutes?: number;

  @IsOptional() @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) base_price?: number;

  @IsOptional() @IsBoolean() requires_x_ray?: boolean;
  @IsOptional() @IsBoolean() requires_anesthesia?: boolean;
}

export class UpdateProcedureDto {
  @IsOptional() @IsString() name?: string;
  @IsOptional() @IsUUID('4') specialty_id?: string;
  @IsOptional() @IsString() code_tuss?: string;
  @IsOptional() @IsString() internal_code?: string;
  @IsOptional() @IsString() description?: string;
  @IsOptional() @IsInt() @Min(5) duration_minutes?: number;
  @IsOptional() @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) base_price?: number;
  @IsOptional() @IsBoolean() requires_x_ray?: boolean;
  @IsOptional() @IsBoolean() requires_anesthesia?: boolean;
  @IsOptional() @IsBoolean() active?: boolean;
}

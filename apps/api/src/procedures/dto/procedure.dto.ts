import { IsString, IsOptional, IsBoolean, IsInt, IsUUID, IsNumber, Min, ValidateIf } from 'class-validator';

// IsOptional() ignora null E undefined em class-validator, mas o decorator
// @IsUUID nao casa com string vazia. Helper pra aceitar null/empty/UUID valido.
const OPTIONAL_UUID = ValidateIf((_o: any, v: any) => v !== null && v !== undefined && v !== '');

export class CreateProcedureDto {
  @IsString({ message: 'Nome e obrigatorio' })
  name: string;

  @IsOptional() @OPTIONAL_UUID @IsUUID('4') specialty_id?: string | null;
  @IsOptional() @IsString() code_tuss?: string | null;
  @IsOptional() @IsString() internal_code?: string | null;
  @IsOptional() @IsString() description?: string | null;

  @IsOptional() @IsInt() @Min(5) duration_minutes?: number;

  @IsOptional() @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) base_price?: number;

  @IsOptional() @IsBoolean() requires_x_ray?: boolean;
  @IsOptional() @IsBoolean() requires_anesthesia?: boolean;
  @IsOptional() @IsBoolean() commissionable?: boolean;

  // Fase 6 — Estetica facial / agendamento de revisita
  @IsOptional() @IsString() category?: string | null;
  @IsOptional() @IsBoolean() is_facial_application?: boolean;
  @IsOptional() @IsInt() @Min(1) default_revisit_months?: number | null;
  @IsOptional() @IsString() post_procedure_instructions?: string | null;
}

export class UpdateProcedureDto {
  @IsOptional() @IsString() name?: string;
  @IsOptional() @OPTIONAL_UUID @IsUUID('4') specialty_id?: string | null;
  @IsOptional() @IsString() code_tuss?: string | null;
  @IsOptional() @IsString() internal_code?: string | null;
  @IsOptional() @IsString() description?: string | null;
  @IsOptional() @IsInt() @Min(5) duration_minutes?: number;
  @IsOptional() @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) base_price?: number;
  @IsOptional() @IsBoolean() requires_x_ray?: boolean;
  @IsOptional() @IsBoolean() requires_anesthesia?: boolean;
  @IsOptional() @IsBoolean() commissionable?: boolean;
  @IsOptional() @IsBoolean() active?: boolean;

  // Fase 6 — Estetica facial / agendamento de revisita
  @IsOptional() @IsString() category?: string | null;
  @IsOptional() @IsBoolean() is_facial_application?: boolean;
  @IsOptional() @IsInt() @Min(1) default_revisit_months?: number | null;
  @IsOptional() @IsString() post_procedure_instructions?: string | null;
}

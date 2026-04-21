import {
  IsString,
  IsOptional,
  IsUUID,
  IsIn,
  IsNumber,
  IsDateString,
  IsInt,
  Min,
  Max,
} from 'class-validator';
import { Type } from 'class-transformer';

export const VALID_FACIAL_POINTS = [
  'FRONTAL', 'GLABELA',
  'PE_DE_GALINHA_DIR', 'PE_DE_GALINHA_ESQ',
  'SUPRACILIAR_DIR', 'SUPRACILIAR_ESQ',
  'NASAL_DORSO', 'PONTA_NASAL', 'BUNNY_LINES',
  'MENTO',
  'MASSETER_DIR', 'MASSETER_ESQ',
  'NASOLABIAL_DIR', 'NASOLABIAL_ESQ',
  'MARIONETE_DIR', 'MARIONETE_ESQ',
  'LABIO_SUPERIOR', 'LABIO_INFERIOR',
  'COMISSURA_DIR', 'COMISSURA_ESQ',
  'MALAR_DIR', 'MALAR_ESQ',
  'MANDIBULA_DIR', 'MANDIBULA_ESQ',
  'TEMPORAL_DIR', 'TEMPORAL_ESQ',
  'PESCOCO', 'PLATISMA', 'COLO',
  'OUTRO',
] as const;

const VALID_SIDE = ['DIREITA', 'ESQUERDA', 'BILATERAL', 'CENTRAL'] as const;
const VALID_UNIT = ['ML', 'UI', 'MG'] as const;
const VALID_TECHNIQUE = [
  'BOLUS', 'RETROINJECAO', 'FANNING', 'CROSSHATCH', 'MAP', 'ROLAMENTO', 'OUTRO',
] as const;
const VALID_DEPTH = [
  'SUPERFICIAL', 'MEDIO', 'PROFUNDO', 'SUPRAPERIOSTAL', 'SUBDERMICO',
] as const;

export class CreateEstheticApplicationDto {
  // Vinculos opcionais
  @IsOptional() @IsUUID('4') procedure_id?: string;
  @IsOptional() @IsUUID('4') clinical_note_id?: string;
  @IsOptional() @IsUUID('4') appointment_id?: string;
  @IsOptional() @IsUUID('4') treatment_plan_item_id?: string;

  // Anatomia
  @IsString()
  @IsIn(VALID_FACIAL_POINTS, { message: `application_point invalido` })
  application_point: string;

  @IsOptional()
  @IsString()
  @IsIn(VALID_SIDE)
  side?: string;

  // Produto / lote
  @IsOptional() @IsUUID('4') product_id?: string;
  @IsOptional() @IsString() batch_number?: string;
  @IsOptional() @IsDateString() expiration_date?: string;

  @IsOptional() @Type(() => Number) @IsNumber({ maxDecimalPlaces: 3 }) @Min(0) volume?: number;
  @IsOptional() @IsString() @IsIn(VALID_UNIT) unit?: string;
  @IsOptional() @IsString() dilution?: string;
  @IsOptional() @IsString() needle_gauge?: string;

  // Tecnica
  @IsOptional() @IsString() @IsIn(VALID_TECHNIQUE) technique?: string;
  @IsOptional() @IsString() @IsIn(VALID_DEPTH) depth?: string;

  @IsOptional() @IsString() notes?: string;

  // Validade do efeito (opcional — se omitido, usa procedure.default_revisit_months)
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(60) expected_duration_months?: number;

  // Quem aplicou (opcional — se omitido, usa req.user.id)
  @IsOptional() @IsUUID('4') applied_by_user_id?: string;

  @IsOptional() @IsDateString() applied_at?: string;
}

export class UpdateEstheticApplicationDto {
  @IsOptional() @IsString() notes?: string;
  @IsOptional() @IsDateString() expected_revisit_at?: string;
}

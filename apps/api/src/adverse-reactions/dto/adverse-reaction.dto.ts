import {
  IsString,
  IsOptional,
  IsUUID,
  IsIn,
  IsBoolean,
  IsDateString,
} from 'class-validator';

const VALID_SEVERITY = ['LEVE', 'MODERADA', 'GRAVE', 'AMEACA_VIDA'] as const;

const VALID_REACTION_TYPE = [
  'EDEMA', 'EQUIMOSE', 'NODULO', 'INFECCAO', 'NECROSE',
  'ALERGIA', 'ASSIMETRIA', 'MIGRACAO', 'EMBOLIA',
  'GRANULOMA', 'HIPERPIGMENTACAO', 'CICATRIZ', 'OUTRO',
] as const;

export class CreateAdverseReactionDto {
  @IsOptional() @IsUUID('4') esthetic_application_id?: string;
  @IsOptional() @IsUUID('4') procedure_id?: string;

  @IsString()
  @IsIn(VALID_SEVERITY, { message: `severity deve ser um de: ${VALID_SEVERITY.join(', ')}` })
  severity: string;

  @IsString()
  @IsIn(VALID_REACTION_TYPE, { message: `reaction_type invalido` })
  reaction_type: string;

  @IsString({ message: 'description e obrigatoria' })
  description: string;

  @IsDateString({}, { message: 'onset_at deve ser data ISO' })
  onset_at: string;

  @IsOptional() @IsString() treatment_given?: string;
  @IsOptional() @IsBoolean() hospitalized?: boolean;
}

export class UpdateAdverseReactionDto {
  @IsOptional() @IsString() @IsIn(VALID_SEVERITY) severity?: string;
  @IsOptional() @IsString() @IsIn(VALID_REACTION_TYPE) reaction_type?: string;
  @IsOptional() @IsString() description?: string;
  @IsOptional() @IsDateString() resolved_at?: string;
  @IsOptional() @IsString() resolution_notes?: string;
  @IsOptional() @IsString() treatment_given?: string;
  @IsOptional() @IsBoolean() hospitalized?: boolean;
}

export class ReportNotivisaDto {
  @IsString({ message: 'notivisa_protocol e obrigatorio' })
  notivisa_protocol: string;
}

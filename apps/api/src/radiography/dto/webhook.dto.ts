import { IsString, IsOptional, IsIn, IsDateString } from 'class-validator';

const VALID_EXAM_TYPES = [
  'PANORAMIC', 'PERIAPICAL', 'BITEWING', 'OCCLUSAL',
  'LATERAL', 'PA', 'CT', 'CBCT', 'OTHER',
] as const;

export class WebhookPayloadDto {
  @IsString({ message: 'tenant_slug obrigatorio' })
  tenant_slug: string; // Identifica qual tenant

  @IsString({ message: 'source_external_id obrigatorio' })
  source_external_id: string; // ID do exame no provider (idempotencia)

  @IsString()
  @IsIn(VALID_EXAM_TYPES, { message: `exam_type deve ser ${VALID_EXAM_TYPES.join(', ')}` })
  exam_type: string;

  // Imagem: pode ser url para download ou base64 inline
  @IsOptional() @IsString() image_url?: string;
  @IsOptional() @IsString() image_base64?: string;
  @IsOptional() @IsString() image_mime?: string; // image/jpeg, image/png

  @IsOptional() @IsString() tooth_fdi?: string;
  @IsOptional() @IsString() report_text?: string;
  @IsOptional() @IsString() report_html?: string;
  @IsOptional() @IsDateString() performed_at?: string;

  // Identificacao do paciente para auto-match
  @IsOptional() @IsString() patient_cpf?: string;
  @IsOptional() @IsString() patient_name?: string;
  @IsOptional() @IsString() patient_phone?: string;
}

export class CreateProviderDto {
  @IsString() name: string;
  @IsString() source_slug: string;
  @IsString() api_key: string; // sera hashed
  @IsOptional() @IsString() notes?: string;
}

export class LinkPatientDto {
  @IsString() patient_id: string;
}

import { IsString, IsOptional, IsArray, IsUUID } from 'class-validator';

export class UpdateMedicalRecordDto {
  @IsOptional() @IsString() chief_complaint?: string;
  @IsOptional() @IsString() history?: string;
}

export class CreateClinicalNoteDto {
  @IsOptional() @IsUUID('4') appointment_id?: string;
  @IsOptional() @IsString() subjective?: string;
  @IsOptional() @IsString() objective?: string;
  @IsOptional() @IsString() assessment?: string;
  @IsOptional() @IsString() plan?: string;

  /** IDs de TreatmentPlanItem que foram executados nesta nota. */
  @IsOptional() @IsArray() @IsUUID('4', { each: true })
  executed_items?: string[];
}

export class UpdateClinicalNoteDto {
  @IsOptional() @IsString() subjective?: string;
  @IsOptional() @IsString() objective?: string;
  @IsOptional() @IsString() assessment?: string;
  @IsOptional() @IsString() plan?: string;
  @IsOptional() @IsArray() @IsUUID('4', { each: true }) executed_items?: string[];
}

export class AddAddendumDto {
  @IsString({ message: 'addendum e obrigatorio' })
  addendum: string;
}

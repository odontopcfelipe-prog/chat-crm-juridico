import { IsString, IsOptional, IsUUID, IsDateString, IsIn } from 'class-validator';

const VALID_STATUS = ['PENDENTE', 'CONTATADO', 'AGENDADO', 'REJEITADO', 'EXPIRADO'] as const;

export class CreateReturnAlertDto {
  @IsUUID('4', { message: 'patient_id deve ser UUID' })
  patient_id: string;

  @IsOptional() @IsUUID('4') professional_user_id?: string;
  @IsOptional() @IsUUID('4') source_appointment_id?: string;

  @IsDateString({}, { message: 'scheduled_for deve ser data ISO' })
  scheduled_for: string;

  @IsOptional() @IsString() reason?: string;
  @IsOptional() @IsString() notes?: string;
}

export class UpdateReturnAlertDto {
  @IsOptional() @IsDateString() scheduled_for?: string;
  @IsOptional() @IsString() reason?: string;
  @IsOptional() @IsString() notes?: string;

  @IsOptional()
  @IsString()
  @IsIn(VALID_STATUS)
  status?: string;

  @IsOptional() @IsUUID('4') scheduled_appointment_id?: string;
}

export class ContactReturnAlertDto {
  @IsOptional() @IsString() notes?: string;
  @IsOptional() @IsUUID('4') scheduled_appointment_id?: string;

  @IsOptional()
  @IsString()
  @IsIn(['CONTATADO', 'AGENDADO', 'REJEITADO'])
  result?: string; // default 'CONTATADO'
}

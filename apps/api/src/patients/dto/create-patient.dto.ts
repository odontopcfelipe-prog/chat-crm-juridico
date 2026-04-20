import { IsString, IsOptional, IsEmail, IsDateString, IsIn, IsUUID } from 'class-validator';

const VALID_STATUS = ['ACTIVE', 'INACTIVE', 'ARCHIVED'] as const;
const VALID_GENDER = ['M', 'F', 'OTHER'] as const;

export class CreatePatientDto {
  @IsString({ message: 'Nome e obrigatorio' })
  name: string;

  @IsOptional()
  @IsString()
  cpf?: string;

  @IsOptional()
  @IsString()
  rg?: string;

  @IsOptional()
  @IsDateString({}, { message: 'birth_date deve ser uma data ISO valida' })
  birth_date?: string;

  @IsOptional()
  @IsString()
  @IsIn(VALID_GENDER, { message: `gender deve ser um de: ${VALID_GENDER.join(', ')}` })
  gender?: string;

  @IsOptional()
  @IsString()
  phone?: string;

  @IsOptional()
  @IsEmail({}, { message: 'Email invalido' })
  email?: string;

  @IsOptional() @IsString() address?: string;
  @IsOptional() @IsString() address_number?: string;
  @IsOptional() @IsString() address_complement?: string;
  @IsOptional() @IsString() neighborhood?: string;
  @IsOptional() @IsString() city?: string;
  @IsOptional() @IsString() state?: string;
  @IsOptional() @IsString() zip_code?: string;

  @IsOptional() @IsString() blood_type?: string;
  @IsOptional() @IsString() emergency_contact_name?: string;
  @IsOptional() @IsString() emergency_contact_phone?: string;

  @IsOptional()
  @IsUUID('4', { message: 'primary_dentist_id deve ser UUID' })
  primary_dentist_id?: string;

  @IsOptional() @IsString() referred_by?: string;

  @IsOptional()
  @IsUUID('4', { message: 'lead_id deve ser UUID' })
  lead_id?: string;

  @IsOptional() @IsString() notes?: string;
}

export class UpdatePatientDto {
  @IsOptional() @IsString() name?: string;
  @IsOptional() @IsString() cpf?: string;
  @IsOptional() @IsString() rg?: string;
  @IsOptional() @IsDateString() birth_date?: string;
  @IsOptional() @IsString() @IsIn(VALID_GENDER) gender?: string;
  @IsOptional() @IsString() phone?: string;
  @IsOptional() @IsEmail() email?: string;

  @IsOptional() @IsString() address?: string;
  @IsOptional() @IsString() address_number?: string;
  @IsOptional() @IsString() address_complement?: string;
  @IsOptional() @IsString() neighborhood?: string;
  @IsOptional() @IsString() city?: string;
  @IsOptional() @IsString() state?: string;
  @IsOptional() @IsString() zip_code?: string;

  @IsOptional() @IsString() blood_type?: string;
  @IsOptional() @IsString() emergency_contact_name?: string;
  @IsOptional() @IsString() emergency_contact_phone?: string;

  @IsOptional() @IsUUID('4') primary_dentist_id?: string;
  @IsOptional() @IsString() referred_by?: string;
  @IsOptional() @IsString() @IsIn(VALID_STATUS) status?: string;
  @IsOptional() @IsString() notes?: string;
}

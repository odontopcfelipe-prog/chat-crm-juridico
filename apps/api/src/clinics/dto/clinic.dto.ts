import { IsString, IsOptional, IsBoolean, IsIn, IsEmail, IsUUID } from 'class-validator';

const VALID_TYPE = ['DENTAL', 'AESTHETIC', 'MIXED'] as const;

export class CreateClinicDto {
  @IsString({ message: 'Nome obrigatorio' })
  name: string;

  @IsOptional() @IsString() short_name?: string;
  @IsOptional() @IsString() address?: string;
  @IsOptional() @IsString() city?: string;
  @IsOptional() @IsString() state?: string;
  @IsOptional() @IsString() phone?: string;
  @IsOptional() @IsEmail() email?: string;
  @IsOptional() @IsString() cnpj?: string;

  @IsOptional()
  @IsString()
  @IsIn(VALID_TYPE, { message: `type deve ser ${VALID_TYPE.join(' | ')}` })
  type?: string;

  @IsOptional() @IsString() logo_url?: string;
  @IsOptional() @IsString() brand_color?: string;
  @IsOptional() @IsBoolean() active?: boolean;
  @IsOptional() @IsBoolean() is_franchise?: boolean;
  @IsOptional() @IsUUID('4') franchisee_owner_user_id?: string;
}

export class UpdateClinicDto {
  @IsOptional() @IsString() name?: string;
  @IsOptional() @IsString() short_name?: string;
  @IsOptional() @IsString() address?: string;
  @IsOptional() @IsString() city?: string;
  @IsOptional() @IsString() state?: string;
  @IsOptional() @IsString() phone?: string;
  @IsOptional() @IsEmail() email?: string;
  @IsOptional() @IsString() cnpj?: string;
  @IsOptional() @IsString() @IsIn(VALID_TYPE) type?: string;
  @IsOptional() @IsString() logo_url?: string;
  @IsOptional() @IsString() brand_color?: string;
  @IsOptional() @IsBoolean() active?: boolean;
  @IsOptional() @IsBoolean() is_franchise?: boolean;
  @IsOptional() @IsUUID('4') franchisee_owner_user_id?: string;
}

export class AssignUserClinicDto {
  @IsUUID('4') user_id: string;
  @IsOptional() @IsString() role?: string;
  @IsOptional() @IsBoolean() is_default?: boolean;
}

import { IsString, IsOptional, IsEmail, IsIn, IsBoolean } from 'class-validator';

const VALID_CATEGORY = ['LABORATORIO', 'INSUMOS', 'EQUIPAMENTOS', 'SERVICOS', 'OUTRO'] as const;

export class CreateSupplierDto {
  @IsString({ message: 'Nome e obrigatorio' })
  name: string;

  @IsOptional() @IsString() cnpj?: string;

  @IsOptional()
  @IsString()
  @IsIn(VALID_CATEGORY, { message: `category deve ser um de: ${VALID_CATEGORY.join(', ')}` })
  category?: string;

  @IsOptional() @IsString() contact_name?: string;
  @IsOptional() @IsString() phone?: string;

  @IsOptional()
  @IsEmail({}, { message: 'Email invalido' })
  email?: string;

  @IsOptional() @IsString() address?: string;
  @IsOptional() @IsString() notes?: string;
  @IsOptional() @IsBoolean() active?: boolean;
}

export class UpdateSupplierDto {
  @IsOptional() @IsString() name?: string;
  @IsOptional() @IsString() cnpj?: string;
  @IsOptional() @IsString() @IsIn(VALID_CATEGORY) category?: string;
  @IsOptional() @IsString() contact_name?: string;
  @IsOptional() @IsString() phone?: string;
  @IsOptional() @IsEmail() email?: string;
  @IsOptional() @IsString() address?: string;
  @IsOptional() @IsString() notes?: string;
  @IsOptional() @IsBoolean() active?: boolean;
}

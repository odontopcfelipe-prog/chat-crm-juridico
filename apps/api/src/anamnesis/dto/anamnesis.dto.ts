import { IsString, IsOptional, IsBoolean, IsObject, IsUUID } from 'class-validator';

export class CreateAnamnesisTemplateDto {
  @IsObject({ message: 'schema deve ser um objeto JSON' })
  schema: Record<string, any>;

  @IsOptional() @IsString() notes?: string;
}

export class UpdateAnamnesisTemplateDto {
  @IsOptional() @IsObject() schema?: Record<string, any>;
  @IsOptional() @IsBoolean() active?: boolean;
  @IsOptional() @IsString() notes?: string;
}

export class CreateAnamnesisDto {
  /** Template a usar. Se omitido, usa o template ativo do tenant. */
  @IsOptional() @IsUUID('4') template_id?: string;

  @IsObject({ message: 'answers deve ser um objeto JSON' })
  answers: Record<string, any>;
}

export class UpdateAnamnesisDto {
  @IsOptional() @IsObject() answers?: Record<string, any>;
}

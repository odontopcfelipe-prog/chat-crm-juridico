import { IsString, IsOptional, IsBoolean } from 'class-validator';

export class CreateSpecialtyDto {
  @IsString({ message: 'Nome e obrigatorio' })
  name: string;

  @IsOptional() @IsString() description?: string;
  @IsOptional() @IsString() icon?: string;
}

export class UpdateSpecialtyDto {
  @IsOptional() @IsString() name?: string;
  @IsOptional() @IsString() description?: string;
  @IsOptional() @IsString() icon?: string;
  @IsOptional() @IsBoolean() active?: boolean;
}

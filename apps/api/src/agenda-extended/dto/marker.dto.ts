import { IsString, IsOptional, IsBoolean } from 'class-validator';

export class CreateMarkerDto {
  @IsString({ message: 'Nome e obrigatorio' })
  name: string;

  @IsOptional() @IsString() color?: string;
  @IsOptional() @IsBoolean() active?: boolean;
}

export class UpdateMarkerDto {
  @IsOptional() @IsString() name?: string;
  @IsOptional() @IsString() color?: string;
  @IsOptional() @IsBoolean() active?: boolean;
}

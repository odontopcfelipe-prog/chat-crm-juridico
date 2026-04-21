import { IsString, IsOptional, IsBoolean, IsInt, Min, Max } from 'class-validator';
import { Type } from 'class-transformer';

export class CreateRoomDto {
  @IsString({ message: 'Nome e obrigatorio' })
  name: string;

  @IsOptional() @IsString() description?: string;
  @IsOptional() @IsString() color?: string;

  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(20) capacity?: number;
  @IsOptional() @IsBoolean() active?: boolean;
}

export class UpdateRoomDto {
  @IsOptional() @IsString() name?: string;
  @IsOptional() @IsString() description?: string;
  @IsOptional() @IsString() color?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(20) capacity?: number;
  @IsOptional() @IsBoolean() active?: boolean;
}

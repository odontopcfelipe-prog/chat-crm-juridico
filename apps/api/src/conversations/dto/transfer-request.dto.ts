import { IsUUID, IsOptional, IsString, IsArray } from 'class-validator';

export class TransferRequestDto {
  @IsUUID('4', { message: 'toUserId deve ser um UUID válido' })
  toUserId: string;

  @IsOptional()
  @IsString()
  reason?: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  audioIds?: string[];
}

export class TransferToLawyerDto {
  @IsOptional()
  @IsString()
  reason?: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  audioIds?: string[];
}

export class ReturnToOriginDto {
  @IsOptional()
  @IsString()
  reason?: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  audioIds?: string[];
}

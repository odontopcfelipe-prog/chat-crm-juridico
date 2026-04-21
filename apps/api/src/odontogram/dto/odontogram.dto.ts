import { IsString, IsOptional, IsObject, Matches, IsIn } from 'class-validator';

const VALID_STATES = [
  'CARIE', 'RESTAURADO', 'AUSENTE', 'PROTESE', 'IMPLANTE',
  'ENDODONTIA', 'EXTRACAO_INDICADA', 'COROA', 'FRATURA', 'OUTROS',
] as const;

const VALID_FACES = ['M', 'D', 'O', 'V', 'L', 'INCISAL'] as const;

export class UpdateOdontogramDto {
  @IsOptional() @IsObject()
  meta?: Record<string, any>;
}

export class CreateToothRecordDto {
  @IsString()
  @Matches(/^([1-4][1-8]|[5-8][1-5])$/, { message: 'tooth_fdi deve ser FDI valido (11-48 ou 51-85)' })
  tooth_fdi: string;

  @IsOptional() @IsString() @IsIn(VALID_FACES)
  face?: string;

  @IsString() @IsIn(VALID_STATES, { message: `state deve ser um de: ${VALID_STATES.join(', ')}` })
  state: string;

  @IsOptional() @IsString() material?: string;
  @IsOptional() @IsString() notes?: string;
}

export class UpdateToothRecordDto {
  @IsOptional() @IsString() @IsIn(VALID_FACES) face?: string;
  @IsOptional() @IsString() @IsIn(VALID_STATES) state?: string;
  @IsOptional() @IsString() material?: string;
  @IsOptional() @IsString() notes?: string;
}

import {
  IsString,
  IsOptional,
  IsBoolean,
  IsInt,
  Min,
  IsIn,
} from 'class-validator';

const VALID_STATES = [
  'CARIE',
  'RESTAURADO',
  'AUSENTE',
  'PROTESE',
  'IMPLANTE',
  'ENDODONTIA',
  'EXTRACAO_INDICADA',
  'COROA',
  'FRATURA',
  'OUTROS',
] as const;

export class CreateStateSuggestionDto {
  @IsString()
  @IsIn(VALID_STATES, {
    message: `state deve ser um de: ${VALID_STATES.join(', ')}`,
  })
  state: string;

  @IsString()
  procedure_id: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  priority?: number;

  @IsOptional()
  @IsBoolean()
  active?: boolean;
}

export class UpdateStateSuggestionDto {
  @IsOptional()
  @IsString()
  @IsIn(VALID_STATES)
  state?: string;

  @IsOptional()
  @IsString()
  procedure_id?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  priority?: number;

  @IsOptional()
  @IsBoolean()
  active?: boolean;
}

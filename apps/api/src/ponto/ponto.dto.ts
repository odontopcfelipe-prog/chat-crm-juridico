import {
  IsString,
  IsNumber,
  IsInt,
  IsOptional,
  IsBoolean,
  IsArray,
  Min,
  Max,
  Matches,
  MinLength,
  MaxLength,
  ArrayMinSize,
  ArrayMaxSize,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

// Localização do aparelho na hora da batida (opcional: sem GPS a batida é aceita,
// a não ser que a clínica exija o local).
export class PunchDto {
  @IsOptional() @IsNumber() @Min(-90) @Max(90)
  latitude?: number;

  @IsOptional() @IsNumber() @Min(-180) @Max(180)
  longitude?: number;

  @IsOptional() @IsNumber() @Min(0)
  accuracy?: number;
}

// Batida lançada pelo gestor (esquecimento, falta de sinal...). Data/hora LOCAL de Maceió.
export class ManualPunchDto {
  @IsString() @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'Data inválida (AAAA-MM-DD)' })
  date: string;

  @IsString() @Matches(/^([01]\d|2[0-3]):[0-5]\d$/, { message: 'Hora inválida (HH:mm)' })
  time: string;

  @IsString() @MinLength(3, { message: 'Escreva o motivo do lançamento' }) @MaxLength(300)
  note: string;
}

export class VoidPunchDto {
  @IsString() @MinLength(3, { message: 'Escreva o motivo da anulação' }) @MaxLength(300)
  reason: string;
}

export class PontoLocalDto {
  @IsNumber() @Min(-90) @Max(90)
  lat: number;

  @IsNumber() @Min(-180) @Max(180)
  lng: number;

  @IsInt() @Min(20) @Max(5000)
  raio_m: number;
}

export class PontoConfigDto {
  // null = apagar o local da clínica
  @IsOptional() @ValidateNested() @Type(() => PontoLocalDto)
  local?: PontoLocalDto | null;

  @IsOptional() @IsBoolean()
  exigir_local?: boolean;

  @IsOptional() @IsArray() @ArrayMaxSize(10) @IsString({ each: true })
  ips?: string[];

  @IsOptional() @IsArray() @ArrayMinSize(7) @ArrayMaxSize(7)
  @IsInt({ each: true }) @Min(0, { each: true }) @Max(1440, { each: true })
  jornada_padrao?: number[];
}

// Jornada própria do funcionário (minutos por dia, 0 = domingo). null = usa a padrão.
export class UserScheduleDto {
  @IsOptional() @IsArray() @ArrayMinSize(7) @ArrayMaxSize(7)
  @IsInt({ each: true }) @Min(0, { each: true }) @Max(1440, { each: true })
  minutes?: number[] | null;
}

import {
  IsString,
  IsNumber,
  IsInt,
  IsOptional,
  IsArray,
  Min,
  Max,
  Matches,
  MinLength,
  MaxLength,
  ArrayMinSize,
  ArrayMaxSize,
} from 'class-validator';

const YMD = /^\d{4}-\d{2}-\d{2}$/;

// Localização do aparelho na hora da batida. Obrigatória (o serviço recusa sem ela),
// mas opcional no DTO pra devolver a mensagem certa em vez de um 400 genérico.
export class PunchDto {
  @IsOptional() @IsNumber() @Min(-90) @Max(90)
  latitude?: number;

  @IsOptional() @IsNumber() @Min(-180) @Max(180)
  longitude?: number;

  @IsOptional() @IsNumber() @Min(0)
  accuracy?: number;
}

// Batida lançada pelo adm (esquecimento). Data/hora LOCAL de Maceió.
export class ManualPunchDto {
  @IsString() @Matches(YMD, { message: 'Data inválida (AAAA-MM-DD)' })
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

// Local base do ponto: centro + raio. Fora do raio a batida é recusada.
export class PontoLocalDto {
  @IsNumber() @Min(-90) @Max(90)
  lat: number;

  @IsNumber() @Min(-180) @Max(180)
  lng: number;

  @IsInt() @Min(20) @Max(2000)
  raio_m: number;
}

// `days` = 7 posições (0 = domingo): null ou {in, break_start, break_end, out} "HH:mm".
// Validado a fundo no serviço (normalizeWeek) — aqui só o formato da lista.
export class CreateMemberDto {
  @IsString() @MinLength(1)
  user_id: string;

  @IsString() @Matches(YMD, { message: 'Data de início inválida (AAAA-MM-DD)' })
  start_date: string;

  @IsArray() @ArrayMinSize(7) @ArrayMaxSize(7)
  days: any[];
}

export class UpdateMemberDto {
  @IsOptional() @IsString() @Matches(YMD, { message: 'Data de início inválida (AAAA-MM-DD)' })
  start_date?: string;

  // null = volta a ficar ativo; data = último dia no ponto.
  @IsOptional() @IsString() @Matches(YMD, { message: 'Data de saída inválida (AAAA-MM-DD)' })
  end_date?: string | null;
}

export class ScheduleDto {
  @IsString() @Matches(YMD, { message: 'Data de vigência inválida (AAAA-MM-DD)' })
  valid_from: string;

  @IsArray() @ArrayMinSize(7) @ArrayMaxSize(7)
  days: any[];
}

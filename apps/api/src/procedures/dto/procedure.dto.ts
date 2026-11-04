import { IsIn, IsString, IsOptional, IsBoolean, IsInt, IsUUID, IsNumber, Matches, Min, ValidateIf } from 'class-validator';

// IsOptional() ignora null E undefined em class-validator, mas o decorator
// @IsUUID nao casa com string vazia. Helper pra aceitar null/empty/UUID valido.
const OPTIONAL_UUID = ValidateIf((_o: any, v: any) => v !== null && v !== undefined && v !== '');

export class CreateProcedureDto {
  @IsString({ message: 'Nome e obrigatorio' })
  name: string;

  @IsOptional() @OPTIONAL_UUID @IsUUID('4') specialty_id?: string | null;
  @IsOptional() @IsString() code_tuss?: string | null;
  @IsOptional() @IsString() internal_code?: string | null;
  @IsOptional() @IsString() description?: string | null;

  @IsOptional() @IsInt() @Min(5) duration_minutes?: number;

  @IsOptional() @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) base_price?: number;

  @IsOptional() @IsBoolean() requires_x_ray?: boolean;
  @IsOptional() @IsBoolean() requires_anesthesia?: boolean;
  @IsOptional() @IsBoolean() commissionable?: boolean;
  @IsOptional() @IsBoolean() quick_sale?: boolean;

  // Fase 6 — Estetica facial / agendamento de revisita
  @IsOptional() @IsString() category?: string | null;
  @IsOptional() @IsBoolean() is_facial_application?: boolean;
  @IsOptional() @IsInt() @Min(0) default_revisit_months?: number | null; // >=1 = gera retorno em N meses (opt-in); null/0 = sem retorno
  @IsOptional() @IsString() post_procedure_instructions?: string | null;
}

export class UpdateProcedureDto {
  @IsOptional() @IsString() name?: string;
  @IsOptional() @OPTIONAL_UUID @IsUUID('4') specialty_id?: string | null;
  @IsOptional() @IsString() code_tuss?: string | null;
  @IsOptional() @IsString() internal_code?: string | null;
  @IsOptional() @IsString() description?: string | null;
  @IsOptional() @IsInt() @Min(5) duration_minutes?: number;
  @IsOptional() @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) base_price?: number;
  @IsOptional() @IsBoolean() requires_x_ray?: boolean;
  @IsOptional() @IsBoolean() requires_anesthesia?: boolean;
  @IsOptional() @IsBoolean() commissionable?: boolean;
  @IsOptional() @IsBoolean() quick_sale?: boolean;
  @IsOptional() @IsBoolean() active?: boolean;
  // Preço promocional da Venda Rápida. null tira a promoção.
  @IsOptional() @IsNumber({ maxDecimalPlaces: 2 }) @Min(0.01) promo_price?: number | null;
  // Faixa "Produtos em destaque" da Nova venda.
  @IsOptional() @IsBoolean() featured?: boolean;

  // Fase 6 — Estetica facial / agendamento de revisita
  @IsOptional() @IsString() category?: string | null;
  @IsOptional() @IsBoolean() is_facial_application?: boolean;
  @IsOptional() @IsInt() @Min(0) default_revisit_months?: number | null; // >=1 = gera retorno em N meses (opt-in); null/0 = sem retorno
  @IsOptional() @IsString() post_procedure_instructions?: string | null;
}

const COR = /^#[0-9a-fA-F]{6}$/;
const MSG_COR = 'Cor inválida: use o formato #rrggbb.';

/** Edição básica da Venda Rápida: a cor das 4 partes da tela e o tamanho das fotos. */
export class AparenciaVendaDto {
  @Matches(COR, { message: MSG_COR }) cor_cabecalho: string;
  @Matches(COR, { message: MSG_COR }) cor_produtos: string;
  @Matches(COR, { message: MSG_COR }) cor_destaque: string;
  @Matches(COR, { message: MSG_COR }) cor_rodape: string;
  @IsIn(['pequeno', 'medio', 'grande']) tamanho_foto: 'pequeno' | 'medio' | 'grande';
}

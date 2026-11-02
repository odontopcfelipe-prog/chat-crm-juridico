/**
 * F8 do laboratório — corpos dos 3 PUT das fichas (cliente, serviço e caso).
 *
 * O PUT é PARCIAL: chave ausente mantém o gravado, null limpa. Por isso:
 *   - todo campo é opcional (@IsOptional deixa passar null e ausente) e texto vazio
 *     também passa (o serviço grava null); o link chega aparado;
 *   - NENHUM inicializador de propriedade: com transform:true o valor padrão
 *     apareceria como se tivesse vindo no corpo e anularia o "mantém".
 * Campo fora daqui (gravado, herdado_de, tenant_id, patient_id...) dá 400 pelo
 * forbidNonWhitelisted do ValidationPipe global (main.ts). Toda mensagem vem de
 * LAB_FICHAS_API. As regras que dependem do gravado (CRO do dentista, prazo e
 * unidade na criação, datas) ficam no serviço, no registro mesclado.
 */
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUrl,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateIf,
} from 'class-validator';
import { Transform } from 'class-transformer';
import {
  GARANTIA_MAX_DIAS,
  LIMITES_DA_FICHA,
  LIMITES_DO_CASO,
  LIMITES_DO_PERFIL,
  MAX_DENTISTAS_SOLICITANTES,
  PRAZO_MAX_DIAS,
  TIPOS_DE_CLIENTE,
  UFS_DO_BRASIL,
  UNIDADES_DO_SERVICO,
  type TipoCliente,
  type UnidadeDoServico,
} from '@crm/shared';
import { LAB_FICHAS_API as T } from '../lab-fichas-textos';

/** Valida só valor de verdade: texto vazio segue como "limpar" (o serviço grava null). */
const SeNaoVazio = () => ValidateIf((_o: unknown, v: unknown) => v !== '');

const texto = { message: T.textoInvalido };
const longo = (campo: keyof typeof T.campos, max: number) => ({ message: T.textoLongo(T.campos[campo], max) });
const RE_DATA = /^\d{4}-\d{2}-\d{2}$/;

export class PutPatientLabProfileDto {
  @IsOptional()
  @SeNaoVazio()
  @IsIn(TIPOS_DE_CLIENTE, { message: T.tipoInvalido })
  kind?: TipoCliente | null;

  @IsOptional()
  @SeNaoVazio()
  @IsString({ message: T.croInvalido })
  @Matches(/^[0-9.\s-]{1,12}$/, { message: T.croInvalido })
  cro_number?: string | null;

  @IsOptional()
  @SeNaoVazio()
  @IsIn(UFS_DO_BRASIL, { message: T.ufInvalida })
  cro_uf?: string | null;

  @IsOptional()
  @IsString(texto)
  @MaxLength(LIMITES_DO_PERFIL.legal_name, longo('legal_name', LIMITES_DO_PERFIL.legal_name))
  legal_name?: string | null;

  @IsOptional()
  @IsString(texto)
  @MaxLength(LIMITES_DO_PERFIL.clinic_name, longo('clinic_name', LIMITES_DO_PERFIL.clinic_name))
  clinic_name?: string | null;

  @IsOptional()
  @IsString(texto)
  @MaxLength(LIMITES_DO_PERFIL.contact_name, longo('contact_name', LIMITES_DO_PERFIL.contact_name))
  contact_name?: string | null;

  @IsOptional()
  @IsString(texto)
  @MaxLength(LIMITES_DO_PERFIL.contact_phone, longo('contact_phone', LIMITES_DO_PERFIL.contact_phone))
  contact_phone?: string | null;

  @IsOptional()
  @IsArray({ message: T.listaInvalida })
  @ArrayMaxSize(MAX_DENTISTAS_SOLICITANTES, { message: T.dentistasDemais })
  @IsString({ each: true, message: T.listaInvalida })
  @MaxLength(LIMITES_DO_PERFIL.dentista, { each: true, ...longo('dentista', LIMITES_DO_PERFIL.dentista) })
  requesting_dentists?: string[] | null;

  @IsOptional()
  @IsString(texto)
  @MaxLength(LIMITES_DO_PERFIL.delivery_notes, longo('delivery_notes', LIMITES_DO_PERFIL.delivery_notes))
  delivery_notes?: string | null;
}

export class PutProcedureLabSpecDto {
  @IsOptional()
  @IsInt({ message: T.prazoInvalido })
  @Min(0, { message: T.prazoInvalido })
  @Max(PRAZO_MAX_DIAS, { message: T.prazoInvalido })
  lead_time_days?: number | null;

  @IsOptional()
  @IsInt({ message: T.garantiaInvalida })
  @Min(0, { message: T.garantiaInvalida })
  @Max(GARANTIA_MAX_DIAS, { message: T.garantiaInvalida })
  warranty_days?: number | null;

  @IsOptional()
  @SeNaoVazio()
  @IsIn(UNIDADES_DO_SERVICO, { message: T.unidadeInvalida })
  unit?: UnidadeDoServico | null;

  @IsOptional()
  @IsString(texto)
  @MaxLength(LIMITES_DA_FICHA.default_material, longo('default_material', LIMITES_DA_FICHA.default_material))
  default_material?: string | null;

  @IsOptional()
  @IsBoolean({ message: T.booleano })
  needs_shade?: boolean | null;

  @IsOptional()
  @IsBoolean({ message: T.booleano })
  has_tryin?: boolean | null;
}

export class PutQuoteLabCaseDto {
  @IsOptional()
  @IsString(texto)
  @MaxLength(LIMITES_DO_CASO.patient_ref, longo('patient_ref', LIMITES_DO_CASO.patient_ref))
  patient_ref?: string | null;

  @IsOptional()
  @IsString(texto)
  @MaxLength(LIMITES_DO_CASO.requested_by_name, longo('requested_by_name', LIMITES_DO_CASO.requested_by_name))
  requested_by_name?: string | null;

  @IsOptional()
  @IsString(texto)
  @MaxLength(LIMITES_DO_CASO.shade, longo('shade', LIMITES_DO_CASO.shade))
  shade?: string | null;

  @IsOptional()
  @IsString(texto)
  @MaxLength(LIMITES_DO_CASO.material, longo('material', LIMITES_DO_CASO.material))
  material?: string | null;

  @IsOptional()
  @SeNaoVazio()
  @Matches(RE_DATA, { message: T.dataInvalida })
  due_date?: string | null;

  @IsOptional()
  @IsString(texto)
  @MaxLength(LIMITES_DO_CASO.instructions, longo('instructions', LIMITES_DO_CASO.instructions))
  instructions?: string | null;

  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @SeNaoVazio()
  @IsUrl({ protocols: ['http', 'https'], require_protocol: true }, { message: T.linkInvalido })
  @MaxLength(LIMITES_DO_CASO.external_files_url, longo('external_files_url', LIMITES_DO_CASO.external_files_url))
  external_files_url?: string | null;

  @IsOptional()
  @SeNaoVazio()
  @Matches(RE_DATA, { message: T.dataInvalida })
  received_at?: string | null;
}

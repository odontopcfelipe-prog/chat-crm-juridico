import { IsBoolean, IsNotEmpty, IsOptional, IsString } from 'class-validator';

export class EmitNotaFiscalDto {
  @IsString()
  @IsNotEmpty()
  transactionId: string;
}

/** Configuração de NFS-e do laboratório (PUT /nota-fiscal/config). */
export class SaveNotaFiscalConfigLabDto {
  @IsOptional() @IsString() provider?: string;
  @IsOptional() @IsString() api_key?: string;
  @IsOptional() @IsString() cnpj?: string;
  @IsOptional() @IsString() inscricao_municipal?: string;
  @IsOptional() @IsString() cnae_code?: string;
  @IsOptional() @IsString() default_iss_rate?: string;
  @IsOptional() @IsBoolean() auto_emit?: boolean;
  @IsOptional() @IsString() servico_descricao?: string;
}

import { IsString, IsUUID, MaxLength, IsOptional, IsBoolean } from 'class-validator';

export class SendMessageDto {
  @IsUUID('4', { message: 'conversationId deve ser um UUID válido' })
  conversationId: string;

  @IsString({ message: 'Texto é obrigatório' })
  @MaxLength(5000, { message: 'Texto excede o limite de 5000 caracteres' })
  text: string;

  @IsOptional()
  @IsString()
  replyToId?: string;

  /** Quando true, salva como nota interna (type='internal_note') e NÃO envia ao WhatsApp */
  @IsOptional()
  @IsBoolean()
  isInternal?: boolean;
}

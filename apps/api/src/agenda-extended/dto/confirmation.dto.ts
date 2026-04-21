import { IsString, IsOptional, IsIn, IsDateString } from 'class-validator';

const VALID_CHANNEL = ['WHATSAPP', 'SMS', 'EMAIL', 'APP_PUSH', 'CLOUDIA', 'MANUAL'] as const;
const VALID_RESPONSE = ['PENDENTE', 'CONFIRMADO', 'REJEITADO', 'REMARCADO', 'SEM_RESPOSTA'] as const;

export class CreateConfirmationDto {
  @IsString()
  @IsIn(VALID_CHANNEL, { message: `channel deve ser um de: ${VALID_CHANNEL.join(', ')}` })
  channel: string;

  @IsOptional() @IsDateString() scheduled_for?: string;
  @IsOptional() @IsDateString() sent_at?: string;
  @IsOptional() @IsString() message_text?: string;
  @IsOptional() @IsString() message_id?: string;
  @IsOptional() @IsString() delivery_status?: string;
}

export class RespondConfirmationDto {
  @IsString()
  @IsIn(VALID_RESPONSE, { message: `response_status deve ser um de: ${VALID_RESPONSE.join(', ')}` })
  response_status: string;

  @IsOptional() @IsString() response_text?: string;
  @IsOptional() @IsString() message_id?: string;
}

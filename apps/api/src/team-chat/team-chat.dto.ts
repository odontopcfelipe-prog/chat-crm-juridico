import { IsOptional, IsString, MaxLength } from 'class-validator';

// O nome do canal é validado no serviço (team-chat-channels.ts) pra devolver a
// mensagem certa em vez de um 400 genérico.
export class SendTeamMessageDto {
  @IsString() @MaxLength(120)
  channel: string;

  @IsOptional() @IsString() @MaxLength(2000, { message: 'Mensagem muito longa (máx. 2000 caracteres)' })
  text?: string;

  @IsOptional() @IsString() @MaxLength(64)
  patient_id?: string;
}

export class TeamReadDto {
  @IsString() @MaxLength(120)
  channel: string;
}

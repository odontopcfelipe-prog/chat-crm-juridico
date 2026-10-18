import { Module } from '@nestjs/common';
import { WhatsappModule } from '../whatsapp/whatsapp.module';
import { AudioDisparoController } from './audio-disparo.controller';
import { AudioDisparoService } from './audio-disparo.service';

/**
 * Lembrete em áudio (teste): texto → mensagem de voz (OpenAI ou Gemini) com voz, sotaque
 * e velocidade escolhidos na Central. Só prévia + envio de teste; não envia sozinho.
 * SettingsService vem do módulo global; ninguém importa este módulo (sem ciclo).
 */
@Module({
  imports: [WhatsappModule],
  controllers: [AudioDisparoController],
  providers: [AudioDisparoService],
})
export class AudioDisparoModule {}

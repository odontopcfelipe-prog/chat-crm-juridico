import { Body, Controller, Get, HttpCode, HttpStatus, Post, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { Authenticated, type AuthUser } from '../auth/decorators/authenticated.decorator';
import { TeamChatService } from './team-chat.service';
import { SendTeamMessageDto, TeamReadDto } from './team-chat.dto';

// Conversa da equipe (botão "Equipe" em todas as telas). Todo logado usa —
// inclusive o dentista: é conversa interna, sem paciente/WhatsApp.
@UseGuards(JwtAuthGuard)
@Controller('team-chat')
export class TeamChatController {
  constructor(private readonly service: TeamChatService) {}

  @Get('overview')
  overview(@Authenticated() user: AuthUser) {
    return this.service.overview(user.tenant_id, user.id);
  }

  @Get('messages')
  messages(@Query('channel') channel: string, @Query('before') before: string | undefined, @Authenticated() user: AuthUser) {
    return this.service.messages(user.tenant_id, user.id, channel, before);
  }

  @Post('messages')
  send(@Body() body: SendTeamMessageDto, @Authenticated() user: AuthUser) {
    return this.service.send(user.tenant_id, user.id, body);
  }

  @Post('read')
  @HttpCode(HttpStatus.OK)
  read(@Body() body: TeamReadDto, @Authenticated() user: AuthUser) {
    return this.service.read(user.tenant_id, user.id, body.channel);
  }
}

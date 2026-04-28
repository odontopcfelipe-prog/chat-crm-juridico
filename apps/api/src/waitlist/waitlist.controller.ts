/**
 * WaitlistController — endpoints REST pra Lista de Espera (Fase 19)
 *
 * Rotas:
 *  GET    /waitlist?status=AGUARDANDO  — listar entradas (filtra por status opcional)
 *  GET    /waitlist/:id                  — detalhes de uma entrada
 *  POST   /waitlist                       — criar nova entrada (lead, dentist, prefs)
 *  PATCH  /waitlist/:id                   — editar entrada
 *  DELETE /waitlist/:id                   — remover entrada
 *  POST   /waitlist/:id/notified           — marca como NOTIFICADO + incrementa contador
 *
 * Autenticação: usa AuthGuard global (já configurado em app.module). tenant_id
 * vem do req.user.tenant_id pra isolamento multi-tenant.
 */
import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  Query,
  Request,
  UseGuards,
} from '@nestjs/common';
import { WaitlistService } from './waitlist.service';
import type { CreateWaitlistDto, UpdateWaitlistDto } from './waitlist.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';

@Controller('waitlist')
@UseGuards(JwtAuthGuard)
export class WaitlistController {
  constructor(private waitlistService: WaitlistService) {}

  @Get()
  list(@Request() req: any, @Query('status') status?: string) {
    return this.waitlistService.list(req.user?.tenant_id, status);
  }

  @Get(':id')
  findOne(@Request() req: any, @Param('id') id: string) {
    return this.waitlistService.findOne(id, req.user?.tenant_id);
  }

  @Post()
  create(@Request() req: any, @Body() data: CreateWaitlistDto) {
    return this.waitlistService.create(data, req.user?.tenant_id);
  }

  @Patch(':id')
  update(@Request() req: any, @Param('id') id: string, @Body() data: UpdateWaitlistDto) {
    return this.waitlistService.update(id, data, req.user?.tenant_id);
  }

  @Delete(':id')
  remove(@Request() req: any, @Param('id') id: string) {
    return this.waitlistService.remove(id, req.user?.tenant_id);
  }

  @Post(':id/notified')
  markNotified(@Request() req: any, @Param('id') id: string) {
    return this.waitlistService.markNotified(id, req.user?.tenant_id);
  }
}

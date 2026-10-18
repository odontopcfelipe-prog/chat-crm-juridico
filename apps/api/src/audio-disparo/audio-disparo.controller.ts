import { BadRequestException, Body, Controller, Get, Post, Put, Request, Res } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { Roles } from '../auth/decorators/roles.decorator';
import { AudioDisparoService } from './audio-disparo.service';

const tenantDe = (req: any): string => {
  const t = req.user?.tenant_id;
  if (!t) throw new BadRequestException('tenant_id ausente');
  return t;
};

/** Lembrete em áudio (teste) — Central › Agendamento. Só ADMIN; escopado na clínica. */
@Roles('ADMIN')
@Controller('disparos/audio-teste')
export class AudioDisparoController {
  constructor(private readonly svc: AudioDisparoService) {}

  @Get('config')
  getConfig(@Request() req: any) {
    return this.svc.getConfig(tenantDe(req));
  }

  @Put('config')
  setConfig(@Body() body: any, @Request() req: any) {
    return this.svc.setConfig(tenantDe(req), body);
  }

  /** Gera a prévia e devolve o áudio pra tocar na tela. */
  @Throttle({ default: { ttl: 60000, limit: 20 } })
  @Post('ouvir')
  async ouvir(@Body() body: any, @Request() req: any, @Res() res: any) {
    const a = await this.svc.ouvir(tenantDe(req), body);
    res.setHeader('Content-Type', a.mime);
    res.setHeader('Cache-Control', 'no-store');
    res.send(a.buffer);
  }

  @Throttle({ default: { ttl: 60000, limit: 10 } })
  @Post('enviar')
  enviar(@Body() body: any, @Request() req: any) {
    return this.svc.enviarTeste(tenantDe(req), body?.config || body, body?.telefone || '');
  }
}

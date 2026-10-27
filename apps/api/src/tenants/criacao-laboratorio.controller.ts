import { Body, Controller, Get, Put, Req } from '@nestjs/common';
import { IsBoolean } from 'class-validator';
import { SuperAdmin } from '../auth/decorators/super-admin.decorator';
import { CriacaoLaboratorioService } from './criacao-laboratorio.service';

export class CriacaoLaboratorioDto {
  @IsBoolean({ message: 'Informe liberada: true ou false' })
  liberada: boolean;
}

/**
 * F3 do laboratório — liga/desliga da criação de conta de laboratório pelo
 * /admin (chave da plataforma). Só o dono da plataforma (SUPER_ADMIN).
 */
@Controller('plataforma/criacao-laboratorio')
export class CriacaoLaboratorioController {
  constructor(private readonly service: CriacaoLaboratorioService) {}

  @SuperAdmin()
  @Get()
  ler() {
    return this.service.ler();
  }

  @SuperAdmin()
  @Put()
  definir(@Body() body: CriacaoLaboratorioDto, @Req() req: any) {
    return this.service.definir(body?.liberada, req?.user?.id ?? null);
  }
}

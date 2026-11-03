import { Controller, Get, Query } from '@nestjs/common';
import { SuperAdmin } from '../auth/decorators/super-admin.decorator';
import { ComparativoContasService } from './comparativo-contas.service';

/** Admin SaaS → Clínicas: comparativo das contas marcadas (só o dono do sistema). */
@Controller('admin/contas')
export class ComparativoContasController {
  constructor(private readonly service: ComparativoContasService) {}

  /** GET /admin/contas/comparativo?ids=a,b&mes=AAAA-MM */
  @Get('comparativo')
  @SuperAdmin()
  comparar(@Query('ids') ids?: string, @Query('mes') mes?: string) {
    return this.service.comparar(ids, mes);
  }
}

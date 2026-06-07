/**
 * Onda 17.32.112 — Anamnese Master (singleton, controlada pelo
 * SUPER_ADMIN). Todos os tenants veem a mesma ficha.
 */
import { Controller, Get, Put, Body, Req } from '@nestjs/common';
import { SuperAdmin } from '../auth/decorators/super-admin.decorator.js';
import { GlobalAnamnesisService } from './global-anamnesis.service.js';

@Controller('global-anamnesis')
export class GlobalAnamnesisController {
  constructor(private readonly service: GlobalAnamnesisService) {}

  /** Qualquer usuario autenticado pode LER (pra UI dos tenants). */
  @Get()
  async get() {
    return this.service.getOrInit();
  }

  /** Apenas SUPER_ADMIN edita. Propaga em todos os tenants. */
  @Put()
  @SuperAdmin()
  async update(@Req() req: any, @Body() body: { schema: any }) {
    const userId = req.user?.sub ?? null;
    return this.service.update(body.schema, userId);
  }
}

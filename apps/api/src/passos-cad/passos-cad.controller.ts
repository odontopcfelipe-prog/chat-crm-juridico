import { BadRequestException, Body, Controller, ForbiddenException, Post, Request, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RequiresPermission } from '../auth/decorators/requires-permission.decorator';
import { pedidoDeLaboratorio } from '../business-type/pedido-de-laboratorio';
import { PedidoDesenhoDto } from './desenho-ia.dto';
import { PassosCadService } from './passos-cad.service';

@UseGuards(JwtAuthGuard)
@Controller('passos-cad')
export class PassosCadController {
  constructor(private readonly passosCad: PassosCadService) {}

  /** Desenhar com IA: só a conta de laboratório, porque cada chamada gasta crédito da chave do sistema. */
  @RequiresPermission('create_evaluation')
  @Post('desenho-ia')
  async desenhar(@Request() req: any, @Body() dto: PedidoDesenhoDto) {
    const tenantId = req.user?.tenant_id;
    if (!tenantId) throw new BadRequestException('tenant_id ausente');
    if (!pedidoDeLaboratorio(req.user)) throw new ForbiddenException('O Passos CAD é só de conta de laboratório.');
    return this.passosCad.desenhar(tenantId, dto);
  }
}

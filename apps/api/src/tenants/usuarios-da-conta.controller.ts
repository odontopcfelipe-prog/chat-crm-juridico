import { Controller, Get, NotFoundException, Param } from '@nestjs/common';
import { SuperAdmin } from '../auth/decorators/super-admin.decorator';
import { ChatGateway } from '../gateway/chat.gateway';
import { PrismaService } from '../prisma/prisma.service';

/** Admin SaaS → Tenants → conta: quem usa a conta e quem está online agora (só o dono do sistema). */
@Controller('admin/contas')
export class UsuariosDaContaController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly gateway: ChatGateway,
  ) {}

  /** GET /admin/contas/:id/usuarios */
  @Get(':id/usuarios')
  @SuperAdmin()
  async listar(@Param('id') id: string) {
    const conta = await this.prisma.tenant.findUnique({
      where: { id },
      select: { id: true, name: true, business_profile: { select: { business_type: true } } },
    });
    if (!conta) throw new NotFoundException('Conta não encontrada.');

    const usuarios = await this.prisma.user.findMany({
      where: { tenant_id: id },
      select: { id: true, name: true, email: true, roles: true, created_at: true },
      orderBy: { name: 'asc' },
    });
    const logins = await this.prisma.accessLog.groupBy({
      by: ['user_id'],
      where: { user_id: { in: usuarios.map((u) => u.id) } },
      _max: { created_at: true },
    });
    const ultimoLogin = new Map(logins.map((l) => [l.user_id, l._max.created_at]));

    return {
      conta: { id: conta.id, name: conta.name, business_type: conta.business_profile?.business_type ?? null },
      usuarios: usuarios.map((u) => ({
        ...u,
        online: this.gateway.isUserOnline(u.id),
        ultimo_login: ultimoLogin.get(u.id) ?? null,
      })),
    };
  }
}

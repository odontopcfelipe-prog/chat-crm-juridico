import { CanActivate, ExecutionContext, Injectable, Logger } from '@nestjs/common';
import { isLab, isLabTenant } from '@crm/shared';
import { PrismaService } from '../prisma/prisma.service';
import { soDoLaboratorio } from '../common/lab-gate.util';

/**
 * F8 do laboratório — guard de CONTROLLER que só deixa passar conta de laboratório
 * (o contrário do LabTenantGuard). Mesma regra de "é laboratório" do LabTenantGuard:
 * o claim bt do token OU a conta na lista de laboratórios (cache de 60 s, que o
 * LabTenantGuard já esquentou na mesma requisição).
 *
 * Conta de clínica e usuário sem conta (SUPER_ADMIN fora de uma conta) recebem 403
 * VERTICAL_DENIED antes de qualquer leitura de registro. É GUARD (e não um if no
 * handler) porque os guards rodam antes do ValidationPipe: a clínica leva 403, nunca
 * o 400 de um corpo inválido.
 *
 * Só usa o PrismaService (módulo @Global): nada a importar, nenhum ciclo de DI.
 */
@Injectable()
export class SoLaboratorioGuard implements CanActivate {
  private readonly logger = new Logger('SoLaboratorioGuard');

  constructor(private readonly prisma: PrismaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const user = context.switchToHttp().getRequest()?.user;
    const tenantId = user?.tenant_id;
    // Sem conta não há laboratório: as fichas sempre se gravam e se leem pela conta do login.
    if (typeof tenantId !== 'string' || tenantId === '') throw soDoLaboratorio();
    if (isLab(user?.bt)) return true;
    if (await isLabTenant(this.prisma, tenantId, (m) => this.logger.warn(m))) return true;
    throw soDoLaboratorio();
  }
}

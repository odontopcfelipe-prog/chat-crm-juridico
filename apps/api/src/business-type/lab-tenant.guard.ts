import { CanActivate, ExecutionContext, ForbiddenException, Injectable, Logger } from '@nestjs/common';
import { getLabTenantIds, isLab } from '@crm/shared';
import { PrismaService } from '../prisma/prisma.service';
import { CODIGO_VERTICAL_NEGADA } from '../common/lab-gate.util';
import { registrarAuditoria } from '../common/utils/audit-log.util';
import { contaInativa, laboratorioCongelado } from './lab-congelamento';
import { chaveDoHandler, rotaDoLaboratorio } from './lab-route-policy';

const UMA_HORA_MS = 3600_000;

/**
 * F2 parte 4 do laboratório — negação POR PADRÃO, por handler ('Classe.metodo').
 *
 * ÚLTIMO APP_GUARD (depois do JwtAuthGuard, que popula o req.user, e dos de
 * papel/permissão/carteira). Para cada requisição:
 *   - sem usuário (rota pública) ou usuário sem conta → passa, sem consulta;
 *   - conta de CLÍNICA → passa. A lista de laboratórios vem do mesmo cache de
 *     60 s que os freios das partes 1-3 já usam (com ele quente, zero consulta);
 *   - conta de LABORATÓRIO:
 *       1. congelada (SUSPENDED/DELETED ou LAB_FREEZE) → 403 TENANT_INACTIVE,
 *          menos o SUPER_ADMIN (como no login: precisa entrar para reativar);
 *       2. handler na política de rotas do laboratório → passa;
 *       3. qualquer outro → 403 VERTICAL_DENIED, com log '[VERTICAL_DENIED]' e
 *          AuditLog (no máximo 1 por conta × handler × hora). Vale também para o
 *          SUPER_ADMIN dentro da conta de laboratório.
 * Handler novo nasce FECHADO para o laboratório até entrar na política.
 */
@Injectable()
export class LabTenantGuard implements CanActivate {
  private readonly logger = new Logger('LabTenantGuard');
  private readonly auditados = new Map<string, number>();

  constructor(private readonly prisma: PrismaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== 'http') return true;
    const user = context.switchToHttp().getRequest()?.user;
    const tenantId = user?.tenant_id;
    if (typeof tenantId !== 'string' || tenantId === '') return true;

    const labs = await getLabTenantIds(this.prisma, (m) => this.logger.warn(m));
    // O token do laboratório já diz o tipo (bt): vale mesmo antes do cache desta
    // réplica ver a conta recém-criada. Token de clínica não tem bt.
    if (!labs.has(tenantId) && !isLab(user.bt)) return true;

    const roles: unknown[] = Array.isArray(user.roles) ? user.roles : [];
    if (!roles.includes('SUPER_ADMIN') && (await laboratorioCongelado(this.prisma, tenantId, (m) => this.logger.warn(m)))) {
      throw contaInativa();
    }

    const chave = chaveDoHandler(context.getClass(), context.getHandler());
    if (rotaDoLaboratorio(chave)) return true;

    this.logger.warn(`[VERTICAL_DENIED] ${tenantId} ${chave}`);
    void this.auditar(tenantId, typeof user.id === 'string' ? user.id : null, chave);
    throw new ForbiddenException({
      message: 'Função não disponível para laboratório.',
      code: CODIGO_VERTICAL_NEGADA,
    });
  }

  /** No máximo 1 linha por conta × handler × hora (por processo). Nunca lança. */
  private async auditar(tenantId: string, userId: string | null, chave: string): Promise<void> {
    const marca = `${tenantId}|${chave}`;
    const agora = Date.now();
    const ultima = this.auditados.get(marca);
    if (ultima !== undefined && agora - ultima < UMA_HORA_MS) return;
    if (this.auditados.size > 5000) this.auditados.clear();
    this.auditados.set(marca, agora);
    await registrarAuditoria(
      this.prisma,
      { tenantId, actorUserId: userId, entity: 'LABORATORIO', entityId: chave, action: CODIGO_VERTICAL_NEGADA },
      this.logger,
    );
  }
}

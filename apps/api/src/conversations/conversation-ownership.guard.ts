import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { conversaForaDaConta } from './conta-da-conversa';

/**
 * Onda 17.61 (segurança/IDOR) — garante que o usuário só opere em conversas do
 * PRÓPRIO tenant. Aplicado no ConversationsController inteiro: roda DEPOIS do
 * JwtAuthGuard global (req.user já populado) e, para qualquer rota com :id,
 * carrega o tenant da conversa e bloqueia se for de outro tenant. Centraliza o
 * isolamento (cobre close, defer, assign, ai-mode, specialty, transferencias,
 * notas e qualquer rota :id futura) sem threadar tenant_id metodo a metodo.
 * SUPER_ADMIN (sem tenant_id) passa — cross-tenant intencional.
 */
@Injectable()
export class ConversationOwnershipGuard implements CanActivate {
  constructor(private prisma: PrismaService) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest();
    const tenantId = req.user?.tenant_id;
    if (!tenantId) return true; // SUPER_ADMIN / contexto sem tenant
    const id = req.params?.id;
    if (!id) return true; // rota sem :id (lista, lead/:leadId, etc.) — escopada à parte
    // Só bloqueia quando a conversa EXISTE e não é da conta: de outro tenant, ou sem
    // conta nem na conversa nem no contato (não revela se a conversa existe;
    // conversa inexistente segue pro handler que devolve 404).
    if (await conversaForaDaConta(this.prisma, id, tenantId)) {
      throw new ForbiddenException('Acesso negado a este recurso');
    }
    return true;
  }
}

import { Injectable, ForbiddenException, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { isAdmin } from '../common/utils/permissions.util';

@Injectable()
export class LeadNotesService {
  constructor(private prisma: PrismaService) {}

  /**
   * Com conta: só lead da própria conta (sem conta ou de outra conta → 403).
   * Sem conta (SUPER_ADMIN) e lead inexistente seguem como antes.
   */
  private async assertLeadDaConta(leadId: string, tenantId?: string) {
    if (!tenantId) return;
    const lead = await this.prisma.lead.findUnique({ where: { id: leadId }, select: { tenant_id: true } });
    if (lead && lead.tenant_id !== tenantId) {
      throw new ForbiddenException('Acesso negado a este recurso');
    }
  }

  async findByLead(leadId: string, tenantId?: string) {
    await this.assertLeadDaConta(leadId, tenantId);
    return this.prisma.leadNote.findMany({
      where: { lead_id: leadId },
      include: {
        user: { select: { id: true, name: true } },
      },
      orderBy: { created_at: 'desc' },
    });
  }

  async create(leadId: string, userId: string, text: string, tenantId?: string) {
    await this.assertLeadDaConta(leadId, tenantId);
    return this.prisma.leadNote.create({
      data: { lead_id: leadId, user_id: userId, text },
      include: {
        user: { select: { id: true, name: true } },
      },
    });
  }

  async delete(noteId: string, userId: string, userRoles: string | string[], tenantId?: string, leadId?: string) {
    const note = await this.prisma.leadNote.findUnique({ where: { id: noteId } });
    if (!note) throw new NotFoundException('Nota não encontrada');
    // A nota tem de ser do lead da URL e, com conta, de lead da própria conta —
    // senão a mesma resposta de nota inexistente.
    if (leadId && note.lead_id !== leadId) throw new NotFoundException('Nota não encontrada');
    if (tenantId) {
      const lead = await this.prisma.lead.findUnique({ where: { id: note.lead_id }, select: { tenant_id: true } });
      if (lead?.tenant_id !== tenantId) throw new NotFoundException('Nota não encontrada');
    }

    // Somente o autor ou ADMIN pode excluir (ADMIN em qualquer posição de roles)
    if (note.user_id !== userId && !isAdmin(userRoles)) {
      throw new ForbiddenException('Sem permissão para excluir esta nota');
    }

    await this.prisma.leadNote.delete({ where: { id: noteId } });
    return { ok: true };
  }
}

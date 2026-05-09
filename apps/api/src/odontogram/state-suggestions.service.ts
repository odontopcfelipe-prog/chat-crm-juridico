import {
  Injectable,
  NotFoundException,
  ForbiddenException,
  BadRequestException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Onda 3.2 — Mapping configuravel POR TENANT de estado clinico -> procedimento.
 *
 * Exemplo: tenant configura "CARIE -> Restauracao em resina (R$ 250)".
 * Quando dentista anota CARIE no dente 36, o front consulta
 * /state-suggestions?state=CARIE e mostra cardzinho "[+] Restauracao R$ 250".
 *
 * Multiplas sugestoes pro mesmo estado sao OK (priority decide ordem).
 */
@Injectable()
export class StateSuggestionsService {
  constructor(private prisma: PrismaService) {}

  async list(tenantId: string, stateFilter?: string) {
    return this.prisma.stateProcedureSuggestion.findMany({
      where: {
        tenant_id: tenantId,
        ...(stateFilter ? { state: stateFilter, active: true } : {}),
      },
      include: {
        procedure: {
          select: {
            id: true,
            name: true,
            base_price: true,
            code_tuss: true,
            duration_minutes: true,
            specialty: { select: { id: true, name: true } },
          },
        },
      },
      orderBy: [{ state: 'asc' }, { priority: 'asc' }],
    });
  }

  async create(
    tenantId: string,
    data: {
      state: string;
      procedure_id: string;
      priority?: number;
      active?: boolean;
    },
  ) {
    // Garantir que o procedimento pertence ao mesmo tenant — previne IDOR
    const procedure = await this.prisma.procedure.findUnique({
      where: { id: data.procedure_id },
      select: { tenant_id: true },
    });
    if (!procedure) throw new NotFoundException('Procedimento nao encontrado');
    if (procedure.tenant_id !== tenantId)
      throw new ForbiddenException('Acesso negado');

    try {
      return await this.prisma.stateProcedureSuggestion.create({
        data: {
          tenant_id: tenantId,
          state: data.state,
          procedure_id: data.procedure_id,
          priority: data.priority ?? 0,
          active: data.active ?? true,
        },
        include: {
          procedure: { select: { id: true, name: true, base_price: true } },
        },
      });
    } catch (err: unknown) {
      // Prisma erro P2002 = unique constraint (mesmo tenant+state+procedure ja existe)
      if ((err as { code?: string })?.code === 'P2002') {
        throw new BadRequestException(
          'Esta sugestao ja existe para este estado/procedimento',
        );
      }
      throw err;
    }
  }

  async update(
    id: string,
    tenantId: string,
    data: {
      state?: string;
      procedure_id?: string;
      priority?: number;
      active?: boolean;
    },
  ) {
    const existing = await this.assertOwnership(id, tenantId);

    if (data.procedure_id && data.procedure_id !== existing.procedure_id) {
      const procedure = await this.prisma.procedure.findUnique({
        where: { id: data.procedure_id },
        select: { tenant_id: true },
      });
      if (!procedure)
        throw new NotFoundException('Procedimento nao encontrado');
      if (procedure.tenant_id !== tenantId)
        throw new ForbiddenException('Acesso negado');
    }

    return this.prisma.stateProcedureSuggestion.update({
      where: { id },
      data,
      include: {
        procedure: { select: { id: true, name: true, base_price: true } },
      },
    });
  }

  async remove(id: string, tenantId: string) {
    await this.assertOwnership(id, tenantId);
    await this.prisma.stateProcedureSuggestion.delete({ where: { id } });
    return { ok: true };
  }

  private async assertOwnership(id: string, tenantId: string) {
    const row = await this.prisma.stateProcedureSuggestion.findUnique({
      where: { id },
      select: { id: true, tenant_id: true, procedure_id: true },
    });
    if (!row) throw new NotFoundException('Sugestao nao encontrada');
    if (row.tenant_id !== tenantId)
      throw new ForbiddenException('Acesso negado');
    return row;
  }
}

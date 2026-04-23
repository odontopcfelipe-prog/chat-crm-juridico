import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

/**
 * InternService — dashboard do estagiário.
 *
 * STUBBED Fase 0.2: estrutura original dependia de CasePetition / LegalCase
 * (peticionamento jurídico). A Fase 2/3 vai reimplementar com base no fluxo
 * odontológico (tarefas clínicas, anotações em MedicalRecord, etc).
 *
 * Por enquanto retornamos dashboards vazios — assinaturas preservadas.
 */
@Injectable()
export class InternService {
  private readonly logger = new Logger(InternService.name);

  constructor(private readonly prisma: PrismaService) {}

  async getDashboard(userId: string, _tenantId?: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        name: true,
        supervisors: { select: { id: true, name: true } },
      },
    });
    return {
      internName: user?.name || '',
      supervisors: user?.supervisors || [],
      pending: [],
      inReview: [],
      corrections: [],
      completedToday: [],
      stats: {
        pendingCount: 0,
        inReviewCount: 0,
        correctionsCount: 0,
        completedTodayCount: 0,
        approvalRate: 0,
      },
    };
  }

  async getBadgeCount(_userId: string) {
    return { count: 0 };
  }

  async getKanbanDashboard(userId: string, _tenantId?: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        name: true,
        supervisors: { select: { id: true, name: true } },
      },
    });
    return {
      internName: user?.name || '',
      supervisors: user?.supervisors || [],
      columns: {
        RASCUNHO: [] as any[],
        EM_REVISAO: [] as any[],
        APROVADA: [] as any[],
        PROTOCOLADA: [] as any[],
      },
      stats: {
        total: 0,
        rascunho: 0,
        emRevisao: 0,
        aprovada: 0,
        protocolada: 0,
        correctionsCount: 0,
        approvalRate: 0,
      },
    };
  }
}

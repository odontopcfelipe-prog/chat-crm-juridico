/**
 * Onda 17.58 — Badges de contagem ao vivo dos cards "MÓDULOS" da home por papel.
 *
 * Um endpoint agregado: dado o setor, calcula só os badges que aquele papel mostra
 * (cada action do sectors.config tem um `badgeKey`). Valor já vem pré-formatado
 * ("Hoje 1", "2.140", "9 fila"). Cada query é isolada (safe) — badge que falha
 * simplesmente some, sem derrubar a home. Reaproveita os corpos de query do
 * HomeHighlightsService.
 */
import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';

export interface ModuleBadge {
  value: string;
  tone?: 'violet' | 'emerald' | 'amber' | 'sky' | 'rose';
}

export interface ModuleBadgesResponse {
  badges: Record<string, ModuleBadge>;
}

// Quais badges cada setor precisa (espelha as actions de sectors.config.ts).
// Evita calcular contagem que nenhum card vai mostrar.
const SECTOR_BADGES: Record<string, string[]> = {
  recepcao:   ['agenda_today', 'patients_total', 'whatsapp_open', 'returns_pending', 'proposals_sent'],
  dentista:   ['agenda_today', 'patients_total', 'proposals_sent'],
  acd_asb:    ['agenda_today', 'patients_total'],
  crc:        ['crc_queue', 'marketing_active', 'returns_pending', 'proposals_sent', 'whatsapp_open'],
  financeiro: ['financeiro_today', 'proposals_sent', 'reports_pct'],
  admin:      ['agenda_today', 'patients_total', 'crc_queue', 'financeiro_today', 'team_count', 'marketing_active', 'reports_pct'],
};

@Injectable()
export class HomeModuleBadgesService {
  private readonly logger = new Logger(HomeModuleBadgesService.name);
  constructor(private readonly prisma: PrismaService) {}

  async forSector(tenantId: string, sector: string): Promise<ModuleBadgesResponse> {
    const keys = SECTOR_BADGES[sector] ?? SECTOR_BADGES.admin;
    const entries = await Promise.all(
      keys.map(async (key) => [key, await this.compute(key, tenantId)] as const),
    );
    const badges: Record<string, ModuleBadge> = {};
    for (const [key, badge] of entries) {
      if (badge) badges[key] = badge;
    }
    return { badges };
  }

  private async compute(key: string, tenantId: string): Promise<ModuleBadge | null> {
    switch (key) {
      case 'agenda_today': {
        const n = await this.safe('agenda_today', () =>
          this.prisma.calendarEvent.count({ where: { tenant_id: tenantId, start_at: this.today() } }));
        return n == null ? null : { value: `Hoje ${n}`, tone: 'violet' };
      }
      case 'patients_total': {
        const n = await this.safe('patients_total', () =>
          this.prisma.patient.count({ where: { tenant_id: tenantId } }));
        return n == null ? null : { value: n.toLocaleString('pt-BR'), tone: 'sky' };
      }
      case 'crc_queue': {
        const n = await this.safe('crc_queue', () =>
          this.prisma.conversation.count({ where: { tenant_id: tenantId, status: { in: ['NEW', 'OPEN', 'NOVO', 'NOVA'] } } }));
        return n == null ? null : { value: `${n} fila`, tone: 'rose' };
      }
      case 'whatsapp_open': {
        const n = await this.safe('whatsapp_open', () =>
          this.prisma.conversation.count({ where: { tenant_id: tenantId, status: { in: ['NEW', 'OPEN', 'NOVO', 'NOVA'] } } }));
        return n == null ? null : { value: `${n}`, tone: 'amber' };
      }
      case 'marketing_active': {
        const n = await this.safe('marketing_active', () =>
          this.prisma.followupEnrollment.count({ where: { status: 'ATIVO', lead: { tenant_id: tenantId } } }));
        return n == null ? null : { value: `${n} ativas`, tone: 'amber' };
      }
      case 'team_count': {
        const n = await this.safe('team_count', () =>
          this.prisma.user.count({ where: { tenant_id: tenantId } }));
        return n == null ? null : { value: `${n}`, tone: 'sky' };
      }
      case 'proposals_sent': {
        const n = await this.safe('proposals_sent', () =>
          this.prisma.quote.count({ where: { status: 'SENT', deleted_at: null, archived_at: null, patient: { tenant_id: tenantId } } }));
        return n == null ? null : { value: `${n}`, tone: 'sky' };
      }
      case 'returns_pending': {
        const n = await this.safe('returns_pending', () =>
          this.prisma.returnAlert.count({ where: { tenant_id: tenantId, status: 'PENDENTE' } }));
        return n == null ? null : { value: `${n}`, tone: 'rose' };
      }
      case 'financeiro_today': {
        const agg = await this.safe('financeiro_today', () =>
          this.prisma.paymentGatewayCharge.aggregate({
            where: { tenant_id: tenantId, paid_at: this.today(), status: { in: ['RECEIVED', 'CONFIRMED'] } },
            _sum: { amount: true },
          }));
        if (agg == null) return null;
        const recebido = Number(agg?._sum?.amount ?? 0);
        return { value: recebido > 0 ? this.brl(recebido) : 'Caixa', tone: 'emerald' };
      }
      case 'reports_pct': {
        const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
        const range = { gte: weekAgo, lte: new Date() };
        const total = await this.safe('reports_pct.total', () =>
          this.prisma.calendarEvent.count({ where: { tenant_id: tenantId, start_at: range } }));
        if (total == null) return null;
        const done = (await this.safe('reports_pct.done', () =>
          this.prisma.calendarEvent.count({
            where: { tenant_id: tenantId, start_at: range, status: { in: ['CONCLUIDO', 'COMPLETED', 'DONE'] } },
          }))) ?? 0;
        const pct = total > 0 ? Math.round((done / total) * 100) : 0;
        return { value: `${pct}%`, tone: 'violet' };
      }
      default:
        return null;
    }
  }

  private today() {
    const start = new Date(); start.setHours(0, 0, 0, 0);
    const end = new Date(); end.setHours(23, 59, 59, 999);
    return { gte: start, lte: end };
  }

  private async safe<T>(name: string, fn: () => Promise<T>): Promise<T | null> {
    try {
      return await fn();
    } catch (err: any) {
      this.logger.warn(`[HOME-BADGES] ${name} falhou: ${err?.message}`);
      return null;
    }
  }

  private brl(n: number): string {
    if (n >= 1000) return `R$ ${(n / 1000).toFixed(1).replace('.', ',')}k`;
    return `R$ ${n.toFixed(0)}`;
  }
}

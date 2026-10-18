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
import { ownPatientsWhere } from '../auth/patient-scope.js';

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
  // Out/2026 — quadrantes do dentista com dados SÓ dele (agenda, atendimentos a
  // confirmar, carteira, em tratamento e a própria comissão) — nada da clínica toda.
  dentista:   ['my_agenda_today', 'my_pending_validation', 'my_patients_total', 'my_patients_in_treatment', 'my_commission_available'],
  acd_asb:    ['agenda_today', 'patients_total'],
  crc:        ['crc_queue', 'marketing_active', 'returns_pending', 'proposals_sent', 'whatsapp_open'],
  financeiro: ['financeiro_today', 'proposals_sent', 'reports_pct'],
  admin:      ['agenda_today', 'patients_total', 'crc_queue', 'financeiro_today', 'team_count', 'marketing_active', 'reports_pct'],
};

@Injectable()
export class HomeModuleBadgesService {
  private readonly logger = new Logger(HomeModuleBadgesService.name);
  constructor(private readonly prisma: PrismaService) {}

  async forSector(tenantId: string, sector: string, userId?: string): Promise<ModuleBadgesResponse> {
    const keys = SECTOR_BADGES[sector] ?? SECTOR_BADGES.admin;
    const entries = await Promise.all(
      keys.map(async (key) => [key, await this.compute(key, tenantId, userId)] as const),
    );
    const badges: Record<string, ModuleBadge> = {};
    for (const [key, badge] of entries) {
      if (badge) badges[key] = badge;
    }
    return { badges };
  }

  private async compute(key: string, tenantId: string, userId?: string): Promise<ModuleBadge | null> {
    switch (key) {
      case 'my_agenda_today': {
        if (!userId) return null;
        // Agenda é naive-UTC (hora de Maceió nos campos UTC): "hoje" = dia de
        // Maceió (Date.now() - 3h) lido em UTC. Desmarcados não contam.
        const n = await this.safe('my_agenda_today', () =>
          this.prisma.calendarEvent.count({
            where: {
              tenant_id: tenantId,
              start_at: this.maceioToday(),
              status: { notIn: ['CANCELADO'] },
              OR: [
                { assigned_user_id: userId },
                { assigned_user_id: null, created_by_id: userId },
              ],
            },
          }));
        return n == null ? null : { value: `Hoje ${n}`, tone: 'violet' };
      }
      case 'my_pending_validation': {
        if (!userId) return null;
        // Mesmo critério da tela Validações (listPendingValidation, últimos 30 dias),
        // mas "agora" no naive-UTC — consulta das próximas horas não conta.
        const naiveNow = new Date(Date.now() - 3 * 60 * 60 * 1000);
        const n = await this.safe('my_pending_validation', () =>
          this.prisma.calendarEvent.count({
            where: {
              tenant_id: tenantId,
              assigned_user_id: userId,
              type: { in: ['CONSULTA', 'PROCEDIMENTO', 'RETORNO'] },
              validated_at: null,
              start_at: { gte: new Date(naiveNow.getTime() - 30 * 24 * 60 * 60 * 1000), lte: naiveNow },
              status: { notIn: ['CANCELADO', 'ADIADO', 'NO_SHOW'] },
            },
          }));
        if (n == null) return null;
        return { value: n === 0 ? 'Em dia' : `${n} a confirmar`, tone: n === 0 ? 'emerald' : 'amber' };
      }
      case 'my_patients_total': {
        if (!userId) return null;
        const n = await this.safe('my_patients_total', () =>
          this.prisma.patient.count({ where: { tenant_id: tenantId, ...ownPatientsWhere(userId) } }));
        return n == null ? null : { value: n.toLocaleString('pt-BR'), tone: 'sky' };
      }
      case 'my_patients_in_treatment': {
        if (!userId) return null;
        const n = await this.safe('my_patients_in_treatment', () =>
          this.prisma.patient.count({
            where: {
              tenant_id: tenantId,
              treatment_plans: { some: { status: 'ACTIVE' } },
              AND: [ownPatientsWhere(userId)],
            },
          }));
        return n == null ? null : { value: n.toLocaleString('pt-BR'), tone: 'emerald' };
      }
      case 'my_commission_available': {
        if (!userId) return null;
        // A comissão é do próprio dentista (pode ver o valor). "A receber" =
        // DISPONIVEL (paciente já pagou, clínica ainda não repassou).
        const agg = await this.safe('my_commission_available', () =>
          this.prisma.commission.aggregate({
            where: { tenant_id: tenantId, professional_user_id: userId, status: 'DISPONIVEL' },
            _sum: { amount: true },
          }));
        if (agg == null) return null;
        const total = Number(agg._sum.amount ?? 0);
        return {
          value: total.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL', maximumFractionDigits: 0 }),
          tone: 'emerald',
        };
      }
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

  /** Dia de Maceió no modelo naive-UTC da agenda. */
  private maceioToday() {
    const now = new Date(Date.now() - 3 * 60 * 60 * 1000);
    const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    const end = new Date(start.getTime() + 24 * 60 * 60 * 1000 - 1);
    return { gte: start, lte: end };
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

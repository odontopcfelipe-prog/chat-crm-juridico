/**
 * Onda 17.32.126 — Chips do bloco em destaque da home por setor.
 *
 * Cada metodo retorna { chips, cta? }. Try/catch isolado por query
 * pra que falha de uma nao derrube as outras.
 */
import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';

export interface HomeChip {
  value: string | number;
  label: string;
  tone?: 'violet' | 'emerald' | 'amber' | 'sky' | 'rose';
}

export interface HighlightResponse {
  chips: HomeChip[];
  cta?: { label: string; href: string };
}

@Injectable()
export class HomeHighlightsService {
  private readonly logger = new Logger(HomeHighlightsService.name);
  constructor(private readonly prisma: PrismaService) {}

  async forSector(tenantId: string, sector: string, userId?: string): Promise<HighlightResponse> {
    switch (sector) {
      case 'recepcao':    return this.forRecepcao(tenantId);
      case 'dentista':    return this.forDentista(tenantId, userId);
      case 'acd_asb':     return this.forAcdAsb(tenantId);
      case 'crc':         return this.forCrc(tenantId);
      case 'financeiro':  return this.forFinanceiro(tenantId);
      case 'admin':       return this.forAdmin(tenantId);
      default:            return { chips: [] };
    }
  }

  // ─── helpers ─────────────────────────────────────────────────────
  private todayBounds() {
    const start = new Date(); start.setHours(0, 0, 0, 0);
    const end   = new Date(); end.setHours(23, 59, 59, 999);
    return { start, end };
  }

  private async safe<T>(name: string, fn: () => Promise<T>, fallback: T): Promise<T> {
    try {
      return await fn();
    } catch (err: any) {
      this.logger.warn(`[HOME-HIGHLIGHTS] ${name} falhou: ${err?.message}`);
      return fallback;
    }
  }

  // ─── Recepcao ────────────────────────────────────────────────────
  private async forRecepcao(tenantId: string): Promise<HighlightResponse> {
    const { start, end } = this.todayBounds();

    const totalHoje = await this.safe('recepcao.totalHoje',
      () => this.prisma.calendarEvent.count({
        where: { tenant_id: tenantId, start_at: { gte: start, lte: end } },
      }), 0);

    const aConfirmar = await this.safe('recepcao.aConfirmar',
      () => this.prisma.calendarEvent.count({
        where: {
          tenant_id: tenantId, start_at: { gte: start, lte: end },
          status: { in: ['SCHEDULED', 'AGENDADO', 'PENDING'] },
        },
      }), 0);

    // Encaixes "livres" = aproximação simples: slots nao ocupados ate fim do dia
    // Pra MVP vamos so contar quantos eventos restantes ate fim do dia
    const now = new Date();
    const restantes = await this.safe('recepcao.restantes',
      () => this.prisma.calendarEvent.count({
        where: { tenant_id: tenantId, start_at: { gte: now, lte: end } },
      }), 0);

    return {
      chips: [
        { value: totalHoje,    label: 'consultas hoje',    tone: 'violet' },
        { value: aConfirmar,   label: 'a confirmar',       tone: 'amber'  },
        { value: restantes,    label: 'restantes hoje',    tone: 'emerald' },
      ],
      cta: { label: 'Abrir agenda do dia', href: '/atendimento/agenda' },
    };
  }

  // ─── Dentista ────────────────────────────────────────────────────
  private async forDentista(tenantId: string, userId?: string): Promise<HighlightResponse> {
    const { start, end } = this.todayBounds();
    const now = new Date();

    const meusHoje = await this.safe('dentista.meusHoje',
      () => this.prisma.calendarEvent.count({
        where: {
          tenant_id: tenantId,
          start_at: { gte: start, lte: end },
          ...(userId ? { user_id: userId } : {}),
        },
      }), 0);

    const proxima = await this.safe('dentista.proxima',
      () => this.prisma.calendarEvent.findFirst({
        where: {
          tenant_id: tenantId,
          start_at: { gte: now, lte: end },
          ...(userId ? { user_id: userId } : {}),
        },
        orderBy: { start_at: 'asc' },
        select:  { start_at: true },
      }), null);

    const proximaTxt = proxima?.start_at
      ? this.minutesUntil(proxima.start_at)
      : '—';

    // Quantos pacientes ativos sem anamnese cadastrada
    const semAnamnese = await this.safe('dentista.semAnamnese',
      () => this.prisma.patient.count({
        where: {
          tenant_id: tenantId,
          anamneses: { none: {} },
        },
      }), 0);

    return {
      chips: [
        { value: meusHoje,    label: 'pacientes hoje',  tone: 'violet'  },
        { value: proximaTxt,  label: 'proxima consulta', tone: 'emerald' },
        { value: semAnamnese, label: 'sem anamnese',     tone: 'amber'   },
      ],
      cta: { label: 'Ver minha agenda', href: '/atendimento/agenda' },
    };
  }

  // ─── ACD/ASB ─────────────────────────────────────────────────────
  private async forAcdAsb(tenantId: string): Promise<HighlightResponse> {
    const { start, end } = this.todayBounds();
    const now = new Date();

    const consultasHoje = await this.safe('acd.consultasHoje',
      () => this.prisma.calendarEvent.count({
        where: { tenant_id: tenantId, start_at: { gte: start, lte: end } },
      }), 0);

    const proxima = await this.safe('acd.proxima',
      () => this.prisma.calendarEvent.findFirst({
        where: { tenant_id: tenantId, start_at: { gte: now, lte: end } },
        orderBy: { start_at: 'asc' },
        select:  { start_at: true },
      }), null);
    const proximaTxt = proxima?.start_at ? this.minutesUntil(proxima.start_at) : '—';

    // Onda 17.32.127 — "Salas pra esterilizar" usa proxy: consultas
    // ja concluidas hoje. Cada consulta concluida = 1 sala pra
    // higienizar. Aproximacao util ate ter modelo Room.status.
    const concluidasHoje = await this.safe('acd.concluidasHoje',
      () => this.prisma.calendarEvent.count({
        where: {
          tenant_id: tenantId,
          start_at: { gte: start, lte: end },
          status:   { in: ['CONCLUIDO', 'COMPLETED', 'DONE'] },
        },
      }), 0);

    return {
      chips: [
        { value: consultasHoje,  label: 'consultas hoje',   tone: 'violet'  },
        { value: proximaTxt,     label: 'proxima consulta', tone: 'emerald' },
        { value: concluidasHoje, label: 'esterilizar (concluidas)', tone: 'amber' },
      ],
      cta: { label: 'Ver agenda do dia', href: '/atendimento/agenda' },
    };
  }

  // ─── CRC ─────────────────────────────────────────────────────────
  private async forCrc(tenantId: string): Promise<HighlightResponse> {
    const novas = await this.safe('crc.novas',
      () => this.prisma.conversation.count({
        where: {
          tenant_id: tenantId,
          status: { in: ['NEW', 'OPEN', 'NOVO', 'NOVA'] },
        },
      }), 0);

    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
    const semResposta = await this.safe('crc.semResposta',
      () => this.prisma.conversation.count({
        where: {
          tenant_id: tenantId,
          last_message_at: { lte: twoHoursAgo },
          status: { not: 'CLOSED' },
        },
      }), 0);

    // Onda 17.32.127 — Follow-ups reais: enrollments ATIVOs cuja
    // proxima mensagem ja venceu (next_send_at <= now). Filtra por
    // tenant via Lead (FollowupEnrollment nao tem tenant_id direto).
    const followUps = await this.safe('crc.followUps',
      () => this.prisma.followupEnrollment.count({
        where: {
          status: 'ATIVO',
          next_send_at: { lte: new Date() },
          lead: { tenant_id: tenantId },
        },
      }), 0);

    return {
      chips: [
        { value: novas,       label: 'novas conversas',  tone: 'violet'  },
        { value: semResposta, label: 'sem resposta +2h', tone: 'amber'   },
        { value: followUps,   label: 'follow-ups pendentes', tone: 'rose' },
      ],
      cta: { label: 'Abrir WhatsApp', href: '/atendimento/whatsapp' },
    };
  }

  // ─── Financeiro ──────────────────────────────────────────────────
  private async forFinanceiro(tenantId: string): Promise<HighlightResponse> {
    const { start, end } = this.todayBounds();
    const PAID_STATUSES = ['RECEIVED', 'CONFIRMED'];
    const TERMINAL_STATUSES = ['RECEIVED', 'CONFIRMED', 'CANCELLED', 'DELETED', 'REFUNDED'];

    const recebidoAgg = await this.safe('fin.recebido',
      () => this.prisma.paymentGatewayCharge.aggregate({
        where: {
          tenant_id: tenantId,
          paid_at:   { gte: start, lte: end },
          status:    { in: PAID_STATUSES },
        },
        _sum: { amount: true },
      }), { _sum: { amount: null } });
    const recebido = Number(recebidoAgg?._sum?.amount ?? 0);

    const vencendoAgg = await this.safe('fin.vencendo',
      () => this.prisma.paymentGatewayCharge.aggregate({
        where: {
          tenant_id: tenantId,
          due_date: { gte: start, lte: end },
          status:   { notIn: TERMINAL_STATUSES },
        },
        _sum: { amount: true },
      }), { _sum: { amount: null } });
    const vencendo = Number(vencendoAgg?._sum?.amount ?? 0);

    // Aproximacao de "inadimplentes": cobrancas atrasadas distintas
    // por treatment_plan_id (cada plan = 1 paciente cobrando).
    const inadimplentes = await this.safe('fin.inadimplentes',
      () => this.prisma.paymentGatewayCharge.findMany({
        where: {
          tenant_id: tenantId,
          due_date: { lt: start },
          status:   { notIn: TERMINAL_STATUSES },
          treatment_plan_id: { not: null },
        },
        select: { treatment_plan_id: true },
        distinct: ['treatment_plan_id'],
      }).then((rs: { treatment_plan_id: string | null }[]) => rs.length), 0);

    return {
      chips: [
        { value: this.brl(recebido),  label: 'recebido hoje', tone: 'emerald' },
        { value: this.brl(vencendo),  label: 'vencendo hoje', tone: 'amber'   },
        { value: inadimplentes,       label: 'inadimplentes', tone: 'rose'    },
      ],
      cta: { label: 'Abrir financeiro', href: '/atendimento/financeiro' },
    };
  }

  // ─── Admin ───────────────────────────────────────────────────────
  private async forAdmin(tenantId: string): Promise<HighlightResponse> {
    const { start, end } = this.todayBounds();

    // Total de consultas e quantas estao concluidas
    const totalSemana = await this.safe('admin.totalSemana',
      () => this.prisma.calendarEvent.count({
        where: {
          tenant_id: tenantId,
          start_at:  { gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000), lte: new Date() },
        },
      }), 0);

    const concluidasSemana = await this.safe('admin.concluidasSemana',
      () => this.prisma.calendarEvent.count({
        where: {
          tenant_id: tenantId,
          start_at:  { gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000), lte: new Date() },
          status:    { in: ['CONCLUIDO', 'COMPLETED', 'DONE'] },
        },
      }), 0);

    const comparecimento = totalSemana > 0
      ? Math.round((concluidasSemana / totalSemana) * 100)
      : 0;

    // Cobrancas vencidas (PaymentGatewayCharge, status nao-terminal)
    const TERMINAL_STATUSES = ['RECEIVED', 'CONFIRMED', 'CANCELLED', 'DELETED', 'REFUNDED'];
    const vencidas = await this.safe('admin.vencidas',
      () => this.prisma.paymentGatewayCharge.count({
        where: {
          tenant_id: tenantId,
          due_date:  { lt: start },
          status:    { notIn: TERMINAL_STATUSES },
        },
      }), 0);

    // Consultas marcadas hoje
    const consultasHoje = await this.safe('admin.consultasHoje',
      () => this.prisma.calendarEvent.count({
        where: { tenant_id: tenantId, start_at: { gte: start, lte: end } },
      }), 0);

    return {
      chips: [
        { value: consultasHoje,        label: 'consultas hoje',  tone: 'violet'  },
        { value: `${comparecimento}%`, label: 'comparecimento 7d', tone: 'emerald' },
        { value: vencidas,             label: 'cobrancas atrasadas', tone: 'rose' },
      ],
      cta: { label: 'Ver indicadores', href: '/atendimento/relatorios' },
    };
  }

  // ─── format helpers ──────────────────────────────────────────────
  private brl(n: number): string {
    if (n === 0) return 'R$ 0';
    if (n >= 1000) return `R$ ${(n / 1000).toFixed(1).replace('.', ',')}k`;
    return `R$ ${n.toFixed(0)}`;
  }

  private minutesUntil(d: Date | string): string {
    const date = typeof d === 'string' ? new Date(d) : d;
    const diff = date.getTime() - Date.now();
    const mins = Math.round(diff / (60 * 1000));
    if (mins < 0)   return 'agora';
    if (mins < 60)  return `${mins}min`;
    const hours = Math.floor(mins / 60);
    return `${hours}h${mins % 60 ? ` ${mins % 60}m` : ''}`;
  }
}

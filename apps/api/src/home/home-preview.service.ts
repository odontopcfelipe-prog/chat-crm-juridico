/**
 * Onda 17.52 — Prévia dos balões da home.
 *
 * Cada balão pode pedir uma prévia (top ~5 itens reais do módulo) que aparece
 * expandida ao clicar, antes de abrir a tela cheia. Retorna sempre
 * { key, items: [{title, subtitle}], cta? }. Try/catch isolado por query
 * (helper safe) pra que erro de uma chave nunca derrube a home.
 *
 * Fases: começa por crc / return-alerts / propostas / whatsapp. Chave
 * desconhecida -> items vazios (o balão simplesmente navega).
 */
import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';

export interface PreviewItem {
  title: string;
  subtitle: string;
}

export interface PreviewResponse {
  key: string;
  items: PreviewItem[];
  cta?: { label: string; href: string };
}

@Injectable()
export class HomePreviewService {
  private readonly logger = new Logger(HomePreviewService.name);
  constructor(private readonly prisma: PrismaService) {}

  async getPreview(tenantId: string, key: string): Promise<PreviewResponse> {
    switch (key) {
      case 'crc':           return this.crc(tenantId);
      case 'return-alerts': return this.returnAlerts(tenantId);
      case 'propostas':     return this.propostas(tenantId);
      case 'whatsapp':      return this.whatsapp(tenantId);
      default:              return { key, items: [] };
    }
  }

  // ─── helpers ─────────────────────────────────────────────────────
  private async safe(name: string, fn: () => Promise<PreviewItem[]>): Promise<PreviewItem[]> {
    try {
      return await fn();
    } catch (err: any) {
      this.logger.warn(`[HOME-PREVIEW] ${name} falhou: ${err?.message}`);
      return [];
    }
  }

  private relTime(d: Date | null | undefined): string {
    if (!d) return '';
    const min = Math.floor((Date.now() - new Date(d).getTime()) / 60000);
    if (min < 1) return 'agora';
    if (min < 60) return `há ${min}min`;
    const h = Math.floor(min / 60);
    if (h < 24) return `há ${h}h`;
    return `há ${Math.floor(h / 24)}d`;
  }

  private fmtDate(d: Date | null | undefined): string {
    if (!d) return '';
    const dt = new Date(d);
    return `${String(dt.getDate()).padStart(2, '0')}/${String(dt.getMonth() + 1).padStart(2, '0')}`;
  }

  private brl(n: number): string {
    return n.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
  }

  private trunc(s: string, n: number): string {
    return s.length > n ? `${s.slice(0, n - 1)}…` : s;
  }

  private join(...parts: (string | undefined | null)[]): string {
    return parts.filter(Boolean).join(' · ');
  }

  // ─── Fila CRC (Lead) ─────────────────────────────────────────────
  private async crc(tenantId: string): Promise<PreviewResponse> {
    const items = await this.safe('crc', async () => {
      const leads = await this.prisma.lead.findMany({
        where: { tenant_id: tenantId, stage: { not: 'PERDIDO' }, is_client: false },
        include: { current_stage: { select: { name: true } } },
        orderBy: { stage_entered_at: 'asc' },
        take: 5,
      });
      return leads.map((l) => ({
        title: l.name || l.phone || 'Lead sem nome',
        subtitle: this.join(l.current_stage?.name || l.stage, this.relTime(l.stage_entered_at)),
      }));
    });
    return { key: 'crc', items, cta: { label: 'Abrir CRC', href: '/atendimento/crm' } };
  }

  // ─── Retornos (ReturnAlert) ──────────────────────────────────────
  private async returnAlerts(tenantId: string): Promise<PreviewResponse> {
    const items = await this.safe('return-alerts', async () => {
      const alerts = await this.prisma.returnAlert.findMany({
        where: { tenant_id: tenantId, status: 'PENDENTE' },
        orderBy: { scheduled_for: 'asc' },
        take: 5,
        include: { patient: { select: { name: true } } },
      });
      return alerts.map((a) => ({
        title: a.patient?.name || 'Paciente',
        subtitle: a.reason || (a.scheduled_for ? `Previsto: ${this.fmtDate(a.scheduled_for)}` : 'Retorno pendente'),
      }));
    });
    return { key: 'return-alerts', items, cta: { label: 'Abrir retornos', href: '/atendimento/return-alerts' } };
  }

  // ─── Propostas (Quote status=SENT) ───────────────────────────────
  private async propostas(tenantId: string): Promise<PreviewResponse> {
    const items = await this.safe('propostas', async () => {
      const quotes = await this.prisma.quote.findMany({
        where: { status: 'SENT', deleted_at: null, archived_at: null, patient: { tenant_id: tenantId } },
        orderBy: { sent_at: 'desc' },
        take: 5,
        select: { quote_number: true, total_value: true, sent_at: true, patient: { select: { name: true } } },
      });
      return quotes.map((q) => ({
        title: q.patient?.name || `Orçamento #${q.quote_number}`,
        subtitle: this.join(this.brl(Number(q.total_value)), q.sent_at ? `enviado ${this.relTime(q.sent_at)}` : null),
      }));
    });
    return { key: 'propostas', items, cta: { label: 'Abrir propostas', href: '/atendimento/orcamentos?status=SENT' } };
  }

  // ─── WhatsApp (Conversation) ─────────────────────────────────────
  private async whatsapp(tenantId: string): Promise<PreviewResponse> {
    const items = await this.safe('whatsapp', async () => {
      const convs = await this.prisma.conversation.findMany({
        where: { tenant_id: tenantId, lead: { stage: { notIn: ['PERDIDO', 'FINALIZADO'] } } },
        orderBy: { last_message_at: 'desc' },
        take: 5,
        select: {
          status: true,
          ai_mode: true,
          assigned_user_id: true,
          lead: { select: { name: true, phone: true } },
          messages: { orderBy: { created_at: 'desc' }, take: 1, select: { text: true } },
        },
      });
      return convs.map((c) => {
        const name = c.lead?.name || c.lead?.phone || 'Desconhecido';
        const st =
          c.status === 'FECHADO' ? 'Fechado' :
          c.status === 'ADIADO'  ? 'Adiado' :
          c.ai_mode              ? 'IA respondendo' :
          c.assigned_user_id     ? 'Em atendimento' :
                                   'Aguardando resposta';
        const last = c.messages?.[0]?.text;
        return { title: name, subtitle: last ? this.join(st, this.trunc(last, 38)) : st };
      });
    });
    return { key: 'whatsapp', items, cta: { label: 'Abrir WhatsApp', href: '/atendimento' } };
  }
}

/**
 * WaitlistService — Lista de Espera (Fase 19)
 *
 * Gerencia entradas de leads aguardando vaga na agenda. Quando um
 * CalendarEvent é cancelado/adiado, o worker chama `findMatchesForSlot()`
 * pra encontrar entradas compatíveis e dispara notificação WhatsApp.
 *
 * Operador também pode gerenciar manualmente em /atendimento/waitlist
 * (criar entrada, marcar como notificado, agendar, descartar).
 */
import { Injectable, NotFoundException, BadRequestException, Logger, Inject, forwardRef } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { WhatsappService } from '../whatsapp/whatsapp.service';

export interface CreateWaitlistDto {
  lead_id: string;
  dentist_id?: string | null;
  preferred_date?: string | null; // ISO date
  preferred_weekday?: number | null; // 0-6
  preferred_period?: 'MANHA' | 'TARDE' | 'NOITE' | 'QUALQUER' | null;
  earliest_date?: string | null; // ISO date
  notes?: string | null;
}

export interface UpdateWaitlistDto extends Partial<CreateWaitlistDto> {
  status?: 'AGUARDANDO' | 'NOTIFICADO' | 'AGENDADO' | 'DESISTIU' | 'EXPIROU';
}

@Injectable()
export class WaitlistService {
  private readonly logger = new Logger(WaitlistService.name);

  constructor(
    private prisma: PrismaService,
    @Inject(forwardRef(() => WhatsappService)) private whatsapp: WhatsappService,
  ) {}

  async list(tenantId?: string, status?: string) {
    return (this.prisma as any).waitlistEntry.findMany({
      where: {
        ...(tenantId ? { tenant_id: tenantId } : {}),
        ...(status ? { status } : {}),
      },
      include: {
        lead: { select: { id: true, name: true, phone: true } },
        dentist: { select: { id: true, name: true } },
      },
      orderBy: { created_at: 'asc' }, // FIFO — primeiros que entraram, primeiros notificados
    });
  }

  async findOne(id: string, tenantId?: string) {
    const entry = await (this.prisma as any).waitlistEntry.findFirst({
      where: { id, ...(tenantId ? { tenant_id: tenantId } : {}) },
      include: {
        lead: { select: { id: true, name: true, phone: true } },
        dentist: { select: { id: true, name: true } },
      },
    });
    if (!entry) throw new NotFoundException('Entrada não encontrada');
    return entry;
  }

  async create(data: CreateWaitlistDto, tenantId?: string) {
    if (!data.lead_id) throw new BadRequestException('lead_id é obrigatório');

    // Evita duplicatas: lead já tem entrada AGUARDANDO/NOTIFICADO?
    const existing = await (this.prisma as any).waitlistEntry.findFirst({
      where: {
        lead_id: data.lead_id,
        status: { in: ['AGUARDANDO', 'NOTIFICADO'] },
      },
    });
    if (existing) {
      throw new BadRequestException(
        'Lead já tem entrada ativa na lista de espera. Atualize a existente em vez de criar nova.',
      );
    }

    return (this.prisma as any).waitlistEntry.create({
      data: {
        tenant_id: tenantId ?? null,
        lead_id: data.lead_id,
        dentist_id: data.dentist_id ?? null,
        preferred_date: data.preferred_date ? new Date(data.preferred_date) : null,
        preferred_weekday: data.preferred_weekday ?? null,
        preferred_period: data.preferred_period ?? null,
        earliest_date: data.earliest_date ? new Date(data.earliest_date) : null,
        notes: data.notes ?? null,
        status: 'AGUARDANDO',
      },
      include: {
        lead: { select: { id: true, name: true, phone: true } },
        dentist: { select: { id: true, name: true } },
      },
    });
  }

  async update(id: string, data: UpdateWaitlistDto, tenantId?: string) {
    await this.findOne(id, tenantId); // valida acesso

    const updateData: any = {
      ...(data.dentist_id !== undefined ? { dentist_id: data.dentist_id } : {}),
      ...(data.preferred_date !== undefined
        ? { preferred_date: data.preferred_date ? new Date(data.preferred_date) : null }
        : {}),
      ...(data.preferred_weekday !== undefined ? { preferred_weekday: data.preferred_weekday } : {}),
      ...(data.preferred_period !== undefined ? { preferred_period: data.preferred_period } : {}),
      ...(data.earliest_date !== undefined
        ? { earliest_date: data.earliest_date ? new Date(data.earliest_date) : null }
        : {}),
      ...(data.notes !== undefined ? { notes: data.notes } : {}),
      ...(data.status !== undefined ? { status: data.status } : {}),
    };

    // Se mudou pra status terminal (AGENDADO/DESISTIU/EXPIROU), marca resolved_at
    if (data.status && ['AGENDADO', 'DESISTIU', 'EXPIROU'].includes(data.status)) {
      updateData.resolved_at = new Date();
    }

    return (this.prisma as any).waitlistEntry.update({
      where: { id },
      data: updateData,
      include: {
        lead: { select: { id: true, name: true, phone: true } },
        dentist: { select: { id: true, name: true } },
      },
    });
  }

  async remove(id: string, tenantId?: string) {
    await this.findOne(id, tenantId);
    return (this.prisma as any).waitlistEntry.delete({ where: { id } });
  }

  async markNotified(id: string, tenantId?: string) {
    await this.findOne(id, tenantId);
    return (this.prisma as any).waitlistEntry.update({
      where: { id },
      data: {
        status: 'NOTIFICADO',
        notified_at: new Date(),
        notify_count: { increment: 1 },
      },
    });
  }

  /**
   * Encontra entradas da lista de espera compatíveis com um slot que abriu.
   * Usado pelo worker quando um CalendarEvent é cancelado/adiado.
   *
   * Critérios de compatibilidade (FIFO entre matches):
   *  1. status = AGUARDANDO ou NOTIFICADO
   *  2. mesmo dentist_id (ou null = qualquer dentista)
   *  3. preferred_date casa OU é null
   *  4. preferred_weekday casa OU é null
   *  5. earliest_date <= data do slot OU é null
   *  6. preferred_period casa com a hora do slot OU é null/QUALQUER
   *      MANHA: hora < 12, TARDE: 12-18, NOITE: >= 18
   */
  async findMatchesForSlot(params: {
    dentistId: string;
    slotStart: Date;
    tenantId?: string;
    limit?: number;
  }) {
    const hour = params.slotStart.getUTCHours();
    let period: 'MANHA' | 'TARDE' | 'NOITE';
    if (hour < 12) period = 'MANHA';
    else if (hour < 18) period = 'TARDE';
    else period = 'NOITE';

    const slotDateOnly = new Date(params.slotStart);
    slotDateOnly.setUTCHours(0, 0, 0, 0);

    return (this.prisma as any).waitlistEntry.findMany({
      where: {
        ...(params.tenantId ? { tenant_id: params.tenantId } : {}),
        status: { in: ['AGUARDANDO', 'NOTIFICADO'] },
        AND: [
          // Dentista compatível (mesmo OU qualquer)
          { OR: [{ dentist_id: params.dentistId }, { dentist_id: null }] },
          // preferred_date null OU mesmo dia
          { OR: [{ preferred_date: null }, { preferred_date: slotDateOnly }] },
          // preferred_weekday null OU mesmo dia da semana
          { OR: [{ preferred_weekday: null }, { preferred_weekday: params.slotStart.getUTCDay() }] },
          // earliest_date null OU <= data do slot
          { OR: [{ earliest_date: null }, { earliest_date: { lte: params.slotStart } }] },
          // preferred_period null/QUALQUER OU mesmo período
          {
            OR: [
              { preferred_period: null },
              { preferred_period: 'QUALQUER' },
              { preferred_period: period },
            ],
          },
        ],
      },
      include: {
        lead: { select: { id: true, name: true, phone: true } },
        dentist: { select: { id: true, name: true } },
      },
      orderBy: { created_at: 'asc' }, // FIFO
      take: params.limit ?? 5,
    });
  }

  /**
   * Hook chamado quando um CalendarEvent muda pra CANCELADO/ADIADO.
   * Encontra os primeiros candidatos da lista de espera, envia WhatsApp
   * pra cada um e marca como NOTIFICADO. Toleramos falhas silenciosamente
   * pra não quebrar o fluxo de cancelamento da agenda.
   */
  async notifySlotOpened(params: {
    dentistId: string;
    slotStart: Date;
    tenantId?: string;
    dentistName?: string;
    limit?: number;
  }): Promise<{ notified: number; matches: any[] }> {
    try {
      const matches = await this.findMatchesForSlot({
        dentistId: params.dentistId,
        slotStart: params.slotStart,
        tenantId: params.tenantId,
        limit: params.limit ?? 3, // notifica os 3 primeiros — primeiro a confirmar fica
      });

      if (!matches.length) {
        this.logger.log(
          `[WAITLIST] Nenhum candidato pro slot ${params.slotStart.toISOString()} dentista=${params.dentistId}`,
        );
        return { notified: 0, matches: [] };
      }

      // Resolve a instância WhatsApp (pega a primeira do banco como fallback)
      const dbInstance = await this.prisma.instance.findFirst({
        where: { type: 'whatsapp' },
        select: { name: true },
      }).catch(() => null);

      const dateLabel = params.slotStart.toLocaleString('pt-BR', {
        timeZone: 'UTC',
        weekday: 'long',
        day: '2-digit',
        month: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
      });

      let notified = 0;
      for (const entry of matches) {
        const phone = entry.lead?.phone;
        if (!phone) continue;

        // Resolve instância prioritariamente da conversa ativa do lead
        const activeConvo = await this.prisma.conversation.findFirst({
          where: { lead_id: entry.lead_id, status: { not: 'ENCERRADO' } },
          orderBy: { last_message_at: 'desc' },
          select: { instance_name: true },
        }).catch(() => null);
        const instanceName = activeConvo?.instance_name || dbInstance?.name || undefined;

        const firstName = (entry.lead?.name || '').split(' ')[0] || 'Olá';
        const dentistLabel = params.dentistName || entry.dentist?.name || 'a equipe';
        const msg =
`Oi ${firstName}! 👋

Abriu uma vaga na agenda do(a) Dr(a). ${dentistLabel} pra ${dateLabel}.

Você está na nossa lista de espera. Quer reservar essa vaga? Responde aqui que confirmamos pra você. 😊

(O primeiro a confirmar leva o horário.)`;

        try {
          const sendResult: any = await this.whatsapp.sendText(phone, msg, instanceName);
          if (!sendResult || sendResult?.statusCode >= 400 || sendResult?.error) {
            this.logger.warn(
              `[WAITLIST] Falha enviando pra ${phone}: ${JSON.stringify(sendResult)}`,
            );
            continue;
          }

          await (this.prisma as any).waitlistEntry.update({
            where: { id: entry.id },
            data: {
              status: 'NOTIFICADO',
              notified_at: new Date(),
              notify_count: { increment: 1 },
            },
          });
          notified++;
          this.logger.log(`[WAITLIST] Notificado ${firstName} (${phone}) pro slot ${dateLabel}`);
        } catch (e: any) {
          this.logger.warn(`[WAITLIST] Erro ao notificar ${phone}: ${e?.message}`);
        }
      }

      return { notified, matches };
    } catch (e: any) {
      this.logger.error(`[WAITLIST] notifySlotOpened falhou: ${e?.message}`);
      return { notified: 0, matches: [] };
    }
  }
}

/**
 * InfluencerSchedules — agendamentos de envio de mensagens.
 *
 * Cria/edita/exclui agendamentos. O envio em si é responsabilidade do worker
 * (apps/worker/src/influencer-messages/influencer-messages-cron.service.ts).
 *
 * Ao criar/editar, o `next_run_at` é recalculado aqui pra que o worker saiba
 * quando disparar. O worker também recalcula após cada execução.
 */
import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { computeNextRunAt, ScheduleType, Recurrence } from '@crm/shared';

const VALID_SCHEDULE_TYPES: ScheduleType[] = ['ONCE', 'RECURRING'];
const VALID_RECURRENCE: Recurrence[] = ['DAILY', 'WEEKLY', 'MONTHLY'];
const VALID_INF_STATUS = ['ATIVO', 'PAUSADO', 'INATIVO'];
const VALID_PLATFORM = ['INSTAGRAM', 'TIKTOK', 'YOUTUBE', 'OUTRO'];

export interface CreateScheduleDto {
  name: string;
  template_id: string;
  active?: boolean;
  schedule_type: ScheduleType;
  run_at?: string | null;
  recurrence?: Recurrence | null;
  weekdays?: number[];
  day_of_month?: number | null;
  hour?: number | null;
  minute?: number | null;
  filter_status?: string[];
  filter_platform?: string[];
  filter_niche?: string | null;
  manual_recipient_ids?: string[];
}
export interface UpdateScheduleDto extends Partial<CreateScheduleDto> {}

@Injectable()
export class InfluencerSchedulesService {
  constructor(private prisma: PrismaService) {}

  private validate(d: CreateScheduleDto | UpdateScheduleDto) {
    if (d.schedule_type !== undefined && !VALID_SCHEDULE_TYPES.includes(d.schedule_type)) {
      throw new BadRequestException(`schedule_type inválido (use ONCE ou RECURRING)`);
    }
    if (d.recurrence != null && !VALID_RECURRENCE.includes(d.recurrence)) {
      throw new BadRequestException(`recurrence inválido (use DAILY, WEEKLY ou MONTHLY)`);
    }
    if (d.weekdays) {
      for (const w of d.weekdays) {
        if (!Number.isInteger(w) || w < 0 || w > 6) {
          throw new BadRequestException('weekdays deve conter inteiros 0-6');
        }
      }
    }
    if (d.day_of_month != null && (d.day_of_month < 1 || d.day_of_month > 31)) {
      throw new BadRequestException('day_of_month deve ser 1-31');
    }
    if (d.hour != null && (d.hour < 0 || d.hour > 23)) throw new BadRequestException('hour deve ser 0-23');
    if (d.minute != null && (d.minute < 0 || d.minute > 59)) throw new BadRequestException('minute deve ser 0-59');
    if (d.filter_status) {
      for (const s of d.filter_status) {
        if (!VALID_INF_STATUS.includes(s)) throw new BadRequestException(`filter_status: "${s}" inválido`);
      }
    }
    if (d.filter_platform) {
      for (const p of d.filter_platform) {
        if (!VALID_PLATFORM.includes(p)) throw new BadRequestException(`filter_platform: "${p}" inválido`);
      }
    }
  }

  private async assertTemplate(tenantId: string, templateId: string) {
    const t = await (this.prisma as any).influencerMessageTemplate.findFirst({
      where: { id: templateId, tenant_id: tenantId },
    });
    if (!t) throw new BadRequestException('Template não encontrado');
  }

  async list(tenantId: string) {
    return (this.prisma as any).influencerSchedule.findMany({
      where: { tenant_id: tenantId },
      include: { template: { select: { id: true, name: true } } },
      orderBy: [{ active: 'desc' }, { next_run_at: 'asc' }, { name: 'asc' }],
    });
  }

  async findOne(id: string, tenantId: string) {
    const s = await (this.prisma as any).influencerSchedule.findFirst({
      where: { id, tenant_id: tenantId },
      include: { template: true },
    });
    if (!s) throw new NotFoundException('Agendamento não encontrado');
    return s;
  }

  async create(tenantId: string, data: CreateScheduleDto) {
    if (!data.name?.trim()) throw new BadRequestException('Nome é obrigatório');
    if (!data.template_id) throw new BadRequestException('Template é obrigatório');
    if (!data.schedule_type) throw new BadRequestException('schedule_type é obrigatório');
    this.validate(data);
    await this.assertTemplate(tenantId, data.template_id);

    const nextRunAt = computeNextRunAt({
      schedule_type: data.schedule_type,
      run_at: data.run_at || null,
      recurrence: data.recurrence || null,
      weekdays: data.weekdays || [],
      day_of_month: data.day_of_month ?? null,
      hour: data.hour ?? null,
      minute: data.minute ?? null,
    });

    return (this.prisma as any).influencerSchedule.create({
      data: {
        tenant_id: tenantId,
        name: data.name.trim(),
        template_id: data.template_id,
        active: data.active ?? true,
        schedule_type: data.schedule_type,
        run_at: data.run_at ? new Date(data.run_at) : null,
        recurrence: data.recurrence || null,
        weekdays: data.weekdays || [],
        day_of_month: data.day_of_month ?? null,
        hour: data.hour ?? null,
        minute: data.minute ?? null,
        filter_status: data.filter_status || [],
        filter_platform: data.filter_platform || [],
        filter_niche: data.filter_niche?.trim() || null,
        manual_recipient_ids: data.manual_recipient_ids || [],
        next_run_at: nextRunAt,
      },
      include: { template: { select: { id: true, name: true } } },
    });
  }

  async update(id: string, tenantId: string, data: UpdateScheduleDto) {
    const existing = await this.findOne(id, tenantId);
    this.validate(data);
    if (data.template_id) await this.assertTemplate(tenantId, data.template_id);

    const patch: any = {};
    if (data.name !== undefined) {
      if (!data.name.trim()) throw new BadRequestException('Nome não pode ser vazio');
      patch.name = data.name.trim();
    }
    if (data.template_id !== undefined) patch.template_id = data.template_id;
    if (data.active !== undefined) patch.active = data.active;
    if (data.schedule_type !== undefined) patch.schedule_type = data.schedule_type;
    if (data.run_at !== undefined) patch.run_at = data.run_at ? new Date(data.run_at) : null;
    if (data.recurrence !== undefined) patch.recurrence = data.recurrence || null;
    if (data.weekdays !== undefined) patch.weekdays = data.weekdays;
    if (data.day_of_month !== undefined) patch.day_of_month = data.day_of_month;
    if (data.hour !== undefined) patch.hour = data.hour;
    if (data.minute !== undefined) patch.minute = data.minute;
    if (data.filter_status !== undefined) patch.filter_status = data.filter_status;
    if (data.filter_platform !== undefined) patch.filter_platform = data.filter_platform;
    if (data.filter_niche !== undefined) patch.filter_niche = data.filter_niche?.trim() || null;
    if (data.manual_recipient_ids !== undefined) patch.manual_recipient_ids = data.manual_recipient_ids;

    // Recalcula next_run_at se mexeu em algo que afeta o agendamento
    const affectsNextRun =
      data.schedule_type !== undefined ||
      data.run_at !== undefined ||
      data.recurrence !== undefined ||
      data.weekdays !== undefined ||
      data.day_of_month !== undefined ||
      data.hour !== undefined ||
      data.minute !== undefined ||
      data.active !== undefined;

    if (affectsNextRun) {
      const merged = { ...existing, ...patch };
      patch.next_run_at = merged.active === false
        ? null
        : computeNextRunAt({
            schedule_type: merged.schedule_type,
            run_at: merged.run_at,
            recurrence: merged.recurrence,
            weekdays: merged.weekdays || [],
            day_of_month: merged.day_of_month,
            hour: merged.hour,
            minute: merged.minute,
          });
    }

    return (this.prisma as any).influencerSchedule.update({
      where: { id },
      data: patch,
      include: { template: { select: { id: true, name: true } } },
    });
  }

  async remove(id: string, tenantId: string) {
    await this.findOne(id, tenantId);
    await (this.prisma as any).influencerSchedule.delete({ where: { id } });
    return { ok: true };
  }

  /**
   * Força o disparo imediato — útil pra testar configuração.
   * Marca next_run_at como agora; o worker pega no próximo tick (até 1 min).
   */
  async runNow(id: string, tenantId: string) {
    const s = await this.findOne(id, tenantId);
    if (!s.active) throw new BadRequestException('Agendamento está pausado — ative antes de disparar');
    return (this.prisma as any).influencerSchedule.update({
      where: { id },
      data: { next_run_at: new Date() },
    });
  }
}

import {
  IsString,
  IsOptional,
  IsBoolean,
  IsNumber,
  IsArray,
  IsIn,
  IsDateString,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

// Tipos de evento da clinica odontologica.
// AUDIENCIA/PERICIA/PRAZO sao mantidos por compat com dados antigos do
// CRM juridico — sao validos no DTO mas nao aparecem no front novo.
const EVENT_TYPES = [
  'CONSULTA', 'PROCEDIMENTO', 'RETORNO', 'BLOQUEIO', 'TAREFA', 'OUTRO',
  'AUDIENCIA', 'PERICIA', 'PRAZO',
] as const;
// Onda 17.61 — mantém em sincronia com calendar.service.ts (fluxo de recepção):
// + COMPARECEU (paciente chegou), EM_ATENDIMENTO, NO_SHOW (faltou). DESMARCOU usa CANCELADO.
const EVENT_STATUSES = ['AGENDADO', 'CONFIRMADO', 'COMPARECEU', 'EM_ATENDIMENTO', 'CONCLUIDO', 'CANCELADO', 'NO_SHOW', 'ADIADO'] as const;

// ─── Reminder sub-DTO ─────────────────────────────────

class ReminderDto {
  @IsNumber()
  minutes_before: number;

  @IsOptional()
  @IsString()
  channel?: string;
}

// ─── Events ───────────────────────────────────────────

export class CreateEventDto {
  @IsIn(EVENT_TYPES as unknown as string[])
  type: string;

  @IsString()
  title: string;

  @IsOptional() @IsString()
  description?: string;

  @IsString()
  start_at: string;

  @IsOptional() @IsString()
  end_at?: string;

  @IsOptional() @IsBoolean()
  all_day?: boolean;

  @IsOptional() @IsIn(EVENT_STATUSES as unknown as string[])
  status?: string;

  @IsOptional() @IsString()
  priority?: string;

  @IsOptional() @IsString()
  color?: string;

  @IsOptional() @IsString()
  location?: string;

  @IsOptional() @IsString()
  lead_id?: string;

  @IsOptional() @IsString()
  patient_id?: string;

  @IsOptional() @IsString()
  conversation_id?: string;

  @IsOptional() @IsString()
  assigned_user_id?: string;

  @IsOptional() @IsString()
  appointment_type_id?: string;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ReminderDto)
  reminders?: ReminderDto[];

  @IsOptional() @IsString()
  recurrence_rule?: string;

  @IsOptional() @IsString()
  recurrence_end?: string;

  @IsOptional()
  @IsArray()
  @IsNumber({}, { each: true })
  recurrence_days?: number[];
}

export class UpdateEventDto {
  @IsOptional() @IsString()
  title?: string;

  @IsOptional() @IsString()
  description?: string;

  @IsOptional() @IsDateString()
  start_at?: string;

  @IsOptional() @IsDateString()
  end_at?: string;

  @IsOptional() @IsBoolean()
  all_day?: boolean;

  @IsOptional() @IsIn(EVENT_STATUSES as unknown as string[])
  status?: string;

  @IsOptional() @IsString()
  priority?: string;

  @IsOptional() @IsString()
  color?: string;

  @IsOptional() @IsString()
  location?: string;

  @IsOptional() @IsIn(EVENT_TYPES as unknown as string[])
  type?: string;

  @IsOptional() @IsString()
  lead_id?: string;

  @IsOptional() @IsString()
  patient_id?: string;

  @IsOptional() @IsString()
  conversation_id?: string;

  @IsOptional() @IsString()
  assigned_user_id?: string;

  @IsOptional() @IsString()
  appointment_type_id?: string;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ReminderDto)
  reminders?: ReminderDto[];
}

// ─── Appointment Types ────────────────────────────────

export class CreateAppointmentTypeDto {
  @IsString()
  name: string;

  @IsNumber()
  duration: number;

  @IsOptional() @IsString()
  color?: string;
}

export class UpdateAppointmentTypeDto {
  @IsOptional() @IsString()
  name?: string;

  @IsOptional() @IsNumber()
  duration?: number;

  @IsOptional() @IsString()
  color?: string;

  @IsOptional() @IsBoolean()
  active?: boolean;
}

// ─── Holidays ─────────────────────────────────────────

export class CreateHolidayDto {
  @IsString()
  date: string;

  @IsString()
  name: string;

  @IsOptional() @IsBoolean()
  recurring_yearly?: boolean;
}

export class UpdateHolidayDto {
  @IsOptional() @IsString()
  date?: string;

  @IsOptional() @IsString()
  name?: string;

  @IsOptional() @IsBoolean()
  recurring_yearly?: boolean;
}

// ─── Schedule Blocks (Fase 25 — Onda 5e v9) ──────────
// Bloqueio pontual de agenda do dentista (ferias, doenca, curso, etc).
// Usado pra impedir IA de agendar no periodo + esconder slots no front.

export class CreateScheduleBlockDto {
  @IsString()
  user_id: string;

  @IsString()
  start_at: string; // ISO 8601 ou YYYY-MM-DDTHH:mm

  @IsString()
  end_at: string;

  @IsOptional() @IsBoolean()
  all_day?: boolean;

  @IsString()
  reason: string; // "Ferias", "Doenca", "Curso", "Compromisso pessoal"

  @IsOptional() @IsString()
  notes?: string;
}

export class UpdateScheduleBlockDto {
  @IsOptional() @IsString()
  start_at?: string;

  @IsOptional() @IsString()
  end_at?: string;

  @IsOptional() @IsBoolean()
  all_day?: boolean;

  @IsOptional() @IsString()
  reason?: string;

  @IsOptional() @IsString()
  notes?: string;
}

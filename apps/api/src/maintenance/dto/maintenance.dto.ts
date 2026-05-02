import { IsString, IsOptional, IsUUID, IsDateString, IsIn } from 'class-validator';

const MAINTENANCE_STATUS = ['PENDING', 'SCHEDULED', 'DONE', 'MISSED', 'CANCELLED'] as const;

export class CreateMaintenanceTaskDto {
  @IsUUID('4') patient_id: string;
  @IsString() title: string;
  @IsDateString() due_date: string;
  @IsOptional() @IsUUID('4') procedure_id?: string;
  @IsOptional() @IsString() notes?: string;
}

export class UpdateMaintenanceTaskDto {
  @IsOptional() @IsString() @IsIn(MAINTENANCE_STATUS) status?: string;
  @IsOptional() @IsDateString() due_date?: string;
  @IsOptional() @IsString() title?: string;
  @IsOptional() @IsString() notes?: string;
  @IsOptional() @IsString() scheduled_event_id?: string | null;
}

import { IsString, IsOptional, IsBoolean, IsNumber, IsArray, IsObject } from 'class-validator';

// ─── Skill DTOs ──────────────────────────────────────────────

export class CreateSkillDto {
  @IsString() name: string;
  @IsString() area: string;
  @IsString() system_prompt: string;

  @IsOptional() @IsString() model?: string;
  @IsOptional() @IsNumber() max_tokens?: number;
  @IsOptional() @IsNumber() temperature?: number;
  @IsOptional() @IsString() handoff_signal?: string | null;
  @IsOptional() @IsBoolean() active?: boolean;
  @IsOptional() @IsNumber() order?: number;

  // Skills V2
  @IsOptional() @IsString() description?: string;
  @IsOptional() @IsArray() trigger_keywords?: string[];
  @IsOptional() @IsString() skill_type?: string;
  @IsOptional() @IsNumber() max_context_tokens?: number;
  @IsOptional() @IsString() provider?: string;
}

export class UpdateSkillDto {
  @IsOptional() @IsString() name?: string;
  @IsOptional() @IsString() area?: string;
  @IsOptional() @IsString() system_prompt?: string;
  @IsOptional() @IsString() model?: string;
  @IsOptional() @IsNumber() max_tokens?: number;
  @IsOptional() @IsNumber() temperature?: number;
  @IsOptional() @IsString() handoff_signal?: string | null;
  @IsOptional() @IsBoolean() active?: boolean;
  @IsOptional() @IsNumber() order?: number;

  // Skills V2
  @IsOptional() @IsString() description?: string;
  @IsOptional() @IsArray() trigger_keywords?: string[];
  @IsOptional() @IsString() skill_type?: string;
  @IsOptional() @IsNumber() max_context_tokens?: number;
  @IsOptional() @IsString() provider?: string;
}

// ─── Skill Tool DTOs ─────────────────────────────────────────

export class CreateSkillToolDto {
  @IsString() name: string;
  @IsString() description: string;
  @IsObject() parameters_json: Record<string, any>;
  @IsString() handler_type: string; // "builtin" | "webhook"
  @IsOptional() @IsObject() handler_config?: Record<string, any>;
  @IsOptional() @IsBoolean() active?: boolean;
}

export class UpdateSkillToolDto {
  @IsOptional() @IsString() name?: string;
  @IsOptional() @IsString() description?: string;
  @IsOptional() @IsObject() parameters_json?: Record<string, any>;
  @IsOptional() @IsString() handler_type?: string;
  @IsOptional() @IsObject() handler_config?: Record<string, any>;
  @IsOptional() @IsBoolean() active?: boolean;
}

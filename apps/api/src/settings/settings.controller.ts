import { Controller, Get, Post, Patch, Delete, Body, UseGuards, Request, Param, Put, Logger, UseInterceptors, UploadedFile, Res, NotFoundException, ForbiddenException, BadRequestException } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';
import { SettingsService } from './settings.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { WhatsappService } from '../whatsapp/whatsapp.service';
import { S3Service } from '../s3/s3.service';
import { CreateSkillDto, UpdateSkillDto, CreateSkillToolDto, UpdateSkillToolDto } from './dto/settings.dto';
import { PrismaService } from '../prisma/prisma.service';
import {
  computeBusinessHoursInfo,
  formatClinicHours,
  isAfterHoursAiEnabled,
  isLabTenant,
  loadOfficeHoursValues,
  type AiChipProfile,
  type ClinicHours,
} from '@crm/shared';
import { setTenantSetting } from '../tenants/tenant-settings.helper';
import { AiTestChatService } from './ai-test-chat.service';
import { negarPermissao } from '../auth/require-any-permission';
import {
  MEMORY_BATCH_KEY,
  clinicSettingStorageKey,
  isClinicScopedSettingKey,
  memoryBatchEfetivo,
  trocarLinhaMemoryBatch,
  validarValorChaveClinica,
} from './settings-scope';
import { SEM_CONTA_MSG, chaveDeGravacaoDaClinica, contaDoUsuario, ehSuperAdmin } from './config-da-clinica';
import { ADMIN_BOT_KEY, AI_COOLDOWN_KEY, camposDePlataformaEnviados, normalizarCooldown, type CorpoAiConfig } from './ia-config';
import { CONTRACT_CONFIG_KEY, escolherCamposContrato, urlPublicaAceita } from './contrato-config';

/** 403 da escrita de skills (instruções da IA), que são da plataforma. */
const SKILLS_PLATAFORMA_MSG = 'Skills da IA são mantidas pela plataforma — somente o administrador do sistema pode alterar.';

/** 403 de configuração da plataforma pedida por quem não é administrador do sistema. */
const SO_PLATAFORMA_MSG = 'Configuração da plataforma — somente o administrador do sistema pode alterar.';
import { CANNED_RESPONSES_KEY, CRM_CONFIG_KEY, validarRespostasRapidas } from './crc-config';

/** Mascara uma chave de API, mostrando apenas os primeiros 4 e últimos 4 caracteres */
function maskApiKey(key: string | null | undefined): string | null {
  if (!key) return null;
  if (key.length <= 10) return '****';
  return `${key.slice(0, 4)}${'*'.repeat(Math.min(key.length - 8, 20))}${key.slice(-4)}`;
}

@Controller('settings')
@UseGuards(JwtAuthGuard)
export class SettingsController {
  private readonly logger = new Logger(SettingsController.name);

  constructor(
    private readonly settingsService: SettingsService,
    private readonly whatsappService: WhatsappService,
    private readonly s3Service: S3Service,
    private readonly prisma: PrismaService,
    private readonly aiTestChatService: AiTestChatService,
  ) {}

  // ─── Generic Settings ─────────────────────────────────

  /**
   * Lista da GlobalSetting.
   * - ADMIN de clínica: só a linha MEMORY_BATCH_ENABLED (nome sem sufixo, a Base
   *   de Conhecimento procura esse nome) com o valor efetivo da CONTA dele. Nada
   *   da plataforma, de outra conta ou segredo. Sem conta: lista vazia (sem 403:
   *   a tela carrega tudo num Promise.all e cairia inteira).
   * - SUPER_ADMIN: a lista inteira, como antes; com conta, a linha
   *   MEMORY_BATCH_ENABLED mostra o valor efetivo da conta dele.
   */
  @Get()
  @Roles('ADMIN', 'SUPER_ADMIN')
  async getAll(@Request() req: any) {
    const isSuper = (req.user?.roles || []).includes('SUPER_ADMIN');
    const tenantId: string | undefined = req.user?.tenant_id || undefined;
    const avisar = (m: string) => this.logger.warn(m);
    if (!isSuper) {
      if (!tenantId) return [];
      const value = await memoryBatchEfetivo(this.prisma, tenantId, avisar);
      return [{ key: MEMORY_BATCH_KEY, value }];
    }
    const all = await this.settingsService.getAll();
    if (!tenantId) return all;
    return trocarLinhaMemoryBatch(all, await memoryBatchEfetivo(this.prisma, tenantId, avisar));
  }

  /**
   * Grava uma chave da GlobalSetting.
   * - Chaves das telas de clínica (Base de Conhecimento, Nota Fiscal): quem tem
   *   conta no token (ADMIN, ou o dono SUPER_ADMIN que também é de uma clínica)
   *   grava SEMPRE na chave da conta (`<chave>_<tenantId>`). Só o SUPER_ADMIN sem
   *   conta grava a global antiga.
   * - Qualquer outra chave: só o SUPER_ADMIN (como antes; o Gateway dele usa este
   *   caminho). Para o ADMIN de clínica, 403 PERMISSION_DENIED.
   */
  @Put()
  @Roles('ADMIN', 'SUPER_ADMIN')
  async upsert(@Request() req: any, @Body() data: { key: string; value: string }) {
    const isSuper = (req.user?.roles || []).includes('SUPER_ADMIN');
    const tenantId: string | undefined = req.user?.tenant_id || undefined;
    const key = String(data?.key || '');

    if (isClinicScopedSettingKey(key)) {
      const value = validarValorChaveClinica(key, data?.value);
      if (tenantId) return this.settingsService.upsert(clinicSettingStorageKey(key, tenantId), value);
      if (isSuper) return this.settingsService.upsert(key, value);
      throw negarPermissao('Configuração da clínica — sua conta de usuário não está ligada a uma clínica.');
    }

    if (!isSuper) {
      // Onda 18.x — CHAVES GLOBAIS DA PLATAFORMA (Asaas + dono da chave global):
      // a chave Asaas PRÓPRIA da clínica vai por outro caminho
      // (POST /payment-gateway/setup → TenantSetting), não por aqui.
      const PLATFORM_ASAAS_KEYS = ['asaas_api_key', 'asaas_webhook_token', 'asaas_sandbox', 'ASAAS_GLOBAL_OWNER_TENANT'];
      if (PLATFORM_ASAAS_KEYS.includes(key)) {
        throw negarPermissao('Configuração global da plataforma — somente o administrador do SaaS. Para a conta Asaas da sua clínica, use "Configurar gateway".');
      }
      throw negarPermissao('Configuração da plataforma — somente o administrador do sistema pode alterar.');
    }
    return this.settingsService.upsert(data.key, data.value);
  }

  // ─── E-mail da plataforma (Onda 17.32.180 — painel /admin) ───────

  /** Config SMTP global do SaaS. Nunca retorna a senha (so has_pass). */
  @Get('smtp')
  @Roles('SUPER_ADMIN')
  async getSmtp() {
    const cfg = await this.settingsService.getSmtpConfig();
    return { host: cfg.host, port: cfg.port, user: cfg.user, from: cfg.from, has_pass: !!cfg.pass };
  }

  /** Salva a config SMTP global. Senha vazia/mascarada nao sobrescreve. */
  @Put('smtp')
  @Roles('SUPER_ADMIN')
  async saveSmtp(@Body() body: { host?: string; port?: string | number; user?: string; pass?: string; from?: string }) {
    const entries: Array<[string, string | undefined]> = [
      ['SMTP_HOST', body.host],
      ['SMTP_PORT', body.port !== undefined && body.port !== null ? String(body.port) : undefined],
      ['SMTP_USER', body.user],
      ['SMTP_PASS', body.pass],
      ['SMTP_FROM', body.from],
    ];
    for (const [key, raw] of entries) {
      if (raw === undefined || raw === null) continue;
      const value = String(raw).trim();
      // Senha em branco ou mascarada = "manter a atual"
      if (key === 'SMTP_PASS' && (!value || /^\*+$/.test(value))) continue;
      await this.settingsService.upsert(key, value);
    }
    return { ok: true };
  }

  // ─── DJEN Lawyers (legado; configuração da plataforma) ─────────────────
  // Nenhuma tela usa. Só o administrador do sistema lê e grava.

  @Get('djen-lawyers')
  @Roles('ADMIN', 'DENTIST')
  async getDjenLawyers(@Request() req: any) {
    if (!ehSuperAdmin(req.user)) throw negarPermissao(SO_PLATAFORMA_MSG);
    const raw = await this.settingsService.get('DJEN_LAWYERS');
    if (raw) {
      try { return JSON.parse(raw); } catch {}
    }
    // Fallback: montar a partir dos settings legados
    const oab  = (await this.settingsService.get('DJEN_OAB_NUMBER'))  || '14209';
    const uf   = (await this.settingsService.get('DJEN_OAB_UF'))      || 'AL';
    const nome = (await this.settingsService.get('DJEN_LAWYER_NAME')) || '';
    return [{ oab, uf, nome }];
  }

  @Patch('djen-lawyers')
  @Roles('ADMIN')
  async saveDjenLawyers(@Request() req: any, @Body() body: { lawyers: Array<{ oab: string; uf: string; nome: string }> }) {
    if (!ehSuperAdmin(req.user)) throw negarPermissao(SO_PLATAFORMA_MSG);
    if (!Array.isArray(body?.lawyers)) throw new BadRequestException('Envie a lista de advogados (lawyers).');
    await this.settingsService.upsert('DJEN_LAWYERS', JSON.stringify(body.lawyers));
    return { message: 'Advogados DJEN salvos com sucesso', count: body.lawyers.length };
  }

  // ─── Horário do Escritório (afeta cron AfterHours e {{business_hours_info}}) ───
  // POR CLÍNICA: lê/grava TenantSetting da clínica do JWT; chave que a clínica
  // ainda não gravou herda o GlobalSetting legado (comportamento antigo). Sem
  // clínica no JWT = global (legado). A grade por dia de Ajustes › IA
  // (AI_CLINIC_HOURS), se existir, vence abertura/fechamento/dias.

  @Get('office-hours')
  @Roles('ADMIN')
  async getOfficeHours(@Request() req: any) {
    const tenantId: string | null = req.user?.tenant_id ?? null;
    const { values, ownKeys, clinicHours } = await loadOfficeHoursValues(this.prisma, tenantId);
    return {
      // NOTA: na var `AFTER_HOURS_START` está a hora que o escritório FECHA.
      // Na UI exportamos como "close" pra não confundir o admin.
      ai_enabled: isAfterHoursAiEnabled(values),
      open_time:  values.AFTER_HOURS_END   ?? '08:00', // AFTER_HOURS_END  = abertura
      close_time: values.AFTER_HOURS_START ?? '17:00', // AFTER_HOURS_START = fechamento
      business_days: (values.BUSINESS_DAYS ?? '1,2,3,4,5')
        .split(',')
        .map((v) => Number.parseInt(v.trim(), 10))
        .filter((n) => Number.isFinite(n) && n >= 0 && n <= 6),
      timezone: values.TIMEZONE ?? 'America/Maceio',
      // 'clinic' = a clínica já tem horário próprio; 'global' = herdando o padrão.
      scope: tenantId && ownKeys.length > 0 ? 'clinic' : 'global',
      // Grade de Ajustes › IA em texto (null = clínica sem grade).
      clinic_hours_text: clinicHours ? formatClinicHours(clinicHours) : null,
    };
  }

  @Put('office-hours')
  @Roles('ADMIN')
  async saveOfficeHours(@Request() req: any, @Body() body: {
    ai_enabled?: boolean;
    open_time?: string;
    close_time?: string;
    business_days?: number[];
    timezone?: string;
  }) {
    const tenantId: string | null = req.user?.tenant_id ?? null;
    if (body.timezone && body.timezone.length > 0) {
      try {
        new Intl.DateTimeFormat('en-US', { timeZone: body.timezone });
      } catch {
        throw new BadRequestException(`Fuso horário inválido: "${body.timezone}". Ex.: America/Maceio`);
      }
    }
    const save = (key: string, value: string) =>
      tenantId ? setTenantSetting(this.prisma, tenantId, key, value) : this.settingsService.upsert(key, value);

    if (typeof body.ai_enabled === 'boolean') {
      await save('AFTER_HOURS_AI_ENABLED', body.ai_enabled ? 'true' : 'false');
    }
    if (body.open_time && /^\d{2}:\d{2}$/.test(body.open_time)) {
      await save('AFTER_HOURS_END', body.open_time);
    }
    if (body.close_time && /^\d{2}:\d{2}$/.test(body.close_time)) {
      await save('AFTER_HOURS_START', body.close_time);
    }
    if (Array.isArray(body.business_days)) {
      const clean = body.business_days
        .filter((n) => Number.isInteger(n) && n >= 0 && n <= 6)
        .join(',');
      if (clean) await save('BUSINESS_DAYS', clean);
    }
    if (body.timezone && body.timezone.length > 0) {
      await save('TIMEZONE', body.timezone);
    }
    return { message: 'Horário da clínica salvo' };
  }

  /**
   * Preview das variáveis DINÂMICAS do sistema (calculadas em tempo real).
   * Usado pela UI de skills para mostrar ao editor o que cada variável
   * resolveria AGORA — evita surpresa no prompt final.
   *
   * Só inclui variáveis globais (não por-lead). Para variáveis por-lead
   * (lead_name, lead_memory, etc), mostrar "ex:" em vez de preview real.
   */
  @Get('variable-preview')
  @Roles('ADMIN')
  async getVariablePreview(@Request() req: any) {
    // Clínica de quem está na tela: horário e feriados DELA (nunca de outra).
    const businessHoursInfo = await computeBusinessHoursInfo(this.prisma, req.user?.tenant_id ?? null).catch(() => '');
    return {
      business_hours_info: businessHoursInfo,
    };
  }

  @Get('whatsapp-config/health')
  @Roles('ADMIN')
  async checkHealth(@Request() req: any) {
    try {
      // Onda 17.32.129 — health usa as instances do tenant logado
      const tenantId = req.user?.tenant_id ?? null;
      await this.whatsappService.listInstances(tenantId);
      return { status: 'online' };
    } catch (error) {
      return { status: 'offline', error: error.message };
    }
  }

  @Get('whatsapp-config')
  @Roles('ADMIN')
  async getWhatsAppConfig(@Request() req: any) {
    // Onda 17.32.129 — Fase 6.1: per-tenant. ADMIN da clinica ve a
    // config DELE (TenantSetting com fallback pro global se nao
    // tiver configurado ainda).
    const tenantId = req.user?.tenant_id ?? null;
    const config = await this.settingsService.getWhatsAppConfig(tenantId);
    return { ...config, apiKey: maskApiKey(config.apiKey) };
  }

  @Post('whatsapp-config')
  @Roles('ADMIN')
  async setWhatsAppConfig(
    @Request() req: any,
    @Body() data: { apiUrl: string; apiKey?: string; webhookUrl?: string },
  ) {
    // Onda 17.32.129 — Fase 6.1: salva no tenant logado (nao no global)
    const tenantId = req.user?.tenant_id ?? null;
    await this.settingsService.setWhatsAppConfig(
      data.apiUrl, data.apiKey, data.webhookUrl, tenantId,
    );

    // Reaplicar webhook em todas as instâncias do tenant
    if (data.webhookUrl) {
      try {
        const instances = await this.whatsappService.listInstances(tenantId);
        const names: string[] = (instances as any[]).map((i) => i.instanceName).filter(Boolean);
        await Promise.allSettled(
          names.map((name) => this.whatsappService.setWebhook(name, data.webhookUrl!, tenantId)),
        );
        this.logger.log(`Webhook atualizado em ${names.length} instância(s) do tenant ${tenantId ?? 'global'}`);
      } catch (e) {
        this.logger.error('Falha ao reaplicar webhook nas instâncias:', e?.message);
      }
    }

    return { message: 'Configurações atualizadas com sucesso' };
  }

  /**
   * Ajustes IA › "Conectar a IA". Liga/desliga por chip, robô de comando e tempo de
   * resposta padrão são DA CLÍNICA de quem está logado. A chave OpenAI (mesmo
   * mascarada) só volta para o administrador do sistema; a clínica vê só os
   * sim/não (isConfigured...). Nunca 403: a tela carrega tudo num Promise.all.
   */
  @Get('ai-config')
  @Roles('ADMIN')
  async getAiConfig(@Request() req: any) {
    const config = await this.settingsService.getAiConfig(contaDoUsuario(req.user));
    return { ...config, apiKey: ehSuperAdmin(req.user) ? maskApiKey(config.apiKey) : null };
  }

  /**
   * Salva "Conectar a IA".
   *  - Campos da PLATAFORMA (chaves, modelo padrão, DJEN, liga/desliga geral
   *    antigo): só o administrador do sistema grava, na configuração global. De
   *    outro usuário são ignorados (aviso no log e lista `ignorados` na resposta) —
   *    o salvamento da clínica continua respondendo 200.
   *  - Campos DA CLÍNICA (tempo de resposta padrão, robô de comando): gravam na
   *    chave da conta de quem salva (inclusive o dono logado numa clínica); o
   *    administrador do sistema sem conta grava a global antiga; sem conta e sem
   *    esse papel, 403.
   */
  @Post('ai-config')
  @Roles('ADMIN')
  async setAiConfig(@Request() req: any, @Body() data: CorpoAiConfig) {
    const corpo: CorpoAiConfig = data && typeof data === 'object' ? data : {};
    const isSuper = ehSuperAdmin(req.user);

    // 1. Decide tudo antes de gravar (nada pela metade).
    const temTempo = corpo.cooldownSeconds !== undefined && corpo.cooldownSeconds !== null;
    const temRobo = corpo.adminBotEnabled !== undefined && corpo.adminBotEnabled !== null;
    const segundos = temTempo ? normalizarCooldown(corpo.cooldownSeconds) : null;
    const chaveTempo = temTempo ? chaveDeGravacaoDaClinica(AI_COOLDOWN_KEY, req.user) : null;
    const chaveRobo = temRobo ? chaveDeGravacaoDaClinica(ADMIN_BOT_KEY, req.user) : null;
    const ignorados = isSuper ? [] : camposDePlataformaEnviados(corpo);
    if (ignorados.length) {
      this.logger.warn(
        `[ai-config] campos da plataforma ignorados (usuário ${req.user?.id ?? '?'} sem SUPER_ADMIN): ${ignorados.join(', ')}`,
      );
    }

    // 2. Plataforma: só o administrador do sistema (como antes).
    if (isSuper) {
      if (corpo.apiKey)    await this.settingsService.setAiConfig(corpo.apiKey);
      if (corpo.adminKey)  await this.settingsService.setAdminKey(corpo.adminKey);
      if (corpo.anthropicApiKey) await this.settingsService.upsert('ANTHROPIC_API_KEY', corpo.anthropicApiKey);
      if (corpo.defaultModel) await this.settingsService.setDefaultModel(corpo.defaultModel);
      if (corpo.djenModel)    await this.settingsService.setDjenModel(corpo.djenModel);
      if (corpo.djenPrompt !== undefined) await this.settingsService.setDjenPrompt(corpo.djenPrompt);
      if (corpo.djenNotifyTemplate !== undefined) await this.settingsService.setDjenNotifyTemplate(corpo.djenNotifyTemplate);
      if (corpo.whatsappAiEnabled !== undefined) await this.settingsService.setWhatsappAiEnabled(corpo.whatsappAiEnabled);
    }

    // 3. Clínica: na chave da conta.
    if (chaveRobo) await this.settingsService.setAdminBotEnabled(!!corpo.adminBotEnabled, chaveRobo);
    if (chaveTempo && segundos !== null) await this.settingsService.setCooldownSeconds(segundos, chaveTempo);
    return { message: 'Configurações de IA salvas com sucesso', ignorados };
  }

  // Valores que a IA pode falar no WhatsApp — POR CLÍNICA (TenantSetting
  // AI_PRICE_TABLE). Texto livre, uma linha por item (ex.: "Limpeza — R$ 350:
  // polimento, flúor e remoção de tártaro"). Vazio = a IA não informa preço nenhum.
  @Get('ai-price-table')
  @Roles('ADMIN')
  async getAiPriceTable(@Request() req: any) {
    const tenantId = req.user?.tenant_id;
    if (!tenantId) return { value: '', enabled: true, form: null };
    const get = (key: string) =>
      this.prisma.tenantSetting.findUnique({ where: { tenant_id_key: { tenant_id: tenantId, key } } });
    const [row, on, form] = await Promise.all([get('AI_PRICE_TABLE'), get('AI_PRICES_ENABLED'), get('AI_PRICE_FORM')]);
    let formJson: any = null;
    try { formJson = form?.value ? JSON.parse(form.value) : null; } catch { formJson = null; }
    return { value: row?.value || '', enabled: on?.value !== 'false', form: formJson };
  }

  @Put('ai-price-table')
  @Roles('ADMIN')
  async setAiPriceTable(@Request() req: any, @Body() body: { value?: string; enabled?: boolean; form?: Record<string, any> | null }) {
    const tenantId = req.user?.tenant_id;
    if (!tenantId) throw new ForbiddenException('Usuário sem clínica');
    const upsert = (key: string, value: string) =>
      this.prisma.tenantSetting.upsert({
        where: { tenant_id_key: { tenant_id: tenantId, key } },
        create: { tenant_id: tenantId, key, value },
        update: { value },
      });
    if (body?.value !== undefined) await upsert('AI_PRICE_TABLE', String(body.value).slice(0, 4000));
    // Chave "a IA pode passar valores" — desligada guarda o texto, só não usa.
    if (body?.enabled !== undefined) await upsert('AI_PRICES_ENABLED', body.enabled ? 'true' : 'false');
    // Campos do "modelo pronto" (nome da doutora, valores) — só pra tela reabrir
    // preenchida; a IA lê o texto final (AI_PRICE_TABLE).
    if (body?.form !== undefined) {
      const formJson = JSON.stringify(body.form ?? null);
      if (formJson.length > 8000) throw new BadRequestException('Lista de procedimentos grande demais.');
      await upsert('AI_PRICE_FORM', formJson);
    }
    return { ok: true };
  }

  // Chat de teste da IA: roda a Sophia de verdade (skills + guia + agenda real)
  // sem enviar WhatsApp nem gravar nada. Sempre na clínica de quem está logado.
  @Post('ai-test-chat')
  @Roles('ADMIN')
  async aiTestChat(
    @Request() req: any,
    @Body()
    body: {
      purpose?: string;
      isClient?: boolean;
      leadName?: string;
      model?: string;
      history?: { from: 'patient' | 'ai'; text: string }[];
      /** "Ver como seria" a 2ª tentativa de agendamento (mensagem separada, minutos depois). */
      retryScheduling?: boolean;
    },
  ) {
    const tenantId = req.user?.tenant_id;
    if (!tenantId) throw new ForbiddenException('Usuário sem clínica');
    const p = String(body?.purpose || '').toUpperCase();
    return this.aiTestChatService.run({
      tenantId,
      purpose: p === 'COMERCIAL' || p === 'CLINICA' || p === 'FINANCEIRO' ? (p as any) : null,
      isClient: !!body?.isClient,
      leadName: body?.leadName ? String(body.leadName).slice(0, 80) : null,
      model: /^[a-z0-9][a-z0-9.-]{1,60}$/i.test(String(body?.model || '')) ? String(body!.model) : null,
      history: Array.isArray(body?.history) ? body!.history : [],
      retryScheduling: body?.retryScheduling === true,
    });
  }

  // Onda 18.20 — liga/desliga a IA de UM chip (Comercial/Clínica/Financeiro).
  // POR CLÍNICA: grava só na clínica do JWT. Sem conta: só o administrador do
  // sistema grava a reserva global antiga; os demais recebem 403.
  @Post('ai-chip-toggle')
  @Roles('ADMIN')
  async setAiChipToggle(@Request() req: any, @Body() body: { purpose: string; enabled: boolean }) {
    const tenantId = contaDoUsuario(req.user);
    if (!tenantId && !ehSuperAdmin(req.user)) throw negarPermissao(SEM_CONTA_MSG);
    await this.settingsService.setChipAiEnabled(body?.purpose, !!body?.enabled, tenantId);
    return { ok: true, purpose: body?.purpose, enabled: !!body?.enabled };
  }

  // ─── Perfil da IA por clínica (Ajustes › IA) ─────────────────
  // Dados da clínica que a IA usa + perfil de cada chip (nome da assistente,
  // assinatura, tamanho da resposta, tempo de resposta, instruções). Sempre a
  // clínica de quem está logado — nunca outra. Bodies são tipos inline (não
  // classe DTO) porque o ValidationPipe tem forbidNonWhitelisted.

  @Get('ai-profile')
  @Roles('ADMIN')
  async getAiProfile(@Request() req: any) {
    const tenantId = req.user?.tenant_id;
    if (!tenantId) throw new ForbiddenException('Usuário sem clínica');
    return this.settingsService.getAiProfile(tenantId);
  }

  @Put('ai-profile/clinic')
  @Roles('ADMIN')
  async saveAiProfileClinic(
    @Request() req: any,
    @Body()
    body: {
      name?: string | null;
      phone?: string | null;
      zip_code?: string | null;
      address?: string | null;
      address_number?: string | null;
      address_complement?: string | null;
      neighborhood?: string | null;
      city?: string | null;
      state?: string | null;
      hours?: ClinicHours | null;
      summary?: string | null;
    },
  ) {
    const tenantId = req.user?.tenant_id;
    if (!tenantId) throw new ForbiddenException('Usuário sem clínica');
    return this.settingsService.saveAiProfileClinic(tenantId, body);
  }

  @Put('ai-profile/chip/:purpose')
  @Roles('ADMIN')
  async saveAiProfileChip(
    @Request() req: any,
    @Param('purpose') purpose: string,
    @Body() body: Partial<AiChipProfile> & { enabled?: boolean },
  ) {
    const tenantId = req.user?.tenant_id;
    if (!tenantId) throw new ForbiddenException('Usuário sem clínica');
    return this.settingsService.saveAiChipProfile(tenantId, purpose, body ?? {});
  }

  // ─── Skills (instruções da IA) — da PLATAFORMA ─────────
  // Leitura: ADMIN de clínica, como antes (laboratório não tem IA: lista vazia).
  // Criar, editar, ligar/desligar, apagar, ferramentas e referências: só o
  // administrador do sistema (403 PERMISSION_DENIED para os demais).

  /** Laboratório (sem SUPER_ADMIN) não lê as skills de clínica. */
  private async semSkillsParaLaboratorio(user: any): Promise<boolean> {
    if (ehSuperAdmin(user)) return false;
    return isLabTenant(this.prisma, contaDoUsuario(user), (m) => this.logger.warn(m));
  }

  /** Escrita de skill/ferramenta/referência: só o administrador do sistema. */
  private exigirPlataforma(user: any): void {
    if (!ehSuperAdmin(user)) throw negarPermissao(SKILLS_PLATAFORMA_MSG);
  }

  @Get('skills')
  @Roles('ADMIN') // Onda 17.61 (segurança/RBAC-08) — config de IA é admin-only.
  async getSkills(@Request() req: any) {
    if (await this.semSkillsParaLaboratorio(req.user)) return [];
    return this.settingsService.getSkills();
  }

  @Patch('skills/:id/toggle')
  @Roles('ADMIN')
  async toggleSkill(@Request() req: any, @Param('id') id: string, @Body() data: { isActive: boolean }) {
    this.exigirPlataforma(req.user);
    await this.settingsService.toggleSkill(id, data.isActive);
    return { message: 'Skill atualizada com sucesso' };
  }

  @Post('skills/reset-defaults')
  @Roles('ADMIN')
  async resetSkillsToDefaults(@Request() req: any) {
    this.exigirPlataforma(req.user);
    return this.settingsService.resetSkillsToDefaults();
  }

  /**
   * Migra a skill SDR para o domínio odontológico (Instituto Odonto Passos).
   * Idempotente. Mantém uploads e tools customizadas pelo admin; sobrescreve
   * apenas o prompt e a reference padrão.
   */
  @Post('skills/migrate-sdr-to-odonto')
  @Roles('ADMIN')
  async migrateSdrToOdonto(@Request() req: any) {
    this.exigirPlataforma(req.user);
    return this.settingsService.migrateSdrToOdonto();
  }

  @Post('skills')
  @Roles('ADMIN')
  async createSkill(@Request() req: any, @Body() data: CreateSkillDto) {
    this.exigirPlataforma(req.user);
    return this.settingsService.createSkill(data);
  }

  @Patch('skills/:id')
  @Roles('ADMIN')
  async updateSkill(@Request() req: any, @Param('id') id: string, @Body() data: UpdateSkillDto) {
    this.exigirPlataforma(req.user);
    return this.settingsService.updateSkill(id, data);
  }

  @Delete('skills/:id')
  @Roles('ADMIN')
  async deleteSkill(@Request() req: any, @Param('id') id: string) {
    this.exigirPlataforma(req.user);
    return this.settingsService.deleteSkill(id);
  }

  // ─── Skill Tools CRUD ─────────────────────────────────

  @Get('skills/:skillId/tools')
  @Roles('ADMIN') // Onda 17.61 (segurança/RBAC-08) — tools (handler_config/url) admin-only.
  async getSkillTools(@Request() req: any, @Param('skillId') skillId: string) {
    if (await this.semSkillsParaLaboratorio(req.user)) return [];
    return this.settingsService.getSkillTools(skillId);
  }

  @Post('skills/:skillId/tools')
  @Roles('ADMIN')
  async createSkillTool(@Request() req: any, @Param('skillId') skillId: string, @Body() data: CreateSkillToolDto) {
    this.exigirPlataforma(req.user);
    return this.settingsService.createSkillTool(skillId, data);
  }

  @Patch('skills/tools/:toolId')
  @Roles('ADMIN')
  async updateSkillTool(@Request() req: any, @Param('toolId') toolId: string, @Body() data: UpdateSkillToolDto) {
    this.exigirPlataforma(req.user);
    return this.settingsService.updateSkillTool(toolId, data);
  }

  @Delete('skills/tools/:toolId')
  @Roles('ADMIN')
  async deleteSkillTool(@Request() req: any, @Param('toolId') toolId: string) {
    this.exigirPlataforma(req.user);
    return this.settingsService.deleteSkillTool(toolId);
  }

  // ─── Skill Assets / References ──────────────────────────

  @Get('skills/:skillId/assets')
  @Roles('ADMIN') // Onda 17.61 (segurança/RBAC-08) — assets de skill admin-only.
  async getSkillAssets(@Request() req: any, @Param('skillId') skillId: string) {
    if (await this.semSkillsParaLaboratorio(req.user)) return [];
    return this.settingsService.getSkillAssets(skillId);
  }

  @Post('skills/:skillId/assets')
  @Roles('ADMIN')
  @UseInterceptors(FileInterceptor('file'))
  async uploadSkillAsset(
    @Request() req: any,
    @Param('skillId') skillId: string,
    @UploadedFile() file: any,
    @Body() body: { asset_type?: string; inject_mode?: string },
  ) {
    this.exigirPlataforma(req.user); // antes de subir qualquer arquivo
    if (!file) throw new NotFoundException('Nenhum arquivo enviado');

    const ext = file.originalname.split('.').pop() || 'bin';
    const uuid = crypto.randomUUID();
    const s3Key = `skill-assets/${skillId}/${uuid}.${ext}`;

    await this.s3Service.uploadBuffer(s3Key, file.buffer, file.mimetype);

    let contentText: string | null = null;
    const assetType = body.asset_type || 'asset';
    const injectMode = body.inject_mode || (assetType === 'reference' ? 'full_text' : 'none');

    if (assetType === 'reference' && injectMode !== 'none') {
      if (file.mimetype === 'text/markdown' || file.mimetype === 'text/plain' || ext === 'md' || ext === 'txt') {
        contentText = file.buffer.toString('utf-8');
      }
    }

    return this.settingsService.createSkillAsset(skillId, {
      name: file.originalname,
      s3_key: s3Key,
      mime_type: file.mimetype,
      size: file.size,
      asset_type: assetType,
      inject_mode: injectMode,
      content_text: contentText,
    });
  }

  @Patch('skills/assets/:assetId')
  @Roles('ADMIN')
  async updateSkillAsset(@Request() req: any, @Param('assetId') assetId: string, @Body() body: { inject_mode?: string; asset_type?: string; content_text?: string; size?: number }) {
    this.exigirPlataforma(req.user);
    return this.settingsService.updateSkillAsset(assetId, body);
  }

  @Delete('skills/assets/:assetId')
  @Roles('ADMIN')
  async deleteSkillAsset(@Request() req: any, @Param('assetId') assetId: string) {
    this.exigirPlataforma(req.user);
    const asset = await this.settingsService.deleteSkillAsset(assetId);
    if (asset?.s3_key) {
      try { await this.s3Service.deleteObject(asset.s3_key); } catch {}
    }
    return { ok: true };
  }

  @Get('skills/assets/:assetId/download')
  @Roles('ADMIN') // Onda 17.61 (segurança/RBAC-08) — download de asset admin-only.
  async downloadSkillAsset(@Request() req: any, @Param('assetId') assetId: string, @Res() res: any) {
    if (await this.semSkillsParaLaboratorio(req.user)) throw new NotFoundException('Asset não encontrado');
    const asset = await this.settingsService.findSkillAssetById(assetId);
    if (!asset) throw new NotFoundException('Asset não encontrado');

    const { buffer, contentType } = await this.s3Service.getObjectBuffer(asset.s3_key);
    res.set({
      'Content-Type': contentType,
      'Content-Disposition': `attachment; filename="${encodeURIComponent(asset.name)}"`,
      'Content-Length': buffer.length,
    });
    res.send(buffer);
  }

  /**
   * Custos de IA: o administrador do sistema vê a plataforma (todas as contas e a
   * organização OpenAI), como antes; os demais veem só o consumo da própria
   * clínica (sem conta: zerado, nunca 403).
   */
  @Get('ai-costs')
  @Roles('ADMIN')
  async getAiCosts(@Request() req: any) {
    if (ehSuperAdmin(req.user)) return this.settingsService.getAiCosts({ tipo: 'plataforma' });
    return this.settingsService.getAiCosts({ tipo: 'clinica', tenantId: contaDoUsuario(req.user) });
  }

  // ─── Clicksign (integração da PLATAFORMA) ─────────────
  // Uma conta ClickSign para todas: só o administrador do sistema troca ambiente
  // e tokens. A clínica vê o status (mesmas chaves e sim/não, tokens como
  // '********'); o GET nunca dá 403 (a tela carrega tudo junto).

  @Get('clicksign')
  @Roles('ADMIN')
  async getClicksign(@Request() req: any) {
    const cfg = await this.settingsService.getClicksignConfig();
    const isSuper = ehSuperAdmin(req.user);
    const mascarar = (t: string | null | undefined) => (isSuper ? maskApiKey(t) : t ? '********' : null);
    return {
      ...cfg,
      apiToken:     mascarar(cfg.apiToken),
      webhookToken: mascarar(cfg.webhookToken),
    };
  }

  @Patch('clicksign')
  @Roles('ADMIN')
  async setClicksign(@Request() req: any, @Body() body: { baseUrl?: string; apiToken?: string; webhookToken?: string }) {
    if (!ehSuperAdmin(req.user)) throw negarPermissao(SO_PLATAFORMA_MSG);
    await this.settingsService.setClicksignConfig(body);
    return { ok: true };
  }

  // ─── Dados fixos dos contratos (POR CLÍNICA) ──────────
  // Os 8 dados (dentista responsável/CRO, endereço, foro) são da clínica; a URL
  // pública da API é da plataforma (só o administrador do sistema grava; vinda
  // de outro usuário é ignorada, com aviso no log e em `ignorados`).

  @Get('contract')
  async getContract(@Request() req: any) {
    return this.settingsService.getContractConfigDaConta(contaDoUsuario(req.user));
  }

  @Patch('contract')
  @Roles('ADMIN')
  async setContract(@Request() req: any, @Body() body: Record<string, string>) {
    const corpo: Record<string, unknown> = body && typeof body === 'object' ? body : {};
    const isSuper = ehSuperAdmin(req.user);
    const conta = contaDoUsuario(req.user);

    // 1. Decide tudo antes de gravar.
    const chave = chaveDeGravacaoDaClinica(CONTRACT_CONFIG_KEY, req.user);
    const dados = escolherCamposContrato(corpo);
    const ignorados: string[] = [];
    let novaUrl: string | null = null;
    if (corpo.publicApiUrl !== undefined && corpo.publicApiUrl !== null) {
      if (!isSuper) {
        ignorados.push('publicApiUrl');
        this.logger.warn(`[contract] publicApiUrl ignorada (usuário ${req.user?.id ?? '?'} sem SUPER_ADMIN)`);
      } else {
        const enviada = String(corpo.publicApiUrl).trim();
        const atual = String((await this.settingsService.getContractConfig()).publicApiUrl ?? '').trim();
        if (enviada !== atual) {
          if (!urlPublicaAceita(enviada)) {
            throw new BadRequestException('URL Pública da API inválida: use um endereço http(s) completo.');
          }
          novaUrl = enviada;
        }
      }
    }

    // 2. Grava.
    await this.settingsService.setContractConfigDaConta(chave, conta, dados);
    if (novaUrl !== null) await this.settingsService.setContractPublicApiUrl(novaUrl);
    return { ok: true, ignorados };
  }

  // ─── CRM Config (POR CLÍNICA) ─────────────────────────
  // Dias de "lead parado" do aviso do CRM: cada clínica com o seu. A clínica que
  // já existia vê o valor antigo até salvar o dela; conta nova começa no padrão.

  @Get('crm-config')
  async getCrmConfig(@Request() req: any) {
    return this.settingsService.getCrmConfig(contaDoUsuario(req.user));
  }

  @Patch('crm-config')
  @Roles('ADMIN')
  async setCrmConfig(@Request() req: any, @Body() body: { stagnationDays?: number }) {
    const chave = chaveDeGravacaoDaClinica(CRM_CONFIG_KEY, req.user);
    await this.settingsService.setCrmConfig(chave, body);
    return { ok: true };
  }

  // ─── Canned Responses (POR CLÍNICA) ───────────────────
  // Menu "/" do inbox: a lista é da clínica (GET aberto a quem está logado — a
  // recepção usa no inbox). A clínica que já existia vê a lista antiga até salvar
  // a dela; conta nova começa vazia.

  @Get('canned-responses')
  async getCannedResponses(@Request() req: any) {
    return this.settingsService.getCannedResponses(contaDoUsuario(req.user));
  }

  @Patch('canned-responses')
  @Roles('ADMIN')
  async setCannedResponses(@Request() req: any, @Body() body: { responses: { id: string; label: string; text: string }[] }) {
    const chave = chaveDeGravacaoDaClinica(CANNED_RESPONSES_KEY, req.user);
    const lista = validarRespostasRapidas(body?.responses);
    await this.settingsService.setCannedResponses(chave, lista);
    return { ok: true };
  }

  // ─── TTS (Text-to-Speech) ─────────────────────────────

  @Get('tts')
  @Roles('ADMIN')
  async getTtsConfig() {
    return this.settingsService.getTtsConfig();
  }

  // Voz da IA (liga/desliga, voz e chave Google) é da PLATAFORMA: usa o crédito
  // Google da plataforma. A clínica vê o status pelo GET; só o administrador do
  // sistema grava.
  @Patch('tts')
  @Roles('ADMIN')
  async setTtsConfig(@Request() req: any, @Body() body: { enabled?: boolean; googleApiKey?: string; voice?: string; language?: string }) {
    if (!ehSuperAdmin(req.user)) throw negarPermissao(SO_PLATAFORMA_MSG);
    await this.settingsService.setTtsConfig(body);
    return { ok: true };
  }
}

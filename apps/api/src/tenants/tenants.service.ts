/**
 * Onda 17.32.77 — Service de gestao de tenants do SaaS.
 *
 * Implementa: list/findOne/create/update/setStatus. create() eh
 * transacional: cria Tenant + admin User. Roles do admin: ['ADMIN']
 * (admin DO TENANT, nao SUPER_ADMIN do SaaS).
 */
import { Injectable, BadRequestException, ConflictException, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import * as argon2 from 'argon2';
import { getLimitsForPlan, isWithinLimit } from './plan-limits.js';
// Onda 17.32.109 — Defaults plantados em cada tenant novo
import { seedTenantDefaults } from '@crm/shared';

@Injectable()
export class TenantsService {
  private readonly logger = new Logger(TenantsService.name);

  constructor(private prisma: PrismaService) {}

  async list(filters: { status?: string; q?: string }) {
    const where: any = {};
    if (filters.status) where.status = filters.status;
    if (filters.q && filters.q.trim()) {
      const q = filters.q.trim();
      where.OR = [
        { name: { contains: q, mode: 'insensitive' } },
        { slug: { contains: q, mode: 'insensitive' } },
        { email: { contains: q, mode: 'insensitive' } },
        { cpf_cnpj: { contains: q } },
      ];
    }
    const tenants = await this.prisma.tenant.findMany({
      where,
      orderBy: { created_at: 'desc' },
      include: {
        _count: {
          select: {
            users: true,
            patients: true,
            leads: true,
            payment_gateway_charges: true,
          },
        },
      },
    });
    return tenants;
  }

  async findOne(id: string) {
    const tenant = await this.prisma.tenant.findUnique({
      where: { id },
      include: {
        _count: {
          select: {
            users: true,
            patients: true,
            leads: true,
            payment_gateway_charges: true,
            conversations: true,
            quote_templates: true,
          },
        },
      },
    });
    return tenant;
  }

  /**
   * Onda 17.32.88 — Slugifica de verdade: lowercase, remove acentos,
   * troca espaços/pontos por hifen, colapsa hifens duplos, trim.
   * Chamado no create/update pra blindar caller (signup, admin, etc).
   */
  private slugify(raw: string | null | undefined): string | null {
    if (!raw) return null;
    const s = String(raw)
      .toLowerCase()
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')    // remove diacriticos
      .replace(/[^a-z0-9]+/g, '-')          // tudo nao-alfanum vira hifen
      .replace(/^-+|-+$/g, '')             // tira hifen das pontas
      .replace(/--+/g, '-')                // colapsa hifens duplos
      .slice(0, 40);
    return s || null;
  }

  async create(body: any) {
    // Slugifica de verdade (não só lowercase) — Onda 17.32.88
    if (body.slug) body.slug = this.slugify(body.slug);

    // Valida slug unico (se informado)
    if (body.slug) {
      const existing = await this.prisma.tenant.findUnique({
        where: { slug: body.slug },
      });
      if (existing) {
        throw new ConflictException('Slug ja em uso');
      }
    }
    // Valida email do admin unico
    const existingAdmin = await this.prisma.user.findUnique({
      where: { email: body.admin.email.toLowerCase() },
    });
    if (existingAdmin) {
      throw new ConflictException('Email do admin ja cadastrado em outro tenant');
    }

    const passwordHash = await argon2.hash(body.admin.password);

    // Transacao: cria Tenant + Admin User atomicamente
    return this.prisma.$transaction(async (tx) => {
      const tenant = await tx.tenant.create({
        data: {
          name: body.name.trim(),
          slug: body.slug || null,
          email: body.email || null,
          phone: body.phone || null,
          cpf_cnpj: body.cpf_cnpj || null,
          plan: body.plan || 'STARTER',
          status: body.status || 'TRIAL',
          trial_ends_at: body.trial_ends_at
            ? new Date(body.trial_ends_at)
            : (body.status === 'TRIAL' || !body.status)
              // Default trial: 14 dias
              ? new Date(Date.now() + 14 * 24 * 60 * 60 * 1000)
              : null,
        },
      });

      const adminUser = await tx.user.create({
        data: {
          tenant_id: tenant.id,
          name: body.admin.name.trim(),
          email: body.admin.email.toLowerCase().trim(),
          password_hash: passwordHash,
          phone: body.admin.phone || null,
          roles: ['ADMIN'],
        },
      });

      // Vincula admin como owner do tenant
      const updated = await tx.tenant.update({
        where: { id: tenant.id },
        data: { owner_user_id: adminUser.id },
      });

      // Onda 17.32.109 — Popula defaults (especialidades, tabela de
      // precos com 30 procedimentos, ficha de anamnese V3) DENTRO da
      // mesma transacao. Se algo falhar, o tenant inteiro eh revertido.
      // Idempotente: pode rodar de novo manualmente via /tenants/me/seed-defaults.
      try {
        const result = await seedTenantDefaults(tx, tenant.id);
        this.logger.log(
          `[TENANT-CREATE] Defaults plantados: ${result.specialties} especialidades, ${result.procedures} procedimentos, anamnese V3.`,
        );
      } catch (err: any) {
        this.logger.error(
          `[TENANT-CREATE] Falha ao plantar defaults: ${err?.message}`,
        );
        throw err; // aborta a transacao — tenant nao fica meio-criado
      }

      this.logger.log(
        `[TENANT-CREATE] Tenant "${tenant.name}" (id=${tenant.id}) criado com admin ${adminUser.email}`,
      );

      return {
        tenant: updated,
        admin: {
          id: adminUser.id,
          email: adminUser.email,
          name: adminUser.name,
        },
      };
    });
  }

  /**
   * Onda 17.32.109 — Re-roda os defaults pra um tenant existente.
   * Util pra tenants antigos que ainda nao tem a tabela de precos ou
   * a ficha de anamnese plantada. Idempotente — upserts em (tenant_id,
   * nome). Atualiza procedimentos ja existentes pra preco/duracao
   * base, NAO apaga os procedimentos custom criados pela clinica.
   */
  /**
   * Onda 17.32.111 — Roda os defaults em TODOS os tenants ativos
   * (status != DELETED). Idempotente. Util pra propagar mudancas na
   * tabela base ou pra recuperar tenants criados antes do seed
   * automatico.
   *
   * Roda 1 a 1 (sequencial) pra logs claros e evitar contencao no
   * banco. Em cada tenant: try/catch isolado — falha de um nao
   * derruba o resto.
   */
  async seedDefaultsForAll(): Promise<{
    total: number;
    success: number;
    failed: number;
    results: Array<{ tenant_id: string; name: string; ok: boolean; error?: string; specialties?: number; procedures?: number }>;
  }> {
    const tenants = await this.prisma.tenant.findMany({
      where: { status: { not: 'DELETED' } },
      select: { id: true, name: true },
      orderBy: { created_at: 'asc' },
    });
    const results = [];
    let success = 0;
    let failed = 0;
    for (const t of tenants) {
      try {
        const r = await seedTenantDefaults(this.prisma, t.id);
        results.push({
          tenant_id: t.id, name: t.name, ok: true,
          specialties: r.specialties, procedures: r.procedures,
        });
        success++;
        this.logger.log(`[SEED-ALL] ${t.name}: OK`);
      } catch (err: any) {
        results.push({ tenant_id: t.id, name: t.name, ok: false, error: err?.message ?? String(err) });
        failed++;
        this.logger.error(`[SEED-ALL] ${t.name}: FALHOU — ${err?.message}`);
      }
    }
    this.logger.log(`[SEED-ALL] Concluido: ${success} OK, ${failed} falhas (${tenants.length} tenants).`);
    return { total: tenants.length, success, failed, results };
  }

  async seedDefaults(tenantId: string) {
    const tenant = await this.prisma.tenant.findUnique({ where: { id: tenantId } });
    if (!tenant) throw new BadRequestException('Tenant nao encontrado');
    const result = await seedTenantDefaults(this.prisma, tenantId);
    this.logger.log(
      `[TENANT-SEED] ${tenant.name} (${tenantId}): ${result.specialties} especialidades, ${result.procedures} procedimentos, anamnese V3.`,
    );
    return result;
  }

  /**
   * Onda 17.32.123 — Estado do onboarding com auto-detect.
   * Calcula o status real de cada etapa olhando o estado do banco
   * (TenantSetting, Patient, User count). Atualiza onboarding_state
   * persistido se mudou pra acelerar consultas futuras.
   */
  async getOnboarding(tenantId: string) {
    const t = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { onboarding_state: true },
    });
    const persisted = (t?.onboarding_state ?? {}) as Record<string, any>;

    // Onda 17.32.140 — Auto-detect SO via legacy (EVOLUTION_API_KEY
    // / EVOLUTION_INSTANCE_NAME). Antes incluia
    // WHATSAPP_INSTANCE_NAMES_JSON (Onda 137), mas isso marcava como
    // done so por ter criado uma instancia — mesmo se ela estiver
    // desconectada. O frontend agora marca como done apenas quando
    // detecta status open via polling no Quick Connect inline.
    const evolution = await this.prisma.tenantSetting.findFirst({
      where: {
        tenant_id: tenantId,
        key: { in: ['EVOLUTION_API_KEY', 'EVOLUTION_INSTANCE_NAME'] },
      },
    });
    const whatsappReady = !!evolution;

    // Auto-detect Asaas
    const asaas = await this.prisma.tenantSetting.findFirst({
      where: { tenant_id: tenantId, key: 'ASAAS_API_KEY' },
    });
    const asaasReady = !!asaas;

    // Auto-detect 1° paciente
    const patientCount = await this.prisma.patient.count({ where: { tenant_id: tenantId } });
    const hasPatient = patientCount > 0;

    // Auto-detect equipe (mais de 1 user = convidou alguem)
    const userCount = await this.prisma.user.count({ where: { tenant_id: tenantId } });
    const hasTeam = userCount > 1;

    // Onda 17.32.152 — Auto-detect identidade da clinica: name, phone,
    // email e cpf_cnpj todos preenchidos = done. Sao os 4 dados que
    // aparecem em cabecalho de recibos, contratos, NFs.
    const tenantRow = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { name: true, phone: true, email: true, cpf_cnpj: true },
    });
    const clinicProfileReady = !!(
      tenantRow?.name?.trim() &&
      tenantRow?.phone?.trim() &&
      tenantRow?.email?.trim() &&
      tenantRow?.cpf_cnpj?.trim()
    );

    const steps = {
      clinic_profile: clinicProfileReady ? 'done' : (persisted.clinic_profile ?? 'pending'),
      whatsapp:      whatsappReady ? 'done' : (persisted.whatsapp      ?? 'pending'),
      asaas:         asaasReady    ? 'done' : (persisted.asaas         ?? 'pending'),
      first_patient: hasPatient    ? 'done' : (persisted.first_patient ?? 'pending'),
      team:          hasTeam       ? 'done' : (persisted.team          ?? 'pending'),
      // Onda 17.32.151 — Tabela de precos. Auto-detect: se ja editou
      // pelo menos 1 procedimento apos a criacao (updated_at > created_at + 30s),
      // considera "revisado". Senao, persisted ou pending.
      pricing:       (await this.detectPricingReviewed(tenantId))
                       ? 'done'
                       : (persisted.pricing ?? 'pending'),
    };

    return {
      steps,
      completed_at: persisted.completed_at ?? null,
      dismissed_at: persisted.dismissed_at ?? null,
      // Total de etapas obrigatorias (clinic_profile + whatsapp + asaas)
      // que ainda nao estao done. Frontend usa pra decidir se mostra
      // wizard agora.
      required_pending: ['clinic_profile', 'whatsapp', 'asaas'].filter(s => (steps as any)[s] !== 'done').length,
      // Quantas etapas opcionais ainda nao foram tocadas (paciente, equipe, precos)
      optional_pending: ['first_patient', 'team', 'pricing'].filter(s => (steps as any)[s] === 'pending').length,
    };
  }

  /**
   * Onda 17.32.151 — Detecta se o tenant ja revisou a tabela de
   * precos. Heuristica: pelo menos 1 procedimento com updated_at
   * significativamente apos o created_at do seed (margem 30s pra
   * ignorar diferenca de timing do upsert no seed).
   *
   * Onda 17.32.162 — Era $queryRaw com nome de tabela hardcoded
   * ('procedures') — renomear o modelo quebrava em silencio (catch
   * devolvia false e a etapa nunca virava done). Agora usa o client
   * Prisma tipado e compara em memoria (tenant tem ~30 procedures;
   * trazer 2 timestamps por linha e barato).
   */
  private async detectPricingReviewed(tenantId: string): Promise<boolean> {
    try {
      const rows = await this.prisma.procedure.findMany({
        where: { tenant_id: tenantId },
        select: { created_at: true, updated_at: true },
      });
      const MARGIN_MS = 30_000;
      return rows.some(
        (p) => p.updated_at.getTime() - p.created_at.getTime() > MARGIN_MS,
      );
    } catch {
      return false;
    }
  }

  async setOnboardingStep(tenantId: string, step: string, status: 'done' | 'skipped') {
    const allowed = ['clinic_profile', 'whatsapp', 'asaas', 'first_patient', 'team', 'pricing'];
    if (!allowed.includes(step)) {
      throw new BadRequestException(`Etapa invalida: ${step}`);
    }
    if (status !== 'done' && status !== 'skipped') {
      throw new BadRequestException(`Status invalido: ${status}`);
    }
    const t = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { onboarding_state: true },
    });
    const state = ((t?.onboarding_state ?? {}) as Record<string, any>);
    state[step] = status;
    await this.prisma.tenant.update({
      where: { id: tenantId },
      data:  { onboarding_state: state as any },
    });
    return this.getOnboarding(tenantId);
  }

  async completeOnboarding(tenantId: string) {
    const t = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { onboarding_state: true },
    });
    const state = ((t?.onboarding_state ?? {}) as Record<string, any>);
    state.completed_at = new Date().toISOString();
    await this.prisma.tenant.update({
      where: { id: tenantId },
      data:  { onboarding_state: state as any },
    });
    return this.getOnboarding(tenantId);
  }

  async dismissOnboarding(tenantId: string) {
    const t = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { onboarding_state: true },
    });
    const state = ((t?.onboarding_state ?? {}) as Record<string, any>);
    state.dismissed_at = new Date().toISOString();
    await this.prisma.tenant.update({
      where: { id: tenantId },
      data:  { onboarding_state: state as any },
    });
    return this.getOnboarding(tenantId);
  }

  async update(id: string, body: any) {
    const existing = await this.prisma.tenant.findUnique({ where: { id } });
    if (!existing) throw new BadRequestException('Tenant nao encontrado');

    // Slugifica de verdade antes de validar — Onda 17.32.88
    if (body.slug !== undefined && body.slug !== null) {
      body.slug = this.slugify(body.slug);
    }

    // Slug unico (se mudou)
    if (body.slug && body.slug !== existing.slug) {
      const conflict = await this.prisma.tenant.findUnique({
        where: { slug: body.slug },
      });
      if (conflict) throw new ConflictException('Slug ja em uso');
    }

    const data: any = {};
    const allowedFields = [
      'name', 'slug', 'email', 'phone', 'cpf_cnpj',
      'logo_url', 'theme_color', 'custom_domain',
      'plan', 'owner_user_id',
    ];
    for (const f of allowedFields) {
      if (body[f] !== undefined) data[f] = body[f] || null;
    }
    if (body.trial_ends_at !== undefined) {
      data.trial_ends_at = body.trial_ends_at ? new Date(body.trial_ends_at) : null;
    }

    return this.prisma.tenant.update({ where: { id }, data });
  }

  /**
   * Onda 17.32.79 — Uso atual + limites do plano do tenant.
   * Usado por GET /tenants/me/usage (dashboard) e pelo PlanLimitGuard.
   */
  async getUsage(tenantId: string) {
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { plan: true, status: true },
    });
    if (!tenant) return null;
    const limits = getLimitsForPlan(tenant.plan);

    // Conta uso atual em paralelo
    const monthStart = new Date();
    monthStart.setDate(1);
    monthStart.setHours(0, 0, 0, 0);

    const [users, patients, inboxes, chargesMonth] = await Promise.all([
      this.prisma.user.count({ where: { tenant_id: tenantId } }),
      this.prisma.patient.count({ where: { tenant_id: tenantId } }),
      this.prisma.instance.count({ where: { tenant_id: tenantId } }),
      this.prisma.paymentGatewayCharge.count({
        where: { tenant_id: tenantId, created_at: { gte: monthStart } },
      }),
    ]);

    return {
      plan: tenant.plan,
      status: tenant.status,
      usage: { users, patients, inboxes, charges_this_month: chargesMonth },
      limits,
      // Helper: % de uso por categoria (cap em 100)
      usage_pct: {
        users: limits.max_users < 0 ? 0 : Math.min(100, Math.round((users / limits.max_users) * 100)),
        patients: limits.max_patients < 0 ? 0 : Math.min(100, Math.round((patients / limits.max_patients) * 100)),
        inboxes: limits.max_inboxes < 0 ? 0 : Math.min(100, Math.round((inboxes / limits.max_inboxes) * 100)),
        charges_this_month: limits.max_charges_per_month < 0 ? 0 : Math.min(100, Math.round((chargesMonth / limits.max_charges_per_month) * 100)),
      },
    };
  }

  /**
   * Onda 17.32.79 — Valida se o tenant ainda pode criar um recurso.
   * Throws ForbiddenException se limite atingido.
   */
  async assertCanCreate(tenantId: string, resource: 'user' | 'patient' | 'inbox' | 'charge') {
    const usage = await this.getUsage(tenantId);
    if (!usage) return; // sem tenant — nao bloqueia (legacy / dev)

    const map: Record<string, [number, number]> = {
      user: [usage.usage.users, usage.limits.max_users],
      patient: [usage.usage.patients, usage.limits.max_patients],
      inbox: [usage.usage.inboxes, usage.limits.max_inboxes],
      charge: [usage.usage.charges_this_month, usage.limits.max_charges_per_month],
    };
    const [current, max] = map[resource] || [0, -1];
    if (!isWithinLimit(current, max)) {
      throw new BadRequestException(
        `Limite do plano ${usage.plan} atingido pra ${resource} (${current}/${max}). Atualize o plano pra continuar.`,
      );
    }
  }

  /**
   * Onda 17.32.80 — Lista settings do tenant com mascara pra chaves
   * sensiveis (nao expoe API tokens completos no GET).
   */
  async listSettings(tenantId: string) {
    const items = await this.prisma.tenantSetting.findMany({
      where: { tenant_id: tenantId },
      orderBy: { key: 'asc' },
    });
    // Mascara chaves sensiveis: mostra so ultimos 4 chars
    const SENSITIVE_PATTERNS = [/token/i, /api_key/i, /password/i, /secret/i];
    return items.map((s) => {
      const isSensitive = SENSITIVE_PATTERNS.some((re) => re.test(s.key));
      const masked = isSensitive && s.value.length > 4
        ? `${'•'.repeat(Math.max(8, s.value.length - 4))}${s.value.slice(-4)}`
        : s.value;
      return {
        key: s.key,
        value: masked,
        is_sensitive: isSensitive,
        updated_at: s.updated_at,
      };
    });
  }

  async upsertSetting(tenantId: string, key: string, value: string) {
    if (!key || !value) {
      throw new BadRequestException('key e value sao obrigatorios');
    }
    const { setTenantSetting } = await import('./tenant-settings.helper.js');
    await setTenantSetting(this.prisma, tenantId, key, value);
    return { ok: true };
  }

  async deleteSetting(tenantId: string, key: string) {
    const { deleteTenantSetting } = await import('./tenant-settings.helper.js');
    await deleteTenantSetting(this.prisma, tenantId, key);
    return { ok: true };
  }

  async setStatus(id: string, status: string, reason?: string) {
    const data: any = { status };
    if (status === 'SUSPENDED') {
      data.suspended_at = new Date();
      data.suspended_reason = reason || null;
    } else if (status === 'ACTIVE') {
      data.suspended_at = null;
      data.suspended_reason = null;
    }
    return this.prisma.tenant.update({ where: { id }, data });
  }
}

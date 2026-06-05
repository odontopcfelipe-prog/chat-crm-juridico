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
import { getLimitsForPlan, isWithinLimit } from './plan-limits';

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

  async create(body: any) {
    // Valida slug unico (se informado)
    if (body.slug) {
      const existing = await this.prisma.tenant.findUnique({
        where: { slug: body.slug.toLowerCase() },
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
          slug: body.slug?.toLowerCase() || null,
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

  async update(id: string, body: any) {
    const existing = await this.prisma.tenant.findUnique({ where: { id } });
    if (!existing) throw new BadRequestException('Tenant nao encontrado');

    // Slug unico (se mudou)
    if (body.slug && body.slug !== existing.slug) {
      const conflict = await this.prisma.tenant.findUnique({
        where: { slug: body.slug.toLowerCase() },
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
    if (data.slug) data.slug = data.slug.toLowerCase();

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

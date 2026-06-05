/**
 * Onda 17.32.77 — Gestao de Tenants (SaaS Fase 1).
 *
 * Endpoints cross-tenant — exigem role SUPER_ADMIN. Permite:
 *  - Listar todos os tenants do SaaS
 *  - Criar novo tenant + admin user inicial
 *  - Editar dados / branding
 *  - Suspender / reativar
 *
 * Tudo protegido pelo SuperAdminGuard. Operadores normais (ADMIN dentro
 * de um tenant) nao tem acesso.
 */
import {
  Controller, Get, Post, Patch, Param, Body, Query, Req, BadRequestException, NotFoundException,
} from '@nestjs/common';
import { SuperAdmin } from '../auth/decorators/super-admin.decorator';
import { Public } from '../auth/decorators/public.decorator';
import { TenantsService } from './tenants.service';

/**
 * Onda 17.32.85 — Signup publico (rota nao autenticada).
 *
 * Permite que qualquer pessoa cadastre uma nova clinica e ja entre em
 * TRIAL de 14 dias. Cria Tenant + admin user atomicamente. Usuario
 * pode fazer login direto apos signup.
 */
@Controller('signup')
export class SignupController {
  constructor(private readonly service: TenantsService) {}

  @Public()
  @Post()
  async signup(@Body() body: {
    clinic_name: string;
    cpf_cnpj?: string;
    phone?: string;
    admin_name: string;
    admin_email: string;
    admin_password: string;
    plan?: string;
  }) {
    if (!body.clinic_name?.trim()) {
      throw new BadRequestException('Nome da clinica eh obrigatorio');
    }
    if (!body.admin_name?.trim() || !body.admin_email?.trim() || !body.admin_password) {
      throw new BadRequestException('Dados do administrador sao obrigatorios');
    }
    if (body.admin_password.length < 6) {
      throw new BadRequestException('Senha precisa ter ao menos 6 caracteres');
    }

    // Slug auto-gerado a partir do nome
    const slug = body.clinic_name
      .toLowerCase()
      .normalize('NFD').replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/(^-|-$)/g, '')
      .slice(0, 40);

    // Cria com status TRIAL — 14 dias de teste antes de cobrar
    return this.service.create({
      name: body.clinic_name.trim(),
      slug: slug || undefined,
      cpf_cnpj: body.cpf_cnpj?.replace(/\D/g, '') || undefined,
      phone: body.phone?.replace(/\D/g, '') || undefined,
      email: body.admin_email.toLowerCase().trim(),
      plan: body.plan || 'STARTER',
      status: 'TRIAL',
      admin: {
        name: body.admin_name.trim(),
        email: body.admin_email.toLowerCase().trim(),
        password: body.admin_password,
        phone: body.phone?.replace(/\D/g, ''),
      },
    });
  }
}

/**
 * Onda 17.32.78 — Endpoint publico (autenticado) pra qualquer user
 * consultar dados do PROPRIO tenant (white-label do frontend).
 * Separado pra nao depender do SuperAdminGuard.
 */
@Controller('tenants')
export class TenantsMeController {
  constructor(private readonly service: TenantsService) {}

  /** Retorna branding + status do tenant do usuario logado. */
  @Get('me')
  async getMyTenant(@Req() req: any) {
    const tenantId = req.user?.tenant_id;
    if (!tenantId) return null;
    const t = await this.service.findOne(tenantId);
    if (!t) return null;
    // Retorna so o necessario pra branding/UI (nao expoe contadores
    // sensiveis se nao for ADMIN do tenant)
    return {
      id: t.id,
      name: t.name,
      slug: t.slug,
      logo_url: t.logo_url,
      theme_color: t.theme_color,
      status: t.status,
      plan: t.plan,
      trial_ends_at: t.trial_ends_at,
    };
  }

  /**
   * Onda 17.32.79 — Uso atual + limites do plano. Frontend mostra
   * barras "X/Y pacientes" no dashboard com sugestao de upgrade
   * quando ultrapassar 80%.
   */
  @Get('me/usage')
  async getMyUsage(@Req() req: any) {
    const tenantId = req.user?.tenant_id;
    if (!tenantId) return null;
    return this.service.getUsage(tenantId);
  }
}

interface CreateTenantBody {
  name: string;
  slug?: string;
  email?: string;
  phone?: string;
  cpf_cnpj?: string;
  plan?: string;
  status?: string;
  trial_ends_at?: string;
  // Admin user inicial — obrigatorio
  admin: {
    name: string;
    email: string;
    password: string;
    phone?: string;
  };
}

interface UpdateTenantBody {
  name?: string;
  slug?: string;
  email?: string;
  phone?: string;
  cpf_cnpj?: string;
  logo_url?: string;
  theme_color?: string;
  custom_domain?: string;
  plan?: string;
  trial_ends_at?: string;
  owner_user_id?: string;
}

@Controller('tenants')
@SuperAdmin()
export class TenantsController {
  constructor(private readonly service: TenantsService) {}

  /** Lista todos os tenants do SaaS (com contadores e ultimo login). */
  @Get()
  list(@Query('status') status?: string, @Query('q') q?: string) {
    return this.service.list({ status, q });
  }

  /** Detalhe + estatisticas de uso. */
  @Get(':id')
  async findOne(@Param('id') id: string) {
    const tenant = await this.service.findOne(id);
    if (!tenant) throw new NotFoundException('Tenant nao encontrado');
    return tenant;
  }

  /** Cria tenant + admin inicial atomicamente. */
  @Post()
  create(@Body() body: CreateTenantBody) {
    if (!body.name || !body.name.trim()) {
      throw new BadRequestException('Nome do tenant eh obrigatorio');
    }
    if (!body.admin?.name || !body.admin?.email || !body.admin?.password) {
      throw new BadRequestException('Dados do admin inicial sao obrigatorios');
    }
    return this.service.create(body);
  }

  /** Atualiza dados / branding. */
  @Patch(':id')
  update(@Param('id') id: string, @Body() body: UpdateTenantBody) {
    return this.service.update(id, body);
  }

  /** Suspende — bloqueia login dos users do tenant. */
  @Post(':id/suspend')
  suspend(@Param('id') id: string, @Body() body: { reason?: string }) {
    return this.service.setStatus(id, 'SUSPENDED', body?.reason);
  }

  /** Reativa um tenant suspenso. */
  @Post(':id/activate')
  activate(@Param('id') id: string) {
    return this.service.setStatus(id, 'ACTIVE');
  }

  /**
   * Onda 17.32.80 — Settings POR tenant. Lista todos os overrides
   * do tenant (com mascara nos valores sensiveis pra nao vazar).
   * Chaves bem conhecidas:
   *   - ASAAS_API_KEY, ASAAS_BASE_URL
   *   - CLICKSIGN_API_TOKEN, CLICKSIGN_BASE_URL, CLICKSIGN_WEBHOOK_TOKEN
   *   - EVOLUTION_INSTANCE_NAME, EVOLUTION_API_KEY
   */
  @Get(':id/settings')
  async listSettings(@Param('id') id: string) {
    return this.service.listSettings(id);
  }

  @Post(':id/settings')
  async upsertSetting(
    @Param('id') id: string,
    @Body() body: { key: string; value: string },
  ) {
    return this.service.upsertSetting(id, body.key, body.value);
  }

  @Post(':id/settings/:key/delete')
  async deleteSetting(@Param('id') id: string, @Param('key') key: string) {
    return this.service.deleteSetting(id, key);
  }
}

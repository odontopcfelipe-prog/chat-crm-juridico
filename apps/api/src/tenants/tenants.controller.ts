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
  Controller, Get, Post, Patch, Param, Body, Query, Req, BadRequestException, ForbiddenException, NotFoundException,
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

    // Slug auto-gerado a partir do nome — Onda 17.32.88: usa range
    // Unicode explicito ̀-ͯ (combining diacritics) em vez de
    // chars invisiveis. Alem disso, o service tambem slugifica como
    // rede de seguranca.
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

  /** Retorna branding + status + dados de contato do tenant do usuario.
   * Onda 17.32.104 — Inclui phone/email/cpf_cnpj/custom_domain (antes
   * faltavam). Sem isso, a pagina /settings/identidade abria com os
   * campos vazios mesmo depois do usuario ter preenchido no signup.
   * Campos sensiveis (suspended_reason, owner_user_id, etc) seguem
   * fora — quem precisa deles eh o SUPER_ADMIN via /admin/tenants. */
  @Get('me')
  async getMyTenant(@Req() req: any) {
    const tenantId = req.user?.tenant_id;
    if (!tenantId) return null;
    const t = await this.service.findOne(tenantId);
    if (!t) return null;
    return {
      id: t.id,
      name: t.name,
      slug: t.slug,
      logo_url: t.logo_url,
      theme_color: t.theme_color,
      phone: t.phone,
      email: t.email,
      cpf_cnpj: t.cpf_cnpj,
      custom_domain: t.custom_domain,
      status: t.status,
      plan: t.plan,
      trial_ends_at: t.trial_ends_at,
      // Onda 17.32.150 — Identifica o ADMIN principal pra frontend
      // mostrar wizard/banner/trial-modal so pra ele.
      owner_user_id: t.owner_user_id,
      // Onda 17.32.154 — Endereco, responsavel tecnico e horarios
      zip_code:           (t as any).zip_code           ?? null,
      address:            (t as any).address            ?? null,
      address_number:     (t as any).address_number     ?? null,
      address_complement: (t as any).address_complement ?? null,
      neighborhood:       (t as any).neighborhood       ?? null,
      city:               (t as any).city               ?? null,
      state:              (t as any).state              ?? null,
      responsible_name:   (t as any).responsible_name   ?? null,
      responsible_cro:    (t as any).responsible_cro    ?? null,
      business_hours:     (t as any).business_hours     ?? null,
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

  /**
   * Onda 17.32.103 — ADMIN do tenant edita os proprios dados de
   * identidade (nome da clinica, logo, cor, contatos).
   *
   * Antes so o SUPER_ADMIN do SaaS conseguia editar isso via
   * /admin/tenants/:id — dono da clinica dependia de pedir suporte.
   * Agora ele mesmo ajusta direto pelo Configuracoes > Identidade.
   *
   * Aceita SO os campos de IDENTIDADE/contato — campos sensiveis
   * (plan, status, trial_ends_at, owner_user_id) ficam reservados
   * pro SUPER_ADMIN no admin/tenants/:id. */
  @Patch('me')
  async updateMyTenant(@Req() req: any, @Body() body: {
    name?: string;
    logo_url?: string | null;
    theme_color?: string | null;
    phone?: string | null;
    email?: string | null;
    cpf_cnpj?: string | null;
    custom_domain?: string | null;
    // Onda 17.32.154 — Endereco, responsavel, horarios
    zip_code?: string | null;
    address?: string | null;
    address_number?: string | null;
    address_complement?: string | null;
    neighborhood?: string | null;
    city?: string | null;
    state?: string | null;
    responsible_name?: string | null;
    responsible_cro?: string | null;
    business_hours?: string | null;
  }) {
    const tenantId = req.user?.tenant_id;
    const roles: string[] = req.user?.roles ?? [];
    if (!tenantId) throw new ForbiddenException('Sem tenant associado');
    if (!roles.includes('ADMIN') && !roles.includes('SUPER_ADMIN')) {
      throw new ForbiddenException('So ADMIN pode editar dados da clinica');
    }
    // Whitelist explicita — ignora qualquer outro campo no body
    const allowed: any = {};
    if (body.name !== undefined)          allowed.name = body.name;
    if (body.logo_url !== undefined)      allowed.logo_url = body.logo_url;
    if (body.theme_color !== undefined)   allowed.theme_color = body.theme_color;
    if (body.phone !== undefined)         allowed.phone = body.phone;
    if (body.email !== undefined)         allowed.email = body.email;
    if (body.cpf_cnpj !== undefined)      allowed.cpf_cnpj = body.cpf_cnpj;
    if (body.custom_domain !== undefined) allowed.custom_domain = body.custom_domain;
    // Onda 17.32.154 — Endereco, responsavel tec, horarios
    if (body.zip_code !== undefined)           allowed.zip_code = body.zip_code;
    if (body.address !== undefined)            allowed.address = body.address;
    if (body.address_number !== undefined)     allowed.address_number = body.address_number;
    if (body.address_complement !== undefined) allowed.address_complement = body.address_complement;
    if (body.neighborhood !== undefined)       allowed.neighborhood = body.neighborhood;
    if (body.city !== undefined)               allowed.city = body.city;
    if (body.state !== undefined)              allowed.state = body.state;
    if (body.responsible_name !== undefined)   allowed.responsible_name = body.responsible_name;
    if (body.responsible_cro !== undefined)    allowed.responsible_cro = body.responsible_cro;
    if (body.business_hours !== undefined)     allowed.business_hours = body.business_hours;

    return this.service.update(tenantId, allowed);
  }

  /**
   * Onda 17.32.123 — Estado do onboarding do tenant logado.
   * Calcula auto-detect de WhatsApp/Asaas via TenantSetting:
   *   - whatsapp = 'done' se EVOLUTION_API_KEY existe
   *   - asaas    = 'done' se ASAAS_API_KEY existe
   *   - first_patient = 'done' se ja tem Patient cadastrado
   *   - team = 'done' se tem mais de 1 User no tenant
   */
  @Get('me/onboarding')
  async getMyOnboarding(@Req() req: any) {
    const tenantId = req.user?.tenant_id;
    if (!tenantId) throw new ForbiddenException('Sem tenant associado');
    return this.service.getOnboarding(tenantId);
  }

  /**
   * Onda 17.32.123 — Marca uma etapa do onboarding como done/skipped.
   * Body: { step: 'whatsapp'|'asaas'|'first_patient'|'team', status: 'done'|'skipped' }
   */
  @Patch('me/onboarding/step')
  async patchMyOnboardingStep(
    @Req() req: any,
    @Body() body: { step: string; status: 'done' | 'skipped' },
  ) {
    const tenantId = req.user?.tenant_id;
    if (!tenantId) throw new ForbiddenException('Sem tenant associado');
    return this.service.setOnboardingStep(tenantId, body.step, body.status);
  }

  /** Onda 17.32.123 — Marca wizard como concluído (não reaparece). */
  @Post('me/onboarding/complete')
  async completeMyOnboarding(@Req() req: any) {
    const tenantId = req.user?.tenant_id;
    if (!tenantId) throw new ForbiddenException('Sem tenant associado');
    return this.service.completeOnboarding(tenantId);
  }

  /** Onda 17.32.123 — Fecha wizard temporariamente (volta amanhã). */
  @Post('me/onboarding/dismiss')
  async dismissMyOnboarding(@Req() req: any) {
    const tenantId = req.user?.tenant_id;
    if (!tenantId) throw new ForbiddenException('Sem tenant associado');
    return this.service.dismissOnboarding(tenantId);
  }

  /**
   * Onda 17.32.109 — Re-popula os defaults (especialidades + tabela
   * de precos + ficha de anamnese V3) no tenant logado. Util pra
   * tenants antigos que ainda nao tinham esses defaults plantados.
   *
   * Idempotente: upsert por (tenant_id, nome). Atualiza dados base mas
   * NAO apaga procedimentos custom criados pela clinica. So ADMIN pode
   * disparar.
   */
  @Post('me/seed-defaults')
  async seedMyDefaults(@Req() req: any) {
    const tenantId = req.user?.tenant_id;
    const roles: string[] = req.user?.roles ?? [];
    if (!tenantId) throw new ForbiddenException('Sem tenant associado');
    if (!roles.includes('ADMIN') && !roles.includes('SUPER_ADMIN')) {
      throw new ForbiddenException('So ADMIN pode plantar defaults');
    }
    return this.service.seedDefaults(tenantId);
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

// Onda 17.32.107 — @SuperAdmin() ficava no nivel do controller, o que
// aplicava o guard em TODAS as rotas — incluindo, por colisao de
// roteamento, GET /tenants/me (que matchava /tenants/:id antes de cair
// no TenantsMeController). Agora o guard eh por rota individual:
// rotas que precisam dele tem @SuperAdmin() explicito; as demais nao.
@Controller('tenants')
export class TenantsController {
  constructor(private readonly service: TenantsService) {}

  /** Lista todos os tenants do SaaS (com contadores e ultimo login). */
  @Get()
  @SuperAdmin()
  list(@Query('status') status?: string, @Query('q') q?: string) {
    return this.service.list({ status, q });
  }

  /** Detalhe + estatisticas de uso. */
  @Get(':id')
  @SuperAdmin()
  async findOne(@Param('id') id: string) {
    const tenant = await this.service.findOne(id);
    if (!tenant) throw new NotFoundException('Tenant nao encontrado');
    return tenant;
  }

  /** Cria tenant + admin inicial atomicamente. */
  @Post()
  @SuperAdmin()
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
  @SuperAdmin()
  update(@Param('id') id: string, @Body() body: UpdateTenantBody) {
    return this.service.update(id, body);
  }

  /** Suspende — bloqueia login dos users do tenant. */
  @Post(':id/suspend')
  @SuperAdmin()
  suspend(@Param('id') id: string, @Body() body: { reason?: string }) {
    return this.service.setStatus(id, 'SUSPENDED', body?.reason);
  }

  /** Reativa um tenant suspenso. */
  @Post(':id/activate')
  @SuperAdmin()
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
  @SuperAdmin()
  async listSettings(@Param('id') id: string) {
    return this.service.listSettings(id);
  }

  @Post(':id/settings')
  @SuperAdmin()
  async upsertSetting(
    @Param('id') id: string,
    @Body() body: { key: string; value: string },
  ) {
    return this.service.upsertSetting(id, body.key, body.value);
  }

  @Post(':id/settings/:key/delete')
  @SuperAdmin()
  async deleteSetting(@Param('id') id: string, @Param('key') key: string) {
    return this.service.deleteSetting(id, key);
  }

  /**
   * Onda 17.32.111 — Re-popula os defaults (especialidades, tabela de
   * precos, ficha de anamnese) em TODOS os tenants ativos. Util pra
   * propagar atualizacoes da tabela base ou recuperar tenants que
   * foram criados antes do seed automatico.
   *
   * Idempotente: upsert por nome — nao duplica nem apaga procedimentos
   * custom criados pelas clinicas. So SUPER_ADMIN dispara.
   */
  @Post('seed-defaults-all')
  @SuperAdmin()
  async seedAll() {
    return this.service.seedDefaultsForAll();
  }
}

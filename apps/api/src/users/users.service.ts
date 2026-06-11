import { Injectable, ForbiddenException, BadRequestException, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { FileStorageService } from '../media/filesystem.service';
import { SettingsService } from '../settings/settings.service';
import { createSmtpTransport } from '../common/utils/smtp.util';
import { Prisma, User } from '@crm/shared';
import * as argon2 from 'argon2';
import { randomBytes } from 'crypto';

/**
 * Normaliza valores legados de role (nomes de departamento em PT-BR, plurais,
 * variações de acentuação) para o enum canônico usado pelo sistema de permissões.
 *
 * Motivação: historicamente o formulário de usuários salvava o nome do
 * departamento como role (ex: "Dentistas", "Estagiário", "Atendente Comercial").
 * Isso quebrava todos os checks de permissão (`roles.includes('ADVOGADO')` etc.).
 * Essa camada garante que, independente do que chegue via API, o banco só
 * receba os 6 enums canônicos suportados por useRole.ts.
 */
const CANONICAL_ROLES = ['ADMIN', 'DENTIST', 'OPERADOR', 'COMERCIAL', 'ASSISTANT', 'FINANCEIRO'] as const;
type CanonicalRole = typeof CANONICAL_ROLES[number];

function normalizeRole(raw: string): CanonicalRole {
  if (!raw) return 'OPERADOR';
  const upper = raw.toString().toUpperCase().trim();
  if (upper === 'ADMIN') return 'ADMIN';
  // Compat: aceita roles legados do domínio jurídico (ADVOGADO/ESTAGIARIO) — banco
  // pré-migração pode conter esses valores; normalizamos para o enum odontológico.
  if (upper === 'ADVOGADO' || upper === 'ADVOGADOS' || upper === 'DENTIST' || upper === 'DENTISTS') return 'DENTIST';
  if (upper === 'OPERADOR' || upper === 'OPERADORES') return 'OPERADOR';
  if (upper === 'COMERCIAL' || upper === 'ATENDENTE COMERCIAL') return 'COMERCIAL';
  if (upper === 'ESTAGIARIO' || upper === 'ESTAGIÁRIO' || upper === 'ESTAGIARIOS' || upper === 'ESTAGIÁRIOS' || upper === 'ASSISTANT' || upper === 'ASSISTANTS') return 'ASSISTANT';
  if (upper === 'FINANCEIRO') return 'FINANCEIRO';
  return 'OPERADOR'; // fallback seguro
}

function normalizeRoles(roles: string[] | undefined | null, legacyRole?: string): CanonicalRole[] {
  const source = (roles && roles.length > 0 ? roles : legacyRole ? [legacyRole] : []).filter(Boolean);
  if (source.length === 0) return ['OPERADOR'];
  const normalized = source.map(normalizeRole);
  // Dedup mantendo ordem
  const seen = new Set<CanonicalRole>();
  return normalized.filter(r => (seen.has(r) ? false : (seen.add(r), true)));
}

@Injectable()
export class UsersService {
  private readonly logger = new Logger(UsersService.name);
  constructor(
    private prisma: PrismaService,
    private fileStorage: FileStorageService,
    private settings: SettingsService,
  ) {}

  private tenantWhere(tenantId?: string) {
    return tenantId ? { OR: [{ tenant_id: tenantId }, { tenant_id: null }] } : {};
  }

  private async verifyTenantOwnership(id: string, tenantId?: string) {
    if (!tenantId) return;
    const user = await this.prisma.user.findUnique({ where: { id }, select: { tenant_id: true } });
    if (user?.tenant_id && user.tenant_id !== tenantId) {
      throw new ForbiddenException('Acesso negado a este recurso');
    }
  }

  async findAgents(tenantId?: string): Promise<{ id: string; name: string; specialties: string[] }[]> {
    return (this.prisma as any).user.findMany({
      where: this.tenantWhere(tenantId),
      select: { id: true, name: true, specialties: true },
      orderBy: { name: 'asc' },
    });
  }

  async findAll(tenantId?: string): Promise<Omit<User, 'password_hash'>[]> {
    const users = await (this.prisma as any).user.findMany({
      where: this.tenantWhere(tenantId),
      orderBy: { created_at: 'desc' },
      include: {
        inboxes: { select: { id: true, name: true } },
        supervisors: { select: { id: true, name: true } },
      },
    });
    return users.map(({ password_hash, ...user }: any) => user);
  }

  async findOne(email: string): Promise<User | null> {
    return this.prisma.user.findUnique({ where: { email } });
  }

  async findById(id: string, tenantId?: string): Promise<Omit<User, 'password_hash'> | null> {
    await this.verifyTenantOwnership(id, tenantId);
    const user = await (this.prisma as any).user.findUnique({
      where: { id },
      include: {
        inboxes: { select: { id: true, name: true } },
      },
    });
    if (!user) return null;
    const { password_hash, ...result } = user as any;
    return result;
  }

  async create(data: { name: string; email: string; password: string; role?: string; roles?: string[]; tenant_id?: string; inboxIds?: string[]; specialties?: string[]; phone?: string; cro_number?: string; cro_uf?: string }): Promise<Omit<User, 'password_hash'>> {
    // Onda 17.32.79 — Valida limite do plano antes de criar.
    // Lazy import pra evitar ciclo de dependencia.
    if (data.tenant_id) {
      try {
        const { getLimitsForPlan, isWithinLimit } = await import('../tenants/plan-limits.js');
        const tenant = await this.prisma.tenant.findUnique({
          where: { id: data.tenant_id },
          select: { plan: true },
        });
        const limits = getLimitsForPlan(tenant?.plan);
        const currentUsers = await this.prisma.user.count({ where: { tenant_id: data.tenant_id } });
        if (!isWithinLimit(currentUsers, limits.max_users)) {
          throw new Error(
            `Limite do plano ${tenant?.plan} atingido pra usuarios (${currentUsers}/${limits.max_users}). Atualize o plano pra continuar.`,
          );
        }
      } catch (e: any) {
        if (e.message?.includes('Limite do plano')) throw new BadRequestException(e.message);
        // Outros erros nao bloqueiam — best-effort
      }
    }
    const password_hash = await argon2.hash(data.password);
    // Normaliza para o enum canônico. Aceita tanto `roles[]` (forma nova) quanto `role` (legado).
    const normalizedRoles = normalizeRoles(data.roles, data.role);
    // Onda 17.32.172 — token de confirmacao de e-mail gerado no cadastro
    const verifyToken = randomBytes(32).toString('hex');
    let user;
    try {
      user = await this.prisma.user.create({
        data: {
          name: data.name,
          email: data.email,
          phone: data.phone || null,
          password_hash,
          roles: normalizedRoles,
          specialties: data.specialties ?? [],
          cro_number: data.cro_number || null,
          cro_uf: data.cro_uf || null,
          tenant_id: data.tenant_id,
          email_verify_token: verifyToken,
          email_verify_sent_at: new Date(),
          inboxes: data.inboxIds ? { connect: data.inboxIds.map(id => ({ id })) } : undefined
        },
        include: { inboxes: { select: { id: true, name: true } } }
      });
    } catch (e: any) {
      // Onda 17.32.173 — P2002 (unique) vazava como "Erro interno do
      // servidor" (500). Caso classico: cadastrar membro com o MESMO
      // e-mail do admin/da clinica. Devolve mensagem clara.
      if (e?.code === 'P2002') {
        throw new BadRequestException('Já existe um usuário com este e-mail. Use outro endereço.');
      }
      // P2025 — inboxIds apontando pra inbox inexistente
      if (e?.code === 'P2025') {
        throw new BadRequestException('Inbox selecionada não existe mais. Recarregue a página e tente de novo.');
      }
      this.logger.error(`[USERS] Falha inesperada ao criar usuario (${data.email}): code=${e?.code} ${e?.message}`);
      throw e;
    }
    // Envio best-effort em background — criar o usuario NUNCA falha
    // por causa de SMTP (sem config, e-mail invalido, servidor fora).
    this.sendVerificationEmail(user.email, user.name, verifyToken, data.tenant_id)
      .catch((e) => this.logger.warn(`[VERIFY-EMAIL] Falha ao enviar pra ${user.email}: ${e?.message}`));
    const { password_hash: _, ...result } = user;
    return result as any;
  }

  // ─── Confirmacao de e-mail (Onda 17.32.172) ────────────────────

  /**
   * Envia o e-mail de confirmacao com o link /verificar-email?token=...
   * Usa o SMTP global das settings (mesma fonte dos lembretes da agenda).
   * Retorna false (sem lancar) quando SMTP nao esta configurado.
   */
  private async sendVerificationEmail(email: string, name: string, token: string, tenantId?: string): Promise<boolean> {
    const smtp = await this.settings.getSmtpConfig();
    if (!smtp.host) {
      this.logger.warn('[VERIFY-EMAIL] SMTP nao configurado — e-mail de confirmacao ignorado');
      return false;
    }

    let clinicName = 'Odonto System';
    if (tenantId) {
      const tenant = await this.prisma.tenant.findUnique({ where: { id: tenantId }, select: { name: true } });
      if (tenant?.name) clinicName = tenant.name;
    }

    const publicUrl = (process.env.PUBLIC_WEB_URL || 'https://sistema.institutoodontopassos.com.br').replace(/\/+$/, '');
    const link = `${publicUrl}/verificar-email?token=${token}`;

    // Onda 17.32.175 — resolve o host via dns.lookup antes do nodemailer
    // (o resolve4 interno dele falha no Swarm; ver smtp.util.ts)
    const transporter = await createSmtpTransport(smtp);

    const html = `
      <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 480px; margin: 0 auto; padding: 24px;">
        <div style="background: #ffffff; border: 1px solid #e4e4e7; border-radius: 16px; padding: 28px; color: #3f3f46;">
          <h2 style="margin: 0 0 6px; color: #18181b; font-size: 19px;">Bem-vindo(a) à equipe, ${name}!</h2>
          <p style="margin: 0 0 18px; color: #71717a; font-size: 14px;">
            Você foi cadastrado(a) no sistema da <b style="color:#3f3f46;">${clinicName}</b>.
            Confirme seu e-mail pra validar o seu acesso:
          </p>
          <p style="text-align: center; margin: 0 0 18px;">
            <a href="${link}" style="display: inline-block; background: #059669; color: #fff; text-decoration: none; font-weight: 600; font-size: 14px; padding: 12px 24px; border-radius: 12px;">
              Confirmar meu e-mail
            </a>
          </p>
          <p style="margin: 0; color: #a1a1aa; font-size: 12px;">
            Pra entrar, use este e-mail e a senha que o administrador definiu pra você.
            Se você não esperava este convite, ignore esta mensagem.
          </p>
        </div>
        <p style="text-align: center; color: #a1a1aa; font-size: 11px; margin-top: 14px;">
          Enviado automaticamente pelo Odonto System — ${clinicName}
        </p>
      </div>
    `;

    await transporter.sendMail({
      from: smtp.from || smtp.user,
      to: email,
      subject: `Confirme seu e-mail — ${clinicName}`,
      html,
    });
    this.logger.log(`[VERIFY-EMAIL] E-mail de confirmacao enviado pra ${email}`);
    return true;
  }

  /** Valida o token do link e marca o e-mail como confirmado. Rota publica. */
  async verifyEmail(token: string): Promise<{ ok: true; name: string; email: string }> {
    if (!token || token.length < 32) {
      throw new BadRequestException('Link inválido.');
    }
    const user = await this.prisma.user.findFirst({
      where: { email_verify_token: token },
      select: { id: true, name: true, email: true, email_verify_sent_at: true },
    });
    if (!user) {
      throw new BadRequestException('Link inválido ou já utilizado.');
    }
    // Expira em 7 dias — o admin pode reenviar pela tela de equipe
    const sentAt = user.email_verify_sent_at ? new Date(user.email_verify_sent_at).getTime() : 0;
    if (Date.now() - sentAt > 7 * 24 * 60 * 60 * 1000) {
      throw new BadRequestException('Link expirado. Peça ao administrador pra reenviar a confirmação.');
    }
    await this.prisma.user.update({
      where: { id: user.id },
      data: { email_verified_at: new Date(), email_verify_token: null },
    });
    this.logger.log(`[VERIFY-EMAIL] E-mail confirmado: ${user.email}`);
    return { ok: true, name: user.name, email: user.email };
  }

  /** Gera novo token e reenvia o e-mail de confirmacao (ADMIN). */
  async resendVerification(id: string, tenantId?: string): Promise<{ ok: boolean; already_verified?: boolean; sent?: boolean }> {
    await this.verifyTenantOwnership(id, tenantId);
    const user = await this.prisma.user.findUnique({
      where: { id },
      select: { id: true, name: true, email: true, email_verified_at: true, tenant_id: true },
    });
    if (!user) throw new BadRequestException('Usuário não encontrado.');
    if (user.email_verified_at) return { ok: true, already_verified: true };

    const verifyToken = randomBytes(32).toString('hex');
    // Onda 17.32.178 — ENVIA PRIMEIRO, persiste DEPOIS: se o reenvio
    // falhar, o token anterior continua valendo (antes, um reenvio
    // falho invalidava o link do e-mail que JA tinha chegado).
    // Onda 17.32.174 — erro de envio NAO pode vazar como 500 generico:
    // o admin precisa ver o motivo real (DNS, porta bloqueada, senha
    // recusada) pra conseguir agir.
    let sent = false;
    try {
      sent = await this.sendVerificationEmail(user.email, user.name, verifyToken, user.tenant_id || tenantId);
    } catch (e: any) {
      const code = e?.code || e?.responseCode || '';
      this.logger.error(`[VERIFY-EMAIL] Reenvio falhou pra ${user.email}: code=${code} ${e?.message}`);
      if (code === 'ENOTFOUND' || code === 'EAI_AGAIN' || code === 'EDNS') {
        throw new BadRequestException('Servidor de e-mail inacessível (falha de DNS no servidor). Avise o suporte técnico.');
      }
      if (code === 'ETIMEDOUT' || code === 'ESOCKET' || code === 'ECONNECTION' || code === 'ECONNREFUSED') {
        throw new BadRequestException('Não foi possível conectar ao servidor SMTP — o provedor pode estar bloqueando a porta de e-mail.');
      }
      if (code === 'EAUTH' || code === 535) {
        throw new BadRequestException('Usuário ou senha SMTP recusados. Confira se a senha é uma "senha de app" válida.');
      }
      throw new BadRequestException(`Falha ao enviar o e-mail: ${e?.message || 'erro desconhecido'}`);
    }
    if (!sent) {
      throw new BadRequestException('SMTP não configurado — configure o servidor de e-mail nas settings antes de reenviar.');
    }
    // Envio confirmado — agora sim o token novo passa a valer
    await this.prisma.user.update({
      where: { id },
      data: { email_verify_token: verifyToken, email_verify_sent_at: new Date() },
    });
    return { ok: true, sent: true };
  }

  async update(id: string, data: { name?: string; email?: string; role?: string; roles?: string[]; password?: string; inboxIds?: string[]; specialties?: string[]; phone?: string; cro_number?: string; cro_uf?: string; sector?: string; extra_grants?: string[]; extra_revokes?: string[] }, tenantId?: string): Promise<Omit<User, 'password_hash'>> {
    await this.verifyTenantOwnership(id, tenantId);
    const updateData: Prisma.UserUpdateInput = {};
    if (data.name) updateData.name = data.name;
    if (data.email) updateData.email = data.email;
    // Multi-role: aceita roles[] (array) OU role (string legado). Sempre normaliza p/ enum canônico.
    let normalizedRoles: CanonicalRole[] | undefined;
    if ((data.roles && data.roles.length > 0) || data.role) {
      normalizedRoles = normalizeRoles(data.roles, data.role);
      (updateData as any).roles = { set: normalizedRoles };
    }
    if (data.phone !== undefined) updateData.phone = data.phone || null;
    if (data.password) updateData.password_hash = await argon2.hash(data.password);
    if (data.specialties !== undefined) (updateData as any).specialties = { set: data.specialties };
    if (data.cro_number !== undefined) updateData.cro_number = data.cro_number || null;
    if (data.cro_uf !== undefined) updateData.cro_uf = data.cro_uf || null;

    // Onda 17.32.116 — Setor e overrides de permissoes
    if (data.sector !== undefined) {
      // Onda 17.32.122 — Inclui acd_asb (auxiliar de consultorio)
      const allowed = ['recepcao','dentista','acd_asb','crc','financeiro','admin'];
      if (data.sector && !allowed.includes(data.sector)) {
        throw new BadRequestException(`Setor invalido: ${data.sector}`);
      }
      (updateData as any).sector = data.sector || null;
    }
    if (data.extra_grants !== undefined)  (updateData as any).extra_grants  = { set: data.extra_grants };
    if (data.extra_revokes !== undefined) (updateData as any).extra_revokes = { set: data.extra_revokes };

    if (data.inboxIds) {
      updateData.inboxes = {
        set: data.inboxIds.map(id => ({ id }))
      };
    }

    let user;
    try {
      user = await this.prisma.user.update({
        where: { id },
        data: updateData,
        include: { inboxes: { select: { id: true, name: true } } }
      });
    } catch (e: any) {
      // Onda 17.32.173 — mesmo tratamento do create: trocar e-mail pra
      // um ja usado retornava 500 generico
      if (e?.code === 'P2002') {
        throw new BadRequestException('Já existe um usuário com este e-mail. Use outro endereço.');
      }
      this.logger.error(`[USERS] Falha inesperada ao atualizar usuario ${id}: code=${e?.code} ${e?.message}`);
      throw e;
    }
    const { password_hash, ...result } = user;
    return result as any;
  }

  /** Retorna contadores do que o usuário possui (para o modal de transferência) */
  async getTransferSummary(id: string, tenantId?: string) {
    await this.verifyTenantOwnership(id, tenantId);
    const [conversations, tasks, events, leads] = await Promise.all([
      this.prisma.conversation.count({ where: { OR: [{ assigned_user_id: id }, { assigned_dentist_id: id }] } }),
      this.prisma.calendarEvent.count({ where: { OR: [{ assigned_user_id: id }, { created_by_id: id }] } }),
      this.prisma.calendarEvent.count({ where: { created_by_id: id } }),
      this.prisma.lead.count({ where: { cs_user_id: id } }),
    ]);
    return { cases: 0, conversations, tasks, events, leads };
  }

  async remove(id: string, tenantId?: string, transferToId?: string): Promise<void> {
    await this.verifyTenantOwnership(id, tenantId);

    // Se informou transferToId, transferir tudo antes de excluir
    if (transferToId) {
      const dest = await this.prisma.user.findUnique({ where: { id: transferToId }, select: { id: true } });
      if (!dest) throw new BadRequestException('Usuário destino da transferência não encontrado.');

      // Transferir tudo em uma transação
      await this.prisma.$transaction([
        // Conversas atribuídas como operador
        this.prisma.conversation.updateMany({
          where: { assigned_user_id: id },
          data: { assigned_user_id: transferToId },
        }),
        // Conversas atribuídas como dentista
        this.prisma.conversation.updateMany({
          where: { assigned_dentist_id: id },
          data: { assigned_dentist_id: transferToId },
        }),
        // Tarefas atribuídas
        this.prisma.calendarEvent.updateMany({
          where: { assigned_user_id: id },
          data: { assigned_user_id: transferToId },
        }),
        // Eventos criados (FK required)
        this.prisma.calendarEvent.updateMany({
          where: { created_by_id: id },
          data: { created_by_id: transferToId },
        }),
        // Leads como CS manager
        this.prisma.lead.updateMany({
          where: { cs_user_id: id },
          data: { cs_user_id: transferToId },
        }),
      ]);

      this.logger.log(`[USERS] Transferido tudo de ${id} para ${transferToId} antes da exclusão`);
    } else {
      // Sem transferência: verificar se tem registros bloqueantes
      const createdEventCount = await this.prisma.calendarEvent.count({ where: { created_by_id: id } });

      if (createdEventCount > 0) {
        throw new ForbiddenException(
          `Não é possível excluir: usuário criou ${createdEventCount} evento(s). Informe para quem transferir.`,
        );
      }

      // Desassociar conversas
      await this.prisma.conversation.updateMany({
        where: { assigned_user_id: id },
        data: { assigned_user_id: null },
      });
    }

    await this.prisma.user.delete({ where: { id } });
  }

  // ─── Dentist / Intern helpers ──────────────────────────────────

  /** Lista dentistas (role DENTIST ou ADMIN com specialties) */
  async findLawyers(tenantId?: string) {
    const tenantFilter = this.tenantWhere(tenantId);
    return this.prisma.user.findMany({
      where: {
        AND: [
          {
            OR: [
              { roles: { has: 'DENTIST' } },
              { roles: { has: 'ADMIN' }, specialties: { isEmpty: false } },
            ],
          },
          // Isolamento multi-tenant combinado via AND para não sobrescrever o OR acima
          ...(Object.keys(tenantFilter).length > 0 ? [tenantFilter] : []),
        ],
      },
      select: { id: true, name: true, roles: true, specialties: true },
      orderBy: { name: 'asc' },
    });
  }

  /** Lista estagiários vinculados a um dentista */
  async findInterns(supervisorId: string) {
    return this.prisma.user.findMany({
      where: { supervisors: { some: { id: supervisorId } } },
      select: { id: true, name: true, email: true, roles: true },
      orderBy: { name: 'asc' },
    });
  }

  /** Define os supervisores (dentistas) de um estagiário */
  async linkSupervisors(internId: string, dentistIds: string[]) {
    return this.prisma.user.update({
      where: { id: internId },
      data: {
        supervisors: { set: dentistIds.map(id => ({ id })) },
      },
      include: {
        supervisors: { select: { id: true, name: true } },
      },
    });
  }

  // ─── Avatar / Foto de Perfil ──────────────────────────────────

  /**
   * Salva o buffer da imagem no filesystem e atualiza profile_picture_url do usuário.
   * Somente ADMIN pode chamar este método.
   */
  async updateAvatar(userId: string, buffer: Buffer, mimeType: string, tenantId?: string): Promise<{ relativePath: string }> {
    await this.verifyTenantOwnership(userId, tenantId);

    const ALLOWED_MIMES: Record<string, string> = {
      'image/jpeg': 'jpg',
      'image/jpg': 'jpg',
      'image/png': 'png',
      'image/gif': 'gif',
      'image/webp': 'webp',
    };
    const ext = ALLOWED_MIMES[mimeType?.toLowerCase()];
    if (!ext) throw new BadRequestException('Tipo de imagem não suportado. Use JPEG, PNG, GIF ou WebP.');
    if (buffer.length > 2 * 1024 * 1024) throw new BadRequestException('Imagem muito grande. Máximo 2 MB.');

    // Apaga arquivos antigos de outras extensões (limpeza)
    for (const oldExt of Object.values(ALLOWED_MIMES)) {
      if (oldExt !== ext) {
        await this.fileStorage.delete(`profiles/${userId}.${oldExt}`);
      }
    }

    const relativePath = `profiles/${userId}.${ext}`;
    await this.fileStorage.write(relativePath, buffer);

    await (this.prisma as any).user.update({
      where: { id: userId },
      data: { profile_picture_url: relativePath },
    });

    this.logger.log(`[AVATAR] Foto de perfil atualizada para usuário ${userId}: ${relativePath}`);
    return { relativePath };
  }

  /**
   * Retorna o buffer da foto de perfil + mimeType para servir via HTTP.
   */
  async getAvatarBuffer(userId: string): Promise<{ buffer: Buffer; mimeType: string } | null> {
    const user = await (this.prisma as any).user.findUnique({
      where: { id: userId },
      select: { profile_picture_url: true },
    });
    if (!user?.profile_picture_url) return null;

    const relativePath = user.profile_picture_url as string;
    const ext = relativePath.split('.').pop()?.toLowerCase() || 'jpg';
    const mimeMap: Record<string, string> = { png: 'image/png', gif: 'image/gif', webp: 'image/webp', jpg: 'image/jpeg', jpeg: 'image/jpeg' };
    const mimeType = mimeMap[ext] ?? 'image/jpeg';

    const buffer = await this.fileStorage.read(relativePath);
    if (!buffer) return null;
    return { buffer, mimeType };
  }

  /**
   * Remove a foto de perfil do usuário.
   * Somente ADMIN pode chamar este método.
   */
  async removeAvatar(userId: string, tenantId?: string): Promise<void> {
    await this.verifyTenantOwnership(userId, tenantId);
    const user = await (this.prisma as any).user.findUnique({
      where: { id: userId },
      select: { profile_picture_url: true },
    });
    if (user?.profile_picture_url) {
      await this.fileStorage.delete(user.profile_picture_url);
    }
    await (this.prisma as any).user.update({
      where: { id: userId },
      data: { profile_picture_url: null },
    });
  }
}

/**
 * InfluencersService — cadastro de influenciadores (parcerias de marketing).
 *
 * Multi-tenant — todas as queries filtram por tenant_id. Coupon_code é único
 * por tenant quando preenchido (evita rastreamento duplicado de campanhas).
 *
 * Hook de Patient (Onda 5e marketing v2): ao criar um influenciador, o sistema
 * automaticamente cria/vincula um Patient. Se o telefone informado já bate com
 * um Patient existente no mesmo tenant, vincula ao existente (evita
 * duplicação). Caso contrário, cria Patient novo via PatientsService.create()
 * — o que também dispara a auto-criação de Lead/Conversation no WhatsApp.
 * Vínculo é best-effort: se falhar, o influenciador é criado sem patient_id
 * (admin pode reparar via update).
 */
import { Injectable, NotFoundException, BadRequestException, Logger, Inject, forwardRef } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { PatientsService } from '../patients/patients.service';

export type Platform = 'INSTAGRAM' | 'TIKTOK' | 'YOUTUBE' | 'OUTRO';
export type CommissionType = 'PERCENTUAL' | 'FIXO' | 'PERMUTA';
export type InfluencerStatus = 'ATIVO' | 'PAUSADO' | 'INATIVO';

export interface CreateInfluencerDto {
  name: string;
  handle?: string | null;
  phone?: string | null;
  email?: string | null;
  platform?: Platform | null;
  followers?: number | null;
  niche?: string | null;
  commission_type?: CommissionType | null;
  commission_value?: number | null;
  coupon_code?: string | null;
  status?: InfluencerStatus;
  notes?: string | null;
}

export interface UpdateInfluencerDto extends Partial<CreateInfluencerDto> {}

const VALID_PLATFORMS: Platform[] = ['INSTAGRAM', 'TIKTOK', 'YOUTUBE', 'OUTRO'];
const VALID_COMMISSION: CommissionType[] = ['PERCENTUAL', 'FIXO', 'PERMUTA'];
const VALID_STATUS: InfluencerStatus[] = ['ATIVO', 'PAUSADO', 'INATIVO'];

@Injectable()
export class InfluencersService {
  private readonly logger = new Logger(InfluencersService.name);

  constructor(
    private prisma: PrismaService,
    @Inject(forwardRef(() => PatientsService))
    private patientsService: PatientsService,
  ) {}

  // Normaliza @handle (remove @ inicial e espaços) — UX permite digitar com ou sem
  private normalizeHandle(h?: string | null): string | null {
    if (!h) return null;
    const trimmed = h.trim().replace(/^@+/, '');
    return trimmed.length === 0 ? null : trimmed;
  }

  private normalizeCoupon(c?: string | null): string | null {
    if (!c) return null;
    const trimmed = c.trim().toUpperCase();
    return trimmed.length === 0 ? null : trimmed;
  }

  /** Normaliza telefone pra comparação (só dígitos). */
  private normalizePhoneDigits(p?: string | null): string | null {
    if (!p) return null;
    const d = p.replace(/\D/g, '');
    return d.length === 0 ? null : d;
  }

  private validate(data: CreateInfluencerDto | UpdateInfluencerDto) {
    if ('platform' in data && data.platform && !VALID_PLATFORMS.includes(data.platform)) {
      throw new BadRequestException(`platform inválido. Use: ${VALID_PLATFORMS.join(', ')}`);
    }
    if ('commission_type' in data && data.commission_type && !VALID_COMMISSION.includes(data.commission_type)) {
      throw new BadRequestException(`commission_type inválido. Use: ${VALID_COMMISSION.join(', ')}`);
    }
    if ('status' in data && data.status && !VALID_STATUS.includes(data.status)) {
      throw new BadRequestException(`status inválido. Use: ${VALID_STATUS.join(', ')}`);
    }
    if ('followers' in data && data.followers != null && data.followers < 0) {
      throw new BadRequestException('followers não pode ser negativo');
    }
    if ('commission_value' in data && data.commission_value != null && data.commission_value < 0) {
      throw new BadRequestException('commission_value não pode ser negativo');
    }
  }

  async list(tenantId: string, opts?: { status?: string; q?: string }) {
    const where: any = { tenant_id: tenantId };
    if (opts?.status && VALID_STATUS.includes(opts.status as InfluencerStatus)) {
      where.status = opts.status;
    }
    if (opts?.q && opts.q.trim()) {
      const q = opts.q.trim();
      where.OR = [
        { name: { contains: q, mode: 'insensitive' } },
        { handle: { contains: q, mode: 'insensitive' } },
        { coupon_code: { contains: q, mode: 'insensitive' } },
      ];
    }
    return (this.prisma as any).influencer.findMany({
      where,
      orderBy: [{ status: 'asc' }, { name: 'asc' }],
      include: { patient: { select: { id: true, name: true } } },
    });
  }

  async findOne(id: string, tenantId: string) {
    const item = await (this.prisma as any).influencer.findFirst({
      where: { id, tenant_id: tenantId },
      include: { patient: { select: { id: true, name: true } } },
    });
    if (!item) throw new NotFoundException('Influenciador não encontrado');
    return item;
  }

  /**
   * Encontra ou cria um Patient pra o influenciador.
   * Estratégia:
   *  1. Se phone informado bate com Patient existente no tenant (comparando só
   *     dígitos), vincula ao existente — sem alterar dados do Patient.
   *  2. Caso contrário, cria Patient novo via PatientsService (que também
   *     auto-cria Lead/Conversation pra que o influencer apareça no WhatsApp).
   *  3. Erros são logados mas não lançados — vincular é best-effort.
   */
  private async ensurePatientForInfluencer(
    tenantId: string,
    influencerName: string,
    phone: string | null,
    email: string | null,
  ): Promise<string | null> {
    try {
      // 1) Procura match por telefone (se preenchido)
      const phoneDigits = this.normalizePhoneDigits(phone);
      if (phoneDigits) {
        const candidates = await this.prisma.patient.findMany({
          where: { tenant_id: tenantId, phone: { not: null } },
          select: { id: true, phone: true },
        });
        const match = candidates.find(p => this.normalizePhoneDigits(p.phone) === phoneDigits);
        if (match) {
          this.logger.log(`[INF-PATIENT] Vinculou influencer "${influencerName}" ao paciente existente ${match.id} (match por telefone)`);
          return match.id;
        }
      }

      // 2) Cria Patient novo
      const created = await this.patientsService.create(tenantId, {
        name: influencerName,
        phone: phone || undefined,
        email: email || undefined,
        // status default ACTIVE já vem do schema
      });
      this.logger.log(`[INF-PATIENT] Criou paciente novo ${created.id} pra influencer "${influencerName}"`);
      return created.id;
    } catch (e: any) {
      this.logger.warn(`[INF-PATIENT] Falhou vincular/criar paciente pra "${influencerName}": ${e?.message}`);
      return null;
    }
  }

  async create(tenantId: string, data: CreateInfluencerDto) {
    if (!data.name || !data.name.trim()) {
      throw new BadRequestException('Nome é obrigatório');
    }
    this.validate(data);

    const coupon = this.normalizeCoupon(data.coupon_code);
    if (coupon) {
      const dup = await (this.prisma as any).influencer.findFirst({
        where: { tenant_id: tenantId, coupon_code: coupon },
      });
      if (dup) throw new BadRequestException(`Cupom "${coupon}" já está em uso`);
    }

    const name = data.name.trim();
    const phone = data.phone?.trim() || null;
    const email = data.email?.trim() || null;
    const handle = this.normalizeHandle(data.handle);
    const phoneDigits = this.normalizePhoneDigits(phone);

    // Onda 5e v35 — cria Influencer + Patient (afiliado da clinica) em UMA
    // transacao atomica. Influenciador parceiro automaticamente vira paciente:
    //   - pode ser atendido (ficha clinica + agendamento)
    //   - vira afiliado da clinica (is_affiliate=true)
    //   - codigo de cupom do influencer = affiliate_code do paciente (mesmo
    //     codigo serve pra desconto do indicado E rastreio da comissao)
    //
    // Match de paciente existente normaliza telefone (so digitos) — evita
    // duplicar quando ja existe paciente com mesmo numero em formato diferente.
    return this.prisma.$transaction(async (tx) => {
      let patient: any = null;
      if (phoneDigits) {
        const candidates = await (tx as any).patient.findMany({
          where: { tenant_id: tenantId, phone: { not: null } },
          select: { id: true, name: true, phone: true, is_affiliate: true },
        });
        patient = candidates.find((p: any) =>
          this.normalizePhoneDigits(p.phone) === phoneDigits,
        ) || null;
      }

      if (patient) {
        // Patient ja existe (mesmo telefone) — ativa afiliado e vincula.
        // Nao sobrescreve nome/email se ja preenchido — preserva ficha.
        await (tx as any).patient.update({
          where: { id: patient.id },
          data: {
            is_affiliate: true,
            affiliate_code: coupon ?? undefined,
          },
        });
      } else {
        // Cria Patient novo com dados minimos do influenciador
        patient = await (tx as any).patient.create({
          data: {
            tenant_id: tenantId,
            name,
            phone,
            email,
            is_affiliate: true,
            affiliate_code: coupon,
            affiliate_commission_pct: 3, // default do programa
            notes: handle
              ? `Influenciador parceiro (@${handle})`
              : 'Influenciador parceiro',
            status: 'ACTIVE',
          },
          select: { id: true, name: true },
        });
      }

      // Se ja ha outro influencer vinculado a esse Patient (unique constraint),
      // criamos influencer SEM patient_id pra nao quebrar — admin pode mesclar
      // depois. Caso raro mas possivel se houver migracao manual.
      const existingLink = await (tx as any).influencer.findUnique({
        where: { patient_id: patient.id },
      });

      const influencer = await (tx as any).influencer.create({
        data: {
          tenant_id: tenantId,
          name,
          handle,
          phone,
          email,
          platform: data.platform || null,
          followers: data.followers ?? null,
          niche: data.niche?.trim() || null,
          commission_type: data.commission_type || null,
          commission_value: data.commission_value ?? null,
          coupon_code: coupon,
          status: data.status || 'ATIVO',
          notes: data.notes?.trim() || null,
          patient_id: existingLink ? null : patient.id,
        },
        include: { patient: { select: { id: true, name: true } } },
      });

      this.logger.log(
        `[INFLUENCER+PATIENT] Influencer ${influencer.id} criado${existingLink ? ' (SEM vinculo — paciente ja linkado)' : ''}, Patient ${patient.id} (${patient.name})`,
      );

      return influencer;
    });
  }

  async update(id: string, tenantId: string, data: UpdateInfluencerDto) {
    const existing = await this.findOne(id, tenantId);
    this.validate(data);

    const patch: any = {};
    if (data.name !== undefined) {
      if (!data.name || !data.name.trim()) throw new BadRequestException('Nome não pode ser vazio');
      patch.name = data.name.trim();
    }
    if (data.handle !== undefined) patch.handle = this.normalizeHandle(data.handle);
    if (data.phone !== undefined) patch.phone = data.phone?.trim() || null;
    if (data.email !== undefined) patch.email = data.email?.trim() || null;
    if (data.platform !== undefined) patch.platform = data.platform || null;
    if (data.followers !== undefined) patch.followers = data.followers ?? null;
    if (data.niche !== undefined) patch.niche = data.niche?.trim() || null;
    if (data.commission_type !== undefined) patch.commission_type = data.commission_type || null;
    if (data.commission_value !== undefined) patch.commission_value = data.commission_value ?? null;
    if (data.coupon_code !== undefined) {
      const coupon = this.normalizeCoupon(data.coupon_code);
      if (coupon) {
        const dup = await (this.prisma as any).influencer.findFirst({
          where: { tenant_id: tenantId, coupon_code: coupon, NOT: { id } },
        });
        if (dup) throw new BadRequestException(`Cupom "${coupon}" já está em uso`);
      }
      patch.coupon_code = coupon;
    }
    if (data.status !== undefined) patch.status = data.status || 'ATIVO';
    if (data.notes !== undefined) patch.notes = data.notes?.trim() || null;

    // Vinculação tardia: se o influencer não tinha patient_id e agora temos
    // dados pra criar/encontrar, tentamos vincular. Não bloqueia se falhar.
    if (!existing.patient_id) {
      const name = (patch.name ?? existing.name) as string;
      const phone = patch.phone !== undefined ? patch.phone : existing.phone;
      const email = patch.email !== undefined ? patch.email : existing.email;
      const patientId = await this.ensurePatientForInfluencer(tenantId, name, phone, email);
      if (patientId) {
        const linked = await (this.prisma as any).influencer.findUnique({
          where: { patient_id: patientId },
        });
        if (!linked || linked.id === id) {
          patch.patient_id = patientId;
        }
      }
    }

    return (this.prisma as any).influencer.update({
      where: { id },
      data: patch,
      include: { patient: { select: { id: true, name: true } } },
    });
  }

  async remove(id: string, tenantId: string) {
    await this.findOne(id, tenantId);
    // NÃO remove o Patient vinculado — entidade primária, fica intocada.
    // Ao apagar Influencer, o Patient simplesmente perde o vínculo reverso.
    await (this.prisma as any).influencer.delete({ where: { id } });
    return { ok: true };
  }
}

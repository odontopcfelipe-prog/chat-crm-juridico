import { Injectable, Logger, NotFoundException, ForbiddenException, BadRequestException, Inject, forwardRef } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { FileStorageService } from '../media/filesystem.service';
import { ReferralsService } from '../referrals/referrals.service';
import { Prisma } from '@crm/shared';

@Injectable()
export class PatientsService {
  private readonly logger = new Logger(PatientsService.name);

  constructor(
    private prisma: PrismaService,
    private fileStorage: FileStorageService,
    @Inject(forwardRef(() => ReferralsService)) private referralsService: ReferralsService,
  ) {}

  /** Cria novo paciente. Valida CPF unico por tenant quando preenchido. */
  async create(tenantId: string, data: Omit<Prisma.PatientUncheckedCreateInput, 'tenant_id'>) {
    if (!tenantId) throw new BadRequestException('tenant_id ausente no contexto');

    if (data.cpf) {
      const existing = await this.prisma.patient.findUnique({
        where: { tenant_id_cpf: { tenant_id: tenantId, cpf: data.cpf } },
      });
      if (existing) throw new BadRequestException('Ja existe um paciente com este CPF neste tenant');
    }

    const patient = await this.prisma.patient.create({
      data: { ...data, tenant_id: tenantId },
    });

    // Hook Indicação Premiada (Fase 21): se foi indicado por outro paciente,
    // cria Referral{status:PENDING}. Best-effort — se falhar não bloqueia
    // o cadastro do paciente.
    if (data.referred_by_id) {
      try {
        await this.referralsService.createPending({
          tenantId,
          referrerId: data.referred_by_id as string,
          referredId: patient.id,
        });
      } catch (e: any) {
        this.logger.warn(`[REFERRAL HOOK] Falhou criar PENDING pra paciente ${patient.id}: ${e?.message}`);
      }
    }

    return patient;
  }

  /** Lista pacientes com busca, filtros e paginacao. */
  async findAll(
    tenantId: string,
    opts: {
      search?: string;
      status?: string;
      dentistId?: string;
      tagId?: string;
      // Filtros avancados (Fase 22)
      noVisitMonths?: number;       // pacientes sem revisao ha X meses
      withActivePlan?: boolean;     // tem TreatmentPlan ACTIVE
      withoutAnamnesis?: boolean;   // nao tem nenhuma anamnese
      birthdayMonth?: boolean;      // aniversariantes do mes corrente
      page?: number;
      limit?: number;
    } = {},
  ) {
    const page = Math.max(1, opts.page || 1);
    // v32: cap aumentado pra 500 — alinhado com ContactPicker que precisa de
    // lista completa pra autocomplete. 500 ainda eh seguro (query count <50ms).
    const limit = Math.min(500, Math.max(1, opts.limit || 20));
    const skip = (page - 1) * limit;

    // Sem revisão há X meses: last_visit_at < (agora - X meses) OU last_visit_at é null
    let lastVisitFilter: Prisma.PatientWhereInput | undefined;
    if (opts.noVisitMonths && opts.noVisitMonths > 0) {
      const cutoff = new Date();
      cutoff.setMonth(cutoff.getMonth() - opts.noVisitMonths);
      lastVisitFilter = {
        OR: [
          { last_visit_at: { lt: cutoff } },
          { last_visit_at: null },
        ],
      };
    }

    // Aniversariantes do mês corrente — Prisma não compara month/day diretamente,
    // mas dá pra filtrar por raw lateral. Aqui fazemos via query SQL no findAll
    // pra evitar — se precisar, usar o endpoint /patients/birthdays.
    // Pra simplificar a lista, omitimos essa otimizacao e filtramos in-memory
    // depois (limitando ao page size).

    // v33: ROLLBACK do OR com tenant_id null — Prisma 6.x nao aceita
    // { equals: null } pro campo tenant_id (typing diz nullable mas
    // gera SQL invalido em runtime → 500). Volto pro filtro simples.
    // Casos de pacientes legacy sem tenant_id sao raros — admin pode
    // corrigir via SQL UPDATE manual se aparecer.
    //
    // MAS mantenho a estrutura AND[] pra resolver o conflito de 2 ORs no
    // root (search vs tenant) que era o REAL bug v31.
    const andFilters: Prisma.PatientWhereInput[] = [
      { tenant_id: tenantId },
    ];
    if (opts.status) andFilters.push({ status: opts.status });
    if (opts.dentistId) andFilters.push({ primary_dentist_id: opts.dentistId });
    if (opts.tagId) andFilters.push({ tags: { some: { tag_id: opts.tagId } } });
    if (opts.withActivePlan) andFilters.push({ treatment_plans: { some: { status: 'ACTIVE' } } });
    if (opts.withoutAnamnesis) andFilters.push({ anamneses: { none: {} } });
    if (lastVisitFilter) andFilters.push(lastVisitFilter);
    if (opts.search) {
      andFilters.push({
        OR: [
          { name: { contains: opts.search, mode: 'insensitive' } },
          { phone: { contains: opts.search } },
          { cpf: { contains: opts.search } },
          { email: { contains: opts.search, mode: 'insensitive' } },
        ],
      });
    }
    const where: Prisma.PatientWhereInput = { AND: andFilters };

    const [data, total] = await Promise.all([
      this.prisma.patient.findMany({
        where,
        orderBy: { created_at: 'desc' },
        skip,
        take: limit,
        include: {
          primary_dentist: { select: { id: true, name: true, email: true } },
          tags: { include: { tag: true } },
          _count: { select: { anamneses: true, treatment_plans: true, appointments: true } },
        },
      }),
      this.prisma.patient.count({ where }),
    ]);

    return { data, total, page, totalPages: Math.ceil(total / limit) };
  }

  /** Detalhe completo do paciente — inclui alergias, medicacoes, prontuario, odontograma. */
  async findOne(id: string, tenantId: string) {
    const patient = await this.prisma.patient.findUnique({
      where: { id },
      include: {
        primary_dentist: { select: { id: true, name: true, email: true } },
        lead: { select: { id: true, phone: true, stage: true } },
        // Indicador (paciente que indicou esse) — mostra nome no overview
        referred_by_patient: { select: { id: true, name: true, phone: true } },
        // Tags / segmentacao (Fase 20)
        tags: { include: { tag: true } },
        allergies: { orderBy: { created_at: 'desc' } },
        medications: { orderBy: { created_at: 'desc' } },
        medical_record: true,
        odontogram: { include: { teeth: true } },
        anamneses: {
          orderBy: { filled_at: 'desc' },
          take: 5,
          select: { id: true, filled_at: true, filled_by_user_id: true },
        },
        treatment_plans: {
          orderBy: { created_at: 'desc' },
          take: 5,
          select: { id: true, status: true, start_date: true, total_value: true, created_at: true },
        },
        _count: {
          select: {
            appointments: true,
            clinical_images: true,
            consents: true,
            quotes: true,
            referrals: true, // quantos pacientes esse aqui indicou
          },
        },
      },
    });

    if (!patient) throw new NotFoundException('Paciente nao encontrado');
    if (patient.tenant_id !== tenantId) throw new ForbiddenException('Acesso negado');

    return patient;
  }

  async update(id: string, tenantId: string, data: Prisma.PatientUncheckedUpdateInput) {
    await this.assertBelongsToTenant(id, tenantId);

    if (data.cpf && typeof data.cpf === 'string') {
      const conflict = await this.prisma.patient.findFirst({
        where: { tenant_id: tenantId, cpf: data.cpf, NOT: { id } },
        select: { id: true },
      });
      if (conflict) throw new BadRequestException('Outro paciente ja usa este CPF');
    }

    return this.prisma.patient.update({ where: { id }, data });
  }

  /** Soft delete — marca como ARCHIVED. Use para preservar historico clinico. */
  async archive(id: string, tenantId: string) {
    await this.assertBelongsToTenant(id, tenantId);
    return this.prisma.patient.update({ where: { id }, data: { status: 'ARCHIVED' } });
  }

  /** Converte um Lead em Patient. Se o paciente ja existe (lead_id ja vinculado), retorna o existente. */
  async convertFromLead(leadId: string, tenantId: string, extraData: Partial<Prisma.PatientUncheckedCreateInput> = {}) {
    const lead = await this.prisma.lead.findUnique({ where: { id: leadId } });
    if (!lead) throw new NotFoundException('Lead nao encontrado');
    if (lead.tenant_id !== tenantId) throw new ForbiddenException('Acesso negado a este lead');

    const existing = await this.prisma.patient.findUnique({ where: { lead_id: leadId } });
    if (existing) return existing;

    const patient = await this.prisma.patient.create({
      data: {
        tenant_id: tenantId,
        lead_id: leadId,
        name: lead.name || 'Paciente sem nome',
        phone: lead.phone,
        email: lead.email || null,
        referred_by: lead.origin || null,
        ...extraData,
      },
    });

    // Backfill: vincula CalendarEvents existentes (criados antes da conversão
    // com lead_id apenas) ao novo patient_id. Garante Timeline + Resumo Clínico
    // a mostrar consultas agendadas antes do lead virar paciente.
    try {
      const linked = await this.prisma.calendarEvent.updateMany({
        where: { lead_id: leadId, patient_id: null },
        data: { patient_id: patient.id },
      });
      if (linked.count > 0) {
        this.logger.log(`[CONVERT] ${linked.count} CalendarEvent(s) vinculado(s) ao paciente ${patient.id}`);
      }

      // Recalcula visit dates baseado nas consultas concluidas que acabamos de vincular
      await this.recalculateVisitDates(patient.id).catch(() => {});
    } catch (e: any) {
      this.logger.warn(`[CONVERT] Backfill falhou: ${e?.message}`);
    }

    // Hook Indicação Premiada: se conversão veio com referred_by_id no extraData
    if (extraData.referred_by_id) {
      try {
        await this.referralsService.createPending({
          tenantId,
          referrerId: extraData.referred_by_id as string,
          referredId: patient.id,
        });
      } catch (e: any) {
        this.logger.warn(`[REFERRAL HOOK] Falhou criar PENDING (convert): ${e?.message}`);
      }
    }

    return patient;
  }

  /**
   * Recalcula first_visit_at e last_visit_at do paciente baseado em
   * todas as consultas (CONSULTA/PROCEDIMENTO/RETORNO) já vinculadas
   * ao patient_id, com status CONFIRMADO ou CONCLUIDO. Usado em
   * conversão Lead→Patient e backfill em massa.
   */
  async recalculateVisitDates(patientId: string): Promise<void> {
    const events = await this.prisma.calendarEvent.findMany({
      where: {
        patient_id: patientId,
        type: { in: ['CONSULTA', 'PROCEDIMENTO', 'RETORNO'] },
        status: { in: ['CONFIRMADO', 'CONCLUIDO'] },
      },
      select: { start_at: true },
      orderBy: { start_at: 'asc' },
    });
    if (events.length === 0) return;
    const first = events[0].start_at;
    const last = events[events.length - 1].start_at;
    await this.prisma.patient.update({
      where: { id: patientId },
      data: { first_visit_at: first, last_visit_at: last },
    });
  }

  /**
   * Backfill admin: 1) vincula CalendarEvents existentes (lead_id mas
   * patient_id null) ao paciente certo via Lead→Patient. 2) Recalcula
   * first/last_visit_at de todos os pacientes do tenant baseado nesses
   * eventos. Idempotente — pode rodar várias vezes sem efeito colateral.
   *
   * Usado uma vez na VPS pra normalizar dados antigos. Nas operações
   * normais, os hooks em CalendarService cuidam disso automaticamente.
   */
  async backfillVisitDates(tenantId: string): Promise<{ patientsLinked: number; eventsLinked: number; patientsRecalculated: number }> {
    // 1) Vincula CalendarEvents que tem lead_id mas nao patient_id
    const orphanEvents = await this.prisma.calendarEvent.findMany({
      where: { tenant_id: tenantId, patient_id: null, lead_id: { not: null } },
      select: { id: true, lead_id: true },
    });

    let eventsLinked = 0;
    const patientsTouched = new Set<string>();
    for (const e of orphanEvents) {
      if (!e.lead_id) continue;
      const patient = await this.prisma.patient.findUnique({
        where: { lead_id: e.lead_id },
        select: { id: true },
      });
      if (!patient) continue;
      await this.prisma.calendarEvent.update({
        where: { id: e.id },
        data: { patient_id: patient.id },
      });
      eventsLinked++;
      patientsTouched.add(patient.id);
    }

    // 2) Pega TODOS os pacientes que tem eventos (não só os que tocamos),
    // pra cobrir o caso de quem ja tinha patient_id mas nunca teve as datas
    // populadas.
    const allPatients = await this.prisma.patient.findMany({
      where: { tenant_id: tenantId },
      select: { id: true },
    });

    let patientsRecalculated = 0;
    for (const p of allPatients) {
      try {
        await this.recalculateVisitDates(p.id);
        patientsRecalculated++;
      } catch {}
    }

    this.logger.log(
      `[BACKFILL] tenant=${tenantId} eventsLinked=${eventsLinked} patientsLinked=${patientsTouched.size} patientsRecalculated=${patientsRecalculated}`,
    );

    return {
      patientsLinked: patientsTouched.size,
      eventsLinked,
      patientsRecalculated,
    };
  }

  /**
   * Lista aniversariantes do período (today | week | month).
   * Usa Postgres date_part pra extrair mês/dia ignorando o ano de nascimento
   * — assim funciona pra qualquer paciente independente da idade.
   *
   * "today": pacientes que fazem aniversário no dia de hoje (UTC).
   * "week":  proximos 7 dias incluindo hoje (cobre o passar do final de mes).
   * "month": qualquer dia do mes corrente.
   */
  async getBirthdays(tenantId: string, period: 'today' | 'week' | 'month' = 'today') {
    // Usamos uma query SQL crua pra trabalhar com extract(month/day) — Prisma
    // nao tem suporte nativo a comparacao de "mes/dia" de DateTime.
    let whereSql: string;
    if (period === 'today') {
      whereSql = `
        EXTRACT(MONTH FROM birth_date) = EXTRACT(MONTH FROM CURRENT_DATE)
        AND EXTRACT(DAY FROM birth_date) = EXTRACT(DAY FROM CURRENT_DATE)
      `;
    } else if (period === 'week') {
      // Próximos 7 dias considerando virada de mês: gera o conjunto (mês, dia)
      // dos próximos 7 dias e usa em (...) IN
      whereSql = `
        (EXTRACT(MONTH FROM birth_date), EXTRACT(DAY FROM birth_date))
        IN (
          SELECT EXTRACT(MONTH FROM d), EXTRACT(DAY FROM d)
          FROM generate_series(CURRENT_DATE, CURRENT_DATE + INTERVAL '6 days', INTERVAL '1 day') AS d
        )
      `;
    } else {
      whereSql = `EXTRACT(MONTH FROM birth_date) = EXTRACT(MONTH FROM CURRENT_DATE)`;
    }

    const rows = await this.prisma.$queryRawUnsafe<Array<{
      id: string; name: string; phone: string | null; birth_date: Date;
      avatar_url: string | null; primary_dentist_id: string | null;
    }>>(`
      SELECT id, name, phone, birth_date, avatar_url, primary_dentist_id
      FROM patients
      WHERE tenant_id = $1
        AND status = 'ACTIVE'
        AND birth_date IS NOT NULL
        AND ${whereSql}
      ORDER BY EXTRACT(MONTH FROM birth_date), EXTRACT(DAY FROM birth_date), name
      LIMIT 200
    `, tenantId);

    return rows.map((r) => {
      // Calcula idade que vai fazer
      const today = new Date();
      const b = new Date(r.birth_date);
      let ageTurning = today.getUTCFullYear() - b.getUTCFullYear();
      // Se ainda nao passou o aniversario esse ano, soma 1 (vai fazer)
      const monthDayBefore =
        today.getUTCMonth() < b.getUTCMonth() ||
        (today.getUTCMonth() === b.getUTCMonth() && today.getUTCDate() < b.getUTCDate());
      if (monthDayBefore) ageTurning += 1;
      return { ...r, age_turning: ageTurning };
    });
  }

  /** Estatisticas rapidas (para dashboard). */
  async getStats(tenantId: string) {
    const [total, active, inactive, archived, withActivePlan] = await Promise.all([
      this.prisma.patient.count({ where: { tenant_id: tenantId } }),
      this.prisma.patient.count({ where: { tenant_id: tenantId, status: 'ACTIVE' } }),
      this.prisma.patient.count({ where: { tenant_id: tenantId, status: 'INACTIVE' } }),
      this.prisma.patient.count({ where: { tenant_id: tenantId, status: 'ARCHIVED' } }),
      this.prisma.patient.count({
        where: {
          tenant_id: tenantId,
          treatment_plans: { some: { status: 'ACTIVE' } },
        },
      }),
    ]);

    return { total, active, inactive, archived, with_active_plan: withActivePlan };
  }

  // ─── Allergies ────────────────────────────────────────────────

  async addAllergy(
    patientId: string,
    tenantId: string,
    data: { allergen: string; severity?: string; notes?: string },
  ) {
    await this.assertBelongsToTenant(patientId, tenantId);
    return this.prisma.patientAllergy.create({ data: { patient_id: patientId, ...data } });
  }

  async removeAllergy(id: string, tenantId: string) {
    const allergy = await this.prisma.patientAllergy.findUnique({
      where: { id },
      select: { id: true, patient: { select: { tenant_id: true } } },
    });
    if (!allergy) throw new NotFoundException('Alergia nao encontrada');
    if (allergy.patient.tenant_id !== tenantId) throw new ForbiddenException('Acesso negado');
    return this.prisma.patientAllergy.delete({ where: { id } });
  }

  // ─── Medications ──────────────────────────────────────────────

  async addMedication(
    patientId: string,
    tenantId: string,
    data: {
      medication: string;
      dosage?: string;
      frequency?: string;
      reason?: string;
      started_at?: Date;
      ended_at?: Date;
    },
  ) {
    await this.assertBelongsToTenant(patientId, tenantId);
    return this.prisma.patientMedication.create({ data: { patient_id: patientId, ...data } });
  }

  async removeMedication(id: string, tenantId: string) {
    const med = await this.prisma.patientMedication.findUnique({
      where: { id },
      select: { id: true, patient: { select: { tenant_id: true } } },
    });
    if (!med) throw new NotFoundException('Medicacao nao encontrada');
    if (med.patient.tenant_id !== tenantId) throw new ForbiddenException('Acesso negado');
    return this.prisma.patientMedication.delete({ where: { id } });
  }

  // ─── Avatar / Foto do paciente ────────────────────────────────

  private static readonly ALLOWED_AVATAR_MIMES: Record<string, string> = {
    'image/jpeg': 'jpg',
    'image/jpg': 'jpg',
    'image/png': 'png',
    'image/webp': 'webp',
  };

  /**
   * Salva imagem em filesystem e atualiza avatar_url do paciente.
   * Aceita JPEG/PNG/WebP. Limite 2 MB.
   */
  async updateAvatar(patientId: string, tenantId: string, buffer: Buffer, mimeType: string) {
    await this.assertBelongsToTenant(patientId, tenantId);

    const ext = PatientsService.ALLOWED_AVATAR_MIMES[mimeType?.toLowerCase()];
    if (!ext) throw new BadRequestException('Tipo de imagem nao suportado. Use JPEG, PNG ou WebP.');
    if (buffer.length > 2 * 1024 * 1024) {
      throw new BadRequestException('Imagem muito grande. Maximo 2 MB.');
    }

    // Limpa versoes anteriores em outras extensoes
    for (const oldExt of Object.values(PatientsService.ALLOWED_AVATAR_MIMES)) {
      if (oldExt !== ext) {
        await this.fileStorage.delete(`patients/${patientId}.${oldExt}`).catch(() => {});
      }
    }

    const relativePath = `patients/${patientId}.${ext}`;
    await this.fileStorage.write(relativePath, buffer);

    await this.prisma.patient.update({
      where: { id: patientId },
      data: { avatar_url: relativePath },
    });

    this.logger.log(`[AVATAR] Foto atualizada para paciente ${patientId}`);
    return { avatar_url: relativePath };
  }

  /** Retorna buffer + mimeType da foto pra servir via HTTP. */
  async getAvatarBuffer(patientId: string): Promise<{ buffer: Buffer; mimeType: string } | null> {
    const patient = await this.prisma.patient.findUnique({
      where: { id: patientId },
      select: { avatar_url: true },
    });
    if (!patient?.avatar_url) return null;

    const ext = patient.avatar_url.split('.').pop()?.toLowerCase() || 'jpg';
    const mimeMap: Record<string, string> = {
      jpg: 'image/jpeg',
      jpeg: 'image/jpeg',
      png: 'image/png',
      webp: 'image/webp',
    };
    const mimeType = mimeMap[ext] ?? 'image/jpeg';

    const buffer = await this.fileStorage.read(patient.avatar_url);
    if (!buffer) return null;
    return { buffer, mimeType };
  }

  /** Remove foto do paciente. */
  async removeAvatar(patientId: string, tenantId: string) {
    await this.assertBelongsToTenant(patientId, tenantId);
    const patient = await this.prisma.patient.findUnique({
      where: { id: patientId },
      select: { avatar_url: true },
    });
    if (patient?.avatar_url) {
      await this.fileStorage.delete(patient.avatar_url).catch(() => {});
    }
    await this.prisma.patient.update({
      where: { id: patientId },
      data: { avatar_url: null },
    });
    return { ok: true };
  }

  // ─── Timeline unificada ──────────────────────────────────────
  //
  // Agrega cronologicamente eventos de 5 fontes em uma só linha do tempo:
  //  1. Consultas (CalendarEvent.start_at)
  //  2. Procedimentos executados (TreatmentPlanItem.executed_at)
  //  3. Pagamentos (Installment, agrupado por status)
  //  4. Retornos (ReturnAlert.scheduled_for + contacted_at)
  //  5. Anamneses (Anamnesis.created_at / signed_at)
  //
  // Roda 5 queries em paralelo, normaliza pra um shape comum, ordena desc
  // por data e limita pelo `limit` (default 100). Permite a recepção ver
  // toda a história do paciente numa olhada — substitui "abrir 5 abas".

  async getTimeline(patientId: string, tenantId: string, limit = 100) {
    await this.assertBelongsToTenant(patientId, tenantId);

    type TimelineItem = {
      id: string;
      // Reference to source row id (sem prefixo) — necessario pra acoes
      // como "Validar" que precisam do CalendarEvent.id real
      source_id?: string;
      type: 'appointment' | 'procedure' | 'payment' | 'return' | 'anamnesis';
      date: string;
      title: string;
      subtitle?: string | null;
      status?: string | null;
      professional?: string | null;
      amount?: number | null;
      link?: string | null;
      // Validacao clinica (Fase 23) — so faz sentido em type=appointment
      assigned_user_id?: string | null;
      validated_at?: string | null;
      validated_by_name?: string | null;
    };

    // Cada query envolvida em try/catch — se uma fonte falhar (ex: tabela
    // ainda não migrou em produção, schema mudou), as outras ainda mostram
    // dados. Evita 500 da rota inteira por causa de uma fonte só.
    const safe = async <T>(p: Promise<T[]>, label: string): Promise<T[]> => {
      try { return await p; }
      catch (e: any) {
        this.logger.warn(`[TIMELINE] Fonte "${label}" falhou: ${e?.message}`);
        return [] as T[];
      }
    };

    const [appointments, procItems, installments, returns, anamneses] = await Promise.all([
      safe(this.prisma.calendarEvent.findMany({
        where: { patient_id: patientId },
        select: {
          id: true, type: true, title: true, description: true,
          start_at: true, status: true,
          assigned_user_id: true,
          assigned_user: { select: { name: true } },
          // Validacao clinica (Fase 23)
          validated_at: true,
          validated_by_user_id: true,
          validated_by: { select: { name: true } },
        },
        orderBy: { start_at: 'desc' },
        take: limit,
      }), 'calendarEvent'),
      safe(this.prisma.treatmentPlanItem.findMany({
        where: {
          treatment_plan: { patient_id: patientId },
          executed_at: { not: null },
        },
        select: {
          id: true, executed_at: true, tooth_fdi: true, status: true,
          procedure: { select: { name: true } },
          executed_by: { select: { name: true } },
        },
        orderBy: { executed_at: 'desc' },
        take: limit,
      }), 'treatmentPlanItem'),
      safe(this.prisma.installment.findMany({
        where: { patient_id: patientId },
        select: {
          id: true, sequence: true, total_count: true,
          amount: true, due_date: true, paid_at: true,
          status: true, payment_method: true,
        },
        orderBy: [{ paid_at: 'desc' }, { due_date: 'desc' }],
        take: limit,
      }), 'installment'),
      safe(this.prisma.returnAlert.findMany({
        where: { patient_id: patientId },
        select: {
          id: true, scheduled_for: true, reason: true, status: true,
          contacted_at: true,
          professional: { select: { name: true } },
        },
        orderBy: { scheduled_for: 'desc' },
        take: limit,
      }), 'returnAlert'),
      safe((this.prisma as any).anamnesis.findMany({
        where: { patient_id: patientId },
        select: {
          id: true, filled_at: true, filled_by_user_id: true,
        },
        orderBy: { filled_at: 'desc' },
        take: limit,
      }) as Promise<any[]>, 'anamnesis'),
    ]);

    const items: TimelineItem[] = [];

    // Consultas
    for (const a of appointments) {
      const typeLabel: Record<string, string> = {
        CONSULTA: 'Consulta',
        PROCEDIMENTO: 'Procedimento',
        RETORNO: 'Retorno',
        BLOQUEIO: 'Bloqueio',
        TAREFA: 'Tarefa',
        OUTRO: 'Evento',
      };
      const label = typeLabel[a.type] || a.type;
      const aAny = a as any;
      items.push({
        id: `appt-${a.id}`,
        source_id: a.id,
        type: 'appointment',
        date: a.start_at.toISOString(),
        title: `${label}: ${a.title}`,
        subtitle: a.description || null,
        status: a.status,
        professional: a.assigned_user?.name || null,
        link: `/atendimento/agenda?event=${a.id}`,
        assigned_user_id: aAny.assigned_user_id ?? null,
        validated_at: aAny.validated_at ? aAny.validated_at.toISOString() : null,
        validated_by_name: aAny.validated_by?.name ?? null,
      });
    }

    // Procedimentos executados
    for (const p of procItems) {
      if (!p.executed_at) continue;
      const tooth = p.tooth_fdi ? ` — dente ${p.tooth_fdi}` : '';
      items.push({
        id: `proc-${p.id}`,
        type: 'procedure',
        date: p.executed_at.toISOString(),
        title: `${p.procedure?.name || 'Procedimento'}${tooth}`,
        subtitle: 'Executado',
        status: p.status,
        professional: p.executed_by?.name || null,
      });
    }

    // Pagamentos: prioriza paid_at quando pago, senão due_date
    for (const i of installments) {
      const isPaid = !!i.paid_at;
      const dt = isPaid ? i.paid_at : i.due_date;
      if (!dt) continue;
      const seqLabel = i.total_count > 1 ? ` (${i.sequence}/${i.total_count})` : '';
      const titlePrefix =
        i.status === 'PAGA' ? 'Pagamento recebido'
        : i.status === 'PARCIAL' ? 'Pagamento parcial'
        : i.status === 'ATRASADA' ? 'Parcela em atraso'
        : i.status === 'CANCELADA' ? 'Parcela cancelada'
        : i.status === 'RENEGOCIADA' ? 'Parcela renegociada'
        : 'Parcela aberta';
      items.push({
        id: `inst-${i.id}`,
        type: 'payment',
        date: dt.toISOString(),
        title: `${titlePrefix}${seqLabel}`,
        subtitle: i.payment_method ? `Via ${i.payment_method}` : null,
        status: i.status,
        amount: Number(i.amount),
      });
    }

    // Retornos
    for (const r of returns) {
      items.push({
        id: `ret-${r.id}`,
        type: 'return',
        date: r.scheduled_for.toISOString(),
        title: r.contacted_at ? `Retorno contatado` : `Retorno programado`,
        subtitle: r.reason || null,
        status: r.status,
        professional: r.professional?.name || null,
      });
    }

    // Anamneses
    for (const a of anamneses) {
      items.push({
        id: `anam-${a.id}`,
        type: 'anamnesis',
        date: a.filled_at.toISOString(),
        title: 'Anamnese preenchida',
        subtitle: null,
        status: null,
      });
    }

    // Ordena desc por data e limita
    items.sort((x, y) => y.date.localeCompare(x.date));
    return { items: items.slice(0, limit), total: items.length };
  }

  // ─── Helpers ──────────────────────────────────────────────────

  private async assertBelongsToTenant(patientId: string, tenantId: string) {
    const row = await this.prisma.patient.findUnique({
      where: { id: patientId },
      select: { tenant_id: true },
    });
    if (!row) throw new NotFoundException('Paciente nao encontrado');
    if (row.tenant_id !== tenantId) throw new ForbiddenException('Acesso negado');
  }
}

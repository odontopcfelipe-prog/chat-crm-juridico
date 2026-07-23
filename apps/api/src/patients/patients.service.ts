import { Injectable, Logger, NotFoundException, ForbiddenException, BadRequestException, Inject, forwardRef } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { FileStorageService } from '../media/filesystem.service';
import { ReferralsService } from '../referrals/referrals.service';
import { PatientTagsService } from '../patient-tags/patient-tags.service';
import { Prisma } from '@crm/shared';
import { normalizeBrazilianPhone, brazilPhoneMatchVariants } from '../common/utils/phone';
// SaaS Fase 4 (Onda 17.32.79) — limites por plano. Import ESTATICO (resolucao
// nodenext, extensao .js): se o modulo sumir o build/boot quebra alto, em vez
// de a checagem de quota ser pulada silenciosamente em runtime — que era o que
// acontecia com o `await import()` dentro de try/catch.
import { getLimitsForPlan, isWithinLimit } from '../tenants/plan-limits.js';

// ============================================================================
// Onda 17.47 — "Inativo" e CALCULADO por recencia, NAO um status salvo.
// Decisao do produto: paciente inativo = nao-arquivado cujo ultimo atendimento
// (last_visit_at, mantido pela agenda ao concluir/validar consulta clinica) foi
// ha MAIS de INACTIVE_AFTER_MONTHS meses. Quem NUNCA foi atendido (last_visit_at
// null) usa a data de cadastro (created_at) como referencia — cadastro recente
// sem consulta ainda conta como Ativo; cadastro antigo sem consulta vira Inativo.
// "Arquivado" (status manual, botao Arquivar) e preservado e tem prioridade.
// Nada disso escreve no banco — e tudo derivado em tempo de leitura.
// ============================================================================
const INACTIVE_AFTER_MONTHS = 12;

/** Data de corte: pacientes com referencia anterior a ela sao Inativos. */
function inactiveCutoff(now: Date = new Date()): Date {
  const d = new Date(now);
  d.setMonth(d.getMonth() - INACTIVE_AFTER_MONTHS);
  return d;
}

/**
 * Fragmento de WHERE (combinavel via AND/spread) pra cada balde de atividade.
 * Ambos excluem ARCHIVED. ACTIVE = referencia DENTRO da janela; INACTIVE = ANTES.
 * Referencia = last_visit_at; se null, cai pra created_at.
 */
function activityWhere(bucket: 'ACTIVE' | 'INACTIVE', cutoff: Date): Prisma.PatientWhereInput {
  if (bucket === 'ACTIVE') {
    return {
      status: { not: 'ARCHIVED' },
      OR: [
        { last_visit_at: { gte: cutoff } },
        { last_visit_at: null, created_at: { gte: cutoff } },
      ],
    };
  }
  return {
    status: { not: 'ARCHIVED' },
    OR: [
      { last_visit_at: { lt: cutoff } },
      { last_visit_at: null, created_at: { lt: cutoff } },
    ],
  };
}

/** Status de atividade derivado pra um paciente ja carregado (selo da lista). */
function deriveActivityStatus(
  p: { status: string; last_visit_at: Date | null; created_at: Date },
  cutoff: Date,
): 'ACTIVE' | 'INACTIVE' | 'ARCHIVED' {
  if (p.status === 'ARCHIVED') return 'ARCHIVED';
  const ref = p.last_visit_at ?? p.created_at;
  return ref < cutoff ? 'INACTIVE' : 'ACTIVE';
}

@Injectable()
export class PatientsService {
  private readonly logger = new Logger(PatientsService.name);

  constructor(
    private prisma: PrismaService,
    private fileStorage: FileStorageService,
    @Inject(forwardRef(() => ReferralsService)) private referralsService: ReferralsService,
    private patientTagsService: PatientTagsService,
  ) {}

  /**
   * SaaS Fase 4 (Onda 17.32.79) — valida o limite de pacientes do plano do
   * tenant ANTES de criar um Patient. Lanca BadRequestException quando a quota
   * ja foi atingida; nao faz nada quando ha folga (ou plano ilimitado).
   *
   * DEVE ser chamado em TODOS os caminhos que criam Patient: create(),
   * convertFromLead() e InfluencersService.create(). Sem isso um tenant fura a
   * quota paga — ex.: STARTER passa de max_patients convertendo leads que
   * chegam o tempo todo pelo WhatsApp, ou cadastrando influenciadores.
   *
   * `client` aceita o tx de uma $transaction em andamento (InfluencersService)
   * pra contar dentro da mesma transacao, sem abrir uma segunda conexao.
   */
  async assertCanCreatePatient(
    tenantId: string,
    client: Prisma.TransactionClient = this.prisma,
  ): Promise<void> {
    if (!tenantId) throw new BadRequestException('tenant_id ausente no contexto');
    const tenant = await client.tenant.findUnique({
      where: { id: tenantId },
      select: { plan: true },
    });
    const limits = getLimitsForPlan(tenant?.plan);
    const currentCount = await client.patient.count({ where: { tenant_id: tenantId } });
    if (!isWithinLimit(currentCount, limits.max_patients)) {
      throw new BadRequestException(
        `Limite do plano ${tenant?.plan} atingido pra pacientes (${currentCount}/${limits.max_patients}). Atualize o plano pra continuar.`,
      );
    }
  }

  // (Removido) backfillPhoneDdi/addDdiBr: gravavam telefone FORMATADO "+55 (82) 9…"
  // com o nono dígito, o que quebrava o casamento por telefone e ERA fonte do
  // contato duplicado. A padronização + unificação segura agora vive no
  // LeadsCleanupService.deduplicatePhones (botão "Corrigir telefones" em Disparos).

  /** Cria novo paciente. Valida CPF unico por tenant quando preenchido. */
  async create(
    tenantId: string,
    data: Omit<Prisma.PatientUncheckedCreateInput, 'tenant_id'> & { tag_ids?: string[] },
  ) {
    if (!tenantId) throw new BadRequestException('tenant_id ausente no contexto');

    // tag_ids nao e coluna do Patient — separa antes de mandar pro prisma.create
    const { tag_ids, ...patientData } = data;

    // Onda 17.32.79 / SaaS Fase 4 — valida limite de pacientes do plano.
    await this.assertCanCreatePatient(tenantId);

    if (data.cpf) {
      const existing = await this.prisma.patient.findUnique({
        where: { tenant_id_cpf: { tenant_id: tenantId, cpf: data.cpf } },
      });
      if (existing) throw new BadRequestException('Ja existe um paciente com este CPF neste tenant');
    }

    // Onda 17.32.184 — ficha (numero de prontuario) unica por tenant
    if (data.record_number) {
      const dupFicha = await this.prisma.patient.findFirst({
        where: { tenant_id: tenantId, record_number: data.record_number as string },
        select: { name: true },
      });
      if (dupFicha) {
        throw new BadRequestException(`A ficha ${data.record_number} já pertence ao paciente ${dupFicha.name}`);
      }
    }

    // Onda 17.34 — isolamento multi-tenant: referred_by_id vem do cliente e e
    // gravado na coluna do paciente. Sem esta checagem, dava pra apontar um
    // paciente de OUTRO tenant como indicador (vazamento + cashback indevido).
    if (patientData.referred_by_id) {
      const referrer = await this.prisma.patient.findUnique({
        where: { id: patientData.referred_by_id as string },
        select: { tenant_id: true },
      });
      if (!referrer || referrer.tenant_id !== tenantId) {
        throw new BadRequestException('Paciente indicador inválido');
      }
    }

    // Onda 17.33 — pré-valida etiquetas ANTES de criar o paciente (fail-fast):
    // se vier tag de outro tenant, erra com 400 claro em vez de criar o
    // paciente e engolir o erro silenciosamente (sem órfão, sem confusão UX).
    const uniqueTagIds = tag_ids ? [...new Set(tag_ids)] : [];
    if (uniqueTagIds.length > 0) {
      const validTags = await (this.prisma as any).patientTag.findMany({
        where: { id: { in: uniqueTagIds }, tenant_id: tenantId },
        select: { id: true },
      });
      if (validTags.length !== uniqueTagIds.length) {
        throw new BadRequestException('Uma ou mais etiquetas são inválidas ou de outro tenant');
      }
    }

    const patient = await this.prisma.patient.create({
      data: { ...patientData, tenant_id: tenantId },
    });

    // Aplica as etiquetas já validadas. Só um erro transitório de banco cai
    // aqui (não validação) — best-effort pra não desfazer o paciente criado.
    if (uniqueTagIds.length > 0) {
      try {
        await this.patientTagsService.setTagsForPatient(patient.id, tenantId, uniqueTagIds);
      } catch (e: any) {
        this.logger.warn(`[PATIENT CREATE] Falha ao aplicar tags em ${patient.id}: ${e?.message}`);
      }
    }

    // Onda 5e v35 (Fase 25) — quando paciente eh cadastrado direto pela ficha
    // (sem ter chegado via WhatsApp), CRIA Lead + Conversation automaticamente
    // se ainda nao existirem. Sem isso:
    //   - Paciente nao aparece na lista do WhatsApp
    //   - Lembretes disparados nao ficam salvos no chat (worker procura por lead_id)
    //   - Operador nao tem visao consolidada da comunicacao com o paciente
    //
    // Best-effort: se falhar nao bloqueia criacao do paciente.
    if (data.phone && !patient.lead_id) {
      try {
        await this.ensureLeadAndConversation(patient.id, data.phone as string, data.name as string | null, tenantId);
      } catch (e: any) {
        this.logger.warn(`[PATIENT CREATE] Falha ao auto-criar Lead/Conversation pra ${patient.id}: ${e?.message}`);
      }
    }

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

  /**
   * v35: Versao publica chamavel via endpoint POST /patients/:id/ensure-conversation
   * pra reparar pacientes existentes (cadastrados sem lead/conversa, ex: Jilfran).
   */
  async ensureLeadAndConversationPublic(patientId: string, tenantId: string) {
    const patient = await this.prisma.patient.findUnique({
      where: { id: patientId },
      select: { id: true, name: true, phone: true, lead_id: true, tenant_id: true },
    });
    if (!patient) throw new NotFoundException('Paciente nao encontrado');
    if (patient.tenant_id !== tenantId) throw new ForbiddenException('Acesso negado');
    if (!patient.phone) throw new BadRequestException('Paciente nao tem telefone — impossivel criar conversa');

    await this.ensureLeadAndConversation(patient.id, patient.phone, patient.name, tenantId);

    // Retorna estado atualizado
    return this.prisma.patient.findUnique({
      where: { id: patientId },
      include: { lead: { select: { id: true, name: true, phone: true } } },
    });
  }

  /**
   * v35: Garante que paciente tem Lead + Conversation associados.
   *   1. Procura Lead existente pelo telefone (mesmo tenant)
   *   2. Se nao tem, cria Lead novo com nome/phone do paciente
   *   3. Vincula patient.lead_id ao lead encontrado/criado
   *   4. Procura Conversation do lead. Se nao tem, cria com instance default
   *
   * Resultado: paciente vira "visivel" na inbox WhatsApp + worker de lembretes
   * consegue salvar mensagem na conversa correta.
   */
  private async ensureLeadAndConversation(
    patientId: string,
    phone: string,
    name: string | null,
    tenantId: string,
  ): Promise<void> {
    // Canoniza pro MESMO formato do webhook (55 + DDD + 8 díg, SEM o nono dígito)
    // — assim o lead do paciente cadastrado à mão e o lead que nasce da mensagem
    // de WhatsApp CONVERGEM num contato só, em vez de duplicar (era a raiz do "2
    // contatos do mesmo paciente").
    const digits = phone.replace(/\D/g, '');
    if (!digits) return;
    const normalizedPhone = normalizeBrazilianPhone(phone);

    // 1. Procura Lead por TODAS as variantes do número (com/sem 9, com/sem 55,
    //    formatado) no mesmo tenant — pra ADOTAR um lead já existente do webhook.
    let lead = await this.prisma.lead.findFirst({
      where: { tenant_id: tenantId, phone: { in: brazilPhoneMatchVariants(phone) } },
      select: { id: true, name: true },
    });

    // Lead já pertence a OUTRO paciente (família divide o número): NÃO dá pra
    // linkar (Patient.lead_id é @unique) NEM criar um lead novo com o mesmo número
    // (Lead tem @@unique[tenant_id, phone] → P2002). Sai limpo, sem vincular: o
    // paciente fica sem conversa própria (o WhatsApp mora no lead do 1º), o que é
    // o comportamento aceitável pra número compartilhado — melhor que crashar.
    if (lead) {
      const claimedByOther = await this.prisma.patient.findFirst({
        where: { lead_id: lead.id, id: { not: patientId } },
        select: { id: true },
      });
      if (claimedByOther) return;

      // Lead já existe (nasceu de uma mensagem WhatsApp com o pushName/apelido do
      // paciente): ADOTA o nome do CADASTRO (autoritativo) — senão a conversa segue
      // mostrando o pushName em vez do nome cadastrado. Só sobrescreve com um nome REAL
      // (ignora vazio e o placeholder "Paciente sem nome").
      const cadastroName = (name || '').trim();
      if (cadastroName && cadastroName !== 'Paciente sem nome' && lead.name !== cadastroName) {
        await this.prisma.lead.update({ where: { id: lead.id }, data: { name: cadastroName } });
        this.logger.log(`[PATIENT] Lead ${lead.id} renomeado pro cadastro: "${cadastroName}" (era "${lead.name || ''}")`);
      }
    }

    // 2. Cria Lead se nao tem
    if (!lead) {
      lead = await this.prisma.lead.create({
        data: {
          name: name || 'Paciente sem nome',
          phone: normalizedPhone,
          tenant_id: tenantId,
          stage: 'NOVO',
          origin: 'cadastro_manual',
        },
        select: { id: true, name: true },
      });
      this.logger.log(`[PATIENT CREATE] Lead criado pra paciente ${patientId}: lead=${lead.id}`);
    }

    // 3. Vincula patient.lead_id
    await this.prisma.patient.update({
      where: { id: patientId },
      data: { lead_id: lead.id },
    });

    // 4. Garante Conversation pra esse lead
    const existingConv = await this.prisma.conversation.findFirst({
      where: { lead_id: lead.id },
      select: { id: true },
    });
    if (!existingConv) {
      // Pega primeira instancia whatsapp do tenant (best-effort)
      const instance = await this.prisma.instance.findFirst({
        where: { tenant_id: tenantId, type: 'whatsapp' },
        select: { name: true, id: true },
      });
      // Pega primeira inbox do tenant (best-effort)
      const inbox = await this.prisma.inbox.findFirst({
        where: { tenant_id: tenantId },
        select: { id: true },
      });
      try {
        await this.prisma.conversation.create({
          data: {
            lead_id: lead.id,
            channel: 'whatsapp',
            status: 'ABERTO',
            external_id: `${normalizedPhone}@s.whatsapp.net`,
            instance_name: instance?.name || null,
            inbox_id: inbox?.id || null,
            tenant_id: tenantId,
            ai_mode: false, // paciente cadastrado manualmente nao quer IA por padrao
            last_message_at: new Date(),
          },
        });
        this.logger.log(`[PATIENT CREATE] Conversation criada pra lead ${lead.id} (paciente ${patientId})`);
      } catch (e: any) {
        // Conversation pode falhar se schema exigir mais campos — log e segue
        this.logger.warn(`[PATIENT CREATE] Falha ao criar conversation: ${e?.message}`);
      }
    }
  }

  /** Lista pacientes com busca, filtros e paginacao. */
  async findAll(
    tenantId: string,
    opts: {
      search?: string;
      status?: string;        // filtro pelo campo SALVO (compat com pickers)
      activity?: string;      // Onda 17.47 — filtro CALCULADO: ACTIVE/INACTIVE/ARCHIVED
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
    // status = filtro pelo campo SALVO. Mantido cru DE PROPOSITO: outros
    // consumidores mandam ?status=ACTIVE pra dizer "nao-arquivado" (pickers de
    // Nova Avaliacao, indicador...). Mexer aqui mudaria o significado deles.
    if (opts.status) andFilters.push({ status: opts.status });
    // Onda 17.47 — activity = filtro CALCULADO por recencia (dropdown da tela de
    // Pacientes). ACTIVE/INACTIVE derivam de last_visit_at/created_at; ARCHIVED
    // cai no status salvo. Param SEPARADO de `status` pra nao colidir com os pickers.
    const activityCutoff = inactiveCutoff();
    if (opts.activity === 'ARCHIVED') {
      andFilters.push({ status: 'ARCHIVED' });
    } else if (opts.activity === 'ACTIVE' || opts.activity === 'INACTIVE') {
      andFilters.push(activityWhere(opts.activity, activityCutoff));
    }
    if (opts.dentistId) andFilters.push({ primary_dentist_id: opts.dentistId });
    if (opts.tagId) andFilters.push({ tags: { some: { tag_id: opts.tagId } } });
    if (opts.withActivePlan) andFilters.push({ treatment_plans: { some: { status: 'ACTIVE' } } });
    if (opts.withoutAnamnesis) andFilters.push({ anamneses: { none: {} } });
    if (lastVisitFilter) andFilters.push(lastVisitFilter);
    // Onda 17.48 — busca textual (substring em nome/telefone/cpf/ficha/email/tag).
    // NAO entra no andFilters base de proposito: a busca e tratada em DOIS baldes
    // pra rankear por relevancia (quem o NOME comeca com o termo vem primeiro).
    const searchOr: Prisma.PatientWhereInput | undefined = opts.search
      ? {
          OR: [
            { name: { contains: opts.search, mode: 'insensitive' } },
            { phone: { contains: opts.search } },
            { cpf: { contains: opts.search } },
            { email: { contains: opts.search, mode: 'insensitive' } },
            // Onda 17.32.184 — busca tambem pela ficha (nº de prontuario)
            { record_number: { contains: opts.search, mode: 'insensitive' } },
            // Onda 17.33 — busca tambem pelo nome da etiqueta
            { tags: { some: { tag: { name: { contains: opts.search, mode: 'insensitive' } } } } },
          ],
        }
      : undefined;

    const include = {
      primary_dentist: { select: { id: true, name: true, email: true } },
      tags: { include: { tag: true } },
      _count: { select: { anamneses: true, treatment_plans: true, appointments: true } },
    } satisfies Prisma.PatientInclude;

    let data: any[];
    let total: number;

    if (searchOr) {
      // Onda 17.48 — RANKING por relevancia. Antes a busca ordenava so por nome
      // ASC: quem apenas CONTINHA a letra num nome menor (ex: "Lustosa" pra "s")
      // vinha ANTES de quem o nome COMECA com ela ("Suellen"). Agora dois baldes:
      //   tier 1 = nome COMECA com o termo (o que o usuario espera ver primeiro)
      //   tier 2 = demais matches (substring em qualquer campo) menos o tier 1
      // Cada balde por nome ASC; a paginacao atravessa os dois corretamente.
      const prefixCond: Prisma.PatientWhereInput = {
        name: { startsWith: opts.search, mode: 'insensitive' },
      };
      const prefixWhere: Prisma.PatientWhereInput = { AND: [...andFilters, prefixCond] };
      const restWhere: Prisma.PatientWhereInput = {
        AND: [...andFilters, searchOr, { NOT: prefixCond }],
      };

      const [prefixCount, restCount] = await Promise.all([
        this.prisma.patient.count({ where: prefixWhere }),
        this.prisma.patient.count({ where: restWhere }),
      ]);
      total = prefixCount + restCount;

      // Fatia da pagina atual em cada balde (tier 1 primeiro, depois tier 2).
      const t1Take = Math.max(0, Math.min(limit, prefixCount - skip));
      const t2Skip = Math.max(0, skip - prefixCount);
      const t2Take = limit - t1Take;

      const [t1, t2] = await Promise.all([
        t1Take > 0
          ? this.prisma.patient.findMany({ where: prefixWhere, orderBy: [{ name: 'asc' }, { id: 'asc' }], skip, take: t1Take, include })
          : Promise.resolve([] as any[]),
        t2Take > 0
          ? this.prisma.patient.findMany({ where: restWhere, orderBy: [{ name: 'asc' }, { id: 'asc' }], skip: t2Skip, take: t2Take, include })
          : Promise.resolve([] as any[]),
      ]);
      data = [...t1, ...t2];
    } else {
      const where: Prisma.PatientWhereInput = { AND: andFilters };
      [data, total] = await Promise.all([
        this.prisma.patient.findMany({
          where,
          // Onda 17.44 — lista em ordem alfabética por nome (antes era created_at
          // desc, que ficava bagunçado depois de importar uma base grande).
          // Onda 17.48 — desempate por id pra ordem total estavel entre paginas
          // (nomes homonimos nao trocam de lugar/duplicam na fronteira).
          orderBy: [{ name: 'asc' }, { id: 'asc' }],
          skip,
          take: limit,
          include,
        }),
        this.prisma.patient.count({ where }),
      ]);
    }

    // Onda 17.47 — anexa o status de atividade CALCULADO (Ativo/Inativo/Arquivado)
    // pra lista exibir o selo certo sem reimplementar a regra dos 12m no front.
    const dataWithActivity = data.map((p) => ({
      ...p,
      activity_status: deriveActivityStatus(p, activityCutoff),
    }));

    return { data: dataWithActivity, total, page, totalPages: Math.ceil(total / limit) };
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

    // Onda 17.32.184 — ficha (numero de prontuario) unica por tenant
    if (data.record_number && typeof data.record_number === 'string') {
      const fichaConflict = await this.prisma.patient.findFirst({
        where: { tenant_id: tenantId, record_number: data.record_number, NOT: { id } },
        select: { name: true },
      });
      if (fichaConflict) {
        throw new BadRequestException(`A ficha ${data.record_number} já pertence ao paciente ${fichaConflict.name}`);
      }
    }

    const updated = await this.prisma.patient.update({ where: { id }, data });

    // Nome do cadastro é a fonte da verdade do contato: quando o nome muda, sincroniza o
    // Lead (contato WhatsApp) — senão a conversa continuaria com o nome antigo/pushName.
    if (typeof data.name === 'string' && data.name.trim() && updated.lead_id) {
      await this.prisma.lead
        .update({ where: { id: updated.lead_id }, data: { name: data.name.trim() } })
        .catch((e: any) => this.logger.warn(`[PATIENT UPDATE] falha ao sincronizar nome do lead ${updated.lead_id}: ${e?.message}`));
    }
    return updated;
  }

  /** Soft delete — marca como ARCHIVED. Use para preservar historico clinico. */
  async archive(id: string, tenantId: string) {
    await this.assertBelongsToTenant(id, tenantId);
    return this.prisma.patient.update({ where: { id }, data: { status: 'ARCHIVED' } });
  }

  /**
   * Onda 14.1 — Preview das dependencias antes de excluir.
   * Retorna lista detalhada (datas, valores, status) pra UI mostrar pro
   * operador exatamente o que sera apagado se ele forcar a exclusao.
   */
  async getDeletionPreview(id: string, tenantId: string) {
    await this.assertBelongsToTenant(id, tenantId);

    const [appointments, quotes, paidInstallments, medicalRecordsCount] =
      await Promise.all([
        this.prisma.calendarEvent.findMany({
          where: { patient_id: id },
          orderBy: { start_at: 'desc' },
          take: 50,
          select: {
            id: true,
            title: true,
            type: true,
            status: true,
            start_at: true,
          },
        }),
        this.prisma.quote.findMany({
          where: { patient_id: id, deleted_at: null },
          orderBy: { created_at: 'desc' },
          take: 50,
          select: {
            id: true,
            title: true,
            status: true,
            total_value: true,
            created_at: true,
          },
        }),
        this.prisma.installment.findMany({
          where: { patient_id: id, status: 'PAGA' },
          orderBy: { paid_at: 'desc' },
          take: 50,
          select: {
            id: true,
            amount: true,
            paid_at: true,
            sequence: true,
            total_count: true,
          },
        }),
        this.prisma.medicalRecord.count({ where: { patient_id: id } }),
      ]);

    const canDeleteSafely =
      appointments.length === 0 &&
      quotes.length === 0 &&
      paidInstallments.length === 0 &&
      medicalRecordsCount === 0;

    return {
      can_delete_safely: canDeleteSafely,
      appointments,
      quotes,
      paid_installments: paidInstallments,
      medical_records_count: medicalRecordsCount,
    };
  }

  /**
   * Onda 14.1 — Exclusao forcada com cascade manual.
   * Usado quando operador VIU as dependencias e mesmo assim quer apagar tudo.
   * Apaga em transacao:
   *  - calendarEvent (relacao SetNull → ficaria orfa, apaga manual)
   *  - patient (cascade automatico do resto via schema)
   *
   * Demais relacoes (quote, installment, medicalRecord, anamnese, odontogram,
   * etc) tem onDelete: Cascade no schema, entao caem junto com o patient.
   */
  async forceDelete(id: string, tenantId: string) {
    await this.assertBelongsToTenant(id, tenantId);

    await this.prisma.$transaction(async (tx) => {
      // Apaga manualmente o que tem SetNull (pra nao deixar orfaos)
      await tx.calendarEvent.deleteMany({ where: { patient_id: id } });
      // Apaga o patient — cascade automatico do resto via schema
      await tx.patient.delete({ where: { id } });
    });

    this.logger.log(`[FORCE-DELETE] Patient ${id} apagado em cascade (tenant=${tenantId})`);
    return { ok: true, deleted_at: new Date().toISOString(), cascade: true };
  }

  /**
   * Onda 14 — Exclusao permanente do paciente (HARD DELETE).
   *
   * Apaga o paciente do banco se ele nao tiver historico relevante.
   * Verifica antes:
   *  - consultas (appointments)
   *  - orcamentos (quotes nao soft-deletados)
   *  - parcelas pagas (installments PAGA)
   *  - prontuario clinico com sessoes (clinical_records)
   *
   * Se tiver alguma dessas → bloqueia com mensagem clara (operador deve
   * arquivar via "Arquivar" em vez).
   * Se estiver limpo → prisma.patient.delete (cascade via schema).
   */
  async permanentlyDelete(id: string, tenantId: string) {
    await this.assertBelongsToTenant(id, tenantId);

    // Conta dependencias bloqueantes (modelos onde patient_id eh FK)
    const [appointmentsCount, quotesCount, paidInstallmentsCount, medicalRecordsCount] =
      await Promise.all([
        this.prisma.calendarEvent.count({ where: { patient_id: id } }),
        this.prisma.quote.count({ where: { patient_id: id, deleted_at: null } }),
        this.prisma.installment.count({
          where: { patient_id: id, status: 'PAGA' },
        }),
        this.prisma.medicalRecord.count({ where: { patient_id: id } }),
      ]);

    const blocks: string[] = [];
    if (appointmentsCount > 0)
      blocks.push(`${appointmentsCount} consulta${appointmentsCount === 1 ? '' : 's'} agendada${appointmentsCount === 1 ? '' : 's'}`);
    if (quotesCount > 0)
      blocks.push(`${quotesCount} orçamento${quotesCount === 1 ? '' : 's'}`);
    if (paidInstallmentsCount > 0)
      blocks.push(`${paidInstallmentsCount} parcela${paidInstallmentsCount === 1 ? '' : 's'} paga${paidInstallmentsCount === 1 ? '' : 's'}`);
    if (medicalRecordsCount > 0)
      blocks.push(`${medicalRecordsCount} registro${medicalRecordsCount === 1 ? '' : 's'} clínico${medicalRecordsCount === 1 ? '' : 's'}`);

    if (blocks.length > 0) {
      throw new BadRequestException(
        `Não é possível excluir permanentemente: paciente tem ${blocks.join(', ')}. ` +
        `Use "Arquivar" pra preservar o histórico ou exclua as dependências antes.`,
      );
    }

    // Sem dependencias relevantes → hard delete (cascade via @relation)
    await this.prisma.patient.delete({ where: { id } });
    return { ok: true, deleted_at: new Date().toISOString() };
  }

  /** Converte um Lead em Patient. Se o paciente ja existe (lead_id ja vinculado), retorna o existente. */
  async convertFromLead(leadId: string, tenantId: string, extraData: Partial<Prisma.PatientUncheckedCreateInput> = {}) {
    const lead = await this.prisma.lead.findUnique({ where: { id: leadId } });
    if (!lead) throw new NotFoundException('Lead nao encontrado');
    if (lead.tenant_id !== tenantId) throw new ForbiddenException('Acesso negado a este lead');

    const existing = await this.prisma.patient.findUnique({ where: { lead_id: leadId } });
    if (existing) return existing;

    // Onda 17.34 — anti-duplicata: se ja existe paciente no tenant com o
    // MESMO telefone (com/sem DDI 55), reusa em vez de criar um segundo
    // cadastro. Cobre o caso classico: recepcao cadastrou manualmente com
    // "82 9..." e o lead do WhatsApp chega como "5582...". Match e por
    // digitos exatos. So gera variante quando ha DDD (>=10 digitos) — numero
    // local de 8 digitos prefixado com "55" colidiria com fixos do DDD 55.
    const leadDigits = (lead.phone || '').replace(/\D/g, '');
    if (leadDigits.length >= 10) {
      const phoneVariants = new Set([leadDigits]);
      if (leadDigits.startsWith('55') && leadDigits.length >= 12) phoneVariants.add(leadDigits.slice(2));
      else phoneVariants.add(`55${leadDigits}`);
      // Fast path indexavel: telefones gravados ja normalizados (fluxos
      // WhatsApp/venda-rapida). Fallback: varredura leve (id+phone+lead_id,
      // <1MB pra 10k pacientes, 1x por conversao) pra pegar formatados
      // ("82 99999-9999") que o match exato de string nao acha.
      let samePhone = await this.prisma.patient.findFirst({
        where: { tenant_id: tenantId, phone: { in: [...phoneVariants] } },
        select: { id: true, phone: true, lead_id: true },
      });
      if (!samePhone) {
        const candidates = await this.prisma.patient.findMany({
          where: { tenant_id: tenantId, phone: { not: null } },
          select: { id: true, phone: true, lead_id: true },
        });
        samePhone = candidates.find((c) => phoneVariants.has((c.phone || '').replace(/\D/g, ''))) ?? null;
      }
      if (samePhone) {
        this.logger.log(
          `[CONVERT] Lead ${leadId} casou com paciente existente ${samePhone.id} pelo telefone — duplicata evitada`,
        );
        if (samePhone.lead_id) {
          return this.prisma.patient.findUniqueOrThrow({ where: { id: samePhone.id } });
        }
        const linked = await this.prisma.patient.update({
          where: { id: samePhone.id },
          data: { lead_id: leadId },
        });
        // Mesmos hooks do caminho de criacao: vincula consultas ja agendadas
        // no lead e puxa a foto do WhatsApp se o paciente nao tem.
        try {
          await this.prisma.calendarEvent.updateMany({
            where: { tenant_id: tenantId, lead_id: leadId, patient_id: null },
            data: { patient_id: linked.id },
          });
          await this.recalculateVisitDates(linked.id).catch(() => {});
        } catch (e: any) {
          this.logger.warn(`[CONVERT] Backfill no vinculo por telefone falhou: ${e?.message}`);
        }
        if (lead.profile_picture_url && !linked.avatar_url) {
          this.copyWhatsappAvatarToPatient(linked.id, tenantId, lead.profile_picture_url).catch((err) =>
            this.logger.warn(`[CONVERT] Falha ao copiar foto WhatsApp pro paciente ${linked.id}: ${err?.message}`),
          );
        }
        return linked;
      }
    }

    // CPF duplicado em extraData estouraria P2002 (500 generico) — valida
    // antes com a mesma mensagem amigavel do create().
    if (extraData.cpf) {
      const cpfDup = await this.prisma.patient.findUnique({
        where: { tenant_id_cpf: { tenant_id: tenantId, cpf: extraData.cpf as string } },
      });
      if (cpfDup) throw new BadRequestException('Ja existe um paciente com este CPF neste tenant');
    }

    // SaaS Fase 4 — valida limite do plano tambem na conversao de Lead. Leads
    // chegam constantemente via WhatsApp; sem esta checagem um tenant STARTER
    // ultrapassa max_patients indefinidamente convertendo leads em pacientes.
    await this.assertCanCreatePatient(tenantId);

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

    // Onda 17.32.62 — Copia foto do WhatsApp (Evolution CDN -> S3 local).
    // A URL da Evolution expira em poucas horas; persistimos a imagem no
    // nosso storage pra que continue funcionando. Best-effort: falha
    // (timeout, 404, formato invalido) so loga warning, nao quebra a
    // conversao.
    if (lead.profile_picture_url) {
      this.copyWhatsappAvatarToPatient(patient.id, tenantId, lead.profile_picture_url)
        .catch((err) =>
          this.logger.warn(
            `[CONVERT] Falha ao copiar foto WhatsApp pro paciente ${patient.id}: ${err?.message}`,
          ),
        );
    }

    // Backfill: vincula CalendarEvents existentes (criados antes da conversão
    // com lead_id apenas) ao novo patient_id. Garante Timeline + Resumo Clínico
    // a mostrar consultas agendadas antes do lead virar paciente.
    try {
      const linked = await this.prisma.calendarEvent.updateMany({
        where: { tenant_id: tenantId, lead_id: leadId, patient_id: null },
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

    // Onda 17.34 — em LOTE: a versao anterior fazia 2 queries POR evento
    // orfao + 2 POR paciente do tenant (N+1). Com 1.000 orfaos e 10.000
    // pacientes eram ~22.000 queries; agora sao ~3 + 1 updateMany por
    // paciente tocado + 1 update por paciente com visita.
    let eventsLinked = 0;
    const patientsTouched = new Set<string>();
    const orphanLeadIds = [...new Set(orphanEvents.map((e) => e.lead_id).filter(Boolean))] as string[];
    if (orphanLeadIds.length > 0) {
      const patientsByLead = await this.prisma.patient.findMany({
        where: { tenant_id: tenantId, lead_id: { in: orphanLeadIds } },
        select: { id: true, lead_id: true },
      });
      const leadToPatient = new Map(patientsByLead.map((p) => [p.lead_id as string, p.id]));
      // Agrupa eventos por paciente destino e vincula com 1 updateMany cada
      const eventsByPatient = new Map<string, string[]>();
      for (const e of orphanEvents) {
        const pid = e.lead_id ? leadToPatient.get(e.lead_id) : undefined;
        if (!pid) continue;
        if (!eventsByPatient.has(pid)) eventsByPatient.set(pid, []);
        eventsByPatient.get(pid)!.push(e.id);
      }
      for (const [pid, eventIds] of eventsByPatient) {
        const r = await this.prisma.calendarEvent.updateMany({
          // tenant_id redundante (orphanEvents ja veio filtrado) — defesa em
          // profundidade contra lead_id corrompido cruzando tenants.
          where: { id: { in: eventIds }, tenant_id: tenantId },
          data: { patient_id: pid },
        });
        eventsLinked += r.count;
        patientsTouched.add(pid);
      }
    }

    // 2) Recalcula first/last_visit_at de quem tem visita — groupBy resolve
    // min/max de TODOS os pacientes do tenant numa query so.
    const visitAgg = await this.prisma.calendarEvent.groupBy({
      by: ['patient_id'],
      where: {
        tenant_id: tenantId,
        patient_id: { not: null },
        type: { in: ['CONSULTA', 'PROCEDIMENTO', 'RETORNO'] },
        status: { in: ['CONFIRMADO', 'CONCLUIDO'] },
      },
      _min: { start_at: true },
      _max: { start_at: true },
    });

    let patientsRecalculated = 0;
    for (const agg of visitAgg) {
      if (!agg.patient_id || !agg._min.start_at) continue;
      try {
        await this.prisma.patient.update({
          where: { id: agg.patient_id },
          data: { first_visit_at: agg._min.start_at, last_visit_at: agg._max.start_at },
        });
        patientsRecalculated++;
      } catch {
        // paciente pode ter sido removido entre o groupBy e o update — ignora
      }
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
    // Onda 18.x — Prisma ORM (findMany) + filtro de mês/dia no NODE. Raw SQL em
    // Patient quebra ("relation patients does not exist" → 500 no widget de
    // aniversariantes) — ver memória do projeto: SEMPRE ORM pra Patient.
    const patients = await this.prisma.patient.findMany({
      where: { tenant_id: tenantId, status: 'ACTIVE', birth_date: { not: null } },
      select: { id: true, name: true, phone: true, birth_date: true, avatar_url: true, primary_dentist_id: true },
    });

    const now = new Date();
    const mdKey = (d: Date) => (d.getUTCMonth() + 1) * 100 + d.getUTCDate();
    let matchesBirthday: (bd: Date) => boolean;
    if (period === 'today') {
      const k = mdKey(now);
      matchesBirthday = (bd) => mdKey(bd) === k;
    } else if (period === 'week') {
      const set = new Set<number>();
      for (let i = 0; i < 7; i++) set.add(mdKey(new Date(now.getTime() + i * 86400000)));
      matchesBirthday = (bd) => set.has(mdKey(bd));
    } else {
      const m = now.getUTCMonth();
      matchesBirthday = (bd) => bd.getUTCMonth() === m;
    }

    const rows = patients
      .filter((p) => p.birth_date && matchesBirthday(new Date(p.birth_date)))
      .sort((a, b) =>
        mdKey(new Date(a.birth_date as Date)) - mdKey(new Date(b.birth_date as Date)) ||
        String(a.name).localeCompare(String(b.name)),
      )
      .slice(0, 200);

    return rows.map((r) => {
      // Calcula idade que vai fazer
      const today = new Date();
      const b = new Date(r.birth_date as Date);
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
    // Onda 17.47 — Ativos/Inativos sao CALCULADOS por recencia (>12m sem
    // atendimento = Inativo); Arquivados continua sendo o status salvo.
    // active + inactive + archived = total (particao: archived vs nao-archived
    // dividido por recencia; created_at sempre existe, entao todo mundo cai em 1).
    const cutoff = inactiveCutoff();
    const [total, active, inactive, archived, withActivePlan] = await Promise.all([
      this.prisma.patient.count({ where: { tenant_id: tenantId } }),
      this.prisma.patient.count({ where: { tenant_id: tenantId, ...activityWhere('ACTIVE', cutoff) } }),
      this.prisma.patient.count({ where: { tenant_id: tenantId, ...activityWhere('INACTIVE', cutoff) } }),
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

  /**
   * Onda 14.50 — Funil de Pacientes da Clínica.
   *
   * REGRA DE ENTRADA (Onda 14.51): paciente so entra no funil quando o
   * PRIMEIRO PAGAMENTO cai em conta. Critério: pelo menos 1 Installment
   * com status 'PAGA' OU 'PARCIAL' (parcial = dinheiro real entrou,
   * mesmo que o valor total da parcela ainda nao tenha sido coberto).
   * Antes de pagar a primeira parcela o paciente ainda eh um "Lead/quote
   * aceita" sem compromisso financeiro consumado — fica no CRM Fechamentos.
   * Apos o pagamento, ele formalmente "vira paciente da clinica".
   *
   * Tambem exige TreatmentPlan ACTIVE ou PENDING_SIGNATURE pra descartar
   * planos cancelados (paciente pagou parcela, plano foi cancelado depois,
   * nao faz sentido aparecer no funil).
   *
   * Retorna patients anotados com:
   *  - aguardandoInicio: true quando nenhum item esta SCHEDULED/IN_PROGRESS
   *    (paciente pagou + assinou mas ainda nao tem proximo procedimento
   *    agendado — operador precisa marcar primeiro procedimento)
   *  - procedures[]: lista deduplicada de procedimentos ativos (SCHEDULED
   *    ou IN_PROGRESS). Frontend usa essa lista pra renderizar o card 1x
   *    em cada coluna de procedimento.
   *  - nextAppointment: data do proximo agendamento (entre items ativos)
   *
   * Front filtra:
   *   coluna "Aguardando Inicio" → patients.filter(p => p.funil.aguardandoInicio)
   *   coluna <procedureId>       → patients.filter(p => p.funil.procedures.some(...))
   *
   * Endpoint: GET /patients/funil-clinica
   */
  async findFunilClinica(tenantId: string) {
    if (!tenantId) throw new BadRequestException('tenant_id ausente no contexto');

    // Onda 14.52 — alem dos patients que passam o gate financeiro, retornar
    // tambem availableProcedures: procedimentos com pelo menos 1 TreatmentPlanItem
    // SCHEDULED/IN_PROGRESS em qualquer paciente do tenant (mesmo que o
    // paciente ainda nao tenha pago a primeira parcela). Isso permite o
    // frontend renderizar as colunas do Kanban mesmo quando o funil esta
    // vazio — operador ve a estrutura do funil sem precisar ter casos reais.
    const availableProceduresRaw = await this.prisma.treatmentPlanItem.findMany({
      where: {
        status: { in: ['SCHEDULED', 'IN_PROGRESS'] },
        treatment_plan: {
          patient: { tenant_id: tenantId },
        },
      },
      distinct: ['procedure_id'],
      select: {
        procedure: { select: { id: true, name: true, category: true } },
      },
    });
    const availableProcedures = availableProceduresRaw.map((r) => r.procedure);

    const patients = await this.prisma.patient.findMany({
      where: {
        tenant_id: tenantId,
        status: 'ACTIVE',
        // Onda 14.51 — Gate financeiro: primeira parcela DEVE ter caido em conta.
        // PAGA = parcela 100% quitada; PARCIAL = parte do valor recebida (ainda
        // sinaliza dinheiro real entrou). ABERTA/ATRASADA/CANCELADA nao entram.
        installments: {
          some: { status: { in: ['PAGA', 'PARCIAL'] } },
        },
        // Plano ainda ativo (paciente nao cancelou tudo depois de pagar)
        treatment_plans: {
          some: { status: { in: ['ACTIVE', 'PENDING_SIGNATURE'] } },
        },
      },
      select: {
        id: true,
        name: true,
        phone: true,
        status: true,
        last_visit_at: true,
        primary_dentist: { select: { id: true, name: true } },
        treatment_plans: {
          where: { status: { in: ['ACTIVE', 'PENDING_SIGNATURE'] } },
          select: {
            id: true,
            status: true,
            total_value: true,
            items: {
              where: { status: { in: ['SCHEDULED', 'IN_PROGRESS'] } },
              select: {
                id: true,
                status: true,
                scheduled_at: true,
                executed_at: true,
                procedure: { select: { id: true, name: true, category: true } },
                scheduled_appointment: { select: { id: true, start_at: true } },
              },
            },
          },
        },
      },
      orderBy: { updated_at: 'desc' },
    });

    const enrichedPatients = patients.map((p) => {
      const activeItems = p.treatment_plans.flatMap((tp) => tp.items);

      // Dedupe procedures: paciente pode ter o mesmo procedimento em multiplos
      // items (ex: 4 facetas separadas). Aparece 1x na coluna mesmo assim.
      const procMap = new Map<string, { id: string; name: string; category: string | null }>();
      for (const it of activeItems) {
        if (!procMap.has(it.procedure.id)) procMap.set(it.procedure.id, it.procedure);
      }

      // Proximo agendamento (entre os scheduled_appointment.start_at). Ignora
      // items sem CalendarEvent vinculado.
      const upcomingDates = activeItems
        .map((it) => it.scheduled_appointment?.start_at)
        .filter((d): d is Date => d != null && d instanceof Date)
        .sort((a, b) => a.getTime() - b.getTime());

      // Soma total dos tratamentos ativos (pra exibir no card)
      const totalValue = p.treatment_plans.reduce(
        (acc, tp) => acc + Number(tp.total_value || 0),
        0,
      );

      return {
        id: p.id,
        name: p.name,
        phone: p.phone,
        status: p.status,
        last_visit_at: p.last_visit_at,
        primary_dentist: p.primary_dentist,
        treatment_plans_total_value: totalValue,
        funil: {
          aguardandoInicio: activeItems.length === 0,
          procedures: Array.from(procMap.values()),
          nextAppointment: upcomingDates[0] ?? null,
        },
      };
    });

    // Onda 14.52 — Retorno passa a ser objeto com `patients` e
    // `availableProcedures` (antes era array puro). Frontend usa
    // availableProcedures pra renderizar colunas mesmo quando nao ha
    // patients no funil — operador ve a estrutura sem precisar ter casos.
    return {
      patients: enrichedPatients,
      availableProcedures,
    };
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
  /**
   * Onda 17.32.62 — Baixa a foto do WhatsApp da URL do Evolution
   * (lead.profile_picture_url) e sobe pro nosso storage via updateAvatar.
   *
   * Best-effort, idempotente: chama via .catch() em convertFromLead. Caller
   * nao precisa esperar. Se o paciente ja tem avatar, sobrescreve com a
   * versao mais recente do WhatsApp.
   *
   * Falhas comuns silenciosas:
   *  - URL da Evolution expirou (TTL curto)
   *  - paciente sem foto no WhatsApp (404)
   *  - mimeType nao suportado (ALLOWED_AVATAR_MIMES)
   *  - imagem > 2 MB
   */
  async copyWhatsappAvatarToPatient(
    patientId: string,
    tenantId: string,
    waUrl: string,
  ): Promise<void> {
    // Timeout de 10s pra nao travar o pipeline de conversao
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);
    let resp: Response;
    try {
      resp = await fetch(waUrl, { signal: controller.signal });
    } finally {
      clearTimeout(timeout);
    }
    if (!resp.ok) {
      throw new Error(`Evolution CDN respondeu ${resp.status}`);
    }
    const contentType = resp.headers.get('content-type') || 'image/jpeg';
    const arrayBuf = await resp.arrayBuffer();
    const buffer = Buffer.from(arrayBuf);
    if (buffer.length === 0) {
      throw new Error('Imagem vazia');
    }
    await this.updateAvatar(patientId, tenantId, buffer, contentType);
    this.logger.log(`[AVATAR-WA] Foto WhatsApp copiada pro paciente ${patientId} (${buffer.length} bytes, ${contentType})`);
  }

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
  async getAvatarBuffer(patientId: string, tenantId: string): Promise<{ buffer: Buffer; mimeType: string } | null> {
    // Onda 17.34 — isolamento multi-tenant: foto e dado pessoal; sem o filtro
    // de tenant qualquer usuario autenticado enumerava ids e baixava fotos
    // de pacientes de outras clinicas.
    const patient = await this.prisma.patient.findUnique({
      where: { id: patientId },
      select: { avatar_url: true, tenant_id: true },
    });
    if (!patient || patient.tenant_id !== tenantId) return null;
    if (!patient.avatar_url) return null;

    const ext = patient.avatar_url.split('.').pop()?.toLowerCase() || 'jpg';
    const mimeMap: Record<string, string> = {
      jpg: 'image/jpeg',
      jpeg: 'image/jpeg',
      png: 'image/png',
      webp: 'image/webp',
    };
    const mimeType = mimeMap[ext] ?? 'image/jpeg';

    // Onda 15.5 — tryRead em vez de read pra nao crashar 500 quando o
    // arquivo nao existe no disco (paciente migrado, volume Docker recriado,
    // etc). Retorna null -> controller responde 404 -> front cai pro
    // fallback de iniciais sem mostrar imagem quebrada.
    const buffer = await this.fileStorage.tryRead(patient.avatar_url);
    if (!buffer) {
      this.logger.warn(
        `[AVATAR] Inconsistencia: paciente ${patientId} tem avatar_url=${patient.avatar_url} ` +
        `no DB mas arquivo nao existe no disco. Considere rodar limpeza manual.`
      );
      return null;
    }
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

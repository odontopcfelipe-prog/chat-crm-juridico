import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { Prisma } from '@crm/shared';
import {
  CreateReturnAlertDto,
  UpdateReturnAlertDto,
  ContactReturnAlertDto,
} from './dto/return-alert.dto';
import { getTenantSetting, setTenantSetting } from '../tenants/tenant-settings.helper';
import { ATTENDED_STATUSES } from '../leads/clinic-transfer-guard';
import {
  RECALL_FAMILIES,
  isFamilyProcedure,
  isFamilyText,
  latestPerPatient,
  pickFamilyHome,
  type FamilyEvidence,
  type FamilyProc,
  type RecallFamily,
} from './recall-families';

// Quem concluiu o item conta como DENTISTA: mesma definição de "profissional clínico" do
// findLawyers (DENTIST, OU ADMIN com especialidade). Item sem executor (null) não casa.
const EXECUTED_BY_DENTIST: Prisma.UserWhereInput = {
  OR: [
    { roles: { has: 'DENTIST' } },
    { roles: { has: 'ADMIN' }, specialties: { isEmpty: false } },
  ],
};
// Tipos de evento clínico (mesma lista do isClinicalEvent da agenda) — TAREFA "ligar pra
// marcar limpeza" concluída NÃO é limpeza feita.
const CLINICAL_EVENT_TYPES = ['CONSULTA', 'PROCEDIMENTO', 'RETORNO', 'ORTODONTIA'];

type Recall = {
  kind: 'procedure' | 'completion';
  type: string;
  patient: { id: string; name: string | null; phone: string | null; avatar_url: string | null };
  last_date: Date | null;
  return_date: Date;
  months: number;
  executed_by_name: string | null; // dentista que concluiu o procedimento (execução mais recente)
  source?: 'plano' | 'agenda'; // de onde veio a data (plano executado ou consulta comparecida)
};

@Injectable()
export class ReturnAlertsService {
  constructor(private prisma: PrismaService) {}

  async create(tenantId: string, userId: string | undefined, dto: CreateReturnAlertDto) {
    if (!tenantId) throw new BadRequestException('tenant_id ausente');

    const patient = await this.prisma.patient.findFirst({
      where: { id: dto.patient_id, tenant_id: tenantId },
      select: { id: true },
    });
    if (!patient) throw new NotFoundException('Paciente nao encontrado');

    return this.prisma.returnAlert.create({
      data: {
        tenant_id: tenantId,
        patient_id: dto.patient_id,
        professional_user_id: dto.professional_user_id || userId,
        source_appointment_id: dto.source_appointment_id,
        scheduled_for: new Date(dto.scheduled_for),
        reason: dto.reason,
        notes: dto.notes,
      },
    });
  }

  async findAll(
    tenantId: string,
    opts: {
      status?: string;
      professional_user_id?: string;
      patient_id?: string;
      from?: string;
      to?: string;
      page?: number;
      limit?: number;
    } = {},
  ) {
    const page = Math.max(1, opts.page || 1);
    const limit = Math.min(200, Math.max(1, opts.limit || 50));
    const skip = (page - 1) * limit;

    const where: Prisma.ReturnAlertWhereInput = {
      tenant_id: tenantId,
      ...(opts.status ? { status: opts.status } : {}),
      ...(opts.professional_user_id ? { professional_user_id: opts.professional_user_id } : {}),
      ...(opts.patient_id ? { patient_id: opts.patient_id } : {}),
      ...(opts.from || opts.to
        ? {
            scheduled_for: {
              ...(opts.from ? { gte: new Date(opts.from) } : {}),
              ...(opts.to ? { lte: new Date(opts.to) } : {}),
            },
          }
        : {}),
    };

    const [data, total] = await Promise.all([
      this.prisma.returnAlert.findMany({
        where,
        orderBy: { scheduled_for: 'asc' },
        skip,
        take: limit,
        include: {
          patient: { select: { id: true, name: true, phone: true, email: true } },
          professional: { select: { id: true, name: true } },
          source_appointment: { select: { id: true, title: true, start_at: true } },
          scheduled_appointment: { select: { id: true, start_at: true } },
        },
      }),
      this.prisma.returnAlert.count({ where }),
    ]);

    return { data, total, page, totalPages: Math.ceil(total / limit) };
  }

  /**
   * Lista alertas pendentes que ja venceram ou vencem hoje — visao
   * principal da recepcao para reagendar pacientes.
   */
  async findPendingNow(tenantId: string) {
    const endOfToday = new Date();
    endOfToday.setHours(23, 59, 59, 999);

    return this.prisma.returnAlert.findMany({
      where: {
        tenant_id: tenantId,
        status: 'PENDENTE',
        scheduled_for: { lte: endOfToday },
      },
      orderBy: { scheduled_for: 'asc' },
      take: 100,
      include: {
        patient: { select: { id: true, name: true, phone: true, email: true } },
        professional: { select: { id: true, name: true } },
      },
    });
  }

  /**
   * QUADRO DE MANUTENÇÃO — retorno de manutenção do sorriso POR ETAPA. OPT-IN: só geram
   * retorno os procedimentos ATIVADOS em Configurações → Retornos (default_revisit_months
   * >= 1); o retorno cai N meses após a execução (validada por um dentista), contando MESMO
   * no meio do tratamento. Também traz o retorno de "Tratamento Concluído". Calculado ao
   * vivo dos itens executados + tasks de conclusão (sem backfill) — ligar/desligar/mudar o
   * tempo reorganiza sozinho. O front agrupa em ABAS por tipo (nome do procedimento +
   * "Tratamento Concluído" + "RETORNO ATRASADO").
   *
   * Retorna { procedures, recalls }; 1 recall por (paciente, tipo) = execução mais RECENTE.
   */
  async getMaintenanceBoard(tenantId: string) {
    const recalls: Recall[] = [];
    // OPT-IN: só geram retorno os procedimentos que o admin ATIVOU em Configurações →
    // Retornos (default_revisit_months >= 1). Procedimento sem intervalo (null/0) NÃO gera
    // retorno — a maioria (biópsia, exodontia, raio-x, avaliação...) não precisa. Lido AO
    // VIVO, então ativar/desativar/mudar o tempo reorganiza o quadro no próximo load (sem
    // backfill). defaultMonths abaixo é só o rótulo do retorno pós-tratamento (Concluído).
    const defaultMonths = await this.getDefaultRecallMonths(tenantId);

    // FAMÍLIAS (limpeza, clareamento, faceta de resina, lentes): o catálogo costuma ter vários procedimentos do mesmo
    // tipo ("Limpeza", "Profilaxia (limpeza + raspagem)", "Clareamento caseiro", antigos
    // arquivados...). Cada família cai numa ÚNICA aba — a do procedimento dela com retorno
    // ligado (home) — junto com quem só tem a consulta comparecida na agenda. Família sem
    // nenhum procedimento ligado → nada muda (opt-in).
    const catalog = await this.prisma.procedure.findMany({
      where: { tenant_id: tenantId },
      select: { id: true, name: true, category: true, active: true, default_revisit_months: true },
    });
    const families = RECALL_FAMILIES.flatMap((fam) => {
      const procs = catalog.filter((p) => isFamilyProcedure(fam, p));
      const home = pickFamilyHome(fam, procs);
      return home ? [{ fam, home, ids: procs.map((p) => p.id) }] : [];
    });
    const familyIds = new Set(families.flatMap((f) => f.ids));
    const homeIds = new Set(families.map((f) => f.home.id));

    // 1) Por PROCEDIMENTO — só os ATIVADOS (default_revisit_months >= 1) geram retorno,
    // N meses após a execução; conta a partir da execução, mesmo no meio do tratamento.
    const items = await this.prisma.treatmentPlanItem.findMany({
      where: {
        status: 'DONE',
        executed_at: { not: null },
        treatment_plan: { patient: { tenant_id: tenantId } },
        // Só procedimento ATIVO gera retorno (consistente com a config, que lista só
        // ativos). Procedimento arquivado NÃO vira aba órfã no quadro — mesmo tendo
        // execuções antigas com retorno ligado.
        procedure: { active: true },
        // Só conta se quem CONCLUIU o item foi um DENTISTA (não recepção).
        executed_by: EXECUTED_BY_DENTIST,
      },
      select: {
        executed_at: true,
        procedure: { select: { id: true, name: true, default_revisit_months: true } },
        executed_by: { select: { name: true } },
        treatment_plan: { select: { patient: { select: { id: true, name: true, phone: true, avatar_url: true } } } },
      },
      orderBy: { executed_at: 'desc' },
      take: 5000,
    });
    const seen = new Set<string>(); // 1 por (paciente, procedimento) = execução mais recente
    for (const it of items) {
      const p = it.treatment_plan?.patient;
      const proc = it.procedure;
      if (!p?.id || !proc?.name || !it.executed_at) continue;
      if (familyIds.has(proc.id)) continue; // família (RECALL_FAMILIES) → bloco 1b
      // Opt-in: só gera retorno o procedimento com intervalo ATIVADO (>=1). Sem intervalo
      // (null/0) → não gera retorno (o admin escolhe quais precisam em Configurações → Retornos).
      const cfg = proc.default_revisit_months;
      if (cfg == null || cfg <= 0) continue;
      const key = `${p.id}|${proc.name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const ret = new Date(it.executed_at);
      ret.setMonth(ret.getMonth() + cfg);
      recalls.push({ kind: 'procedure', type: proc.name, patient: p, last_date: it.executed_at, return_date: ret, months: cfg, executed_by_name: it.executed_by?.name ?? null, source: 'plano' });
    }

    // 1b) FAMÍLIAS — todo paciente que fez o procedimento, numa aba só por família.
    for (const f of families) recalls.push(...(await this.familyRecalls(tenantId, f.fam, f.home, f.ids)));

    // 2) TRATAMENTO CONCLUÍDO — tasks de conclusão (marcador [plan:] no notes).
    const completions = await this.prisma.maintenanceTask.findMany({
      where: { tenant_id: tenantId, notes: { startsWith: '[plan:' } },
      select: { due_date: true, patient: { select: { id: true, name: true, phone: true, avatar_url: true } } },
      orderBy: { due_date: 'asc' },
      take: 5000,
    });
    const seenComp = new Set<string>();
    for (const t of completions) {
      if (!t.patient?.id || seenComp.has(t.patient.id)) continue;
      seenComp.add(t.patient.id);
      recalls.push({ kind: 'completion', type: 'Tratamento Concluído', patient: t.patient, last_date: null, return_date: t.due_date, months: defaultMonths, executed_by_name: null });
    }

    // Abas = os procedimentos SELECIONADOS (retorno ligado em Configurações → Retornos),
    // MESMO sem paciente ainda — o quadro EXPÕE o que foi configurado (associa a config às
    // abas). Une com os tipos que já têm recall (garantia). Uma aba de selecionado sem
    // paciente aparece vazia ("ninguém fez esse procedimento ainda").
    // Os outros procedimentos ligados de uma família não viram aba própria: estão na home.
    const selectedProcs = catalog.filter(
      (p) => p.active && (p.default_revisit_months ?? 0) >= 1 && (!familyIds.has(p.id) || homeIds.has(p.id)),
    );
    const procedureTabs = Array.from(
      new Set<string>([
        ...selectedProcs.map((s) => s.name),
        ...recalls.filter((r) => r.kind === 'procedure').map((r) => r.type),
      ]),
    ).sort((a, b) => a.localeCompare(b, 'pt-BR'));

    // Mais próximo/atrasado primeiro (return_date asc).
    recalls.sort((a, b) => a.return_date.getTime() - b.return_date.getTime());
    return { procedures: procedureTabs, recalls };
  }

  /**
   * Retornos de uma FAMÍLIA (limpeza, clareamento, faceta...) na aba da home, com a próxima vinda
   * calculada da execução MAIS RECENTE + N meses da home. Duas evidências:
   *   - item de plano DONE de QUALQUER procedimento da família (ativo ou arquivado), mesma
   *     regra de concluído por DENTISTA;
   *   - consulta clínica na agenda (título/tipo de consulta com o termo da família, ou
   *     vinculada a um item da família) em que o paciente COMPARECEU.
   */
  private async familyRecalls(tenantId: string, fam: RecallFamily, home: FamilyProc, ids: string[]): Promise<Recall[]> {
    const months = home.default_revisit_months as number;
    const [famItems, famEvents] = await Promise.all([
      this.prisma.treatmentPlanItem.findMany({
        where: {
          status: 'DONE',
          executed_at: { not: null },
          procedure_id: { in: ids },
          treatment_plan: { patient: { tenant_id: tenantId } },
          executed_by: EXECUTED_BY_DENTIST,
        },
        select: {
          executed_at: true,
          executed_by: { select: { name: true } },
          treatment_plan: { select: { patient_id: true } },
        },
        orderBy: { executed_at: 'desc' },
        take: 5000,
      }),
      this.prisma.calendarEvent.findMany({
        where: {
          tenant_id: tenantId,
          type: { in: CLINICAL_EVENT_TYPES },
          status: { in: ATTENDED_STATUSES },
          OR: [
            ...fam.agendaTerms.flatMap((t): Prisma.CalendarEventWhereInput[] => [
              { title: { contains: t, mode: 'insensitive' } },
              { appointment_type: { name: { contains: t, mode: 'insensitive' } } },
            ]),
            { treatment_plan_items: { some: { procedure_id: { in: ids } } } },
          ],
        },
        select: {
          start_at: true,
          title: true,
          patient_id: true,
          lead_id: true,
          appointment_type: { select: { name: true } },
          assigned_user: { select: { name: true } },
          treatment_plan_items: { where: { procedure_id: { in: ids } }, select: { id: true }, take: 1 },
        },
        orderBy: { start_at: 'desc' },
        take: 5000,
      }),
    ]);

    const evidences: FamilyEvidence[] = [];
    for (const it of famItems) {
      if (!it.executed_at || !it.treatment_plan?.patient_id) continue;
      evidences.push({ patient_id: it.treatment_plan.patient_id, date: it.executed_at, by_name: it.executed_by?.name ?? null, source: 'plano' });
    }
    // O ILIKE do banco também pega "limpeza de pele"/"clareamento de pele" — o filtro fino é aqui.
    const evs = famEvents.filter(
      (e) => e.treatment_plan_items.length > 0 || isFamilyText(fam, e.title) || isFamilyText(fam, e.appointment_type?.name),
    );
    // Consulta só com lead (sem patient_id): acha o paciente pelo Patient.lead_id.
    const leadIds = Array.from(new Set(evs.filter((e) => !e.patient_id && e.lead_id).map((e) => e.lead_id as string)));
    const leadToPatient = new Map<string, string>();
    if (leadIds.length) {
      const ps = await this.prisma.patient.findMany({
        where: { tenant_id: tenantId, lead_id: { in: leadIds } },
        select: { id: true, lead_id: true },
      });
      for (const p of ps) if (p.lead_id) leadToPatient.set(p.lead_id, p.id);
    }
    for (const e of evs) {
      const pid = e.patient_id || (e.lead_id ? leadToPatient.get(e.lead_id) : undefined);
      if (!pid) continue;
      evidences.push({ patient_id: pid, date: e.start_at, by_name: e.assigned_user?.name ?? null, source: 'agenda' });
    }

    const latest = latestPerPatient(evidences, months);
    const pats = latest.length
      ? await this.prisma.patient.findMany({
          where: { tenant_id: tenantId, id: { in: latest.map((l) => l.patient_id) } },
          select: { id: true, name: true, phone: true, avatar_url: true },
        })
      : [];
    const byId = new Map(pats.map((p) => [p.id, p]));
    const out: Recall[] = [];
    for (const l of latest) {
      const p = byId.get(l.patient_id);
      if (!p) continue; // paciente de outro tenant/apagado — nunca entra
      out.push({ kind: 'procedure', type: home.name, patient: p, last_date: l.date, return_date: l.return_date, months, executed_by_name: l.by_name, source: l.source });
    }
    return out;
  }

  // ─── Config dos Retornos (Configurações → Retornos) ────────────────────────

  /** Padrão da clínica em MESES — fallback quando o procedimento não tem intervalo próprio. */
  private async getDefaultRecallMonths(tenantId: string): Promise<number> {
    const raw = await getTenantSetting(this.prisma, 'RECALL_DEFAULT_MONTHS', tenantId, undefined);
    const n = raw != null ? parseInt(raw, 10) : 6;
    return Number.isFinite(n) && n > 0 ? n : 6;
  }

  /**
   * Config da tela de Retornos: o padrão da clínica + o catálogo de procedimentos ativos
   * com o intervalo de cada um. O front edita o intervalo por procedimento (PATCH /procedures/:id)
   * e o padrão (PATCH /return-alerts/config); o quadro reorganiza sozinho no próximo load.
   */
  async getRecallConfig(tenantId: string) {
    if (!tenantId) throw new BadRequestException('tenant_id ausente');
    const [defaultMonths, procedures] = await Promise.all([
      this.getDefaultRecallMonths(tenantId),
      this.prisma.procedure.findMany({
        where: { tenant_id: tenantId, active: true },
        select: {
          id: true,
          name: true,
          default_revisit_months: true,
          specialty: { select: { id: true, name: true } },
        },
        orderBy: [{ specialty_id: 'asc' }, { name: 'asc' }],
      }),
    ]);
    return { default_months: defaultMonths, procedures };
  }

  /** Ajusta o padrão da clínica (meses). 0/ inválido cai em 6; teto 120 meses. */
  async setRecallConfig(tenantId: string, months: number) {
    if (!tenantId) throw new BadRequestException('tenant_id ausente');
    const clean = Number.isFinite(months) && months > 0 ? Math.min(120, Math.floor(months)) : 6;
    await setTenantSetting(this.prisma, tenantId, 'RECALL_DEFAULT_MONTHS', String(clean));
    return { default_months: clean };
  }

  async findOne(tenantId: string, id: string) {
    const alert = await this.prisma.returnAlert.findFirst({
      where: { id, tenant_id: tenantId },
      include: {
        patient: true,
        professional: { select: { id: true, name: true, email: true } },
        source_appointment: true,
        scheduled_appointment: true,
        contacted_by: { select: { id: true, name: true } },
      },
    });
    if (!alert) throw new NotFoundException('Alerta nao encontrado');
    return alert;
  }

  async update(tenantId: string, id: string, dto: UpdateReturnAlertDto) {
    await this.findOne(tenantId, id);
    return this.prisma.returnAlert.update({
      where: { id },
      data: {
        scheduled_for: dto.scheduled_for ? new Date(dto.scheduled_for) : undefined,
        reason: dto.reason,
        notes: dto.notes,
        status: dto.status,
        scheduled_appointment_id: dto.scheduled_appointment_id,
      },
    });
  }

  /**
   * Marca alerta como CONTATADO (ou AGENDADO/REJEITADO conforme result).
   * Usado pela recepcao apos ligar/whatsapp para o paciente.
   */
  async contact(tenantId: string, id: string, userId: string, dto: ContactReturnAlertDto) {
    await this.findOne(tenantId, id);
    return this.prisma.returnAlert.update({
      where: { id },
      data: {
        status: dto.result || 'CONTATADO',
        contacted_at: new Date(),
        contacted_by_user_id: userId,
        scheduled_appointment_id: dto.scheduled_appointment_id,
        notes: dto.notes,
      },
    });
  }
}

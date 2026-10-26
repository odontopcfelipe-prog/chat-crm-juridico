import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import {
  DEFAULT_RETORNO_TEMPLATES,
  RETORNO_DISPARO_IDS,
  RETORNO_FAMILIAS,
  RETORNO_FAMILIA_TEXTO,
  RETORNO_HORA_FIM,
  RETORNO_HORA_INICIO,
  RETORNO_INTERVALO_PACIENTE_DIAS,
  RETORNO_TETO_DIA,
  chipPacienteOuLegado,
  dataBr,
  diasRestantesNaJanela,
  escolherChipPaciente,
  findClinicHoliday,
  getLabTenantIds,
  isRetornoDisparoId,
  renderRetornoTemplate,
  retornoDisparoId,
  retornoEtapaDoDia,
  retornoTemplateKey,
  retornoToggleKey,
  soTemChipFinanceiro,
  tempoDesde,
  type RetornoDisparoId,
  type RetornoEtapa,
  type RetornoFamilia,
} from '@crm/shared';
import { PrismaService } from '../prisma/prisma.service';
import { WhatsappService } from '../whatsapp/whatsapp.service';
import { ReturnAlertsService } from './return-alerts.service';
import { wasSent, numeroSemWhatsapp, chipForaDoAr } from '../whatsapp/envio-resultado';
import { enviarAnexosDoDisparo } from '../disparo-anexos/disparo-anexos-envio';

const LOG = '[RETORNO-DISPARO]';
const MACEIO_OFFSET_MS = 3 * 3600e3;
const BOARD_TTL_MS = 10 * 60_000;
const PACE_MIN_MS = 3 * 60_000;
const PACE_MAX_MS = 7 * 60_000;
const PAUSA_CHIP_CAIDO_MS = 30 * 60_000;
const TENTATIVAS_POR_TICK = 5;
/** Consulta que segura o disparo: qualquer atendimento clínico ainda por vir. */
const CLINICAL_EVENT_TYPES = ['CONSULTA', 'PROCEDIMENTO', 'RETORNO', 'ORTODONTIA'];
const EVENTO_NAO_CONTA = ['CANCELADO', 'NO_SHOW', 'ADIADO', 'CONCLUIDO'];
/** Marca (exactly-once por toque) no AuditLog: entity_id = paciente:família:data prevista; action = etapa. */
const AUDIT_ENTITY = 'RETORNO_DISPARO';

type BoardRecall = {
  kind: string;
  family?: string;
  patient: { id: string; name: string | null };
  last_date: Date | null;
  return_date: Date;
};

export type RetornoCandidato = {
  id: RetornoDisparoId;
  familia: RetornoFamilia;
  etapa: RetornoEtapa;
  patientId: string;
  ultima: Date;
  prevista: Date;
  chave: string;
  diasRestantes: number;
};

type Situacao = 'na_fila' | 'agendado' | 'sem_telefone' | 'nao_recebe' | 'recente' | 'ja_recebeu';

const isFamilia = (k: string | undefined): k is RetornoFamilia => !!k && (RETORNO_FAMILIAS as readonly string[]).includes(k);
const diaIso = (d: Date) => d.toISOString().slice(0, 10);

/**
 * Disparos de RETORNO DE MANUTENÇÃO (Central de Disparos › Retorno de manutenção).
 *
 * Roda na API (1 réplica) porque as datas vêm do quadro Retornos (getMaintenanceBoard —
 * mesma regra que a tela mostra: plano executado + consulta comparecida, execução mais
 * recente + meses do procedimento) e o envio usa o WhatsappService (resolve o 9º dígito).
 *
 * A cada minuto, seg–sáb 9:00–17:59 (Maceió), por clínica com algum toque ligado:
 *   - dia fechado (feriado) não envia; teto de RETORNO_TETO_DIA envios/dia;
 *   - só o chip da CLÍNICA (na falta, o Comercial — nunca o Financeiro);
 *   - marca-passo POR CHIP no banco (WhatsappChipPacer, o mesmo da régua): 3–7 min entre
 *     envios no mesmo chip, reservado de forma atômica;
 *   - 1 toque por (paciente, tipo, data prevista, etapa) — marca no AuditLog;
 *   - suspende quem tem consulta marcada; pula quem pediu pra não receber, sem telefone,
 *     arquivado, ou que recebeu aviso de retorno/recall nos últimos dias.
 */
@Injectable()
export class RetornoDisparosService {
  private readonly logger = new Logger(RetornoDisparosService.name);
  private busy = false;
  private boardCache = new Map<string, { at: number; recalls: BoardRecall[] }>();
  private avisado = new Map<string, string>();

  constructor(
    private prisma: PrismaService,
    private returnAlerts: ReturnAlertsService,
    private whatsapp: WhatsappService,
  ) {}

  @Cron('*/1 9-17 * * 1-6', { timeZone: 'America/Maceio' })
  async tick() {
    if (this.busy) return;
    this.busy = true;
    try {
      await this.rodar(new Date());
    } catch (e: any) {
      this.logger.warn(`${LOG} tick falhou: ${e?.message}`);
    } finally {
      this.busy = false;
    }
  }

  /** Clínicas → toques ligados (só 'true' liga). */
  async ligadosPorClinica(): Promise<Map<string, Set<RetornoDisparoId>>> {
    const rows = await this.prisma.globalSetting
      .findMany({ where: { key: { startsWith: 'RETORNO_' }, value: 'true' }, select: { key: true } })
      .catch(() => [] as { key: string }[]);
    const out = new Map<string, Set<RetornoDisparoId>>();
    for (const { key } of rows) {
      for (const id of RETORNO_DISPARO_IDS) {
        const prefixo = retornoToggleKey(id, '');
        if (!key.startsWith(prefixo)) continue;
        const tenantId = key.slice(prefixo.length);
        if (!tenantId) continue;
        if (!out.has(tenantId)) out.set(tenantId, new Set());
        out.get(tenantId)!.add(id);
      }
    }
    return out;
  }

  async rodar(agora: Date): Promise<void> {
    const local = new Date(agora.getTime() - MACEIO_OFFSET_MS);
    const hora = local.getUTCHours();
    if (hora < RETORNO_HORA_INICIO || hora >= RETORNO_HORA_FIM) return;
    const ligados = await this.ligadosPorClinica();
    // F2 [LAB-GATE] — retorno de manutenção é texto de clínica (procedimento, revisão):
    // conta de laboratório não dispara, mesmo com o toque ligado. Clínica: sem
    // laboratório o conjunto é vazio e o laço é o mesmo de antes.
    const labs = await getLabTenantIds(this.prisma, (m) => this.logger.warn(m));
    for (const [tenantId, ids] of ligados) {
      if (labs.has(tenantId)) {
        this.avisarUmaVez(`lab:${tenantId}`, diaIso(local), `[LAB-GATE] retorno-disparos — conta ${tenantId} é laboratório: não dispara`);
        continue;
      }
      try {
        await this.processarClinica(tenantId, ids, agora);
      } catch (e: any) {
        this.logger.warn(`${LOG} clínica ${tenantId}: ${e?.message}`);
      }
    }
  }

  private avisarUmaVez(chave: string, dia: string, msg: string) {
    if (this.avisado.get(chave) === dia) return;
    this.avisado.set(chave, dia);
    this.logger.warn(msg);
  }

  /** Recalls do quadro (cache de 10 min por clínica — o quadro é pesado e muda pouco). */
  private async board(tenantId: string, agora: Date): Promise<BoardRecall[]> {
    const c = this.boardCache.get(tenantId);
    if (c && agora.getTime() - c.at < BOARD_TTL_MS) return c.recalls;
    const b = await this.returnAlerts.getMaintenanceBoard(tenantId);
    const recalls = (b.recalls || []) as unknown as BoardRecall[];
    this.boardCache.set(tenantId, { at: agora.getTime(), recalls });
    return recalls;
  }

  /** Início do dia de Maceió, como instante real (UTC). */
  private inicioDiaMaceio(agora: Date): Date {
    const local = new Date(agora.getTime() - MACEIO_OFFSET_MS);
    return new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate()) + MACEIO_OFFSET_MS);
  }

  /**
   * Quem está na janela de algum toque LIGADO hoje e ainda não recebeu esse toque, com a
   * situação de cada um (só 'na_fila' sai). Ordem: quem perde a janela primeiro.
   */
  async avaliar(
    tenantId: string,
    ligados: Set<RetornoDisparoId>,
    agora: Date,
  ): Promise<Array<RetornoCandidato & { situacao: Situacao; nome: string | null; telefone: string | null }>> {
    const hoje = new Date(agora.getTime() - MACEIO_OFFSET_MS);
    const recalls = await this.board(tenantId, agora);
    const cands: RetornoCandidato[] = [];
    for (const r of recalls) {
      if (r.kind !== 'procedure' || !isFamilia(r.family) || !r.last_date || !r.patient?.id) continue;
      const prevista = new Date(r.return_date);
      const etapa = retornoEtapaDoDia(prevista, hoje);
      if (!etapa) continue;
      const id = retornoDisparoId(r.family, etapa);
      if (!ligados.has(id)) continue;
      cands.push({
        id,
        familia: r.family,
        etapa,
        patientId: r.patient.id,
        ultima: new Date(r.last_date),
        prevista,
        chave: `${r.patient.id}:${r.family}:${diaIso(prevista)}`,
        diasRestantes: diasRestantesNaJanela(prevista, hoje, etapa),
      });
    }
    if (!cands.length) return [];

    const pids = Array.from(new Set(cands.map((c) => c.patientId)));
    const desde = new Date(agora.getTime() - RETORNO_INTERVALO_PACIENTE_DIAS * 864e5);
    const [marcas, pacientes, recentes] = await Promise.all([
      this.prisma.auditLog.findMany({
        where: { entity: AUDIT_ENTITY, tenant_id: tenantId, entity_id: { in: cands.map((c) => c.chave) } },
        select: { entity_id: true, action: true },
      }),
      this.prisma.patient.findMany({
        where: { tenant_id: tenantId, id: { in: pids } },
        select: { id: true, name: true, phone: true, status: true, lead_id: true, lead: { select: { contact_opt_out_at: true } } },
      }),
      this.prisma.dispatchLog.findMany({
        where: {
          tenant_id: tenantId,
          ref_patient_id: { in: pids },
          sent_at: { gte: desde },
          // retorno, recall e campanha manual: o paciente não recebe 2 avisos em poucos dias
          OR: [{ type: { startsWith: 'retorno_' } }, { type: { in: ['recall_preventivo', 'campanha_manual'] } }],
        },
        select: { ref_patient_id: true },
      }),
    ]);
    const jaFoi = new Set(marcas.map((m) => `${m.entity_id}|${m.action}`));
    const pac = new Map(pacientes.map((p) => [p.id, p]));
    const recente = new Set(recentes.map((r) => r.ref_patient_id));

    // Consulta marcada (paciente OU o contato dele) = suspenso: o agendamento tem os avisos dele.
    const leadIds = pacientes.map((p) => p.lead_id).filter((x): x is string => !!x);
    const futuras = await this.prisma.calendarEvent.findMany({
      where: {
        tenant_id: tenantId,
        type: { in: CLINICAL_EVENT_TYPES },
        status: { notIn: EVENTO_NAO_CONTA },
        start_at: { gte: hoje }, // naive Maceió
        OR: [{ patient_id: { in: pids } }, ...(leadIds.length ? [{ lead_id: { in: leadIds } }] : [])],
      },
      select: { patient_id: true, lead_id: true },
    });
    const agendado = new Set<string>();
    const leadDoPaciente = new Map(pacientes.filter((p) => p.lead_id).map((p) => [p.lead_id as string, p.id]));
    for (const e of futuras) {
      if (e.patient_id) agendado.add(e.patient_id);
      if (e.lead_id && leadDoPaciente.has(e.lead_id)) agendado.add(leadDoPaciente.get(e.lead_id)!);
    }

    const out = cands.map((c) => {
      const p = pac.get(c.patientId);
      let situacao: Situacao = 'na_fila';
      if (jaFoi.has(`${c.chave}|${c.etapa}`)) situacao = 'ja_recebeu';
      else if (!p || p.status === 'ARCHIVED' || p.lead?.contact_opt_out_at) situacao = 'nao_recebe';
      else if (!p.phone?.replace(/\D/g, '')) situacao = 'sem_telefone';
      else if (agendado.has(c.patientId)) situacao = 'agendado';
      else if (recente.has(c.patientId)) situacao = 'recente';
      return { ...c, situacao, nome: p?.name ?? null, telefone: p?.phone ?? null };
    });
    out.sort((a, b) => a.diasRestantes - b.diasRestantes || a.prevista.getTime() - b.prevista.getTime());
    return out;
  }

  private async processarClinica(tenantId: string, ligados: Set<RetornoDisparoId>, agora: Date): Promise<void> {
    const local = new Date(agora.getTime() - MACEIO_OFFSET_MS);
    const dia = diaIso(local);

    try {
      const feriado = await findClinicHoliday(this.prisma, local, tenantId);
      if (feriado) return this.avisarUmaVez(`feriado:${tenantId}`, dia, `${LOG} clínica ${tenantId}: feriado (${feriado.name}) — não envia hoje`);
    } catch (e: any) {
      return this.avisarUmaVez(`feriado-erro:${tenantId}`, dia, `${LOG} clínica ${tenantId}: não conferiu feriado (${e?.message}) — não envia`);
    }

    const enviadosHoje = await this.prisma.dispatchLog.count({
      where: { tenant_id: tenantId, type: { startsWith: 'retorno_' }, sent_at: { gte: this.inicioDiaMaceio(agora) } },
    });
    if (enviadosHoje >= RETORNO_TETO_DIA) {
      return this.avisarUmaVez(`teto:${tenantId}`, dia, `${LOG} clínica ${tenantId}: teto do dia (${enviadosHoje}/${RETORNO_TETO_DIA})`);
    }

    const chips = await this.prisma.instance.findMany({
      where: { type: 'whatsapp', tenant_id: tenantId },
      orderBy: { created_at: 'asc' },
      select: { name: true, purpose: true },
    });
    const escolha = escolherChipPaciente(chips, 'CLINICA');
    const chip = chipPacienteOuLegado(escolha);
    if (!chip) {
      const motivo = soTemChipFinanceiro(escolha) ? 'só tem chip Financeiro' : 'sem chip de WhatsApp';
      return this.avisarUmaVez(`chip:${tenantId}`, dia, `${LOG} clínica ${tenantId}: ${motivo} — retorno não envia`);
    }

    const fila = (await this.avaliar(tenantId, ligados, agora)).filter((c) => c.situacao === 'na_fila');
    if (!fila.length) return;

    // Vez do chip (atômico, o mesmo marca-passo da régua): só quem move next_allowed_at envia.
    await this.prisma.whatsappChipPacer.createMany({
      data: [{ instance_name: chip, next_allowed_at: new Date(0) }],
      skipDuplicates: true,
    });
    const vez = await this.prisma.whatsappChipPacer.updateMany({
      where: { instance_name: chip, next_allowed_at: { lte: agora } },
      data: { next_allowed_at: new Date(agora.getTime() + PACE_MIN_MS + Math.random() * (PACE_MAX_MS - PACE_MIN_MS)) },
    });
    if (vez.count === 0) return;

    let desfecho: 'enviado' | 'falhou' | 'chip_caido' | 'pulado' = 'pulado';
    try {
      for (const c of fila.slice(0, TENTATIVAS_POR_TICK)) {
        desfecho = await this.enviar(tenantId, c, chip, agora);
        if (desfecho !== 'pulado') break;
      }
    } finally {
      if (desfecho === 'pulado') {
        await this.prisma.whatsappChipPacer
          .updateMany({ where: { instance_name: chip }, data: { next_allowed_at: agora } })
          .catch(() => undefined);
      } else if (desfecho === 'chip_caido') {
        await this.prisma.whatsappChipPacer
          .updateMany({ where: { instance_name: chip }, data: { next_allowed_at: new Date(agora.getTime() + PAUSA_CHIP_CAIDO_MS) } })
          .catch(() => undefined);
        this.logger.warn(`${LOG} clínica ${tenantId}: chip ${chip} fora do ar — retorno pausado 30 min`);
      }
    }
  }

  /** Texto do toque: o da clínica (TenantSetting) ou o padrão. */
  async templateDe(tenantId: string, id: RetornoDisparoId): Promise<string> {
    const ts = await this.prisma.tenantSetting
      .findUnique({ where: { tenant_id_key: { tenant_id: tenantId, key: retornoTemplateKey(id) } } })
      .catch(() => null);
    return ts?.value?.trim() ? ts.value : DEFAULT_RETORNO_TEMPLATES[id];
  }

  private async enviar(
    tenantId: string,
    c: RetornoCandidato,
    chip: string,
    agora: Date,
  ): Promise<'enviado' | 'falhou' | 'chip_caido' | 'pulado'> {
    // Reconfere ao vivo o que pode ter mudado desde a avaliação (cache do quadro).
    const p = await this.prisma.patient.findFirst({
      where: { id: c.patientId, tenant_id: tenantId },
      select: { id: true, name: true, phone: true, status: true, lead_id: true, lead: { select: { contact_opt_out_at: true } } },
    });
    if (!p?.phone || p.status === 'ARCHIVED' || p.lead?.contact_opt_out_at) return 'pulado';
    const hoje = new Date(agora.getTime() - MACEIO_OFFSET_MS);
    const futura = await this.prisma.calendarEvent.count({
      where: {
        tenant_id: tenantId,
        type: { in: CLINICAL_EVENT_TYPES },
        status: { notIn: EVENTO_NAO_CONTA },
        start_at: { gte: hoje },
        OR: [{ patient_id: p.id }, ...(p.lead_id ? [{ lead_id: p.lead_id }] : [])],
      },
    });
    if (futura) return 'pulado';
    const ja = await this.prisma.auditLog.count({
      where: { entity: AUDIT_ENTITY, tenant_id: tenantId, entity_id: c.chave, action: c.etapa },
    });
    if (ja) return 'pulado';

    // Marca ANTES de enviar (nunca 2×). Se o chip estiver fora do ar, a marca é desfeita.
    const marca = await this.prisma.auditLog.create({
      data: {
        entity: AUDIT_ENTITY,
        entity_id: c.chave,
        action: c.etapa,
        tenant_id: tenantId,
        meta_json: { disparo: c.id, prevista: diaIso(c.prevista), ultima: diaIso(c.ultima) } as any,
      },
    });

    const tenant = await this.prisma.tenant.findUnique({ where: { id: tenantId }, select: { name: true } }).catch(() => null);
    const texto = renderRetornoTemplate(await this.templateDe(tenantId, c.id), {
      nome: (p.name || '').trim().split(/\s+/)[0] || '',
      tempo: tempoDesde(c.ultima, hoje),
      data_ultima: dataBr(c.ultima),
      data_prevista: dataBr(c.prevista),
      procedimento: RETORNO_FAMILIA_TEXTO[c.familia],
      clinica: tenant?.name || 'a clínica',
    });

    let res: any;
    try {
      res = await this.whatsapp.sendText(p.phone, texto, chip, undefined, tenantId);
    } catch (e: any) {
      res = { error: e?.message || 'erro', statusCode: e?.response?.status };
    }
    const ok = wasSent(res);
    const semWhatsapp = !ok && numeroSemWhatsapp(res);
    const chipCaido = !ok && !semWhatsapp && chipForaDoAr(res);

    if (chipCaido) {
      await this.prisma.auditLog.delete({ where: { id: marca.id } }).catch(() => undefined);
      return 'chip_caido';
    }
    // Anexos do card (fotos/áudio) depois do texto que saiu; nunca lança.
    if (ok) await enviarAnexosDoDisparo(this.prisma, this.whatsapp, { tenantId, disparoId: c.id, phone: p.phone, instance: chip });
    await this.prisma.dispatchLog
      .create({
        data: {
          tenant_id: tenantId,
          type: c.id,
          channel: 'WHATSAPP',
          recipient_name: p.name,
          recipient_phone: p.phone,
          status: ok ? 'SENT' : 'FAILED',
          error: ok ? null : semWhatsapp ? 'número sem WhatsApp' : String(res?.error || res?.message || 'Evolution recusou o envio').slice(0, 300),
          external_message_id: ok ? res?.key?.id || res?.messageId || null : null,
          ref_patient_id: p.id,
          sent_at: new Date(),
        },
      })
      .catch((e: any) => this.logger.warn(`${LOG} DispatchLog não registrou: ${e?.message}`));
    this.logger.log(`${LOG} ${c.id} → paciente ${p.id} (${ok ? 'enviado' : 'falhou'})`);
    return ok ? 'enviado' : 'falhou';
  }

  // ─── Central de Disparos: texto e "quem vai receber" ────────────────────────

  async getTemplate(tenantId: string, id: string) {
    if (!isRetornoDisparoId(id)) throw new BadRequestException('disparo de retorno inválido');
    return { template: await this.templateDe(tenantId, id), default: DEFAULT_RETORNO_TEMPLATES[id] };
  }

  /** Vazio = volta ao padrão. */
  async setTemplate(tenantId: string, id: string, template?: string) {
    if (!isRetornoDisparoId(id)) throw new BadRequestException('disparo de retorno inválido');
    const key = retornoTemplateKey(id);
    const value = (template || '').trim();
    if (!value) {
      await this.prisma.tenantSetting.deleteMany({ where: { tenant_id: tenantId, key } });
      return { template: DEFAULT_RETORNO_TEMPLATES[id] };
    }
    if (value.length > 1500) throw new BadRequestException('Mensagem muito longa (máx. 1500 caracteres)');
    await this.prisma.tenantSetting.upsert({
      where: { tenant_id_key: { tenant_id: tenantId, key } },
      create: { tenant_id: tenantId, key, value },
      update: { value },
    });
    return { template: value };
  }

  /**
   * Quem está na janela deste toque HOJE (como se ele estivesse ligado) e a situação de
   * cada um — pra clínica ver antes de ligar.
   */
  async previstos(tenantId: string, id: string) {
    if (!isRetornoDisparoId(id)) throw new BadRequestException('disparo de retorno inválido');
    const lista = await this.avaliar(tenantId, new Set([id]), new Date());
    return lista.map((c) => ({
      nome: c.nome,
      telefone: c.telefone,
      data_ultima: diaIso(c.ultima),
      data_prevista: diaIso(c.prevista),
      situacao: c.situacao,
    }));
  }
}

// Classificação da resposta da Evolution: fonte única em whatsapp/envio-resultado (campanha usa também).
export { wasSent, numeroSemWhatsapp, chipForaDoAr } from '../whatsapp/envio-resultado';

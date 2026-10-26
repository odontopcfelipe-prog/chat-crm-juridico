import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { SettingsService } from '../settings/settings.service';
import {
  toBrazilWhatsappNumber,
  escolherChipPaciente,
  chipPacienteOuLegado,
  soTemChipFinanceiro,
  contaLegada,
  contaDaChavePostCare,
  POST_CARE_CONFIG_KEY,
  POST_CARE_CONFIG_PREFIX,
} from '@crm/shared';
import axios from 'axios';

interface PostCareConfig {
  enabled: boolean;
  delay_hours: number;
  initial_choice: 'descontraido' | 'formal' | 'breve' | 'custom';
  initial_custom: string;
  thanks_text: string;
  apology_text: string;
  send_thanks_on_positive: boolean;
  send_apology_on_negative: boolean;
}

const DEFAULT_TEMPLATES = {
  descontraido:
    'Olá {patient_name}! Passando aqui pra perguntar o que achou do atendimento com {dentist_name} referente ao procedimento de {procedure}. O que você achou? 😊',
  formal:
    'Olá, {patient_name}. Esperamos que esteja bem. Gostaríamos de saber sua opinião sobre o atendimento realizado por {dentist_name} referente ao procedimento de {procedure}. Como foi sua experiência?',
  breve:
    'Oi {patient_name}! Como foi seu atendimento com {dentist_name} hoje? Manda um feedback rapidinho 💛',
};

const DEFAULT_CONFIG: PostCareConfig = {
  enabled: true,
  delay_hours: 2,
  initial_choice: 'descontraido',
  initial_custom: DEFAULT_TEMPLATES.descontraido,
  thanks_text:
    'Que bom que gostou, {patient_name}! 💛 Seu feedback nos ajuda muito. Se quiser nos ajudar ainda mais, deixa uma avaliação no Google!',
  apology_text:
    'Sentimos muito que sua experiência não tenha sido a esperada, {patient_name}. Nossa equipe vai entrar em contato com você em breve pra entender e resolver. Obrigada pelo retorno!',
  send_thanks_on_positive: true,
  send_apology_on_negative: true,
};

/** Config de cada conta num tick + filtro das contas ligadas para as consultas. */
interface PlanoPostCare {
  cfgFor(tenantId: string): Promise<PostCareConfig>;
  filtroConta: Record<string, unknown>;
}

@Injectable()
export class PostCareCronService implements OnModuleInit {
  private readonly logger = new Logger(PostCareCronService.name);

  constructor(
    private prisma: PrismaService,
    private settings: SettingsService,
  ) {}

  onModuleInit() {
    this.logger.log('[PostCare] Cron service iniciado (scan + dispatch a cada 10 min)');
  }

  @Cron('*/10 * * * *', { timeZone: 'America/Maceio' })
  async tick() {
    try {
      // Config POR CONTA (POST_CARE_CONFIG_<tenantId>); conta legada sem a própria
      // herda a global antiga; conta nova sem a própria fica no padrão.
      const plano = await this.montarPlano();
      if (!plano) return;

      const created = await this.scanCompletedAppointments(plano);
      const sent = await this.dispatchPendingSurveys(plano);
      if (created || sent) {
        this.logger.log(`[PostCare] Tick: ${created} criada(s), ${sent} enviada(s)`);
      }
    } catch (err: any) {
      this.logger.error(`[PostCare] Erro no tick: ${err.message}`);
    }
  }

  /**
   * Config de cada conta neste tick + o filtro de contas ligadas para as consultas
   * (uma conta desligada não pode "entupir" o take das outras). null = nenhuma
   * conta ligada (o mesmo "não faz nada" de quando a global estava desligada).
   */
  private async montarPlano(): Promise<PlanoPostCare | null> {
    const legada = await this.getConfig();
    const linhas: Array<{ key: string; value: string | null }> =
      (await this.prisma.globalSetting.findMany({
        where: { key: { startsWith: POST_CARE_CONFIG_PREFIX } },
        select: { key: true, value: true },
      })) ?? [];
    const proprias = new Map<string, PostCareConfig>();
    for (const l of linhas) {
      const t = contaDaChavePostCare(l.key);
      if (t) proprias.set(t, this.parseConfig(l.value));
    }

    const cache = new Map<string, PostCareConfig>();
    const cfgFor = async (tenantId: string): Promise<PostCareConfig> => {
      const pronta = proprias.get(tenantId) ?? cache.get(tenantId);
      if (pronta) return pronta;
      const legadaDaConta = await contaLegada(this.prisma, tenantId, (m) => this.logger.warn(m));
      const cfg = legadaDaConta ? legada : { ...DEFAULT_CONFIG };
      cache.set(tenantId, cfg);
      return cfg;
    };

    if (legada.enabled && DEFAULT_CONFIG.enabled) {
      // Quem não tem a própria está ligado (legada herda a global ligada; nova, o padrão).
      const desligadas = [...proprias].filter(([, c]) => !c.enabled).map(([t]) => t);
      return { cfgFor, filtroConta: desligadas.length ? { tenant_id: { notIn: desligadas } } : {} };
    }

    // Global antiga desligada: só as contas com a própria ligada e as contas novas
    // sem a própria (padrão) entram.
    const ligadas = new Set([...proprias].filter(([, c]) => c.enabled).map(([t]) => t));
    const contas: Array<{ id: string }> = (await this.prisma.tenant.findMany({ select: { id: true } })) ?? [];
    for (const { id } of contas) {
      if (!proprias.has(id) && (await cfgFor(id)).enabled) ligadas.add(id);
    }
    if (!ligadas.size) return null;
    return { cfgFor, filtroConta: { tenant_id: { in: [...ligadas] } } };
  }

  // ─── Scan: cria survey PENDING para consultas concluidas sem survey ─────────

  private async scanCompletedAppointments(plano: PlanoPostCare): Promise<number> {
    const since = new Date();
    since.setDate(since.getDate() - 1);

    const events = await (this.prisma as any).calendarEvent.findMany({
      where: {
        status: 'CONCLUIDO',
        type: 'CONSULTA',
        updated_at: { gte: since },
        post_care_survey: null,
        patient_id: { not: null },
        ...plano.filtroConta,
      },
      select: {
        id: true, tenant_id: true, patient_id: true, assigned_user_id: true,
        title: true, start_at: true, end_at: true,
      },
      take: 200,
    });

    let created = 0;
    for (const ev of events) {
      if (!ev.tenant_id || !ev.patient_id) continue;
      const cfg = await plano.cfgFor(ev.tenant_id);
      if (!cfg.enabled) continue;
      const baseAt = ev.end_at || ev.start_at;
      const triggerAt = new Date(baseAt.getTime() + cfg.delay_hours * 60 * 60 * 1000);
      try {
        await (this.prisma as any).postCareSurvey.create({
          data: {
            tenant_id: ev.tenant_id,
            patient_id: ev.patient_id,
            appointment_id: ev.id,
            dentist_id: ev.assigned_user_id,
            procedure_summary: ev.title,
            trigger_at: triggerAt,
            status: 'PENDING',
          },
        });
        created++;
      } catch (err: any) {
        // Unique constraint = ja existe — ignora
        if (!String(err?.message || '').includes('Unique')) {
          this.logger.warn(`[PostCare] scan: erro ao criar survey appointment=${ev.id}: ${err.message}`);
        }
      }
    }

    return created;
  }

  // ─── Dispatch: envia surveys PENDING com trigger_at vencido ─────────────────

  private async dispatchPendingSurveys(plano: PlanoPostCare): Promise<number> {
    const now = new Date();
    const surveys = await (this.prisma as any).postCareSurvey.findMany({
      where: { status: 'PENDING', trigger_at: { lte: now }, ...plano.filtroConta },
      orderBy: { trigger_at: 'asc' },
      take: 30,
      include: {
        patient: { select: { id: true, name: true, phone: true, tenant_id: true } },
        dentist: { select: { name: true } },
      },
    });

    let sent = 0;
    for (const s of surveys) {
      const contaDaPesquisa: string | null = s.tenant_id ?? s.patient?.tenant_id ?? null;
      const cfg = contaDaPesquisa ? await plano.cfgFor(contaDaPesquisa) : { ...DEFAULT_CONFIG };
      // Conta desligada: fica PENDING, como com o robô desligado. (Sem conta segue
      // como antes: o envio recusa e a pesquisa vira FAILED.)
      if (contaDaPesquisa && !cfg.enabled) continue;
      if (!s.patient.phone) {
        await (this.prisma as any).postCareSurvey.update({
          where: { id: s.id },
          data: { status: 'SKIPPED', last_error: 'Paciente sem telefone' },
        });
        continue;
      }

      try {
        const text = this.renderInitialMessage(cfg, {
          patient_name: s.patient.name.split(' ')[0],
          dentist_name: s.dentist?.name
            ? `Dr(a). ${s.dentist.name.split(' ').slice(0, 2).join(' ')}`
            : 'a equipe',
          procedure: (s.procedure_summary || 'sua consulta').toLowerCase(),
        });
        const evolutionMsgId = await this.sendWhatsApp(s.patient.tenant_id, s.patient.phone, text);
        await (this.prisma as any).postCareSurvey.update({
          where: { id: s.id },
          data: {
            status: 'SENT',
            sent_at: new Date(),
            evolution_message_id: evolutionMsgId,
            last_error: null,
          },
        });
        sent++;
      } catch (err: any) {
        this.logger.warn(`[PostCare] Falha ao enviar survey ${s.id}: ${err.message}`);
        await (this.prisma as any).postCareSurvey.update({
          where: { id: s.id },
          data: { status: 'FAILED', last_error: err.message?.slice(0, 500) },
        });
      }
    }
    return sent;
  }

  // ─── Helpers ────────────────────────────────────────────────────────────────

  /** Global antiga (sem conta) — a reserva das contas legadas. */
  private async getConfig(): Promise<PostCareConfig> {
    const row = await this.prisma.globalSetting.findUnique({
      where: { key: POST_CARE_CONFIG_KEY },
    });
    return this.parseConfig(row?.value);
  }

  private parseConfig(value: string | null | undefined): PostCareConfig {
    if (!value) return { ...DEFAULT_CONFIG };
    try {
      return { ...DEFAULT_CONFIG, ...JSON.parse(value) };
    } catch {
      return { ...DEFAULT_CONFIG };
    }
  }

  private renderInitialMessage(
    cfg: PostCareConfig,
    ctx: { patient_name: string; dentist_name: string; procedure: string },
  ): string {
    const tpl =
      cfg.initial_choice === 'custom'
        ? cfg.initial_custom || DEFAULT_TEMPLATES.descontraido
        : DEFAULT_TEMPLATES[cfg.initial_choice];
    return tpl
      .replace(/\{patient_name\}/g, ctx.patient_name || 'paciente')
      .replace(/\{dentist_name\}/g, ctx.dentist_name || 'a equipe')
      .replace(/\{procedure\}/g, ctx.procedure || 'sua consulta');
  }

  private async sendWhatsApp(tenantId: string, phone: string, text: string): Promise<string | null> {
    const cfg = await this.settings.getEvolutionConfig();
    if (!cfg.apiUrl || !cfg.apiKey) {
      throw new Error('Evolution API nao configurada');
    }
    if (!tenantId) throw new Error('Paciente sem clínica (tenant) — não dá pra escolher o chip');
    // Pesquisa pós-atendimento é do PACIENTE ⇒ chip CLINICA (na falta, o COMERCIAL),
    // nunca o FINANCEIRO. Antes era a 1ª Instance por NOME — 'Comercial'/'whatsapp'
    // (órfãs, purpose NULL) vinham antes de 't00000000-*' e o envio ia pra elas.
    // Clínica legada (sem chip com função) segue no 1º chip por nome, sem o financeiro.
    const chips = await this.prisma.instance.findMany({
      where: { tenant_id: tenantId, type: 'whatsapp' },
      select: { name: true, purpose: true },
      orderBy: { name: 'asc' },
    });
    const escolha = escolherChipPaciente(chips, 'CLINICA');
    const instance = chipPacienteOuLegado(escolha);
    if (!instance) {
      throw new Error(
        soTemChipFinanceiro(escolha)
          ? 'Clínica só tem o chip Financeiro — pesquisa não sai por ele. Conecte o chip da Clínica.'
          : 'Sem Evolution instance no tenant',
      );
    }

    const resp = await axios.post(
      `${cfg.apiUrl}/message/sendText/${instance}`,
      { number: toBrazilWhatsappNumber(phone), text },
      {
        headers: { 'Content-Type': 'application/json', apikey: cfg.apiKey },
        timeout: 15000,
      },
    );
    // Evolution pode responder 2xx com exists:false (número sem WhatsApp) — isso é
    // FALHA, não envio (vira status FAILED na pesquisa).
    let respJson = '';
    try { respJson = JSON.stringify(resp.data) ?? ''; } catch { /* resposta não serializável */ }
    if (/"exists"\s*:\s*false/.test(respJson)) {
      throw new Error(`Número sem WhatsApp (chip ${instance})`);
    }
    return resp.data?.key?.id || resp.data?.id || null;
  }
}

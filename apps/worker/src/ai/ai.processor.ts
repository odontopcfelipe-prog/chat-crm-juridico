import { Processor, WorkerHost, InjectQueue } from '@nestjs/bullmq';
import { Job, Queue } from 'bullmq';
import { Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { SettingsService } from '../settings/settings.service';
import { S3Service } from '../s3/s3.service';
import OpenAI, { toFile } from 'openai';
import axios from 'axios';
import { SkillRouter } from './skill-router';
import { NonPatientClassifier } from './non-patient-classifier';
import { ToolExecutor } from './tool-executor';
import { PromptBuilder } from './prompt-builder';
import { buildHandlerMap } from './tool-handlers';
import { createLLMClient, calculateCost, type LLMProvider } from './llm-client';
import {
  computeBusinessHoursInfo,
  clinicStatusNow,
  brazilPhoneMatchVariants,
  isNonPatientCategory,
  naoPacienteTriageKey,
  nonPatientCategoryLabel,
} from '@crm/shared';
import { sendAdminAlert } from '../admin-alerts/admin-alert';
import {
  NON_PATIENT_HANDOFF_TEXT,
  buildNonPatientAdminText,
  buildNonPatientAttachmentCaption,
  buildNonPatientTeamNote,
  chooseNonPatientReply,
  contradictsNonPatient,
  decideNonPatientBlock,
  extractNaoPacienteFromRaw,
  nonPatientAttachmentMeta,
  normalizeNaoPaciente,
  type NaoPacienteFlag,
} from './non-patient-rules';
import { aiTeamNoteExternalId, aiTeamNoteKey, hasRecentSameSubjectNote } from './team-note';
import { MemoryRetrievalService } from '../memory/memory-retrieval.service';
import {
  loadPipelinesForTenant,
  buildPipelinesPromptBlock,
  resolveStageUpdate,
  describeFunnelChoice,
  type LeadPipelinePosition,
} from './pipeline-context';
import { ensureOrcamentistaAssigned } from './orcamentista';
import {
  CONVERSATION_GUIDE,
  SCHEDULING_RULES,
  FINANCE_GUIDE,
  FINANCE_RULES,
  NO_PRICE_TABLE,
  splitIntoBubbles,
  bubbleTypingMs,
  bubblePauseMs,
  tidyReply,
  resolveReplyStyle,
  detectPatientStyle,
  isClosingWithoutScheduling,
  replyProposesSlots,
  replyListsSlots,
  promisesSlotsLater,
  leadFirstName,
  buildSchedulingRetryInstruction,
} from './conversation-guide';
import { loadClinicAiContext, isChipAiEnabledForClinic, type ClinicAiContext } from './clinic-ai-context';
import { computeDaySlots } from './tool-handlers/check-availability';
import { findDentistConflict } from './tool-handlers/book-appointment';
import { isAiAutobookEnabled } from './auto-book-gate';
import {
  loadFinanceiroContext,
  normalizeFinanceiroAction,
  runFinanceiroSend,
  type FinanceiroSendable,
  type FinanceiroAction,
} from './financeiro';
import {
  alternativeCandidates,
  assessBookingClaim,
  buildBookingFixText,
  buildHonestPreferenceText,
  buildSlotTakenText,
  compactDayTimes,
  existingAppointmentFilter,
  findBookingClaims,
  formatSlotLabel,
  hasRecentAiTeamNote,
  isAiTeamNote,
  isSlotSpecificRefusal,
  isValidConfirmSlot,
  lastOutTurnText,
  maceioNowNaive,
  maceioTodayStr,
  modelEmittedNoAction,
  normalizeSchedulingAction,
  pickAlternativeSlots,
  pickSuggestedSlots,
  REMINDER_MIN_DELAY_MS,
  reminderDelayMs,
  sortSlots,
  stripCancellationClaims,
  withoutRefused,
  type FreeSlotDay,
  type NormalizedSchedulingAction,
  type SlotRef,
} from './scheduling-safety';
import {
  NO_AUTOMATION_SIGNALS,
  chatTurnPrefix,
  classifyHistorySender,
  historyTextLabel,
  loadAutomationSignals,
  stripHistoryLabels,
  type AutomationSignals,
} from './history-sender';

// Modelos com suporte a visão (imagens)
const VISION_MODELS = ['gpt-4o', 'gpt-4.1', 'gpt-5', 'claude-'];

// LONG_MEMORY_SYSTEM_PROMPT REMOVIDO em 2026-04-20 (Divida 2 do MEMORY_SYSTEM.md).
//
// O sistema antigo (updateLongMemory + AiMemory.facts_json com case_state)
// foi substituido pelo sistema novo: extracao batch noturna + Memory entries
// + ProfileConsolidationProcessor (incremental 02h) + LeadProfile (prosa).
//
// Leitura de AiMemory permanece como fallback para ~19 leads legacy sem
// tenant_id que nao puderam ser migrados em massa — quando eles interagem
// de novo, a extracao noturna cria Memory entries e LeadProfile automaticamente.

@Processor('ai-jobs')
export class AiProcessor extends WorkerHost {
  private readonly logger = new Logger(AiProcessor.name);
  private skillRouter = new SkillRouter();
  private nonPatientClassifier = new NonPatientClassifier();
  private promptBuilder = new PromptBuilder();

  constructor(
    private prisma: PrismaService,
    private settings: SettingsService,
    private s3: S3Service,
    @InjectQueue('calendar-reminders') private reminderQueue: Queue,
    private memoryRetrieval: MemoryRetrievalService,
    // Mesma fila deste processor (registrada no AiModule) — usada só pra agendar a
    // 2ª tentativa de agendamento ('ai-scheduling-retry'). Sem import entre módulos.
    @InjectQueue('ai-jobs') private aiQueue: Queue,
  ) {
    super();
  }

  // ─── 2ª TENTATIVA DE AGENDAMENTO ─────────────────────────────────────────
  // Paciente encerrou sem agendar ("ok", "vou pensar"): a IA responde curto sem
  // fechar a porta e, schedulingRetryMin minutos depois (perfil do chip), este
  // mesmo processor manda UMA mensagem separada oferecendo 2 horários. No máx. 1
  // por conversa por dia (jobId fixo por conversa + dia de Maceió).

  /** Tipos de evento que contam como "consulta" do paciente (mesmos dos safeguards). */
  private static readonly CLINICAL_EVENT_TYPES = ['CONSULTA', 'PROCEDIMENTO', 'RETORNO', 'ORTODONTIA'];

  /**
   * O lead/paciente já tem consulta FUTURA (AGENDADO/CONFIRMADO)? Procura pela
   * conversa, pelo lead e pelo Patient ligado ao lead (eventos criados na tela).
   * Agenda é naive-UTC (hora de Maceió gravada como UTC) → "agora" = Date.now()-3h.
   * Erro = assume que TEM (não manda tentativa às cegas).
   */
  private async hasFutureClinicalAppointment(convo: any): Promise<boolean> {
    try {
      const leadId: string | null = convo.lead_id || convo.lead?.id || null;
      const patient = leadId
        ? await (this.prisma as any).patient
            .findUnique({ where: { lead_id: leadId }, select: { id: true } })
            .catch(() => null)
        : null;
      const or: any[] = [{ conversation_id: convo.id }];
      if (leadId) or.push({ lead_id: leadId });
      if (patient?.id) or.push({ patient_id: patient.id });
      const nowNaive = new Date(Date.now() - 3 * 60 * 60 * 1000);
      const ev = await (this.prisma as any).calendarEvent.findFirst({
        where: {
          OR: or,
          type: { in: AiProcessor.CLINICAL_EVENT_TYPES },
          status: { in: ['AGENDADO', 'CONFIRMADO'] },
          start_at: { gt: nowNaive },
        },
        select: { id: true },
      });
      return !!ev;
    } catch (e: any) {
      this.logger.warn(`[AI-RETRY] Falha ao checar consulta futura (conv ${convo?.id}): ${e?.message} — não agenda tentativa`);
      return true;
    }
  }

  /**
   * Inícios (naive) das consultas que o lead/paciente JÁ tem (mesma identificação do
   * hasFutureClinicalAppointment): as ativas de HOJE em diante — inclusive a de hoje
   * que já começou (atrasado, chegando, em atendimento) — e as atendidas nas últimas
   * 12h (existingAppointmentFilter). Usado pela rede de segurança do "deixei
   * agendado": "sua consulta está marcada pra hoje às 9h" sobre uma consulta que JÁ
   * existe não é marcação nova. Mais próximas primeiro (série recorrente longa não
   * esconde a de amanhã). Erro = [] (não esconde a correção de uma confirmação falsa).
   */
  private async futureClinicalStarts(convo: any): Promise<Date[]> {
    try {
      const leadId: string | null = convo.lead_id || convo.lead?.id || null;
      const patient = leadId
        ? await (this.prisma as any).patient
            .findUnique({ where: { lead_id: leadId }, select: { id: true } })
            .catch(() => null)
        : null;
      const or: any[] = [{ conversation_id: convo.id }];
      if (leadId) or.push({ lead_id: leadId });
      if (patient?.id) or.push({ patient_id: patient.id });
      // Lead duplicado por formato de número (55/9º dígito): a consulta pode estar no outro.
      const phones = brazilPhoneMatchVariants(convo.lead?.phone);
      const tenantId: string | null = convo.tenant_id || convo.lead?.tenant_id || null;
      if (phones.length) or.push({ lead: { phone: { in: phones }, ...(tenantId ? { tenant_id: tenantId } : {}) } });
      const evs = await (this.prisma as any).calendarEvent.findMany({
        where: {
          AND: [{ OR: or }, { OR: existingAppointmentFilter() }],
          type: { in: AiProcessor.CLINICAL_EVENT_TYPES },
        },
        select: { start_at: true },
        orderBy: { start_at: 'asc' },
        take: 20,
      });
      return (evs || []).map((e: any) => new Date(e.start_at));
    } catch (e: any) {
      this.logger.warn(`[AI] Falha ao buscar consultas futuras (conv ${convo?.id}): ${e?.message}`);
      return [];
    }
  }

  /**
   * Até 2 horários pra oferecer no lugar de um que a guarda recusou: mesma fonte
   * do prompt (computeDaySlots do Orçamentista), o mais cedo primeiro, em dias
   * diferentes quando houver — cada um conferido com a MESMA regra de conflito da
   * guarda (evento que começou noutro dia não aparece no computeDaySlots e faria a
   * recusa se repetir). Até 8 tentativas; erro na checagem = aceita o candidato.
   */
  private async pickVerifiedAlternatives(
    freeDays: FreeSlotDay[],
    exclude: SlotRef | null,
    dentistId: string,
    ignoreEventIds: string[],
    max = 2,
  ): Promise<SlotRef[]> {
    const ok: SlotRef[] = [];
    for (const c of alternativeCandidates(freeDays, exclude).slice(0, 8)) {
      if (ok.length >= max) break;
      const [y, mo, d] = c.date.split('-').map(Number);
      const [h, mi] = c.time.split(':').map(Number);
      const start = new Date(Date.UTC(y, mo - 1, d, h, mi, 0, 0));
      const end = new Date(start.getTime() + 60 * 60_000);
      try {
        if (!(await findDentistConflict(this.prisma, dentistId, start, end, ignoreEventIds))) ok.push(c);
      } catch {
        ok.push(c);
      }
    }
    return sortSlots(ok);
  }

  /**
   * ALERTA interno pra equipe — mecanismos que já existem:
   *  - nota interna na conversa (Message type 'internal_note', igual à do chat), com o
   *    ASSUNTO no external_message_id (team-note.ts);
   *  - sininho (Notification) pro atendente da conversa + ADMINs da clínica (clique
   *    abre a conversa).
   * Trava: pula só se já há nota da IA do MESMO assunto nos últimos 30 min (outro
   * horário / outro assunto gera nota nova). Best-effort: erro só loga.
   * Devolve o id da nota (a API emite no WebSocket junto com os balões).
   */
  private async alertTeam(
    convo: any,
    n: {
      key: string;
      text: string;
      title: string;
      body: string;
      notificationType: string;
      data: Record<string, unknown>;
      /** Nota antiga (sem assunto no id) que conta como o mesmo assunto. */
      legacySame?: (text: string) => boolean;
      logLabel: string;
    },
  ): Promise<string | null> {
    try {
      if (hasRecentSameSubjectNote(convo.messages || [], n.key, { legacySame: n.legacySame })) {
        this.logger.log(`[AI] Alerta "${n.key}" já enviado há pouco (conv ${convo.id}) — não repete`);
        return null;
      }
      const note = await this.prisma.message.create({
        data: {
          conversation_id: convo.id,
          direction: 'out',
          type: 'internal_note',
          text: n.text,
          external_message_id: aiTeamNoteExternalId(n.key),
          status: 'enviado',
        },
      });
      // Em memória também: outro alerta neste mesmo job enxerga a nota (trava por assunto).
      if (Array.isArray(convo.messages)) convo.messages.unshift(note);

      const tenantId: string | null = convo.tenant_id || convo.lead?.tenant_id || null;
      const userIds = new Set<string>();
      if (convo.assigned_user_id) userIds.add(convo.assigned_user_id);
      if (tenantId) {
        const admins = await (this.prisma as any).user.findMany({
          where: { tenant_id: tenantId, roles: { has: 'ADMIN' } },
          select: { id: true },
          take: 5,
        });
        for (const a of admins || []) userIds.add(a.id);
      }
      for (const uid of userIds) {
        await (this.prisma as any).notification
          .create({
            data: {
              user_id: uid,
              tenant_id: tenantId,
              notification_type: n.notificationType,
              title: n.title,
              body: n.body.slice(0, 300),
              data: { conversationId: convo.id, lead_id: convo.lead_id || convo.lead?.id || null, ...n.data },
            },
          })
          .catch(() => {});
      }
      this.logger.warn(
        `[AI] ALERTA pra equipe — ${n.logLabel} (conv ${convo.id}). Nota interna + ${userIds.size} notificação(ões).`,
      );
      return note?.id || null;
    } catch (e: any) {
      this.logger.warn(`[AI] Falha ao alertar a equipe (conv ${convo?.id}): ${e?.message}`);
      return null;
    }
  }

  /**
   * ALERTA quando a IA NÃO conseguiu marcar (freio desligado, sem Orçamentista, guarda
   * recusou sem alternativa, erro, "disse que agendou" sem horário identificável).
   * Assunto = o horário: o mesmo horário não repete em 30 min; horário diferente gera nota nova.
   */
  private async alertTeamBookingIssue(
    convo: any,
    info: { slot?: SlotRef | null; reason: string; detail?: string | null },
  ): Promise<string | null> {
    const leadName = convo.lead?.name || 'Paciente';
    const label = info.slot ? formatSlotLabel(info.slot.date, info.slot.time) : null;
    const text =
      `⚠️ IA: ${label ? `o paciente aceitou ${label}, mas ` : ''}a consulta NÃO foi criada na agenda (${info.reason}). ` +
      `A IA avisou o paciente que a recepção vai falar com ele: falem com o paciente e agendem manualmente.` +
      (info.detail ? `\nÚltima mensagem do paciente: "${info.detail.slice(0, 200)}"` : '');
    return this.alertTeam(convo, {
      key: aiTeamNoteKey({ slot: info.slot }),
      text,
      title: 'IA não conseguiu agendar — confirmar com o paciente',
      body: `${leadName}${label ? ` pediu ${label}` : ''}. Motivo: ${info.reason}`,
      notificationType: 'calendar_reminder',
      data: { date: info.slot?.date || null, time: info.slot?.time || null, reason: info.reason },
      // Nota de antes do assunto no id: mesmo assunto se cita o mesmo horário (ou ambas sem horário).
      legacySame: (t) => (label ? t.includes(label) : /a consulta NÃO foi criada/.test(t) && !/o paciente aceitou/.test(t)),
      logLabel: `agendamento não criado (${label || 'horário não identificado'}): ${info.reason}`,
    });
  }

  /**
   * ALERTA interno de contato NÃO-paciente (sem pausar a IA): a equipe dá o retorno.
   * `alreadyMarked`: lead marcado pela triagem e a resposta com horário foi trocada —
   * a nota diz como desfazer a marca (assunto próprio).
   */
  private async alertTeamNonPatient(
    convo: any,
    flag: { categoria: string; resumo: string },
    detail: string | null,
    opts: { alreadyMarked?: boolean } = {},
  ): Promise<string | null> {
    const nome = convo.lead?.name || 'Contato';
    const label = nonPatientCategoryLabel(flag.categoria);
    return this.alertTeam(convo, {
      key: aiTeamNoteKey({ topic: opts.alreadyMarked ? 'np_marcado' : `np_${flag.categoria}` }),
      text: buildNonPatientTeamNote({
        categoria: flag.categoria,
        resumo: flag.resumo,
        trecho: detail,
        alreadyMarked: opts.alreadyMarked,
      }),
      title: opts.alreadyMarked
        ? 'Contato marcado como não-paciente — resposta com horário trocada'
        : 'Contato não-paciente — repassar ao responsável',
      body: `${nome}: ${label}${flag.resumo ? `. ${flag.resumo}` : ''}`,
      notificationType: 'nao_paciente',
      data: { categoria: flag.categoria, reason: 'nao_paciente' },
      logLabel: `contato não-paciente (${flag.categoria}${flag.resumo ? `: ${flag.resumo.slice(0, 80)}` : ''})`,
    });
  }

  /**
   * Agenda a 2ª tentativa (job 'ai-scheduling-retry' na fila ai-jobs). jobId fixo
   * por conversa + dia de Maceió: se já existe um job PENDENTE (delayed/waiting),
   * troca pelo novo (timer e marco reiniciam); se já RODOU hoje (completed/failed,
   * guardado 24h), não cria outro. Best-effort: erro só loga.
   */
  private async scheduleSchedulingRetry(convo: any, minutes: number, reason: string): Promise<void> {
    try {
      if (await this.hasFutureClinicalAppointment(convo)) {
        this.logger.log(`[AI-RETRY] conv ${convo.id}: lead já tem consulta futura — 2ª tentativa NÃO agendada`);
        return;
      }
      const dayKey = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString().slice(0, 10).replace(/-/g, '');
      const jobId = `ai-sched-retry-${convo.id}-${dayKey}`;
      const existing = await this.aiQueue.getJob(jobId);
      if (existing) {
        const state = await existing.getState().catch(() => 'unknown');
        if (state === 'delayed' || state === 'waiting' || state === 'prioritized') {
          await existing.remove();
          this.logger.log(`[AI-RETRY] conv ${convo.id}: tentativa pendente substituída (timer reiniciado)`);
        } else {
          this.logger.log(
            `[AI-RETRY] conv ${convo.id}: já houve 2ª tentativa hoje (job ${jobId} em ${state}) — não agenda outra`,
          );
          return;
        }
      }
      const retryAfterMessageAt = new Date().toISOString();
      await this.aiQueue.add(
        'ai-scheduling-retry',
        {
          conversation_id: convo.id,
          lead_id: convo.lead_id || convo.lead?.id || null,
          schedulingRetry: true,
          retryAfterMessageAt,
          // Quem estava atribuído ao agendar: se mudar até o disparo, um humano assumiu.
          assignedUserId: convo.assigned_user_id || null,
        },
        {
          jobId,
          delay: Math.max(1, minutes) * 60_000,
          attempts: 1, // nunca reenviar a tentativa em duplicidade
          removeOnComplete: { age: 24 * 60 * 60 },
          removeOnFail: { age: 24 * 60 * 60 },
        },
      );
      this.logger.log(
        `[AI-RETRY] conv ${convo.id}: 2ª tentativa de agendamento AGENDADA em ${minutes} min (job ${jobId}, motivo: ${reason})`,
      );
    } catch (e: any) {
      this.logger.warn(`[AI-RETRY] Falha ao agendar 2ª tentativa (conv ${convo?.id}): ${e?.message}`);
    }
  }

  /**
   * Checagens SÍNCRONAS da 2ª tentativa sobre a conversa já carregada (mensagens
   * DESC). Devolve o motivo pra abortar, ou null pra seguir.
   */
  private schedulingRetryAbortReason(convo: any, data: any): string | null {
    const after = Date.parse(String(data?.retryAfterMessageAt || ''));
    if (!Number.isFinite(after)) return 'job sem retryAfterMessageAt válido';
    const newer = (convo.messages || []).filter((m: any) => new Date(m.created_at).getTime() > after);
    if (newer.some((m: any) => m.direction === 'in')) return 'paciente respondeu depois (o fluxo normal cuida)';
    if (newer.some((m: any) => m.direction === 'out')) return 'outra mensagem saiu depois (operador/disparo)';
    // Recepção fechou/adiou a conversa (os botões só mudam o status) → não manda.
    if (convo.status && convo.status !== 'ABERTO') return `conversa ${convo.status}`;
    const before = data?.assignedUserId || null;
    if (convo.assigned_user_id && convo.assigned_user_id !== before) return 'conversa atribuída a um humano depois';
    return null;
  }

  // ─── TRIAGEM NÃO-PACIENTE ────────────────────────────────────────────────
  /** Toggle da triagem com handoff (pausa + aviso aos ADMs). Default OFF; erro = OFF. */
  private async nonPatientTriageOn(tenantId: string | null | undefined): Promise<boolean> {
    if (!tenantId) return false;
    try {
      const on = await this.prisma.globalSetting.findUnique({ where: { key: naoPacienteTriageKey(tenantId) } });
      return on?.value === 'true';
    } catch (e: any) {
      this.logger.warn(`[AI][NÃO-PACIENTE] Falha ao ler o toggle da triagem (tenant ${tenantId}): ${e?.message}`);
      return false;
    }
  }

  /**
   * Classificador (só com o toggle ligado). Detecta fornecedor/currículo/parceria/
   * negócio/propaganda e, se for o caso: (a) responde educado que vai encaminhar ao
   * responsável e encerra; (b) pausa a IA nesta conversa SEM religar
   * (ai_mode_source='MANUAL' — o cron de reativação e o after-hours não mexem) e marca o
   * lead (Lead.non_patient_category/at); (c) avisa os ADMs (sendAdminAlert) e encaminha
   * os arquivos que a pessoa já mandou. handled=true → o caller faz `return` e pula o
   * fluxo de venda. Lead JÁ marcado não é reclassificado (o bloqueio dele vem da marca).
   * Classificou mas a resposta falhou antes de sair → handled=false + classified: o
   * fluxo normal segue com a agenda bloqueada.
   */
  private async maybeHandleNonPatient(
    convo: any,
    chronological: any[],
  ): Promise<{ handled: boolean; classified: { category: string; reason: string } | null }> {
    const none = { handled: false, classified: null };
    const tenantId = convo.tenant_id || convo.lead?.tenant_id;
    if (!tenantId) return none;
    if (convo.lead?.non_patient_category) return none; // já triado: não gasta outra chamada

    // Gate opt-in por tenant (default OFF).
    if (!(await this.nonPatientTriageOn(tenantId))) return none;

    // Classifica SÓ pelas mensagens do contato (inbound) — nunca pelas da Sophia.
    const inboundMessages = chronological
      .filter((m: any) => m.direction === 'in')
      .map((m: any) => (m.text || '[mídia]').slice(0, 300));
    if (inboundMessages.length === 0) return none;

    // Mesmo provider/model do router (chamada barata). Sem chave → segue normal.
    const routerConfig = await this.settings.getRouterConfig();
    const apiKey = routerConfig.provider === 'anthropic'
      ? await this.settings.getAnthropicKey()
      : await this.settings.getOpenAiKey();
    if (!apiKey) return none;

    const { category, reason } = await this.nonPatientClassifier.classify({
      inboundMessages,
      model: routerConfig.model,
      provider: routerConfig.provider as LLMProvider,
      apiKey,
    });

    if (category === 'PACIENTE') return none; // segue o fluxo de venda normal
    const classified = { category, reason };

    // Paciente cadastrado (ficha ligada ao lead) nunca passa pelo handoff.
    if (await this.leadHasPatientRecord(convo)) {
      this.logger.warn(`[AI][NÃO-PACIENTE] Conv ${convo.id} classificada como ${category}, mas o lead tem cadastro de paciente — sem handoff (segue normal)`);
      return none;
    }

    this.logger.log(
      `[AI][NÃO-PACIENTE] Conv ${convo.id} classificada como ${category} (${reason}) — encaminhando ao responsável + pausando IA + alertando ADMs.`,
    );

    // (a) Resposta educada de encerramento, assinada com o perfil COMERCIAL DESTA
    // clínica (nome da assistente + assinatura liga/desliga em Ajustes › IA).
    let assistantName = 'Assistente';
    try {
      const { profile } = await loadClinicAiContext(this.prisma, tenantId, 'COMERCIAL');
      assistantName = profile.assistantName;
      const signature = profile.signature ? `*${profile.assistantName}:* ` : '';
      const sent = await this.sendPlainWhatsApp(convo.lead?.phone, `${signature}${NON_PATIENT_HANDOFF_TEXT}`, convo.instance_name);
      if (!sent) this.logger.warn(`[AI][NÃO-PACIENTE] Conv ${convo.id}: resposta de repasse NÃO entregue — segue o handoff (ADMs avisados)`);
    } catch (e: any) {
      this.logger.warn(`[AI][NÃO-PACIENTE] Falha ao responder o contato (conv ${convo.id}): ${e?.message} — segue o fluxo normal sem agenda`);
      return { handled: false, classified };
    }

    // Salva a mensagem de saída (best-effort — não bloqueia o handoff).
    try {
      await this.prisma.message.create({
        data: {
          conversation_id: convo.id,
          direction: 'out',
          type: 'text',
          text: NON_PATIENT_HANDOFF_TEXT,
          external_message_id: `sys_ai_np_${Date.now()}`,
          status: 'enviado',
          skill_id: null,
        },
      });
    } catch (e: any) {
      this.logger.warn(`[AI][NÃO-PACIENTE] Falha ao salvar mensagem de handoff: ${e?.message}`);
    }

    // (b) pausa + marca o lead, (c) ADMs + arquivos.
    await this.finishNonPatientHandoff(
      convo,
      tenantId,
      { categoria: isNonPatientCategory(category) ? category : 'OUTRO', resumo: reason },
      assistantName,
    );
    return { handled: true, classified };
  }

  /** O lead tem cadastro de Paciente (ficha)? Erro = assume que tem (não faz handoff às cegas). */
  private async leadHasPatientRecord(convo: any): Promise<boolean> {
    const leadId: string | null = convo.lead_id || convo.lead?.id || null;
    if (!leadId) return false;
    try {
      const p = await (this.prisma as any).patient.findFirst({ where: { lead_id: leadId }, select: { id: true } });
      return !!p;
    } catch (e: any) {
      this.logger.warn(`[AI][NÃO-PACIENTE] Falha ao checar cadastro de paciente (lead ${leadId}): ${e?.message}`);
      return true;
    }
  }

  /**
   * Marca de não-paciente do lead que VALE neste turno (null = trata como paciente).
   * A marca só nasce no handoff (IA pausada), mas a IA pode voltar a rodar por outros
   * caminhos (lembrete de consulta, mover setor…) sem limpar a marca: quem é cliente,
   * tem ficha de Paciente ou consulta marcada é paciente — a marca antiga não bloqueia.
   */
  private async effectiveNonPatientMark(convo: any, isClient: boolean): Promise<string | null> {
    const mark: string | null = convo.lead?.non_patient_category || null;
    if (!mark || isClient || convo.lead?.is_client) return null;
    if ((await this.leadHasPatientRecord(convo)) || (await this.hasFutureClinicalAppointment(convo))) {
      this.logger.log(
        `[AI][NÃO-PACIENTE] lead ${convo.lead?.id} marcado ${mark}, mas tem ficha de paciente/consulta — marca ignorada (conv ${convo.id})`,
      );
      return null;
    }
    return mark;
  }

  /**
   * Marca o lead como não-paciente (Lead.non_patient_category/at). Só se ainda não
   * estava marcado: não reescreve a categoria nem reinicia a janela de 72h dos anexos.
   * Devolve o instante gravado (null = já estava marcado / erro).
   */
  private async markLeadNonPatient(convo: any, categoria: string): Promise<Date | null> {
    const leadId: string | null = convo.lead_id || convo.lead?.id || null;
    if (!leadId) return null;
    try {
      const at = new Date();
      const r = await this.prisma.lead.updateMany({
        where: { id: leadId, non_patient_category: null },
        data: { non_patient_category: categoria, non_patient_at: at },
      });
      if (r.count > 0) {
        if (convo.lead) Object.assign(convo.lead, { non_patient_category: categoria, non_patient_at: at });
        this.logger.log(`[AI][NÃO-PACIENTE] Lead ${leadId} marcado como ${categoria}`);
        return at;
      }
      return null;
    } catch (e: any) {
      this.logger.warn(`[AI][NÃO-PACIENTE] Falha ao marcar o lead ${leadId}: ${e?.message}`);
      return null;
    }
  }

  /**
   * Handoff de não-paciente (toggle ligado): (b) pausa a IA SEM religar (MANUAL é
   * OBRIGATÓRIO: o ai-reactivation-cron só religa `ai_mode_source: { not: 'MANUAL' }` e
   * o after-hours respeita MANUAL) e marca o lead logo em seguida; (c) avisa os ADMs e
   * encaminha os arquivos que a pessoa JÁ mandou. Sem número de aviso / ninguém recebeu →
   * nota interna + sininho (alguém precisa dar o retorno). Cada passo é best-effort.
   * Devolve o id da nota interna, se precisou criar.
   */
  private async finishNonPatientHandoff(
    convo: any,
    tenantId: string,
    flag: { categoria: string; resumo: string },
    assistantName: string,
  ): Promise<string | null> {
    try {
      await this.prisma.conversation.update({
        where: { id: convo.id },
        data: {
          ai_mode: false,
          ai_mode_disabled_at: new Date(),
          ai_mode_source: 'MANUAL',
          last_message_at: new Date(),
        },
      });
    } catch (e: any) {
      this.logger.warn(`[AI][NÃO-PACIENTE] Falha ao pausar a IA (conv ${convo.id}): ${e?.message}`);
    }
    const markedAt = (await this.markLeadNonPatient(convo, flag.categoria)) || new Date();

    let delivered = false;
    try {
      const r = await this.alertAdminsNonPatient(tenantId, flag, convo, assistantName);
      delivered = r.sent > 0;
      if (!r.noPhone) {
        await this.forwardNonPatientPriorAttachments(convo, tenantId, flag.categoria, markedAt);
      }
    } catch (e: any) {
      this.logger.warn(`[AI][NÃO-PACIENTE] alerta admin falhou: ${e?.message}`);
    }
    if (!delivered) {
      const lastIn = (convo.messages || []).find((m: any) => m.direction === 'in' && m.text);
      return this.alertTeamNonPatient(convo, flag, lastIn?.text || null);
    }
    return null;
  }

  /**
   * Aviso aos ADMs pelo helper sendAdminAlert: VÁRIOS números (VENDA_FEITA_PHONE_<t>,
   * senão DAILY_SUMMARY_PHONE_<t>), só chips DA CLÍNICA (nunca o EVOLUTION_INSTANCE_NAME
   * global), DispatchLog 'nao_paciente_handoff' por número.
   */
  private async alertAdminsNonPatient(
    tenantId: string,
    flag: { categoria: string; resumo: string },
    convo: any,
    assistantName: string,
  ): Promise<{ sent: number; noPhone: boolean }> {
    const nome = convo.lead?.name || 'Contato';
    const lastIn = (convo.messages || []).find((m: any) => m.direction === 'in' && m.text);
    const text = buildNonPatientAdminText({
      assistantName,
      categoria: flag.categoria,
      nome,
      telefone: convo.lead?.phone || null,
      resumo: flag.resumo,
      trecho: lastIn?.text || null,
    });
    const r = await sendAdminAlert(this.prisma, this.settings, tenantId, {
      type: 'nao_paciente_handoff',
      text,
      recipientName: nome,
    });
    if (r.noPhone) {
      this.logger.warn(
        `[AI][NÃO-PACIENTE] Sem número de aviso dos ADMs (VENDA_FEITA_PHONE/DAILY_SUMMARY_PHONE) — tenant ${tenantId}. Handoff feito, mas ninguém avisado por WhatsApp.`,
      );
    } else {
      this.logger.log(`[AI][NÃO-PACIENTE] ADMs avisados: ${r.sent}/${r.phones.length} número(s) (conv ${convo.id})`);
    }
    return { sent: r.sent, noPhone: r.noPhone };
  }

  /** Tamanho máximo do arquivo encaminhado aos ADMs (o mesmo do webhook da API). */
  private static readonly NAO_PACIENTE_ANEXO_MAX_BYTES = 15 * 1024 * 1024;

  /**
   * Encaminha aos ADMs os arquivos (documento/imagem) que a pessoa JÁ mandou nesta
   * conversa — últimas 24h, até 3, até o instante da triagem (os que chegarem DEPOIS o
   * webhook da API encaminha). Dedup por mensagem com o MESMO marcador da API (AuditLog
   * NAO_PACIENTE_ANEXO, entity_id = Message.id), gravado ANTES de enviar. Arquivo que
   * chegou pelo chip da CLÍNICA/FINANCEIRO é de paciente: nunca encaminha. Best-effort.
   */
  private async forwardNonPatientPriorAttachments(
    convo: any,
    tenantId: string,
    categoria: string,
    upTo: Date,
  ): Promise<number> {
    let forwarded = 0;
    try {
      const msgs: any[] = await this.prisma.message.findMany({
        where: {
          conversation_id: convo.id,
          direction: 'in',
          type: { in: ['document', 'image'] },
          created_at: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000), lte: upTo },
        },
        orderBy: { created_at: 'desc' },
        take: 3,
        select: {
          id: true,
          type: true,
          text: true,
          external_message_id: true,
          instance_name: true,
          media: { select: { mime_type: true, original_name: true } },
        },
      });
      if (!msgs.length) return 0;

      const chipNames = [...new Set(msgs.map((m) => m.instance_name).filter(Boolean))] as string[];
      const chips: { name: string; purpose: string | null }[] = chipNames.length
        ? await this.prisma.instance.findMany({ where: { name: { in: chipNames } }, select: { name: true, purpose: true } })
        : [];
      const purposeOf = new Map(chips.map((c) => [c.name, c.purpose]));
      const nome = convo.lead?.name || convo.lead?.phone || 'Contato';
      const telefone = convo.lead?.phone || null;

      for (const m of [...msgs].reverse()) {
        try {
          const purpose = m.instance_name ? purposeOf.get(m.instance_name) : null;
          if (purpose === 'CLINICA' || purpose === 'FINANCEIRO') continue;
          const ja = await this.prisma.auditLog.findFirst({
            where: { entity: 'NAO_PACIENTE_ANEXO', entity_id: m.id },
            select: { id: true },
          });
          if (ja) continue;
          // Marca ANTES de enviar (mesmo formato da API): na dúvida, não manda 2×.
          await this.prisma.auditLog.create({
            data: { entity: 'NAO_PACIENTE_ANEXO', entity_id: m.id, action: 'forward', meta_json: { tenant_id: tenantId } },
          });
          const file = await this.downloadAttachmentBase64(m, convo.instance_name || null);
          const meta = nonPatientAttachmentMeta({
            type: m.type,
            mime: file?.mimetype || m.media?.mime_type || null,
            originalName: m.media?.original_name || null,
          });
          const caption = buildNonPatientAttachmentCaption({ nome, categoria, telefone, caption: m.text || null });
          const r = await sendAdminAlert(this.prisma, this.settings, tenantId, {
            type: 'nao_paciente_anexo',
            recipientName: nome,
            text: file ? caption : `${caption}\n\n_(o arquivo não pôde ser anexado — veja na conversa pelo painel)_`,
            media: file
              ? { data: file.data, mediatype: meta.mediatype, mimetype: meta.mimetype, fileName: meta.fileName }
              : null,
          });
          if (r.sent > 0) forwarded++;
        } catch (e: any) {
          this.logger.warn(`[AI][NÃO-PACIENTE] Falha ao encaminhar o arquivo da msg ${m?.id}: ${e?.message}`);
        }
      }
      if (forwarded) {
        this.logger.log(`[AI][NÃO-PACIENTE] ${forwarded} arquivo(s) que o contato já tinha mandado encaminhado(s) aos ADMs (conv ${convo.id})`);
      }
    } catch (e: any) {
      this.logger.warn(`[AI][NÃO-PACIENTE] Falha ao buscar arquivos do contato (conv ${convo?.id}): ${e?.message}`);
    }
    return forwarded;
  }

  /**
   * Base64 do arquivo de uma mensagem recebida: 1º a Evolution (chat/getBase64FromMediaMessage
   * na instância que RECEBEU a mensagem — Message.instance_name, senão o chip da conversa;
   * nunca o chip global), senão a cópia da API (GET /media/:id). null = não conseguiu.
   */
  private async downloadAttachmentBase64(
    msg: { id: string; external_message_id?: string | null; instance_name?: string | null },
    convoInstance: string | null,
  ): Promise<{ data: string; mimetype: string | null } | null> {
    const max = AiProcessor.NAO_PACIENTE_ANEXO_MAX_BYTES;
    const instance = msg.instance_name || convoInstance;
    const keyId = msg.external_message_id || '';
    if (instance && keyId && !keyId.startsWith('sys_')) {
      try {
        const { apiUrl, apiKey } = await this.settings.getEvolutionConfig();
        if (apiUrl) {
          const res = await axios.post(
            `${apiUrl}/chat/getBase64FromMediaMessage/${instance}`,
            { message: { key: { id: keyId } } },
            { headers: { apikey: apiKey }, timeout: 60_000, maxContentLength: 30 * 1024 * 1024 },
          );
          const b64 = String(res.data?.base64 || '').replace(/^data:[^;]+;base64,/, '');
          if (b64 && Math.floor((b64.length * 3) / 4) <= max) {
            return { data: b64, mimetype: String(res.data?.mimetype || '').split(';')[0].trim() || null };
          }
        }
      } catch (e: any) {
        this.logger.warn(`[AI][NÃO-PACIENTE] Evolution não devolveu o arquivo da msg ${msg.id}: ${e?.message}`);
      }
    }
    try {
      const { buffer, contentType } = await this.fetchMediaBuffer(msg.id);
      if (buffer.length && buffer.length <= max) {
        return { data: buffer.toString('base64'), mimetype: contentType.split(';')[0].trim() || null };
      }
    } catch (e: any) {
      this.logger.warn(`[AI][NÃO-PACIENTE] API não devolveu o arquivo da msg ${msg.id}: ${e?.message}`);
    }
    return null;
  }

  /** Envio WhatsApp cru via Evolution com checagem de entrega REAL (estilo wasSent). */
  /**
   * Conversa EM MEMÓRIA pro chat de teste (Ajustes › IA). Mesmo formato do
   * findUnique do process() (mensagens em ordem DESC). O chip (instance_name) é o
   * da função escolhida no teste, pra IA usar as skills daquele chip.
   */
  private async buildTestConversation(data: {
    tenantId: string;
    purpose?: string | null;
    isClient?: boolean;
    leadName?: string | null;
    history: { from: 'patient' | 'ai'; text: string }[];
  }): Promise<any> {
    const TEST_ID = '__ai_test__';
    const inst = data.purpose
      ? await this.prisma.instance.findFirst({
          where: { tenant_id: data.tenantId, type: 'whatsapp', purpose: data.purpose },
          orderBy: { created_at: 'asc' },
          select: { name: true },
        })
      : null;
    const now = Date.now();
    const history = (data.history || []).slice(-40);
    const messages = history
      .map((m, i) => ({
        id: `${TEST_ID}_${i}`,
        conversation_id: TEST_ID,
        direction: m.from === 'patient' ? 'in' : 'out',
        type: 'text',
        text: String(m.text || '').slice(0, 2000),
        // 'sys_' = mensagem da própria IA (não é rotulada como operador humano)
        external_message_id: m.from === 'patient' ? `${TEST_ID}_in_${i}` : `sys_ai_test_${i}`,
        created_at: new Date(now - (history.length - i) * 60_000),
        media: null,
      }))
      .reverse();
    return {
      id: TEST_ID,
      tenant_id: data.tenantId,
      lead_id: TEST_ID,
      lead: { id: TEST_ID, name: data.leadName || 'Paciente Teste', phone: '5582900000000', is_client: !!data.isClient },
      messages,
      ai_mode: true,
      instance_name: inst?.name || null,
      specialty: null,
      next_step: null,
      ai_notes: null,
      reminder_context: null,
      assigned_dentist_id: null,
    };
  }

  private async sendPlainWhatsApp(
    phone: string | null | undefined,
    text: string,
    instanceName?: string | null,
  ): Promise<boolean> {
    if (!phone) return false;
    const { apiUrl, apiKey } = await this.settings.getEvolutionConfig();
    if (!apiUrl) return false;
    const inst = instanceName || process.env.EVOLUTION_INSTANCE_NAME || '';
    try {
      const res = await axios.post(
        `${apiUrl}/message/sendText/${inst}`,
        { number: phone, text },
        { headers: { 'Content-Type': 'application/json', apikey: apiKey }, timeout: 30000 },
      );
      const d: any = res.data || {};
      // Evolution não lança em não-entrega: devolve statusCode/error ou exists:false.
      if (d?.error || (typeof d?.status === 'number' && d.status >= 400) || d?.exists === false) {
        return false;
      }
      return true;
    } catch (e: any) {
      this.logger.warn(`[AI] sendPlainWhatsApp falhou (${inst}): ${e?.message}`);
      return false;
    }
  }

  // ─── Retorna o parâmetro correto de tokens conforme o modelo ───
  private tokenParam(
    model: string,
    value: number,
  ): { max_tokens?: number; max_completion_tokens?: number } {
    const usesCompletionTokens = ['gpt-4.1', 'gpt-5', 'o1', 'o3'].some(
      (prefix) => model.startsWith(prefix),
    );
    return usesCompletionTokens
      ? { max_completion_tokens: value }
      : { max_tokens: value };
  }

  // ─── Verifica se o modelo suporta visão ───
  private modelSupportsVision(model: string): boolean {
    return VISION_MODELS.some((prefix) => model.startsWith(prefix));
  }

  // ─── Tabela de preços OpenAI (USD por 1M tokens) ───
  private static readonly OPENAI_PRICING: Record<string, { input: number; output: number }> = {
    'gpt-4o-mini':  { input: 0.15,  output: 0.60  },
    'gpt-4o':       { input: 5.00,  output: 15.00 },
    'gpt-4.1':      { input: 2.00,  output: 8.00  },
    'gpt-4.1-mini': { input: 0.40,  output: 1.60  },
    'gpt-5':        { input: 15.00, output: 60.00 },
    'gpt-5-mini':   { input: 1.50,  output: 6.00  },
    'o1':           { input: 15.00, output: 60.00 },
    'o3-mini':      { input: 1.10,  output: 4.40  },
  };

  // ─── Salva uso de tokens no banco para o dashboard de custos ───
  // Onda 2.2 (Fase 25) — tenant_id agora OBRIGATORIO pra isolar custos por
  // clinica e evitar vazamento entre tenants. Leads legacy sem tenant
  // recebem o UUID dummy (00000000-0000-0000-0000-000000000000).
  private async saveUsage(params: {
    tenant_id: string | null;
    conversation_id?: string | null;
    skill_id?: string | null;
    model: string;
    call_type: 'chat' | 'memory' | 'whisper';
    usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number } | null;
  }): Promise<void> {
    if (!params.usage) return;
    // Busca preço pelo prefixo do modelo (ex: 'gpt-4.1' cobre 'gpt-4.1-mini')
    const priceEntry = Object.entries(AiProcessor.OPENAI_PRICING)
      .find(([key]) => params.model.startsWith(key));
    const price = priceEntry ? priceEntry[1] : { input: 0.15, output: 0.60 };
    const costUsd =
      (params.usage.prompt_tokens     * price.input  / 1_000_000) +
      (params.usage.completion_tokens * price.output / 1_000_000);
    try {
      await (this.prisma as any).aiUsage.create({
        data: {
          // tenant_id obrigatorio — fallback dummy pra leads legacy
          tenant_id:       params.tenant_id || '00000000-0000-0000-0000-000000000000',
          conversation_id: params.conversation_id ?? null,
          skill_id:        params.skill_id ?? null,
          model:           params.model,
          call_type:       params.call_type,
          prompt_tokens:     params.usage.prompt_tokens,
          completion_tokens: params.usage.completion_tokens,
          total_tokens:      params.usage.total_tokens,
          cost_usd:          costUsd,
        },
      });
    } catch (e) {
      this.logger.warn(`[AI] Falha ao salvar AiUsage: ${e}`);
    }
  }

  // ─── Seleciona a skill baseado na especialidade ───
  private selectSkill(skills: any[], specialty: string | null): any | null {
    if (!skills.length) return null;
    if (specialty) {
      const specialist = skills.find(
        (s) =>
          s.area.toLowerCase().includes(specialty.toLowerCase()) ||
          specialty.toLowerCase().includes(s.area.toLowerCase()),
      );
      if (specialist) return specialist;
    }
    return (
      skills.find((s) =>
        ['geral', '*', 'triagem'].includes(s.area.toLowerCase()),
      ) || skills[0]
    );
  }

  // ─── Normaliza IDs de modelos (aliases → IDs reais da API) ───
  private normalizeModelId(model: string): string {
    const aliases: Record<string, string> = {
      'claude-haiku-4-5': 'claude-haiku-4-5-20251001',
      'claude-sonnet-4-5': 'claude-sonnet-4-5-20250514',
    };
    return aliases[model] || model;
  }

  // ─── Constrói header WAV para PCM raw (Gemini TTS retorna PCM 24kHz) ───
  private buildWavHeader(dataSize: number, sampleRate: number, channels: number, bitsPerSample: number): Buffer {
    const header = Buffer.alloc(44);
    const byteRate = sampleRate * channels * (bitsPerSample / 8);
    const blockAlign = channels * (bitsPerSample / 8);
    header.write('RIFF', 0);
    header.writeUInt32LE(36 + dataSize, 4);
    header.write('WAVE', 8);
    header.write('fmt ', 12);
    header.writeUInt32LE(16, 16);
    header.writeUInt16LE(1, 20); // PCM
    header.writeUInt16LE(channels, 22);
    header.writeUInt32LE(sampleRate, 24);
    header.writeUInt32LE(byteRate, 28);
    header.writeUInt16LE(blockAlign, 32);
    header.writeUInt16LE(bitsPerSample, 34);
    header.write('data', 36);
    header.writeUInt32LE(dataSize, 40);
    return header;
  }

  // ─── Parseia resposta JSON da IA com fallbacks robustos ───
  private parseAiResponse(raw: string): {
    reply: string;
    updates: any;
    scheduling_action?: NormalizedSchedulingAction;
    slots_to_offer?: { date: string; time: string; label: string }[];
    /** Paciente encerrou sem agendar → sistema manda a 2ª tentativa depois. */
    retry_scheduling?: boolean;
    /** Quem escreve NÃO é paciente (emprego, fornecedor, negócio…) — null = paciente. */
    nao_paciente?: NaoPacienteFlag | null;
    /** Ação da Carla (FINANCEIRO): reenviar boleto/PIX do próprio paciente. */
    financeiro_action?: FinanceiroAction | null;
  } {
    const extract = (parsed: any) => ({
      reply: parsed.reply ?? '',
      updates: parsed.updates || parsed.lead_update || {},
      // Normalizado: aceita a ação dentro de `updates`, solta no topo, com grafia
      // variante e data/hora em outros formatos (antes era descartada em silêncio).
      scheduling_action: this.normalizeActionLogged(parsed) || undefined,
      slots_to_offer: parsed.slots_to_offer || undefined,
      retry_scheduling: parsed.retry_scheduling === true || parsed.retry_scheduling === 'true',
      nao_paciente: normalizeNaoPaciente(parsed),
      financeiro_action: normalizeFinanceiroAction(parsed),
    });

    // 1. JSON puro
    try {
      const parsed = JSON.parse(raw);
      if ('reply' in parsed) return extract(parsed);
    } catch {}

    // 2. Markdown ```json ... ``` (com ou sem fechamento)
    const jsonMatch = raw.match(/```json?\s*([\s\S]*?)```/) ||
                      raw.match(/```json?\s*([\s\S]+)/); // ```json sem fechar
    if (jsonMatch) {
      try {
        const parsed = JSON.parse(jsonMatch[1].trim());
        if ('reply' in parsed) return extract(parsed);
      } catch {}
    }

    // 3. Extrair "reply" via regex (fallback para JSON truncado/malformado)
    const replyMatch = raw.match(/"reply"\s*:\s*"((?:[^"\\]|\\.)*)"/);
    if (replyMatch) {
      const reply = replyMatch[1]
        .replace(/\\n/g, '\n')
        .replace(/\\"/g, '"')
        .replace(/\\\\/g, '\\');
      this.logger.warn(`[AI] JSON malformado — reply extraído via regex (${reply.length} chars)`);
      // Tenta salvar o scheduling_action também (antes era perdido aqui).
      let scheduling_action: NormalizedSchedulingAction | undefined;
      const actionMatch = raw.match(/"scheduling_action"\s*:\s*(\{[^{}]*\})/);
      if (actionMatch) {
        try {
          scheduling_action = this.normalizeActionLogged({ scheduling_action: JSON.parse(actionMatch[1]) }) || undefined;
        } catch {
          // ação também malformada — segue sem
        }
      }
      // A ação financeira também pode ter vindo no JSON truncado — resgata por regex.
      let financeiro_action: FinanceiroAction | null = null;
      const finMatch = raw.match(/"financeiro_action"\s*:\s*(\{[^{}]*\})/);
      if (finMatch) {
        try { financeiro_action = normalizeFinanceiroAction({ financeiro_action: JSON.parse(finMatch[1]) }); } catch { /* malformado */ }
      }
      return {
        reply,
        updates: {},
        scheduling_action,
        retry_scheduling: /"retry_scheduling"\s*:\s*(?:true|"true")/.test(raw),
        nao_paciente: extractNaoPacienteFromRaw(raw),
        financeiro_action,
      };
    }

    this.logger.warn('[AI] Resposta não é JSON válido — usando como texto puro');
    return { reply: raw, updates: {} };
  }

  /** normalizeSchedulingAction + log quando o formato veio diferente do contrato. */
  private normalizeActionLogged(container: any): NormalizedSchedulingAction | null {
    const norm = normalizeSchedulingAction(container);
    const raw = container?.scheduling_action;
    const rawStr = raw === undefined ? undefined : JSON.stringify(raw);
    if (norm && rawStr !== JSON.stringify(norm)) {
      this.logger.warn(
        `[AI] scheduling_action normalizado: ${rawStr ?? '(fora do topo)'} → ${JSON.stringify(norm)}`,
      );
    } else if (!norm && raw != null && rawStr !== 'null') {
      this.logger.warn(`[AI] scheduling_action ignorado (ação desconhecida): ${String(rawStr).slice(0, 200)}`);
    }
    return norm;
  }

  /**
   * Baixa o conteúdo de uma Media via API interna (rota pública GET /media/:id).
   * A API serve do filesystem (prioritário) com fallback automático S3 → Evolution CDN.
   * Usar HTTP em vez de filesystem direto evita acoplar o worker ao volume montado.
   */
  private async fetchMediaBuffer(
    messageId: string,
  ): Promise<{ buffer: Buffer; contentType: string }> {
    // Dentro da network do Swarm, "api" resolve para o service via DNS interno.
    // INTERNAL_API_URL pode ser sobrescrito no env (ex: dev local).
    const apiUrl = process.env.INTERNAL_API_URL || 'http://api:3000';
    const response = await axios.get(`${apiUrl}/media/${messageId}`, {
      responseType: 'arraybuffer',
      timeout: 30_000,
      maxContentLength: 30 * 1024 * 1024, // 30MB
    });
    return {
      buffer: Buffer.from(response.data),
      contentType: (response.headers['content-type'] as string) || 'application/octet-stream',
    };
  }

  /** Verifica se a Media tem algum storage disponível (filesystem OU S3). */
  private hasMediaStorage(media: any | null): boolean {
    return !!(media?.file_path || media?.s3_key);
  }

  // ─── Auto-transcreve mensagens de áudio sem texto (Whisper) ───
  private async autoTranscribeAudios(
    messages: any[],
    ai: OpenAI,
  ): Promise<void> {
    for (const msg of messages) {
      // Só áudios recebidos do cliente sem transcrição
      if (msg.direction !== 'in' || msg.type !== 'audio' || msg.text) continue;

      // Retry apenas para mensagens recentes (< 2 min). Mensagens antigas sem mídia
      // são do sync-history e nunca terão storage — pular sem esperar.
      let media = msg.media ?? null;
      const msgAge = Date.now() - new Date(msg.created_at).getTime();
      const isRecent = msgAge < 2 * 60 * 1000; // < 2 minutos

      if (!this.hasMediaStorage(media) && isRecent) {
        // Polling com duas fases:
        // - Fase rápida (5×500ms = 2.5s): cobre download síncrono com pequeno atraso de commit
        // - Fase lenta (12×2000ms = 24s): cobre fallback assíncrono em áudios longos
        const phases = [
          { attempts: 5, delay: 500 },
          { attempts: 12, delay: 2000 },
        ];
        outer: for (const phase of phases) {
          for (let attempt = 1; attempt <= phase.attempts; attempt++) {
            await new Promise((r) => setTimeout(r, phase.delay));
            const found = await this.prisma.media.findFirst({
              where: { message_id: msg.id },
            });
            if (this.hasMediaStorage(found)) {
              media = found;
              break outer;
            }
            this.logger.log(
              `[AI] Aguardando mídia para msg ${msg.id} (delay=${phase.delay}ms tentativa ${attempt}/${phase.attempts})...`,
            );
          }
        }
      }
      if (!this.hasMediaStorage(media)) {
        msg.text = '[o cliente enviou um áudio mas não foi possível ouvir — peça educadamente para repetir por texto ou enviar outro áudio]';
        continue;
      }

      try {
        // Baixa via HTTP da API interna — serve do filesystem (prioritário)
        // ou S3 (compat com áudios antigos), de forma transparente.
        const { buffer, contentType } = await this.fetchMediaBuffer(msg.id);
        const mimeBase = contentType.split(';')[0].trim();
        const ext = mimeBase.split('/')[1] || 'ogg';

        const file = await toFile(buffer, `audio.${ext}`, { type: mimeBase });
        const result = await ai.audio.transcriptions.create({
          file,
          model: 'gpt-4o-transcribe',
          language: 'pt',
          prompt: 'Transcrição de mensagem de voz do WhatsApp em português brasileiro. O cliente está conversando com uma clínica odontológica sobre procedimentos, agendamentos ou dúvidas clínicas.',
        });

        const transcription = result.text?.trim() || '';
        if (transcription) {
          // Salva no banco para que próximos jobs não precisem retranscrever
          await this.prisma.message.update({
            where: { id: msg.id },
            data: { text: transcription },
          });
          msg.text = transcription; // atualiza in-memory
          this.logger.log(
            `[AI] Áudio transcrito (msg ${msg.id}, ${(buffer.length / 1024).toFixed(0)}KB): "${transcription.slice(0, 80)}"`,
          );
        }
      } catch (e: any) {
        this.logger.warn(
          `[AI] Falha ao transcrever áudio ${msg.id}: ${e.message}`,
        );
        msg.text = '[o cliente enviou um áudio mas não foi possível ouvir — peça educadamente para repetir por texto ou enviar outro áudio]';
      }
    }
  }

  // ─── Coleta imagens para visão (base64 inline) ───
  private async collectVisionImages(messages: any[]): Promise<
    { type: 'image_url'; image_url: { url: string } }[]
  > {
    const attachments: { type: 'image_url'; image_url: { url: string } }[] =
      [];

    for (const msg of messages) {
      if (msg.direction !== 'in' || msg.type !== 'image') continue;
      const media = msg.media ?? null;
      if (!this.hasMediaStorage(media)) continue;

      try {
        // HTTP GET na API interna (prioriza filesystem, fallback S3)
        const { buffer, contentType } = await this.fetchMediaBuffer(msg.id);
        const mimeBase = contentType.split(';')[0].trim();
        const base64 = buffer.toString('base64');
        attachments.push({
          type: 'image_url',
          image_url: { url: `data:${mimeBase};base64,${base64}` },
        });
        this.logger.log(
          `[AI] Imagem carregada para visão (msg ${msg.id}, ${(buffer.length / 1024).toFixed(0)}KB)`,
        );
      } catch (e: any) {
        this.logger.warn(
          `[AI] Falha ao carregar imagem ${msg.id}: ${e.message}`,
        );
      }
    }

    return attachments;
  }

  // ─── Aplica updates do JSON da IA no banco ───
  private async applyAiUpdates(
    updates: any,
    convoId: string,
    leadId: string,
    leadPhone: string,
    instanceName: string | null,
  ) {
    if (!updates || typeof updates !== 'object') return;

    // a. Nome do lead — sempre atualiza quando a IA extrai o nome real do contato.
    //    O pushName do WhatsApp (display name) é apenas um placeholder inicial;
    //    quando o usuário informa o próprio nome a IA o captura e substitui.
    if (updates.name && updates.name !== 'null' && updates.name.length >= 2) {
      await this.prisma.lead.update({
        where: { id: leadId },
        data: { name: updates.name },
      });
      this.logger.log(
        `[AI] Nome atualizado: "${updates.name}" → lead ${leadId}`,
      );

      // Nome salvo no banco (Lead.name) — Evolution API não tem endpoint para renomear contatos
    }

    // b. Status → Lead.stage
    // FINALIZADO vindo da IA ("encerrado") num contato que ainda é LEAD: ignora.
    // Só vira paciente quem compareceu ou pagou (a API promove) — FINALIZADO com
    // is_client=false sumia com a conversa das abas Leads E Clientes.
    let blockFinalizado = false;
    if (updates.status === 'FINALIZADO' || (!updates.status && updates.next_step === 'encerrado')) {
      const who = await this.prisma.lead.findUnique({ where: { id: leadId }, select: { is_client: true } });
      if (!who?.is_client) {
        blockFinalizado = true;
        this.logger.log(`[AI] Lead ${leadId}: IA pediu FINALIZADO mas o contato ainda é lead — stage mantido`);
      }
    }
    let resolvedStage: string | null = null;
    if (updates.status && updates.status !== 'null' && !(blockFinalizado && updates.status === 'FINALIZADO')) {
      const stageData: Record<string, any> = { stage: updates.status, stage_entered_at: new Date() };
      // Se for PERDIDO, salvar loss_reason junto
      if (updates.status === 'PERDIDO' && updates.loss_reason) {
        stageData.loss_reason = updates.loss_reason;
      }
      await this.prisma.lead.update({ where: { id: leadId }, data: stageData });
      resolvedStage = updates.status;
      this.logger.log(`[AI] Lead.stage → "${updates.status}"${updates.loss_reason ? ` (motivo: ${updates.loss_reason})` : ''}`);
    } else if (!updates.status && updates.next_step) {
      // Se a IA enviou next_step mas esqueceu o status, inferir o stage automaticamente
      const inferMap: Record<string, string> = {
        formulario:        'AGUARDANDO_FORM',
        reuniao:           'REUNIAO_AGENDADA',
        documentos:        'AGUARDANDO_DOCS',
        procuracao:        'AGUARDANDO_PROC',
        encerrado:         'FINALIZADO',
        triagem_concluida: 'QUALIFICANDO',
        perdido:           'PERDIDO',
      };
      const inferred = inferMap[updates.next_step];
      if (inferred && !(blockFinalizado && inferred === 'FINALIZADO')) {
        const stageData: Record<string, any> = { stage: inferred, stage_entered_at: new Date() };
        // Quando lead é perdido, salvar motivo se fornecido
        if (inferred === 'PERDIDO' && updates.loss_reason) {
          stageData.loss_reason = updates.loss_reason;
        }
        await this.prisma.lead.update({ where: { id: leadId }, data: stageData });
        resolvedStage = inferred;
        this.logger.log(`[AI] Stage inferido do next_step "${updates.next_step}": ${inferred}${updates.loss_reason ? ` (motivo: ${updates.loss_reason})` : ''}`);
      }
    } else if (updates.status === 'PERDIDO' && updates.loss_reason) {
      // Se a IA enviou PERDIDO diretamente no status, salvar loss_reason também
      await this.prisma.lead.update({ where: { id: leadId }, data: { loss_reason: updates.loss_reason } });
    }

    // === AUTOMAÇÃO: Criar tarefas automáticas baseado no novo stage ===
    if (resolvedStage) {
      try {
        const conv = await (this.prisma as any).conversation.findUnique({
          where: { id: convoId },
          select: { assigned_dentist_id: true },
        });
        const dentistId = conv?.assigned_dentist_id;

        if (dentistId) {
          const taskMap: Record<string, string> = {
            AGUARDANDO_DOCS: 'Cobrar documentos do lead',
            AGUARDANDO_PROC: 'Cobrar procuração do lead',
            AGUARDANDO_FORM: 'Acompanhar preenchimento do formulário',
          };
          const taskTitle = taskMap[resolvedStage];
          if (taskTitle) {
            const lead = await this.prisma.lead.findUnique({
              where: { id: leadId },
              select: { name: true },
            });
            await this.createCalendarEvent({
              type: 'TAREFA',
              title: `${taskTitle} — ${lead?.name || 'Lead'}`,
              description: `Tarefa automática criada pela IA ao mover lead para ${resolvedStage}`,
              // Agenda é naive-UTC: "daqui a 24h" parte do agora de Maceió (senão a
              // tarefa caía 3h depois do horário em que foi criada).
              start_at: new Date(maceioNowNaive().getTime() + 24 * 60 * 60 * 1000),
              assigned_user_id: dentistId,
              lead_id: leadId,
              conversation_id: convoId,
              created_by_id: dentistId,
            });
            this.logger.log(
              `[AI] Tarefa automática criada: "${taskTitle}" para dentista ${dentistId}`,
            );
          }
        }
      } catch (e: any) {
        this.logger.warn(`[AI] Falha ao criar tarefa automática: ${e.message}`);
      }
    }

    // c. Especialidade → Conversation.specialty (só se não classificada) + auto-atribuir especialista
    if (updates.area && updates.area !== 'null') {
      const conv = await (this.prisma as any).conversation.findUnique({
        where: { id: convoId },
        select: { specialty: true, assigned_dentist_id: true },
      });
      if (!conv?.specialty) {
        await (this.prisma as any).conversation.update({
          where: { id: convoId },
          data: { specialty: updates.area },
        });
        this.logger.log(`[AI] Especialidade classificada: "${updates.area}"`);

        // Auto-atribuir o especialista menos ocupado (só se ainda não houver um)
        if (!conv?.assigned_dentist_id) {
          const dentistId = await this.findLeastBusySpecialist(updates.area);
          if (dentistId) {
            await (this.prisma as any).conversation.update({
              where: { id: convoId },
              data: { assigned_dentist_id: dentistId },
            });
            this.logger.log(
              `[AI] Especialista pré-atribuído: ${dentistId} (especialidade: ${updates.area})`,
            );
          }
        }
      }
    }

    // d. lead_summary → AiMemory: REMOVIDO em 2026-04-20
    //
    // O sistema novo (LeadProfile + Memory entries via extracao batch noturna
    // e ProfileConsolidationProcessor) agora e a fonte unica de verdade para
    // contexto do lead. Ver MEMORY_SYSTEM.md secao 9.6 (migracao case_state).
    //
    // A leitura de AiMemory continua na linha ~970 como fallback para leads
    // sem LeadProfile (principalmente os 19 leads legacy sem tenant_id que
    // nao puderam ser migrados em massa).

    // e. next_step + notes → Conversation
    const convUpdate: any = {};
    if (updates.next_step) convUpdate.next_step = updates.next_step;
    if (updates.notes) convUpdate.ai_notes = updates.notes;
    if (Object.keys(convUpdate).length > 0) {
      await (this.prisma as any).conversation.update({
        where: { id: convoId },
        data: convUpdate,
      });
    }

    // f. form_data → Auto-preencher FichaTrabalhista (área Trabalhista)
    if (updates.form_data && typeof updates.form_data === 'object') {
      const formFields = updates.form_data;
      // Filtrar campos null/undefined
      const cleanFields: Record<string, any> = {};
      for (const [key, value] of Object.entries(formFields)) {
        if (value !== null && value !== undefined && value !== 'null') {
          cleanFields[key] = value;
        }
      }
      if (Object.keys(cleanFields).length > 0) {
        try {
          const ficha = await (this.prisma as any).fichaTrabalhista.upsert({
            where: { lead_id: leadId },
            update: {},
            create: { lead_id: leadId, data: {} },
          });
          const oldData = (ficha.data as Record<string, any>) || {};
          const merged = { ...oldData, ...cleanFields };
          const totalFields = 76;
          const filled = Object.values(merged).filter(
            (v) => v !== null && v !== undefined && v !== '',
          ).length;
          const pct = Math.min(100, Math.round((filled / totalFields) * 100));

          await (this.prisma as any).fichaTrabalhista.update({
            where: { lead_id: leadId },
            data: {
              data: merged,
              nome_completo: cleanFields.nome_completo ?? ficha.nome_completo,
              nome_empregador: cleanFields.nome_empregador ?? ficha.nome_empregador,
              completion_pct: pct,
              filled_by: 'ai',
            },
          });
          this.logger.log(
            `[AI] Ficha trabalhista atualizada: ${Object.keys(cleanFields).length} campo(s), ${pct}%`,
          );
        } catch (e: any) {
          this.logger.warn(`[AI] Falha ao atualizar ficha trabalhista: ${e.message}`);
        }
      }
    }

    // g. Se next_step = "formulario" e especialidade = Trabalhista, preencher ficha com memória
    if (updates.next_step === 'formulario') {
      try {
        const conv = await (this.prisma as any).conversation.findUnique({
          where: { id: convoId },
          select: { specialty: true },
        });
        if (conv?.specialty?.toLowerCase().includes('trabalhist')) {
          const memory = await this.prisma.aiMemory.findUnique({
            where: { lead_id: leadId },
          });
          if (memory?.facts_json) {
            const facts = memory.facts_json as any;
            const mappedData: Record<string, string> = {};
            if (facts.lead?.full_name) mappedData.nome_completo = facts.lead.full_name;
            if (facts.lead?.cpf) mappedData.cpf = facts.lead.cpf;
            if (facts.lead?.city) mappedData.cidade = facts.lead.city;
            if (facts.lead?.state) mappedData.estado_uf = facts.lead.state;
            if (facts.lead?.phones?.[0]) mappedData.telefone = facts.lead.phones[0];
            if (facts.lead?.emails?.[0]) mappedData.email = facts.lead.emails[0];
            if (facts.lead?.mother_name) mappedData.nome_mae = facts.lead.mother_name;
            if (facts.parties?.counterparty_name) mappedData.nome_empregador = facts.parties.counterparty_name;
            if (facts.parties?.counterparty_id) mappedData.cnpjcpf_empregador = facts.parties.counterparty_id;
            if (facts.facts?.current?.employment_status) mappedData.situacao_atual = facts.facts.current.employment_status;
            if (facts.facts?.current?.main_issue) mappedData.motivos_reclamacao = facts.facts.current.main_issue;
            const kv = facts.facts?.current?.key_values || {};
            if (kv.salario) mappedData.salario = String(kv.salario);
            const kd = facts.facts?.current?.key_dates || {};
            if (kd.admissao) mappedData.data_admissao = kd.admissao;
            if (kd.demissao || kd.saida) mappedData.data_saida = kd.demissao || kd.saida;

            if (Object.keys(mappedData).length > 0) {
              const ficha = await (this.prisma as any).fichaTrabalhista.upsert({
                where: { lead_id: leadId },
                update: {},
                create: { lead_id: leadId, data: {} },
              });
              const merged = { ...(ficha.data as Record<string, any>), ...mappedData };
              const totalFields = 76;
              const filled = Object.values(merged).filter((v) => v != null && v !== '').length;
              const pct = Math.min(100, Math.round((filled / totalFields) * 100));

              await (this.prisma as any).fichaTrabalhista.update({
                where: { lead_id: leadId },
                data: {
                  data: merged,
                  nome_completo: mappedData.nome_completo ?? ficha.nome_completo,
                  nome_empregador: mappedData.nome_empregador ?? ficha.nome_empregador,
                  completion_pct: pct,
                  filled_by: 'ai',
                },
              });
              this.logger.log(
                `[AI] Ficha trabalhista preenchida da memória: ${Object.keys(mappedData).length} campo(s)`,
              );
            }
          }
        }
      } catch (e: any) {
        this.logger.warn(`[AI] Falha ao preencher ficha da memória: ${e.message}`);
      }
    }

    // ─── CRM dinâmico (Fase 4): pipeline_slug + stage_slug ───
    // A IA retorna slugs do bloco "FUNIS DISPONÍVEIS" injetado no prompt.
    // Resolve em pipeline_id/stage_id e atualiza o Lead. Funciona em AMBOS
    // os paths (com tools via respond_to_client OU JSON inline parser legado).
    if (updates.stage_slug || updates.pipeline_slug) {
      try {
        const pipeUpdate = await resolveStageUpdate(this.prisma as any, leadId, {
          stage_slug: updates.stage_slug,
          pipeline_slug: updates.pipeline_slug,
        });
        if (pipeUpdate.warnings.length) {
          this.logger.warn(
            `[AI] CRM dinâmico lead ${leadId} (stage_slug=${updates.stage_slug}, pipeline_slug=${updates.pipeline_slug}): ${pipeUpdate.warnings.join('; ')}`,
          );
        }
        if (pipeUpdate.data) {
          await (this.prisma as any).lead.update({ where: { id: leadId }, data: pipeUpdate.data });
          this.logger.log(
            `[AI] CRM dinâmico aplicado ao lead ${leadId}: ${JSON.stringify(pipeUpdate.data)}` +
              (pipeUpdate.pipelineName ? ` — lançado no funil "${pipeUpdate.pipelineName}"` : '') +
              (pipeUpdate.stageName ? ` / etapa "${pipeUpdate.stageName}"` : ''),
          );
        }
      } catch (e: any) {
        this.logger.error(`[AI] Falha ao aplicar CRM dinâmico: ${e.message}`);
      }
    }
  }

  // ─── Cria CalendarEvent diretamente + enfileira lembretes ───
  // ⚠️ Anti-duplicação (reagendamento): se já existir CONSULTA ATIVA pra essa
  // conversa, CANCELA o evento antigo antes de criar o novo. Evita o cenário
  // onde lead pediu remarcar e ficavam 2 eventos na agenda do dentista (o
  // antigo + o novo). Reminders não enviados do antigo são deletados (cascade
  // via onDelete não rola porque só CANCELAMOS, não deletamos — então fazemos
  // delete explícito dos EventReminder com sent_at=null).
  private async createCalendarEvent(params: {
    type: string;
    title: string;
    description?: string;
    start_at: Date;
    end_at?: Date;
    assigned_user_id: string;
    lead_id: string;
    conversation_id?: string;
    created_by_id: string;
  }): Promise<any> {
    // Anti-duplicação: cancelar consultas ativas anteriores da MESMA conversa
    if (params.conversation_id && params.type === 'CONSULTA') {
      const existing = await (this.prisma as any).calendarEvent.findMany({
        where: {
          conversation_id: params.conversation_id,
          type: 'CONSULTA',
          status: { notIn: ['CANCELADO', 'CONCLUIDO'] },
        },
        select: { id: true, start_at: true, status: true },
      });

      for (const old of existing) {
        // Marca como cancelado (preserva histórico no audit)
        await (this.prisma as any).calendarEvent.update({
          where: { id: old.id },
          data: {
            status: 'CANCELADO',
            description: `[CANCELADO automaticamente — reagendamento via IA em ${new Date().toISOString()}]`,
          },
        });

        // Remove reminders pendentes (não enviados ainda)
        // Os jobs no BullMQ vão tentar disparar mas vão checar status
        // do CalendarEvent — como tá CANCELADO, devem skip.
        await (this.prisma as any).eventReminder.deleteMany({
          where: { event_id: old.id, sent_at: null },
        });

        this.logger.log(
          `[AI] Reagendamento detectado — evento antigo CANCELADO: id=${old.id} start=${old.start_at.toISOString()}`,
        );
      }
    }

    const event = await this.prisma.calendarEvent.create({
      data: {
        type: params.type,
        title: params.title,
        description: params.description,
        start_at: params.start_at,
        end_at: params.end_at || new Date(params.start_at.getTime() + 30 * 60 * 1000),
        status: 'AGENDADO',
        priority: 'NORMAL',
        assigned_user_id: params.assigned_user_id,
        lead_id: params.lead_id,
        conversation_id: params.conversation_id,
        created_by_id: params.created_by_id,
        reminders: {
          create: [
            { minutes_before: 60, channel: 'WHATSAPP' },
            { minutes_before: 1440, channel: 'WHATSAPP' },
          ],
        },
      },
      include: { reminders: true },
    });

    // Enqueue WhatsApp reminders — mesma conta da API (calendar.service.enqueueReminders):
    // start_at é naive (Maceió), instante real = naive + 3h; < 1 min de antecedência pula.
    for (const r of event.reminders) {
      const delay = reminderDelayMs(event.start_at, r.minutes_before);
      if (delay >= REMINDER_MIN_DELAY_MS) {
        await this.reminderQueue.add(
          'send-reminder',
          { reminderId: r.id, eventId: event.id, channel: r.channel },
          // ANTI-DUPLICIDADE (espelha calendar.service/book-appointment): jobId ESTÁVEL
          // (dedup natural do BullMQ) + attempts:1. Sem isto herdava attempts:3 e, como o
          // processor reseta sent_at na falha, uma entrega-com-erro da Evolution reenviava
          // ao paciente. (Latente: só via autobook da IA, default OFF.)
          { delay, jobId: `reminder-${r.id}`, attempts: 1, removeOnComplete: true, removeOnFail: 50 },
        );
      }
    }

    this.logger.log(
      `[AI] CalendarEvent criado: "${params.title}" (${params.type}) para ${params.assigned_user_id}`,
    );
    return event;
  }

  /**
   * v28: Quando safeguard cancela evento + IA nao propos horarios novos,
   * buscamos 2-3 slots disponiveis nos proximos 7 dias e appendamos uma
   * proposta amigavel na resposta da IA. Garante estrategia de venda
   * (nunca aceita "no" passivo sem oferecer alternativa).
   *
   * Retorna string formatada pra concat, ou null se nao tem dados suficientes.
   */
  private async buildRescheduleSuggestion(
    convo: any,
    opts: {
      /** Continua uma resposta da IA ("Sem problemas! Vou te passar outros horários.")
       *  → sem saudação nem "sem problema" repetidos. */
      continuing?: boolean;
      /** Horários que NÃO podem voltar na oferta (o que o paciente acabou de largar). */
      exclude?: { date: string; time: string }[];
      /** Chat de teste: não grava o lock-in do Orçamentista. */
      readOnly?: boolean;
    } = {},
  ): Promise<string | null> {
    try {
      // Onda 19: usa o Orçamentista (o MESMO dentista que o confirm_slot marca),
      // não o assigned cru — o convo em memória pode estar desatualizado e o
      // fallback assigned_user_id podia ser um operador (não-dentista).
      const dentistId =
        (await ensureOrcamentistaAssigned(this.prisma as any, convo.id, {
          tenantId: convo.tenant_id || convo.lead?.tenant_id || undefined,
          readOnly: !!opts.readOnly,
        })) ||
        (convo as any).assigned_dentist_id;
      if (!dentistId) return null;
      const tz = 'America/Maceio';
      const formatDateBR = (d: Date) =>
        d.toLocaleDateString('pt-BR', { timeZone: tz, weekday: 'short', day: '2-digit', month: '2-digit' });
      // Coleta dias com vaga (UTC-consistente + rótulo ancorado ao meio-dia UTC).
      const daysWithSlots: { label: string; dateStr: string; times: string[] }[] = [];
      const startDate = new Date(Date.now() - 3 * 60 * 60 * 1000); // -3h = "agora" em Maceió (naive-UTC)
      startDate.setUTCDate(startDate.getUTCDate() + 1); // começa amanhã (UTC naive)
      for (let i = 0; i < 14 && daysWithSlots.length < 5; i++) {
        const day = new Date(startDate.getTime());
        day.setUTCDate(day.getUTCDate() + i);
        const dateStr = day.toISOString().split('T')[0];
        const anchor = new Date(`${dateStr}T12:00:00Z`);
        if (anchor.getUTCDay() === 0) continue; // pula domingo
        const dayslots = await this.getAvailability(
          dentistId,
          dateStr,
          60,
          convo.tenant_id || convo.lead?.tenant_id || null,
        );
        const excluded = new Set((opts.exclude || []).filter((x) => x.date === dateStr).map((x) => x.time));
        const times = dayslots.map((s) => s.start).filter((t) => !excluded.has(t));
        if (times.length > 0) {
          daysWithSlots.push({ label: formatDateBR(anchor), dateStr, times });
        }
      }
      if (daysWithSlots.length === 0) return null;
      // Mesma curadoria da PROPOSTA SUGERIDA (pickSuggestedSlots): máx 2 dias, o
      // mais cedo de cada + 1 da tarde (nunca 3 do mesmo dia), em ordem cronológica.
      const labelOf = new Map(daysWithSlots.map((d) => [d.dateStr, d.label]));
      const picks = pickSuggestedSlots(daysWithSlots.map((d) => ({ date: d.dateStr, times: d.times })));
      if (picks.length === 0) return null;
      const firstName = (convo.lead?.name || '').split(' ')[0] || '';
      const greeting = firstName ? `${firstName}, ` : '';
      const intro = opts.continuing
        ? 'Tenho estes horários livres:'
        : `${greeting}sem problema! Consegui te encaixar bem pertinho:`;
      const lines = picks.map((s) => `• ${labelOf.get(s.date) || s.date} às ${s.time}`).join('\n');
      const cta = '\nAlgum desses serve melhor pra você?';
      return `${intro}\n${lines}${cta}`;
    } catch (e: any) {
      this.logger.warn(`[AI] buildRescheduleSuggestion falhou: ${e.message}`);
      return null;
    }
  }

  // ─── Consulta disponibilidade de horários de um dentista ───
  // Onda 19: delega pra computeDaySlots (a MESMA fonte do check_availability e,
  // por consequência, coerente com o book-appointment). A implementação anterior
  // aqui estava QUEBRADA desde a migração multi-turno (2026-05-03): usava
  // findUnique sobre o @@unique([user_id,day_of_week]) que foi REMOVIDO →
  // PrismaClientValidationError em toda chamada → {{available_slots}} sempre caía
  // no catch ("Erro ao consultar horários"). Além disso lia hora LOCAL em vez de
  // UTC naive. computeDaySlots corrige tudo (multi-turno, UTC, ScheduleBlock,
  // feriado recorrente). `tenantId` = clínica REAL da conversa (inclui o tenant
  // all-zeros do Instituto): só os feriados dela + globais fecham o dia.
  private async getAvailability(
    userId: string,
    dateStr: string,
    durationMinutes: number,
    tenantId: string | null,
  ): Promise<{ start: string; end: string }[]> {
    const starts = await computeDaySlots(this.prisma as any, userId, dateStr, durationMinutes, tenantId);
    return starts.map((start) => {
      const [h, m] = start.split(':').map(Number);
      const endMin = h * 60 + m + durationMinutes;
      const end = `${String(Math.floor(endMin / 60)).padStart(2, '0')}:${String(endMin % 60).padStart(2, '0')}`;
      return { start, end };
    });
  }

  // ─── Encontra o especialista menos ocupado para uma especialidade ───
  private async findLeastBusySpecialist(area: string): Promise<string | null> {
    const allUsers = await (this.prisma as any).user.findMany({
      where: { specialties: { isEmpty: false } },
      select: { id: true, specialties: true },
    });

    const areaLower = area.toLowerCase();
    const specialists = (allUsers as any[]).filter((u) =>
      u.specialties.some(
        (s: string) =>
          s.toLowerCase().includes(areaLower) ||
          areaLower.includes(s.toLowerCase()),
      ),
    );

    if (!specialists.length) {
      this.logger.warn(
        `[AI] Nenhum especialista encontrado para área: "${area}"`,
      );
      return null;
    }

    const counts = await Promise.all(
      specialists.map(async (s) => {
        const count = await (this.prisma as any).conversation.count({
          where: { assigned_dentist_id: s.id, status: 'ABERTO' },
        });
        return { id: s.id as string, count };
      }),
    );

    counts.sort((a, b) => a.count - b.count);
    this.logger.log(
      `[AI] Especialistas disponíveis para "${area}": ${counts.map((c) => `${c.id}(${c.count})`).join(', ')}`,
    );
    return counts[0]?.id ?? null;
  }

  // updateLongMemory() REMOVIDO em 2026-04-20 — Divida 2 do MEMORY_SYSTEM.md.
  //
  // Sistema antigo: chamada GPT-4.1 a cada mensagem pra atualizar AiMemory.
  // Custo: ~$0.03 por mensagem recebida. Escrevia case_state em JSON verboso.
  //
  // Sistema novo: extracao batch noturna (DailyMemoryBatchProcessor 00h)
  // processa TODAS as conversas do dia de uma vez. Memory entries sao
  // consolidadas pelo ProfileConsolidationProcessor (incremental 02h) em
  // LeadProfile.summary (prosa natural). Custo: ~$0.01/dia por tenant
  // (constante, ~70% menor).

  // ─── Processo principal ───
  async process(job: Job<any, any, string>): Promise<any> {
    this.logger.log(`Iniciando job de IA: ${job.id}`);

    // 1. Ler chave OpenAI do banco
    const openAiKey = await this.settings.getOpenAiKey();
    if (!openAiKey) {
      this.logger.warn(
        'OPENAI_API_KEY não configurada — configure em Ajustes IA',
      );
      return;
    }

    const { conversation_id } = job.data;

    if (!conversation_id) {
      this.logger.warn(`[AI] Job ${job.id} sem conversation_id — ignorando (payload: ${JSON.stringify(job.data).slice(0, 100)})`);
      return;
    }

    // Chat de teste (Ajustes › IA): roda o MESMO cérebro numa conversa em memória —
    // nada é enviado pro WhatsApp nem gravado (mensagem, lead, agenda, custo).
    const dryRun = job.data?.dryRun === true;
    // 2ª tentativa de agendamento (job 'ai-scheduling-retry', agendado por este
    // processor depois que o paciente encerrou sem agendar). No dryRun é o "Ver como
    // seria" da tela: roda só a instrução da tentativa, sem checagens de banco.
    const isSchedulingRetry = job.data?.schedulingRetry === true;

    try {
      // 2. Buscar conversa + lead + últimas 20 mensagens com mídia incluída
      // orderBy desc para pegar as mais RECENTES; invertemos abaixo para ordem cronológica
      const convo: any = dryRun ? await this.buildTestConversation(job.data) : await this.prisma.conversation.findUnique({
        where: { id: conversation_id },
        include: {
          lead: true,
          messages: {
            orderBy: { created_at: 'desc' },
            take: 80,
            include: { media: true },
          },
        },
      });

      // 3. Verificar ai_mode ativo
      if (!convo) {
        if (isSchedulingRetry) this.logger.log(`[AI-RETRY] Job ${job.id} abortado — conversa ${conversation_id} não existe mais`);
        return;
      }

      // 3a. Quando ai_mode=false (operador humano atende), nada a fazer aqui.
      //
      // O sistema antigo atualizava AiMemory sincronamente neste ponto. Hoje,
      // a extracao batch noturna (DailyMemoryBatchProcessor 00h) processa as
      // conversas de operadores humanos junto com as da IA, gerando Memory
      // entries e atualizando LeadProfile automaticamente.
      if (!convo.ai_mode) {
        if (isSchedulingRetry) this.logger.log(`[AI-RETRY] Job ${job.id} abortado — IA desligada na conversa ${conversation_id} (humano atende)`);
        return;
      }

      if (isSchedulingRetry) {
        // 3b'. 2ª tentativa: a última mensagem É nossa, de propósito — pula o
        // anti-stale. Mas aborta se o paciente respondeu, se outra mensagem saiu
        // depois (operador/disparo) ou se um humano assumiu a conversa.
        if (!dryRun) {
          const abortReason = this.schedulingRetryAbortReason(convo, job.data);
          if (abortReason) {
            this.logger.log(`[AI-RETRY] Job ${job.id} abortado (conv ${conversation_id}): ${abortReason}`);
            return;
          }
        }
      } else {
        // 3b. Anti-stale check — aborta job duplicado/obsoleto
        // Mensagens carregadas em ordem DESC: convo.messages[0] = mais recente.
        // Se a mensagem mais recente já é outbound (IA/operador respondeu), não há nada a responder.
        // Isso ocorre quando dois jobs são enfileirados quase ao mesmo tempo (race condition)
        // e o segundo encontra a conversa já respondida pelo primeiro.
        const mostRecentMsg = convo.messages[0];
        if (mostRecentMsg && mostRecentMsg.direction === 'out') {
          this.logger.warn(
            `[AI] Job ${job.id} abortado — última msg já é outbound (race condition evitada) para conv ${conversation_id}`,
          );
          return;
        }
      }

      // 4. (Debounce gerenciado no enqueue — evolution.service.ts)
      // O job só chega aqui após o silêncio do lead (delay configurável em Ajustes IA).
      // Não há mais cooldown guard aqui; o processor simplesmente processa todas as
      // mensagens acumuladas no histórico de uma só vez.

      const ai = new OpenAI({ apiKey: openAiKey });

      // 5. Auto-transcrever áudios sem texto (Whisper) — salva no banco
      await this.autoTranscribeAudios(convo.messages as any[], ai);

      // 6. Carregar AiMemory (Long Memory) do lead
      const memory = await this.prisma.aiMemory.findUnique({
        where: { lead_id: convo.lead_id },
      });
      const factsJson = (memory?.facts_json as any) || null;

      // Montar memória legível COMPLETA para injeção no prompt
      // Quanto mais detalhada, menos chance de repetir perguntas
      let leadMemory = 'Nenhuma memória anterior — primeiro contato.';
      if (memory && (memory.summary || factsJson)) {
        const parts: string[] = [];
        if (memory.summary) parts.push(`📋 Resumo: ${memory.summary}`);
        // Dados do lead
        if (factsJson?.lead) {
          const l = factsJson.lead;
          const leadParts: string[] = [];
          if (l.full_name) leadParts.push(`Nome: ${l.full_name}`);
          if (l.first_name && !l.full_name) leadParts.push(`Nome: ${l.first_name}`);
          if (l.cpf) leadParts.push(`CPF: ${l.cpf}`);
          if (l.mother_name) leadParts.push(`Mãe: ${l.mother_name}`);
          if (l.city) leadParts.push(`Cidade: ${l.city}`);
          if (l.state) leadParts.push(`Estado: ${l.state}`);
          if (l.phones?.length) leadParts.push(`Telefone(s): ${l.phones.join(', ')}`);
          if (l.emails?.length) leadParts.push(`Email(s): ${l.emails.join(', ')}`);
          if (leadParts.length) parts.push(`👤 Dados do Lead: ${leadParts.join(' | ')}`);
        }
        // Caso
        // Suporte a múltiplos processos (facts.cases[]) + backward compat (facts.case)
        const allCases: any[] = factsJson?.cases || (factsJson?.case ? [factsJson.case] : []);
        if (allCases.length === 1) {
          const c = allCases[0];
          const caseParts: string[] = [];
          if (c.case_number) caseParts.push(`Nº: ${c.case_number}`);
          if (c.area) caseParts.push(`Área: ${c.area}`);
          if (c.tracking_stage) caseParts.push(`Estágio: ${c.tracking_stage}`);
          if (c.status) caseParts.push(`Status: ${c.status}`);
          if (c.summary) caseParts.push(`Resumo: ${c.summary}`);
          if (c.opposing_party) caseParts.push(`Parte contrária: ${c.opposing_party}`);
          if (c.subarea) caseParts.push(`Subárea: ${c.subarea}`);
          if (c.tags?.length) caseParts.push(`Tags: ${c.tags.join(', ')}`);
          if (caseParts.length) parts.push(`⚖️ Processo: ${caseParts.join(' | ')}`);
        } else if (allCases.length > 1) {
          const caseLines = allCases.map((c: any, i: number) => {
            const p: string[] = [];
            if (c.case_number) p.push(`Nº: ${c.case_number}`);
            if (c.area) p.push(c.area);
            if (c.tracking_stage) p.push(`Estágio: ${c.tracking_stage}`);
            if (c.opposing_party) p.push(`vs ${c.opposing_party}`);
            return `  ${i + 1}. ${p.join(' | ')}`;
          });
          parts.push(`⚖️ Processos (${allCases.length}):\n${caseLines.join('\n')}`);
        }
        // Partes
        if (factsJson?.parties) {
          const p = factsJson.parties;
          const partyParts: string[] = [];
          if (p.client_role) partyParts.push(`Papel do cliente: ${p.client_role}`);
          if (p.counterparty_name) partyParts.push(`Parte contrária: ${p.counterparty_name}`);
          if (p.counterparty_id) partyParts.push(`CNPJ/CPF contrária: ${p.counterparty_id}`);
          if (p.counterparty_type) partyParts.push(`Tipo: ${p.counterparty_type}`);
          if (partyParts.length) parts.push(`🏢 Partes: ${partyParts.join(' | ')}`);
        }
        // Fatos
        if (factsJson?.facts) {
          const f = factsJson.facts;
          if (f.current) {
            const curParts: string[] = [];
            if (f.current.employment_status) curParts.push(`Situação: ${f.current.employment_status}`);
            if (f.current.main_issue) curParts.push(`Problema: ${f.current.main_issue}`);
            if (f.current.key_dates && Object.keys(f.current.key_dates).length) {
              curParts.push(`Datas: ${Object.entries(f.current.key_dates).map(([k,v]) => `${k}=${v}`).join(', ')}`);
            }
            if (f.current.key_values && Object.keys(f.current.key_values).length) {
              curParts.push(`Valores: ${Object.entries(f.current.key_values).map(([k,v]) => `${k}=${v}`).join(', ')}`);
            }
            if (curParts.length) parts.push(`📌 Situação atual: ${curParts.join(' | ')}`);
          }
          if (f.core_facts?.length)
            parts.push(`📝 Fatos-chave:\n${f.core_facts.map((fact: string, i: number) => `  ${i+1}. ${fact}`).join('\n')}`);
          if (f.timeline?.length) {
            const events = f.timeline.filter((t: any) => t?.event).slice(-10);
            if (events.length)
              parts.push(`📅 Timeline:\n${events.map((t: any) => `  - ${t.date || '?'}: ${t.event} (${t.origin || '?'})`).join('\n')}`);
          }
        }
        // Evidências
        if (factsJson?.evidence?.items?.length) {
          const evItems = factsJson.evidence.items
            .filter((e: any) => e?.type)
            .map((e: any) => `${e.type}(${e.status || '?'})${e.notes ? ': '+e.notes : ''}`);
          if (evItems.length)
            parts.push(`📎 Evidências: ${evItems.join('; ')}`);
        }
        // Perguntas pendentes
        if (factsJson?.open_questions?.length)
          parts.push(`❓ Perguntas AINDA pendentes (pergunte estas):\n${factsJson.open_questions.map((q: string, i: number) => `  ${i+1}. ${q}`).join('\n')}`);
        // Próximas ações
        if (factsJson?.next_actions?.length)
          parts.push(`🎯 Próximas ações: ${factsJson.next_actions.join('; ')}`);

        // Histórico de etapas CRM (kanban de leads)
        if (factsJson?.crm_timeline?.length) {
          const entries = (factsJson.crm_timeline as any[]).slice(-10);
          parts.push(`🏷️ Jornada no CRM:\n${entries.map((e: any) => `  - ${e.date}: ${e.from || 'início'} → ${e.to}${e.loss_reason ? ` (${e.loss_reason})` : ''}`).join('\n')}`);
        }
        // Histórico de etapas do processo judicial
        if (factsJson?.case_timeline?.length) {
          const entries = (factsJson.case_timeline as any[]).slice(-10);
          parts.push(`⚖️ Histórico do Processo:\n${entries.map((e: any) => `  - ${e.date}: ${e.from || 'início'} → ${e.to}${e.case_number ? ` (${e.case_number})` : ''}`).join('\n')}`);
        }
        // Petições protocoladas/aprovadas
        if (factsJson?.petitions?.length) {
          const pItems = (factsJson.petitions as any[]).slice(-5);
          parts.push(`📄 Petições: ${pItems.map((p: any) => `${p.type}(${p.status})${p.date ? ' em '+p.date : ''}`).join('; ')}`);
        }
        // Publicações DJEN analisadas
        if (factsJson?.djen_publications?.length) {
          const dItems = (factsJson.djen_publications as any[]).slice(0, 5);
          parts.push(`📰 DJEN (${dItems.length} pub.):\n${dItems.map((d: any) => `  - ${d.date}: ${d.tipo}${d.assunto ? ' — '+d.assunto : ''}. ${d.resumo || ''}`).join('\n')}`);
        }

        if (parts.length) leadMemory = parts.join('\n');
      }

      // 6b. Função do CHIP da conversa (Comercial/Clínica/Financeiro) — define as
      // skills elegíveis (8.0) e o PERFIL da IA (nome, assinatura, tamanho). Erro ao
      // resolver = sem função (usa todas as skills e o perfil padrão), não silêncio.
      let chipPurpose: string | null = null;
      let chipTenantId: string | null = null;
      try {
        if (convo.instance_name) {
          const inst = await this.prisma.instance.findFirst({
            where: { name: convo.instance_name },
            select: { purpose: true, tenant_id: true },
          });
          chipPurpose = inst?.purpose || null;
          chipTenantId = inst?.tenant_id || null;
        }
      } catch (e: any) {
        this.logger.warn(`[AI] Falha ao resolver a função do chip: ${e.message} — usando todas as skills`);
      }

      // 6c. Contexto da CLÍNICA desta conversa (carregado UMA vez): perfil do chip
      // (AI_PROFILE_<PURPOSE>), nome/telefone/endereço do tenant e horário de
      // atendimento. No chat de teste sem chip daquela função, vale a função
      // escolhida na tela (job.data.purpose).
      const rawTenantId: string | null = (convo as any).tenant_id || null;
      // Conversa legada sem clínica: cai pra clínica do lead e, por fim, pra dona do
      // chip (mesma regra do webhook, que aplica o tempo de resposta dessa clínica).
      const profileTenantId: string | null = rawTenantId || (convo as any).lead?.tenant_id || chipTenantId || null;
      // Chip sem função (legado, 1 chip só) usa o perfil COMERCIAL — mesma regra do
      // webhook, do encerramento de não-paciente e do follow-up.
      const profilePurpose: string =
        chipPurpose ?? (dryRun && typeof job.data?.purpose === 'string' ? job.data.purpose : null) ?? 'COMERCIAL';
      const clinicCtx: ClinicAiContext = await loadClinicAiContext(this.prisma, profileTenantId, profilePurpose);
      const aiProfile = clinicCtx.profile;
      const assistantName = aiProfile.assistantName;

      // 6d. 2ª tentativa de agendamento (fluxo real): checagens que dependem da
      // clínica/chip. O webhook NÃO passa por aqui, então o liga/desliga da IA do
      // chip é conferido de novo (mesma regra do webhook).
      if (isSchedulingRetry && !dryRun) {
        let abortReason: string | null = null;
        if (aiProfile.schedulingRetryMin <= 0) abortReason = 'clínica desligou a 2ª tentativa no perfil do chip';
        else if (profilePurpose === 'FINANCEIRO') abortReason = 'chip Financeiro não faz tentativa de agendamento';
        else if (convo.lead?.is_client) abortReason = 'contato já é paciente (Pós-Venda)';
        else if (await this.effectiveNonPatientMark(convo, false))
          abortReason = `contato marcado como não-paciente (${convo.lead.non_patient_category})`;
        else if (!(await isChipAiEnabledForClinic(this.prisma, rawTenantId || chipTenantId || (convo as any).lead?.tenant_id, chipPurpose)))
          abortReason = `IA desligada no chip ${chipPurpose ?? 'sem função'} desta clínica`;
        else if (await this.hasFutureClinicalAppointment(convo)) abortReason = 'lead já tem consulta futura';
        if (abortReason) {
          this.logger.log(`[AI-RETRY] Job ${job.id} abortado (conv ${conversation_id}): ${abortReason}`);
          return;
        }
        this.logger.log(`[AI-RETRY] conv ${conversation_id}: rodando a 2ª tentativa de agendamento`);
      }

      // 7. Montar histórico com rótulos (Cliente / <assistente> / Mensagem automática / Operador)
      // Invertemos o array (que veio desc) para ordem cronológica correta
      const chronological = [...convo.messages].reverse();
      // Tamanho das respostas: 'auto' = espelha o jeito do paciente (mensagens curtas
      // x textão); 'curta'/'media'/'longa' = escolha da clínica no perfil do chip.
      const replyStyle = resolveReplyStyle(aiProfile.replyLength, chronological as any[]);
      const patientStyle = replyStyle.style;
      // Quem escreveu cada 'out' (IA / disparo automático / operador humano) — ver
      // history-sender.ts. Falhou a consulta = tudo que não é da IA fica "Operador".
      let automationSignals: AutomationSignals = NO_AUTOMATION_SIGNALS;
      if (!dryRun) {
        try {
          automationSignals = await loadAutomationSignals(this.prisma, {
            tenantId: profileTenantId,
            lead: convo.lead ? { id: convo.lead.id, phone: convo.lead.phone } : null,
            // Nota interna da IA pra equipe (note_ai_) não é conversa — fica de fora.
            messages: (chronological as any[]).filter((m: any) => !isAiTeamNote(m)),
          });
        } catch (e: any) {
          this.logger.warn(`[AI] Falha ao carregar envios automáticos da conversa ${convo.id}: ${e.message}`);
        }
      }
      const historyText = chronological
        // Alerta interno que a própria IA gravou pra equipe não é conversa com o paciente.
        .filter((m: any) => !isAiTeamNote(m))
        .map((m: any) => {
          const sender = historyTextLabel(classifyHistorySender(m, automationSignals), assistantName);
          // Indica tipo de mídia quando não há texto
          const content =
            m.text ||
            (m.type === 'audio'
              ? '[áudio sem transcrição]'
              : m.type === 'image'
                ? `[imagem${m.media?.original_name ? ': ' + m.media.original_name : ''}]`
                : m.type === 'document'
                  ? `[documento${m.media?.original_name ? ': ' + m.media.original_name : ''}]`
                  : '[mídia]');
          return `${sender}: ${content}`;
        })
        .join('\n');

      // 8. Carregar skills ativas (com tools e assets inclusos)
      const allActiveSkills = await this.settings.getActiveSkills();
      // 8.0 Onda 18.22 — filtrar pelo CHIP da conversa. Cada skill tem um purpose
      // (Comercial/Clínica/Financeiro) ou null="Geral" (vale em qualquer chip).
      // ISOLAMENTO DURO: se o chip TEM função mas NÃO tem skill própria (nem
      // Geral), a IA fica em SILÊNCIO — não empresta skills de outro chip. Chip
      // SEM função definida (legado/1-chip) continua usando todas (não some do
      // radar). Erro ao resolver = fallback seguro (usa todas), não silêncio.
      // (chipPurpose resolvido em 6b)
      let activeSkills = allActiveSkills;
      let silentNoSkill = false;
      try {
        if (chipPurpose) {
          const filtered = allActiveSkills.filter(
            (s: any) => !s.purpose || s.purpose === chipPurpose,
          );
          if (filtered.length > 0) {
            activeSkills = filtered;
            this.logger.log(
              `[AI] Chip ${chipPurpose}: ${filtered.length}/${allActiveSkills.length} skills elegíveis`,
            );
          } else {
            this.logger.log(
              `[AI] Chip ${chipPurpose} ligado mas SEM skill própria — IA em silêncio (isolamento duro)`,
            );
            silentNoSkill = true;
          }
        }
      } catch (e: any) {
        this.logger.warn(`[AI] Falha ao filtrar skills por chip: ${e.message} — usando todas`);
      }
      // Chip com função e sem skill própria: encerra sem responder (isolamento duro).
      if (silentNoSkill) return;

      // 8.5 Detectar se é CLIENTE → forçar skill area='Acompanhamento' (Pós-Venda
      // odontológica). Em odonto, basta `lead.is_client=true`; o carregamento de
      // legalCase fica como BEST-EFFORT (legado jurídico — preenche
      // activeCasesInfoBlock quando existir, mas não é mais pré-requisito).
      let isActiveClient = false;
      let activeCases: any[] = [];
      try {
        const lead = await (this.prisma as any).lead.findUnique({
          where: { id: convo.lead_id },
          select: { is_client: true, stage: true },
        });
        if (lead?.is_client || (dryRun && convo.lead.is_client)) {
          isActiveClient = true;
          try {
            activeCases = await (this.prisma as any).legalCase.findMany({
              where: { lead_id: convo.lead_id, archived: false },
              select: { id: true, case_number: true, specialty: true, tracking_stage: true, in_tracking: true, stage: true, opposing_party: true },
              orderBy: { stage_changed_at: 'desc' },
            });
          } catch {
            // Tabela legalCase pode não existir / estar vazia em tenants odonto.
            // Não impede a ativação da skill Pós-Venda.
            activeCases = [];
          }
        }
      } catch (e: any) {
        this.logger.warn(`[AI] Falha ao verificar status de cliente: ${e.message}`);
      }

      // 8.7 TRIAGEM NÃO-PACIENTE — quando quem escreve NÃO é paciente/lead (fornecedor
      // oferecendo serviço, currículo/emprego, parceria, propaganda), a IA encaminha ao
      // responsável e ENCERRA (em vez de "tentar vender dente"), pausa a si mesma (sem
      // religar) e avisa os ADMs. Só no chip COMERCIAL (ou sem função definida) e só
      // quando NÃO é cliente já cadastrado. Opt-in por tenant (default OFF). Best-effort:
      // qualquer dúvida/erro → trata como PACIENTE e segue o fluxo normal de venda.
      // (2ª tentativa: a conversa já foi triada no turno normal — não reclassifica.)
      // Handoff de não-paciente: fora da 2ª tentativa, contato que não é cliente, chip
      // COMERCIAL ou sem função (mesma trava do webhook dos anexos). Marcar/gravar: também
      // fora do chat de teste (lá só mostra o que faria).
      const npEligible =
        !isSchedulingRetry && !isActiveClient && chipPurpose !== 'CLINICA' && chipPurpose !== 'FINANCEIRO';
      const npCanMark = !dryRun && npEligible;
      // Marca de não-paciente do lead que vale neste turno (handoff antigo; ignorada pra
      // quem tem ficha de Paciente ou consulta marcada).
      const npLeadMark = await this.effectiveNonPatientMark(convo, isActiveClient);
      // Classificou como não-paciente mas o handoff não saiu: segue o fluxo SEM agenda.
      let npClassified: { category: string; reason: string } | null = null;
      if (npCanMark) {
        try {
          const triage = await this.maybeHandleNonPatient(convo, chronological);
          if (triage.handled) return;
          npClassified = triage.classified;
        } catch (e: any) {
          this.logger.warn(`[AI][NÃO-PACIENTE] Falha na triagem (segue fluxo normal): ${e?.message}`);
        }
      }

      // 9. Selecionar skill — via Router inteligente ou fallback area-matching
      const specialty = (convo as any).specialty || null;
      const nextStep = (convo as any).next_step || null;
      const routerConfig = await this.settings.getRouterConfig();
      let skill: any = null;
      let routerReason = '';
      let routerTokens = 0;

      // Se é cliente, forçar skill de Acompanhamento (Pós-Venda). Onda 18.20 —
      // busca no conjunto COMPLETO (não no filtrado por chip): o override
      // "cliente → Pós-Venda" é transversal. Assim um paciente que escreve no chip
      // Comercial ainda recebe a Pós-Venda (Clínica), sem cair no router de vendas.
      // FINANCEIRO (Carla): NÃO aplica o override "cliente → Pós-Venda". No chip de
      // cobrança todo titular é paciente; sem esta exceção, a skill de venda/agenda
      // sequestraria a conversa. Deixa o filtro por purpose escolher a skill FINANCEIRO.
      if (isActiveClient && profilePurpose !== 'FINANCEIRO') {
        skill = allActiveSkills.find((s: any) => s.area === 'Acompanhamento') || null;
        if (skill) {
          const casesNote = activeCases.length > 0 ? ` com ${activeCases.length} processo(s) ativo(s)` : '';
          routerReason = `cliente cadastrado${casesNote} — skill Pós-Venda`;
          this.logger.log(`[AI] Cliente identificado (lead=${convo.lead_id})${casesNote}, usando skill Acompanhamento (Pós-Venda)`);
        } else {
          this.logger.warn(`[AI] Cliente identificado mas skill area='Acompanhamento' não encontrada — caindo no router padrão`);
        }
      }

      if (!skill && routerConfig.enabled && activeSkills.length > 1) {
        try {
          const routerApiKey = routerConfig.provider === 'anthropic'
            ? await this.settings.getAnthropicKey()
            : await this.settings.getOpenAiKey();

          if (routerApiKey) {
            // Últimas 5 mensagens para contexto do router
            const lastMsgs = chronological.slice(-5).map((m: any) => {
              const sender = m.direction === 'in' ? 'Cliente' : assistantName;
              return `${sender}: ${(m.text || '[mídia]').slice(0, 200)}`;
            });

            // Pipeline atual do lead — usado pro router fazer "stickiness"
            // (uma vez que lead foi classificado num funil, manter a skill desse
            // funil ativa, exceto se o lead pedir mudança explícita de procedimento).
            // Sem isso o router troca de skill toda mensagem baseado em palavras
            // soltas (ex: "agende" → trocava pra Implantes mesmo que lead estivesse
            // em Lentes de Porcelana).
            let currentPipelineSlug: string | null = null;
            try {
              const leadPipeline = await (this.prisma as any).lead.findUnique({
                where: { id: convo.lead_id },
                select: { pipeline: { select: { slug: true } } },
              });
              currentPipelineSlug = leadPipeline?.pipeline?.slug ?? null;
            } catch {
              // ignora — router funciona sem isso
            }

            const routerResult = await this.skillRouter.selectSkill({
              skills: activeSkills,
              lastMessages: lastMsgs,
              specialty,
              nextStep,
              currentPipelineSlug,
              routerModel: routerConfig.model,
              routerProvider: routerConfig.provider as LLMProvider,
              apiKey: routerApiKey,
            });

            skill = activeSkills.find((s: any) => s.id === routerResult.skillId) || null;
            routerReason = routerResult.reason;
            routerTokens = routerResult.tokensUsed;
          }
        } catch (err: any) {
          this.logger.warn(`[AI] Router falhou: ${err.message}. Usando fallback.`);
        }
      }

      // Fallback: area-matching original
      if (!skill) {
        skill = this.selectSkill(activeSkills, specialty);
        routerReason = routerReason || 'fallback: area matching';
      }

      // 10. Preparar prompt e parâmetros
      let systemPrompt: string;
      let model: string;
      let maxTokens: number;
      let temperature: number;

      // 10b. Buscar status da ficha trabalhista (se especialidade trabalhista)
      let fichaStatus = '';
      if (specialty?.toLowerCase().includes('trabalhist')) {
        try {
          const ficha = await (this.prisma as any).fichaTrabalhista.findUnique({
            where: { lead_id: convo.lead_id },
          });
          if (ficha?.data) {
            const data = ficha.data as Record<string, any>;
            const requiredFields = [
              'nome_completo', 'cpf', 'data_nascimento', 'nome_mae', 'estado_civil', 'profissao', 'telefone', 'email',
              'cidade', 'estado_uf',
              'nome_empregador', 'funcao', 'data_admissao', 'situacao_atual', 'salario', 'ctps_assinada_corretamente', 'atividades_realizadas',
              'horario_entrada', 'horario_saida', 'tempo_intervalo', 'dias_trabalhados', 'fazia_horas_extras',
              'fgts_depositado', 'fgts_sacado', 'tem_ferias_pendentes', 'tem_decimo_terceiro_pendente',
              'possui_testemunhas', 'possui_provas_documentais',
            ];
            const filled = requiredFields.filter(k => data[k] && data[k] !== '');
            const missing = requiredFields.filter(k => !data[k] || data[k] === '');
            fichaStatus = `CAMPOS JÁ PREENCHIDOS (${filled.length}/${requiredFields.length}): ${filled.join(', ')}\nCAMPOS FALTANDO (${missing.length}): ${missing.join(', ')}\nProgresso: ${ficha.completion_pct || 0}%`;
          } else {
            fichaStatus = 'FICHA AINDA NÃO INICIADA — nenhum campo preenchido. Comece coletando os dados.';
          }
        } catch {
          fichaStatus = 'FICHA AINDA NÃO INICIADA — nenhum campo preenchido. Comece coletando os dados.';
        }
      }

      const siteUrl = process.env.APP_URL || 'https://andrelustosaadvogados.com.br';

      // 10c. Buscar horários disponíveis do dentista atribuído (para agendamento)
      // Formato injetado no prompt como {{available_slots}}:
      //   "Terça 28/04 (2026-04-28): 09:00, 10:00, 14:00 | Quarta 29/04 (...) | ..."
      // Inclui nome do dia em PT-BR pra IA matchear quando lead disser "terça",
      // "quinta", etc. Loop começa em i=1 (próximo dia) — NÃO inclui hoje pra dar
      // tempo de preparação. Limite: 5 dias com vagas.
      //
      // v12 (Onda 5e): REMOVIDO o skip hardcoded de sabado. Agora respeita
      // UserSchedule do dentista — se ele atende sabado, a IA propoe sabado.
      // getAvailability ja respeita feriados, blocks e UserSchedule, retornando
      // [] pra dias sem turnos. Window ampliada de 7 pra 14 dias pra cobrir
      // sabados que podem cair na semana seguinte.
      let availableSlots = 'Nenhum dentista atribuído — horários indisponíveis.';
      // FINANCEIRO (Carla): não há agenda neste canal. Resumo real das cobranças do
      // PRÓPRIO paciente (escopado por tenant+paciente, reconciliado ao vivo no Asaas)
      // entra no lugar de {{available_slots}}; a lista `sendable` alimenta o reenvio
      // seguro de boletos (financeiro_action).
      let financeiroResumo = '(não se aplica neste canal)';
      let financeiroSendable: FinanceiroSendable[] = [];
      // Mesma lista, ESTRUTURADA (todos os horários livres de cada dia): a rede de
      // segurança do "deixei agendado" e as alternativas de horário usam ela.
      let freeSlotDays: FreeSlotDay[] = [];
      // Onda 18.x — os horários da CONSULTA têm que vir da agenda do MESMO dentista que o
      // confirm_slot vai marcar (a Orçamentista, Dra. Suellen). Antes lia
      // convo.assigned_dentist_id CRU (podia ser o especialista de ÁREA, ex. Dr. Fellipe) e
      // o confirm_slot reatribuía pra Suellen → oferecia horário do Fellipe e a marcação na
      // Suellen era recusada (conflito/turno). Resolve o Orçamentista aqui, igual o check_availability.
      let assignedDentistId: string | null = null;
      // FINANCEIRO não resolve/atribui Orçamentista (efeito colateral em dados) nem
      // calcula horários — só carrega o financeiro do paciente desta conversa.
      if (profilePurpose === 'FINANCEIRO') {
        availableSlots = '(não se aplica — canal financeiro)';
        try {
          const finCtx = await loadFinanceiroContext(
            this.prisma as any,
            this.settings,
            profileTenantId,
            convo.lead_id || convo.lead?.id || null,
          );
          financeiroResumo = finCtx.resumoText;
          financeiroSendable = finCtx.sendable;
        } catch (e: any) {
          this.logger.warn(`[AI] Falha ao carregar financeiro do paciente (conv ${convo.id}): ${e?.message}`);
          financeiroResumo = '(não consegui consultar o financeiro agora — diga que vai conferir com a equipe)';
        }
      } else {
        try {
          assignedDentistId = await ensureOrcamentistaAssigned(this.prisma as any, convo.id, {
            tenantId: convo.tenant_id || undefined,
            readOnly: dryRun,
          });
        } catch (e: any) {
          this.logger.warn(`[AI] Falha ao resolver Orçamentista pros slots (conv ${convo.id}): ${e?.message}`);
        }
        if (!assignedDentistId) assignedDentistId = (convo as any).assigned_dentist_id;
      }
      if (assignedDentistId) {
        try {
          const tz = 'America/Maceio';
          const formatDateBR = (d: Date) =>
            d.toLocaleDateString('pt-BR', { timeZone: tz, day: '2-digit', month: '2-digit' });
          const formatWeekday = (d: Date) => {
            const wd = d.toLocaleDateString('pt-BR', { timeZone: tz, weekday: 'long' });
            // Capitaliza ("segunda-feira" → "Segunda-feira")
            return wd.charAt(0).toUpperCase() + wd.slice(1);
          };
          // v12: NAO pula sabado. Apenas pula domingo (raramente clinica
          // odontologica atende). Se quiser tambem desbloquear domingo, basta
          // remover o skip abaixo — getAvailability ja respeita UserSchedule.
          // Coleta ESTRUTURADA dos dias com vaga (nearest-first) pra permitir
          // a curadoria da PROPOSTA abaixo.
          // Onda 19: loop UTC-consistente (igual check-availability). O rótulo
          // legível é ancorado ao meio-dia UTC do MESMO dateStr pra bater com o
          // dia que o confirm_slot marca — senão, à noite em Maceió o toISOString
          // rolava pro dia seguinte e a IA falava um dia e agendava outro.
          const daysWithSlots: { label: string; dateStr: string; times: string[] }[] = [];
          const startDate = new Date(Date.now() - 3 * 60 * 60 * 1000); // -3h = "agora" em Maceió (naive-UTC)
          startDate.setUTCDate(startDate.getUTCDate() + 1); // começa amanhã (UTC naive)
          for (let i = 0; i < 14 && daysWithSlots.length < 5; i++) {
            const day = new Date(startDate.getTime());
            day.setUTCDate(day.getUTCDate() + i);
            const dateStr = day.toISOString().split('T')[0];
            const anchor = new Date(`${dateStr}T12:00:00Z`); // 12:00Z = 09:00 Maceió, mesmo dia
            if (anchor.getUTCDay() === 0) continue; // pula domingo (clinica fechada)
            const slots = await this.getAvailability(assignedDentistId, dateStr, 60, profileTenantId);
            if (slots.length > 0) {
              daysWithSlots.push({
                label: `${formatWeekday(anchor)} ${formatDateBR(anchor)} (${dateStr})`,
                dateStr,
                times: slots.map((s) => s.start),
              });
            }
          }

          freeSlotDays = daysWithSlots.map((d) => ({ date: d.dateStr, times: d.times }));
          if (daysWithSlots.length === 0) {
            availableSlots = 'Sem horários disponíveis nos próximos dias.';
          } else {
            // ── Curadoria da PROPOSTA (Onda 19 — regra de oferta do dono) ──
            // Objetivo: propor POUCAS opções, o mais CEDO possível, ESPALHADAS
            // em dias diferentes (NUNCA 3 do mesmo dia — isso expõe "buracos" na
            // agenda e passa impressão de agenda vazia), dentro dos 2 dias mais
            // próximos com vaga. O 1º horário = "encaixe mais próximo" (mostra
            // esforço e valoriza a vaga → aumenta o comparecimento).
            // Regra determinística (pickSuggestedSlots):
            //   1) 1 horário (o mais cedo) de cada um dos 2 dias mais próximos;
            //   2) o 3º é um horário da TARDE do dia mais próximo que tiver (manhã E
            //      tarde aparecem); sem tarde, o 2º horário do dia (MÁX 2 por dia).
            // Ordem CRONOLÓGICA (dia, depois hora): o 1º = ENCAIXE (o mais cedo).
            const labelOf = new Map(daysWithSlots.map((d) => [d.dateStr, d.label]));
            const suggestion = pickSuggestedSlots(freeSlotDays);
            const suggLines = suggestion
              .map((s, idx) => `  • ${labelOf.get(s.date) || s.date} às ${s.time}${idx === 0 ? '  ← ENCAIXE mais próximo (ofereça como prioridade)' : ''}`)
              .join('\n');
            // Agenda completa compacta — fallback só pra quando o lead pedir um
            // dia/horário específico ou recusar as sugeridas. Manhã E tarde de cada
            // dia (antes slice(0, 6) mostrava só a manhã e a tarde ficava invisível).
            const fullLines = daysWithSlots
              .map((d) => `${d.label}: ${compactDayTimes(d.times)}`)
              .join(' | ');
            availableSlots =
              `PROPOSTA SUGERIDA (ofereça SÓ estas — no máx 3, espalhados em até 2 dias, a mais cedo primeiro; NUNCA 3 do mesmo dia):\n${suggLines}\n` +
              `AGENDA COMPLETA (use APENAS se o lead recusar as sugeridas ou pedir um dia/horário específico): ${fullLines}`;
          }
        } catch (e: any) {
          this.logger.warn(`[AI] Falha ao buscar disponibilidade: ${e.message}`);
          availableSlots = 'Erro ao consultar horários — tente novamente.';
        }
      }

      // 2ª tentativa sem horário concreto pra oferecer = não manda nada (a mensagem
      // existe pra propor 2 horários; sem eles vira só cobrança).
      if (isSchedulingRetry && !availableSlots.includes('PROPOSTA SUGERIDA')) {
        this.logger.log(`[AI-RETRY] conv ${conversation_id}: sem PROPOSTA SUGERIDA na agenda (${availableSlots.slice(0, 80)}) — tentativa não enviada`);
        if (dryRun) {
          return {
            dryRun: true,
            schedulingRetry: true,
            bubbles: [],
            retrySkipped: 'Sem horários livres na agenda para oferecer — a 2ª tentativa não seria enviada.',
            retryScheduling: false,
            retryAfterMin: aiProfile.schedulingRetryMin,
          };
        }
        return;
      }

      // ── Próximos eventos do calendário do lead — perícias, audiências, prazos ──
      let upcomingEventsBlock = '';
      try {
        const upcomingEvents = await this.prisma.calendarEvent.findMany({
          where: {
            lead_id: convo.lead_id,
            start_at: { gte: maceioNowNaive() }, // agenda naive-UTC: "agora" de Maceió
            status: { notIn: ['CANCELADO', 'CONCLUIDO'] },
          },
          orderBy: { start_at: 'asc' },
          take: 5,
          select: { type: true, title: true, start_at: true, location: true, description: true },
        });
        if (upcomingEvents.length > 0) {
          const TYPE_LABEL: Record<string, string> = {
            AUDIENCIA: '⚖️ Audiência', PERICIA: '🔬 Perícia', PRAZO: '⏰ Prazo',
            CONSULTA: '📞 Consulta', TAREFA: '✅ Tarefa', OUTRO: '📅 Evento',
          };
          const lines = upcomingEvents.map(e => {
            const dt = e.start_at;
            const dateStr = `${String(dt.getUTCDate()).padStart(2,'0')}/${String(dt.getUTCMonth()+1).padStart(2,'0')}/${dt.getUTCFullYear()} ${String(dt.getUTCHours()).padStart(2,'0')}:${String(dt.getUTCMinutes()).padStart(2,'0')}`;
            const label = TYPE_LABEL[e.type] || e.type;
            return `- ${label}: ${e.title} | ${dateStr}${e.location ? ` | Local: ${e.location}` : ''}${e.description ? ` | ${e.description.slice(0,100)}` : ''}`;
          });
          upcomingEventsBlock =
            `\n═══════════════════════════════════════════════════\n` +
            `📅 PRÓXIMOS EVENTOS DO CLIENTE (use para responder dúvidas sobre data/horário):\n` +
            lines.join('\n') + '\n' +
            `═══════════════════════════════════════════════════\n`;
        }
      } catch (e: any) {
        this.logger.warn(`[AI] Falha ao buscar próximos eventos: ${e.message}`);
      }

      // ── Notas internas dos operadores (ConversationNote) — visíveis para a IA ──
      let operatorNotesBlock = '';
      try {
        const opNotes = await (this.prisma as any).conversationNote.findMany({
          where: { conversation_id: convo.id },
          orderBy: { created_at: 'desc' },
          take: 10,
          include: { user: { select: { name: true } } },
        });
        if (opNotes.length > 0) {
          const lines = opNotes.reverse().map((n: any) => {
            const date = new Date(n.created_at).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
            return `- [${n.user?.name || 'Operador'}, ${date}]: ${n.text}`;
          });
          operatorNotesBlock =
            `\n═══════════════════════════════════════════════════\n` +
            `📝 NOTAS INTERNAS DOS OPERADORES (instruções da equipe — OBEDEÇA):\n` +
            lines.join('\n') + '\n' +
            `═══════════════════════════════════════════════════\n`;
        }
      } catch (e: any) {
        this.logger.warn(`[AI] Falha ao carregar notas internas: ${e.message}`);
      }

      // ── ai_notes — observações da própria IA sobre o lead ──
      let aiNotesBlock = '';
      if ((convo as any).ai_notes) {
        aiNotesBlock =
          `\n═══════════════════════════════════════════════════\n` +
          `🤖 SUAS ANOTAÇÕES ANTERIORES (você escreveu isso):\n` +
          `${(convo as any).ai_notes}\n` +
          `═══════════════════════════════════════════════════\n`;
      }

      // ── Reminder context — injeta aviso se cliente está respondendo a um lembrete recente ──
      let reminderContextBlock = '';
      const reminderCtx = (convo as any).reminder_context as any;
      if (reminderCtx && reminderCtx.sent_at) {
        const sentAt = new Date(reminderCtx.sent_at);
        const hoursAgo = Math.round((Date.now() - sentAt.getTime()) / 3_600_000);
        if (hoursAgo < 48) {
          const quando = hoursAgo === 0 ? 'há menos de 1 hora' : `há ${hoursAgo} hora(s)`;
          reminderContextBlock =
            `\n═══════════════════════════════════════════════════\n` +
            `⚠️ CONTEXTO — LEMBRETE ENVIADO AO CLIENTE (${quando}):\n` +
            `Tipo: ${reminderCtx.type || ''}\n` +
            `Evento: ${reminderCtx.event_title || ''}\n` +
            `Data/Hora: ${reminderCtx.event_date || ''}\n` +
            (reminderCtx.location ? `Local: ${reminderCtx.location}\n` : '') +
            `\nMensagem que foi enviada ao cliente:\n"${(reminderCtx.message_sent || '').slice(0, 500)}"\n` +
            `\nINSTRUÇÕES IMPORTANTES:\n` +
            `- Se o cliente está respondendo agora, PROVAVELMENTE é sobre este lembrete.\n` +
            `- Você JÁ SABE todos os detalhes da audiência — NÃO pergunte data, local ou horário.\n` +
            `- Responda dúvidas (documentos a levar, como se preparar, o que esperar etc.) com naturalidade.\n` +
            `- NÃO mencione que foi você quem enviou o lembrete — aja como atendente humano normal.\n` +
            `═══════════════════════════════════════════════════\n`;
        }
      }

      // Montar info de processos ativos (para clientes com caso em andamento)
      let activeCasesInfoBlock = '';
      if (isActiveClient && activeCases.length > 0) {
        const TRACKING_LABELS: Record<string, string> = {
          DISTRIBUIDO: 'Distribuído', CITACAO: 'Citação', CONTESTACAO: 'Contestação',
          REPLICA: 'Réplica', PERICIA_AGENDADA: 'Perícia Agendada', INSTRUCAO: 'Audiência/Instrução',
          ALEGACOES_FINAIS: 'Alegações Finais', AGUARDANDO_SENTENCA: 'Aguardando Sentença',
          JULGAMENTO: 'Julgamento', RECURSO: 'Recurso', TRANSITADO: 'Transitado em Julgado',
          EXECUCAO: 'Execução', ENCERRADO: 'Encerrado',
        };
        const PREP_LABELS: Record<string, string> = {
          VIABILIDADE: 'Análise de Viabilidade', DOCUMENTACAO: 'Coleta de Documentos',
          PETICAO: 'Petição Inicial', REVISAO: 'Revisão', PROTOCOLO: 'Protocolo',
        };
        const caseLines = activeCases.map((c: any) => {
          const stageLabel = c.in_tracking
            ? (TRACKING_LABELS[c.tracking_stage] || c.tracking_stage || 'Em acompanhamento')
            : (PREP_LABELS[c.stage] || c.stage || 'Em preparação');
          return `  - Nº ${c.case_number || 'Sem número'} | ${c.specialty || 'Especialidade não definida'} | Estágio: ${stageLabel}${c.opposing_party ? ` | vs ${c.opposing_party}` : ''}`;
        });
        activeCasesInfoBlock = `═══════════════════════════════════════════════════
⚖️ PROCESSOS ATIVOS DO CLIENTE (${activeCases.length}):
${caseLines.join('\n')}

IMPORTANTE: Este é um CLIENTE já contratado. NÃO faça triagem, NÃO investigue fatos, NÃO pergunte dados pessoais. Responda sobre o andamento do processo.
═══════════════════════════════════════════════════
`;
      }

      // Variável dinâmica: bloco informativo sobre horário de expediente.
      // Vazio se dentro do expediente; multi-linha (inclui motivo + próximo
      // horário útil) se fora. A skill decide como usar via {{business_hours_info}}.
      // Horário e feriados são DA CLÍNICA REAL da conversa (profileTenantId, de 6c —
      // inclui o tenant all-zeros do Instituto, que é uma clínica real): antes ia
      // null pra ele e a tabela Holiday era lida sem filtro (feriado de qualquer
      // clínica fechava esta). tenantIdForBH continua só pro ToolContext (abaixo).
      const tenantIdForBH =
        rawTenantId && rawTenantId !== '00000000-0000-0000-0000-000000000000'
          ? rawTenantId
          : null;
      const businessHoursInfo = await computeBusinessHoursInfo(
        this.prisma,
        profileTenantId,
      ).catch((e: any) => {
        this.logger.warn(`[AI] Falha ao calcular business_hours_info: ${e.message}`);
        return '';
      });
      this.logger.log(
        `[AI] business_hours_info len=${businessHoursInfo.length} tenant="${profileTenantId}" preview="${businessHoursInfo.slice(0, 120).replace(/\n/g, '\\n')}"`,
      );
      // Clínica com grade própria (Ajustes › IA): o "aberta/fechada agora" segue ELA,
      // não o horário do escritório (AFTER_HOURS_* da clínica, senão o global). Feriado
      // cadastrado (da clínica ou global) continua mandando. Hora local de Maceió em naive-UTC.
      const isHolidayToday = /FERIADO/i.test(businessHoursInfo);
      const clinicStatus = clinicStatusNow(clinicCtx.hours, new Date(Date.now() - 3 * 60 * 60 * 1000));
      const effectiveBusinessHoursInfo =
        clinicStatus && !isHolidayToday ? (clinicStatus.open ? '' : clinicStatus.text) : businessHoursInfo;
      // "Situação agora" que SEMPRE vai pro prompt: feriado vence a grade da semana.
      const clinicNowText = isHolidayToday
        ? 'Hoje é FERIADO: a clínica está FECHADA. Pode responder e agendar normalmente; só não prometa atendimento presencial hoje.'
        : clinicStatus?.text ||
          (clinicCtx.hoursText ? 'Sem grade de horário no sistema: use o horário de atendimento informado acima.' : '(horário não cadastrado no sistema)');

      // Dados da CLÍNICA desta conversa (nunca fixos no código — antes "Instituto
      // Odonto Passos" e "Dra. Suellen" valiam pra todos os tenants): nome do tenant
      // (clinicCtx, 6c), dentista avaliador(a) (orçamentista resolvido acima) e a
      // tabela de valores que a IA pode falar (TenantSetting AI_PRICE_TABLE, editável
      // em Ajustes › IA).
      const firmName = clinicCtx.firmName || 'nossa clínica';
      let doctorName = 'a dentista avaliadora';
      let priceTable = NO_PRICE_TABLE;
      try {
        const [doctorRow, priceRow, pricesOnRow] = await Promise.all([
          assignedDentistId
            ? this.prisma.user.findUnique({ where: { id: assignedDentistId }, select: { name: true } })
            : null,
          rawTenantId
            ? (this.prisma as any).tenantSetting.findUnique({
                where: { tenant_id_key: { tenant_id: rawTenantId, key: 'AI_PRICE_TABLE' } },
              })
            : null,
          rawTenantId
            ? (this.prisma as any).tenantSetting.findUnique({
                where: { tenant_id_key: { tenant_id: rawTenantId, key: 'AI_PRICES_ENABLED' } },
              })
            : null,
        ]);
        if (doctorRow?.name) doctorName = doctorRow.name;
        // AI_PRICES_ENABLED='false' = clínica desligou "passar valores" (mantém o texto salvo).
        if (priceRow?.value?.trim() && pricesOnRow?.value !== 'false') priceTable = priceRow.value.trim();
      } catch (e: any) {
        this.logger.warn(`[AI] Falha ao carregar dados da clínica pro prompt: ${e.message}`);
      }

      // Campo da clínica não cadastrado: a IA não pode inventar endereço/telefone/horário.
      const NOT_REGISTERED = '(não cadastrado — não invente; diga que vai confirmar com a equipe)';
      const vars: Record<string, string> = {
        lead_name: convo.lead.name || 'Desconhecido',
        lead_phone: convo.lead.phone || '',
        specialty: specialty || 'a ser identificada',
        firm_name: firmName,
        // Perfil do chip desta clínica (Ajustes › IA) + dados de contato do tenant.
        assistant_name: assistantName,
        clinic_phone: clinicCtx.phone || NOT_REGISTERED,
        clinic_address: clinicCtx.address || NOT_REGISTERED,
        clinic_hours: clinicCtx.hoursText || NOT_REGISTERED,
        chip_instructions: aiProfile.instructions || '(nenhuma)',
        doctor_name: doctorName,
        price_table: priceTable,
        lead_memory: leadMemory,
        lead_summary: memory?.summary || '',
        conversation_id: convo.id,
        lead_id: convo.lead_id || convo.lead?.id || '',
        history_summary: historyText.slice(0, 2000),
        // URL base do site — use no prompt: "{{site_url}}/geral/arapiraca"
        site_url: siteUrl,
        form_url: `${siteUrl}/formulario/trabalhista/${convo.lead_id || convo.lead?.id || ''}`,
        data_hoje: new Date().toLocaleString('pt-BR', {
          timeZone: 'America/Maceio',
          day: '2-digit', month: '2-digit', year: 'numeric',
          hour: '2-digit', minute: '2-digit',
        }),
        ficha_status: fichaStatus,
        available_slots: availableSlots,
        financeiro_resumo: financeiroResumo,
        reminder_context: reminderContextBlock,
        upcoming_events: upcomingEventsBlock,
        operator_notes: operatorNotesBlock,
        ai_notes: aiNotesBlock,
        active_cases_info: activeCasesInfoBlock,
        business_hours_info: effectiveBusinessHoursInfo,
        clinic_now: clinicNowText,
        patient_style: replyStyle.hint,
      };

      // Cabeçalho fixo de capacidades — injetado antes de qualquer skill prompt
      const MEDIA_CAPABILITIES_HEADER = `CAPACIDADES DE MÍDIA DISPONÍVEIS:
- Áudios são transcritos automaticamente por IA (Whisper). O texto transcrito já aparece no histórico como texto normal. NUNCA diga que não consegue ouvir — você lê a transcrição.
- Imagens e documentos enviados pelo cliente são analisados visualmente quando o modelo suporta visão. Responda ao conteúdo deles normalmente.
- NUNCA peça para o cliente "escrever em texto" por causa de mídia — você já consegue ler o conteúdo.

`;

      // CORE_RULES: regras técnicas injetadas em TODO prompt (identidade, memória,
      // horários). Tom e jeito de conversar vêm do CONVERSATION_GUIDE (conversation-guide.ts).
      // O roteiro de cada especialidade está no skill.system_prompt (editável no admin).
      // FINANCEIRO (Carla) tem guia PRÓPRIO: sem venda/agenda. No lugar do
      // CONVERSATION_GUIDE + HORÁRIOS, entra FINANCE_GUIDE + RESUMO FINANCEIRO do
      // paciente; e os finalRules viram FINANCE_RULES (ver conversation-guide.ts).
      const isFinance = profilePurpose === 'FINANCEIRO';
      const guideBlock = isFinance
        ? `${FINANCE_GUIDE}\nRESUMO FINANCEIRO (use SOMENTE estes dados — são do PRÓPRIO paciente desta conversa):\n{{financeiro_resumo}}`
        : `${CONVERSATION_GUIDE}\nHORÁRIOS DISPONÍVEIS (use SOMENTE estes — NUNCA invente datas ou horários):\n{{available_slots}}`;
      const CORE_RULES = `DATA E HORA ATUAL: {{data_hoje}} (fuso horário de Maceió/AL).

═══════════════════════════════════════════════════
IDENTIDADE DO CONTATO ATUAL (NUNCA pergunte de qual número ou com quem está falando — esta é a verdade):
- Nome: {{lead_name}}
- Telefone WhatsApp: {{lead_phone}}
- Conversa ID: {{conversation_id}}
Se o paciente perguntar os próprios dados (nome, telefone), confirme usando este bloco.
═══════════════════════════════════════════════════
MEMÓRIA DO LEAD (tudo que já foi coletado sobre este cliente — não pergunte de novo o que já está aqui):
{{lead_memory}}
═══════════════════════════════════════════════════
{{operator_notes}}
{{ai_notes}}
{{reminder_context}}
{{upcoming_events}}
{{active_cases_info}}
${guideBlock}

STATUS DA FICHA:
{{ficha_status}}
`;

      // Regras finais — entram POR ÚLTIMO no prompt (o modelo pesa mais o final),
      // valendo sobre skills custom mal escritas. FINANCEIRO usa as regras de cobrança
      // (sem venda/agenda); os demais, as de agendamento. Ver conversation-guide.ts.
      const AGENDAMENTO_OVERRIDES = isFinance ? FINANCE_RULES : SCHEDULING_RULES;


      // ─── Sistema de memoria (3 camadas) ──────────────────────────────
      // Camada 1: Memorias organizacionais (escritorio) — so com tenant valido
      // Camada 2: LeadProfile.summary (perfil consolidado do cliente)
      // Camada 3: Memorias episodicas recentes do lead
      //
      // Distribuicao:
      //   - Bloco completo (memoryBlock) anexado automaticamente ao final do
      //     system prompt APENAS se a skill nao referenciar as variaveis novas
      //     (ver PromptBuilder.buildSystemPrompt — detecta uso das {{...}})
      //   - Cada camada tambem e exposta como variavel {{office_memories}},
      //     {{lead_profile}}, {{recent_episodes}} e {{memory_block}} para
      //     skill writers controlarem o posicionamento manualmente.
      // Fallback: caso o sistema novo ainda nao tenha memorias populadas,
      // strings ficam vazias e o prompt usa o {{lead_memory}} antigo (case_state).
      let memoryBlock = '';
      let officeMemoriesStr = '';
      let leadProfileStr = '';
      let recentEpisodesStr = '';
      try {
        const leadIdForMem = convo.lead_id || convo.lead?.id || null;
        // Tenant REAL da conversa (rawTenantId), não o tenantIdForBH: aquele vira
        // null pro '00000000-…' — que é o Instituto, clínica real — e o Instituto
        // ficava sem o resumo da clínica (OrganizationProfile) e sem memórias.
        const tenantIdForMem: string | null = rawTenantId;
        if (tenantIdForMem && leadIdForMem) {
          const [orgProfile, orgMems, profile, recentEpisodes] = await Promise.all([
            // OrganizationProfile consolidado (prosa) — fonte principal
            this.prisma.organizationProfile.findUnique({
              where: { tenant_id: tenantIdForMem },
              select: { summary: true },
            }),
            // Memorias org cruas — fallback se perfil nao existir ainda
            this.prisma.memory.findMany({
              where: {
                tenant_id: tenantIdForMem,
                scope: 'organization',
                scope_id: tenantIdForMem,
                status: 'active',
              },
              orderBy: [{ subcategory: 'asc' }, { confidence: 'desc' }],
              select: { content: true, subcategory: true },
            }),
            this.prisma.leadProfile.findUnique({
              where: { lead_id: leadIdForMem },
              select: { summary: true },
            }),
            this.prisma.memory.findMany({
              where: {
                tenant_id: tenantIdForMem,
                scope: 'lead',
                scope_id: leadIdForMem,
                status: 'active',
                type: 'episodic',
              },
              orderBy: { created_at: 'desc' },
              take: 5,
              select: { content: true },
            }),
          ]);

          // Prioridade: OrgProfile.summary (prosa consolidada, ~500 palavras)
          // Fallback: bloco agrupado cru quando perfil ainda nao foi gerado
          if (orgProfile?.summary?.trim()) {
            officeMemoriesStr = orgProfile.summary.trim();
          } else {
            officeMemoriesStr = this.promptBuilder.buildOrganizationMemoryBlock(orgMems) || '';
          }
          leadProfileStr = profile?.summary?.trim() || '';
          recentEpisodesStr = recentEpisodes.length
            ? recentEpisodes.map((m) => `- ${m.content}`).join('\n')
            : '';
          memoryBlock = this.promptBuilder.buildMemoryLayers({
            orgSummary: officeMemoriesStr || null,
            leadProfileSummary: leadProfileStr || null,
            recentEpisodes,
          });
          if (memoryBlock) {
            this.logger.log(
              `[AI] memoryBlock: orgProfile=${orgProfile ? 1 : 0} orgMemsRaw=${orgMems.length} profile=${profile ? 1 : 0} episodes=${recentEpisodes.length} chars=${memoryBlock.length}`,
            );
          }
        }
      } catch (e: any) {
        this.logger.warn(`[AI] Falha ao montar memoryBlock: ${e.message}`);
      }

      // Expoe as 3 camadas como variaveis do template — skill writer pode
      // usar {{office_memories}}, {{lead_profile}}, {{recent_episodes}} ou
      // {{memory_block}} (bloco completo) em qualquer posicao do system prompt.
      vars.office_memories = officeMemoriesStr;
      vars.lead_profile = leadProfileStr;
      vars.recent_episodes = recentEpisodesStr;
      vars.memory_block = memoryBlock;

      // Carrega pipelines dinâmicos do tenant (Fase 4) — bloco é injetado no
      // system prompt pra IA saber quais funis/etapas existem. Tolerante a
      // falhas: se não há pipelines configurados, block fica vazio e a IA
      // opera no modo legado (Lead.stage String hardcoded).
      let pipelinesBlock = '';
      try {
        const tenantIdForPipelines = (convo as any)?.tenant_id ?? null;
        const pipelines = await loadPipelinesForTenant(this.prisma as any, tenantIdForPipelines);
        // Onde o contato está hoje no CRC — sem isso a IA não sabia se já tinha
        // classificado e reenviava/ignorava o funil. No teste: contato novo no padrão.
        let position: LeadPipelinePosition | null = null;
        if (dryRun) {
          const def = pipelines.find(p => p.is_default) ?? pipelines[0];
          const init = def?.stages.find(s => s.is_initial) ?? def?.stages[0];
          if (def) {
            position = { pipelineSlug: def.slug, pipelineName: def.name, stageSlug: init?.slug ?? null, stageName: init?.name ?? null };
          }
        } else if (convo.lead_id) {
          const lp = await (this.prisma as any).lead.findUnique({
            where: { id: convo.lead_id },
            select: {
              pipeline: { select: { slug: true, name: true } },
              current_stage: { select: { slug: true, name: true } },
            },
          });
          position = {
            pipelineSlug: lp?.pipeline?.slug ?? null,
            pipelineName: lp?.pipeline?.name ?? null,
            stageSlug: lp?.current_stage?.slug ?? null,
            stageName: lp?.current_stage?.name ?? null,
          };
        }
        // Paciente (compareceu ou pagou) não está no funil do CRC — só lead tem funil.
        pipelinesBlock = isActiveClient ? '' : buildPipelinesPromptBlock(pipelines, position);
      } catch (e: any) {
        this.logger.warn(`[AI] Falha ao carregar pipelines do tenant: ${e.message}`);
      }

      if (skill) {
        // Injetar references (SkillAssets com inject_mode=full_text) no prompt via PromptBuilder
        const references = (skill.assets || [])
          .filter((a: any) => a.inject_mode === 'full_text' && a.content_text)
          .map((a: any) => ({ name: a.name, content: a.content_text }));

        systemPrompt = this.promptBuilder.buildSystemPrompt({
          mediaCapabilities: MEDIA_CAPABILITIES_HEADER,
          behaviorRules: CORE_RULES,
          skillPrompt: skill.system_prompt,
          references,
          maxContextTokens: skill.max_context_tokens || 4000,
          vars,
          memoryBlock,
          pipelinesBlock,
          finalRules: AGENDAMENTO_OVERRIDES,
        });
        // DEBUG temporário: confirma se {{business_hours_info}} foi substituído
        // no prompt final enviado ao LLM.
        const hasLiteralVar = systemPrompt.includes('{{business_hours_info}}');
        const hasResolved = systemPrompt.includes('CLÍNICA FECHADA');
        this.logger.log(
          `[AI] systemPrompt: literal_var=${hasLiteralVar} resolved_block=${hasResolved} length=${systemPrompt.length}`,
        );
        model = this.normalizeModelId(skill.model || (await this.settings.getDefaultModel()));
        maxTokens = Math.max(skill.max_tokens || 500, 800);
        temperature = skill.temperature ?? 0.7;
        this.logger.log(
          `[AI] Usando skill: "${skill.name}" (area=${skill.area}, model=${model})`,
        );
      } else {
        const fallbackSkillPrompt = `Você é ${assistantName}, assistente de pré-atendimento da clínica odontológica.
Seu objetivo PRINCIPAL é AGENDAR uma avaliação inicial do paciente — sem isso a clínica perde a venda.

ROTEIRO (siga na ordem, UMA pergunta por vez):
1. Cumprimente o paciente pelo nome (se já tiver, no contexto) e pergunte o que ele precisa
   resolver (ex: "Oi! Conta pra mim, o que você gostaria de tratar?").
2. Faça 1-2 perguntas de qualificação rápida sobre o problema (ex: "É algo que dói? Tem
   muito tempo?"). NÃO interrogue — duas perguntas no MÁXIMO.
3. Onda 5e v12: ASSIM QUE TIVER NOÇÃO BÁSICA do que o paciente quer, OFEREÇA os horários
   da PROPOSTA SUGERIDA do bloco {{available_slots}} (no máx 3, espalhados em até 2 dias, o mais
   cedo primeiro; NUNCA 3 do mesmo dia). Enquadre o 1º como ENCAIXE. Exemplo:
     "Deixa eu ver se consigo um encaixe pra sua consulta o quanto antes… 🙌
      Consegui! Posso te encaixar:
      • Terça 06/05 às 09:00
      • Quarta 07/05 às 14:00
      Qual fica melhor pra você?"
4. Quando o paciente escolher, CONFIRME e use scheduling_action pra registrar.

PROIBIDO (perdemos paciente cada vez que falamos isso):
❌ "Alguém da equipe vai entrar em contato"
❌ "A recepção te liga"
❌ "Vou passar pra atendente humano"
❌ "Aguarde nosso retorno"
❌ "Não temos vaga no sábado" (se sábado estiver em {{available_slots}})

OBRIGATÓRIO:
✅ Toda mensagem que indique vontade de agendar ("quero marcar", "tem vaga",
   "qual horário", "pode ser tal dia") DEVE virar uma proposta concreta com os
   horários da PROPOSTA SUGERIDA (2-3, espalhados em até 2 dias, o mais cedo primeiro;
   1º como ENCAIXE). Sem desvio.
✅ Se a lista estiver vazia ("Sem horários disponíveis"), oferecer lista de
   espera: "Os próximos dias estão lotados. Quer que eu te coloque na lista
   de espera pra avisar assim que abrir?"

Retorne SOMENTE JSON válido: {"reply":"texto para enviar","updates":{"name":null,"status":"INICIAL","area":null,"lead_summary":"resumo","next_step":"duvidas","notes":"","loss_reason":null,"form_data":null},"scheduling_action":null,"retry_scheduling":false}

Valores válidos para updates.status: INICIAL | QUALIFICANDO | AGUARDANDO_FORM | REUNIAO_AGENDADA | AGUARDANDO_DOCS | AGUARDANDO_PROC | FINALIZADO | PERDIDO
Valores válidos para updates.next_step: duvidas | triagem_concluida | entrevista | formulario | reuniao | documentos | procuracao | encerrado | perdido
updates.loss_reason: motivo da perda em português (ex: "Sem interesse"). Obrigatório quando next_step="perdido". Null nos demais casos.
form_data: objeto com campos trabalhistas extraídos (só quando area=Trabalhista). Null quando não se aplica.
scheduling_action: {"action":"confirm_slot","date":"YYYY-MM-DD","time":"HH:MM"} quando confirmar agendamento. Null quando não se aplica.
retry_scheduling: true quando o paciente encerrou sem agendar ("ok", "vou pensar", "depois vejo"…) e não tem consulta marcada (ver regra PACIENTE ENCERROU SEM AGENDAR). False nos demais casos.`;
        systemPrompt = this.promptBuilder.buildSystemPrompt({
          mediaCapabilities: MEDIA_CAPABILITIES_HEADER,
          behaviorRules: CORE_RULES,
          skillPrompt: fallbackSkillPrompt,
          references: [],
          maxContextTokens: 4000,
          vars,
          memoryBlock,
          pipelinesBlock,
          finalRules: AGENDAMENTO_OVERRIDES,
        });
        model = await this.settings.getDefaultModel();
        maxTokens = 1500;
        temperature = 0.7;
        this.logger.warn(
          '[AI] Nenhuma skill ativa encontrada — usando prompt fallback',
        );
      }

      // Clínica escolheu respostas LONGAS no perfil do chip: garante tokens pra
      // mensagem completa (skill com max_tokens baixo cortaria no meio).
      if (aiProfile.replyLength === 'longa') maxTokens = Math.max(maxTokens, 1500);

      // Chat de teste: permite trocar o modelo pra comparar (só no teste — o
      // WhatsApp real continua usando o modelo da skill). O provider (OpenAI x
      // Anthropic) é detectado pelo nome do modelo mais abaixo.
      if (dryRun && typeof job.data?.model === 'string' && job.data.model.trim()) {
        model = this.normalizeModelId(job.data.model.trim());
      }

      // 11. Montar histórico MULTI-TURN (memória natural do modelo)
      // Imagens do cliente são incluídas inline no turn correto (não descoladas no final).
      const supportsVision = this.modelSupportsVision(model);
      const chatTurns: Array<{role: 'user' | 'assistant', content: string | any[]}> = [];
      for (const m of chronological) {
        // Alerta interno que a própria IA gravou pra equipe (nunca foi pro paciente).
        if (isAiTeamNote(m)) continue;
        const isClient = (m as any).direction === 'in';
        const role: 'user' | 'assistant' = isClient ? 'user' : 'assistant';

        // Imagem do cliente + modelo suporta visão → incluir inline no turn
        // Se media ainda não chegou (race condition com media job), aguarda com polling.
        if (isClient && (m as any).type === 'image' && supportsVision) {
          let mediaRecord = (m as any).media ?? null;

          if (!mediaRecord?.s3_key) {
            const msgAge = Date.now() - new Date((m as any).created_at).getTime();
            const isRecent = msgAge < 2 * 60 * 1000;
            if (isRecent) {
              // Polling: fase rápida (5×500ms) + fase lenta (6×2000ms) = até 14.5s
              const phases = [
                { attempts: 5, delay: 500 },
                { attempts: 6, delay: 2000 },
              ];
              outer: for (const phase of phases) {
                for (let attempt = 1; attempt <= phase.attempts; attempt++) {
                  await new Promise((r) => setTimeout(r, phase.delay));
                  const found = await this.prisma.media.findFirst({
                    where: { message_id: (m as any).id },
                  });
                  if (found?.s3_key) {
                    mediaRecord = found;
                    break outer;
                  }
                  this.logger.log(
                    `[AI] Aguardando mídia de imagem para msg ${(m as any).id} (delay=${phase.delay}ms tentativa ${attempt}/${phase.attempts})...`,
                  );
                }
              }
            }
          }

          if (mediaRecord?.s3_key) {
            try {
              const { buffer, contentType } = await this.s3.getObjectBuffer(mediaRecord.s3_key);
              const mimeBase = contentType.split(';')[0].trim();
              const base64 = buffer.toString('base64');
              const imageBlock = { type: 'image_url', image_url: { url: `data:${mimeBase};base64,${base64}` } };
              const textBlock = { type: 'text', text: (m as any).text || '[imagem enviada pelo cliente]' };
              chatTurns.push({ role, content: [imageBlock, textBlock] });
              this.logger.log(`[AI] Imagem ${(m as any).id} incluída inline no chatTurn (${(buffer.length / 1024).toFixed(0)}KB)`);
              continue;
            } catch (e: any) {
              this.logger.warn(`[AI] Falha ao carregar imagem ${(m as any).id} inline: ${e.message}`);
            }
          }
        }

        const content =
          (m as any).text ||
          ((m as any).type === 'audio'
            ? '[áudio sem transcrição]'
            : (m as any).type === 'image'
              ? '[imagem enviada]'
              : (m as any).type === 'document'
                ? '[documento enviado]'
                : '[mídia]');
        // Resposta da própria IA vai sem rótulo; operador humano e disparo automático
        // vão rotulados (history-sender.ts).
        const finalContent = chatTurnPrefix(classifyHistorySender(m as any, automationSignals)) + content;
        // Mesclar mensagens de texto consecutivas do mesmo remetente
        const last = chatTurns[chatTurns.length - 1];
        if (last && last.role === role && typeof last.content === 'string') {
          last.content += '\n' + finalContent;
        } else {
          chatTurns.push({ role, content: finalContent });
        }
      }

      // visionImages não é mais necessário — imagens já estão inline nos turns acima
      const visionImages: { type: 'image_url'; image_url: { url: string } }[] = [];

      // Instrução final para a IA (não aparece no chat do cliente). O trecho de
      // tamanho segue o estilo EFETIVO (perfil do chip ou espelho do paciente) —
      // antes era "mensagens curtas" fixo e brigava com a escolha de respostas longas.
      const lengthInstruction =
        patientStyle === 'longo'
          ? 'Responda numa mensagem só, mais completa (sem picotar em balões).'
          : replyStyle.explicit && patientStyle === 'normal'
            ? 'Respostas de tamanho médio, objetivas; separe balões por linha em branco só quando houver ideias diferentes.'
            : 'Mensagens curtas, balões separados por linha em branco.';
      // 2ª tentativa de agendamento: a instrução própria SUBSTITUI a normal (a
      // última mensagem é nossa; a IA volta por conta própria com 2 horários).
      const instruction = isSchedulingRetry
        ? buildSchedulingRetryInstruction(leadFirstName(convo.lead?.name))
        : `[INSTRUÇÃO INTERNA — não exiba ao cliente]\nResponda à última mensagem do cliente — primeiro o que ele perguntou. Consulte o histórico completo acima e a MEMÓRIA DO LEAD no system prompt: NÃO repita perguntas, frases nem ofertas que você já fez. ${lengthInstruction} Atualize o status do funil conforme as regras de PROGRESSÃO DE ETAPAS.`;
      // Balões: a 2ª tentativa é UMA mensagem curta (no máx. 2 balões).
      const maxBubbles = isSchedulingRetry ? 2 : 3;

      // Montar array final de mensagens para a OpenAI (multi-turn real)
      const openAiMessages: any[] = [
        { role: 'system', content: systemPrompt },
        ...chatTurns,
      ];

      // Adicionar instrução + imagens de visão como última mensagem user
      if (visionImages.length > 0) {
        openAiMessages.push({
          role: 'user',
          content: [{ type: 'text', text: instruction }, ...visionImages],
        });
      } else {
        openAiMessages.push({ role: 'user', content: instruction });
      }

      this.logger.log(`[AI] Multi-turn: ${chatTurns.length} turns + instrução (${chronological.length} msgs carregadas)`);

      // 12. Chamar LLM — com tools (function calling) ou JSON mode (legado)
      const skillTools = (skill?.tools || []).filter((t: any) => t.active);
      const useToolCalling = skillTools.length > 0;
      let aiText = '';
      let updates: any = {};
      let scheduling_action: any = null;
      let financeiro_action: FinanceiroAction | null = null;
      let slotsToOffer: any[] | null = null;
      let toolCallLogs: any[] = [];
      // Modelo marcou retry_scheduling (paciente encerrou sem agendar).
      let retrySchedulingFlag = false;
      // Modelo marcou "nao_paciente" (emprego, fornecedor, negócio… — não é consulta).
      let naoPacienteFromModel: NaoPacienteFlag | null = null;

      if (useToolCalling) {
        // ─── PATH NOVO: Function Calling com Tool Executor ───
        // Auto-detectar provider pelo nome do modelo (evita inconsistência model/provider)
        const isClaudeModel = model.startsWith('claude-');
        // (no chat de teste o modelo pode ter sido trocado — aí o provider segue o modelo)
        const provider: LLMProvider = isClaudeModel ? 'anthropic' : (dryRun && job.data?.model ? 'openai' : (skill.provider || 'openai'));
        const apiKeyForSkill = provider === 'anthropic'
          ? await this.settings.getAnthropicKey()
          : await this.settings.getOpenAiKey();

        if (!apiKeyForSkill) {
          this.logger.error(`[AI] API key não encontrada para provider "${provider}"`);
          return;
        }

        const llmClient = createLLMClient(provider, apiKeyForSkill);
        const toolDefs = this.promptBuilder.buildToolDefinitions(skillTools);
        toolDefs.push(this.promptBuilder.buildRespondToClientTool());

        const handlerMap = buildHandlerMap(skillTools);
        // Chat de teste: só ferramentas de CONSULTA rodam de verdade; as que gravam
        // (agendar, atualizar lead, escalar…) devolvem um "ok simulado".
        // Chat de teste e 2ª tentativa: ferramentas de escrita (agendar, atualizar lead...)
        // viram "ok simulado" — a tentativa só PROPÕE horário.
        if (dryRun || isSchedulingRetry) {
          const READ_ONLY_TOOLS = new Set([
            'check_availability', 'get_procedures', 'get_esthetic_procedures',
            'search_references', 'search_memory', 'check_esthetic_revisit_due',
          ]);
          for (const [name, h] of handlerMap) {
            if (READ_ONLY_TOOLS.has((h as any).name)) continue;
            handlerMap.set(name, {
              name: (h as any).name,
              execute: async () => ({ ok: true, simulated: true, note: 'Modo teste: nada foi gravado.' }),
            } as any);
          }
        }
        // Contato JÁ marcado como não-paciente (13-NP): a ferramenta de agendar não marca nada.
        if (npLeadMark) {
          for (const [name, h] of handlerMap) {
            if ((h as any).name !== 'book_appointment') continue;
            handlerMap.set(name, {
              name: 'book_appointment',
              execute: async () => ({
                success: false,
                error: 'Este contato NÃO é paciente (emprego/fornecedor/negócio): não agende. Diga que vai repassar ao responsável.',
              }),
            } as any);
          }
        }

        // Converter chatTurns para LLMMessage format
        const llmMessages = chatTurns.map((t: any) => ({
          role: t.role as 'user' | 'assistant',
          content: t.content,
        }));

        // Add instruction as last user turn.
        // Se o último turn já é 'user' (ex: imagem), mescla a instruction nele —
        // Anthropic rejeita dois turns 'user' consecutivos (imagem + instruction).
        const lastLlmMsg = llmMessages[llmMessages.length - 1];
        if (lastLlmMsg && lastLlmMsg.role === 'user') {
          if (Array.isArray(lastLlmMsg.content)) {
            lastLlmMsg.content = [...lastLlmMsg.content, { type: 'text', text: instruction }];
          } else {
            lastLlmMsg.content = String(lastLlmMsg.content) + '\n\n' + instruction;
          }
        } else {
          llmMessages.push({ role: 'user' as const, content: instruction });
        }

        const toolExecutor = new ToolExecutor(handlerMap);
        const toolResult = await toolExecutor.execute({
          client: llmClient,
          model,
          systemPrompt,
          messages: llmMessages,
          tools: toolDefs,
          maxTokens,
          temperature,
          context: {
            conversationId: convo.id,
            leadId: convo.lead.id,
            leadPhone: convo.lead.phone,
            instanceName: convo.instance_name || null,
            prisma: this.prisma,
            s3: this.s3,
            skillAssets: skill.assets || [],
            reminderQueue: this.reminderQueue,
            memoryRetrieval: this.memoryRetrieval,
            // (teste: o tenant "zero" do Instituto vira null em tenantIdForBH; o
            // check_availability precisa dele pra achar a agenda sem conversa real)
            tenantId: tenantIdForBH || (dryRun ? convo.tenant_id : undefined) || undefined,
            dryRun,
            assistantName,
          },
        });

        toolCallLogs = toolResult.toolCallLogs;

        // Cacheia ambas as calls de interesse antes de qualquer ramificação
        const respondCall = toolCallLogs.find((l: any) => l.name === 'respond_to_client');
        const updateLeadCall = toolCallLogs.find((l: any) => l.name === 'update_lead');

        if (respondCall) {
          aiText = respondCall.input.reply || '';
          updates = respondCall.input.updates || {};
          scheduling_action = this.normalizeActionLogged(respondCall.input);
          financeiro_action = normalizeFinanceiroAction(respondCall.input);
          slotsToOffer = respondCall.input.slots_to_offer || null;
          retrySchedulingFlag =
            respondCall.input.retry_scheduling === true || respondCall.input.retry_scheduling === 'true';
          naoPacienteFromModel = normalizeNaoPaciente(respondCall.input);
        } else if (toolResult.response.content) {
          // Fallback: parse content as JSON (hybrid mode) ou texto puro
          const parsed = this.parseAiResponse(toolResult.response.content);
          aiText = parsed.reply;
          updates = parsed.updates || {};
          scheduling_action = parsed.scheduling_action || null;
          financeiro_action = parsed.financeiro_action || null;
          retrySchedulingFlag = !!parsed.retry_scheduling;
          naoPacienteFromModel = parsed.nao_paciente || null;
        }

        // Propaga stage/next_step de update_lead quando respond_to_client não trouxe status.
        // Cobre todos os paths: com ou sem respond_to_client.
        if (!updates.status && updateLeadCall) {
          if (updateLeadCall.input?.stage) {
            updates.status = updateLeadCall.input.stage;
          } else if (updateLeadCall.input?.next_step && !updates.next_step) {
            updates.next_step = updateLeadCall.input.next_step;
          }
        }

        // CRM dinâmico (pipeline_slug + stage_slug) movido para applyAiUpdates()
        // (chamado mais abaixo). Garante que o path com tools E o path legado
        // (JSON inline) usem a mesma lógica.

        // Save usage (Onda 2.2 — passa tenant_id obrigatorio)
        await this.saveUsage({
          tenant_id: (convo as any)?.tenant_id ?? null,
          conversation_id: dryRun ? null : conversation_id,
          skill_id: skill?.id ?? null,
          model,
          call_type: 'chat',
          usage: {
            prompt_tokens: toolResult.response.usage.promptTokens,
            completion_tokens: toolResult.response.usage.completionTokens,
            total_tokens: toolResult.response.usage.totalTokens,
          },
        });

        this.logger.log(`[AI] Tool calling: ${toolCallLogs.length} tools executados, reply: ${aiText.slice(0, 80)}...`);

      } else {
        // ─── PATH LEGADO: JSON mode (sem tools) ───
        const isClaudeModelLegacy = model.startsWith('claude-');
        const legacyProvider: LLMProvider = isClaudeModelLegacy ? 'anthropic' : 'openai';
        const legacyApiKey = isClaudeModelLegacy
          ? await this.settings.getAnthropicKey()
          : openAiKey;

        if (!legacyApiKey) {
          this.logger.error(`[AI] API key não encontrada para provider "${legacyProvider}" (legacy path)`);
          return;
        }

        const legacyClient = createLLMClient(legacyProvider, legacyApiKey);
        const legacyMessages = chatTurns.map((t: any) => ({
          role: t.role as 'user' | 'assistant',
          content: t.content,
        }));
        // Mesclar instrução no último turn user — evita dois user consecutivos (Anthropic rejeita)
        const lastLegacyMsg = legacyMessages[legacyMessages.length - 1];
        if (lastLegacyMsg && lastLegacyMsg.role === 'user') {
          if (Array.isArray(lastLegacyMsg.content)) {
            lastLegacyMsg.content = [...lastLegacyMsg.content, { type: 'text', text: instruction }];
          } else {
            lastLegacyMsg.content = String(lastLegacyMsg.content) + '\n\n' + instruction;
          }
        } else {
          legacyMessages.push({ role: 'user' as const, content: instruction });
        }

        const legacyResult = await legacyClient.chat({
          model,
          systemPrompt,
          messages: legacyMessages,
          maxTokens,
          temperature,
          jsonMode: true,
        });

        const completion = { choices: [{ message: { content: legacyResult.content } }] } as any;
        // Salvar usage com dados reais (Onda 2.2 — tenant_id obrigatorio)
        await this.saveUsage({
          tenant_id: (convo as any)?.tenant_id ?? null,
          conversation_id: dryRun ? null : conversation_id,
          skill_id: skill?.id ?? null,
          model,
          call_type: 'chat',
          usage: {
            prompt_tokens: legacyResult.usage.promptTokens,
            completion_tokens: legacyResult.usage.completionTokens,
            total_tokens: legacyResult.usage.totalTokens,
          },
        });

        const rawResponse =
          completion.choices[0]?.message?.content ||
          '{"reply":"Desculpe, estou com instabilidade no momento."}';

        const parsed = this.parseAiResponse(rawResponse);
        aiText = parsed.reply;
        updates = parsed.updates;
        scheduling_action = parsed.scheduling_action;
        financeiro_action = parsed.financeiro_action || null;
        slotsToOffer = parsed.slots_to_offer || null;
        retrySchedulingFlag = !!parsed.retry_scheduling;
        naoPacienteFromModel = parsed.nao_paciente || null;
      }

      this.logger.log(
        `[AI] Resposta — reply: ${aiText.slice(0, 80)}... | updates: ${JSON.stringify(updates).slice(0, 200)} | scheduling_action: ${JSON.stringify(scheduling_action) || 'null'}`,
      );
      if (!updates.status && !updates.next_step && !updates.name) {
        this.logger.warn(`[AI] updates vazio após processamento — stage não será atualizado. convo=${conversation_id}`);
      }

      // 13b. Sanitização: se aiText contém JSON cru (IA retornou JSON em vez de texto),
      // extrair apenas o campo reply para não enviar dados internos ao cliente.
      if (aiText && (aiText.includes('```json') || aiText.trimStart().startsWith('{'))) {
        const sanitized = this.parseAiResponse(aiText);
        if (sanitized.reply !== aiText) {
          this.logger.warn(`[AI] JSON cru detectado no aiText — extraindo reply (${aiText.length} chars → ${sanitized.reply.length} chars)`);
          aiText = sanitized.reply;
          // Mesclar updates extraídos se os atuais estão vazios
          if (!updates.status && sanitized.updates?.status) updates.status = sanitized.updates.status;
          if (!updates.name && sanitized.updates?.name) updates.name = sanitized.updates.name;
          if (!updates.area && sanitized.updates?.area) updates.area = sanitized.updates.area;
          if (!updates.lead_summary && sanitized.updates?.lead_summary) updates.lead_summary = sanitized.updates.lead_summary;
          if (!updates.next_step && sanitized.updates?.next_step) updates.next_step = sanitized.updates.next_step;
          if (!updates.notes && sanitized.updates?.notes) updates.notes = sanitized.updates.notes;
          if (sanitized.retry_scheduling) retrySchedulingFlag = true;
          if (!naoPacienteFromModel && sanitized.nao_paciente) naoPacienteFromModel = sanitized.nao_paciente;
          // A ação também pode ter vindo dentro do JSON cru.
          if (!isValidConfirmSlot(scheduling_action) && sanitized.scheduling_action) {
            scheduling_action = sanitized.scheduling_action;
          }
          if (!financeiro_action && sanitized.financeiro_action) financeiro_action = sanitized.financeiro_action;
        }
      }

      const isAwaitingConfirmation = reminderCtx?.awaiting_confirmation === true;
      const lastInboundForRetry = [...chronological].reverse().find((m: any) => m.direction === 'in');
      const lastInboundAt = lastInboundForRetry ? new Date(lastInboundForRetry.created_at).getTime() : 0;
      // Nossa última fala ANTES da dele (todos os balões, sem notas internas): a proposta
      // que o "sim"/"ok" dele aceitou (13a) — e, se ela propôs horário, um "ok"/"👍"
      // solto é CONFIRMAÇÃO, não encerramento (13c).
      const lastOutBeforeInbound = lastOutTurnText(chronological as any[], lastInboundAt);
      const todayStr = maceioTodayStr();
      let suppressRetry = false;
      let bookingRecovered = false;
      let teamAlertNoteId: string | null = null;
      // A 13a zerou uma ação que o MODELO emitiu (confirm_slot incompleto/inválido,
      // confirm_appointment com "agendei" de outro horário): pro SAFEGUARD v28 e pra 2ª
      // tentativa isso continua sendo "veio ação" (como antes da 13a) — senão um
      // "cancelei…" mantido no texto cancelaria a consulta real.
      let actionDroppedBy13a = false;
      // A 13a corrigiu um "agendei/remarquei" falso neste turno (a equipe foi avisada ou o
      // paciente vai confirmar): o v28 não cancela consulta por causa do texto deste
      // turno nem anexa outra proposta de horário.
      let claimCorrectedBy13a = false;
      // Resposta a lembrete com "não vou poder…" (gatilho 2 do SAFEGUARD v28: sem ação do
      // modelo, a consulta é cancelada). Calculado aqui porque a 13a precisa saber.
      const patientSaidNo =
        isAwaitingConfirmation &&
        /\b(n[ãa]o\s+(?:vou|posso|consigo|d[áa])|imprevisto|preciso\s+remarcar|n[ãa]o\s+ir(?:ei|i)|n[ãa]o\s+conseguirei|n[ãa]o\s+poderei)\b/i.test(
          String(lastInboundForRetry?.text || '').toLowerCase(),
        );

      // 13-NP. NÃO É CONSULTA — emprego/currículo/entrevista, fornecedor, negociação/
      // contrato/reunião comercial, parceria, imprensa. Vale quando o MODELO marcou
      // "nao_paciente", o classificador marcou (handoff não saiu) ou o lead JÁ está
      // marcado (não reclassifica). Bloqueado: confirm_slot descartado, sem rede 13a, sem
      // 2ª tentativa e sem oferta de horário; a resposta é a da IA quando serve (sem
      // horário/reunião e, no handoff, dizendo que repassa), senão o texto fixo de repasse.
      // Depois do envio: toggle da triagem ligado → handoff (pausa + marca + ADMs); senão
      // só ALERTA interno (nota + sininho), sem pausar e SEM gravar a marca no lead (um
      // erro do modelo não pode tirar a agenda do lead pra sempre).
      // Chip Financeiro só conversa com quem já é paciente (cobrança, negociação da dívida
      // do próprio tratamento): marca de não-paciente lá é falso positivo — não vale.
      const npOnFinanceiro = profilePurpose === 'FINANCEIRO';
      if (naoPacienteFromModel && npOnFinanceiro) {
        this.logger.warn(
          `[AI][NÃO-PACIENTE] modelo marcou ${naoPacienteFromModel.categoria} no chip Financeiro — ignorado (conv ${convo.id})`,
        );
      }
      // Sinal contraditório no MESMO turno (confirm_slot / ofereceu horário / "agendei"):
      // na dúvida, é PACIENTE — a marca do modelo não vale.
      const npModelContradicts =
        !!naoPacienteFromModel &&
        !npOnFinanceiro &&
        contradictsNonPatient(aiText, { confirmSlot: isValidConfirmSlot(scheduling_action) });
      if (npModelContradicts) {
        this.logger.warn(
          `[AI][NÃO-PACIENTE] modelo marcou ${naoPacienteFromModel!.categoria}, mas marcou/ofereceu horário no mesmo turno — tratado como paciente (conv ${convo.id})`,
        );
      }
      const npBlock = decideNonPatientBlock({
        fromModel: npOnFinanceiro ? null : naoPacienteFromModel,
        fromClassifier: npClassified,
        leadCategory: npOnFinanceiro ? null : npLeadMark,
        isClient: isActiveClient,
        modelSchedules: npModelContradicts,
      });
      const npTenantId: string | null = convo.tenant_id || convo.lead?.tenant_id || null;
      let npHandoff = false;
      if (npBlock.blocked) {
        if (scheduling_action?.action === 'confirm_slot') {
          this.logger.warn(
            `[AI][NÃO-PACIENTE] confirm_slot DESCARTADO — contato não é paciente (${npBlock.categoria}, ${npBlock.origem}): ${JSON.stringify(scheduling_action)} (conv ${convo.id})`,
          );
          scheduling_action = null;
        }
        retrySchedulingFlag = false;
        // Handoff com pausa: só detectado AGORA, contato/chip elegível, toggle ligado e sem
        // ficha de paciente ligada ao lead (no chat de teste só mostra que faria).
        npHandoff =
          npBlock.novo &&
          npEligible &&
          (await this.nonPatientTriageOn(npTenantId)) &&
          (dryRun || !(await this.leadHasPatientRecord(convo)));
        const chosen = chooseNonPatientReply(aiText, { requireRepasse: npHandoff, alreadyMarked: !npBlock.novo });
        if (chosen.replaced) {
          this.logger.warn(
            `[AI][NÃO-PACIENTE] resposta da IA trocada pelo texto de repasse (oferecia horário/reunião ou não dizia que repassa) (conv ${convo.id}): "${aiText.slice(0, 160)}"`,
          );
          // Lead JÁ marcado e a resposta da IA (com horário/"agendei") foi trocada: avisa a
          // equipe — sem isso um paciente marcado por engano ficava sem agenda, em silêncio.
          if (npBlock.origem === 'lead' && npBlock.categoria && aiText.trim() && !dryRun) {
            teamAlertNoteId =
              (await this.alertTeamNonPatient(
                convo,
                { categoria: npBlock.categoria, resumo: npBlock.resumo },
                lastInboundForRetry?.text || null,
                { alreadyMarked: true },
              )) || teamAlertNoteId;
          }
        }
        aiText = chosen.text;
        this.logger.log(
          `[AI][NÃO-PACIENTE] conv ${convo.id}: ${npBlock.categoria} (${npBlock.origem}${npBlock.novo ? ', novo' : ', já marcado'}) — agenda bloqueada${npHandoff ? ', handoff com pausa' : ''}`,
        );
      }

      // 13a. REDE DE SEGURANÇA — "disse que agendou sem confirm_slot". As skills rodam
      // no caminho JSON legado e o modelo às vezes responde "Perfeito, deixei agendado"
      // sem emitir a ação (ou com ela incompleta): nada era criado e a frase falsa ia
      // pro paciente. Filtro de ENTRADA: findBookingClaims; quem DECIDE é o
      // assessBookingClaim (scheduling-safety.ts):
      //  - resposta sobre consulta que JÁ existe → não mexe;
      //  - proposta ("vou deixar agendado terça às 9h, pode ser?") → não mexe;
      //  - SÓ MARCA (sintetiza o confirm_slot e segue o caminho normal: freio,
      //    Orçamentista e guardas do book_appointment) quando é afirmação de FATO, sem
      //    pergunta, de UM horário livre, o paciente ACEITOU esse horário e ele não tem
      //    consulta futura;
      //  - senão a frase falsa NÃO sai: vira pedido de confirmação / oferta sem o que ele
      //    recusou (buildBookingFixText) ou, sem como marcar, resposta honesta + alerta pra
      //    equipe, mantendo o resto da resposta.
      // Vale também na resposta a lembrete ("sua consulta está confirmada" é 'existing') e
      // com confirm_appointment / reschedule_appointment / cancel_appointment: nenhuma
      // delas marca horário NOVO — "deixei agendado X" / "remarquei pra X" com elas é falso.
      // Não vale na 2ª tentativa, no chip Financeiro ("o pagamento ficou agendado" não é
      // consulta) nem pra quem não é paciente (13-NP).
      const netAction: string | null = scheduling_action?.action || null;
      if (
        !npBlock.blocked &&
        !isSchedulingRetry &&
        profilePurpose !== 'FINANCEIRO' &&
        !isValidConfirmSlot(scheduling_action)
      ) {
        if (scheduling_action?.action === 'confirm_slot') {
          this.logger.warn(`[AI] confirm_slot incompleto: ${JSON.stringify(scheduling_action)} (conv ${convo.id})`);
        }
        if (findBookingClaims(aiText, todayStr).length) {
          const existingStarts = await this.futureClinicalStarts(convo);
          // Resposta a lembrete: a consulta do lembrete conta como "já tem" (mesmo se o tipo
          // do evento estiver fora da busca) — "sua consulta está confirmada" não é corrigida.
          const reminderStart = isAwaitingConfirmation ? new Date(String(reminderCtx?.event_date_iso || '')) : null;
          if (reminderStart && Number.isFinite(reminderStart.getTime()) && !existingStarts.some((d) => d.getTime() === reminderStart.getTime())) {
            existingStarts.push(reminderStart);
          }
          const decision = assessBookingClaim({
            reply: aiText,
            freeDays: freeSlotDays,
            todayStr,
            patientText: lastInboundForRetry?.text || null,
            lastOutText: lastOutBeforeInbound,
            existingStarts,
            hint:
              scheduling_action?.action === 'confirm_slot'
                ? { date: scheduling_action.date, time: scheduling_action.time }
                : null,
          });
          if (decision.kind === 'book') {
            scheduling_action = { action: 'confirm_slot', date: decision.slot.date, time: decision.slot.time };
            bookingRecovered = true;
            this.logger.warn(
              `[AI] confirm_slot RECUPERADO do texto (${decision.slot.date} ${decision.slot.time}) — a IA disse que agendou sem emitir a ação e o paciente aceitou esse horário (conv ${convo.id})`,
            );
          } else if (decision.kind === 'existing') {
            this.logger.log(
              `[AI] Resposta fala de consulta que já existe — rede de segurança do "agendei" não interfere (conv ${convo.id})`,
            );
          } else if (decision.kind === 'offer') {
            this.logger.log(
              `[AI] Resposta é proposta com pedido de confirmação ("vou deixar agendado…?") — nada é marcado, texto mantido (conv ${convo.id})`,
            );
          } else if (decision.kind === 'correct') {
            this.logger.warn(
              `[AI] disse que agendou sem confirm_slot (${decision.why}) — NÃO marca; corrigindo a resposta (conv ${convo.id}): "${aiText.slice(0, 160)}"`,
            );
            claimCorrectedBy13a = true;
            // Cancelar/remarcar que o modelo emitiu continua valendo (o paciente pediu: 15c/
            // 15e cancelam a consulta atual) — só a frase falsa do horário NOVO cai. O resto
            // (confirm_slot incompleto, confirm_appointment de outro horário) não serve.
            const keepsCancel = netAction === 'cancel_appointment' || netAction === 'reschedule_appointment';
            if (!keepsCancel) {
              if (netAction) actionDroppedBy13a = true;
              scheduling_action = null;
            }
            // A consulta que ele tem vai MESMO ser cancelada neste turno? (ação acima, ou o
            // gatilho 2 do v28: lembrete + "não vou poder" sem ação do modelo.)
            const oldCancelled = decision.hasExisting && (keepsCancel || (patientSaidNo && !netAction));
            // "Cancelei sua consulta anterior" mantido no texto só fica se for verdade (o
            // novo horário NÃO foi marcado: a anterior continua ativa).
            const cancelStrip = oldCancelled ? { text: decision.keepText, stripped: false } : stripCancellationClaims(decision.keepText);
            if (cancelStrip.stripped) {
              this.logger.warn(`[AI] 13a tirou "cancelei…" da resposta — a consulta anterior NÃO foi cancelada (conv ${convo.id})`);
            }
            const fixDecision = { ...decision, keepText: cancelStrip.text };
            // Paciente com consulta (remarcação?) → não oferece outro: a equipe resolve.
            const autobookOn =
              !decision.hasExisting && (await isAiAutobookEnabled(this.prisma, (convo as any)?.tenant_id));
            // Pediu um horário que não está livre: as alternativas nunca são ele.
            const requestedSlot: SlotRef | null =
              decision.requested?.date && decision.requested?.time
                ? { date: decision.requested.date, time: decision.requested.time }
                : null;
            let alts: SlotRef[] = [];
            let altsFromClaim = false;
            if (autobookOn) {
              // Horário(s) identificado(s) — conferidos com a mesma regra de conflito da guarda.
              if (decision.propose.length) {
                alts = assignedDentistId
                  ? await this.pickVerifiedAlternatives(
                      decision.propose.map((s) => ({ date: s.date, times: [s.time] })),
                      null,
                      assignedDentistId,
                      [],
                      Math.min(3, decision.propose.length),
                    )
                  : decision.propose;
                altsFromClaim = alts.length > 0;
              }
              if (!alts.length) {
                // Recusou: nenhuma alternativa cai no que ele recusou (horário, dia, hora, turno).
                const pool = withoutRefused(freeSlotDays, decision.refused);
                alts = assignedDentistId
                  ? await this.pickVerifiedAlternatives(pool, requestedSlot, assignedDentistId, [])
                  : pickAlternativeSlots(pool, requestedSlot, 2);
              }
            }
            let fix: string;
            if (alts.length) {
              // Pediu horário que não está livre → "Não consegui X. Tenho A ou B…"; recusou →
              // oferta "Sem problemas! Tenho A ou B…"; senão pede a confirmação (o próximo
              // "pode ser" vira confirm_slot normal).
              fix = buildBookingFixText(fixDecision, alts, altsFromClaim);
            } else {
              const slot = decision.propose.length === 1 ? decision.propose[0] : requestedSlot;
              // Depois de RECUSA não houve escolha dele: "a recepção te chama com outras opções".
              const refusedNoChoice = decision.offer || (!!decision.refused && !slot);
              fix = buildHonestPreferenceText(slot, fixDecision);
              suppressRetry = true;
              if (!dryRun) {
                teamAlertNoteId = await this.alertTeamBookingIssue(convo, {
                  slot: refusedNoChoice ? null : slot,
                  reason: decision.hasExisting
                    ? oldCancelled
                      ? 'o paciente pediu pra remarcar/cancelar: a consulta anterior foi CANCELADA e o novo horário NÃO foi marcado — marquem com ele'
                      : 'o paciente já tem consulta e a IA disse que marcou outro horário (remarcação?) — o novo horário NÃO foi marcado e a consulta que ele já tem CONTINUA ATIVA (não foi cancelada)' +
                        (cancelStrip.stripped ? '; a IA também disse que tinha cancelado a anterior (frase tirada da resposta)' : '')
                    : !autobookOn
                      ? 'agendamento automático pela IA desligado nesta clínica'
                      : refusedNoChoice
                        ? 'o paciente recusou o horário e não havia outro livre pra oferecer — chamem com outras opções'
                        : 'a IA disse que tinha agendado, mas não havia horário livre pra marcar',
                  detail: lastInboundForRetry?.text || null,
                });
              }
            }
            // Mantém o resto da resposta (ex.: o preço que ele perguntou), sem a frase falsa.
            aiText = fixDecision.keepText ? `${fixDecision.keepText}\n\n${fix}` : fix;
          }
        }
      }

      // 13b-2. Remarcação sem horário na resposta, ou horário PROMETIDO e não listado
      // ("Sem problemas! Vou te passar outros horários."): a IA só fala quando o paciente
      // escreve — ninguém mandaria os horários depois. Lista 2–3 vagas reais AGORA, na
      // mesma resposta. Roda antes do 15e: a consulta que ele está largando ainda ocupa
      // a agenda, então o mesmo horário não volta na oferta. Com horário listado, a 2ª
      // tentativa e o v28 não repetem a oferta (replyProposesSlots / aiProposedSlots).
      if (
        !isSchedulingRetry &&
        !npBlock.blocked &&
        !claimCorrectedBy13a &&
        profilePurpose !== 'FINANCEIRO' &&
        (scheduling_action?.action === 'reschedule_appointment' || promisesSlotsLater(aiText)) &&
        !replyListsSlots(aiText)
      ) {
        const offer = await this.buildRescheduleSuggestion(convo, { continuing: true, readOnly: dryRun });
        if (offer) {
          aiText = `${aiText.trimEnd()}\n\n${offer}`;
          this.logger.log(
            `[AI] conv ${conversation_id}: ${scheduling_action?.action === 'reschedule_appointment' ? 'remarcação' : 'prometeu horários'} sem listar — vagas listadas na mesma resposta`,
          );
        } else {
          this.logger.warn(`[AI] conv ${conversation_id}: prometeu horários mas não há vaga pra listar`);
        }
      }

      // 13c. Vai ter 2ª tentativa de agendamento? Pelo modelo (retry_scheduling) ou
      // pela REDE DE SEGURANÇA: a última mensagem do paciente é um encerramento curto
      // ("ok", "vou pensar") e a resposta não propõe horário. Nunca numa resposta que
      // já oferece horário, com scheduling_action (confirmou/cancelou/remarcou), no
      // chip Financeiro, pra quem já é paciente (Pós-Venda) ou se a própria resposta
      // já é a 2ª tentativa. Consulta futura é conferida no banco ao agendar.
      // A conversa já estava em andamento (a IA/equipe falou antes do "ok") — um "ok"
      // solto de lead novo não dispara a tentativa.
      const hadPriorReply = chronological.some(
        (m: any) => m.direction === 'out' && new Date(m.created_at).getTime() < lastInboundAt,
      );
      const retryBySafetyNet =
        !retrySchedulingFlag && isClosingWithoutScheduling(lastInboundForRetry?.text, lastOutBeforeInbound);
      const retryEligible =
        !isSchedulingRetry &&
        !suppressRetry &&
        // Quem não é paciente (13-NP) nunca recebe tentativa de agendamento.
        !npBlock.blocked &&
        hadPriorReply &&
        aiProfile.schedulingRetryMin > 0 &&
        // Lead marcado como perdido nesta resposta (recusou) → não insiste.
        updates?.status !== 'PERDIDO' &&
        updates?.next_step !== 'perdido' &&
        !updates?.loss_reason &&
        profilePurpose !== 'FINANCEIRO' &&
        !isActiveClient &&
        modelEmittedNoAction(scheduling_action, actionDroppedBy13a) &&
        !!aiText.trim() &&
        !replyProposesSlots(aiText);
      const wantsSchedulingRetry = retryEligible && (retrySchedulingFlag || retryBySafetyNet);
      const retryReason = retrySchedulingFlag ? 'modelo marcou retry_scheduling' : 'rede de segurança (encerramento curto)';
      if (retrySchedulingFlag || retryBySafetyNet) {
        this.logger.log(
          `[AI-RETRY] conv ${conversation_id}: ${retryReason} → ${wantsSchedulingRetry ? `2ª tentativa em ${aiProfile.schedulingRetryMin} min` : 'NÃO elegível (perfil/chip/paciente/ação/horário na resposta)'}`,
        );
      }

      // A 2ª tentativa NUNCA agenda/cancela sozinha (o paciente não respondeu a ela) e
      // só sai se de fato propõe horário — senão seria outra mensagem de encerramento solta.
      if (isSchedulingRetry) {
        scheduling_action = null;
        if (!replyProposesSlots(aiText)) {
          this.logger.log(`[AI-RETRY] conv ${conversation_id}: resposta sem horário — 2ª tentativa NÃO enviada`);
          if (dryRun) {
            return {
              dryRun: true,
              bubbles: [],
              schedulingRetry: true,
              retrySkipped: 'A IA não montou uma proposta com horários — a 2ª tentativa não seria enviada.',
              model,
              skill: skill?.name || null,
            };
          }
          return;
        }
      }

      // Chat de teste: devolve a resposta (já em balões) e PARA aqui — nada abaixo
      // (salvaguardas de agenda, updates do lead, envio, gravação) roda no teste.
      if (dryRun) {
        const handoff = skill?.handoff_signal;
        const willHandoff = !!handoff && aiText.includes(handoff);
        const reply = tidyReply(stripHistoryLabels(willHandoff ? aiText.split(handoff).join('') : aiText));
        // Funil/etapa em que ela lançaria o contato no CRC (nada é gravado no teste).
        let funnel: { pipeline: string | null; stage: string | null } | null = null;
        try {
          const testPipelines = await loadPipelinesForTenant(this.prisma as any, convo.tenant_id ?? null);
          funnel = describeFunnelChoice(testPipelines, updates);
        } catch {
          // o teste segue sem o funil
        }
        return {
          dryRun: true,
          funnel,
          bubbles: splitIntoBubbles(reply, maxBubbles, patientStyle),
          // 2ª tentativa de agendamento: esta resposta marcaria a tentativa (modelo ou
          // rede de segurança, e o perfil permite)? E em quantos minutos. Com
          // schedulingRetry no job, os balões acima SÃO a tentativa ("Ver como seria").
          schedulingRetry: isSchedulingRetry,
          retryScheduling: wantsSchedulingRetry && !willHandoff,
          retryAfterMin: aiProfile.schedulingRetryMin,
          // Jeito DETECTADO do paciente (a escolha da clínica vai em profile.effectiveStyle).
          patientStyle: detectPatientStyle(chronological as any[]),
          // Perfil aplicado (Ajustes › IA) — a tela mostra nome/tamanho usados no teste.
          profile: {
            assistantName,
            replyLength: aiProfile.replyLength,
            effectiveStyle: patientStyle,
          },
          skill: skill?.name || null,
          model,
          handoff: willHandoff,
          scheduling_action: scheduling_action || null,
          // true = a IA disse "agendei" sem a ação e o horário foi recuperado do texto.
          schedulingRecovered: bookingRecovered,
          // Não é consulta (13-NP): categoria/resumo e se faria o handoff com pausa.
          naoPaciente: npBlock.blocked
            ? { categoria: npBlock.categoria, resumo: npBlock.resumo, origem: npBlock.origem, handoff: npHandoff }
            : null,
          tools: toolCallLogs.map((l: any) => l.name).filter((n: string) => n !== 'respond_to_client'),
        };
      }

      // 14. Verificar sinal de escalada (handoff para humano)
      let finalText = aiText;

      // Onda 5e v28 (Fase 25) — SAFEGUARDS REFORÇADOS pra cancelamento.
      // Bug recorrente: IA respondia "cancelei sua consulta" mas evento
      // permanecia na agenda E IA nao propunha remarcacao. v22 detectava
      // só "cancelei/cancelado/removi/desmarquei". v28 expande pra 3 camadas:
      //
      // CAMADA 1: dicionario AMPLIADO de palavras de "encerrar agendamento"
      //   ('cancelei', 'fica pra próxima', 'remarcar mais tarde', 'anotei aqui',
      //   'ficou pra próximo', 'sem problemas, fica pra', 'tudo bem, te aviso',
      //   'desmarquei', 'tirei da agenda', etc)
      //
      // CAMADA 2: contexto awaiting_confirmation + sinal NEGATIVO do paciente
      //   Se reminder_context.awaiting_confirmation=true E ultima msg do
      //   paciente contem "nao posso/vou/consigo" → forca acao mesmo sem IA
      //   ter usado palavras chave
      //
      // CAMADA 3: log estruturado pra rastreabilidade
      //   Sempre logamos qual camada disparou, com excerpt da resposta
      // (reminderCtx e isAwaitingConfirmation já foram declarados acima — reutilizamos aqui)
      // Pega ultima msg do paciente (direction='in') — vem de chronological
      const lastInbound = chronological?.filter((m: any) => m.direction === 'in')?.slice(-1)?.[0];
      const lastInboundText = (lastInbound?.text || '').toLowerCase();
      // (patientSaidNo — gatilho 2 — é calculado antes da 13a, com a mesma regra.)

      // Detecta palavras-chave AMPLIADAS de "encerrar/abandonar agendamento". Texto que a
      // 13a corrigiu neste turno não arma o gatilho: o "agendei/remarquei" era falso, a
      // equipe foi avisada e a consulta que ele tem fica como está.
      const aiSaysCancel = !claimCorrectedBy13a && finalText && /\b(cancelei|cancelado|cancelada|removi|desmarquei|tirei\s+da\s+agenda|fica\s+pra?\s+(?:pr[oó]xima|outro\s+dia)|deixa\s+pra?\s+depois|fica\s+pra\s+depois|anotei\s+(?:aqui|que)|ficou\s+pra\s+(?:pr[oó]xima|depois)|removi\s+da\s+agenda)\b/i.test(finalText);

      // Detecta proposta de horarios novos (formato comum: "DD/MM as HH:MM" ou bullet "• ")
      const aiProposedSlots = finalText && (
        /\b\d{1,2}\/\d{1,2}\b.*\b\d{1,2}[:h]\d{2}\b/i.test(finalText) ||
        finalText.includes('•') ||
        /tenho\s+(?:essas|essa|esse|esses)\s+(?:opç[ãoe]es|hor[áa]rios)/i.test(finalText) ||
        /(?:que\s+tal|posso\s+te?\s+encaixar|consigo\s+te?\s+encaixar)/i.test(finalText)
      );

      // Ação que o modelo emitiu e a 13a zerou (confirm_slot incompleto) conta como
      // ação — igual a antes da 13a; senão o "cancelei…" mantido no texto armaria o v28.
      const noActionFromAi = modelEmittedNoAction(scheduling_action, actionDroppedBy13a);

      this.logger.log(
        `[AI-SAFEGUARD] convo=${convo.id} awaiting=${isAwaitingConfirmation} patientNo=${patientSaidNo} aiCancel=${aiSaysCancel} aiProposed=${aiProposedSlots} action=${scheduling_action?.action || 'null'}`
      );

      // GATILHO 1: IA usou palavra de cancelamento sem emitir action
      // GATILHO 2: lead negou + IA nao emitiu action nem propos horarios novos
      // (2ª tentativa: o "não" do paciente é antigo e já foi tratado no turno normal.)
      const shouldForceCancel = !isSchedulingRetry && noActionFromAi && (aiSaysCancel || patientSaidNo);

      if (shouldForceCancel) {
        const reason = aiSaysCancel
          ? `IA usou palavra de encerrar agendamento sem emitir action`
          : `Paciente negou (awaiting_confirmation) e IA nao propos horarios novos nem cancelou explicitamente`;
        this.logger.warn(
          `[AI] HALLUCINATION DETECTED (${reason}). conv=${convo.id} reply="${finalText.slice(0, 200)}" lastIn="${lastInboundText.slice(0, 100)}"`,
        );
        // Cancela eventos futuros do lead (mesma logica do handler cancel_appointment)
        try {
          const cancelled = await (this.prisma as any).calendarEvent.findMany({
            where: {
              OR: [{ conversation_id: convo.id }, { lead_id: convo.lead.id }],
              type: { in: ['CONSULTA', 'PROCEDIMENTO', 'RETORNO'] },
              status: { notIn: ['CANCELADO', 'CONCLUIDO'] },
              start_at: { gte: maceioNowNaive() }, // agenda naive-UTC: "agora" de Maceió
            },
            select: { id: true, title: true, start_at: true },
          });
          for (const ev of cancelled) {
            await (this.prisma as any).calendarEvent.update({
              where: { id: ev.id },
              data: {
                status: 'CANCELADO',
                description: `[CANCELADO via SAFEGUARD v28 — ${reason} ${new Date().toISOString()}]`,
              },
            });
            await (this.prisma as any).eventReminder.deleteMany({
              where: { event_id: ev.id, sent_at: null },
            });
            this.logger.log(`[AI] Safeguard cancelou evento ${ev.id} (${ev.title}) start=${ev.start_at?.toISOString()}`);
          }
          // Limpa awaiting_confirmation pra nao re-disparar
          if (isAwaitingConfirmation) {
            await (this.prisma as any).conversation.update({
              where: { id: convo.id },
              data: { reminder_context: { ...reminderCtx, awaiting_confirmation: false, cancelled_via_safeguard_at: new Date().toISOString() } },
            });
          }
          // Onda v28: APPENDA proposta de remarcacao na resposta da IA se ela
          // nao ofereceu nenhuma. Estrategia de venda: paciente que so ouve
          // "ok cancelei" tem ~70% chance de nao voltar.
          // (Nunca pra quem não é paciente — 13-NP: sem oferta de horário.)
          // (Nem quando a 13a corrigiu o texto: a resposta já diz que a recepção confirma.)
          if (!aiProposedSlots && cancelled.length > 0 && !npBlock.blocked && !claimCorrectedBy13a) {
            // O horário que acabou de ser cancelado não volta na oferta.
            const slotsAppend = await this.buildRescheduleSuggestion(convo, {
              exclude: cancelled
                .filter((ev: any) => ev.start_at)
                .map((ev: any) => {
                  const iso = new Date(ev.start_at).toISOString();
                  return { date: iso.slice(0, 10), time: iso.slice(11, 16) };
                }),
            });
            if (slotsAppend) {
              finalText = finalText.trimEnd() + '\n\n' + slotsAppend;
              this.logger.log(`[AI] Safeguard APPENDOU proposta de remarcacao na resposta`);
            }
          }
        } catch (e: any) {
          this.logger.warn(`[AI] Safeguard de cancelamento falhou: ${e.message}`);
        }
      }

      const handoffSignal = skill?.handoff_signal || null;
      const handedOff = !!handoffSignal && finalText.includes(handoffSignal);
      if (handoffSignal && finalText.includes(handoffSignal)) {
        finalText = finalText
          .replace(new RegExp(handoffSignal, 'g'), '')
          .trim();
        await (this.prisma as any).conversation.update({
          where: { id: conversation_id },
          data: { ai_mode: false },
        });
        this.logger.log(
          `[AI] Sinal de escalada detectado ("${handoffSignal}") — ai_mode desativado para ${conversation_id}`,
        );
      }

      // 13-NP (sem handoff): toggle da triagem desligado, chip/contato sem handoff ou ficha
      // de paciente → só ALERTA interno (nota + sininho) com o tipo e o resumo; a IA NÃO
      // é pausada e o lead NÃO é marcado (a marca só nasce no handoff, que a recepção
      // desfaz religando a IA — aqui ninguém religaria e um erro do modelo bloquearia a
      // agenda do lead pra sempre, em silêncio). O handoff com pausa roda depois do envio.
      if (npBlock.novo && !npHandoff && npBlock.categoria) {
        const npFlag = { categoria: npBlock.categoria, resumo: npBlock.resumo };
        teamAlertNoteId =
          (await this.alertTeamNonPatient(convo, npFlag, lastInboundForRetry?.text || null)) || teamAlertNoteId;
      }

      // 14a. Reply vazio = conversa encerrada — IA decidiu não responder
      // (ex: cliente disse "obrigado" após despedida, loop detectado)
      if (!finalText || !finalText.trim()) {
        this.logger.log(`[AI] Reply vazio — conversa encerrada, IA não responde (conv ${conversation_id})`);
        // Ainda aplica updates e salva log, mas não envia mensagem
        await this.applyAiUpdates(updates, convo.id, convo.lead.id, convo.lead.phone, convo.instance_name || null);
        return;
      }

      // 14b. Salvar log de execução da skill (observabilidade)
      // Onda 2.4 — tenant_id obrigatorio pra dashboard "qual skill mais
      // usada por clinica". Fallback dummy pra leads legacy sem tenant.
      try {
        await (this.prisma as any).skillExecutionLog.create({
          data: {
            tenant_id: (convo as any)?.tenant_id || '00000000-0000-0000-0000-000000000000',
            conversation_id,
            skill_id: skill?.id || null,
            tool_calls_json: toolCallLogs.length > 0 ? toolCallLogs : undefined,
            selection_reason: routerReason || null,
            router_tokens: routerTokens || null,
            duration_ms: Date.now() - (job.processedOn || Date.now()),
          },
        });
      } catch { /* non-critical */ }

      // 15. Aplicar updates automaticamente
      await this.applyAiUpdates(
        updates,
        convo.id,
        convo.lead.id,
        convo.lead.phone,
        convo.instance_name || null,
      );

      // 15b. Processar scheduling_action (agendamento automático de avaliação)
      // ⚠️ REGRA: TODA avaliação inicial vai pra um dentista com especialidade
      // "Orçamentista" (ver apps/worker/src/ai/orcamentista.ts). Se a conversa
      // tem outro dentista atribuído (ex: especialista em Implantes), o helper
      // ensureOrcamentistaAssigned() reatribui pra um Orçamentista antes de criar
      // o evento. Se não houver NENHUM Orçamentista cadastrado → não cria evento
      // e loga warning (operador precisa marcar manualmente).
      if (isValidConfirmSlot(scheduling_action)) {
        const slot: SlotRef = { date: scheduling_action.date, time: scheduling_action.time };
        // Sem como marcar (freio, sem Orçamentista, recusa sem alternativa, erro):
        // resposta honesta + alerta pra equipe. Antes era "Deixa eu confirmar esse
        // horário certinho e já te retorno" — e ninguém retornava.
        const honestAndAlert = async (reason: string) => {
          finalText = buildHonestPreferenceText(slot);
          teamAlertNoteId =
            (await this.alertTeamBookingIssue(convo, { slot, reason, detail: lastInboundForRetry?.text || null })) ||
            teamAlertNoteId;
        };
        try {
          // FREIO — agendamento automático pela IA é OPT-IN (default OFF). Sem isso,
          // a IA NÃO cria a "Avaliação" sozinha (evita "agendando o pessoal sozinho").
          if (!(await isAiAutobookEnabled(this.prisma, (convo as any)?.tenant_id))) {
            this.logger.warn(
              `[AI] Auto-agendamento DESATIVADO (tenant ${(convo as any)?.tenant_id ?? 'null'}) — Avaliação NÃO criada (${slot.date} ${slot.time}); operador confirma manualmente.`,
            );
            // Autobook OFF → NENHUM evento é criado. Não deixa a IA dizer "Agendei"
            // (falso): responde honesto e avisa a equipe com o horário pedido.
            await honestAndAlert('agendamento automático pela IA desligado nesta clínica');
          } else {
          const dentistId = await ensureOrcamentistaAssigned(this.prisma as any, convo.id);

          if (!dentistId) {
            this.logger.warn(
              `[AI] confirm_slot ${slot.date} ${slot.time} — NENHUM Orçamentista cadastrado no tenant. CalendarEvent NÃO criado. Lead ${convo.lead.id} ficará em "avaliacao-aceita" sem evento — operador precisa atribuir um Orçamentista (Settings → Usuários) e agendar manualmente.`,
            );
            // Sem Orçamentista não há evento — NÃO deixa a IA dizer "agendei" (falso).
            await honestAndAlert('nenhum dentista Orçamentista cadastrado');
          } else {
            // Onda 18.x — DELEGA pro book_appointment em vez do createCalendarEvent CRU.
            // O caminho antigo criava o evento SEM validação (conflito/feriado/passado/
            // turno/dedup/devedor) e com FUSO LOCAL errado (setHours) — a agenda é
            // naive-UTC. book_appointment tem TODAS as guardas + Date.UTC + lembretes
            // (1d/1h/15min) + notifica dentista. ensureOrcamentistaAssigned acima já
            // travou a Dra. Suellen em assigned_dentist_id, que o handler lê.

            // (1) REMARCAÇÃO — consultas FUTURAS ativas desta MESMA conversa. Só são
            // canceladas DEPOIS que a nova foi marcada (antes eram canceladas ANTES do
            // book: se a guarda recusasse, o lead perdia a consulta que tinha). O book
            // ignora essas na checagem de conflito/dedup (ignoreEventIds) — senão
            // mover 9h → 9h30 batia na própria consulta antiga.
            // Horário RECUPERADO do texto (13a) nunca é remarcação: só é sintetizado sem
            // consulta futura — e não cancela nada (nem consulta fora da busca do 13a).
            // Alerta da IA pra equipe nas últimas horas (ex.: "já tem consulta, disse que
            // marcou outro — remarcação?") → NÃO cancela a anterior: pode ser a consulta
            // real dele (o novo horário era da filha…) e a recepção está resolvendo.
            const openTeamAlert = hasRecentAiTeamNote(convo.messages || []);
            if (openTeamAlert && !bookingRecovered) {
              this.logger.warn(
                `[AI] confirm_slot ${slot.date} ${slot.time} com alerta da IA em aberto nesta conversa — NÃO cancela consulta anterior (conv ${convo.id})`,
              );
            }
            let prev: { id: string }[] = [];
            try {
              if (!bookingRecovered && !openTeamAlert) {
                prev = await (this.prisma as any).calendarEvent.findMany({
                  where: {
                    conversation_id: convo.id,
                    type: 'CONSULTA',
                    status: { notIn: ['CANCELADO', 'CONCLUIDO'] },
                    start_at: { gt: maceioNowNaive() },
                  },
                  select: { id: true },
                });
              }
            } catch (e: any) {
              this.logger.warn(`[AI] Falha ao buscar consulta anterior (reagendamento) conv ${convo.id}: ${e?.message}`);
            }

            // (2) DELEGA. skipPatientNotify=true — a confirmação ao paciente é o próprio
            // finalText da IA; sem isso o handler manda a confirmação DELE tambem → 2 msgs.
            // eslint-disable-next-line @typescript-eslint/no-var-requires
            const { BookAppointmentHandler } = require('./tool-handlers/book-appointment');
            const bookResult = await new BookAppointmentHandler().execute(
              {
                date: slot.date,
                time: slot.time,
                // Avaliação inicial com a Orçamentista: o procedimento vai no TÍTULO (o
                // nome do paciente o card da agenda já mostra). A descrição ("Avaliação
                // agendada pela IA (<assistente>) pelo WhatsApp — paciente novo") o
                // handler monta.
                title: 'Avaliação',
              },
              {
                prisma: this.prisma,
                conversationId: convo.id,
                leadId: convo.lead.id,
                reminderQueue: this.reminderQueue,
                skipPatientNotify: true,
                ignoreEventIds: prev.map((p) => p.id),
                assistantName,
              } as any,
            );
            if (bookResult?.success) {
              this.logger.log(
                `[AI] Consulta agendada (Dra. Suellen): ${slot.date} ${slot.time} evt=${bookResult.eventId}${bookResult.already_booked ? ' (ja existia)' : ''}${bookingRecovered ? ' [recuperado do texto]' : ''}`,
              );
              // (3) Remarcação: agora sim cancela as anteriores (nunca a que acabou de
              // ser marcada/reaproveitada).
              const toCancel = prev.filter((p) => p.id !== bookResult.eventId);
              try {
                for (const old of toCancel) {
                  await (this.prisma as any).calendarEvent.update({
                    where: { id: old.id },
                    data: { status: 'CANCELADO', description: `[CANCELADO — reagendamento via IA em ${new Date().toISOString()}]` },
                  });
                  await (this.prisma as any).eventReminder.deleteMany({ where: { event_id: old.id, sent_at: null } });
                }
                if (toCancel.length) {
                  this.logger.log(`[AI] Reagendamento: ${toCancel.length} consulta(s) anterior(es) da conv ${convo.id} CANCELADA(s) depois de marcar a nova.`);
                }
              } catch (e: any) {
                this.logger.warn(`[AI] Falha ao cancelar consulta anterior (reagendamento) conv ${convo.id}: ${e?.message}`);
              }
            } else {
              // (4) Guarda recusou. O finalText ("agendei") ainda NÃO foi enviado → SOBRESCREVE
              // pra NÃO confirmar falso. Recusa DESTE horário (ocupado/passado/turno/feriado/
              // bloqueio) → oferece 2 horários livres NOVOS; recusa que vale pra qualquer
              // horário (devedor…) ou sem alternativa → honesto + alerta pra equipe.
              const err = String(bookResult?.error || 'erro desconhecido');
              this.logger.warn(
                `[AI] confirm_slot RECUSADO pela guarda (${slot.date} ${slot.time}): ${err} — evento NÃO criado; corrigindo a resposta (conv ${convo.id}).`,
              );
              const alts = isSlotSpecificRefusal(err)
                ? await this.pickVerifiedAlternatives(freeSlotDays, slot, dentistId, prev.map((p) => p.id))
                : [];
              if (alts.length) {
                finalText = buildSlotTakenText(alts);
              } else {
                await honestAndAlert(`agenda recusou: ${err}`);
              }
            }
          }
          }
        } catch (e: any) {
          // Exceção no meio do caminho: o "deixei agendado" da IA NÃO pode sair sem evento.
          this.logger.warn(`[AI] Falha ao agendar avaliação (${slot.date} ${slot.time}): ${e.message} — corrigindo a resposta`);
          try {
            await honestAndAlert(`erro ao agendar: ${String(e?.message || e).slice(0, 120)}`);
          } catch {
            finalText = buildHonestPreferenceText(slot);
          }
        }
      }

      // 15c. Processar scheduling_action.cancel_appointment (cancelamento pelo lead)
      // Onda 5e v22 (Fase 25): bug fix critico — antes filtrava SO por
      // conversation_id, deixando passar eventos criados MANUALMENTE pela tela
      // (que tem conversation_id NULL ou diferente). Resultado: IA dizia
      // "cancelei" mas evento continuava na agenda. Fix: filtra OR por
      // conversation_id OU lead_id (eventos FUTUROS do mesmo paciente).
      if (scheduling_action?.action === 'cancel_appointment') {
        try {
          const cancelled = await (this.prisma as any).calendarEvent.findMany({
            where: {
              OR: [
                { conversation_id: convo.id },
                { lead_id: convo.lead.id },
              ],
              type: { in: ['CONSULTA', 'PROCEDIMENTO', 'RETORNO'] },
              status: { notIn: ['CANCELADO', 'CONCLUIDO'] },
              start_at: { gte: maceioNowNaive() }, // so eventos futuros (passados nao cancela) — agora de Maceió (naive-UTC)
            },
            select: { id: true, start_at: true, title: true },
          });

          if (cancelled.length === 0) {
            this.logger.warn(
              `[AI] cancel_appointment recebido mas NENHUMA consulta futura encontrada pra lead ${convo.lead.id} (conv=${convo.id}). IA pode ter alucinado o cancelamento — ver prompt.`,
            );
          } else {
            for (const ev of cancelled) {
              await (this.prisma as any).calendarEvent.update({
                where: { id: ev.id },
                data: {
                  status: 'CANCELADO',
                  description: `[CANCELADO pelo lead via WhatsApp em ${new Date().toISOString()}]`,
                },
              });
              await (this.prisma as any).eventReminder.deleteMany({
                where: { event_id: ev.id, sent_at: null },
              });
              this.logger.log(
                `[AI] Lead cancelou — evento CANCELADO: id=${ev.id} title="${ev.title}" start=${ev.start_at.toISOString()}`,
              );
            }
          }
        } catch (e: any) {
          this.logger.warn(`[AI] Falha ao cancelar avaliação: ${e.message}`);
        }
      }

      // 15d. Onda 5e v18 (Fase 25, Fase B.2) — confirmacao do paciente
      // Quando paciente responde positivo ao lembrete 24h (reminder_context.
      // awaiting_confirmation=true), IA emite confirm_appointment. Aqui
      // marcamos status=CONFIRMADO no CalendarEvent + limpamos o flag.
      // v22: fallback agora busca por OR(conversation_id, lead_id) tb.
      if (scheduling_action?.action === 'confirm_appointment') {
        try {
          // Pega event_id do reminder_context (foi salvo quando enviamos lembrete 24h)
          const reminderCtx = (convo as any).reminder_context as any;
          const eventId = reminderCtx?.event_id;
          if (!eventId) {
            // Fallback: pega evento ATIVO mais proximo (busca por convo OU lead)
            const nextEvent = await (this.prisma as any).calendarEvent.findFirst({
              where: {
                OR: [
                  { conversation_id: convo.id },
                  { lead_id: convo.lead.id },
                ],
                type: { in: ['CONSULTA', 'PROCEDIMENTO', 'RETORNO'] },
                status: { notIn: ['CANCELADO', 'CONCLUIDO'] },
                start_at: { gte: maceioNowNaive() }, // agenda naive-UTC: "agora" de Maceió
              },
              orderBy: { start_at: 'asc' },
              select: { id: true },
            });
            if (nextEvent) {
              await (this.prisma as any).calendarEvent.update({
                where: { id: nextEvent.id },
                data: { status: 'CONFIRMADO' },
              });
              this.logger.log(`[AI] Paciente confirmou — evento ${nextEvent.id} marcado como CONFIRMADO (via fallback)`);
            }
          } else {
            await (this.prisma as any).calendarEvent.update({
              where: { id: eventId },
              data: { status: 'CONFIRMADO' },
            });
            this.logger.log(`[AI] Paciente confirmou — evento ${eventId} marcado como CONFIRMADO`);
          }
          // Limpa awaiting_confirmation pra IA nao re-processar a mesma resposta
          if (reminderCtx?.awaiting_confirmation) {
            await (this.prisma as any).conversation.update({
              where: { id: convo.id },
              data: { reminder_context: { ...reminderCtx, awaiting_confirmation: false, confirmed_at: new Date().toISOString() } },
            });
          }
        } catch (e: any) {
          this.logger.warn(`[AI] Falha ao confirmar evento: ${e.message}`);
        }
      }

      // 15e. Onda 5e v18 (Fase B.3) — pedido de remarcacao do paciente
      // IA emite reschedule_appointment quando paciente quer trocar dia/hora.
      // Cancelamos o evento atual + IA continuara com check_availability na
      // proxima resposta (regra B.3 do AGENDAMENTO_OVERRIDES manda oferecer
      // 2-3 horarios novos).
      // v22: filtro ampliado pra buscar por OR(conversation_id, lead_id).
      if (scheduling_action?.action === 'reschedule_appointment') {
        try {
          const cancelled = await (this.prisma as any).calendarEvent.findMany({
            where: {
              OR: [
                { conversation_id: convo.id },
                { lead_id: convo.lead.id },
              ],
              type: { in: ['CONSULTA', 'PROCEDIMENTO', 'RETORNO'] },
              status: { notIn: ['CANCELADO', 'CONCLUIDO'] },
              start_at: { gte: maceioNowNaive() }, // agenda naive-UTC: "agora" de Maceió
            },
            select: { id: true, start_at: true },
          });
          for (const ev of cancelled) {
            await (this.prisma as any).calendarEvent.update({
              where: { id: ev.id },
              data: {
                status: 'CANCELADO',
                description: `[REMARCADO pelo paciente via WhatsApp em ${new Date().toISOString()}]`,
              },
            });
            await (this.prisma as any).eventReminder.deleteMany({
              where: { event_id: ev.id, sent_at: null },
            });
            this.logger.log(`[AI] Paciente pediu remarcacao — evento ${ev.id} cancelado, IA propora novos horarios`);
          }
          // Limpa awaiting_confirmation
          const reminderCtx = (convo as any).reminder_context as any;
          if (reminderCtx?.awaiting_confirmation) {
            await (this.prisma as any).conversation.update({
              where: { id: convo.id },
              data: { reminder_context: { ...reminderCtx, awaiting_confirmation: false, rescheduled_at: new Date().toISOString() } },
            });
          }
        } catch (e: any) {
          this.logger.warn(`[AI] Falha ao processar remarcacao: ${e.message}`);
        }
      }

      // 16. Ler config da Evolution e enviar via WhatsApp
      const { apiUrl, apiKey } = await this.settings.getEvolutionConfig();
      if (!apiUrl) {
        this.logger.warn(
          'EVOLUTION_API_URL não configurada — resposta da IA não enviada',
        );
        return;
      }

      const instanceName =
        convo.instance_name || process.env.EVOLUTION_INSTANCE_NAME || '';

      // Onda 18.x — tira o TRAVESSÃO (— em dash / – en dash) das respostas da IA: a
      // clínica não quer esse traço no WhatsApp. Troca por vírgula (leitura natural em
      // pt-BR) e limpa pontuação/espaço dobrados. NÃO mexe no hífen comum "-" (bem-estar,
      // pós-venda). Vale pro texto ENVIADO e pro SALVO (ambos usam finalText).
      // Também tira rótulo de turno copiado do histórico ("[Operador Humano]: …").
      finalText = tidyReply(stripHistoryLabels(finalText));

      // ─── CARLA (FINANCEIRO): reenvio de boleto/PIX sob pedido ───────────────────
      // Só no chip FINANCEIRO, com ação emitida pela IA, fora do chat de teste. Os
      // boletos saem SEMPRE do paciente DESTA conversa (financeiroSendable — escopado
      // por tenant+paciente) e com freio ao vivo (nunca reenvia pra quem já pagou). O
      // envio ocorre ANTES dos balões de texto, pela mesma instância FINANCEIRO da
      // conversa. Kill-switch global AI_FINANCEIRO_SEND_OFF desliga todos os envios da
      // Carla sem mexer no liga/desliga do chip.
      if (profilePurpose === 'FINANCEIRO' && financeiro_action && !dryRun) {
        const sendTenantId = (profileTenantId || (convo as any).tenant_id || '') as string;
        const killed = await this.prisma.globalSetting
          .findUnique({ where: { key: 'AI_FINANCEIRO_SEND_OFF' } })
          .then((r: any) => r?.value === 'true')
          .catch(() => false);
        // Cross-check de tenant da instância de envio: a conta Evolution é global, então
        // o número remetente é decidido só pelo instance_name. Garante que o chip
        // pertence ao MESMO tenant do paciente (nunca manda a cobrança do Instituto pelo
        // número da Pra Sorrir, p.ex.). tenantId vazio = não envia (evita fallback global).
        let instanceOk = !!sendTenantId && !!convo.instance_name;
        if (instanceOk) {
          const inst = await this.prisma.instance
            .findFirst({ where: { name: convo.instance_name! }, select: { tenant_id: true } })
            .catch(() => null);
          if (inst?.tenant_id && inst.tenant_id !== sendTenantId) {
            instanceOk = false;
            this.logger.warn(`[CARLA] instância ${convo.instance_name} é de outro tenant (${inst.tenant_id} ≠ ${sendTenantId}) — não envia.`);
          }
        }
        if (killed) {
          this.logger.warn('[CARLA] envio de boleto desligado (AI_FINANCEIRO_SEND_OFF) — ação ignorada.');
        } else if (!instanceOk) {
          this.logger.warn('[CARLA] sem tenant/instância FINANCEIRO confiável — não envia boleto.');
        } else if (financeiroSendable.length === 0) {
          this.logger.log('[CARLA] ação de envio sem cobranças em aberto do paciente — nada a enviar.');
        } else {
          try {
            const r = await runFinanceiroSend({
              prisma: this.prisma,
              settings: this.settings,
              logger: this.logger,
              tenantId: sendTenantId,
              phone: convo.lead?.phone || '',
              instanceName: convo.instance_name!,
              action: financeiro_action,
              sendable: financeiroSendable,
              dryRun,
            });
            this.logger.log(`[CARLA] financeiro_action ${financeiro_action.action}: ${r.sent} enviada(s), ${r.blocked} barrada(s) de ${r.attempted}.`);
          } catch (e: any) {
            this.logger.error(`[CARLA] falha no reenvio de boleto: ${e?.message}`);
          }
        }
      }

      // Assinatura "*<Nome>:*" em negrito no WhatsApp (salva sem assinatura no DB).
      // Nome e liga/desliga vêm do perfil do chip desta clínica (Ajustes › IA).
      // textToSend = resposta inteira (usada no fallback do TTS).
      const signaturePrefix = aiProfile.signature ? `*${assistantName}:* ` : '';
      const textToSend = `${signaturePrefix}${finalText}`;

      // Pré-calcular se vai enviar áudio (para pular texto nesse caso)
      // Buscar a última mensagem inbound (mais recente = primeiro do array desc)
      const _lastIn = convo.messages.find((m: any) => m.direction === 'in');
      const _tts = await this.settings.getTtsConfig();
      const _willAudio = _tts.enabled && _tts.googleApiKey && !_tts.googleApiKey.startsWith('enc:') && _lastIn?.type === 'audio';

      this.logger.debug(`[TTS-CHECK] enabled=${_tts.enabled} keyLen=${_tts.googleApiKey?.length || 0} keyEnc=${_tts.googleApiKey?.startsWith('enc:')} lastInType=${_lastIn?.type} willAudio=${_willAudio}`);

      if (_willAudio) {
        this.logger.log('[AI] Lead enviou áudio — resposta será apenas por voz (sem texto)');
      }

      // Onda 19.x — resposta em BALÕES, como a recepção escreve (uma ideia por
      // mensagem). O guia manda separar balões com linha em branco; cada balão
      // vira uma mensagem no WhatsApp com seu próprio "digitando..." proporcional
      // ao tamanho (bubbleTypingMs: piso 1,8s / teto 8s) e pausa entre balões. Só o 1º leva a assinatura.
      // Cada balão é gravado com o ID real da Evolution (dedup do echo do webhook).
      const bubbles = _willAudio ? [finalText] : splitIntoBubbles(finalText, maxBubbles, patientStyle);
      const evoHeaders = { 'Content-Type': 'application/json', apikey: apiKey };
      const savedMsgs: any[] = [];
      let sendFailed = false;
      let sendErrorDetail: string | null = null;
      let evolutionMsgId = `sys_ai_${Date.now()}`;

      for (let i = 0; i < bubbles.length; i++) {
        const bubble = bubbles[i];
        // 2ª tentativa: o job leva 15–40s (agenda, LLM, "digitando"). Se o paciente
        // escreveu nesse meio-tempo, para aqui — senão a mensagem dele ficaria sem
        // resposta (o job normal abortaria pelo anti-stale ao ver a nossa por último).
        if (isSchedulingRetry) {
          const after = new Date(String(job.data?.retryAfterMessageAt || 0));
          const replied = await this.prisma.message.findFirst({
            where: { conversation_id: convo.id, direction: 'in', created_at: { gt: after } },
            select: { id: true },
          });
          if (replied) {
            this.logger.log(`[AI-RETRY] conv ${convo.id}: paciente escreveu durante a tentativa — parei antes do balão ${i + 1}`);
            break;
          }
        }
        evolutionMsgId = `sys_ai_${Date.now()}_${i}`;
        let bubbleFailed = false;

        if (!_willAudio) {
          // Ritmo humano: pausa curta antes do próximo balão + "digitando" proporcional.
          const pauseMs = bubblePauseMs(i);
          if (pauseMs) await new Promise((resolve) => setTimeout(resolve, pauseMs));
          const typingMs = bubbleTypingMs(bubble);
          // Formato flat (sem wrapper "options") — conforme comportamento real da API
          axios
            .post(
              `${apiUrl}/chat/sendPresence/${instanceName}`,
              { number: convo.lead.phone, delay: typingMs, presence: 'composing' },
              { headers: evoHeaders, timeout: 10000 },
            )
            .catch((e) => this.logger.warn(`[AI] sendPresence falhou (não-fatal): ${e.message}`));
          await new Promise((resolve) => setTimeout(resolve, typingMs));

          // sendFailed/sendErrorDetail marcam a Message com o status REAL do envio
          // (antes o erro era silenciado e gravava 'enviado' sem chegar no WhatsApp).
          try {
            // sendList (listas interativas) não funciona via Baileys — slots de
            // agendamento já vêm formatados no texto pela IA.
            const sendResult = await axios.post(
              `${apiUrl}/message/sendText/${instanceName}`,
              { number: convo.lead.phone, text: i === 0 ? `${signaturePrefix}${bubble}` : bubble },
              { headers: evoHeaders, timeout: 30000 },
            );
            evolutionMsgId = sendResult.data?.key?.id || evolutionMsgId;
          } catch (sendErr: any) {
            bubbleFailed = true;
            sendFailed = true;
            const status = sendErr.response?.status || sendErr.code || sendErr.message;
            sendErrorDetail = `${status}: ${JSON.stringify(sendErr.response?.data || {}).slice(0, 160)}`;
            this.logger.error(`[AI] Falha ao enviar balão ${i + 1}/${bubbles.length} via Evolution (${status}): ${sendErrorDetail}`);
          }
        }
        // (áudio: não envia texto — será enviado apenas áudio no passo 18 (TTS))

        // 17. Salvar o balão no banco com skill_id (texto limpo, sem assinatura).
        // Race condition: o echo da Evolution pode chegar antes do worker salvar,
        // criando a mensagem sem skill_id. Nesse caso, capturamos P2002 e atualizamos.
        try {
          savedMsgs.push(await this.prisma.message.create({
            data: {
              conversation_id: convo.id,
              direction: 'out',
              type: 'text',
              text: bubble,
              external_message_id: evolutionMsgId,
              status: bubbleFailed ? 'falhou' : 'enviado',
              skill_id: skill?.id || null,
            },
          }));
        } catch (createErr: any) {
          if (createErr.code === 'P2002' && evolutionMsgId && !evolutionMsgId.startsWith('sys_ai_')) {
            this.logger.warn(`[AI] P2002 em message.create — echo chegou antes do save. Atualizando skill_id em ${evolutionMsgId}`);
            const existing = await this.prisma.message.findUnique({ where: { external_message_id: evolutionMsgId } });
            if (!existing) throw createErr;
            savedMsgs.push(await this.prisma.message.update({
              where: { id: existing.id },
              data: { skill_id: skill?.id || null },
            }));
          } else {
            throw createErr;
          }
        }
        if (bubbleFailed) break; // não manda o resto se um balão falhou (ordem quebrada)
      }
      const savedMsg = savedMsgs[savedMsgs.length - 1];
      // 2ª tentativa interrompida antes do 1º balão (paciente escreveu): nada saiu,
      // o job normal da mensagem dele responde.
      if (!savedMsg) return;

      // 18. Atualizar last_message_at
      await this.prisma.conversation.update({
        where: { id: convo.id },
        data: { last_message_at: new Date() },
      });

      if (sendFailed) {
        // Falha de envio: log explícito + status já gravado como 'falhou'
        this.logger.error(
          `[AI] Resposta NÃO chegou ao WhatsApp ${convo.lead.phone} (${sendErrorDetail || 'erro desconhecido'}, evoId=${evolutionMsgId}). Mensagem gravada com status='falhou' — operador deve reenviar manualmente.`,
        );
      } else {
        this.logger.log(
          `[AI] Resposta enviada para ${convo.lead.phone} (model=${model}, skill=${skill?.name || 'NULL — badge não aparecerá'}, skill_id=${skill?.id || 'null'}, evoId=${evolutionMsgId})`,
        );
      }
      if (!skill?.id) {
        this.logger.warn(`[AI] skill_id=null para conv ${convo.id} — verifique se as skills estão ativas nas configurações de IA`);
      }

      // 18. TTS — reutiliza _willAudio calculado antes do envio de texto
      const ttsConfig = _tts; // reutiliza config já carregado
      if (_willAudio) {
        this.logger.log(`[TTS] Chave OK (len=${ttsConfig.googleApiKey.length}), voz=${ttsConfig.voice}`);
        try {
          // Remove formatação markdown do texto
          const ttsText = finalText
            .replace(/\*\*(.*?)\*\*/g, '$1')
            .replace(/\*(.*?)\*/g, '$1')
            .trim();

          // Detectar se é voz Gemini ou Google Cloud TTS legado
          const isGeminiVoice = !ttsConfig.voice?.startsWith('pt-BR');
          const voiceName = isGeminiVoice ? (ttsConfig.voice || 'Kore') : 'Kore';

          if (!isGeminiVoice) {
            this.logger.log(`[TTS] Voz legada ${ttsConfig.voice} detectada — usando Gemini com voz Kore`);
          }

          // Instrução de estilo para voz natural e adaptativa
          const styledText = `Mulher profissional, voz serena e confiante. Fala com clareza e empatia. Adapta automaticamente o tom conforme o conteúdo da mensagem. Atendimento ao cliente jurídico via áudio. O cliente pode estar ansioso, aliviado, inadimplente ou aguardando notícias do processo. A voz deve espelhar o momento emocional do conteúdo narrado. Português brasileiro padrão, dicção clara. REGRAS DE ADAPTAÇÃO: mensagem de prazo ou urgência, ritmo mais acelerado com ênfase nas datas e valores; mensagem de atualização processual, tom informativo com pausas após termos jurídicos; mensagem de boas notícias, voz mais leve com leve sorriso perceptível; mensagem de cobrança, tom sério e respeitoso sem agressividade; mensagem de situação delicada, voz mais suave com ritmo lento; mensagem de boas-vindas, tom acolhedor e animado; mensagem informativa, tom neutro e preciso. Agora diga: ${ttsText}`;

          // Gemini 2.5 Flash TTS
          const geminiModel = 'gemini-2.5-flash-preview-tts';
          const ttsRes = await fetch(
            `https://generativelanguage.googleapis.com/v1beta/models/${geminiModel}:generateContent?key=${ttsConfig.googleApiKey}`,
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                contents: [{ parts: [{ text: styledText }] }],
                generationConfig: {
                  responseModalities: ['AUDIO'],
                  speechConfig: {
                    voiceConfig: {
                      prebuiltVoiceConfig: { voiceName },
                    },
                  },
                },
              }),
              signal: AbortSignal.timeout(30000),
            },
          );

          if (!ttsRes.ok) {
            const errText = await ttsRes.text().catch(() => '');
            this.logger.warn(`[TTS] Gemini TTS retornou ${ttsRes.status}: ${errText.slice(0, 300)}`);
          } else {
            const ttsData = await ttsRes.json();
            const audioB64 = ttsData?.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
            if (!audioB64) {
              this.logger.warn('[TTS] Gemini TTS não retornou áudio');
            } else {
              // Gemini retorna PCM 24kHz 16-bit — converter para WAV
              const pcmBuffer = Buffer.from(audioB64, 'base64');
              const wavHeader = this.buildWavHeader(pcmBuffer.length, 24000, 1, 16);
              const audioBuffer = Buffer.concat([wavHeader, pcmBuffer]);

            // Upload do áudio para S3
            const audioKey = `tts/${convo.id}/${savedMsg.id}.wav`;
            await this.s3.uploadBuffer(audioKey, audioBuffer, 'audio/wav');

            // Cria registro de mensagem de áudio no banco
            const audioMsg = await this.prisma.message.create({
              data: {
                conversation_id:     convo.id,
                direction:           'out',
                type:                'audio',
                text:                null,
                status:              'enviado',
                skill_id:            skill?.id || null,
              },
            });

            // Cria registro de mídia vinculado à mensagem
            await (this.prisma as any).media.create({
              data: {
                message_id: audioMsg.id,
                s3_key:     audioKey,
                mime_type:  'audio/wav',
                size:       audioBuffer.length,
              },
            });

            // Envia via Evolution API como áudio base64 puro
            const audioBase64 = audioBuffer.toString('base64');
            const ttsEvoResult = await axios.post(
              `${apiUrl}/message/sendWhatsAppAudio/${instanceName}`,
              { number: convo.lead.phone, audio: audioBase64 },
              { headers: { 'Content-Type': 'application/json', apikey: apiKey }, timeout: 30000 },
            );

            // Salvar external_message_id para deduplicação do echo da Evolution
            const ttsEvoId = ttsEvoResult.data?.key?.id;
            if (ttsEvoId) {
              await this.prisma.message.update({
                where: { id: audioMsg.id },
                data: { external_message_id: ttsEvoId },
              });
            }

            this.logger.log(`[TTS] Áudio Gemini enviado para ${convo.lead.phone} (${audioBuffer.length} bytes, voz=${voiceName}, evoId=${ttsEvoId || 'N/A'})`);
            }
          }
        } catch (ttsErr: any) {
          this.logger.warn(`[TTS] Falha ao gerar/enviar áudio: ${ttsErr.message} — enviando texto como fallback`);
          // Fallback: envia texto quando TTS falha (créditos esgotados, erro de API, etc.)
          try {
            await axios.post(
              `${apiUrl}/message/sendText/${instanceName}`,
              { number: convo.lead.phone, text: textToSend },
              { headers: { 'Content-Type': 'application/json', apikey: apiKey }, timeout: 30000 },
            );
            this.logger.log('[TTS] Fallback texto enviado com sucesso');
          } catch (fallbackErr: any) {
            this.logger.error(`[TTS] Fallback texto também falhou: ${fallbackErr.message}`);
          }
        }
      }

      // 19. Sistema antigo (updateLongMemory/AiMemory) REMOVIDO em 2026-04-20.
      //
      // Substituido por: extracao batch noturna (00h) -> Memory entries ->
      // ProfileConsolidationProcessor (02h incremental) -> LeadProfile.
      // Ver MEMORY_SYSTEM.md secao 9.6 (migracao case_state -> LeadProfile).
      //
      // Leitura de AiMemory permanece como fallback na linha ~970 para
      // leads legacy sem tenant_id que nao puderam ser migrados em massa.

      // 19a. 13-NP com handoff (toggle da triagem ligado): a resposta de repasse já saiu —
      // agora o mesmo handoff do classificador: pausa a IA (MANUAL), marca o lead, avisa
      // os ADMs e encaminha os arquivos que a pessoa já mandou. Mesmo se o envio falhou:
      // os ADMs precisam saber.
      if (npHandoff && npBlock.categoria && npTenantId) {
        teamAlertNoteId =
          (await this.finishNonPatientHandoff(
            convo,
            npTenantId,
            { categoria: npBlock.categoria, resumo: npBlock.resumo },
            assistantName,
          )) || teamAlertNoteId;
      }

      // 19b. 2ª tentativa de agendamento — SÓ depois do envio dar certo (e do áudio,
      // se houve: o marco retryAfterMessageAt é "agora", depois de tudo que saiu).
      // Nunca a partir de uma 2ª tentativa (13c), nem com handoff pra humano.
      if (wantsSchedulingRetry && !sendFailed && !handedOff) {
        await this.scheduleSchedulingRetry(convo, aiProfile.schedulingRetryMin, retryReason);
      }

      // 20. Retorna IDs para o AiEventsService da API emitir WebSocket em tempo real
      // messageIds: todos os balões (a API emite cada um no WebSocket).
      // Nota interna de alerta (se houve) vai antes dos balões — mesma ordem do banco.
      const emittedIds = [...(teamAlertNoteId ? [teamAlertNoteId] : []), ...savedMsgs.map((m: any) => m.id)];
      return { conversationId: convo.id, messageId: savedMsg.id, messageIds: emittedIds };
    } catch (e: any) {
      this.logger.error(`Erro no processamento da IA: ${e.message}`);
      throw e;
    }
  }
}

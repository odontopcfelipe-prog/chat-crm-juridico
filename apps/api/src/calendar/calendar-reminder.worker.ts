import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { PrismaService } from '../prisma/prisma.service';
import { WhatsappService } from '../whatsapp/whatsapp.service';
import { SettingsService } from '../settings/settings.service';
import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';
import { createSmtpTransport } from '../common/utils/smtp.util';
import {
  DEFAULT_REMINDER_CONFIG,
  applyTemplate,
  pickTemplateKey,
  formatTenantAddress,
  type ReminderConfig,
} from '@crm/shared';

// ─── Labels/emojis para lembretes EMAIL (portado do worker em 2026-04-20) ──
const TYPE_LABEL: Record<string, string> = {
  AUDIENCIA: 'Audiência',
  PERICIA: 'Perícia',
  PRAZO: 'Prazo',
  TAREFA: 'Tarefa',
  CONSULTA: 'Consulta',
  ORTODONTIA: 'Ortodontia',
  OUTRO: 'Evento',
};

const TYPE_EMOJI: Record<string, string> = {
  AUDIENCIA: '⚖️',
  PERICIA: '🔬',
  PRAZO: '⏰',
  TAREFA: '✅',
  CONSULTA: '🟣',
  ORTODONTIA: '😁',
  OUTRO: '📅',
};

function formatDateShort(d: Date): string {
  return d.toLocaleDateString('pt-BR', {
    timeZone: 'UTC',
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}

function formatTimeShort(d: Date): string {
  return d.toLocaleTimeString('pt-BR', {
    timeZone: 'UTC',
    hour: '2-digit',
    minute: '2-digit',
  });
}

// ─── Formatação de datas em pt-BR ────────────────────────────────────────────

// App usa UTC "naive" — horários salvos no banco como UTC = horário local de Maceió.
// Por isso exibimos em UTC puro (sem conversão de fuso) para não subtrair 3h.
function formatDateTime(date: Date): string {
  return date.toLocaleString('pt-BR', {
    weekday: 'long',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'UTC',
  });
}

function minutesLabel(minutes: number): string {
  if (minutes < 60) return `${minutes} minutos`;
  if (minutes === 60) return '1 hora';
  if (minutes < 1440) return `${Math.round(minutes / 60)} horas`;
  if (minutes === 1440) return '1 dia';
  return `${Math.round(minutes / 1440)} dias`;
}

// ─── Templates fallback (quando IA indisponível) ──────────────────────────────
// Onda 5e v17 (Fase 25) — templates SEPARADOS por tipo de evento + canal:
//   - templateClienteJuridico: AUDIENCIA/PERICIA (legado)
//   - templateClienteConsulta24h/1h/15min: CONSULTA odontologica (novos)
// Tom NATURAL (nao robotico) — convite a confirmar SEM "responda 1/2".

function templateClienteJuridico(event: any, minutesBefore: number): string {
  const prazo = minutesLabel(minutesBefore);
  const dateStr = formatDateTime(event.start_at);
  const nome = (event.lead?.name || 'Cliente').split(' ')[0];
  return (
    `⚖️ *Lembrete de Audiência*\n\n` +
    `Olá, ${nome}!\n\n` +
    `Sua audiência está marcada para *${prazo}*:\n\n` +
    `📅 *Data/Hora:* ${dateStr}\n` +
    (event.location ? `📍 *Local:* ${event.location}\n` : '') +
    `\nPor favor, chegue com *30 minutos de antecedência*.\n` +
    `Em caso de dúvidas, entre em contato com o escritório.\n\n` +
    `_Aviso automático do escritório_`
  );
}

/**
 * Lembrete de CONSULTA odonto enviado ao paciente.
 * v27: usa templates configuraveis do tenant (REMINDER_CONFIG_<tenant_id>)
 * via applyTemplate. Fallback pros defaults DEFAULT_REMINDER_CONFIG se admin
 * nao customizou.
 *
 * Templates suportam variaveis: {nome}, {dentista}, {data}, {hora}, {local},
 * {clinica}, {antecedencia}, {nome_completo}, {dentista_completo}.
 */
function templateClienteConsulta(
  event: any,
  minutesBefore: number,
  config: ReminderConfig,
  tenantAddr: string,
  forceKey?: keyof ReminderConfig['templates'],
): string {
  const nomeFull = event.lead?.name || 'paciente';
  const nome = nomeFull.split(' ')[0];
  const dentistaFull = event.assigned_user?.name || '';
  // Encurta "Dra. Suellen Passos" -> "Dra. Suellen"
  const parts = dentistaFull.split(' ');
  const dentista = parts.length >= 3 ? `${parts[0]} ${parts[1]}` : dentistaFull;

  const dateStr = formatDateTime(event.start_at);
  const horaStr = `${String(event.start_at.getUTCHours()).padStart(2, '0')}:${String(event.start_at.getUTCMinutes()).padStart(2, '0')}`;
  const antecedenciaLabel = minutesLabel(minutesBefore);

  // Escolhe qual template aplicar: forçado (confirmação) ou pela faixa de antecedência.
  const templateKey = forceKey ?? pickTemplateKey(minutesBefore);
  const template = config.templates[templateKey];

  return applyTemplate(template, {
    nome,
    nome_completo: nomeFull,
    dentista,
    dentista_completo: dentistaFull,
    data: dateStr,
    hora: horaStr,
    local: event.location || tenantAddr || '',
    antecedencia: antecedenciaLabel,
  });
}

function templateAdvogado(event: any, minutesBefore: number): string {
  const prazo = minutesLabel(minutesBefore);
  const dateStr = formatDateTime(event.start_at);
  const tipo = event.type;
  const caseNum = event.title;
  const advNome = (event.assigned_user?.name || 'Advogado').split(' ').slice(0, 2).join(' ');

  if (tipo === 'AUDIENCIA') {
    return (
      `⚖️ *Lembrete de Audiência — ${prazo} antes*\n\n` +
      `Olá, ${advNome}!\n\n` +
      `📋 *Processo:* ${caseNum}\n` +
      `📅 *Data/Hora:* ${dateStr}\n` +
      (event.location ? `📍 *Local:* ${event.location}\n` : '') +
      (event.lead?.name ? `👤 *Cliente:* ${event.lead.name}\n` : '') +
      `\n_Lembrete automático do CRM Jurídico_`
    );
  }
  if (tipo === 'PERICIA') {
    return (
      `🔬 *Lembrete de Perícia — ${prazo} antes*\n\n` +
      `Olá, ${advNome}!\n\n` +
      `📋 *Processo:* ${caseNum}\n` +
      `📅 *Data/Hora:* ${dateStr}\n` +
      (event.location ? `📍 *Local:* ${event.location}\n` : '') +
      (event.lead?.name ? `👤 *Cliente:* ${event.lead.name}\n` : '') +
      (event.description ? `📝 *Obs:* ${event.description}\n` : '') +
      `\n_Lembrete automático do CRM Jurídico_`
    );
  }
  if (tipo === 'PRAZO') {
    return (
      `⏰ *Lembrete de Prazo — ${prazo} restantes*\n\n` +
      `Olá, ${advNome}!\n\n` +
      `📋 *Prazo:* ${event.title}\n` +
      `📅 *Vencimento:* ${dateStr}\n` +
      (caseNum ? `🔢 *Processo:* ${caseNum}\n` : '') +
      `\n_Lembrete automático do CRM Jurídico_`
    );
  }
  return (
    `📅 *Lembrete — ${prazo} antes*\n\nOlá, ${advNome}!\n\n*${event.title}*\n📅 ${dateStr}\n\n_Lembrete automático do CRM Jurídico_`
  );
}

// ─── Montagem do contexto para a IA ──────────────────────────────────────────

function buildContext(event: any, memory: any, legalCase: any, ficha: any, djenPubs?: any[]): string {
  const lines: string[] = [];

  // Evento
  lines.push(`## EVENTO`);
  lines.push(`Tipo: ${event.type}`);
  lines.push(`Título: ${event.title}`);
  lines.push(`Data/Hora: ${formatDateTime(event.start_at)}`);
  if (event.location) lines.push(`Local: ${event.location}`);
  if (event.description) lines.push(`Descrição: ${event.description}`);

  // Cliente
  if (event.lead) {
    lines.push(`\n## CLIENTE`);
    lines.push(`Nome: ${event.lead.name || 'Não informado'}`);
  }

  // Advogado
  if (event.assigned_user) {
    lines.push(`\n## ADVOGADO RESPONSÁVEL`);
    lines.push(`Nome: ${event.assigned_user.name}`);
  }

  // Processo
  if (legalCase) {
    lines.push(`\n## PROCESSO`);
    if (legalCase.case_number) lines.push(`Número: ${legalCase.case_number}`);
    if (legalCase.action_type) lines.push(`Tipo de ação: ${legalCase.action_type}`);
    if (legalCase.opposing_party) lines.push(`Parte contrária: ${legalCase.opposing_party}`);
    if (legalCase.court) lines.push(`Tribunal/Vara: ${legalCase.court}`);
    if (legalCase.judge) lines.push(`Juiz/Desembargador: ${legalCase.judge}`);
    if (legalCase.claim_value) lines.push(`Valor da causa: R$ ${Number(legalCase.claim_value).toLocaleString('pt-BR', { minimumFractionDigits: 2 })}`);
    if (legalCase.notes) lines.push(`Notas do advogado: ${legalCase.notes}`);
  }

  // Memória do cliente (AiMemory)
  if (memory) {
    lines.push(`\n## MEMÓRIA DO CASO (histórico do atendimento)`);
    if (memory.summary) lines.push(`Resumo: ${memory.summary}`);

    let facts: any = {};
    try { facts = typeof memory.facts_json === 'string' ? JSON.parse(memory.facts_json) : (memory.facts_json || {}); } catch { facts = {}; }

    if (facts.case?.area) lines.push(`Área detectada: ${facts.case.area}`);
    if (facts.case?.subarea) lines.push(`Subárea: ${facts.case.subarea}`);
    if (facts.parties?.counterparty_name) lines.push(`Empresa/parte adversa: ${facts.parties.counterparty_name}`);
    if (facts.facts?.current?.main_issue) lines.push(`Problema principal: ${facts.facts.current.main_issue}`);
    if (facts.facts?.current?.employment_status) lines.push(`Situação trabalhista: ${facts.facts.current.employment_status}`);

    const keyDates = facts.facts?.current?.key_dates || {};
    const dateEntries = Object.entries(keyDates).filter(([, v]) => v);
    if (dateEntries.length > 0) {
      lines.push(`Datas importantes: ${dateEntries.map(([k, v]) => `${k}=${v}`).join(', ')}`);
    }

    const keyVals = facts.facts?.current?.key_values || {};
    const valEntries = Object.entries(keyVals).filter(([, v]) => v);
    if (valEntries.length > 0) {
      lines.push(`Valores relevantes: ${valEntries.map(([k, v]) => `${k}=${v}`).join(', ')}`);
    }

    const coreFacts: string[] = facts.facts?.core_facts || [];
    if (coreFacts.length > 0) {
      lines.push(`Fatos-chave: ${coreFacts.slice(0, 10).join(' | ')}`);
    }

    const openQuestions: string[] = facts.open_questions || [];
    if (openQuestions.length > 0) {
      lines.push(`Dúvidas abertas do cliente: ${openQuestions.slice(0, 5).join(' | ')}`);
    }
  }

  // Ficha trabalhista (resumo)
  if (ficha && ficha.data) {
    let fichaData: any = {};
    try { fichaData = typeof ficha.data === 'string' ? JSON.parse(ficha.data) : (ficha.data || {}); } catch { fichaData = {}; }
    const fichaLines: string[] = [];
    if (fichaData.data_admissao) fichaLines.push(`Admissão: ${fichaData.data_admissao}`);
    if (fichaData.data_demissao) fichaLines.push(`Demissão: ${fichaData.data_demissao}`);
    if (fichaData.tipo_rescisao) fichaLines.push(`Tipo de rescisão: ${fichaData.tipo_rescisao}`);
    if (fichaData.ultimo_salario) fichaLines.push(`Último salário: ${fichaData.ultimo_salario}`);
    if (fichaLines.length > 0) {
      lines.push(`\n## FICHA TRABALHISTA`);
      fichaLines.forEach(l => lines.push(l));
    }
  }

  // Publicações DJEN (histórico das movimentações do processo)
  if (djenPubs && djenPubs.length > 0) {
    lines.push(`\n## HISTÓRICO DJEN (${djenPubs.length} publicação(ões) recente(s))`);
    djenPubs.forEach((pub, idx) => {
      const date = new Date(pub.data_disponibilizacao).toLocaleDateString('pt-BR');
      lines.push(`\nPublicação ${idx + 1} — ${date}:`);
      if (pub.tipo_comunicacao) lines.push(`  Tipo: ${pub.tipo_comunicacao}`);
      if (pub.assunto) lines.push(`  Assunto: ${pub.assunto}`);
      const snippet = (pub.conteudo || '').slice(0, 400);
      if (snippet) lines.push(`  Conteúdo: ${snippet}${pub.conteudo?.length > 400 ? '…' : ''}`);
    });
  }

  return lines.join('\n');
}

// ─── Worker ───────────────────────────────────────────────────────────────────

@Processor('calendar-reminders')
export class CalendarReminderWorker extends WorkerHost {
  private readonly logger = new Logger(CalendarReminderWorker.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly whatsapp: WhatsappService,
    private readonly settings: SettingsService,
  ) {
    super();
    this.logger.log('✅ CalendarReminderWorker registrado na fila calendar-reminders (API container)');
  }

  async process(job: Job<any>) {
    this.logger.log(`[WORKER-API] Processando job ${job.name} (id: ${job.id})`);

    // ── Notificação imediata de audiência agendada ────────────────────────────
    if (job.name === 'notify-hearing-scheduled') {
      return this.processHearingScheduled(job.data.eventId, false);
    }

    // ── Notificação de remarcação de audiência ────────────────────────────────
    if (job.name === 'notify-hearing-rescheduled') {
      return this.processHearingScheduled(job.data.eventId, true);
    }

    // ── Lembretes antes do evento (fluxo original) ────────────────────────────
    const { reminderId, eventId, channel } = job.data;

    if (channel !== 'WHATSAPP' && channel !== 'EMAIL') {
      this.logger.warn(`Worker: canal desconhecido "${channel}" para reminder ${reminderId}`);
      return;
    }

    const reminder = await this.prisma.eventReminder.findUnique({
      where: { id: reminderId },
      select: { id: true, sent_at: true, minutes_before: true },
    });

    if (!reminder) {
      this.logger.warn(`Reminder ${reminderId} não encontrado — pode ter sido deletado`);
      return;
    }
    if (reminder.sent_at) {
      this.logger.log(`Reminder ${reminderId} já enviado em ${reminder.sent_at.toISOString()} — ignorando`);
      return;
    }

    // Carrega evento com todos os dados necessários para personalização
    // STUBBED: LegalCase relation removida Fase 0.2
    const event = await this.prisma.calendarEvent.findUnique({
      where: { id: eventId },
      include: {
        assigned_user: { select: { id: true, name: true, phone: true } },
        lead: { select: { id: true, name: true, phone: true, is_client: true } },
        // v31: patient como fallback quando evento foi criado direto via ficha
        // (sem lead vinculado). Worker mescla lead || patient ao processar.
        patient: { select: { id: true, name: true, phone: true } },
        // Onda 17.60 — pra saber se ESTE lembrete é o de MAIOR antecedência
        // (= a confirmação) ou só um lembrete intermediário.
        reminders: { select: { minutes_before: true } },
      },
    });

    if (!event) {
      this.logger.warn(`Evento ${eventId} não encontrado`);
      return;
    }

    // Onda 17.49 — respeita o toggle "Lembrete" do painel Operacional.
    // Default LIGADO: so pula se REMINDER_CONFIG_<tenant>.enabled === false.
    const remCfg = await this.prisma.globalSetting.findUnique({
      where: { key: `REMINDER_CONFIG_${event.tenant_id}` },
    });
    if (remCfg?.value) {
      try {
        const cfg = JSON.parse(remCfg.value);
        if (cfg?.enabled === false) {
          this.logger.log(`[WORKER-API] Lembretes desligados (tenant ${event.tenant_id}) — pulando reminder ${reminderId}`);
          return;
        }
        // Onda 18.x — respeita a LISTA de antecedências ativas da Central. Se a
        // clínica DESLIGOU este lembrete (removeu a antecedência), NÃO envia —
        // mesmo que o EventReminder já estivesse ANEXADO ao evento (criado antes
        // de desligar). Antes, desligar na Central só afetava eventos NOVOS; os
        // já anexados disparavam assim mesmo ("desliguei e mesmo assim caiu").
        // Só a faixa de LEMBRETE puro (<48h/2880min): a de 48h (pedido de
        // confirmação) tem interação com o scheduler de confirmação — não é
        // filtrada aqui pra não abrir buraco de confirmação. Só aplica quando a
        // lista está EXPLÍCITA (default_antecedencias salvo); sem config, envia.
        if (reminder.minutes_before < 2880 && Array.isArray(cfg?.default_antecedencias)) {
          const ativo = cfg.default_antecedencias.some(
            (a: any) => Number(a?.minutes_before) === reminder.minutes_before,
          );
          if (!ativo) {
            this.logger.log(`[WORKER-API] Lembrete ${reminder.minutes_before}min desligado na Central (tenant ${event.tenant_id}) — pulando reminder ${reminderId}`);
            return;
          }
        }
      } catch { /* config corrompida = trata como ligado */ }
    }

    // v31: se nao tem lead mas tem patient, usa patient como source pra envio
    // Mantem event.lead pra compat com restantes do codigo (templates, logs)
    if (!event.lead && (event as any).patient) {
      const p = (event as any).patient;
      (event as any).lead = { id: p.id, name: p.name, phone: p.phone };
    }

    if (['CANCELADO', 'CONCLUIDO'].includes(event.status)) {
      this.logger.log(`Evento ${eventId} está ${event.status} — lembrete ignorado`);
      await this.prisma.eventReminder.update({ where: { id: reminderId }, data: { sent_at: new Date() } });
      return;
    }

    // Envia pelo canal apropriado. Dedup defensivo: so marca sent_at se o
    // envio foi bem-sucedido (evita perder o job quando ha falha transitoria).
    // v24: lastErrorMsg captura motivo legivel pra salvar no banco (UI exibe).
    // v25: capturedExternalMsgId pra delivery tracking via webhook.
    let sent = false;
    let lastErrorMsg: string | null = null;
    let capturedExternalMsgId: string | null = null;
    if (channel === 'WHATSAPP') {
      // Validacao previa: paciente precisa ter telefone
      if (!event.lead?.phone) {
        lastErrorMsg = 'Paciente sem telefone cadastrado';
        sent = false;
      } else {
        try {
          const result = await this.sendWhatsAppReminders(event, reminder.minutes_before);
          capturedExternalMsgId = result.externalMsgId;
          sent = true;
        } catch (e: any) {
          lastErrorMsg = e?.message || 'Falha desconhecida ao enviar WhatsApp';
          sent = false;
        }
      }
    } else if (channel === 'EMAIL') {
      try {
        sent = await this.sendEmailReminder(event);
        if (!sent) lastErrorMsg = 'Email não enviado (verifique config SMTP ou destinatario)';
      } catch (e: any) {
        lastErrorMsg = e?.message || 'Falha desconhecida ao enviar email';
        sent = false;
      }
    }

    if (sent) {
      // v24+v25: limpa last_error + salva external_message_id pra webhook propagar status
      await this.prisma.eventReminder.update({
        where: { id: reminderId },
        data: {
          sent_at: new Date(),
          last_error: null,
          external_message_id: capturedExternalMsgId,
        },
      });
      this.logger.log(`[REMINDER] ${channel} enviado para evento "${event.title}" (${eventId})${capturedExternalMsgId ? ` msgId=${capturedExternalMsgId}` : ''}`);
    } else {
      // v24: salva motivo da falha pra UI mostrar no badge FALHOU
      await this.prisma.eventReminder.update({
        where: { id: reminderId },
        data: {
          last_error: lastErrorMsg ||
            `Falha ao enviar via ${channel}. Verifique se a instancia Evolution esta online e o numero tem WhatsApp ativo.`,
        },
      });
      this.logger.warn(`[REMINDER] ${channel} falhou para evento "${event.title}" — nao marcado como sent_at. Erro: ${lastErrorMsg}`);

      // v25 (#13): cria Notification pra admin/dentista quando reminder falha
      try {
        await this.notifyReminderFailure(event, reminder.minutes_before, lastErrorMsg);
      } catch (e: any) {
        this.logger.warn(`[REMINDER] Falha ao notificar admin sobre erro: ${e.message}`);
      }
    }
  }

  // ─── v25 (#13): Notifica equipe quando reminder falha ───────────────────────
  // Cria Notification pro dentista responsavel + admin do tenant. NotificationCenter
  // do app (sininho) mostra automaticamente.
  private async notifyReminderFailure(event: any, minutesBefore: number, errorMsg: string | null) {
    const userIds = new Set<string>();
    if (event.assigned_user_id) userIds.add(event.assigned_user_id);
    // Pega admins do mesmo tenant
    if (event.tenant_id) {
      const admins = await this.prisma.user.findMany({
        where: {
          tenant_id: event.tenant_id,
          roles: { has: 'ADMIN' },
        },
        select: { id: true },
        take: 5,
      });
      admins.forEach((a) => userIds.add(a.id));
    }
    const labelMin = minutesBefore < 60 ? `${minutesBefore}min` : minutesBefore === 60 ? '1h' : minutesBefore === 1440 ? '1d' : `${Math.round(minutesBefore / 60)}h`;
    const title = `Lembrete falhou (${labelMin} antes)`;
    const body = `${event.lead?.name || 'Paciente'} — ${event.title}. Motivo: ${errorMsg || 'erro desconhecido'}`;
    for (const uid of userIds) {
      try {
        await this.prisma.notification.create({
          data: {
            user_id: uid,
            tenant_id: event.tenant_id || null,
            notification_type: 'reminder_failed',
            title,
            body,
            data: { event_id: event.id, lead_id: event.lead_id, error: errorMsg },
          },
        });
      } catch {
        // silent — nao bloqueia o flow do worker se notif falhar
      }
    }
    if (userIds.size > 0) {
      this.logger.log(`[REMINDER] Notificacao 'reminder_failed' criada pra ${userIds.size} user(s)`);
    }
  }

  // ─── Orquestra os envios ──────────────────────────────────────────────────

  /**
   * Envia mensagem WhatsApp pro paciente + dentista.
   * v25: retorna { externalMsgId } da mensagem enviada AO PACIENTE pra
   * salvar no EventReminder e habilitar delivery tracking via webhook.
   */
  private async sendWhatsAppReminders(
    event: any,
    minutesBefore: number,
  ): Promise<{ externalMsgId: string | null }> {
    const isAudiencia = event.type === 'AUDIENCIA' || event.type === 'PERICIA';
    // Onda 17.61 — lembretes pra TODOS os atendimentos da agenda: CONSULTA +
    // PROCEDIMENTO + RETORNO (igual ao isClinicalEvent do backend). Bloqueio/
    // tarefa/outro não têm paciente pra lembrar.
    const isClinical = ['CONSULTA', 'PROCEDIMENTO', 'RETORNO', 'ORTODONTIA'].includes(event.type);

    // Carrega contexto adicional do cliente (memória)
    // STUBBED: LegalCase/DjenPublication/FichaTrabalhista removidos Fase 0.2
    const leadId = event.lead?.id;
    const memory = leadId
      ? await this.prisma.aiMemory.findUnique({ where: { lead_id: leadId } }).catch(() => null)
      : null;
    const ficha: any = null;
    const djenPubs: any[] = [];

    const context = buildContext(event, memory, null, ficha, djenPubs);

    // ── 1. Mensagem para o Dentista/Advogado (sempre) ─────────────────────────
    if (event.assigned_user?.phone) {
      const advPhone = event.assigned_user.phone.replace(/\D/g, '');
      // Dentista/Advogado recebe template rico — sem precisar de IA
      const advMsg = templateAdvogado(event, minutesBefore);
      try {
        await this.whatsapp.sendText(advPhone, advMsg);
        this.logger.log(`[REMINDER] WhatsApp enviado para dentista/advogado ${advPhone}`);
      } catch (e: any) {
        this.logger.warn(`[REMINDER] Erro ao enviar para dentista/advogado ${advPhone}: ${e.message}`);
      }
    }

    // v25: retorna externalMsgId pra worker salvar no EventReminder
    let returnedMsgId: string | null = null;

    // ── 2. Mensagem para o Cliente/Paciente ──────────────────────────────────
    // Onda 5e v17: ANTES era `if (isAudiencia && ...)` — bug critico que excluia
    // CONSULTA odonto (paciente nunca recebia lembrete!). Agora envia pra
    // qualquer evento com lead.phone, usando template apropriado por tipo.
    //
    // Onda 18.x — ORTODONTIA por ordem de chegada: se a clínica LIGOU os disparos
    // dedicados de ortô, o lembrete GENÉRICO ao paciente naquela faixa DUPLICARIA a
    // mensagem — então suprime o lembrete genérico do CLIENTE nessa faixa (o disparo
    // de ortô cobre). Mapa: faixa ~24h (1440–2879min) ↔ confirmação de ortô; faixa
    // same-day (<1440) ↔ lembrete de ortô (portões). A faixa 48h (>=2880, pedido de
    // confirmação) e o lembrete do DENTISTA (acima) NÃO são afetados.
    let suppressOrtoClient = false;
    if (event.type === 'ORTODONTIA' && event.tenant_id && minutesBefore < 2880) {
      const ortoKey =
        minutesBefore >= 1440
          ? `APPOINTMENT_CONFIRMATION_ORTO_ENABLED_${event.tenant_id}`
          : `APPOINTMENT_ORTO_REMINDER_ENABLED_${event.tenant_id}`;
      const ortoSetting = await this.prisma.globalSetting
        .findUnique({ where: { key: ortoKey } })
        .catch(() => null);
      suppressOrtoClient = ortoSetting?.value === 'true';
      // Faixa ~24h: só suprime se a confirmação de ortô REALMENTE vai disparar. O
      // scheduler PULA a confirmação (AppointmentConfirmation) quando existe um
      // lembrete de 48h (>=2880) NÃO enviado — ele "confia" que o de 48h confirma.
      // Se suprimíssemos o de 24h nesse caso e o de 48h falhasse, o paciente
      // ficaria SEM NADA. Então espelha o predicado do scheduler: com 48h pendente,
      // NÃO suprime o lembrete de 24h (rede de segurança).
      if (suppressOrtoClient && minutesBefore >= 1440) {
        const pending48h = await this.prisma.eventReminder
          .findFirst({
            where: { event_id: event.id, channel: 'WHATSAPP', sent_at: null, minutes_before: { gte: 2880 } },
            select: { id: true },
          })
          .catch(() => null);
        if (pending48h) suppressOrtoClient = false;
      }
      if (suppressOrtoClient) {
        this.logger.log(`[REMINDER] ORTODONTIA ${event.id} (${minutesBefore}min) — lembrete genérico do paciente suprimido (disparo de ortô ativo cobre a faixa)`);
      }
    }
    const shouldNotifyClient = (isAudiencia || isClinical) && event.lead?.phone && !suppressOrtoClient;
    if (shouldNotifyClient) {
      const clientPhone = event.lead.phone.replace(/\D/g, '');
      // Onda 17.60 — cada disparo é EXPLÍCITO (você liga o que quer): a CONFIRMAÇÃO
      // é o disparo de 48h (>=2880 min) — usa consulta_confirmacao e pede pra
      // confirmar. Os lembretes (24h/1h/15min) só LEMBRAM, nunca pedem confirmação.
      // (Confirmação por 24h fica no disparo separado "Confirmação de agendamento".)
      const isConfirmation = isClinical && minutesBefore >= 2880;
      let clientMsg: string;

      // AGENDA DO COMERCIAL — lead não-cliente + toggle da faixa LIGADO → texto
      // próprio e chip COMERCIAL, NO LUGAR da versão clínica (nunca os dois).
      // Toggle OFF (default) → comportamento atual. Ortodontia fica fora.
      // Detecção segura mesmo após o merge lead||patient do process(): o paciente
      // "disfarçado" de lead não carrega is_client (undefined ≠ false), e evento
      // com paciente de verdade tem event.patient preenchido.
      const leadComercial =
        !(event as any).patient && !!event.lead && (event.lead as any).is_client === false;
      let usaComercial = false;
      let comercialCid: string | null = null;
      if (leadComercial && isClinical && event.type !== 'ORTODONTIA' && event.tenant_id) {
        try {
          const { comercialAgendaEnabledKey, comercialLembreteIdFor } = await import('@crm/shared');
          const cid = comercialLembreteIdFor(minutesBefore);
          const cs = await this.prisma.globalSetting.findUnique({
            where: { key: comercialAgendaEnabledKey(cid, event.tenant_id) },
          });
          usaComercial = cs?.value === 'true';
        } catch { /* falha na leitura = segue o fluxo clínico */ }
      }

      if (usaComercial) {
        const { comercialAgendaTemplateKey, defaultComercialAgendaTemplate, comercialLembreteIdFor, applyTemplate } = await import('@crm/shared');
        const cid = comercialLembreteIdFor(minutesBefore);
        comercialCid = cid;
        let tpl = defaultComercialAgendaTemplate(cid);
        try {
          const row = await this.prisma.globalSetting.findUnique({
            where: { key: comercialAgendaTemplateKey(cid, event.tenant_id!) },
          });
          if (row?.value) {
            const parsed = JSON.parse(row.value);
            if (typeof parsed?.template === 'string' && parsed.template.trim()) tpl = parsed.template;
          }
        } catch { /* template corrompido → default */ }
        const tenantAddr = await this.loadTenantAddress(event.tenant_id!);
        const startAt = new Date(event.start_at);
        const dataStr = `${String(startAt.getUTCDate()).padStart(2, '0')}/${String(startAt.getUTCMonth() + 1).padStart(2, '0')}`;
        const horaStr = `${String(startAt.getUTCHours()).padStart(2, '0')}:${String(startAt.getUTCMinutes()).padStart(2, '0')}`;
        const dentistaFull = event.assigned_user?.name || '';
        const dParts = dentistaFull.split(' ');
        clientMsg = applyTemplate(tpl, {
          nome: (event.lead.name || 'você').split(' ')[0],
          nome_completo: event.lead.name || 'você',
          dentista: dParts.length >= 3 ? `${dParts[0]} ${dParts[1]}` : (dentistaFull || 'a clínica'),
          dentista_completo: dentistaFull || 'a clínica',
          data: dataStr,
          hora: horaStr,
          local: event.location || tenantAddr || '',
        });
        this.logger.log(`[REMINDER] Template COMERCIAL (${cid}) gerado pro lead ${clientPhone} (${minutesBefore}min antes)`);
      } else if (isClinical) {
        // CONSULTA/PROCEDIMENTO/RETORNO: usa o template natural odonto (sem IA pra ser
        // consistente). A confirmação (48h) usa o template consulta_confirmacao.
        // v27: carrega config do tenant pra usar templates customizaveis.
        const config = await this.loadReminderConfig(event.tenant_id);
        const tenantAddr = await this.loadTenantAddress(event.tenant_id);
        clientMsg = templateClienteConsulta(event, minutesBefore, config, tenantAddr, isConfirmation ? 'consulta_confirmacao' : undefined);
        this.logger.log(`[REMINDER] Template ${event.type}${isConfirmation ? ' (CONFIRMAÇÃO)' : ''} gerado pra paciente ${clientPhone} (${minutesBefore}min antes)`);
      } else {
        // AUDIENCIA/PERICIA: tenta IA, fallback pra template juridico
        try {
          clientMsg = await this.generateClientMessage(event, minutesBefore, context);
          this.logger.log(`[REMINDER] Mensagem IA gerada para cliente ${clientPhone}`);
        } catch (e: any) {
          this.logger.warn(`[REMINDER] IA indisponível, usando template: ${e.message}`);
          clientMsg = templateClienteJuridico(event, minutesBefore);
        }
      }

      // Busca a conversa ativa para salvar a mensagem.
      // NUNCA a do FINANCEIRO: ele é mundo isolado (conversa própria) e, como toda
      // cobrança dá bump no last_message_at dele, ele vencia este orderBy e o texto
      // de AGENDA era arquivado dentro da thread do financeiro — o dono via "o
      // financeiro mandando disparo de agendamento" (e o ai_mode/reminder_context
      // abaixo ainda eram setados na conversa errada).
      const lastConvo = await this.prisma.conversation.findFirst({
        where: {
          lead_id: event.lead.id,
          status: { not: 'ENCERRADO' },
          NOT: { inbox: { purpose: 'FINANCEIRO' } },
        },
        orderBy: { last_message_at: 'desc' },
        select: { id: true, instance_name: true },
      }).catch(() => null);

      // Onda 17.59 — CONSULTA odonto resolve a instância por TENANT e passa o
      // tenantId pro sendText (IGUAL à "agendada"/Notificar que FUNCIONAM). O
      // caminho antigo (instância por lead, sem tenantId) fazia o lembrete de
      // consulta falhar calado, porque o sendText resolve a config da Evolution
      // pelo tenant. Audiência/perícia mantêm o caminho legado por lead.
      // Agenda do Comercial: lead não-cliente sai pelo chip COMERCIAL.
      const reminderInstanceName = isClinical && event.tenant_id
        ? await this.resolveTenantInstance(event.tenant_id, usaComercial ? 'COMERCIAL' : 'CLINICA')
        : await this.resolveInstanceName(event.lead.id);

      let reminderSendResult: any;
      try {
        reminderSendResult = await this.whatsapp.sendText(
          clientPhone,
          clientMsg,
          reminderInstanceName ?? undefined,
          undefined,
          isClinical ? event.tenant_id : undefined,
        );
        // sendText() retorna objeto de erro em vez de lançar exceção em falhas HTTP
        if (!reminderSendResult || reminderSendResult?.statusCode >= 400 || reminderSendResult?.error) {
          throw new Error(`Evolution API error ${reminderSendResult?.statusCode}: ${reminderSendResult?.error}`);
        }
        this.logger.log(`[REMINDER] WhatsApp enviado para cliente ${clientPhone}`);
      } catch (e: any) {
        this.logger.warn(`[REMINDER] Erro ao enviar para cliente ${clientPhone}: ${e.message}`);
        // Não salva mensagem se envio falhou
        reminderSendResult = undefined;
      }

      // Central de Disparos 2.0 — o lembrete COMERCIAL ganha registro próprio no
      // DispatchLog (o EventReminder não distingue lead de paciente).
      if (comercialCid && event.tenant_id) {
        await this.prisma.dispatchLog.create({
          data: {
            tenant_id: event.tenant_id,
            type: comercialCid,
            channel: 'WHATSAPP',
            recipient_name: event.lead?.name || null,
            recipient_phone: clientPhone,
            status: reminderSendResult !== undefined ? 'SENT' : 'FAILED',
            error: reminderSendResult !== undefined ? null : 'Evolution recusou o envio (número/chip)',
            external_message_id: reminderSendResult?.data?.key?.id || null,
            ref_event_id: event.id,
            sent_at: new Date(),
          },
        }).catch((e: any) => this.logger.warn(`[DISPATCH-LOG] ${comercialCid} não registrou: ${e?.message}`));
      }

      // Sem conversa não-financeira: a mensagem SAIU, mas não há onde arquivar nem
      // onde armar o awaiting_confirmation — o "confirmo" do paciente não vai ser
      // processado. Logado pra não ser mais uma falha muda.
      if (!lastConvo && reminderSendResult !== undefined) {
        this.logger.warn(
          `[REMINDER] Lembrete enviado ao lead ${event.lead.id}, mas ele não tem conversa fora do FINANCEIRO — ` +
          `não arquivei e não armei a confirmação (a resposta dele não será processada).`,
        );
      }

      // ── Salva mensagem e contexto na conversa (visível para operador) ──
      if (lastConvo && reminderSendResult !== undefined) {
        try {
          const evolutionMsgId = reminderSendResult?.data?.key?.id || `sys_reminder_${Date.now()}`;
          returnedMsgId = evolutionMsgId; // v25: retorna pro worker salvar no reminder
          await this.prisma.message.create({
            data: {
              conversation_id: lastConvo.id,
              direction: 'out',
              type: 'text',
              text: clientMsg,
              external_message_id: evolutionMsgId,
              status: 'enviado',
            },
          });
          // Onda 17.60 — flag awaiting_confirmation SÓ no disparo de CONFIRMAÇÃO
          // (o lembrete de MAIOR antecedência do evento — 48h se houver, senão 24h).
          // Antes era qualquer >=1440, o que faria 48h E 24h pedirem confirmação.
          // A IA detecta a resposta e processa via AGENDAMENTO_OVERRIDES.
          const awaitingConfirmation = isConfirmation;
          await this.prisma.conversation.update({
            where: { id: lastConvo.id },
            data: {
              last_message_at: new Date(),
              ai_mode: true, // reativa IA para responder dúvidas do cliente
              reminder_context: {
                type: event.type,
                event_id: event.id,
                event_title: event.title,
                event_date: formatDateTime(event.start_at),
                event_date_iso: event.start_at.toISOString(),
                location: event.location || null,
                message_sent: clientMsg.slice(0, 800),
                minutes_before: minutesBefore,
                sent_at: new Date().toISOString(),
                // v17: marca lembrete 24h pra IA tratar resposta como confirmacao
                awaiting_confirmation: awaitingConfirmation,
              },
            },
          });
          this.logger.log(
            `[REMINDER] Mensagem salva e IA reativada na conversa ${lastConvo.id}` +
              (awaitingConfirmation ? ' (aguardando confirmacao)' : ''),
          );
        } catch (e: any) {
          this.logger.warn(`[REMINDER] Falha ao salvar mensagem na conversa: ${e.message}`);
        }
      }
    }

    // v25: retorna externalMsgId pra worker salvar no EventReminder
    return { externalMsgId: returnedMsgId };
  }

  /**
   * v27: Carrega ReminderConfig do tenant (ou global). Fallback pros
   * defaults DEFAULT_REMINDER_CONFIG se nao customizado. Cache nao usado
   * (cada chamada custa 1 query, aceitavel pra volume de lembretes).
   */
  private async loadReminderConfig(tenantId: string | null | undefined): Promise<ReminderConfig> {
    const key = tenantId ? `REMINDER_CONFIG_${tenantId}` : 'REMINDER_CONFIG';
    try {
      const setting = await this.prisma.globalSetting.findUnique({ where: { key } });
      if (!setting?.value) return DEFAULT_REMINDER_CONFIG;
      const parsed = JSON.parse(setting.value);
      return {
        default_antecedencias: Array.isArray(parsed.default_antecedencias)
          ? parsed.default_antecedencias
          : DEFAULT_REMINDER_CONFIG.default_antecedencias,
        templates: {
          ...DEFAULT_REMINDER_CONFIG.templates,
          ...(parsed.templates || {}),
        },
      };
    } catch (e: any) {
      this.logger.warn(`Falha ao carregar config ${key}, usando defaults: ${e?.message}`);
      return DEFAULT_REMINDER_CONFIG;
    }
  }

  /** Onda 17.57 — endereço cadastrado da clínica (Identidade) pro {local} do lembrete. */
  private async loadTenantAddress(tenantId: string | null | undefined): Promise<string> {
    if (!tenantId) return '';
    try {
      const t = await this.prisma.tenant.findUnique({
        where: { id: tenantId },
        select: {
          address: true, address_number: true, address_complement: true,
          neighborhood: true, city: true, state: true,
        },
      });
      return formatTenantAddress(t);
    } catch {
      return '';
    }
  }

  // ─── Notificação imediata de audiência agendada ───────────────────────────

  private async processHearingScheduled(eventId: string, isRescheduled = false) {
    // STUBBED: LegalCase relation removida Fase 0.2
    const event = await this.prisma.calendarEvent.findUnique({
      where: { id: eventId },
      include: {
        assigned_user: { select: { id: true, name: true, phone: true } },
        lead: { select: { id: true, name: true, phone: true, is_client: true } },
        // v31: patient como fallback quando evento foi criado direto via ficha
        // (sem lead vinculado). Worker mescla lead || patient ao processar.
        patient: { select: { id: true, name: true, phone: true } },
      },
    });

    if (!event) {
      this.logger.warn(`[HEARING-NOTIFY] Evento ${eventId} não encontrado — cancelado`);
      return;
    }
    if (['CANCELADO', 'CONCLUIDO'].includes(event.status)) {
      this.logger.log(`[HEARING-NOTIFY] Evento ${eventId} já está ${event.status} — ignorado`);
      return;
    }
    if (!event.lead?.phone) {
      this.logger.log(`[HEARING-NOTIFY] Evento ${eventId} sem telefone do cliente — ignorado`);
      return;
    }

    const leadId = event.lead.id;
    // STUBBED: LegalCase/DjenPublication/FichaTrabalhista removidos Fase 0.2
    const memory = await this.prisma.aiMemory.findUnique({ where: { lead_id: leadId } }).catch(() => null);
    const ficha: any = null;
    const djenPubs: any[] = [];

    const context = buildContext(event, memory, null, ficha, djenPubs);
    const clientPhone = event.lead.phone.replace(/\D/g, '');
    const firstName = (event.lead.name || 'Cliente').split(' ')[0];

    let msg: string;
    try {
      msg = await this.generateHearingScheduledMessage(event, context, firstName, isRescheduled);
      this.logger.log(`[HEARING-NOTIFY] Mensagem IA gerada para ${clientPhone} (remarcação=${isRescheduled})`);
    } catch (e: any) {
      this.logger.warn(`[HEARING-NOTIFY] IA indisponível, usando template: ${e.message}`);
      msg = isRescheduled
        ? this.templateHearingRescheduled(event, firstName)
        : this.templateHearingScheduled(event, firstName);
    }

    // Busca a conversa ativa para salvar a mensagem (visível ao operador)
    const lastConvo = await this.prisma.conversation.findFirst({
      where: { lead_id: leadId, status: { not: 'ENCERRADO' } },
      orderBy: { last_message_at: 'desc' },
      select: { id: true, ai_mode: true, instance_name: true },
    }).catch(() => null);

    // Resolve instância WhatsApp em 4 níveis: conversa ativa → encerrada → banco → env
    // Cobre clientes sem histórico no chat (cadastrados via processos/DJEN)
    const instanceName = await this.resolveInstanceName(leadId);

    let sendResult: any;
    try {
      sendResult = await this.whatsapp.sendText(
        clientPhone,
        msg,
        instanceName,
      );
      // sendText() retorna objeto de erro em vez de lançar exceção em falhas HTTP
      if (!sendResult || sendResult?.statusCode >= 400 || sendResult?.error) {
        throw new Error(`Evolution API error ${sendResult?.statusCode}: ${sendResult?.error}`);
      }
      this.logger.log(`[HEARING-NOTIFY] WhatsApp enviado para ${clientPhone} sobre ${event.type} ${eventId}`);
    } catch (e: any) {
      this.logger.warn(`[HEARING-NOTIFY] Erro ao enviar para ${clientPhone}: ${e.message}`);
      // Lança para que o BullMQ faça retry (attempts: 3)
      throw e;
    }

    // Salva mensagem na conversa (visível para o operador no chat)
    // e atualiza reminder_context para a IA/operador saberem o contexto
    if (lastConvo) {
      try {
        const evolutionMsgId = sendResult?.data?.key?.id || `sys_hearing_${Date.now()}`;
        await this.prisma.message.create({
          data: {
            conversation_id: lastConvo.id,
            direction: 'out',
            type: 'text',
            text: msg,
            external_message_id: evolutionMsgId,
            status: 'enviado',
          },
        });
        await this.prisma.conversation.update({
          where: { id: lastConvo.id },
          data: {
            last_message_at: new Date(),
            ai_mode: true, // reativa IA para responder dúvidas do cliente
            reminder_context: {
              type: event.type === 'PERICIA' ? 'PERICIA_AGENDADA' : 'AUDIENCIA_AGENDADA',
              event_title: event.title,
              event_date: formatDateTime(event.start_at),
              event_date_iso: event.start_at.toISOString(),
              location: event.location || null,
              message_sent: msg.slice(0, 800),
              sent_at: new Date().toISOString(),
            },
          },
        });
        this.logger.log(`[HEARING-NOTIFY] Mensagem salva e IA reativada na conversa ${lastConvo.id}`);
      } catch (e: any) {
        this.logger.warn(`[HEARING-NOTIFY] Falha ao salvar mensagem na conversa: ${e.message}`);
      }
    }
  }

  private templateHearingRescheduled(event: any, firstName: string): string {
    const dateStr = formatDateTime(event.start_at);
    const isPericia = event.type === 'PERICIA';
    return (
      `${isPericia ? '🔬' : '📅'} *${isPericia ? 'Perícia' : 'Audiência'} Remarcada*\n\n` +
      `Olá, ${firstName}!\n\n` +
      `Informamos que sua ${isPericia ? 'perícia' : 'audiência'} foi *remarcada* para uma nova data:\n\n` +
      `📅 *Nova Data/Hora:* ${dateStr}\n` +
      (event.location ? `📍 *Local:* ${event.location}\n` : '') +
      `\nPor favor, anote a nova data.${isPericia ? ' Lembre-se de levar documentos pessoais e laudos médicos, se houver.' : ' Chegue com *30 minutos de antecedência*.'}\n` +
      `Qualquer dúvida, é só responder esta mensagem.\n\n` +
      `_Atendimento_`
    );
  }

  private templateHearingScheduled(event: any, firstName: string): string {
    const dateStr = formatDateTime(event.start_at);
    const isPericia = event.type === 'PERICIA';
    return (
      `${isPericia ? '🔬' : '⚖️'} *${isPericia ? 'Perícia Agendada' : 'Audiência Agendada'}*\n\n` +
      `Olá, ${firstName}!\n\n` +
      `Gostaríamos de informar que sua ${isPericia ? 'perícia' : 'audiência'} foi agendada:\n\n` +
      `📅 *Data/Hora:* ${dateStr}\n` +
      (event.location ? `📍 *Local:* ${event.location}\n` : '') +
      (isPericia
        ? `\nLembre-se de levar documentos pessoais e laudos médicos, se houver. Chegue com *15 minutos de antecedência* e coopere plenamente com o perito.\n`
        : `\nRecomendamos chegar com *30 minutos de antecedência*.\n`) +
      `Qualquer dúvida, estamos à disposição.\n\n` +
      `_Atendimento_`
    );
  }

  private async generateHearingScheduledMessage(event: any, context: string, firstName: string, isRescheduled = false): Promise<string> {
    const aiConfig = await this.settings.getAiConfig();
    const model = aiConfig.defaultModel || 'gpt-4.1-mini';
    const isAnthropic = model.startsWith('claude');
    const dateStr = formatDateTime(event.start_at);
    const isPericia = event.type === 'PERICIA';
    const tipoEvento = isPericia ? 'perícia' : 'audiência';

    const systemPrompt = `Você é o assistente do clínica.
Sua tarefa é enviar uma mensagem via WhatsApp informando ao cliente que sua ${tipoEvento} foi ${isRescheduled ? 'remarcada' : 'agendada'}.

REGRAS:
- Escreva em português brasileiro natural e acolhedor
- Seja direto e claro — o cliente precisa saber a data, horário e local
- Use formatação WhatsApp (*negrito*) com moderação
- Personalize com base no histórico/contexto do caso quando relevante
- NÃO invente informações — use apenas o contexto fornecido
${isPericia
  ? '- Para perícia: oriente a levar documentos pessoais e laudos médicos, se houver; chegar 15 min antes; cooperar plenamente com o perito'
  : '- Se o caso for trabalhista, reforce brevemente a importância da audiência\n- Oriente a chegar com 30 minutos de antecedência'}
- Deixe claro que pode tirar dúvidas respondendo esta mensagem
- Limite: máximo 200 palavras
- Finalize com "_Atendimento_"`;

    const userPrompt = isRescheduled
      ? `Crie uma mensagem informando ao cliente que a ${tipoEvento} foi *remarcada* para uma nova data.
Deixe claro que é uma remarcação (não um novo agendamento).

DADOS DA NOVA ${tipoEvento.toUpperCase()}:
Data/Hora: ${dateStr}
${event.location ? `Local: ${event.location}` : 'Local: a confirmar'}

CONTEXTO DO CASO:
${context}

Nome do cliente: "${firstName}"

Gere APENAS a mensagem final para WhatsApp, sem explicações.`
      : `Crie uma mensagem informando ao cliente que a ${tipoEvento} foi agendada.

DADOS DA ${tipoEvento.toUpperCase()}:
Data/Hora: ${dateStr}
${event.location ? `Local: ${event.location}` : 'Local: a confirmar'}
${event.title ? `Título: ${event.title}` : ''}

CONTEXTO DO CASO:
${context}

Nome do cliente: "${firstName}"

Gere APENAS a mensagem final para WhatsApp, sem explicações.`;

    if (isAnthropic) {
      const anthropicKey = (await this.settings.get('ANTHROPIC_API_KEY')) || process.env.ANTHROPIC_API_KEY;
      if (!anthropicKey) throw new Error('ANTHROPIC_API_KEY não configurada');
      const client = new Anthropic({ apiKey: anthropicKey });
      const response = await client.messages.create({
        model, max_tokens: 350, temperature: 0.7,
        system: systemPrompt,
        messages: [{ role: 'user', content: userPrompt }],
      });
      return ((response.content[0] as any)?.text || '').trim();
    } else {
      const openaiKey = (await this.settings.get('OPENAI_API_KEY')) || process.env.OPENAI_API_KEY;
      if (!openaiKey) throw new Error('OPENAI_API_KEY não configurada');
      const openai = new OpenAI({ apiKey: openaiKey });
      const completion = await openai.chat.completions.create({
        model, max_tokens: 350, temperature: 0.7,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
      });
      return (completion.choices[0]?.message?.content || '').trim();
    }
  }

  // ─── Geração da mensagem via IA ───────────────────────────────────────────

  private async generateClientMessage(
    event: any,
    minutesBefore: number,
    context: string,
  ): Promise<string> {
    const aiConfig = await this.settings.getAiConfig();
    const model = aiConfig.defaultModel || 'gpt-4.1-mini';
    const isAnthropic = model.startsWith('claude');
    const prazo = minutesLabel(minutesBefore);
    const firstName = (event.lead?.name || 'Cliente').split(' ')[0];

    const isPericia = event.type === 'PERICIA';
    const systemPrompt = `Você é o assistente virtual do clínica.
Sua função é enviar lembretes personalizados e humanizados via WhatsApp para os clientes.

REGRAS IMPORTANTES:
- Escreva em português brasileiro natural e acolhedor, sem ser formal demais
- Seja direto e objetivo — a mensagem deve ser lida rapidamente no celular
- Use formatação WhatsApp (*negrito*, _itálico_) com moderação
- Personalize com base no histórico e contexto do caso
- NÃO invente informações — use apenas o que está no contexto fornecido
- NÃO mencione valores monetários a menos que estejam explicitamente no contexto
${isPericia
  ? '- Para perícia: oriente o cliente a chegar com 15 min de antecedência, levar documentos pessoais e laudos médicos se houver, e cooperar plenamente com o perito'
  : '- Se o caso for trabalhista, mencione a importância da audiência para o direito do cliente\n- Sempre oriente a chegar com antecedência (30 min)'}
- Sempre indique o horário e local de forma clara
- Finalize sinalizando disponibilidade para dúvidas
- Limite: máximo 250 palavras
- NÃO use assinatura longa — apenas "_Atendimento_" no final`;

    const userPrompt = `Crie uma mensagem de lembrete personalizada para o cliente sobre a audiência que ocorre em ${prazo}.

DADOS DO CASO:
${context}

O nome do cliente é "${firstName}".
A audiência é em ${prazo}.

Gere APENAS a mensagem final formatada para WhatsApp, sem explicações adicionais.`;

    if (isAnthropic) {
      const anthropicKey = (await this.settings.get('ANTHROPIC_API_KEY')) || process.env.ANTHROPIC_API_KEY;
      if (!anthropicKey) throw new Error('ANTHROPIC_API_KEY não configurada');
      const client = new Anthropic({ apiKey: anthropicKey });
      const response = await client.messages.create({
        model,
        max_tokens: 400,
        temperature: 0.7,
        system: systemPrompt,
        messages: [{ role: 'user', content: userPrompt }],
      });
      return ((response.content[0] as any)?.text || '').trim();
    } else {
      const openaiKey = (await this.settings.get('OPENAI_API_KEY')) || process.env.OPENAI_API_KEY;
      if (!openaiKey) throw new Error('OPENAI_API_KEY não configurada');
      const openai = new OpenAI({ apiKey: openaiKey });
      const completion = await openai.chat.completions.create({
        model,
        max_tokens: 400,
        temperature: 0.7,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
      });
      return (completion.choices[0]?.message?.content || '').trim();
    }
  }

  // ─── Resolução da instância WhatsApp (4 níveis de fallback) ──────────────────
  //
  //  1. Conversa ativa do lead (status ≠ ENCERRADO)
  //  2. Qualquer conversa do lead (inclusive encerradas)
  //  3. Primeira instância WhatsApp cadastrada no banco
  //     → cobre clientes sem histórico no chat (cadastrados via processos/DJEN)
  //  4. Variável de ambiente EVOLUTION_INSTANCE_NAME
  //
  // Ao retornar undefined o sendText() usará a instância padrão configurada
  // no WhatsappService — envio ainda pode funcionar em instâncias single-tenant.

  private async resolveInstanceName(leadId: string): Promise<string | undefined> {
    // Nível 1: conversa ativa
    const activeConvo = await this.prisma.conversation.findFirst({
      where: { lead_id: leadId, status: { not: 'ENCERRADO' } },
      orderBy: { last_message_at: 'desc' },
      select: { instance_name: true },
    }).catch(() => null);
    if (activeConvo?.instance_name) return activeConvo.instance_name;

    // Nível 2: qualquer conversa (inclusive encerradas)
    const anyConvo = await this.prisma.conversation.findFirst({
      where: { lead_id: leadId, instance_name: { not: null } },
      orderBy: { last_message_at: 'desc' },
      select: { instance_name: true },
    }).catch(() => null);
    if (anyConvo?.instance_name) {
      this.logger.log(`[INSTANCE] Lead ${leadId} sem conversa ativa — usando instância de conversa anterior: ${anyConvo.instance_name}`);
      return anyConvo.instance_name;
    }

    // Nível 3: primeira instância WhatsApp cadastrada no banco
    const dbInstance = await this.prisma.instance.findFirst({
      where: { type: 'whatsapp' },
      select: { name: true },
    }).catch(() => null);
    if (dbInstance?.name) {
      this.logger.log(`[INSTANCE] Lead ${leadId} sem conversas — usando instância do banco: ${dbInstance.name}`);
      return dbInstance.name;
    }

    // Nível 4: variável de ambiente
    const envInstance = process.env.EVOLUTION_INSTANCE_NAME;
    if (envInstance) {
      this.logger.log(`[INSTANCE] Lead ${leadId} sem instância no banco — usando env EVOLUTION_INSTANCE_NAME: ${envInstance}`);
      return envInstance;
    }

    this.logger.warn(`[INSTANCE] Lead ${leadId}: nenhuma instância WhatsApp encontrada. Envio pode falhar.`);
    return undefined;
  }

  // ─── Resolução da instância por TENANT (Onda 17.59) ──────────────────────────
  //
  // Espelha resolveTenantWhatsappInstance do CalendarService — a engine da
  // "agendada"/Notificar que FUNCIONAM. Escopar por tenant_id (em vez de por lead)
  // é o que faltava pro lembrete de CONSULTA odonto entregar: conversa do tenant →
  // instância do tenant. Pode voltar null — aí o sendText resolve via tenantId.
  private async resolveTenantInstance(
    tenantId: string,
    purpose?: 'COMERCIAL' | 'CLINICA',
  ): Promise<string | null> {
    // Onda 17.64 — prefere o chip da função pedida (lembrete clínico sai pelo
    // chip CLINICA). Sempre escopado por tenant_id; fallback = heurística atual.
    if (purpose) {
      const byPurpose = await this.prisma.instance.findFirst({
        where: { type: 'whatsapp', tenant_id: tenantId, purpose },
        orderBy: { created_at: 'asc' },
        select: { name: true },
      }).catch(() => null);
      if (byPurpose?.name) return byPurpose.name;
    }
    // Onda 18.x — UNIÃO Comercial↔Clínica: chip pedido fora → usa o OUTRO chip
    // clínico antes de qualquer fallback (mesmo mundo paciente/lead). Nunca Financeiro.
    if (purpose === 'CLINICA' || purpose === 'COMERCIAL') {
      const irmao = purpose === 'CLINICA' ? 'COMERCIAL' : 'CLINICA';
      const bySibling = await this.prisma.instance.findFirst({
        where: { type: 'whatsapp', tenant_id: tenantId, purpose: irmao },
        orderBy: { created_at: 'asc' },
        select: { name: true },
      }).catch(() => null);
      if (bySibling?.name) return bySibling.name;
    }
    // Nomes dos chips FINANCEIRO — pra não vazarem no fallback por conversa.
    const finNames = (await this.prisma.instance.findMany({
      where: { type: 'whatsapp', tenant_id: tenantId, purpose: 'FINANCEIRO' },
      select: { name: true },
    }).catch(() => [] as { name: string }[])).map((i) => i.name);
    // Fallback: a conversa mais recente do TENANT. Excluir o financeiro é essencial —
    // ele não é do mundo da agenda e, como toda cobrança dá bump no last_message_at,
    // ele virava "a mais recente" e SEQUESTRAVA o chip do próximo lembrete de consulta.
    const convo = await this.prisma.conversation.findFirst({
      where: {
        instance_name: { not: null },
        tenant_id: tenantId,
        NOT: [
          { inbox: { purpose: 'FINANCEIRO' } },
          ...(finNames.length ? [{ instance_name: { in: finNames } }] : []),
        ],
      },
      orderBy: { last_message_at: 'desc' },
      select: { instance_name: true },
    }).catch(() => null);
    if (convo?.instance_name) return convo.instance_name;
    const inst = await this.prisma.instance.findFirst({
      where: { type: 'whatsapp', tenant_id: tenantId, NOT: { purpose: 'FINANCEIRO' } },
      orderBy: { created_at: 'asc' },
      select: { name: true },
    }).catch(() => null);
    if (inst?.name) return inst.name;

    // Onda 18.x — só sobrou o chip FINANCEIRO: NÃO manda lembrete/confirmação de
    // paciente por ele (número de cobrança). Devolve null → não envia; o aviso de
    // tela pede pra reconectar a Clínica. (Antes saía pelo financeiro; a clínica
    // preferiu não trocar o número do paciente.)
    this.logger.warn(
      `[REMINDER] Tenant ${tenantId} sem chip CLINICA/COMERCIAL conectado — disparo de paciente NÃO sai pelo Financeiro. Reconecte a Clínica.`,
    );
    return null;
  }

  // ─── Email reminder (portado do worker em 2026-04-20 — Divida 3) ────────
  //
  // Envia lembrete HTML por email para lead + advogado assigned ao evento.
  // Le config SMTP via SettingsService.getSmtpConfig() (mesma fonte do worker).
  // Retorna true se pelo menos 1 destinatario recebeu com sucesso.
  private async sendEmailReminder(event: any): Promise<boolean> {
    const recipients: { email: string; name: string }[] = [];
    if (event.lead?.email) {
      recipients.push({ email: event.lead.email, name: event.lead.name || event.lead.email });
    }
    if (event.assigned_user?.email) {
      recipients.push({
        email: event.assigned_user.email,
        name: event.assigned_user.name || event.assigned_user.email,
      });
    }

    if (recipients.length === 0) {
      this.logger.warn(`Evento ${event.id} nao tem email de destino — lembrete email ignorado`);
      return false;
    }

    const smtp = await this.settings.getSmtpConfig();
    if (!smtp.host) {
      this.logger.warn('SMTP nao configurado — lembrete email ignorado');
      return false;
    }

    // Onda 17.32.175 — resolve o host via dns.lookup antes do nodemailer
    // (o resolve4 interno dele falha no Swarm; ver smtp.util.ts)
    const transporter = await createSmtpTransport(smtp);

    const typeEmoji = TYPE_EMOJI[event.type] || '📅';
    const label = TYPE_LABEL[event.type] || 'Evento';
    const dateStr = formatDateShort(event.start_at);
    const timeStr = formatTimeShort(event.start_at);

    let anySent = false;
    for (const recipient of recipients) {
      const html = `
        <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 480px; margin: 0 auto; padding: 24px;">
          <div style="background: #1a1a2e; border-radius: 16px; padding: 24px; color: #e0e0e0;">
            <h2 style="margin: 0 0 16px; color: #fff; font-size: 18px;">
              ${typeEmoji} Lembrete de ${label}
            </h2>
            <div style="background: rgba(255,255,255,0.05); border-radius: 12px; padding: 16px; margin-bottom: 16px;">
              <p style="margin: 0 0 8px; font-weight: bold; font-size: 16px; color: #fff;">${event.title}</p>
              <p style="margin: 0 0 4px; color: #a0a0b0;">📆 ${dateStr}</p>
              <p style="margin: 0 0 4px; color: #a0a0b0;">⏰ ${timeStr}</p>
              ${event.location ? `<p style="margin: 0; color: #a0a0b0;">📍 ${event.location}</p>` : ''}
            </div>
            <p style="margin: 0; color: #a0a0b0; font-size: 13px;">
              Olá ${recipient.name}, este é um lembrete do seu compromisso agendado.
            </p>
          </div>
          <p style="text-align: center; color: #888; font-size: 11px; margin-top: 16px;">
            Enviado automaticamente pelo sistema da clínica
          </p>
        </div>
      `;

      try {
        await transporter.sendMail({
          from: smtp.from || smtp.user,
          to: recipient.email,
          subject: `${typeEmoji} Lembrete: ${event.title} — ${dateStr} ${timeStr}`,
          html,
        });
        this.logger.log(`Email lembrete enviado para ${recipient.email} (${recipient.name})`);
        anySent = true;
      } catch (err: any) {
        this.logger.error(`Falha ao enviar email para ${recipient.email}: ${err.message}`);
      }
    }
    return anySent;
  }
}

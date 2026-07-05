import { Processor, WorkerHost, InjectQueue } from '@nestjs/bullmq';
import { Job, Queue } from 'bullmq';
import { Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { SettingsService } from '../settings/settings.service';
import { S3Service } from '../s3/s3.service';
import OpenAI, { toFile } from 'openai';
import axios from 'axios';
import { SkillRouter } from './skill-router';
import { ToolExecutor } from './tool-executor';
import { PromptBuilder } from './prompt-builder';
import { buildHandlerMap } from './tool-handlers';
import { createLLMClient, calculateCost, type LLMProvider } from './llm-client';
import { computeBusinessHoursInfo } from '@crm/shared';
import { MemoryRetrievalService } from '../memory/memory-retrieval.service';
import { loadPipelinesForTenant, buildPipelinesPromptBlock, resolveStageUpdate } from './pipeline-context';
import { ensureOrcamentistaAssigned } from './orcamentista';

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
  private promptBuilder = new PromptBuilder();

  constructor(
    private prisma: PrismaService,
    private settings: SettingsService,
    private s3: S3Service,
    @InjectQueue('calendar-reminders') private reminderQueue: Queue,
    private memoryRetrieval: MemoryRetrievalService,
  ) {
    super();
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
    scheduling_action?: { action: string; date?: string; time?: string };
    slots_to_offer?: { date: string; time: string; label: string }[];
  } {
    const extract = (parsed: any) => ({
      reply: parsed.reply ?? '',
      updates: parsed.updates || parsed.lead_update || {},
      scheduling_action: parsed.scheduling_action || undefined,
      slots_to_offer: parsed.slots_to_offer || undefined,
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
      return { reply, updates: {} };
    }

    this.logger.warn('[AI] Resposta não é JSON válido — usando como texto puro');
    return { reply: raw, updates: {} };
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
    let resolvedStage: string | null = null;
    if (updates.status && updates.status !== 'null') {
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
      if (inferred) {
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
              start_at: new Date(Date.now() + 24 * 60 * 60 * 1000),
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
        if (pipeUpdate) {
          await (this.prisma as any).lead.update({ where: { id: leadId }, data: pipeUpdate });
          this.logger.log(
            `[AI] CRM dinâmico aplicado ao lead ${leadId}: ${JSON.stringify(pipeUpdate)}`,
          );
        } else {
          this.logger.warn(
            `[AI] Slug de pipeline/stage inválido — stage_slug=${updates.stage_slug}, pipeline_slug=${updates.pipeline_slug}. Lead não atualizado.`,
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

    // Enqueue WhatsApp reminders
    for (const r of event.reminders) {
      const fireAt = new Date(event.start_at.getTime() - r.minutes_before * 60 * 1000);
      if (fireAt > new Date()) {
        await this.reminderQueue.add(
          'send-reminder',
          { reminderId: r.id, eventId: event.id, channel: r.channel },
          { delay: fireAt.getTime() - Date.now() },
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
  private async buildRescheduleSuggestion(convo: any): Promise<string | null> {
    try {
      const dentistId = convo.assigned_dentist_id || convo.assigned_user_id;
      if (!dentistId) return null;
      const now = new Date();
      const tz = 'America/Maceio';
      const formatDateBR = (d: Date) =>
        d.toLocaleDateString('pt-BR', { timeZone: tz, weekday: 'short', day: '2-digit', month: '2-digit' });
      const slots: { date: string; time: string; label: string }[] = [];
      // Busca 7 dias a frente
      for (let i = 1; i <= 14 && slots.length < 3; i++) {
        const day = new Date(now.getTime() + i * 24 * 60 * 60 * 1000);
        if (day.getDay() === 0) continue; // pula domingo
        const dateStr = day.toISOString().split('T')[0];
        const dayslots = await this.getAvailability(dentistId, dateStr, 60);
        if (dayslots.length > 0) {
          slots.push({
            date: dateStr,
            time: dayslots[0].start,
            label: `${formatDateBR(day)} às ${dayslots[0].start}`,
          });
        }
      }
      if (slots.length === 0) return null;
      const firstName = (convo.lead?.name || '').split(' ')[0] || '';
      const greeting = firstName ? `${firstName}, ` : '';
      const intro = `${greeting}sem problema! Tenho esses horários pertinho:`;
      const lines = slots.map((s) => `• ${s.label}`).join('\n');
      const cta = '\nAlgum desses serve melhor pra você?';
      return `${intro}\n${lines}${cta}`;
    } catch (e: any) {
      this.logger.warn(`[AI] buildRescheduleSuggestion falhou: ${e.message}`);
      return null;
    }
  }

  // ─── Consulta disponibilidade de horários de um dentista ───
  private async getAvailability(
    userId: string,
    dateStr: string,
    durationMinutes: number,
  ): Promise<{ start: string; end: string }[]> {
    const date = new Date(dateStr);
    const dayOfWeek = date.getDay();

    // Verificar feriado
    const dateOnly = date.toISOString().split('T')[0];
    const holidayCount = await (this.prisma as any).holiday.count({
      where: {
        OR: [
          { date: new Date(dateOnly) },
          { date: { gte: new Date(dateOnly + 'T00:00:00'), lte: new Date(dateOnly + 'T23:59:59') } },
        ],
      },
    });
    if (holidayCount > 0) return [];

    // Horário de trabalho do dia
    const schedule = await (this.prisma as any).userSchedule.findUnique({
      where: { user_id_day_of_week: { user_id: userId, day_of_week: dayOfWeek } },
    });
    if (!schedule) return [];

    // Eventos existentes nesse dia
    const dayStart = new Date(date);
    dayStart.setHours(0, 0, 0, 0);
    const dayEnd = new Date(date);
    dayEnd.setHours(23, 59, 59, 999);

    const events = await this.prisma.calendarEvent.findMany({
      where: {
        assigned_user_id: userId,
        start_at: { gte: dayStart, lte: dayEnd },
        status: { notIn: ['CANCELADO'] },
      },
      select: { start_at: true, end_at: true },
      orderBy: { start_at: 'asc' },
    });

    // Calcular slots livres
    const [startH, startM] = schedule.start_time.split(':').map(Number);
    const [endH, endM] = schedule.end_time.split(':').map(Number);
    const workStart = startH * 60 + startM;
    const workEnd = endH * 60 + endM;

    const busy = events.map((e: any) => {
      const s = e.start_at.getHours() * 60 + e.start_at.getMinutes();
      const eEnd = e.end_at
        ? e.end_at.getHours() * 60 + e.end_at.getMinutes()
        : s + 30;
      return { start: s, end: eEnd };
    });

    // Adicionar pausa de almoço como período ocupado
    if (schedule.lunch_start && schedule.lunch_end) {
      const [lsH, lsM] = (schedule.lunch_start as string).split(':').map(Number);
      const [leH, leM] = (schedule.lunch_end as string).split(':').map(Number);
      busy.push({ start: lsH * 60 + lsM, end: leH * 60 + leM });
      busy.sort((a: any, b: any) => a.start - b.start);
    }

    const slots: { start: string; end: string }[] = [];
    let cursor = workStart;
    for (const b of busy) {
      while (cursor + durationMinutes <= b.start) {
        const slotEnd = cursor + durationMinutes;
        slots.push({
          start: `${String(Math.floor(cursor / 60)).padStart(2, '0')}:${String(cursor % 60).padStart(2, '0')}`,
          end: `${String(Math.floor(slotEnd / 60)).padStart(2, '0')}:${String(slotEnd % 60).padStart(2, '0')}`,
        });
        cursor = slotEnd;
      }
      if (b.end > cursor) cursor = b.end;
    }
    while (cursor + durationMinutes <= workEnd) {
      const slotEnd = cursor + durationMinutes;
      slots.push({
        start: `${String(Math.floor(cursor / 60)).padStart(2, '0')}:${String(cursor % 60).padStart(2, '0')}`,
        end: `${String(Math.floor(slotEnd / 60)).padStart(2, '0')}:${String(slotEnd % 60).padStart(2, '0')}`,
      });
      cursor = slotEnd;
    }

    return slots;
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

    try {
      // 2. Buscar conversa + lead + últimas 20 mensagens com mídia incluída
      // orderBy desc para pegar as mais RECENTES; invertemos abaixo para ordem cronológica
      const convo = await this.prisma.conversation.findUnique({
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
      if (!convo) return;

      // 3a. Quando ai_mode=false (operador humano atende), nada a fazer aqui.
      //
      // O sistema antigo atualizava AiMemory sincronamente neste ponto. Hoje,
      // a extracao batch noturna (DailyMemoryBatchProcessor 00h) processa as
      // conversas de operadores humanos junto com as da IA, gerando Memory
      // entries e atualizando LeadProfile automaticamente.
      if (!convo.ai_mode) {
        return;
      }

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

      // 7. Montar histórico com rótulos (Cliente / Sophia / Operador)
      // Invertemos o array (que veio desc) para ordem cronológica correta
      const chronological = [...convo.messages].reverse();
      const historyText = chronological
        .map((m: any) => {
          const sender =
            m.direction === 'in'
              ? 'Cliente'
              : m.external_message_id?.startsWith('sys_')
                ? 'Sophia'
                : 'Operador';
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
      let activeSkills = allActiveSkills;
      let silentNoSkill = false;
      try {
        let chipPurpose: string | null = null;
        if (convo.instance_name) {
          const inst = await this.prisma.instance.findFirst({
            where: { name: convo.instance_name },
            select: { purpose: true },
          });
          chipPurpose = inst?.purpose || null;
        }
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
        if (lead?.is_client) {
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
      if (isActiveClient) {
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
              const sender = m.direction === 'in' ? 'Cliente' : 'Sophia';
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
      const assignedDentistId = (convo as any).assigned_dentist_id;
      if (assignedDentistId) {
        try {
          const now = new Date();
          const tz = 'America/Maceio';
          const formatDateBR = (d: Date) =>
            d.toLocaleDateString('pt-BR', { timeZone: tz, day: '2-digit', month: '2-digit' });
          const formatWeekday = (d: Date) => {
            const wd = d.toLocaleDateString('pt-BR', { timeZone: tz, weekday: 'long' });
            // Capitaliza ("segunda-feira" → "Segunda-feira")
            return wd.charAt(0).toUpperCase() + wd.slice(1);
          };
          const slotParts: string[] = [];
          // v12: NAO pula sabado. Apenas pula domingo (raramente clinica
          // odontologica atende). Se quiser tambem desbloquear domingo, basta
          // remover o skip abaixo — getAvailability ja respeita UserSchedule.
          for (let i = 1; i <= 14 && slotParts.length < 5; i++) {
            const day = new Date(now.getTime() + i * 24 * 60 * 60 * 1000);
            if (day.getDay() === 0) continue; // pula apenas domingo (clinica fechada)
            const dateStr = day.toISOString().split('T')[0];
            const slots = await this.getAvailability(assignedDentistId, dateStr, 60);
            if (slots.length > 0) {
              const slotsStr = slots.slice(0, 6).map((s) => s.start).join(', ');
              slotParts.push(`${formatWeekday(day)} ${formatDateBR(day)} (${dateStr}): ${slotsStr}`);
            }
          }
          if (slotParts.length > 0) {
            availableSlots = slotParts.join(' | ');
          } else {
            availableSlots = 'Sem horários disponíveis nos próximos dias.';
          }
        } catch (e: any) {
          this.logger.warn(`[AI] Falha ao buscar disponibilidade: ${e.message}`);
          availableSlots = 'Erro ao consultar horários — tente novamente.';
        }
      }

      // ── Próximos eventos do calendário do lead — perícias, audiências, prazos ──
      let upcomingEventsBlock = '';
      try {
        const upcomingEvents = await this.prisma.calendarEvent.findMany({
          where: {
            lead_id: convo.lead_id,
            start_at: { gte: new Date() },
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
      // Passa null quando tenant_id é string vazia/UUID dummy — evita filtrar
      // holidays por tenant inexistente.
      const rawTenantId = (convo as any).tenant_id;
      const tenantIdForBH =
        rawTenantId && rawTenantId !== '00000000-0000-0000-0000-000000000000'
          ? rawTenantId
          : null;
      const businessHoursInfo = await computeBusinessHoursInfo(
        this.prisma,
        tenantIdForBH,
      ).catch((e: any) => {
        this.logger.warn(`[AI] Falha ao calcular business_hours_info: ${e.message}`);
        return '';
      });
      this.logger.log(
        `[AI] business_hours_info len=${businessHoursInfo.length} tenant="${tenantIdForBH}" preview="${businessHoursInfo.slice(0, 120).replace(/\n/g, '\\n')}"`,
      );

      const vars: Record<string, string> = {
        lead_name: convo.lead.name || 'Desconhecido',
        lead_phone: convo.lead.phone || '',
        specialty: specialty || 'a ser identificada',
        firm_name: 'Instituto Odonto Passos',
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
        reminder_context: reminderContextBlock,
        upcoming_events: upcomingEventsBlock,
        operator_notes: operatorNotesBlock,
        ai_notes: aiNotesBlock,
        active_cases_info: activeCasesInfoBlock,
        business_hours_info: businessHoursInfo,
      };

      // Cabeçalho fixo de capacidades — injetado antes de qualquer skill prompt
      const MEDIA_CAPABILITIES_HEADER = `CAPACIDADES DE MÍDIA DISPONÍVEIS:
- Áudios são transcritos automaticamente por IA (Whisper). O texto transcrito já aparece no histórico como texto normal. NUNCA diga que não consegue ouvir — você lê a transcrição.
- Imagens e documentos enviados pelo cliente são analisados visualmente quando o modelo suporta visão. Responda ao conteúdo deles normalmente.
- NUNCA peça para o cliente "escrever em texto" por causa de mídia — você já consegue ler o conteúdo.

`;

      // CORE_RULES: regras técnicas imutáveis injetadas em TODO prompt.
      // O conteúdo de personalidade, roteiro e comportamento está no skill.system_prompt (editável no admin).
      const CORE_RULES = `DATA E HORA ATUAL: {{data_hoje}} (fuso horário de Maceió/AL).

🚨🚨🚨 REGRAS PRIORITÁRIAS DE AGENDAMENTO (LEIA TAMBÉM AS REGRAS DETALHADAS NO FINAL DESTE PROMPT) 🚨🚨🚨

Ao tratar agendamento de avaliação/consulta, OBRIGATORIAMENTE:
1. SEMPRE proponha 1-3 horários CONCRETOS quando o lead demonstrar interesse em marcar.
2. Se o lead disser "não vou poder", "não consigo", "preciso remarcar", "tenho imprevisto",
   "não conseguirei", trate como REMARCAÇÃO e proponha 2-3 horários novos imediatamente.
   NUNCA aceite passivamente ("ok, te aviso") — perdemos paciente assim.
3. Se você FALAR que cancelou ("cancelei", "removi da agenda"), OBRIGATÓRIO emitir
   scheduling_action: { "action": "cancel_appointment" } no JSON. Sem isso, fica
   inconsistente: paciente acha que cancelou mas o evento permanece na agenda.
4. PROIBIDO falar "alguém entrará em contato", "aguarde retorno", "vou passar pra
   atendente" — perdemos lead a cada vez. SEMPRE oferte horários da {{available_slots}}.

A versão DETALHADA dessas regras está no FINAL deste prompt sob "🚨 REGRAS INVIOLÁVEIS DE
AGENDAMENTO". Aquelas têm prioridade sobre QUALQUER outra instrução acima.

═══════════════════════════════════════════════════
IDENTIDADE DO CONTATO ATUAL (NUNCA pergunte de qual número ou com quem está falando — esta é a verdade):
- Nome: {{lead_name}}
- Telefone WhatsApp: {{lead_phone}}
- Conversa ID: {{conversation_id}}
═══════════════════════════════════════════════════
MEMÓRIA DO LEAD (tudo que já foi coletado sobre este cliente):
{{lead_memory}}
═══════════════════════════════════════════════════
{{operator_notes}}
{{ai_notes}}
{{reminder_context}}
{{upcoming_events}}
{{active_cases_info}}
REGRAS DE TOM E FORMATO (INVIOLÁVEIS):
- MÁXIMO 2 frases curtas por mensagem. Se passar disso, CORTE.
- NUNCA pular linha na mensagem. Tudo em bloco só.
- NUNCA usar: "Opa", "Beleza", "Caramba", "Show", "Top", "Legal", "Massa", "Dahora"
- NUNCA usar: "Ótima pergunta", "Boa pergunta", "Excelente pergunta"
- NUNCA usar: "Entendi.", "Ok.", "Certo.", "Vou anotar", "Anotei"
- NUNCA comentar o que o lead disse: nada de "isso é sério", "é pesado mesmo", "complicado"
- NUNCA ser MAIS informal que o lead. O lead define o tom. Se ele escreve formal, responda formal.
- Vá DIRETO para a próxima pergunta. Sem preâmbulos.

PROIBIDO REPETIR PERGUNTAS:
- O histórico COMPLETO da conversa está nos turns acima (user/assistant). LEIA TUDO.
- A MEMÓRIA DO LEAD contém TODOS os fatos já extraídos.
- ANTES de perguntar algo, verifique SE a informação já foi dita no histórico OU na memória.
- Se perceber que repetiu, reconheça e avance.

PROIBIDO CONFUNDIR A IDENTIDADE DO CONTATO:
- O telefone do cliente que está conversando agora é {{lead_phone}}. Isso é fato.
- Se o lead mencionar um número diferente na conversa (ex: "meu fixo é X"), é info ADICIONAL — NUNCA pergunte "você está falando daquele número?" ou "qual número você está usando?".
- Se uma mensagem chega, ELA VEIO de {{lead_phone}}. Nunca questione.
- Se precisar confirmar qual é o contato principal, use o {{lead_phone}} já exibido acima.

RESPONDER A PERGUNTA DO CLIENTE VEM SEMPRE PRIMEIRO (CRÍTICO):
- Se o cliente fez uma PERGUNTA direta, RESPONDA essa pergunta ANTES de qualquer outra ação.
- NUNCA ignore a pergunta pra seguir seu roteiro. Responda primeiro, depois continue com o que precisar.
- Se a pergunta for sobre OS PRÓPRIOS DADOS dele (nome, telefone, email, CPF), CONFIRME usando o bloco "IDENTIDADE DO CONTATO ATUAL" acima. Exemplos:
  * "qual meu número?" → "Seu número é {{lead_phone}}."
  * "qual meu nome cadastrado?" → "Temos {{lead_name}} aqui."
  * "qual o telefone que aparece pra vocês?" → "Aparece {{lead_phone}}."
- Se a pergunta for sobre o ESCRITÓRIO (endereço, horário, equipe, honorários), RESPONDA com base nas informações de "Sobre nosso escritório" (se sua skill tem essa seção) ou diga que precisa confirmar com a equipe.
- NUNCA responda "não tenho essa informação" pra dados que estão claramente no contexto acima.

HORÁRIOS DISPONÍVEIS DO DENTISTA (use SOMENTE estes — NUNCA invente datas ou horários):
{{available_slots}}

REGRAS DE AGENDAMENTO (CRÍTICAS — viole isso e perdemos pacientes):

1. RESPEITE OS HORÁRIOS LISTADOS ACIMA. Se aparecer "Sábado 12/05 (...)" na lista,
   o dentista ATENDE no sábado — pode oferecer sem hesitar. NUNCA diga
   "não atendemos no sábado" ou "fim de semana não temos vaga" se o sábado
   estiver listado em {{available_slots}}. Apenas domingo é fechado por padrão
   (a menos que esteja listado também).

2. SEMPRE PROPONHA AGENDAMENTO QUANDO O LEAD DEMONSTRAR INTERESSE.
   Sinais de interesse: "quero agendar", "qual horário", "tem vaga", "marca pra mim",
   "posso ir tal dia?", "consigo um horário?", "quanto tempo demora pra atender", e
   variações. Reaja SEMPRE oferecendo 2-3 horários concretos da lista acima.

3. PROIBIDAS estas respostas (perdemos paciente cada vez que falamos isso):
   ❌ "Alguém da equipe vai entrar em contato"
   ❌ "Vou passar pra atendente"
   ❌ "A equipe vai te retornar"
   ❌ "Aguarde nosso retorno"
   ❌ "Vamos analisar e respondemos depois"
   ❌ "Não temos vaga no sábado" (se sábado estiver na lista)
   ✅ Em vez disso, OFERECA 2-3 horários da lista {{available_slots}} e pergunte
      qual prefere.

4. SE A LISTA DE HORÁRIOS ESTIVER VAZIA ou disser "Sem horários disponíveis":
   ✅ Diga: "Olha, nossa agenda dos próximos dias está cheia. Quer que eu te
      coloque na lista de espera pra avisar assim que abrir?" — NUNCA diga
      "alguém entrará em contato".

5. CONFIRMAÇÃO DO HORÁRIO: quando o lead aceitar um horário específico,
   responda confirmando ("Perfeito! Agendei pra você dia X às Y") e use a
   ferramenta scheduling_action pra registrar — sem isso o agendamento NÃO
   fica salvo no sistema.

6. Use {{data_hoje}} para calcular dias da semana corretamente quando o lead
   disser "amanhã", "próxima quinta", etc.

STATUS DA FICHA:
{{ficha_status}}
`;

      // ─── AGENDAMENTO_OVERRIDES (Onda 5e v16, Fase 25) ─────────────────
      // Bloco INVIOLAVEL injetado POR ULTIMO no prompt — depois do skill.system_prompt,
      // pipelines, memoria e references. Razao: skills custom criadas pelo admin
      // podem ter prompts mal escritos que contradizem regras de agendamento (ex:
      // 'amanha nao temos vaga' em vez de propor proximo disponivel). Como LLM
      // pesa mais o que vem por ultimo, esse bloco vence qualquer instrucao de skill.
      //
      // Caso real do user (03/05/2026): skill "convite_avaliacao" do funil
      // Lentes de Porcelana respondeu "amanha nao temos horarios disponiveis para
      // avaliacao. Quer escolher outro dia ou prefere que eu te avise quando abrir vaga?"
      // — em vez de propor o proximo dia disponivel. Esse override impede isso.
      const AGENDAMENTO_OVERRIDES = `
═══════════════════════════════════════════════════════════════
🚨🚨🚨 REGRAS INVIOLÁVEIS DE AGENDAMENTO 🚨🚨🚨
ATENÇÃO: AS REGRAS ABAIXO TÊM PRIORIDADE SOBRE TODA E QUALQUER
INSTRUÇÃO ANTERIOR — INCLUSIVE PROMPTS DE SKILLS CUSTOMIZADAS,
MEMÓRIA, REFERENCIAS OU PIPELINE BLOCKS. SE QUALQUER REGRA ACIMA
CONFLITAR COM ESTA SEÇÃO, VOCÊ DEVE OBEDECER ESTA SEÇÃO.
═══════════════════════════════════════════════════════════════

Você está numa CLÍNICA ODONTOLÓGICA. Cada lead que pede pra agendar e não
recebe horário concreto = paciente PERDIDO. Por isso:

REGRA 1 — SE O LEAD QUER MARCAR, SEMPRE PROPONHA HORÁRIOS CONCRETOS.
  Sinais de querer marcar: "agendar", "marcar", "tem vaga", "qual horário",
  "amanhã", "tal dia", "consigo ir", "próxima semana", etc.
  Reação OBRIGATÓRIA: pegar 1 a 3 horários da lista {{available_slots}} e
  oferecer no formato:
    "Posso encaixar você em uma dessas opções:
     • [Dia DD/MM] às HH:MM
     • [Dia DD/MM] às HH:MM
     • [Dia DD/MM] às HH:MM
     Qual fica melhor?"

REGRA 2 — DIA PEDIDO INDISPONÍVEL ≠ EMPURRAR DECISÃO PRO LEAD.
  Se o lead pediu "amanhã" mas amanhã não está em {{available_slots}}
  (porque é fim de semana sem expediente, dia cheio ou feriado), NUNCA
  responda "amanhã não temos horários, quer escolher outro dia?". Errado.
  Em vez disso, RESPONDA ASSIM:
    "Amanhã nossa agenda já está fechada [opcionalmente: por ser sábado/domingo/
     feriado]. Mas tenho essas opções pertinho:
     • [PRIMEIRO horário disponível em {{available_slots}}]
     • [SEGUNDO horário disponível]
     • [TERCEIRO se houver]
     Alguma dessas serve?"
  Sempre PROPONHA os 3 mais próximos. Nunca pergunte "quer escolher outro dia?"
  sem antes oferecer alternativas.

REGRA 3 — FIM DE SEMANA SE NÃO ESTIVER EM {{available_slots}}.
  Se sábado/domingo NÃO aparecer na lista {{available_slots}}, voce pode
  informar que "atendemos de segunda a sexta" — MAS sempre seguido de
  proposta de horários da próxima janela disponível (regra 2).
  Se sábado APARECER na lista, então o dentista atende sábado — NUNCA diga
  "não atendemos sábado".

REGRA 4 — JAMAIS RESPONDA ESTAS FRASES (perdemos paciente toda vez):
  ❌ "Alguém da equipe vai entrar em contato"
  ❌ "A recepção te liga"
  ❌ "Vou passar pra atendente"
  ❌ "Aguarde nosso retorno"
  ❌ "Quer escolher outro dia?" (sem oferecer opções concretas antes)
  ❌ "Quer que eu te avise quando abrir vaga?" (a menos que a lista esteja
       100% vazia — ai sim, lista de espera vira fallback)

REGRA 5 — LISTA TOTALMENTE VAZIA ("Sem horários disponíveis nos próximos dias").
  Só nesse caso extremo, responda:
    "Olha, nossa agenda dos próximos [N] dias está cheia. Quer que eu te
     coloque na nossa lista de espera pra avisar assim que abrir uma vaga?"

REGRA 6 — CONFIRMAÇÃO DO HORÁRIO ESCOLHIDO.
  Quando o paciente escolher um horário, CONFIRME ("Perfeito! Agendei
  pra você dia X às Y") e use scheduling_action no JSON de retorno —
  sem isso o agendamento NÃO fica salvo.

REGRA 7 — RESPOSTA AO LEMBRETE DE 1 DIA ANTES (Onda 5e v18, Fase B).
  Quando o reminder_context indica awaiting_confirmation=true, significa
  que enviamos lembrete 24h antes pedindo pro paciente confirmar.
  Detecte a resposta NATURALMENTE (não use "responda 1 ou 2"):

  CONFIRMAÇÃO (paciente vai comparecer):
    Sinais: "ok", "sim", "confirmado", "estarei lá", "pode contar comigo",
    "vou sim", "tô confirmado", "beleza", "perfeito", "👍", "✅", "tudo certo",
    "sem problema", "tranquilo", "valeu", "obrigado(a)" (nesse contexto), etc.
    → AÇÃO: responda de forma calorosa ("Perfeito! Te aguardamos amanhã 😊")
       e emita scheduling_action: {"action": "confirm_appointment"}.

  PEDIDO DE REMARCAÇÃO (paciente quer trocar de dia/hora) — DEFAULT:
    Sinais (TODOS estes devem virar REMARCAÇÃO, NÃO cancelamento):
      "não vou poder", "não vou conseguir", "não consigo ir", "não dá",
      "preciso remarcar", "tem outro dia?", "consigo trocar?", "outra data",
      "não consigo nesse horario", "preciso desmarcar pra outro",
      "pode ser depois?", "manda outras opções", "imprevisto", "vai ter
      reunião", "esqueci que tenho compromisso", "estou viajando", etc.
    → AÇÃO ESTRATÉGICA DE VENDA (CRITICA — perdemos paciente se errar):
      1. NÃO aceite passivamente. Cada paciente que cancela e nao remarca
         imediatamente = ~70% chance de NUNCA voltar.
      2. Resposta empática + PROPOSTA ATIVA de remarcacao:
         "Tranquilo, [nome]! Sem problema. Tenho esses outros horarios:
          • [Dia DD/MM] às HH:MM
          • [Dia DD/MM] às HH:MM
          • [Dia DD/MM] às HH:MM
          Algum desses serve melhor?"
      3. Emita scheduling_action: {"action": "reschedule_appointment"}.
      4. Use SEMPRE 2-3 horarios da lista {{available_slots}}.

  CANCELAMENTO DEFINITIVO (apenas casos EXPLÍCITOS — NUNCA por default):
    Sinais EXPLÍCITOS exigidos (precisa de pelo menos UM destes):
      "desisti totalmente", "não tenho mais interesse", "não quero mais",
      "remova de vez", "cancela tudo", "esquece", "perdi o interesse",
      "vou em outro lugar", "achei outro dentista"
    NAO use cancelamento se o paciente apenas disse "não vou" ou
    "não posso" — isso é REMARCAÇÃO, ofereca outras datas.
    → AÇÃO: responda compreensivo + tenta UMA recuperação:
       "Tudo bem, [nome]. Posso te ajudar a encontrar um horario melhor
        em outra semana, ou prefere que eu te avise se abrir alguma
        promoção/horario diferente no futuro?"
       Se confirmar desistencia, emita {"action": "cancel_appointment"}.
       Se topar voltar, ofereça lista de espera ou novos slots.

  AMBIGUIDADE: se a resposta não for clara (ex: "vou ver", "depois te falo"),
  pergunte de forma humanizada ("Quer que eu mantenha o horário ou prefere
  outro dia?") sem chumbar resposta de número.

REGRA 8 — JAMAIS DIZER "CANCELEI" SEM EMITIR scheduling_action.
  Se a resposta da IA contiver "cancelei", "cancelado", "removi", "desmarquei"
  ou similar, OBRIGATORIAMENTE deve vir junto com scheduling_action no JSON.
  Sem isso, o evento permanece na agenda (bug grave) e o paciente fica
  com expectativa errada.
═══════════════════════════════════════════════════════════════
`;


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
        if (tenantIdForBH && leadIdForMem) {
          const [orgProfile, orgMems, profile, recentEpisodes] = await Promise.all([
            // OrganizationProfile consolidado (prosa) — fonte principal
            this.prisma.organizationProfile.findUnique({
              where: { tenant_id: tenantIdForBH },
              select: { summary: true },
            }),
            // Memorias org cruas — fallback se perfil nao existir ainda
            this.prisma.memory.findMany({
              where: {
                tenant_id: tenantIdForBH,
                scope: 'organization',
                scope_id: tenantIdForBH,
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
                tenant_id: tenantIdForBH,
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
        pipelinesBlock = buildPipelinesPromptBlock(pipelines);
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
        const hasResolved = systemPrompt.includes('ESCRITÓRIO FECHADO');
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
        const fallbackSkillPrompt = `Você é Sophia, assistente de pré-atendimento da clínica odontológica.
Seu objetivo PRINCIPAL é AGENDAR uma avaliação inicial do paciente — sem isso a clínica perde a venda.

ROTEIRO (siga na ordem, UMA pergunta por vez):
1. Cumprimente o paciente pelo nome (se já tiver, no contexto) e pergunte o que ele precisa
   resolver (ex: "Oi! Conta pra mim, o que você gostaria de tratar?").
2. Faça 1-2 perguntas de qualificação rápida sobre o problema (ex: "É algo que dói? Tem
   muito tempo?"). NÃO interrogue — duas perguntas no MÁXIMO.
3. Onda 5e v12: ASSIM QUE TIVER NOÇÃO BÁSICA do que o paciente quer, OFEREÇA 2-3 horários
   da lista {{available_slots}}. Exemplo:
     "Posso te encaixar pra uma avaliação. Tenho essas opções:
      • Terça 06/05 às 09:00
      • Quarta 07/05 às 14:00
      • Sábado 10/05 às 10:00
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
   "qual horário", "pode ser tal dia") DEVE virar uma proposta concreta de
   horários da lista acima. Sem desvio.
✅ Se a lista estiver vazia ("Sem horários disponíveis"), oferecer lista de
   espera: "Os próximos dias estão lotados. Quer que eu te coloque na lista
   de espera pra avisar assim que abrir?"

Retorne SOMENTE JSON válido: {"reply":"texto para enviar","updates":{"name":null,"status":"INICIAL","area":null,"lead_summary":"resumo","next_step":"duvidas","notes":"","loss_reason":null,"form_data":null},"scheduling_action":null}

Valores válidos para updates.status: INICIAL | QUALIFICANDO | AGUARDANDO_FORM | REUNIAO_AGENDADA | AGUARDANDO_DOCS | AGUARDANDO_PROC | FINALIZADO | PERDIDO
Valores válidos para updates.next_step: duvidas | triagem_concluida | entrevista | formulario | reuniao | documentos | procuracao | encerrado | perdido
updates.loss_reason: motivo da perda em português (ex: "Sem interesse"). Obrigatório quando next_step="perdido". Null nos demais casos.
form_data: objeto com campos trabalhistas extraídos (só quando area=Trabalhista). Null quando não se aplica.
scheduling_action: {"action":"confirm_slot","date":"YYYY-MM-DD","time":"HH:MM"} quando confirmar agendamento. Null quando não se aplica.`;
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

      // 11. Montar histórico MULTI-TURN (memória natural do modelo)
      // Imagens do cliente são incluídas inline no turn correto (não descoladas no final).
      const supportsVision = this.modelSupportsVision(model);
      const chatTurns: Array<{role: 'user' | 'assistant', content: string | any[]}> = [];
      for (const m of chronological) {
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
        const isOperator = !isClient && !(m as any).external_message_id?.startsWith('sys_');
        const finalContent = isOperator ? `[Operador Humano]: ${content}` : content;
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

      // Instrução final para a IA (não aparece no chat do cliente)
      const instruction = `[INSTRUÇÃO INTERNA — não exiba ao cliente]\nResponda à última mensagem do cliente. Consulte o histórico completo acima e a MEMÓRIA DO LEAD no system prompt: NÃO repita perguntas já respondidas. Avance o roteiro para o próximo ponto que ainda não foi coberto. Atualize o status do funil conforme as regras de PROGRESSÃO DE ETAPAS.`;

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
      let slotsToOffer: any[] | null = null;
      let toolCallLogs: any[] = [];

      if (useToolCalling) {
        // ─── PATH NOVO: Function Calling com Tool Executor ───
        // Auto-detectar provider pelo nome do modelo (evita inconsistência model/provider)
        const isClaudeModel = model.startsWith('claude-');
        const provider: LLMProvider = isClaudeModel ? 'anthropic' : (skill.provider || 'openai');
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
            tenantId: tenantIdForBH || undefined,
          },
        });

        toolCallLogs = toolResult.toolCallLogs;

        // Cacheia ambas as calls de interesse antes de qualquer ramificação
        const respondCall = toolCallLogs.find((l: any) => l.name === 'respond_to_client');
        const updateLeadCall = toolCallLogs.find((l: any) => l.name === 'update_lead');

        if (respondCall) {
          aiText = respondCall.input.reply || '';
          updates = respondCall.input.updates || {};
          scheduling_action = respondCall.input.scheduling_action || null;
          slotsToOffer = respondCall.input.slots_to_offer || null;
        } else if (toolResult.response.content) {
          // Fallback: parse content as JSON (hybrid mode) ou texto puro
          const parsed = this.parseAiResponse(toolResult.response.content);
          aiText = parsed.reply;
          updates = parsed.updates || {};
          scheduling_action = parsed.scheduling_action || null;
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
          conversation_id,
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
          conversation_id,
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
        slotsToOffer = parsed.slots_to_offer || null;
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
        }
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
      // (reminderCtx ja foi declarado linha ~1388 — reutilizamos aqui)
      const isAwaitingConfirmation = reminderCtx?.awaiting_confirmation === true;
      // Pega ultima msg do paciente (direction='in') — vem de chronological
      const lastInbound = chronological?.filter((m: any) => m.direction === 'in')?.slice(-1)?.[0];
      const lastInboundText = (lastInbound?.text || '').toLowerCase();
      const patientSaidNo = isAwaitingConfirmation && /\b(n[ãa]o\s+(?:vou|posso|consigo|d[áa])|imprevisto|preciso\s+remarcar|n[ãa]o\s+ir(?:ei|i)|n[ãa]o\s+conseguirei|n[ãa]o\s+poderei)\b/i.test(lastInboundText);

      // Detecta palavras-chave AMPLIADAS de "encerrar/abandonar agendamento"
      const aiSaysCancel = finalText && /\b(cancelei|cancelado|cancelada|removi|desmarquei|tirei\s+da\s+agenda|fica\s+pra?\s+(?:pr[oó]xima|outro\s+dia)|deixa\s+pra?\s+depois|fica\s+pra\s+depois|anotei\s+(?:aqui|que)|ficou\s+pra\s+(?:pr[oó]xima|depois)|removi\s+da\s+agenda)\b/i.test(finalText);

      // Detecta proposta de horarios novos (formato comum: "DD/MM as HH:MM" ou bullet "• ")
      const aiProposedSlots = finalText && (
        /\b\d{1,2}\/\d{1,2}\b.*\b\d{1,2}[:h]\d{2}\b/i.test(finalText) ||
        finalText.includes('•') ||
        /tenho\s+(?:essas|essa|esse|esses)\s+(?:opç[ãoe]es|hor[áa]rios)/i.test(finalText) ||
        /(?:que\s+tal|posso\s+te?\s+encaixar|consigo\s+te?\s+encaixar)/i.test(finalText)
      );

      const noActionFromAi = !scheduling_action?.action;

      this.logger.log(
        `[AI-SAFEGUARD] convo=${convo.id} awaiting=${isAwaitingConfirmation} patientNo=${patientSaidNo} aiCancel=${aiSaysCancel} aiProposed=${aiProposedSlots} action=${scheduling_action?.action || 'null'}`
      );

      // GATILHO 1: IA usou palavra de cancelamento sem emitir action
      // GATILHO 2: lead negou + IA nao emitiu action nem propos horarios novos
      const shouldForceCancel = noActionFromAi && (aiSaysCancel || patientSaidNo);

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
              start_at: { gte: new Date() },
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
          if (!aiProposedSlots && cancelled.length > 0) {
            const slotsAppend = await this.buildRescheduleSuggestion(convo);
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
      if (scheduling_action?.action === 'confirm_slot' && scheduling_action.date && scheduling_action.time) {
        try {
          const dentistId = await ensureOrcamentistaAssigned(this.prisma as any, convo.id);

          if (!dentistId) {
            this.logger.warn(
              `[AI] confirm_slot ${scheduling_action.date} ${scheduling_action.time} — NENHUM Orçamentista cadastrado no tenant. CalendarEvent NÃO criado. Lead ${convo.lead.id} ficará em "avaliacao-aceita" sem evento — operador precisa atribuir um Orçamentista (Settings → Usuários) e agendar manualmente.`,
            );
          } else {
            const [h, m] = scheduling_action.time.split(':').map(Number);
            const startAt = new Date(scheduling_action.date + 'T00:00:00');
            startAt.setHours(h, m, 0, 0);
            const endAt = new Date(startAt.getTime() + 60 * 60 * 1000);

            await this.createCalendarEvent({
              type: 'CONSULTA',
              title: `Avaliação — ${convo.lead.name || 'Lead'}`,
              description: `Avaliação agendada automaticamente pela IA — Orçamentista`,
              start_at: startAt,
              end_at: endAt,
              assigned_user_id: dentistId,
              lead_id: convo.lead.id,
              conversation_id: convo.id,
              created_by_id: dentistId,
            });
            this.logger.log(
              `[AI] Avaliação agendada: ${scheduling_action.date} ${scheduling_action.time} — Orçamentista ${dentistId}`,
            );
          }
        } catch (e: any) {
          this.logger.warn(`[AI] Falha ao agendar avaliação: ${e.message}`);
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
              start_at: { gte: new Date() }, // so eventos futuros (passados nao cancela)
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
                start_at: { gte: new Date() },
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
              start_at: { gte: new Date() },
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

      // Assinatura "Sophia:" em negrito no WhatsApp (salva sem assinatura no DB)
      const textToSend = `*Sophia:* ${finalText}`;

      // Exibe "digitando..." por 5s via endpoint dedicado da Evolution API.
      // Fire-and-forget (sem await): dispara o indicador e imediatamente começa
      // a contar os 5s em paralelo — evita dupla espera (API delay + setTimeout).
      const TYPING_DELAY_MS = 2000;
      // Formato flat (sem wrapper "options") — conforme comportamento real da API
      axios
        .post(
          `${apiUrl}/chat/sendPresence/${instanceName}`,
          {
            number: convo.lead.phone,
            delay: TYPING_DELAY_MS,
            presence: 'composing',
          },
          { headers: { 'Content-Type': 'application/json', apikey: apiKey }, timeout: 10000 },
        )
        .catch((e) =>
          this.logger.warn(`[AI] sendPresence falhou (não-fatal): ${e.message}`),
        );
      await new Promise((resolve) => setTimeout(resolve, TYPING_DELAY_MS));

      // Captura o ID real da mensagem retornado pela Evolution API
      // para que o webhook echo seja corretamente deduplicado e não gere registro duplicado.
      let evolutionMsgId = `sys_ai_${Date.now()}`;
      // Pré-calcular se vai enviar áudio (para pular texto nesse caso)
      // Buscar a última mensagem inbound (mais recente = primeiro do array desc)
      const _lastIn = convo.messages.find((m: any) => m.direction === 'in');
      const _tts = await this.settings.getTtsConfig();
      const _willAudio = _tts.enabled && _tts.googleApiKey && !_tts.googleApiKey.startsWith('enc:') && _lastIn?.type === 'audio';

      this.logger.debug(`[TTS-CHECK] enabled=${_tts.enabled} keyLen=${_tts.googleApiKey?.length || 0} keyEnc=${_tts.googleApiKey?.startsWith('enc:')} lastInType=${_lastIn?.type} willAudio=${_willAudio}`);

      if (_willAudio) {
        this.logger.log('[AI] Lead enviou áudio — resposta será apenas por voz (sem texto)');
      }

      // sendFailed/sendErrorDetail ficam fora do try/catch para o passo 17
      // saber se houve falha e marcar a Message com status correto. Antes
      // este bloco silenciava o erro e gravava como 'enviado' mesmo quando
      // o WhatsApp nunca recebia.
      let sendFailed = false;
      let sendErrorDetail: string | null = null;
      try {
        let sendResult: any;
        const evoHeaders = { 'Content-Type': 'application/json', apikey: apiKey };

        // Se vai enviar áudio, pula o texto
        if (_willAudio) {
          // Não envia texto — será enviado apenas áudio no passo 18 (TTS)
        } else {
          // sendList (listas interativas) não funciona via Baileys —
          // WhatsApp deprecou para conexões não-oficiais (só Cloud API).
          // Slots de agendamento já vêm formatados no finalText pela IA.
          sendResult = await axios.post(
            `${apiUrl}/message/sendText/${instanceName}`,
            { number: convo.lead.phone, text: textToSend },
            { headers: evoHeaders, timeout: 30000 },
          );
        }
        if (sendResult) evolutionMsgId = sendResult.data?.key?.id || evolutionMsgId;
      } catch (sendErr: any) {
        sendFailed = true;
        const status = sendErr.response?.status || sendErr.code || sendErr.message;
        sendErrorDetail = `${status}: ${JSON.stringify(sendErr.response?.data || {}).slice(0, 160)}`;
        this.logger.error(`[AI] Falha ao enviar via Evolution (${status}): ${sendErrorDetail}`);
      }

      // 17. Salvar mensagem no banco com skill_id (texto limpo, sem assinatura)
      // Usa o ID real da Evolution para que o echo do webhook seja deduplicado.
      // Race condition: o echo da Evolution pode chegar antes do worker salvar,
      // criando a mensagem sem skill_id. Nesse caso, capturamos P2002 e atualizamos.
      //
      // status reflete o RESULTADO REAL do envio:
      //   - 'enviado': axios.post retornou 2xx (ou era resposta áudio-only)
      //   - 'falhou':  axios.post lançou exceção (DNS, 4xx, 5xx, timeout, etc)
      let savedMsg: any;
      try {
        savedMsg = await this.prisma.message.create({
          data: {
            conversation_id: convo.id,
            direction: 'out',
            type: 'text',
            text: finalText,
            external_message_id: evolutionMsgId,
            status: sendFailed ? 'falhou' : 'enviado',
            skill_id: skill?.id || null,
          },
        });
      } catch (createErr: any) {
        if (createErr.code === 'P2002' && evolutionMsgId && !evolutionMsgId.startsWith('sys_ai_')) {
          // Echo criou a mensagem primeiro — encontra e atualiza o skill_id
          this.logger.warn(`[AI] P2002 em message.create — echo chegou antes do save. Atualizando skill_id em ${evolutionMsgId}`);
          const existing = await this.prisma.message.findUnique({ where: { external_message_id: evolutionMsgId } });
          if (existing) {
            savedMsg = await this.prisma.message.update({
              where: { id: existing.id },
              data: { skill_id: skill?.id || null },
            });
          } else {
            throw createErr;
          }
        } else {
          throw createErr;
        }
      }

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

      // 20. Retorna IDs para o AiEventsService da API emitir WebSocket em tempo real
      return { conversationId: convo.id, messageId: savedMsg.id };
    } catch (e: any) {
      this.logger.error(`Erro no processamento da IA: ${e.message}`);
      throw e;
    }
  }
}

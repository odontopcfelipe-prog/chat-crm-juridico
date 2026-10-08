import { Injectable, OnModuleDestroy, Logger, BadRequestException, ServiceUnavailableException } from '@nestjs/common';
import { Queue, QueueEvents } from 'bullmq';

export interface AiTestChatInput {
  tenantId: string;
  purpose?: 'COMERCIAL' | 'CLINICA' | 'FINANCEIRO' | null;
  isClient?: boolean;
  leadName?: string | null;
  /** Modelo só pro teste (comparar). Vazio = o da skill. */
  model?: string | null;
  history: { from: 'patient' | 'ai'; text: string }[];
}

/**
 * Chat de teste da Sophia (Ajustes › IA). Enfileira um job `dryRun` na MESMA fila
 * do worker (ai-jobs) — o worker roda o mesmo cérebro (skills, guia, horários
 * reais) numa conversa em memória e devolve a resposta sem enviar WhatsApp nem
 * gravar nada. Conexões Redis próprias e preguiçosas (só abrem no 1º teste).
 */
@Injectable()
export class AiTestChatService implements OnModuleDestroy {
  private readonly logger = new Logger(AiTestChatService.name);
  private queue: Queue | null = null;
  private events: QueueEvents | null = null;

  private ensure() {
    if (this.queue && this.events) return { queue: this.queue, events: this.events };
    const connection = {
      host: process.env.REDIS_HOST || 'localhost',
      port: parseInt(process.env.REDIS_PORT || '6379'),
      password: process.env.REDIS_PASSWORD || undefined,
      maxRetriesPerRequest: null as any,
      enableReadyCheck: false,
    };
    const prefix = process.env.BULL_PREFIX || 'bull';
    this.queue = new Queue('ai-jobs', { connection, prefix });
    this.events = new QueueEvents('ai-jobs', { connection, prefix });
    return { queue: this.queue, events: this.events };
  }

  async run(input: AiTestChatInput) {
    const history = (input.history || [])
      .filter((m) => m && (m.from === 'patient' || m.from === 'ai') && String(m.text || '').trim())
      .slice(-40);
    if (!history.length || history[history.length - 1].from !== 'patient') {
      throw new BadRequestException('A última mensagem do teste precisa ser do paciente.');
    }
    const { queue, events } = this.ensure();
    const job = await queue.add(
      'ai-test',
      {
        dryRun: true,
        conversation_id: '__ai_test__',
        tenantId: input.tenantId,
        purpose: input.purpose || null,
        isClient: !!input.isClient,
        leadName: input.leadName || null,
        model: input.model || null,
        history,
      },
      { removeOnComplete: true, removeOnFail: true, attempts: 1 },
    );
    try {
      const result: any = await job.waitUntilFinished(events, 90_000);
      if (!result?.dryRun) {
        throw new ServiceUnavailableException(
          'A IA não respondeu. Confira se a chave da OpenAI/Anthropic está configurada e se há skill ativa no chip escolhido.',
        );
      }
      return result;
    } catch (e: any) {
      if (e?.status) throw e;
      this.logger.warn(`[AI-TEST] Falhou: ${e?.message}`);
      throw new ServiceUnavailableException(`Teste da IA falhou: ${e?.message || 'tempo esgotado'}`);
    }
  }

  async onModuleDestroy() {
    await this.events?.close();
    await this.queue?.close();
  }
}

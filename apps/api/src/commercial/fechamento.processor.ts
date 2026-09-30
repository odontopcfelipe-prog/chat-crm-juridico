import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { QuotesService } from './quotes.service';

/**
 * Processa a 2ª etapa da SEQUÊNCIA DO FECHAMENTO, agendada com 3 min de atraso pela
 * QuotesService.applyFinancing:
 *   fechamento → (agora) apresentação → (3 min) NEGOCIAÇÃO + BOLETO DA ENTRADA → (D+1) parcelas.
 *
 * Roda no container da API (mesmo padrão do CalendarReminderWorker). Best-effort: o
 * runFechamentoDeferido nunca lança (cada disparo é try/catch próprio).
 */
@Processor('fechamento-jobs')
export class FechamentoProcessor extends WorkerHost {
  private readonly logger = new Logger(FechamentoProcessor.name);

  constructor(private readonly quotes: QuotesService) {
    super();
    this.logger.log('✅ FechamentoProcessor registrado na fila fechamento-jobs (API container)');
  }

  async process(job: Job<any>): Promise<void> {
    if (job.name !== 'deferido') {
      this.logger.warn(`[FECHAMENTO] job desconhecido "${job.name}" (id ${job.id}) — ignorando`);
      return;
    }
    const { tenantId, planId, terms } = job.data || {};
    if (!tenantId || !planId) {
      this.logger.warn(`[FECHAMENTO] job ${job.id} sem tenantId/planId — ignorando`);
      return;
    }
    this.logger.log(`[FECHAMENTO] Rodando negociação + entrada (plano ${planId}) 3 min após a apresentação.`);
    await this.quotes.runFechamentoDeferido({ tenantId, planId, terms });
  }
}

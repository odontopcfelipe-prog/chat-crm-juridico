/**
 * IA do laboratório na API: exigir a conta em ACTIVE (a chave da OpenAI é compartilhada)
 * e registrar o gasto em AiUsage com a conta certa. Funções puras com o Prisma por
 * parâmetro (sem provider Nest — ver CLAUDE.md: ciclo de DI). Só para conta de laboratório.
 */
import { ForbiddenException, Logger } from '@nestjs/common';
import { contaDoLabLiberaIa } from '@crm/shared';
import { LimitePorConta } from '../common/limite-por-conta';
import { LAB_IA_API } from './lab-ia-api-textos';

const logger = new Logger('LabIaConta');

const UMA_HORA_MS = 3_600_000;

/** Limites de uso da chave compartilhada, por conta de laboratório. */
export const LIMITE_TESTE_DA_IA = new LimitePorConta(30, UMA_HORA_MS, LAB_IA_API.limiteTeste);
export const LIMITE_CORRECAO = new LimitePorConta(120, UMA_HORA_MS, LAB_IA_API.limiteCorrecao);
export const LIMITE_TRANSCRICAO = new LimitePorConta(120, UMA_HORA_MS, LAB_IA_API.limiteTranscricao);

/** Correção de texto no laboratório: tamanho do texto e da resposta. */
export const TEXTO_MAXIMO_DA_CORRECAO = 4000;
export const MAX_TOKENS_DA_CORRECAO = 2000;

/** Dólares por 1 milhão de tokens. */
const PRECO: Record<string, { entrada: number; saida: number }> = {
  'gpt-4.1-mini': { entrada: 0.4, saida: 1.6 },
  'gpt-4o-transcribe': { entrada: 2.5, saida: 10 },
};

/** 403 de quem pede a IA numa conta de laboratório fora de ACTIVE. */
export function semAssinaturaParaIa(): ForbiddenException {
  return new ForbiddenException({ message: LAB_IA_API.semAssinatura, code: LAB_IA_API.codigoSemAssinatura });
}

export async function exigirContaComIa(prisma: any, tenantId: unknown): Promise<void> {
  if (!(await contaDoLabLiberaIa(prisma, tenantId))) throw semAssinaturaParaIa();
}

/** Grava o gasto na conta do laboratório. Falha só avisa: o gasto não derruba a tela. */
export async function registrarUsoDoLaboratorio(
  prisma: any,
  dados: {
    tenantId: string;
    conversationId?: string | null;
    model: string;
    callType: 'chat' | 'whisper';
    usage?: { prompt_tokens?: number; completion_tokens?: number; input_tokens?: number; output_tokens?: number } | null;
  },
): Promise<void> {
  if (!dados.usage) return;
  const entrada = Number(dados.usage.prompt_tokens ?? dados.usage.input_tokens ?? 0);
  const saida = Number(dados.usage.completion_tokens ?? dados.usage.output_tokens ?? 0);
  const preco = PRECO[dados.model] ?? PRECO['gpt-4.1-mini'];
  try {
    await prisma.aiUsage.create({
      data: {
        tenant_id: dados.tenantId,
        conversation_id: dados.conversationId ?? null,
        model: dados.model,
        call_type: dados.callType,
        prompt_tokens: entrada,
        completion_tokens: saida,
        total_tokens: entrada + saida,
        cost_usd: (entrada * preco.entrada + saida * preco.saida) / 1_000_000,
      },
    });
  } catch (e: any) {
    logger.warn(`[lab-ia] não gravou o gasto da conta ${dados.tenantId}: ${e?.message}`);
  }
}

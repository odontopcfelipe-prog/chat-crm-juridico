import type { ToolHandler, ToolContext } from '../tool-executor';

/**
 * Escala a conversa para atendimento humano.
 * Desativa o modo IA e opcionalmente registra o motivo.
 */
export class EscalateToHumanHandler implements ToolHandler {
  name = 'escalate_to_human';

  async execute(params: { reason?: string }, context: ToolContext): Promise<any> {
    await context.prisma.conversation.update({
      where: { id: context.conversationId },
      data: { ai_mode: false },
    });

    return {
      success: true,
      message: 'Conversa escalada para atendimento humano',
      reason: params.reason || 'solicitação do agente',
    };
  }
}

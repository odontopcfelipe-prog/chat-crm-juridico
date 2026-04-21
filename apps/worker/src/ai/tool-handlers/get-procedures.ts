import type { ToolHandler, ToolContext } from '../tool-executor';

/**
 * Lista os procedimentos do catálogo da clínica (tenant-scoped).
 *
 * Permite à IA responder perguntas como:
 *  - "Quais procedimentos vocês fazem?"
 *  - "Quanto custa uma restauração?"
 *  - "Vocês fazem implante?"
 *
 * Aceita filtros opcionais:
 *  - search: filtra por nome (case-insensitive)
 *  - specialty: filtra por nome da especialidade
 *  - max_results: limite de itens (default 20, max 50)
 */
export class GetProceduresHandler implements ToolHandler {
  name = 'get_procedures';

  async execute(
    params: { search?: string; specialty?: string; max_results?: number },
    context: ToolContext,
  ): Promise<any> {
    const prisma = context.prisma;
    const maxResults = Math.min(50, Math.max(1, params.max_results ?? 20));

    const convo = await prisma.conversation.findUnique({
      where: { id: context.conversationId },
      select: { tenant_id: true },
    });
    if (!convo?.tenant_id) {
      return { success: false, error: 'Conversa sem tenant_id associado' };
    }

    const where: any = {
      tenant_id: convo.tenant_id,
      active: true,
    };

    if (params.search) {
      where.name = { contains: params.search, mode: 'insensitive' };
    }

    if (params.specialty) {
      where.specialty = {
        name: { contains: params.specialty, mode: 'insensitive' },
        active: true,
      };
    }

    const procedures = await prisma.procedure.findMany({
      where,
      orderBy: [{ specialty_id: 'asc' }, { name: 'asc' }],
      take: maxResults,
      select: {
        name: true,
        base_price: true,
        duration_minutes: true,
        requires_x_ray: true,
        requires_anesthesia: true,
        description: true,
        specialty: { select: { name: true } },
      },
    });

    if (procedures.length === 0) {
      return {
        success: true,
        count: 0,
        message: 'Nenhum procedimento encontrado com esses filtros.',
        procedures: [],
      };
    }

    return {
      success: true,
      count: procedures.length,
      procedures: procedures.map((p: typeof procedures[number]) => ({
        nome: p.name,
        especialidade: p.specialty?.name || 'Geral',
        preco_base: Number(p.base_price),
        duracao_minutos: p.duration_minutes,
        requer_raio_x: p.requires_x_ray,
        requer_anestesia: p.requires_anesthesia,
        descricao: p.description || undefined,
      })),
    };
  }
}

import type { ToolHandler, ToolContext } from '../tool-executor';

/**
 * Lista procedimentos esteticos faciais do catalogo (tenant-scoped).
 *
 * Permite a IA responder perguntas como:
 *  - "Quanto custa harmonizacao facial?"
 *  - "Voces fazem botox?"
 *  - "Quais preenchimentos labiais voces oferecem?"
 *
 * Filtros:
 *  - category: codigo da categoria (HOF, TOXINA_BOTULINICA, PREENCHIMENTO_AH,
 *    BIOESTIMULADOR, FIOS_PDO, FIOS_PLLA, PEELING_QUIMICO, MICROAGULHAMENTO,
 *    SKINBOOSTER, LASER, RADIOFREQUENCIA, ULTRASSOM_MICROFOCADO,
 *    LIPO_ENZIMATICA, LIMPEZA_PELE)
 *  - search: filtra por nome (case-insensitive)
 *  - max_results: default 20, max 50
 *
 * Por padrao retorna apenas procedimentos com is_facial_application=true,
 * evitando misturar procedimentos odontologicos na resposta.
 */
export class GetEstheticProceduresHandler implements ToolHandler {
  name = 'get_esthetic_procedures';

  async execute(
    params: { category?: string; search?: string; max_results?: number },
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
      is_facial_application: true,
    };

    if (params.category) {
      where.category = params.category.toUpperCase();
    }

    if (params.search) {
      where.name = { contains: params.search, mode: 'insensitive' };
    }

    const procedures = await prisma.procedure.findMany({
      where,
      orderBy: [{ category: 'asc' }, { name: 'asc' }],
      take: maxResults,
      select: {
        name: true,
        category: true,
        base_price: true,
        duration_minutes: true,
        default_revisit_months: true,
        description: true,
        post_procedure_instructions: true,
        specialty: { select: { name: true } },
      },
    });

    if (procedures.length === 0) {
      return {
        success: true,
        count: 0,
        message: 'Nenhum procedimento estetico facial encontrado com esses filtros.',
        procedures: [],
      };
    }

    return {
      success: true,
      count: procedures.length,
      procedures: procedures.map((p: typeof procedures[number]) => ({
        nome: p.name,
        categoria: p.category || 'OUTRO',
        especialidade: p.specialty?.name || 'Estetica',
        preco_base: Number(p.base_price),
        duracao_minutos: p.duration_minutes,
        validade_efeito_meses: p.default_revisit_months || undefined,
        descricao: p.description || undefined,
        orientacoes_pos_procedimento: p.post_procedure_instructions || undefined,
      })),
    };
  }
}

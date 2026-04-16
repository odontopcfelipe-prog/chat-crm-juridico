import type { ToolHandler, ToolContext } from '../tool-executor';

/**
 * Salva campo(s) da ficha trabalhista (ou outra ficha futura).
 * Usa o mesmo endpoint interno que o frontend usa.
 */
export class SaveFormFieldHandler implements ToolHandler {
  name = 'save_form_field';

  async execute(
    params: { fields: Record<string, string> },
    context: ToolContext,
  ): Promise<any> {
    const fields = params.fields || {};
    if (!Object.keys(fields).length) {
      return { success: false, message: 'Nenhum campo fornecido' };
    }

    // Find or create ficha
    const existing = await context.prisma.fichaTrabalhista.upsert({
      where: { lead_id: context.leadId },
      update: {},
      create: { lead_id: context.leadId, data: {} },
    });

    const oldData = (existing.data as Record<string, any>) || {};
    const merged = { ...oldData, ...fields };

    // Calculate completion
    const TOTAL_FIELDS = 75;
    const filled = Object.values(merged).filter(
      (v) => v !== null && v !== undefined && v !== '',
    ).length;
    const pct = Math.min(100, Math.round((filled / TOTAL_FIELDS) * 100));

    await context.prisma.fichaTrabalhista.update({
      where: { lead_id: context.leadId },
      data: {
        data: merged,
        completion_pct: pct,
        filled_by: 'ai',
        ...(fields.nome_completo ? { nome_completo: fields.nome_completo } : {}),
        ...(fields.nome_empregador ? { nome_empregador: fields.nome_empregador } : {}),
      },
    });

    return {
      success: true,
      fields_saved: Object.keys(fields),
      completion_pct: pct,
    };
  }
}

import type { ToolHandler, ToolContext } from '../tool-executor';

/**
 * Salva campo(s) da ficha trabalhista (ou outra ficha futura).
 * Usa o mesmo endpoint interno que o frontend usa.
 */
export class SaveFormFieldHandler implements ToolHandler {
  name = 'save_form_field';

  async execute(
    _params: { fields: Record<string, string> },
    _context: ToolContext,
  ): Promise<any> {
    // Ficha trabalhista descontinuada na transição odonto — handler neutralizado.
    return {
      ok: true,
      success: true,
      note: 'Ficha trabalhista descontinuada na transição odonto — campo ignorado.',
    };
  }
}

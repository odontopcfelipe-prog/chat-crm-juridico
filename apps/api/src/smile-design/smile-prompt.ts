/**
 * Prompt do Smile Design — o que a IA de imagem deve fazer com a foto.
 *
 * Regra de ouro: mexe SÓ nos dentes (e na gengiva colada neles). Rosto,
 * lábios, pele, enquadramento e luz ficam idênticos — é uma simulação de
 * tratamento, não um "filtro de beleza". O texto vai em inglês porque é a
 * língua em que os modelos de imagem seguem instrução com mais precisão;
 * o pedido livre do dentista entra em português mesmo.
 */

export const SMILE_TREATMENTS = ['COMPLETO', 'CLAREAMENTO', 'ALINHAMENTO', 'REABILITACAO'] as const;
export type SmileTreatment = (typeof SMILE_TREATMENTS)[number];

export const SMILE_SHADES = ['NATURAL', 'BRANCO', 'EXTRA'] as const;
export type SmileShade = (typeof SMILE_SHADES)[number];

export interface SmilePromptOptions {
  treatment: SmileTreatment;
  shade: SmileShade;
  /** Pedido livre do dentista (português). */
  extra?: string | null;
  /** true quando a boca foi marcada na foto (vai máscara junto). */
  hasMask: boolean;
}

const TREATMENT_TEXT: Record<SmileTreatment, string> = {
  COMPLETO:
    'Design an ideal smile as if the patient received porcelain veneers: harmonious tooth proportions ' +
    '(central incisors about 75-80% width-to-height), symmetric left and right sides, teeth aligned on a ' +
    'smooth arch, no gaps, incisal edges following the curve of the lower lip, healthy and even gum line.',
  CLAREAMENTO:
    'Only whiten the existing teeth (professional tooth whitening). Do NOT change the shape, size, position, ' +
    'rotation or alignment of any tooth — the same teeth, just whiter and with stains removed.',
  ALINHAMENTO:
    'Straighten the existing teeth as after orthodontic treatment (clear aligners/braces): correct crowding ' +
    'and rotations, close gaps, level the incisal edges on a smooth arch. Keep each tooth\'s own natural shape.',
  REABILITACAO:
    'Restore the smile: replace missing teeth, rebuild broken, worn, chipped or decayed teeth with ' +
    'natural-looking restorations (implants/crowns), close the spaces, keep a balanced and natural arch.',
};

const SHADE_TEXT: Record<SmileShade, string> = {
  NATURAL:
    'Tooth color: natural bright white (shade A1) with subtle natural translucency at the edges — healthy, not artificial.',
  BRANCO:
    'Tooth color: clean bright white (shade BL2), clearly whiter than natural but still realistic with enamel texture.',
  EXTRA:
    'Tooth color: very white (shade BL1, "celebrity" white), but keep realistic enamel texture, translucency and light reflections — never flat or chalky.',
};

export function isSmileTreatment(v: unknown): v is SmileTreatment {
  return typeof v === 'string' && (SMILE_TREATMENTS as readonly string[]).includes(v);
}

export function isSmileShade(v: unknown): v is SmileShade {
  return typeof v === 'string' && (SMILE_SHADES as readonly string[]).includes(v);
}

export function buildSmilePrompt(opts: SmilePromptOptions): string {
  const parts: string[] = [
    'This is a real clinical photo of a dental patient. Create a cosmetic dentistry "smile design" simulation.',
    opts.hasMask
      ? 'Edit ONLY the teeth inside the masked mouth area (and the gum line right around them, if needed).'
      : 'Edit ONLY the teeth (and the gum line right around them, if needed).',
    'Everything else must stay exactly identical to the original photo: the same person and facial identity, ' +
      'same lips (shape, color, position and how open they are), same skin, facial hair, eyes, nose, hair, ' +
      'expression, head pose, camera angle, framing, lighting, colors and background.',
    'Do not beautify, retouch, smooth the skin or reshape the face. Do not open or close the mouth more.',
    TREATMENT_TEXT[opts.treatment],
    SHADE_TEXT[opts.shade],
    'The new teeth must look photorealistic: real enamel texture, subtle individual variation between teeth, ' +
      'natural translucency at the incisal edges, reflections that match the scene lighting, correct perspective ' +
      'and depth inside the mouth. Avoid fake, oversized, uniformly opaque or denture-like teeth.',
  ];
  const extra = (opts.extra || '').trim();
  if (extra) {
    parts.push(`Additional request from the dentist (in Portuguese): "${extra.slice(0, 500)}"`);
  }
  return parts.join(' ');
}

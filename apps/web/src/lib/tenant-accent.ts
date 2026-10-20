/**
 * Out/2026 — Cor de destaque da clínica (multi-tenant) pras telas de paleta neutra
 * (boas-vindas da Minha agenda, painel do dentista): a ÚNICA cor delas é a da
 * clínica (Tenant.theme_color).
 *
 * Sem cor cadastrada (ou inválida) = cinza neutro; cor clara demais (amarelo, bege…)
 * é escurecida pra continuar legível no fundo claro.
 */
export const NEUTRAL_ACCENT = '#6B7280';

export function tenantAccent(hex: string | null | undefined): string {
  const m = /^#?([0-9a-f]{6})$/i.exec((hex || '').trim());
  if (!m) return NEUTRAL_ACCENT;
  const n = parseInt(m[1], 16);
  let [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  const lum = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  if (lum > 0.62) [r, g, b] = [r, g, b].map((c) => Math.round(c * 0.62));
  return `#${[r, g, b].map((c) => c.toString(16).padStart(2, '0')).join('')}`;
}

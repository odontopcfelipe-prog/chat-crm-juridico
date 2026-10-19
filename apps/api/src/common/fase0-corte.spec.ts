/**
 * Fase 0 — data de corte das regras novas de execução (19/10/2026 00:00 em Maceió).
 */
import { CONCILIACAO_DESDE, criadoAposCorte } from './fase0-corte';

describe('fase0-corte (criadoAposCorte)', () => {
  it('o corte é 19/10/2026 00:00 em Maceió (03:00 UTC)', () => {
    expect(CONCILIACAO_DESDE.toISOString()).toBe('2026-10-19T03:00:00.000Z');
  });

  it('18/10 23:59 em Maceió é antes do corte', () => {
    expect(criadoAposCorte(new Date('2026-10-19T02:59:00.000Z'))).toBe(false);
    expect(criadoAposCorte('2026-10-18T23:59:59.999-03:00')).toBe(false);
  });

  it('19/10 00:00 em Maceió já vale', () => {
    expect(criadoAposCorte(new Date('2026-10-19T03:00:00.000Z'))).toBe(true);
    expect(criadoAposCorte('2026-10-19T00:00:00.000-03:00')).toBe(true);
    expect(criadoAposCorte('2026-11-02T15:30:00.000Z')).toBe(true);
  });

  it('sem data conta como antigo', () => {
    expect(criadoAposCorte(null)).toBe(false);
    expect(criadoAposCorte(undefined)).toBe(false);
    expect(criadoAposCorte('')).toBe(false);
  });

  it('data inválida conta como antigo', () => {
    expect(criadoAposCorte('não é data')).toBe(false);
  });
});

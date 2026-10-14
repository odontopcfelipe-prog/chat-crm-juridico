import { buildAlertIndex, LEGACY_DEDUP_DAYS } from './regua-dedup';

const NOW = Date.parse('2026-10-14T12:00:00Z');
const diasAtras = (d: number) => new Date(NOW - d * 86_400_000);

describe('trava de repetição da régua (por boleto)', () => {
  it('caso Jose: aviso da 1ª parcela NÃO trava a 2ª parcela no mesmo marco', () => {
    const idx = buildAlertIndex(
      [{ entity_id: 'jose', action: 'boleto_1d_antes', created_at: diasAtras(36), meta_json: { charge_ids: ['parcela1'] } }],
      NOW,
    );
    expect(idx.jaAvisado('parcela1', 'jose', 'boleto_1d_antes')).toBe(true);
    expect(idx.jaAvisado('parcela2', 'jose', 'boleto_1d_antes')).toBe(false);
  });

  it('o mesmo boleto não recebe o mesmo marco 2× (cron roda a cada minuto)', () => {
    const idx = buildAlertIndex(
      [{ entity_id: 'p', action: 'boleto_no_dia', created_at: new Date(NOW - 60_000), meta_json: { charge_ids: ['a', 'b'] } }],
      NOW,
    );
    expect(idx.jaAvisado('a', 'p', 'boleto_no_dia')).toBe(true);
    expect(idx.jaAvisado('b', 'p', 'boleto_no_dia')).toBe(true); // aviso agrupado grava os 2
    expect(idx.jaAvisado('a', 'p', 'boleto_atraso_1d')).toBe(false); // outro marco segue
  });

  it('registro antigo (sem charge_ids) trava paciente+marco só por alguns dias', () => {
    const rows = [{ entity_id: 'p', action: 'boleto_no_dia', created_at: diasAtras(1), meta_json: { tenant_id: 't' } }];
    expect(buildAlertIndex(rows, NOW).jaAvisado('qualquer', 'p', 'boleto_no_dia')).toBe(true);
    const velho = [{ ...rows[0], created_at: diasAtras(LEGACY_DEDUP_DAYS + 1) }];
    expect(buildAlertIndex(velho, NOW).jaAvisado('qualquer', 'p', 'boleto_no_dia')).toBe(false);
  });

  it('meta_json nulo ou malformado não quebra (vira registro antigo)', () => {
    const idx = buildAlertIndex(
      [
        { entity_id: 'p', action: 'boleto_atraso_3d', created_at: diasAtras(2), meta_json: null },
        { entity_id: 'q', action: 'boleto_atraso_3d', created_at: diasAtras(2), meta_json: { charge_ids: 'x' } },
      ],
      NOW,
    );
    expect(idx.jaAvisado('c', 'p', 'boleto_atraso_3d')).toBe(true);
    expect(idx.jaAvisado('c', 'q', 'boleto_atraso_3d')).toBe(true);
    expect(idx.jaAvisado('c', 'r', 'boleto_atraso_3d')).toBe(false);
  });
});

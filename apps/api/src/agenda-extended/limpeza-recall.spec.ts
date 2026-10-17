import {
  isLimpezaProcedure,
  isLimpezaText,
  latestLimpezaPerPatient,
  pickLimpezaHome,
  type LimpezaProc,
} from './limpeza-recall';

describe('limpeza-recall', () => {
  it('reconhece limpeza dental e deixa a estética de fora', () => {
    expect(isLimpezaText('Limpeza')).toBe(true);
    expect(isLimpezaText('Profilaxia (limpeza + raspagem)')).toBe(true);
    expect(isLimpezaText('PROFILAXIA')).toBe(true);
    expect(isLimpezaText('Consulta - limpeza e avaliação')).toBe(true);
    expect(isLimpezaText('Limpeza de pele')).toBe(false);
    expect(isLimpezaText('Limpeza pele profunda')).toBe(false);
    expect(isLimpezaText('Limpeza facial')).toBe(false);
    expect(isLimpezaText('Clareamento de Consultorio')).toBe(false);
    expect(isLimpezaText(null)).toBe(false);
  });

  it('procedimento de limpeza = categoria PROFILAXIA ou nome', () => {
    expect(isLimpezaProcedure({ name: 'Raspagem supragengival', category: 'PROFILAXIA' })).toBe(true);
    expect(isLimpezaProcedure({ name: 'Limpeza', category: null })).toBe(true);
    expect(isLimpezaProcedure({ name: 'Limpeza', category: 'LIMPEZA_PELE' })).toBe(false);
    expect(isLimpezaProcedure({ name: 'Faceta de Resina (PREMIUM)', category: 'ESTETICA_DENTAL' })).toBe(false);
  });

  const proc = (over: Partial<LimpezaProc>): LimpezaProc => ({
    id: over.name || 'x',
    name: 'Limpeza',
    category: null,
    active: true,
    default_revisit_months: 6,
    ...over,
  });

  it('aba da limpeza = a ligada e ativa; prefere PROFILAXIA', () => {
    expect(pickLimpezaHome([proc({ name: 'Limpeza', default_revisit_months: null })])).toBeNull();
    expect(pickLimpezaHome([proc({ name: 'Limpeza', active: false })])).toBeNull();
    const home = pickLimpezaHome([
      proc({ name: 'Limpeza' }),
      proc({ name: 'Profilaxia (limpeza + raspagem)', category: 'PROFILAXIA' }),
      proc({ name: 'Limpeza antiga', active: false }),
    ]);
    expect(home?.name).toBe('Profilaxia (limpeza + raspagem)');
  });

  it('1 por paciente, a mais recente de qualquer fonte, + N meses', () => {
    const out = latestLimpezaPerPatient(
      [
        { patient_id: 'a', date: new Date('2026-01-10T12:00:00Z'), by_name: 'Dra. X', source: 'plano' },
        { patient_id: 'a', date: new Date('2026-07-13T12:00:00Z'), by_name: 'Dra. Y', source: 'agenda' },
        { patient_id: 'b', date: new Date('2026-03-05T12:00:00Z'), by_name: null, source: 'plano' },
      ],
      6,
    );
    expect(out).toHaveLength(2);
    const a = out.find((o) => o.patient_id === 'a')!;
    expect(a.source).toBe('agenda');
    expect(a.by_name).toBe('Dra. Y');
    expect(a.return_date.toISOString().slice(0, 10)).toBe('2027-01-13');
    const b = out.find((o) => o.patient_id === 'b')!;
    expect(b.return_date.toISOString().slice(0, 10)).toBe('2026-09-05');
  });
});

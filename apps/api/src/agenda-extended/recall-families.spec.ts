import {
  RECALL_FAMILIES,
  isFamilyProcedure,
  isFamilyText,
  latestPerPatient,
  pickFamilyHome,
  type FamilyProc,
} from './recall-families';

const LIMPEZA = RECALL_FAMILIES.find((f) => f.key === 'limpeza')!;
const CLAREAMENTO = RECALL_FAMILIES.find((f) => f.key === 'clareamento')!;
const FACETA = RECALL_FAMILIES.find((f) => f.key === 'faceta_resina')!;

describe('recall-families', () => {
  it('limpeza: reconhece limpeza dental e deixa a estética de fora', () => {
    expect(isFamilyText(LIMPEZA, 'Limpeza')).toBe(true);
    expect(isFamilyText(LIMPEZA, 'Profilaxia (limpeza + raspagem)')).toBe(true);
    expect(isFamilyText(LIMPEZA, 'PROFILAXIA')).toBe(true);
    expect(isFamilyText(LIMPEZA, 'Consulta - limpeza e avaliação')).toBe(true);
    expect(isFamilyText(LIMPEZA, 'Limpeza de pele')).toBe(false);
    expect(isFamilyText(LIMPEZA, 'Limpeza pele profunda')).toBe(false);
    expect(isFamilyText(LIMPEZA, 'Limpeza facial')).toBe(false);
    expect(isFamilyText(LIMPEZA, 'Clareamento de Consultorio')).toBe(false);
    expect(isFamilyText(LIMPEZA, null)).toBe(false);
  });

  it('clareamento: dental entra (consultório, caseiro, combinado), de pele/axila não', () => {
    expect(isFamilyText(CLAREAMENTO, 'Clareamento de Consultorio')).toBe(true);
    expect(isFamilyText(CLAREAMENTO, 'Clareamento caseiro (moldeira)')).toBe(true);
    expect(isFamilyText(CLAREAMENTO, 'CLAREAMENTO DENTAL')).toBe(true);
    expect(isFamilyText(CLAREAMENTO, 'Clareamento combinado')).toBe(true);
    expect(isFamilyText(CLAREAMENTO, 'Clareamento de pele')).toBe(false);
    expect(isFamilyText(CLAREAMENTO, 'Clareamento de axilas')).toBe(false);
    expect(isFamilyText(CLAREAMENTO, 'Clareamento de manchas')).toBe(false);
    expect(isFamilyText(CLAREAMENTO, 'Clareamento íntimo')).toBe(false);
    expect(isFamilyText(CLAREAMENTO, 'Limpeza')).toBe(false);
  });

  it('faceta de resina: resina/direta/sem material entra; porcelana, lente e remoção não', () => {
    expect(isFamilyText(FACETA, 'Faceta de Resina (PREMIUM)')).toBe(true);
    expect(isFamilyText(FACETA, 'Faceta em resina simples')).toBe(true);
    expect(isFamilyText(FACETA, 'Facetas diretas')).toBe(true);
    expect(isFamilyText(FACETA, 'Faceta')).toBe(true);
    expect(isFamilyText(FACETA, 'Reparo de faceta')).toBe(true);
    expect(isFamilyText(FACETA, 'Faceta de porcelana')).toBe(false);
    expect(isFamilyText(FACETA, 'Faceta cerâmica (e.max)')).toBe(false);
    expect(isFamilyText(FACETA, 'Lente de contato / faceta')).toBe(false);
    expect(isFamilyText(FACETA, 'Remoção de faceta')).toBe(false);
    expect(isFamilyText(FACETA, 'Restauração em resina')).toBe(false);
  });

  it('procedimento da família = categoria da família ou nome; estética facial nunca', () => {
    expect(isFamilyProcedure(LIMPEZA, { name: 'Raspagem supragengival', category: 'PROFILAXIA' })).toBe(true);
    expect(isFamilyProcedure(LIMPEZA, { name: 'Limpeza', category: null })).toBe(true);
    expect(isFamilyProcedure(LIMPEZA, { name: 'Limpeza', category: 'LIMPEZA_PELE' })).toBe(false);
    expect(isFamilyProcedure(LIMPEZA, { name: 'Faceta de Resina (PREMIUM)', category: 'ESTETICA_DENTAL' })).toBe(false);
    expect(isFamilyProcedure(CLAREAMENTO, { name: 'Clareamento de Consultorio', category: 'ESTETICA_DENTAL' })).toBe(true);
    expect(isFamilyProcedure(CLAREAMENTO, { name: 'Clareamento a laser', category: 'LASER' })).toBe(false);
    expect(isFamilyProcedure(CLAREAMENTO, { name: 'Faceta de Resina (PREMIUM)', category: 'ESTETICA_DENTAL' })).toBe(false);
  });

  const proc = (over: Partial<FamilyProc>): FamilyProc => ({
    id: over.name || 'x',
    name: 'Limpeza',
    category: null,
    active: true,
    default_revisit_months: 6,
    ...over,
  });

  it('aba da família = a ligada e ativa; limpeza prefere PROFILAXIA', () => {
    expect(pickFamilyHome(LIMPEZA, [proc({ name: 'Limpeza', default_revisit_months: null })])).toBeNull();
    expect(pickFamilyHome(LIMPEZA, [proc({ name: 'Limpeza', active: false })])).toBeNull();
    const home = pickFamilyHome(LIMPEZA, [
      proc({ name: 'Limpeza' }),
      proc({ name: 'Profilaxia (limpeza + raspagem)', category: 'PROFILAXIA' }),
      proc({ name: 'Limpeza antiga', active: false }),
    ]);
    expect(home?.name).toBe('Profilaxia (limpeza + raspagem)');
    const clar = pickFamilyHome(CLAREAMENTO, [
      proc({ name: 'Clareamento caseiro', default_revisit_months: null }),
      proc({ name: 'Clareamento de Consultorio', default_revisit_months: 12 }),
    ]);
    expect(clar?.name).toBe('Clareamento de Consultorio');
  });

  it('1 por paciente, a mais recente de qualquer fonte, + N meses', () => {
    const out = latestPerPatient(
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

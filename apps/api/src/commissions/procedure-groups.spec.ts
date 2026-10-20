import { groupProcedures, procedureGroup } from './procedure-groups';

describe('procedure-groups', () => {
  it('reconhece a família pelo nome, com ou sem acento', () => {
    expect(procedureGroup({ name: 'Limpeza dental (profilaxia)' })).toBe('Limpeza');
    expect(procedureGroup({ name: 'Restauração em resina' })).toBe('Restauração');
    expect(procedureGroup({ name: 'EXTRACAO DE SISO' })).toBe('Extração');
    expect(procedureGroup({ name: 'Tratamento de canal - molar' })).toBe('Endodontia');
    expect(procedureGroup({ name: 'Lente de contato em porcelana' })).toBe('Lentes e facetas');
    expect(procedureGroup({ name: 'Implante unitário' })).toBe('Implante');
  });

  it('nome específico vence a categoria genérica', () => {
    expect(procedureGroup({ name: 'Faceta em resina', category: 'ESTETICA_DENTAL' })).toBe('Lentes e facetas');
  });

  it('usa a categoria quando o nome não diz nada e o próprio nome no fim', () => {
    expect(procedureGroup({ name: 'Proc. 0042', category: 'DENTISTICA' })).toBe('Restauração');
    expect(procedureGroup({ name: 'BOTOX TESTA', category: 'TOXINA_BOTULINICA' })).toBe('Toxina botulínica');
    expect(procedureGroup({ name: 'MOLDAGEM', category: null })).toBe('Moldagem');
    expect(procedureGroup({ name: '', category: null })).toBe('Outros');
  });

  it('agrupa, ordena e junta o excedente em "Outros"', () => {
    const procs = [
      ...Array(5).fill({ name: 'Limpeza' }),
      ...Array(3).fill({ name: 'Restauração' }),
      ...Array(2).fill({ name: 'Canal' }),
      { name: 'Implante' }, { name: 'Moldagem' }, { name: 'Clareamento' },
    ];
    const r = groupProcedures(procs, 3);
    expect(r.total).toBe(13);
    expect(r.items).toEqual([
      { label: 'Limpeza', count: 5 },
      { label: 'Restauração', count: 3 },
      { label: 'Endodontia', count: 2 },
      { label: 'Outros', count: 3 },
    ]);
  });

  it('mês vazio', () => {
    expect(groupProcedures([])).toEqual({ total: 0, items: [] });
  });
});

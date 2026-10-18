/**
 * Out/2026 — direcionar pacientes pros dentistas: especialidade, dados antigos e origem.
 */
import { pickDentistForProcedure, procedureAreas, dentistsForProcedure } from '@crm/shared';
import { planDentistBackfill } from './dentist-backfill';
import { originLabel } from './dentist-links';
import { ownPatientsWhere } from '../auth/patient-scope';

const DENTISTS = [
  { id: 'ana', name: 'Ana', specialties: ['Orçamentista', 'Clínico geral'] },
  { id: 'bia', name: 'Bia', specialties: ['Endodontia'] },
  { id: 'caio', name: 'Caio', specialties: ['Ortodontia'] },
  { id: 'davi', name: 'Davi', specialties: ['Implantes', 'Prótese'] },
];

describe('pickDentistForProcedure (especialidade)', () => {
  it('canal → endodontista; aparelho → ortodontista; implante → implantodontista', () => {
    expect(pickDentistForProcedure({ name: 'Tratamento de canal (molar)' }, DENTISTS)).toBe('bia');
    expect(pickDentistForProcedure({ name: 'Manutenção', category: 'ORTODONTIA' }, DENTISTS)).toBe('caio');
    expect(pickDentistForProcedure({ name: 'Implante unitário', specialty: 'Implantodontia' }, DENTISTS)).toBe('davi');
    expect(pickDentistForProcedure({ name: 'Coroa em porcelana' }, DENTISTS)).toBe('davi');
  });

  it('especialidade/categoria têm prioridade sobre o nome', () => {
    expect([...procedureAreas({ name: 'Canal', category: 'ORTODONTIA' })]).toEqual(['ortodontia']);
  });

  it('quem lança é preferido quando é da área; ninguém da área → quem lança (se dentista)', () => {
    const two = [...DENTISTS, { id: 'bruno', name: 'Bruno', specialties: ['endodontista'] }];
    expect(pickDentistForProcedure({ name: 'Canal' }, two, { preferUserId: 'bruno' })).toBe('bruno');
    expect(pickDentistForProcedure({ name: 'Canal' }, two)).toBe('bia'); // 1º por nome
    expect(pickDentistForProcedure({ name: 'Consulta de rotina' }, DENTISTS, { preferUserId: 'ana' })).toBe('ana');
    expect(pickDentistForProcedure({ name: 'Algo sem área' }, DENTISTS, { preferUserId: 'recepcao' })).toBeNull();
  });

  it('acento e caixa não importam', () => {
    expect(dentistsForProcedure({ specialty: 'PRÓTESE' }, DENTISTS).map((d) => d.id)).toEqual(['davi']);
  });
});

describe('planDentistBackfill (dados antigos — só preenche vazio)', () => {
  const procCanal = { name: 'Canal' };
  const procImpl = { name: 'Implante' };

  it('item de orçamento vazio → área; item de plano copia do orçamento; responsável = 1ª consulta', () => {
    const plan = planDentistBackfill({
      dentists: DENTISTS,
      quoteItems: [
        { id: 'qi1', quote_id: 'q1', procedure_id: 'pCanal', tooth_fdi: '36', order_index: 0, dentist_id: null, procedure: procCanal, quote_created_by: 'ana' },
        { id: 'qi2', quote_id: 'q1', procedure_id: 'pImpl', tooth_fdi: '46', order_index: 1, dentist_id: 'davi', procedure: procImpl, quote_created_by: 'ana' },
        { id: 'qi3', quote_id: 'q2', procedure_id: 'pCanal', tooth_fdi: null, order_index: 0, dentist_id: null, procedure: procCanal, quote_created_by: 'ana', assignable: false },
      ],
      planItems: [
        { id: 'pi1', plan_quote_id: 'q1', procedure_id: 'pCanal', tooth_fdi: '36', order_index: 0, executed_by_user_id: null, procedure: procCanal },
        { id: 'pi2', plan_quote_id: 'q1', procedure_id: 'pImpl', tooth_fdi: '46', order_index: 1, executed_by_user_id: null, procedure: procImpl },
        { id: 'pi3', plan_quote_id: null, procedure_id: 'pX', tooth_fdi: null, order_index: 0, executed_by_user_id: 'caio', procedure: { name: 'Algo' } },
        { id: 'pi4', plan_quote_id: null, procedure_id: 'pX', tooth_fdi: null, order_index: 0, executed_by_user_id: 'recepcao', procedure: { name: 'Algo' } },
      ],
      patients: [{ id: 'pt1', lead_id: 'l1' }, { id: 'pt2', lead_id: null }, { id: 'pt3', lead_id: null }],
      attendedEvents: [
        { patient_id: null, lead_id: 'l1', assigned_user_id: 'ana', start_at: new Date('2026-01-01') },
        { patient_id: 'pt1', lead_id: 'l1', assigned_user_id: 'bia', start_at: new Date('2026-02-01') },
        { patient_id: 'pt2', lead_id: null, assigned_user_id: 'recepcao', start_at: new Date('2026-02-01') },
      ],
    });
    expect(plan.quoteItems).toEqual([{ id: 'qi1', dentist_id: 'bia' }]); // qi2 já tinha; qi3 não é atribuível
    expect(plan.planItems).toEqual([
      { id: 'pi1', dentist_id: 'bia' },   // do item equivalente do orçamento (recém-atribuído)
      { id: 'pi2', dentist_id: 'davi' },  // do orçamento (já tinha)
      { id: 'pi3', dentist_id: 'caio' },  // quem executou (dentista)
    ]);
    expect(plan.semDentista.planItems).toBe(1); // pi4: executor não é dentista e sem área
    // pt1: a consulta mais antiga (pelo lead) foi com a Ana; pt2: só não-dentista → fica vazio.
    expect(plan.primary).toEqual([{ id: 'pt1', dentist_id: 'ana' }]);
    expect(plan.semDentista.patients).toBe(2);
  });
});

describe('origem do paciente', () => {
  it('rótulos legíveis e esconde marcas internas', () => {
    expect(originLabel('whatsapp')).toBe('WhatsApp');
    expect(originLabel('Indicacao')).toBe('Indicação');
    expect(originLabel('cadastro_manual')).toBe('Cadastro na clínica');
    expect(originLabel('AUTO_CREATED_FROM_PATIENT')).toBeNull();
    expect(originLabel('')).toBeNull();
    expect(originLabel('tiktok')).toBe('Tiktok');
  });
});

describe('carteira do dentista inclui o responsável pelo procedimento do plano', () => {
  it('ownPatientsWhere tem TreatmentPlanItem.dentist_id', () => {
    expect(JSON.stringify(ownPatientsWhere('u1'))).toContain('"items":{"some":{"dentist_id":"u1"}}');
  });
});

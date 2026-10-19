/**
 * Fase 0 — F0: quem pode confirmar procedimento (ator) e quando o plano deixa.
 */
import {
  motivoNegarAtor,
  motivoBloqueioPlano,
  MSG_ITEM_OUTRO_DENTISTA,
  MSG_SO_DENTISTA,
  MSG_AGUARDANDO_FINANCEIRO,
  MSG_PLANO_CANCELADO,
} from './execucao-regras';

describe('execucao-regras — motivoNegarAtor', () => {
  const base = { actorId: 'u1', actorEhDentista: false, itemDentistId: null as string | null };

  it('ADMIN passa em qualquer item (com ou sem dentista, sendo ou não dentista)', () => {
    expect(motivoNegarAtor({ ...base, isAdmin: true })).toBeNull();
    expect(motivoNegarAtor({ ...base, isAdmin: true, itemDentistId: 'outro' })).toBeNull();
    expect(motivoNegarAtor({ ...base, isAdmin: true, actorEhDentista: true, itemDentistId: 'outro' })).toBeNull();
  });

  it('item COM dentista: só o próprio dentista confirma', () => {
    expect(motivoNegarAtor({ ...base, isAdmin: false, actorEhDentista: true, itemDentistId: 'u1' })).toBeNull();
    expect(motivoNegarAtor({ ...base, isAdmin: false, actorEhDentista: true, itemDentistId: 'u2' })).toBe(MSG_ITEM_OUTRO_DENTISTA);
  });

  it('item COM dentista: "dono" do item sem o papel DENTIST no banco NÃO passa (dentist_id vem do cliente)', () => {
    expect(motivoNegarAtor({ ...base, isAdmin: false, actorEhDentista: false, itemDentistId: 'u1' })).toBe(MSG_SO_DENTISTA);
  });

  it('item COM dentista: não dentista e não dono leva "só dentista"', () => {
    expect(motivoNegarAtor({ ...base, isAdmin: false, actorEhDentista: false, itemDentistId: 'u2' })).toBe(MSG_SO_DENTISTA);
  });

  it('item SEM dentista: qualquer dentista confirma; não dentista não', () => {
    expect(motivoNegarAtor({ ...base, isAdmin: false, actorEhDentista: true, itemDentistId: null })).toBeNull();
    expect(motivoNegarAtor({ ...base, isAdmin: false, actorEhDentista: false, itemDentistId: null })).toBe(MSG_SO_DENTISTA);
  });
});

describe('execucao-regras — motivoBloqueioPlano', () => {
  const POS = new Date('2026-10-19T03:00:00.000Z'); // 19/10 00:00 Maceió (corte)
  const PRE = new Date('2026-10-19T02:59:59.000Z'); // 18/10 23:59 Maceió
  const VALIDADO = new Date('2026-10-20T12:00:00.000Z');

  it('plano CANCELLED bloqueia (antes ou depois do corte, validado ou não)', () => {
    expect(motivoBloqueioPlano({ status: 'CANCELLED', created_at: PRE, validated_by_financial_at: null })).toBe(MSG_PLANO_CANCELADO);
    expect(motivoBloqueioPlano({ status: 'CANCELLED', created_at: POS, validated_by_financial_at: VALIDADO })).toBe(MSG_PLANO_CANCELADO);
  });

  it('pós-corte sem validação do Financeiro bloqueia', () => {
    expect(motivoBloqueioPlano({ status: 'ACTIVE', created_at: POS, validated_by_financial_at: null })).toBe(MSG_AGUARDANDO_FINANCEIRO);
    expect(motivoBloqueioPlano({ status: 'PENDING_SIGNATURE', created_at: POS, validated_by_financial_at: null })).toBe(MSG_AGUARDANDO_FINANCEIRO);
  });

  it('pós-corte validado passa', () => {
    expect(motivoBloqueioPlano({ status: 'ACTIVE', created_at: POS, validated_by_financial_at: VALIDADO })).toBeNull();
  });

  it('pré-corte sem validação passa (nada retroativo)', () => {
    expect(motivoBloqueioPlano({ status: 'ACTIVE', created_at: PRE, validated_by_financial_at: null })).toBeNull();
    expect(motivoBloqueioPlano({ status: 'PENDING_SIGNATURE', created_at: PRE, validated_by_financial_at: null })).toBeNull();
  });

  it('PAUSED continua permitido (como hoje)', () => {
    expect(motivoBloqueioPlano({ status: 'PAUSED', created_at: POS, validated_by_financial_at: VALIDADO })).toBeNull();
    expect(motivoBloqueioPlano({ status: 'PAUSED', created_at: PRE, validated_by_financial_at: null })).toBeNull();
  });

  it('sem data de criação conta como antigo', () => {
    expect(motivoBloqueioPlano({ status: 'ACTIVE', created_at: null, validated_by_financial_at: null })).toBeNull();
  });
});

/**
 * Fase 0 — regras C (soma das formas = valor) e D (cancelada não recebe baixa).
 */
import { erroSomaFormas, motivoBloqueioBaixa, MSG_COBRANCA_CANCELADA, round2 } from './baixa-regras';

describe('motivoBloqueioBaixa (regra D)', () => {
  it.each(['DELETED', 'REFUNDED', 'CANCELLED', 'REFUND_REQUESTED', 'CHARGEBACK_REQUESTED'])('status %s bloqueia', (status) => {
    expect(motivoBloqueioBaixa({ status })).toBe(MSG_COBRANCA_CANCELADA);
  });

  it('cancelled_at preenchido bloqueia mesmo com status PENDING', () => {
    expect(motivoBloqueioBaixa({ status: 'PENDING', cancelled_at: new Date() })).toBe(MSG_COBRANCA_CANCELADA);
  });

  it('deleted:true (Asaas) bloqueia', () => {
    expect(motivoBloqueioBaixa({ status: 'PENDING', deleted: true })).toBe(MSG_COBRANCA_CANCELADA);
  });

  it.each(['PENDING', 'OVERDUE'])('status %s passa', (status) => {
    expect(motivoBloqueioBaixa({ status, cancelled_at: null, deleted: false })).toBeNull();
  });

  it('cobrança não encontrada (null) segue o fluxo', () => {
    expect(motivoBloqueioBaixa(null)).toBeNull();
  });
});

describe('erroSomaFormas (regra C)', () => {
  it('soma 100,01 contra 100,00 passa (tolerância de 1 centavo)', () => {
    expect(erroSomaFormas([{ value: 50 }, { value: 50.01 }], 100)).toBeNull();
    expect(erroSomaFormas([{ value: 100 }], 100.01)).toBeNull();
  });

  it('soma 99,98 contra 100,00 dá erro com os valores em reais', () => {
    const e = erroSomaFormas([{ value: 49.99 }, { value: 49.99 }], 100);
    expect(e).toBe('A soma das formas de pagamento (R$ 99,98) tem que ser igual ao valor da cobrança (R$ 100,00).');
  });

  it('soma exata em float (0,1 + 0,2 = 0,3) passa', () => {
    expect(erroSomaFormas([{ value: 0.1 }, { value: 0.2 }], 0.3)).toBeNull();
  });

  it('lista vazia, null ou só valores zerados passa', () => {
    expect(erroSomaFormas([], 100)).toBeNull();
    expect(erroSomaFormas(null, 100)).toBeNull();
    expect(erroSomaFormas(undefined, 100)).toBeNull();
    expect(erroSomaFormas([{ value: 0 }], 100)).toBeNull();
  });

  it('linha zerada não entra na soma', () => {
    expect(erroSomaFormas([{ value: 100 }, { value: 0 }], 100)).toBeNull();
  });
});

describe('round2', () => {
  it('arredonda pra 2 casas', () => {
    expect(round2(12.3456)).toBe(12.35);
    expect(round2(0.1 + 0.2)).toBe(0.3);
    expect(round2(99.999)).toBe(100);
  });
});

import { combinar, veredictoAsaas, veredictoLocal } from './cobranca-freio';

describe('freio ao vivo da régua — nunca cobrar quem já pagou', () => {
  describe('veredictoLocal (status relido do banco na hora do envio)', () => {
    it('cobra só PENDING/OVERDUE não recebido em espécie', () => {
      expect(veredictoLocal({ status: 'PENDING', received_in_cash: false })).toBe('cobrar');
      expect(veredictoLocal({ status: 'OVERDUE', received_in_cash: false })).toBe('cobrar');
    });
    it('não cobra se a baixa chegou entre a escolha e o envio', () => {
      expect(veredictoLocal({ status: 'RECEIVED', received_in_cash: false })).toBe('nao_cobrar');
      expect(veredictoLocal({ status: 'CONFIRMED', received_in_cash: false })).toBe('nao_cobrar');
      expect(veredictoLocal({ status: 'CANCELLED', received_in_cash: false })).toBe('nao_cobrar');
    });
    it('não cobra recebido na clínica, mesmo com status PENDING', () => {
      expect(veredictoLocal({ status: 'PENDING', received_in_cash: true })).toBe('nao_cobrar');
    });
    it('não cobra cobrança que sumiu do banco', () => {
      expect(veredictoLocal(null)).toBe('nao_cobrar');
    });
  });

  describe('veredictoAsaas (GET /payments/{id} ao vivo)', () => {
    it('caso real: local PENDING mas Asaas já RECEIVED → não cobra', () => {
      expect(combinar(veredictoLocal({ status: 'PENDING', received_in_cash: false }), veredictoAsaas({ ok: true, status: 'RECEIVED' }))).toBe('nao_cobrar');
    });
    it('não cobra nenhum status de pago/estorno/removido', () => {
      for (const s of ['RECEIVED', 'CONFIRMED', 'RECEIVED_IN_CASH', 'REFUNDED', 'REFUND_REQUESTED', 'CHARGEBACK_REQUESTED', 'DUNNING_RECEIVED', 'ALGO_NOVO']) {
        expect(veredictoAsaas({ ok: true, status: s })).toBe('nao_cobrar');
      }
      expect(veredictoAsaas({ ok: true, status: 'PENDING', deleted: true })).toBe('nao_cobrar');
    });
    it('cobra só PENDING/OVERDUE', () => {
      expect(veredictoAsaas({ ok: true, status: 'PENDING' })).toBe('cobrar');
      expect(veredictoAsaas({ ok: true, status: 'overdue' })).toBe('cobrar');
    });
    it('Asaas fora/lento → espera (fail-closed), 404 → não cobra', () => {
      expect(veredictoAsaas({ ok: false })).toBe('indisponivel');
      expect(veredictoAsaas({ ok: false, httpStatus: 503 })).toBe('indisponivel');
      expect(veredictoAsaas({ ok: false, httpStatus: 401 })).toBe('indisponivel');
      expect(veredictoAsaas({ ok: true, status: '' })).toBe('indisponivel');
      expect(veredictoAsaas({ ok: false, httpStatus: 404 })).toBe('nao_cobrar');
    });
  });

  it('combinar: um "não cobrar" vence; senão "indisponível" segura', () => {
    expect(combinar('cobrar', 'nao_cobrar')).toBe('nao_cobrar');
    expect(combinar('indisponivel', 'nao_cobrar')).toBe('nao_cobrar');
    expect(combinar('cobrar', 'indisponivel')).toBe('indisponivel');
    expect(combinar('cobrar', 'cobrar')).toBe('cobrar');
  });
});

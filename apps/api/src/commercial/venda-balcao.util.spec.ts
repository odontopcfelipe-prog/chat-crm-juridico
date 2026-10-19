/**
 * Fase 0 — venda de balcão: notas com a marca "Venda rapida", forma dominante e
 * roteamento (forma única x split) igual ao que a tela da venda rápida faz hoje.
 */
import { BadRequestException } from '@nestjs/common';
import { isVendaRapidaQuote } from './quotes.service';
import { formaDominante, notasVendaBalcao, roteamentoBalcao, type FormaBalcao } from './venda-balcao.util';

describe('notasVendaBalcao', () => {
  const casos: FormaBalcao[][] = [
    [{ method: 'DINHEIRO', value: 100 }],
    [{ method: 'PIX', value: 100 }],
    [{ method: 'PIX_MAQUININHA', value: 100 }],
    [{ method: 'CARTAO', value: 100, installments: 3 }],
    [{ method: 'CARTAO', value: 60 }, { method: 'CARTAO', value: 40, debit: true }],
    [{ method: 'PIX', value: 70 }, { method: 'DINHEIRO', value: 30 }],
    [],
  ];

  it.each(casos.map((c) => [c]))('sempre começa com "Venda rapida" (%j)', (ps) => {
    const n = notasVendaBalcao(ps);
    expect(n.startsWith('Venda rapida')).toBe(true);
    expect(isVendaRapidaQuote({ notes: n })).toBe(true);
  });

  it('forma única usa o rótulo da forma', () => {
    expect(notasVendaBalcao([{ method: 'DINHEIRO', value: 100 }])).toBe('Venda rapida — recebido na clinica: Espécie');
    expect(notasVendaBalcao([{ method: 'PIX', value: 100 }])).toBe('Venda rapida — recebido na clinica: PIX da clínica');
  });

  it('dois cartões viram "Maquineta (2 cartões)"', () => {
    expect(notasVendaBalcao([{ method: 'CARTAO', value: 60 }, { method: 'CARTAO', value: 40 }])).toBe(
      'Venda rapida — recebido na clinica: Maquineta (2 cartões)',
    );
  });

  it('misto lista cada forma com o valor', () => {
    expect(notasVendaBalcao([{ method: 'PIX', value: 70 }, { method: 'DINHEIRO', value: 30.5 }])).toBe(
      'Venda rapida — recebido na clinica (varias formas): PIX da clínica R$ 70.00 + Espécie R$ 30.50',
    );
  });
});

describe('formaDominante', () => {
  it('escolhe a forma de maior valor', () => {
    expect(formaDominante([{ method: 'DINHEIRO', value: 30 }, { method: 'PIX', value: 70 }])).toBe('PIX');
  });

  it('empate fica com a que chegou primeiro', () => {
    expect(formaDominante([{ method: 'DINHEIRO', value: 50 }, { method: 'PIX', value: 50 }])).toBe('DINHEIRO');
    expect(formaDominante([{ method: 'PIX', value: 50 }, { method: 'DINHEIRO', value: 50 }])).toBe('PIX');
  });

  it('lista vazia devolve string vazia', () => {
    expect(formaDominante([])).toBe('');
  });
});

describe('roteamentoBalcao', () => {
  it('cartão único vai em split com installments', () => {
    const ps: FormaBalcao[] = [{ method: 'CARTAO', value: 300, installments: 3 }];
    expect(roteamentoBalcao(ps)).toEqual({
      manualPaymentMethod: 'CARTAO',
      receivedMethod: 'CARTAO',
      installments: 3,
      split: ps,
    });
  });

  it('dinheiro único fica sem split e sem parcelas', () => {
    expect(roteamentoBalcao([{ method: 'DINHEIRO', value: 100 }])).toEqual({
      manualPaymentMethod: 'DINHEIRO',
      receivedMethod: 'DINHEIRO',
      installments: undefined,
      split: undefined,
    });
  });

  it('PIX único também fica sem split', () => {
    const r = roteamentoBalcao([{ method: 'PIX', value: 100 }]);
    expect(r.manualPaymentMethod).toBe('PIX');
    expect(r.split).toBeUndefined();
  });

  it('misto vai em split com a forma dominante e sem parcelas no topo', () => {
    const ps: FormaBalcao[] = [{ method: 'DINHEIRO', value: 30 }, { method: 'CARTAO', value: 70, installments: 2 }];
    expect(roteamentoBalcao(ps)).toEqual({
      manualPaymentMethod: 'CARTAO',
      receivedMethod: 'CARTAO',
      installments: undefined,
      split: ps,
    });
  });

  it('dois cartões vão em split', () => {
    const ps: FormaBalcao[] = [{ method: 'CARTAO', value: 60, installments: 2 }, { method: 'CARTAO', value: 40, debit: true }];
    const r = roteamentoBalcao(ps);
    expect(r.split).toBe(ps);
    expect(r.installments).toBeUndefined();
    expect(r.manualPaymentMethod).toBe('CARTAO');
  });

  it('sem forma nenhuma barra com 400', () => {
    expect(() => roteamentoBalcao([])).toThrow(BadRequestException);
  });
});

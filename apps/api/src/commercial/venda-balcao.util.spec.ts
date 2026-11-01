/**
 * Fase 0 — venda de balcão: notas com a marca "Venda rapida", forma dominante e
 * roteamento (forma única x split) igual ao que a tela da venda rápida faz hoje.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as ts from 'typescript';
import { BadRequestException } from '@nestjs/common';
import { isVendaRapidaQuote } from './quotes.service';
import {
  LAB_NOTAS_BALCAO,
  LAB_ROTULO_FORMA,
  ROTULO_FORMA,
  formaDominante,
  notasVendaBalcao,
  roteamentoBalcao,
  type FormaBalcao,
} from './venda-balcao.util';

/**
 * A cópia de isVendaRapidaQuote em patients/dentist-links.ts (não exportada: importar o
 * serviço de orçamentos lá criaria ciclo entre módulos). Compilada a partir do fonte.
 */
function copiaDeDentistLinks(): (q: { title?: string | null; notes?: string | null }) => boolean {
  const src = fs.readFileSync(path.join(__dirname, '..', 'patients', 'dentist-links.ts'), 'utf8').replace(/\r\n/g, '\n');
  const norm = /^const norm = [\s\S]*?;\n/m.exec(src)?.[0];
  const fn = /^function isVendaRapidaQuote\([\s\S]*?\n\}/m.exec(src)?.[0];
  if (!norm || !fn) throw new Error('não achei norm/isVendaRapidaQuote em patients/dentist-links.ts');
  const js = ts.transpileModule(`${norm}\n${fn}\nexports.isVendaRapidaQuote = isVendaRapidaQuote;`, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const exp: Record<string, unknown> = {};
  new Function('exports', js)(exp);
  return exp.isVendaRapidaQuote as (q: { title?: string | null; notes?: string | null }) => boolean;
}
const isVendaRapidaDaCopia = copiaDeDentistLinks();

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

  // F5 — laboratório: o mesmo começo "Venda rapida" (a marca de isVendaRapidaQuote e da
  // cópia em patients/dentist-links.ts), "recebido no laboratorio" e o PIX do laboratório.
  it.each(casos.map((c) => [c]))('laboratório: começa com "Venda rapida", é venda rápida nas duas marcas e não fala de clínica (%j)', (ps) => {
    const n = notasVendaBalcao(ps, true);
    expect(n.startsWith('Venda rapida')).toBe(true);
    expect(isVendaRapidaQuote({ notes: n })).toBe(true);
    expect(isVendaRapidaDaCopia({ notes: n })).toBe(true);
    expect(n.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()).not.toMatch(/clinica/);
  });

  it('laboratório: os textos exatos', () => {
    expect(notasVendaBalcao([], true)).toBe('Venda rapida — recebido no laboratorio');
    expect(notasVendaBalcao([{ method: 'DINHEIRO', value: 100 }], true)).toBe('Venda rapida — recebido no laboratorio: Espécie');
    expect(notasVendaBalcao([{ method: 'PIX', value: 100 }], true)).toBe('Venda rapida — recebido no laboratorio: PIX do laboratório');
    expect(notasVendaBalcao([{ method: 'PIX_MAQUININHA', value: 100 }], true)).toBe('Venda rapida — recebido no laboratorio: PIX (Maquineta)');
    expect(notasVendaBalcao([{ method: 'CARTAO', value: 60 }, { method: 'CARTAO', value: 40 }], true)).toBe(
      'Venda rapida — recebido no laboratorio: Maquineta (2 cartões)',
    );
    expect(notasVendaBalcao([{ method: 'PIX', value: 70 }, { method: 'DINHEIRO', value: 30.5 }], true)).toBe(
      'Venda rapida — recebido no laboratorio (varias formas): PIX do laboratório R$ 70.00 + Espécie R$ 30.50',
    );
  });

  it('clínica: lab=false é exatamente o texto de sempre (sem o 2º argumento)', () => {
    for (const ps of casos) expect(notasVendaBalcao(ps, false)).toBe(notasVendaBalcao(ps));
  });

  it('o rótulo das formas da clínica não muda (o do laboratório fica à parte)', () => {
    expect(ROTULO_FORMA).toEqual({ DINHEIRO: 'Espécie', PIX: 'PIX da clínica', PIX_MAQUININHA: 'PIX (Maquineta)', CARTAO: 'Maquineta' });
    expect(LAB_ROTULO_FORMA).toEqual({ PIX: 'PIX do laboratório' });
    expect(Object.isFrozen(LAB_ROTULO_FORMA)).toBe(true);
    expect(Object.isFrozen(LAB_NOTAS_BALCAO)).toBe(true);
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

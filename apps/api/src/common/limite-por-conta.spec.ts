import { HttpException } from '@nestjs/common';
import { LimitePorConta } from './limite-por-conta';

describe('LimitePorConta', () => {
  const HORA = 3_600_000;

  it('até o máximo passa; acima responde 429 com a mensagem do limite', () => {
    const limite = new LimitePorConta(2, HORA, 'Limite atingido.');
    limite.consumir('a', 0);
    limite.consumir('a', 1);
    const erro = (() => {
      try {
        limite.consumir('a', 2);
      } catch (e) {
        return e as HttpException;
      }
      return null;
    })();
    expect(erro?.getStatus()).toBe(429);
    expect(erro?.message).toBe('Limite atingido.');
  });

  it('cada conta tem a sua contagem', () => {
    const limite = new LimitePorConta(1, HORA, 'x');
    limite.consumir('a', 0);
    expect(() => limite.consumir('b', 0)).not.toThrow();
    expect(() => limite.consumir('a', 1)).toThrow(HttpException);
  });

  it('passada a janela, a contagem recomeça', () => {
    const limite = new LimitePorConta(1, HORA, 'x');
    limite.consumir('a', 0);
    expect(() => limite.consumir('a', HORA - 1)).toThrow(HttpException);
    expect(() => limite.consumir('a', HORA)).not.toThrow();
  });
});

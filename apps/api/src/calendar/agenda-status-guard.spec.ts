import {
  agoraMaceioNaive,
  mudancaTravada,
  statusInicialBloqueado,
  STATUS_INICIAIS_SO_ADMIN,
  STATUS_TRAVADOS_POS_VALIDACAO,
} from './agenda-status-guard';

describe('Fase 0 — agenda-status-guard', () => {
  it('agoraMaceioNaive: 15:00Z real vira 12:00Z naive (Maceió UTC-3)', () => {
    expect(agoraMaceioNaive(Date.UTC(2026, 9, 19, 15, 0)).toISOString()).toBe('2026-10-19T12:00:00.000Z');
  });

  it('agoraMaceioNaive sem argumento usa o relógio atual', () => {
    const antes = Date.now();
    const r = agoraMaceioNaive().getTime();
    expect(r).toBeGreaterThanOrEqual(antes - 3 * 3600_000);
    expect(r).toBeLessThanOrEqual(Date.now() - 3 * 3600_000);
  });

  describe('statusInicialBloqueado (criação)', () => {
    it('não-admin criando CONSULTA já CONCLUIDO: bloqueado', () => {
      expect(statusInicialBloqueado({ clinico: true, status: 'CONCLUIDO', isAdmin: false })).toBe(true);
    });
    it.each(STATUS_INICIAIS_SO_ADMIN.map((s) => [s]))('não-admin criando consulta com %s: bloqueado', (s) => {
      expect(statusInicialBloqueado({ clinico: true, status: s, isAdmin: false })).toBe(true);
    });
    it('COMPARECEU (encaixe na hora) fica livre', () => {
      expect(statusInicialBloqueado({ clinico: true, status: 'COMPARECEU', isAdmin: false })).toBe(false);
    });
    it('sem status (vira AGENDADO) fica livre', () => {
      expect(statusInicialBloqueado({ clinico: true, status: undefined, isAdmin: false })).toBe(false);
      expect(statusInicialBloqueado({ clinico: true, status: null, isAdmin: false })).toBe(false);
    });
    it('TAREFA com CONCLUIDO fica livre (não é evento clínico)', () => {
      expect(statusInicialBloqueado({ clinico: false, status: 'CONCLUIDO', isAdmin: false })).toBe(false);
    });
    it('ADMIN fica livre', () => {
      expect(statusInicialBloqueado({ clinico: true, status: 'CONCLUIDO', isAdmin: true })).toBe(false);
      expect(statusInicialBloqueado({ clinico: true, status: 'NO_SHOW', isAdmin: true })).toBe(false);
    });
  });

  describe('mudancaTravada (pós-validação)', () => {
    it('NO_SHOW por não-admin: travado', () => {
      expect(mudancaTravada({ para: 'NO_SHOW', isAdmin: false })).toBe(true);
    });
    it.each(STATUS_TRAVADOS_POS_VALIDACAO.map((s) => [s]))('%s por não-admin: travado', (s) => {
      expect(mudancaTravada({ para: s, isAdmin: false })).toBe(true);
    });
    it('CONFIRMADO e CONCLUIDO por não-admin: livres', () => {
      expect(mudancaTravada({ para: 'CONFIRMADO', isAdmin: false })).toBe(false);
      expect(mudancaTravada({ para: 'CONCLUIDO', isAdmin: false })).toBe(false);
    });
    it('ADMIN nunca é travado', () => {
      expect(mudancaTravada({ para: 'NO_SHOW', isAdmin: true })).toBe(false);
      expect(mudancaTravada({ para: 'ADIADO', isAdmin: true })).toBe(false);
    });
  });
});

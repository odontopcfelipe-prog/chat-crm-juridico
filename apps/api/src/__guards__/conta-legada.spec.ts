/**
 * Configuração por conta na GlobalSetting (`<CHAVE>_<tenantId>`), com reserva na
 * chave global antiga SÓ para as contas que já existiam (packages/shared/src/conta-legada.ts).
 *
 *  - conta criada antes do corte = legada: sem a própria, herda a global antiga;
 *  - conta criada depois = nova: sem a própria, null (o padrão do código) — nunca
 *    herda configuração de outra;
 *  - a chave da conta sempre vence;
 *  - quando não dá para saber (erro, conta não achada, data inválida): legada
 *    (o comportamento de hoje), com aviso, sem guardar no cache.
 */
import {
  CONTAS_LEGADAS_CRIADAS_ATE,
  __limparCacheContaLegada,
  chaveConfigDaConta,
  contaLegada,
  criadaAntesDoCorte,
  lerConfigDaConta,
} from '@crm/shared';

const ANTES = new Date('2025-03-01T12:00:00.000Z');
const DEPOIS = new Date('2026-11-05T12:00:00.000Z');

function banco(contas: Record<string, Date | null | 'erro'>, settings: Record<string, string> = {}) {
  return {
    tenant: {
      findUnique: jest.fn(async ({ where }: any) => {
        const c = contas[where.id];
        if (c === 'erro') throw new Error('banco fora');
        if (c === undefined) return null;
        return { created_at: c };
      }),
    },
    globalSetting: {
      findUnique: jest.fn(async ({ where }: any) => (where.key in settings ? { value: settings[where.key] } : null)),
    },
  };
}

beforeEach(() => __limparCacheContaLegada());

describe('Conta legada — reserva na configuração global antiga só para quem já existia', () => {
  it('o corte é uma data fixa (contas criadas antes desta entrega)', () => {
    expect(CONTAS_LEGADAS_CRIADAS_ATE).toBe('2026-10-27T00:00:00.000Z');
    expect(criadaAntesDoCorte(ANTES)).toBe(true);
    expect(criadaAntesDoCorte(DEPOIS)).toBe(false);
    expect(criadaAntesDoCorte(new Date(CONTAS_LEGADAS_CRIADAS_ATE))).toBe(false);
    expect(criadaAntesDoCorte(ANTES.toISOString())).toBe(true);
    expect(criadaAntesDoCorte(null)).toBeNull();
    expect(criadaAntesDoCorte('xx')).toBeNull();
  });

  it('conta antiga é legada; conta nova não', async () => {
    const p = banco({ antiga: ANTES, nova: DEPOIS });
    expect(await contaLegada(p, 'antiga', () => undefined)).toBe(true);
    expect(await contaLegada(p, 'nova', () => undefined)).toBe(false);
  });

  it('created_at não muda: a 2ª pergunta da mesma conta não vai ao banco', async () => {
    const p = banco({ nova: DEPOIS });
    await contaLegada(p, 'nova');
    await contaLegada(p, 'nova');
    expect(p.tenant.findUnique).toHaveBeenCalledTimes(1);
  });

  it('nunca rejeita: erro do banco = legada (comportamento de hoje), avisa e não guarda no cache', async () => {
    const p = banco({ x: 'erro' });
    const avisos: string[] = [];
    expect(await contaLegada(p, 'x', (m) => avisos.push(m))).toBe(true);
    expect(avisos.join()).toMatch(/falha/);
    await contaLegada(p, 'x', () => undefined);
    expect(p.tenant.findUnique).toHaveBeenCalledTimes(2);
  });

  it('conta não achada ou sem data válida = legada, com aviso; o aviso que lança não derruba', async () => {
    const p = banco({ semData: null });
    expect(await contaLegada(p, 'sumiu', () => { throw new Error('log quebrado'); })).toBe(true);
    expect(await contaLegada(p, 'semData', () => undefined)).toBe(true);
  });

  it('sem id: legada, sem consultar', async () => {
    const p = banco({});
    expect(await contaLegada(p, undefined)).toBe(true);
    expect(await contaLegada(p, '')).toBe(true);
    expect(p.tenant.findUnique).not.toHaveBeenCalled();
  });

  describe('lerConfigDaConta', () => {
    const settings = { X: 'global-antiga', [chaveConfigDaConta('X', 'propria')]: 'da-conta' };

    it('a chave da conta vence (mesmo em conta nova)', async () => {
      const p = banco({ propria: DEPOIS }, settings);
      expect(await lerConfigDaConta(p, 'X', 'propria')).toBe('da-conta');
    });

    it('conta legada sem a própria herda a global antiga', async () => {
      const p = banco({ antiga: ANTES }, settings);
      expect(await lerConfigDaConta(p, 'X', 'antiga')).toBe('global-antiga');
    });

    it('conta NOVA sem a própria NÃO herda: null (o padrão do código)', async () => {
      const p = banco({ nova: DEPOIS }, settings);
      expect(await lerConfigDaConta(p, 'X', 'nova')).toBeNull();
      expect(p.globalSetting.findUnique).not.toHaveBeenCalledWith({ where: { key: 'X' } });
    });

    it('sem conta: a global antiga (como hoje)', async () => {
      const p = banco({}, settings);
      expect(await lerConfigDaConta(p, 'X', null)).toBe('global-antiga');
    });

    it('nunca lê a chave de OUTRA conta', async () => {
      const p = banco({ nova: DEPOIS }, settings);
      await lerConfigDaConta(p, 'X', 'nova');
      const lidas = p.globalSetting.findUnique.mock.calls.map((c: any[]) => c[0].where.key);
      expect(lidas).toEqual(['X_nova']);
    });
  });
});

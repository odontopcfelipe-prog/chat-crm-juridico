import {
  DEFAULT_RETORNO_TEMPLATES,
  RETORNO_DISPARO_IDS,
  RETORNO_VARIAVEIS,
  diasRestantesNaJanela,
  isRetornoDisparoId,
  parseRetornoDisparoId,
  renderRetornoTemplate,
  retornoEtapaDoDia,
  retornoTemplateKey,
  retornoToggleKey,
  tempoDesde,
} from '@crm/shared';
import { RECALL_FAMILIES } from './recall-families';

const d = (s: string) => new Date(`${s}T12:00:00Z`);

describe('retorno-disparos (regras puras)', () => {
  it('12 toques: 4 tipos × antes/no dia/depois, ids que voltam inteiros', () => {
    expect(RETORNO_DISPARO_IDS).toHaveLength(12);
    expect(parseRetornoDisparoId('retorno_faceta_resina_no_dia')).toEqual({ familia: 'faceta_resina', etapa: 'no_dia' });
    expect(parseRetornoDisparoId('retorno_lentes_porcelana_depois')).toEqual({ familia: 'lentes_porcelana', etapa: 'depois' });
    expect(parseRetornoDisparoId('retorno_limpeza_antes')).toEqual({ familia: 'limpeza', etapa: 'antes' });
    expect(isRetornoDisparoId('retorno_limpeza_antes')).toBe(true);
    expect(isRetornoDisparoId('retorno_implante_antes')).toBe(false);
    expect(retornoToggleKey('retorno_limpeza_no_dia', 'T1')).toBe('RETORNO_LIMPEZA_NO_DIA_ENABLED_T1');
    expect(retornoTemplateKey('retorno_clareamento_depois')).toBe('RETORNO_CLAREAMENTO_DEPOIS_TEMPLATE');
  });

  it('os tipos do disparo são famílias do quadro Retornos (mesma chave)', () => {
    const keys = RECALL_FAMILIES.map((f) => f.key);
    for (const id of RETORNO_DISPARO_IDS) expect(keys).toContain(parseRetornoDisparoId(id).familia);
  });

  it('janelas: antes D-15..D-1 · no dia D0..D+6 · depois D+15..D+45 · fora = nada', () => {
    const prev = d('2027-01-13');
    expect(retornoEtapaDoDia(prev, d('2026-12-28'))).toBeNull(); // D-16
    expect(retornoEtapaDoDia(prev, d('2026-12-29'))).toBe('antes'); // D-15
    expect(retornoEtapaDoDia(prev, d('2027-01-12'))).toBe('antes'); // D-1
    expect(retornoEtapaDoDia(prev, d('2027-01-13'))).toBe('no_dia'); // D0
    expect(retornoEtapaDoDia(prev, d('2027-01-19'))).toBe('no_dia'); // D+6
    expect(retornoEtapaDoDia(prev, d('2027-01-20'))).toBeNull(); // D+7 (entre janelas)
    expect(retornoEtapaDoDia(prev, d('2027-01-28'))).toBe('depois'); // D+15
    expect(retornoEtapaDoDia(prev, d('2027-02-27'))).toBe('depois'); // D+45
    expect(retornoEtapaDoDia(prev, d('2027-02-28'))).toBeNull(); // D+46: saiu da régua
    // hora do dia não muda o dia (datas naive-UTC)
    expect(retornoEtapaDoDia(new Date('2027-01-13T00:30:00Z'), new Date('2027-01-13T20:59:00Z'))).toBe('no_dia');
    expect(diasRestantesNaJanela(prev, d('2027-01-13'), 'no_dia')).toBe(6);
    expect(diasRestantesNaJanela(prev, d('2027-01-12'), 'antes')).toBe(0);
  });

  it('tempoDesde em português', () => {
    expect(tempoDesde(d('2026-07-13'), d('2027-01-13'))).toBe('6 meses');
    expect(tempoDesde(d('2026-07-13'), d('2027-01-12'))).toBe('5 meses');
    expect(tempoDesde(d('2026-01-10'), d('2027-01-10'))).toBe('1 ano');
    expect(tempoDesde(d('2025-10-01'), d('2027-01-02'))).toBe('1 ano e 3 meses');
    expect(tempoDesde(d('2024-01-01'), d('2026-02-01'))).toBe('2 anos e 1 mês');
    expect(tempoDesde(d('2026-12-01'), d('2027-01-15'))).toBe('45 dias');
    expect(tempoDesde(d('2027-01-14'), d('2027-01-15'))).toBe('1 dia');
  });

  it('textos-padrão: todos existem, só usam variáveis conhecidas e saem preenchidos', () => {
    const conhecidas = new Set(RETORNO_VARIAVEIS.map((v) => v.key));
    for (const id of RETORNO_DISPARO_IDS) {
      const t = DEFAULT_RETORNO_TEMPLATES[id];
      expect(t && t.length).toBeTruthy();
      for (const m of t.matchAll(/\{(\w+)\}/g)) expect(conhecidas).toContain(m[1]);
      expect(t).toContain('{tempo}'); // todo toque informa há quanto tempo foi feito
      const out = renderRetornoTemplate(t, {
        nome: 'Ana', tempo: '6 meses', data_ultima: '13/07/2026', data_prevista: '13/01/2027', procedimento: 'limpeza', clinica: 'Clínica X',
      });
      expect(out).not.toMatch(/\{\w+\}/);
      expect(out.length).toBeLessThan(700); // cabe numa bolha de WhatsApp sem virar textão
    }
    // "depois" sempre dá a saída de quem já fez em outro lugar
    for (const id of RETORNO_DISPARO_IDS.filter((i) => i.endsWith('_depois'))) {
      expect(DEFAULT_RETORNO_TEMPLATES[id]).toMatch(/outro lugar/);
    }
  });
});

/**
 * F1 — tipo de negócio (packages/shared/src/business-type.ts).
 *
 * Só o valor EXATO 'LABORATORIO' liga o caminho do laboratório. Qualquer outra
 * coisa — ausente, vazio, minúsculo, com espaço, objeto, número — é CLÍNICA, e a
 * clínica continua vendo o 1º argumento de pickBt. A lista de rotas do lab
 * começa vazia: o laboratório nasce sem acesso a nada.
 */
import {
  ALLOWED_LAB_ROUTES,
  BT_CLINICA,
  BT_LABORATORIO,
  isLab,
  labAllowsRoute,
  normalizeBusinessType,
  pickBt,
  resolveBtFromJwtPayload,
} from '@crm/shared';

const NAO_LAB: unknown[] = [undefined, null, '', 'CLINICA', 'laboratorio', 'Laboratorio', 'LABORATORIO ', ' LABORATORIO', 'LAB', {}, [], 1, 0, true, { bt: 'LABORATORIO' }];

describe('business-type — na dúvida, clínica', () => {
  it.each(NAO_LAB.map((v) => [JSON.stringify(v) ?? String(v), v]))('pickBt(%s) devolve o texto da clínica', (_rotulo, bt) => {
    expect(pickBt(bt, 'clinica', 'lab')).toBe('clinica');
    expect(isLab(bt)).toBe(false);
    expect(normalizeBusinessType(bt)).toBe(BT_CLINICA);
  });

  it("só 'LABORATORIO' devolve o texto do laboratório", () => {
    expect(pickBt('LABORATORIO', 'clinica', 'lab')).toBe('lab');
    expect(isLab(BT_LABORATORIO)).toBe(true);
    expect(normalizeBusinessType('LABORATORIO')).toBe(BT_LABORATORIO);
  });

  it('pickBt devolve a MESMA referência do argumento escolhido', () => {
    const daClinica = { titulo: 'Pacientes' };
    const doLab = { titulo: 'Dentistas' };
    expect(pickBt(undefined, daClinica, doLab)).toBe(daClinica);
    expect(pickBt('LABORATORIO', daClinica, doLab)).toBe(doLab);
  });

  it('JWT sem o claim bt (todo token de clínica hoje) é clínica', () => {
    const tokenDeClinica = { sub: 'u1', email: 'a@exemplo.com', roles: ['ADMIN'], tenant_id: 't1' };
    expect(resolveBtFromJwtPayload(tokenDeClinica)).toBe(BT_CLINICA);
    expect(resolveBtFromJwtPayload(undefined)).toBe(BT_CLINICA);
    expect(resolveBtFromJwtPayload('LABORATORIO')).toBe(BT_CLINICA);
    expect(resolveBtFromJwtPayload({ bt: 'laboratorio' })).toBe(BT_CLINICA);
    expect(resolveBtFromJwtPayload({ ...tokenDeClinica, bt: 'LABORATORIO' })).toBe(BT_LABORATORIO);
  });
});

describe('labAllowsRoute — negação por padrão', () => {
  it('a lista de rotas do laboratório começa vazia', () => {
    expect(ALLOWED_LAB_ROUTES).toEqual([]);
    expect(Object.isFrozen(ALLOWED_LAB_ROUTES)).toBe(true);
  });

  it.each(['/', '/atendimento', '/atendimento/pacientes', '/atendimento/settings/disparos', '/admin', '', 'atendimento', undefined, null])(
    'com a lista vazia, %p fica fechada',
    (rota) => {
      expect(labAllowsRoute(rota)).toBe(false);
    },
  );

  it('com uma rota liberada, abre só ela e as filhas (prefixo de segmento)', () => {
    const lista = ['/atendimento/pacientes/'];
    expect(labAllowsRoute('/atendimento/pacientes', lista)).toBe(true);
    expect(labAllowsRoute('/atendimento/pacientes/123?aba=ficha', lista)).toBe(true);
    expect(labAllowsRoute('/atendimento/pacientes-antigos', lista)).toBe(false);
    expect(labAllowsRoute('/atendimento', lista)).toBe(false);
  });
});

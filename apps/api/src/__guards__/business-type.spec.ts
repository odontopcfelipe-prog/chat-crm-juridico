/**
 * F1 — tipo de negócio (packages/shared/src/business-type.ts).
 *
 * Só o valor EXATO 'LABORATORIO' liga o caminho do laboratório. Qualquer outra
 * coisa — ausente, vazio, minúsculo, com espaço, objeto, número — é CLÍNICA, e a
 * clínica continua vendo o 1º argumento de pickBt. A lista de rotas do lab é
 * negação por padrão: só as telas da F4 abrem, e '/atendimento' e
 * '/atendimento/settings' são exatas (como prefixo abririam tudo embaixo).
 */
import {
  ALLOWED_LAB_ROUTES,
  BT_CLINICA,
  BT_LABORATORIO,
  decodeJwtPayload,
  isLab,
  labAllowsRoute,
  normalizeBusinessType,
  pickBt,
  resolveBtFromJwtPayload,
  resolveBtFromToken,
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
  it('retrato exato das rotas do laboratório (lista e entradas congeladas)', () => {
    expect(ALLOWED_LAB_ROUTES).toEqual([
      { path: '/atendimento', exact: true },
      '/atendimento/chat',
      '/atendimento/split',
      '/atendimento/dashboard',
      '/atendimento/caixa',
      '/atendimento/ponto',
      { path: '/atendimento/settings', exact: true },
      '/atendimento/settings/whatsapp',
      '/atendimento/settings/inboxes',
      '/atendimento/settings/canned-responses',
      '/atendimento/settings/notifications',
      '/atendimento/settings/identidade',
      '/atendimento/settings/ponto',
    ]);
    expect(Object.isFrozen(ALLOWED_LAB_ROUTES)).toBe(true);
    const objetos = ALLOWED_LAB_ROUTES.filter((e) => typeof e === 'object');
    expect(objetos).toHaveLength(2);
    for (const entrada of objetos) expect(Object.isFrozen(entrada)).toBe(true);
    expect(() => (ALLOWED_LAB_ROUTES as unknown as string[]).push('/atendimento/agenda')).toThrow();
  });

  it.each([
    '/',
    '/atendimento/pacientes',
    '/atendimento/pacientes/1',
    '/atendimento/agenda',
    '/atendimento/crm',
    '/atendimento/contacts',
    '/atendimento/tasks',
    '/atendimento/billing',
    '/atendimento/settings/disparos',
    '/atendimento/settings/users',
    '/atendimento/settings/ai',
    '/atendimento/dashboard-completo',
    '/atendimento/chatbot',
    '/atendimento-antigo',
    '/admin',
    '',
    'atendimento',
    'atendimento/chat',
    undefined,
    null,
    42,
  ])('fora da lista, %p fica fechada', (rota) => {
    expect(labAllowsRoute(rota)).toBe(false);
  });

  it("'/atendimento' é exata: abre o inbox e nada embaixo dele", () => {
    expect(labAllowsRoute('/atendimento')).toBe(true);
    expect(labAllowsRoute('/atendimento/')).toBe(true);
    expect(labAllowsRoute('/atendimento?x=1')).toBe(true);
    expect(labAllowsRoute('/atendimento#topo')).toBe(true);
    expect(labAllowsRoute('/atendimento/agenda')).toBe(false);
    expect(labAllowsRoute('/atendimento/pacientes/1')).toBe(false);
    expect(labAllowsRoute('/atendimento/crm')).toBe(false);
  });

  it("'/atendimento/settings' é exata: abre só o índice das configurações", () => {
    expect(labAllowsRoute('/atendimento/settings')).toBe(true);
    expect(labAllowsRoute('/atendimento/settings/')).toBe(true);
    expect(labAllowsRoute('/atendimento/settings?aba=1')).toBe(true);
    expect(labAllowsRoute('/atendimento/settings/ai')).toBe(false);
    expect(labAllowsRoute('/atendimento/settings/users')).toBe(false);
    // As subtelas liberadas entram pela própria entrada, não pelo índice.
    expect(labAllowsRoute('/atendimento/settings/whatsapp')).toBe(true);
    expect(labAllowsRoute('/atendimento/settings/ponto')).toBe(true);
  });

  it('as entradas de prefixo abrem a tela e as filhas, por segmento', () => {
    expect(labAllowsRoute('/atendimento/dashboard')).toBe(true);
    expect(labAllowsRoute('/atendimento/dashboard-completo')).toBe(false);
    expect(labAllowsRoute('/atendimento/ponto')).toBe(true);
    expect(labAllowsRoute('/atendimento/ponto/equipe')).toBe(true);
    expect(labAllowsRoute('/atendimento/chat/abc')).toBe(true);
    expect(labAllowsRoute('/atendimento/chat/abc?chatonly=1')).toBe(true);
    expect(labAllowsRoute('/atendimento/split')).toBe(true);
    expect(labAllowsRoute('/atendimento/caixa/')).toBe(true);
  });

  it('com uma rota liberada, abre só ela e as filhas (prefixo de segmento)', () => {
    const lista = ['/atendimento/pacientes/'];
    expect(labAllowsRoute('/atendimento/pacientes', lista)).toBe(true);
    expect(labAllowsRoute('/atendimento/pacientes/123?aba=ficha', lista)).toBe(true);
    expect(labAllowsRoute('/atendimento/pacientes-antigos', lista)).toBe(false);
    expect(labAllowsRoute('/atendimento', lista)).toBe(false);
  });

  it('entrada exata numa lista própria vale só para a própria rota', () => {
    const lista = [{ path: '/atendimento/pacientes/', exact: true as const }];
    expect(labAllowsRoute('/atendimento/pacientes', lista)).toBe(true);
    expect(labAllowsRoute('/atendimento/pacientes/?aba=ficha', lista)).toBe(true);
    expect(labAllowsRoute('/atendimento/pacientes/123', lista)).toBe(false);
    expect(labAllowsRoute('/atendimento', lista)).toBe(false);
    expect(labAllowsRoute('/atendimento', [])).toBe(false);
  });

  it('entrada torta (objeto sem exact: true, sem path, null, número) não abre nada', () => {
    const tortas = [{ path: '/atendimento' }, { path: '/atendimento', exact: 'true' }, { exact: true }, null, 7] as never[];
    expect(labAllowsRoute('/atendimento', tortas)).toBe(false);
    expect(labAllowsRoute('/atendimento/chat', tortas)).toBe(false);
  });
});

/** Segmento base64url de um valor (como o JWT grava), com ou sem o '=' do fim. */
function segmento(valor: unknown, comPadding = false): string {
  const url = Buffer.from(JSON.stringify(valor), 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_');
  return comPadding ? url : url.replace(/=+$/, '');
}
const jwt = (payload: unknown, comPadding = false) => `cabecalho.${segmento(payload, comPadding)}.assinatura`;

describe('resolveBtFromToken / decodeJwtPayload — o token que o web lê do localStorage', () => {
  it.each<[string, unknown]>([
    ['sem token', undefined],
    ['null', null],
    ['vazio', ''],
    ['sem payload', 'a.b'],
    ['um segmento só', 'abc'],
    ['lixo', '%%%.@@@.###'],
    ['payload que não é JSON', `x.${Buffer.from('nao e json').toString('base64')}.y`],
    ['bt minúsculo', jwt({ bt: 'laboratorio', tenant_id: 't1' })],
    ['bt com espaço', jwt({ bt: 'LABORATORIO ' })],
    ['bt aninhado', jwt({ user: { bt: 'LABORATORIO' } })],
    ['token de clínica (sem bt)', jwt({ sub: 'u1', roles: ['ADMIN'], tenant_id: 't1' })],
    ['payload é lista', jwt(['LABORATORIO'])],
    ['número no lugar do token', 123],
    ['objeto no lugar do token', { bt: 'LABORATORIO' }],
  ])('%s → clínica', (_rotulo, token) => {
    expect(resolveBtFromToken(token)).toBe(BT_CLINICA);
  });

  it("payload { bt: 'LABORATORIO' } → laboratório, com e sem padding", () => {
    const payload = { bt: 'LABORATORIO' };
    expect(segmento(payload, true)).toMatch(/=$/); // o caso com padding existe de fato
    expect(resolveBtFromToken(jwt(payload, true))).toBe(BT_LABORATORIO);
    expect(resolveBtFromToken(jwt(payload, false))).toBe(BT_LABORATORIO);
  });

  it('lê base64url (- e _) e devolve o payload inteiro', () => {
    const payload = { bt: 'LABORATORIO', tenant_id: 't-lab', x: '???>>>~~~' };
    expect(segmento(payload)).toMatch(/[-_]/); // o caso base64url existe de fato
    expect(decodeJwtPayload(jwt(payload))).toEqual(payload);
    expect(resolveBtFromToken(jwt(payload))).toBe(BT_LABORATORIO);
  });

  it('decodeJwtPayload: só objeto plano; o resto é null', () => {
    expect(decodeJwtPayload(jwt([1, 2]))).toBeNull();
    expect(decodeJwtPayload(jwt(1))).toBeNull();
    expect(decodeJwtPayload(jwt('LABORATORIO'))).toBeNull();
    expect(decodeJwtPayload(jwt(null))).toBeNull();
    expect(decodeJwtPayload(42)).toBeNull();
    expect(decodeJwtPayload({ bt: 'LABORATORIO' })).toBeNull();
    expect(decodeJwtPayload(undefined)).toBeNull();
    expect(decodeJwtPayload('a.b')).toBeNull();
    expect(decodeJwtPayload(jwt({ tenant_id: 't1' }))).toEqual({ tenant_id: 't1' });
  });
});

/**
 * F4 — acesso por tela com o tipo de negócio (canAccessRouteBt, de
 * packages/shared/src/business-type.ts), contra o retrato das clínicas
 * (canaccessroute.matrix.json, o mesmo do canaccessroute-matrix.spec).
 *
 *   - CLÍNICA (qualquer bt que não seja o valor exato 'LABORATORIO'): em todo
 *     par tela × setor, canAccessRouteBt é EXATAMENTE canAccessRoute — e bate
 *     com o retrato salvo. A casca da clínica não muda por causa do laboratório.
 *   - LABORATÓRIO: canAccessRoute E a lista de rotas do laboratório. Nenhuma
 *     tela fora da lista abre para setor nenhum.
 *
 * O spec lê o @crm/shared COMPILADO (dist): depois de mexer no shared, rode
 * `npm run build -w @crm/shared` antes.
 */
import * as fs from 'fs';
import * as path from 'path';
import {
  BT_LABORATORIO,
  canAccessRoute,
  canAccessRouteBt,
  labAllowsRoute,
  resolvePermissions,
  type Permission,
  type Sector,
} from '@crm/shared';

type Linha = Record<string, boolean>;
interface Matriz {
  setores: string[];
  rotas: Record<string, Linha>;
}

const MATRIZ = JSON.parse(fs.readFileSync(path.join(__dirname, 'canaccessroute.matrix.json'), 'utf8')) as Matriz;
const TELAS = Object.keys(MATRIZ.rotas);
const SETORES = MATRIZ.setores;

/** has() com o pacote padrão de permissões do setor (como o canaccessroute-matrix.spec). */
function temDoSetor(setor: string): (perm: Permission) => boolean {
  const perms = resolvePermissions(setor as Sector);
  return (p) => perms.has(p);
}

// Tudo que não é o valor exato 'LABORATORIO' é clínica.
const BT_DE_CLINICA: Array<[string, unknown]> = [
  ['undefined', undefined],
  ['null', null],
  ["''", ''],
  ["'CLINICA'", 'CLINICA'],
  ["'laboratorio'", 'laboratorio'],
  ['{}', {}],
  ['1', 1],
];

describe('canAccessRouteBt × retrato das clínicas (F4)', () => {
  it('o retrato tem as telas do web e os 6 setores', () => {
    // Sanidade: sem isto, um JSON vazio passaria sem comparar nada.
    expect(TELAS.length).toBeGreaterThan(20);
    expect(TELAS).toEqual(expect.arrayContaining(['/atendimento', '/atendimento/agenda', '/atendimento/settings']));
    expect(SETORES).toEqual(expect.arrayContaining(['recepcao', 'dentista', 'acd_asb', 'crc', 'financeiro', 'admin']));
  });

  it.each(BT_DE_CLINICA)('bt %s: em todo par tela × setor é exatamente canAccessRoute (e o retrato)', (_rotulo, bt) => {
    const diferentes: string[] = [];
    for (const setor of SETORES) {
      const has = temDoSetor(setor);
      for (const tela of TELAS) {
        const comBt = canAccessRouteBt(tela, has, bt);
        const semBt = canAccessRoute(tela, has);
        const retrato = MATRIZ.rotas[tela][setor];
        if (comBt !== semBt || (typeof retrato === 'boolean' && comBt !== retrato)) {
          diferentes.push(`${tela} × ${setor}: comBt=${comBt} canAccessRoute=${semBt} retrato=${retrato}`);
        }
      }
    }
    expect(diferentes).toEqual([]);
  });

  it("bt 'LABORATORIO': canAccessRoute E a lista do laboratório; nada fora da lista abre", () => {
    const errados: string[] = [];
    const abertasForaDaLista: string[] = [];
    for (const setor of SETORES) {
      const has = temDoSetor(setor);
      for (const tela of TELAS) {
        const lab = canAccessRouteBt(tela, has, BT_LABORATORIO);
        if (lab !== (canAccessRoute(tela, has) && labAllowsRoute(tela))) errados.push(`${tela} × ${setor}`);
        if (lab && !labAllowsRoute(tela)) abertasForaDaLista.push(`${tela} × ${setor}`);
      }
    }
    expect(errados).toEqual([]);
    expect(abertasForaDaLista).toEqual([]);
  });

  it('no laboratório, as telas de clínica ficam fechadas até para o admin', () => {
    const admin = temDoSetor('admin');
    for (const tela of ['/atendimento/agenda', '/atendimento/pacientes', '/atendimento/crm', '/atendimento/contacts', '/atendimento/settings/users', '/atendimento/settings/ai', '/atendimento/billing']) {
      expect(canAccessRoute(tela, admin)).toBe(true); // na clínica o admin abre
      expect(canAccessRouteBt(tela, admin, BT_LABORATORIO)).toBe(false);
    }
    // E as liberadas continuam abrindo para ele.
    for (const tela of ['/atendimento', '/atendimento/chat/abc', '/atendimento/dashboard', '/atendimento/caixa', '/atendimento/settings', '/atendimento/settings/whatsapp']) {
      expect(canAccessRouteBt(tela, admin, BT_LABORATORIO)).toBe(true);
    }
  });

  it('no laboratório, a lista não abre o que a permissão do setor fecha', () => {
    // O dentista (Protético) não tem view_chat: o inbox continua fechado para ele.
    const dentista = temDoSetor('dentista');
    expect(canAccessRoute('/atendimento', dentista)).toBe(false);
    expect(canAccessRouteBt('/atendimento', dentista, BT_LABORATORIO)).toBe(false);
    // A central do ponto exige manage_users mesmo estando na lista.
    const recepcao = temDoSetor('recepcao');
    expect(labAllowsRoute('/atendimento/ponto/equipe')).toBe(true);
    expect(canAccessRouteBt('/atendimento/ponto/equipe', recepcao, BT_LABORATORIO)).toBe(canAccessRoute('/atendimento/ponto/equipe', recepcao));
  });
});

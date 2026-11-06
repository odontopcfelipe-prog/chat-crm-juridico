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
    for (const tela of [
      '/atendimento/minha-agenda',
      '/atendimento/settings/appointment-markers',
      '/atendimento/settings/office',
      '/atendimento/fechamentos',
    ]) {
      expect(canAccessRoute(tela, admin)).toBe(true); // na clínica o admin abre
      expect(canAccessRouteBt(tela, admin, BT_LABORATORIO)).toBe(false);
    }
    // E as liberadas continuam abrindo para ele (os blocos de cada fase são os de business-type.ts).
    for (const tela of [
      '/atendimento',
      '/atendimento/chat/abc',
      '/atendimento/dashboard',
      '/atendimento/caixa',
      '/atendimento/billing',
      '/atendimento/settings',
      '/atendimento/settings/whatsapp',
      // [F5a]
      '/atendimento/pacientes',
      '/atendimento/pacientes/1',
      '/atendimento/contacts',
      // [/F5a]
      // [F5b]
      '/atendimento/financeiro',
      '/atendimento/financeiro/contas-a-pagar',
      '/atendimento/financeiro/boletos',
      '/atendimento/financeiro/validar',
      '/atendimento/financeiro/parcelas',
      '/atendimento/settings/payment-gateway',
      // [/F5b]
      // [F5c]
      '/atendimento/venda-rapida',
      '/atendimento/settings/procedures',
      '/atendimento/settings/patient-tags',
      '/atendimento/settings/users',
      '/atendimento/estoque',
      // [/F5c]
      // [F6a]
      '/atendimento/orcamentos',
      '/atendimento/orcamentos?status=SENT',
      '/atendimento/settings/quote-templates',
      // [/F6a]
      // [F7a]
      '/atendimento/agenda',
      '/atendimento/agenda?tab=tasks',
      '/atendimento/settings/disparos',
      // [/F7a]
      // [F9a]
      '/atendimento/passos-cad',
      // [/F9a]
      // [F12a]
      '/atendimento/crm',
      '/atendimento/settings/pipelines',
      '/atendimento/tasks',
      '/atendimento/settings/permissions',
      '/atendimento/settings/specialties',
      '/atendimento/relatorios',
      '/atendimento/financeiro/dashboard',
      '/atendimento/dashboard-completo',
      '/atendimento/progresso',
      '/atendimento/comissoes',
      '/atendimento/settings/commission-rules',
      '/atendimento/metas',
      '/atendimento/meu-jogo',
      '/atendimento/minha-comissao',
      '/atendimento/settings/contracts',
      '/atendimento/settings/nota-fiscal',
      '/atendimento/settings/quote-coupons',
      '/atendimento/settings/quotes-trash',
      '/atendimento/settings/disparos/campanhas',
      '/atendimento/settings/emails-automaticos',
      '/atendimento/settings/automations',
      '/atendimento/afiliados',
      '/atendimento/referrals',
      '/atendimento/influenciadores',
      '/atendimento/marketing/analytics',
      '/atendimento/settings/ai',
      // [/F12a]
    ]) {
      expect(canAccessRouteBt(tela, admin, BT_LABORATORIO)).toBe(true);
    }
  });

  // [F5a]
  it('no laboratório, o Protético (setor dentista) abre os clientes e não abre os contatos', () => {
    const dentista = temDoSetor('dentista');
    expect(canAccessRouteBt('/atendimento/pacientes', dentista, BT_LABORATORIO)).toBe(true);
    expect(canAccessRouteBt('/atendimento/pacientes/1', dentista, BT_LABORATORIO)).toBe(true);
    // Contatos e chat exigem view_chat, que o setor dentista não tem.
    expect(canAccessRouteBt('/atendimento/contacts', dentista, BT_LABORATORIO)).toBe(false);
    for (const setor of ['recepcao', 'crc', 'admin']) {
      expect(canAccessRouteBt('/atendimento/contacts', temDoSetor(setor), BT_LABORATORIO)).toBe(true);
    }
  });
  // [/F5a]

  // [F5b]
  it('no laboratório, financeiro e admin abrem o financeiro; o Protético, a recepção e a expedição não', () => {
    const telas = [
      '/atendimento/financeiro',
      '/atendimento/financeiro/contas-a-pagar',
      '/atendimento/financeiro/boletos',
      '/atendimento/financeiro/validar',
      '/atendimento/financeiro/parcelas',
    ];
    for (const setor of ['financeiro', 'admin']) {
      for (const tela of telas) expect(canAccessRouteBt(tela, temDoSetor(setor), BT_LABORATORIO)).toBe(true);
    }
    for (const setor of ['dentista', 'recepcao', 'acd_asb']) {
      for (const tela of telas) expect(canAccessRouteBt(tela, temDoSetor(setor), BT_LABORATORIO)).toBe(false);
    }
    // A configuração do gateway é só do admin.
    expect(canAccessRouteBt('/atendimento/settings/payment-gateway', temDoSetor('admin'), BT_LABORATORIO)).toBe(true);
    expect(canAccessRouteBt('/atendimento/settings/payment-gateway', temDoSetor('financeiro'), BT_LABORATORIO)).toBe(false);
  });
  // [/F5b]

  // [F5c]
  it('no laboratório, a venda rápida abre para admin, recepção e CRC e fica fechada para financeiro, expedição e Protético', () => {
    for (const setor of ['admin', 'recepcao', 'crc']) {
      expect(canAccessRouteBt('/atendimento/venda-rapida', temDoSetor(setor), BT_LABORATORIO)).toBe(true);
    }
    for (const setor of ['financeiro', 'acd_asb', 'dentista']) {
      expect(canAccessRouteBt('/atendimento/venda-rapida', temDoSetor(setor), BT_LABORATORIO)).toBe(false);
    }
    // Serviços, etiquetas e equipe: só o admin.
    for (const tela of ['/atendimento/settings/procedures', '/atendimento/settings/patient-tags', '/atendimento/settings/users']) {
      expect(canAccessRouteBt(tela, temDoSetor('admin'), BT_LABORATORIO)).toBe(true);
      expect(canAccessRouteBt(tela, temDoSetor('recepcao'), BT_LABORATORIO)).toBe(false);
    }
  });
  // [/F5c]

  // [F6a]
  it('no laboratório, o painel de orçamentos abre para quem cuida de propostas e os modelos só para o admin', () => {
    // Mesma regra da clínica (manage_proposals/view_proposals): admin, recepção, CRC e financeiro.
    for (const setor of ['admin', 'recepcao', 'crc', 'financeiro']) {
      expect(canAccessRouteBt('/atendimento/orcamentos', temDoSetor(setor), BT_LABORATORIO)).toBe(true);
      expect(canAccessRouteBt('/atendimento/orcamentos?status=SENT', temDoSetor(setor), BT_LABORATORIO)).toBe(true);
    }
    for (const setor of ['dentista', 'acd_asb']) {
      expect(canAccessRouteBt('/atendimento/orcamentos', temDoSetor(setor), BT_LABORATORIO)).toBe(false);
    }
    // Modelos de orçamento: tela de configuração, só o admin.
    expect(canAccessRouteBt('/atendimento/settings/quote-templates', temDoSetor('admin'), BT_LABORATORIO)).toBe(true);
    for (const setor of ['recepcao', 'crc', 'financeiro', 'dentista', 'acd_asb']) {
      expect(canAccessRouteBt('/atendimento/settings/quote-templates', temDoSetor(setor), BT_LABORATORIO)).toBe(false);
    }
    // Cada caso igual ao da clínica: a lista do laboratório não muda permissão nenhuma.
    for (const setor of ['admin', 'recepcao', 'crc', 'financeiro', 'dentista', 'acd_asb']) {
      for (const tela of ['/atendimento/orcamentos', '/atendimento/settings/quote-templates']) {
        expect(canAccessRouteBt(tela, temDoSetor(setor), BT_LABORATORIO)).toBe(canAccessRoute(tela, temDoSetor(setor)));
      }
    }
  });
  // [/F6a]

  // [F7a]
  it('no laboratório, a agenda e a Central abrem para cada setor igual à clínica', () => {
    for (const setor of ['admin', 'recepcao', 'crc', 'financeiro', 'dentista', 'acd_asb']) {
      const has = temDoSetor(setor);
      for (const tela of ['/atendimento/agenda', '/atendimento/agenda?tab=tasks', '/atendimento/settings/disparos']) {
        expect([setor, tela, canAccessRouteBt(tela, has, BT_LABORATORIO)]).toEqual([setor, tela, canAccessRoute(tela, has)]);
      }
    }
    // O Protético (setor dentista) e a Expedição veem a agenda (view_agenda).
    expect(canAccessRouteBt('/atendimento/agenda', temDoSetor('dentista'), BT_LABORATORIO)).toBe(true);
    expect(canAccessRouteBt('/atendimento/agenda', temDoSetor('acd_asb'), BT_LABORATORIO)).toBe(true);
    // A Central é tela de configuração: só o admin.
    expect(canAccessRouteBt('/atendimento/settings/disparos', temDoSetor('admin'), BT_LABORATORIO)).toBe(true);
    expect(canAccessRouteBt('/atendimento/settings/disparos', temDoSetor('recepcao'), BT_LABORATORIO)).toBe(false);
  });
  // [/F7a]

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

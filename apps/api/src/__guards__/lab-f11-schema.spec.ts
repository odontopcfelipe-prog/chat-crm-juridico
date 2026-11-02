/**
 * F11 do laboratório — a tabela de convites do cadastro de laboratório contra o
 * schema real (Prisma.dmmf).
 *
 * - guarda só o hash do código (token_hash obrigatório e único); nenhuma coluna
 *   com o código em si;
 * - não tem relação nenhuma: os ids são texto, então nenhuma tabela existente
 *   (User, Tenant, LabWaitlistEntry) ganha campo, e apagar uma inscrição da lista
 *   de espera continua funcionando.
 */
import { Prisma } from '@crm/shared';

const models = Prisma.dmmf.datamodel.models;
const model = (nome: string) => {
  const m = models.find((x) => x.name === nome);
  if (!m) throw new Error(`model ${nome} não existe no schema`);
  return m;
};
const campo = (nomeModel: string, nomeCampo: string) => model(nomeModel).fields.find((f) => f.name === nomeCampo);

describe('F11 — LabSignupInvite', () => {
  it('token_hash: texto obrigatório e único', () => {
    expect(campo('LabSignupInvite', 'token_hash')).toMatchObject({ kind: 'scalar', type: 'String', isRequired: true, isUnique: true, isList: false });
  });

  it('nenhuma coluna com o código do convite (só o hash)', () => {
    const nomes = model('LabSignupInvite').fields.map((f) => f.name);
    for (const proibido of ['codigo', 'code', 'token', 'convite', 'link']) expect(nomes).not.toContain(proibido);
  });

  it('as colunas, sem nenhuma relação nem enum', () => {
    const m = model('LabSignupInvite');
    expect(m.fields.filter((f) => f.kind === 'object')).toEqual([]);
    expect(m.fields.filter((f) => f.kind === 'enum')).toEqual([]);
    expect(Object.fromEntries(m.fields.map((f) => [f.name, `${f.type}${f.isRequired ? '' : '?'}`]))).toEqual({
      id: 'String',
      token_hash: 'String',
      email: 'String?',
      lab_name: 'String?',
      waitlist_entry_id: 'String?',
      created_by_user_id: 'String?',
      created_at: 'DateTime',
      expires_at: 'DateTime',
      used_at: 'DateTime?',
      tenant_id: 'String?',
      revoked_at: 'DateTime?',
    });
    expect(m.fields.filter((f) => f.isId).map((f) => f.name)).toEqual(['id']);
  });

  it('User, Tenant e LabWaitlistEntry não ganharam campo do convite', () => {
    for (const nome of ['User', 'Tenant', 'LabWaitlistEntry']) {
      expect([nome, model(nome).fields.filter((f) => f.type === 'LabSignupInvite').map((f) => f.name)]).toEqual([nome, []]);
    }
    expect(models.flatMap((m) => m.fields.filter((f) => f.type === 'LabSignupInvite').map((f) => `${m.name}.${f.name}`))).toEqual([]);
  });
});

/**
 * F8 do laboratório — as 3 tabelas novas (fichas do cliente, do serviço e do caso)
 * contra o schema real (Prisma.dmmf).
 *
 * - cada uma é 1:1 com a tabela da clínica: a chave (@id) é a própria FK, que sai
 *   da tabela nova e apaga junto (Cascade);
 * - tenant_id é texto obrigatório; tipo e unidade são texto (nada de enum);
 * - Patient, Procedure e Quote só ganharam o campo de relação do Prisma (sem
 *   coluna) e o Tenant não ganhou nada;
 * - o paciente do caso é TEXTO, sem nenhuma relação com Patient.
 */
import { Prisma } from '@crm/shared';

const models = Prisma.dmmf.datamodel.models;
const model = (nome: string) => {
  const m = models.find((x) => x.name === nome);
  if (!m) throw new Error(`model ${nome} não existe no schema`);
  return m;
};
const campo = (nomeModel: string, nomeCampo: string) => model(nomeModel).fields.find((f) => f.name === nomeCampo);

const NOVAS = [
  { tabela: 'PatientLabProfile', chave: 'patient_id', relacao: 'patient', de: 'Patient', volta: 'lab_profile' },
  { tabela: 'ProcedureLabSpec', chave: 'procedure_id', relacao: 'procedure', de: 'Procedure', volta: 'lab_spec' },
  { tabela: 'QuoteLabCase', chave: 'quote_id', relacao: 'quote', de: 'Quote', volta: 'lab_case' },
] as const;

describe('F8 — tabelas das fichas do laboratório', () => {
  it.each(NOVAS)('$tabela: a chave é a FK para $de, com Cascade, e tenant_id é texto obrigatório', ({ tabela, chave, relacao, de }) => {
    expect(campo(tabela, chave)).toMatchObject({ kind: 'scalar', type: 'String', isId: true, isRequired: true });
    expect(model(tabela).fields.filter((f) => f.isId).map((f) => f.name)).toEqual([chave]);
    const rel = campo(tabela, relacao);
    expect(rel).toMatchObject({ kind: 'object', type: de, isList: false, isRequired: true, relationOnDelete: 'Cascade' });
    expect(rel!.relationFromFields).toEqual([chave]);
    expect(rel!.relationToFields).toEqual(['id']);
    expect(campo(tabela, 'tenant_id')).toMatchObject({ kind: 'scalar', type: 'String', isRequired: true, isList: false });
  });

  it.each(NOVAS)('$de.$volta é só relação do Prisma (sem coluna nova em $de)', ({ tabela, de, volta }) => {
    const f = campo(de, volta);
    expect(f).toMatchObject({ kind: 'object', type: tabela, isList: false, isRequired: false });
    expect(f!.relationFromFields ?? []).toEqual([]);
  });

  it('tipo do cliente e unidade do serviço são texto (sem enum)', () => {
    expect(campo('PatientLabProfile', 'kind')).toMatchObject({ kind: 'scalar', type: 'String', isRequired: true });
    expect(campo('ProcedureLabSpec', 'unit')).toMatchObject({ kind: 'scalar', type: 'String', isRequired: true });
    for (const { tabela } of NOVAS) {
      expect([tabela, model(tabela).fields.filter((f) => f.kind === 'enum').map((f) => f.name)]).toEqual([tabela, []]);
    }
  });

  it('ficha técnica: prazo obrigatório, garantia e material padrão opcionais', () => {
    expect(campo('ProcedureLabSpec', 'lead_time_days')).toMatchObject({ type: 'Int', isRequired: true });
    expect(campo('ProcedureLabSpec', 'warranty_days')).toMatchObject({ type: 'Int', isRequired: false });
    expect(campo('ProcedureLabSpec', 'default_material')).toMatchObject({ kind: 'scalar', type: 'String', isRequired: false });
    expect(campo('PatientLabProfile', 'requesting_dentists')).toMatchObject({ type: 'String', isList: true });
  });

  it('ficha do caso: o paciente do caso é texto opcional, sem relação nenhuma com Patient', () => {
    const caso = model('QuoteLabCase');
    expect(caso.fields.filter((f) => f.type === 'Patient')).toEqual([]);
    expect(campo('QuoteLabCase', 'patient_ref')).toMatchObject({ kind: 'scalar', type: 'String', isRequired: false, isList: false });
    // A única relação da tabela é com o orçamento.
    expect(caso.fields.filter((f) => f.kind === 'object').map((f) => f.type)).toEqual(['Quote']);
  });

  it('as tabelas novas não se ligam ao Tenant (o Tenant fica intocado)', () => {
    for (const { tabela } of NOVAS) {
      expect([tabela, model(tabela).fields.filter((f) => f.type === 'Tenant').map((f) => f.name)]).toEqual([tabela, []]);
    }
    const novasNoTenant = model('Tenant').fields.filter((f) => NOVAS.some((n) => n.tabela === f.type));
    expect(novasNoTenant).toEqual([]);
  });
});

/**
 * F8 do laboratório — Ativo/Inativo pelo último orçamento e a busca pelo perfil do
 * cliente, contra o Postgres DE VERDADE (só no CI).
 *
 * O Prisma só confere some/none/is em relação na hora de executar: aqui os where de
 * atividade-do-laboratorio.ts rodam num banco descartável, com os 6 casos da regra:
 *   - orçamento há 10 dias → Ativo;
 *   - só orçamento há 120 dias → Inativo;
 *   - sem orçamento e cadastro há 10 dias → Ativo;
 *   - sem orçamento e cadastro há 200 dias → Inativo;
 *   - só orçamento apagado (recente) → conta como sem orçamento → Inativo;
 *   - arquivado com orçamento recente → Arquivado.
 * E confere: Ativos ∩ Inativos = vazio; Ativos + Inativos + Arquivados = total; a
 * busca por CRO e por razão social acha o cliente certo.
 *
 * Roda SÓ no job do CI (banco ci@localhost:5432/ci, recriado a cada execução).
 * Em qualquer outra máquina é pulado — nunca encosta em banco de clínica.
 */
import { PrismaClient } from '@crm/shared';
import { PatientsService } from '../patients/patients.service';

const BANCO_DO_CI = process.env.CI === 'true' && /^postgresql:\/\/ci:ci@localhost:5432\/ci(\?|$)/.test(process.env.DATABASE_URL ?? '');
const descrever = BANCO_DO_CI ? describe : describe.skip;

const LAB = '00000000-0000-0000-0000-0000000a71b1';
const DIA = 86_400_000;

descrever('atividade e busca do laboratório no Postgres do CI', () => {
  let prisma: PrismaClient;
  let svc: PatientsService;
  let usuario = '';
  const ids: Record<string, string> = {};

  const diasAtras = (n: number) => new Date(Date.now() - n * DIA);

  beforeAll(async () => {
    prisma = new PrismaClient();
    svc = new PatientsService(prisma as any, {} as any, {} as any, {} as any, {} as any, {} as any);
    await prisma.tenant.upsert({ where: { id: LAB }, create: { id: LAB, name: 'Laboratório do teste da atividade' }, update: {} });
    const u = await prisma.user.create({ data: { name: 'Atividade', email: 'atividade-lab@exemplo.test', password_hash: 'x', tenant_id: LAB } });
    usuario = u.id;

    const cadastro = async (chave: string, criado: number, status = 'ACTIVE') => {
      const p = await prisma.patient.create({ data: { tenant_id: LAB, name: `Cliente Atividade ${chave}`, status, created_at: diasAtras(criado) } });
      ids[chave] = p.id;
      return p.id;
    };
    const orcamento = (patient_id: string, criado: number, apagado = false) =>
      prisma.quote.create({
        data: { patient_id, created_by_user_id: usuario, created_at: diasAtras(criado), deleted_at: apagado ? diasAtras(1) : null },
      });

    const orc10 = await cadastro('orc-10', 400);
    await orcamento(orc10, 10);
    await orcamento(orc10, 300);
    const orc120 = await cadastro('orc-120', 400);
    await orcamento(orc120, 120);
    await cadastro('novo-10', 10);
    await cadastro('velho-200', 200);
    const soApagado = await cadastro('so-apagado', 200);
    await orcamento(soApagado, 5, true);
    const arquivado = await cadastro('arquivado', 10, 'ARCHIVED');
    await orcamento(arquivado, 2);

    await prisma.patientLabProfile.create({
      data: { patient_id: orc10, tenant_id: LAB, kind: 'CLINICA', cro_number: '98765', cro_uf: 'AL', legal_name: 'Razão Exemplo Atividade Ltda', clinic_name: 'Sorriso Exemplo' },
    });
    await prisma.patientLabProfile.create({
      data: { patient_id: orc120, tenant_id: LAB, kind: 'DENTISTA', cro_number: '1234', cro_uf: 'SE' },
    });
  });

  afterAll(async () => {
    // Cadastro apagado leva orçamentos e perfil junto (onDelete Cascade).
    await prisma.patient.deleteMany({ where: { tenant_id: LAB } });
    await prisma.user.deleteMany({ where: { id: usuario } });
    await prisma.tenant.deleteMany({ where: { id: LAB } });
    await prisma.$disconnect();
  });

  const nomes = (r: { data: any[] }) => r.data.map((p) => Object.keys(ids).find((k) => ids[k] === p.id)).sort();

  it('os 6 casos: selo, baldes e último orçamento (o apagado não conta)', async () => {
    const todos = await svc.findAll(LAB, { lab: true, limit: 500 });
    const selo = Object.fromEntries(todos.data.map((p: any) => [Object.keys(ids).find((k) => ids[k] === p.id), p.activity_status]));
    expect(selo).toEqual({
      'orc-10': 'ACTIVE',
      'orc-120': 'INACTIVE',
      'novo-10': 'ACTIVE',
      'velho-200': 'INACTIVE',
      'so-apagado': 'INACTIVE',
      arquivado: 'ARCHIVED',
    });
    const semOrcamento = todos.data.filter((p: any) => p.ultimo_orcamento_em === null).map((p: any) => p.id).sort();
    expect(semOrcamento).toEqual([ids['novo-10'], ids['velho-200'], ids['so-apagado']].sort());
    const perfil = todos.data.find((p: any) => p.id === ids['orc-10']).lab_profile;
    expect(perfil).toEqual({ kind: 'CLINICA', cro_number: '98765', cro_uf: 'AL', clinic_name: 'Sorriso Exemplo', legal_name: 'Razão Exemplo Atividade Ltda' });

    const ativos = await svc.findAll(LAB, { lab: true, activity: 'ACTIVE', limit: 500 });
    const inativos = await svc.findAll(LAB, { lab: true, activity: 'INACTIVE', limit: 500 });
    const arquivados = await svc.findAll(LAB, { lab: true, activity: 'ARCHIVED', limit: 500 });
    expect(nomes(ativos)).toEqual(['novo-10', 'orc-10']);
    expect(nomes(inativos)).toEqual(['orc-120', 'so-apagado', 'velho-200']);
    expect(nomes(arquivados)).toEqual(['arquivado']);

    // Ativos ∩ Inativos = vazio; o selo de cada balde bate com o filtro.
    const a = new Set(ativos.data.map((p: any) => p.id));
    expect(inativos.data.filter((p: any) => a.has(p.id))).toEqual([]);
    expect(ativos.data.every((p: any) => p.activity_status === 'ACTIVE')).toBe(true);
    expect(inativos.data.every((p: any) => p.activity_status === 'INACTIVE')).toBe(true);
  });

  it('getStats do laboratório: Ativos + Inativos + Arquivados = total', async () => {
    const s = await svc.getStats(LAB, null, true);
    expect(s).toEqual(expect.objectContaining({ total: 6, active: 2, inactive: 3, archived: 1 }));
    expect(s.active + s.inactive + s.archived).toBe(s.total);
  });

  it('busca por CRO (3 ou mais dígitos) e por razão social acha o cliente certo', async () => {
    expect(nomes(await svc.findAll(LAB, { lab: true, search: 'CRO-AL 98765', limit: 500 }))).toEqual(['orc-10']);
    expect(nomes(await svc.findAll(LAB, { lab: true, search: 'razão exemplo atividade', limit: 500 }))).toEqual(['orc-10']);
    expect(nomes(await svc.findAll(LAB, { lab: true, search: 'Sorriso Exemplo', limit: 500 }))).toEqual(['orc-10']);
    expect(nomes(await svc.findAll(LAB, { lab: true, search: '1234', limit: 500 }))).toEqual(['orc-120']);
    // Menos de 3 dígitos não busca CRO.
    expect(nomes(await svc.findAll(LAB, { lab: true, search: '98', limit: 500 }))).toEqual([]);
    // Sem lab, a busca da clínica não olha o perfil do cliente.
    expect(nomes(await svc.findAll(LAB, { search: 'CRO-AL 98765', limit: 500 }))).toEqual([]);
  });
});

/**
 * F8 do laboratório — lista de clientes e cartões (PatientsService.findAll e getStats).
 *
 * CLÍNICA (retrato escrito ANTES da mudança e conferido no código de antes): o
 * where de Ativo/Inativo/Arquivado (12 meses pelo último atendimento, ou pelo
 * cadastro), a busca com os mesmos campos e a mesma ordem, o mesmo include, as
 * mesmas chaves em cada linha, as 5 contagens do getStats e NENHUMA leitura a
 * mais (nada de quote.groupBy, tenantBusinessProfile ou tenantSetting).
 *
 * LABORATÓRIO (lab: true): Inativo = sem orçamento NÃO apagado há 90 dias; quem
 * nunca teve orçamento conta pela data do cadastro. A busca ganha CRO (3 ou mais
 * dígitos), nome fantasia e razão social no FIM do OR. O selo sai de um único
 * quote.groupBy. A linha ganha lab_profile e ultimo_orcamento_em.
 *
 * Prisma gravador (sem banco) e relógio fixo. O some/none em relação só é
 * validado em execução: isso fica no __guards__/patient-activity.db.spec.ts.
 */
import { BT_LABORATORIO, DIAS_SEM_ORCAMENTO_PARA_INATIVO, __limparCacheLabTenants } from '@crm/shared';
import { PatientsService } from './patients.service';
import { PatientsController } from './patients.controller';
import { ownPatientsWhere } from '../auth/patient-scope';
import {
  atividadeDoLaboratorioWhere,
  buscaDoLaboratorio,
  corteDoLaboratorio,
  includeDoLaboratorio,
  statusDoLaboratorio,
} from './atividade-do-laboratorio';

const AGORA = new Date('2026-11-01T15:00:00.000Z');
const CONTA = 'conta-exemplo-1';
const DIA = 86_400_000;

/** Corte da clínica: cópia de inactiveCutoff (12 meses, setMonth). */
function corteDaClinica(): Date {
  const d = new Date(AGORA);
  d.setMonth(d.getMonth() - 12);
  return d;
}

/** Cópia literal de activityWhere (patients.service.ts). */
function atividadeDaClinica(bucket: 'ACTIVE' | 'INACTIVE', cutoff: Date) {
  if (bucket === 'ACTIVE') {
    return {
      status: { not: 'ARCHIVED' },
      OR: [{ last_visit_at: { gte: cutoff } }, { last_visit_at: null, created_at: { gte: cutoff } }],
    };
  }
  return {
    status: { not: 'ARCHIVED' },
    OR: [{ last_visit_at: { lt: cutoff } }, { last_visit_at: null, created_at: { lt: cutoff } }],
  };
}

const INCLUDE_DA_CLINICA = {
  primary_dentist: { select: { id: true, name: true, email: true } },
  tags: { include: { tag: true } },
  lead: { select: { profile_picture_url: true, origin: true } },
  referred_by_patient: { select: { name: true } },
  _count: { select: { anamneses: true, treatment_plans: true, appointments: true } },
};

type Chamada = { modelo: string; metodo: string; args: any };

/** Prisma gravador: toda chamada a qualquer modelo fica em `chamadas`. */
function gravador(linhas: any[] = [], grupos: any[] = []) {
  const chamadas: Chamada[] = [];
  const respostas: Record<string, (args: any) => any> = {
    'patient.findMany': () => linhas,
    'patient.count': () => linhas.length,
    'quote.groupBy': () => grupos,
  };
  const prisma: any = new Proxy(
    {},
    {
      get(_alvo, modelo: string) {
        if (typeof modelo !== 'string' || modelo === 'then') return undefined;
        return new Proxy(
          {},
          {
            get(_m, metodo: string) {
              if (typeof metodo !== 'string' || metodo === 'then') return undefined;
              return async (args: any) => {
                chamadas.push({ modelo, metodo, args });
                const r = respostas[`${modelo}.${metodo}`];
                return r ? r(args) : null;
              };
            },
          },
        );
      },
    },
  );
  const svc = new PatientsService(prisma, {} as any, {} as any, {} as any, {} as any, {} as any);
  const de = (modelo: string, metodo?: string) =>
    chamadas.filter((c) => c.modelo === modelo && (metodo === undefined || c.metodo === metodo));
  return { svc: svc as any, chamadas, de };
}

function linha(over: Record<string, any> = {}): Record<string, any> {
  return {
    id: 'pac-1',
    name: 'Cadastro Exemplo',
    status: 'ACTIVE',
    last_visit_at: null,
    created_at: new Date(AGORA.getTime() - 10 * DIA),
    tenant_id: CONTA,
    lead: { profile_picture_url: null, origin: null },
    referred_by_patient: null,
    tags: [],
    primary_dentist: null,
    _count: { anamneses: 0, treatment_plans: 0, appointments: 0 },
    ...over,
  };
}

beforeEach(() => {
  jest.useFakeTimers({ now: AGORA, doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] });
});
afterEach(() => {
  jest.useRealTimers();
});

describe('CLÍNICA — findAll e getStats como antes da F8', () => {
  const variantes: Array<[string, Record<string, any>]> = [
    ['sem lab', {}],
    ['com lab:false', { lab: false }],
  ];

  describe.each(variantes)('%s', (_nome, extra) => {
    it.each([['ACTIVE'], ['INACTIVE']] as const)('activity %s: where literal de findMany e count (12 meses)', async (bucket) => {
      const g = gravador([linha()]);
      await g.svc.findAll(CONTA, { activity: bucket, ...extra });
      const esperado = { AND: [{ tenant_id: CONTA }, atividadeDaClinica(bucket, corteDaClinica())] };
      const [findMany] = g.de('patient', 'findMany');
      const [count] = g.de('patient', 'count');
      expect(findMany.args.where).toEqual(esperado);
      expect(count.args.where).toEqual(esperado);
      expect(findMany.args.orderBy).toEqual([{ name: 'asc' }, { id: 'asc' }]);
      expect(findMany.args.skip).toBe(0);
      expect(findMany.args.take).toBe(20);
    });

    it('activity ARCHIVED: o status salvo', async () => {
      const g = gravador([linha({ status: 'ARCHIVED' })]);
      await g.svc.findAll(CONTA, { activity: 'ARCHIVED', ...extra });
      const esperado = { AND: [{ tenant_id: CONTA }, { status: 'ARCHIVED' }] };
      expect(g.de('patient', 'findMany')[0].args.where).toEqual(esperado);
      expect(g.de('patient', 'count')[0].args.where).toEqual(esperado);
    });

    it.each([
      ['com contato', true],
      ['sem contato', false],
    ])('busca %s: o OR com os campos e a ordem de antes, nos dois baldes', async (_n, contactSearch) => {
      const g = gravador([linha()]);
      await g.svc.findAll(CONTA, { search: 'Exe 12345', contactSearch, ...extra });
      const termo = 'Exe 12345';
      const searchOr = {
        OR: [
          { name: { contains: termo, mode: 'insensitive' } },
          ...(contactSearch ? [{ phone: { contains: termo } }] : []),
          { cpf: { contains: termo } },
          ...(contactSearch ? [{ email: { contains: termo, mode: 'insensitive' } }] : []),
          { record_number: { contains: termo, mode: 'insensitive' } },
          { tags: { some: { tag: { name: { contains: termo, mode: 'insensitive' } } } } },
        ],
      };
      const prefixo = { name: { startsWith: termo, mode: 'insensitive' } };
      const prefixWhere = { AND: [{ tenant_id: CONTA }, prefixo] };
      const restWhere = { AND: [{ tenant_id: CONTA }, searchOr, { NOT: prefixo }] };
      expect(g.de('patient', 'count').map((c) => c.args.where)).toEqual([prefixWhere, restWhere]);
      // O gravador conta 1 em cada balde: tier 1 leva 1 linha e o tier 2 o resto da página.
      const ordem = [{ name: 'asc' }, { id: 'asc' }];
      expect(g.de('patient', 'findMany').map((c) => c.args)).toEqual([
        { where: prefixWhere, orderBy: ordem, skip: 0, take: 1, include: INCLUDE_DA_CLINICA },
        { where: restWhere, orderBy: ordem, skip: 0, take: 19, include: INCLUDE_DA_CLINICA },
      ]);
    });

    it('include idêntico, nenhuma leitura a mais e as linhas sem chave nova', async () => {
      const g = gravador([linha(), linha({ id: 'pac-2', last_visit_at: new Date(AGORA.getTime() - 400 * DIA) })]);
      const r = await g.svc.findAll(CONTA, { ...extra });
      expect(g.de('patient', 'findMany')[0].args.include).toEqual(INCLUDE_DA_CLINICA);
      expect(g.chamadas.map((c) => `${c.modelo}.${c.metodo}`).sort()).toEqual(['patient.count', 'patient.findMany']);
      expect(g.de('quote')).toEqual([]);
      expect(g.de('tenantBusinessProfile')).toEqual([]);
      expect(g.de('tenantSetting')).toEqual([]);
      const chaves = Object.keys(linha()).concat(['activity_status', 'origem']).sort();
      for (const l of r.data) expect(Object.keys(l).sort()).toEqual(chaves);
      expect(r.data.map((l: any) => l.activity_status)).toEqual(['ACTIVE', 'INACTIVE']);
      expect(r).toEqual(expect.objectContaining({ total: 2, page: 1, totalPages: 1 }));
    });

    it.each([
      ['sem carteira', null],
      ['com carteira', 'usuario-exemplo-1'],
    ])('getStats %s: as 5 contagens com os mesmos where', async (_n, owner) => {
      const g = gravador([linha()]);
      const r = await (extra.lab === false ? g.svc.getStats(CONTA, owner, false) : g.svc.getStats(CONTA, owner));
      const base = owner ? { tenant_id: CONTA, AND: [ownPatientsWhere(owner)] } : { tenant_id: CONTA };
      const c = corteDaClinica();
      expect(g.chamadas.map((x) => ({ m: `${x.modelo}.${x.metodo}`, where: x.args.where }))).toEqual([
        { m: 'patient.count', where: base },
        { m: 'patient.count', where: { ...base, ...atividadeDaClinica('ACTIVE', c) } },
        { m: 'patient.count', where: { ...base, ...atividadeDaClinica('INACTIVE', c) } },
        { m: 'patient.count', where: { ...base, status: 'ARCHIVED' } },
        { m: 'patient.count', where: { ...base, treatment_plans: { some: { status: 'ACTIVE' } } } },
      ]);
      expect(Object.keys(r)).toEqual(['total', 'active', 'inactive', 'archived', 'with_active_plan']);
    });
  });
});

describe('LABORATÓRIO — regra dos 90 dias sem orçamento', () => {
  const corte = new Date(AGORA.getTime() - DIAS_SEM_ORCAMENTO_PARA_INATIVO * DIA);

  it('corteDoLaboratorio = agora menos DIAS_SEM_ORCAMENTO_PARA_INATIVO dias', () => {
    expect(DIAS_SEM_ORCAMENTO_PARA_INATIVO).toBe(90);
    expect(corteDoLaboratorio(AGORA)).toEqual(corte);
    expect(corteDoLaboratorio()).toEqual(corte);
  });

  it('where ACTIVE e INACTIVE exatos (os dois baldes repartem o não arquivado)', () => {
    expect(atividadeDoLaboratorioWhere('ACTIVE', corte)).toEqual({
      status: { not: 'ARCHIVED' },
      OR: [
        { quotes: { some: { deleted_at: null, created_at: { gte: corte } } } },
        { quotes: { none: { deleted_at: null } }, created_at: { gte: corte } },
      ],
    });
    expect(atividadeDoLaboratorioWhere('INACTIVE', corte)).toEqual({
      status: { not: 'ARCHIVED' },
      quotes: { none: { deleted_at: null, created_at: { gte: corte } } },
      OR: [{ quotes: { some: { deleted_at: null } } }, { created_at: { lt: corte } }],
    });
  });

  it.each([['ACTIVE'], ['INACTIVE']] as const)('findAll activity %s: where do laboratório em findMany e count', async (bucket) => {
    const g = gravador([linha()]);
    await g.svc.findAll(CONTA, { activity: bucket, lab: true });
    const esperado = { AND: [{ tenant_id: CONTA }, atividadeDoLaboratorioWhere(bucket, corte)] };
    expect(g.de('patient', 'findMany')[0].args.where).toEqual(esperado);
    expect(g.de('patient', 'count')[0].args.where).toEqual(esperado);
  });

  it('findAll ARCHIVED: o mesmo status salvo da clínica', async () => {
    const g = gravador([]);
    await g.svc.findAll(CONTA, { activity: 'ARCHIVED', lab: true });
    expect(g.de('patient', 'findMany')[0].args.where).toEqual({ AND: [{ tenant_id: CONTA }, { status: 'ARCHIVED' }] });
    // Lista vazia: nenhum groupBy.
    expect(g.de('quote', 'groupBy')).toEqual([]);
  });

  it('busca: o OR da clínica e, no FIM, nome fantasia, razão social e CRO (só com 3 ou mais dígitos)', async () => {
    expect(buscaDoLaboratorio('CRO-AL 12345')).toEqual([
      { lab_profile: { is: { clinic_name: { contains: 'CRO-AL 12345', mode: 'insensitive' } } } },
      { lab_profile: { is: { legal_name: { contains: 'CRO-AL 12345', mode: 'insensitive' } } } },
      { lab_profile: { is: { cro_number: { contains: '12345' } } } },
    ]);
    expect(buscaDoLaboratorio('Sorriso 12')).toEqual([
      { lab_profile: { is: { clinic_name: { contains: 'Sorriso 12', mode: 'insensitive' } } } },
      { lab_profile: { is: { legal_name: { contains: 'Sorriso 12', mode: 'insensitive' } } } },
    ]);
    const tudo = JSON.stringify(buscaDoLaboratorio('Exemplo 1234'));
    expect(tudo).not.toMatch(/contact_|requesting_dentists/);

    const g = gravador([linha()]);
    await g.svc.findAll(CONTA, { search: 'CRO-AL 12345', contactSearch: true, lab: true });
    const termo = 'CRO-AL 12345';
    const resto = g.de('patient', 'count')[1].args.where;
    // O tier 1 (prefixo do nome) não muda no laboratório.
    expect(g.de('patient', 'count')[0].args.where).toEqual({
      AND: [{ tenant_id: CONTA }, { name: { startsWith: termo, mode: 'insensitive' } }],
    });
    expect(resto.AND[1]).toEqual({
      OR: [
        { name: { contains: termo, mode: 'insensitive' } },
        { phone: { contains: termo } },
        { cpf: { contains: termo } },
        { email: { contains: termo, mode: 'insensitive' } },
        { record_number: { contains: termo, mode: 'insensitive' } },
        { tags: { some: { tag: { name: { contains: termo, mode: 'insensitive' } } } } },
        ...buscaDoLaboratorio(termo),
      ],
    });
    expect(g.de('patient', 'findMany')[0].args.include).toEqual({ ...INCLUDE_DA_CLINICA, ...includeDoLaboratorio });
  });

  it('include ganha só o lab_profile sem contato; um único groupBy com deleted_at:null', async () => {
    expect(includeDoLaboratorio).toEqual({
      lab_profile: { select: { kind: true, cro_number: true, cro_uf: true, clinic_name: true, legal_name: true } },
    });
    const g = gravador([linha({ id: 'a' }), linha({ id: 'b' })], []);
    await g.svc.findAll(CONTA, { lab: true });
    const grupos = g.de('quote', 'groupBy');
    expect(grupos).toHaveLength(1);
    expect(grupos[0].args).toEqual({
      by: ['patient_id'],
      where: { patient_id: { in: ['a', 'b'] }, deleted_at: null },
      _max: { created_at: true },
    });
    expect(g.chamadas.map((c) => `${c.modelo}.${c.metodo}`).sort()).toEqual(['patient.count', 'patient.findMany', 'quote.groupBy']);
  });

  it('selo: tabela-verdade dos 6 casos e as chaves novas da linha', async () => {
    const dias = (n: number) => new Date(AGORA.getTime() - n * DIA);
    const linhas = [
      linha({ id: 'orc-10', created_at: dias(400), lab_profile: null }),
      linha({ id: 'orc-120', created_at: dias(400), lab_profile: null }),
      linha({ id: 'novo-10', created_at: dias(10), lab_profile: null }),
      linha({ id: 'velho-200', created_at: dias(200), lab_profile: null }),
      // Só orçamento apagado: o groupBy (deleted_at:null) não traz nada → conta pelo cadastro.
      linha({ id: 'so-apagado', created_at: dias(200), lab_profile: null }),
      linha({
        id: 'arquivado',
        status: 'ARCHIVED',
        created_at: dias(10),
        lab_profile: { kind: 'CLINICA', cro_number: null, cro_uf: null, clinic_name: 'Sorriso', legal_name: 'Sorriso Ltda' },
      }),
    ];
    const grupos = [
      { patient_id: 'orc-10', _max: { created_at: dias(10) } },
      { patient_id: 'orc-120', _max: { created_at: dias(120) } },
      { patient_id: 'arquivado', _max: { created_at: dias(1) } },
    ];
    const g = gravador(linhas, grupos);
    const r = await g.svc.findAll(CONTA, { lab: true });
    const selo = Object.fromEntries(r.data.map((l: any) => [l.id, l.activity_status]));
    expect(selo).toEqual({
      'orc-10': 'ACTIVE',
      'orc-120': 'INACTIVE',
      'novo-10': 'ACTIVE',
      'velho-200': 'INACTIVE',
      'so-apagado': 'INACTIVE',
      arquivado: 'ARCHIVED',
    });
    const ultimo = Object.fromEntries(r.data.map((l: any) => [l.id, l.ultimo_orcamento_em]));
    expect(ultimo).toEqual({
      'orc-10': dias(10).toISOString(),
      'orc-120': dias(120).toISOString(),
      'novo-10': null,
      'velho-200': null,
      'so-apagado': null,
      arquivado: dias(1).toISOString(),
    });
    const chaves = Object.keys(linhas[0]).concat(['activity_status', 'origem', 'ultimo_orcamento_em']).sort();
    for (const l of r.data) expect(Object.keys(l).sort()).toEqual(chaves);
    expect(r.data.find((l: any) => l.id === 'arquivado').lab_profile).toEqual(linhas[5].lab_profile);

    // A mesma regra, direto na função pura.
    expect(statusDoLaboratorio({ status: 'ACTIVE', created_at: dias(400) }, dias(10), corte)).toBe('ACTIVE');
    expect(statusDoLaboratorio({ status: 'ACTIVE', created_at: dias(400) }, dias(120), corte)).toBe('INACTIVE');
    expect(statusDoLaboratorio({ status: 'ACTIVE', created_at: dias(10) }, null, corte)).toBe('ACTIVE');
    expect(statusDoLaboratorio({ status: 'ACTIVE', created_at: dias(200) }, null, corte)).toBe('INACTIVE');
    expect(statusDoLaboratorio({ status: 'ARCHIVED', created_at: dias(10) }, dias(1), corte)).toBe('ARCHIVED');
  });

  it.each([
    ['sem carteira', null],
    ['com carteira', 'usuario-exemplo-1'],
  ])('getStats %s: Ativos e Inativos pela regra dos 90 dias; o resto igual', async (_n, owner) => {
    const g = gravador([]);
    await g.svc.getStats(CONTA, owner, true);
    const base = owner ? { tenant_id: CONTA, AND: [ownPatientsWhere(owner)] } : { tenant_id: CONTA };
    expect(g.chamadas.map((x) => ({ m: `${x.modelo}.${x.metodo}`, where: x.args.where }))).toEqual([
      { m: 'patient.count', where: base },
      { m: 'patient.count', where: { ...base, ...atividadeDoLaboratorioWhere('ACTIVE', corte) } },
      { m: 'patient.count', where: { ...base, ...atividadeDoLaboratorioWhere('INACTIVE', corte) } },
      { m: 'patient.count', where: { ...base, status: 'ARCHIVED' } },
      { m: 'patient.count', where: { ...base, treatment_plans: { some: { status: 'ACTIVE' } } } },
    ]);
  });
});

describe('PatientsController — o portão sai do token, sem leitura nova', () => {
  function montar() {
    const svc = { findAll: jest.fn().mockResolvedValue({ data: [] }), getStats: jest.fn().mockResolvedValue({}) };
    const ctrl = new PatientsController(svc as any, {} as any, {} as any, {} as any);
    return { svc, ctrl };
  }
  const usuario = (bt?: string) => ({ id: 'usuario-exemplo-1', roles: ['ADMIN'], tenant_id: CONTA, ...(bt ? { bt } : {}) });

  beforeEach(() => __limparCacheLabTenants());

  it('clínica: lab:false no findAll e no getStats', async () => {
    const m = montar();
    await m.ctrl.findAll({ user: usuario() }, 'Exemplo');
    await m.ctrl.getStats({ user: usuario() });
    expect(m.svc.findAll.mock.calls[0][1]).toEqual(expect.objectContaining({ search: 'Exemplo', lab: false }));
    expect(m.svc.getStats.mock.calls[0]).toEqual([CONTA, null, false]);
  });

  it('laboratório: lab:true no findAll e no getStats', async () => {
    const m = montar();
    await m.ctrl.findAll({ user: usuario(BT_LABORATORIO) }, 'Exemplo');
    await m.ctrl.getStats({ user: usuario(BT_LABORATORIO) });
    expect(m.svc.findAll.mock.calls[0][1]).toEqual(expect.objectContaining({ search: 'Exemplo', lab: true }));
    expect(m.svc.getStats.mock.calls[0]).toEqual([CONTA, null, true]);
  });
});

/**
 * F1 — quem é laboratório (packages/shared/src/lab-tenants.ts).
 *
 * Sem laboratório (hoje), as varreduras de clínica recebem de volta EXATAMENTE
 * o que mandaram (mesma referência): nem a consulta ao banco muda. O cache faz
 * no máximo 1 consulta por minuto, e uma falha do banco nunca derruba quem
 * chamou. A forma do filtro por model é conferida contra o schema real
 * (Prisma.dmmf): OR com NULL só em tenant_id opcional; notIn direto em
 * obrigatório; via paciente quando o model não tem tenant_id.
 */
import {
  EXCLUI_LAB_FORMA,
  Prisma,
  __limparCacheLabTenants,
  algumLab,
  excludeLabWhere,
  getLabTenantIds,
  isLabTenant,
  isLabTenantCached,
  withoutLabTenants,
} from '@crm/shared';

const LAB = '00000000-0000-0000-0000-00000000a001';

function prismaFalso(linhas: Array<{ tenant_id: string }> | Error) {
  const findMany = jest.fn(async () => {
    if (linhas instanceof Error) throw linhas;
    return linhas;
  });
  return { prisma: { tenantBusinessProfile: { findMany } }, findMany };
}

beforeEach(() => {
  __limparCacheLabTenants();
  jest.useFakeTimers({ now: new Date('2026-10-20T15:00:00.000Z') });
});
afterEach(() => jest.useRealTimers());

describe('sem laboratório — tudo volta igual', () => {
  it('withoutLabTenants devolve o MESMO array', () => {
    const linhas = [{ tenant_id: 'a' }, { tenant_id: null }, {}];
    expect(withoutLabTenants(linhas, new Set())).toBe(linhas);
  });

  it.each(Object.keys(EXCLUI_LAB_FORMA))('excludeLabWhere(%s) devolve o MESMO where', (modelo) => {
    const where = { status: 'ATIVO' };
    expect(excludeLabWhere(modelo as keyof typeof EXCLUI_LAB_FORMA, where, new Set())).toBe(where);
    expect(excludeLabWhere(modelo as keyof typeof EXCLUI_LAB_FORMA, undefined, new Set())).toBeUndefined();
  });

  it('getLabTenantIds pergunta só pelos LABORATORIO e devolve vazio', async () => {
    const { prisma, findMany } = prismaFalso([]);
    const ids = await getLabTenantIds(prisma);
    expect(ids.size).toBe(0);
    expect(findMany).toHaveBeenCalledWith({ where: { business_type: 'LABORATORIO' }, select: { tenant_id: true } });
    expect(isLabTenantCached(LAB)).toBe(false);
  });
});

describe('cache de 60 s', () => {
  it('1 consulta por minuto; chamadas simultâneas dividem a mesma', async () => {
    const { prisma, findMany } = prismaFalso([{ tenant_id: LAB }]);
    await Promise.all([getLabTenantIds(prisma), getLabTenantIds(prisma), getLabTenantIds(prisma)]);
    expect(findMany).toHaveBeenCalledTimes(1);
    jest.setSystemTime(new Date('2026-10-20T15:00:59.000Z'));
    await getLabTenantIds(prisma);
    expect(findMany).toHaveBeenCalledTimes(1);
    jest.setSystemTime(new Date('2026-10-20T15:01:01.000Z'));
    await getLabTenantIds(prisma);
    expect(findMany).toHaveBeenCalledTimes(2);
  });

  it('isLabTenantCached lê o último conjunto carregado', async () => {
    expect(isLabTenantCached(LAB)).toBe(false);
    await getLabTenantIds(prismaFalso([{ tenant_id: LAB }]).prisma);
    expect(isLabTenantCached(LAB)).toBe(true);
    expect(isLabTenantCached('outro')).toBe(false);
    expect(isLabTenantCached('')).toBe(false);
    expect(isLabTenantCached(null)).toBe(false);
  });

  it('banco falhou: não lança, mantém o último conjunto e avisa', async () => {
    const avisos: string[] = [];
    await getLabTenantIds(prismaFalso([{ tenant_id: LAB }]).prisma);
    jest.setSystemTime(new Date('2026-10-20T15:02:00.000Z'));
    const falho = prismaFalso(new Error('relation "TenantBusinessProfile" does not exist'));
    const ids = await getLabTenantIds(falho.prisma, (m) => avisos.push(m));
    expect([...ids]).toEqual([LAB]);
    expect(avisos[0]).toContain('[lab-tenants] falha');
    // e não martela o banco: a falha também vale por 60 s
    await getLabTenantIds(falho.prisma, (m) => avisos.push(m));
    expect(falho.findMany).toHaveBeenCalledTimes(1);
  });

  it('banco falhou sem nunca ter carregado: conjunto vazio (clínica)', async () => {
    const ids = await getLabTenantIds(prismaFalso(new Error('timeout')).prisma, () => undefined);
    expect(ids.size).toBe(0);
  });

  it('falha SÍNCRONA não prende a consulta: depois de 60 s pergunta de novo', async () => {
    const quebrado = { tenantBusinessProfile: { findMany: jest.fn(() => { throw new Error('client sem o model'); }) } };
    expect((await getLabTenantIds(quebrado as any, () => undefined)).size).toBe(0);
    const bom = prismaFalso([{ tenant_id: LAB }]);
    jest.setSystemTime(new Date('2026-10-20T15:01:01.000Z'));
    expect([...(await getLabTenantIds(bom.prisma))]).toEqual([LAB]);
    expect(bom.findMany).toHaveBeenCalledTimes(1);
  });

  it('prisma ausente não lança e não prende', async () => {
    expect((await getLabTenantIds({} as any, () => undefined)).size).toBe(0);
    expect((await getLabTenantIds(undefined as any, () => undefined)).size).toBe(0);
    jest.setSystemTime(new Date('2026-10-20T15:01:01.000Z'));
    const bom = prismaFalso([{ tenant_id: LAB }]);
    expect([...(await getLabTenantIds(bom.prisma))]).toEqual([LAB]);
  });

  it('aviso que lança não derruba quem chamou', async () => {
    const ids = await getLabTenantIds(prismaFalso(new Error('x')).prisma, () => {
      throw new Error('logger quebrado');
    });
    expect(ids.size).toBe(0);
  });
});

describe('com um laboratório', () => {
  const labs = new Set([LAB]);

  it('withoutLabTenants tira só as linhas do lab (NULL e outras contas ficam)', () => {
    const linhas = [{ tenant_id: 'clinica' }, { tenant_id: LAB }, { tenant_id: null }, {}];
    expect(withoutLabTenants(linhas, labs)).toEqual([{ tenant_id: 'clinica' }, { tenant_id: null }, {}]);
    const porConversa = [{ conversa: { tenant_id: LAB } }, { conversa: { tenant_id: 'clinica' } }];
    expect(withoutLabTenants(porConversa, labs, (l) => l.conversa.tenant_id)).toEqual([{ conversa: { tenant_id: 'clinica' } }]);
  });

  it('excludeLabWhere: forma por model e o where original intacto', () => {
    const where = { status: 'ATIVO' };
    const copia = JSON.parse(JSON.stringify(where));
    expect(excludeLabWhere('lead', where, labs)).toEqual({
      AND: [{ status: 'ATIVO' }, { OR: [{ tenant_id: null }, { tenant_id: { notIn: [LAB] } }] }],
    });
    expect(excludeLabWhere('patient', where, labs)).toEqual({ AND: [{ status: 'ATIVO' }, { tenant_id: { notIn: [LAB] } }] });
    // F2 parte 2 — pesquisa pós-atendimento: tenant_id obrigatório, notIn direto.
    expect(excludeLabWhere('postCareSurvey', where, labs)).toEqual({ AND: [{ status: 'ATIVO' }, { tenant_id: { notIn: [LAB] } }] });
    expect(excludeLabWhere('quote', undefined, labs)).toEqual({ AND: [{}, { patient: { tenant_id: { notIn: [LAB] } } }] });
    expect(where).toEqual(copia);
  });
});

describe('isLabTenant e algumLab (F2)', () => {
  it('isLabTenant: sem id não consulta; com id usa o mesmo cache', async () => {
    const { prisma, findMany } = prismaFalso([{ tenant_id: LAB }]);
    for (const vazio of [null, undefined, '', 42, {}]) expect(await isLabTenant(prisma, vazio)).toBe(false);
    expect(findMany).not.toHaveBeenCalled();
    expect(await isLabTenant(prisma, LAB)).toBe(true);
    expect(await isLabTenant(prisma, 'clinica')).toBe(false);
    expect(findMany).toHaveBeenCalledTimes(1);
  });

  it('isLabTenant: banco falhou sem nunca ter carregado = clínica, sem lançar', async () => {
    const { prisma } = prismaFalso(new Error('db fora'));
    expect(await isLabTenant(prisma, LAB, () => undefined)).toBe(false);
  });

  it('algumLab: sem laboratório é false; null/undefined/texto vazio contam como clínica', () => {
    expect(algumLab(new Set(), [LAB])).toBe(false);
    const labs = new Set([LAB]);
    expect(algumLab(labs, [null, undefined, '', 'clinica'])).toBe(false);
    expect(algumLab(labs, [null, LAB])).toBe(true);
    expect(algumLab(labs, [])).toBe(false);
  });
});

describe('a forma de cada model bate com o schema', () => {
  const models = Prisma.dmmf.datamodel.models;
  const delegate = (nome: string) => nome.charAt(0).toLowerCase() + nome.slice(1);

  it.each(Object.entries(EXCLUI_LAB_FORMA))('%s → %s', (modelo, forma) => {
    const m = models.find((x) => delegate(x.name) === modelo);
    expect(m).toBeDefined();
    const tenant = m!.fields.find((f) => f.name === 'tenant_id');
    if (forma === 'tenant_opcional') {
      expect(tenant).toBeDefined();
      expect(tenant!.isRequired).toBe(false);
    } else if (forma === 'tenant_obrigatorio') {
      expect(tenant).toBeDefined();
      expect(tenant!.isRequired).toBe(true);
    } else {
      expect(tenant).toBeUndefined();
      const paciente = m!.fields.find((f) => f.name === 'patient');
      expect(paciente).toMatchObject({ kind: 'object', type: 'Patient', isList: false, isRequired: true });
      const tenantDoPaciente = models.find((x) => x.name === 'Patient')!.fields.find((f) => f.name === 'tenant_id');
      expect(tenantDoPaciente!.isRequired).toBe(true);
    }
  });

  it('TenantBusinessProfile: tenant_id é a chave e apaga junto com o Tenant', () => {
    const m = models.find((x) => x.name === 'TenantBusinessProfile')!;
    expect(m.fields.find((f) => f.name === 'tenant_id')).toMatchObject({ isId: true, isRequired: true });
    expect(m.fields.find((f) => f.name === 'business_type')).toMatchObject({ type: 'String', isRequired: true });
    expect(m.fields.find((f) => f.name === 'tenant')).toMatchObject({ type: 'Tenant', relationOnDelete: 'Cascade' });
    // A conta (Tenant) não ganhou coluna nova: só a relação do Prisma.
    const doTenant = models.find((x) => x.name === 'Tenant')!.fields.find((f) => f.name === 'business_profile');
    expect(doTenant).toMatchObject({ kind: 'object', type: 'TenantBusinessProfile', isList: false, isRequired: false });
    expect(doTenant!.relationFromFields ?? []).toEqual([]);
  });
});

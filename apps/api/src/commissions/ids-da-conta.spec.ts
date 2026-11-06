/**
 * Comissão, regra de comissão e meta: no laboratório, cada id informado precisa ser da
 * conta do token. A clínica grava como sempre, sem ler nenhum dos registros.
 *
 * Sem banco: o Prisma é um dublê; dados de exemplo (repositório público).
 */
import { BadRequestException, Logger, NotFoundException } from '@nestjs/common';
import { __limparCacheLabTenants } from '@crm/shared';
import { temPalavraDeClinica } from '../business-type/lab-vocab.interceptor';
import { CommissionRulesService } from './commission-rules.service';
import { CommissionsService } from './commissions.service';
import { GoalsService } from './goals.service';
import { LAB_COMISSAO_IDS } from './lab-jogo-textos';

const LAB = 'conta-lab';
const CLINICA = 'conta-clinica';

const daConta = (where: any) =>
  where.tenant_id === LAB || where.patient?.tenant_id === LAB || where.treatment_plan?.patient?.tenant_id === LAB;
const buscaDaConta = (certo: string) => jest.fn(async ({ where }: any) => (where.id === certo && daConta(where) ? { id: where.id } : null));

function montar() {
  const prisma: any = {
    tenantBusinessProfile: { findMany: jest.fn(async () => [{ tenant_id: LAB }]) },
    patient: { findFirst: jest.fn(async () => ({ id: 'pac' })) },
    user: { findFirst: buscaDaConta('prof-lab') },
    procedure: { findFirst: buscaDaConta('serv-lab') },
    treatmentPlanItem: { findFirst: buscaDaConta('item-lab') },
    quote: { findFirst: buscaDaConta('orc-lab'), findMany: jest.fn(async () => []) },
    commission: {
      create: jest.fn(async (a: any) => a.data),
      findFirst: jest.fn(),
    },
    commissionRule: {
      create: jest.fn(async (a: any) => a.data),
      findFirst: jest.fn(async () => ({ id: 'regra' })),
      update: jest.fn(async (a: any) => a.data),
    },
    goal: {
      create: jest.fn(async (a: any) => ({ id: 'meta', ...a.data })),
      findFirst: jest.fn(async () => ({ id: 'meta', metric: 'CUSTOM', period_start: new Date(), period_end: new Date(), scope: 'CLINIC' })),
      update: jest.fn(async (a: any) => a.data),
    },
  };
  return {
    prisma,
    comissoes: new CommissionsService(prisma),
    regras: new CommissionRulesService(prisma),
    metas: new GoalsService(prisma),
  };
}

const comissao = (over: Record<string, string> = {}) =>
  ({ professional_user_id: 'prof-lab', patient_id: 'pac', base_value: 100, amount: 10, ...over }) as any;
const regra = (over: Record<string, unknown> = {}) => ({ professional_user_id: 'prof-lab', percentage: 10, ...over }) as any;
const meta = (over: Record<string, string> = {}) =>
  ({ metric: 'CUSTOM', target_value: 1, period_start: '2030-01-01', period_end: '2030-02-01', ...over }) as any;
/** Edições da meta pela rota (o recálculo em segundo plano grava outros campos). */
const edicoesDaMeta = (prisma: any) => prisma.goal.update.mock.calls.filter((c: any[]) => 'professional_user_id' in c[0].data);

beforeEach(() => {
  __limparCacheLabTenants();
  for (const nivel of ['log', 'warn', 'error'] as const) jest.spyOn(Logger.prototype, nivel).mockImplementation(() => undefined);
});
afterEach(() => jest.restoreAllMocks());

describe('comissão', () => {
  it.each([
    ['professional_user_id', 'prof-outra', LAB_COMISSAO_IDS.profissional],
    ['procedure_id', 'serv-outra', LAB_COMISSAO_IDS.servico],
    ['treatment_plan_item_id', 'item-outra', LAB_COMISSAO_IDS.itemDeTrabalho],
    ['quote_id', 'orc-outra', LAB_COMISSAO_IDS.orcamento],
  ])('laboratório: %s de outra conta é recusado com mensagem clara', async (campo, valor, mensagem) => {
    const { comissoes, prisma } = montar();
    const e = await comissoes.create(LAB, comissao({ [campo]: valor })).catch((x) => x);
    expect(e).toBeInstanceOf(BadRequestException);
    expect(e.message).toBe(mensagem);
    expect(prisma.commission.create).not.toHaveBeenCalled();
  });

  it('laboratório: com todos os ids da conta grava; a busca filtra pela conta do token', async () => {
    const { comissoes, prisma } = montar();
    await comissoes.create(LAB, comissao({ procedure_id: 'serv-lab', treatment_plan_item_id: 'item-lab', quote_id: 'orc-lab' }));
    expect(prisma.commission.create).toHaveBeenCalledTimes(1);
    expect(prisma.user.findFirst.mock.calls[0][0].where).toEqual({ id: 'prof-lab', tenant_id: LAB });
    expect(prisma.treatmentPlanItem.findFirst.mock.calls[0][0].where).toEqual({ id: 'item-lab', treatment_plan: { patient: { tenant_id: LAB } } });
    expect(prisma.quote.findFirst.mock.calls[0][0].where).toEqual({ id: 'orc-lab', patient: { tenant_id: LAB } });
  });

  it('clínica: grava como sempre, sem ler nenhum dos registros', async () => {
    const { comissoes, prisma } = montar();
    await comissoes.create(CLINICA, comissao({ procedure_id: 'x', treatment_plan_item_id: 'y', quote_id: 'z' }));
    expect(prisma.commission.create).toHaveBeenCalledTimes(1);
    for (const modelo of [prisma.user, prisma.procedure, prisma.treatmentPlanItem, prisma.quote]) {
      expect(modelo.findFirst).not.toHaveBeenCalled();
    }
  });

  it('abrir: no laboratório, comissão ligada a registro de outra conta responde 404; a da conta abre; clínica como sempre', async () => {
    const { comissoes, prisma } = montar();
    prisma.commission.findFirst.mockResolvedValue({ id: 'c1', professional_user_id: 'prof-lab', procedure_id: 'serv-outra' });
    await expect(comissoes.findOne(LAB, 'c1')).rejects.toBeInstanceOf(NotFoundException);

    prisma.commission.findFirst.mockResolvedValue({ id: 'c1', professional_user_id: 'prof-lab', procedure_id: 'serv-lab' });
    await expect(comissoes.findOne(LAB, 'c1')).resolves.toMatchObject({ id: 'c1' });

    prisma.user.findFirst.mockClear();
    await expect(comissoes.findOne(CLINICA, 'c1')).resolves.toMatchObject({ id: 'c1' });
    expect(prisma.user.findFirst).not.toHaveBeenCalled();
  });
});

describe('regra de comissão', () => {
  it('laboratório: profissional e serviço de outra conta são recusados ao criar; serviço, ao editar', async () => {
    const { regras, prisma } = montar();
    await expect(regras.create(LAB, regra({ professional_user_id: 'prof-outra' }))).rejects.toThrow(LAB_COMISSAO_IDS.profissional);
    await expect(regras.create(LAB, regra({ procedure_id: 'serv-outra' }))).rejects.toThrow(LAB_COMISSAO_IDS.servico);
    await expect(regras.update(LAB, 'regra', { procedure_id: 'serv-outra' })).rejects.toThrow(LAB_COMISSAO_IDS.servico);
    expect(prisma.commissionRule.create).not.toHaveBeenCalled();
    expect(prisma.commissionRule.update).not.toHaveBeenCalled();
    await regras.create(LAB, regra({ procedure_id: 'serv-lab' }));
    await regras.update(LAB, 'regra', { procedure_id: 'serv-lab' });
    expect(prisma.commissionRule.create).toHaveBeenCalledTimes(1);
    expect(prisma.commissionRule.update).toHaveBeenCalledTimes(1);
  });

  it('clínica: como sempre', async () => {
    const { regras, prisma } = montar();
    await regras.create(CLINICA, regra({ procedure_id: 'x' }));
    await regras.update(CLINICA, 'regra', { procedure_id: 'x' });
    expect(prisma.commissionRule.create).toHaveBeenCalledTimes(1);
    expect(prisma.commissionRule.update).toHaveBeenCalledTimes(1);
    expect(prisma.user.findFirst).not.toHaveBeenCalled();
    expect(prisma.procedure.findFirst).not.toHaveBeenCalled();
  });
});

describe('meta', () => {
  it('laboratório: profissional de outra conta é recusado ao criar e ao editar; meta sem profissional passa', async () => {
    const { metas, prisma } = montar();
    await expect(metas.create(LAB, meta({ professional_user_id: 'prof-outra' }))).rejects.toThrow(LAB_COMISSAO_IDS.profissional);
    await expect(metas.update(LAB, 'meta', { professional_user_id: 'prof-outra' })).rejects.toThrow(LAB_COMISSAO_IDS.profissional);
    expect(prisma.goal.create).not.toHaveBeenCalled();
    expect(edicoesDaMeta(prisma)).toHaveLength(0);
    await metas.create(LAB, meta());
    await metas.create(LAB, meta({ professional_user_id: 'prof-lab' }));
    await metas.update(LAB, 'meta', { professional_user_id: 'prof-lab' });
    expect(prisma.goal.create).toHaveBeenCalledTimes(2);
    expect(edicoesDaMeta(prisma)).toHaveLength(1);
  });

  it('clínica: como sempre', async () => {
    const { metas, prisma } = montar();
    await metas.create(CLINICA, meta({ professional_user_id: 'x' }));
    await metas.update(CLINICA, 'meta', { professional_user_id: 'x' });
    expect(prisma.goal.create).toHaveBeenCalledTimes(1);
    expect(edicoesDaMeta(prisma)).toHaveLength(1);
    expect(prisma.user.findFirst).not.toHaveBeenCalled();
  });
});

it('as mensagens não têm vocabulário de clínica', () => {
  for (const texto of Object.values(LAB_COMISSAO_IDS)) expect(temPalavraDeClinica(texto)).toBe(false);
});

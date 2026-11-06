/**
 * Link público do orçamento (proposta-online-laboratorio.ts) com a conta de laboratório
 * suspensa ou congelada: responde como indisponível, não conta visualização e não aceita.
 * Quando a conta volta a ficar ativa, o mesmo link volta a abrir.
 *
 * Sem banco: o Prisma é um dublê; dados de exemplo (repositório público).
 */
import { Logger, NotFoundException } from '@nestjs/common';
import { __limparCacheLabTenants } from '@crm/shared';
import { LAB_PROPOSTA_ONLINE } from './lab-proposta-online-textos';
import { aceitarPropostaPublica, verPropostaPublica } from './proposta-online-laboratorio';

const LAB = 'tenant-lab-exemplo';
const TOKEN = 'abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG';

const orcamento = () => ({
  id: 'orc-1',
  patient_id: 'cli-1',
  quote_number: 42,
  status: 'SENT',
  valid_until: new Date('2099-01-15T15:00:00.000Z'),
  deleted_at: null,
  archived_at: null,
  subtotal: 900,
  discount_percent: 0,
  discount_value: 0,
  total_value: 900,
  payment_terms: null,
  notes: null,
  patient: { name: 'Clínica Parceira Exemplo', tenant_id: LAB },
  items: [],
});

function montar(conta: { status?: string; chaves?: string[] }) {
  const prisma: any = {
    tenantBusinessProfile: { findMany: jest.fn(async () => [{ tenant_id: LAB }]) },
    portalToken: {
      findUnique: jest.fn(async () => ({ id: 'tk-1', tenant_id: LAB, patient_id: 'cli-1', expires_at: new Date('2099-01-01T00:00:00Z'), channel: 'LAB_PROPOSTA:orc-1' })),
    },
    quote: { findFirst: jest.fn(async () => orcamento()), findMany: jest.fn(async () => []), update: jest.fn(async () => ({})) },
    tenant: { findUnique: jest.fn(async () => ({ name: 'Laboratório Exemplo', logo_url: null, status: conta.status ?? 'ACTIVE' })) },
    globalSetting: { findMany: jest.fn(async ({ where }: any) => (conta.chaves ?? []).filter((k) => where.key.in.includes(k)).map(() => ({ value: 'true' }))) },
    auditLog: { create: jest.fn(async () => ({})) },
    quoteLabCase: { findMany: jest.fn(async () => []), findFirst: jest.fn(async () => null), findUnique: jest.fn(async () => null) },
  };
  return prisma;
}

beforeEach(() => {
  __limparCacheLabTenants();
  for (const nivel of ['log', 'warn', 'debug', 'error', 'verbose'] as const) {
    jest.spyOn(Logger.prototype, nivel).mockImplementation(() => undefined);
  }
});
afterEach(() => jest.restoreAllMocks());

describe('link do orçamento com a conta suspensa ou congelada', () => {
  it.each([
    ['SUSPENDED', { status: 'SUSPENDED' }],
    ['DELETED', { status: 'DELETED' }],
    ['LAB_FREEZE', { chaves: ['LAB_FREEZE'] }],
    ['LAB_FREEZE_<conta>', { chaves: [`LAB_FREEZE_${LAB}`] }],
  ])('%s: a página responde como indisponível e não conta visualização', async (_n, conta) => {
    const prisma = montar(conta);
    await expect(verPropostaPublica(prisma, TOKEN)).rejects.toThrow(new NotFoundException(LAB_PROPOSTA_ONLINE.linkInvalido));
    expect(prisma.quote.update).not.toHaveBeenCalled();
    expect(prisma.quote.findFirst).not.toHaveBeenCalled();
  });

  it.each([
    ['SUSPENDED', { status: 'SUSPENDED' }],
    ['LAB_FREEZE', { chaves: ['LAB_FREEZE'] }],
  ])('%s: o aceite é recusado e o orçamento não é aceito', async (_n, conta) => {
    const prisma = montar(conta);
    const aceitar = jest.fn(async () => ({}));
    await expect(
      aceitarPropostaPublica({ prisma, aceitar, logger: new Logger('t') }, TOKEN, { nome: 'Ana Souza' }),
    ).rejects.toThrow(new NotFoundException(LAB_PROPOSTA_ONLINE.linkInvalido));
    expect(aceitar).not.toHaveBeenCalled();
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });

  it('conta em teste abre; a que volta a ficar ativa abre de novo pelo mesmo link', async () => {
    await expect(verPropostaPublica(montar({ status: 'TRIAL' }), TOKEN)).resolves.toMatchObject({ situacao: 'ABERTO' });
    const prisma = montar({ status: 'SUSPENDED' });
    await expect(verPropostaPublica(prisma, TOKEN)).rejects.toBeInstanceOf(NotFoundException);
    prisma.tenant.findUnique.mockResolvedValue({ name: 'Laboratório Exemplo', logo_url: null, status: 'ACTIVE' });
    await expect(verPropostaPublica(prisma, TOKEN)).resolves.toMatchObject({ situacao: 'ABERTO' });
  });
});

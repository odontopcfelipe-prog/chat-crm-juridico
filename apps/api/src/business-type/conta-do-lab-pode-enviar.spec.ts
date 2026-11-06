/**
 * contaDoLabPodeEnviar (packages/shared/src/lab-ia.ts): a chave que todo envio automático
 * de laboratório confere. Usa as mesmas chaves de congelamento da API
 * (lab-congelamento.ts): o que o guard chama de conta congelada também não envia.
 *
 * Sem banco: o Prisma é um dublê; dados de exemplo (repositório público).
 */
import { contaDoLabPodeEnviar } from '@crm/shared';
import { chaveCongelaConta, CHAVE_CONGELA_TODOS, laboratorioCongelado, __limparCacheCongelamento } from './lab-congelamento';

const CONTA = 'conta-lab-exemplo';

function prismaCom(status: string | null, chaves: Record<string, string> = {}) {
  return {
    tenant: { findUnique: jest.fn(async () => (status === null ? null : { status })) },
    globalSetting: {
      findMany: jest.fn(async ({ where }: any) =>
        where.key.in.filter((k: string) => k in chaves).map((key: string) => ({ key, value: chaves[key] })),
      ),
    },
  };
}

beforeEach(() => __limparCacheCongelamento());

describe('contaDoLabPodeEnviar', () => {
  it.each([
    ['ACTIVE', true],
    ['TRIAL', true],
    ['SUSPENDED', false],
    ['DELETED', false],
    ['QUALQUER_OUTRO', false],
  ])('status %s: %s', async (status, esperado) => {
    await expect(contaDoLabPodeEnviar(prismaCom(status), CONTA)).resolves.toBe(esperado);
  });

  it('conta que não existe não envia', async () => {
    await expect(contaDoLabPodeEnviar(prismaCom(null), CONTA)).resolves.toBe(false);
  });

  it.each([
    ['todas as contas', CHAVE_CONGELA_TODOS],
    ['só esta conta', chaveCongelaConta(CONTA)],
  ])('congelada (%s): não envia, mesmo em ACTIVE', async (_n, chave) => {
    await expect(contaDoLabPodeEnviar(prismaCom('ACTIVE', { [chave]: 'true' }), CONTA)).resolves.toBe(false);
    await expect(contaDoLabPodeEnviar(prismaCom('ACTIVE', { [chave]: ' TRUE ' }), CONTA)).resolves.toBe(false);
  });

  it('chave de congelamento em false ou de outra conta não congela', async () => {
    await expect(contaDoLabPodeEnviar(prismaCom('ACTIVE', { [CHAVE_CONGELA_TODOS]: 'false' }), CONTA)).resolves.toBe(true);
    await expect(contaDoLabPodeEnviar(prismaCom('ACTIVE', { [chaveCongelaConta('outra-conta')]: 'true' }), CONTA)).resolves.toBe(true);
  });

  it('erro de leitura, sem id ou id que não é texto: não envia e nunca lança', async () => {
    const quebrado: any = { tenant: { findUnique: jest.fn(async () => { throw new Error('banco fora'); }) }, globalSetting: { findMany: jest.fn(async () => []) } };
    await expect(contaDoLabPodeEnviar(quebrado, CONTA)).resolves.toBe(false);
    const sincrono: any = { tenant: { findUnique: () => { throw new Error('dublê sem o método'); } }, globalSetting: { findMany: jest.fn(async () => []) } };
    await expect(contaDoLabPodeEnviar(sincrono, CONTA)).resolves.toBe(false);
    for (const id of ['', null, undefined, 123]) {
      await expect(contaDoLabPodeEnviar(prismaCom('ACTIVE'), id)).resolves.toBe(false);
    }
  });

  it('não guarda resposta: a conta que volta a ficar ativa envia na chamada seguinte', async () => {
    const prisma = prismaCom('SUSPENDED');
    await expect(contaDoLabPodeEnviar(prisma, CONTA)).resolves.toBe(false);
    prisma.tenant.findUnique.mockResolvedValue({ status: 'ACTIVE' });
    await expect(contaDoLabPodeEnviar(prisma, CONTA)).resolves.toBe(true);
  });

  it.each([
    ['SUSPENDED', {}],
    ['DELETED', {}],
    ['ACTIVE', { [CHAVE_CONGELA_TODOS]: 'true' }],
    ['TRIAL', { [chaveCongelaConta(CONTA)]: 'true' }],
  ])('a conta que o guard da API congela (%s) também não envia', async (status, chaves) => {
    const prisma = prismaCom(status, chaves as Record<string, string>);
    await expect(laboratorioCongelado(prisma as any, CONTA)).resolves.toBe(true);
    await expect(contaDoLabPodeEnviar(prisma, CONTA)).resolves.toBe(false);
  });
});

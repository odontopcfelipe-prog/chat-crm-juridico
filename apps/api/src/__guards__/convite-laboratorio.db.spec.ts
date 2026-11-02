/**
 * F11 do laboratório — uso único do convite contra o Postgres DE VERDADE (só no CI).
 *
 * O convite é gasto com um updateMany condicional dentro da transação que cria a
 * conta. No READ COMMITTED, o 2º UPDATE da mesma linha espera a trava do 1º e
 * reavalia o WHERE: só um cadastro leva o convite; o outro recebe 403 e a
 * transação dele é desfeita. O mock dos specs só cobre a lógica; aqui é o banco.
 *
 * Roda SÓ no job do CI (banco ci@localhost:5432/ci, recriado a cada execução).
 * Em qualquer outra máquina é pulado — nunca encosta em banco de clínica.
 */
import { ForbiddenException } from '@nestjs/common';
import { PrismaClient } from '@crm/shared';
import { acharConviteValido, consumirConviteNaTransacao, gerarCodigoConvite } from '../tenants/convite-laboratorio';

const BANCO_DO_CI = process.env.CI === 'true' && /^postgresql:\/\/ci:ci@localhost:5432\/ci(\?|$)/.test(process.env.DATABASE_URL ?? '');
const descrever = BANCO_DO_CI ? describe : describe.skip;

const CONTA_A = '00000000-0000-4000-8000-0000000f11a1';
const CONTA_B = '00000000-0000-4000-8000-0000000f11b1';
const DIA = 24 * 3600_000;

descrever('convite do cadastro de laboratório no Postgres do CI', () => {
  let prisma: PrismaClient;
  const criados: string[] = [];

  async function novoConvite(extra: Record<string, unknown> = {}) {
    const { codigo, token_hash } = gerarCodigoConvite();
    const c = await prisma.labSignupInvite.create({
      data: { token_hash, lab_name: 'Laboratório do teste', expires_at: new Date(Date.now() + 14 * DIA), ...extra },
    });
    criados.push(c.id);
    return { id: c.id, codigo };
  }

  const gastar = (conviteId: string, tenantId: string) =>
    prisma.$transaction(async (tx) => {
      await consumirConviteNaTransacao(tx, { conviteId, tenantId, agora: new Date() });
      // Segura a transação um pouco: a outra chega enquanto a linha está travada.
      await new Promise((r) => setTimeout(r, 150));
      return tenantId;
    });

  beforeAll(() => {
    prisma = new PrismaClient();
  });

  afterAll(async () => {
    await prisma.labSignupInvite.deleteMany({ where: { id: { in: criados } } });
    await prisma.$disconnect();
  });

  it('dois cadastros ao mesmo tempo com o mesmo convite: exatamente um leva; o outro recebe 403', async () => {
    const { id } = await novoConvite();
    const r = await Promise.allSettled([gastar(id, CONTA_A), gastar(id, CONTA_B)]);

    const venceu = r.filter((x): x is PromiseFulfilledResult<string> => x.status === 'fulfilled');
    const perdeu = r.filter((x): x is PromiseRejectedResult => x.status === 'rejected');
    expect(venceu).toHaveLength(1);
    expect(perdeu).toHaveLength(1);
    expect(perdeu[0].reason).toBeInstanceOf(ForbiddenException);
    expect(perdeu[0].reason.getResponse()).toMatchObject({ code: 'CONVITE_INVALIDO' });

    const linha = await prisma.labSignupInvite.findUnique({ where: { id } });
    expect(linha?.used_at).toBeInstanceOf(Date);
    expect(linha?.tenant_id).toBe(venceu[0].value);
  });

  it.each([
    ['vencido', { expires_at: new Date(Date.now() - 1000) }],
    ['revogado', { revoked_at: new Date() }],
  ])('convite %s: 403 e a linha não muda', async (_n, extra) => {
    const { id } = await novoConvite(extra);
    await expect(gastar(id, CONTA_A)).rejects.toBeInstanceOf(ForbiddenException);
    const linha = await prisma.labSignupInvite.findUnique({ where: { id } });
    expect(linha?.used_at).toBeNull();
    expect(linha?.tenant_id).toBeNull();
  });

  it('a busca pelo código roda no banco e só acha o convite que está valendo', async () => {
    const valendo = await novoConvite({ email: 'contato@lab.teste' });
    const vencido = await novoConvite({ expires_at: new Date(Date.now() - 1000) });
    expect(await acharConviteValido(prisma, valendo.codigo, new Date())).toEqual({
      id: valendo.id,
      email: 'contato@lab.teste',
      lab_name: 'Laboratório do teste',
      created_by_user_id: null,
    });
    expect(await acharConviteValido(prisma, vencido.codigo, new Date())).toBeNull();
    expect(await acharConviteValido(prisma, gerarCodigoConvite().codigo, new Date())).toBeNull();
  });
});

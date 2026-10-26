/**
 * F1 — filtro "fora os laboratórios" contra o Postgres DE VERDADE (só no CI).
 *
 * O Prisma só reclama de forma errada de where (OR com NULL em campo
 * obrigatório, relação inexistente) na hora de executar. Aqui cada forma de
 * EXCLUI_LAB_FORMA roda num banco descartável com um id de laboratório falso:
 * nenhuma pode dar erro de validação, e as linhas legadas com tenant_id NULL
 * continuam aparecendo.
 *
 * Roda SÓ no job do CI (banco ci@localhost:5432/ci, recriado a cada execução).
 * Em qualquer outra máquina é pulado — nunca encosta em banco de clínica.
 */
import { EXCLUI_LAB_FORMA, PrismaClient, excludeLabWhere, type ModeloExcluiLab } from '@crm/shared';

const BANCO_DO_CI = process.env.CI === 'true' && /^postgresql:\/\/ci:ci@localhost:5432\/ci(\?|$)/.test(process.env.DATABASE_URL ?? '');
const descrever = BANCO_DO_CI ? describe : describe.skip;

const LAB_FALSO = new Set(['00000000-0000-0000-0000-00000000fa1e']);

descrever('excludeLabWhere no Postgres do CI', () => {
  let prisma: PrismaClient;
  const tenantId = '00000000-0000-0000-0000-0000000c1db1';
  const criados: { leads: string[] } = { leads: [] };

  beforeAll(async () => {
    prisma = new PrismaClient();
    await prisma.tenant.upsert({ where: { id: tenantId }, create: { id: tenantId, name: 'Clínica do teste' }, update: {} });
    const semClinica = await prisma.lead.create({ data: { phone: '5582900000901', tags: [] } });
    const daClinica = await prisma.lead.create({ data: { phone: '5582900000902', tags: [], tenant_id: tenantId } });
    criados.leads.push(semClinica.id, daClinica.id);
  });

  afterAll(async () => {
    await prisma.lead.deleteMany({ where: { id: { in: criados.leads } } });
    await prisma.tenant.deleteMany({ where: { id: tenantId } });
    await prisma.$disconnect();
  });

  it.each(Object.keys(EXCLUI_LAB_FORMA))('%s: a forma roda sem erro do Prisma', async (modelo) => {
    const where = excludeLabWhere(modelo as ModeloExcluiLab, {}, LAB_FALSO);
    await expect((prisma as any)[modelo].findMany({ where, take: 1 })).resolves.toBeInstanceOf(Array);
    await expect((prisma as any)[modelo].count({ where })).resolves.toEqual(expect.any(Number));
  });

  it('lead com tenant_id NULL continua aparecendo (o filtro não come o legado)', async () => {
    const where = excludeLabWhere('lead', { id: { in: criados.leads } }, LAB_FALSO);
    const achados = await prisma.lead.findMany({ where, select: { id: true } });
    expect(achados.map((l) => l.id).sort()).toEqual([...criados.leads].sort());
  });

  it('lead da conta de laboratório sai', async () => {
    const where = excludeLabWhere('lead', { id: { in: criados.leads } }, new Set([tenantId]));
    const achados = await prisma.lead.findMany({ where, select: { id: true } });
    expect(achados.map((l) => l.id)).toEqual([criados.leads[0]]);
  });

  it('a tabela nova existe e começa vazia', async () => {
    await expect(prisma.tenantBusinessProfile.count()).resolves.toBe(0);
  });
});

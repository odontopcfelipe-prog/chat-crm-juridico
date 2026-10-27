/**
 * F2 parte 4 — contagens da vigia do laboratório contra o Postgres DE VERDADE
 * (só no CI). O Prisma só reclama de where errado na hora de executar: aqui as
 * 30 contagens rodam num banco descartável, e as que dependem de NULL e de chip
 * são conferidas com linhas de verdade.
 *
 * Roda SÓ no job do CI (banco ci@localhost:5432/ci, recriado a cada execução).
 * Em qualquer outra máquina é pulado — nunca encosta em banco de clínica.
 */
import { PrismaClient } from '@crm/shared';
import { contarForaDoLugar } from '../business-type/lab-sentinela';

const BANCO_DO_CI = process.env.CI === 'true' && /^postgresql:\/\/ci:ci@localhost:5432\/ci(\?|$)/.test(process.env.DATABASE_URL ?? '');
const descrever = BANCO_DO_CI ? describe : describe.skip;

const LAB = '00000000-0000-0000-0000-00000000fa51';
const CLINICA = '00000000-0000-0000-0000-00000000c151';

descrever('vigia do laboratório no Postgres do CI', () => {
  let prisma: PrismaClient;
  const leads: string[] = [];
  let usuario = '';

  beforeAll(async () => {
    prisma = new PrismaClient();
    for (const [id, name] of [[LAB, 'Laboratório do teste'], [CLINICA, 'Clínica do teste da vigia']]) {
      await prisma.tenant.upsert({ where: { id }, create: { id, name }, update: {} });
    }
    await prisma.instance.create({ data: { name: 'vigia-chip-lab', tenant_id: LAB } });
    await prisma.instance.create({ data: { name: 'vigia-chip-clinica', tenant_id: CLINICA } });
    const u = await prisma.user.create({ data: { name: 'Vigia', email: 'vigia-lab@exemplo.test', password_hash: 'x', tenant_id: LAB } });
    usuario = u.id;

    const leadLab = await prisma.lead.create({ data: { phone: '5582900000951', tags: [], tenant_id: LAB } });
    const leadClinica = await prisma.lead.create({ data: { phone: '5582900000952', tags: [], tenant_id: CLINICA } });
    leads.push(leadLab.id, leadClinica.id);
    const convLab = await prisma.conversation.create({ data: { lead_id: leadLab.id, tenant_id: LAB } });
    const convClinica = await prisma.conversation.create({ data: { lead_id: leadClinica.id, tenant_id: CLINICA } });

    const msg = (conversation_id: string, instance_name: string | null, extra: Record<string, unknown> = {}) =>
      prisma.message.create({ data: { conversation_id, direction: 'out', type: 'text', status: 'enviado', instance_name, ...extra } });
    await msg(convLab.id, 'vigia-chip-lab'); // certo: chip do próprio laboratório
    await msg(convLab.id, null); // sem chip registrado: não conta
    await msg(convLab.id, 'vigia-chip-clinica'); // ERRADO: conversa do lab pelo chip da clínica
    await msg(convClinica.id, 'vigia-chip-lab'); // ERRADO: chip do lab em conversa da clínica
    await msg(convClinica.id, 'vigia-chip-clinica'); // da clínica: nada a ver com o lab

    const evento = (tenant_id: string, type: string) =>
      prisma.calendarEvent.create({ data: { tenant_id, type, title: 'teste', start_at: new Date(), created_by_id: usuario } });
    await evento(LAB, 'TAREFA');
    await evento(LAB, 'CONSULTA'); // ERRADO
    await evento(CLINICA, 'CONSULTA'); // da clínica: não conta

    await prisma.aiUsage.create({ data: { tenant_id: CLINICA, model: 'x', call_type: 'chat' } });
  });

  afterAll(async () => {
    await prisma.calendarEvent.deleteMany({ where: { tenant_id: { in: [LAB, CLINICA] } } });
    await prisma.aiUsage.deleteMany({ where: { tenant_id: { in: [LAB, CLINICA] } } });
    await prisma.message.deleteMany({ where: { conversation: { lead_id: { in: leads } } } });
    await prisma.conversation.deleteMany({ where: { lead_id: { in: leads } } });
    await prisma.lead.deleteMany({ where: { id: { in: leads } } });
    await prisma.instance.deleteMany({ where: { name: { in: ['vigia-chip-lab', 'vigia-chip-clinica'] } } });
    await prisma.user.deleteMany({ where: { id: usuario } });
    await prisma.tenant.deleteMany({ where: { id: { in: [LAB, CLINICA] } } });
    await prisma.$disconnect();
  });

  it('todas as contagens rodam sem erro do Prisma e só acham o que está errado no laboratório', async () => {
    const r = await contarForaDoLugar(prisma as any, LAB);
    expect(Object.keys(r)).toHaveLength(30);
    expect(r['Mensagem enviada por chip de outra conta']).toBe(1);
    expect(r['Mensagem do chip do laboratório em conversa de outra conta']).toBe(1);
    expect(r['Evento de agenda de clínica']).toBe(1);
    expect(r['Uso de IA']).toBe(0);
    const resto = Object.entries(r).filter(
      ([n]) => !['Mensagem enviada por chip de outra conta', 'Mensagem do chip do laboratório em conversa de outra conta', 'Evento de agenda de clínica'].includes(n),
    );
    expect(resto.every(([, n]) => n === 0)).toBe(true);
  });
});

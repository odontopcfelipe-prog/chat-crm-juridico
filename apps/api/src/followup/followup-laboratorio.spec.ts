/**
 * Laboratório — sequências de mensagens (texto fixo) e comunicado em massa.
 *
 * Na conta de laboratório: a sequência nasce desligada e sem etapa automática, o passo é
 * texto fixo por WhatsApp (sem IA), só entra lead em sequência LIGADA da própria conta e
 * o disparo em massa é só o comunicado. A clínica segue como sempre (sequência global
 * continua valendo para o lead dela).
 *
 * Banco de teste: dublê em memória. Dados de exemplo (repositório público).
 */
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { __limparCacheLabTenants } from '@crm/shared';
import { FollowupService } from './followup.service';
import { FollowupController } from './followup.controller';
import { LAB_FOLLOWUP_SEMENTES } from './lab-followup-textos';

const LAB = 'conta-lab';
const CLINICA = 'conta-clinica';
const ESCOPO_LAB = { tenantId: LAB, superAdmin: false };

beforeEach(() => __limparCacheLabTenants());

function montar(over: { sequencias?: any[]; passos?: any[]; lead?: any } = {}) {
  const criados: any[] = [];
  const fila: any[] = [];
  const prisma: any = {
    tenantBusinessProfile: { findMany: jest.fn(async () => [{ tenant_id: LAB }]) },
    followupSequence: {
      findUnique: jest.fn(async ({ where }: any) => (over.sequencias ?? []).find((s) => s.id === where.id) ?? null),
      findFirst: jest.fn(async ({ where }: any) =>
        (over.sequencias ?? []).find((s) => s.tenant_id === where.tenant_id && s.name === where.name) ?? null,
      ),
      findMany: jest.fn(async () => over.sequencias ?? []),
      create: jest.fn(async ({ data }: any) => {
        criados.push(data);
        return { id: 'nova', ...data };
      }),
      update: jest.fn(async ({ data }: any) => data),
    },
    followupStep: {
      findMany: jest.fn(async () => over.passos ?? []),
      findFirst: jest.fn(async () => ({ position: 2 })),
      findUnique: jest.fn(async () => ({ sequence: { tenant_id: LAB } })),
      create: jest.fn(async ({ data }: any) => data),
      update: jest.fn(async ({ data }: any) => data),
    },
    lead: {
      findUnique: jest.fn(async () => over.lead ?? { id: 'l1', tenant_id: LAB, name: 'Dra. Ana' }),
      findMany: jest.fn(async () => [{ id: 'l1', name: 'Dra. Ana', phone: '5582999990000', stage: 'NOVO' }]),
    },
    followupEnrollment: {
      findUnique: jest.fn(async () => null),
      upsert: jest.fn(async ({ create }: any) => ({ id: 'e1', ...create })),
    },
    broadcastJob: { create: jest.fn(async ({ data }: any) => ({ id: 'b1', ...data, items: [{ id: 'i1' }] })) },
  };
  const queue: any = { add: jest.fn(async (...a: any[]) => fila.push(a)) };
  const svc = new FollowupService(prisma, queue);
  return { svc, prisma, queue, criados, fila };
}

const PASSO = { delay_hours: 24, custom_prompt: 'Olá, {{nome}}! Posso preparar um orçamento?' };

describe('sequência do laboratório', () => {
  it('nasce desligada, na conta, sem etapa automática e com passo de texto fixo por WhatsApp', async () => {
    const { svc, criados } = montar();
    await svc.createSequence({ name: 'Minha', active: true, auto_enroll_stages: ['NOVO'], steps: [PASSO], tenant_id: 'outra' } as any, LAB);
    expect(criados[0]).toMatchObject({ tenant_id: LAB, active: false, auto_enroll_stages: [] });
    expect(criados[0].steps.create[0]).toMatchObject({ channel: 'whatsapp', custom_prompt: PASSO.custom_prompt, position: 1, auto_send: true });
  });

  it('passo sem texto, por e-mail ou com palavra de clínica é recusado', async () => {
    const { svc } = montar();
    await expect(svc.createSequence({ name: 'X', steps: [{ delay_hours: 1 }] } as any, LAB)).rejects.toBeInstanceOf(BadRequestException);
    await expect(svc.createSequence({ name: 'X', steps: [{ ...PASSO, channel: 'email' }] } as any, LAB)).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      svc.createSequence({ name: 'X', steps: [{ ...PASSO, custom_prompt: 'Sua consulta está marcada' }] } as any, LAB),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('só liga se todo passo tem texto', async () => {
    const seq = { id: 's1', tenant_id: LAB, active: false };
    const sem = montar({ sequencias: [seq], passos: [{ custom_prompt: 'ok' }, { custom_prompt: '  ' }] });
    await expect(sem.svc.updateSequence('s1', { active: true }, ESCOPO_LAB)).rejects.toBeInstanceOf(BadRequestException);
    const vazia = montar({ sequencias: [seq], passos: [] });
    await expect(vazia.svc.updateSequence('s1', { active: true }, ESCOPO_LAB)).rejects.toBeInstanceOf(BadRequestException);
    const com = montar({ sequencias: [seq], passos: [{ custom_prompt: 'ok' }] });
    await com.svc.updateSequence('s1', { active: true, category: 'X', max_attempts: 99 } as any, ESCOPO_LAB);
    expect(com.prisma.followupSequence.update.mock.calls[0][0].data).toEqual({ active: true });
  });

  it('edição do passo no laboratório grava só texto e prazo', async () => {
    const { svc, prisma } = montar();
    await svc.updateStep('p1', { custom_prompt: ' Novo texto ', delay_hours: 48, channel: 'email', auto_send: false } as any, ESCOPO_LAB);
    expect(prisma.followupStep.update.mock.calls[0][0].data).toEqual({ custom_prompt: 'Novo texto', delay_hours: 48 });
    await expect(svc.updateStep('p1', { delay_hours: -1 }, ESCOPO_LAB)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('sementes: duas sequências da conta, desligadas, sem etapa automática, e só uma vez', async () => {
    const { svc, criados } = montar();
    const r = await svc.seedSequenciasDoLaboratorio(LAB);
    expect(r.created).toEqual(LAB_FOLLOWUP_SEMENTES.map((s) => s.nome));
    for (const c of criados) {
      expect(c).toMatchObject({ tenant_id: LAB, active: false, auto_enroll_stages: [] });
      expect(c.steps.create.every((p: any) => p.channel === 'whatsapp' && p.custom_prompt.includes('{{nome}}'))).toBe(true);
    }
    const jaTem = montar({ sequencias: LAB_FOLLOWUP_SEMENTES.map((s, i) => ({ id: `s${i}`, tenant_id: LAB, name: s.nome })) });
    expect((await jaTem.svc.seedSequenciasDoLaboratorio(LAB)).created).toEqual([]);
  });

  it('seed pelo controller: ADMIN do laboratório cria as do laboratório; quem não é ADMIN recebe 403', async () => {
    const { svc } = montar();
    const ctrl = new FollowupController(svc);
    const r = await ctrl.seedDefaultSequences({ user: { tenant_id: LAB, bt: 'LABORATORIO', roles: ['ADMIN'] } });
    expect(r.created.length).toBe(LAB_FOLLOWUP_SEMENTES.length);
    expect(() => ctrl.seedDefaultSequences({ user: { tenant_id: LAB, bt: 'LABORATORIO', roles: ['CRC'] } })).toThrow(ForbiddenException);
  });
});

describe('inscrição de lead', () => {
  const propria = { id: 's1', tenant_id: LAB, active: true, steps: [{ delay_hours: 24 }] };

  it('laboratório entra na sequência ligada da própria conta', async () => {
    const { svc, prisma, queue } = montar({ sequencias: [propria] });
    await svc.enrollLead('l1', 's1');
    expect(prisma.followupEnrollment.upsert).toHaveBeenCalledTimes(1);
    expect(queue.add).toHaveBeenCalledTimes(1);
  });

  it('sequência global ou de outra conta não alcança lead de laboratório', async () => {
    for (const tenant_id of [null, CLINICA]) {
      const { svc, prisma } = montar({ sequencias: [{ ...propria, tenant_id }] });
      await expect(svc.enrollLead('l1', 's1')).rejects.toBeInstanceOf(NotFoundException);
      expect(prisma.followupEnrollment.upsert).not.toHaveBeenCalled();
    }
  });

  it('sequência desligada não inscreve; contato que pediu para não receber também não', async () => {
    const off = montar({ sequencias: [{ ...propria, active: false }] });
    await expect(off.svc.enrollLead('l1', 's1')).rejects.toBeInstanceOf(BadRequestException);
    const optout = montar({ sequencias: [propria], lead: { id: 'l1', tenant_id: LAB, contact_opt_out_at: new Date() } });
    await expect(optout.svc.enrollLead('l1', 's1')).rejects.toBeInstanceOf(BadRequestException);
    expect(optout.prisma.followupEnrollment.upsert).not.toHaveBeenCalled();
  });

  it('clínica: a sequência global continua valendo para o lead dela', async () => {
    const { svc, prisma } = montar({ sequencias: [{ ...propria, tenant_id: null }], lead: { id: 'l1', tenant_id: CLINICA } });
    await svc.enrollLead('l1', 's1');
    expect(prisma.followupEnrollment.upsert).toHaveBeenCalledTimes(1);
  });

  it('inscrição automática por etapa: laboratório só olha as da própria conta; clínica mantém as globais', async () => {
    const lab = montar();
    await lab.svc.autoEnrollByStage('l1', 'NOVO');
    expect(lab.prisma.followupSequence.findMany.mock.calls[0][0].where).toEqual({
      active: true,
      auto_enroll_stages: { has: 'NOVO' },
      tenant_id: LAB,
    });
    const cli = montar({ lead: { id: 'l1', tenant_id: CLINICA } });
    cli.prisma.lead.findUnique.mockResolvedValue({ is_client: false, tenant_id: CLINICA });
    await cli.svc.autoEnrollByStage('l1', 'NOVO');
    expect(cli.prisma.followupSequence.findMany.mock.calls[0][0].where).toEqual({
      active: true,
      auto_enroll_stages: { has: 'NOVO' },
      OR: [{ tenant_id: CLINICA }, { tenant_id: null }],
    });
  });
});

describe('texto por IA e comunicado em massa', () => {
  it('regenerar mensagem por IA não existe no laboratório', async () => {
    const { svc, prisma } = montar();
    prisma.followupMessage = { findUnique: jest.fn(async () => ({ enrollment: { lead: { tenant_id: LAB } } })) };
    await expect(svc.regenerateMessage('m1', ESCOPO_LAB)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('disparo em massa do laboratório é só o comunicado, com texto fixo', async () => {
    const { svc, prisma } = montar();
    await expect(svc.createBroadcast({ type: 'AUDIENCIA', days_ahead: 7, interval_ms: 8000, custom_prompt: 'x' }, 'u1', LAB)).rejects.toBeInstanceOf(BadRequestException);
    await expect(svc.createBroadcast({ type: 'COMUNICADO', days_ahead: 0, interval_ms: 8000 }, 'u1', LAB)).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      svc.createBroadcast({ type: 'COMUNICADO', days_ahead: 0, interval_ms: 8000, custom_prompt: 'Aviso aos pacientes' }, 'u1', LAB),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.broadcastJob.create).not.toHaveBeenCalled();
  });

  it('comunicado do laboratório: só contatos da conta que aceitam mensagens, no ritmo da clínica', async () => {
    const { svc, prisma, queue } = montar();
    const b = await svc.createBroadcast({ type: 'COMUNICADO', days_ahead: 0, interval_ms: 1000, custom_prompt: 'Olá, {{nome}}! Fechamos na sexta.' }, 'u1', LAB);
    const where = prisma.lead.findMany.mock.calls[0][0].where;
    expect(where).toMatchObject({ tenant_id: LAB, is_client: true, contact_opt_out_at: null, whatsapp_invalid_at: null, non_patient_category: null });
    expect(b.tenant_id).toBe(LAB);
    expect(b.name.startsWith('Comunicado')).toBe(true);
    expect(b.interval_ms).toBe(5000); // piso do ritmo, como na clínica
    expect(queue.add).toHaveBeenCalledTimes(1);
  });
});

/**
 * Furo antigo achado na revisão da F0b: as rotas de follow-up por id
 * (sequências, passos, inscrições, aprovações, disparos em massa) e a lista de
 * sequências (por ?tenant_id da URL) ignoravam a clínica de quem chama.
 * Agora: recurso de outra clínica = "não encontrado"; registro sem clínica
 * (global/legado) só o SUPER_ADMIN altera; seed de sequências globais só o
 * SUPER_ADMIN. Chamadas internas (sem escopo) seguem como antes.
 */
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { FollowupController } from './followup.controller';
import { FollowupService } from './followup.service';

const SEQS: Record<string, { id: string; tenant_id: string | null; active: boolean }> = {
  's-a': { id: 's-a', tenant_id: 'a', active: true },
  's-b': { id: 's-b', tenant_id: 'b', active: true },
  's-g': { id: 's-g', tenant_id: null, active: true },
};
const STEPS: Record<string, string> = { 'p-a': 's-a', 'p-b': 's-b' };
const LEADS: Record<string, { id: string; tenant_id: string | null }> = {
  'l-a': { id: 'l-a', tenant_id: 'a' },
  'l-b': { id: 'l-b', tenant_id: 'b' },
};
const ENROLL: Record<string, string> = { 'e-a': 'l-a', 'e-b': 'l-b' };
const MSGS: Record<string, string> = { 'm-a': 'e-a', 'm-b': 'e-b' };
const BCAST: Record<string, { tenant_id: string | null; status: string }> = { 'b-a': { tenant_id: 'a', status: 'ENVIANDO' }, 'b-b': { tenant_id: 'b', status: 'ENVIANDO' } };

function montar() {
  const escritas: string[] = [];
  const prisma: any = {
    followupSequence: {
      findUnique: jest.fn(async ({ where }: any) => (SEQS[where.id] ? { ...SEQS[where.id], steps: [] } : null)),
      findMany: jest.fn(async () => []),
      create: jest.fn(async ({ data }: any) => {
        escritas.push(`seq.create:${data.tenant_id ?? 'null'}`);
        return data;
      }),
      update: jest.fn(async ({ where }: any) => {
        escritas.push(`seq.update:${where.id}`);
        return {};
      }),
      delete: jest.fn(async ({ where }: any) => escritas.push(`seq.delete:${where.id}`)),
    },
    followupStep: {
      findUnique: jest.fn(async ({ where }: any) => (STEPS[where.id] ? { sequence: { tenant_id: SEQS[STEPS[where.id]].tenant_id } } : null)),
      create: jest.fn(async () => escritas.push('step.create')),
      update: jest.fn(async ({ where }: any) => escritas.push(`step.update:${where.id}`)),
      delete: jest.fn(async ({ where }: any) => escritas.push(`step.delete:${where.id}`)),
    },
    lead: { findUnique: jest.fn(async ({ where }: any) => LEADS[where.id] ?? null) },
    followupEnrollment: {
      findUnique: jest.fn(async ({ where }: any) =>
        ENROLL[where.id] ? { lead: { tenant_id: LEADS[ENROLL[where.id]].tenant_id } } : null,
      ),
      findMany: jest.fn(async () => []),
      update: jest.fn(async ({ where }: any) => {
        escritas.push(`enroll.update:${where.id}`);
        return {};
      }),
      updateMany: jest.fn(async () => ({ count: 0 })),
    },
    followupMessage: {
      findUnique: jest.fn(async ({ where }: any) =>
        MSGS[where.id] ? { enrollment: { lead: { tenant_id: LEADS[ENROLL[MSGS[where.id]]].tenant_id } } } : null,
      ),
      update: jest.fn(async ({ where }: any) => {
        escritas.push(`msg.update:${where.id}`);
        return {};
      }),
    },
    broadcastJob: {
      findUnique: jest.fn(async ({ where }: any) => (BCAST[where.id] ? { id: where.id, ...BCAST[where.id], items: [] } : null)),
      update: jest.fn(async ({ where }: any) => escritas.push(`bcast.update:${where.id}`)),
    },
    broadcastItem: { updateMany: jest.fn(async () => ({ count: 0 })) },
  };
  const queue: any = { add: jest.fn(async () => ({})) };
  const svc = new FollowupService(prisma, queue);
  const ctrl = new FollowupController(svc);
  return { ctrl, svc, prisma, queue, escritas };
}

const req = (tenant_id: string | null, roles = ['ADMIN']) => ({ user: { id: 'u', name: 'U', tenant_id, roles } });
const nf = expect.any(NotFoundException);

describe('Follow-up — rotas na clínica de quem chama', () => {
  it('lista de sequências usa a clínica do login (a URL não escolhe mais)', async () => {
    const { ctrl, prisma } = montar();
    await ctrl.listSequences(req('a'));
    expect(prisma.followupSequence.findMany.mock.calls[0][0].where).toEqual({ OR: [{ tenant_id: 'a' }, { tenant_id: null }] });
  });

  it('criar sequência: nasce na clínica de quem cria (body.tenant_id só vale pro SUPER_ADMIN)', async () => {
    const { ctrl, escritas } = montar();
    await ctrl.createSequence({ name: 'X', tenant_id: 'b' }, req('a'));
    await ctrl.createSequence({ name: 'Y', tenant_id: 'b' }, req(null, ['SUPER_ADMIN']));
    expect(escritas).toEqual(['seq.create:a', 'seq.create:b']);
  });

  it('sequência e passos de OUTRA clínica (ou globais) → não encontrado, nada escrito', async () => {
    const { ctrl, escritas } = montar();
    const r = req('a');
    await expect(ctrl.updateSequence('s-b', { name: 'X' }, r)).rejects.toEqual(nf);
    await expect(ctrl.updateSequence('s-g', { name: 'X' }, r)).rejects.toEqual(nf);
    await expect(ctrl.deleteSequence('s-b', r)).rejects.toEqual(nf);
    await expect(ctrl.addStep('s-b', {}, r)).rejects.toEqual(nf);
    await expect(ctrl.updateStep('p-b', {}, r)).rejects.toEqual(nf);
    await expect(ctrl.deleteStep('p-b', r)).rejects.toEqual(nf);
    expect(escritas).toEqual([]);
  });

  it('a própria clínica altera a dela; SUPER_ADMIN altera a global', async () => {
    const { ctrl, escritas } = montar();
    await ctrl.updateSequence('s-a', { name: 'X' }, req('a'));
    await ctrl.updateStep('p-a', {}, req('a'));
    await ctrl.updateSequence('s-g', { name: 'X' }, req(null, ['SUPER_ADMIN']));
    expect(escritas).toEqual(['seq.update:s-a', 'step.update:p-a', 'seq.update:s-g']);
  });

  it('inscrições: lista filtrada pela clínica; inscrever/pausar/cancelar lead de outra → não encontrado', async () => {
    const { ctrl, prisma, escritas } = montar();
    await ctrl.listEnrollments({}, req('a'));
    expect(prisma.followupEnrollment.findMany.mock.calls[0][0].where).toEqual({ lead: { tenant_id: 'a' } });
    await expect(ctrl.enrollLead({ lead_id: 'l-b', sequence_id: 's-a' }, req('a'))).rejects.toEqual(nf);
    await expect(ctrl.pauseEnrollment('e-b', {}, req('a'))).rejects.toEqual(nf);
    await expect(ctrl.cancelEnrollment('e-b', req('a'))).rejects.toEqual(nf);
    await expect(ctrl.markConverted('e-b', req('a'))).rejects.toEqual(nf);
    expect(escritas).toEqual([]);
    await ctrl.cancelEnrollment('e-a', req('a'));
    expect(escritas).toEqual(['enroll.update:e-a']);
  });

  it('aprovar/rejeitar mensagem de outra clínica → não encontrado, nada enfileirado', async () => {
    const { ctrl, queue, escritas } = montar();
    await expect(ctrl.approveMessage('m-b', {}, req('a'))).rejects.toEqual(nf);
    await expect(ctrl.rejectMessage('m-b', req('a'))).rejects.toEqual(nf);
    await expect(ctrl.regenerateMessage('m-b', req('a'))).rejects.toEqual(nf);
    expect(queue.add).not.toHaveBeenCalled();
    expect(escritas).toEqual([]);
    await ctrl.approveMessage('m-a', {}, req('a'));
    expect(queue.add).toHaveBeenCalledTimes(1);
  });

  it('disparo em massa de outra clínica → não encontrado', async () => {
    const { ctrl, escritas } = montar();
    await expect(ctrl.getBroadcast('b-b', req('a'))).rejects.toEqual(nf);
    await expect(ctrl.cancelBroadcast('b-b', req('a'))).rejects.toEqual(nf);
    expect(escritas).toEqual([]);
    await expect(ctrl.getBroadcast('b-a', req('a'))).resolves.toMatchObject({ id: 'b-a' });
  });

  it('seed das sequências globais: só SUPER_ADMIN', () => {
    const { ctrl } = montar();
    expect(() => ctrl.seedDefaultSequences(req('a'))).toThrow(ForbiddenException);
  });

  it('chamada interna sem escopo (auto-enroll/automação) segue como antes', async () => {
    const { svc } = montar();
    await expect(svc.updateSequence('s-b', { name: 'X' })).resolves.toEqual({});
  });
});

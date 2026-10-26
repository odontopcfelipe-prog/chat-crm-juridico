/**
 * Criar sequência de follow-up (POST /followup/sequences): nasce na clínica de
 * quem cria. Sem clínica no login, só o SUPER_ADMIN cria (a sequência sem
 * clínica vale para todas); os demais recebem 403 PERMISSION_DENIED e nada é
 * criado. O SUPER_ADMIN segue escolhendo a clínica pelo corpo, como antes.
 */
import { ForbiddenException } from '@nestjs/common';
import { FollowupController } from '../followup/followup.controller';
import { FollowupService } from '../followup/followup.service';

const A = 'conta-a';
const B = 'conta-b';
const ADMIN_A = { id: 'u-a', roles: ['ADMIN'], tenant_id: A };
const ADMIN_SEM_CONTA = { id: 'u-x', roles: ['ADMIN'], tenant_id: null };
const ADMIN_CONTA_VAZIA = { id: 'u-y', roles: ['ADMIN'], tenant_id: '' };
const COMERCIAL_SEM_CONTA = { id: 'u-c', roles: ['COMERCIAL'], tenant_id: undefined };
const DONO = { id: 'u-dono', roles: ['ADMIN', 'SUPER_ADMIN'], tenant_id: A };
const SUPER_SEM_CONTA = { id: 'u-s', roles: ['SUPER_ADMIN'], tenant_id: null };

function montar() {
  const criadas: Array<string | null> = [];
  const prisma: any = {
    followupSequence: {
      create: jest.fn(async ({ data }: any) => {
        criadas.push(data.tenant_id ?? null);
        return { id: 'nova', ...data, steps: [] };
      }),
    },
  };
  const ctl = new FollowupController(new FollowupService(prisma, { add: jest.fn() } as any));
  return { ctl, prisma, criadas };
}

const req = (user: any) => ({ user });
const SEQ = { name: 'Reativação', category: 'LEADS' };

describe('Sequência de follow-up sem clínica: só o SUPER_ADMIN', () => {
  it.each([
    ['ADMIN sem clínica', ADMIN_SEM_CONTA],
    ['ADMIN com clínica vazia', ADMIN_CONTA_VAZIA],
    ['COMERCIAL sem clínica', COMERCIAL_SEM_CONTA],
  ])('%s: 403 PERMISSION_DENIED, nada criado (nem com tenant_id no corpo)', async (_n, u) => {
    const { ctl, prisma } = montar();
    for (const corpo of [SEQ, { ...SEQ, tenant_id: B }]) {
      const e = await ctl.createSequence(corpo, req(u)).catch((x) => x);
      expect(e).toBeInstanceOf(ForbiddenException);
      expect((e as ForbiddenException).getResponse()).toMatchObject({ code: 'PERMISSION_DENIED' });
    }
    expect(prisma.followupSequence.create).not.toHaveBeenCalled();
  });

  it('a clínica A cria na dela; tenant_id de outra clínica no corpo é ignorado', async () => {
    const { ctl, criadas } = montar();
    await ctl.createSequence(SEQ, req(ADMIN_A));
    await ctl.createSequence({ ...SEQ, tenant_id: B }, req(ADMIN_A));
    expect(criadas).toEqual([A, A]);
  });

  it('o dono escolhe a clínica pelo corpo (a dele) e ainda cria a que vale para todas, como antes', async () => {
    const { ctl, criadas } = montar();
    await ctl.createSequence({ ...SEQ, tenant_id: A }, req(DONO));
    await ctl.createSequence(SEQ, req(DONO));
    expect(criadas).toEqual([A, null]);
  });

  it('SUPER_ADMIN sem clínica cria a sequência para todas (ou a de uma clínica pelo corpo), como antes', async () => {
    const { ctl, criadas } = montar();
    await ctl.createSequence(SEQ, req(SUPER_SEM_CONTA));
    await ctl.createSequence({ ...SEQ, tenant_id: B }, req(SUPER_SEM_CONTA));
    expect(criadas).toEqual([null, B]);
  });
});

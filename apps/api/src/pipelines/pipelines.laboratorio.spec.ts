/**
 * Paridade do laboratório — funis (PipelinesService).
 *
 * - seedDefaults segue recusado ao laboratório (os funis padrão são da clínica);
 * - reorderStages no laboratório só aceita etapas do próprio funil; na clínica a
 *   chamada ao banco é a mesma de sempre (sem a conferência extra).
 *
 * Sem banco: o Prisma é um fake que guarda o que foi chamado.
 */
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { __limparCacheLabTenants } from '@crm/shared';
import { PipelinesService } from './pipelines.service';

const CLINICA = 'tenant-clinica-exemplo';
const LAB = 'tenant-lab-exemplo';
const FUNIL = 'funil-1';

function montar(etapasDoFunil: string[]) {
  const atualizacoes: any[] = [];
  const buscas: any[] = [];
  const prisma: any = {
    tenantBusinessProfile: { findMany: jest.fn(async () => [{ tenant_id: LAB }]) },
    pipeline: {
      findUnique: jest.fn(async ({ where }: any) => ({
        id: where.id,
        tenant_id: where.id === FUNIL ? undefined : null,
        _count: { leads: 0, stages: etapasDoFunil.length },
        stages: [],
      })),
    },
    pipelineStage: {
      findMany: jest.fn(async (args: any) => {
        buscas.push(args);
        return etapasDoFunil.filter((id) => args.where.id.in.includes(id)).map((id) => ({ id }));
      }),
      update: jest.fn((args: any) => {
        atualizacoes.push(args);
        return args;
      }),
    },
    $transaction: jest.fn(async (ops: any[]) => ops),
  };
  const svc = new PipelinesService(prisma);
  return { svc, prisma, atualizacoes, buscas };
}

// O funil de exemplo pertence à conta que pede (a conferência de dono é do findOne).
function funilDa(conta: string) {
  const m = montar(['e1', 'e2']);
  m.prisma.pipeline.findUnique = jest.fn(async ({ where }: any) => ({
    id: where.id,
    tenant_id: conta,
    _count: { leads: 0, stages: 2 },
    stages: [],
  }));
  return m;
}

beforeEach(() => __limparCacheLabTenants());

describe('PipelinesService.seedDefaults', () => {
  it('laboratório: recusa os funis padrão da clínica', async () => {
    const { svc } = funilDa(LAB);
    await expect(svc.seedDefaults(LAB)).rejects.toBeInstanceOf(ForbiddenException);
  });
});

describe('PipelinesService.reorderStages', () => {
  const itens = [
    { id: 'e1', position: 1 },
    { id: 'e2', position: 0 },
  ];

  it('laboratório: reordena etapas do próprio funil', async () => {
    const { svc, prisma, buscas } = funilDa(LAB);
    await expect(svc.reorderStages(FUNIL, itens, LAB)).resolves.toEqual({ ok: true });
    expect(buscas).toHaveLength(1);
    expect(buscas[0].where.pipeline_id).toBe(FUNIL);
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
  });

  it('laboratório: etapa que não é do funil recusa e não grava nada', async () => {
    const { svc, prisma } = funilDa(LAB);
    await expect(svc.reorderStages(FUNIL, [...itens, { id: 'de-outro-funil', position: 2 }], LAB)).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('clínica: a mesma gravação de sempre, sem conferência extra de etapas', async () => {
    const { svc, prisma, buscas } = funilDa(CLINICA);
    await expect(svc.reorderStages(FUNIL, itens, CLINICA)).resolves.toEqual({ ok: true });
    expect(buscas).toHaveLength(0);
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
  });
});

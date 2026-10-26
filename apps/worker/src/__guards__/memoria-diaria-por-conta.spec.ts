/**
 * "Extração automática diária" (Base de Conhecimento) é POR CONTA no worker:
 * a extração da meia-noite e o perfil da organização das 02h decidem conta a
 * conta (MEMORY_BATCH_ENABLED_<conta> ?? global antiga se a conta for legada ??
 * ligada). Uma clínica desligando não para a outra; a conta nova não herda o
 * global antigo. O freio de laboratório (F2) continua (lab-gate-ia.spec.ts).
 */
import { Logger } from '@nestjs/common';
import { __limparCacheContaLegada, __limparCacheLabTenants } from '@crm/shared';
import { DailyMemoryBatchProcessor } from '../memory/daily-memory-batch.processor';
import { OrgProfileConsolidationProcessor } from '../memory/org-profile-consolidation.processor';
import { MemoryDedupService } from '../memory/memory-dedup.service';

const A = 'conta-a';
const B = 'conta-b';
const NOVA = 'conta-nova';
const LAB = 'conta-lab';
const CRIACAO: Record<string, Date> = {
  [A]: new Date('2025-01-10T10:00:00Z'),
  [B]: new Date('2026-02-20T10:00:00Z'),
  [NOVA]: new Date('2026-11-02T10:00:00Z'),
  [LAB]: new Date('2026-11-03T10:00:00Z'),
};

beforeAll(() => {
  for (const m of ['log', 'warn', 'debug', 'error'] as const) {
    jest.spyOn(Logger.prototype, m).mockImplementation(() => undefined);
  }
});
beforeEach(() => {
  __limparCacheLabTenants();
  __limparCacheContaLegada();
});

function banco(settings: Record<string, string>, contas = [A, B, NOVA], labs: string[] = []) {
  return {
    tenantBusinessProfile: { findMany: jest.fn(async () => labs.map((tenant_id) => ({ tenant_id }))) },
    tenant: {
      findMany: jest.fn(async () => contas.map((id) => ({ id }))),
      findUnique: jest.fn(async ({ where }: any) => (CRIACAO[where.id] ? { created_at: CRIACAO[where.id] } : null)),
    },
    globalSetting: {
      findUnique: jest.fn(async ({ where }: any) => (where.key in settings ? { value: settings[where.key] } : null)),
    },
    organizationProfile: { findMany: jest.fn(async () => []) },
    $queryRaw: jest.fn(async () => []),
    memory: { update: jest.fn() },
  };
}

async function extracao(settings: Record<string, string>, contas?: string[], labs?: string[]) {
  const prisma: any = banco(settings, contas, labs);
  const fila: any = { add: jest.fn(async () => ({})) };
  await new DailyMemoryBatchProcessor(prisma, {} as any, {} as any, {} as any, fila).scheduleDailyExtraction();
  return fila.add.mock.calls.map((c: any[]) => c[1].tenant_id);
}

async function perfil(settings: Record<string, string>, contas?: string[], labs?: string[]) {
  const prisma: any = banco(settings, contas, labs);
  const svc: any = new OrgProfileConsolidationProcessor(prisma, {} as any);
  svc.consolidateIncremental = jest.fn(async () => ({ changed: false }));
  await svc.scheduleDailyConsolidation();
  return svc.consolidateIncremental.mock.calls.map((c: any[]) => c[0]);
}

describe('Extração diária de memórias — decidida por conta', () => {
  describe('uma clínica desligando não para a outra', () => {
    it('extração: B desligou a dela, A e a conta nova seguem', async () => {
      expect(await extracao({ MEMORY_BATCH_ENABLED: 'true', [`MEMORY_BATCH_ENABLED_${B}`]: 'false' })).toEqual([A, NOVA]);
    });

    it('perfil da organização: pula só a B', async () => {
      expect(await perfil({ MEMORY_BATCH_ENABLED: 'true', [`MEMORY_BATCH_ENABLED_${B}`]: 'false' })).toEqual([A, NOVA]);
    });

    it('A ligou a dela com a global desligada: só a A (a B legada segue a global)', async () => {
      const cfg = { MEMORY_BATCH_ENABLED: 'false', [`MEMORY_BATCH_ENABLED_${A}`]: 'true' };
      expect(await extracao(cfg, [A, B])).toEqual([A]);
      expect(await perfil(cfg, [A, B])).toEqual([A]);
    });
  });

  describe('sem chave de conta, as clínicas de hoje ficam como estavam', () => {
    it('sem nada salvo: todas (como hoje)', async () => {
      expect(await extracao({}, [A, B])).toEqual([A, B]);
      expect(await perfil({}, [A, B])).toEqual([A, B]);
    });

    it('global desligada: nenhuma conta legada roda (como hoje)', async () => {
      expect(await extracao({ MEMORY_BATCH_ENABLED: 'false' }, [A, B])).toEqual([]);
      expect(await perfil({ MEMORY_BATCH_ENABLED: 'FALSE' }, [A, B])).toEqual([]);
    });
  });

  describe('conta nova não herda a global antiga', () => {
    it('global desligada: a conta nova sem a própria roda (padrão ligado)', async () => {
      expect(await extracao({ MEMORY_BATCH_ENABLED: 'false' })).toEqual([NOVA]);
      expect(await perfil({ MEMORY_BATCH_ENABLED: 'false' })).toEqual([NOVA]);
    });

    it('conta nova desligando a dela: não roda', async () => {
      expect(await extracao({ [`MEMORY_BATCH_ENABLED_${NOVA}`]: 'false' })).toEqual([A, B]);
    });
  });

  it('o laboratório continua fora, mesmo com a chave ligada', async () => {
    const cfg = { [`MEMORY_BATCH_ENABLED_${LAB}`]: 'true' };
    expect(await extracao(cfg, [A, LAB], [LAB])).toEqual([A]);
    expect(await perfil(cfg, [A, LAB], [LAB])).toEqual([A]);
  });

  it('falha ao ler a chave de uma conta: só ela fica de fora nesta noite', async () => {
    const prisma: any = banco({});
    const original = prisma.globalSetting.findUnique;
    prisma.globalSetting.findUnique = jest.fn(async (args: any) => {
      if (args.where.key === `MEMORY_BATCH_ENABLED_${B}`) throw new Error('banco fora');
      return original(args);
    });
    const fila: any = { add: jest.fn(async () => ({})) };
    await new DailyMemoryBatchProcessor(prisma, {} as any, {} as any, {} as any, fila).scheduleDailyExtraction();
    expect(fila.add.mock.calls.map((c: any[]) => c[1].tenant_id)).toEqual([A, NOVA]);
  });

  it('a limpeza de duplicadas segue só a chave global (sem mudança)', async () => {
    const prisma: any = banco({ MEMORY_BATCH_ENABLED: 'false', [`MEMORY_BATCH_ENABLED_${A}`]: 'true' });
    await new MemoryDedupService(prisma).dedupOrganizationMemories();
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
    expect(prisma.globalSetting.findUnique.mock.calls.map((c: any[]) => c[0].where.key)).toEqual(['MEMORY_BATCH_ENABLED']);
  });
});

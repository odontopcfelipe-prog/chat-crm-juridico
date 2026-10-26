/**
 * F2 do laboratório — freio da IA no worker. Laboratório não tem IA em nenhuma
 * camada; a clínica segue EXATAMENTE como antes.
 *
 *  - AiProcessor.process: todo job de IA (resposta, memory-op, 2ª tentativa, chat
 *    de teste) de conversa de laboratório para antes da transcrição e da OpenAI;
 *  - isChipAiEnabledForClinic: false para laboratório;
 *  - fora do expediente, religar após 24 h, memória noturna e perfil da
 *    organização: laboratório fica de fora.
 *
 * "Sem laboratório" = TenantBusinessProfile vazia, o caso de produção hoje.
 */
import { Logger } from '@nestjs/common';
import { __limparCacheLabTenants } from '@crm/shared';
import { AiProcessor } from '../ai/ai.processor';
import { isChipAiEnabledForClinic } from '../ai/clinic-ai-context';
import { AfterHoursService } from '../after-hours/after-hours.service';
import { AiReactivationCronService } from '../ai/ai-reactivation-cron.service';
import { MemoryJobsProcessor } from '../memory/memory-jobs.processor';
import { DailyMemoryBatchProcessor } from '../memory/daily-memory-batch.processor';
import { OrgProfileConsolidationProcessor } from '../memory/org-profile-consolidation.processor';
import { colunasLigadasPorClinica } from '../reativacao/reativacao-dados';
import { reativacaoColunaKey } from '@crm/shared';

const CLINICA = 'tenant-clinica';
const OUTRA_CLINICA = 'tenant-clinica-2';
const LAB = 'tenant-lab';

beforeAll(() => {
  for (const m of ['log', 'warn', 'debug', 'error'] as const) {
    jest.spyOn(Logger.prototype, m).mockImplementation(() => undefined);
  }
});
beforeEach(() => __limparCacheLabTenants());

const perfis = (labs: string[]) => ({
  findMany: jest.fn(async () => labs.map((tenant_id) => ({ tenant_id }))),
});

// ─── AiProcessor.process ────────────────────────────────────────────────────

const PAROU = new Error('passou do freio');

function montarIa(labs: string[], convo: any, donoDoChip: string | null = null) {
  const prisma: any = {
    tenantBusinessProfile: perfis(labs),
    conversation: { findUnique: jest.fn(async () => convo) },
    instance: { findFirst: jest.fn(async () => (donoDoChip ? { tenant_id: donoDoChip } : null)) },
  };
  const settings: any = { getOpenAiKey: jest.fn(async () => 'sk-teste') };
  const proc: any = new AiProcessor(prisma, settings, {} as any, {} as any, {} as any, {} as any);
  // 1º passo depois do freio: se for chamado, o job passou (e para aqui).
  proc.autoTranscribeAudios = jest.fn(async () => {
    throw PAROU;
  });
  proc.buildTestConversation = jest.fn(async (d: any) => ({ ...convo, tenant_id: d.tenantId }));
  return { proc, prisma };
}

const conversa = (tenant_id: string | null, leadTenant: string | null, instance_name: string | null = 'chip-1') => ({
  id: 'conv-1',
  tenant_id,
  lead_id: 'lead-1',
  lead: { id: 'lead-1', tenant_id: leadTenant },
  ai_mode: true,
  instance_name,
  messages: [{ id: 'm-1', direction: 'in', type: 'text', text: 'oi', created_at: new Date() }],
});

const job = (data: any) => ({ id: 'job-1', name: 'process_ai_response', data }) as any;

async function rodar(proc: any, data: any) {
  try {
    await proc.process(job(data));
  } catch (e) {
    if (e !== PAROU) throw e;
  }
}

describe('AiProcessor — job de IA de laboratório para no freio', () => {
  it('clínica sem laboratório cadastrado: segue para a transcrição (fluxo de hoje)', async () => {
    const { proc, prisma } = montarIa([], conversa(CLINICA, CLINICA));
    await rodar(proc, { conversation_id: 'conv-1' });
    expect(proc.autoTranscribeAudios).toHaveBeenCalledTimes(1);
    expect(prisma.instance.findFirst).not.toHaveBeenCalled();
  });

  it('clínica com OUTRA conta laboratório: segue igual', async () => {
    const { proc } = montarIa([LAB], conversa(CLINICA, CLINICA), CLINICA);
    await rodar(proc, { conversation_id: 'conv-1' });
    expect(proc.autoTranscribeAudios).toHaveBeenCalledTimes(1);
  });

  it('conversa de laboratório: para antes da transcrição/OpenAI', async () => {
    const { proc } = montarIa([LAB], conversa(LAB, LAB));
    await rodar(proc, { conversation_id: 'conv-1' });
    expect(proc.autoTranscribeAudios).not.toHaveBeenCalled();
  });

  it('conversa legada sem conta, contato do laboratório: para', async () => {
    const { proc } = montarIa([LAB], conversa(null, LAB));
    await rodar(proc, { conversation_id: 'conv-1' });
    expect(proc.autoTranscribeAudios).not.toHaveBeenCalled();
  });

  it('conversa e contato sem conta, chip do laboratório: para', async () => {
    const { proc } = montarIa([LAB], conversa(null, null), LAB);
    await rodar(proc, { conversation_id: 'conv-1' });
    expect(proc.autoTranscribeAudios).not.toHaveBeenCalled();
  });

  // retryAfterMessageAt depois da última mensagem: a checagem própria da 2ª
  // tentativa deixa passar — quem barra o laboratório é só o freio.
  const retry = () => ({
    conversation_id: 'conv-1',
    schedulingRetry: true,
    retryAfterMessageAt: new Date(Date.now() + 60_000).toISOString(),
  });

  it('2ª tentativa de agendamento de clínica: segue', async () => {
    const { proc } = montarIa([LAB], conversa(CLINICA, CLINICA), CLINICA);
    await rodar(proc, retry());
    expect(proc.autoTranscribeAudios).toHaveBeenCalledTimes(1);
  });

  it('2ª tentativa de agendamento de laboratório: para', async () => {
    const { proc } = montarIa([LAB], conversa(LAB, LAB));
    await rodar(proc, retry());
    expect(proc.autoTranscribeAudios).not.toHaveBeenCalled();
  });

  it('chat de teste (Ajustes › IA) de laboratório: para; de clínica: segue', async () => {
    const lab = montarIa([LAB], conversa(null, null, null));
    await rodar(lab.proc, { conversation_id: '__ai_test__', dryRun: true, tenantId: LAB, history: [] });
    expect(lab.proc.autoTranscribeAudios).not.toHaveBeenCalled();
    __limparCacheLabTenants();
    const cli = montarIa([LAB], conversa(null, null, null));
    await rodar(cli.proc, { conversation_id: '__ai_test__', dryRun: true, tenantId: CLINICA, history: [] });
    expect(cli.proc.autoTranscribeAudios).toHaveBeenCalledTimes(1);
  });
});

// ─── isChipAiEnabledForClinic ───────────────────────────────────────────────

function prismaChaves(labs: string[], tenantVal: string | null, globalVal: string | null, kill: string | null): any {
  return {
    tenantBusinessProfile: perfis(labs),
    tenantSetting: { findUnique: jest.fn(async () => (tenantVal == null ? null : { value: tenantVal })) },
    globalSetting: {
      findUnique: jest.fn(async ({ where }: any) => {
        if (where.key === 'WHATSAPP_AI_ENABLED') return kill == null ? null : { value: kill };
        return globalVal == null ? null : { value: globalVal };
      }),
    },
  };
}

describe('isChipAiEnabledForClinic — laboratório sempre desligado, clínica igual', () => {
  const casos: Array<[string | null, string | null, string | null, boolean]> = [
    [null, null, null, true],
    [null, 'true', null, true],
    [null, 'false', null, false],
    ['true', 'false', null, true],
    ['false', 'true', null, false],
    [null, null, 'false', false],
  ];
  it.each(casos)('clínica: tenant=%s global=%s kill=%s → %s', async (t, g, k, esperado) => {
    expect(await isChipAiEnabledForClinic(prismaChaves([LAB], t, g, k), CLINICA, 'COMERCIAL')).toBe(esperado);
  });
  it.each(casos)('laboratório: tenant=%s global=%s kill=%s → false', async (t, g, k) => {
    expect(await isChipAiEnabledForClinic(prismaChaves([LAB], t, g, k), LAB, 'COMERCIAL')).toBe(false);
  });
});

// ─── fora do expediente ─────────────────────────────────────────────────────

describe('AfterHours — laboratório fica de fora', () => {
  function montar(labs: string[]) {
    const prisma: any = {
      tenantBusinessProfile: perfis(labs),
      tenant: { findMany: jest.fn(async () => [{ id: CLINICA }, { id: LAB }, { id: OUTRA_CLINICA }]) },
    };
    const svc: any = new AfterHoursService(prisma);
    svc.tickTenant = jest.fn(async () => undefined);
    return { svc, prisma };
  }

  it('sem laboratório cadastrado: todas as contas + as sem clínica, na mesma ordem', async () => {
    const { svc, prisma } = montar([]);
    await svc.tick();
    expect(prisma.tenant.findMany).toHaveBeenCalledWith({ where: { status: { not: 'DELETED' } }, select: { id: true } });
    expect(svc.tickTenant.mock.calls.map((c: any[]) => c[0])).toEqual([CLINICA, LAB, OUTRA_CLINICA, null]);
  });

  it('com laboratório: ele sai, as clínicas e as sem clínica seguem', async () => {
    const { svc } = montar([LAB]);
    await svc.tick();
    expect(svc.tickTenant.mock.calls.map((c: any[]) => c[0])).toEqual([CLINICA, OUTRA_CLINICA, null]);
  });
});

// ─── religar a IA após 24 h ─────────────────────────────────────────────────

describe('AiReactivation — laboratório fica fora da busca', () => {
  function montar(labs: string[]) {
    const prisma: any = {
      tenantBusinessProfile: perfis(labs),
      conversation: { findMany: jest.fn(async () => []), update: jest.fn() },
    };
    return { svc: new AiReactivationCronService(prisma), prisma };
  }

  it('sem laboratório cadastrado: mesmo where de antes', async () => {
    const { svc, prisma } = montar([]);
    await svc.reactivateStaleConversations();
    const where = prisma.conversation.findMany.mock.calls[0][0].where;
    expect(Object.keys(where)).toEqual(['ai_mode', 'ai_mode_disabled_at', 'status', 'ai_mode_source', 'lead']);
    expect(where.ai_mode).toBe(false);
    expect(where.ai_mode_disabled_at.lt).toBeInstanceOf(Date);
    expect(where.status).toEqual({ notIn: ['FECHADO'] });
    expect(where.ai_mode_source).toEqual({ not: 'MANUAL' });
    expect(where.lead).toEqual({ stage: { notIn: ['PERDIDO', 'FINALIZADO'] } });
  });

  it('com laboratório: where de antes + fora os laboratórios (null-safe)', async () => {
    const { svc, prisma } = montar([LAB]);
    await svc.reactivateStaleConversations();
    const where = prisma.conversation.findMany.mock.calls[0][0].where;
    expect(where.AND).toHaveLength(2);
    expect(where.AND[0].ai_mode).toBe(false);
    expect(where.AND[1]).toEqual({ OR: [{ tenant_id: null }, { tenant_id: { notIn: [LAB] } }] });
  });
});

// ─── régua de reativação de leads (planejador, redator com IA e envio) ──────

describe('Régua de reativação — laboratório não tem coluna ligada', () => {
  const ligada = (coluna: any, tenant: string) => ({ key: reativacaoColunaKey(coluna, tenant) });
  function montar(labs: string[]) {
    const findMany = jest.fn(async () => [
      ligada('novo', CLINICA),
      ligada('conversa', CLINICA),
      ligada('novo', LAB),
      ligada('orcamento', OUTRA_CLINICA),
    ]);
    return { prisma: { tenantBusinessProfile: perfis(labs), globalSetting: { findMany } } as any, findMany };
  }
  const comoObjeto = (m: Map<string, Set<string>>) =>
    Object.fromEntries([...m].map(([t, s]) => [t, [...s].sort()]));

  it('sem laboratório cadastrado: todas as contas, como antes', async () => {
    const { prisma } = montar([]);
    expect(comoObjeto(await colunasLigadasPorClinica(prisma))).toEqual({
      [CLINICA]: ['conversa', 'novo'],
      [LAB]: ['novo'],
      [OUTRA_CLINICA]: ['orcamento'],
    });
  });

  it('com laboratório: ele some (o planejador cancela, o redator não escreve, nada sai)', async () => {
    const { prisma } = montar([LAB]);
    expect(comoObjeto(await colunasLigadasPorClinica(prisma))).toEqual({
      [CLINICA]: ['conversa', 'novo'],
      [OUTRA_CLINICA]: ['orcamento'],
    });
  });
});

// ─── memória (fila memory-jobs, extração noturna, perfil da organização) ────

describe('MemoryJobs — job de laboratório não roda', () => {
  function montar(labs: string[]) {
    const prisma: any = { tenantBusinessProfile: perfis(labs) };
    const batch: any = { processTenantBatch: jest.fn(async () => 'batch') };
    const profile: any = { consolidateAfterBatch: jest.fn(async () => 'after'), consolidateSingle: jest.fn(async () => 'single') };
    const org: any = { consolidateSingle: jest.fn(async () => 'org'), rebuildFromScratch: jest.fn(async () => 'rebuild') };
    return { proc: new MemoryJobsProcessor(prisma, batch, profile, org), batch, profile, org };
  }
  const nomes = ['daily-batch-extract', 'manual-extract', 'consolidate-profiles-after-batch', 'consolidate-profile', 'consolidate-org-profile', 'rebuild-org-profile'];

  it.each(nomes)('clínica: %s é roteado como antes', async (nome) => {
    const { proc } = montar([LAB]);
    expect(await proc.process({ name: nome, data: { tenant_id: CLINICA } } as any)).not.toBeNull();
  });

  it.each(nomes)('laboratório: %s não chega ao processador', async (nome) => {
    const { proc, batch, profile, org } = montar([LAB]);
    expect(await proc.process({ name: nome, data: { tenant_id: LAB } } as any)).toBeNull();
    for (const f of [batch.processTenantBatch, profile.consolidateAfterBatch, profile.consolidateSingle, org.consolidateSingle, org.rebuildFromScratch]) {
      expect(f).not.toHaveBeenCalled();
    }
  });
});

describe('Extração noturna e perfil da organização — laboratório fica de fora', () => {
  it('extração noturna: agenda só as clínicas (sem laboratório: todas)', async () => {
    for (const [labs, esperado] of [
      [[], [CLINICA, LAB, OUTRA_CLINICA]],
      [[LAB], [CLINICA, OUTRA_CLINICA]],
    ] as Array<[string[], string[]]>) {
      __limparCacheLabTenants();
      const prisma: any = {
        tenantBusinessProfile: perfis(labs),
        globalSetting: { findUnique: jest.fn(async () => null) },
        tenant: { findMany: jest.fn(async () => [{ id: CLINICA }, { id: LAB }, { id: OUTRA_CLINICA }]) },
      };
      const fila: any = { add: jest.fn(async () => ({})) };
      const svc = new DailyMemoryBatchProcessor(prisma, {} as any, {} as any, {} as any, fila);
      await svc.scheduleDailyExtraction();
      expect(fila.add.mock.calls.map((c: any[]) => c[1].tenant_id)).toEqual(esperado);
    }
  });

  it('perfil da organização: consolida só as clínicas (sem laboratório: todas)', async () => {
    for (const [labs, esperado] of [
      [[], [CLINICA, LAB, OUTRA_CLINICA]],
      [[LAB], [CLINICA, OUTRA_CLINICA]],
    ] as Array<[string[], string[]]>) {
      __limparCacheLabTenants();
      const prisma: any = {
        tenantBusinessProfile: perfis(labs),
        tenant: { findMany: jest.fn(async () => [{ id: CLINICA }, { id: LAB }, { id: OUTRA_CLINICA }]) },
        organizationProfile: { findMany: jest.fn(async () => []) },
      };
      const svc: any = new OrgProfileConsolidationProcessor(prisma, {} as any);
      svc.consolidateIncremental = jest.fn(async () => ({ changed: false }));
      await svc.consolidateAll();
      expect(svc.consolidateIncremental.mock.calls.map((c: any[]) => c[0])).toEqual(esperado);
    }
  });
});

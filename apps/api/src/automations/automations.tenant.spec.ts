/**
 * F0b — sequências de follow-up e regras "sem resposta" ficam na clínica delas.
 *
 * Antes: o auto-enroll por etapa inscrevia o lead em sequências de TODAS as
 * clínicas, e a regra NO_RESPONSE_24H/48H de uma clínica agia nas conversas de
 * todas. Agora cada uma só alcança os leads/conversas da própria clínica; as
 * globais (sem tenant) e os registros legados (sem tenant) seguem como antes.
 */
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { __limparCacheLabTenants } from '@crm/shared';
import { AutomationsService, regraValeParaConversa } from './automations.service';
import { FollowupService } from '../followup/followup.service';

describe('regraValeParaConversa', () => {
  it.each([
    ['regra da clínica A, conversa da A', 'a', 'a', true],
    ['regra da clínica A, conversa da B', 'a', 'b', false],
    ['regra global, conversa da B', null, 'b', true],
    ['regra da clínica A, conversa legada sem clínica', 'a', null, true],
  ])('%s', (_n, rule, conv, esperado) => {
    expect(regraValeParaConversa({ tenant_id: rule }, { tenant_id: conv })).toBe(esperado);
  });
});

describe('AutomationsService.checkNoResponse — tenant', () => {
  it('regra NO_RESPONSE_24H de uma clínica só age nas conversas dela', async () => {
    const notas: string[] = [];
    const prisma: any = {
      automationRule: {
        findMany: jest.fn(async ({ where }: any) =>
          where.trigger === 'NO_RESPONSE_24H'
            ? [
                { id: 'r-a', tenant_id: 'a', action: 'SEND_INTERNAL_NOTE', action_value: 'A' },
                { id: 'r-g', tenant_id: null, action: 'SEND_INTERNAL_NOTE', action_value: 'G' },
              ]
            : [],
        ),
      },
      conversation: {
        findMany: jest.fn(async () => [
          { id: 'c-a', lead_id: null, tenant_id: 'a' },
          { id: 'c-b', lead_id: null, tenant_id: 'b' },
          { id: 'c-0', lead_id: null, tenant_id: null },
        ]),
      },
      message: {
        create: jest.fn(async ({ data }: any) => {
          notas.push(`${data.conversation_id}:${data.text}`);
        }),
      },
    };
    const svc = new AutomationsService(prisma, {} as any);
    await svc.checkNoResponse();
    expect(notas.sort()).toEqual(
      ['c-a:Automação: A', 'c-a:Automação: G', 'c-b:Automação: G', 'c-0:Automação: A', 'c-0:Automação: G'].sort(),
    );
  });
});

describe('FollowupService — tenant', () => {
  function montar(lead: { id: string; tenant_id: string | null; is_client?: boolean }, sequencias: any[]) {
    const inscritos: string[] = [];
    const prisma: any = {
      lead: { findUnique: jest.fn(async () => ({ is_client: false, ...lead })) },
      followupSequence: {
        findMany: jest.fn(async ({ where }: any) =>
          sequencias.filter(
            (s) =>
              s.auto_enroll_stages.includes(where.auto_enroll_stages.has) &&
              (!where.OR || where.OR.some((o: any) => o.tenant_id === s.tenant_id)),
          ),
        ),
        findUnique: jest.fn(async ({ where }: any) => sequencias.find((s) => s.id === where.id) ?? null),
      },
    };
    const svc = new FollowupService(prisma, {} as any);
    jest.spyOn(svc, 'enrollLead').mockImplementation(async (_l: string, seqId: string) => {
      inscritos.push(seqId);
      return {} as any;
    });
    return { svc, inscritos, prisma };
  }

  const SEQS = [
    { id: 's-a', tenant_id: 'a', active: true, auto_enroll_stages: ['NOVO'], category: 'OUTRO' },
    { id: 's-b', tenant_id: 'b', active: true, auto_enroll_stages: ['NOVO'], category: 'OUTRO' },
    { id: 's-g', tenant_id: null, active: true, auto_enroll_stages: ['NOVO'], category: 'OUTRO' },
  ];

  it('auto-enroll: lead da clínica A só entra nas sequências da A e nas globais', async () => {
    const { svc, inscritos } = montar({ id: 'l1', tenant_id: 'a' }, SEQS);
    await svc.autoEnrollByStage('l1', 'NOVO');
    expect(inscritos.sort()).toEqual(['s-a', 's-g']);
  });

  it('auto-enroll: lead legado sem clínica segue como antes (todas)', async () => {
    const { svc, inscritos } = montar({ id: 'l0', tenant_id: null }, SEQS);
    await svc.autoEnrollByStage('l0', 'NOVO');
    expect(inscritos.sort()).toEqual(['s-a', 's-b', 's-g']);
  });

  it('enrollLead recusa sequência de outra clínica', async () => {
    const prisma: any = {
      lead: { findUnique: jest.fn(async () => ({ id: 'l1', tenant_id: 'a' })) },
      followupSequence: { findUnique: jest.fn(async () => ({ ...SEQS[1], steps: [] })) },
    };
    const svc = new FollowupService(prisma, {} as any);
    await expect(svc.enrollLead('l1', 's-b')).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('AutomationsService — CREATE_TASK nasce na clínica', () => {
  function montarTarefa(lead: { tenant_id: string | null } | null, conv: { tenant_id: string | null } | null) {
    const criadas: any[] = [];
    const prisma: any = {
      lead: { findUnique: jest.fn(async () => lead) },
      conversation: { findUnique: jest.fn(async () => conv) },
      task: { create: jest.fn(async ({ data }: any) => criadas.push(data)) },
    };
    const svc = new AutomationsService(prisma, {} as any);
    const rodar = (rule: any, ctx: any) => (svc as any).executeAction(rule, ctx);
    return { rodar, criadas };
  }
  const regra = (tenant_id: string | null) => ({ action: 'CREATE_TASK', action_value: '{"title":"Ligar"}', tenant_id });

  it('pega a clínica do lead (antes: tarefa sem clínica, visível para todas)', async () => {
    const { rodar, criadas } = montarTarefa({ tenant_id: 'a' }, null);
    await rodar(regra(null), { leadId: 'l1' });
    expect(criadas[0]).toMatchObject({ tenant_id: 'a', title: 'Ligar', lead_id: 'l1' });
  });

  it('sem lead, pega a da conversa; sem as duas, a da regra', async () => {
    const c = montarTarefa(null, { tenant_id: 'b' });
    await c.rodar(regra('a'), { conversationId: 'c1' });
    expect(c.criadas[0].tenant_id).toBe('b');
    const r = montarTarefa(null, null);
    await r.rodar(regra('a'), {});
    expect(r.criadas[0].tenant_id).toBe('a');
  });

  it('nada conhecido (regra global, contexto legado) → como antes, sem clínica', async () => {
    const { rodar, criadas } = montarTarefa({ tenant_id: null }, null);
    await rodar(regra(null), { leadId: 'l0' });
    expect(criadas[0]).not.toHaveProperty('tenant_id');
  });
});

describe('AutomationsService — editar e apagar regra', () => {
  beforeEach(() => __limparCacheLabTenants());
  afterEach(() => __limparCacheLabTenants());

  const REGRAS: Record<string, any> = {
    'r-a': { tenant_id: 'a', action: 'ADD_TAG', action_value: 'x' },
    'r-seq': { tenant_id: 'a', action: 'ENROLL_FOLLOWUP', action_value: 's-a' },
    'r-b': { tenant_id: 'b', action: 'ADD_TAG', action_value: 'x' },
    'r-g': { tenant_id: null, action: 'ADD_TAG', action_value: 'x' },
  };
  const SEQUENCIAS: Record<string, any> = { 's-a': { tenant_id: 'a' }, 's-b': { tenant_id: 'b' }, 's-g': { tenant_id: null } };

  function montarRegras(labs: string[] = []) {
    const prisma: any = {
      tenantBusinessProfile: { findMany: jest.fn(async () => labs.map((tenant_id) => ({ tenant_id }))) },
      automationRule: {
        findUnique: jest.fn(async ({ where }: any) => REGRAS[where.id] ?? null),
        update: jest.fn(async (a: any) => a),
        delete: jest.fn(async () => ({})),
        create: jest.fn(async (a: any) => a.data),
      },
      followupSequence: { findUnique: jest.fn(async ({ where }: any) => SEQUENCIAS[where.id] ?? null) },
    };
    return { svc: new AutomationsService(prisma, {} as any), prisma };
  }

  it.each([[[] as string[]], [['a']]])('lista fechada: o corpo não muda a conta nem o id (laboratórios: %j)', async (labs) => {
    const { svc, prisma } = montarRegras(labs);
    await svc.update('r-a', { tenant_id: null, id: 'outro', created_at: new Date(0), enabled: false } as any, 'a');
    const data = prisma.automationRule.update.mock.calls[0][0].data;
    expect(data).toEqual({ name: undefined, trigger: undefined, action: undefined, action_value: undefined, enabled: false });
    expect(Object.keys(data).sort()).toEqual(['action', 'action_value', 'enabled', 'name', 'trigger']);
  });

  it('regra de outra conta responde 404 para qualquer tipo de conta, sem gravar', async () => {
    for (const labs of [[], ['a']]) {
      __limparCacheLabTenants();
      const { svc, prisma } = montarRegras(labs);
      await expect(svc.update('r-b', { enabled: false }, 'a')).rejects.toBeInstanceOf(NotFoundException);
      await expect(svc.remove('r-b', 'a')).rejects.toBeInstanceOf(NotFoundException);
      expect(prisma.automationRule.update).not.toHaveBeenCalled();
      expect(prisma.automationRule.delete).not.toHaveBeenCalled();
    }
  });

  it('regra inexistente responde 404', async () => {
    const { svc } = montarRegras();
    await expect(svc.update('nao-existe', { enabled: false }, 'a')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('clínica: a regra dela e a global continuam editáveis, como na tela', async () => {
    const { svc, prisma } = montarRegras();
    await svc.update('r-a', { enabled: false }, 'a');
    await svc.update('r-g', { enabled: false }, 'a');
    await svc.remove('r-g', 'a');
    expect(prisma.automationRule.update).toHaveBeenCalledTimes(2);
    expect(prisma.automationRule.delete).toHaveBeenCalledTimes(1);
  });

  it('laboratório: a regra global responde 404', async () => {
    const { svc, prisma } = montarRegras(['a']);
    await expect(svc.update('r-g', { enabled: false }, 'a')).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.automationRule.update).not.toHaveBeenCalled();
  });

  it('clínica: sequência de outra conta é recusada ao editar e ao criar; a dela e a global passam', async () => {
    const { svc, prisma } = montarRegras();
    await expect(svc.update('r-seq', { action_value: 's-b' }, 'a')).rejects.toBeInstanceOf(BadRequestException);
    await expect(svc.update('r-a', { action: 'ENROLL_FOLLOWUP', action_value: 's-b' }, 'a')).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      svc.create({ name: 'R', trigger: 'NEW_LEAD', action: 'ENROLL_FOLLOWUP', action_value: 's-b', tenant_id: 'a' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.automationRule.update).not.toHaveBeenCalled();
    expect(prisma.automationRule.create).not.toHaveBeenCalled();

    await svc.update('r-seq', { action_value: 's-a' }, 'a');
    await svc.update('r-seq', { action_value: 's-g' }, 'a');
    await svc.create({ name: 'R', trigger: 'NEW_LEAD', action: 'ENROLL_FOLLOWUP', action_value: 's-g', tenant_id: 'a' });
    expect(prisma.automationRule.update).toHaveBeenCalledTimes(2);
    expect(prisma.automationRule.create).toHaveBeenCalledTimes(1);
  });

  it('laboratório: ao editar, só sequência da própria conta (a global não); trocar a ação confere o valor gravado', async () => {
    const { svc, prisma } = montarRegras(['a']);
    await expect(svc.update('r-seq', { action_value: 's-g' }, 'a')).rejects.toBeInstanceOf(BadRequestException);
    await expect(svc.update('r-a', { action: 'ENROLL_FOLLOWUP' }, 'a')).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.automationRule.update).not.toHaveBeenCalled();
    await svc.update('r-seq', { action_value: 's-a' }, 'a');
    expect(prisma.automationRule.update).toHaveBeenCalledTimes(1);
  });

  it('ligar e desligar não confere a sequência', async () => {
    const { svc, prisma } = montarRegras();
    await svc.update('r-seq', { enabled: false }, 'a');
    expect(prisma.followupSequence.findUnique).not.toHaveBeenCalled();
    expect(prisma.automationRule.update).toHaveBeenCalledTimes(1);
  });
});

/**
 * F0b — sequências de follow-up e regras "sem resposta" ficam na clínica delas.
 *
 * Antes: o auto-enroll por etapa inscrevia o lead em sequências de TODAS as
 * clínicas, e a regra NO_RESPONSE_24H/48H de uma clínica agia nas conversas de
 * todas. Agora cada uma só alcança os leads/conversas da própria clínica; as
 * globais (sem tenant) e os registros legados (sem tenant) seguem como antes.
 */
import { NotFoundException } from '@nestjs/common';
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

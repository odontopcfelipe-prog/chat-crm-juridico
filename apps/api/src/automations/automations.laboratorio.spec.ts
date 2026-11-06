/**
 * Laboratório — regras de automação agem só na conta dele.
 *
 * "Sem resposta": a conversa do laboratório só entra se a PRÓPRIA conta tem regra ligada;
 * regra global (das clínicas) nunca age na conversa dele; regra do laboratório nunca age
 * fora dele. A regra "iniciar sequência" aponta só para sequência da própria conta.
 *
 * Banco de teste: dublê em memória. Dados de exemplo (repositório público).
 */
import { BadRequestException } from '@nestjs/common';
import { __limparCacheLabTenants } from '@crm/shared';
import { AutomationsService } from './automations.service';

const LAB = 'conta-lab';
const OUTRO_LAB = 'conta-lab-2';
const CLINICA = 'conta-clinica';

beforeEach(() => __limparCacheLabTenants());

function montar(regras24: any[], conversas: any[], leads: Record<string, string | null> = {}) {
  const notas: string[] = [];
  const wheres: any[] = [];
  const prisma: any = {
    tenantBusinessProfile: { findMany: jest.fn(async () => [{ tenant_id: LAB }, { tenant_id: OUTRO_LAB }]) },
    automationRule: {
      findMany: jest.fn(async ({ where }: any) => (where.trigger === 'NO_RESPONSE_24H' ? regras24 : [])),
    },
    conversation: {
      findMany: jest.fn(async ({ where }: any) => {
        wheres.push(where);
        return conversas;
      }),
    },
    lead: { findUnique: jest.fn(async ({ where }: any) => ({ tenant_id: leads[where.id] ?? null })) },
    followupSequence: { findUnique: jest.fn(async ({ where }: any) => (where.id === 's-lab' ? { tenant_id: LAB } : { tenant_id: null })) },
    message: {
      create: jest.fn(async ({ data }: any) => {
        notas.push(`${data.conversation_id}:${data.text}`);
      }),
    },
  };
  return { svc: new AutomationsService(prisma, {} as any), notas, wheres, prisma };
}

const nota = (id: string, tenant: string | null, texto: string) => ({ id, tenant_id: tenant, action: 'SEND_INTERNAL_NOTE', action_value: texto });

describe('checkNoResponse com laboratório', () => {
  it('conversa de laboratório sem regra própria fica fora da busca', async () => {
    const { svc, wheres } = montar([nota('r-g', null, 'G')], []);
    await svc.checkNoResponse();
    const dentro = JSON.stringify(wheres[0]);
    expect(dentro).toContain(LAB);
    expect(dentro).toContain(OUTRO_LAB);
  });

  it('laboratório com regra própria entra na busca; o outro, sem regra, continua fora', async () => {
    const { svc, wheres } = montar([nota('r-lab', LAB, 'L')], []);
    await svc.checkNoResponse();
    const fora = JSON.stringify(wheres[0]);
    expect(fora).toContain(OUTRO_LAB);
    expect(fora).not.toContain(`"${LAB}"`);
  });

  it('regra do laboratório age só na conversa dele; regra global e de outra conta nunca', async () => {
    const { svc, notas } = montar(
      [nota('r-lab', LAB, 'L'), nota('r-glob', null, 'G'), nota('r-cli', CLINICA, 'C')],
      [
        { id: 'c-lab', lead_id: null, tenant_id: LAB },
        { id: 'c-cli', lead_id: null, tenant_id: CLINICA },
        { id: 'c-leg', lead_id: 'l-lab', tenant_id: null }, // conversa legada (sem conta) de contato do laboratório
        { id: 'c-leg-cli', lead_id: 'l-cli', tenant_id: null },
      ],
      { 'l-lab': LAB, 'l-cli': CLINICA },
    );
    await svc.checkNoResponse();
    expect(notas.sort()).toEqual(
      [
        'c-lab:Automação: L',
        'c-leg:Automação: L', // legada, mas do contato do laboratório: a regra dele vale
        'c-cli:Automação: G',
        'c-cli:Automação: C',
        'c-leg-cli:Automação: G',
        'c-leg-cli:Automação: C',
      ].sort(),
    );
  });
});

describe('criar regra "iniciar sequência"', () => {
  it('no laboratório só aceita sequência da própria conta', async () => {
    const { svc, prisma } = montar([], []);
    prisma.automationRule.create = jest.fn(async ({ data }: any) => data);
    await expect(
      svc.create({ name: 'R', trigger: 'NEW_LEAD', action: 'ENROLL_FOLLOWUP', action_value: 's-global', tenant_id: LAB }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await svc.create({ name: 'R', trigger: 'NEW_LEAD', action: 'ENROLL_FOLLOWUP', action_value: 's-lab', tenant_id: LAB });
    expect(prisma.automationRule.create).toHaveBeenCalledTimes(1);
    // clínica: sem conferência nova
    await svc.create({ name: 'R', trigger: 'NEW_LEAD', action: 'ENROLL_FOLLOWUP', action_value: 's-global', tenant_id: CLINICA });
    expect(prisma.automationRule.create).toHaveBeenCalledTimes(2);
  });
});

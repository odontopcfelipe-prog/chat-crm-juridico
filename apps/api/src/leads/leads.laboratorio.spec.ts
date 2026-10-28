/**
 * F5 do laboratório — funil (LeadsService) numa conta de LABORATÓRIO.
 *
 * No laboratório o cliente (dentista ou clínica) nasce do cadastro manual e não há
 * IA, área de atendimento nem setor Clínica. Então, na conta de laboratório:
 *  - trocar de etapa não grava a memória da IA;
 *  - FINALIZADO não exige área de atendimento, não religa a IA (POS_VENDA) e não cria
 *    cadastro a partir do contato (o mesmo vale para as etapas que criariam);
 *  - "criar cadastro a partir do contato" (ensurePatient) é recusado (VERTICAL_DENIED);
 *  - o 1º pagamento promove o contato que ainda não é cliente (promoteToPatientIfEligible)
 *    pelo caminho do laboratório: vira cliente e FINALIZADO, sem os efeitos acima;
 *  - a promoção (promoteLeadCore) não troca a conversa de setor;
 *  - cliente não volta a ser lead sozinho (demoteLeadById).
 * Cada caso registra `[LAB-GATE] ...` no log.
 *
 * Clínica: as MESMAS chamadas, na MESMA ordem e com os MESMOS argumentos sem
 * laboratório cadastrado e com OUTRA conta laboratório (a única coisa nova é a
 * leitura da lista de laboratórios, que fica fora do rastro).
 *
 * Sem banco: o Prisma é um gravador que guarda o estado do lead; serviços vizinhos
 * são fakes que anotam a chamada no mesmo rastro. Relógio fixo; dados de exemplo.
 */
import { ForbiddenException, Logger } from '@nestjs/common';
import { __limparCacheLabTenants } from '@crm/shared';
import { CODIGO_VERTICAL_NEGADA } from '../common/lab-gate.util';
import { FollowupService } from '../followup/followup.service';
import { PatientsService } from '../patients/patients.service';
import { LeadsController } from './leads.controller';
import { LeadsService } from './leads.service';

const AGORA = new Date('2026-10-28T15:00:00.000Z');
const CLINICA = 'tenant-clinica-exemplo';
const LAB = 'tenant-lab-exemplo';
const LEAD = 'lead-1';
const PACIENTE = 'cadastro-1';
const CHIP_CLINICA = { name: 'chip-clinica', inbox_id: 'inbox-clinica' };
const CHIP_COMERCIAL = { name: 'chip-comercial', inbox_id: 'inbox-comercial' };
const ETAPAS = [
  { id: 'etapa-inicial', slug: 'inicial', position: 0, is_initial: true, is_won: false, is_lost: false },
  { id: 'etapa-qualificando', slug: 'qualificando', position: 1, is_initial: false, is_won: false, is_lost: false },
  { id: 'etapa-aceita', slug: 'avaliacao-aceita', position: 2, is_initial: false, is_won: false, is_lost: false },
  { id: 'etapa-orcamento', slug: 'orcamento-enviado', position: 3, is_initial: false, is_won: false, is_lost: false },
  { id: 'etapa-ganho', slug: 'contrato-assinado', position: 8, is_initial: false, is_won: true, is_lost: false },
  { id: 'etapa-perdido', slug: 'perdido', position: 9, is_initial: false, is_won: false, is_lost: true },
];

type Efeito = [string, ...any[]];

let logs: { nivel: string; msg: string }[] = [];
const registrou = (nivel: string, trecho: string) => logs.some((l) => l.nivel === nivel && l.msg.includes(trecho));
const avisos = () => logs.filter((l) => l.nivel === 'warn' || l.nivel === 'error').map((l) => l.msg);

beforeEach(() => {
  logs = [];
  __limparCacheLabTenants();
  jest.useFakeTimers({
    now: AGORA,
    doNotFake: [
      'nextTick', 'setImmediate', 'clearImmediate', 'setTimeout', 'clearTimeout',
      'setInterval', 'clearInterval', 'queueMicrotask', 'hrtime', 'performance',
    ],
  });
  for (const nivel of ['log', 'warn', 'debug', 'error', 'verbose'] as const) {
    jest.spyOn(Logger.prototype, nivel).mockImplementation((msg: any) => {
      logs.push({ nivel, msg: String(msg) });
    });
  }
});
afterEach(() => {
  jest.restoreAllMocks();
  jest.useRealTimers();
});

interface Cenario {
  /** Conta do lead (null = lead legado sem conta). */
  conta: string | null;
  /** Contas de laboratório cadastradas. */
  labs: string[];
  is_client: boolean;
  stage: string;
  /** A conversa tem área de atendimento (especialidade). */
  especialidade: boolean;
  /** Cobrança paga (patientEvidence). */
  pagou: boolean;
}

/** Banco gravador + LeadsService REAL com vizinhos falsos, num rastro só. */
function montar(c: Partial<Cenario> = {}) {
  const cen: Cenario = { conta: CLINICA, labs: [], is_client: false, stage: 'QUALIFICANDO', especialidade: false, pagou: false, ...c };
  __limparCacheLabTenants();
  const efeitos: Efeito[] = [];
  const lead: Record<string, any> = {
    id: LEAD,
    tenant_id: cen.conta,
    name: 'Contato Exemplo',
    is_client: cen.is_client,
    became_client_at: cen.is_client ? new Date('2026-01-10T12:00:00.000Z') : null,
    stage: cen.stage,
    stage_id: cen.is_client ? 'etapa-ganho' : 'etapa-qualificando',
    pipeline_id: 'funil-1',
  };
  const respostas: Record<string, (a: any) => any> = {
    'lead.findUnique': (a) => (a.where.id === LEAD ? { ...lead } : null),
    'lead.update': (a) => {
      Object.assign(lead, a.data);
      return { ...lead };
    },
    'lead.updateMany': (a) => {
      if ('is_client' in a.where && a.where.is_client !== lead.is_client) return { count: 0 };
      Object.assign(lead, a.data);
      return { count: 1 };
    },
    'patient.findUnique': () => ({ id: PACIENTE, tenant_id: cen.conta, lead_id: LEAD }),
    'patient.findMany': () => [{ id: PACIENTE }],
    'calendarEvent.findFirst': () => null,
    'paymentGatewayCharge.findFirst': () => (cen.pagou ? { id: 'cobranca-1' } : null),
    'followupEnrollment.findMany': () => [{ id: 'inscricao-1' }],
    'pipelineStage.findFirst': (a) => {
      if (a.where.is_won) return ETAPAS.find((e) => e.is_won) ?? null;
      if (a.where.is_lost) return ETAPAS.find((e) => e.is_lost) ?? null;
      return ETAPAS.find((e) => e.slug === a.where.slug) ?? null;
    },
    'pipelineStage.findUnique': (a) => {
      const e = ETAPAS.find((x) => x.id === a.where.id);
      return e ? { ...e, pipeline_id: 'funil-1', pipeline: { tenant_id: cen.conta } } : null;
    },
    'pipelineStage.findMany': () => ETAPAS.map((e) => ({ ...e, pipeline_id: 'funil-1' })),
    'instance.findFirst': (a) =>
      a.where.purpose === 'CLINICA' ? { ...CHIP_CLINICA } : a.where.purpose === 'COMERCIAL' ? { ...CHIP_COMERCIAL } : null,
    'conversation.findFirst': (a) => {
      if (a.select?.specialty) return { specialty: cen.especialidade ? 'Implante' : null, assigned_dentist_id: null };
      if (a.select?.assigned_user_id) return { assigned_user_id: 'atendente-1' };
      if (a.where.inbox_id) return null;
      if (a.where.inbox?.purpose) return { id: 'conversa-1' };
      return null;
    },
    'conversation.update': (a) => ({ id: a.where.id, ...a.data }),
    'aiMemory.findUnique': () => null,
  };
  const perfis = jest.fn(async () => cen.labs.map((tenant_id) => ({ tenant_id })));
  const modelos: Record<string, any> = {};
  const prisma: any = new Proxy(
    {},
    {
      get(_a, modelo: string | symbol) {
        if (typeof modelo !== 'string' || modelo === 'then') return undefined;
        // A lista de laboratórios (cache de 60 s) fica fora do rastro.
        if (modelo === 'tenantBusinessProfile') return { findMany: perfis };
        modelos[modelo] ??= new Proxy(
          {},
          {
            get(_m, metodo: string | symbol) {
              if (typeof metodo !== 'string' || metodo === 'then') return undefined;
              return async (args: any) => {
                const op = `${modelo}.${metodo}`;
                efeitos.push([`prisma.${op}`, args]);
                const r = respostas[op];
                if (r) return r(args);
                if (metodo === 'findMany') return [];
                if (metodo === 'updateMany' || metodo === 'deleteMany') return { count: 1 };
                if (metodo === 'create') return { id: `novo-${modelo}`, ...(args?.data ?? {}) };
                return null;
              };
            },
          },
        );
        return modelos[modelo];
      },
    },
  );
  const fake = (nome: string, resposta?: (...a: any[]) => any) => (...a: any[]) => {
    efeitos.push([nome, ...a]);
    return resposta ? resposta(...a) : undefined;
  };
  const chatGateway: any = {
    emitConversationsUpdate: fake('socket.emitConversationsUpdate'),
    emitNewLeadNotification: fake('socket.emitNewLeadNotification', async () => undefined),
  };
  const automations: any = { onStageChange: fake('automations.onStageChange', async () => undefined) };
  const drive: any = {
    isConfigured: fake('drive.isConfigured', async () => false),
    ensureLeadFolder: fake('drive.ensureLeadFolder', async () => null),
  };
  const patients: any = { convertFromLead: fake('patients.convertFromLead', async () => ({ id: PACIENTE })) };
  const followup: any = { autoEnrollByStage: fake('followup.autoEnrollByStage', async () => undefined) };
  const registro = new Map<any, any>([
    [PatientsService, patients],
    [FollowupService, followup],
  ]);
  const moduleRef: any = { get: (cls: any) => registro.get(cls) };
  const leads = new LeadsService(prisma, chatGateway, automations, moduleRef, drive);
  registro.set(LeadsService, leads);
  const ctl = new LeadsController(leads, {} as any);
  const de = (op: string) => efeitos.filter((e) => e[0] === op).map((e) => e[1]);
  const nomes = () => efeitos.map((e) => e[0]);
  return { cen, lead, efeitos, de, nomes, leads, ctl, perfis };
}

async function drenar() {
  for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
}

async function erro(p: Promise<unknown>): Promise<any> {
  try {
    await p;
  } catch (e) {
    return e;
  }
  throw new Error('era para lançar e não lançou');
}
const codigo = (e: any) => e?.getResponse?.()?.code;

/** Roda o mesmo cenário de clínica sem laboratório e com OUTRA conta laboratório. */
async function clinicaIgual(c: Partial<Cenario>, rodar: (m: ReturnType<typeof montar>) => Promise<unknown>) {
  const sem = montar({ ...c, labs: [] });
  const rSem = await rodar(sem).catch((e) => e);
  await drenar();
  const com = montar({ ...c, labs: [LAB] });
  const rCom = await rodar(com).catch((e) => e);
  await drenar();
  expect(com.efeitos).toEqual(sem.efeitos);
  expect(rCom).toEqual(rSem);
  expect(registrou('log', '[LAB-GATE]')).toBe(false);
  return { sem, com, r: rSem };
}

const AI_POS_VENDA = { where: { lead_id: LEAD }, data: { ai_mode: true, ai_mode_source: 'POS_VENDA', ai_mode_disabled_at: null } };

describe('updateStatus / PATCH /leads/:id/stage — troca de etapa', () => {
  it('laboratório: a etapa muda e o histórico grava, mas a memória da IA não', async () => {
    const m = montar({ conta: LAB, labs: [LAB] });
    await m.ctl.updateStage(LEAD, { stage: 'AGUARDANDO_PROC' } as any, { user: { id: 'u-1', tenant_id: LAB } });
    await drenar();

    expect(m.de('prisma.lead.update')).toHaveLength(1);
    expect(m.de('prisma.leadStageHistory.create')).toHaveLength(1);
    expect(m.nomes().filter((n) => n.startsWith('prisma.aiMemory.'))).toEqual([]);
    expect(registrou('log', '[LAB-GATE] memoria-etapa')).toBe(true);
    expect(avisos()).toEqual([]);
  });

  it('clínica sem laboratório e com OUTRA conta laboratório: mesmas chamadas, com a memória da IA', async () => {
    const { sem } = await clinicaIgual({}, (m) =>
      m.ctl.updateStage(LEAD, { stage: 'AGUARDANDO_PROC' } as any, { user: { id: 'u-1', tenant_id: CLINICA } }),
    );
    expect(sem.nomes()).toContain('prisma.aiMemory.findUnique');
    expect(sem.nomes()).toContain('prisma.aiMemory.create');
  });

  it('SUPER_ADMIN sem conta move lead de laboratório: decide pela conta do lead (sem memória da IA)', async () => {
    const m = montar({ conta: LAB, labs: [LAB] });
    await m.leads.updateStatus(LEAD, 'AGUARDANDO_PROC', undefined);
    await drenar();

    expect(m.de('prisma.lead.update')).toHaveLength(1);
    expect(m.nomes().filter((n) => n.startsWith('prisma.aiMemory.'))).toEqual([]);
    expect(registrou('log', '[LAB-GATE] memoria-etapa')).toBe(true);
  });

  it('SUPER_ADMIN sem conta move lead de clínica: igual com e sem laboratório', async () => {
    const { sem } = await clinicaIgual({}, (m) => m.leads.updateStatus(LEAD, 'AGUARDANDO_PROC', undefined));
    expect(sem.nomes()).toContain('prisma.aiMemory.create');
  });
});

describe('FINALIZADO — ganho', () => {
  it('laboratório sem área de atendimento: finaliza, vira cliente, sem IA pós-venda e sem cadastro automático', async () => {
    const m = montar({ conta: LAB, labs: [LAB] });
    const r: any = await m.ctl.updateStage(LEAD, { stage: 'FINALIZADO' } as any, { user: { id: 'u-1', tenant_id: LAB } });
    await drenar();

    expect(r).toMatchObject({ stage: 'FINALIZADO', is_client: true, stage_id: 'etapa-ganho' });
    expect(m.de('prisma.lead.update')[0].data).toMatchObject({ stage: 'FINALIZADO', is_client: true, became_client_at: AGORA });
    // A área de atendimento não é consultada (não existe no laboratório).
    expect(m.de('prisma.conversation.findFirst').filter((a: any) => a.select?.specialty)).toEqual([]);
    expect(m.de('prisma.conversation.updateMany')).toEqual([]);
    expect(m.de('patients.convertFromLead')).toEqual([]);
    expect(m.nomes().filter((n) => n.startsWith('prisma.aiMemory.'))).toEqual([]);
    expect(registrou('log', '[LAB-GATE] finalizado-sem-especialidade')).toBe(true);
    expect(registrou('log', '[LAB-GATE] pos-venda')).toBe(true);
    expect(registrou('log', '[LAB-GATE] lead-paciente')).toBe(true);
    expect(avisos()).toEqual([]);
  });

  it('laboratório pela etapa de ganho do funil (stage_id): o mesmo', async () => {
    const m = montar({ conta: LAB, labs: [LAB] });
    await m.ctl.updateStage(LEAD, { stage_id: 'etapa-ganho' } as any, { user: { id: 'u-1', tenant_id: LAB } });
    await drenar();

    expect(m.lead).toMatchObject({ stage: 'FINALIZADO', is_client: true, stage_id: 'etapa-ganho' });
    expect(m.de('prisma.conversation.updateMany')).toEqual([]);
    expect(m.de('patients.convertFromLead')).toEqual([]);
  });

  it('clínica sem área de atendimento: a mesma recusa (403), igual com e sem laboratório', async () => {
    const { r, sem } = await clinicaIgual({}, (m) =>
      m.ctl.updateStage(LEAD, { stage: 'FINALIZADO' } as any, { user: { id: 'u-1', tenant_id: CLINICA } }),
    );
    expect(r).toBeInstanceOf(ForbiddenException);
    expect((r as Error).message).toContain('especialidade');
    expect(sem.de('prisma.lead.update')).toEqual([]);
  });

  it('clínica com área de atendimento: mesmas chamadas, com IA pós-venda e cadastro a partir do contato', async () => {
    const { sem } = await clinicaIgual({ especialidade: true }, (m) =>
      m.ctl.updateStage(LEAD, { stage: 'FINALIZADO' } as any, { user: { id: 'u-1', tenant_id: CLINICA } }),
    );
    expect(sem.de('prisma.conversation.updateMany')).toEqual([AI_POS_VENDA]);
    expect(sem.efeitos.filter((e) => e[0] === 'patients.convertFromLead')).toEqual([['patients.convertFromLead', LEAD, CLINICA]]);
  });
});

describe('Etapa que criaria cadastro a partir do contato (avaliacao-aceita)', () => {
  it('laboratório: sem cadastro automático', async () => {
    const m = montar({ conta: LAB, labs: [LAB] });
    await m.ctl.updateStage(LEAD, { stage_id: 'etapa-aceita' } as any, { user: { id: 'u-1', tenant_id: LAB } });
    await drenar();

    expect(m.lead.stage_id).toBe('etapa-aceita');
    expect(m.de('patients.convertFromLead')).toEqual([]);
    expect(registrou('log', '[LAB-GATE] lead-paciente')).toBe(true);
  });

  it('clínica: cria o cadastro, igual com e sem laboratório', async () => {
    const { sem } = await clinicaIgual({}, (m) =>
      m.ctl.updateStage(LEAD, { stage_id: 'etapa-aceita' } as any, { user: { id: 'u-1', tenant_id: CLINICA } }),
    );
    expect(sem.efeitos.filter((e) => e[0] === 'patients.convertFromLead')).toEqual([['patients.convertFromLead', LEAD, CLINICA]]);
  });
});

describe('ensurePatient — criar cadastro a partir do contato', () => {
  it('laboratório: recusado (VERTICAL_DENIED), nada criado', async () => {
    const m = montar({ conta: LAB, labs: [LAB] });
    const e = await erro(m.leads.ensurePatient(LEAD, LAB));
    expect(codigo(e)).toBe(CODIGO_VERTICAL_NEGADA);
    expect(m.de('patients.convertFromLead')).toEqual([]);
    expect(registrou('log', '[LAB-GATE] lead-paciente')).toBe(true);
  });

  it('laboratório pela rota "Promover a cliente": a mesma recusa, nada gravado', async () => {
    const m = montar({ conta: LAB, labs: [LAB] });
    const e = await erro(m.ctl.promoteToClient(LEAD, { user: { id: 'u-1', tenant_id: LAB } }));
    expect(codigo(e)).toBe(CODIGO_VERTICAL_NEGADA);
    expect(m.nomes().filter((n) => !/\.(findUnique|findFirst|findMany)$/.test(n))).toEqual([]);
  });

  it('clínica: cria o cadastro, igual com e sem laboratório', async () => {
    const { sem } = await clinicaIgual({}, (m) => m.leads.ensurePatient(LEAD, CLINICA));
    expect(sem.efeitos.filter((e) => e[0] === 'patients.convertFromLead')).toEqual([['patients.convertFromLead', LEAD, CLINICA]]);
  });
});

describe('promoteToPatientIfEligible — pagou/compareceu (gatilho automático)', () => {
  it('laboratório que pagou: o 1º pagamento promove — cliente e FINALIZADO, sem setor, IA, memória nem cadastro automático', async () => {
    const m = montar({ conta: LAB, labs: [LAB], pagou: true });
    const r = await m.leads.promoteToPatientIfEligible(LEAD, LAB, 'pagamento confirmado (Asaas)');
    await drenar();

    expect(r).toEqual({ ok: true, leadId: LEAD, stageFinalized: true, movedConversations: 0 });
    expect(m.de('prisma.lead.updateMany')[0]).toEqual({
      where: { id: LEAD, is_client: false },
      data: { is_client: true, became_client_at: AGORA },
    });
    expect(m.lead).toMatchObject({ is_client: true, became_client_at: AGORA, stage: 'FINALIZADO', stage_id: 'etapa-ganho' });
    // Nada de clínica: sem área de atendimento, troca de setor, IA pós-venda, memória
    // da IA nem cadastro a partir do contato.
    expect(m.de('prisma.conversation.findFirst').filter((a: any) => a.select?.specialty)).toEqual([]);
    expect(m.de('prisma.instance.findFirst')).toEqual([]);
    expect(m.de('prisma.conversation.update')).toEqual([]);
    expect(m.de('prisma.conversation.updateMany')).toEqual([]);
    expect(m.de('patients.convertFromLead')).toEqual([]);
    expect(m.nomes().filter((n) => n.startsWith('prisma.aiMemory.'))).toEqual([]);
    expect(registrou('log', '[LAB-GATE] troca-de-setor')).toBe(true);
    expect(registrou('log', '[LAB-GATE] pos-venda')).toBe(true);
    expect(registrou('log', '[LAB-GATE] memoria-etapa')).toBe(true);
    expect(registrou('log', '[LAB-GATE] lead-paciente')).toBe(true);
    expect(avisos()).toEqual([]);
  });

  it('laboratório que não pagou: segue lead, nada gravado', async () => {
    const m = montar({ conta: LAB, labs: [LAB] });
    const r = await m.leads.promoteToPatientIfEligible(LEAD, LAB, 'aprovar e cobrar');
    await drenar();

    expect(r).toEqual({ ok: false, leadId: LEAD, notYet: true });
    expect(m.nomes().filter((n) => !/\.(findUnique|findFirst|findMany)$/.test(n))).toEqual([]);
    expect(m.lead.is_client).toBe(false);
  });

  it('laboratório: contato do cadastro manual (já cliente) — o pagamento não muda nada', async () => {
    const m = montar({ conta: LAB, labs: [LAB], is_client: true, stage: 'NOVO', pagou: true });
    const r = await m.leads.promoteToPatientIfEligible(LEAD, LAB, 'pagamento confirmado (Asaas)');
    await drenar();

    expect(r).toEqual({ ok: true, leadId: LEAD, alreadyClient: true });
    expect(m.nomes()).toEqual(['prisma.lead.findUnique']);
    expect(m.lead).toMatchObject({ is_client: true, stage: 'NOVO' });
  });

  it('clínica que pagou: promove, igual com e sem laboratório (troca de setor e IA pós-venda)', async () => {
    const { sem, r } = await clinicaIgual({ pagou: true, especialidade: true }, (m) =>
      m.leads.promoteToPatientIfEligible(LEAD, CLINICA, 'pagamento confirmado (Asaas)'),
    );
    expect(r).toEqual({ ok: true, leadId: LEAD, stageFinalized: true, movedConversations: 1 });
    expect(sem.de('prisma.conversation.updateMany')).toEqual([AI_POS_VENDA]);
    expect(sem.de('prisma.conversation.update')).toEqual([
      { where: { id: 'conversa-1' }, data: { inbox_id: CHIP_CLINICA.inbox_id, instance_name: CHIP_CLINICA.name, assigned_user_id: null } },
    ]);
  });

  it('clínica que não pagou nem compareceu: segue lead, igual com e sem laboratório', async () => {
    const { r } = await clinicaIgual({}, (m) => m.leads.promoteToPatientIfEligible(LEAD, CLINICA, 'aprovar e cobrar'));
    expect(r).toEqual({ ok: false, leadId: LEAD, notYet: true });
  });
});

describe('promoteLeadCore (via graduateLeadToClient) — promoção', () => {
  it('laboratório: vira cliente e FINALIZADO, sem trocar a conversa de setor e sem IA pós-venda', async () => {
    const m = montar({ conta: LAB, labs: [LAB] });
    const r = await m.leads.graduateLeadToClient(PACIENTE, LAB, 'u-1');
    await drenar();

    expect(r).toEqual({ ok: true, leadId: LEAD, stageFinalized: true, movedConversations: 0 });
    expect(m.de('prisma.lead.updateMany')[0]).toEqual({
      where: { id: LEAD, is_client: false },
      data: { is_client: true, became_client_at: AGORA, cs_user_id: 'u-1' },
    });
    expect(m.lead).toMatchObject({ is_client: true, stage: 'FINALIZADO' });
    expect(m.de('prisma.instance.findFirst')).toEqual([]);
    expect(m.de('prisma.conversation.update')).toEqual([]);
    expect(m.de('prisma.conversation.updateMany')).toEqual([]);
    expect(m.de('patients.convertFromLead')).toEqual([]);
    expect(registrou('log', '[LAB-GATE] troca-de-setor')).toBe(true);
    expect(registrou('log', '[LAB-GATE] pos-venda')).toBe(true);
    expect(avisos()).toEqual([]);
  });

  it('clínica: promove, troca de setor e religa a IA — igual com e sem laboratório', async () => {
    const { r, sem } = await clinicaIgual({ especialidade: true }, (m) => m.leads.graduateLeadToClient(PACIENTE, CLINICA, 'u-1'));
    expect(r).toEqual({ ok: true, leadId: LEAD, stageFinalized: true, movedConversations: 1 });
    expect(sem.de('prisma.conversation.updateMany')).toEqual([AI_POS_VENDA]);
    expect(sem.de('prisma.conversation.update')).toHaveLength(1);
  });
});

describe('demoteLeadById — cliente volta a ser lead', () => {
  it('laboratório: segue cliente — sem rebaixar, sem trocar de setor, sem mexer na IA', async () => {
    const m = montar({ conta: LAB, labs: [LAB], is_client: true, stage: 'FINALIZADO' });
    const r = await m.leads.demoteLeadById(LEAD, LAB);
    await drenar();

    expect(r).toMatchObject({ ok: false, leadId: LEAD });
    expect(m.nomes()).toEqual(['prisma.lead.findUnique']);
    expect(m.lead).toMatchObject({ is_client: true, stage: 'FINALIZADO' });
    expect(registrou('log', '[LAB-GATE] rebaixar-cliente')).toBe(true);
  });

  it('laboratório pela ficha (demoteLeadFromClient): o mesmo', async () => {
    const m = montar({ conta: LAB, labs: [LAB], is_client: true, stage: 'FINALIZADO' });
    const r = await m.leads.demoteLeadFromClient(PACIENTE, LAB);
    await drenar();

    expect(r).toMatchObject({ ok: false, leadId: LEAD });
    expect(m.de('prisma.lead.update')).toEqual([]);
    expect(m.de('prisma.conversation.update')).toEqual([]);
    expect(m.de('prisma.conversation.updateMany')).toEqual([]);
  });

  it('clínica: rebaixa, volta pro Comercial e IA POS_VENDA → COMERCIAL — igual com e sem laboratório', async () => {
    const { r, sem } = await clinicaIgual({ is_client: true, stage: 'FINALIZADO' }, (m) => m.leads.demoteLeadById(LEAD, CLINICA));
    expect(r).toEqual({ ok: true, leadId: LEAD });
    expect(sem.de('prisma.lead.update')[0].data).toMatchObject({ is_client: false, became_client_at: null, stage: 'NEGOCIACAO' });
    expect(sem.de('prisma.conversation.update')).toEqual([
      { where: { id: 'conversa-1' }, data: { inbox_id: CHIP_COMERCIAL.inbox_id, instance_name: CHIP_COMERCIAL.name, assigned_user_id: null } },
    ]);
    expect(sem.de('prisma.conversation.updateMany')).toEqual([
      { where: { lead_id: LEAD, ai_mode_source: 'POS_VENDA' }, data: { ai_mode_source: 'COMERCIAL' } },
    ]);
  });
});

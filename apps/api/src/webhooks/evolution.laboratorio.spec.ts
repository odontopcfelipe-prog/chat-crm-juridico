/**
 * F5 — webhook do WhatsApp (EvolutionService.handleMessagesUpsert) numa conta de
 * laboratório.
 *
 *  - Escrever no número principal (chip CLINICA) não faz o contato virar cliente:
 *    no laboratório o is_client vem do cadastro de clientes. Sem a trava de
 *    comparecimento e sem lead.update.
 *  - Conversa nova nasce com ai_mode=false (lá a IA não responde; com true a
 *    conversa aparecia como do robô, fora das filas da equipe).
 *  - O resync do chip (reconexão) também cria a conversa nova com ai_mode=false.
 *
 * Clínica: a MESMA sequência de chamadas, com os mesmos argumentos, sem nenhum
 * laboratório cadastrado e com OUTRA conta laboratório cadastrada. A leitura da
 * lista de laboratórios (cache de 60 s) fica fora da comparação.
 *
 * O handler roda de verdade até o ponto que interessa; ali o banco falso lança
 * PARADA (mensagem, IA e o resto não são deste spec).
 */
import { Logger } from '@nestjs/common';
import { __limparCacheLabTenants } from '@crm/shared';
import { EvolutionService } from './evolution.service';

const AGORA = new Date('2026-10-20T15:00:00.000Z');
const CLINICA = 'conta-clinica-exemplo';
const LAB = 'conta-lab-exemplo';
const OUTRO_LAB = 'conta-outro-lab-exemplo';
const LEAD = 'lead-1';
const TELEFONE = '5582900000001';
const CHIPS = {
  CLINICA: { name: 'chip-principal-exemplo', inbox_id: 'inbox-principal' },
  COMERCIAL: { name: 'chip-captacao-exemplo', inbox_id: 'inbox-captacao' },
} as const;

type Op = [string, any];

interface Mundo {
  conta: string;
  /** Conta gravada no contato (padrão: a mesma do chip; null = contato legado sem conta). */
  contaLead?: string | null;
  labs: string[];
  chip: 'CLINICA' | 'COMERCIAL';
  is_client: boolean;
  /** Tem consulta na agenda sem comparecimento nem pagamento. */
  agendou: boolean;
  /** Onde o banco falso para: na 1ª busca de conversa ou na criação da conversa nova. */
  paraEm: 'busca' | 'criacao';
}

function montar(m: Partial<Mundo> = {}) {
  const w: Mundo = {
    conta: CLINICA,
    labs: [],
    chip: 'CLINICA',
    is_client: false,
    agendou: false,
    paraEm: 'busca',
    ...m,
  };
  const ops: Op[] = [];
  const lead = { id: LEAD, tenant_id: w.contaLead === undefined ? w.conta : w.contaLead, phone: TELEFONE, name: 'Contato Exemplo', stage: 'NOVO', is_client: w.is_client, became_client_at: null };
  const respostas: Record<string, (a: any) => any> = {
    'patient.findMany': () => [],
    'calendarEvent.findFirst': (a) => (w.agendou && !a.where.status ? { id: 'evento-1' } : null),
    'financialTransaction.findFirst': () => null,
    'lead.update': (a) => ({ ...lead, ...a.data }),
    'conversation.findFirst': () => {
      if (w.paraEm === 'busca') throw new Error('PARADA');
      return null;
    },
    'conversation.create': () => {
      throw new Error('PARADA');
    },
  };
  const prisma: any = new Proxy(
    {},
    {
      get(_a, modelo: string | symbol) {
        if (typeof modelo !== 'string' || modelo === 'then') return undefined;
        return new Proxy(
          {},
          {
            get(_b, metodo: string | symbol) {
              if (typeof metodo !== 'string' || metodo === 'then') return undefined;
              return async (args: any) => {
                const op = `${modelo}.${metodo}`;
                // A lista de laboratórios (só leitura, cache de 60 s) fica fora da comparação.
                if (op === 'tenantBusinessProfile.findMany') return w.labs.map((tenant_id) => ({ tenant_id }));
                ops.push([op, args]);
                const r = respostas[op];
                if (r) return r(args);
                if (metodo === 'findMany') return [];
                return null;
              };
            },
          },
        );
      },
    },
  );
  const chip = CHIPS[w.chip];
  const inboxes: any = {
    findByInstanceName: async (nome: string) => {
      ops.push(['inboxes.findByInstanceName', nome]);
      return { ...chip, tenant_id: w.conta, purpose: w.chip, inbox: { id: chip.inbox_id, tenant_id: w.conta } };
    },
  };
  const leads: any = {
    upsert: async (...a: any[]) => {
      ops.push(['leads.upsert', a]);
      return { ...lead };
    },
  };
  const adminBot: any = {
    isEnabled: async (t: any) => {
      ops.push(['adminBot.isEnabled', t]);
      return false;
    },
  };
  const evo = new EvolutionService(
    prisma, {} as any, leads, inboxes, {} as any, {} as any, {} as any, {} as any, adminBot, {} as any, {} as any,
  );
  const rodar = () =>
    expect(
      evo.handleMessagesUpsert({
        event: 'messages.upsert',
        instance: chip.name,
        data: {
          key: { remoteJid: `${TELEFONE}@s.whatsapp.net`, fromMe: false, id: 'MSG-EXEMPLO-1' },
          pushName: 'Contato Exemplo',
          message: { conversation: 'Oi, tudo bem?' },
          messageType: 'conversation',
          messageTimestamp: Math.floor(AGORA.getTime() / 1000),
        },
      }),
    ).rejects.toThrow('PARADA');
  return { ops, rodar };
}

const nomes = (ops: Op[]) => ops.map((o) => o[0]);
const argsDe = (ops: Op[], op: string) => ops.filter((o) => o[0] === op).map((o) => o[1]);

let logs: string[];

beforeEach(() => {
  __limparCacheLabTenants();
  jest.useFakeTimers({
    now: AGORA,
    doNotFake: [
      'nextTick', 'setImmediate', 'clearImmediate', 'setTimeout', 'clearTimeout',
      'setInterval', 'clearInterval', 'queueMicrotask', 'hrtime', 'performance',
    ],
  });
  logs = [];
  for (const nivel of ['log', 'warn', 'error', 'debug', 'verbose'] as const) {
    jest.spyOn(Logger.prototype, nivel).mockImplementation((msg: any) => {
      logs.push(String(msg));
    });
  }
});

afterEach(() => {
  jest.restoreAllMocks();
  jest.useRealTimers();
});

/** Roda o mesmo mundo sem laboratório e com OUTRA conta laboratório; devolve os dois. */
async function semEComLab(m: Partial<Mundo>) {
  const semLab = montar({ ...m, labs: [] });
  await semLab.rodar();
  __limparCacheLabTenants();
  const comLab = montar({ ...m, labs: [OUTRO_LAB] });
  await comLab.rodar();
  return { semLab, comLab };
}

describe('chip principal (CLINICA) — laboratório', () => {
  it('contato que não é cliente escreve no número do laboratório: o cadastro fica como está', async () => {
    const { ops, rodar } = montar({ conta: LAB, labs: [LAB] });
    await rodar();

    expect(nomes(ops)).not.toContain('lead.update');
    // Nem a trava de comparecimento da clínica é consultada.
    expect(nomes(ops)).not.toContain('patient.findMany');
    expect(nomes(ops)).not.toContain('calendarEvent.findFirst');
    expect(nomes(ops)).toEqual(['inboxes.findByInstanceName', 'adminBot.isEnabled', 'leads.upsert', 'conversation.findFirst']);
    expect(logs.some((l) => l.startsWith('[LAB-GATE] chip-clinica'))).toBe(true);
  });

  it('contato legado sem conta escrevendo no chip do laboratório: também fica de fora', async () => {
    const { ops, rodar } = montar({ conta: LAB, contaLead: null, labs: [LAB] });
    await rodar();
    expect(nomes(ops)).not.toContain('lead.update');
  });

  it('chip da clínica com contato marcado como laboratório (dado misto): na dúvida, fica de fora', async () => {
    const { ops, rodar } = montar({ conta: CLINICA, contaLead: LAB, labs: [LAB] });
    await rodar();
    expect(nomes(ops)).not.toContain('lead.update');
  });
});

describe('chip principal (CLINICA) — clínica idêntica com e sem laboratório cadastrado', () => {
  it('contato nunca agendado: vira paciente como hoje', async () => {
    const { semLab, comLab } = await semEComLab({});

    expect(comLab.ops).toEqual(semLab.ops);
    expect(argsDe(comLab.ops, 'lead.update')).toEqual([
      { where: { id: LEAD }, data: { is_client: true, became_client_at: AGORA } },
    ]);
    expect(nomes(comLab.ops)).toContain('calendarEvent.findFirst');
    expect(logs.some((l) => l.includes('[LAB-GATE]'))).toBe(false);
  });

  it('lead agendado sem comparecimento: segue lead como hoje', async () => {
    const { semLab, comLab } = await semEComLab({ agendou: true });

    expect(comLab.ops).toEqual(semLab.ops);
    expect(nomes(comLab.ops)).not.toContain('lead.update');
  });

  it('já é paciente: nada muda', async () => {
    const { semLab, comLab } = await semEComLab({ is_client: true });

    expect(comLab.ops).toEqual(semLab.ops);
    expect(nomes(comLab.ops)).toEqual(['inboxes.findByInstanceName', 'adminBot.isEnabled', 'leads.upsert', 'conversation.findFirst']);
  });
});

describe('conversa nova', () => {
  const BASE = {
    lead_id: LEAD,
    channel: 'whatsapp',
    status: 'ABERTO',
    external_id: `${TELEFONE}@s.whatsapp.net`,
  };

  it.each(['CLINICA', 'COMERCIAL'] as const)('laboratório, chip %s: nasce com ai_mode=false', async (chip) => {
    const { ops, rodar } = montar({ conta: LAB, labs: [LAB], chip, paraEm: 'criacao' });
    await rodar();

    expect(argsDe(ops, 'conversation.create')).toEqual([
      {
        data: {
          ...BASE,
          inbox_id: CHIPS[chip].inbox_id,
          instance_name: CHIPS[chip].name,
          tenant_id: LAB,
          ai_mode: false,
        },
      },
    ]);
    expect(logs.some((l) => l.startsWith('[LAB-GATE] conversa-nova'))).toBe(true);
  });

  it.each(['CLINICA', 'COMERCIAL'] as const)('clínica, chip %s: o create leva os mesmos campos de hoje (sem ai_mode)', async (chip) => {
    const { semLab, comLab } = await semEComLab({ chip, paraEm: 'criacao' });

    expect(comLab.ops).toEqual(semLab.ops);
    const [criacao] = argsDe(comLab.ops, 'conversation.create');
    expect(criacao).toEqual({
      data: {
        ...BASE,
        inbox_id: CHIPS[chip].inbox_id,
        instance_name: CHIPS[chip].name,
        tenant_id: CLINICA,
      },
    });
    expect(Object.keys(criacao.data)).toEqual([
      'lead_id', 'channel', 'status', 'external_id', 'inbox_id', 'instance_name', 'tenant_id',
    ]);
    expect('ai_mode' in criacao.data).toBe(false);
    expect(logs.some((l) => l.includes('[LAB-GATE]'))).toBe(false);
  });
});

/**
 * Resync do chip (scheduleResyncAfterReconnect): chat recente do WhatsApp sem
 * conversa no sistema vira conversa nova. Banco falso completo (sem PARADA): o
 * resync roda até o fim, com a fase 2 sem conversas abertas.
 */
function montarResync(m: { conta: string; contaLead?: string | null; labs: string[]; chip?: 'CLINICA' | 'COMERCIAL' }) {
  const chip = CHIPS[m.chip ?? 'CLINICA'];
  const ops: Op[] = [];
  const lead = { id: LEAD, tenant_id: m.contaLead === undefined ? m.conta : m.contaLead, phone: TELEFONE, name: 'Contato Exemplo', stage: 'NOVO', is_client: false };
  const respostas: Record<string, (a: any) => any> = {
    'conversation.findFirst': () => null,
    'conversation.create': (a) => ({ id: 'conversa-nova', ...a.data }),
  };
  const prisma: any = new Proxy(
    {},
    {
      get(_a, modelo: string | symbol) {
        if (typeof modelo !== 'string' || modelo === 'then') return undefined;
        return new Proxy(
          {},
          {
            get(_b, metodo: string | symbol) {
              if (typeof metodo !== 'string' || metodo === 'then') return undefined;
              return async (args: any) => {
                const op = `${modelo}.${metodo}`;
                // A lista de laboratórios (só leitura, cache de 60 s) fica fora da comparação.
                if (op === 'tenantBusinessProfile.findMany') return m.labs.map((tenant_id) => ({ tenant_id }));
                ops.push([op, args]);
                const r = respostas[op];
                if (r) return r(args);
                if (metodo === 'findMany') return [];
                return null;
              };
            },
          },
        );
      },
    },
  );
  const chatGateway: any = {
    emitConversationsUpdate: (...a: any[]) => {
      ops.push(['socket.emitConversationsUpdate', a]);
    },
  };
  const leads: any = {
    findByPhone: async (...a: any[]) => {
      ops.push(['leads.findByPhone', a]);
      return null;
    },
    upsert: async (...a: any[]) => {
      ops.push(['leads.upsert', a]);
      return { ...lead };
    },
  };
  const inboxes: any = {
    findByInstanceName: async (nome: string) => {
      ops.push(['inboxes.findByInstanceName', nome]);
      return { ...chip, tenant_id: m.conta, purpose: m.chip ?? 'CLINICA', inbox: { id: chip.inbox_id, tenant_id: m.conta } };
    },
  };
  const whatsapp: any = {
    fetchChats: async (nome: string) => {
      ops.push(['whatsapp.fetchChats', nome]);
      return [
        {
          remoteJid: `${TELEFONE}@s.whatsapp.net`,
          pushName: 'Contato Exemplo',
          lastMessage: { messageTimestamp: Math.floor(AGORA.getTime() / 1000) },
        },
      ];
    },
  };
  const fila: any = {
    add: async (...a: any[]) => {
      ops.push(['fila.add', a]);
    },
  };
  const evo = new EvolutionService(
    prisma, chatGateway, leads, inboxes, fila, fila, whatsapp, {} as any, {} as any, {} as any, {} as any,
  );
  const rodar = () => evo.scheduleResyncAfterReconnect(chip.name, { stabilizeDelayMs: 0, triggerReason: 'manual' });
  return { ops, rodar };
}

describe('resync do chip — conversa nova', () => {
  const BASE = {
    lead_id: LEAD,
    channel: 'whatsapp',
    status: 'ABERTO',
    external_id: `${TELEFONE}@s.whatsapp.net`,
  };

  it.each(['CLINICA', 'COMERCIAL'] as const)('laboratório, chip %s: nasce com ai_mode=false', async (chip) => {
    const { ops, rodar } = montarResync({ conta: LAB, labs: [LAB], chip });
    await expect(rodar()).resolves.toEqual({ newConvsCreated: 1, conversationsResynced: 0 });

    expect(argsDe(ops, 'conversation.create')).toEqual([
      {
        data: {
          ...BASE,
          inbox_id: CHIPS[chip].inbox_id,
          instance_name: CHIPS[chip].name,
          tenant_id: LAB,
          last_message_at: AGORA,
          ai_mode: false,
        },
      },
    ]);
    expect(logs.some((l) => l.startsWith('[LAB-GATE] resync'))).toBe(true);
  });

  it('laboratório com contato legado sem conta: também nasce com ai_mode=false', async () => {
    const { ops, rodar } = montarResync({ conta: LAB, contaLead: null, labs: [LAB] });
    await rodar();
    expect(argsDe(ops, 'conversation.create')[0].data.ai_mode).toBe(false);
  });

  it.each(['CLINICA', 'COMERCIAL'] as const)('clínica, chip %s: o create leva os mesmos campos de hoje (sem ai_mode)', async (chip) => {
    const semLab = montarResync({ conta: CLINICA, labs: [], chip });
    const r1 = await semLab.rodar();
    __limparCacheLabTenants();
    const comLab = montarResync({ conta: CLINICA, labs: [OUTRO_LAB], chip });
    const r2 = await comLab.rodar();

    expect(comLab.ops).toEqual(semLab.ops);
    expect(r2).toEqual(r1);
    const [criacao] = argsDe(comLab.ops, 'conversation.create');
    expect(criacao).toEqual({
      data: {
        ...BASE,
        inbox_id: CHIPS[chip].inbox_id,
        instance_name: CHIPS[chip].name,
        tenant_id: CLINICA,
        last_message_at: AGORA,
      },
    });
    expect(Object.keys(criacao.data)).toEqual([
      'lead_id', 'channel', 'status', 'external_id', 'inbox_id', 'instance_name', 'tenant_id', 'last_message_at',
    ]);
    expect(logs.some((l) => l.includes('[LAB-GATE]'))).toBe(false);
  });
});

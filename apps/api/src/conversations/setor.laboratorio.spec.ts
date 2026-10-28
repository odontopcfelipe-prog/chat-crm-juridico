/**
 * F5 — "Mover setor" (ConversationsService.moveToSector) numa conta de laboratório.
 *
 * Laboratório: a troca de setor troca o número de saída (inbox + chip) e
 * reclassifica o contato com os mesmos dados da clínica (setor principal = cliente
 * dentista, captação = contato em captação), porque o envio escolhe o chip pelo
 * is_client. Fica de fora só a trava de comparecimento/pagamento (regra e texto
 * de clínica), e a mensagem de "sem WhatsApp" fala de laboratório.
 *
 * Conversa aberta pela equipe (create, do POST /conversations): no laboratório
 * nasce com ai_mode=false; na clínica o create recebe o mesmo objeto.
 *
 * Clínica: a MESMA sequência de chamadas, com os mesmos argumentos, sem nenhum
 * laboratório cadastrado e com OUTRA conta laboratório cadastrada. A leitura da
 * lista de laboratórios (cache de 60 s) fica fora da comparação.
 */
import { BadRequestException, Logger } from '@nestjs/common';
import { __limparCacheLabTenants } from '@crm/shared';
import { ConversationsService } from './conversations.service';
import { MessagesService } from '../messages/messages.service';
import { CLINIC_TRANSFER_BLOCKED_MSG } from '../leads/clinic-transfer-guard';

const AGORA = new Date('2026-10-20T15:00:00.000Z');
const CLINICA = 'conta-clinica-exemplo';
const LAB = 'conta-lab-exemplo';
const OUTRO_LAB = 'conta-outro-lab-exemplo';
const LEAD = 'lead-1';
const CONVERSA = 'conversa-1';
const CHIPS: Record<string, { name: string; inbox_id: string }> = {
  CLINICA: { name: 'chip-principal-exemplo', inbox_id: 'inbox-principal' },
  COMERCIAL: { name: 'chip-captacao-exemplo', inbox_id: 'inbox-captacao' },
};
const ETAPAS = [
  { id: 'etapa-inicial', slug: 'inicial', name: 'Novo contato', position: 0, is_initial: true, is_won: false, is_lost: false, is_hidden: false },
  { id: 'etapa-orcamento', slug: 'orcamento-enviado', name: 'Orçamento enviado', position: 3, is_initial: false, is_won: false, is_lost: false, is_hidden: false },
  { id: 'etapa-ganho', slug: 'contrato-assinado', name: 'Contrato assinado', position: 8, is_initial: false, is_won: true, is_lost: false, is_hidden: false },
];

type Op = [string, any];

interface Mundo {
  conta: string;
  labs: string[];
  is_client: boolean;
  stage: string;
  stage_id: string;
  /** Tem consulta na agenda sem comparecimento nem pagamento. */
  agendou: boolean;
  /** Existe chip do setor-alvo. */
  temChip: boolean;
}

function montar(m: Partial<Mundo> = {}) {
  const w: Mundo = {
    conta: CLINICA,
    labs: [],
    is_client: false,
    stage: 'QUALIFICANDO',
    stage_id: 'etapa-inicial',
    agendou: false,
    temChip: true,
    ...m,
  };
  const ops: Op[] = [];
  const respostas: Record<string, (a: any) => any> = {
    'conversation.findUnique': () => ({
      id: CONVERSA,
      tenant_id: w.conta,
      lead_id: LEAD,
      lead: {
        is_client: w.is_client,
        became_client_at: w.is_client ? new Date('2026-01-10T12:00:00.000Z') : null,
        stage: w.stage,
        pipeline_id: 'funil-1',
        stage_id: w.stage_id,
      },
    }),
    'patient.findMany': () => [],
    'calendarEvent.findFirst': (a) => (w.agendou && !a.where.status ? { id: 'evento-1' } : null),
    'financialTransaction.findFirst': () => null,
    'instance.findFirst': (a) => (w.temChip ? { ...CHIPS[a.where.purpose] } : null),
    'globalSetting.findUnique': () => null,
    'tenantSetting.findUnique': () => null,
    'conversation.update': (a) => ({ id: a.where.id, ...a.data }),
    'lead.update': (a) => ({ id: a.where.id, ...a.data }),
    'conversation.create': (a) => ({ id: 'conversa-nova', ...a.data }),
    'pipelineStage.findMany': () => ETAPAS.map((e) => ({ ...e, pipeline_id: 'funil-1' })),
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
  const chatGateway: any = {
    emitConversationsUpdate: (...a: any[]) => {
      ops.push(['socket.emitConversationsUpdate', a]);
    },
  };
  const service = new ConversationsService(prisma, chatGateway, {} as any, {} as any);
  return { service, ops, prisma };
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
  for (const nivel of ['log', 'warn', 'error', 'debug'] as const) {
    jest.spyOn(Logger.prototype, nivel).mockImplementation((msg: any) => {
      logs.push(String(msg));
    });
  }
});

afterEach(() => {
  jest.restoreAllMocks();
  jest.useRealTimers();
});

describe('moveToSector — laboratório', () => {
  it('para o setor principal: troca o número de saída e marca is_client como na clínica', async () => {
    const { service, ops } = montar({ conta: LAB, labs: [LAB] });
    const r: any = await service.moveToSector(CONVERSA, 'CLINICA', 'operador-1');

    expect(r).toMatchObject({ inbox_id: CHIPS.CLINICA.inbox_id, instance_name: CHIPS.CLINICA.name, assigned_user_id: null });
    // A IA não é religada: no laboratório o chip nunca está com a IA ligada.
    expect(argsDe(ops, 'conversation.update')).toEqual([
      {
        where: { id: CONVERSA },
        data: {
          inbox_id: CHIPS.CLINICA.inbox_id,
          instance_name: CHIPS.CLINICA.name,
          assigned_user_id: null,
          ai_mode_source: 'MANUAL',
        },
      },
    ]);
    expect(argsDe(ops, 'lead.update')).toEqual([
      { where: { id: LEAD }, data: { is_client: true, became_client_at: AGORA } },
    ]);
    expect(logs.some((l) => l.startsWith('[LAB-GATE] setor'))).toBe(true);
  });

  it('contato agendado sem comparecimento: não passa pela trava da clínica (nem pelo texto dela) e vira cliente', async () => {
    const { service, ops } = montar({ conta: LAB, labs: [LAB], agendou: true });
    await expect(service.moveToSector(CONVERSA, 'CLINICA', 'operador-1')).resolves.toBeDefined();

    expect(nomes(ops)).not.toContain('calendarEvent.findFirst');
    expect(nomes(ops)).not.toContain('patient.findMany');
    expect(argsDe(ops, 'lead.update')).toEqual([
      { where: { id: LEAD }, data: { is_client: true, became_client_at: AGORA } },
    ]);
  });

  it('quem já era cliente vai para o setor principal: não re-carimba became_client_at', async () => {
    const { service, ops } = montar({ conta: LAB, labs: [LAB], is_client: true });
    await service.moveToSector(CONVERSA, 'CLINICA', 'operador-1');

    expect(argsDe(ops, 'lead.update')).toEqual([
      { where: { id: LEAD }, data: { is_client: true, became_client_at: new Date('2026-01-10T12:00:00.000Z') } },
    ]);
  });

  it('cliente em ganho que vai para a captação: deixa de ser cliente e sai do ganho como na clínica', async () => {
    const { service, ops } = montar({ conta: LAB, labs: [LAB], is_client: true, stage: 'FINALIZADO', stage_id: 'etapa-ganho' });
    await service.moveToSector(CONVERSA, 'COMERCIAL', 'operador-1');

    expect(argsDe(ops, 'conversation.update')[0].data).toMatchObject({ instance_name: CHIPS.COMERCIAL.name });
    expect(argsDe(ops, 'lead.update')).toEqual([
      {
        where: { id: LEAD },
        data: {
          is_client: false,
          became_client_at: null,
          stage: 'NEGOCIACAO',
          stage_entered_at: AGORA,
          stage_id: 'etapa-orcamento',
        },
      },
    ]);
  });

  it.each([
    ['contato → setor principal', {}, 'CLINICA'],
    ['cliente → setor principal', { is_client: true }, 'CLINICA'],
    ['cliente em ganho → captação', { is_client: true, stage: 'FINALIZADO', stage_id: 'etapa-ganho' }, 'COMERCIAL'],
    ['contato → captação', {}, 'COMERCIAL'],
  ] as Array<[string, Partial<Mundo>, 'CLINICA' | 'COMERCIAL']>)(
    '%s: o contato é reclassificado com os mesmos dados da clínica',
    async (_nome, mundo, setor) => {
      const clinica = montar({ ...mundo, labs: [LAB] });
      await clinica.service.moveToSector(CONVERSA, setor, 'operador-1');
      const lab = montar({ ...mundo, conta: LAB, labs: [LAB] });
      await lab.service.moveToSector(CONVERSA, setor, 'operador-1');

      expect(argsDe(lab.ops, 'lead.update')).toHaveLength(1);
      expect(argsDe(lab.ops, 'lead.update')).toEqual(argsDe(clinica.ops, 'lead.update'));
    },
  );

  it.each([
    ['contato movido para o setor principal sai pelo chip principal', {}, 'CLINICA'],
    ['cliente movido para a captação sai pelo chip de captação', { is_client: true }, 'COMERCIAL'],
  ] as Array<[string, Partial<Mundo>, 'CLINICA' | 'COMERCIAL']>)('envio depois do move: %s', async (_nome, mundo, setor) => {
    const { service, ops, prisma } = montar({ ...mundo, conta: LAB, labs: [LAB] });
    const movida: any = await service.moveToSector(CONVERSA, setor, 'operador-1');
    const [{ data: contato }] = argsDe(ops, 'lead.update');

    // O envio (texto e mídia) escolhe o chip pelo is_client do contato.
    const mensagens = new MessagesService(prisma, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any);
    const chip = await (mensagens as any).resolveDispatchInstance({
      instance_name: movida.instance_name,
      tenant_id: LAB,
      inbox_id: movida.inbox_id,
      lead: { is_client: contato.is_client },
    });

    expect(chip).toBe(CHIPS[setor].name);
  });

  it('sem chip do setor: a mensagem fala de laboratório', async () => {
    const principal = montar({ conta: LAB, labs: [LAB], temChip: false });
    await expect(principal.service.moveToSector(CONVERSA, 'CLINICA')).rejects.toThrow(
      new BadRequestException('Seu laboratório não tem um WhatsApp de Atendimento/Produção conectado.'),
    );
    const captacao = montar({ conta: LAB, labs: [LAB], temChip: false });
    await expect(captacao.service.moveToSector(CONVERSA, 'COMERCIAL')).rejects.toThrow(
      'Seu laboratório não tem um WhatsApp de Captação conectado.',
    );
    expect(nomes(principal.ops)).not.toContain('conversation.update');
    expect(nomes(principal.ops)).not.toContain('lead.update');
  });
});

describe('moveToSector — clínica idêntica com e sem laboratório cadastrado', () => {
  const cenarios: Array<[string, Partial<Mundo>, 'CLINICA' | 'COMERCIAL']> = [
    ['lead nunca agendado → Clínica', {}, 'CLINICA'],
    ['paciente em ganho → Comercial', { is_client: true, stage: 'FINALIZADO', stage_id: 'etapa-ganho' }, 'COMERCIAL'],
    ['paciente → Clínica', { is_client: true }, 'CLINICA'],
  ];

  it.each(cenarios)('%s', async (_nome, mundo, setor) => {
    const semLab = montar({ ...mundo, labs: [] });
    const r1 = await semLab.service.moveToSector(CONVERSA, setor, 'operador-1');
    __limparCacheLabTenants();
    const comLab = montar({ ...mundo, labs: [OUTRO_LAB] });
    const r2 = await comLab.service.moveToSector(CONVERSA, setor, 'operador-1');

    expect(comLab.ops).toEqual(semLab.ops);
    expect(r2).toEqual(r1);
    expect(logs.some((l) => l.includes('[LAB-GATE]'))).toBe(false);
  });

  it('lead nunca agendado → Clínica: marca is_client como hoje', async () => {
    const { service, ops } = montar({ labs: [OUTRO_LAB] });
    await service.moveToSector(CONVERSA, 'CLINICA', 'operador-1');

    expect(argsDe(ops, 'lead.update')).toEqual([
      { where: { id: LEAD }, data: { is_client: true, became_client_at: AGORA } },
    ]);
    expect(nomes(ops)).toEqual([
      'conversation.findUnique',
      'patient.findMany',
      'calendarEvent.findFirst',
      'calendarEvent.findFirst',
      'paymentGatewayCustomer.findMany',
      'financialTransaction.findFirst',
      'instance.findFirst',
      'globalSetting.findUnique',
      'tenantSetting.findUnique',
      'globalSetting.findUnique',
      'conversation.update',
      'lead.update',
      'socket.emitConversationsUpdate',
    ]);
  });

  it('paciente em ganho → Comercial: desmarca is_client e sai do ganho como hoje', async () => {
    const { service, ops } = montar({ labs: [OUTRO_LAB], is_client: true, stage: 'FINALIZADO', stage_id: 'etapa-ganho' });
    await service.moveToSector(CONVERSA, 'COMERCIAL', 'operador-1');

    expect(argsDe(ops, 'lead.update')).toEqual([
      {
        where: { id: LEAD },
        data: {
          is_client: false,
          became_client_at: null,
          stage: 'NEGOCIACAO',
          stage_entered_at: AGORA,
          stage_id: 'etapa-orcamento',
        },
      },
    ]);
  });

  it('lead agendado sem comparecimento → Clínica: barrado como hoje, com e sem laboratório', async () => {
    for (const labs of [[], [OUTRO_LAB]]) {
      __limparCacheLabTenants();
      const { service, ops } = montar({ labs, agendou: true });
      await expect(service.moveToSector(CONVERSA, 'CLINICA')).rejects.toThrow(CLINIC_TRANSFER_BLOCKED_MSG);
      expect(nomes(ops)).not.toContain('conversation.update');
    }
  });

  it('sem chip do setor: a mensagem da clínica não muda', async () => {
    for (const labs of [[], [OUTRO_LAB]]) {
      __limparCacheLabTenants();
      const clinica = montar({ labs, temChip: false });
      await expect(clinica.service.moveToSector(CONVERSA, 'CLINICA')).rejects.toThrow(
        'Sua clínica não tem um WhatsApp Clínica conectado.',
      );
      const comercial = montar({ labs, temChip: false });
      await expect(comercial.service.moveToSector(CONVERSA, 'COMERCIAL')).rejects.toThrow(
        'Sua clínica não tem um WhatsApp Comercial conectado.',
      );
    }
  });
});

describe('create (POST /conversations) — conversa aberta pela equipe', () => {
  const dados = (conta?: string) => ({
    lead: { connect: { id: LEAD } },
    channel: 'whatsapp',
    external_id: '5582900000001@s.whatsapp.net',
    inbox: { connect: { id: CHIPS.CLINICA.inbox_id } },
    instance_name: CHIPS.CLINICA.name,
    ai_mode: true,
    tenant: conta ? { connect: { id: conta } } : undefined,
  });

  it('laboratório: nasce com ai_mode=false', async () => {
    const { service, ops } = montar({ labs: [LAB] });
    const d = dados(LAB);
    const r: any = await service.create(d as any);

    expect(argsDe(ops, 'conversation.create')).toEqual([{ data: { ...d, ai_mode: false } }]);
    expect(r).toMatchObject({ ai_mode: false });
    expect(d.ai_mode).toBe(true); // o objeto de quem chamou não é alterado
    expect(logs.some((l) => l.startsWith('[LAB-GATE] conversa-nova'))).toBe(true);
  });

  it('clínica, com e sem laboratório cadastrado: o create recebe o mesmo objeto de hoje', async () => {
    for (const labs of [[], [OUTRO_LAB]]) {
      __limparCacheLabTenants();
      const { service, ops } = montar({ labs });
      const d = dados(CLINICA);
      await service.create(d as any);

      expect(nomes(ops)).toEqual(['conversation.create']);
      expect(argsDe(ops, 'conversation.create')[0].data).toBe(d);
    }
    expect(logs.some((l) => l.includes('[LAB-GATE]'))).toBe(false);
  });

  it('sem conta no corpo: segue como hoje', async () => {
    const { service, ops } = montar({ labs: [LAB] });
    const d = dados();
    await service.create(d as any);

    expect(argsDe(ops, 'conversation.create')[0].data).toBe(d);
  });
});

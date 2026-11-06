/**
 * IA no atendimento do laboratório, rodando o AiProcessor.process de verdade com o LLM e
 * o envio dublados: quem responde, com qual prompt, por qual chip e gravando em qual conta.
 *
 * Repositório público: ids fictícios.
 */
import axios from 'axios';
import { Logger } from '@nestjs/common';
import { __limparCacheLabTenants } from '@crm/shared';
import { AiProcessor } from './ai.processor';
import {
  camadasDoPromptDoLaboratorio,
  formatarCatalogo,
  lerPassarEquipe,
  lerVisita,
  marcarVisitaDoLaboratorio,
  nomeDaIaDoLaboratorio,
  skillDoLaboratorio,
} from './lab-ia';

jest.mock('axios');
jest.mock('./llm-client', () => ({
  ...jest.requireActual('./llm-client'),
  createLLMClient: jest.fn(),
}));
jest.mock('./conversation-guide', () => ({
  ...jest.requireActual('./conversation-guide'),
  bubbleTypingMs: () => 0,
  bubblePauseMs: () => 0,
}));
const { createLLMClient } = jest.requireMock('./llm-client');

const LAB = 'conta-lab';
const OUTRO_LAB = 'conta-lab-2';
const CLINICA = 'conta-clinica';

/** O que a clínica fala e nunca pode aparecer no prompt do laboratório. */
const TERMOS_DE_CLINICA: [string, RegExp][] = [
  ['paciente', /paciente/i],
  ['consulta', /\bconsultas?\b/i],
  ['avaliação', /avalia[cç]/i],
  ['clareamento', /clareamento/i],
  ['clínica', /cl[ií]nic/i],
  ['tratamento', /tratamento/i],
  ['prontuário', /prontu[aá]rio/i],
  ['anamnese', /anamnese/i],
  ['odontograma', /odontograma/i],
  ['Sophia', /soph/i],
  ['Carla', /\bcarla\b/i],
  ['Instituto', /instituto/i],
  ['Odonto Passos', /odonto passos/i],
  ['doutora', /\bdra\b|doutora/i],
  ['recepção', /recep[cç]/i],
  ['audiência', /audi[eê]ncia/i],
  ['perícia', /per[ií]cia/i],
  ['jurídico', /jur[ií]dic/i],
  ['limpeza', /limpeza/i],
  ['Orçamentista', /or[cç]amentista/i],
  ['honorário', /honor[aá]rio/i],
  ['variável sem valor', /\{\{/],
];

/** "paciente do caso" é o único uso permitido (o paciente do dentista). */
const semOPacienteDoCaso = (t: string) => t.replace(/paciente do caso/gi, '');

function termosDeClinicaEm(texto: string): string[] {
  const limpo = semOPacienteDoCaso(texto);
  return TERMOS_DE_CLINICA.filter(([, re]) => re.test(limpo)).map(([nome]) => nome);
}

interface Cenario {
  labs?: string[];
  status?: string | null;
  chaves?: Record<string, string>;
  chipPurpose?: string | null;
  chipTenant?: string | null;
  convTenant?: string | null;
  leadTenant?: string | null;
  isClient?: boolean;
  reminder?: any;
  /** Resposta crua do modelo. */
  resposta?: string;
  falhaLista?: boolean;
  /** Mensagens globais ligadas de propósito. */
  globais?: Record<string, string>;
}

function montar(c: Cenario = {}) {
  const convTenant = c.convTenant === undefined ? LAB : c.convTenant;
  const lead = { id: 'lead-1', name: 'Dr. Fulano', phone: '5582900000001', tenant_id: c.leadTenant === undefined ? LAB : c.leadTenant, is_client: !!c.isClient };
  const convo = {
    id: 'conv-1',
    tenant_id: convTenant,
    lead_id: lead.id,
    lead,
    ai_mode: true,
    instance_name: 'chip-1',
    specialty: null,
    next_step: null,
    ai_notes: null,
    reminder_context: c.reminder ?? null,
    assigned_dentist_id: null,
    messages: [
      { id: 'm1', conversation_id: 'conv-1', direction: 'in', type: 'text', text: 'Quanto fica uma coroa em zircônia?', external_message_id: 'x1', created_at: new Date(), media: null },
    ],
  };
  const globais: Record<string, string> = { WHATSAPP_AI_ENABLED: 'true', AI_ENABLED_COMERCIAL: 'true', AI_ENABLED_CLINICA: 'true', AI_ENABLED_FINANCEIRO: 'true', ...(c.globais ?? {}) };

  const fixos: any = {
    tenantBusinessProfile: {
      findMany: jest.fn(async () => {
        if (c.falhaLista) throw new Error('banco fora');
        return (c.labs ?? [LAB, OUTRO_LAB]).map((tenant_id) => ({ tenant_id }));
      }),
    },
    conversation: { findUnique: jest.fn(async () => convo), update: jest.fn(async () => ({})) },
    instance: {
      findFirst: jest.fn(async () => ({
        tenant_id: c.chipTenant === undefined ? LAB : c.chipTenant,
        purpose: c.chipPurpose === undefined ? 'COMERCIAL' : c.chipPurpose,
        name: 'chip-1',
      })),
    },
    tenant: {
      findUnique: jest.fn(async ({ select }: any) =>
        select?.status ? { status: c.status === undefined ? 'ACTIVE' : c.status } : { name: 'Lab Exemplo', phone: '8233330000', business_hours: null },
      ),
    },
    tenantSetting: {
      findUnique: jest.fn(async ({ where }: any) => {
        const v = (c.chaves ?? {})[where.tenant_id_key.key];
        return v === undefined ? null : { value: v };
      }),
    },
    globalSetting: {
      findUnique: jest.fn(async ({ where }: any) => (globais[where.key] === undefined ? null : { value: globais[where.key] })),
      findMany: jest.fn(async () => []),
    },
    lead: { findUnique: jest.fn(async () => ({ is_client: !!c.isClient })), update: jest.fn(async () => ({})) },
    procedure: {
      findMany: jest.fn(async () => [
        { name: 'Coroa em zircônia', base_price: 350, lab_spec: { lead_time_days: 7, default_material: 'Zircônia' } },
        { name: 'Faceta em cerâmica', base_price: 0, lab_spec: null },
      ]),
    },
    calendarEvent: { findMany: jest.fn(async () => [{ type: 'PROVA', start_at: new Date('2030-01-10T14:00:00Z'), location: 'Consultório' }]) },
    message: { create: jest.fn(async ({ data }: any) => ({ id: 'msg-' + data.type, ...data })) },
    aiUsage: { create: jest.fn(async () => ({})) },
    skillExecutionLog: { create: jest.fn(async () => ({})) },
    aiMemory: { findUnique: jest.fn(async () => null) },
    memory: { findMany: jest.fn(async () => []) },
    organizationProfile: { findUnique: jest.fn(async () => null) },
    leadProfile: { findUnique: jest.fn(async () => null) },
    user: { findMany: jest.fn(async () => []), findFirst: jest.fn(async () => null), findUnique: jest.fn(async () => null) },
    notification: { create: jest.fn(async () => ({})) },
  };
  // Qualquer outra leitura: vazio. findMany devolve lista; o resto, null.
  const prisma: any = new Proxy(fixos, {
    get(alvo, nome: string) {
      if (nome in alvo) return alvo[nome];
      return new Proxy({}, { get: (_o, metodo: string) => jest.fn(async () => (metodo === 'findMany' ? [] : metodo === 'count' ? 0 : null)) });
    },
  });
  const settings: any = {
    getOpenAiKey: jest.fn(async () => 'sk-teste'),
    getActiveSkills: jest.fn(async () => [{ id: 'skill-clinica', name: 'SDR', area: 'Triagem', purpose: 'COMERCIAL', system_prompt: 'Sophia do Instituto', tools: [], assets: [] }]),
    getRouterConfig: jest.fn(async () => ({ enabled: false })),
    getDefaultModel: jest.fn(async () => 'gpt-4.1-mini'),
    getEvolutionConfig: jest.fn(async () => ({ apiUrl: 'http://evo.exemplo', apiKey: 'k' })),
    getTtsConfig: jest.fn(async () => ({ enabled: false, googleApiKey: '' })),
    getAsaasConfig: jest.fn(async () => null),
  };
  const reminderQueue = { add: jest.fn(async () => undefined) };
  const proc: any = new AiProcessor(prisma, settings, {} as any, reminderQueue as any, {} as any, { add: jest.fn(), getJob: jest.fn() } as any);

  const chat = jest.fn(async () => ({
    content: c.resposta ?? '{"reply":"A coroa em zircônia fica R$ 350,00, prazo de 7 dias.","updates":{}}',
    usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
  }));
  (createLLMClient as jest.Mock).mockReturnValue({ chat });
  (axios.post as jest.Mock).mockResolvedValue({ data: { key: { id: 'evo-1' } } });

  const rodar = (data: any = { conversation_id: 'conv-1' }) => proc.process({ id: 'job-1', data, processedOn: Date.now() } as any);
  const promptEnviado = () => {
    const arg: any = chat.mock.calls[0]?.[0 as any];
    const mensagens = (arg?.messages ?? []).map((m: any) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content))).join('\n');
    return { sistema: String(arg?.systemPrompt ?? ''), mensagens };
  };
  return { prisma, settings, proc, chat, rodar, promptEnviado, reminderQueue };
}

const chaveLigada = (p: string) => ({ [`AI_ENABLED_${p}`]: 'true' });

beforeAll(() => {
  for (const m of ['log', 'warn', 'debug', 'error'] as const) jest.spyOn(Logger.prototype, m).mockImplementation(() => undefined);
});
beforeEach(() => {
  __limparCacheLabTenants();
  (axios.post as jest.Mock).mockReset();
});

describe('quem responde', () => {
  it('conta de laboratório sem a chave não responde, mesmo com as globais ligadas', async () => {
    const m = montar({ chaves: {} });
    await m.rodar();
    expect(m.chat).not.toHaveBeenCalled();
    expect(axios.post).not.toHaveBeenCalled();
  });

  it("chave com valor diferente de 'true' não liga", async () => {
    const m = montar({ chaves: { AI_ENABLED_COMERCIAL: 'TRUE' } });
    await m.rodar();
    expect(m.chat).not.toHaveBeenCalled();
  });

  it.each(['TRIAL', 'SUSPENDED', 'DELETED', 'PAST_DUE', null])('conta em %s com a chave não responde', async (status) => {
    const m = montar({ status, chaves: chaveLigada('COMERCIAL') });
    await m.rodar();
    expect(m.chat).not.toHaveBeenCalled();
    expect(axios.post).not.toHaveBeenCalled();
  });

  it('ACTIVE com a chave responde com o prompt do laboratório e pelo chip dele', async () => {
    const m = montar({ chaves: chaveLigada('COMERCIAL') });
    const r = await m.rodar();
    expect(m.settings.getActiveSkills).not.toHaveBeenCalled();
    const { sistema } = m.promptEnviado();
    expect(sistema).toContain('atendimento comercial do laboratório');
    expect(sistema).toContain('Lab Exemplo');
    expect(sistema).toContain('Coroa em zircônia');
    const envio = (axios.post as jest.Mock).mock.calls.find((c) => String(c[0]).includes('/message/sendText/'));
    expect(envio[0]).toContain('/message/sendText/chip-1');
    expect(envio[1].text).toContain('*Atendimento:*');
    expect(r.messageIds.length).toBeGreaterThan(0);
  });

  it('a chave de um chip não liga outro', async () => {
    const m = montar({ chipPurpose: 'FINANCEIRO', chaves: chaveLigada('COMERCIAL') });
    await m.rodar();
    expect(m.chat).not.toHaveBeenCalled();
  });

  it('chip sem função não responde', async () => {
    const m = montar({ chipPurpose: null, chaves: chaveLigada('COMERCIAL') });
    await m.rodar();
    expect(m.chat).not.toHaveBeenCalled();
  });

  it('erro ao ler o tipo da conta não responde: nunca cai no prompt da clínica', async () => {
    const m = montar({ falhaLista: true, chaves: chaveLigada('COMERCIAL') });
    await m.rodar();
    expect(m.chat).not.toHaveBeenCalled();
    expect(m.settings.getActiveSkills).not.toHaveBeenCalled();
  });

  it('a lista falhou mas a conferência direta acha o laboratório: segue como laboratório, não como clínica', async () => {
    const m = montar({ chaves: chaveLigada('COMERCIAL') });
    m.prisma.tenantBusinessProfile.findMany
      .mockRejectedValueOnce(new Error('banco fora'))
      .mockResolvedValue([{ tenant_id: LAB }]);
    await m.rodar();
    expect(m.settings.getActiveSkills).not.toHaveBeenCalled();
  });

  it('erro ao ler o chip não responde', async () => {
    const m = montar({ chaves: chaveLigada('COMERCIAL') });
    m.prisma.instance.findFirst.mockRejectedValue(new Error('banco fora'));
    await m.rodar();
    expect(m.chat).not.toHaveBeenCalled();
  });

  it('erro ao ler o status da conta não responde', async () => {
    const m = montar({ chaves: chaveLigada('COMERCIAL') });
    m.prisma.tenant.findUnique.mockRejectedValue(new Error('banco fora'));
    await m.rodar();
    expect(m.chat).not.toHaveBeenCalled();
  });

  it('2ª tentativa de agendamento nunca roda no laboratório', async () => {
    const m = montar({ chaves: chaveLigada('COMERCIAL') });
    await m.rodar({ conversation_id: 'conv-1', schedulingRetry: true, retryAfterMessageAt: new Date(0) });
    expect(m.chat).not.toHaveBeenCalled();
  });
});

describe('contas não se cruzam', () => {
  it.each([
    ['contato de outra conta', { leadTenant: OUTRO_LAB }],
    ['chip de outra conta', { chipTenant: OUTRO_LAB }],
    ['conversa de clínica com chip de laboratório', { convTenant: CLINICA, leadTenant: CLINICA }],
    ['contato de clínica em conversa de laboratório', { leadTenant: CLINICA }],
  ])('%s: não responde', async (_n, extra) => {
    const m = montar({ chaves: chaveLigada('COMERCIAL'), ...extra });
    await m.rodar();
    expect(m.chat).not.toHaveBeenCalled();
    expect(m.settings.getActiveSkills).not.toHaveBeenCalled();
  });

  it('catálogo, agenda e gasto só da própria conta; nada de memória', async () => {
    const m = montar({ chaves: chaveLigada('COMERCIAL') });
    await m.rodar();
    expect(m.prisma.procedure.findMany.mock.calls[0][0].where).toEqual({ tenant_id: LAB, active: true });
    expect(m.prisma.calendarEvent.findMany.mock.calls[0][0].where).toMatchObject({ tenant_id: LAB, lead_id: 'lead-1' });
    expect(m.prisma.aiUsage.create.mock.calls[0][0].data).toMatchObject({ tenant_id: LAB, skill_id: null, call_type: 'chat' });
    expect(m.prisma.aiMemory.findUnique).not.toHaveBeenCalled();
    expect(m.prisma.memory.findMany).not.toHaveBeenCalled();
    expect(m.prisma.leadProfile.findUnique).not.toHaveBeenCalled();
    expect(m.prisma.organizationProfile.findUnique).not.toHaveBeenCalled();
    // Message.skill_id é chave estrangeira para PromptSkill: sem linha, sem id.
    expect(m.prisma.message.create.mock.calls[0][0].data.skill_id).toBeNull();
  });
});

describe('prompt do laboratório sem termo de clínica', () => {
  const CHIPS = ['COMERCIAL', 'CLINICA', 'FINANCEIRO'] as const;

  it.each(CHIPS)('chip %s, autobook desligado: prompt inteiro limpo', async (purpose) => {
    const m = montar({
      chipPurpose: purpose,
      chaves: {
        ...chaveLigada(purpose),
        AI_CLINIC_HOURS: JSON.stringify({ days: { 1: { open: '08:00', close: '18:00' } } }),
      },
      reminder: { sent_at: new Date().toISOString(), type: 'COLETA', event_date: '10/01/2030 14:00', message_sent: 'Lembrete da coleta' },
    });
    await m.rodar();
    const { sistema, mensagens } = m.promptEnviado();
    expect(sistema.length).toBeGreaterThan(500);
    expect(termosDeClinicaEm(sistema)).toEqual([]);
    expect(termosDeClinicaEm(mensagens)).toEqual([]);
  });

  it.each(CHIPS)('chip %s, autobook ligado: prompt inteiro limpo', async (purpose) => {
    const m = montar({ chipPurpose: purpose, chaves: chaveLigada(purpose), globais: { [`AI_AUTOBOOK_ENABLED_${LAB}`]: 'true' } });
    await m.rodar();
    expect(termosDeClinicaEm(m.promptEnviado().sistema)).toEqual([]);
  });

  it.each(CHIPS)('chat de teste do chip %s: resposta e prompt limpos, sem gravar nem enviar', async (purpose) => {
    const m = montar({ chaves: {} });
    const r = await m.rodar({
      dryRun: true,
      conversation_id: '__ai_test__',
      tenantId: LAB,
      purpose,
      model: 'gpt-5',
      history: [{ from: 'patient', text: 'Oi' }],
    });
    expect(r.dryRun).toBe(true);
    expect(termosDeClinicaEm(m.promptEnviado().sistema)).toEqual([]);
    expect(axios.post).not.toHaveBeenCalled();
    expect(m.prisma.message.create).not.toHaveBeenCalled();
    // O laboratório não escolhe modelo.
    expect((m.chat.mock.calls[0] as any)[0].model).toBe('gpt-4.1-mini');
  });

  it('camadas de texto sozinhas também passam (sem os dados da conta)', () => {
    for (const p of CHIPS) {
      const c = camadasDoPromptDoLaboratorio(p);
      const tudo = [c.mediaCapabilities, c.behaviorRules, c.finalRules, skillDoLaboratorio(p).system_prompt].join('\n').replace(/\{\{\w+\}\}/g, '');
      expect(termosDeClinicaEm(tudo)).toEqual([]);
    }
  });

  it('a skill do laboratório não tem ferramenta, referência nem id de PromptSkill', () => {
    for (const p of CHIPS) {
      const s = skillDoLaboratorio(p);
      expect(s).toMatchObject({ id: null, tools: [], assets: [], model: null, purpose: p });
    }
  });

  it('nome: o salvo; sem nome salvo, o neutro (nunca o padrão da clínica)', () => {
    expect(nomeDaIaDoLaboratorio('{"schedulingRetryMin":0}', 'COMERCIAL')).toBe('Atendimento');
    expect(nomeDaIaDoLaboratorio(null, 'FINANCEIRO')).toBe('Financeiro');
    expect(nomeDaIaDoLaboratorio('{"assistantName":"Marina"}', 'CLINICA')).toBe('Marina');
  });
});

describe('clínica idêntica', () => {
  const clinica = { convTenant: CLINICA, leadTenant: CLINICA, chipTenant: CLINICA };

  it('conversa de clínica usa as skills do banco e o guia de sempre, sem ler o status da conta', async () => {
    const m = montar({ ...clinica, resposta: '{"reply":"Oi","updates":{}}' });
    await m.rodar();
    expect(m.settings.getActiveSkills).toHaveBeenCalled();
    const { sistema } = m.promptEnviado();
    expect(sistema).toContain('Sophia do Instituto');
    expect(sistema).toContain('COMO VOCÊ CONVERSA');
    expect(sistema).not.toContain('laboratório de prótese');
    expect(m.prisma.tenant.findUnique.mock.calls.filter(([a]: any[]) => a?.select?.status)).toEqual([]);
    expect(m.prisma.procedure.findMany).not.toHaveBeenCalled();
    expect(m.prisma.message.create.mock.calls[0][0].data.skill_id).toBe('skill-clinica');
  });

  it('sem nenhum laboratório cadastrado não lê o chip para decidir e segue a clínica', async () => {
    const m = montar({ ...clinica, labs: [], resposta: '{"reply":"Oi","updates":{}}' });
    await m.rodar();
    expect(m.promptEnviado().sistema).toContain('COMO VOCÊ CONVERSA');
  });
});

describe('passar para a equipe e agenda', () => {
  it('passar_equipe: responde, pausa a IA da conversa e avisa por nota interna', async () => {
    const m = montar({
      chaves: chaveLigada('COMERCIAL'),
      resposta: '{"reply":"A equipe vai assumir.","updates":{"passar_equipe":"pediu desconto"}}',
    });
    await m.rodar();
    expect(m.prisma.conversation.update.mock.calls.some(([a]: any[]) => a.data?.ai_mode === false)).toBe(true);
    const nota = m.prisma.message.create.mock.calls.map(([a]: any[]) => a.data).find((d: any) => d.type === 'internal_note');
    expect(nota.text).toContain('pediu desconto');
    expect(termosDeClinicaEm(nota.text)).toEqual([]);
  });

  it('JSON truncado: ainda enxerga o passar_equipe', () => {
    expect(lerPassarEquipe({}, '{"reply":"x","updates":{"passar_equipe":"urgência"')).toBe('urgência');
    expect(lerPassarEquipe({ passar_equipe: null }, null)).toBeNull();
  });

  it('disse que marcou sem nada marcado: a frase não sai e a equipe assume', async () => {
    const m = montar({
      chaves: chaveLigada('COMERCIAL'),
      resposta: '{"reply":"Perfeito, deixei agendado terça às 09:00.","updates":{}}',
    });
    m.prisma.calendarEvent.findMany.mockResolvedValue([]);
    await m.rodar();
    const envio = (axios.post as jest.Mock).mock.calls.find((c) => String(c[0]).includes('/message/sendText/'));
    expect(envio[1].text).toContain('confirmar esse horário com a equipe');
    expect(m.prisma.conversation.update.mock.calls.some(([a]: any[]) => a.data?.ai_mode === false)).toBe(true);
  });

  it('oferta com pergunta não aciona a rede: a resposta sai e a IA segue na conversa', async () => {
    const m = montar({
      chaves: chaveLigada('COMERCIAL'),
      resposta: '{"reply":"Posso deixar marcado para terça às 09:00?","updates":{}}',
    });
    m.prisma.calendarEvent.findMany.mockResolvedValue([]);
    await m.rodar();
    const envio = (axios.post as jest.Mock).mock.calls.find((c) => String(c[0]).includes('/message/sendText/'));
    expect(envio[1].text).toContain('Posso deixar marcado');
    expect(m.prisma.conversation.update.mock.calls.some(([a]: any[]) => a.data?.ai_mode === false)).toBe(false);
  });

  it('autobook desligado: updates.visita não marca nada', async () => {
    const m = montar({
      chaves: chaveLigada('COMERCIAL'),
      resposta: '{"reply":"Vou pedir pra equipe confirmar.","updates":{"visita":{"tipo":"COLETA","date":"2031-01-10","time":"09:00"}}}',
    });
    m.prisma.calendarEvent.create = jest.fn();
    await m.rodar();
    expect(m.prisma.calendarEvent.create).not.toHaveBeenCalled();
  });

  it('só COLETA, PROVA ou ENTREGA valem', () => {
    expect(lerVisita({ visita: { tipo: 'coleta', date: '2031-01-10', time: '09:00' } })).toEqual({ tipo: 'COLETA', date: '2031-01-10', time: '09:00' });
    expect(lerVisita({ visita: { tipo: 'CONSULTA', date: '2031-01-10', time: '09:00' } })).toBeNull();
    expect(lerVisita({ visita: { tipo: 'PROVA', date: '10/01', time: '09:00' } })).toBeNull();
  });

  it('marca a visita na conta certa, com os lembretes do laboratório', async () => {
    const create = jest.fn(async ({ data }: any) => ({ id: 'ev-1', start_at: data.start_at, reminders: [{ id: 'r1', minutes_before: 2880, channel: 'WHATSAPP' }] }));
    const prisma: any = {
      $queryRaw: jest.fn(async () => []),
      user: { findFirst: jest.fn(async ({ where }: any) => (where.roles ? { id: 'adm-lab' } : null)) },
      holiday: { findFirst: jest.fn(async () => null), findMany: jest.fn(async () => []) },
      calendarEvent: { findFirst: jest.fn(async () => null), create },
      patient: { findFirst: jest.fn(async () => ({ id: 'cli-1' })) },
    };
    const fila = { add: jest.fn(async () => undefined) };
    const r = await marcarVisitaDoLaboratorio({
      prisma,
      reminderQueue: fila,
      tenantId: LAB,
      conversationId: 'conv-1',
      leadId: 'lead-1',
      assistantName: 'Marina',
      visita: { tipo: 'ENTREGA', date: '2031-01-10', time: '09:00' },
    });
    expect(r).toEqual({ ok: true, eventId: 'ev-1' });
    const data = (create.mock.calls as any)[0][0].data;
    expect(data).toMatchObject({ tenant_id: LAB, type: 'ENTREGA', title: 'Entrega', created_by_ai: true, assigned_user_id: 'adm-lab', patient_id: 'cli-1' });
    expect(data.reminders.create.map((x: any) => x.minutes_before)).toEqual([2880, 1440]);
    expect(prisma.user.findFirst.mock.calls[0][0].where).toMatchObject({ tenant_id: LAB });
    expect(fila.add).toHaveBeenCalledTimes(1);
  });

  it('fora do horário ou tipo inválido: recusa sem criar', async () => {
    const prisma: any = { user: { findFirst: jest.fn() }, calendarEvent: { create: jest.fn() }, holiday: { findMany: jest.fn(async () => []) } };
    const fechado = await marcarVisitaDoLaboratorio({
      prisma,
      tenantId: LAB,
      conversationId: 'c',
      leadId: 'l',
      hours: { days: { 1: { open: '08:00', close: '18:00' } } } as any,
      visita: { tipo: 'COLETA', date: '2031-01-11', time: '09:00' },
    });
    expect(fechado.ok).toBe(false);
    const tipo = await marcarVisitaDoLaboratorio({ prisma, tenantId: LAB, conversationId: 'c', leadId: 'l', visita: { tipo: 'CONSULTA' as any, date: '2031-01-10', time: '09:00' } });
    expect(tipo.ok).toBe(false);
    expect(prisma.calendarEvent.create).not.toHaveBeenCalled();
  });
});

describe('catálogo', () => {
  it('preço 0 ou sem prazo vira "confirmar com a equipe"; catálogo vazio não informa nada', () => {
    const t = formatarCatalogo([
      { name: 'Coroa em zircônia', base_price: 350, lab_spec: { lead_time_days: 7, default_material: 'Zircônia' } },
      { name: 'Faceta em cerâmica', base_price: 0, lab_spec: null },
    ]);
    expect(t).toMatch(/Coroa em zircônia: R\$\s?350,00; prazo de 7 dia/);
    expect(t).toContain('Faceta em cerâmica: sem preço cadastrado (diga que vai confirmar com a equipe); prazo a confirmar com a equipe');
    expect(formatarCatalogo([])).toContain('confirmar com a equipe');
  });
});

/**
 * F0b — envio SEM chip na API só sai pelo chip da PRÓPRIA clínica.
 *
 * Antes, sendText/sendMedia sem chip caíam no chip padrão do servidor (GlobalSetting
 * ou env EVOLUTION_INSTANCE_NAME, vazia → 'whatsapp') — o número de uma clínica — para
 * o paciente de qualquer clínica, e as ações sobre mensagem (apagar, editar, reagir,
 * lida, digitando) sem chip também. Agora: override legado DA clínica, ou o chip padrão
 * só se a clínica for a dona; senão nenhuma chamada HTTP e o MESMO 404 de hoje.
 *
 * Repositório público: ids e números fictícios.
 */
import { BadRequestException, Logger } from '@nestjs/common';
import { WhatsappService, describeEvolutionFailure, evolutionSendFailed } from './whatsapp.service';
import { __limparCacheEnvChip, chipPadraoDaClinica } from './env-chip';
import { chipForaDoAr, wasSent } from './envio-resultado';
import { invalidateAllSettings } from '../tenants/tenant-settings.helper';
import { MessagesService } from '../messages/messages.service';

const DONA = 'clinica-dona-exemplo'; // dona do chip padrão do servidor
const OUTRA = 'outra-clinica-exemplo';
const TEL = '5582900000001';

type Cenario = {
  legado?: string | null; // TenantSetting EVOLUTION_INSTANCE_NAME da clínica
  global?: string | null; // GlobalSetting EVOLUTION_INSTANCE_NAME
  inst?: { tenant_id: string | null; inbox: { tenant_id: string | null } | null } | null;
  instFalha?: boolean;
};

function montar(c: Cenario = {}) {
  const prisma: any = {
    tenantSetting: {
      findUnique: jest.fn(async ({ where }: any) =>
        where?.tenant_id_key?.key === 'EVOLUTION_INSTANCE_NAME' && c.legado ? { value: c.legado } : null,
      ),
    },
    globalSetting: {
      findUnique: jest.fn(async ({ where }: any) =>
        where?.key === 'EVOLUTION_INSTANCE_NAME' && c.global ? { value: c.global } : null,
      ),
    },
    instance: {
      findUnique: jest.fn(async () => {
        if (c.instFalha) throw new Error('banco fora');
        return c.inst === undefined ? { tenant_id: DONA, inbox: null } : c.inst;
      }),
    },
    tenant: { findFirst: jest.fn(async () => ({ id: DONA })) },
  };
  const settings: any = { getWhatsAppConfig: async () => ({ apiUrl: 'http://evo', apiKey: 'k' }) };
  const svc = new WhatsappService(settings, {} as any, prisma);
  return { svc, prisma };
}

const fetchMock = jest.fn();
const fetchOriginal = global.fetch;
const envOriginal = process.env.EVOLUTION_INSTANCE_NAME;
let avisos: string[] = [];

/** URLs chamadas na Evolution. */
const urls = () => fetchMock.mock.calls.map((c) => String(c[0]));

beforeAll(() => {
  (global as any).fetch = fetchMock;
});
afterAll(() => {
  (global as any).fetch = fetchOriginal;
  if (envOriginal === undefined) delete process.env.EVOLUTION_INSTANCE_NAME;
  else process.env.EVOLUTION_INSTANCE_NAME = envOriginal;
});
beforeEach(() => {
  delete process.env.EVOLUTION_INSTANCE_NAME;
  invalidateAllSettings();
  __limparCacheEnvChip();
  fetchMock.mockReset();
  fetchMock.mockResolvedValue({ ok: true, json: async () => ({ key: { id: 'm1' } }), text: async () => '' });
  avisos = [];
  // O resolveEvolutionConfig faz `await import(...)`, que não roda no jest deste projeto
  // (sem --experimental-vm-modules). Aqui ele só dá URL/chave da clínica; o instanceName
  // dele NÃO é mais usado no envio sem chip (nunca pode aparecer numa URL).
  jest.spyOn(WhatsappService.prototype, 'resolveEvolutionConfig').mockResolvedValue({
    apiUrl: 'http://evo',
    apiKey: 'k',
    instanceName: 'chip-do-resolve-antigo',
  });
  jest.spyOn(Logger.prototype, 'warn').mockImplementation((m: any) => {
    avisos.push(String(m));
  });
  jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
});
afterEach(() => {
  const viaResolveAntigo = urls().filter((u) => u.includes('chip-do-resolve-antigo'));
  jest.restoreAllMocks();
  expect(viaResolveAntigo).toEqual([]);
});

/** O que o chamador vê é o MESMO de hoje com o 'whatsapp' inexistente (404). */
function confereMesmaFalhaDeHoje(r: any) {
  expect(r).toMatchObject({ statusCode: 404, semChip: true });
  expect(evolutionSendFailed(r)).toBe(true);
  expect(wasSent(r)).toBe(false);
  expect(chipForaDoAr(r)).toBe(true);
  expect(describeEvolutionFailure(r)).toMatch(/chip do WhatsApp não encontrado/);
}

describe('sendText sem chip', () => {
  it('clínica que NÃO é dona do chip padrão → nenhuma chamada (nem whatsappNumbers) e a falha de hoje', async () => {
    const { svc } = montar();
    const r = await svc.sendText(TEL, 'oi', undefined, undefined, OUTRA);
    expect(fetchMock).not.toHaveBeenCalled();
    confereMesmaFalhaDeHoje(r);
    expect(avisos.join('\n')).toMatch(/\[envio-chip\] sendText: clínica outra-clinica-exemplo sem chip próprio/);
  });

  it('clínica dona do chip padrão → sai por ele, igual hoje', async () => {
    const { svc } = montar();
    const r = await svc.sendText(TEL, 'oi', undefined, undefined, DONA);
    expect(urls()).toContain('http://evo/message/sendText/whatsapp');
    expect(urls()).toContain('http://evo/chat/whatsappNumbers/whatsapp');
    expect(evolutionSendFailed(r)).toBe(false);
  });

  it('override legado DA clínica (TenantSetting) → sai por ele, sem conferir dono', async () => {
    const { svc, prisma } = montar({ legado: 'chip-legado' });
    await svc.sendText(TEL, 'oi', undefined, undefined, OUTRA);
    expect(urls()).toContain('http://evo/message/sendText/chip-legado');
    expect(prisma.instance.findUnique).not.toHaveBeenCalled();
  });

  it('GlobalSetting do chip padrão de outra clínica → não envia; a dona continua igual', async () => {
    const { svc, prisma } = montar({ global: 'chip-global', inst: { tenant_id: DONA, inbox: null } });
    const r = await svc.sendText(TEL, 'oi', undefined, undefined, OUTRA);
    expect(fetchMock).not.toHaveBeenCalled();
    confereMesmaFalhaDeHoje(r);
    expect(prisma.instance.findUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { name: 'chip-global' } }));

    await svc.sendText(TEL, 'oi', undefined, undefined, DONA);
    expect(urls()).toContain('http://evo/message/sendText/chip-global');
  });

  it('env EVOLUTION_INSTANCE_NAME de outra clínica → não envia; a dona continua igual', async () => {
    process.env.EVOLUTION_INSTANCE_NAME = 'chip-env';
    const { svc } = montar();
    await svc.sendText(TEL, 'oi', undefined, undefined, OUTRA);
    expect(fetchMock).not.toHaveBeenCalled();
    await svc.sendText(TEL, 'oi', undefined, undefined, DONA);
    expect(urls()).toContain('http://evo/message/sendText/chip-env');
  });

  it('sem clínica e sem chip → não envia (antes ia pelo chip padrão)', async () => {
    const { svc } = montar();
    const r = await svc.sendText(TEL, 'oi');
    expect(fetchMock).not.toHaveBeenCalled();
    confereMesmaFalhaDeHoje(r);
    expect(avisos.join('\n')).toMatch(/\[envio-chip\] sendText: sem chip e sem clínica — não envia/);
  });

  it('com chip → nada muda: sai pelo chip e nem consulta o banco', async () => {
    const { svc, prisma } = montar();
    await svc.sendText(TEL, 'oi', 't1234-1');
    expect(urls()).toContain('http://evo/message/sendText/t1234-1');
    expect(prisma.instance.findUnique).not.toHaveBeenCalled();
    expect(prisma.tenantSetting.findUnique).not.toHaveBeenCalled();
  });
});

describe('chipPadraoDaClinica (dono do chip padrão)', () => {
  it('dono pelo setor quando a Instance não tem clínica', async () => {
    const { prisma } = montar({ inst: { tenant_id: null, inbox: { tenant_id: DONA } } });
    await expect(chipPadraoDaClinica(prisma, DONA, 't')).resolves.toBe('whatsapp');
    await expect(chipPadraoDaClinica(prisma, OUTRA, 't')).resolves.toBeNull();
  });

  it('chip sem registro → a clínica mais antiga (quem sempre usou)', async () => {
    const { prisma } = montar({ inst: null });
    await expect(chipPadraoDaClinica(prisma, DONA, 't')).resolves.toBe('whatsapp');
    expect(prisma.tenant.findFirst).toHaveBeenCalledWith({ orderBy: { created_at: 'asc' }, select: { id: true } });
    await expect(chipPadraoDaClinica(prisma, OUTRA, 't')).resolves.toBeNull();
  });

  it('falha ao conferir o dono → não envia (falha fechada)', async () => {
    const { svc, prisma } = montar({ instFalha: true });
    await expect(chipPadraoDaClinica(prisma, DONA, 't')).resolves.toBeNull();
    const r = await svc.sendText(TEL, 'oi', undefined, undefined, DONA);
    expect(fetchMock).not.toHaveBeenCalled();
    confereMesmaFalhaDeHoje(r);
  });

  it('dono em cache por 60 s (não consulta o banco a cada envio)', async () => {
    const { prisma } = montar();
    await chipPadraoDaClinica(prisma, DONA, 't');
    await chipPadraoDaClinica(prisma, OUTRA, 't');
    expect(prisma.instance.findUnique).toHaveBeenCalledTimes(1);
  });
});

describe('sendMedia sem chip', () => {
  const doc = (svc: WhatsappService, tenant?: string, chip?: string) =>
    svc.sendMedia(TEL, 'document', 'b64', 'leg', chip, 'a.pdf', 'application/pdf', undefined, tenant);

  it('clínica que NÃO é dona → nenhuma chamada e a falha de hoje', async () => {
    const { svc } = montar();
    const r = await doc(svc, OUTRA);
    expect(fetchMock).not.toHaveBeenCalled();
    confereMesmaFalhaDeHoje(r);
  });

  it('clínica dona → sai pelo chip padrão, igual hoje', async () => {
    const { svc } = montar();
    await doc(svc, DONA);
    expect(urls()).toContain('http://evo/message/sendMedia/whatsapp');
  });

  it('sem clínica e sem chip (áudio do chat sem chip) → não envia', async () => {
    const { svc } = montar();
    const r = await svc.sendMedia(TEL, 'audio', 'b64');
    expect(fetchMock).not.toHaveBeenCalled();
    confereMesmaFalhaDeHoje(r);
  });

  it('com chip → nada muda', async () => {
    const { svc, prisma } = montar();
    await doc(svc, undefined, 't1234-1');
    expect(urls()).toContain('http://evo/message/sendMedia/t1234-1');
    expect(prisma.instance.findUnique).not.toHaveBeenCalled();
  });
});

describe('ações sobre mensagem sem chip → não chama (sem cair no chip padrão)', () => {
  it('editar, apagar, reagir, lista, lida e digitando', async () => {
    const { svc } = montar();
    const rs = [
      await svc.editMessage('', TEL, 'id1', 'x'),
      await svc.deleteForEveryone('', `${TEL}@s.whatsapp.net`, 'id1', true),
      await svc.sendReaction('', { remoteJid: 'j', fromMe: true, id: 'i' }, '👍'),
      await svc.sendList(TEL, 't', 'd', 'b', [], undefined),
      await svc.markAsRead('', []),
      await svc.sendPresence('', TEL, 'composing'),
    ];
    expect(fetchMock).not.toHaveBeenCalled();
    for (const r of rs) expect(r).toMatchObject({ statusCode: 404, semChip: true });
  });

  it('com chip → chamam a Evolution pelo chip, como antes', async () => {
    const { svc } = montar();
    await svc.editMessage('t1234-1', TEL, 'id1', 'x');
    await svc.deleteForEveryone('t1234-1', `${TEL}@s.whatsapp.net`, 'id1', true);
    await svc.sendReaction('t1234-1', { remoteJid: 'j', fromMe: true, id: 'i' }, '👍');
    await svc.markAsRead('t1234-1', []);
    await svc.sendPresence('t1234-1', TEL, 'composing');
    expect(urls()).toEqual([
      'http://evo/chat/updateMessage/t1234-1',
      'http://evo/chat/deleteMessageForEveryone/t1234-1',
      'http://evo/message/sendReaction/t1234-1',
      'http://evo/chat/markMessageAsRead/t1234-1',
      'http://evo/chat/sendPresence/t1234-1',
    ]);
  });
});

describe('quem chama: chat do operador sem chip fica com o MESMO registro de falha', () => {
  it('MessagesService.sendMessage: conversa sem chip e clínica sem chip → "erro" + BadRequest, sem chamar a Evolution', async () => {
    const { svc: whatsapp, prisma } = montar();
    const criadas: any[] = [];
    Object.assign(prisma, {
      conversation: {
        findUnique: jest.fn(async () => ({
          id: 'conv-1', lead_id: 'lead-1', instance_name: null, tenant_id: OUTRA, inbox_id: null,
          assigned_user_id: null, lead: { phone: TEL, is_client: true },
        })),
        update: jest.fn(async () => ({})),
      },
      instance: { ...prisma.instance, findFirst: jest.fn(async () => null) },
      message: {
        create: jest.fn(async ({ data }: any) => {
          criadas.push(data);
          return { id: 'msg-1', ...data };
        }),
      },
    });
    const gateway: any = { emitNewMessage: jest.fn(), emitConversationsUpdate: jest.fn() };
    const messages = new MessagesService(prisma, whatsapp, gateway, {} as any, {} as any, {} as any, {} as any, {} as any);

    await expect(messages.sendMessage('conv-1', 'oi')).rejects.toThrow(
      new BadRequestException('Falha ao enviar mensagem via WhatsApp'),
    );
    expect(fetchMock).not.toHaveBeenCalled();
    expect(criadas).toEqual([expect.objectContaining({ status: 'erro', text: 'oi', direction: 'out' })]);
  });
});

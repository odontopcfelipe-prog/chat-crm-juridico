/**
 * F6 do laboratório — envio do orçamento de trabalho pelo WhatsApp
 * (QuotesService.sendByWhatsapp → enviarOrcamentoDoLaboratorio).
 *
 * Laboratório: sem portal nem link; a mensagem é o PDF do orçamento com a legenda do
 * laboratório, pela conversa do cliente no chip Atendimento/Comercial; o orçamento vira
 * SENT e ganha a versão 'SEND'. Sem PDF, o envio é recusado e nada muda.
 * Clínica: o mesmo envio de hoje (link do portal, texto e PDF), com e sem outra conta de
 * laboratório.
 *
 * Sem banco: o Prisma é um gravador; dados de exemplo (repositório público).
 */
import { BadRequestException, Logger } from '@nestjs/common';
import { __limparCacheLabTenants } from '@crm/shared';
import { temPalavraDeClinica } from '../business-type/lab-vocab.interceptor';
import { LAB_API_MESSAGES } from '../business-type/lab-api-messages';
import { QuotesService } from './quotes.service';
import { LAB_ORCAMENTO_WHATSAPP } from './lab-orcamento-textos';
import { legendaDoOrcamentoDoLaboratorio } from './orcamento-whatsapp-laboratorio';

const LAB = 'tenant-lab-exemplo';
const CLINICA = 'tenant-clinica-exemplo';
const USER = 'u-atendimento';
const PDF = Buffer.from('%PDF-1.3 exemplo');

beforeEach(() => {
  __limparCacheLabTenants();
  // Relógio parado: sent_at igual nas duas montagens comparadas.
  jest.useFakeTimers({
    now: new Date('2026-10-30T14:00:00.000Z'),
    doNotFake: [
      'nextTick', 'setImmediate', 'clearImmediate', 'setTimeout', 'clearTimeout',
      'setInterval', 'clearInterval', 'queueMicrotask', 'hrtime', 'performance',
    ],
  });
  for (const nivel of ['log', 'warn', 'debug', 'error', 'verbose'] as const) {
    jest.spyOn(Logger.prototype, nivel).mockImplementation(() => undefined);
  }
});
afterEach(() => {
  jest.restoreAllMocks();
  jest.useRealTimers();
});

type Op = [string, any];

function orcamento(conta: string, over: Record<string, any> = {}) {
  return {
    id: 'orc-1',
    quote_number: 42,
    status: 'DRAFT',
    sent_at: null,
    patient_id: 'cli-1',
    patient: { id: 'cli-1', name: 'Clínica Parceira Exemplo', tenant_id: conta, phone: '5582900000001' },
    items: [{ id: 'qi-1' }, { id: 'qi-2' }],
    total_value: 810,
    discount_value: 90,
    valid_until: new Date('2026-11-17T15:00:00.000Z'),
    _count: { attachments: 1, versions: 0 },
    ...over,
  };
}

function montar(conta: string, labs: string[], opts: { quote?: any; pdf?: 'ok' | 'falha' | 'ausente'; chips?: any[]; envio?: any } = {}) {
  __limparCacheLabTenants();
  const ops: Op[] = [];
  const quote = opts.quote ?? orcamento(conta);
  const prisma: any = {
    tenantBusinessProfile: { findMany: jest.fn(async () => labs.map((tenant_id) => ({ tenant_id }))) },
    quote: {
      findUnique: jest.fn(async (a: any) => (ops.push(['quote.findUnique', a]), quote)),
      update: jest.fn(async (a: any) => (ops.push(['quote.update', a]), { ...quote, ...a.data })),
    },
    tenant: { findUnique: jest.fn(async (a: any) => (ops.push(['tenant.findUnique', a]), { name: conta === LAB ? 'Laboratório Exemplo' : 'Clínica Exemplo' })) },
  };
  const whatsapp = { sendText: jest.fn(), sendMedia: jest.fn() };
  const portal = { createMagicLink: jest.fn(async () => ({ link: 'https://portal.exemplo.test/p/token' })) };
  const versions = { createSnapshot: jest.fn(async () => ({ id: 'v-1' })) };
  const pdfService =
    opts.pdf === 'ausente'
      ? undefined
      : {
          generatePdf: jest.fn(async () => {
            if (opts.pdf === 'falha') throw new Error('pdfkit indisponível');
            return PDF;
          }),
        };
  const messages = {
    resolvePatientChips: jest.fn(async () => opts.chips ?? [{ name: 'chip-atendimento', purpose: 'CLINICA' }]),
    assertPatientSendable: jest.fn(async () => undefined),
    sendPatientText: jest.fn(async () => ({ message: { id: 'msg-1', external_message_id: 'wamid-1' }, instance: 'chip-atendimento', purpose: 'CLINICA' })),
    sendPatientFile: jest.fn(
      opts.envio ??
        (async () => ({ message: { id: 'msg-2', external_message_id: 'wamid-2' }, instance: 'chip-atendimento', purpose: 'CLINICA' })),
    ),
  };
  const conversations = { findOrCreatePatientConversationId: jest.fn(async () => 'conversa-1') };
  const svc = new QuotesService(
    prisma, { get: () => undefined } as any, whatsapp as any, portal as any, versions as any, undefined, undefined, undefined,
    pdfService as any, undefined, undefined, messages as any, conversations as any,
  );
  jest.spyOn(svc, 'findOne').mockImplementation(async () => quote);
  const lead = jest.spyOn(svc, 'resolvePatientWhatsappLead').mockResolvedValue('lead-1');
  return { svc, ops, prisma, whatsapp, portal, versions, pdfService, messages, conversations, lead, quote };
}

describe('envio do orçamento de trabalho pelo WhatsApp (F6)', () => {
  it('laboratório: PDF anexado, legenda do laboratório, sem link do portal; vira SENT com a versão SEND', async () => {
    const m = montar(LAB, [LAB]);
    const r = await m.svc.sendByWhatsapp('orc-1', LAB, USER);

    expect(r).toEqual({ ok: true, link: null, sent_to: '5582900000001', status: 'SENT', conversationId: 'conversa-1' });
    expect(m.portal.createMagicLink).not.toHaveBeenCalled();
    expect(m.messages.sendPatientText).not.toHaveBeenCalled();
    expect(m.whatsapp.sendText).not.toHaveBeenCalled();
    expect(m.whatsapp.sendMedia).not.toHaveBeenCalled();

    // Chip Atendimento/Comercial (nunca o Financeiro), contato e conversa do cliente.
    expect(m.messages.resolvePatientChips).toHaveBeenCalledWith(LAB, true);
    expect(m.lead).toHaveBeenCalledWith('cli-1', LAB);
    expect(m.conversations.findOrCreatePatientConversationId).toHaveBeenCalledWith('lead-1', LAB);
    expect(m.messages.assertPatientSendable).toHaveBeenCalledWith({ conversationId: 'conversa-1', tenantId: LAB, expectedPhone: '5582900000001' });
    expect(m.pdfService!.generatePdf).toHaveBeenCalledWith('orc-1', LAB);

    expect(m.messages.sendPatientFile).toHaveBeenCalledTimes(1);
    const [envio] = m.messages.sendPatientFile.mock.calls[0] as any[];
    expect(envio).toMatchObject({
      conversationId: 'conversa-1',
      tenantId: LAB,
      expectedPhone: '5582900000001',
      file: { buffer: PDF, mimetype: 'application/pdf', originalname: 'orcamento-42.pdf', size: PDF.length },
    });
    const legenda: string = envio.caption;
    expect(legenda).not.toMatch(/https?:|portal/i);
    expect(legenda).not.toMatch(/na cl[ií]nica \*/i);
    expect(temPalavraDeClinica(legenda)).toBe(false);
    expect(legenda).toContain('Oi, Clínica Parceira Exemplo! 👋');
    expect(legenda).toContain('Seu orçamento nº 42 no laboratório *Laboratório Exemplo* está pronto:');
    expect(legenda).toContain('📋 2 serviço(s)');
    expect(legenda).toContain('📎 1 anexo(s) (fotos e arquivos do caso)');
    expect(legenda).toContain('Segue o PDF com os detalhes.');

    expect(m.prisma.quote.update).toHaveBeenCalledWith({
      where: { id: 'orc-1' },
      data: { status: 'SENT', sent_at: expect.any(Date), whatsapp_message_id: 'wamid-2' },
    });
    expect(m.versions.createSnapshot).toHaveBeenCalledWith('orc-1', USER, 'SEND', LAB_ORCAMENTO_WHATSAPP.versaoEnviada);
  });

  it('laboratório, reenvio (já SENT): não muda o status nem cria versão; só guarda o id da mensagem', async () => {
    const m = montar(LAB, [LAB], { quote: orcamento(LAB, { status: 'SENT', sent_at: new Date('2026-10-20T12:00:00Z') }) });
    await m.svc.sendByWhatsapp('orc-1', LAB, USER);
    expect(m.prisma.quote.update).toHaveBeenCalledWith({ where: { id: 'orc-1' }, data: { whatsapp_message_id: 'wamid-2' } });
    expect(m.versions.createSnapshot).not.toHaveBeenCalled();
  });

  it.each([
    ['PDF falhou', 'falha' as const],
    ['sem o serviço de PDF', 'ausente' as const],
  ])('laboratório, %s: recusa sem enviar e o orçamento continua como estava', async (_r, pdf) => {
    const m = montar(LAB, [LAB], { pdf });
    const e = await m.svc.sendByWhatsapp('orc-1', LAB, USER).catch((x) => x);
    expect(e).toBeInstanceOf(BadRequestException);
    expect(e.message).toBe(LAB_ORCAMENTO_WHATSAPP.semPdf);
    expect(m.messages.sendPatientFile).not.toHaveBeenCalled();
    expect(m.messages.sendPatientText).not.toHaveBeenCalled();
    expect(m.prisma.quote.update).not.toHaveBeenCalled();
    expect(m.versions.createSnapshot).not.toHaveBeenCalled();
  });

  it('laboratório, envio falhou: motivo no texto do laboratório, "pode ter sido entregue" propagado, sem SENT', async () => {
    const falha = Object.assign(new Error('Paciente sem telefone cadastrado'), { mayHaveBeenDelivered: true });
    const m = montar(LAB, [LAB], { envio: async () => { throw falha; } });
    const e = await m.svc.sendByWhatsapp('orc-1', LAB, USER).catch((x) => x);
    expect(e).toBeInstanceOf(BadRequestException);
    expect(e.message).toBe(LAB_ORCAMENTO_WHATSAPP.falhaEnvio(LAB_API_MESSAGES.semTelefoneCobranca));
    expect(e.mayHaveBeenDelivered).toBe(true);
    expect(m.prisma.quote.update).not.toHaveBeenCalled();
  });

  it('laboratório, sem chip Atendimento/Comercial: a mensagem do laboratório, sem contato nem conversa', async () => {
    const m = montar(LAB, [LAB], { chips: [] });
    const e = await m.svc.sendByWhatsapp('orc-1', LAB, USER).catch((x) => x);
    expect(e.message).toBe(LAB_API_MESSAGES.semChipOrcamento);
    expect(m.lead).not.toHaveBeenCalled();
    expect(m.conversations.findOrCreatePatientConversationId).not.toHaveBeenCalled();
    expect(m.pdfService!.generatePdf).not.toHaveBeenCalled();
  });

  it('laboratório, sem telefone, sem caixa de entrada e status fechado: mensagens do laboratório', async () => {
    const semTel = montar(LAB, [LAB], { quote: orcamento(LAB, { patient: { id: 'cli-1', name: 'X', tenant_id: LAB, phone: null } }) });
    expect((await semTel.svc.sendByWhatsapp('orc-1', LAB, USER).catch((x) => x)).message).toBe(LAB_API_MESSAGES.semTelefoneOrcamento);

    const semCaixa = montar(LAB, [LAB]);
    semCaixa.conversations.findOrCreatePatientConversationId.mockResolvedValue(null as any);
    expect((await semCaixa.svc.sendByWhatsapp('orc-1', LAB, USER).catch((x) => x)).message).toBe(LAB_API_MESSAGES.semCaixaDeEntrada);

    const aceito = montar(LAB, [LAB], { quote: orcamento(LAB, { status: 'ACCEPTED' }) });
    const e = await aceito.svc.sendByWhatsapp('orc-1', LAB, USER).catch((x) => x);
    expect(e.message).toBe(LAB_ORCAMENTO_WHATSAPP.statusNaoReenvia('ACCEPTED'));
    expect(aceito.messages.resolvePatientChips).not.toHaveBeenCalled();
  });

  it('clínica (com e sem outra conta de laboratório): link do portal, texto de hoje e as mesmas operações', async () => {
    const antes = montar(CLINICA, []);
    const r1: any = await antes.svc.sendByWhatsapp('orc-1', CLINICA, USER);
    const depois = montar(CLINICA, [LAB]);
    const r2: any = await depois.svc.sendByWhatsapp('orc-1', CLINICA, USER);

    for (const [m, r] of [[antes, r1], [depois, r2]] as const) {
      expect(r.link).toBe('https://portal.exemplo.test/p/token');
      expect(m.portal.createMagicLink).toHaveBeenCalledWith(CLINICA, 'cli-1', 'OTHER');
      const [envio] = m.messages.sendPatientFile.mock.calls[0] as any[];
      expect(envio.caption).toContain('Oi Clínica! 👋');
      expect(envio.caption).toContain('Seu orçamento na clínica *Clínica Exemplo* está pronto:');
      expect(envio.caption).toContain('📋 2 procedimento(s)');
      expect(envio.caption).toContain('https://portal.exemplo.test/p/token');
      expect(envio.file.originalname).toBe('orcamento-42.pdf');
    }
    expect(depois.ops).toEqual(antes.ops);
    expect(depois.messages.sendPatientFile.mock.calls).toEqual(antes.messages.sendPatientFile.mock.calls);
  });

  it('legenda sem nome do laboratório e sem validade/desconto/anexos: linhas opcionais somem', () => {
    const legenda = legendaDoOrcamentoDoLaboratorio(
      { patient: { name: '' }, items: [], total_value: 100, discount_value: 0, valid_until: null, _count: { attachments: 0 } },
      '7',
      null,
    );
    expect(legenda).toBe(
      ['Olá! 👋', '', 'Seu orçamento nº 7 está pronto:', '', '📋 0 serviço(s)', `💰 Total: ${(100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })}`, LAB_ORCAMENTO_WHATSAPP.fecho].join('\n'),
    );
  });
});

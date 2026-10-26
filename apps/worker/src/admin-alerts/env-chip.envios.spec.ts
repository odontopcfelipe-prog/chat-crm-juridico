/**
 * F0b (sobras) — os envios AO PACIENTE/CONTATO que ainda caíam no chip padrão do
 * servidor (env EVOLUTION_INSTANCE_NAME) sem conferir a clínica: repasse do
 * não-paciente e resposta da IA, confirmação do book_appointment, follow-up,
 * influenciadores e régua de cobrança.
 *
 * Regra: o chip padrão só serve à clínica DONA dele (env-chip.ts). Sem chip próprio
 * → não envia + o MESMO registro de falha de hoje (com a env vazia todos já falhavam:
 * rota vazia ou 404 do chip morto 'whatsapp'). Nunca escolhe outro chip.
 *
 * Mesmo padrão do bloco "quem usa" de env-chip.tenant.spec.ts: Prisma mockado,
 * env = 'chip-padrao', Evolution mockada no axios. Dados de exemplo (repo público).
 */
import axios from 'axios';
import { Logger } from '@nestjs/common';
import { __limparCacheEnvChip } from './env-chip';
import { AiProcessor } from '../ai/ai.processor';
import { BookAppointmentHandler } from '../ai/tool-handlers/book-appointment';
import { FollowupProcessor } from '../followup/followup.processor';
import { InfluencerMessagesCronService } from '../influencer-messages/influencer-messages-cron.service';
import { PaymentAlertsCronService } from '../payment/payment-alerts-cron.service';

jest.mock('axios');
const post = axios.post as jest.Mock;

const TEL = '5582900000001';

/** Banco em que o chip padrão (Instance) é da clínica `dono`; `extra` = outros modelos. */
function prismaCom(dono: string | null, extra: Record<string, any> = {}) {
  return {
    instance: {
      findUnique: jest.fn(async () => (dono ? { tenant_id: dono } : null)),
      findMany: jest.fn(async () => []),
      findFirst: jest.fn(async () => null),
    },
    tenant: { findFirst: jest.fn(async () => ({ id: 'instituto' })) },
    ...extra,
  } as any;
}

const settings = { getEvolutionConfig: jest.fn(async () => ({ apiUrl: 'http://evo', apiKey: 'k' })) } as any;

const ENV = process.env.EVOLUTION_INSTANCE_NAME;
beforeAll(() => {
  jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
});
beforeEach(() => {
  process.env.EVOLUTION_INSTANCE_NAME = 'chip-padrao';
  __limparCacheEnvChip();
  post.mockReset();
  post.mockResolvedValue({ data: { key: { id: 'm1' } } });
  settings.getEvolutionConfig.mockClear();
});
afterAll(() => {
  if (ENV === undefined) delete process.env.EVOLUTION_INSTANCE_NAME;
  else process.env.EVOLUTION_INSTANCE_NAME = ENV;
});

// ─── ai.processor — repasse do não-paciente (sendPlainWhatsApp) ─────────────────
describe('IA: resposta de repasse ao não-paciente', () => {
  const novo = (prisma: any): any => new AiProcessor(prisma, settings, {} as any, {} as any, {} as any, {} as any);

  it('conversa sem chip, clínica que não é dona do chip padrão → false, zero envio', async () => {
    const proc = novo(prismaCom('instituto'));
    await expect(proc.sendPlainWhatsApp(TEL, 'oi', null, 'pra-sorrir')).resolves.toBe(false);
    expect(post).not.toHaveBeenCalled();
  });

  it('clínica dona → sai pelo chip padrão, como antes', async () => {
    const proc = novo(prismaCom('instituto'));
    await expect(proc.sendPlainWhatsApp(TEL, 'oi', null, 'instituto')).resolves.toBe(true);
    expect(post.mock.calls[0][0]).toBe('http://evo/message/sendText/chip-padrao');
  });

  it('conversa com chip → usa o chip dela, sem conferir o dono do padrão', async () => {
    const prisma = prismaCom('instituto');
    await expect(novo(prisma).sendPlainWhatsApp(TEL, 'oi', 'chip-da-conversa', 'pra-sorrir')).resolves.toBe(true);
    expect(post.mock.calls[0][0]).toBe('http://evo/message/sendText/chip-da-conversa');
    expect(prisma.instance.findUnique).not.toHaveBeenCalled();
  });

  it('env vazia → false sem chamar a Evolution (hoje: POST em rota vazia → false)', async () => {
    delete process.env.EVOLUTION_INSTANCE_NAME;
    await expect(novo(prismaCom('instituto')).sendPlainWhatsApp(TEL, 'oi', null, 'instituto')).resolves.toBe(false);
    expect(post).not.toHaveBeenCalled();
  });
});

// ─── ai.processor — chip da resposta normal da IA (chipDaResposta) ──────────────
describe('IA: chip da resposta ao paciente', () => {
  const novo = (prisma: any): any => new AiProcessor(prisma, settings, {} as any, {} as any, {} as any, {} as any);

  it("outra clínica → '' (o balão continua gravado como 'falhou', nunca sai por outro número)", async () => {
    await expect(novo(prismaCom('instituto')).chipDaResposta({ instance_name: null }, 'pra-sorrir')).resolves.toBe('');
  });

  it('clínica dona → o chip padrão', async () => {
    await expect(novo(prismaCom('instituto')).chipDaResposta({ instance_name: null }, 'instituto')).resolves.toBe('chip-padrao');
  });

  it('conversa com chip → o dela, sem consultar o dono', async () => {
    const prisma = prismaCom('instituto');
    await expect(novo(prisma).chipDaResposta({ instance_name: 't1-1' }, 'pra-sorrir')).resolves.toBe('t1-1');
    expect(prisma.instance.findUnique).not.toHaveBeenCalled();
  });

  it("env vazia → '' (igual a hoje)", async () => {
    delete process.env.EVOLUTION_INSTANCE_NAME;
    await expect(novo(prismaCom('instituto')).chipDaResposta({ instance_name: null }, 'instituto')).resolves.toBe('');
  });

  it('conversa e lead sem clínica (legado) → o chip padrão (resíduo documentado em env-chip.ts)', async () => {
    await expect(novo(prismaCom('instituto')).chipDaResposta({ instance_name: null }, null)).resolves.toBe('chip-padrao');
  });
});

// ─── book-appointment — confirmação formal ao paciente (notifyPatient) ──────────
describe('book_appointment: confirmação ao paciente', () => {
  const ev = (tenant_id: string | undefined) => ({
    id: 'ev-1', start_at: new Date('2026-10-21T14:30:00.000Z'), location: null, assigned_user: { name: 'Dra. Ana Exemplo' },
    lead_id: 'lead-1', lead: { name: 'Maria Exemplo', phone: TEL }, tenant_id,
  });
  const banco = () =>
    prismaCom('instituto', {
      globalSetting: {
        findUnique: jest.fn(async ({ where }: any) =>
          ({ EVOLUTION_API_URL: { value: 'http://evo' }, EVOLUTION_GLOBAL_APIKEY: { value: 'k' } } as any)[where.key] ?? null),
      },
    });
  const notificar = (e: any, prisma: any) => (new BookAppointmentHandler() as any).notifyPatient(e, prisma);

  it('evento de outra clínica → não envia', async () => {
    await notificar(ev('pra-sorrir'), banco());
    expect(post).not.toHaveBeenCalled();
  });

  it('evento da clínica dona → sai pelo chip padrão, como antes', async () => {
    await notificar(ev('instituto'), banco());
    expect(post).toHaveBeenCalledTimes(1);
    expect(post.mock.calls[0][0]).toBe('http://evo/message/sendText/chip-padrao');
  });

  it('env vazia → não envia (hoje: POST em rota vazia que falhava)', async () => {
    delete process.env.EVOLUTION_INSTANCE_NAME;
    await notificar(ev('instituto'), banco());
    expect(post).not.toHaveBeenCalled();
  });
});

// ─── followup.processor — chip do lead sem conversa aberta (chipDoLead) ─────────
describe('follow-up: lead sem conversa aberta e clínica sem chip com função', () => {
  const lead = (tenant_id: string) => ({ id: 'l1', tenant_id, phone: TEL, name: 'Maria Exemplo', is_client: false });
  const banco = (tenant_id: string, chips: any[] = []) =>
    prismaCom('instituto', {
      instance: {
        findUnique: jest.fn(async () => ({ tenant_id: 'instituto' })),
        findMany: jest.fn(async () => chips),
      },
      lead: { findUnique: jest.fn(async () => lead(tenant_id)), update: jest.fn(async () => ({})) },
      followupMessage: { update: jest.fn(async () => ({})), findUnique: jest.fn(async () => null) },
      dispatchLog: { create: jest.fn(async () => ({})) },
    });
  const novo = (prisma: any): any => new FollowupProcessor(prisma, settings, {} as any);

  it('outra clínica → não envia; FollowupMessage FALHOU + DispatchLog FAILED (o mesmo registro de hoje)', async () => {
    const prisma = banco('pra-sorrir');
    await novo(prisma).sendMessageDirect('m1', 'l1', 'whatsapp', 'oi', null);
    expect(post).not.toHaveBeenCalled();
    expect(prisma.followupMessage.update).toHaveBeenCalledWith({ where: { id: 'm1' }, data: { status: 'FALHOU' } });
    expect(prisma.dispatchLog.create.mock.calls[0][0].data).toMatchObject({ tenant_id: 'pra-sorrir', status: 'FAILED' });
  });

  it('clínica dona → sai pelo chip padrão e fica ENVIADO', async () => {
    const prisma = banco('instituto');
    await novo(prisma).sendMessageDirect('m1', 'l1', 'whatsapp', 'oi', null);
    expect(post.mock.calls[0][0]).toBe('http://evo/message/sendText/chip-padrao');
    expect(prisma.followupMessage.update.mock.calls[0][0].data.status).toBe('ENVIADO');
  });

  it('clínica com chip COMERCIAL → usa ele, sem consultar o dono do padrão', async () => {
    const prisma = banco('pra-sorrir', [{ name: 't1-1', purpose: 'COMERCIAL' }]);
    await novo(prisma).sendMessageDirect('m1', 'l1', 'whatsapp', 'oi', null);
    expect(post.mock.calls[0][0]).toBe('http://evo/message/sendText/t1-1');
    expect(prisma.instance.findUnique).not.toHaveBeenCalled();
  });

  it('disparo em massa de outra clínica → BroadcastItem FALHOU + failed_count, zero envio', async () => {
    const prisma = banco('pra-sorrir');
    prisma.broadcastJob = {
      findUnique: jest.fn(async () => ({ id: 'b1', status: 'ATIVO', type: 'COMUNICADO' })),
      update: jest.fn(async () => ({})),
    };
    prisma.broadcastItem = {
      findUnique: jest.fn(async () => ({ id: 'i1', status: 'PENDENTE', event_id: null, lead_id: 'l1' })),
      update: jest.fn(async () => ({})),
      count: jest.fn(async () => 1),
    };
    prisma.conversation = { findFirst: jest.fn(async () => null) };
    await novo(prisma).processBroadcastItem('b1', 'i1', 'Oi {{nome}}');
    expect(post).not.toHaveBeenCalled();
    const falha = prisma.broadcastItem.update.mock.calls.map((c: any) => c[0].data).find((d: any) => d.status);
    expect(falha.status).toBe('FALHOU');
    expect(falha.error).toMatch(/chip próprio/);
    expect(prisma.broadcastJob.update).toHaveBeenCalledWith({ where: { id: 'b1' }, data: { failed_count: { increment: 1 } } });
  });
});

// ─── influenciadores — dispatchOne ──────────────────────────────────────────────
describe('influenciadores: mensagem automática', () => {
  const sch = (tenant_id: string) => ({ id: 's1', tenant_id, template: { body: 'Oi {{nome}}' } });
  const inf = { id: 'i1', name: 'Ana', phone: '(82) 90000-0001' };
  const banco = () => prismaCom(null, { influencerMessageLog: { upsert: jest.fn(async () => ({})) } });

  beforeEach(() => {
    delete process.env.EVOLUTION_INSTANCE_NAME; // produção hoje: env vazia → padrão 'whatsapp'
  });

  it("outra clínica → FAILED no log, sem chamar a Evolution (hoje: FAILED com o 404 do 'whatsapp')", async () => {
    const prisma = banco();
    const svc: any = new InfluencerMessagesCronService(prisma, settings);
    await expect(svc.dispatchOne(sch('pra-sorrir'), inf, new Date('2026-10-20T15:00:00.000Z'))).resolves.toBe('FAILED');
    expect(post).not.toHaveBeenCalled();
    const { create } = prisma.influencerMessageLog.upsert.mock.calls[0][0];
    expect(create).toMatchObject({ tenant_id: 'pra-sorrir', status: 'FAILED', sent_text: 'Oi Ana' });
    expect(create.error_message).toMatch(/chip próprio/);
  });

  it("clínica dona do 'whatsapp' (a mais antiga, chip sem registro) → POST igual a hoje", async () => {
    const svc: any = new InfluencerMessagesCronService(banco(), settings);
    await expect(svc.dispatchOne(sch('instituto'), inf, new Date('2026-10-20T15:00:00.000Z'))).resolves.toBe('SENT');
    expect(post.mock.calls[0][0]).toBe('http://evo/message/sendText/whatsapp');
  });
});

// ─── régua de cobrança — resolveFinanceiroInstance + envio ──────────────────────
describe('régua de cobrança: chip do Financeiro', () => {
  beforeEach(() => {
    delete process.env.EVOLUTION_INSTANCE_NAME; // produção hoje: env vazia → padrão 'whatsapp'
  });

  it('sem FINANCEIRO/CLINICA: outra clínica → null; clínica dona → o padrão; com FINANCEIRO → ele', async () => {
    const prisma = prismaCom('instituto');
    const svc: any = new PaymentAlertsCronService(prisma, settings);
    await expect(svc.resolveFinanceiroInstance('pra-sorrir')).resolves.toBeNull();
    await expect(svc.resolveFinanceiroInstance('instituto')).resolves.toBe('whatsapp');

    const comFin = prismaCom('instituto');
    comFin.instance.findFirst.mockResolvedValueOnce({ name: 'fin1' });
    await expect((new PaymentAlertsCronService(comFin, settings) as any).resolveFinanceiroInstance('pra-sorrir')).resolves.toBe('fin1');
    expect(comFin.instance.findUnique).not.toHaveBeenCalled();
  });

  function montar() {
    const prisma = prismaCom('instituto', {
      auditLog: { create: jest.fn(async () => ({})) },
      dispatchLog: { create: jest.fn(async () => ({})) },
    });
    const svc: any = new PaymentAlertsCronService(prisma, settings);
    jest.spyOn(svc, 'aplicarFreioAoVivo').mockResolvedValue('ok');
    jest.spyOn(svc, 'enrichFromAsaas').mockResolvedValue(undefined);
    jest.spyOn(svc, 'resolveClinicName').mockResolvedValue('Clínica Exemplo');
    jest.spyOn(svc, 'resolveTemplate').mockResolvedValue('Oi {nome}, vence {data} {valor}');
    jest.spyOn(svc, 'resolveIntroTemplate').mockResolvedValue('Oi {nome}, aqui é o Financeiro da {clinica}');
    const registrar = jest.spyOn(svc, 'registerInFinanceiroConversation').mockResolvedValue(undefined);
    return { svc, prisma, registrar };
  }
  const pick = (pdfUrls: string[]) => {
    const membro = {
      chargeId: 'c1', gateway: 'LOCAL', amount: 250, dueDate: new Date('2026-10-21T00:00:00Z'),
      link: 'https://pagar.exemplo.test/c1', codigo: 'PIX-EXEMPLO', pdfUrl: pdfUrls[0], tipo: 'boleto',
    };
    return {
      chargeId: 'c1', gateway: 'LOCAL', patientId: 'pac1', tenantId: 'pra-sorrir', stage: 'boleto_1d_antes',
      phone: TEL, name: 'Maria Exemplo', amount: 250, count: 1, dueDate: membro.dueDate, link: membro.link,
      members: [membro], codigo: 'PIX-EXEMPLO', pdfUrls, tipo: 'boleto',
    };
  };

  it.each([
    ['texto + código PIX', [] as string[]],
    ['boleto em PDF', ['https://asaas.exemplo.test/b/c1.pdf']],
  ])('outra clínica (%s) → a MESMA falha de hoje: marco travado, FAILED, marca-passo anda; nunca cooldown', async (_n, pdfUrls) => {
    const { svc, prisma, registrar } = montar();
    const agora = Date.now();
    await expect(svc.sendPacedCharge(pick(pdfUrls), agora)).resolves.toBe('failed');
    expect(post).not.toHaveBeenCalled();
    // logSent: a trava do marco por boleto (message_id null, como na falha de hoje).
    const audit = prisma.auditLog.create.mock.calls[0][0].data;
    expect(audit).toMatchObject({ entity: 'PAYMENT_ALERT', entity_id: 'pac1', action: 'boleto_1d_antes' });
    expect(audit.meta_json).toMatchObject({ tenant_id: 'pra-sorrir', message_id: null, charge_ids: ['c1'] });
    expect(prisma.dispatchLog.create.mock.calls[0][0].data).toMatchObject({ tenant_id: 'pra-sorrir', status: 'FAILED' });
    expect(svc.lastSentAt).toBe(agora);
    expect(registrar).not.toHaveBeenCalled();
  });

  it('clínica dona do padrão → sai pelo chip, como hoje', async () => {
    const { svc } = montar();
    await expect(svc.sendPacedCharge({ ...pick([]), tenantId: 'instituto' }, Date.now())).resolves.toBe('sent');
    expect(post.mock.calls[0][0]).toBe('http://evo/message/sendText/whatsapp');
  });

  it('apresentação D+1 de outra clínica → não envia; marcada como tentada + FAILED + marca-passo', async () => {
    const { svc, prisma } = montar();
    const agora = Date.now();
    const r = await svc.sendIntro({ planId: 'p1', tenantId: 'pra-sorrir', phone: TEL, name: 'Maria Exemplo' }, agora);
    expect(r).toBe('failed');
    expect(post).not.toHaveBeenCalled();
    expect(prisma.auditLog.create.mock.calls[0][0].data).toMatchObject({ entity: 'BOLETO_INTRO', entity_id: 'p1' });
    expect(prisma.dispatchLog.create.mock.calls[0][0].data).toMatchObject({ type: 'boleto_intro', status: 'FAILED' });
    expect(svc.lastSentAt).toBe(agora);
  });

  it('Evolution sem configuração continua valendo antes do chip: cooldown, não gasta a apresentação', async () => {
    const { svc, prisma } = montar();
    settings.getEvolutionConfig.mockResolvedValueOnce({ apiUrl: '', apiKey: '' });
    const r = await svc.sendIntro({ planId: 'p1', tenantId: 'pra-sorrir', phone: TEL, name: 'Maria Exemplo' }, Date.now());
    expect(r).toBe('cooldown');
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });
});

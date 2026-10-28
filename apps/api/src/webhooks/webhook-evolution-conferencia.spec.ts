/**
 * Avisos da Evolution (HmacGuard) em modo vigia.
 *
 * (a) O que entra e o que é recusado é exatamente o de antes, em todas as combinações
 *     de WEBHOOK_HMAC_REQUIRED, chave do WhatsApp configurada ou não, e assinatura
 *     ausente, válida ou inválida (nos dois cabeçalhos). A referência é a regra
 *     anterior, copiada abaixo em `regraAnterior`.
 * (b) Aviso aceito sem assinatura conferida gera `[WEBHOOK-VIGIA] evolution ...`,
 *     uma linha por chip e motivo a cada 10 min, sem consulta externa nem banco.
 * (c) Pelo HTTP: o que entra chega no EvolutionService; o que é recusado leva 401 e não chega.
 */
import * as crypto from 'crypto';
import { Test } from '@nestjs/testing';
import { INestApplication, Logger, UnauthorizedException } from '@nestjs/common';
import request from 'supertest';
import { HmacGuard } from './guards/hmac.guard';
import { EvolutionController } from './evolution.controller';
import { EvolutionService } from './evolution.service';
import { SettingsService } from '../settings/settings.service';

const CHIP = 't1234abcd-1';
const CHAVE = 'chave-whatsapp-exemplo';
const OUTRA_CHAVE = 'outra-chave-exemplo';

function aviso(extra: Record<string, unknown> = {}) {
  return {
    event: 'messages.upsert',
    instance: CHIP,
    data: {
      key: { id: 'MSG-1', remoteJid: '5582900000000@s.whatsapp.net', fromMe: false },
      message: { conversation: 'Oi, quero marcar' },
    },
    ...extra,
  };
}

function assinar(body: unknown, chave = CHAVE) {
  return crypto.createHmac('sha256', chave).update(JSON.stringify(body)).digest('hex');
}

/** A regra de aceitar/recusar como era antes desta entrega (referência dos testes). */
function regraAnterior(apiKey: string | undefined, envRequired: string | undefined, headers: Record<string, string>, body: unknown): 'aceita' | 401 {
  const hmacRequired = envRequired === 'true';
  if (!apiKey) return hmacRequired ? 401 : 'aceita';
  const signature = headers['x-webhook-signature'] || headers['x-signature'] || '';
  if (!signature) return hmacRequired ? 401 : 'aceita';
  const expected = crypto.createHmac('sha256', apiKey).update(JSON.stringify(body)).digest('hex');
  const a = Buffer.from(String(signature));
  const b = Buffer.from(expected);
  return a.length !== b.length || !crypto.timingSafeEqual(a, b) ? 401 : 'aceita';
}

/** Sem valor padrão de propósito: `undefined` = chave do WhatsApp não configurada. */
function montar(apiKey: string | undefined) {
  const settings = {
    getWhatsAppConfig: jest.fn(async () => ({ apiUrl: 'https://evo.exemplo.test', apiKey, webhookUrl: undefined })),
  };
  const guard = new HmacGuard(settings as any);
  const passa = (body: any, headers: Record<string, string> = {}) =>
    guard.canActivate({ switchToHttp: () => ({ getRequest: () => ({ body, headers }) }) } as any);
  return { guard, settings, passa };
}

let warn: jest.SpyInstance;
let fetchSpy: jest.SpyInstance;
const vigia = () => warn.mock.calls.map((c) => String(c[0])).filter((m) => m.includes('[WEBHOOK-VIGIA]'));

let envAntes: string | undefined;
let agora: number;

beforeEach(() => {
  envAntes = process.env.WEBHOOK_HMAC_REQUIRED;
  delete process.env.WEBHOOK_HMAC_REQUIRED;
  agora = Date.UTC(2026, 9, 28, 12, 0, 0);
  jest.spyOn(Date, 'now').mockImplementation(() => agora);
  warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  fetchSpy = jest.spyOn(globalThis, 'fetch').mockImplementation(async () => {
    throw new Error('o guard não deve consultar nada fora');
  });
});

afterEach(() => {
  if (envAntes === undefined) delete process.env.WEBHOOK_HMAC_REQUIRED;
  else process.env.WEBHOOK_HMAC_REQUIRED = envAntes;
  jest.restoreAllMocks();
});

describe('(a) aceita e recusa como antes, em todas as combinações', () => {
  const body = aviso({ apikey: null });
  const valida = assinar(body);
  const deOutraChave = assinar(body, OUTRA_CHAVE);

  const chaves: Array<[string, string | undefined]> = [
    ['chave configurada', CHAVE],
    ['sem chave (undefined)', undefined],
    ['sem chave (vazia)', ''],
  ];
  const envs: Array<string | undefined> = [undefined, 'true', 'false', 'TRUE', '1'];
  const cabecalhos: Array<[string, Record<string, string>]> = [
    ['sem assinatura', {}],
    ['x-webhook-signature vazio', { 'x-webhook-signature': '' }],
    ['x-webhook-signature válida', { 'x-webhook-signature': valida }],
    ['x-signature válida', { 'x-signature': valida }],
    ['assinatura curta', { 'x-webhook-signature': 'abc' }],
    ['assinatura de outra chave (mesmo tamanho)', { 'x-webhook-signature': deOutraChave }],
    ['x-signature inválida', { 'x-signature': deOutraChave }],
    ['x-webhook-signature válida + x-signature inválida', { 'x-webhook-signature': valida, 'x-signature': 'abc' }],
    ['x-webhook-signature inválida + x-signature válida', { 'x-webhook-signature': 'abc', 'x-signature': valida }],
    ['x-webhook-signature vazio + x-signature válida', { 'x-webhook-signature': '', 'x-signature': valida }],
  ];

  const casos: Array<[string, string | undefined, string | undefined, Record<string, string>]> = [];
  for (const [nomeChave, chave] of chaves) {
    for (const env of envs) {
      for (const [nomeCab, headers] of cabecalhos) {
        casos.push([`${nomeChave}, WEBHOOK_HMAC_REQUIRED=${env ?? '(vazio)'}, ${nomeCab}`, chave, env, headers]);
      }
    }
  }

  it.each(casos)('%s', async (_nome, chave, env, headers) => {
    if (env === undefined) delete process.env.WEBHOOK_HMAC_REQUIRED;
    else process.env.WEBHOOK_HMAC_REQUIRED = env;
    const esperado = regraAnterior(chave, env, headers, body);
    const t = montar(chave);
    const r = t.passa(body, headers);

    if (esperado === 'aceita') {
      await expect(r).resolves.toBe(true);
    } else {
      await expect(r).rejects.toBeInstanceOf(UnauthorizedException);
      await expect(t.passa(body, headers)).rejects.toMatchObject({ status: 401 });
    }

    // Vigia só quando entrou sem assinatura conferida; nunca na recusa nem com assinatura válida.
    const conferida = !!chave && esperado === 'aceita' && !!(headers['x-webhook-signature'] || headers['x-signature']);
    expect(vigia()).toHaveLength(esperado === 'aceita' && !conferida ? 1 : 0);

    // Sem consulta externa e sem banco: só a leitura da configuração que já existia.
    expect(fetchSpy).not.toHaveBeenCalled();
    for (const call of t.settings.getWhatsAppConfig.mock.calls as unknown[][]) expect(call).toEqual([]);
  });

  it('a referência cobre os três desfechos (entra sem assinatura, entra assinado, 401)', () => {
    const desfechos = new Set(casos.map(([, chave, env, headers]) => {
      const r = regraAnterior(chave, env, headers, body);
      if (r === 401) return '401';
      return chave && (headers['x-webhook-signature'] || headers['x-signature']) ? 'assinado' : 'sem-assinatura';
    }));
    expect([...desfechos].sort()).toEqual(['401', 'assinado', 'sem-assinatura']);
  });

  it('apikey no corpo, qualquer que seja, não muda nada (não é conferida)', async () => {
    const t = montar(CHAVE);
    for (const apikey of [undefined, null, '', 'Apikey not found', 'token-qualquer', CHAVE]) {
      await expect(t.passa(aviso({ apikey }))).resolves.toBe(true);
    }
    process.env.WEBHOOK_HMAC_REQUIRED = 'true';
    await expect(t.passa(aviso({ apikey: 'token-qualquer' }))).rejects.toMatchObject({ status: 401 });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('chip desconhecido, nome enorme ou corpo sem chip: entra como antes', async () => {
    const t = montar(CHAVE);
    await expect(t.passa(aviso({ instance: 'chip-que-nao-existe' }))).resolves.toBe(true);
    await expect(t.passa(aviso({ instance: 'x'.repeat(100_000) }))).resolves.toBe(true);
    await expect(t.passa({})).resolves.toBe(true);
    await expect(t.passa({ event: 'connection.update' })).resolves.toBe(true);
  });

  it('o guard só depende da configuração (sem banco e sem WhatsappService)', () => {
    expect(HmacGuard.length).toBe(1);
  });
});

describe('(b) log de vigia', () => {
  it('sem assinatura: aparece com chip, evento e motivo', async () => {
    const t = montar(CHAVE);
    await t.passa(aviso());
    expect(vigia()).toEqual([
      `[WEBHOOK-VIGIA] evolution: aviso aceito sem assinatura (chip ${CHIP}, evento messages.upsert)`,
    ]);
  });

  it('sem chave configurada: aparece com o motivo próprio', async () => {
    const t = montar(undefined);
    await t.passa(aviso(), { 'x-webhook-signature': 'abc' });
    expect(vigia()).toHaveLength(1);
    expect(vigia()[0]).toContain('sem chave configurada para conferir a assinatura');
  });

  it('uma linha por chip a cada 10 min, com a contagem do intervalo', async () => {
    const t = montar(CHAVE);
    for (let i = 0; i < 5; i++) await t.passa(aviso());
    await t.passa(aviso({ instance: 'outro-chip-1' }));
    expect(vigia()).toHaveLength(2);
    agora += 10 * 60_000;
    await t.passa(aviso({ event: 'messages.update' }));
    expect(vigia()).toHaveLength(3);
    expect(vigia()[2]).toContain(`chip ${CHIP}, evento messages.update`);
    expect(vigia()[2]).toContain('(+4 iguais nos últimos 10 min)');
  });

  it('nome de chip com quebra de linha ou enorme sai curto e numa linha só', async () => {
    const t = montar(CHAVE);
    await t.passa(aviso({ instance: 'chip\n[HMAC] falso' }));
    await t.passa(aviso({ instance: 'y'.repeat(5_000) }));
    const [a, b] = vigia();
    expect(a).not.toContain('\n');
    expect(a).toContain('chip chip__HMAC__falso');
    expect(b.length).toBeLessThan(200);
  });

  it('muitos chips inventados: o número de linhas e a memória ficam limitados', async () => {
    const t = montar(CHAVE);
    for (let i = 0; i < 2_000; i++) await t.passa(aviso({ instance: `inventado-${i}` }));
    expect(vigia().length).toBeLessThanOrEqual(201);
    expect(vigia().some((m) => m.includes('outros chips'))).toBe(true);
    expect(((t.guard as any).vigia as Map<string, unknown>).size).toBeLessThanOrEqual(201);
    // Passado o intervalo, chips novos voltam a ter linha própria.
    agora += 10 * 60_000;
    await t.passa(aviso({ instance: 'chip-novo' }));
    const linhas = vigia();
    expect(linhas[linhas.length - 1]).toContain('chip chip-novo');
  });

  it('falha no log nunca muda o desfecho', async () => {
    warn.mockImplementation(() => {
      throw new Error('log fora');
    });
    const t = montar(CHAVE);
    await expect(t.passa(aviso())).resolves.toBe(true);
    await expect(montar(undefined).passa(aviso())).resolves.toBe(true);
  });

  it('assinatura válida e recusas não geram vigia', async () => {
    const t = montar(CHAVE);
    const body = aviso();
    await t.passa(body, { 'x-webhook-signature': assinar(body) });
    await expect(t.passa(body, { 'x-webhook-signature': 'abc' })).rejects.toBeInstanceOf(UnauthorizedException);
    process.env.WEBHOOK_HMAC_REQUIRED = 'true';
    await expect(t.passa(body)).rejects.toBeInstanceOf(UnauthorizedException);
    expect(vigia()).toHaveLength(0);
  });
});

describe('(c) pelo controller', () => {
  let app: INestApplication;
  let evo: { handleMessagesUpsert: jest.Mock; handleMessagesUpdate: jest.Mock };

  async function subir(apiKey: string | undefined) {
    evo = { handleMessagesUpsert: jest.fn(async () => undefined), handleMessagesUpdate: jest.fn(async () => undefined) };
    const mod = await Test.createTestingModule({
      controllers: [EvolutionController],
      providers: [
        HmacGuard,
        { provide: EvolutionService, useValue: evo },
        { provide: SettingsService, useValue: montar(apiKey).settings },
      ],
    }).compile();
    app = mod.createNestApplication({ logger: false });
    await app.init();
  }

  afterEach(async () => {
    await app?.close();
  });

  it('aviso de hoje (sem assinatura) → 200, processado e com vigia', async () => {
    await subir(CHAVE);
    const res = await request(app.getHttpServer()).post('/webhooks/evolution').send(aviso());
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ received: true });
    expect(evo.handleMessagesUpsert).toHaveBeenCalledTimes(1);
    expect(vigia()).toHaveLength(1);
  });

  it('sem chave configurada → 200 e processado', async () => {
    await subir(undefined);
    const res = await request(app.getHttpServer()).post('/webhooks/evolution').send(aviso({ event: 'messages.update' }));
    expect(res.status).toBe(200);
    expect(evo.handleMessagesUpdate).toHaveBeenCalledTimes(1);
  });

  it('assinatura válida → 200 e processado, sem vigia', async () => {
    await subir(CHAVE);
    const body = aviso();
    const res = await request(app.getHttpServer())
      .post('/webhooks/evolution')
      .set('x-signature', assinar(body))
      .send(body);
    expect(res.status).toBe(200);
    expect(evo.handleMessagesUpsert).toHaveBeenCalledTimes(1);
    expect(vigia()).toHaveLength(0);
  });

  it('assinatura inválida → 401 e não processado', async () => {
    await subir(CHAVE);
    const res = await request(app.getHttpServer())
      .post('/webhooks/evolution')
      .set('x-webhook-signature', assinar(aviso(), OUTRA_CHAVE))
      .send(aviso());
    expect(res.status).toBe(401);
    expect(evo.handleMessagesUpsert).not.toHaveBeenCalled();
  });

  it('WEBHOOK_HMAC_REQUIRED=true sem assinatura → 401 e não processado', async () => {
    process.env.WEBHOOK_HMAC_REQUIRED = 'true';
    await subir(CHAVE);
    const res = await request(app.getHttpServer()).post('/webhooks/evolution').send(aviso());
    expect(res.status).toBe(401);
    expect(evo.handleMessagesUpsert).not.toHaveBeenCalled();
  });
});

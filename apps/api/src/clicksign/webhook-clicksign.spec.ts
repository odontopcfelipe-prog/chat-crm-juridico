/**
 * Webhook da ClickSign (POST /webhooks/clicksign) — o aviso é conferido antes de
 * qualquer efeito.
 *
 * - Segredo do webhook configurado: a assinatura HMAC é exigida (Content-Hmac
 *   `sha256=<hex>`, como a ClickSign manda, ou o cabeçalho x-clicksign-hmac-sha256).
 *   Ausente ou diferente → 401 e nada aplicado, sem consultar a API.
 * - Sem segredo: o documento é lido na API da ClickSign com o token já configurado
 *   e precisa estar no estado do aviso ('closed' na assinatura concluída,
 *   'running' no erro de biometria). A conferência sempre responde 200.
 *   1. A API respondeu com o status: no estado do aviso → aplica. Fechamento que
 *      a API ainda mostra 'running' → nada na hora; novas leituras no próprio
 *      processo (30 s, 2 min, 10 min) aplicam pelo mesmo caminho quando a API
 *      mostrar 'closed'; se todas seguirem 'running', nada é alterado e fica o
 *      `[WEBHOOK-VIGIA]` "fechamento ainda aberto na API". Outro estado → nenhum
 *      efeito (no erro de biometria, o atendente ainda recebe o alerta).
 *   2. Falha passageira na leitura (429, 5xx, rede, tempo esgotado) nas 2
 *      tentativas → aceita como antes, com `[WEBHOOK-VIGIA]`: um fechamento real
 *      não se perde enquanto a ClickSign oscila.
 *   3. Leitura indisponível (sem token da API, 401/404) → também como antes, com
 *      `[WEBHOOK-VIGIA]`.
 *   2 e 3 valem também para as leituras agendadas. Nenhuma variável do servidor
 *   (como uma CLICKSIGN_WEBHOOK_RIGIDO esquecida) segura o aviso.
 * - Erro de biometria: o tutorial no WhatsApp sai no máximo 1 vez por documento a
 *   cada 10 min (marca no próprio registro do documento). O primeiro aviso é igual
 *   ao de antes; os repetidos dentro da janela mantêm o status e avisam o atendente.
 *
 * Os dois sistemas de contrato que chegam por aqui: o legado (ContractSignature,
 * TCLE do plano) e o Contract da proposta.
 */
import * as crypto from 'crypto';
import * as express from 'express';
import { INestApplication, UnauthorizedException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { ClicksignService } from './clicksign.service';
import { ClicksignWebhookController } from './clicksign.controller';

// ─── Dados de exemplo (repositório público: nada real) ───────────────────────

const SEGREDO = 'segredo-webhook-exemplo';
const TOKEN_API = 'token-api-exemplo';
const BASE = 'https://app.clicksign.com';
const DOC_LEGADO = '0b0e0c00-0000-4000-8000-0000000000a1';
const DOC_CONTRATO = '0b0e0c00-0000-4000-8000-0000000000b2';
const DOC_DESCONHECIDO = '0b0e0c00-0000-4000-8000-0000000000c3';

const SEG = 1000;
const MIN = 60 * SEG;
const HORA = 60 * MIN;

const fechado = (key: string, name = 'auto_close') => ({
  event: { name, data: {}, occurred_at: '2026-10-20T13:00:00-03:00' },
  document: { key, status: 'closed' },
});
const biometria = (key: string) => ({
  event: { name: 'facematch_refused', data: {}, occurred_at: '2026-10-20T13:00:00-03:00' },
  document: { key, status: 'running' },
});
const assinaturaParcial = (key: string) => ({
  event: { name: 'sign', data: {}, occurred_at: '2026-10-20T13:00:00-03:00' },
  document: { key, status: 'running' },
});

const hmac = (raw: string, segredo = SEGREDO) =>
  crypto.createHmac('sha256', segredo).update(raw).digest('hex');

// ─── Respostas da API da ClickSign ───────────────────────────────────────────

type Resposta = () => any;
const resposta = (status: number, body: any = {}) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});
const documento = (key: string, status: string): Resposta => () =>
  resposta(200, { document: { key, status, downloads: {} } });
const http = (status: number): Resposta => () => resposta(status, { errors: ['exemplo'] });
const semRede: Resposta = () => {
  throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } });
};
const tempoEsgotado: Resposta = () => {
  throw Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
};

// ─── Montagem ────────────────────────────────────────────────────────────────

interface Estado {
  assinatura?: any;
  contrato?: any;
}

function montar(o: { webhookToken?: string; apiToken?: string; api?: Resposta[]; estado?: Estado } = {}) {
  const estado: Estado = o.estado ?? {
    assinatura: {
      id: 'assinatura-1',
      cs_document_key: DOC_LEGADO,
      conversation_id: 'conversa-1',
      status: 'PENDENTE',
      signing_url: `${BASE}/sign/pedido-1`,
      updated_at: new Date('2026-10-20T12:00:00Z'),
    },
    contrato: { id: 'contrato-1', clicksign_document_id: DOC_CONTRATO, status: 'SENT', patient_signed_at: null },
  };
  const conversa = {
    id: 'conversa-1',
    instance_name: 'chip-clinica',
    assigned_user_id: 'usuario-1',
    lead: { id: 'lead-1', name: 'Maria Exemplo', phone: '5582900000000' },
  };
  const plano = {
    id: 'plano-1',
    status: 'PENDING_SIGNATURE',
    start_date: null,
    contract_signature_id: 'assinatura-1',
    patient: { lead_id: 'lead-1', tenant_id: 'conta-1' },
  };

  const efeitos: any[] = [];
  const grava = (nome: string) => jest.fn(async (args: any) => { efeitos.push([nome, args]); return {}; });
  const prisma: any = {
    contract: {
      findFirst: jest.fn(async ({ where }: any) =>
        estado.contrato && where.clicksign_document_id === estado.contrato.clicksign_document_id ? estado.contrato : null),
      findUnique: jest.fn(async ({ where }: any) =>
        estado.contrato && where.id === estado.contrato.id
          ? { ...estado.contrato, quote: { patient: { tenant_id: 'conta-1' } } }
          : null),
      // Como o banco: o que foi gravado vale para a próxima leitura.
      update: jest.fn(async (args: any) => {
        efeitos.push(['contract.update', args]);
        Object.assign(estado.contrato, { status: args.data.status });
        return {};
      }),
    },
    contractSignature: {
      findUnique: jest.fn(async ({ where, include }: any) => {
        const a = estado.assinatura;
        if (!a || where.cs_document_key !== a.cs_document_key) return null;
        return include?.conversation ? { ...a, conversation: conversa } : a;
      }),
      update: jest.fn(async (args: any) => {
        efeitos.push(['contractSignature.update', args]);
        Object.assign(estado.assinatura, { status: args.data.status });
        return {};
      }),
      // Como o banco: só altera (e conta) quando o registro casa com o filtro.
      updateMany: jest.fn(async ({ where, data }: any) => {
        const a = estado.assinatura;
        const casa = (c: any): boolean =>
          (c.id === undefined || c.id === a.id) &&
          (c.status?.not === undefined || a.status !== c.status.not) &&
          (c.updated_at === undefined ||
            (c.updated_at instanceof Date
              ? a.updated_at?.getTime() === c.updated_at.getTime()
              : a.updated_at?.getTime() < c.updated_at.lt.getTime())) &&
          (c.OR === undefined || c.OR.some(casa));
        if (!a || !casa(where)) return { count: 0 };
        Object.assign(a, data);
        efeitos.push(['contractSignature.updateMany', { where, data }]);
        return { count: 1 };
      }),
    },
    conversation: {
      findUnique: jest.fn(async ({ where }: any) => (where.id === conversa.id ? conversa : null)),
    },
    treatmentPlan: {
      findUnique: jest.fn(async ({ where }: any) => (where.contract_signature_id === plano.contract_signature_id ? plano : null)),
      update: grava('treatmentPlan.update'),
    },
  };
  const s3 = { uploadBuffer: grava('s3.uploadBuffer') };
  const whatsapp = { sendText: grava('whatsapp.sendText'), sendMedia: jest.fn(async (...a: any[]) => { efeitos.push(['whatsapp.sendMedia', a]); }) };
  const chatGateway = {
    server: { to: (sala: string) => ({ emit: (ev: string, p: any) => { efeitos.push(['socket', sala, ev, p]); } }) },
  };

  const antes = process.env.PUBLIC_API_URL;
  process.env.PUBLIC_API_URL = 'https://api.exemplo.test';
  const svc = new ClicksignService(prisma, s3 as any, whatsapp as any, chatGateway as any, {} as any, {} as any);
  if (antes === undefined) delete process.env.PUBLIC_API_URL; else process.env.PUBLIC_API_URL = antes;

  jest.spyOn(svc as any, 'getCfg').mockResolvedValue({
    baseUrl: BASE,
    token: o.apiToken ?? TOKEN_API,
    webhookToken: o.webhookToken ?? '',
  });
  jest.spyOn(svc as any, 'downloadSignedPdfFromClicksign').mockResolvedValue(Buffer.from('%PDF-exemplo'));
  jest.spyOn(svc as any, 'movleadToContractSigned').mockImplementation(async (leadId: any) => {
    efeitos.push(['lead.contrato-assinado', leadId]);
  });
  (svc as any).esperar = jest.fn(async () => {});

  const logs: string[] = [];
  for (const nivel of ['log', 'warn', 'debug', 'error'] as const) {
    jest.spyOn((svc as any).logger, nivel).mockImplementation((m: any) => { logs.push(`${nivel}: ${m}`); });
  }

  const fila = [...(o.api ?? [])];
  const urls: string[] = [];
  (global as any).fetch = jest.fn(async (url: string) => {
    urls.push(url);
    const prox = fila.shift();
    if (!prox) throw new Error('consulta à API não esperada neste caso');
    return prox();
  });

  const ctl = new ClicksignWebhookController(svc);
  jest.spyOn((ctl as any).logger, 'warn').mockImplementation((m: any) => { logs.push(`warn: ${m}`); });

  /** Entrega o aviso como o express entrega: corpo cru + cabeçalhos. */
  const enviar = (payload: any, cab: { contentHmac?: string; antigo?: string } = {}) =>
    ctl.handleWebhook(payload, cab.contentHmac as any, cab.antigo as any, { rawBody: JSON.stringify(payload) });

  /** Efeitos sem as datas (new Date() de cada execução). */
  const efeitosSemData = () =>
    JSON.parse(JSON.stringify(efeitos, (_k, v) =>
      typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(v) ? 'DATA' : v));

  return { svc, ctl, enviar, efeitos, efeitosSemData, logs, urls, whatsapp, estado, prisma };
}

const erro = (p: Promise<any>) => p.then(() => null, (e) => e);
const urlDoc = (key: string) => `${BASE}/api/v1/documents/${key}?access_token=${TOKEN_API}`;
const vigia = (m: ReturnType<typeof montar>) => m.logs.filter((l) => l.includes('[WEBHOOK-VIGIA]'));

/**
 * Avança o relógio falso e deixa terminar a releitura que ele disparou (os mocks
 * só encadeiam promessas: tudo acaba antes do próximo setImmediate, que é real).
 */
async function passar(ms: number) {
  jest.advanceTimersByTime(ms);
  await new Promise<void>((r) => setImmediate(r));
}

const fetchOriginal = (global as any).fetch;
beforeEach(() => {
  // Releituras agendadas e a janela do tutorial correm no relógio falso.
  jest.useFakeTimers({ doNotFake: ['nextTick', 'queueMicrotask', 'setImmediate'] });
});
afterEach(() => {
  jest.useRealTimers(); // descarta releituras que o caso deixou pendentes
  (global as any).fetch = fetchOriginal;
  delete process.env.CLICKSIGN_WEBHOOK_RIGIDO;
  jest.restoreAllMocks();
});

// ─── (a) Aviso de hoje: mesmo efeito ─────────────────────────────────────────

describe('ClickSign — aviso de hoje segue com o mesmo efeito', () => {
  it('com segredo: Content-Hmac (sha256=...) ou o cabeçalho antigo válido aplica a assinatura, sem consultar a API', async () => {
    const p = fechado(DOC_LEGADO);
    const raw = JSON.stringify(p);

    const novo = montar({ webhookToken: SEGREDO });
    expect(await novo.enviar(p, { contentHmac: `sha256=${hmac(raw)}` })).toEqual({ ok: true });
    expect(novo.urls).toEqual([]);

    const antigo = montar({ webhookToken: SEGREDO });
    expect(await antigo.enviar(p, { antigo: hmac(raw) })).toEqual({ ok: true });
    expect(antigo.urls).toEqual([]);
    expect(antigo.efeitosSemData()).toEqual(novo.efeitosSemData());

    const nomes = novo.efeitos.map((e) => e[0]);
    expect(nomes).toEqual([
      's3.uploadBuffer', 'contractSignature.update', 'treatmentPlan.update',
      'lead.contrato-assinado', 'whatsapp.sendMedia', 'socket', 'socket',
    ]);
    expect(novo.efeitos[1][1]).toMatchObject({
      where: { id: 'assinatura-1' },
      data: { status: 'ASSINADO', signed_s3_key: 'contracts-signed/assinatura-1.pdf' },
    });
    expect(novo.efeitos[2][1]).toMatchObject({ where: { id: 'plano-1' }, data: { status: 'ACTIVE' } });
    expect(novo.efeitos[4][1]).toEqual([
      '5582900000000', 'document', 'https://api.exemplo.test/contracts/clicksign/signed-pdf/assinatura-1',
      '📄 Contrato assinado — Maria Exemplo', 'chip-clinica',
    ]);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('sem segredo: documento fechado na ClickSign → o mesmo efeito do aviso assinado', async () => {
    const p = fechado(DOC_LEGADO);
    const assinado = montar({ webhookToken: SEGREDO });
    await assinado.enviar(p, { contentHmac: `sha256=${hmac(JSON.stringify(p))}` });

    const conferido = montar({ api: [documento(DOC_LEGADO, 'closed')] });
    expect(await conferido.enviar(p)).toEqual({ ok: true });
    expect(conferido.urls).toEqual([urlDoc(DOC_LEGADO)]);
    expect(conferido.efeitosSemData()).toEqual(assinado.efeitosSemData());
    expect(conferido.logs.some((l) => l.includes('Aviso conferido na ClickSign'))).toBe(true);
    expect(vigia(conferido)).toEqual([]);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('contrato da proposta: com segredo ou conferido na ClickSign → SIGNED igual', async () => {
    const p = fechado(DOC_CONTRATO, 'document_closed');
    const assinado = montar({ webhookToken: SEGREDO });
    await assinado.enviar(p, { contentHmac: `sha256=${hmac(JSON.stringify(p))}` });
    expect(assinado.efeitos.map((e) => e[0])).toEqual(['s3.uploadBuffer', 'contract.update']);
    expect(assinado.efeitos[1][1]).toMatchObject({
      where: { id: 'contrato-1' },
      data: { status: 'SIGNED', pdf_url: 'contracts-signed/quote-contrato-1.pdf' },
    });

    const conferido = montar({ api: [documento(DOC_CONTRATO, 'closed')] });
    await conferido.enviar(p);
    expect(conferido.urls).toEqual([urlDoc(DOC_CONTRATO)]);
    expect(conferido.efeitosSemData()).toEqual(assinado.efeitosSemData());
  });

  it('erro de biometria: documento aberto na ClickSign → ERRO_BIOMETRIA e tutorial, igual ao aviso assinado', async () => {
    const p = biometria(DOC_LEGADO);
    const assinado = montar({ webhookToken: SEGREDO });
    await assinado.enviar(p, { contentHmac: `sha256=${hmac(JSON.stringify(p))}` });
    expect(assinado.efeitos.map((e) => e[0])).toEqual(['contractSignature.updateMany', 'whatsapp.sendText', 'socket']);
    expect(assinado.efeitos[0][1]).toMatchObject({ where: { id: 'assinatura-1' }, data: { status: 'ERRO_BIOMETRIA' } });
    expect(assinado.estado.assinatura.status).toBe('ERRO_BIOMETRIA');
    expect(assinado.whatsapp.sendText.mock.calls).toEqual([
      ['5582900000000', expect.stringContaining(`${BASE}/sign/pedido-1`), 'chip-clinica'],
    ]);

    const conferido = montar({ api: [documento(DOC_LEGADO, 'running')] });
    await conferido.enviar(p);
    expect(conferido.urls).toEqual([urlDoc(DOC_LEGADO)]);
    expect(conferido.efeitosSemData()).toEqual(assinado.efeitosSemData());
    expect(jest.getTimerCount()).toBe(0);
  });

  it('avisos que já não tinham efeito (assinatura parcial, documento desconhecido, já assinado): 200, sem consulta e nada alterado', async () => {
    const parcial = montar();
    expect(await parcial.enviar(assinaturaParcial(DOC_LEGADO))).toEqual({ ok: true });

    const desconhecido = montar();
    expect(await desconhecido.enviar(fechado(DOC_DESCONHECIDO))).toEqual({ ok: true });
    expect(await desconhecido.enviar(biometria(DOC_DESCONHECIDO))).toEqual({ ok: true });

    const jaAssinado = montar({
      estado: {
        assinatura: { id: 'assinatura-1', cs_document_key: DOC_LEGADO, conversation_id: 'conversa-1', status: 'ASSINADO' },
        contrato: { id: 'contrato-1', clicksign_document_id: DOC_CONTRATO, status: 'SIGNED' },
      },
    });
    expect(await jaAssinado.enviar(fechado(DOC_LEGADO))).toEqual({ ok: true });
    expect(await jaAssinado.enviar(fechado(DOC_CONTRATO))).toEqual({ ok: true });

    for (const m of [parcial, desconhecido, jaAssinado]) {
      expect(m.urls).toEqual([]);
      expect(m.efeitos).toEqual([]);
    }
    expect(jest.getTimerCount()).toBe(0);
  });
});

// ─── (b) Aviso que não confere: nada aplicado, sem reenvio em loop ───────────

describe('ClickSign — aviso que não confere não altera nada', () => {
  it('sem segredo: fechamento com o documento cancelado na ClickSign → 200 e nada alterado, sem releitura', async () => {
    const cancelado = montar({ api: [documento(DOC_CONTRATO, 'canceled')] });
    expect(await cancelado.enviar(fechado(DOC_CONTRATO))).toEqual({ ok: true });
    expect(cancelado.urls).toEqual([urlDoc(DOC_CONTRATO)]);
    expect(cancelado.efeitos).toEqual([]);
    expect(cancelado.logs.some((l) => l.includes('Aviso não conferido na ClickSign') && l.includes("'canceled'"))).toBe(true);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('sem segredo: erro de biometria com o documento já fechado ou cancelado → só o alerta ao atendente, sem mensagem ao paciente nem mudar o status', async () => {
    for (const status of ['closed', 'canceled']) {
      const m = montar({ api: [documento(DOC_LEGADO, status)] });
      expect(await m.enviar(biometria(DOC_LEGADO))).toEqual({ ok: true });
      expect(m.efeitos).toEqual([
        ['socket', 'conversa-1', 'contract:biometric_error', {
          conversationId: 'conversa-1', leadName: 'Maria Exemplo', eventName: 'facematch_refused', errorType: 'biometria facial',
        }],
      ]);
      expect(m.whatsapp.sendText).not.toHaveBeenCalled();
      expect(m.estado.assinatura.status).toBe('PENDENTE');
      expect(m.logs.some((l) => l.includes("fora de 'running'") && l.includes('atendente avisado'))).toBe(true);
      expect(jest.getTimerCount()).toBe(0);
    }
  });

  it('com segredo: assinatura ausente, diferente ou de outro segredo → 401, sem consulta e nada alterado', async () => {
    const p = fechado(DOC_LEGADO);
    const raw = JSON.stringify(p);
    const casos: Array<{ contentHmac?: string; antigo?: string }> = [
      {},
      { contentHmac: '' },
      { contentHmac: 'sha256=' + '0'.repeat(64) },
      { contentHmac: `sha256=${hmac(raw, 'outro-segredo')}` },
      { antigo: hmac(raw + ' ') },
      { contentHmac: hmac(raw).slice(0, 10) },
    ];
    for (const cab of casos) {
      const m = montar({ webhookToken: SEGREDO, api: [documento(DOC_LEGADO, 'closed')] });
      expect(await erro(m.enviar(p, cab))).toBeInstanceOf(UnauthorizedException);
      expect(m.urls).toEqual([]);
      expect(m.efeitos).toEqual([]);
    }
  });
});

// ─── (c) Fechamento que a API ainda mostra aberto: releituras no processo ────

describe('ClickSign — fechamento que a API ainda mostra aberto: releituras em 30 s, 2 min e 10 min', () => {
  it('responde 200 na hora, sem efeito; a releitura de 30 s lê fechado e aplica uma vez, pelo mesmo caminho', async () => {
    const referencia = montar({ api: [documento(DOC_LEGADO, 'closed')] });
    await referencia.enviar(fechado(DOC_LEGADO));

    const m = montar({ api: [documento(DOC_LEGADO, 'running'), documento(DOC_LEGADO, 'closed')] });
    expect(await m.enviar(fechado(DOC_LEGADO))).toEqual({ ok: true });
    expect(m.efeitos).toEqual([]);
    expect(m.urls).toEqual([urlDoc(DOC_LEGADO)]);
    expect(jest.getTimerCount()).toBe(1);

    await passar(29 * SEG);
    expect(m.urls).toHaveLength(1);
    await passar(1 * SEG);
    expect(m.urls).toEqual([urlDoc(DOC_LEGADO), urlDoc(DOC_LEGADO)]);
    expect(m.efeitosSemData()).toEqual(referencia.efeitosSemData());
    expect(m.estado.assinatura.status).toBe('ASSINADO');
    expect(vigia(m)).toEqual([]);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('contrato da proposta: aberto, aberto em 30 s e fechado em 2 min → SIGNED uma vez', async () => {
    const m = montar({
      api: [documento(DOC_CONTRATO, 'running'), documento(DOC_CONTRATO, 'running'), documento(DOC_CONTRATO, 'closed')],
    });
    await m.enviar(fechado(DOC_CONTRATO));
    await passar(30 * SEG);
    expect(m.efeitos).toEqual([]);
    expect(jest.getTimerCount()).toBe(1);

    await passar(2 * MIN);
    expect(m.urls).toHaveLength(3);
    expect(m.efeitos.map((e) => e[0])).toEqual(['s3.uploadBuffer', 'contract.update']);
    expect(m.efeitos[1][1]).toMatchObject({ where: { id: 'contrato-1' }, data: { status: 'SIGNED' } });
    expect(jest.getTimerCount()).toBe(0);
  });

  it('fechado só na última releitura (10 min) → aplica', async () => {
    const aberto = documento(DOC_LEGADO, 'running');
    const m = montar({ api: [aberto, aberto, aberto, documento(DOC_LEGADO, 'closed')] });
    await m.enviar(fechado(DOC_LEGADO));
    await passar(30 * SEG);
    await passar(2 * MIN);
    expect(m.efeitos).toEqual([]);
    await passar(10 * MIN);
    expect(m.urls).toHaveLength(4);
    expect(m.efeitos.filter((e) => e[0] === 'contractSignature.update')).toHaveLength(1);
    expect(m.estado.assinatura.status).toBe('ASSINADO');
  });

  it('aberto em todas as releituras → nada alterado e um [WEBHOOK-VIGIA] "fechamento ainda aberto na API — nada alterado"', async () => {
    const aberto = documento(DOC_LEGADO, 'running');
    const m = montar({ api: [aberto, aberto, aberto, aberto] });
    expect(await m.enviar(fechado(DOC_LEGADO))).toEqual({ ok: true });
    await passar(30 * SEG);
    await passar(2 * MIN);
    expect(vigia(m)).toEqual([]);
    await passar(10 * MIN);

    expect(m.urls).toHaveLength(4);
    expect(m.efeitos).toEqual([]);
    expect(m.estado.assinatura.status).toBe('PENDENTE');
    expect(vigia(m)).toHaveLength(1);
    expect(vigia(m)[0]).toMatch(/^warn: \[WEBHOOK-VIGIA\] ClickSign: fechamento ainda aberto na API — nada alterado/);
    expect(vigia(m)[0]).toContain(DOC_LEGADO);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('releitura com falha passageira (503, rede, tempo esgotado) → aplica como hoje, com [WEBHOOK-VIGIA]', async () => {
    const referencia = montar({ api: [documento(DOC_LEGADO, 'closed')] });
    await referencia.enviar(fechado(DOC_LEGADO));

    for (const falhas of [[http(503), http(503)], [semRede, tempoEsgotado]]) {
      const m = montar({ api: [documento(DOC_LEGADO, 'running'), ...falhas] });
      await m.enviar(fechado(DOC_LEGADO));
      expect(m.efeitos).toEqual([]);
      await passar(30 * SEG);
      expect(m.urls).toHaveLength(3);
      expect(m.efeitosSemData()).toEqual(referencia.efeitosSemData());
      expect(vigia(m)).toHaveLength(1);
      expect(vigia(m)[0]).toContain('falha passageira na leitura');
      expect(vigia(m)[0]).toContain('aplicado como antes');
      expect(jest.getTimerCount()).toBe(0);
    }

    const contrato = montar({ api: [documento(DOC_CONTRATO, 'running'), http(502), http(502)] });
    await contrato.enviar(fechado(DOC_CONTRATO));
    await passar(30 * SEG);
    expect(contrato.efeitos.map((e) => e[0])).toEqual(['s3.uploadBuffer', 'contract.update']);
  });

  it('releitura sem acesso à API (404) → aplica como hoje, com [WEBHOOK-VIGIA] de leitura indisponível', async () => {
    const m = montar({ api: [documento(DOC_LEGADO, 'running'), documento(DOC_LEGADO, 'running'), http(404)] });
    await m.enviar(fechado(DOC_LEGADO));
    await passar(30 * SEG);
    await passar(2 * MIN);
    expect(m.efeitos.filter((e) => e[0] === 'contractSignature.update')).toHaveLength(1);
    expect(vigia(m)).toHaveLength(1);
    expect(vigia(m)[0]).toContain('leitura indisponível');
  });

  it('outro aviso aplicou enquanto a releitura esperava → a releitura não aplica de novo nem consulta a API', async () => {
    const m = montar({ api: [documento(DOC_LEGADO, 'running'), documento(DOC_LEGADO, 'closed')] });
    await m.enviar(fechado(DOC_LEGADO, 'auto_close'));
    await m.enviar(fechado(DOC_LEGADO, 'document_closed'));
    expect(m.efeitos.filter((e) => e[0] === 'contractSignature.update')).toHaveLength(1);

    const antes = m.efeitos.length;
    await passar(30 * SEG);
    expect(m.urls).toHaveLength(2);
    expect(m.efeitos).toHaveLength(antes);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('aviso repetido enquanto a releitura espera não abre outra fila: aplica uma vez só', async () => {
    const m = montar({
      api: [documento(DOC_LEGADO, 'running'), documento(DOC_LEGADO, 'running'), documento(DOC_LEGADO, 'closed')],
    });
    await m.enviar(fechado(DOC_LEGADO, 'auto_close'));
    await m.enviar(fechado(DOC_LEGADO, 'document_closed'));
    expect(jest.getTimerCount()).toBe(1);

    await passar(30 * SEG);
    expect(m.urls).toHaveLength(3);
    expect(m.efeitos.filter((e) => e[0] === 'contractSignature.update')).toHaveLength(1);
    expect(m.efeitos.filter((e) => e[0] === 'whatsapp.sendMedia')).toHaveLength(1);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('erro ao aplicar na releitura não lança: fica no log [WEBHOOK-VIGIA]', async () => {
    const m = montar({ api: [documento(DOC_LEGADO, 'running'), documento(DOC_LEGADO, 'closed')] });
    await m.enviar(fechado(DOC_LEGADO));
    m.prisma.contractSignature.update.mockImplementationOnce(async () => { throw new Error('banco fora do ar'); });

    await passar(30 * SEG);
    expect(vigia(m)).toHaveLength(1);
    expect(vigia(m)[0]).toContain('erro ao aplicar o fechamento na releitura (banco fora do ar)');
    expect(jest.getTimerCount()).toBe(0);
  });
});

// ─── (d) Leitura impossível ──────────────────────────────────────────────────

describe('ClickSign — quando não dá para conferir', () => {
  // Regra: com a ClickSign oscilando, um fechamento real não pode se perder. Por
  // isso a falha passageira nas 2 tentativas aplica como antes e deixa o rastro.
  it('falha passageira (500, 503, 429, rede, tempo) nas 2 tentativas: aceita como hoje, com [WEBHOOK-VIGIA]', async () => {
    const referencia = montar({ api: [documento(DOC_LEGADO, 'closed')] });
    await referencia.enviar(fechado(DOC_LEGADO));
    const referenciaContrato = montar({ api: [documento(DOC_CONTRATO, 'closed')] });
    await referenciaContrato.enviar(fechado(DOC_CONTRATO));

    for (const falha of [http(500), http(503), http(429), semRede, tempoEsgotado]) {
      const m = montar({ api: [falha, falha] });
      expect(await m.enviar(fechado(DOC_LEGADO))).toEqual({ ok: true });
      expect(m.urls).toHaveLength(2);
      expect(m.efeitosSemData()).toEqual(referencia.efeitosSemData());
      expect(m.logs.some((l) =>
        l.startsWith('warn: [WEBHOOK-VIGIA] ClickSign: aviso aceito sem conferência') &&
        l.includes('falha passageira na leitura') && l.includes('aplicado como antes'))).toBe(true);

      const c = montar({ api: [falha, falha] });
      expect(await c.enviar(fechado(DOC_CONTRATO))).toEqual({ ok: true });
      expect(c.efeitosSemData()).toEqual(referenciaContrato.efeitosSemData());
      expect(c.logs.some((l) => l.includes('[WEBHOOK-VIGIA]') && l.includes('falha passageira na leitura'))).toBe(true);
    }
  });

  it('falha passageira e leitura boa na segunda tentativa: conferido, sem vigia', async () => {
    const m = montar({ api: [http(502), documento(DOC_LEGADO, 'closed')] });
    await m.enviar(fechado(DOC_LEGADO));
    expect(m.urls).toHaveLength(2);
    expect(m.efeitos.some((e) => e[0] === 'contractSignature.update')).toBe(true);
    expect(vigia(m)).toEqual([]);
  });

  it('sem token da API, documento fora da conta (404) ou token recusado (401): aceita como hoje, com [WEBHOOK-VIGIA]', async () => {
    const semToken = montar({ apiToken: '' });
    await semToken.enviar(fechado(DOC_LEGADO));
    expect(semToken.urls).toEqual([]);
    expect(semToken.efeitos.some((e) => e[0] === 'contractSignature.update')).toBe(true);
    expect(semToken.logs.some((l) =>
      l.includes('[WEBHOOK-VIGIA]') && l.includes('leitura indisponível') && l.includes('token da API ClickSign não configurado'))).toBe(true);

    for (const status of [404, 401]) {
      const m = montar({ api: [http(status)] });
      await m.enviar(biometria(DOC_LEGADO));
      expect(m.urls).toHaveLength(1);
      expect(m.efeitos.map((e) => e[0])).toEqual(['contractSignature.updateMany', 'whatsapp.sendText', 'socket']);
      expect(m.logs.some((l) =>
        l.includes('[WEBHOOK-VIGIA]') && l.includes('leitura indisponível') && l.includes(`respondeu ${status}`))).toBe(true);
    }
  });

  it('CLICKSIGN_WEBHOOK_RIGIDO=1 esquecida no servidor não segura nada: ClickSign fora, sem token ou 404 → aplica como hoje, com [WEBHOOK-VIGIA]', async () => {
    process.env.CLICKSIGN_WEBHOOK_RIGIDO = '1';

    const fora = montar({ api: [http(500), semRede] });
    expect(await fora.enviar(fechado(DOC_LEGADO))).toEqual({ ok: true });
    expect(fora.efeitos.filter((e) => e[0] === 'contractSignature.update')).toHaveLength(1);

    const semToken = montar({ apiToken: '' });
    expect(await semToken.enviar(fechado(DOC_CONTRATO))).toEqual({ ok: true });
    expect(semToken.efeitos.map((e) => e[0])).toEqual(['s3.uploadBuffer', 'contract.update']);

    const naoAchou = montar({ api: [http(404)] });
    expect(await naoAchou.enviar(biometria(DOC_LEGADO))).toEqual({ ok: true });
    expect(naoAchou.efeitos.map((e) => e[0])).toEqual(['contractSignature.updateMany', 'whatsapp.sendText', 'socket']);

    const releitura = montar({ api: [documento(DOC_LEGADO, 'running'), http(503), http(503)] });
    expect(await releitura.enviar(fechado(DOC_LEGADO))).toEqual({ ok: true });
    await passar(30 * SEG);
    expect(releitura.efeitos.filter((e) => e[0] === 'contractSignature.update')).toHaveLength(1);

    for (const m of [fora, semToken, naoAchou, releitura]) {
      expect(vigia(m)).toHaveLength(1);
      expect(m.logs.join('\n')).not.toContain('RIGIDO');
    }
  });

  it('o log nunca leva o token da API nem o segredo do webhook', async () => {
    const aberto = documento(DOC_LEGADO, 'running');
    const casos: Array<ReturnType<typeof montar>> = [];
    // Um de cada vez: cada montagem troca o fetch global.
    for (const api of [[semRede, tempoEsgotado], [http(404)], [aberto, aberto, aberto, aberto]]) {
      const m = montar({ api });
      await m.enviar(fechado(DOC_LEGADO));
      await passar(30 * SEG);
      await passar(2 * MIN);
      await passar(10 * MIN);
      casos.push(m);
    }
    expect(casos.map((m) => m.urls.length)).toEqual([2, 1, 4]);
    const comSegredo = montar({ webhookToken: SEGREDO });
    await erro(comSegredo.enviar(fechado(DOC_LEGADO), { contentHmac: 'sha256=00' }));
    for (const m of [...casos, comSegredo]) {
      expect(m.logs.join('\n')).not.toContain(TOKEN_API);
      expect(m.logs.join('\n')).not.toContain(SEGREDO);
    }
  });
});

// ─── (e) Tutorial de biometria: no máximo 1 por documento a cada 10 min ──────

describe('ClickSign — tutorial de biometria no WhatsApp: 1 por documento a cada 10 min', () => {
  const aberto = () => documento(DOC_LEGADO, 'running');
  const avisoAtendente = (m: ReturnType<typeof montar>) =>
    m.efeitos.filter((e) => e[0] === 'socket' && e[2] === 'contract:biometric_error');

  it('dois avisos seguidos para o mesmo documento: um tutorial só; o segundo mantém o status e avisa o atendente', async () => {
    const m = montar({ api: [aberto(), aberto()] });
    expect(await m.enviar(biometria(DOC_LEGADO))).toEqual({ ok: true });
    expect(await m.enviar(biometria(DOC_LEGADO))).toEqual({ ok: true });

    expect(m.whatsapp.sendText).toHaveBeenCalledTimes(1);
    expect(m.estado.assinatura.status).toBe('ERRO_BIOMETRIA');
    expect(avisoAtendente(m)).toHaveLength(2);
    expect(m.efeitos.map((e) => e[0])).toEqual([
      'contractSignature.updateMany', 'whatsapp.sendText', 'socket', 'socket',
    ]);
    expect(m.logs.some((l) => l.includes('já enviado nos últimos 10 min'))).toBe(true);
  });

  it('avisos simultâneos (com ou sem segredo): um tutorial só', async () => {
    const semSegredo = montar({ api: [aberto(), aberto(), aberto()] });
    await Promise.all([1, 2, 3].map(() => semSegredo.enviar(biometria(DOC_LEGADO))));
    expect(semSegredo.whatsapp.sendText).toHaveBeenCalledTimes(1);

    const p = biometria(DOC_LEGADO);
    const comSegredo = montar({ webhookToken: SEGREDO });
    const cab = { contentHmac: `sha256=${hmac(JSON.stringify(p))}` };
    await Promise.all([comSegredo.enviar(p, cab), comSegredo.enviar(p, cab)]);
    expect(comSegredo.whatsapp.sendText).toHaveBeenCalledTimes(1);
    expect(avisoAtendente(comSegredo)).toHaveLength(2);
  });

  it('nova falha 1 h depois → 2 tutoriais; 11 min depois → 2; 9 min ou 1 min depois → 1 só', async () => {
    const casos: Array<[number, number]> = [[1 * HORA, 2], [11 * MIN, 2], [9 * MIN, 1], [1 * MIN, 1]];
    for (const [intervalo, tutoriais] of casos) {
      const inicio = new Date('2026-10-20T13:00:00Z').getTime();
      jest.setSystemTime(inicio);
      const m = montar({ api: [aberto(), aberto()] });
      await m.enviar(biometria(DOC_LEGADO));
      jest.setSystemTime(inicio + intervalo);
      await m.enviar(biometria(DOC_LEGADO));

      expect([intervalo, m.whatsapp.sendText.mock.calls.length]).toEqual([intervalo, tutoriais]);
      expect(avisoAtendente(m)).toHaveLength(2);
      expect(m.estado.assinatura.status).toBe('ERRO_BIOMETRIA');
    }
  });

  it('o tutorial não saiu (falha no envio): o próximo aviso do documento manda', async () => {
    const m = montar({ api: [aberto(), aberto()] });
    m.whatsapp.sendText.mockImplementationOnce(async () => { throw new Error('chip desconectado'); });

    await m.enviar(biometria(DOC_LEGADO));
    expect(m.estado.assinatura.status).toBe('ERRO_BIOMETRIA');
    await m.enviar(biometria(DOC_LEGADO));

    expect(m.whatsapp.sendText).toHaveBeenCalledTimes(2);
    expect(m.efeitos.filter((e) => e[0] === 'whatsapp.sendText')).toHaveLength(1);
    expect(avisoAtendente(m)).toHaveLength(2);
  });

  it('aviso com o documento fora de running não gasta a vez: o aviso real seguinte manda o tutorial', async () => {
    const m = montar({ api: [documento(DOC_LEGADO, 'closed'), aberto()] });
    await m.enviar(biometria(DOC_LEGADO));
    expect(m.efeitos.map((e) => e[0])).toEqual(['socket']);
    expect(m.estado.assinatura.status).toBe('PENDENTE');

    await m.enviar(biometria(DOC_LEGADO));
    expect(m.whatsapp.sendText).toHaveBeenCalledTimes(1);
  });
});

// ─── (f) Pela rota HTTP: nomes dos cabeçalhos e código de resposta ───────────

describe('ClickSign — pela rota HTTP (POST /webhooks/clicksign)', () => {
  let app: INestApplication | undefined;

  beforeEach(() => {
    jest.useRealTimers(); // servidor HTTP de verdade; nenhum caso daqui agenda releitura
  });
  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  async function subir(m: ReturnType<typeof montar>) {
    const mod = await Test.createTestingModule({
      controllers: [ClicksignWebhookController],
      providers: [{ provide: ClicksignService, useValue: m.svc }],
    }).compile();
    app = mod.createNestApplication({ bodyParser: false, logger: false });
    // Como o main.ts: o corpo cru fica em req.rawBody para conferir o HMAC.
    app.use(express.json({ verify: (req: any, _res, buf) => { req.rawBody = buf.toString('utf8'); } }));
    await app.init();
    return (raw: string, cabecalhos: Record<string, string> = {}) =>
      request(app!.getHttpServer())
        .post('/webhooks/clicksign')
        .set({ 'Content-Type': 'application/json', ...cabecalhos })
        .send(raw);
  }

  // Corpo formatado de propósito: o HMAC vale sobre os bytes que chegaram.
  const raw = JSON.stringify(fechado(DOC_LEGADO), null, 2);

  it("com segredo: 'Content-Hmac: sha256=<hex>' certo → 200 e aplica", async () => {
    const m = montar({ webhookToken: SEGREDO });
    const post = await subir(m);
    const res = await post(raw, { 'Content-Hmac': `sha256=${hmac(raw)}` });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(m.urls).toEqual([]);
    expect(m.efeitos.find((e) => e[0] === 'contractSignature.update')?.[1]).toMatchObject({ data: { status: 'ASSINADO' } });
  });

  it("com segredo: 'x-clicksign-hmac-sha256: <hex>' certo → 200 e aplica", async () => {
    const m = montar({ webhookToken: SEGREDO });
    const post = await subir(m);
    const res = await post(raw, { 'x-clicksign-hmac-sha256': hmac(raw) });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(m.estado.assinatura.status).toBe('ASSINADO');
  });

  it('com segredo: sem cabeçalho, cabeçalho errado ou noutro nome → 401 sem efeito', async () => {
    const m = montar({ webhookToken: SEGREDO, api: [documento(DOC_LEGADO, 'closed')] });
    const post = await subir(m);
    const casos: Array<Record<string, string>> = [
      {},
      { 'Content-Hmac': 'sha256=' + '0'.repeat(64) },
      { 'x-clicksign-hmac-sha256': hmac(raw, 'outro-segredo') },
      { 'x-hub-signature-256': `sha256=${hmac(raw)}` },
    ];
    for (const cab of casos) {
      const res = await post(raw, cab);
      expect(res.status).toBe(401);
    }
    expect(m.urls).toEqual([]);
    expect(m.efeitos).toEqual([]);
    expect(m.estado.assinatura.status).toBe('PENDENTE');
  });

  it('sem segredo: documento fechado na ClickSign → 200 exato (não 201) e aplica', async () => {
    const m = montar({ api: [documento(DOC_LEGADO, 'closed')] });
    const post = await subir(m);
    const res = await post(raw);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(m.estado.assinatura.status).toBe('ASSINADO');
  });
});

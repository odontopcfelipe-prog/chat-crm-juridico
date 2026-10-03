import { MessagesService } from '../messages/messages.service';
import { ConversationsService } from '../conversations/conversations.service';
import { QuotesService } from './quotes.service';
import { TreatmentPlanContractService } from './treatment-plan-contract.service';
import { ContractWhatsappService } from './contract-whatsapp.service';
import { PatientsService } from '../patients/patients.service';
import { ClicksignService } from '../clicksign/clicksign.service';

/**
 * BLINDAGEM — mensagem/documento de PACIENTE nunca sai pelo chip FINANCEIRO
 * (incidente jul/2026). Os 4 caminhos que escolhiam chip/conversa "na mão":
 *  1. orçamento no WhatsApp (QuotesService.sendByWhatsapp)
 *  2. TCLE do plano (TreatmentPlanContractService.sendForSignature)
 *  3. link do ClickSign do contrato (ContractWhatsappService.sendClickSign)
 *  4. conversa criada no cadastro do paciente (PatientsService)
 *
 * Serviços REAIS (Messages/Conversations/Quotes/...) sobre um prisma FAKE em
 * memória que imita o SQL (inclusive NULL: `{ not: 'X' }` NÃO casa NULL), com o
 * WhatsApp/ClickSign falsos registrando por qual chip cada envio saiu.
 * Regras: só chip CLINICA/COMERCIAL do PRÓPRIO tenant; nunca FINANCEIRO, nunca
 * chip sem função, nunca o default global (instância undefined); sem chip
 * clínico → NÃO envia (erro claro, nada pela metade).
 */

const T1 = '00000000-0000-0000-0000-000000000000'; // Instituto
const T2 = 'outra-clinica-tenant'; // outra clínica (id fictício) — nunca pode vazar pra T1
const CLINIC_CHIPS = ['inst-clinica', 'inst-comercial'];

// ─── prisma fake ─────────────────────────────────────────────────────────────

type Tri = boolean | null;
const and = (rs: Tri[]): Tri => (rs.some((r) => r === false) ? false : rs.some((r) => r === null) ? null : true);
const or = (rs: Tri[]): Tri => (rs.some((r) => r === true) ? true : rs.some((r) => r === null) ? null : false);
const not = (r: Tri): Tri => (r === null ? null : !r);

/** Comparação escalar com lógica de 3 valores do SQL (NULL = desconhecido). */
function cmp(val: any, f: any): Tri {
  const isNull = val === null || val === undefined;
  if (f === null) return isNull;
  if (typeof f !== 'object' || f instanceof Date) return isNull ? null : val === f;
  const rs: Tri[] = [];
  for (const [op, arg] of Object.entries(f)) {
    if (op === 'in') rs.push(isNull ? null : (arg as any[]).includes(val));
    else if (op === 'notIn') rs.push(isNull ? null : !(arg as any[]).includes(val));
    else if (op === 'not') rs.push(arg === null ? !isNull : typeof arg === 'object' ? not(cmp(val, arg)) : isNull ? null : val !== arg);
    else if (op === 'equals') rs.push(cmp(val, arg));
    else if (op === 'gte') rs.push(isNull ? null : val >= (arg as any));
    else if (op === 'startsWith') rs.push(isNull ? null : String(val).startsWith(String(arg)));
    else throw new Error(`operador não suportado no fake: ${op}`);
  }
  return and(rs);
}

const TO_ONE: Record<string, Record<string, [string, string]>> = {
  conversation: { lead: ['lead', 'lead_id'], inbox: ['inbox', 'inbox_id'] },
  patient: { lead: ['lead', 'lead_id'] },
  treatmentPlan: { patient: ['patient', 'patient_id'] },
  contract: { quote: ['quote', 'quote_id'] },
  quote: { patient: ['patient', 'patient_id'] },
};
const TO_MANY: Record<string, Record<string, [string, string]>> = {
  message: { media: ['media', 'message_id'] },
};

function makeDb(seed: Record<string, any[]>) {
  const db: Record<string, any[]> = {
    instance: [], inbox: [], conversation: [], lead: [], patient: [], message: [], media: [],
    tenant: [], treatmentPlan: [], contract: [], quote: [], contractSignature: [],
    ...JSON.parse(JSON.stringify(seed), (k, v) => (/_at$|^created_at$/.test(k) && typeof v === 'string' ? new Date(v) : v)),
  };
  let seq = 0;

  const evalWhere = (model: string, row: any, where: any): Tri => {
    if (!where) return true;
    const rs: Tri[] = [];
    for (const [k, v] of Object.entries(where)) {
      if (v === undefined) continue;
      if (k === 'AND') rs.push(and((Array.isArray(v) ? v : [v]).map((w) => evalWhere(model, row, w))));
      else if (k === 'OR') rs.push(or((v as any[]).map((w) => evalWhere(model, row, w))));
      else if (k === 'NOT') rs.push(and((Array.isArray(v) ? v : [v]).map((w) => not(evalWhere(model, row, w)))));
      else if (TO_ONE[model]?.[k]) {
        // Filtro por relação vira subquery no Prisma: sem relação → false (nunca NULL).
        const [rel, fk] = TO_ONE[model][k];
        const r = db[rel].find((x) => x.id === row[fk]);
        rs.push(r ? evalWhere(rel, r, v) === true : false);
      } else rs.push(cmp(row[k], v));
    }
    return and(rs);
  };
  const attach = (model: string, row: any, sel?: any): any => {
    const out = { ...row };
    if (!sel) return out;
    for (const [k, v] of Object.entries(sel)) {
      const sub = v === true ? undefined : (v as any)?.select || (v as any)?.include;
      if (TO_ONE[model]?.[k]) {
        const [rel, fk] = TO_ONE[model][k];
        const r = db[rel].find((x) => x.id === row[fk]);
        out[k] = r ? attach(rel, r, sub) : null;
      } else if (TO_MANY[model]?.[k]) {
        const [rel, fk] = TO_MANY[model][k];
        out[k] = db[rel].filter((x) => x[fk] === row.id).map((x) => attach(rel, x, sub));
      }
    }
    return out;
  };
  const sortRows = (rows: any[], orderBy: any) => {
    const keys = (Array.isArray(orderBy) ? orderBy : orderBy ? [orderBy] : []).flatMap((o: any) => Object.entries(o));
    return [...rows].sort((a, b) => {
      for (const [k, dir] of keys) {
        const av = a[k] instanceof Date ? a[k].getTime() : a[k];
        const bv = b[k] instanceof Date ? b[k].getTime() : b[k];
        if (av === bv) continue;
        return (av > bv ? 1 : -1) * (dir === 'desc' ? -1 : 1);
      }
      return 0;
    });
  };
  const model = (name: string) => ({
    findUnique: async ({ where, include, select }: any) => {
      const r = db[name].find((x) => evalWhere(name, x, where) === true);
      return r ? attach(name, r, include || select) : null;
    },
    findFirst: async ({ where, orderBy, include, select }: any = {}) => {
      const r = sortRows(db[name].filter((x) => evalWhere(name, x, where) === true), orderBy)[0];
      return r ? attach(name, r, include || select) : null;
    },
    findMany: async ({ where, orderBy, include, select }: any = {}) =>
      sortRows(db[name].filter((x) => evalWhere(name, x, where) === true), orderBy).map((r) => attach(name, r, include || select)),
    create: async ({ data }: any) => {
      if (name === 'message' && db.message.some((m) => m.external_message_id === data.external_message_id)) {
        throw Object.assign(new Error('Unique constraint'), { code: 'P2002' });
      }
      const row = { id: `${name}-novo-${++seq}`, created_at: new Date(), ...data };
      db[name].push(row);
      return { ...row };
    },
    update: async ({ where, data }: any) => {
      const r = db[name].find((x) => evalWhere(name, x, where) === true);
      if (!r) throw new Error(`${name} não encontrado`);
      Object.assign(r, data);
      return { ...r };
    },
    delete: async ({ where }: any) => {
      const i = db[name].findIndex((x) => evalWhere(name, x, where) === true);
      return db[name].splice(i, 1)[0];
    },
    count: async ({ where }: any = {}) => db[name].filter((x) => evalWhere(name, x, where) === true).length,
  });
  const prisma: any = {
    $transaction: async (fn: any) => (typeof fn === 'function' ? fn(prisma) : Promise.all(fn)),
    $executeRaw: async () => 0,
  };
  for (const name of Object.keys(db)) prisma[name] = model(name);
  return { db, prisma };
}

// ─── mundo de teste ──────────────────────────────────────────────────────────

function seedWorld(opts: { clinicChips?: boolean } = {}) {
  const clinicChips = opts.clinicChips ?? true;
  return {
    tenant: [
      { id: T1, name: 'Instituto Odonto Passos' },
      { id: T2, name: 'Clínica Sorriso Teste' },
    ],
    instance: [
      // FINANCEIRO e o chip morto são os MAIS RECENTES — o loop antigo do orçamento
      // ("mais recente primeiro") pegava exatamente eles.
      ...(clinicChips ? [
        { id: 'i1', name: 'inst-clinica', tenant_id: T1, type: 'whatsapp', purpose: 'CLINICA', created_at: '2026-01-01T00:00:00Z' },
        { id: 'i2', name: 'inst-comercial', tenant_id: T1, type: 'whatsapp', purpose: 'COMERCIAL', created_at: '2026-02-01T00:00:00Z' },
      ] : []),
      { id: 'i3', name: 'inst-financeiro', tenant_id: T1, type: 'whatsapp', purpose: 'FINANCEIRO', created_at: '2026-09-01T00:00:00Z' },
      { id: 'i4', name: 'inst-morto', tenant_id: T1, type: 'whatsapp', purpose: null, created_at: '2026-09-15T00:00:00Z' },
      { id: 'i5', name: 'outra-clinica-chip', tenant_id: T2, type: 'whatsapp', purpose: 'CLINICA', created_at: '2025-12-01T00:00:00Z' },
    ],
    inbox: [
      { id: 'inbox-fin', tenant_id: T1, purpose: 'FINANCEIRO', created_at: '2026-01-01T00:00:00Z' },
      { id: 'inbox-clin', tenant_id: T1, purpose: 'CLINICA', created_at: '2026-01-02T00:00:00Z' },
      { id: 'inbox-com', tenant_id: T1, purpose: 'COMERCIAL', created_at: '2026-01-03T00:00:00Z' },
      { id: 'inbox-t2', tenant_id: T2, purpose: 'CLINICA', created_at: '2025-12-01T00:00:00Z' },
    ],
    lead: [
      { id: 'lead-1', tenant_id: T1, name: 'Maria Souza', phone: '558299990001', is_client: false },
      { id: 'lead-t2', tenant_id: T2, name: 'João Lima', phone: '558299990009', is_client: true },
    ],
    patient: [
      { id: 'pat-1', tenant_id: T1, name: 'Maria Souza', phone: '(82) 99999-0001', email: null, lead_id: 'lead-1' },
      { id: 'pat-t2', tenant_id: T2, name: 'João Lima', phone: '82 99999-0009', email: null, lead_id: 'lead-t2' },
    ],
    conversation: [
      // A conversa do Financeiro é a MAIS RECENTE (a cobrança dá bump) — é a que o
      // "orderBy last_message_at desc" sem filtro pegava.
      { id: 'conv-fin', tenant_id: T1, lead_id: 'lead-1', channel: 'whatsapp', status: 'ABERTO', inbox_id: 'inbox-fin', instance_name: 'inst-financeiro', last_message_at: '2026-10-02T12:00:00Z' },
    ],
    quote: [{ id: 'quote-1', status: 'DRAFT', patient_id: 'pat-1' }],
  };
}

function makeServices(seed: Record<string, any[]>) {
  const { db, prisma } = makeDb(seed);
  const sends: Array<{ kind: 'text' | 'media'; number: string; instance: string | undefined; text: string }> = [];
  const failChips = new Set<string>(); // chips "fora do ar" (404)
  const whatsapp: any = {
    sendText: jest.fn(async (number: string, text: string, instance?: string) => {
      sends.push({ kind: 'text', number, instance, text });
      if (instance && failChips.has(instance)) return { statusCode: 404, error: 'instance does not exist' };
      return { key: { id: `wa-${sends.length}` } };
    }),
    sendMedia: jest.fn(async (number: string, _t: string, _m: string, caption: string, instance?: string) => {
      sends.push({ kind: 'media', number, instance, text: caption });
      if (instance && failChips.has(instance)) return { statusCode: 404, error: 'instance does not exist' };
      return { key: { id: `wa-${sends.length}` } };
    }),
  };
  const chatGateway: any = { emitNewMessage: jest.fn(), emitConversationsUpdate: jest.fn(), server: null };
  const fileStorage: any = { generatePath: (id: string, ext: string) => `t/${id}.${ext}`, write: jest.fn(async () => {}) };
  const settings: any = { getContractConfig: async () => ({ publicApiUrl: '' }) };
  const mediaSign: any = { signedQuery: () => 'sig=1' };
  const aiQueue: any = { getJob: async () => null, add: async () => ({}) };

  const messages = new MessagesService(prisma, whatsapp, chatGateway, {} as any, fileStorage, settings, mediaSign, aiQueue);
  const conversations = new ConversationsService(prisma, chatGateway, whatsapp, {} as any);
  const portalAuth: any = { createMagicLink: jest.fn(async () => ({ link: 'https://portal.test/m/abc' })) };
  const pdfService: any = { generatePdf: jest.fn(async () => Buffer.from('%PDF-1.4 orcamento')) };
  const moduleRef: any = { get: jest.fn() };
  const quotes = new QuotesService(
    prisma, moduleRef, whatsapp, portalAuth, undefined, undefined, undefined, undefined, pdfService, undefined, undefined,
    messages, conversations,
  );
  return { db, prisma, whatsapp, sends, failChips, messages, conversations, quotes, portalAuth, chatGateway, fileStorage };
}

/** Nenhum envio saiu pelo Financeiro, por chip morto, pelo default global ou por chip de outra clínica. */
function expectOnlyClinicChips(sends: Array<{ instance: string | undefined }>, allowed = CLINIC_CHIPS) {
  expect(sends.length).toBeGreaterThan(0);
  for (const s of sends) {
    expect(s.instance).toBeDefined();
    expect(allowed).toContain(s.instance);
    expect(s.instance).not.toBe('inst-financeiro');
  }
}

function fakeQuote(over: Record<string, any> = {}) {
  return {
    id: 'quote-1',
    status: 'DRAFT',
    patient_id: 'pat-1',
    patient: { id: 'pat-1', name: 'Maria Souza', phone: '(82) 99999-0001', tenant_id: T1 },
    items: [{ id: 'it-1' }, { id: 'it-2' }],
    total_value: 1500,
    discount_value: 0,
    valid_until: null,
    quote_number: 42,
    _count: { attachments: 0 },
    ...over,
  };
}

// ─── 1. Orçamento no WhatsApp ────────────────────────────────────────────────

describe('1. QuotesService.sendByWhatsapp — orçamento só pelo chip clínico', () => {
  it('manda o PDF pelo chip Clínica/Comercial na conversa de PACIENTE (nunca a do Financeiro) e grava no chat', async () => {
    const w = makeServices(seedWorld());
    jest.spyOn(w.quotes, 'findOne').mockResolvedValue(fakeQuote() as any);

    const res = await w.quotes.sendByWhatsapp('quote-1', T1);

    expectOnlyClinicChips(w.sends);
    expect(w.sends).toHaveLength(1);
    expect(w.sends[0].kind).toBe('media');
    expect(res.conversationId).not.toBe('conv-fin');
    const conv = w.db.conversation.find((c) => c.id === res.conversationId)!;
    expect(['inbox-clin', 'inbox-com']).toContain(conv.inbox_id);
    // O envio ficou no histórico da conversa de paciente (antes não era gravado).
    const msgs = w.db.message.filter((m) => m.conversation_id === res.conversationId);
    expect(msgs).toHaveLength(1);
    expect(CLINIC_CHIPS).toContain(msgs[0].instance_name);
    expect(w.db.message.some((m) => m.conversation_id === 'conv-fin')).toBe(false);
    expect(w.db.quote[0].status).toBe('SENT');
  });

  it('usa o nome da PRÓPRIA clínica no texto (não "Instituto Odonto Passos" fixo) e o chip dela', async () => {
    const w = makeServices(seedWorld());
    jest.spyOn(w.quotes, 'findOne').mockResolvedValue(fakeQuote({
      patient_id: 'pat-t2',
      patient: { id: 'pat-t2', name: 'João Lima', phone: '82 99999-0009', tenant_id: T2 },
    }) as any);

    await w.quotes.sendByWhatsapp('quote-1', T2);

    expectOnlyClinicChips(w.sends, ['outra-clinica-chip']);
    expect(w.sends[0].text).toContain('Clínica Sorriso Teste');
    expect(w.sends[0].text).not.toContain('Instituto Odonto Passos');
  });

  it('chip Comercial fora do ar (404) → troca pro Clínica; nunca cai no Financeiro', async () => {
    const w = makeServices(seedWorld());
    w.failChips.add('inst-comercial');
    jest.spyOn(w.quotes, 'findOne').mockResolvedValue(fakeQuote() as any);

    await w.quotes.sendByWhatsapp('quote-1', T1);

    expect(w.sends.map((s) => s.instance)).toEqual(['inst-comercial', 'inst-clinica']);
  });

  it('sem chip clínico (só Financeiro + chip morto) → NÃO envia, não gera link nem conversa', async () => {
    const w = makeServices(seedWorld({ clinicChips: false }));
    jest.spyOn(w.quotes, 'findOne').mockResolvedValue(fakeQuote() as any);
    const convsBefore = w.db.conversation.length;

    await expect(w.quotes.sendByWhatsapp('quote-1', T1)).rejects.toThrow(/Clínica\/Comercial/);

    expect(w.sends).toHaveLength(0);
    expect(w.portalAuth.createMagicLink).not.toHaveBeenCalled();
    expect(w.db.conversation.length).toBe(convsBefore);
    expect(w.db.message).toHaveLength(0);
  });

  it('telefone do cadastro ≠ contato do WhatsApp → recusa (não manda pra outro número)', async () => {
    const w = makeServices(seedWorld());
    jest.spyOn(w.quotes, 'findOne').mockResolvedValue(fakeQuote({
      patient: { id: 'pat-1', name: 'Maria Souza', phone: '(82) 98888-7777', tenant_id: T1 },
    }) as any);

    await expect(w.quotes.sendByWhatsapp('quote-1', T1)).rejects.toThrow(/diferente do contato/);
    expect(w.sends).toHaveLength(0);
    expect(w.portalAuth.createMagicLink).not.toHaveBeenCalled();
  });

  it('número da família (contato já é de outro paciente) → usa a conversa desse contato, sem vincular', async () => {
    const seed = seedWorld();
    seed.patient.push({ id: 'pat-filho', tenant_id: T1, name: 'Pedro Souza', phone: '82999990001', email: null, lead_id: null } as any);
    const w = makeServices(seed);
    jest.spyOn(w.quotes, 'findOne').mockResolvedValue(fakeQuote({
      patient_id: 'pat-filho',
      patient: { id: 'pat-filho', name: 'Pedro Souza', phone: '82999990001', tenant_id: T1 },
    }) as any);

    const res = await w.quotes.sendByWhatsapp('quote-1', T1);

    expectOnlyClinicChips(w.sends);
    expect(w.db.conversation.find((c) => c.id === res.conversationId)!.lead_id).toBe('lead-1');
    expect(w.db.patient.find((p) => p.id === 'pat-filho')!.lead_id).toBeNull();
  });
});

// ─── 2. TCLE do plano ────────────────────────────────────────────────────────

describe('2. TreatmentPlanContractService.sendForSignature — TCLE na conversa de paciente', () => {
  function build(seed: Record<string, any[]>) {
    const w = makeServices({
      ...seed,
      treatmentPlan: [{ id: 'plan-1', patient_id: 'pat-1', status: 'PENDING_SIGNATURE', contract_signature_id: null }],
    });
    const clicksign: any = {
      createGenericSignature: jest.fn(async () => ({ signingUrl: 'https://app.clicksign.com/sign/tcle-1', contractSignatureId: 'sig-1' })),
    };
    const svc = new TreatmentPlanContractService(w.prisma, clicksign, w.messages, w.conversations);
    jest.spyOn(svc as any, 'generateTclePdf').mockResolvedValue(Buffer.from('%PDF-1.4 tcle'));
    return { ...w, clicksign, svc };
  }

  it('não usa a conversa mais recente (Financeiro): vincula a de paciente e manda o link real pelo chip clínico', async () => {
    const seed = seedWorld();
    // Conversa clínica mais ANTIGA que a do Financeiro.
    seed.conversation.push({ id: 'conv-clin', tenant_id: T1, lead_id: 'lead-1', channel: 'whatsapp', status: 'ABERTO', inbox_id: 'inbox-clin', instance_name: 'inst-clinica', last_message_at: '2026-09-20T12:00:00Z' } as any);
    const w = build(seed);

    const res = await w.svc.sendForSignature('plan-1', T1);

    expect(w.clicksign.createGenericSignature).toHaveBeenCalledTimes(1);
    const arg = w.clicksign.createGenericSignature.mock.calls[0][0];
    expect(arg.conversationId).toBe('conv-clin');
    expect(arg).not.toHaveProperty('whatsappInstance');
    expectOnlyClinicChips(w.sends);
    expect(w.sends[0].text).toContain('https://app.clicksign.com/sign/tcle-1');
    expect(w.sends[0].text).not.toContain('will-be-replaced');
    expect(w.db.message.find((m) => m.conversation_id === 'conv-clin')).toBeTruthy();
    expect(res).toMatchObject({ signingUrl: 'https://app.clicksign.com/sign/tcle-1', whatsappSent: true });
  });

  it('sem chip clínico → NÃO sobe no ClickSign nem envia', async () => {
    const w = build(seedWorld({ clinicChips: false }));

    await expect(w.svc.sendForSignature('plan-1', T1)).rejects.toThrow(/Clínica\/Comercial/);

    expect(w.clicksign.createGenericSignature).not.toHaveBeenCalled();
    expect(w.sends).toHaveLength(0);
    expect(w.db.treatmentPlan[0].contract_signature_id).toBeNull();
  });
});

// ─── 3. Link do ClickSign do contrato ────────────────────────────────────────

describe('3. ContractWhatsappService.sendClickSign — link do contrato pelo chip clínico', () => {
  function build(seed: Record<string, any[]>) {
    const w = makeServices({
      ...seed,
      quote: [{ id: 'quote-1', status: 'ACCEPTED', patient_id: 'pat-1' }],
      contract: [{ id: 'contract-1', quote_id: 'quote-1', status: 'DRAFT' }],
    });
    const contracts: any = {
      sendToClickSign: jest.fn(async () => ({ id: 'contract-1', status: 'SENT', signing_url: 'https://app.clicksign.com/sign/ct-1' })),
    };
    const svc = new ContractWhatsappService(w.prisma, {} as any, w.conversations, w.messages, w.quotes, contracts);
    return { ...w, contracts, svc };
  }

  it('sobe no ClickSign e manda o link pelo chip Clínica/Comercial, na conversa de paciente', async () => {
    const w = build(seedWorld());

    const res: any = await w.svc.sendClickSign('contract-1', T1, 'user-1');

    expect(w.contracts.sendToClickSign).toHaveBeenCalledTimes(1);
    expectOnlyClinicChips(w.sends);
    expect(w.sends[0].text).toContain('https://app.clicksign.com/sign/ct-1');
    expect(res.whatsapp.sent).toBe(true);
    expect(res.whatsapp.conversationId).not.toBe('conv-fin');
  });

  it('sem chip clínico → NÃO sobe no ClickSign (contrato segue DRAFT) nem envia', async () => {
    const w = build(seedWorld({ clinicChips: false }));

    await expect(w.svc.sendClickSign('contract-1', T1, 'user-1')).rejects.toThrow(/Clínica\/Comercial/);

    expect(w.contracts.sendToClickSign).not.toHaveBeenCalled();
    expect(w.sends).toHaveLength(0);
  });

  it('WhatsApp falha DEPOIS do ClickSign → devolve o motivo (sem fingir que enviou)', async () => {
    const w = build(seedWorld());
    w.failChips.add('inst-clinica');
    w.failChips.add('inst-comercial');

    const res: any = await w.svc.sendClickSign('contract-1', T1, 'user-1');

    expectOnlyClinicChips(w.sends);
    expect(res.whatsapp).toMatchObject({ sent: false });
    expect(res.whatsapp.error).toMatch(/desconectado/);
  });
});

describe('3b. ClicksignService — os métodos genéricos não mandam WhatsApp (nem pelo chip padrão)', () => {
  function build() {
    const { prisma } = makeDb({});
    const whatsapp: any = { sendText: jest.fn(), sendMedia: jest.fn() };
    const svc = new ClicksignService(prisma, {} as any, whatsapp, {} as any, {} as any, {} as any);
    jest.spyOn(svc as any, 'getCfg').mockResolvedValue({ baseUrl: 'https://app.clicksign.com', token: 't' });
    jest.spyOn(svc as any, 'uploadDocument').mockResolvedValue('doc-1');
    jest.spyOn(svc as any, 'createSigner').mockResolvedValue('signer-1');
    jest.spyOn(svc as any, 'addSignerToDocumentCustom').mockResolvedValue('req-1');
    return { svc, whatsapp };
  }

  it('sendDocumentForSignature (contrato) só sobe o documento', async () => {
    const { svc, whatsapp } = build();
    const r = await svc.sendDocumentForSignature({
      buffer: Buffer.from('x'), filename: 'c.pdf', signerName: 'Maria', signerEmail: 'm@x', signerPhone: '82999990001', signerMessage: 'assine',
    });
    expect(r.signingUrl).toBe('https://app.clicksign.com/sign/req-1');
    expect(whatsapp.sendText).not.toHaveBeenCalled();
    expect(whatsapp.sendMedia).not.toHaveBeenCalled();
  });

  it('createGenericSignature (TCLE) só sobe o documento e grava a assinatura', async () => {
    const { svc, whatsapp } = build();
    await svc.createGenericSignature({
      leadId: 'lead-1', conversationId: 'conv-1', buffer: Buffer.from('x'), filename: 't.pdf',
      signerName: 'Maria', signerEmail: 'm@x', signerPhone: '82999990001', signerMessage: 'assine',
    });
    expect(whatsapp.sendText).not.toHaveBeenCalled();
    expect(whatsapp.sendMedia).not.toHaveBeenCalled();
  });
});

// ─── 4. Conversa criada no cadastro do paciente ──────────────────────────────

describe('4. PatientsService — conversa do cadastro nunca nasce no Financeiro', () => {
  function build(seed: Record<string, any[]>) {
    const w = makeServices(seed);
    const svc = new PatientsService(w.prisma, w.fileStorage, {} as any, {} as any, {} as any, w.conversations);
    return { ...w, svc };
  }

  it('lead só com conversa do Financeiro → cria a de PACIENTE (inbox + chip clínico), nunca reusa/usa o Financeiro', async () => {
    const seed = seedWorld();
    seed.patient.push({ id: 'pat-2', tenant_id: T1, name: 'Ana Reis', phone: '82 98888-0002', email: null, lead_id: null } as any);
    seed.lead.push({ id: 'lead-2', tenant_id: T1, name: 'Ana', phone: '558288880002', is_client: true } as any);
    seed.conversation.push({ id: 'conv-fin-2', tenant_id: T1, lead_id: 'lead-2', channel: 'whatsapp', status: 'ABERTO', inbox_id: 'inbox-fin', instance_name: 'inst-financeiro', last_message_at: '2026-10-01T00:00:00Z' } as any);
    const w = build(seed);

    await w.svc.ensureLeadAndConversationPublic('pat-2', T1);

    const convs = w.db.conversation.filter((c) => c.lead_id === 'lead-2');
    expect(convs).toHaveLength(2);
    const created = convs.find((c) => c.id !== 'conv-fin-2')!;
    expect(created.inbox_id).toBe('inbox-clin');
    expect(created.instance_name).toBe('inst-clinica');
    expect(w.db.patient.find((p) => p.id === 'pat-2')!.lead_id).toBe('lead-2');
  });

  it('já tem conversa de paciente (mesmo ENCERRADA) → não abre conversa vazia nova', async () => {
    const seed = seedWorld();
    seed.patient.push({ id: 'pat-3', tenant_id: T1, name: 'Bia', phone: '82 97777-0003', email: null, lead_id: null } as any);
    seed.lead.push({ id: 'lead-3', tenant_id: T1, name: 'Bia', phone: '558277770003', is_client: true } as any);
    seed.conversation.push({ id: 'conv-old', tenant_id: T1, lead_id: 'lead-3', channel: 'whatsapp', status: 'ENCERRADO', inbox_id: 'inbox-clin', instance_name: 'inst-clinica', last_message_at: '2026-03-01T00:00:00Z' } as any);
    const w = build(seed);

    await w.svc.ensureLeadAndConversationPublic('pat-3', T1);

    expect(w.db.conversation.filter((c) => c.lead_id === 'lead-3')).toHaveLength(1);
  });

  it('sem chip clínico → conversa nasce SEM chip (nunca com o Financeiro nem o chip morto)', async () => {
    const seed = seedWorld({ clinicChips: false });
    seed.patient.push({ id: 'pat-4', tenant_id: T1, name: 'Caio', phone: '82 96666-0004', email: null, lead_id: null } as any);
    const w = build(seed);

    await w.svc.ensureLeadAndConversationPublic('pat-4', T1);

    const leadId = w.db.patient.find((p) => p.id === 'pat-4')!.lead_id;
    const convs = w.db.conversation.filter((c) => c.lead_id === leadId);
    expect(convs).toHaveLength(1);
    expect(convs[0].inbox_id).toBe('inbox-clin');
    expect(convs[0].instance_name).toBeNull();
  });

  it('só inbox sem função + Financeiro → usa o inbox sem função (NOT purpose não pode descartar NULL)', async () => {
    const seed = seedWorld();
    seed.inbox = [
      { id: 'inbox-fin', tenant_id: T1, purpose: 'FINANCEIRO', created_at: '2026-01-01T00:00:00Z' },
      { id: 'inbox-legado', tenant_id: T1, purpose: null, created_at: '2026-01-05T00:00:00Z' },
    ] as any;
    seed.patient.push({ id: 'pat-5', tenant_id: T1, name: 'Duda', phone: '82 95555-0005', email: null, lead_id: null } as any);
    const w = build(seed);

    await w.svc.ensureLeadAndConversationPublic('pat-5', T1);

    const leadId = w.db.patient.find((p) => p.id === 'pat-5')!.lead_id;
    const conv = w.db.conversation.find((c) => c.lead_id === leadId)!;
    expect(conv.inbox_id).toBe('inbox-legado');
    expect(conv.instance_name).not.toBe('inst-financeiro');
  });
});

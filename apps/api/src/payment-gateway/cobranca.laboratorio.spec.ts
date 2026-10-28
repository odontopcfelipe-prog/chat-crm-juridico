/**
 * Laboratório de prótese — cobrança do laboratório no webhook do Asaas, no reconcile
 * (mesma via: handleWebhook) e na baixa na recepção.
 *
 * O laboratório recebe igual à clínica: a cobrança é baixada, a receita entra no caixa,
 * a parcela vira PAGA, o fluxo da entrada (sinal) continua e a confirmação de pagamento
 * sai pelo chip Financeiro com texto neutro. O que NÃO roda no laboratório (log
 * `[LAB-GATE] ...`): pagou → paciente (IA pós-venda, setor Clínica), liberação de
 * comissão, aviso interno de venda feita, cancelou tudo → volta a lead, regravar o
 * telefone do cliente, importar clientes do Asaas como clientes prontos e e-mail com
 * texto de clínica. A descrição da cobrança que volta ao cliente sai sem palavra de
 * clínica ("Plano de tratamento odontológico" vira "Trabalho de prótese"), e a que vai
 * ao Asaas na emissão (boleto, carnê, PIX, cartão) já nasce assim, com a mesma tag
 * [plan:<id>] e as mesmas palavras que a emissão procura para não emitir duas vezes.
 * Sem o nome da conta, a confirmação assina com "o laboratório".
 *
 * Clínica: as mesmas operações, na mesma ordem e com os mesmos argumentos, com e sem
 * uma OUTRA conta de laboratório cadastrada (a leitura da lista de laboratórios fica
 * fora do rastro). Prisma, WhatsApp, e-mail e Asaas mockados; relógio fixo.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as ts from 'typescript';
import { ForbiddenException, Logger } from '@nestjs/common';
import { __limparCacheLabTenants, stripInternalTags } from '@crm/shared';
import { PaymentGatewayService } from './payment-gateway.service';
import { TreatmentPlanBillingService } from '../commercial/treatment-plan-billing.service';
import { EmailAutomationService } from '../email-automation/email-automation.service';
import { EMAIL_EVENTS } from '../email-automation/email-events';
import {
  NOME_PADRAO_DO_LABORATORIO,
  descricaoParaClienteDoLaboratorio,
  semVariaveis,
  temVocabularioDeClinica,
} from './cobranca-laboratorio';

// O webhook carrega estes serviços por require() + ModuleRef: aqui viram classes vazias
// (o ModuleRef falso devolve o dublê pelo nome da classe).
jest.mock('../commercial/down-payment-flow.service', () => ({ DownPaymentFlowService: class DownPaymentFlowService {} }));
jest.mock('../commercial/quotes.service', () => ({ QuotesService: class QuotesService {} }));

// ─── Dados de exemplo (repositório público: nada real) ───────────────────────
const CLINICA = 'tenant-clinica';
const LAB = 'tenant-lab';
const AGORA = new Date('2026-10-21T15:00:00.000Z');
const HOJE = '2026-10-21';
const PLANO = '00000000-0000-0000-0000-0000000000aa';
const TEL = '5582988887777';
// Vocabulário de clínica que não pode chegar ao cliente do laboratório.
const PALAVRAS_DE_CLINICA = /odontol|paciente|consulta|tratamento|passos/i;

// ─── Carregador: o arquivo-fonte real, com o import dinâmico virando require ─
// Mesmo carregador dos retratos mensagens-paciente e lab-gate-automatismos: o jest
// deste projeto não executa `await import('@crm/shared')` (usado pelos avisos ao
// cliente); o resto é o código de produção byte a byte.
const RAIZ_SRC = path.resolve(__dirname, '..');
const OPCOES_TS = (() => {
  const raizApi = path.resolve(RAIZ_SRC, '..');
  const lido = ts.readConfigFile(path.join(raizApi, 'tsconfig.json'), ts.sys.readFile);
  const { options } = ts.convertCompilerOptionsFromJson(lido.config.compilerOptions, raizApi);
  return {
    ...options,
    module: ts.ModuleKind.CommonJS,
    moduleResolution: ts.ModuleResolutionKind.Node10,
    resolvePackageJsonExports: undefined,
    sourceMap: false,
    inlineSourceMap: false,
    declaration: false,
    incremental: false,
  };
})();
function carregarFonte(relativo: string): any {
  const arquivo = path.join(RAIZ_SRC, relativo);
  const { outputText } = ts.transpileModule(fs.readFileSync(arquivo, 'utf8'), {
    fileName: arquivo,
    compilerOptions: OPCOES_TS,
  });
  const modulo = { exports: {} as any };
  const requerer = (id: string) => require(id.startsWith('.') ? path.resolve(path.dirname(arquivo), id) : id);
  new Function('exports', 'require', 'module', '__filename', '__dirname', outputText)(
    modulo.exports, requerer, modulo, arquivo, path.dirname(arquivo),
  );
  return modulo.exports;
}
const { PaymentGatewayService: GatewayDaFonte } = carregarFonte('payment-gateway/payment-gateway.service.ts');

// ─── Relógio e logs ──────────────────────────────────────────────────────────
let logs: string[];
/** Logs calados; os `log` ficam anotados (para conferir os `[LAB-GATE] ...`). */
function calar() {
  jest.spyOn(Logger.prototype, 'log').mockImplementation((m: any) => {
    logs.push(String(m));
  });
  for (const nivel of ['warn', 'debug', 'error'] as const) {
    jest.spyOn(Logger.prototype, nivel).mockImplementation(() => undefined);
  }
}
beforeEach(() => {
  __limparCacheLabTenants();
  logs = [];
  calar();
  jest.useFakeTimers({
    now: AGORA,
    doNotFake: [
      'nextTick', 'setImmediate', 'clearImmediate', 'setTimeout', 'clearTimeout',
      'setInterval', 'clearInterval', 'queueMicrotask', 'hrtime', 'performance',
    ],
  });
});
afterEach(() => {
  jest.restoreAllMocks();
  jest.useRealTimers();
});
const registrou = (trecho: string) => logs.some((l) => l.includes('[LAB-GATE]') && l.includes(trecho));

// ─── Banco falso ─────────────────────────────────────────────────────────────
type Op = [string, any];
type Respostas = Record<string, (args: any) => any>;

/**
 * Grava `modelo.metodo(args)` em `ops` e responde pelo mapa (padrão: findMany=[],
 * count=0, updateMany=1, create/update = os dados com id, o resto null). A leitura da
 * lista de laboratórios (TenantBusinessProfile) não entra no rastro.
 */
function banco(labs: string[], respostas: Respostas = {}) {
  __limparCacheLabTenants();
  const ops: Op[] = [];
  const perfis = jest.fn(async () => labs.map((tenant_id) => ({ tenant_id })));
  const modelos: Record<string, any> = {};
  const prisma: any = new Proxy(
    {},
    {
      get(_a, modelo: string | symbol) {
        if (typeof modelo !== 'string' || modelo === 'then') return undefined;
        if (modelo === 'tenantBusinessProfile') return { findMany: perfis };
        if (modelo === '$transaction') {
          return async (cb: any) => {
            ops.push(['$transaction', null]);
            const r = typeof cb === 'function' ? await cb(prisma) : await Promise.all(cb);
            ops.push(['$transaction:fim', null]);
            return r;
          };
        }
        if (modelo.startsWith('$')) {
          return async () => {
            ops.push([modelo, null]);
            return 1;
          };
        }
        modelos[modelo] ??= new Proxy(
          {},
          {
            get(_m, metodo: string | symbol) {
              if (typeof metodo !== 'string' || metodo === 'then') return undefined;
              return async (args: any) => {
                const op = `${modelo}.${metodo}`;
                ops.push([op, args]);
                const r = respostas[op];
                if (r) return r(args);
                if (metodo === 'findMany') return [];
                if (metodo === 'count') return 0;
                if (metodo === 'updateMany' || metodo === 'deleteMany') return { count: 1 };
                if (metodo === 'create' || metodo === 'update') return { id: `${modelo}-1`, ...(args?.data ?? {}) };
                return null;
              };
            },
          },
        );
        return modelos[modelo];
      },
    },
  );
  const de = (op: string) => ops.filter(([o]) => o === op).map(([, a]) => a);
  return { prisma, ops, perfis, de, nomes: () => ops.map(([o]) => o) };
}

// ─── Cobranças ───────────────────────────────────────────────────────────────
function cobranca(tenant: string, over: Record<string, any> = {}) {
  return {
    id: `cob-${tenant}`,
    tenant_id: tenant,
    external_id: `pay_${tenant}`,
    customer_external_id: `cus_${tenant}`,
    status: 'PENDING',
    kind: null,
    amount: 250,
    billing_type: 'BOLETO',
    description: `Parcela 1/3 — Dr. Exemplo [plan:${PLANO}]`,
    installment_id: null,
    transaction_id: null,
    treatment_plan_id: 'plano-1',
    lead_honorario_payment_id: null,
    received_in_cash: false,
    paid_at: null,
    payment_date: null,
    net_value: null,
    invoice_url: null,
    due_date: new Date('2026-10-25T00:00:00.000Z'),
    treatment_plan: { patient: { name: 'Dr. Exemplo', lead_id: 'lead-1' }, quote: { created_by_user_id: 'u-1' } },
    patient: { name: 'Dr. Exemplo', lead_id: 'lead-1' },
    ...over,
  };
}
const evento = (c: any, status: string) => ({
  event: `PAYMENT_${status}`,
  payment: {
    id: c.external_id,
    status,
    customer: c.customer_external_id,
    value: c.amount,
    paymentDate: HOJE,
    confirmedDate: HOJE,
    description: c.description,
  },
});

// ─── Webhook / reconcile / baixa (serviço importado normalmente) ─────────────
function webhook(labs: string[], charge: any) {
  const b = banco(labs, {
    'paymentGatewayCharge.findUnique': () => charge,
    'paymentGatewayCharge.findFirst': () => charge,
    'paymentGatewayCharge.update': (a: any) => ({ ...charge, ...a.data }),
    'installment.findUnique': () => ({ id: 'parc-1', amount: 250, discount_value: 0, fee_value: 0, status: 'PENDENTE', patient_id: 'pac-1' }),
    'treatmentPlan.findUnique': () => ({ quote_id: 'quote-1' }),
    'commission.findMany': () => [{ id: 'com-1' }],
  });
  const entrada = { handleChargePaid: jest.fn(async () => undefined) };
  const vendas = { notifyVendaFeitaOnPaid: jest.fn(async () => undefined) };
  const dubles: Record<string, any> = { DownPaymentFlowService: entrada, QuotesService: vendas };
  const moduleRef = { get: jest.fn((cls: any) => dubles[cls?.name]) };
  const asaas = { listCustomers: jest.fn(async () => ({ data: [], hasMore: false })) };
  const svc = new PaymentGatewayService(b.prisma, asaas as any, {} as any, {} as any, {} as any, {} as any, moduleRef as any);
  const espiao = (nome: string, impl: () => any) => jest.spyOn(PaymentGatewayService.prototype as any, nome).mockImplementation(impl);
  const promove = espiao('promoteLeadFromCharge', () => undefined);
  const rebaixa = espiao('tryDemoteLeadIfAllChargesCancelled', () => undefined);
  const confirma = espiao('notifyClientPaymentReceived', async () => undefined);
  const avisaCancelada = espiao('notifyClientChargeDeleted', async () => undefined);
  const emailPago = espiao('sendPaymentConfirmedEmail', async () => undefined);
  // Cópias: o restoreAllMocks entre a 1ª e a 2ª rodada não pode mexer no que foi anotado.
  const efeitos = () => ({
    ops: [...b.ops],
    promove: [...promove.mock.calls],
    rebaixa: [...rebaixa.mock.calls],
    confirma: [...confirma.mock.calls],
    avisaCancelada: [...avisaCancelada.mock.calls],
    emailPago: [...emailPago.mock.calls],
    entrada: [...entrada.handleChargePaid.mock.calls],
    vendaFeita: [...vendas.notifyVendaFeitaOnPaid.mock.calls],
  });
  return { svc, asaas, entrada, vendas, promove, rebaixa, confirma, avisaCancelada, emailPago, efeitos, ...b };
}

describe('webhook do Asaas (e reconcile) — cobrança de laboratório', () => {
  it('parcela paga: baixa, receita no caixa, parcela PAGA e confirmação saem; promoção, comissão e aviso de venda não', async () => {
    const c = cobranca(LAB, { installment_id: 'parc-1' });
    const m = webhook([LAB], c);
    await m.svc.handleWebhook(evento(c, 'RECEIVED'));

    // O laboratório recebe: status, receita e parcela.
    expect(m.de('paymentGatewayCharge.update')[0].data.status).toBe('RECEIVED');
    expect(m.de('financialTransaction.create')).toHaveLength(1);
    expect(m.de('financialTransaction.create')[0].data).toMatchObject({ tenant_id: LAB, type: 'RECEITA', status: 'PAGO' });
    expect(m.de('installment.update')[0].data.status).toBe('PAGA');
    expect(m.confirma).toHaveBeenCalledTimes(1);
    expect(m.emailPago).toHaveBeenCalledTimes(1);
    // O 1º pagamento promove o contato (caminho sem efeito de clínica no laboratório).
    expect(m.promove.mock.calls).toEqual([[c.id, LAB, 'parcela paga (Asaas)']]);
    // Ganchos de clínica: não rodam.
    expect(m.vendas.notifyVendaFeitaOnPaid).not.toHaveBeenCalled();
    expect(m.nomes()).not.toContain('commission.findMany');
    expect(m.nomes()).not.toContain('commission.updateMany');
    expect(m.nomes()).not.toContain('treatmentPlan.findUnique');
    expect(registrou('venda-feita')).toBe(true);
    expect(registrou('comissao')).toBe(true);
  });

  it('pagamento confirmado sem parcela: promove o contato como na clínica (sem efeito de clínica no laboratório)', async () => {
    const c = cobranca(LAB);
    const m = webhook([LAB], c);
    await m.svc.handleWebhook(evento(c, 'CONFIRMED'));
    expect(m.promove.mock.calls).toEqual([[c.id, LAB, 'pagamento confirmado (Asaas)']]);
    expect(m.confirma).toHaveBeenCalledTimes(1);
  });

  it('entrada (SINAL) paga: o fluxo da entrada continua (parcelas e trabalho liberado)', async () => {
    const c = cobranca(LAB, { kind: 'SINAL' });
    const m = webhook([LAB], c);
    await m.svc.handleWebhook(evento(c, 'RECEIVED'));
    expect(m.entrada.handleChargePaid.mock.calls).toEqual([[c.id]]);
    // Promove como na clínica (no laboratório, sem efeito de clínica).
    expect(m.promove.mock.calls).toEqual([[c.id, LAB, 'pagamento confirmado (Asaas)']]);
  });

  it.each(['DELETED', 'REFUNDED'])('cobrança %s com cliente vinculado: avisa igual, mas o cliente não volta a lead', async (status) => {
    const c = cobranca(LAB);
    const m = webhook([LAB], c);
    await m.svc.handleWebhook(evento(c, status));
    expect(m.de('paymentGatewayCharge.update')[0].data.status).toBe(status);
    expect(m.avisaCancelada).toHaveBeenCalledTimes(1);
    expect(m.rebaixa).not.toHaveBeenCalled();
    expect(registrou('demote')).toBe(true);
  });

  it('reconcile (silencioso): baixa e receita sem aviso; a parcela paga promove como na clínica; nada de gancho de clínica', async () => {
    const c = cobranca(LAB, { installment_id: 'parc-1' });
    const m = webhook([LAB], c);
    await m.svc.handleWebhook(evento(c, 'RECEIVED'), { silent: true });
    expect(m.de('financialTransaction.create')).toHaveLength(1);
    expect(m.confirma).not.toHaveBeenCalled();
    expect(m.promove.mock.calls).toEqual([[c.id, LAB, 'parcela paga (Asaas)']]);
    expect(m.nomes()).not.toContain('commission.findMany');
  });
});

describe('webhook do Asaas — clínica igual com e sem outra conta de laboratório', () => {
  const casos: Array<[string, Record<string, any>, string]> = [
    ['parcela paga', { installment_id: 'parc-1' }, 'RECEIVED'],
    ['pagamento confirmado', {}, 'CONFIRMED'],
    ['entrada (SINAL) paga', { kind: 'SINAL' }, 'RECEIVED'],
    ['cancelada', {}, 'DELETED'],
    ['estornada', {}, 'REFUNDED'],
  ];
  it.each(casos)('%s', async (_nome, over, status) => {
    const c = cobranca(CLINICA, over);
    const antes = webhook([], c);
    await antes.svc.handleWebhook(evento(c, status));
    const efeitosAntes = antes.efeitos();
    jest.restoreAllMocks();
    calar();
    const depois = webhook([LAB], c);
    await depois.svc.handleWebhook(evento(c, status));
    expect(depois.efeitos()).toEqual(efeitosAntes);
  });

  it('a clínica segue com todos os ganchos (promoção, comissão, venda feita, volta a lead)', async () => {
    const pago = cobranca(CLINICA, { installment_id: 'parc-1' });
    const m = webhook([LAB], pago);
    await m.svc.handleWebhook(evento(pago, 'RECEIVED'));
    expect(m.promove.mock.calls).toEqual([[pago.id, CLINICA, 'parcela paga (Asaas)']]);
    expect(m.vendas.notifyVendaFeitaOnPaid.mock.calls).toEqual([[pago.id]]);
    expect(m.nomes()).toContain('commission.updateMany');

    jest.restoreAllMocks();
    calar();
    const cancelada = cobranca(CLINICA);
    const n = webhook([LAB], cancelada);
    await n.svc.handleWebhook(evento(cancelada, 'DELETED'));
    expect(n.rebaixa.mock.calls).toEqual([[cancelada]]);
  });
});

describe('baixa na recepção (registerClinicReceipt) — o mesmo freio do pagamento', () => {
  it('laboratório: marca recebida, lança a receita e promove o contato, sem liberar comissão', async () => {
    const c = cobranca(LAB);
    const m = webhook([LAB], c);
    const r = await m.svc.registerClinicReceipt(c.external_id, { userId: 'u-recep', origem: 'receive-in-cash' });
    expect(r).toMatchObject({ ok: true, charge_id: c.id });
    expect(m.de('paymentGatewayCharge.update')[0].data).toMatchObject({ received_in_cash: true, status: 'RECEIVED' });
    expect(m.de('financialTransaction.create')).toHaveLength(1);
    expect(m.promove.mock.calls).toEqual([[c.id, LAB, 'pagamento na clínica']]);
    expect(m.nomes()).not.toContain('commission.findMany');
  });

  it('clínica: mesmas operações e a mesma promoção com e sem outra conta de laboratório', async () => {
    const c = cobranca(CLINICA);
    const antes = webhook([], c);
    await antes.svc.registerClinicReceipt(c.external_id, { userId: 'u-recep', origem: 'receive-in-cash' });
    const efeitosAntes = antes.efeitos();
    jest.restoreAllMocks();
    calar();
    const depois = webhook([LAB], c);
    await depois.svc.registerClinicReceipt(c.external_id, { userId: 'u-recep', origem: 'receive-in-cash' });
    expect(depois.efeitos()).toEqual(efeitosAntes);
    expect(depois.promove.mock.calls).toEqual([[c.id, CLINICA, 'pagamento na clínica']]);
    expect(depois.nomes()).toContain('commission.updateMany');
  });
});

describe('importar clientes do Asaas — rotina de clínica', () => {
  it('laboratório: recusado antes de ler o Asaas (não cria contato como cliente)', async () => {
    const m = webhook([LAB], null);
    const erro = await m.svc.importAsaasCustomers(LAB).catch((e) => e);
    expect(erro).toBeInstanceOf(ForbiddenException);
    expect(erro.getResponse()).toMatchObject({ code: 'VERTICAL_DENIED' });
    expect(m.asaas.listCustomers).not.toHaveBeenCalled();
    expect(m.ops).toEqual([]);
  });

  it('clínica: a mesma leitura do Asaas com e sem outra conta de laboratório', async () => {
    const antes = webhook([], null);
    const r1 = await antes.svc.importAsaasCustomers(CLINICA);
    const depois = webhook([LAB], null);
    const r2 = await depois.svc.importAsaasCustomers(CLINICA);
    expect(r2).toEqual(r1);
    expect(depois.asaas.listCustomers.mock.calls).toEqual(antes.asaas.listCustomers.mock.calls);
    expect(depois.ops).toEqual(antes.ops);
  });
});

// ─── Avisos ao cliente (serviço carregado da fonte: import dinâmico vira require) ─
function avisos(labs: string[], tenantDoContato: string, respostas: Respostas = {}) {
  const b = banco(labs, {
    'paymentGatewayCustomer.findFirst': () => ({
      lead: { id: 'lead-1', name: 'Dr. Exemplo da Silva', phone: '82988887777', tenant_id: tenantDoContato },
    }),
    'tenant.findUnique': ({ where }: any) => ({ name: `Conta ${where.id}` }),
    'paymentNotifyDedup.create': () => ({}),
    ...respostas,
  });
  const envios: Array<{ para: string; texto: string; chip: string | null }> = [];
  const whatsapp: any = {
    getInstanceForPurpose: async (_t: string, p: string) => `chip-${p.toLowerCase()}`,
    sendText: async (para: string, texto: string, chip?: string) => {
      envios.push({ para, texto, chip: chip ?? null });
      return { key: { id: `wamid-${envios.length}` } };
    },
  };
  const svc = new GatewayDaFonte(b.prisma, {} as any, whatsapp, {} as any, {} as any, {} as any, {} as any);
  jest.spyOn(svc as any, 'findOrCreateFinanceiroConversation').mockResolvedValue({ id: 'conv-fin', instance_name: 'chip-financeiro' });
  return { svc, envios, ...b };
}
const pagamento = (tenant: string, description: string) => ({
  id: `pay_${tenant}`,
  customer: `cus_${tenant}`,
  value: 350,
  billingType: 'PIX',
  description,
});

describe('confirmação de pagamento ao cliente (texto neutro, descrição sem clínica)', () => {
  // [descrição gravada na cobrança, como o cliente do laboratório lê na confirmação]
  const CASOS: Array<[string, string]> = [
    [`Plano de tratamento odontológico — Dr. Exemplo (3x) [plan:${PLANO}]`, '(Trabalho de prótese — Dr. Exemplo (3x))'],
    [`Entrada Financiamento Banco PASSOS — Dr. Exemplo [plan:${PLANO}]`, '(Entrada — Dr. Exemplo)'],
    [`Parcelado Financiamento Banco PASSOS — Dr. Exemplo (10x) [plan:${PLANO}]`, '(Parcelado — Dr. Exemplo (10x))'],
    [`Plano de tratamento — Dr. Exemplo (PIX) [plan:${PLANO}]`, '(Trabalho de prótese — Dr. Exemplo (PIX))'],
    [`Parcela 2/3 — Clínica Sorriso Exemplo [plan:${PLANO}]`, '(Parcela 2/3 — Clínica Sorriso Exemplo)'],
  ];
  const DESCRICOES = CASOS.map(([d]) => d);

  it.each(CASOS)('laboratório: %s', async (descricao, comoLe) => {
    const m = avisos([LAB], LAB);
    await (m.svc as any).notifyClientPaymentReceived(pagamento(LAB, descricao), { tenant_id: LAB, amount: 350, billing_type: 'PIX' });
    expect(m.envios).toHaveLength(1);
    const { texto, chip, para } = m.envios[0];
    expect(chip).toBe('chip-financeiro');
    expect(para).toBe(TEL.slice(0, 4) + TEL.slice(5));
    expect(texto).toContain('Pagamento Confirmado');
    expect(texto).toContain('Olá, Dr.!');
    expect(texto).toContain(` via PIX no valor de *${(350).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })}* ${comoLe}.`);
    expect(texto).not.toMatch(PALAVRAS_DE_CLINICA);
    expect(texto).not.toContain('[plan:');
  });

  it('laboratório: texto salvo com palavra de clínica não vai — sai o padrão (neutro)', async () => {
    const salvo = JSON.stringify({ template: 'Olá {nome}! Recebemos o pagamento do seu tratamento na {clinica}.' });
    const m = avisos([LAB], LAB, {
      'globalSetting.findUnique': ({ where }: any) => (String(where.key).includes('PAYMENT_CONFIRMATION') ? null : { value: salvo }),
    });
    await (m.svc as any).notifyClientPaymentReceived(pagamento(LAB, 'Parcela 1/3 — Dr. Exemplo'), { tenant_id: LAB, amount: 350, billing_type: 'PIX' });
    expect(m.envios[0].texto).toContain('Pagamento Confirmado');
    expect(m.envios[0].texto).not.toMatch(PALAVRAS_DE_CLINICA);
    expect(registrou('confirmacao')).toBe(true);
  });

  // {clinica} sem o nome da conta (leitura falhou, sem conta ou nome vazio): o laboratório
  // assina com o nome padrão dele; a clínica continua com "a clínica".
  const SALVO_COM_NOME = JSON.stringify({ template: 'Obrigado! Equipe {clinica}.' });
  const semNomeDaConta: Array<[string, (args: any) => any]> = [
    ['conta não encontrada', () => null],
    ['nome vazio', () => ({ name: '' })],
    [
      'leitura falhou',
      () => {
        throw new Error('banco indisponível');
      },
    ],
  ];
  const comTextoSalvo = (tenant: (args: any) => any): Respostas => ({
    'globalSetting.findUnique': ({ where }: any) => (String(where.key).includes('PAYMENT_CONFIRMATION') ? null : { value: SALVO_COM_NOME }),
    'tenant.findUnique': tenant,
  });

  it.each(semNomeDaConta)('laboratório sem o nome da conta (%s): {clinica} vira "o laboratório"', async (_caso, tenant) => {
    expect(temVocabularioDeClinica(semVariaveis('Obrigado! Equipe {clinica}.'))).toBe(false); // o texto salvo vale
    const m = avisos([LAB], LAB, comTextoSalvo(tenant));
    await (m.svc as any).notifyClientPaymentReceived(pagamento(LAB, 'Parcela 1/3 — Dr. Exemplo'), { tenant_id: LAB, amount: 350, billing_type: 'PIX' });
    expect(m.envios).toHaveLength(1);
    expect(m.envios[0].texto).toBe('Obrigado! Equipe o laboratório.');
    expect(m.envios[0].texto).toBe(`Obrigado! Equipe ${NOME_PADRAO_DO_LABORATORIO}.`);
    expect(m.envios[0].texto).not.toContain('a clínica');
    expect(m.de('tenant.findUnique')).toEqual([{ where: { id: LAB }, select: { name: true } }]);
  });

  it('laboratório com o nome da conta: {clinica} vira o nome', async () => {
    const m = avisos([LAB], LAB, comTextoSalvo(() => ({ name: 'Laboratório Exemplo' })));
    await (m.svc as any).notifyClientPaymentReceived(pagamento(LAB, 'Parcela 1/3 — Dr. Exemplo'), { tenant_id: LAB, amount: 350, billing_type: 'PIX' });
    expect(m.envios[0].texto).toBe('Obrigado! Equipe Laboratório Exemplo.');
  });

  it.each(semNomeDaConta)('clínica sem o nome da conta (%s): continua "a clínica", com e sem outra conta de laboratório', async (_caso, tenant) => {
    const dados = pagamento(CLINICA, 'Parcela 1/3 — Dr. Exemplo');
    const cob = { tenant_id: CLINICA, amount: 350, billing_type: 'PIX' };
    const antes = avisos([], CLINICA, comTextoSalvo(tenant));
    await (antes.svc as any).notifyClientPaymentReceived(dados, cob);
    const depois = avisos([LAB], CLINICA, comTextoSalvo(tenant));
    await (depois.svc as any).notifyClientPaymentReceived(dados, cob);
    expect(antes.envios[0].texto).toBe('Obrigado! Equipe a clínica.');
    expect(depois.envios).toEqual(antes.envios);
    expect(depois.ops).toEqual(antes.ops);
  });

  it('sem cobrança local (só o cliente do Asaas): o contato do laboratório recebe o texto neutro', async () => {
    const m = avisos([LAB], LAB, { 'paymentGatewayCharge.findUnique': () => null });
    await m.svc.handleWebhook({
      event: 'PAYMENT_RECEIVED',
      payment: { ...pagamento(LAB, `Plano de tratamento odontológico — Dr. Exemplo (3x) [plan:${PLANO}]`), status: 'RECEIVED', paymentDate: HOJE },
    });
    expect(m.envios).toHaveLength(1);
    expect(m.envios[0].texto).not.toMatch(PALAVRAS_DE_CLINICA);
    expect(m.envios[0].texto).toContain('Trabalho de prótese — Dr. Exemplo (3x)');
  });

  it.each(DESCRICOES)('clínica igual com e sem outra conta de laboratório: %s', async (descricao) => {
    const dados = pagamento(CLINICA, descricao);
    const cob = { tenant_id: CLINICA, amount: 350, billing_type: 'PIX' };
    const antes = avisos([], CLINICA);
    await (antes.svc as any).notifyClientPaymentReceived(dados, cob);
    const depois = avisos([LAB], CLINICA);
    await (depois.svc as any).notifyClientPaymentReceived(dados, cob);
    expect(depois.envios).toEqual(antes.envios);
    expect(depois.ops).toEqual(antes.ops);
    // A clínica continua lendo a descrição dela, sem troca de palavras.
    expect(depois.envios[0].texto).toContain(descricao.replace(` [plan:${PLANO}]`, ''));
  });
});

describe('aviso de cobrança cancelada / estornada ao cliente', () => {
  const DESCRICAO = `Plano de tratamento odontológico — Dr. Exemplo (3x) [plan:${PLANO}]`;

  it.each(['DELETED', 'REFUNDED'])('laboratório (%s): texto neutro e o telefone do cadastro fica como está', async (status) => {
    const m = avisos([LAB], LAB);
    await (m.svc as any).notifyClientChargeDeleted(pagamento(LAB, DESCRICAO), { tenant_id: LAB, amount: 350 }, status);
    expect(m.envios).toHaveLength(1);
    expect(m.envios[0].texto).not.toMatch(PALAVRAS_DE_CLINICA);
    expect(m.envios[0].texto).toContain('Trabalho de prótese — Dr. Exemplo (3x)');
    expect(m.de('lead.update')).toEqual([]);
    expect(registrou('telefone')).toBe(true);
  });

  it.each(['DELETED', 'REFUNDED'])('clínica (%s): igual com e sem outra conta de laboratório (inclusive o telefone)', async (status) => {
    const dados = pagamento(CLINICA, DESCRICAO);
    const antes = avisos([], CLINICA);
    await (antes.svc as any).notifyClientChargeDeleted(dados, { tenant_id: CLINICA, amount: 350 }, status);
    const depois = avisos([LAB], CLINICA);
    await (depois.svc as any).notifyClientChargeDeleted(dados, { tenant_id: CLINICA, amount: 350 }, status);
    expect(depois.envios).toEqual(antes.envios);
    expect(depois.ops).toEqual(antes.ops);
    expect(depois.de('lead.update')).toEqual([{ where: { id: 'lead-1' }, data: { phone: TEL.slice(0, 4) + TEL.slice(5) } }]);
  });
});

// ─── Emissão da cobrança (TreatmentPlanBillingService): descrição que vai ao Asaas ─
/**
 * Plano ativo de R$ 900 do cliente "Dr. Exemplo". As cobranças gravadas ficam em
 * `criadas` e o findFirst procura nelas pelo mesmo `description contains` que o serviço
 * usa (idempotência por plano). O Asaas devolve 3 parcelas-filhas no carnê.
 */
function emissao(labs: string[], tenant: string, respostas: Respostas = {}) {
  const plano = {
    id: PLANO,
    status: 'ACTIVE',
    total_value: 900,
    patient_id: 'pac-1',
    patient: { id: 'pac-1', tenant_id: tenant, name: 'Dr. Exemplo' },
  };
  const criadas: any[] = [];
  const b = banco(labs, {
    'treatmentPlan.findUnique': () => plano,
    'paymentGatewayCharge.create': (a: any) => {
      const row = { id: `cob-${criadas.length + 1}`, ...a.data };
      criadas.push(row);
      return row;
    },
    'paymentGatewayCharge.findFirst': ({ where }: any) =>
      criadas.find((c) => String(c.description).includes(where?.description?.contains ?? '\u0000')) ?? null,
    ...respostas,
  });
  let n = 0;
  const asaas = {
    createCharge: jest.fn(async (dados: any, _tenant?: string) => {
      n += 1;
      return { id: `pay_${n}`, status: 'PENDING', installment: dados.installmentCount ? `ins_${n}` : undefined, bankSlipUrl: null, invoiceUrl: null, nossoNumero: null };
    }),
    listCharges: jest.fn(async () => ({
      data: ['2026-11-21', '2026-12-21', '2027-01-21'].map((dueDate, i) => ({ id: `parc_${i + 1}`, installmentNumber: i + 1, value: 200, dueDate, status: 'PENDING' })),
    })),
    getPixQrCode: jest.fn(async () => null),
    hasOwnAccount: jest.fn(async () => true),
  };
  const gateway = { ensureCustomerForPatient: jest.fn(async () => ({ external_id: 'cus_exemplo' })) };
  const svc = new TreatmentPlanBillingService(b.prisma, gateway as any, asaas as any);
  const noAsaas = () => asaas.createCharge.mock.calls.map(([d]) => d.description as string);
  const noBanco = () => criadas.map((c) => c.description as string);
  const efeitos = () => ({ ops: [...b.ops], asaas: [...asaas.createCharge.mock.calls], gateway: [...gateway.ensureCustomerForPatient.mock.calls] });
  return { svc, asaas, criadas, noAsaas, noBanco, efeitos, ...b };
}
const TAG = `[plan:${PLANO}]`;
const FINANCIAMENTO = { downPaymentValue: 300, signalValue: 100, signalMethod: 'PIX' as const, installmentCount: 3, installmentValue: 200 };
type Emissao = ReturnType<typeof emissao>;
const EMISSOES: Array<[string, (m: Emissao, tenant: string) => Promise<unknown>]> = [
  ['carnê do plano inteiro', (m, t) => m.svc.createInstallmentCharges(PLANO, t, { billingType: 'BOLETO', installmentCount: 3 })],
  ['parcelamento com entrada', (m, t) => m.svc.createFinancingCharges(PLANO, t, FINANCIAMENTO)],
  ['à vista no Asaas', (m, t) => m.svc.createSimpleCharge(PLANO, t, { billingType: 'BOLETO', value: 900 })],
  ['cartão 3x no Asaas', (m, t) => m.svc.createSimpleCharge(PLANO, t, { billingType: 'CREDIT_CARD', value: 900, installmentCount: 3 })],
  ['recebido no balcão (local)', (m, t) => m.svc.createSimpleCharge(PLANO, t, { billingType: 'PIX', value: 900, receivedInClinic: true })],
];

describe('emissão da cobrança no laboratório — descrição do boleto/fatura sem texto de clínica', () => {
  it('carnê do plano inteiro: "Trabalho de prótese" no Asaas e no banco, com o (Nx) e a tag do plano', async () => {
    const m = emissao([LAB], LAB);
    await m.svc.createInstallmentCharges(PLANO, LAB, { billingType: 'BOLETO', installmentCount: 3 });
    expect(m.noAsaas()).toEqual([`Trabalho de prótese — Dr. Exemplo (3x) ${TAG}`]);
    expect(m.noBanco()).toEqual([`Trabalho de prótese — Dr. Exemplo (3x) ${TAG}`]);
    // O plano continua achando a cobrança: a 2ª emissão é recusada pela mesma busca.
    await expect(m.svc.createInstallmentCharges(PLANO, LAB, { billingType: 'BOLETO', installmentCount: 3 })).rejects.toThrow('Plano ja possui cobranca gerada');
    expect(m.asaas.createCharge).toHaveBeenCalledTimes(1);
  });

  it('parcelamento com entrada: sinal, entrada e carnê sem o nome do financiamento da clínica', async () => {
    const m = emissao([LAB], LAB);
    await m.svc.createFinancingCharges(PLANO, LAB, FINANCIAMENTO);
    expect(m.noAsaas()).toEqual([
      `Sinal de fechamento — Dr. Exemplo ${TAG}`,
      `Entrada — Dr. Exemplo ${TAG}`,
      `Parcelado — Dr. Exemplo (3x) ${TAG}`,
    ]);
    // O que fica gravado no banco não muda (já era neutro).
    expect(m.noBanco()).toEqual([
      `Sinal (1/1) — Dr. Exemplo ${TAG}`,
      `Entrada (1/1) — Dr. Exemplo ${TAG}`,
      `Parcela 1/3 — Dr. Exemplo ${TAG}`,
      `Parcela 2/3 — Dr. Exemplo ${TAG}`,
      `Parcela 3/3 — Dr. Exemplo ${TAG}`,
    ]);
  });

  it('parcelamento com entrada: "Sinal", "Entrada" e "Parcelado" continuam na descrição (a emissão não repete o que já existe)', async () => {
    const descricoes = [`Sinal de fechamento — Dr. Exemplo ${TAG}`, `Entrada — Dr. Exemplo ${TAG}`, `Parcelado — Dr. Exemplo (3x) ${TAG}`];
    const m = emissao([LAB], LAB, {
      'paymentGatewayCharge.findMany': () => descricoes.map((description) => ({ kind: null, description })),
    });
    await m.svc.createFinancingCharges(PLANO, LAB, FINANCIAMENTO);
    expect(m.asaas.createCharge).not.toHaveBeenCalled();
    expect(m.criadas).toEqual([]);
  });

  it.each([
    ['à vista no Asaas', { billingType: 'BOLETO' as const, value: 900 }, `Trabalho de prótese — Dr. Exemplo (à vista) ${TAG}`, 1],
    ['cartão 3x no Asaas', { billingType: 'CREDIT_CARD' as const, value: 900, installmentCount: 3 }, `Trabalho de prótese — Dr. Exemplo (3x) ${TAG}`, 1],
    ['recebido no balcão (local)', { billingType: 'PIX' as const, value: 900, receivedInClinic: true }, `Trabalho de prótese — Dr. Exemplo (à vista) ${TAG}`, 0],
  ])('cobrança simples (%s): "Trabalho de prótese"', async (_caso, opcoes, esperado, vezesNoAsaas) => {
    const m = emissao([LAB], LAB);
    await m.svc.createSimpleCharge(PLANO, LAB, opcoes);
    expect(m.noBanco()).toEqual([esperado]);
    expect(m.noAsaas()).toEqual(vezesNoAsaas ? [esperado] : []);
  });

  it.each(EMISSOES)('%s: nada de texto de clínica, a tag do plano no fim e a confirmação mostra o mesmo texto', async (_caso, emitir) => {
    const m = emissao([LAB], LAB);
    await emitir(m, LAB);
    const todas = [...m.noAsaas(), ...m.noBanco()];
    expect(todas.length).toBeGreaterThan(0);
    for (const d of todas) {
      expect(d).not.toMatch(PALAVRAS_DE_CLINICA);
      expect(d.endsWith(` ${TAG}`)).toBe(true);
      // Mesma leitura do plano que o aceite da proposta faz na descrição.
      expect(d.match(/\[plan:([0-9a-f-]{36})\]/i)?.[1]).toBe(PLANO);
      // A confirmação de pagamento do laboratório não precisa trocar nada.
      expect(descricaoParaClienteDoLaboratorio(stripInternalTags(d))).toBe(stripInternalTags(d));
    }
  });
});

describe('emissão da cobrança na clínica — igual com e sem outra conta de laboratório', () => {
  it.each(EMISSOES)('%s', async (_caso, emitir) => {
    const antes = emissao([], CLINICA);
    const r1 = await emitir(antes, CLINICA);
    const efeitosAntes = antes.efeitos();
    const depois = emissao([LAB], CLINICA);
    const r2 = await emitir(depois, CLINICA);
    expect(depois.efeitos()).toEqual(efeitosAntes);
    expect(r2).toEqual(r1);
  });

  it('as descrições da clínica continuam as de antes', async () => {
    const descricoes = async (emitir: (m: Emissao, t: string) => Promise<unknown>) => {
      const m = emissao([LAB], CLINICA);
      await emitir(m, CLINICA);
      return m.noAsaas();
    };
    const lidas: string[][] = [];
    for (const [, emitir] of EMISSOES.slice(0, 4)) lidas.push(await descricoes(emitir));
    const [carne, financiamento, avista, cartao] = lidas;
    expect(carne).toEqual([`Plano de tratamento odontológico — Dr. Exemplo (3x) ${TAG}`]);
    expect(financiamento).toEqual([
      `Sinal de fechamento — Dr. Exemplo ${TAG}`,
      `Entrada Financiamento Banco PASSOS — Dr. Exemplo ${TAG}`,
      `Parcelado Financiamento Banco PASSOS — Dr. Exemplo (3x) ${TAG}`,
    ]);
    expect(avista).toEqual([`Plano de tratamento — Dr. Exemplo (à vista) ${TAG}`]);
    expect(cartao).toEqual([`Plano de tratamento — Dr. Exemplo (3x) ${TAG}`]);
  });
});

// ─── E-mails automáticos (EmailAutomationService.dispatch) ───────────────────
function correio(labs: string[], respostas: Respostas = {}) {
  const b = banco(labs, { 'tenant.findUnique': ({ where }: any) => ({ name: `Conta ${where.id}`, email: null }), ...respostas });
  const mail = { renderTemplate: jest.fn((o: any) => `<html>${o.title}|${o.bodyHtml}</html>`), send: jest.fn(async () => true) };
  return { svc: new EmailAutomationService(b.prisma, mail as any), mail, ...b };
}
const varsDe = (key: string) =>
  Object.fromEntries(EMAIL_EVENTS.find((e) => e.key === key)!.variables.filter((v) => v.name !== 'clinica_nome').map((v) => [v.name, v.sample]));

describe('e-mails automáticos na conta de laboratório', () => {
  it('cobrança (gerada, vence amanhã, paga, atrasada): texto neutro, sai igual', async () => {
    const m = correio([LAB]);
    for (const key of ['cobranca_criada', 'vencimento_proximo', 'pagamento_confirmado', 'pagamento_atrasado']) {
      await expect(m.svc.dispatch(key, LAB, 'cliente@exemplo.test', varsDe(key))).resolves.toBe(true);
    }
    expect(m.mail.send).toHaveBeenCalledTimes(4);
    for (const [envio] of m.mail.send.mock.calls as any[]) {
      expect(semVariaveis(envio.subject)).not.toMatch(PALAVRAS_DE_CLINICA);
    }
  });

  it.each(['agendamento_criado', 'agendamento_remarcado'])('%s (texto de consulta): não sai', async (key) => {
    const m = correio([LAB]);
    await expect(m.svc.dispatch(key, LAB, 'cliente@exemplo.test', varsDe(key))).resolves.toBe(false);
    expect(m.mail.send).not.toHaveBeenCalled();
    expect(m.mail.renderTemplate).not.toHaveBeenCalled();
    expect(registrou('email')).toBe(true);
  });

  it('texto salvo com palavra de clínica num e-mail de cobrança: não sai', async () => {
    const m = correio([LAB], {
      'tenantEmailTemplate.findUnique': () => ({ enabled: true, subject: 'Pagamento confirmado', body: 'Recebemos o pagamento do seu tratamento.' }),
    });
    await expect(m.svc.dispatch('pagamento_confirmado', LAB, 'cliente@exemplo.test', varsDe('pagamento_confirmado'))).resolves.toBe(false);
    expect(m.mail.send).not.toHaveBeenCalled();
  });

  it('clínica: todos os e-mails iguais com e sem outra conta de laboratório', async () => {
    const enviar = async (m: ReturnType<typeof correio>) => {
      const r: boolean[] = [];
      for (const ev of EMAIL_EVENTS) r.push(await m.svc.dispatch(ev.key, CLINICA, 'paciente@exemplo.test', varsDe(ev.key)));
      return r;
    };
    const antes = correio([]);
    const r1 = await enviar(antes);
    const depois = correio([LAB]);
    const r2 = await enviar(depois);
    expect(r1.every(Boolean)).toBe(true);
    expect(r2).toEqual(r1);
    expect(depois.mail.send.mock.calls).toEqual(antes.mail.send.mock.calls);
    expect(depois.ops).toEqual(antes.ops);
  });
});

// ─── Funções puras do texto do laboratório ───────────────────────────────────
describe('cobranca-laboratorio: texto sem vocabulário de clínica', () => {
  it.each([
    ['Plano de tratamento odontológico — Ana (3x)', 'Trabalho de prótese — Ana (3x)'],
    ['PLANO DE TRATAMENTO ODONTOLÓGICO — Ana', 'Trabalho de prótese — Ana'],
    ['Plano de tratamento — Ana (PIX)', 'Trabalho de prótese — Ana (PIX)'],
    ['Entrada Financiamento Banco PASSOS — Ana', 'Entrada — Ana'],
    ['Parcelado Financiamento Banco PASSOS — Ana (12x)', 'Parcelado — Ana (12x)'],
    ['Sinal de fechamento — Ana', 'Sinal de fechamento — Ana'],
    ['Parcela 2/3 — Clínica Sorriso', 'Parcela 2/3 — Clínica Sorriso'],
    ['Consulta de avaliação — Ana', ''],
    ['Retorno do paciente — Ana', ''],
    ['', ''],
  ])('%s → %s', (de, para) => {
    expect(descricaoParaClienteDoLaboratorio(de)).toBe(para);
  });

  it('palavras: paciente, consulta, tratamento, odontológico e TCLE contam; clínica, dentista e "paciente do caso" não', () => {
    for (const t of ['Paciente', 'CONSULTAS', 'tratamento', 'Odontológico', 'tcle', 'prontuário', 'Banco Passos']) {
      expect([t, temVocabularioDeClinica(t)]).toEqual([t, true]);
    }
    for (const t of ['Clínica Sorriso', 'Dentista', 'paciente do caso', 'consultório', 'Trabalho de prótese', null, '']) {
      expect([t, temVocabularioDeClinica(t)]).toEqual([t, false]);
    }
  });

  it('semVariaveis tira {{var}} e {var}', () => {
    const t = semVariaveis('Olá, {{paciente_nome}}! Consulta {nome} na {{ clinica_nome }}');
    expect(t.replace(/\s+/g, ' ').trim()).toBe('Olá, ! Consulta na');
    // O nome que entra na variável não conta: só o texto fixo do modelo.
    expect(temVocabularioDeClinica(semVariaveis('Olá, {{paciente_nome}}! Recebemos {valor}.'))).toBe(false);
  });
});

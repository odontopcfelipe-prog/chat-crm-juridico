/**
 * F6 do laboratório — portões do QuotesService na aba Propostas e na montagem do orçamento:
 *   - aprovar e cobrar com recebimento manual (espécie, PIX em conta, PIX ou cartão na
 *     maquineta): no laboratório o CPF/CNPJ do cliente é opcional, o trabalho nasce
 *     ACTIVE sem TCLE e espera o Validar do Financeiro. PIX online e boleto continuam
 *     exigindo documento. Na clínica, o CPF continua obrigatório, igual a hoje;
 *   - financiamento aprovado (decision_id/source): recusado no laboratório antes do aceite;
 *   - elemento do item: só numeração FDI ou vazio no laboratório; a clínica aceita 'SUP'.
 * E a lista dos textos da clínica que a F6 tocou, com a contagem de d2147294 (o texto da
 * clínica nesses arquivos não pode mudar).
 *
 * Sem banco: o Prisma é um gravador; dados de exemplo (repositório público).
 */
import * as fs from 'fs';
import * as path from 'path';
import { BadRequestException, Logger } from '@nestjs/common';
import { __limparCacheLabTenants } from '@crm/shared';
import { CODIGO_VERTICAL_NEGADA, negarLaboratorio } from '../common/lab-gate.util';
import { QuotesService } from './quotes.service';
import { TreatmentPlanBillingService } from './treatment-plan-billing.service';
import { LAB_ORCAMENTO_ITENS } from './lab-orcamento-textos';

const LAB = 'tenant-lab-exemplo';
const CLINICA = 'tenant-clinica-exemplo';
const USER = 'u-atendimento';
const PLANO = '22222222-2222-4222-8222-222222222222';
const AGORA = new Date('2026-10-30T14:00:00.000Z');
const SEM_CPF = 'Paciente sem CPF cadastrado. Edite o paciente e adicione o CPF antes de gerar cobranca.';

let logs: { nivel: string; msg: string }[] = [];
const registrou = (nivel: string, trecho: string) => logs.some((l) => l.nivel === nivel && l.msg.includes(trecho));

beforeEach(() => {
  logs = [];
  __limparCacheLabTenants();
  jest.useFakeTimers({
    now: AGORA,
    doNotFake: [
      'nextTick', 'setImmediate', 'clearImmediate', 'setTimeout', 'clearTimeout',
      'setInterval', 'clearInterval', 'queueMicrotask', 'hrtime', 'performance',
    ],
  });
  for (const nivel of ['log', 'warn', 'debug', 'error', 'verbose'] as const) {
    jest.spyOn(Logger.prototype, nivel).mockImplementation((msg: any) => {
      logs.push({ nivel, msg: String(msg) });
    });
  }
});
afterEach(() => {
  jest.restoreAllMocks();
  jest.useRealTimers();
});

const drenar = async () => {
  for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
};

type Op = [string, any];

/** Conta (laboratório ou clínica) com um orçamento em rascunho e o cliente sem/com documento. */
function montar(conta: string, labs: string[], cpf: string | null = null) {
  __limparCacheLabTenants();
  const ops: Op[] = [];
  const cliente = { id: 'cli-1', tenant_id: conta, name: 'Clínica Parceira Exemplo', cpf, phone: '5582900000001', lead_id: 'lead-1' };
  const quote: any = {
    id: 'q-1',
    quote_number: 42,
    status: 'DRAFT',
    sent_at: null,
    patient_id: cliente.id,
    total_value: 200,
    notes: null,
    items: [
      { procedure_id: 'proc-coroa', tooth_fdi: '11', quantity: 1, unit_price: 120, total_price: 120, notes: null, dentist_id: 'u-protetico' },
      { procedure_id: 'proc-placa', tooth_fdi: null, quantity: 1, unit_price: 80, total_price: 80, notes: null, dentist_id: 'u-protetico' },
    ],
    patient: cliente,
  };
  let plano: any = null;
  const cobrancas: any[] = [];

  const respostas: Record<string, (a: any) => any> = {
    'patient.findUnique': () => cliente,
    'paymentGatewayCharge.findUnique': (a) => (a.where?.id ? { transaction_id: null } : null),
    'paymentGatewayCharge.findFirst': () => null,
    'paymentGatewayCharge.create': (a) => {
      const row = { id: `cob-${cobrancas.length + 1}`, ...a.data };
      cobrancas.push(row);
      return row;
    },
    'quote.update': (a) => Object.assign(quote, a.data),
    'quote.findUnique': () => ({ status: quote.status }),
    'treatmentPlan.create': (a) => {
      const { items, ...dados } = a.data;
      plano = { id: PLANO, ...dados, items: items.create };
      return plano;
    },
    'treatmentPlan.findFirst': () => plano,
    'treatmentPlan.findUnique': () => (plano ? { ...plano, patient: cliente } : null),
    'treatmentPlan.update': (a) => Object.assign(plano, a.data),
    'procedure.findMany': () => [
      { id: 'proc-coroa', base_price: 120, tenant_id: conta, name: 'Coroa', category: 'PROTESE', specialty: null },
    ],
    'quoteItem.update': (a) => ({ id: a.where.id, ...a.data }),
  };
  const perfis = jest.fn(async () => labs.map((tenant_id) => ({ tenant_id })));
  const modelos: Record<string, any> = {};
  const prisma: any = new Proxy(
    {},
    {
      get(_a, modelo: string | symbol) {
        if (typeof modelo !== 'string' || modelo === 'then') return undefined;
        if (modelo === 'tenantBusinessProfile') return { findMany: perfis };
        if (modelo === '$transaction') return async (cb: any) => cb(prisma);
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
                if (metodo === 'updateMany' || metodo === 'deleteMany') return { count: 0 };
                if (metodo === 'create') return { id: `${modelo}-1`, ...(args?.data ?? {}) };
                return null;
              };
            },
          },
        );
        return modelos[modelo];
      },
    },
  );

  // TCLE: no laboratório o serviço de contrato recusa (função de clínica).
  const contrato = {
    sendForSignature: jest.fn(async () => {
      if (labs.includes(conta)) throw negarLaboratorio('TCLE');
      return { signingUrl: 'https://exemplo.invalid/assinar' };
    }),
  };
  const caixa = { registerClinicReceipt: jest.fn(async () => ({ ok: true, transaction_id: 'receita-1' })) };
  const billing = new TreatmentPlanBillingService(prisma, caixa as any, {} as any);
  const simples = jest.spyOn(billing, 'createSimpleCharge').mockResolvedValue({ charge: { id: 'cob-online' } } as any);
  const manual = jest.spyOn(billing, 'createManualReceipt');
  const service = new QuotesService(prisma, { get: jest.fn() } as any, undefined, undefined, undefined, contrato as any, billing);

  jest.spyOn(service, 'findOne').mockImplementation(async () => quote);
  jest.spyOn(service as any, 'shadowCheckApproveValue').mockResolvedValue(undefined);
  jest.spyOn(service as any, 'recordAffiliateReferral').mockImplementation(() => undefined);
  jest.spyOn(service as any, 'sendComprovantePagamento').mockResolvedValue(undefined);
  jest.spyOn(service as any, 'sendNegociacaoAprovada').mockResolvedValue(undefined);
  jest.spyOn(service as any, 'sendPixDelivery').mockResolvedValue(undefined);
  jest.spyOn(service as any, 'sendVendaFeita').mockResolvedValue(undefined);
  jest.spyOn(service as any, 'tryGraduateLeadToClientByQuote').mockImplementation(() => undefined);
  const pronto = jest.spyOn(service as any, 'ensurePatientReadyForBilling');
  const de = (op: string) => ops.filter(([o]) => o === op).map(([, a]) => a);
  return { service, ops, de, perfis, contrato, caixa, simples, manual, pronto, cobrancas, quote, plano: () => plano };
}

describe('aprovar e cobrar no laboratório (F6): documento opcional no recebimento manual', () => {
  it.each([
    ['espécie', { billing_type: 'PIX', manual_payment_method: 'DINHEIRO' }],
    ['PIX em conta', { billing_type: 'PIX', manual_payment_method: 'PIX' }],
    ['PIX na maquineta', { billing_type: 'PIX', manual_payment_method: 'PIX_MAQUININHA' }],
    ['cartão na maquineta', { billing_type: 'CREDIT_CARD', manual_payment_method: 'CARTAO' }],
  ])('%s, cliente sem CPF/CNPJ: passa, cobrança local, trabalho ACTIVE sem TCLE e na fila do Validar', async (_rotulo, forma) => {
    const m = montar(LAB, [LAB], null);
    const r: any = await m.service.approveAndBill('q-1', LAB, USER, { value: 200, ...forma } as any);
    await drenar();

    expect(m.pronto.mock.calls).toEqual([['cli-1', LAB, true]]);
    expect(m.manual).toHaveBeenCalledTimes(1);
    expect(m.simples).not.toHaveBeenCalled();
    expect(m.cobrancas).toHaveLength(1);
    expect(m.cobrancas[0]).toMatchObject({ gateway: 'CASH', tenant_id: LAB, amount: 200 });
    expect(m.caixa.registerClinicReceipt).toHaveBeenCalledTimes(1);
    expect(r).toMatchObject({ quote_id: 'q-1', plan_id: PLANO });

    // Trabalho: ACTIVE desde o aceite (sem TCLE) e sem a liberação do Financeiro.
    const plano = m.plano();
    expect(plano.status).toBe('ACTIVE');
    expect(plano.validated_by_financial_at ?? null).toBeNull();
    expect(m.de('treatmentPlan.updateMany')).toEqual([]);
    expect(registrou('log', '[LAB-GATE] tcle')).toBe(true);
    // Sem comissão de venda no laboratório.
    expect(m.de('commission.create')).toEqual([]);
  });

  it('PIX online e boleto sem documento: continuam recusando (o Asaas exige), sem aceitar nada', async () => {
    for (const billing_type of ['PIX', 'BOLETO'] as const) {
      const m = montar(LAB, [LAB], null);
      const e = await m.service.approveAndBill('q-1', LAB, USER, { billing_type, value: 200 }).catch((x) => x);
      expect(e).toBeInstanceOf(BadRequestException);
      expect(e.message).toBe(SEM_CPF);
      expect(m.pronto.mock.calls).toEqual([['cli-1', LAB, false]]);
      expect(m.de('treatmentPlan.create')).toEqual([]);
      expect(m.simples).not.toHaveBeenCalled();
    }
  });

  it('clínica (com e sem outra conta de laboratório), recebimento manual sem CPF: 400 com a mensagem de hoje', async () => {
    for (const labs of [[], [LAB]]) {
      const m = montar(CLINICA, labs, null);
      const e = await m.service
        .approveAndBill('q-1', CLINICA, USER, { billing_type: 'PIX', value: 200, manual_payment_method: 'DINHEIRO' })
        .catch((x) => x);
      expect(e).toBeInstanceOf(BadRequestException);
      expect(e.message).toBe(SEM_CPF);
      expect(m.pronto.mock.calls).toEqual([['cli-1', CLINICA, false]]);
      expect(m.de('treatmentPlan.create')).toEqual([]);
    }
  });

  it('clínica sem forma manual: não lê a lista de laboratórios antes do documento (o || vem antes da leitura)', async () => {
    const original = (QuotesService.prototype as any).ensurePatientReadyForBilling;
    const leiturasAteODocumento = async (conta: string, labs: string[], forma: Record<string, unknown>) => {
      const m = montar(conta, labs, '000.000.000-00');
      let leituras = -1;
      m.pronto.mockImplementation(async (...args: any[]) => {
        leituras = m.perfis.mock.calls.length;
        return original.apply(m.service, args);
      });
      await m.service.approveAndBill('q-1', conta, USER, { value: 200, ...forma } as any);
      await drenar();
      return { m, leituras };
    };
    const clinica = await leiturasAteODocumento(CLINICA, [LAB], { billing_type: 'PIX' });
    expect(clinica.leituras).toBe(0);
    expect(clinica.m.pronto.mock.calls).toEqual([['cli-1', CLINICA, false]]);
    expect(clinica.m.simples).toHaveBeenCalledTimes(1);
    // Com forma manual a leitura acontece antes (é ela que decide o documento opcional).
    const lab = await leiturasAteODocumento(LAB, [LAB], { billing_type: 'PIX', manual_payment_method: 'PIX' });
    expect(lab.leituras).toBe(1);
    // Mesmas operações no banco com e sem outra conta de laboratório.
    const antes = montar(CLINICA, [], '000.000.000-00');
    await antes.service.approveAndBill('q-1', CLINICA, USER, { billing_type: 'PIX', value: 200 });
    await drenar();
    expect(clinica.m.ops.map(([o]) => o)).toEqual(antes.ops.map(([o]) => o));
  });

  it('clínica com CPF e recebimento manual: mesmas operações com e sem outra conta de laboratório', async () => {
    const antes = montar(CLINICA, [], '000.000.000-00');
    await antes.service.approveAndBill('q-1', CLINICA, USER, { billing_type: 'PIX', value: 200, manual_payment_method: 'DINHEIRO' });
    await drenar();
    const depois = montar(CLINICA, [LAB], '000.000.000-00');
    await depois.service.approveAndBill('q-1', CLINICA, USER, { billing_type: 'PIX', value: 200, manual_payment_method: 'DINHEIRO' });
    await drenar();
    expect(depois.ops.map(([o]) => o)).toEqual(antes.ops.map(([o]) => o));
    expect(depois.pronto.mock.calls).toEqual([['cli-1', CLINICA, false]]);
    expect(depois.plano().status).toBe('ACTIVE');
    expect(depois.contrato.sendForSignature).toHaveBeenCalledWith(PLANO, CLINICA);
  });
});

describe('financiamento aprovado no laboratório (F6)', () => {
  const PAROU = new Error('parou-depois-do-portao');
  const dados = { down_payment_value: 0, installment_count: 6, installment_value: 40 };

  function montarFinanciamento(conta: string, labs: string[]) {
    const m = montar(conta, labs, '000.000.000-00');
    (m.service.findOne as jest.Mock).mockRejectedValue(PAROU);
    return m;
  }

  it('com decision_id ou source: VERTICAL_DENIED antes de aceitar (nem lê o orçamento)', async () => {
    for (const extra of [{ decision_id: 'dec-1' }, { source: 'internal' as const }]) {
      const m = montarFinanciamento(LAB, [LAB]);
      const e = await m.service.applyFinancing('q-1', LAB, USER, { ...dados, ...extra }).catch((x) => x);
      expect(e?.getResponse?.()?.code).toBe(CODIGO_VERTICAL_NEGADA);
      expect(m.service.findOne).not.toHaveBeenCalled();
      expect(m.ops).toEqual([]);
    }
  });

  it('sem decision_id (boleto parcelado/carnê): passa o portão no laboratório', async () => {
    const m = montarFinanciamento(LAB, [LAB]);
    await expect(m.service.applyFinancing('q-1', LAB, USER, dados)).rejects.toBe(PAROU);
  });

  it('clínica: com decision_id passa o portão (só a leitura cacheada); sem decision_id nem lê a lista', async () => {
    const com = montarFinanciamento(CLINICA, [LAB]);
    await expect(com.service.applyFinancing('q-1', CLINICA, USER, { ...dados, decision_id: 'dec-1' })).rejects.toBe(PAROU);
    expect(com.perfis).toHaveBeenCalledTimes(1);
    const sem = montarFinanciamento(CLINICA, [LAB]);
    await expect(sem.service.applyFinancing('q-1', CLINICA, USER, dados)).rejects.toBe(PAROU);
    expect(sem.perfis).not.toHaveBeenCalled();
  });
});

describe('elemento do item no laboratório: só FDI ou vazio (F6)', () => {
  function montarItem(conta: string, labs: string[]) {
    const m = montar(conta, labs);
    jest.spyOn(m.service as any, 'getItemEnsuringTenant').mockResolvedValue({
      id: 'qi-1', quote_id: 'q-1', quantity: 1, unit_price: 120, quote: { status: 'DRAFT' },
    });
    jest.spyOn(m.service as any, 'recalcTotals').mockResolvedValue(undefined);
    const resolver = (tooth_fdi: string | undefined) =>
      (m.service as any).resolveItems([{ procedure_id: 'proc-coroa', tooth_fdi, dentist_id: '' }], conta, null);
    const editar = (tooth_fdi: string | undefined) => m.service.updateItem('qi-1', conta, { tooth_fdi });
    return { ...m, resolver, editar };
  }

  it.each(['SUP', 'INF', '19', '56', '9', 'abc', ' 11'])('laboratório, elemento %p: 400 com o texto do laboratório (montar e editar)', async (dente) => {
    const m = montarItem(LAB, [LAB]);
    await expect(m.resolver(dente)).rejects.toThrow(LAB_ORCAMENTO_ITENS.elementoInvalido);
    await expect(m.editar(dente)).rejects.toThrow(LAB_ORCAMENTO_ITENS.elementoInvalido);
    expect(m.de('quoteItem.update')).toEqual([]);
  });

  it.each(['11', '18', '21', '38', '48', '51', '55', '65', '85', '', undefined])('laboratório, elemento %p: passa', async (dente) => {
    const m = montarItem(LAB, [LAB]);
    await expect(m.resolver(dente)).resolves.toHaveLength(1);
    await expect(m.editar(dente)).resolves.toBeDefined();
  });

  it("clínica com 'SUP' (com e sem outra conta de laboratório): passa como hoje", async () => {
    for (const labs of [[], [LAB]]) {
      const m = montarItem(CLINICA, labs);
      await expect(m.resolver('SUP')).resolves.toHaveLength(1);
      await expect(m.editar('SUP')).resolves.toBeDefined();
    }
  });

  it('clínica com elemento FDI ou vazio: nenhuma leitura nova (o formato é testado antes)', async () => {
    const m = montarItem(CLINICA, [LAB]);
    await m.resolver('16');
    await m.editar('16');
    await m.resolver(undefined);
    expect(m.perfis).not.toHaveBeenCalled();
  });
});

/**
 * Textos da clínica nos arquivos de servidor que a F6 tocou (sem pickBt nem LAB_ declarada,
 * por serem de muito movimento): a contagem de cada um tem de ser a de d2147294.
 */
const TEXTOS_DA_CLINICA: Record<string, Array<[string, number]>> = {
  'commercial.controller.ts': [
    ["'orcamento'", 1],
    ["'procedimentos'", 1],
  ],
  'quotes.service.ts': [
    ["'Paciente sem telefone cadastrado — adicione antes de enviar via WhatsApp.'", 1],
    ["'Nenhum WhatsApp Clínica/Comercial cadastrado — o orçamento não sai pelo número do Financeiro. Configure em Configurações › WhatsApp.'", 1],
    ["'Sem caixa de entrada Clínica/Comercial pra esse paciente — configure o WhatsApp da clínica.'", 1],
    ["'Servico de portal nao disponivel'", 1],
    ["'Servico de WhatsApp nao disponivel'", 1],
    ['`Oi ${firstName}! 👋\\n\\n`', 2],
    ["`Seu orçamento${clinica ? ` na clínica *${clinica}*` : ''} está pronto:\\n\\n`", 1],
    ['`📋 ${itemCount} procedimento(s)\\n`', 1],
    ['`💰 Total: ${formatBRL(quote.total_value)}\\n`', 1],
    ['`🎁 Desconto: ${formatBRL(quote.discount_value)}\\n`', 1],
    ['`📅 Válido até ${validUntil}\\n`', 1],
    ['`📎 ${attachmentCount} anexo(s) (fotos, exames)\\n`', 1],
    ['`\\nAcesse pra ver detalhes e aceitar:\\n${magic.link}\\n\\n`', 1],
    ['`Qualquer dúvida, é só responder por aqui. 😊`', 1],
    ["`Falha ao enviar WhatsApp: ${e?.message || 'erro desconhecido'}. Link gerado: ${magic.link}`", 1],
    ["'Enviado via WhatsApp'", 1],
    ["'Este plano já tem parcelas emitidas. Recarregue a página. Se precisar reemitir, cancele as cobranças ativas primeiro.'", 1],
    ["Aprovado pelo Banco PASSOS (decision_id: ${data.decision_id}, source: ${data.source || 'internal'})", 1],
    ["'Itens so podem ser editados em rascunhos'", 1],
    ["'Itens so podem ser adicionados em rascunhos'", 1],
    ['`Procedimento ${i.procedure_id} nao encontrado`', 1],
    ["'Plano de tratamento nao foi criado — verifique se o orcamento tem items'", 2],
    ['`Orcamento esta ${quote.status} — nao pode reenviar. Crie um novo orcamento se precisar.`', 1],
    ["'Paciente sem CPF cadastrado. Edite o paciente e adicione o CPF antes de gerar cobranca.'", 1],
  ],
  'quote-pdf.service.ts': [
    // O cabeçalho usa o nome da própria clínica (Tenant.name), nunca um nome fixo.
    ["'INSTITUTO ODONTO PASSOS'", 0],
    ["'Clinica Odontologica'", 1],
    ["'ORÇAMENTO'", 1],
    ["'PACIENTE'", 1],
    ["'PROCEDIMENTOS'", 1],
    ["'Procedimento'", 2],
    ["'Dente'", 1],
    ["'Assinatura do paciente'", 1],
    ["'Os arquivos podem ser visualizados no portal do paciente ou solicitados à recepção.'", 1],
    ["' (juros PagBank 3,59% a.m.)'", 1],
    ['(Banco PASSOS · 1,5% a.m.)', 1],
    ["'Sem consulta de crédito · pagamento imediato em boleto.'", 1],
    ['`Sem consulta de crédito · Valor original: ${formatBRL(total)}.`', 1],
    ["'Orcamento nao encontrado'", 1],
    ["'Orcamento nao pertence ao tenant'", 1],
  ],
  'quote-templates.service.ts': [
    ["'Nome do template e obrigatorio'", 1],
    ["'Template nao encontrado'", 1],
    ["'Acesso negado'", 2],
    ["'Orcamento nao encontrado'", 1],
    ["'Templates so podem ser aplicados em rascunhos'", 1],
  ],
};

describe('texto da clínica intocado nos arquivos do servidor da F6 (contagem de d2147294)', () => {
  it.each(Object.keys(TEXTOS_DA_CLINICA))('%s', (arq) => {
    const src = fs.readFileSync(path.join(__dirname, arq), 'utf8');
    const errados = TEXTOS_DA_CLINICA[arq]
      .map(([texto, n]) => [texto, n, src.split(texto).length - 1] as const)
      .filter(([, n, achou]) => n !== achou)
      .map(([texto, n, achou]) => `${texto}: esperava ${n}, achou ${achou}`);
    expect(errados).toEqual([]);
  });

  it('quotes.service.ts e commercial.controller.ts sem pickBt nem const LAB_ (só portões e texto importado)', () => {
    for (const arq of ['quotes.service.ts', 'commercial.controller.ts', 'quote-pdf.service.ts', 'quote-templates.service.ts']) {
      const src = fs.readFileSync(path.join(__dirname, arq), 'utf8');
      expect([arq, /\bpickBt\s*\(/.test(src), /\bconst\s+LAB_/.test(src)]).toEqual([arq, false, false]);
    }
  });
});

/**
 * F7 do laboratório — avisos de venda do fechamento: negociação aprovada (orçamento
 * aprovado), boleto da entrada e a fila fechamento-jobs que chama os dois.
 *
 * Até a F6 a conta de laboratório não recebia nenhum destes. Na F7 ela recebe pelo
 * MESMO caminho da clínica (mesmo toggle, mesma dedup, mesmo chip Financeiro com o
 * Clínica de reserva, mesma marca da peça do carnê), com o texto do laboratório:
 * "orçamento de trabalho aprovado", serviços no lugar de procedimentos, o PDF do
 * orçamento de trabalho e o primeiro nome sem "Dr."/"Dra.". O comprovante de pagamento
 * continua sem sair no laboratório (escondido na Central e recusado no servidor).
 *
 * Os casos da clínica vieram sem nenhuma mudança de lab-gate-automatismos.spec.ts e
 * lab-gate-eventos.spec.ts (9eb61bff): (a) sem laboratório cadastrado = mesmas
 * chamadas de antes; (b) clínica com OUTRA conta laboratório = igual ao (a).
 *
 * O banco de teste grava cada operação (menos a leitura da lista de laboratórios, a única
 * coisa nova para a clínica). Dados de exemplo (repositório público: nada real).
 */
import { Logger } from '@nestjs/common';
import { __limparCacheLabTenants, LAB_ENTRADA, LAB_NEGOCIACAO } from '@crm/shared';
import { QuotesService } from '../commercial/quotes.service';
import { FechamentoProcessor } from '../commercial/fechamento.processor';
import { invalidateAllSettings } from '../tenants/tenant-settings.helper';

// ─── Dados de exemplo (repositório público: nada real) ───────────────────────
const CLINICA = 'tenant-clinica';
const LAB = 'tenant-lab';
const AGORA = new Date('2026-10-21T15:00:00.000Z'); // quarta, 12:00 em Maceió
const TEL: Record<string, string> = {
  [CLINICA]: '5582900000001',
  [LAB]: '5582900000003',
};

// ─── Logs (o [LAB-GATE] é conferido) ─────────────────────────────────────────
let logs: { nivel: string; msg: string }[] = [];
beforeAll(() => {
  for (const nivel of ['log', 'warn', 'debug', 'error', 'verbose'] as const) {
    jest.spyOn(Logger.prototype, nivel).mockImplementation((msg: any) => {
      logs.push({ nivel, msg: String(msg) });
    });
  }
});
beforeEach(() => {
  logs = [];
  __limparCacheLabTenants();
  invalidateAllSettings();
  // Só o relógio é fixo; promessas e timers seguem reais.
  jest.useFakeTimers({
    now: AGORA,
    doNotFake: [
      'nextTick', 'setImmediate', 'clearImmediate', 'setTimeout', 'clearTimeout',
      'setInterval', 'clearInterval', 'queueMicrotask', 'hrtime', 'performance',
    ],
  });
});
afterEach(() => jest.useRealTimers());
const registrou = (nivel: string, trecho: string) => logs.some((l) => l.nivel === nivel && l.msg.includes(trecho));

// ─── Banco de teste (gravador) ───────────────────────────────────────────────

type Op = [string, any];
type Respostas = Record<string, (args: any) => any>;

/**
 * Grava `modelo.metodo(args)` em `ops` e responde pelo mapa (padrão: findMany=[],
 * count=0, updateMany=1, create = os dados com id, o resto null). A leitura da lista
 * de laboratórios (TenantBusinessProfile) não entra no rastro.
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
        if (modelo === '$transaction') return async (cb: any) => (typeof cb === 'function' ? cb(prisma) : Promise.all(cb));
        if (modelo.startsWith('$')) {
          return async (...args: any[]) => {
            ops.push([modelo, args.slice(1)]);
            return respostas[modelo] ? respostas[modelo](args) : modelo === '$queryRaw' ? [] : 0;
          };
        }
        modelos[modelo] ??= new Proxy(
          {},
          {
            get(_m, metodo: string | symbol) {
              if (typeof metodo !== 'string' || metodo === 'then') return undefined;
              return async (args: any) => {
                const op = `${modelo}.${metodo}`;
                // A leitura de contaDoLabPodeEnviar fica fora do rastro: conta ativa, sem congelamento.
                if (op === 'tenant.findUnique' && args?.select?.status) return { status: (respostas as any)['conta.status']?.(args) ?? 'ACTIVE' };
                if (op === 'globalSetting.findMany' && args?.where?.key?.in?.includes('LAB_FREEZE')) return [];
                ops.push([op, args]);
                const r = respostas[op];
                if (r) return r(args);
                if (metodo === 'findMany' || metodo === 'groupBy') return [];
                if (metodo === 'count') return 0;
                if (metodo === 'updateMany' || metodo === 'deleteMany' || metodo === 'createMany') return { count: 1 };
                if (metodo === 'create') return { id: `novo-${modelo}`, ...(args?.data ?? {}) };
                if (metodo === 'update' || metodo === 'upsert') return { id: args?.where?.id ?? `upd-${modelo}` };
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
  const nomes = () => ops.map(([o]) => o);
  return { prisma, ops, de, nomes, perfis };
}

// ─── fila fechamento-jobs ────────────────────────────────────────────────────

describe('Fechamento deferido (fila fechamento-jobs e fallback) — o laboratório recebe com o texto dele', () => {
  const TERMOS = { entrada: 500, parcelas: 10, valorParcela: 250, total: 3000, forma: 'BOLETO' };
  const PACIENTE = { name: 'Maria Exemplo', phone: TEL[CLINICA] };
  function montar(labs: string[], statusDaConta?: string) {
    const b = banco(labs, { 'treatmentPlan.findUnique': () => ({ patient: PACIENTE }), 'conta.status': () => statusDaConta });
    const svc = new QuotesService(b.prisma, {} as any, {} as any, {} as any);
    const negociacao = jest.spyOn(svc as any, 'sendNegociacaoAprovada').mockImplementation(async () => undefined);
    const entrada = jest.spyOn(svc as any, 'sendEntradaCobranca').mockImplementation(async () => undefined);
    return { svc, negociacao, entrada, processor: new FechamentoProcessor(svc), ...b };
  }

  it('laboratório com a conta suspensa depois do fechamento: nem a negociação nem a entrada saem', async () => {
    const m = montar([LAB], 'SUSPENDED');
    await m.svc.runFechamentoDeferido({ tenantId: LAB, planId: 'plano-lab', terms: TERMOS });
    expect(m.ops).toEqual([]);
    expect(m.negociacao).not.toHaveBeenCalled();
    expect(m.entrada).not.toHaveBeenCalled();
  });

  it('sem laboratório cadastrado: mesma consulta e os dois envios, como antes', async () => {
    const m = montar([]);
    await m.svc.runFechamentoDeferido({ tenantId: CLINICA, planId: 'plano-1', terms: TERMOS });
    expect(m.ops).toEqual([
      ['treatmentPlan.findUnique', { where: { id: 'plano-1' }, select: { patient: { select: { name: true, phone: true } } } }],
    ]);
    expect(m.negociacao.mock.calls).toEqual([[CLINICA, 'plano-1', PACIENTE, TERMOS]]);
    expect(m.entrada.mock.calls).toEqual([[CLINICA, 'plano-1', PACIENTE]]);
  });

  it('clínica com OUTRA conta laboratório (pela fila): igual', async () => {
    const antes = montar([]);
    await antes.processor.process({ name: 'deferido', id: 'f1', data: { tenantId: CLINICA, planId: 'plano-1', terms: TERMOS } } as any);
    const depois = montar([LAB]);
    await depois.processor.process({ name: 'deferido', id: 'f1', data: { tenantId: CLINICA, planId: 'plano-1', terms: TERMOS } } as any);
    expect(depois.ops).toEqual(antes.ops);
    expect(depois.negociacao.mock.calls).toEqual(antes.negociacao.mock.calls);
    expect(depois.entrada.mock.calls).toEqual(antes.entrada.mock.calls);
    expect(depois.negociacao).toHaveBeenCalledTimes(1);
  });

  it('laboratório (fila e fallback): a mesma consulta, a negociação e o boleto da entrada, como na clínica', async () => {
    const m = montar([LAB]);
    await m.processor.process({ name: 'deferido', id: 'f1', data: { tenantId: LAB, planId: 'plano-lab', terms: TERMOS } } as any);
    await m.svc.runFechamentoDeferido({ tenantId: LAB, planId: 'plano-lab', terms: TERMOS });
    const consulta = ['treatmentPlan.findUnique', { where: { id: 'plano-lab' }, select: { patient: { select: { name: true, phone: true } } } }];
    expect(m.ops).toEqual([consulta, consulta]);
    expect(m.negociacao.mock.calls).toEqual([
      [LAB, 'plano-lab', PACIENTE, TERMOS],
      [LAB, 'plano-lab', PACIENTE, TERMOS],
    ]);
    expect(m.entrada.mock.calls).toEqual([
      [LAB, 'plano-lab', PACIENTE],
      [LAB, 'plano-lab', PACIENTE],
    ]);
    expect(registrou('log', '[LAB-GATE] fechamento')).toBe(false);
  });
});


// ═════════════════════════════════════════════════════════════════════════════
// Mensagens do fechamento com texto de clínica (consumidor) e envio do orçamento
// ═════════════════════════════════════════════════════════════════════════════

describe('Fechamento — negociação aprovada e entrada com o texto do laboratório; comprovante não sai no laboratório', () => {
  const PACIENTE = (t: string) => ({ name: 'Maria Exemplo', phone: TEL[t] });
  function montar(labs: string[], ligados: string[]) {
    const b = banco(labs, {
      'globalSetting.findUnique': ({ where }) => (ligados.some((t) => where.key.endsWith(`_${t}`) && /ENABLED/.test(where.key)) ? { value: 'true' } : null),
      'tenant.findUnique': () => ({ name: 'Clínica Exemplo' }),
      'treatmentPlanItem.findMany': () => [{ quantity: 1, procedure: { name: 'Procedimento exemplo' } }],
      'paymentGatewayCharge.findMany': () => [],
    });
    const whatsapp = {
      getInstanceForPurpose: jest.fn(async (t: string, p: string) => `chip-${p.toLowerCase()}-${t}`),
      sendText: jest.fn(async (tel: string, ..._r: any[]) => ({ key: { id: `wamid-${tel}` } })),
      sendMedia: jest.fn(async (tel: string, ..._r: any[]) => ({ key: { id: `wamid-midia-${tel}` } })),
    };
    const svc = new QuotesService(b.prisma, { get: () => undefined } as any, whatsapp as any);
    return { svc: svc as any, whatsapp, ...b };
  }
  const TERMOS = { total: 1500, forma: 'PIX' };

  it('negociação aprovada, clínica sem laboratório: lê o toggle, manda e marca, como antes', async () => {
    const m = montar([], [CLINICA]);
    await m.svc.sendNegociacaoAprovada(CLINICA, 'plano-1', PACIENTE(CLINICA), TERMOS);
    expect(m.ops[0]).toEqual(['globalSetting.findUnique', { where: { key: `NEGOCIACAO_APROVADA_ENABLED_${CLINICA}` } }]);
    expect(m.whatsapp.sendText.mock.calls.map((c: any[]) => c[0])).toEqual([TEL[CLINICA]]);
    expect(m.de('auditLog.create').map((a: any) => a.data.entity)).toContain('NEGOCIACAO_APROVADA');
  });

  it('negociação aprovada, clínica com OUTRA conta laboratório: o mesmo rastro e o mesmo envio', async () => {
    const antes = montar([], [CLINICA]);
    await antes.svc.sendNegociacaoAprovada(CLINICA, 'plano-1', PACIENTE(CLINICA), TERMOS);
    const depois = montar([LAB], [CLINICA]);
    await depois.svc.sendNegociacaoAprovada(CLINICA, 'plano-1', PACIENTE(CLINICA), TERMOS);
    expect(depois.ops).toEqual(antes.ops);
    expect(depois.whatsapp.sendText.mock.calls).toEqual(antes.whatsapp.sendText.mock.calls);
  });

  it('negociação aprovada, laboratório com o toggle ligado: manda o orçamento aprovado do laboratório e marca', async () => {
    const m = montar([LAB], [LAB]);
    await m.svc.sendNegociacaoAprovada(LAB, 'plano-lab', PACIENTE(LAB), TERMOS);
    // As mesmas leituras e marcas da clínica, na chave da conta do laboratório.
    expect(m.nomes()).toEqual([
      'globalSetting.findUnique',
      'globalSetting.findUnique',
      'auditLog.findFirst',
      'globalSetting.findUnique',
      'tenant.findUnique',
      'treatmentPlanItem.findMany',
      'auditLog.create',
      'dispatchLog.create',
    ]);
    expect(m.ops[0]).toEqual(['globalSetting.findUnique', { where: { key: `NEGOCIACAO_APROVADA_ENABLED_${LAB}` } }]);
    expect(m.ops[1]).toEqual(['globalSetting.findUnique', { where: { key: `NEGOCIACAO_APROVADA_AVISTA_ENABLED_${LAB}` } }]);
    expect(m.ops[3]).toEqual(['globalSetting.findUnique', { where: { key: `COBRANCA_TEMPLATE_NEGOCIACAO_APROVADA_AVISTA_${LAB}` } }]);
    expect(m.whatsapp.sendText.mock.calls).toEqual([
      [
        TEL[LAB],
        'Olá, Maria! Seu orçamento de trabalho foi *aprovado*.\n\n' +
          '• Procedimento exemplo\n\n' +
          '• Total: R$ 1.500,00 (PIX)\n\n' +
          'Já te envio o código PIX aqui mesmo pra você pagar. 😊\n\n' +
          'Qualquer dúvida, é só chamar por aqui.',
        `chip-financeiro-${LAB}`,
      ],
    ]);
    expect(String(m.whatsapp.sendText.mock.calls[0][1])).not.toMatch(/tratamento|paciente/i);
    expect(m.de('auditLog.create').map((a: any) => [a.data.entity, a.data.entity_id])).toEqual([['NEGOCIACAO_APROVADA', 'plano-lab']]);
    expect(m.de('dispatchLog.create').map((a: any) => [a.data.tenant_id, a.data.type])).toEqual([[LAB, 'negociacao_aprovada']]);
    expect(registrou('log', '[LAB-GATE] negociacao-aprovada')).toBe(false);
  });

  it('negociação aprovada, laboratório com o toggle desligado: não manda nem marca', async () => {
    const m = montar([LAB], []);
    await m.svc.sendNegociacaoAprovada(LAB, 'plano-lab', PACIENTE(LAB), TERMOS);
    expect(m.whatsapp.sendText).not.toHaveBeenCalled();
    expect(m.whatsapp.sendMedia).not.toHaveBeenCalled();
    expect(m.de('auditLog.create')).toEqual([]);
  });

  it('entrada, clínica sem laboratório e com OUTRA conta laboratório: busca a entrada, como antes', async () => {
    const antes = montar([], [CLINICA]);
    await antes.svc.sendEntradaCobranca(CLINICA, 'plano-1', PACIENTE(CLINICA));
    expect(antes.nomes()).toEqual(['paymentGatewayCharge.findMany']);
    expect(antes.de('paymentGatewayCharge.findMany')[0].where.treatment_plan_id).toBe('plano-1');
    const depois = montar([LAB], [CLINICA]);
    await depois.svc.sendEntradaCobranca(CLINICA, 'plano-1', PACIENTE(CLINICA));
    expect(depois.ops).toEqual(antes.ops);
  });

  it('entrada, laboratório: busca a entrada como na clínica (sem entrada, nada sai)', async () => {
    const m = montar([LAB], [LAB]);
    await m.svc.sendEntradaCobranca(LAB, 'plano-lab', PACIENTE(LAB));
    expect(m.nomes()).toEqual(['paymentGatewayCharge.findMany']);
    expect(m.de('paymentGatewayCharge.findMany')[0].where.treatment_plan_id).toBe('plano-lab');
    expect(m.whatsapp.sendText).not.toHaveBeenCalled();
    expect(registrou('log', '[LAB-GATE] entrada-cobranca')).toBe(false);
  });

  it('comprovante, clínica sem laboratório: manda e marca, como antes', async () => {
    const m = montar([], [CLINICA]);
    await m.svc.sendComprovantePagamento(CLINICA, 'plano-1', PACIENTE(CLINICA), { total: 1500, forma: 'PIX' });
    expect(m.whatsapp.sendText.mock.calls.map((c: any[]) => [c[0], c[2]])).toEqual([[TEL[CLINICA], `chip-financeiro-${CLINICA}`]]);
    expect(m.de('auditLog.create').map((a: any) => a.data.entity)).toEqual(['COMPROVANTE_PAGAMENTO']);
  });

  it('comprovante, clínica com OUTRA conta laboratório: o mesmo rastro e o mesmo envio', async () => {
    const antes = montar([], [CLINICA]);
    await antes.svc.sendComprovantePagamento(CLINICA, 'plano-1', PACIENTE(CLINICA), { total: 1500, forma: 'PIX' });
    const depois = montar([LAB], [CLINICA]);
    await depois.svc.sendComprovantePagamento(CLINICA, 'plano-1', PACIENTE(CLINICA), { total: 1500, forma: 'PIX' });
    expect(depois.ops).toEqual(antes.ops);
    expect(depois.whatsapp.sendText.mock.calls).toEqual(antes.whatsapp.sendText.mock.calls);
  });

  it('comprovante, laboratório com o toggle ligado: nem lê, nem manda', async () => {
    const m = montar([LAB], [LAB]);
    await m.svc.sendComprovantePagamento(LAB, 'plano-lab', PACIENTE(LAB), { total: 1500, forma: 'PIX' });
    expect(m.ops).toEqual([]);
    expect(m.whatsapp.sendText).not.toHaveBeenCalled();
  });
});

// ─── textos do laboratório: nomes, itens, PDF e texto salvo ──────────────────

describe('Orçamento aprovado — o texto do laboratório e o da clínica (fallbacks e PDF)', () => {
  const PARCELADO = { entrada: 500, parcelas: 10, valorParcela: 250, total: 3000, forma: 'BOLETO' };
  function montar(conta: string, labs: string[], o: { salvo?: string; nome?: string | null } = {}) {
    const b = banco(labs, {
      'globalSetting.findUnique': ({ where }) =>
        where.key === `NEGOCIACAO_APROVADA_ENABLED_${conta}`
          ? { value: 'true' }
          : o.salvo && where.key === `COBRANCA_TEMPLATE_NEGOCIACAO_APROVADA_${conta}`
            ? { value: JSON.stringify({ template: o.salvo }) }
            : null,
      'tenant.findUnique': () => ({ name: null }),
      'treatmentPlanItem.findMany': () => [{ quantity: 2, procedure: null }, { quantity: 1, procedure: { name: 'Coroa' } }],
      'treatmentPlan.findUnique': () => ({ quote_id: `quote-${conta}` }),
    });
    const envios: any[] = [];
    const whatsapp = {
      getInstanceForPurpose: jest.fn(async (_t: string, p: string) => `chip-${p.toLowerCase()}`),
      sendText: jest.fn(async (tel: string, texto: string, inst?: string) => {
        envios.push({ tipo: 'texto', tel, texto, inst });
        return { key: { id: `wamid-${envios.length}` } };
      }),
      sendMedia: jest.fn(async (tel: string, tipo: string, _b64: string, legenda: string, inst?: string, arquivo?: string, mime?: string) => {
        envios.push({ tipo, tel, legenda, inst, arquivo, mime });
        return { key: { id: `wamid-${envios.length}` } };
      }),
    };
    const pdf = { generatePdf: jest.fn(async () => Buffer.from('%PDF-1.4 exemplo')) };
    const svc: any = new QuotesService(b.prisma, {} as any, whatsapp as any, undefined, undefined, undefined, undefined, undefined, pdf as any);
    const enviar = () => svc.sendNegociacaoAprovada(conta, `plano-${conta}`, { name: o.nome ?? null, phone: TEL[conta] }, PARCELADO);
    return { svc, enviar, envios, pdf, ...b };
  }

  it('clínica sem nome de conta, de cliente e de item: os textos de antes (9eb61bff), com e sem OUTRA conta laboratório', async () => {
    const esperado = [
      {
        tipo: 'texto',
        tel: TEL[CLINICA],
        texto:
          'Olá, paciente! 🎉 Seu tratamento foi *aprovado*.\n\n• Procedimento (2x)\n• Coroa\n\n' +
          '• Entrada: R$ 500,00\n• 10x de R$ 250,00\n• Total: R$ 3.000,00\n\nQualquer dúvida, é só chamar por aqui! 💙',
        inst: 'chip-financeiro',
      },
      {
        tipo: 'document',
        tel: TEL[CLINICA],
        legenda: 'Aqui estão os procedimentos do seu tratamento, paciente. 😊',
        inst: 'chip-financeiro',
        arquivo: 'procedimentos-paciente.pdf',
        mime: 'application/pdf',
      },
    ];
    const antes = montar(CLINICA, []);
    await antes.enviar();
    expect(antes.envios).toEqual(esperado);
    const depois = montar(CLINICA, [LAB]);
    await depois.enviar();
    expect(depois.envios).toEqual(esperado);
    expect(depois.ops).toEqual(antes.ops);
  });

  it('clínica com texto salvo que fala em tratamento: sai o texto salvo, como antes', async () => {
    const m = montar(CLINICA, [LAB], { salvo: 'Oi {nome}, seu tratamento foi aprovado. {itens}', nome: 'Maria Souza' });
    await m.enviar();
    expect(m.envios[0].texto).toBe('Oi Maria, seu tratamento foi aprovado. • Procedimento (2x)\n• Coroa');
  });

  it('laboratório, cliente "Dr." e item sem nome: primeiro nome sem título, "Serviço" e o PDF do orçamento de trabalho', async () => {
    const m = montar(LAB, [LAB], { nome: 'Dr. Carlos Lima' });
    await m.enviar();
    expect(m.envios).toEqual([
      {
        tipo: 'texto',
        tel: TEL[LAB],
        texto:
          'Olá, Carlos! Seu orçamento de trabalho foi *aprovado*.\n\n• Serviço (2x)\n• Coroa\n\n' +
          '• Entrada: R$ 500,00\n• 10x de R$ 250,00\n• Total: R$ 3.000,00\n\nQualquer dúvida, é só chamar por aqui.',
        inst: 'chip-financeiro',
      },
      {
        tipo: 'document',
        tel: TEL[LAB],
        legenda: LAB_NEGOCIACAO.legendaDoPdf('Carlos'),
        inst: 'chip-financeiro',
        arquivo: LAB_NEGOCIACAO.arquivoDoPdf('Carlos'),
        mime: 'application/pdf',
      },
    ]);
    expect(LAB_NEGOCIACAO.arquivoDoPdf('Carlos')).toBe('servicos-Carlos.pdf');
    // O PDF é o mesmo gerador da clínica, sem valores (no laboratório ele desenha o orçamento de trabalho).
    expect(m.pdf.generatePdf.mock.calls).toEqual([[`quote-${LAB}`, LAB, false]]);
  });

  it('laboratório sem nome do cliente nem da conta: "doutor(a)" e "o laboratório" no {clinica} do texto salvo', async () => {
    const m = montar(LAB, [LAB], { salvo: 'Oi {nome}! {clinica} aprovou: {itens}' });
    await m.enviar();
    expect(m.envios[0].texto).toBe('Oi doutor(a)! o laboratório aprovou: • Serviço (2x)\n• Coroa');
    expect(m.envios[1].arquivo).toBe(LAB_NEGOCIACAO.arquivoDoPdf('doutor(a)'));
  });

  it('laboratório com texto salvo que fala em tratamento ou paciente: sai o texto do laboratório', async () => {
    for (const salvo of ['Olá {nome}! Seu tratamento foi aprovado. {itens}', 'Paciente {nome}, aprovado: {itens}']) {
      const m = montar(LAB, [LAB], { salvo, nome: 'Dra. Ana Melo' });
      await m.enviar();
      expect(m.envios[0].texto).toBe(
        'Olá, Ana! Seu orçamento de trabalho foi *aprovado*.\n\n• Serviço (2x)\n• Coroa\n\n' +
          '• Entrada: R$ 500,00\n• 10x de R$ 250,00\n• Total: R$ 3.000,00\n\nQualquer dúvida, é só chamar por aqui.',
      );
    }
  });
});

describe('Boleto da entrada — o texto do laboratório e o da clínica', () => {
  const HOJE = new Date('2026-10-21T12:00:00.000Z');
  function montar(conta: string, labs: string[], nome: string | null) {
    const b = banco(labs, {
      'paymentGatewayCharge.findMany': () => [
        {
          id: 'ch-1', kind: 'ENTRADA', amount: 700, due_date: HOJE, external_id: 'pay_1', gateway: 'ASAAS',
          boleto_url: 'https://asaas.exemplo.test/b/1.pdf', invoice_url: null, pix_copy_paste: '00020126exemplo',
        },
      ],
    });
    const envios: any[] = [];
    const whatsapp = {
      getInstanceForPurpose: jest.fn(async (_t: string, p: string) => `chip-${p.toLowerCase()}`),
      sendText: jest.fn(async (tel: string, texto: string, inst?: string) => {
        envios.push({ tel, texto, inst });
        return { key: { id: `wamid-${envios.length}` } };
      }),
    };
    const moduleRef = { get: () => { throw new Error('sem Asaas no teste'); } };
    const svc: any = new QuotesService(b.prisma, moduleRef as any, whatsapp as any);
    const enviar = () => svc.sendEntradaCobranca(conta, `plano-${conta}`, { name: nome, phone: TEL[conta] });
    return { enviar, envios, ...b };
  }
  const RODAPE = '\n\n🔗 Boleto:\nhttps://asaas.exemplo.test/b/1.pdf\n\nSe preferir pagar por *PIX*, o código vai na *próxima mensagem* 👇';

  it('clínica sem nome do cliente: o texto de antes (9eb61bff), com e sem OUTRA conta laboratório', async () => {
    const esperado = [
      {
        tel: TEL[CLINICA],
        texto: 'paciente, pra garantir seu tratamento, segue o *boleto da entrada* de *R$ 700,00* (vence em *21/10/2026*).' + RODAPE,
        inst: 'chip-financeiro',
      },
      { tel: TEL[CLINICA], texto: '00020126exemplo', inst: 'chip-financeiro' },
    ];
    const antes = montar(CLINICA, [], null);
    await antes.enviar();
    expect(antes.envios).toEqual(esperado);
    const depois = montar(CLINICA, [LAB], null);
    await depois.enviar();
    expect(depois.envios).toEqual(esperado);
    expect(depois.ops).toEqual(antes.ops);
  });

  it('laboratório: o boleto com o texto do laboratório, o mesmo link, o PIX e a marca da peça', async () => {
    const m = montar(LAB, [LAB], 'Dr. Carlos Lima');
    await m.enviar();
    expect(m.envios).toEqual([
      {
        tel: TEL[LAB],
        texto: LAB_ENTRADA.mensagem('Carlos', 'da entrada', 'R$ 700,00', '21/10/2026') + RODAPE,
        inst: 'chip-financeiro',
      },
      { tel: TEL[LAB], texto: '00020126exemplo', inst: 'chip-financeiro' },
    ]);
    expect(m.envios[0].texto).toBe(
      'Carlos, pra liberarmos o início do seu trabalho, segue o *boleto da entrada* de *R$ 700,00* (vence em *21/10/2026*).' + RODAPE,
    );
    expect(m.de('auditLog.create').map((a: any) => [a.data.entity, a.data.entity_id, a.data.meta_json])).toEqual([
      ['BOLETO_DELIVERY_PIECE', `plano-${LAB}:pay_1`, { tenant_id: LAB, source: 'fechamento_entrada' }],
    ]);
  });

  it('laboratório sem nome do cliente: "doutor(a)"', async () => {
    const m = montar(LAB, [LAB], null);
    await m.enviar();
    expect(m.envios[0].texto.startsWith('doutor(a), pra liberarmos o início do seu trabalho')).toBe(true);
  });
});

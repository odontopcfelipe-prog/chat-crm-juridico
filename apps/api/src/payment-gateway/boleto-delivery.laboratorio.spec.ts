/**
 * Envio dos boletos (carnê D+2) no laboratório: o mesmo serviço da clínica, numa rodada
 * própria e só na conta que ligou o card (chave ausente = desligado, sem herdar da
 * apresentação). Texto do laboratório, só boleto do Asaas da conta e chip da conta; sem
 * chip, não envia e registra a falha. A rodada das clínicas continua a mesma.
 *
 * Dublês no lugar do AsaasClient (import dinâmico). Dados de exemplo.
 */
import { Logger } from '@nestjs/common';
import { LAB_REGUA, __limparCacheLabTenants, semVariaveis, temVocabularioDeClinica } from '@crm/shared';
import { BoletoDeliveryService } from './boleto-delivery.service';

const LAB = 'tenant-lab';
const OUTRO_LAB = 'tenant-lab-2';
const CLINICA = 'tenant-clinica';
const TEL = '5582900000003';
const AGORA = new Date('2026-10-21T15:00:00.000Z'); // quarta, 12:00 em Maceió
const ONTEM = new Date('2026-10-20T15:00:00.000Z');

const ancora = (conta: string, plano = `plano-${conta}`) => ({ entity_id: plano, meta_json: { tenant_id: conta, source: 'fechamento' }, created_at: ONTEM });
const parcela = (n: number, over: Record<string, any> = {}) => ({
  kind: 'INSTALLMENT',
  external_id: `pay_p${n}`,
  boleto_url: `https://asaas.exemplo.test/b/parcela-${n}.pdf`,
  due_date: new Date('2026-11-05T00:00:00.000Z'),
  amount: 100,
  description: `Parcela ${n}/3 — Trabalho de prótese`,
  ...over,
});

interface Mundo {
  labs?: string[];
  settings?: Record<string, string>;
  ancoras?: any[];
  cobrancas?: any[];
  planoDaConta?: boolean;
  nomeDaConta?: string | null;
  chip?: (conta: string, funcao: string) => string | null;
  cobrancaNoAsaas?: Record<string, any>;
  /** A consulta das âncoras devolve tudo, sem olhar o filtro da conta. */
  ancorasSemFiltro?: boolean;
  /** Status da conta no cadastro (padrão: ACTIVE). */
  status?: string;
}

function montar(m: Mundo = {}) {
  __limparCacheLabTenants();
  const settings = m.settings ?? {};
  const ops: [string, any][] = [];
  const responde = (op: string, args: any) => {
    switch (op) {
      case 'tenantBusinessProfile.findMany':
        return (m.labs ?? [LAB]).map((tenant_id) => ({ tenant_id }));
      case 'globalSetting.findMany':
        return Object.entries(settings)
          .filter(([key, value]) => args.where.key.in.includes(key) && (args.where.value === undefined || value === args.where.value))
          .map(([key, value]) => ({ key, value }));
      case 'globalSetting.findUnique':
        return args.where.key in settings ? { value: settings[args.where.key] } : null;
      case 'auditLog.findMany': {
        if (args.where.entity !== 'BOLETO_INTRO') return [];
        const filtro = m.ancorasSemFiltro ? null : args.where.meta_json;
        return (m.ancoras ?? []).filter((a) => !filtro || a.meta_json.tenant_id === filtro.equals);
      }
      case 'auditLog.findFirst':
      case 'auditLog.count':
        return op === 'auditLog.count' ? 0 : null;
      case 'treatmentPlan.findFirst':
        return m.planoDaConta === false ? null : { id: args.where.id };
      case 'treatmentPlan.findUnique':
        return { patient: { name: 'Dra. Ana Souza', phone: TEL } };
      case 'paymentGatewayCharge.findMany':
        return m.cobrancas ?? [parcela(1), parcela(2)];
      case 'tenant.findUnique':
        if (args.select?.status) return { status: m.status ?? 'ACTIVE' };
        return m.nomeDaConta === undefined ? { name: 'Laboratório Exemplo' } : m.nomeDaConta ? { name: m.nomeDaConta } : null;
      default:
        return {};
    }
  };
  const prisma: any = new Proxy(
    {},
    {
      get(_a, modelo: string) {
        if (modelo === 'then') return undefined;
        return new Proxy(
          {},
          {
            get(_b, metodo: string) {
              return async (args: any) => {
                ops.push([`${modelo}.${metodo}`, args]);
                return responde(`${modelo}.${metodo}`, args);
              };
            },
          },
        );
      },
    },
  );
  const asaas: any = {
    getCharge: jest.fn(async (id: string) => m.cobrancaNoAsaas?.[id] ?? { status: 'PENDING', installment: 'parc-1' }),
    getInstallmentPaymentBook: jest.fn(async () => Buffer.from('%PDF carnê')),
    listCharges: jest.fn(async () => ({ data: [] })),
  };
  const whatsapp: any = {
    getInstanceForPurpose: jest.fn(async (conta: string, funcao: string) => (m.chip ? m.chip(conta, funcao) : `chip-${funcao.toLowerCase()}-${conta}`)),
    sendText: jest.fn(async () => ({ key: { id: 'wamid-t' } })),
    sendMedia: jest.fn(async () => ({ key: { id: 'wamid-m' } })),
  };
  const svc = new BoletoDeliveryService(prisma, asaas, whatsapp) as any;
  jest.spyOn(svc, 'sleep').mockImplementation(async () => undefined);
  return { svc, ops, asaas, whatsapp, de: (op: string) => ops.filter(([o]) => o === op).map(([, a]) => a) };
}

const LIGADO = { [`BOLETO_DELIVERY_ENABLED_${LAB}`]: 'true' };

function semTextoDeClinica(t: string): boolean {
  return !temVocabularioDeClinica(semVariaveis(t)) && !/instituto|banco passos|paciente|consulta|tratamento/i.test(t);
}

beforeAll(() => {
  for (const n of ['log', 'warn', 'debug', 'error'] as const) jest.spyOn(Logger.prototype, n).mockImplementation(() => undefined);
});
beforeEach(() => {
  jest.useFakeTimers({
    now: AGORA,
    doNotFake: ['nextTick', 'setImmediate', 'clearImmediate', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'queueMicrotask', 'hrtime', 'performance'],
  });
});
afterEach(() => jest.useRealTimers());

describe('liga por conta', () => {
  it.each([
    ['sem a chave', {}],
    ['chave em false', { [`BOLETO_DELIVERY_ENABLED_${LAB}`]: 'false' }],
    ['só a apresentação ligada (sem herança)', { [`BOLETO_INTRO_ENABLED_${LAB}`]: 'true' }],
    ['ligado em OUTRO laboratório', { [`BOLETO_DELIVERY_ENABLED_${OUTRO_LAB}`]: 'true' }],
  ])('%s: a venda da conta não é entregue', async (_n, settings) => {
    const m = montar({ labs: [LAB, OUTRO_LAB], settings, ancoras: [ancora(LAB)] });
    await m.svc.tick();
    expect(m.whatsapp.sendText).not.toHaveBeenCalled();
    expect(m.whatsapp.sendMedia).not.toHaveBeenCalled();
    expect(m.de('auditLog.create').filter((a) => a.data.entity === 'BOLETO_DELIVERY')).toEqual([]);
  });

  it('a chave ligada: entrega só a venda da própria conta, e a consulta das âncoras é só dela', async () => {
    const m = montar({
      labs: [LAB, OUTRO_LAB],
      settings: LIGADO,
      ancoras: [ancora(LAB), ancora(OUTRO_LAB), ancora(CLINICA)],
    });
    const fila = await m.svc.findPendingDosLaboratorios();
    expect(fila).toEqual([{ planId: `plano-${LAB}`, tenantId: LAB }]);
    const consulta = m.de('auditLog.findMany').find((a) => a.where.entity === 'BOLETO_INTRO');
    expect(consulta.where.meta_json).toEqual({ path: ['tenant_id'], equals: LAB });
    expect(m.de('globalSetting.findMany')[0].where.key.in).toEqual([`BOLETO_DELIVERY_ENABLED_${LAB}`, `BOLETO_DELIVERY_ENABLED_${OUTRO_LAB}`]);
  });

  it.each([
    ['SUSPENDED', { status: 'SUSPENDED' }],
    ['DELETED', { status: 'DELETED' }],
    ['LAB_FREEZE', { settings: { ...LIGADO, LAB_FREEZE: 'true' } }],
    ['LAB_FREEZE_<conta>', { settings: { ...LIGADO, [`LAB_FREEZE_${LAB}`]: 'true' } }],
  ])('conta %s: a rodada não entrega nem lê as âncoras dela', async (_n, conta) => {
    const m = montar({ settings: LIGADO, ancoras: [ancora(LAB)], ...conta });
    await expect(m.svc.findPendingDosLaboratorios()).resolves.toEqual([]);
    expect(m.de('auditLog.findMany')).toEqual([]);
  });

  it('conta em teste entrega; só a conta suspensa fica de fora', async () => {
    const m = montar({ settings: LIGADO, ancoras: [ancora(LAB)], status: 'TRIAL' });
    await expect(m.svc.findPendingDosLaboratorios()).resolves.toEqual([{ planId: `plano-${LAB}`, tenantId: LAB }]);
  });

  it('âncora de outra conta que voltar na consulta: fora da rodada, sem ler a chave dela', async () => {
    const m = montar({ settings: LIGADO, ancoras: [ancora(CLINICA), ancora(LAB)], ancorasSemFiltro: true });
    await expect(m.svc.findPendingDeliveries(LAB)).resolves.toEqual([{ planId: `plano-${LAB}`, tenantId: LAB }]);
    expect(m.de('globalSetting.findUnique').map((a) => a.where.key)).toEqual([`BOLETO_DELIVERY_ENABLED_${LAB}`]);
  });

  it('sem laboratório cadastrado: só a lista, nada da chave', async () => {
    const m = montar({ labs: [], settings: LIGADO, ancoras: [] });
    await (m.svc as any).tickDosLaboratorios();
    expect(m.de('globalSetting.findMany')).toEqual([]);
  });
});

describe('o envio na conta que ligou', () => {
  it('texto do laboratório + carnê pelo chip da conta; legendas sem texto de clínica; nome sem Dr.', async () => {
    const m = montar({ settings: LIGADO, ancoras: [ancora(LAB)], cobrancas: [parcela(1), parcela(2), { ...parcela(3), kind: 'ENTRADA', external_id: 'pay_e' }] });
    await m.svc.tick();
    const abertura = LAB_REGUA.entrega.replace('{nome}', 'Ana').replace('{clinica}', 'Laboratório Exemplo');
    expect(m.whatsapp.sendText.mock.calls).toEqual([[TEL, abertura, `chip-financeiro-${LAB}`]]);
    const midias = m.whatsapp.sendMedia.mock.calls;
    expect(midias).toHaveLength(2);
    expect(midias.every((c: any[]) => c[4] === `chip-financeiro-${LAB}`)).toBe(true);
    const textos = [abertura, ...midias.map((c: any[]) => c[3] as string), ...midias.map((c: any[]) => c[5] as string)];
    expect(textos.filter((t: string) => !semTextoDeClinica(t))).toEqual([]);
    expect(midias.map((c: any[]) => c[3])).toEqual(['Carnê — 2 parcelas', 'Entrada']);
    // Asaas sempre com a conta do laboratório.
    expect(m.asaas.getCharge.mock.calls.every((c: any[]) => c[1] === LAB)).toBe(true);
    expect(m.asaas.getInstallmentPaymentBook.mock.calls.every((c: any[]) => c[1] === LAB)).toBe(true);
    const busca = m.de('paymentGatewayCharge.findMany')[0].where;
    expect(busca).toMatchObject({ tenant_id: LAB, gateway: 'ASAAS', billing_type: 'BOLETO' });
    expect(m.de('dispatchLog.create')[0].data).toMatchObject({ tenant_id: LAB, type: 'boleto_delivery', status: 'SENT' });
    expect(m.de('auditLog.create').some((a) => a.data.entity === 'BOLETO_DELIVERY' && a.data.action === 'sent')).toBe(true);
  });

  it('o carnê com plano de links (só na última tentativa) também não fala em clínica', async () => {
    const m = montar({ settings: LIGADO, cobrancas: [parcela(1), parcela(2)] });
    m.asaas.getInstallmentPaymentBook.mockRejectedValue(new Error('fora'));
    jest.spyOn(m.svc, 'baixarPdf').mockRejectedValue(new Error('fora'));
    await m.svc.sendBoletos(`plano-${LAB}`, LAB, 'Dra. Ana Souza', TEL, { lab: true, ultimaTentativa: true });
    const textos = m.whatsapp.sendText.mock.calls.map((c: any[]) => c[1] as string);
    expect(textos.length).toBe(2);
    expect(textos.filter((t: string) => !semTextoDeClinica(t))).toEqual([]);
  });

  it('texto salvo próprio vale; com palavra de clínica cai no padrão; {clinica} sem nome = o laboratório', async () => {
    const chave = `COBRANCA_TEMPLATE_BOLETO_DELIVERY_${LAB}`;
    const proprio = montar({ settings: { [chave]: JSON.stringify({ template: 'Oi {nome}, boletos de {clinica}.' }) } });
    await expect(proprio.svc.resolveDeliveryText(LAB, 'Ana', undefined, true)).resolves.toBe('Oi Ana, boletos de Laboratório Exemplo.');
    const deClinica = montar({ settings: { [chave]: JSON.stringify({ template: 'Oi {nome}, boletos do seu tratamento.' }) } });
    await expect(deClinica.svc.resolveDeliveryText(LAB, 'Ana', undefined, true)).resolves.toBe(
      LAB_REGUA.entrega.replace('{nome}', 'Ana').replace('{clinica}', 'Laboratório Exemplo'),
    );
    const semNome = montar({ nomeDaConta: null });
    await expect(semNome.svc.resolveDeliveryText(LAB, 'Ana', undefined, true)).resolves.toBe(
      LAB_REGUA.entrega.replace('{nome}', 'Ana').replace('{clinica}', LAB_REGUA.laboratorioSemNome),
    );
  });

  it('entrada paga no Asaas com status local velho: o PDF não sai', async () => {
    const m = montar({
      settings: LIGADO,
      ancoras: [ancora(LAB)],
      cobrancas: [{ ...parcela(3), kind: 'ENTRADA', external_id: 'pay_e' }],
      cobrancaNoAsaas: { pay_e: { status: 'RECEIVED' } },
    });
    await m.svc.tick();
    expect(m.whatsapp.sendText).not.toHaveBeenCalled();
    expect(m.whatsapp.sendMedia).not.toHaveBeenCalled();
  });

  it('sem chip da conta: não envia, registra a falha e conta a tentativa', async () => {
    const m = montar({ settings: LIGADO, ancoras: [ancora(LAB)], chip: () => null });
    await m.svc.tick();
    expect(m.whatsapp.sendText).not.toHaveBeenCalled();
    expect(m.whatsapp.sendMedia).not.toHaveBeenCalled();
    expect(m.asaas.getInstallmentPaymentBook).not.toHaveBeenCalled();
    expect(m.de('dispatchLog.create')[0].data).toMatchObject({ tenant_id: LAB, type: 'boleto_delivery', status: 'FAILED' });
    expect(m.de('auditLog.create').map((a) => a.data.entity)).toEqual(['BOLETO_DELIVERY_ATTEMPT']);
  });

  it('plano que não é de cadastro da conta: não envia', async () => {
    const m = montar({ settings: LIGADO, ancoras: [ancora(LAB)], planoDaConta: false });
    await m.svc.tick();
    expect(m.whatsapp.sendText).not.toHaveBeenCalled();
    expect(m.de('treatmentPlan.findFirst')[0].where).toEqual({ id: `plano-${LAB}`, patient: { tenant_id: LAB } });
  });

  it('boleto do mês (manual) no laboratório: nome sem Dr. e resposta sem paciente', async () => {
    const m = montar({
      cobrancas: [{ id: 'c1', external_id: 'pay_1', boleto_url: 'https://asaas.exemplo.test/b/1.pdf', due_date: new Date('2026-11-05T00:00:00.000Z'), customer_external_id: 'cus', treatment_plan: { patient: { name: 'Dra. Ana Souza', phone: TEL } } }],
    });
    jest.spyOn(m.svc, 'assertPlanoDaClinica').mockResolvedValue(undefined);
    const r = await m.svc.sendCurrentBoleto('plano-1', LAB);
    expect(r.ok).toBe(true);
    expect(r.detail).not.toMatch(/paciente/i);
    expect(m.whatsapp.sendMedia.mock.calls[0][3]).toContain('Oi Ana!');
  });
});

describe('clínica igual', () => {
  const CLINICA_LIGADA = { [`BOLETO_DELIVERY_ENABLED_${CLINICA}`]: 'true', [`COBRANCA_TEMPLATE_X_${CLINICA}`]: '' };

  it('a venda da clínica sai na rodada dela, com o texto dela, antes de qualquer leitura do laboratório', async () => {
    const m = montar({ settings: { ...CLINICA_LIGADA, ...LIGADO }, ancoras: [ancora(CLINICA)] });
    jest.spyOn(m.svc, 'tickDosLaboratorios').mockImplementation(async () => undefined);
    await m.svc.tick();
    expect(m.whatsapp.sendText.mock.calls[0]).toEqual([TEL, 'Olá, Dra.! 📄 Aqui estão os seus boletos, todos em PDF. Qualquer dúvida, é só me chamar por aqui! 💙', `chip-financeiro-${CLINICA}`]);
    expect(m.de('paymentGatewayCharge.findMany')[0].where).not.toHaveProperty('gateway');
    expect(m.de('treatmentPlan.findFirst')).toEqual([]);
  });

  it('herança da apresentação continua valendo na clínica', async () => {
    const m = montar({ settings: { [`BOLETO_INTRO_ENABLED_${CLINICA}`]: 'true' } });
    await expect(m.svc.isEnabled(CLINICA)).resolves.toBe(true);
    await expect(m.svc.isEnabled(CLINICA, true)).resolves.toBe(false);
  });

  it('a rodada das clínicas segue mesmo com a dos laboratórios ocupada, e vice-versa', async () => {
    const m = montar({ settings: {}, ancoras: [] });
    m.svc.busyLab = true;
    const leuAncoras = () => m.de('auditLog.findMany').length;
    await m.svc.tick();
    expect(leuAncoras()).toBe(1);
    m.svc.busyLab = false;
    m.svc.busy = true;
    await m.svc.tick();
    expect(m.de('tenantBusinessProfile.findMany').length).toBeGreaterThan(0);
  });
});

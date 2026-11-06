/**
 * Régua de cobrança no laboratório: o motor da clínica numa raia própria.
 *
 * Só na conta que ligou o marco (chave ausente ou 'false' = não envia e nem lê cobrança),
 * com o texto do laboratório, o chip da conta (FINANCEIRO → CLINICA → COMERCIAL, nunca o
 * do servidor), só boleto da conta Asaas dela e com as proteções da clínica: freio ao vivo,
 * trava entre workers, recência, fim de semana, marcos e agrupamento por cliente. A raia
 * das clínicas continua igual (mesmas leituras, na mesma ordem, e os mesmos envios).
 *
 * Service real; banco e Evolution falsos. Dados de exemplo (repositório público).
 */
import { Logger } from '@nestjs/common';
import axios from 'axios';
import {
  COBRANCA_STAGES,
  COBRANCA_TIPOS,
  LAB_REGUA,
  __limparCacheLabTenants,
  defaultCobrancaTemplate,
  padraoFinDoLaboratorio,
  semVariaveis,
  temVocabularioDeClinica,
  type CobrancaStage,
  type CobrancaTipo,
} from '@crm/shared';
import { __limparCacheEnvChip } from '../admin-alerts/env-chip';
import { buildGroupMessage, planGroup } from './cobranca-grupo';
import { PaymentAlertsCronService } from './payment-alerts-cron.service';

jest.mock('axios', () => {
  const m: any = { post: jest.fn(), get: jest.fn() };
  m.default = m;
  return { __esModule: true, ...m };
});

const LAB = 'tenant-lab';
const OUTRO_LAB = 'tenant-lab-2';
const CLINICA = 'tenant-clinica';
const NOME_DO_LAB = 'Laboratório Exemplo';
const EVO = 'https://evolution.exemplo.test';
const AGORA = new Date('2026-10-20T15:00:00.000Z'); // terça, 12:00 em Maceió
const TEL = '5582900000003';

const VENCE: Record<CobrancaStage, string> = {
  boleto_1d_antes: '2026-10-21',
  boleto_no_dia: '2026-10-20',
  boleto_atraso_1d: '2026-10-19',
  boleto_atraso_2d: '2026-10-18',
  boleto_atraso_3d: '2026-10-17',
  boleto_atraso_15d: '2026-10-05',
  boleto_atraso_30d: '2026-09-20',
  boleto_atrasado: '2026-08-10',
};
const CHAVE: Record<CobrancaStage, string> = {
  boleto_1d_antes: 'BOLETO_1D_ANTES',
  boleto_no_dia: 'BOLETO_NO_DIA',
  boleto_atraso_1d: 'BOLETO_ATRASO_1D',
  boleto_atraso_2d: 'BOLETO_ATRASO_2D',
  boleto_atraso_3d: 'BOLETO_ATRASO_3D',
  boleto_atraso_15d: 'BOLETO_ATRASO_15D',
  boleto_atraso_30d: 'BOLETO_ATRASO_30D',
  boleto_atrasado: 'BOLETO_ATRASADO',
};
const chaveDe = (stage: CobrancaStage, conta = LAB) => `${CHAVE[stage]}_${conta}`;

const CHIP_FIN = { name: 'chip-fin-lab', purpose: 'FINANCEIRO', tenant_id: LAB, type: 'whatsapp' };
const CHIP_ATEND = { name: 'chip-atend-lab', purpose: 'CLINICA', tenant_id: LAB, type: 'whatsapp' };
const CHIP_COM = { name: 'chip-com-lab', purpose: 'COMERCIAL', tenant_id: LAB, type: 'whatsapp' };
const CHIP_DA_CLINICA = { name: 'chip-fin-clinica', purpose: 'FINANCEIRO', tenant_id: CLINICA, type: 'whatsapp' };

let seq = 0;
function cobranca(conta: string | null, stage: CobrancaStage, over: Record<string, any> = {}) {
  const id = over.id ?? `ch-${++seq}`;
  return {
    id,
    external_id: `pay_${id}`,
    gateway: 'ASAAS',
    status: 'PENDING',
    received_in_cash: false,
    created_at: new Date('2026-08-01T12:00:00.000Z'),
    tenant_id: conta,
    amount: 250,
    due_date: new Date(`${VENCE[stage]}T00:00:00.000Z`),
    invoice_url: `https://pagamento.exemplo.test/${id}`,
    boleto_url: `https://asaas.exemplo.test/b/${id}.pdf`,
    billing_type: 'BOLETO',
    pix_copy_paste: `PIX-${id}`,
    boleto_barcode: null,
    treatment_plan: null,
    treatment_plan_id: null,
    installment: null,
    patient: { id: `pac-${conta}`, name: 'Dr. Carlos Lima', phone: TEL, no_overdue_dunning: false },
    ...over,
  };
}

// ─── Banco falso ─────────────────────────────────────────────────────────────

function casaConta(where: any, conta: string | null): boolean {
  if (!where) return true;
  if (where.AND) return where.AND.every((w: any) => casaConta(w, conta));
  if (Array.isArray(where.OR) && where.OR.some((x: any) => 'tenant_id' in x)) return where.OR.some((w: any) => casaConta(w, conta));
  const f = where.tenant_id;
  if (f === undefined) return true;
  if (f === null) return conta === null;
  if (typeof f === 'string') return conta === f;
  if (f.in) return conta != null && f.in.includes(conta);
  if (f.notIn) return conta != null && !f.notIn.includes(conta);
  return true;
}

function casaCobranca(where: any, c: any): boolean {
  const base = where.AND ? where.AND[0] : where;
  if (!casaConta(where, c.tenant_id)) return false;
  if (base.status?.in && !base.status.in.includes(c.status)) return false;
  if (base.received_in_cash !== undefined && base.received_in_cash !== c.received_in_cash) return false;
  if (base.gateway !== undefined && base.gateway !== c.gateway) return false;
  if (base.billing_type !== undefined && base.billing_type !== c.billing_type) return false;
  if (base.treatment_plan_id?.not === null && !c.treatment_plan_id) return false;
  for (const [campo, f] of [['due_date', base.due_date], ['created_at', base.created_at]] as const) {
    if (!f) continue;
    const t = new Date(c[campo]).getTime();
    if (f.gte && t < f.gte.getTime()) return false;
    if (f.lte && t > f.lte.getTime()) return false;
    if (f.lt && t >= f.lt.getTime()) return false;
  }
  return true;
}

interface Mundo {
  labs?: string[];
  settings?: Record<string, string>;
  cobrancas?: any[];
  chips?: any[];
  avisos?: any[];
  planos?: any[];
  /** Status no Asaas por external_id (número = erro HTTP). Sem entrada: PENDING. */
  asaas?: Record<string, string | number>;
  /** Contas com chave Asaas própria (padrão: os dois laboratórios e a clínica). */
  contasAsaas?: string[];
  nomes?: Record<string, string | null>;
  pacer?: Map<string, Date>;
  /** Status de cada conta no cadastro (padrão: ACTIVE). */
  status?: Record<string, string>;
}

function montar(m: Mundo = {}) {
  const settings = m.settings ?? {};
  const cobrancas = m.cobrancas ?? [];
  const chips = m.chips ?? [CHIP_FIN];
  const avisos = m.avisos ?? [];
  const planos = m.planos ?? [];
  const pacer = m.pacer ?? new Map<string, Date>();
  const ops: [string, any][] = [];
  const registra = (op: string, args: any) => ops.push([op, args]);
  const tabela: Record<string, Record<string, (a: any) => any>> = {
    tenantBusinessProfile: { findMany: () => (m.labs ?? [LAB]).map((tenant_id) => ({ tenant_id })) },
    globalSetting: {
      findMany: ({ where }: any) =>
        Object.entries(settings)
          .filter(([key, value]) => {
            if (where.key.in && !where.key.in.includes(key)) return false;
            if (where.key.startsWith && !key.startsWith(where.key.startsWith)) return false;
            return where.value === undefined || where.value === value;
          })
          .map(([key, value]) => ({ key, value })),
      findUnique: ({ where }: any) => (where.key in settings ? { key: where.key, value: settings[where.key] } : null),
    },
    paymentGatewayCharge: {
      findMany: ({ where }: any) => {
        if (where.id?.in) {
          return cobrancas.filter((c) => where.id.in.includes(c.id)).map((c) => ({ id: c.id, status: c.status, received_in_cash: c.received_in_cash }));
        }
        return cobrancas
          .filter((c) => casaCobranca(where, c))
          .sort((a, b) => new Date(a.due_date).getTime() - new Date(b.due_date).getTime());
      },
      groupBy: ({ where }: any) => {
        const vistos = new Set<string>();
        return cobrancas
          .filter((c) => casaCobranca(where, c))
          .filter((c) => !vistos.has(c.treatment_plan_id) && !!vistos.add(c.treatment_plan_id))
          .map((c) => ({ treatment_plan_id: c.treatment_plan_id, tenant_id: c.tenant_id }));
      },
      update: () => ({}),
    },
    instance: {
      findFirst: ({ where }: any) =>
        chips.find((c) => c.tenant_id === where.tenant_id && c.type === where.type && c.purpose === where.purpose) ?? null,
      findUnique: ({ where }: any) => {
        const c = chips.find((x) => x.name === where.name);
        return c ? { tenant_id: c.tenant_id, inbox: null } : null;
      },
    },
    tenant: {
      findUnique: ({ where }: any) => {
        const nome = (m.nomes ?? { [LAB]: NOME_DO_LAB, [OUTRO_LAB]: 'Prótese Dois', [CLINICA]: 'Clínica Exemplo' })[where.id];
        return { name: nome ?? null, status: m.status?.[where.id] ?? 'ACTIVE' };
      },
      findFirst: () => ({ id: CLINICA }),
    },
    patient: {
      findMany: ({ where }: any) => {
        const ids = new Set<string>();
        for (const c of cobrancas) {
          const p = c.treatment_plan?.patient || c.installment?.patient || c.patient;
          if (p?.id && (p.tenant_id ?? c.tenant_id) === where.tenant_id) ids.add(p.id);
        }
        return where.id.in.filter((id: string) => ids.has(id)).map((id: string) => ({ id }));
      },
    },
    treatmentPlan: {
      findMany: ({ where }: any) => {
        if (where.id?.in) {
          return planos.filter((p) => where.id.in.includes(p.id) && (!where.patient || where.patient.tenant_id === p.tenant_id));
        }
        return planos.filter((p) => where.patient_id.in.includes(p.patient_id)).map((p) => ({ id: p.id, patient_id: p.patient_id }));
      },
    },
    auditLog: {
      findMany: ({ where }: any) =>
        avisos.filter((a) => {
          if (a.entity !== where.entity) return false;
          if (where.entity_id?.in && !where.entity_id.in.includes(a.entity_id)) return false;
          if (where.action?.in && !where.action.in.includes(a.action)) return false;
          if (typeof where.action === 'string' && where.action !== a.action) return false;
          return !where.created_at?.gte || new Date(a.created_at) >= where.created_at.gte;
        }),
      create: ({ data }: any) => {
        avisos.push({ ...data, created_at: new Date() });
        return {};
      },
    },
    dispatchLog: { create: () => ({}) },
    inbox: { findFirst: () => null },
    whatsappChipPacer: {
      createMany: ({ data }: any) => {
        if (!pacer.has(data[0].instance_name)) pacer.set(data[0].instance_name, data[0].next_allowed_at);
        return { count: 1 };
      },
      updateMany: ({ where, data }: any) => {
        const t = pacer.get(where.instance_name);
        if (!t || t > where.next_allowed_at.lte) return { count: 0 };
        pacer.set(where.instance_name, data.next_allowed_at);
        return { count: 1 };
      },
    },
  };
  const prisma: any = new Proxy(
    {},
    {
      get(_a, modelo: string) {
        return new Proxy(
          {},
          {
            get(_b, metodo: string) {
              return async (args: any) => {
                registra(`${modelo}.${metodo}`, args);
                const f = tabela[modelo]?.[metodo];
                return f ? f(args) : null;
              };
            },
          },
        );
      },
    },
  );
  const contasAsaas = m.contasAsaas ?? [LAB, OUTRO_LAB, CLINICA];
  const configs: Record<string, any> = Object.fromEntries(contasAsaas.map((c) => [c, { apiKey: `chave-${c}`, baseUrl: `https://asaas.exemplo.test/${c}` }]));
  const settingsSvc: any = {
    getEvolutionConfig: jest.fn(async () => ({ apiUrl: EVO, apiKey: 'chave-somente-teste' })),
    getAsaasConfig: jest.fn(async (conta: string) => configs[conta] ?? null),
  };
  (axios.get as jest.Mock).mockImplementation(async (url: string) => {
    const ext = /\/payments\/([^/]+)/.exec(url)?.[1] as string;
    if (url.endsWith('/pixQrCode')) return { data: { payload: `PIX-${ext}` } };
    const v = m.asaas?.[ext] ?? 'PENDING';
    if (typeof v === 'number') throw Object.assign(new Error('http'), { response: { status: v } });
    return { data: { status: v } };
  });
  const novoServico = () => new PaymentAlertsCronService(prisma, settingsSvc) as any;
  return { svc: novoServico(), novoServico, prisma, ops, settingsSvc, avisos, pacer };
}

const posts = () => (axios.post as jest.Mock).mock.calls.map((c) => ({ url: c[0] as string, body: c[1] as any }));
const textosEnviados = () => posts().map((p) => p.body.text ?? p.body.caption ?? '');
const de = (ops: [string, any][], op: string) => ops.filter(([o]) => o === op).map(([, a]) => a);
const leuCobranca = (ops: [string, any][]) => ops.some(([o]) => o.startsWith('paymentGatewayCharge.'));
const VALOR = (250).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const BLOCO_PDF = '📎 Segue o boleto em anexo. Se preferir pagar por *PIX*, o código vai na *próxima mensagem* 👇';

/** A mensagem de 1 boleto com PDF e PIX, a partir do padrão do laboratório. */
function textoEsperado(stage: CobrancaStage, tipo: CobrancaTipo = 'boleto', data = VENCE[stage]) {
  const [, mes, dia] = data.split('-');
  return (padraoFinDoLaboratorio(stage, tipo) as string)
    .replace('{nome}', 'Carlos')
    .replace('{clinica}', NOME_DO_LAB)
    .replace('{valor}', VALOR)
    .replace('{data}', `${dia}/${mes}`)
    .replace('{codigo}', BLOCO_PDF);
}

function semTextoDeClinica(t: string): boolean {
  return !temVocabularioDeClinica(semVariaveis(t)) && !/instituto|banco passos|\bpaciente|\bconsulta|tratamento/i.test(t);
}

/** Evolution falsa do zero: cada envio responde um id novo (wamid-1, wamid-2...). */
function zerarEnvios() {
  (axios.post as jest.Mock).mockReset();
  let n = 0;
  (axios.post as jest.Mock).mockImplementation(async () => ({ data: { key: { id: `wamid-${++n}` } } }));
}

beforeAll(() => {
  for (const n of ['log', 'warn', 'debug', 'error'] as const) jest.spyOn(Logger.prototype, n).mockImplementation(() => undefined);
});

beforeEach(() => {
  __limparCacheLabTenants();
  __limparCacheEnvChip();
  delete process.env.EVOLUTION_INSTANCE_NAME;
  (axios.get as jest.Mock).mockReset();
  zerarEnvios();
  jest.useFakeTimers({
    now: AGORA,
    doNotFake: ['nextTick', 'setImmediate', 'clearImmediate', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'queueMicrotask', 'hrtime', 'performance'],
  });
});
afterEach(() => jest.useRealTimers());

// ─── Conta suspensa ou congelada ─────────────────────────────────────────────

describe('conta de laboratório suspensa ou congelada', () => {
  const ligada = (stage: CobrancaStage) => ({ cobrancas: [cobranca(LAB, stage)], settings: { [chaveDe(stage)]: 'true' } });

  it.each([
    ['SUSPENDED', { status: { [LAB]: 'SUSPENDED' } }],
    ['DELETED', { status: { [LAB]: 'DELETED' } }],
    ['LAB_FREEZE', { settings: { LAB_FREEZE: 'true' } }],
    ['LAB_FREEZE_<conta>', { settings: { [`LAB_FREEZE_${LAB}`]: 'true' } }],
  ])('%s: não envia nem lê a cobrança', async (_n, conta: any) => {
    const base = ligada('boleto_no_dia');
    const m = montar({ ...base, ...conta, settings: { ...base.settings, ...conta.settings } });
    await m.svc.sendOnePacedChargeDosLaboratorios();
    expect(posts()).toEqual([]);
    expect(leuCobranca(m.ops)).toBe(false);
  });

  it('atrasados e apresentação também param: a raia inteira da conta fica de fora', async () => {
    const m = montar({
      cobrancas: [cobranca(LAB, 'boleto_atrasado')],
      settings: { [chaveDe('boleto_atrasado')]: 'true', [`BOLETO_INTRO_ENABLED_${LAB}`]: 'true', [`BOLETO_DELIVERY_ENABLED_${LAB}`]: 'true' },
      status: { [LAB]: 'SUSPENDED' },
    });
    await m.svc.sendOnePacedChargeDosLaboratorios();
    expect(posts()).toEqual([]);
    expect(leuCobranca(m.ops)).toBe(false);
  });

  it('a conta suspensa não segura o outro laboratório', async () => {
    const m = montar({
      labs: [LAB, OUTRO_LAB],
      chips: [CHIP_FIN, { ...CHIP_FIN, name: 'chip-do-outro', tenant_id: OUTRO_LAB }],
      cobrancas: [cobranca(LAB, 'boleto_no_dia', { id: 'ch-1' }), cobranca(OUTRO_LAB, 'boleto_no_dia', { id: 'ch-2' })],
      settings: { [chaveDe('boleto_no_dia')]: 'true', [`BOLETO_NO_DIA_${OUTRO_LAB}`]: 'true' },
      status: { [LAB]: 'SUSPENDED' },
    });
    await m.svc.sendOnePacedChargeDosLaboratorios();
    expect(posts().length).toBeGreaterThan(0);
    expect(posts().every((p) => p.url.includes('chip-do-outro'))).toBe(true);
  });

  it('TRIAL envia e a conta que volta a ficar ativa volta a enviar', async () => {
    const trial = montar({ ...ligada('boleto_no_dia'), status: { [LAB]: 'TRIAL' } });
    await trial.svc.sendOnePacedChargeDosLaboratorios();
    expect(posts().length).toBeGreaterThan(0);

    zerarEnvios();
    __limparCacheLabTenants();
    const status: Record<string, string> = { [LAB]: 'SUSPENDED' };
    const m = montar({ ...ligada('boleto_no_dia'), status });
    await m.svc.sendOnePacedChargeDosLaboratorios();
    expect(posts()).toEqual([]);
    status[LAB] = 'ACTIVE';
    await m.svc.sendOnePacedChargeDosLaboratorios();
    expect(posts().length).toBeGreaterThan(0);
  });

  it('a raia das clínicas não lê o status de conta nenhuma', async () => {
    const m = montar({ labs: [], cobrancas: [cobranca(CLINICA, 'boleto_no_dia')], chips: [{ ...CHIP_FIN, name: 'chip-fin-clinica', tenant_id: CLINICA }], settings: { [`BOLETO_NO_DIA_${CLINICA}`]: 'true' } });
    await m.svc.sendOnePacedCharge();
    expect(m.ops.some(([op, a]) => op === 'tenant.findUnique' && a?.select?.status)).toBe(false);
  });
});

// ─── Regra 1: desligada por padrão, marco a marco ────────────────────────────

describe('liga por conta, marco a marco', () => {
  it.each(COBRANCA_STAGES)('%s: conta sem a chave não envia nem lê a cobrança', async (stage) => {
    const m = montar({ cobrancas: [cobranca(LAB, stage)] });
    await m.svc.sendOnePacedChargeDosLaboratorios();
    expect(posts()).toEqual([]);
    expect(leuCobranca(m.ops)).toBe(false);
  });

  it.each(COBRANCA_STAGES)("%s: chave em 'false' não envia nem lê a cobrança", async (stage) => {
    const m = montar({ cobrancas: [cobranca(LAB, stage)], settings: { [chaveDe(stage)]: 'false' } });
    await m.svc.sendOnePacedChargeDosLaboratorios();
    expect(posts()).toEqual([]);
    expect(leuCobranca(m.ops)).toBe(false);
  });

  it.each(COBRANCA_STAGES)('%s: só outro marco ligado na conta: esta cobrança não sai', async (stage) => {
    const outro: CobrancaStage = stage === 'boleto_no_dia' ? 'boleto_1d_antes' : 'boleto_no_dia';
    const m = montar({ cobrancas: [cobranca(LAB, stage)], settings: { [chaveDe(outro)]: 'true' } });
    await m.svc.sendOnePacedChargeDosLaboratorios();
    expect(posts()).toEqual([]);
  });

  it.each(COBRANCA_STAGES)('%s: ligado NA OUTRA conta não vale para esta', async (stage) => {
    const m = montar({ labs: [LAB, OUTRO_LAB], cobrancas: [cobranca(LAB, stage)], settings: { [chaveDe(stage, OUTRO_LAB)]: 'true' } });
    await m.svc.sendOnePacedChargeDosLaboratorios();
    expect(posts()).toEqual([]);
  });

  it.each(COBRANCA_STAGES)('%s: com a chave da própria conta, envia com o texto do laboratório pelo chip dela', async (stage) => {
    const c = cobranca(LAB, stage);
    const m = montar({ cobrancas: [c], settings: { [chaveDe(stage)]: 'true' } });
    await m.svc.sendOnePacedChargeDosLaboratorios();
    expect(posts()).toEqual([
      {
        url: `${EVO}/message/sendMedia/chip-fin-lab`,
        body: expect.objectContaining({ number: TEL, media: c.boleto_url, caption: textoEsperado(stage) }),
      },
      { url: `${EVO}/message/sendText/chip-fin-lab`, body: { number: TEL, text: c.pix_copy_paste } },
    ]);
    expect(de(m.ops, 'auditLog.create')[0].data).toMatchObject({ entity: 'PAYMENT_ALERT', action: stage, meta_json: { tenant_id: LAB, charge_ids: [c.id] } });
    expect(de(m.ops, 'dispatchLog.create')[0].data).toMatchObject({ tenant_id: LAB, type: stage, status: 'SENT' });
  });

  describe('apresentação e âncora do envio dos boletos', () => {
    const plano = (id = 'plano-1') => ({ id, patient_id: `pac-${LAB}`, tenant_id: LAB, patient: { name: 'Dra. Ana Souza', phone: TEL } });
    const venda = () =>
      cobranca(LAB, 'boleto_1d_antes', {
        treatment_plan_id: 'plano-1',
        created_at: new Date('2026-10-19T15:00:00.000Z'),
        due_date: new Date('2026-11-20T00:00:00.000Z'),
      });
    const INTRO = `BOLETO_INTRO_ENABLED_${LAB}`;
    const ENTREGA = `BOLETO_DELIVERY_ENABLED_${LAB}`;

    it('sem chave nenhuma: nem mensagem, nem âncora', async () => {
      const m = montar({ cobrancas: [venda()], planos: [plano()] });
      await m.svc.sendOnePacedChargeDosLaboratorios();
      expect(posts()).toEqual([]);
      expect(de(m.ops, 'auditLog.create')).toEqual([]);
      expect(leuCobranca(m.ops)).toBe(false);
    });

    it('só a apresentação ligada e a chave da entrega ausente: não herda (a clínica herda); nada sai', async () => {
      const m = montar({ cobrancas: [venda()], planos: [plano()], settings: { [INTRO]: 'true' } });
      await m.svc.sendOnePacedChargeDosLaboratorios();
      expect(posts()).toEqual([]);
      expect(de(m.ops, 'auditLog.create')).toEqual([]);
      await expect(m.svc.isDeliveryEnabled(LAB, true)).resolves.toBe(false);
      await expect(m.svc.isDeliveryEnabled(LAB)).resolves.toBe(true);
    });

    it('só a entrega ligada: ancora sem mandar mensagem', async () => {
      const m = montar({ cobrancas: [venda()], planos: [plano()], settings: { [ENTREGA]: 'true' } });
      await m.svc.sendOnePacedChargeDosLaboratorios();
      expect(posts()).toEqual([]);
      expect(de(m.ops, 'auditLog.create').map((a) => a.data)).toEqual([
        expect.objectContaining({ entity: 'BOLETO_INTRO', entity_id: 'plano-1', action: 'intro', meta_json: expect.objectContaining({ tenant_id: LAB }) }),
      ]);
    });

    it('apresentação e entrega ligadas: texto do laboratório, chip da conta e âncora', async () => {
      const m = montar({ cobrancas: [venda()], planos: [plano()], settings: { [INTRO]: 'true', [ENTREGA]: 'true' } });
      await m.svc.sendOnePacedChargeDosLaboratorios();
      expect(posts()).toEqual([
        {
          url: `${EVO}/message/sendText/chip-fin-lab`,
          body: { number: TEL, text: LAB_REGUA.apresentacao.replace('{nome}', 'Ana').replace('{clinica}', NOME_DO_LAB) },
        },
      ]);
      expect(de(m.ops, 'dispatchLog.create')[0].data).toMatchObject({ tenant_id: LAB, type: 'boleto_intro', status: 'SENT' });
      expect(semTextoDeClinica(textosEnviados()[0])).toBe(true);
      const groupBy = de(m.ops, 'paymentGatewayCharge.groupBy')[0].where;
      expect(groupBy).toMatchObject({ tenant_id: LAB, gateway: 'ASAAS', billing_type: 'BOLETO' });
    });

    it('venda de outra conta no plano: fora', async () => {
      const m = montar({
        cobrancas: [venda()],
        planos: [{ ...plano(), tenant_id: CLINICA }],
        settings: { [INTRO]: 'true', [ENTREGA]: 'true' },
      });
      await m.svc.sendOnePacedChargeDosLaboratorios();
      expect(posts()).toEqual([]);
    });
  });
});

// ─── Regra 2: texto ──────────────────────────────────────────────────────────

describe('texto do laboratório', () => {
  it('padrões da régua: sem vocabulário de clínica, nome do Instituto ou Banco PASSOS', () => {
    const todos = [
      ...COBRANCA_STAGES.flatMap((s) => COBRANCA_TIPOS.map((t) => padraoFinDoLaboratorio(s, t) as string)),
      LAB_REGUA.apresentacao,
      LAB_REGUA.entrega,
      LAB_REGUA.grupoAbertura('Carlos', 3, 'boletos', NOME_DO_LAB, VALOR),
    ];
    expect(todos.length).toBe(COBRANCA_STAGES.length * COBRANCA_TIPOS.length + 3);
    expect(todos.filter((t) => !semTextoDeClinica(t))).toEqual([]);
    for (const s of COBRANCA_STAGES) {
      for (const t of COBRANCA_TIPOS) {
        // Texto próprio do laboratório, com a variável que o envio troca (nunca o da clínica).
        const padrao = padraoFinDoLaboratorio(s, t) as string;
        expect(padrao).not.toBe(defaultCobrancaTemplate(s, t));
        expect(padrao).toContain('{codigo}');
        expect(padrao).toContain('{valor}');
        expect(padrao).not.toContain('{item}');
      }
    }
  });

  it('cada marco × tipo: o que sai não tem texto de clínica; {nome} sem Dr. e {clinica} é o laboratório', async () => {
    for (const stage of COBRANCA_STAGES) {
      for (const billing of [{ billing_type: 'PIX', boleto_url: null }, { billing_type: 'BOLETO' }, { billing_type: 'BOLETO', installment: { patient: { id: `pac-${LAB}`, name: 'Dr. Carlos Lima', phone: TEL, no_overdue_dunning: false } } }]) {
        zerarEnvios();
        __limparCacheLabTenants();
        const m = montar({ cobrancas: [cobranca(LAB, stage, billing)], settings: { [chaveDe(stage)]: 'true' } });
        await m.svc.sendOnePacedChargeDosLaboratorios();
        const [msg] = textosEnviados();
        expect(msg).toBeTruthy();
        expect([stage, semTextoDeClinica(msg)]).toEqual([stage, true]);
        expect(msg).toContain('Carlos');
        expect(msg).not.toContain('Dr.');
        expect(msg).toContain(NOME_DO_LAB);
        expect(msg).not.toMatch(/\{\w+\}/);
      }
    }
  });

  it('o editor vale: texto salvo do tipo sai; palavra de clínica cai no padrão do laboratório', async () => {
    const stage: CobrancaStage = 'boleto_atraso_3d';
    const chaveTipo = `COBRANCA_TEMPLATE_BOLETO_ATRASO_3D_BOLETO_${LAB}`;
    const proprio = montar({
      cobrancas: [cobranca(LAB, stage)],
      settings: { [chaveDe(stage)]: 'true', [chaveTipo]: JSON.stringify({ template: 'Oi {nome}, aqui é {clinica}: {valor}. {codigo}' }) },
    });
    await proprio.svc.sendOnePacedChargeDosLaboratorios();
    expect(textosEnviados()[0]).toBe(`Oi Carlos, aqui é ${NOME_DO_LAB}: ${VALOR}. ${BLOCO_PDF}`);

    zerarEnvios();
    __limparCacheLabTenants();
    const deClinica = montar({
      cobrancas: [cobranca(LAB, stage)],
      settings: { [chaveDe(stage)]: 'true', [chaveTipo]: JSON.stringify({ template: 'Oi {nome}, seu tratamento está em aberto. {codigo}' }) },
    });
    await deClinica.svc.sendOnePacedChargeDosLaboratorios();
    expect(textosEnviados()[0]).toBe(textoEsperado(stage));
  });

  it('o mesmo texto salvo com palavra de clínica continua saindo na clínica (lá ninguém filtra)', async () => {
    const m = montar({ settings: { [`COBRANCA_TEMPLATE_BOLETO_NO_DIA_${CLINICA}`]: JSON.stringify({ template: 'Seu tratamento {nome}' }) } });
    await expect(m.svc.resolveTemplate(CLINICA, 'boleto_no_dia', 'boleto')).resolves.toBe('Seu tratamento {nome}');
    await expect(m.svc.resolveTemplate(CLINICA, 'boleto_no_dia', 'boleto', false)).resolves.toBe('Seu tratamento {nome}');
  });

  it('conta sem nome: {clinica} vira o laboratório, nunca "a clínica"', async () => {
    const m = montar({ nomes: {}, cobrancas: [cobranca(LAB, 'boleto_no_dia')], settings: { [chaveDe('boleto_no_dia')]: 'true' } });
    await m.svc.sendOnePacedChargeDosLaboratorios();
    expect(textosEnviados()[0]).toContain(LAB_REGUA.laboratorioSemNome);
    expect(textosEnviados()[0]).not.toContain('clínica');
    await expect(m.svc.resolveClinicName(CLINICA)).resolves.toBe('a clínica');
  });

  it('cliente sem nome utilizável: "Cliente", nunca "Dr."', async () => {
    const m = montar({
      cobrancas: [cobranca(LAB, 'boleto_no_dia', { patient: { id: `pac-${LAB}`, name: 'Dra.', phone: TEL, no_overdue_dunning: false } })],
      settings: { [chaveDe('boleto_no_dia')]: 'true' },
    });
    await m.svc.sendOnePacedChargeDosLaboratorios();
    expect(textosEnviados()[0]).toContain(`Oi ${LAB_REGUA.clienteSemNome}!`);
  });

  it('aviso agrupado: abertura do laboratório; a da clínica não muda', () => {
    const plano = planGroup([
      { chargeId: 'a', amount: 100, dueDate: new Date('2026-10-05T00:00:00Z'), link: 'https://x.exemplo.test/a', pdfUrl: 'https://x.exemplo.test/a.pdf' },
      { chargeId: 'b', amount: 200, dueDate: new Date('2026-10-05T00:00:00Z'), link: 'https://x.exemplo.test/b', codigo: 'PIX-b' },
    ]);
    const lab = buildGroupMessage('Carlos', NOME_DO_LAB, 300, plano, true);
    expect(lab.split('\n\n')[0]).toBe(`Olá Carlos, você tem 2 cobranças em aberto com ${NOME_DO_LAB}, no total de *${(300).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })}*.`);
    expect(semTextoDeClinica(lab)).toBe(true);
    const clinica = buildGroupMessage('Maria', 'Clínica Exemplo', 300, plano);
    expect(clinica.split('\n\n')[0]).toBe(`Olá Maria, você tem 2 cobranças em aberto na Clínica Exemplo, no total de *${(300).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })}*.`);
    expect(lab.split('\n\n').slice(1)).toEqual(clinica.split('\n\n').slice(1));
  });
});

// ─── Regra 3: chip ───────────────────────────────────────────────────────────

describe('chip da própria conta', () => {
  const rodar = async (chips: any[]) => {
    const m = montar({ chips, cobrancas: [cobranca(LAB, 'boleto_no_dia')], settings: { [chaveDe('boleto_no_dia')]: 'true' } });
    await m.svc.sendOnePacedChargeDosLaboratorios();
    return m;
  };

  it.each([
    ['FINANCEIRO primeiro', [CHIP_COM, CHIP_ATEND, CHIP_FIN, CHIP_DA_CLINICA], 'chip-fin-lab'],
    ['sem Financeiro: Atendimento', [CHIP_COM, CHIP_ATEND, CHIP_DA_CLINICA], 'chip-atend-lab'],
    ['só Comercial', [CHIP_COM, CHIP_DA_CLINICA], 'chip-com-lab'],
  ])('%s', async (_n, chips, esperado) => {
    await rodar(chips);
    expect(posts().every((p) => p.url.endsWith(`/${esperado}`))).toBe(true);
    expect(posts().length).toBeGreaterThan(0);
  });

  it('sem chip da conta: não envia, registra a falha e o chip de outra conta fica de fora', async () => {
    const m = await rodar([CHIP_DA_CLINICA]);
    expect(posts()).toEqual([]);
    expect(de(m.ops, 'dispatchLog.create')[0].data).toMatchObject({ tenant_id: LAB, type: 'boleto_no_dia', status: 'FAILED' });
    expect(de(m.ops, 'auditLog.create')[0].data).toMatchObject({ entity: 'PAYMENT_ALERT', action: 'boleto_no_dia' });
  });

  it('nunca o chip padrão do servidor, mesmo com a conta registrada como dona dele', async () => {
    process.env.EVOLUTION_INSTANCE_NAME = 'chip-do-servidor';
    const m = await rodar([{ name: 'chip-do-servidor', purpose: null, tenant_id: LAB, type: 'whatsapp' }]);
    expect(posts()).toEqual([]);
    expect(de(m.ops, 'instance.findUnique')).toEqual([]);
    expect(de(m.ops, 'instance.findFirst').map((a) => a.where.purpose)).toEqual(['FINANCEIRO', 'CLINICA', 'COMERCIAL']);
    expect(de(m.ops, 'instance.findFirst').every((a) => a.where.tenant_id === LAB)).toBe(true);
    // A clínica dona continua usando o chip do servidor, como hoje.
    await expect(m.svc.resolveFinanceiroInstance(LAB)).resolves.toBe('chip-do-servidor');
  });

  it('apresentação sem chip da conta: não envia e registra a falha, nem com a conta dona do chip do servidor', async () => {
    process.env.EVOLUTION_INSTANCE_NAME = 'chip-do-servidor';
    const m = montar({
      chips: [CHIP_DA_CLINICA, { name: 'chip-do-servidor', purpose: null, tenant_id: LAB, type: 'whatsapp' }],
      cobrancas: [cobranca(LAB, 'boleto_1d_antes', { treatment_plan_id: 'plano-1', created_at: new Date('2026-10-19T15:00:00.000Z'), due_date: new Date('2026-11-20T00:00:00.000Z') })],
      planos: [{ id: 'plano-1', patient_id: `pac-${LAB}`, tenant_id: LAB, patient: { name: 'Dra. Ana Souza', phone: TEL } }],
      settings: { [`BOLETO_INTRO_ENABLED_${LAB}`]: 'true', [`BOLETO_DELIVERY_ENABLED_${LAB}`]: 'true' },
    });
    await m.svc.sendOnePacedChargeDosLaboratorios();
    expect(posts()).toEqual([]);
    expect(de(m.ops, 'dispatchLog.create')[0].data).toMatchObject({ tenant_id: LAB, type: 'boleto_intro', status: 'FAILED' });
    expect(de(m.ops, 'instance.findUnique')).toEqual([]);
  });

  it('sem chip da conta: a falha anda no ritmo da conta, não 1 por minuto', async () => {
    const m = montar({
      chips: [],
      cobrancas: [cobranca(LAB, 'boleto_no_dia'), cobranca(LAB, 'boleto_atraso_1d')],
      settings: { [chaveDe('boleto_no_dia')]: 'true', [chaveDe('boleto_atraso_1d')]: 'true' },
    });
    await m.svc.sendOnePacedChargeDosLaboratorios();
    expect(de(m.ops, 'dispatchLog.create')).toHaveLength(1);
    jest.setSystemTime(new Date(AGORA.getTime() + 60_000));
    await m.svc.sendOnePacedChargeDosLaboratorios();
    expect(de(m.ops, 'dispatchLog.create')).toHaveLength(1);
    jest.setSystemTime(new Date(AGORA.getTime() + 8 * 60_000));
    await m.svc.sendOnePacedChargeDosLaboratorios();
    expect(de(m.ops, 'dispatchLog.create')).toHaveLength(2);
    expect(posts()).toEqual([]);
  });
});

// ─── Regra 4: dinheiro ───────────────────────────────────────────────────────

describe('só boleto da conta Asaas da própria conta, com as proteções da clínica', () => {
  const NO_DIA = { [chaveDe('boleto_no_dia')]: 'true' };

  it('a busca é só da conta e só do Asaas: gateway local e outra conta ficam de fora', async () => {
    const local = cobranca(LAB, 'boleto_no_dia', { gateway: 'LOCAL' });
    const outra = cobranca(OUTRO_LAB, 'boleto_no_dia');
    const m = montar({ labs: [LAB, OUTRO_LAB], cobrancas: [local, outra], settings: NO_DIA });
    await m.svc.sendOnePacedChargeDosLaboratorios();
    expect(posts()).toEqual([]);
    expect(de(m.ops, 'paymentGatewayCharge.findMany')[0].where).toMatchObject({ tenant_id: LAB, gateway: 'ASAAS' });
    expect(de(m.ops, 'dispatchLog.create')).toEqual([]);
  });

  it('cobrança de carteira antiga: a varredura também é só da conta e só do Asaas', async () => {
    const m = montar({ cobrancas: [cobranca(LAB, 'boleto_atrasado', { gateway: 'LOCAL' })], settings: { [chaveDe('boleto_atrasado')]: 'true' } });
    await m.svc.sendOnePacedChargeDosLaboratorios();
    expect(posts()).toEqual([]);
    const buscas = de(m.ops, 'paymentGatewayCharge.findMany');
    expect(buscas[buscas.length - 1].where).toMatchObject({ tenant_id: { in: [LAB] }, gateway: 'ASAAS' });
  });

  it('confere no Asaas com a chave da conta antes de enviar', async () => {
    const c = cobranca(LAB, 'boleto_no_dia');
    const m = montar({ cobrancas: [c], settings: NO_DIA });
    await m.svc.sendOnePacedChargeDosLaboratorios();
    expect(m.settingsSvc.getAsaasConfig.mock.calls.every((a: any[]) => a[0] === LAB)).toBe(true);
    const [url, opcoes] = (axios.get as jest.Mock).mock.calls[0];
    expect(url).toBe(`https://asaas.exemplo.test/${LAB}/payments/${c.external_id}`);
    expect(opcoes.headers.access_token).toBe(`chave-${LAB}`);
  });

  it('pago no Asaas com o status local velho: não cobra', async () => {
    const c = cobranca(LAB, 'boleto_no_dia');
    const m = montar({ cobrancas: [c], settings: NO_DIA, asaas: { [c.external_id]: 'RECEIVED' } });
    await m.svc.sendOnePacedChargeDosLaboratorios();
    expect(posts()).toEqual([]);
    expect(de(m.ops, 'auditLog.create')).toEqual([]);
    expect(m.svc.freioBarrado({ patientId: `pac-${LAB}`, stage: 'boleto_no_dia', tenantId: LAB })).toBe(true);
  });

  it('não existe nesta conta Asaas (404), ou Asaas fora do ar: não cobra', async () => {
    for (const erro of [404, 503]) {
      zerarEnvios();
      __limparCacheLabTenants();
      const c = cobranca(LAB, 'boleto_no_dia');
      const m = montar({ cobrancas: [c], settings: NO_DIA, asaas: { [c.external_id]: erro } });
      await m.svc.sendOnePacedChargeDosLaboratorios();
      expect(posts()).toEqual([]);
      expect(de(m.ops, 'auditLog.create')).toEqual([]);
    }
  });

  it('conta sem chave Asaas própria: nada sai e a conta fica barrada por 1 h', async () => {
    const m = montar({ cobrancas: [cobranca(LAB, 'boleto_no_dia')], settings: NO_DIA, contasAsaas: [CLINICA] });
    await m.svc.sendOnePacedChargeDosLaboratorios();
    expect(posts()).toEqual([]);
    expect(m.svc.freioBarrado({ patientId: 'qualquer', stage: 'boleto_atraso_1d', tenantId: LAB })).toBe(true);
    expect(m.svc.freioBarrado({ patientId: 'qualquer', stage: 'boleto_atraso_1d', tenantId: CLINICA })).toBe(false);
  });

  it('agrupa por cliente: 2 boletos no mesmo marco = 1 aviso com o total e os 2 PDFs', async () => {
    const a = cobranca(LAB, 'boleto_atraso_1d');
    const b = cobranca(LAB, 'boleto_atraso_1d');
    const m = montar({ cobrancas: [a, b], settings: { [chaveDe('boleto_atraso_1d')]: 'true' } });
    await m.svc.sendOnePacedChargeDosLaboratorios();
    expect(posts().map((p) => p.body.media)).toEqual([a.boleto_url, b.boleto_url]);
    expect(posts()[0].body.caption).toContain(`2 boletos em aberto com ${NOME_DO_LAB}`);
    expect(semTextoDeClinica(posts()[0].body.caption)).toBe(true);
    expect(posts()[1].body.caption).toBe('');
    expect(de(m.ops, 'auditLog.create')[0].data.meta_json.charge_ids).toEqual([a.id, b.id]);
  });

  it('agrupado com 1 já paga: o freio tira a paga e o aviso vira o de boleto único', async () => {
    const paga = cobranca(LAB, 'boleto_atraso_1d');
    const aberta = cobranca(LAB, 'boleto_atraso_1d');
    const m = montar({ cobrancas: [paga, aberta], settings: { [chaveDe('boleto_atraso_1d')]: 'true' }, asaas: { [paga.external_id]: 'CONFIRMED' } });
    await m.svc.sendOnePacedChargeDosLaboratorios();
    expect(posts()[0].body.media).toBe(aberta.boleto_url);
    expect(posts()[0].body.caption).toBe(textoEsperado('boleto_atraso_1d'));
  });

  it('marco já enviado para o boleto não repete; a parcela seguinte recebe', async () => {
    const c = cobranca(LAB, 'boleto_no_dia');
    const envio = { entity: 'PAYMENT_ALERT', entity_id: `pac-${LAB}`, action: 'boleto_no_dia', created_at: new Date('2026-10-20T14:00:00.000Z'), meta_json: { charge_ids: [c.id] } };
    const m = montar({ cobrancas: [c], settings: NO_DIA, avisos: [{ ...envio }] });
    await m.svc.sendOnePacedChargeDosLaboratorios();
    expect(posts()).toEqual([]);

    zerarEnvios();
    __limparCacheLabTenants();
    const nova = cobranca(LAB, 'boleto_no_dia');
    const n = montar({ cobrancas: [c, nova], settings: NO_DIA, avisos: [{ ...envio }] });
    await n.svc.sendOnePacedChargeDosLaboratorios();
    expect(posts().map((p) => p.body.media).filter(Boolean)).toEqual([nova.boleto_url]);
  });

  it('carteira de atrasados: 1 toque por semana, contando qualquer marco', async () => {
    const liga = { [chaveDe('boleto_atrasado')]: 'true' };
    const aviso = (dias: number) => ({
      entity: 'PAYMENT_ALERT', entity_id: `pac-${LAB}`, action: 'boleto_atraso_1d', created_at: new Date(AGORA.getTime() - dias * 86_400_000), meta_json: { charge_ids: ['outra'] },
    });
    const recente = montar({ cobrancas: [cobranca(LAB, 'boleto_atrasado')], settings: liga, avisos: [aviso(3)] });
    await recente.svc.sendOnePacedChargeDosLaboratorios();
    expect(posts()).toEqual([]);

    __limparCacheLabTenants();
    const antigo = montar({ cobrancas: [cobranca(LAB, 'boleto_atrasado')], settings: liga, avisos: [aviso(8)] });
    await antigo.svc.sendOnePacedChargeDosLaboratorios();
    expect(posts().length).toBeGreaterThan(0);
    expect(posts()[0].body.caption).toBe(textoEsperado('boleto_atrasado'));
  });

  it('cobrança nascida hoje e cliente com opt-out de atraso não recebem', async () => {
    const hoje = montar({ cobrancas: [cobranca(LAB, 'boleto_no_dia', { created_at: new Date('2026-10-20T14:00:00.000Z') })], settings: NO_DIA });
    await hoje.svc.sendOnePacedChargeDosLaboratorios();
    expect(posts()).toEqual([]);

    __limparCacheLabTenants();
    const optout = montar({
      cobrancas: [cobranca(LAB, 'boleto_atraso_1d', { patient: { id: `pac-${LAB}`, name: 'Dr. Carlos Lima', phone: TEL, no_overdue_dunning: true } })],
      settings: { [chaveDe('boleto_atraso_1d')]: 'true', [chaveDe('boleto_atrasado')]: 'true' },
    });
    await optout.svc.sendOnePacedChargeDosLaboratorios();
    expect(posts()).toEqual([]);
  });

  it('fim de semana: na sexta antecipa o "1 dia antes" e na segunda repesca o marco de atraso perdido', async () => {
    jest.setSystemTime(new Date('2026-10-23T15:00:00.000Z')); // sexta
    const seg = cobranca(LAB, 'boleto_1d_antes', { due_date: new Date('2026-10-26T00:00:00.000Z') });
    const sexta = montar({ cobrancas: [seg], settings: { [chaveDe('boleto_1d_antes')]: 'true' } });
    await sexta.svc.sendOnePacedChargeDosLaboratorios();
    expect(posts()[0].body.caption).toContain('vence *na segunda-feira (26/10)*');

    zerarEnvios();
    __limparCacheLabTenants();
    jest.setSystemTime(new Date('2026-10-26T15:00:00.000Z')); // segunda
    const quarta = cobranca(LAB, 'boleto_atraso_3d', { due_date: new Date('2026-10-21T00:00:00.000Z') });
    const segunda = montar({ cobrancas: [quarta], settings: { [chaveDe('boleto_atraso_3d')]: 'true' } });
    await segunda.svc.sendOnePacedChargeDosLaboratorios();
    expect(posts()[0].body.caption).toContain('em aberto há *3 dias*');
    expect(de(segunda.ops, 'auditLog.create')[0].data.action).toBe('boleto_atraso_3d');
  });

  it('cadastro de outra conta na cobrança da conta: fora da fila, nada sai', async () => {
    const m = montar({
      cobrancas: [cobranca(LAB, 'boleto_no_dia', { patient: { id: 'pac-outro', tenant_id: CLINICA, name: 'Maria', phone: TEL, no_overdue_dunning: false } })],
      settings: NO_DIA,
    });
    await m.svc.sendOnePacedChargeDosLaboratorios();
    expect(posts()).toEqual([]);
    expect(de(m.ops, 'patient.findMany')[0].where).toEqual({ id: { in: ['pac-outro'] }, tenant_id: LAB });
  });
});

// ─── Trava entre workers e ritmo ─────────────────────────────────────────────

describe('trava contra 2 workers e marca-passo', () => {
  const NO_DIA = { [chaveDe('boleto_no_dia')]: 'true' };

  it('dois workers no mesmo minuto: só quem reserva a vez do chip envia', async () => {
    const c = cobranca(LAB, 'boleto_no_dia');
    const m = montar({ cobrancas: [c], settings: NO_DIA });
    const a = m.novoServico();
    const b = m.novoServico();
    await Promise.all([a.sendOnePacedChargeDosLaboratorios(), b.sendOnePacedChargeDosLaboratorios()]);
    expect(posts().filter((p) => p.body.media === c.boleto_url)).toHaveLength(1);
    expect(de(m.ops, 'auditLog.create')).toHaveLength(1);
    expect(de(m.ops, 'dispatchLog.create')).toHaveLength(1);
  });

  it('worker reiniciado (sem o ritmo em memória) respeita a vez do chip gravada no banco', async () => {
    const c = cobranca(LAB, 'boleto_no_dia');
    const pacer = new Map<string, Date>([['chip-fin-lab', new Date(AGORA.getTime() + 60_000)]]);
    const m = montar({ cobrancas: [c], settings: NO_DIA, pacer });
    await m.svc.sendOnePacedChargeDosLaboratorios();
    expect(posts()).toEqual([]);
    expect(de(m.ops, 'auditLog.create')).toEqual([]);
  });

  it('falha ao reservar a vez do chip: não envia agora', async () => {
    const m = montar({ cobrancas: [cobranca(LAB, 'boleto_no_dia')], settings: NO_DIA });
    const proxy = new Proxy(m.prisma, { get: (t, p: string) => (p === 'whatsappChipPacer' ? { createMany: async () => { throw new Error('banco fora'); }, updateMany: async () => ({ count: 1 }) } : t[p]) });
    const svc = new PaymentAlertsCronService(proxy, m.settingsSvc) as any;
    await svc.sendOnePacedChargeDosLaboratorios();
    expect(posts()).toEqual([]);
    expect(de(m.ops, 'auditLog.create')).toEqual([]);
  });

  it('o envio do laboratório anda só o ritmo dele: o da clínica fica parado e o outro laboratório não espera', async () => {
    const chipOutro = { name: 'chip-outro-lab', purpose: 'FINANCEIRO', tenant_id: OUTRO_LAB, type: 'whatsapp' };
    const m = montar({
      labs: [LAB, OUTRO_LAB],
      chips: [CHIP_FIN, chipOutro],
      cobrancas: [cobranca(LAB, 'boleto_no_dia'), cobranca(LAB, 'boleto_atraso_1d'), cobranca(OUTRO_LAB, 'boleto_no_dia')],
      settings: { [chaveDe('boleto_no_dia')]: 'true', [chaveDe('boleto_atraso_1d')]: 'true', [chaveDe('boleto_no_dia', OUTRO_LAB)]: 'true' },
    });
    await m.svc.sendOnePacedChargeDosLaboratorios();
    expect(m.svc.lastSentAt).toBe(0);
    expect(m.svc.nextGapMs).toBe(0);
    const enviados = () => de(m.ops, 'auditLog.create').map((a) => a.data.meta_json.tenant_id);
    expect(enviados()).toEqual([LAB, OUTRO_LAB]);
    // No minuto seguinte, a 2ª cobrança da conta espera o ritmo dela.
    jest.setSystemTime(new Date(AGORA.getTime() + 60_000));
    await m.svc.sendOnePacedChargeDosLaboratorios();
    expect(enviados()).toEqual([LAB, OUTRO_LAB]);
    // Passado o intervalo (no máximo 7 min), sai.
    jest.setSystemTime(new Date(AGORA.getTime() + 8 * 60_000));
    await m.svc.sendOnePacedChargeDosLaboratorios();
    expect(enviados()).toEqual([LAB, OUTRO_LAB, LAB]);
  });

  it('um laboratório com problema não segura o outro nem lança para o cron', async () => {
    const chipOutro = { name: 'chip-outro-lab', purpose: 'FINANCEIRO', tenant_id: OUTRO_LAB, type: 'whatsapp' };
    const c = cobranca(OUTRO_LAB, 'boleto_no_dia');
    const m = montar({
      labs: [LAB, OUTRO_LAB],
      chips: [CHIP_FIN, chipOutro],
      cobrancas: [cobranca(LAB, 'boleto_no_dia'), c],
      settings: { [chaveDe('boleto_no_dia')]: 'true', [chaveDe('boleto_no_dia', OUTRO_LAB)]: 'true' },
    });
    const proxy = new Proxy(m.prisma, {
      get: (t, p: string) =>
        p === 'paymentGatewayCharge'
          ? {
              ...['groupBy', 'update'].reduce((o: any, k) => ({ ...o, [k]: t.paymentGatewayCharge[k] }), {}),
              findMany: async (a: any) => {
                if (a.where.tenant_id === LAB) throw new Error('banco fora');
                return t.paymentGatewayCharge.findMany(a);
              },
            }
          : t[p],
    });
    const svc = new PaymentAlertsCronService(proxy, m.settingsSvc) as any;
    await expect(svc.sendOnePacedChargeDosLaboratorios()).resolves.toBeUndefined();
    expect(posts().map((p) => p.body.media).filter(Boolean)).toEqual([c.boleto_url]);
  });

  it('sem laboratório cadastrado: nenhuma leitura além da lista', async () => {
    const m = montar({ labs: [], settings: { [chaveDe('boleto_no_dia')]: 'true' } });
    await m.svc.sendOnePacedChargeDosLaboratorios();
    expect(m.ops.map(([o]) => o)).toEqual(['tenantBusinessProfile.findMany']);
  });
});

// ─── Regra 5: clínica igual ──────────────────────────────────────────────────

describe('clínica igual', () => {
  const daClinica = () => [cobranca(CLINICA, 'boleto_no_dia', { id: 'ch-clinica' })];
  const chips = [CHIP_FIN, CHIP_DA_CLINICA];
  const ligada = { [`BOLETO_NO_DIA_${CLINICA}`]: 'true' };

  it('o tick roda a raia das clínicas primeiro, com as mesmas leituras e envios de antes', async () => {
    // Só a raia das clínicas, como era antes (o laboratório fora da busca).
    const antes = montar({ chips, cobrancas: daClinica(), settings: ligada });
    await antes.svc.sendOnePacedCharge();
    const postsAntes = posts();
    const opsAntes = [...antes.ops];

    // O tick inteiro, com um laboratório ligado e com cobrança para enviar.
    zerarEnvios();
    __limparCacheLabTenants();
    const doLab = cobranca(LAB, 'boleto_no_dia', { id: 'ch-lab' });
    const depois = montar({
      chips,
      cobrancas: [...daClinica(), doLab],
      settings: { ...ligada, [chaveDe('boleto_no_dia')]: 'true' },
    });
    await depois.svc.pacerTick();
    // As leituras e gravações da clínica são as primeiras e são as mesmas.
    expect(JSON.parse(JSON.stringify(depois.ops.slice(0, opsAntes.length)))).toEqual(JSON.parse(JSON.stringify(opsAntes)));
    // Os envios da clínica saem iguais, pelo chip dela; os do laboratório vêm depois.
    expect(posts().slice(0, postsAntes.length)).toEqual(postsAntes);
    expect(postsAntes[0].url).toContain('chip-fin-clinica');
    expect(posts().slice(postsAntes.length).every((p) => p.url.includes('chip-fin-lab'))).toBe(true);
    expect(posts().slice(postsAntes.length).length).toBeGreaterThan(0);
    // O ritmo da clínica é o dela (avançado pelo envio dela, não pelo do laboratório).
    expect(depois.svc.lastSentAt).toBe(AGORA.getTime());
  });

  it('a busca das clínicas continua sem cobrança de laboratório, com o where de antes', async () => {
    const m = montar({ chips, cobrancas: [cobranca(LAB, 'boleto_no_dia'), ...daClinica()], settings: { ...ligada, [chaveDe('boleto_no_dia')]: 'true' } });
    const pick = await m.svc.findNextCharge();
    expect(pick).toMatchObject({ chargeId: 'ch-clinica', tenantId: CLINICA });
    const where = de(m.ops, 'paymentGatewayCharge.findMany')[0].where;
    expect(where.AND[1]).toEqual({ OR: [{ tenant_id: null }, { tenant_id: { notIn: [LAB] } }] });
    expect(where.AND[0]).not.toHaveProperty('gateway');
    expect(de(m.ops, 'patient.findMany')).toEqual([]);
    expect(de(m.ops, 'whatsappChipPacer.updateMany')).toEqual([]);
  });

  it('a clínica não reserva a vez do chip no banco nem lê o marca-passo dele', async () => {
    const m = montar({ chips, cobrancas: daClinica(), settings: ligada, labs: [] });
    await m.svc.sendOnePacedCharge();
    expect(posts().length).toBeGreaterThan(0);
    expect(m.ops.some(([o]) => o.startsWith('whatsappChipPacer.'))).toBe(false);
    expect(textosEnviados()[0]).toBe(
      defaultCobrancaTemplate('boleto_no_dia', 'boleto')
        .replace('{nome}', 'Dr.')
        .replace('{data}', '20/10')
        .replace('{valor}', VALOR)
        .replace('{codigo}', BLOCO_PDF),
    );
  });

  it('conversa do Financeiro criada pela régua: ai_mode só no laboratório', async () => {
    const tx: any = {
      conversation: { create: jest.fn(async () => ({ id: 'conv-1' })) },
      message: { create: jest.fn(async () => ({})) },
    };
    const banco: any = {
      inbox: { findFirst: async () => ({ id: 'inbox-fin' }) },
      lead: { findFirst: async () => ({ id: 'lead-1' }) },
      conversation: { findFirst: async () => null },
      $transaction: async (cb: any) => cb(tx),
    };
    const svc = new PaymentAlertsCronService(banco, {} as any) as any;
    await svc.registerInFinanceiroConversation(LAB, TEL, 'Oi', 'wamid-1', 'chip-fin-lab', true);
    await svc.registerInFinanceiroConversation(CLINICA, TEL, 'Oi', 'wamid-2', 'chip-fin-clinica');
    expect(tx.conversation.create.mock.calls[0][0].data.ai_mode).toBe(false);
    expect(tx.conversation.create.mock.calls[1][0].data).not.toHaveProperty('ai_mode');
  });

  it('conversa do Financeiro criada pela régua: com o chip Financeiro ligado e a conta ativa, nasce com a IA', async () => {
    const tx: any = {
      conversation: { create: jest.fn(async () => ({ id: 'conv-1' })) },
      message: { create: jest.fn(async () => ({})) },
    };
    const banco: any = {
      inbox: { findFirst: async () => ({ id: 'inbox-fin' }) },
      lead: { findFirst: async () => ({ id: 'lead-1' }) },
      conversation: { findFirst: async () => null },
      tenantSetting: { findUnique: async () => ({ value: 'true' }) },
      tenant: { findUnique: async () => ({ status: 'ACTIVE' }) },
      globalSetting: { findMany: async () => [] },
      $transaction: async (cb: any) => cb(tx),
    };
    const svc = new PaymentAlertsCronService(banco, {} as any) as any;
    await svc.registerInFinanceiroConversation(LAB, TEL, 'Oi', 'wamid-1', 'chip-fin-lab', true);
    expect(tx.conversation.create.mock.calls[0][0].data.ai_mode).toBe(true);
  });
});

/**
 * F2 parte 2c do laboratório — gatilhos por EVENTO e AÇÕES de clínica na API.
 *
 * Efeito AUTOMÁTICO disparado por evento (TCLE no aceite, retorno ao concluir,
 * tarefa→agenda, aviso de agendamento, lembretes, lista de espera, pesquisa
 * pós-atendimento, follow-up, regras de automação, adoção de lead órfão, pasta no
 * Drive, mensagens do fechamento com texto de clínica): no laboratório não acontece,
 * em silêncio, com log `[LAB-GATE]`; a ação principal (aceitar, concluir, criar a
 * tarefa, agendar) continua.
 *
 * AÇÃO do usuário que só existe para clínica (seeds, portal/magic link, envio do
 * orçamento, contrato odontológico, contrato jurídico legado, TCLE manual,
 * manutenção/retorno manual, reenvio de lembrete...): no laboratório é RECUSADA com
 * 403 `VERTICAL_DENIED`. Laços de TODAS as contas (seed de todas, anamnese master)
 * pulam o laboratório.
 *
 * No laboratório o plano do aceite (simples e parcial) nasce ACTIVE (não há TCLE).
 *
 * Cada freio tem três casos: (a) sem laboratório cadastrado (o caso de produção hoje)
 * = mesmas chamadas e argumentos de antes (os casos (a) e (b) passam também contra o
 * código anterior); (b) clínica com OUTRA conta laboratório = igual ao (a); (c)
 * laboratório = o efeito não acontece / a ação é recusada.
 *
 * O banco falso grava cada operação (menos a leitura da lista de laboratórios, a única
 * coisa nova para a clínica) e responde aos where só no que importa aqui: a conta da
 * linha contra `tenant_id: null | { notIn } | { in }`, como o Postgres.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as ts from 'typescript';
import { BadRequestException, Logger, NotFoundException } from '@nestjs/common';
import { __limparCacheLabTenants } from '@crm/shared';
import { CODIGO_VERTICAL_NEGADA, negarLaboratorio } from '../common/lab-gate.util';
import { TreatmentPlanContractService } from '../commercial/treatment-plan-contract.service';
import { QuotesService } from '../commercial/quotes.service';
import { TreatmentPlansService } from '../commercial/treatment-plans.service';
import { MaintenanceService } from '../maintenance/maintenance.service';
import { ReturnAlertsService } from '../agenda-extended/return-alerts.service';
import { TasksService } from '../tasks/tasks.service';
import { WaitlistService } from '../waitlist/waitlist.service';
import { PostCareService } from '../post-care/post-care.service';
import { FollowupService } from '../followup/followup.service';
import { AutomationsService } from '../automations/automations.service';
import { LeadsService } from '../leads/leads.service';
import { GoogleDriveController } from '../google-drive/google-drive.controller';
import { ContractsService } from '../commercial/contracts.service';
import { ContractWhatsappService } from '../commercial/contract-whatsapp.service';
import { TenantsService } from '../tenants/tenants.service';
import { GlobalAnamnesisService } from '../global-anamnesis/global-anamnesis.service';
import { PipelinesService } from '../pipelines/pipelines.service';
import { PortalAuthService } from '../portal/portal-auth.service';
import { ClicksignService } from '../clicksign/clicksign.service';
import { ContractsService as ContratoJuridicoService } from '../contracts/contracts.service';
import { invalidateAllSettings } from '../tenants/tenant-settings.helper';

// ─── Dados de exemplo (repositório público: nada real) ───────────────────────
const CLINICA = 'tenant-clinica';
const OUTRA_CLINICA = 'tenant-clinica-2';
const LAB = 'tenant-lab';
const AGORA = new Date('2026-10-21T15:00:00.000Z'); // quarta, 12:00 em Maceió
const TEL: Record<string, string> = {
  [CLINICA]: '5582900000001',
  [OUTRA_CLINICA]: '5582900000002',
  [LAB]: '5582900000003',
};
const OR_SEM_LAB = { OR: [{ tenant_id: null }, { tenant_id: { notIn: [LAB] } }] };

// ─── Carregador do CalendarService (o import dinâmico do @crm/shared vira require) ─
// Mesmo carregador do retrato mensagens-paciente e da parte 2b: o jest deste projeto
// não executa `await import('@crm/shared')`; o resto é o código de produção.
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
const { CalendarService } = carregarFonte('calendar/calendar.service.ts');

// ─── Logs (o [LAB-GATE] e os avisos de falha são conferidos) ─────────────────
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
  // Só o relógio é falso; promessas e timers seguem reais.
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

// ─── Banco falso ─────────────────────────────────────────────────────────────

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

/** Avalia o where na linha, só pela conta (da linha e do contato/paciente dela). */
function casa(where: any, linha: any): boolean {
  if (!where || typeof where !== 'object') return true;
  return Object.entries(where).every(([k, v]: [string, any]) => {
    if (k === 'AND') return (Array.isArray(v) ? v : [v]).every((w) => casa(w, linha));
    if (k === 'OR') return (v as any[]).some((w) => casa(w, linha));
    if (k === 'NOT') return !casa(v, linha);
    if (k === 'tenant_id') {
      const t = linha?.tenant_id ?? null;
      if (v === null) return t === null;
      if (typeof v === 'string') return t === v;
      if (v && 'notIn' in v) return t !== null && !v.notIn.includes(t); // NOT IN exclui NULL
      if (v && 'in' in v) return t !== null && v.in.includes(t);
      if (v && 'not' in v && v.not === null) return t !== null;
      return true;
    }
    if (k === 'lead' || k === 'patient') return casa(v, linha?.[k]);
    return true; // o resto do where não importa aqui
  });
}

const tocaLab = (x: unknown) => JSON.stringify(x).includes(LAB);
/** O rastro sem as operações que citam o laboratório. */
const semOLab = (ops: Op[]) => ops.filter((o) => !tocaLab(o));
const esperar = async () => {
  for (let i = 0; i < 30; i++) await new Promise((r) => setImmediate(r));
};
/** O erro que a promessa lançou (falha o teste se não lançar). */
async function erro(p: Promise<unknown>): Promise<any> {
  try {
    await p;
  } catch (e) {
    return e;
  }
  throw new Error('era para lançar e não lançou');
}
const codigo = (e: any) => e?.getResponse?.()?.code;

// ═════════════════════════════════════════════════════════════════════════════
// TCLE e plano no aceite
// ═════════════════════════════════════════════════════════════════════════════

describe('TCLE (sendForSignature) — laboratório recusa; o aceite em segundo plano só registra', () => {
  function montar(labs: string[], conta = CLINICA) {
    const b = banco(labs, {
      'treatmentPlan.findUnique': ({ where }) => ({
        id: where.id,
        status: 'PENDING_SIGNATURE',
        contract_signature_id: null,
        patient: { tenant_id: conta, lead_id: `lead-${conta}`, name: 'Maria Exemplo', phone: TEL[conta], email: null },
        items: [],
      }),
      'tenant.findUnique': () => ({ name: 'Clínica Exemplo' }),
    });
    const clicksign = {
      createGenericSignature: jest.fn(async (_a: any) => ({ signingUrl: 'https://assinar.exemplo.test/x', contractSignatureId: 'assinatura-1' })),
    };
    const messages = { sendPatientText: jest.fn(async (_a: any) => ({})) };
    const svc = new TreatmentPlanContractService(b.prisma, clicksign as any, messages as any, {} as any);
    const conversa = jest.spyOn(svc as any, 'resolvePatientConversation').mockResolvedValue('conversa-1');
    jest.spyOn(svc as any, 'generateTclePdf').mockResolvedValue(Buffer.from('%PDF-exemplo'));
    return { svc, clicksign, messages, conversa, ...b };
  }

  it('clínica, sem laboratório: gera, sobe na ClickSign, liga ao plano e manda o link, como antes', async () => {
    const m = montar([]);
    const r = await m.svc.sendForSignature('plano-1', CLINICA);
    expect(r).toEqual({ signingUrl: 'https://assinar.exemplo.test/x', whatsappSent: true });
    expect(m.nomes()).toEqual(['treatmentPlan.findUnique', 'treatmentPlan.update', 'tenant.findUnique']);
    expect(m.de('treatmentPlan.update')).toEqual([{ where: { id: 'plano-1' }, data: { contract_signature_id: 'assinatura-1' } }]);
    expect(m.conversa).toHaveBeenCalledWith(`lead-${CLINICA}`, CLINICA, TEL[CLINICA]);
    expect(m.clicksign.createGenericSignature).toHaveBeenCalledTimes(1);
    expect(m.messages.sendPatientText.mock.calls[0][0]).toMatchObject({ conversationId: 'conversa-1', tenantId: CLINICA, expectedPhone: TEL[CLINICA] });
  });

  it('clínica com OUTRA conta laboratório: o mesmo rastro e o mesmo envio', async () => {
    const antes = montar([]);
    await antes.svc.sendForSignature('plano-1', CLINICA);
    const depois = montar([LAB]);
    await depois.svc.sendForSignature('plano-1', CLINICA);
    expect(depois.ops).toEqual(antes.ops);
    expect(depois.clicksign.createGenericSignature.mock.calls).toEqual(antes.clicksign.createGenericSignature.mock.calls.map((c: any[]) => [{ ...c[0], filename: expect.any(String) }]));
    expect(depois.messages.sendPatientText.mock.calls).toEqual(antes.messages.sendPatientText.mock.calls);
  });

  it('laboratório: recusa (VERTICAL_DENIED) antes de gerar, subir ou mandar', async () => {
    const m = montar([LAB], LAB);
    const e = await erro(m.svc.sendForSignature('plano-lab', LAB));
    expect(codigo(e)).toBe(CODIGO_VERTICAL_NEGADA);
    expect(e.getStatus()).toBe(403);
    expect(m.nomes()).toEqual(['treatmentPlan.findUnique']);
    expect(m.conversa).not.toHaveBeenCalled();
    expect(m.clicksign.createGenericSignature).not.toHaveBeenCalled();
    expect(m.messages.sendPatientText).not.toHaveBeenCalled();
  });

  it('aceite/fechamento (fireContractForPlan), laboratório: só registra [LAB-GATE], sem aviso de falha', async () => {
    const lab = montar([LAB], LAB);
    const quotesLab = new QuotesService(lab.prisma, {} as any, undefined, undefined, undefined, lab.svc);
    quotesLab.fireContractForPlan('plano-lab', LAB);
    await esperar();
    expect(registrou('log', '[LAB-GATE] tcle')).toBe(true);
    expect(logs.some((l) => l.msg.includes('[ACCEPT→CLICKSIGN]'))).toBe(false);
  });

  it('aceite/fechamento (fireContractForPlan), clínica com OUTRA conta laboratório: a falha segue no aviso, como antes', async () => {
    const falha = { sendForSignature: jest.fn(async () => { throw new BadRequestException('Paciente sem telefone'); }) };
    const quotesClinica = new QuotesService(banco([LAB]).prisma, {} as any, undefined, undefined, undefined, falha as any);
    quotesClinica.fireContractForPlan('plano-1', CLINICA);
    await esperar();
    expect(registrou('warn', '[ACCEPT→CLICKSIGN] Falha ao disparar assinatura do plano plano-1: Paciente sem telefone')).toBe(true);
    expect(registrou('log', '[LAB-GATE]')).toBe(false);
  });

  it('negarLaboratorio: 403 com code VERTICAL_DENIED e a mensagem clara', () => {
    const e = negarLaboratorio('Portal do paciente');
    expect(e.getStatus()).toBe(403);
    expect(e.getResponse()).toEqual({ message: 'Portal do paciente: função de clínica, não disponível para laboratório.', code: 'VERTICAL_DENIED' });
  });
});

describe('Aceite (simples e parcial) — no laboratório o plano nasce ACTIVE; na clínica PENDING_SIGNATURE', () => {
  const ITENS = [
    { id: 'item-1', procedure_id: 'proc-1', tooth_fdi: 11, quantity: 1, unit_price: 100, total_price: 100, notes: null, dentist_id: null, procedure: { category: null } },
    { id: 'item-2', procedure_id: 'proc-2', tooth_fdi: null, quantity: 1, unit_price: 50, total_price: 50, notes: null, dentist_id: 'dentista-1', procedure: { category: null } },
  ];
  function montar(labs: string[], conta = CLINICA) {
    const b = banco(labs, {
      'quote.findUnique': ({ where }) => ({
        id: where.id,
        status: 'SENT',
        sent_at: AGORA,
        patient_id: `pac-${conta}`,
        patient: { id: `pac-${conta}`, tenant_id: conta },
        items: ITENS,
        total_value: 150,
        discount_percent: 0,
        notes: null,
        title: 'Orçamento exemplo',
        created_by_user_id: 'usuario-1',
        payment_terms: null,
        valid_until: null,
      }),
      'quote.findFirst': () => ({ quote_number: 7 }),
      'treatmentPlan.create': ({ data }) => ({ id: 'plano-novo', ...data, items: [] }),
    });
    const contrato = { sendForSignature: jest.fn(async () => ({ signingUrl: 'https://assinar.exemplo.test/x' })) };
    const svc = new QuotesService(b.prisma, { get: () => undefined } as any, undefined, undefined, undefined, contrato as any);
    return { svc, contrato, ...b };
  }
  const plano = (m: ReturnType<typeof montar>) => m.de('treatmentPlan.create')[0].data;

  it('aceite, clínica sem laboratório: plano PENDING_SIGNATURE (mesmo objeto) e o TCLE sai', async () => {
    const m = montar([]);
    await m.svc.accept('orc-1', CLINICA, 'usuario-1');
    expect(Object.keys(plano(m))).toEqual(['patient_id', 'quote_id', 'status', 'total_value', 'items']);
    expect(plano(m).status).toBe('PENDING_SIGNATURE');
    expect(m.contrato.sendForSignature).toHaveBeenCalledWith('plano-novo', CLINICA);
  });

  it('aceite, clínica com OUTRA conta laboratório: o mesmo rastro', async () => {
    const antes = montar([]);
    await antes.svc.accept('orc-1', CLINICA, 'usuario-1');
    const depois = montar([LAB]);
    await depois.svc.accept('orc-1', CLINICA, 'usuario-1');
    expect(depois.ops).toEqual(antes.ops);
    expect(depois.contrato.sendForSignature.mock.calls).toEqual(antes.contrato.sendForSignature.mock.calls);
  });

  it('aceite, laboratório: o plano nasce ACTIVE com start_date (não há TCLE para assinar)', async () => {
    const m = montar([LAB], LAB);
    await m.svc.accept('orc-lab', LAB, 'usuario-1');
    expect(plano(m).status).toBe('ACTIVE');
    expect(plano(m).start_date).toEqual(AGORA);
    expect(registrou('log', '[LAB-GATE] plano-ativo')).toBe(true);
  });

  it('aprovação parcial, clínica sem laboratório: plano PENDING_SIGNATURE (mesmo objeto)', async () => {
    const m = montar([]);
    await m.svc.acceptPartial('orc-1', CLINICA, ['item-1'], 'usuario-1');
    expect(Object.keys(plano(m))).toEqual(['patient_id', 'quote_id', 'status', 'total_value', 'items']);
    expect(plano(m).status).toBe('PENDING_SIGNATURE');
  });

  it('aprovação parcial, clínica com OUTRA conta laboratório: o mesmo rastro', async () => {
    const antes = montar([]);
    await antes.svc.acceptPartial('orc-1', CLINICA, ['item-1'], 'usuario-1');
    const depois = montar([LAB]);
    await depois.svc.acceptPartial('orc-1', CLINICA, ['item-1'], 'usuario-1');
    // As datas do "[Resto de aprovacao parcial em ...]" e do accepted_at saem do relógio fixo.
    expect(depois.ops).toEqual(antes.ops);
  });

  it('aprovação parcial, laboratório: o plano nasce ACTIVE com start_date', async () => {
    const m = montar([LAB], LAB);
    await m.svc.acceptPartial('orc-lab', LAB, ['item-1'], 'usuario-1');
    expect(plano(m).status).toBe('ACTIVE');
    expect(plano(m).start_date).toEqual(AGORA);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Mensagens do fechamento com texto de clínica (consumidor) e envio do orçamento
// ═════════════════════════════════════════════════════════════════════════════

describe('Fechamento — negociação aprovada, entrada e comprovante: laboratório não recebe', () => {
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

  it('negociação aprovada, laboratório com o toggle ligado: nem lê, nem manda', async () => {
    const m = montar([LAB], [LAB]);
    await m.svc.sendNegociacaoAprovada(LAB, 'plano-lab', PACIENTE(LAB), TERMOS);
    expect(m.ops).toEqual([]);
    expect(m.whatsapp.sendText).not.toHaveBeenCalled();
    expect(m.whatsapp.sendMedia).not.toHaveBeenCalled();
    expect(registrou('log', '[LAB-GATE] negociacao-aprovada')).toBe(true);
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

  it('entrada, laboratório: nem busca a cobrança', async () => {
    const m = montar([LAB], [LAB]);
    await m.svc.sendEntradaCobranca(LAB, 'plano-lab', PACIENTE(LAB));
    expect(m.ops).toEqual([]);
    expect(registrou('log', '[LAB-GATE] entrada-cobranca')).toBe(true);
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

describe('Envio do orçamento pelo WhatsApp (portal) — laboratório recusa', () => {
  function montar(labs: string[], conta = CLINICA) {
    const b = banco(labs, {
      'quote.findUnique': ({ where }) => ({
        id: where.id,
        status: 'DRAFT',
        sent_at: null,
        patient_id: `pac-${conta}`,
        patient: { id: `pac-${conta}`, name: 'Maria Exemplo', tenant_id: conta, phone: TEL[conta] },
        items: [],
        total_value: 150,
        valid_until: null,
        _count: { attachments: 0, versions: 0 },
      }),
      'tenant.findUnique': () => ({ name: 'Clínica Exemplo' }),
    });
    const portal = { createMagicLink: jest.fn(async () => ({ link: 'https://portal.exemplo.test/p/token' })) };
    const messages = {
      resolvePatientChips: jest.fn(async () => [{ name: 'chip-clinica', purpose: 'CLINICA' }]),
      assertPatientSendable: jest.fn(async () => undefined),
      sendPatientText: jest.fn(async () => ({ message: { id: 'msg-1' } })),
      sendPatientFile: jest.fn(async () => ({ message: { id: 'msg-2' } })),
    };
    const conversations = { findOrCreatePatientConversationId: jest.fn(async () => 'conversa-1') };
    const svc = new QuotesService(
      b.prisma, { get: () => undefined } as any, undefined, portal as any, undefined, undefined, undefined, undefined,
      undefined, undefined, undefined, messages as any, conversations as any,
    );
    jest.spyOn(svc as any, 'resolvePatientWhatsappLead').mockResolvedValue('lead-1');
    return { svc, portal, messages, conversations, ...b };
  }

  it('clínica sem laboratório: gera o link do portal e manda na conversa de paciente, como antes', async () => {
    const m = montar([]);
    await m.svc.sendByWhatsapp('orc-1', CLINICA, 'usuario-1');
    expect(m.portal.createMagicLink).toHaveBeenCalledWith(CLINICA, `pac-${CLINICA}`, 'OTHER');
    expect(m.messages.sendPatientText.mock.calls.length + m.messages.sendPatientFile.mock.calls.length).toBeGreaterThan(0);
  });

  it('clínica com OUTRA conta laboratório: o mesmo rastro e o mesmo envio', async () => {
    const antes = montar([]);
    await antes.svc.sendByWhatsapp('orc-1', CLINICA, 'usuario-1');
    const depois = montar([LAB]);
    await depois.svc.sendByWhatsapp('orc-1', CLINICA, 'usuario-1');
    expect(depois.ops).toEqual(antes.ops);
    expect(depois.messages.sendPatientText.mock.calls).toEqual(antes.messages.sendPatientText.mock.calls);
    expect(depois.portal.createMagicLink.mock.calls).toEqual(antes.portal.createMagicLink.mock.calls);
  });

  it('laboratório: recusa (VERTICAL_DENIED) sem link, sem conversa, sem envio', async () => {
    const m = montar([LAB], LAB);
    const e = await erro(m.svc.sendByWhatsapp('orc-lab', LAB, 'usuario-1'));
    expect(codigo(e)).toBe(CODIGO_VERTICAL_NEGADA);
    expect(m.nomes()).toEqual(['quote.findUnique']);
    expect(m.portal.createMagicLink).not.toHaveBeenCalled();
    expect(m.conversations.findOrCreatePatientConversationId).not.toHaveBeenCalled();
    expect(m.messages.sendPatientText).not.toHaveBeenCalled();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Retornos / manutenção
// ═════════════════════════════════════════════════════════════════════════════

describe('Retornos e manutenção (MaintenanceService e "Retornos pendentes")', () => {
  const VENCE = new Date('2027-04-21T15:00:00.000Z');
  function montar(labs: string[]) {
    const b = banco(labs);
    return { svc: new MaintenanceService(b.prisma), ...b };
  }
  const completo = (t: string) => ({ tenantId: t, patientId: `pac-${t}`, treatmentPlanId: `plano-${t}`, months: 6, completedAt: AGORA });

  it('retorno pós-tratamento, clínica sem laboratório: procura, cria o recall e o espelho, como antes', async () => {
    const m = montar([]);
    const r = await m.svc.createFromPlanCompletion(completo(CLINICA));
    expect(r).toMatchObject({ id: 'novo-maintenanceTask' });
    expect(m.ops).toEqual([
      ['maintenanceTask.findFirst', { where: { tenant_id: CLINICA, notes: { contains: `[plan:plano-${CLINICA}]` } } }],
      ['maintenanceTask.create', { data: { tenant_id: CLINICA, patient_id: `pac-${CLINICA}`, due_date: VENCE, title: 'Retorno pós-tratamento', notes: `[plan:plano-${CLINICA}]`, created_by_user_id: null } }],
      ['returnAlert.create', { data: { tenant_id: CLINICA, patient_id: `pac-${CLINICA}`, professional_user_id: null, scheduled_for: VENCE, reason: 'Retorno pós-tratamento' } }],
    ]);
  });

  it('retorno pós-tratamento, clínica com OUTRA conta laboratório: o mesmo rastro', async () => {
    const antes = montar([]);
    await antes.svc.createFromPlanCompletion(completo(CLINICA));
    const depois = montar([LAB]);
    await depois.svc.createFromPlanCompletion(completo(CLINICA));
    expect(depois.ops).toEqual(antes.ops);
  });

  it('retorno pós-tratamento, laboratório: devolve null, nada lido nem criado', async () => {
    const m = montar([LAB]);
    expect(await m.svc.createFromPlanCompletion(completo(LAB))).toBeNull();
    expect(m.ops).toEqual([]);
    expect(registrou('log', '[LAB-GATE] retorno-pos-tratamento')).toBe(true);
  });

  const item = (t: string, meses: number | null = 6) => ({
    tenantId: t, patientId: `pac-${t}`, treatmentPlanItemId: `item-${t}`, procedureId: 'proc-1',
    procedureName: 'Limpeza', defaultRevisitMonths: meses, executedAt: AGORA,
  });

  it('revisão por procedimento, clínica sem laboratório e com OUTRA conta laboratório: cria igual', async () => {
    const antes = montar([]);
    await antes.svc.createFromTreatmentPlanItem(item(CLINICA));
    expect(antes.nomes()).toEqual(['maintenanceTask.findFirst', 'maintenanceTask.create']);
    const depois = montar([LAB]);
    await depois.svc.createFromTreatmentPlanItem(item(CLINICA));
    expect(depois.ops).toEqual(antes.ops);
  });

  it('revisão por procedimento sem meses configurados: nem lê a lista de laboratórios (como antes)', async () => {
    const m = montar([LAB]);
    expect(await m.svc.createFromTreatmentPlanItem(item(CLINICA, null))).toBeNull();
    expect(m.ops).toEqual([]);
    expect(m.perfis).not.toHaveBeenCalled();
  });

  it('revisão por procedimento, laboratório (meses editados na tabela): nada criado', async () => {
    const m = montar([LAB]);
    expect(await m.svc.createFromTreatmentPlanItem(item(LAB))).toBeNull();
    expect(m.ops).toEqual([]);
    expect(registrou('log', '[LAB-GATE] revisao-procedimento')).toBe(true);
  });

  const estetica = (t: string) => ({
    tenantId: t, patientId: `pac-${t}`, estheticApplicationId: `apl-${t}`, procedureId: null,
    procedureName: 'Toxina', expectedRevisitAt: VENCE, createdByUserId: 'usuario-1',
  });

  it('revisão da aplicação estética, clínica sem laboratório e com OUTRA conta laboratório: cria igual', async () => {
    const antes = montar([]);
    await antes.svc.createFromEstheticApplication(estetica(CLINICA));
    expect(antes.nomes()).toEqual(['maintenanceTask.findFirst', 'maintenanceTask.create', 'returnAlert.create']);
    const depois = montar([LAB]);
    await depois.svc.createFromEstheticApplication(estetica(CLINICA));
    expect(depois.ops).toEqual(antes.ops);
  });

  it('revisão da aplicação estética, laboratório: nada criado', async () => {
    const m = montar([LAB]);
    expect(await m.svc.createFromEstheticApplication(estetica(LAB))).toBeNull();
    expect(m.ops).toEqual([]);
  });

  const manual = { patient_id: 'pac-1', title: 'Revisão', due_date: '2027-04-21T15:00:00.000Z' };

  it('manutenção manual, clínica sem laboratório e com OUTRA conta laboratório: cria e espelha igual', async () => {
    const antes = montar([]);
    await antes.svc.createManual(CLINICA, 'usuario-1', manual);
    expect(antes.nomes()).toEqual(['maintenanceTask.create', 'returnAlert.create']);
    const depois = montar([LAB]);
    await depois.svc.createManual(CLINICA, 'usuario-1', manual);
    expect(depois.ops).toEqual(antes.ops);
  });

  it('manutenção manual, laboratório: recusa (VERTICAL_DENIED), nada criado', async () => {
    const m = montar([LAB]);
    const e = await erro(m.svc.createManual(LAB, 'usuario-1', manual));
    expect(codigo(e)).toBe(CODIGO_VERTICAL_NEGADA);
    expect(m.ops).toEqual([]);
  });

  function retornos(labs: string[]) {
    const b = banco(labs, { 'patient.findFirst': ({ where }) => ({ id: where.id }) });
    return { svc: new ReturnAlertsService(b.prisma), ...b };
  }
  const retorno = { patient_id: 'pac-1', scheduled_for: '2027-04-21T15:00:00.000Z', reason: 'Revisão' } as any;

  it('retorno pendente manual, clínica sem laboratório e com OUTRA conta laboratório: confere o paciente e cria igual', async () => {
    const antes = retornos([]);
    await antes.svc.create(CLINICA, 'usuario-1', retorno);
    expect(antes.nomes()).toEqual(['patient.findFirst', 'returnAlert.create']);
    const depois = retornos([LAB]);
    await depois.svc.create(CLINICA, 'usuario-1', retorno);
    expect(depois.ops).toEqual(antes.ops);
  });

  it('retorno pendente manual, laboratório: recusa (VERTICAL_DENIED)', async () => {
    const m = retornos([LAB]);
    expect(codigo(await erro(m.svc.create(LAB, 'usuario-1', retorno)))).toBe(CODIGO_VERTICAL_NEGADA);
    expect(m.ops).toEqual([]);
  });
});

describe('Concluir tratamento e backfill — o laboratório não ganha retorno (consumidor real)', () => {
  const FIM = new Date('2026-09-01T12:00:00.000Z');
  function montar(labs: string[], conta: string) {
    invalidateAllSettings(); // RECALL_DEFAULT_MONTHS tem cache: cada montagem lê do zero
    const b = banco(labs, {
      'treatmentPlan.findUnique': ({ where }) => ({ id: where.id, patient_id: `pac-${conta}`, patient: { id: `pac-${conta}`, tenant_id: conta }, items: [{ status: 'DONE' }] }),
      'treatmentPlan.update': ({ where, data }) => ({ id: where.id, ...data }),
      'treatmentPlan.findMany': () => [{ id: `plano-${conta}`, patient_id: `pac-${conta}`, status: 'COMPLETED', end_date: FIM, items: [{ status: 'DONE', executed_at: FIM }] }],
    });
    const svc = new TreatmentPlansService(b.prisma, {} as any, undefined, new MaintenanceService(b.prisma));
    return { svc, ...b };
  }

  it('concluir, clínica (sem laboratório e com OUTRA conta laboratório): conclui e cria o retorno, igual', async () => {
    const antes = montar([], CLINICA);
    await antes.svc.complete(`plano-${CLINICA}`, CLINICA);
    expect(antes.nomes()).toEqual(expect.arrayContaining(['treatmentPlan.update', 'maintenanceTask.create', 'returnAlert.create']));
    const depois = montar([LAB], CLINICA);
    await depois.svc.complete(`plano-${CLINICA}`, CLINICA);
    expect(depois.ops).toEqual(antes.ops);
  });

  it('concluir, laboratório: o plano conclui, sem retorno nem espelho', async () => {
    const m = montar([LAB], LAB);
    const r = await m.svc.complete(`plano-${LAB}`, LAB);
    expect(r).toMatchObject({ status: 'COMPLETED' });
    expect(m.de('maintenanceTask.create')).toEqual([]);
    expect(m.de('returnAlert.create')).toEqual([]);
  });

  it('backfill, clínica com OUTRA conta laboratório: conta o retorno criado, como antes', async () => {
    const clinica = montar([LAB], CLINICA);
    expect(await clinica.svc.backfillPostTreatmentReturns(CLINICA)).toEqual({ scanned: 1, created: 1 });
  });

  it('backfill, laboratório: não cria e não conta (o consumidor devolve null)', async () => {
    const lab = montar([LAB], LAB);
    expect(await lab.svc.backfillPostTreatmentReturns(LAB)).toEqual({ scanned: 1, created: 0 });
    expect(lab.de('maintenanceTask.create')).toEqual([]);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Tarefa → agenda
// ═════════════════════════════════════════════════════════════════════════════

describe('Tarefa com prazo → evento TAREFA na agenda — laboratório: a tarefa nasce, a agenda não', () => {
  const PRAZO = '2026-10-25T13:00:00.000Z';
  function montar(labs: string[], leads: Record<string, string> = {}) {
    const b = banco(labs, {
      'task.create': ({ data }) => ({ id: 'tarefa-1', calendar_event_id: null, lead_id: null, ...data, tenant_id: data.tenant_id ?? null }),
      'lead.findUnique': ({ where }) => ({ tenant_id: leads[where.id] ?? null }),
    });
    const agenda = { create: jest.fn(async (_d: any) => ({ id: 'evento-tarefa' })) };
    const svc = new TasksService(b.prisma, {} as any, agenda as any);
    return { svc, agenda, ...b };
  }
  const tarefa = (t: string | undefined, extra: Record<string, any> = {}) => ({
    title: 'Ligar para o contato', due_at: PRAZO, tenant_id: t, created_by_id: 'usuario-1', ...extra,
  });

  it('clínica sem laboratório: cria a tarefa e o evento TAREFA, como antes', async () => {
    const m = montar([]);
    await m.svc.create(tarefa(CLINICA));
    expect(m.nomes()).toEqual(['task.create', 'task.update']);
    expect(m.de('task.update')).toEqual([{ where: { id: 'tarefa-1' }, data: { calendar_event_id: 'evento-tarefa' } }]);
    expect(m.agenda.create.mock.calls[0][0]).toMatchObject({ type: 'TAREFA', tenant_id: CLINICA, created_by_id: 'usuario-1' });
  });

  it('clínica com OUTRA conta laboratório: o mesmo rastro e o mesmo evento', async () => {
    const antes = montar([]);
    await antes.svc.create(tarefa(CLINICA));
    const depois = montar([LAB]);
    await depois.svc.create(tarefa(CLINICA));
    expect(depois.ops).toEqual(antes.ops);
    expect(depois.agenda.create.mock.calls).toEqual(antes.agenda.create.mock.calls);
  });

  it('laboratório: a tarefa é criada, mas não vira evento na agenda', async () => {
    const m = montar([LAB]);
    const r = await m.svc.create(tarefa(LAB));
    expect(r).toMatchObject({ id: 'tarefa-1', tenant_id: LAB });
    expect(m.nomes()).toEqual(['task.create']);
    expect(m.agenda.create).not.toHaveBeenCalled();
    expect(registrou('log', '[LAB-GATE] tarefa-agenda')).toBe(true);
  });

  const LEADS = { 'lead-lab': LAB, 'lead-clinica': CLINICA };
  it('tarefa sem conta, lead de laboratório: não vai para a agenda', async () => {
    const lab = montar([LAB], LEADS);
    await lab.svc.create(tarefa(undefined, { lead_id: 'lead-lab' }));
    expect(lab.agenda.create).not.toHaveBeenCalled();
  });

  it('tarefa sem conta, lead de clínica com OUTRA conta laboratório: vai para a agenda, como antes', async () => {
    const clinica = montar([LAB], LEADS);
    await clinica.svc.create(tarefa(undefined, { lead_id: 'lead-clinica' }));
    expect(clinica.agenda.create).toHaveBeenCalledTimes(1);
  });

  it('sem prazo: nem lê a lista de laboratórios (como antes)', async () => {
    const m = montar([LAB]);
    await m.svc.create({ title: 'Sem prazo', tenant_id: CLINICA, created_by_id: 'usuario-1' });
    expect(m.perfis).not.toHaveBeenCalled();
  });
});

describe('Migrar tarefas órfãs para a agenda (POST calendar/migrate-tasks)', () => {
  const DATA = new Date('2026-10-25T13:00:00.000Z');
  const tarefa = (id: string, tenant_id: string | null, assigned_user_id: string) => ({
    id, title: id, description: null, tenant_id, assigned_user_id, status: 'A_FAZER', due_at: DATA, created_at: DATA,
    lead_id: null, conversation_id: null, comments: [],
  });
  const TAREFAS = [
    tarefa('t-clinica', CLINICA, 'u-clinica'),
    tarefa('t-lab', LAB, 'u-lab'),
    tarefa('t-sem-conta-lab', null, 'u-lab'),
    tarefa('t-sem-conta-clinica', null, 'u-clinica'),
  ];
  const USUARIOS: Record<string, string> = { 'u-clinica': CLINICA, 'u-lab': LAB };
  function montar(labs: string[]) {
    const b = banco(labs, {
      'task.findMany': ({ where }) =>
        JSON.stringify(where).includes('"calendar_event_id":{"not":null}') ? [] : TAREFAS.filter((t) => casa(where, t)),
      'user.findUnique': ({ where }) => ({ tenant_id: USUARIOS[where.id] ?? null }),
      'calendarEvent.create': ({ data }) => ({ id: `evento-${data.title}` }),
    });
    const svc = new CalendarService(b.prisma, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any);
    return { svc, ...b };
  }
  const contas = (m: ReturnType<typeof montar>) => m.de('calendarEvent.create').map((a: any) => [a.data.title, a.data.tenant_id]);

  it('SUPER_ADMIN, sem laboratório cadastrado: converte todas, como antes', async () => {
    const m = montar([]);
    const r = await m.svc.migrateOrphanTasks({ superAdmin: true });
    expect(m.de('task.findMany')[0].where).toEqual({ calendar_event_id: null });
    expect(r).toEqual({ orphanTasksMigrated: 4, commentsMigrated: 0, skippedNoCreator: 0, skippedNoClinic: 0 });
  });

  it('SUPER_ADMIN com laboratório: fora o laboratório (null-safe) e a tarefa sem conta de responsável do laboratório', async () => {
    const m = montar([LAB]);
    const r = await m.svc.migrateOrphanTasks({ superAdmin: true });
    expect(m.de('task.findMany')[0].where).toEqual({ AND: [{ calendar_event_id: null }, OR_SEM_LAB] });
    expect(contas(m)).toEqual([['t-clinica', CLINICA], ['t-sem-conta-clinica', CLINICA]]);
    expect(r).toEqual({ orphanTasksMigrated: 2, commentsMigrated: 0, skippedNoCreator: 0, skippedNoClinic: 1 });
  });

  it('ADMIN da clínica, sem laboratório e com OUTRA conta laboratório: o mesmo rastro', async () => {
    const antes = montar([]);
    await antes.svc.migrateOrphanTasks({ tenantId: CLINICA, superAdmin: false });
    expect(contas(antes)).toEqual([['t-clinica', CLINICA]]);
    const depois = montar([LAB]);
    await depois.svc.migrateOrphanTasks({ tenantId: CLINICA, superAdmin: false });
    expect(depois.ops).toEqual(antes.ops);
  });

  it('ADMIN do laboratório: nada é lido nem convertido', async () => {
    const m = montar([LAB]);
    expect(await m.svc.migrateOrphanTasks({ tenantId: LAB, superAdmin: false })).toEqual({
      orphanTasksMigrated: 0, commentsMigrated: 0, skippedNoCreator: 0, skippedNoClinic: 0,
    });
    expect(m.ops).toEqual([]);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Agenda: aviso de agendamento, lembretes, aviso manual, reenvio, backfill
// ═════════════════════════════════════════════════════════════════════════════

describe('Agenda — evento de laboratório: sem aviso ao contato e sem lembrete WhatsApp/e-mail', () => {
  const INICIO = '2026-10-28T14:00:00.000Z';
  const LEMBRETES = [
    { minutes_before: 1440, channel: 'WHATSAPP' },
    { minutes_before: 60, channel: 'WHATSAPP' },
    { minutes_before: 30, channel: 'PUSH' },
  ];
  function montar(labs: string[], respostas: Respostas = {}, leads: Record<string, string> = {}) {
    let criados: any[] = [];
    const b = banco(labs, {
      'patient.findUnique': () => null,
      'globalSetting.findUnique': () => null,
      'lead.findUnique': ({ where }) => ({ tenant_id: leads[where.id] ?? null }),
      'calendarEvent.create': ({ data }) => ({
        id: 'evento-1',
        ...data,
        reminders: (data.reminders?.create ?? []).map((r: any, i: number) => ({ id: `lembrete-${i + 1}`, event_id: 'evento-1', ...r })),
        assigned_user: { id: data.assigned_user_id, name: 'Dra. Ana Exemplo' },
        lead: data.lead_id ? { id: data.lead_id, name: 'Maria Exemplo', phone: TEL[CLINICA], is_client: true } : null,
      }),
      'eventReminder.createMany': ({ data }) => {
        criados = data;
        return { count: data.length };
      },
      'eventReminder.findMany': () => criados.map((r, i) => ({ id: `novo-${i + 1}`, ...r })),
      ...respostas,
    });
    const fila = { add: jest.fn(async (..._a: any[]) => ({ id: 'job' })), getJob: jest.fn(async (_id: string) => null) };
    const waitlist = { notifySlotOpened: jest.fn(async () => ({ notified: 0 })) };
    const svc = new CalendarService(b.prisma, { emitCalendarUpdate: jest.fn() }, fila, waitlist, {} as any, {} as any, { get: () => undefined });
    const avisos: any[] = [];
    jest.spyOn(svc, 'sendAppointmentEventWhatsapp').mockImplementation(async (...a: any[]) => {
      avisos.push(['whatsapp', a[1], a[2], a[3], a[4]]);
      return { sent: true };
    });
    jest.spyOn(svc, 'sendAppointmentEventEmail').mockImplementation(async (...a: any[]) => {
      avisos.push(['email', a[1], a[2], a[3], a[4]]);
    });
    return { svc, fila, avisos, ...b };
  }
  const evento = (t: string | undefined, extra: Record<string, any> = {}) => ({
    type: 'CONSULTA', title: 'Consulta exemplo', start_at: INICIO, end_at: '2026-10-28T14:30:00.000Z', lead_id: 'lead-1',
    assigned_user_id: 'dentista-1', created_by_id: 'recepcao-1', tenant_id: t, actor_roles: ['OPERADOR'], reminders: LEMBRETES, ...extra,
  });
  const lembretesCriados = (m: ReturnType<typeof montar>) => m.de('calendarEvent.create')[0].data.reminders?.create;

  it('criar, clínica sem laboratório: os 3 lembretes, os 2 jobs e o aviso "agendada" (e-mail + WhatsApp), como antes', async () => {
    const m = montar([]);
    await m.svc.create(evento(CLINICA));
    await esperar();
    expect(lembretesCriados(m)).toEqual(LEMBRETES);
    expect(m.fila.add.mock.calls.map((c: any[]) => c[1].reminderId)).toEqual(['lembrete-1', 'lembrete-2']);
    expect(m.avisos).toEqual([
      ['email', undefined, 'lead-1', CLINICA, 'agendamento_criado'],
      ['whatsapp', undefined, 'lead-1', CLINICA, 'created'],
    ]);
  });

  it('criar, clínica com OUTRA conta laboratório: o mesmo rastro, os mesmos jobs e avisos', async () => {
    const antes = montar([]);
    await antes.svc.create(evento(CLINICA));
    await esperar();
    const depois = montar([LAB]);
    await depois.svc.create(evento(CLINICA));
    await esperar();
    expect(depois.ops).toEqual(antes.ops);
    expect(depois.fila.add.mock.calls).toEqual(antes.fila.add.mock.calls);
    expect(depois.avisos).toEqual(antes.avisos);
  });

  it('criar, laboratório: o evento nasce só com o lembrete PUSH da equipe; nenhum job, nenhum aviso', async () => {
    const m = montar([LAB]);
    await m.svc.create(evento(LAB));
    await esperar();
    expect(m.de('calendarEvent.create')).toHaveLength(1);
    expect(lembretesCriados(m)).toEqual([{ minutes_before: 30, channel: 'PUSH' }]);
    expect(m.fila.add).not.toHaveBeenCalled();
    expect(m.avisos).toEqual([]);
    expect(registrou('log', '[LAB-GATE] lembretes-agenda')).toBe(true);
  });

  const LEADS = { 'lead-lab': LAB, 'lead-clinica': CLINICA };
  it('criar sem conta no evento, contato de laboratório: sem lembrete ao contato', async () => {
    const lab = montar([LAB], {}, LEADS);
    await lab.svc.create(evento(undefined, { lead_id: 'lead-lab' }));
    expect(lembretesCriados(lab)).toEqual([{ minutes_before: 30, channel: 'PUSH' }]);
    expect(lab.fila.add).not.toHaveBeenCalled();
  });

  const PACIENTES: Record<string, string> = { 'pac-lab': LAB, 'pac-clinica': CLINICA };
  const pacientes = { 'patient.findUnique': ({ where }: any) => ({ tenant_id: PACIENTES[where.id] ?? null }) };

  it('criar sem conta no evento nem contato, paciente do laboratório: sem lembrete ao contato', async () => {
    const lab = montar([LAB], pacientes, LEADS);
    await lab.svc.create(evento(undefined, { lead_id: undefined, patient_id: 'pac-lab' }));
    expect(lembretesCriados(lab)).toEqual([{ minutes_before: 30, channel: 'PUSH' }]);
    expect(lab.fila.add).not.toHaveBeenCalled();
    expect(lab.avisos).toEqual([]);
  });

  it('criar sem conta no evento nem contato, paciente de clínica com OUTRA conta laboratório: os lembretes de antes', async () => {
    const clinica = montar([LAB], pacientes, LEADS);
    await clinica.svc.create(evento(undefined, { lead_id: undefined, patient_id: 'pac-clinica' }));
    expect(lembretesCriados(clinica)).toEqual(LEMBRETES);
  });

  it('criar sem conta no evento, contato de clínica com OUTRA conta laboratório: os lembretes de antes', async () => {
    const clinica = montar([LAB], {}, LEADS);
    await clinica.svc.create(evento(undefined, { lead_id: 'lead-clinica' }));
    expect(lembretesCriados(clinica)).toEqual(LEMBRETES);
    expect(clinica.fila.add).toHaveBeenCalledTimes(2);
  });

  const antes = (t: string) => ({
    'calendarEvent.findUnique': () => ({
      type: 'CONSULTA', start_at: new Date(INICIO), location: null, lead_id: 'lead-1', status: 'AGENDADO',
      assigned_user_id: 'dentista-1', tenant_id: t, validated_at: null, validated_by_user_id: null,
    }),
    'calendarEvent.update': ({ where, data }: any) => ({
      id: where.id, type: 'CONSULTA', status: 'AGENDADO', start_at: data.start_at ?? new Date(INICIO), lead_id: 'lead-1',
      patient_id: null, tenant_id: t, assigned_user_id: 'dentista-1', assigned_user: { id: 'dentista-1', name: 'Dra. Ana Exemplo' },
      lead: { id: 'lead-1', name: 'Maria Exemplo', phone: TEL[CLINICA], is_client: true }, reminders: [],
    }),
  });
  const remarcar = { start_at: '2026-10-29T14:00:00.000Z', reminders: [{ minutes_before: 1440, channel: 'WHATSAPP' }, { minutes_before: 30, channel: 'PUSH' }] };

  it('remarcar, clínica sem laboratório: troca os lembretes, re-enfileira e avisa "remarcada", como antes', async () => {
    const m = montar([], antes(CLINICA));
    await m.svc.update('evento-1', remarcar);
    await esperar();
    expect(m.de('eventReminder.createMany')).toEqual([{
      data: [
        { event_id: 'evento-1', minutes_before: 1440, channel: 'WHATSAPP' },
        { event_id: 'evento-1', minutes_before: 30, channel: 'PUSH' },
      ],
    }]);
    expect(m.fila.add.mock.calls.map((c: any[]) => c[1].reminderId)).toEqual(['novo-1']);
    expect(m.avisos).toEqual([
      ['whatsapp', null, 'lead-1', CLINICA, 'rescheduled'],
      ['email', null, 'lead-1', CLINICA, 'agendamento_remarcado'],
    ]);
  });

  it('remarcar, clínica com OUTRA conta laboratório: o mesmo rastro, jobs e avisos', async () => {
    const a = montar([], antes(CLINICA));
    await a.svc.update('evento-1', remarcar);
    await esperar();
    const d = montar([LAB], antes(CLINICA));
    await d.svc.update('evento-1', remarcar);
    await esperar();
    expect(d.ops).toEqual(a.ops);
    expect(d.fila.add.mock.calls).toEqual(a.fila.add.mock.calls);
    expect(d.avisos).toEqual(a.avisos);
  });

  it('remarcar, laboratório: só o lembrete PUSH, nada re-enfileirado, sem aviso', async () => {
    const m = montar([LAB], antes(LAB));
    await m.svc.update('evento-1', remarcar);
    await esperar();
    expect(m.de('eventReminder.createMany')).toEqual([{ data: [{ event_id: 'evento-1', minutes_before: 30, channel: 'PUSH' }] }]);
    expect(m.fila.add).not.toHaveBeenCalled();
    expect(m.avisos).toEqual([]);
  });

  const lembreteAntigo = { id: 'antigo-1', minutes_before: 1440, channel: 'WHATSAPP' };
  const comAntigo = (t: string) => ({
    ...antes(t),
    'calendarEvent.update': (a: any) => ({ ...antes(t)['calendarEvent.update'](a), reminders: [lembreteAntigo] }),
  });

  it('remarcar só a data (lembretes antigos ficam), clínica com OUTRA conta laboratório: re-enfileira, como antes', async () => {
    const clinica = montar([LAB], comAntigo(CLINICA));
    await clinica.svc.update('evento-1', { start_at: '2026-10-29T14:00:00.000Z' });
    expect(clinica.fila.add.mock.calls.map((c: any[]) => c[1].reminderId)).toEqual(['antigo-1']);
  });

  it('remarcar só a data (lembretes antigos ficam), laboratório: nada re-enfileirado', async () => {
    const lab = montar([LAB], comAntigo(LAB));
    await lab.svc.update('evento-1', { start_at: '2026-10-29T14:00:00.000Z' });
    expect(lab.fila.add).not.toHaveBeenCalled();
  });

  const notificar = (t: string) => ({
    'calendarEvent.findUnique': (a: any) =>
      a.select
        ? { id: 'evento-1', type: 'CONSULTA', status: 'AGENDADO', title: 'Consulta', lead: { phone: TEL[CLINICA] }, patient: null }
        : { id: 'evento-1', type: 'CONSULTA', start_at: new Date(INICIO), tenant_id: t, lead_id: 'lead-1', patient_id: null, assigned_user: null, lead: { id: 'lead-1' } },
  });

  it('"Notificar" manual, clínica sem laboratório e com OUTRA conta laboratório: manda igual', async () => {
    const a = montar([], notificar(CLINICA));
    expect(await a.svc.notifyEvent('evento-1')).toEqual({ queued: true, message: 'WhatsApp enviado ao paciente ✅' });
    expect(a.avisos).toEqual([['whatsapp', null, 'lead-1', CLINICA, 'created']]);
    const d = montar([LAB], notificar(CLINICA));
    await d.svc.notifyEvent('evento-1');
    expect(d.ops).toEqual(a.ops);
    expect(d.avisos).toEqual(a.avisos);
  });

  it('"Notificar" manual, laboratório: recusa (VERTICAL_DENIED), nada sai', async () => {
    const m = montar([LAB], notificar(LAB));
    expect(codigo(await erro(m.svc.notifyEvent('evento-1')))).toBe(CODIGO_VERTICAL_NEGADA);
    expect(m.avisos).toEqual([]);
  });

  const EV: Record<string, any> = { id: 'evento-1', status: 'AGENDADO', start_at: new Date(INICIO), lead_id: 'lead-1', patient_id: null };
  const reenviar = (t: string) => ({
    'eventReminder.findFirst': ({ include }: any) => ({
      id: 'lembrete-1',
      channel: 'WHATSAPP',
      event: Object.fromEntries(Object.keys(include.event.select).map((k) => [k, { ...EV, tenant_id: t }[k]])),
    }),
  });

  it('reenviar lembrete, clínica sem laboratório: a mesma consulta, zera e re-enfileira, como antes', async () => {
    const m = montar([], reenviar(CLINICA));
    expect(await m.svc.resendReminder('lembrete-1', CLINICA)).toEqual({ success: true, reminder_id: 'lembrete-1' });
    expect(m.de('eventReminder.findFirst')).toEqual([{
      where: { id: 'lembrete-1', event: { OR: [{ tenant_id: CLINICA }, { tenant_id: null }] } },
      include: { event: { select: { id: true, status: true, start_at: true } } },
    }]);
    expect(m.de('eventReminder.update')).toEqual([{ where: { id: 'lembrete-1' }, data: { sent_at: null, last_error: null } }]);
    expect(m.fila.add).toHaveBeenCalledTimes(1);
  });

  it('reenviar lembrete, clínica com OUTRA conta laboratório: lê a conta do evento e re-enfileira igual', async () => {
    const a = montar([], reenviar(CLINICA));
    await a.svc.resendReminder('lembrete-1', CLINICA);
    const d = montar([LAB], reenviar(CLINICA));
    await d.svc.resendReminder('lembrete-1', CLINICA);
    expect(d.de('eventReminder.findFirst')[0].include.event.select).toEqual({
      id: true, status: true, start_at: true, tenant_id: true, lead_id: true, patient_id: true,
    });
    expect(d.ops.filter(([o]) => o !== 'eventReminder.findFirst')).toEqual(a.ops.filter(([o]) => o !== 'eventReminder.findFirst'));
    expect(d.fila.add.mock.calls).toEqual(a.fila.add.mock.calls);
  });

  it('reenviar lembrete, laboratório: recusa (VERTICAL_DENIED), nada zera nem enfileira', async () => {
    const m = montar([LAB], reenviar(LAB));
    expect(codigo(await erro(m.svc.resendReminder('lembrete-1', LAB)))).toBe(CODIGO_VERTICAL_NEGADA);
    expect(m.de('eventReminder.update')).toEqual([]);
    expect(m.fila.add).not.toHaveBeenCalled();
  });

  const EVENTOS = [
    { id: 'ev-clinica', tenant_id: CLINICA, start_at: new Date(INICIO), reminders: [] },
    { id: 'ev-lab', tenant_id: LAB, start_at: new Date(INICIO), reminders: [] },
    { id: 'ev-legado', tenant_id: null, start_at: new Date(INICIO), reminders: [] },
  ];
  const backfill = {
    'calendarEvent.findMany': ({ where }: any) => EVENTOS.filter((e) => casa(where, e)),
    'eventReminder.create': ({ data }: any) => ({ id: `lem-${data.event_id}-${data.minutes_before}` }),
  };
  const eventosComLembrete = (m: ReturnType<typeof montar>) => [...new Set(m.de('eventReminder.create').map((a: any) => a.data.event_id))];

  it('backfill de lembretes, ADMIN da clínica sem laboratório e com OUTRA conta laboratório: o mesmo rastro', async () => {
    const a = montar([], backfill);
    const r = await a.svc.backfillReminders({ tenant_id: CLINICA });
    expect(r).toEqual({ events_scanned: 2, reminders_created: 6, jobs_enqueued: 6, dry_run: false });
    expect(eventosComLembrete(a)).toEqual(['ev-clinica', 'ev-legado']);
    const d = montar([LAB], backfill);
    await d.svc.backfillReminders({ tenant_id: CLINICA });
    // Com laboratório cadastrado, a busca também traz a conta do contato/paciente
    // (para o evento legado sem conta); o resto do rastro é o mesmo.
    const semInclude = (ops: any[]) =>
      ops.map(([o, args]: any[]) => (o === 'calendarEvent.findMany' ? [o, { ...args, include: undefined }] : [o, args]));
    expect(semInclude(d.ops)).toEqual(semInclude(a.ops));
    expect(a.de('calendarEvent.findMany')[0].include).toEqual({ reminders: { select: { minutes_before: true } } });
    expect(d.de('calendarEvent.findMany')[0].include).toEqual({
      reminders: { select: { minutes_before: true } },
      lead: { select: { tenant_id: true } },
      patient: { select: { tenant_id: true } },
    });
  });

  it('backfill de lembretes, evento legado sem conta: o de contato/paciente do laboratório fica sem lembrete (ADMIN da clínica e SUPER_ADMIN)', async () => {
    const LEGADOS = [
      { id: 'ev-legado-clinica', tenant_id: null, start_at: new Date(INICIO), reminders: [], lead: { tenant_id: CLINICA }, patient: null },
      { id: 'ev-legado-lead-lab', tenant_id: null, start_at: new Date(INICIO), reminders: [], lead: { tenant_id: LAB }, patient: null },
      { id: 'ev-legado-pac-lab', tenant_id: null, start_at: new Date(INICIO), reminders: [], lead: null, patient: { tenant_id: LAB } },
    ];
    const fx = {
      'calendarEvent.findMany': ({ where }: any) => LEGADOS.filter((e) => casa(where, e)),
      'eventReminder.create': ({ data }: any) => ({ id: `lem-${data.event_id}-${data.minutes_before}` }),
    };
    for (const opcoes of [{ tenant_id: CLINICA }, {}]) {
      const m = montar([LAB], fx);
      await m.svc.backfillReminders(opcoes);
      expect(eventosComLembrete(m)).toEqual(['ev-legado-clinica']);
    }
  });

  it('backfill de lembretes, ADMIN do laboratório: nada lido nem criado (nem nos legados sem conta)', async () => {
    const m = montar([LAB], backfill);
    expect(await m.svc.backfillReminders({ tenant_id: LAB })).toEqual({ events_scanned: 0, reminders_created: 0, jobs_enqueued: 0, dry_run: false });
    expect(m.ops).toEqual([]);
    expect(m.fila.add).not.toHaveBeenCalled();
  });

  it('backfill de lembretes, SUPER_ADMIN sem laboratório cadastrado: todas as contas, como antes', async () => {
    const a = montar([], backfill);
    await a.svc.backfillReminders({});
    expect(eventosComLembrete(a)).toEqual(['ev-clinica', 'ev-lab', 'ev-legado']);
  });

  it('backfill de lembretes, SUPER_ADMIN com laboratório: fora ele (null-safe)', async () => {
    const d = montar([LAB], backfill);
    await d.svc.backfillReminders({});
    expect(eventosComLembrete(d)).toEqual(['ev-clinica', 'ev-legado']);
    expect(d.de('calendarEvent.findMany')[0].where.AND[1]).toEqual(OR_SEM_LAB);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Lista de espera e pesquisa pós-atendimento
// ═════════════════════════════════════════════════════════════════════════════

describe('Lista de espera (vaga aberta) — entrada de laboratório não é avisada', () => {
  const VAGA = new Date('2026-10-28T14:00:00.000Z');
  const entrada = (id: string, tenant_id: string | null, contaDoContato: string) => ({
    id, tenant_id, lead_id: `lead-${id}`, dentist: null,
    lead: { id: `lead-${id}`, name: 'Maria Exemplo', phone: TEL[contaDoContato], tenant_id: contaDoContato, is_client: true },
  });
  const ENTRADAS = [entrada('e-clinica', CLINICA, CLINICA), entrada('e-lab', LAB, LAB), entrada('e-lab-sem-conta', null, LAB)];
  function montar(labs: string[]) {
    const b = banco(labs, {
      'waitlistEntry.findMany': ({ where }) => ENTRADAS.filter((e) => casa(where, e)),
      'instance.findMany': ({ where }) => [{ name: `chip-${where.tenant_id}`, purpose: 'CLINICA' }],
    });
    const whatsapp = { sendText: jest.fn(async (tel: string, ..._r: any[]) => ({ key: { id: `wamid-${tel}` } })) };
    return { svc: new WaitlistService(b.prisma, whatsapp as any), whatsapp, ...b };
  }
  const vaga = (tenantId?: string) => ({ dentistId: 'dentista-1', slotStart: VAGA, tenantId, dentistName: 'Ana Exemplo' });
  const para = (m: ReturnType<typeof montar>) => m.whatsapp.sendText.mock.calls.map((c: any[]) => [c[0], c[2], c[4]]);

  it('clínica sem laboratório e com OUTRA conta laboratório: avisa o candidato da clínica, igual', async () => {
    const a = montar([]);
    expect((await a.svc.notifySlotOpened(vaga(CLINICA))).notified).toBe(1);
    expect(para(a)).toEqual([[TEL[CLINICA], `chip-${CLINICA}`, CLINICA]]);
    const d = montar([LAB]);
    await d.svc.notifySlotOpened(vaga(CLINICA));
    expect(d.ops).toEqual(a.ops);
    expect(d.whatsapp.sendText.mock.calls).toEqual(a.whatsapp.sendText.mock.calls);
  });

  it('laboratório: os candidatos não são avisados nem marcados', async () => {
    const m = montar([LAB]);
    expect((await m.svc.notifySlotOpened(vaga(LAB))).notified).toBe(0);
    expect(m.whatsapp.sendText).not.toHaveBeenCalled();
    expect(m.de('waitlistEntry.update')).toEqual([]);
    expect(registrou('log', '[LAB-GATE] lista-de-espera')).toBe(true);
  });

  it('vaga de evento sem conta, sem laboratório cadastrado: avisa todos, como antes', async () => {
    const a = montar([]);
    expect((await a.svc.notifySlotOpened(vaga(undefined))).notified).toBe(3);
  });

  it('vaga de evento sem conta, com laboratório: só a clínica (pela conta da entrada e pela do contato)', async () => {
    const d = montar([LAB]);
    expect((await d.svc.notifySlotOpened(vaga(undefined))).notified).toBe(1);
    expect(para(d)).toEqual([[TEL[CLINICA], `chip-${CLINICA}`, CLINICA]]);
  });
});

describe('Pesquisa pós-atendimento (criação) — evento de laboratório não ganha pesquisa', () => {
  const CFG = { enabled: true, delay_hours: 2 } as any;
  function montar(labs: string[], conta: string) {
    const b = banco(labs, {
      'calendarEvent.findUnique': ({ where }) => ({
        id: where.id, tenant_id: conta, patient_id: `pac-${conta}`, assigned_user_id: 'dentista-1', title: 'Consulta',
        start_at: new Date('2026-10-21T10:00:00.000Z'), end_at: new Date('2026-10-21T10:30:00.000Z'), status: 'CONCLUIDO', type: 'CONSULTA',
      }),
    });
    return { svc: new PostCareService(b.prisma, {} as any), ...b };
  }

  it('clínica sem laboratório e com OUTRA conta laboratório: cria a pesquisa, igual', async () => {
    const a = montar([], CLINICA);
    expect(await a.svc.ensureSurveyForAppointment('evento-1', CFG)).toEqual({ survey_id: 'novo-postCareSurvey', created: true });
    expect(a.nomes()).toEqual(['calendarEvent.findUnique', 'postCareSurvey.findUnique', 'postCareSurvey.create']);
    const d = montar([LAB], CLINICA);
    await d.svc.ensureSurveyForAppointment('evento-1', CFG);
    expect(d.ops).toEqual(a.ops);
  });

  it('laboratório (cron ou test-send): sem pesquisa', async () => {
    const m = montar([LAB], LAB);
    expect(await m.svc.ensureSurveyForAppointment('evento-lab', CFG)).toBeNull();
    expect(m.nomes()).toEqual(['calendarEvent.findUnique']);
    expect(registrou('log', '[LAB-GATE] pesquisa-pos-atendimento')).toBe(true);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Follow-up, automações, lead órfão, Drive
// ═════════════════════════════════════════════════════════════════════════════

describe('Follow-up — laboratório: inscrição manual recusada, automática não acontece', () => {
  function montar(labs: string[], conta: string) {
    const b = banco(labs, {
      'lead.findUnique': ({ where }) => ({ id: where.id, tenant_id: conta, is_client: false }),
      'followupSequence.findUnique': ({ where }) => ({ id: where.id, tenant_id: null, active: true, steps: [{ delay_hours: 1 }] }),
      'followupSequence.findMany': () => [{ id: 'seq-1', name: 'Novo Lead — Captação', category: 'LEADS' }],
      'followupEnrollment.upsert': () => ({ id: 'inscricao-1' }),
    });
    const fila = { add: jest.fn(async (..._a: any[]) => ({ id: 'job' })) };
    return { svc: new FollowupService(b.prisma, fila as any), fila, ...b };
  }

  it('inscrição, clínica sem laboratório e com OUTRA conta laboratório: inscreve e agenda o passo 1, igual', async () => {
    const a = montar([], CLINICA);
    await a.svc.enrollLead('lead-1', 'seq-1');
    expect(a.nomes()).toEqual(['lead.findUnique', 'followupSequence.findUnique', 'followupEnrollment.findUnique', 'followupEnrollment.upsert']);
    expect(a.fila.add).toHaveBeenCalledTimes(1);
    const d = montar([LAB], CLINICA);
    await d.svc.enrollLead('lead-1', 'seq-1');
    expect(d.ops).toEqual(a.ops);
    expect(d.fila.add.mock.calls).toEqual(a.fila.add.mock.calls);
  });

  it('inscrição manual, laboratório: recusa (VERTICAL_DENIED), nada inscrito', async () => {
    const m = montar([LAB], LAB);
    expect(codigo(await erro(m.svc.enrollLead('lead-lab', 'seq-1')))).toBe(CODIGO_VERTICAL_NEGADA);
    expect(m.de('followupEnrollment.upsert')).toEqual([]);
    expect(m.fila.add).not.toHaveBeenCalled();
  });

  it('auto-inscrição por etapa, clínica sem laboratório e com OUTRA conta laboratório: igual', async () => {
    const a = montar([], CLINICA);
    await a.svc.autoEnrollByStage('lead-1', 'NOVO');
    expect(a.de('followupEnrollment.upsert')).toHaveLength(1);
    const d = montar([LAB], CLINICA);
    await d.svc.autoEnrollByStage('lead-1', 'NOVO');
    expect(d.ops).toEqual(a.ops);
  });

  it('auto-inscrição por etapa, laboratório: nem lê as sequências (nem as globais)', async () => {
    const m = montar([LAB], LAB);
    await m.svc.autoEnrollByStage('lead-lab', 'NOVO');
    expect(m.nomes()).toEqual(['lead.findUnique']);
    expect(registrou('log', '[LAB-GATE] followup-auto')).toBe(true);
  });
});

describe('Regras de automação — as globais (de clínica) não agem em lead de laboratório', () => {
  const regra = (id: string, tenant_id: string | null, trigger: string) => ({ id, tenant_id, trigger, action: 'ADD_TAG', action_value: id, enabled: true });
  const REGRAS = ['NEW_LEAD', 'STAGE_CHANGE'].flatMap((g) => [regra(`global-${g}`, null, g), regra(`clinica-${g}`, CLINICA, g), regra(`lab-${g}`, LAB, g)]);
  const CONTA_DO_LEAD: Record<string, string | null> = { 'lead-clinica': CLINICA, 'lead-lab': LAB, 'lead-legado': null };
  function montar(labs: string[]) {
    const b = banco(labs, {
      'automationRule.findMany': ({ where }) => REGRAS.filter((r) => (!where?.trigger || r.trigger === where.trigger) && casa(where, r)),
      'automationRule.findUnique': ({ where }) => REGRAS.find((r) => r.id === where.id) ?? null,
      'lead.findUnique': ({ where, select }) => (select?.tags ? { tags: [] } : { tenant_id: CONTA_DO_LEAD[where.id] ?? null }),
    });
    return { svc: new AutomationsService(b.prisma, { get: () => undefined } as any), ...b };
  }
  const etiquetas = (m: ReturnType<typeof montar>) => m.de('lead.update').map((a: any) => a.data.tags[0]);

  it('lead novo, clínica sem laboratório e com OUTRA conta laboratório: a global e a da clínica agem, igual', async () => {
    const a = montar([]);
    await a.svc.onNewLead('lead-clinica', CLINICA);
    expect(etiquetas(a)).toEqual(['global-NEW_LEAD', 'clinica-NEW_LEAD']);
    const d = montar([LAB]);
    await d.svc.onNewLead('lead-clinica', CLINICA);
    expect(d.ops).toEqual(a.ops);
  });

  it('lead novo, laboratório: só a regra da conta dele (a global fica fora)', async () => {
    const m = montar([LAB]);
    await m.svc.onNewLead('lead-lab', LAB);
    expect(etiquetas(m)).toEqual(['lab-NEW_LEAD']);
    expect(registrou('log', '[LAB-GATE] automacoes')).toBe(true);
  });

  it('troca de etapa, clínica sem laboratório e com OUTRA conta laboratório: a global e a da clínica agem, igual', async () => {
    const a = montar([]);
    await a.svc.onStageChange('lead-clinica', 'QUALIFICANDO', CLINICA);
    expect(etiquetas(a)).toEqual(['global-STAGE_CHANGE', 'clinica-STAGE_CHANGE']);
    const d = montar([LAB]);
    await d.svc.onStageChange('lead-clinica', 'QUALIFICANDO', CLINICA);
    expect(d.ops).toEqual(a.ops);
  });

  it('troca de etapa, laboratório: só a regra da conta dele', async () => {
    const lab = montar([LAB]);
    await lab.svc.onStageChange('lead-lab', 'QUALIFICANDO', LAB);
    expect(etiquetas(lab)).toEqual(['lab-STAGE_CHANGE']);
  });

  it('gancho sem conta, lead de laboratório: vale a conta do lead (só a regra dele)', async () => {
    const lab = montar([LAB]);
    await lab.svc.onStageChange('lead-lab', 'QUALIFICANDO', undefined);
    expect(etiquetas(lab)).toEqual(['lab-STAGE_CHANGE']);
  });

  it('gancho sem conta, lead legado sem conta com OUTRA conta laboratório: todas as regras, como antes', async () => {
    const legado = montar([LAB]);
    await legado.svc.onStageChange('lead-legado', 'QUALIFICANDO', undefined);
    expect(etiquetas(legado)).toEqual(['global-STAGE_CHANGE', 'clinica-STAGE_CHANGE', 'lab-STAGE_CHANGE']);
  });

  it('tela de regras, clínica sem laboratório e com OUTRA conta laboratório: as dela e as globais (mesmo where)', async () => {
    const a = montar([]);
    await a.svc.findAll(CLINICA);
    const d = montar([LAB]);
    await d.svc.findAll(CLINICA);
    expect(d.ops).toEqual(a.ops);
    expect(a.de('automationRule.findMany')[0].where).toEqual({ OR: [{ tenant_id: CLINICA }, { tenant_id: null }] });
  });

  it('tela de regras, laboratório: só as dele (as globais são de clínica)', async () => {
    const lab = montar([LAB]);
    await lab.svc.findAll(LAB);
    expect(lab.de('automationRule.findMany')[0].where).toEqual({ tenant_id: LAB });
  });

  it('editar/apagar, clínica com OUTRA conta laboratório: como antes (sem leitura a mais)', async () => {
    const a = montar([LAB]);
    await a.svc.update('global-NEW_LEAD', { enabled: false }, CLINICA);
    await a.svc.remove('global-NEW_LEAD', CLINICA);
    expect(a.nomes()).toEqual(['automationRule.update', 'automationRule.delete']);
  });

  it('editar/apagar, laboratório: recusa regra global ou de outra conta (VERTICAL_DENIED); mexe na dele', async () => {
    const lab = montar([LAB]);
    expect(codigo(await erro(lab.svc.update('global-NEW_LEAD', { enabled: false }, LAB)))).toBe(CODIGO_VERTICAL_NEGADA);
    expect(codigo(await erro(lab.svc.remove('clinica-NEW_LEAD', LAB)))).toBe(CODIGO_VERTICAL_NEGADA);
    expect(lab.de('automationRule.update')).toEqual([]);
    expect(lab.de('automationRule.delete')).toEqual([]);
    await lab.svc.update('lab-NEW_LEAD', { enabled: false }, LAB);
    expect(lab.de('automationRule.update')).toHaveLength(1);
  });
});

describe('Lead órfão (sem conta) — o chip do laboratório nunca adota', () => {
  function montar(labs: string[]) {
    const b = banco(labs, {
      'lead.findFirst': ({ where }) => ({ id: `lead-${where.tenant_id}` }),
      'lead.update': ({ where }) => ({ id: where.id }),
    });
    const svc = new LeadsService(b.prisma, {} as any, {} as any, { get: () => undefined } as any, {} as any);
    return { svc, ...b };
  }
  const recebida = (t: string) => ({ phone: TEL[t], name: 'Contato Exemplo', tenant_id: t } as any);

  it('clínica sem laboratório e com OUTRA conta laboratório: adota o órfão e segue igual', async () => {
    const a = montar([]);
    await a.svc.upsert(recebida(CLINICA));
    expect(a.ops[0]).toEqual(['lead.updateMany', { where: { phone: { in: expect.any(Array) }, tenant_id: null }, data: { tenant_id: CLINICA } }]);
    const d = montar([LAB]);
    await d.svc.upsert(recebida(CLINICA));
    expect(d.ops).toEqual(a.ops);
  });

  it('laboratório: não adota (o lead sem conta é legado da clínica); resolve na conta dele', async () => {
    const m = montar([LAB]);
    await m.svc.upsert(recebida(LAB));
    expect(m.de('lead.updateMany').filter((a: any) => a.where.tenant_id === null)).toEqual([]);
    expect(m.de('lead.findFirst')[0].where.tenant_id).toBe(LAB);
    expect(registrou('log', '[LAB-GATE] adocao-orfao')).toBe(true);
  });
});

describe('Pasta do lead no Google Drive (Drive global da clínica)', () => {
  function montar(labs: string[], conta: string) {
    const b = banco(labs, {
      'lead.findUnique': () => ({ tenant_id: conta, pipeline_id: null, stage_id: null, stage: 'NOVO' }),
      'lead.update': ({ where }) => ({ id: where.id, name: 'Maria Exemplo', tenant_id: conta }),
    });
    const drive = { isConfigured: jest.fn(async () => true), ensureLeadFolder: jest.fn(async (..._a: any[]) => 'pasta-1') };
    const automations = { onStageChange: jest.fn(async () => undefined) };
    const svc = new LeadsService(b.prisma, { emitConversationsUpdate: jest.fn() } as any, automations as any, { get: () => undefined } as any, drive as any);
    return { svc, drive, ...b };
  }

  it('etapa AGUARDANDO_DOCS, clínica sem laboratório e com OUTRA conta laboratório: cria a pasta, igual', async () => {
    const a = montar([], CLINICA);
    await a.svc.updateStatus('lead-1', 'AGUARDANDO_DOCS', CLINICA);
    await esperar();
    expect(a.drive.ensureLeadFolder.mock.calls).toEqual([['lead-1', 'Maria Exemplo']]);
    const d = montar([LAB], CLINICA);
    await d.svc.updateStatus('lead-1', 'AGUARDANDO_DOCS', CLINICA);
    await esperar();
    expect(d.drive.ensureLeadFolder.mock.calls).toEqual(a.drive.ensureLeadFolder.mock.calls);
    expect(d.ops).toEqual(a.ops);
  });

  it('etapa AGUARDANDO_DOCS, laboratório: sem pasta no Drive da clínica', async () => {
    const m = montar([LAB], LAB);
    await m.svc.updateStatus('lead-lab', 'AGUARDANDO_DOCS', LAB);
    await esperar();
    expect(m.drive.ensureLeadFolder).not.toHaveBeenCalled();
    expect(registrou('log', '[LAB-GATE] drive-pasta')).toBe(true);
  });

  function manual(labs: string[], conta: string) {
    const b = banco(labs, {
      'lead.findUnique': () => ({ name: 'Maria Exemplo', tenant_id: conta }),
    });
    const drive = { isConfigured: jest.fn(async () => true), ensureLeadFolder: jest.fn(async (..._a: any[]) => 'pasta-1') };
    return { ctl: new GoogleDriveController(drive as any, b.prisma), drive, ...b };
  }

  // A consulta do lead traz sempre a conta (correção "configuração por clínica":
  // lead de outra conta = 404). O freio de laboratório vem depois dessa checagem.
  it('criação manual da pasta, clínica sem laboratório cadastrado: a consulta e a pasta, como antes', async () => {
    const a = manual([], CLINICA);
    expect(await a.ctl.createLeadFolder('lead-1', { user: { tenant_id: CLINICA } })).toEqual({
      ok: true, folderId: 'pasta-1', folderUrl: 'https://drive.google.com/drive/folders/pasta-1',
    });
    expect(a.de('lead.findUnique')).toEqual([{ where: { id: 'lead-1' }, select: { name: true, tenant_id: true } }]);
  });

  it('criação manual da pasta, clínica com OUTRA conta laboratório: a mesma consulta e a mesma pasta', async () => {
    const a = manual([], CLINICA);
    await a.ctl.createLeadFolder('lead-1', { user: { tenant_id: CLINICA } });
    const d = manual([LAB], CLINICA);
    await d.ctl.createLeadFolder('lead-1', { user: { tenant_id: CLINICA } });
    expect(d.de('lead.findUnique')).toEqual(a.de('lead.findUnique'));
    expect(d.drive.ensureLeadFolder.mock.calls).toEqual(a.drive.ensureLeadFolder.mock.calls);
  });

  it('criação manual da pasta, laboratório: recusa (VERTICAL_DENIED), inclusive para o SUPER_ADMIN; cruzado = 404', async () => {
    const proprio = manual([LAB], LAB);
    expect(codigo(await erro(proprio.ctl.createLeadFolder('lead-lab', { user: { tenant_id: LAB } })))).toBe(CODIGO_VERTICAL_NEGADA);
    const plataforma = manual([LAB], LAB);
    expect(codigo(await erro(plataforma.ctl.createLeadFolder('lead-lab', { user: { roles: ['SUPER_ADMIN'] } })))).toBe(CODIGO_VERTICAL_NEGADA);
    const cruzado = manual([LAB], CLINICA);
    expect(await erro(cruzado.ctl.createLeadFolder('lead-1', { user: { tenant_id: LAB } }))).toBeInstanceOf(NotFoundException);
    for (const m of [proprio, plataforma, cruzado]) expect(m.drive.ensureLeadFolder).not.toHaveBeenCalled();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Contratos (odontológico e jurídico legado)
// ═════════════════════════════════════════════════════════════════════════════

describe('Contrato de tratamento odontológico — laboratório recusa criar e enviar', () => {
  function criar(labs: string[], conta: string) {
    const b = banco(labs, {
      'quote.findUnique': ({ where }) => ({ id: where.id, status: 'ACCEPTED', patient: { id: `pac-${conta}`, tenant_id: conta }, contract: null, items: [] }),
    });
    const pdf = { assessCompleteness: jest.fn(async () => ({ complete: false, missing: ['CPF do paciente'] })) };
    return { svc: new ContractsService(b.prisma, pdf as any), pdf, ...b };
  }

  it('criar, clínica sem laboratório e com OUTRA conta laboratório: confere os dados, igual', async () => {
    const a = criar([], CLINICA);
    const e = await erro(a.svc.createForQuote('orc-1', CLINICA, 'usuario-1'));
    expect(e.message).toContain('Faltam dados pra gerar o contrato: CPF do paciente');
    expect(a.pdf.assessCompleteness).toHaveBeenCalledWith('orc-1', CLINICA, undefined);
    const d = criar([LAB], CLINICA);
    await erro(d.svc.createForQuote('orc-1', CLINICA, 'usuario-1'));
    expect(d.ops).toEqual(a.ops);
    expect(d.pdf.assessCompleteness.mock.calls).toEqual(a.pdf.assessCompleteness.mock.calls);
  });

  it('criar, laboratório: recusa (VERTICAL_DENIED) antes de montar o contrato', async () => {
    const m = criar([LAB], LAB);
    expect(codigo(await erro(m.svc.createForQuote('orc-lab', LAB, 'usuario-1')))).toBe(CODIGO_VERTICAL_NEGADA);
    expect(m.pdf.assessCompleteness).not.toHaveBeenCalled();
  });

  function enviar(labs: string[], conta: string, status: string) {
    const b = banco(labs, {
      'contract.findUnique': ({ where }) => ({
        id: where.id, status,
        quote: { patient: { id: `pac-${conta}`, name: 'Maria Exemplo', phone: TEL[conta], tenant_id: conta, lead_id: null, lead: null } },
      }),
    });
    const messages = { resolvePatientChips: jest.fn(async () => []) };
    const svc = new ContractWhatsappService(b.prisma, {} as any, {} as any, messages as any, {} as any, {} as any);
    return { svc, messages, ...b };
  }

  it('enviar no WhatsApp / ClickSign, clínica sem laboratório e com OUTRA conta laboratório: mesmas checagens', async () => {
    for (const labs of [[], [LAB]]) {
      const zap = enviar(labs, CLINICA, 'CANCELLED');
      expect((await erro(zap.svc.send('contrato-1', CLINICA, 'usuario-1', 'Segue o contrato'))).message).toBe(
        (zap.svc as any).problemMessage('CONTRACT_INACTIVE'),
      );
      const cs = enviar(labs, CLINICA, 'DRAFT');
      expect((await erro(cs.svc.sendClickSign('contrato-1', CLINICA, 'usuario-1'))).message).toBe((cs.svc as any).problemMessage('NO_CLINICAL_CHIP'));
      expect(cs.messages.resolvePatientChips).toHaveBeenCalledWith(CLINICA, true);
    }
  });

  it('enviar no WhatsApp / ClickSign, laboratório: recusa (VERTICAL_DENIED) antes de qualquer checagem de envio', async () => {
    const zap = enviar([LAB], LAB, 'DRAFT');
    expect(codigo(await erro(zap.svc.send('contrato-lab', LAB, 'usuario-1', 'Segue o contrato')))).toBe(CODIGO_VERTICAL_NEGADA);
    const cs = enviar([LAB], LAB, 'DRAFT');
    expect(codigo(await erro(cs.svc.sendClickSign('contrato-lab', LAB, 'usuario-1')))).toBe(CODIGO_VERTICAL_NEGADA);
    expect(zap.messages.resolvePatientChips).not.toHaveBeenCalled();
    expect(cs.messages.resolvePatientChips).not.toHaveBeenCalled();
  });
});

describe('Contrato jurídico legado (ClickSign e trabalhista) — laboratório recusa', () => {
  const conversa = (conta: string, contaDoContato = conta) => ({
    'conversation.findUnique': ({ where }: any) => ({
      id: where.id, tenant_id: conta, instance_name: `chip-${conta}`,
      lead: { id: `lead-${contaDoContato}`, name: 'Maria Exemplo', phone: TEL[contaDoContato], tenant_id: contaDoContato },
    }),
  });
  function clicksign(labs: string[], conta: string, contaDoContato = conta) {
    const b = banco(labs, conversa(conta, contaDoContato));
    const contratos = { generateBuffer: jest.fn(async () => Buffer.from('docx-exemplo')) };
    const whatsapp = { sendText: jest.fn(async () => ({ key: { id: 'wamid-1' } })) };
    const svc = new ClicksignService(b.prisma, {} as any, whatsapp as any, { emitNewMessage: jest.fn() } as any, contratos as any, {} as any);
    jest.spyOn(svc as any, 'getCfg').mockResolvedValue({ baseUrl: 'https://assinatura.exemplo.test', token: 'token-exemplo', webhookToken: '' });
    jest.spyOn(svc as any, 'uploadDocument').mockResolvedValue('doc-1');
    jest.spyOn(svc as any, 'createSigner').mockResolvedValue('signatario-1');
    jest.spyOn(svc as any, 'addSignerToDocument').mockResolvedValue('pedido-1');
    return { svc, contratos, whatsapp, ...b };
  }
  const VARIAVEIS = { NOME_CONTRATANTE: 'Maria Exemplo', PERCENTUAL: '30' } as any;

  it('ClickSign, clínica sem laboratório e com OUTRA conta laboratório: gera, sobe e manda o link, igual', async () => {
    const a = clicksign([], CLINICA);
    expect(await a.svc.requestSignature({ conversationId: 'conversa-1', variaveis: VARIAVEIS })).toMatchObject({
      signingUrl: 'https://assinatura.exemplo.test/sign/pedido-1',
    });
    expect(a.contratos.generateBuffer).toHaveBeenCalledWith(VARIAVEIS, CLINICA);
    expect(a.whatsapp.sendText).toHaveBeenCalledTimes(1);
    const d = clicksign([LAB], CLINICA);
    await d.svc.requestSignature({ conversationId: 'conversa-1', variaveis: VARIAVEIS });
    expect(d.ops).toEqual(a.ops);
    expect(d.whatsapp.sendText.mock.calls).toEqual(a.whatsapp.sendText.mock.calls);
  });

  it('ClickSign, laboratório (pela conversa ou pelo contato): recusa (VERTICAL_DENIED) antes de gerar', async () => {
    for (const [conta, contato] of [[LAB, LAB], [null as any, LAB]]) {
      const m = clicksign([LAB], conta, contato);
      expect(codigo(await erro(m.svc.requestSignature({ conversationId: 'conversa-lab', variaveis: VARIAVEIS })))).toBe(CODIGO_VERTICAL_NEGADA);
      expect(m.contratos.generateBuffer).not.toHaveBeenCalled();
      expect(m.whatsapp.sendText).not.toHaveBeenCalled();
      expect(m.de('contractSignature.create')).toEqual([]);
    }
  });

  function trabalhista(labs: string[], conta: string, contaDoContato = conta) {
    const b = banco(labs, conversa(conta, contaDoContato));
    const svc = new ContratoJuridicoService(b.prisma, {} as any, {} as any, {} as any);
    const pdf = jest.spyOn(svc as any, 'generatePdfBuffer').mockRejectedValue(new Error('parou-aqui'));
    return { svc, pdf, ...b };
  }

  it('trabalhista, clínica sem laboratório e com OUTRA conta laboratório: segue para gerar o PDF, igual', async () => {
    for (const labs of [[], [LAB]]) {
      const m = trabalhista(labs, CLINICA);
      expect((await erro(m.svc.generateAndSend('conversa-1', { ...VARIAVEIS }, 'https://api.exemplo.test'))).message).toBe('parou-aqui');
      expect(m.pdf).toHaveBeenCalledTimes(1);
      expect(m.nomes()).toEqual(['conversation.findUnique']);
    }
  });

  it('trabalhista, laboratório (pela conversa ou pelo contato): recusa (VERTICAL_DENIED)', async () => {
    for (const [conta, contato] of [[LAB, LAB], [null as any, LAB]]) {
      const m = trabalhista([LAB], conta, contato);
      expect(codigo(await erro(m.svc.generateAndSend('conversa-lab', { ...VARIAVEIS }, 'https://api.exemplo.test')))).toBe(CODIGO_VERTICAL_NEGADA);
      expect(m.pdf).not.toHaveBeenCalled();
    }
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Seeds, anamnese master, funis padrão, portal
// ═════════════════════════════════════════════════════════════════════════════

describe('Seeds de clínica — o laço de todas pula o laboratório; o seed da conta recusa', () => {
  const CONTAS = [CLINICA, LAB, OUTRA_CLINICA];
  function montar(labs: string[], contas = CONTAS) {
    const b = banco(labs, {
      'tenant.findMany': () => contas.map((id) => ({ id, name: `Conta ${id}` })),
      'tenant.findUnique': ({ where }) => ({ id: where.id, name: `Conta ${where.id}` }),
    });
    return { svc: new TenantsService(b.prisma, {} as any), ...b };
  }

  it('seed de todas, sem laboratório cadastrado: todas as contas, como antes', async () => {
    const a = montar([]);
    const ra = await a.svc.seedDefaultsForAll();
    expect(ra.results.map((r: any) => r.tenant_id)).toEqual(CONTAS);
  });

  it('seed de todas, com laboratório: o mesmo laço de antes sobre as clínicas, sem ele', async () => {
    const d = montar([LAB]);
    const rd = await d.svc.seedDefaultsForAll();
    expect(rd.results.map((r: any) => r.tenant_id)).toEqual([CLINICA, OUTRA_CLINICA]);
    expect(rd.total).toBe(2);
    // O laço com laboratório é o de antes sobre as clínicas (como se ele não existisse).
    const soClinicas = montar([], [CLINICA, OUTRA_CLINICA]);
    await soClinicas.svc.seedDefaultsForAll();
    expect(d.ops).toEqual(soClinicas.ops);
    expect(tocaLab(d.ops)).toBe(false);
  });

  it('seed da conta, clínica sem laboratório e com OUTRA conta laboratório: igual', async () => {
    const a = montar([]);
    await a.svc.seedDefaults(CLINICA);
    expect(a.ops[0]).toEqual(['tenant.findUnique', { where: { id: CLINICA } }]);
    const d = montar([LAB]);
    await d.svc.seedDefaults(CLINICA);
    expect(d.ops).toEqual(a.ops);
  });

  it('seed da conta, laboratório: recusa (VERTICAL_DENIED), nada criado', async () => {
    const m = montar([LAB]);
    expect(codigo(await erro(m.svc.seedDefaults(LAB)))).toBe(CODIGO_VERTICAL_NEGADA);
    expect(m.ops).toEqual([]);
  });
});

describe('Anamnese master — a propagação pula o laboratório', () => {
  function montar(labs: string[], contas = [CLINICA, LAB, OUTRA_CLINICA]) {
    const b = banco(labs, {
      'globalAnamnesisTemplate.upsert': () => ({ id: 'singleton', version: 4 }),
      'tenant.findMany': () => contas.map((id) => ({ id, name: `Conta ${id}` })),
    });
    return { svc: new GlobalAnamnesisService(b.prisma), ...b };
  }

  it('sem laboratório cadastrado: propaga em todas, como antes', async () => {
    const a = montar([]);
    const ra = await a.svc.update({ secoes: [] }, 'super-1');
    expect(ra).toMatchObject({ propagated: 3, failed: 0, total_tenants: 3 });
    expect(a.de('anamnesisTemplate.upsert').map((u: any) => u.create.tenant_id)).toEqual([CLINICA, LAB, OUTRA_CLINICA]);
  });

  it('com laboratório: o mesmo laço de antes sobre as clínicas, sem ele', async () => {
    const d = montar([LAB]);
    const rd = await d.svc.update({ secoes: [] }, 'super-1');
    expect(rd).toMatchObject({ propagated: 2, failed: 0, total_tenants: 2 });
    const soClinicas = montar([], [CLINICA, OUTRA_CLINICA]);
    await soClinicas.svc.update({ secoes: [] }, 'super-1');
    expect(d.ops).toEqual(soClinicas.ops);
    expect(tocaLab(d.ops)).toBe(false);
  });
});

describe('Funis padrão de clínica (POST pipelines/seed-defaults) — laboratório recusa', () => {
  function montar(labs: string[]) {
    const b = banco(labs);
    return { svc: new PipelinesService(b.prisma), ...b };
  }

  it('clínica sem laboratório e com OUTRA conta laboratório: cria os funis, igual', async () => {
    const a = montar([]);
    const ra = await a.svc.seedDefaults(CLINICA);
    expect(ra.created.length).toBeGreaterThan(0);
    const d = montar([LAB]);
    await d.svc.seedDefaults(CLINICA);
    expect(d.ops).toEqual(a.ops);
  });

  it('laboratório: recusa (VERTICAL_DENIED), nenhum funil criado', async () => {
    const m = montar([LAB]);
    expect(codigo(await erro(m.svc.seedDefaults(LAB)))).toBe(CODIGO_VERTICAL_NEGADA);
    expect(m.ops).toEqual([]);
  });
});

describe('Portal do paciente — link recusado e troca do token barrada no laboratório', () => {
  function montar(labs: string[], conta: string) {
    const b = banco(labs, {
      'patient.findFirst': ({ where }) => ({ id: where.id, name: 'Maria Exemplo', phone: TEL[conta], email: null }),
      'portalToken.findUnique': () => ({
        id: 'token-1', consumed_at: null, expires_at: new Date('2026-10-25T00:00:00.000Z'),
        patient: { id: `pac-${conta}`, name: 'Maria Exemplo', tenant_id: conta, status: 'ACTIVE' },
      }),
    });
    const jwt = { signAsync: jest.fn(async () => 'jwt-exemplo') };
    return { svc: new PortalAuthService(b.prisma, jwt as any, {} as any), jwt, ...b };
  }

  it('link, clínica sem laboratório e com OUTRA conta laboratório: cria o token, igual', async () => {
    for (const labs of [[], [LAB]]) {
      const m = montar(labs, CLINICA);
      const r = await m.svc.createMagicLink(CLINICA, 'pac-1', 'OTHER');
      expect(r.link).toContain('/area-paciente/login?token=');
      expect(m.nomes()).toEqual(['patient.findFirst', 'portalToken.create']);
      expect(m.de('portalToken.create')[0].data).toMatchObject({ tenant_id: CLINICA, patient_id: 'pac-1', channel: 'OTHER' });
    }
  });

  it('link, laboratório: recusa (VERTICAL_DENIED), nenhum token', async () => {
    const m = montar([LAB], LAB);
    expect(codigo(await erro(m.svc.createMagicLink(LAB, 'pac-lab', 'WHATSAPP')))).toBe(CODIGO_VERTICAL_NEGADA);
    expect(m.de('portalToken.create')).toEqual([]);
  });

  it('troca do token, clínica sem laboratório e com OUTRA conta laboratório: consome e entra, igual', async () => {
    const a = montar([], CLINICA);
    expect(await a.svc.exchangeToken('token-exemplo-123')).toEqual({ jwt: 'jwt-exemplo', patient: { id: `pac-${CLINICA}`, name: 'Maria Exemplo' } });
    const d = montar([LAB], CLINICA);
    await d.svc.exchangeToken('token-exemplo-123');
    expect(d.ops).toEqual(a.ops);
    expect(d.jwt.signAsync.mock.calls).toEqual(a.jwt.signAsync.mock.calls);
  });

  it('troca do token, laboratório (link de antes da conversão): recusa, não consome', async () => {
    const m = montar([LAB], LAB);
    expect(codigo(await erro(m.svc.exchangeToken('token-exemplo-123')))).toBe(CODIGO_VERTICAL_NEGADA);
    expect(m.de('portalToken.update')).toEqual([]);
    expect(m.jwt.signAsync).not.toHaveBeenCalled();
  });
});

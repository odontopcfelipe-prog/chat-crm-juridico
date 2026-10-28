/**
 * F5 — conversa do Financeiro numa conta de laboratório.
 *
 * Laboratório: a conversa que o sistema cria para o aviso ao cliente (a própria do
 * Financeiro, achada ou criada em findOrCreateFinanceiroConversation, e a de reserva
 * do aviso de cobrança cancelada/estornada quando a conta não tem setor Financeiro)
 * nasce com ai_mode=false. Lá a IA não responde, e com true a conversa aparecia como
 * do robô, fora das filas Minhas/Espera da equipe.
 *
 * Clínica: as mesmas operações, na mesma ordem e com os mesmos argumentos, sem nenhum
 * laboratório cadastrado e com OUTRA conta laboratório cadastrada; o create leva os
 * mesmos campos de antes. A leitura da lista de laboratórios (cache de 60 s) fica fora
 * da comparação. Prisma e WhatsApp falsos; relógio fixo.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as ts from 'typescript';
import { Logger } from '@nestjs/common';
import { __limparCacheLabTenants } from '@crm/shared';

// ─── Dados de exemplo (repositório público: nada real) ───────────────────────
const AGORA = new Date('2026-10-21T15:00:00.000Z');
const CLINICA = 'conta-clinica-exemplo';
const LAB = 'conta-lab-exemplo';
const OUTRO_LAB = 'conta-outro-lab-exemplo';
const LEAD = 'lead-1';
const TEL = '5582988887777';
const INBOX_FIN = 'inbox-financeiro';
const CHIP_FIN = 'chip-financeiro-exemplo';

// ─── Carregador: o arquivo-fonte real, com o import dinâmico virando require ─
// Mesmo carregador dos retratos mensagens-paciente e cobranca.laboratorio: o jest
// deste projeto não executa `await import('@crm/shared')` (usado pelo aviso de
// cobrança cancelada); o resto é o código de produção byte a byte.
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
const { PaymentGatewayService } = carregarFonte('payment-gateway/payment-gateway.service.ts');

type Op = [string, any];

interface Mundo {
  /** Conta do contato e da cobrança. */
  conta: string;
  labs: string[];
  /** A conta tem setor Financeiro (inbox) com chip. */
  temFinanceiro: boolean;
  /** Já existe conversa aberta do Financeiro para o contato. */
  jaTemConversa: boolean;
}

function montar(m: Partial<Mundo> = {}) {
  const w: Mundo = { conta: CLINICA, labs: [], temFinanceiro: true, jaTemConversa: false, ...m };
  const ops: Op[] = [];
  const respostas: Record<string, (a: any) => any> = {
    'inbox.findFirst': () => (w.temFinanceiro ? { id: INBOX_FIN } : null),
    'conversation.findFirst': () => (w.jaTemConversa ? { id: 'conversa-existente', instance_name: CHIP_FIN } : null),
    'conversation.create': (a) => ({ id: 'conversa-nova', instance_name: a.data.instance_name ?? null }),
    'paymentGatewayCustomer.findFirst': () => ({
      lead: { id: LEAD, name: 'Dra. Exemplo', phone: TEL, tenant_id: w.conta },
    }),
  };
  const prisma: any = new Proxy(
    {},
    {
      get(_a, modelo: string | symbol) {
        if (typeof modelo !== 'string' || modelo === 'then') return undefined;
        if (modelo === '$transaction') return async (fn: (tx: any) => any) => fn(prisma);
        if (modelo === '$executeRaw') {
          return async (_partes: TemplateStringsArray, ...valores: any[]) => {
            ops.push(['$executeRaw', valores]);
            return 0;
          };
        }
        return new Proxy(
          {},
          {
            get(_b, metodo: string | symbol) {
              if (typeof metodo !== 'string' || metodo === 'then') return undefined;
              return async (args: any) => {
                const op = `${modelo}.${metodo}`;
                // A lista de laboratórios (só leitura, cache de 60 s) fica fora da comparação.
                if (op === 'tenantBusinessProfile.findMany') return w.labs.map((tenant_id) => ({ tenant_id }));
                ops.push([op, args]);
                const r = respostas[op];
                if (r) return r(args);
                if (metodo === 'findMany') return [];
                return null;
              };
            },
          },
        );
      },
    },
  );
  const whatsapp: any = {
    getInstanceForPurpose: async (...a: any[]) => {
      ops.push(['whatsapp.getInstanceForPurpose', a]);
      return w.temFinanceiro ? CHIP_FIN : null;
    },
    sendText: async (...a: any[]) => {
      ops.push(['whatsapp.sendText', a]);
      return { key: { id: 'MSG-EXEMPLO-1' } };
    },
  };
  const svc = new PaymentGatewayService(prisma, {} as any, whatsapp, {} as any, {} as any, {} as any, {} as any);
  return { svc, ops };
}

const argsDe = (ops: Op[], op: string) => ops.filter((o) => o[0] === op).map((o) => o[1]);

let logs: string[];

beforeEach(() => {
  __limparCacheLabTenants();
  jest.useFakeTimers({
    now: AGORA,
    doNotFake: [
      'nextTick', 'setImmediate', 'clearImmediate', 'setTimeout', 'clearTimeout',
      'setInterval', 'clearInterval', 'queueMicrotask', 'hrtime', 'performance',
    ],
  });
  logs = [];
  for (const nivel of ['log', 'warn', 'error', 'debug'] as const) {
    jest.spyOn(Logger.prototype, nivel).mockImplementation((msg: any) => {
      logs.push(String(msg));
    });
  }
});

afterEach(() => {
  jest.restoreAllMocks();
  jest.useRealTimers();
});

describe('conversa própria do Financeiro (findOrCreateFinanceiroConversation)', () => {
  const criar = (svc: any, conta: string) => svc.findOrCreateFinanceiroConversation(LEAD, conta, TEL);
  const CAMPOS = {
    lead_id: LEAD,
    channel: 'whatsapp',
    status: 'ABERTO',
    external_id: `${TEL}@s.whatsapp.net`,
    inbox_id: INBOX_FIN,
    instance_name: CHIP_FIN,
  };

  it('laboratório: nasce com ai_mode=false', async () => {
    const { svc, ops } = montar({ conta: LAB, labs: [LAB] });
    await expect(criar(svc, LAB)).resolves.toEqual({ id: 'conversa-nova', instance_name: CHIP_FIN });

    expect(argsDe(ops, 'conversation.create')).toEqual([
      {
        data: { ...CAMPOS, tenant_id: LAB, last_message_at: AGORA, ai_mode: false },
        select: { id: true, instance_name: true },
      },
    ]);
    expect(logs.some((l) => l.startsWith('[LAB-GATE] financeiro'))).toBe(true);
  });

  it('clínica, com e sem laboratório cadastrado: o create leva os mesmos campos de hoje (sem ai_mode)', async () => {
    const semLab = montar({ labs: [] });
    const r1 = await criar(semLab.svc, CLINICA);
    __limparCacheLabTenants();
    const comLab = montar({ labs: [OUTRO_LAB] });
    const r2 = await criar(comLab.svc, CLINICA);

    expect(comLab.ops).toEqual(semLab.ops);
    expect(r2).toEqual(r1);
    const [criacao] = argsDe(comLab.ops, 'conversation.create');
    expect(criacao.data).toEqual({ ...CAMPOS, tenant_id: CLINICA, last_message_at: AGORA });
    expect(Object.keys(criacao.data)).toEqual([
      'lead_id', 'channel', 'status', 'external_id', 'inbox_id', 'instance_name', 'tenant_id', 'last_message_at',
    ]);
    expect(logs.some((l) => l.includes('[LAB-GATE]'))).toBe(false);
  });

  it('conversa que já existe é reusada como hoje, no laboratório e na clínica', async () => {
    for (const [conta, labs] of [[LAB, [LAB]], [CLINICA, [OUTRO_LAB]]] as Array<[string, string[]]>) {
      __limparCacheLabTenants();
      const { svc, ops } = montar({ conta, labs, jaTemConversa: true });
      await expect(criar(svc, conta)).resolves.toEqual({ id: 'conversa-existente', instance_name: CHIP_FIN });
      expect(argsDe(ops, 'conversation.create')).toEqual([]);
      expect(argsDe(ops, 'conversation.update')).toEqual([]);
    }
  });
});

describe('aviso de cobrança cancelada sem setor Financeiro: conversa de reserva', () => {
  const avisar = (svc: any, conta: string) =>
    svc.notifyClientChargeDeleted(
      { customer: 'cus_exemplo', value: 350, description: 'Trabalho de exemplo' },
      { tenant_id: conta, amount: 350 },
      'DELETED',
    );

  it('laboratório: nasce com ai_mode=false', async () => {
    const { svc, ops } = montar({ conta: LAB, labs: [LAB], temFinanceiro: false });
    await avisar(svc, LAB);

    const [criacao] = argsDe(ops, 'conversation.create');
    expect(criacao.data).toEqual({
      lead_id: LEAD,
      channel: 'whatsapp',
      status: 'ABERTO',
      instance_name: null,
      last_message_at: AGORA,
      tenant_id: LAB,
      ai_mode: false,
    });
    // O aviso continua saindo e ficando na conversa criada.
    expect(argsDe(ops, 'whatsapp.sendText')).toHaveLength(1);
    expect(argsDe(ops, 'message.create')[0].data.conversation_id).toBe('conversa-nova');
  });

  it('clínica, com e sem laboratório cadastrado: as mesmas operações e o create sem ai_mode', async () => {
    const semLab = montar({ labs: [], temFinanceiro: false });
    await avisar(semLab.svc, CLINICA);
    __limparCacheLabTenants();
    const comLab = montar({ labs: [OUTRO_LAB], temFinanceiro: false });
    await avisar(comLab.svc, CLINICA);

    expect(comLab.ops).toEqual(semLab.ops);
    const [criacao] = argsDe(comLab.ops, 'conversation.create');
    expect(Object.keys(criacao.data)).toEqual([
      'lead_id', 'channel', 'status', 'instance_name', 'last_message_at', 'tenant_id',
    ]);
    expect(logs.some((l) => l.includes('[LAB-GATE]'))).toBe(false);
  });
});

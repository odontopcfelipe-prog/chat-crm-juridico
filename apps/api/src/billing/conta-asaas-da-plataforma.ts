/**
 * Mensalidade dos laboratórios — conta Asaas DA PLATAFORMA.
 *
 * O laboratório paga a mensalidade numa conta Asaas própria da plataforma, separada
 * de qualquer clínica. A mensalidade da clínica continua no caminho de sempre
 * (BillingService, conta global), sem mudança. Chave e ambiente ficam na
 * GlobalSetting; a chave é gravada cifrada (SENSITIVE_KEYS). Sem chave, a
 * assinatura do laboratório não abre e nada é criado em conta nenhuma.
 *
 * O que vale é sempre o que o Asaas responde: o aviso (webhook) só pede uma nova
 * leitura dos pagamentos da assinatura, nunca é tomado como pagamento.
 */
import { decryptValue, encryptValue } from '../common/utils/crypto.util';

export const CHAVE_API_PLATAFORMA = 'ASAAS_PLATAFORMA_API_KEY';
export const CHAVE_SANDBOX_PLATAFORMA = 'ASAAS_PLATAFORMA_SANDBOX';

const URL_PRODUCAO = 'https://api.asaas.com/v3';
const URL_SANDBOX = 'https://api-sandbox.asaas.com/v3';
const TEMPO_LIMITE_MS = 15_000;

export interface ContaAsaasDaPlataforma {
  apiKey: string;
  baseUrl: string;
  sandbox: boolean;
}

type LinhaGlobal = { value?: string | null; updated_at?: Date | null } | null;
type PrismaGlobal = {
  globalSetting: {
    findUnique(args: { where: { key: string } }): Promise<LinhaGlobal>;
    upsert(args: { where: { key: string }; create: { key: string; value: string }; update: { value: string } }): Promise<unknown>;
  };
};

/**
 * Valor cifrado → texto; o gravado em texto puro (manual) volta como está. Cifrado
 * que não abre (segredo trocado) conta como sem chave: nunca vai cifrado para o Asaas.
 */
function abrir(valor: string | null | undefined): string {
  if (!valor) return '';
  try {
    return decryptValue(valor).trim();
  } catch {
    return '';
  }
}

/** A conta da plataforma, ou null sem chave (ou se a leitura falhar). */
export async function lerContaDaPlataforma(prisma: PrismaGlobal): Promise<ContaAsaasDaPlataforma | null> {
  try {
    const [chave, sandbox] = await Promise.all([
      prisma.globalSetting.findUnique({ where: { key: CHAVE_API_PLATAFORMA } }),
      prisma.globalSetting.findUnique({ where: { key: CHAVE_SANDBOX_PLATAFORMA } }),
    ]);
    const apiKey = abrir(chave?.value);
    if (!apiKey) return null;
    const ehSandbox = sandbox?.value === 'true';
    return { apiKey, sandbox: ehSandbox, baseUrl: ehSandbox ? URL_SANDBOX : URL_PRODUCAO };
  } catch {
    return null;
  }
}

/** O que a tela do administrador vê: nunca a chave. */
export async function resumoDaContaDaPlataforma(
  prisma: PrismaGlobal,
): Promise<{ configurada: boolean; sandbox: boolean; atualizado_em: Date | null }> {
  const [chave, sandbox] = await Promise.all([
    prisma.globalSetting.findUnique({ where: { key: CHAVE_API_PLATAFORMA } }),
    prisma.globalSetting.findUnique({ where: { key: CHAVE_SANDBOX_PLATAFORMA } }),
  ]);
  return {
    configurada: !!abrir(chave?.value),
    sandbox: sandbox?.value === 'true',
    atualizado_em: chave?.updated_at ?? null,
  };
}

/** Grava a chave (cifrada) e/ou o ambiente. Chave vazia = mantém a atual. */
export async function gravarContaDaPlataforma(
  prisma: PrismaGlobal,
  dados: { apiKey?: string | null; sandbox?: boolean | null },
): Promise<void> {
  const apiKey = typeof dados.apiKey === 'string' ? dados.apiKey.trim() : '';
  if (apiKey) {
    const value = encryptValue(apiKey);
    await prisma.globalSetting.upsert({
      where: { key: CHAVE_API_PLATAFORMA },
      create: { key: CHAVE_API_PLATAFORMA, value },
      update: { value },
    });
  }
  if (typeof dados.sandbox === 'boolean') {
    const value = dados.sandbox ? 'true' : 'false';
    await prisma.globalSetting.upsert({
      where: { key: CHAVE_SANDBOX_PLATAFORMA },
      create: { key: CHAVE_SANDBOX_PLATAFORMA, value },
      update: { value },
    });
  }
}

/** Erro do Asaas com o status HTTP e a descrição que ele devolveu. */
export class ErroDoAsaas extends Error {
  constructor(
    readonly status: number,
    readonly descricao: string,
  ) {
    super(`[Asaas ${status}] ${descricao}`);
  }
}

/** Uma chamada à API do Asaas na conta da plataforma. */
export async function chamarAsaas(
  conta: ContaAsaasDaPlataforma,
  metodo: 'GET' | 'POST' | 'DELETE',
  caminho: string,
  corpo?: unknown,
): Promise<any> {
  const res = await fetch(`${conta.baseUrl}${caminho}`, {
    method: metodo,
    headers: {
      'Content-Type': 'application/json',
      apikey: conta.apiKey,
      'User-Agent': 'LexCRM/1.0',
    },
    body: corpo === undefined ? undefined : JSON.stringify(corpo),
    signal: AbortSignal.timeout(TEMPO_LIMITE_MS),
  });
  const texto = await res.text();
  let json: any = null;
  try {
    json = texto ? JSON.parse(texto) : null;
  } catch {
    json = null;
  }
  if (!res.ok) {
    const descricao = json?.errors?.[0]?.description || `HTTP ${res.status}`;
    throw new ErroDoAsaas(res.status, String(descricao));
  }
  return json;
}

/** Um pagamento de assinatura, como o Asaas devolve (só o que usamos). */
export interface PagamentoAsaas {
  id: string;
  status: string;
  dueDate: string; // AAAA-MM-DD
  value?: number;
  invoiceUrl?: string | null;
  paymentDate?: string | null;
  clientPaymentDate?: string | null;
}

const PAGOS = new Set(['RECEIVED', 'CONFIRMED', 'RECEIVED_IN_CASH']);
const EM_ABERTO = new Set(['PENDING', 'OVERDUE']);
const DATA = /^\d{4}-\d{2}-\d{2}$/;

function valido(p: unknown): p is PagamentoAsaas {
  const x = p as PagamentoAsaas;
  return !!x && typeof x.id === 'string' && !!x.id && typeof x.status === 'string' && typeof x.dueDate === 'string' && DATA.test(x.dueDate);
}

/** O pagamento já pago de vencimento mais recente (empate: o de maior id). */
export function ultimoPago(pagamentos: readonly unknown[]): PagamentoAsaas | null {
  const pagos = pagamentos.filter(valido).filter((p) => PAGOS.has(p.status));
  if (!pagos.length) return null;
  return pagos.reduce((a, b) => (b.dueDate > a.dueDate || (b.dueDate === a.dueDate && b.id > a.id) ? b : a));
}

/** O pagamento em aberto (pendente ou vencido) de vencimento mais antigo. */
export function primeiroEmAberto(pagamentos: readonly unknown[]): PagamentoAsaas | null {
  const abertos = pagamentos.filter(valido).filter((p) => EM_ABERTO.has(p.status));
  if (!abertos.length) return null;
  return abertos.reduce((a, b) => (b.dueDate < a.dueDate || (b.dueDate === a.dueDate && b.id < a.id) ? b : a));
}

/** Vencimento (AAAA-MM-DD) do pagamento com este id na lista, ou null. */
export function vencimentoDe(pagamentos: readonly unknown[], id: string | null | undefined): string | null {
  if (!id) return null;
  return pagamentos.filter(valido).find((p) => p.id === id)?.dueDate ?? null;
}

/** AAAA-MM-DD ao meio-dia UTC. */
export function meioDia(data: string): Date {
  return new Date(`${data}T12:00:00Z`);
}

/** Um mês depois do vencimento (dia 31 vira o último dia do mês seguinte), ao meio-dia UTC. */
export function umMesDepois(vencimento: string): Date {
  const [a, m, d] = vencimento.split('-').map(Number);
  const ultimoDia = new Date(Date.UTC(a, m + 1, 0)).getUTCDate();
  return new Date(Date.UTC(a, m, Math.min(d, ultimoDia), 12));
}

/** Data do pagamento (a do cliente, se houver), ao meio-dia UTC; sem data, agora. */
export function dataDoPagamento(p: PagamentoAsaas, agora: Date): Date {
  const d = p.clientPaymentDate || p.paymentDate;
  return typeof d === 'string' && DATA.test(d) ? meioDia(d) : agora;
}

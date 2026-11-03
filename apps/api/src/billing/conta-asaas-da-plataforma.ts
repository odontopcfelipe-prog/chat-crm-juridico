/**
 * Mensalidade dos laboratórios — a mesma conta Asaas da assinatura das clínicas.
 *
 * O laboratório paga a mensalidade na conta Asaas da própria plataforma: a mesma em
 * que a clínica assina o plano (BillingService: AsaasClient.getConfig() sem conta,
 * a configuração global). A mensalidade da clínica continua no caminho de sempre,
 * sem mudança. Sem chave, a assinatura do laboratório não abre e nada é criado.
 *
 * O que vale é sempre o que o Asaas responde: o aviso (webhook) só pede uma nova
 * leitura dos pagamentos da assinatura, nunca é tomado como pagamento.
 */
const TEMPO_LIMITE_MS = 15_000;

export interface ContaAsaasDaPlataforma {
  apiKey: string;
  baseUrl: string;
  sandbox: boolean;
}

/** De onde vem a conta: o AsaasClient da assinatura das clínicas. */
export interface FonteDaContaDaPlataforma {
  getConfig(): Promise<{ apiKey?: string | null; baseUrl?: string | null; sandbox?: boolean | null }>;
}

/**
 * A conta da assinatura das clínicas, ou null sem chave (ou se a leitura falhar).
 * Lida SEM conta: com a do laboratório, o AsaasClient daria a conta Asaas dele.
 */
export async function lerContaDaPlataforma(asaas: FonteDaContaDaPlataforma): Promise<ContaAsaasDaPlataforma | null> {
  try {
    const c = await asaas.getConfig();
    const apiKey = typeof c?.apiKey === 'string' ? c.apiKey.trim() : '';
    const baseUrl = typeof c?.baseUrl === 'string' ? c.baseUrl : '';
    if (!apiKey || !baseUrl) return null;
    return { apiKey, baseUrl, sandbox: !!c.sandbox };
  } catch {
    return null;
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
      // O Asaas só lê a chave neste cabeçalho (o mesmo do AsaasClient).
      access_token: conta.apiKey,
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

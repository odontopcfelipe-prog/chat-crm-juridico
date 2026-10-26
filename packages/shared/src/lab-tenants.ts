/**
 * F1 do laboratório — quais contas são LABORATÓRIO, para os agendadores e
 * varreduras de clínica poderem deixá-las de fora (fases seguintes).
 *
 * Hoje não existe laboratório: getLabTenantIds devolve um conjunto vazio e
 * withoutLabTenants / excludeLabWhere devolvem a MESMA referência que receberam
 * — a clínica não vê diferença nenhuma, nem na consulta ao banco.
 *
 * Funções puras com o Prisma por parâmetro (sem provider Nest — ver CLAUDE.md:
 * ciclo de DI). Uma consulta por minuto por processo (cache de 60 s).
 */
import { BT_LABORATORIO } from './business-type';

const CACHE_MS = 60_000;
const SEM_LAB: ReadonlySet<string> = new Set<string>();

type PrismaLab = {
  tenantBusinessProfile: {
    findMany(args: {
      where: { business_type: string };
      select: { tenant_id: true };
    }): Promise<Array<{ tenant_id: string }>>;
  };
};

let cache: { ids: ReadonlySet<string>; ate: number } | null = null;
let emVoo: Promise<ReadonlySet<string>> | null = null;

/**
 * Ids das contas de laboratório (cache de 60 s; chamadas simultâneas dividem a
 * mesma consulta). Se a consulta falhar, fica com o último conjunto conhecido
 * (vazio se nunca carregou) por mais 60 s e avisa — nunca derruba quem chamou.
 */
export async function getLabTenantIds(
  prisma: PrismaLab,
  avisar: (msg: string) => void = (msg) => console.warn(msg),
): Promise<ReadonlySet<string>> {
  if (cache && cache.ate > Date.now()) return cache.ids;
  if (emVoo) return emVoo;
  const consulta = carregar(prisma, avisar);
  emVoo = consulta;
  // Limpa DEPOIS de guardar (o .finally é sempre assíncrono): uma falha síncrona
  // (prisma ausente, mock que lança) não pode deixar a promessa presa em emVoo.
  void consulta.finally(() => {
    if (emVoo === consulta) emVoo = null;
  });
  return consulta;
}

/** Nunca rejeita: em falha, devolve o último conjunto conhecido. */
async function carregar(prisma: PrismaLab, avisar: (msg: string) => void): Promise<ReadonlySet<string>> {
  try {
    const linhas = await prisma.tenantBusinessProfile.findMany({
      where: { business_type: BT_LABORATORIO },
      select: { tenant_id: true },
    });
    const ids = linhas.length ? new Set(linhas.map((l) => l.tenant_id)) : SEM_LAB;
    cache = { ids, ate: Date.now() + CACHE_MS };
    return ids;
  } catch (e) {
    const ids = cache?.ids ?? SEM_LAB;
    cache = { ids, ate: Date.now() + CACHE_MS };
    try {
      avisar(`[lab-tenants] falha ao ler TenantBusinessProfile — usando ${ids.size} lab(s) do cache: ${(e as Error)?.message ?? e}`);
    } catch {
      // o aviso nunca derruba quem chamou
    }
    return ids;
  }
}

/**
 * A conta é laboratório? Usa o mesmo cache de 60 s. Sem id (null, '', não-texto)
 * responde false sem consultar nada. Nunca rejeita.
 */
export async function isLabTenant(
  prisma: PrismaLab,
  tenantId: unknown,
  avisar?: (msg: string) => void,
): Promise<boolean> {
  if (typeof tenantId !== 'string' || tenantId === '') return false;
  const ids = await getLabTenantIds(prisma, avisar);
  return ids.has(tenantId);
}

/**
 * Algum destes ids é de laboratório? Sem laboratório cadastrado, false sem olhar
 * os ids. null/undefined/'' contam como clínica.
 */
export function algumLab(labIds: ReadonlySet<string>, ids: readonly unknown[]): boolean {
  if (!labIds.size) return false;
  return ids.some((t) => typeof t === 'string' && labIds.has(t));
}

/**
 * Síncrono: a conta está no último conjunto carregado por getLabTenantIds?
 * Sem carga ainda (ou id vazio) = false, ou seja, clínica.
 */
export function isLabTenantCached(tenantId: unknown): boolean {
  return typeof tenantId === 'string' && tenantId !== '' && !!cache?.ids.has(tenantId);
}

/** Tira das linhas as de laboratório. Sem laboratório, devolve o MESMO array. */
export function withoutLabTenants<T>(
  linhas: T[],
  labIds: ReadonlySet<string>,
  tenantDe: (linha: T) => unknown = (linha) => (linha as { tenant_id?: unknown } | null)?.tenant_id,
): T[] {
  if (!labIds.size) return linhas;
  return linhas.filter((linha) => {
    const t = tenantDe(linha);
    return !(typeof t === 'string' && labIds.has(t));
  });
}

/**
 * Como cada model filtra o laboratório. A forma depende do schema:
 *  - tenant_opcional (tenant_id String?): OR [null, notIn] — `notIn` sozinho
 *    jogaria fora as linhas legadas com tenant_id NULL (Prisma `not` exclui NULL);
 *  - tenant_obrigatorio (tenant_id String): notIn — OR com null num campo
 *    obrigatório dá erro de validação do Prisma;
 *  - via_paciente (sem tenant_id; a conta vem do paciente): patient.tenant_id notIn.
 * O spec lab-tenants confere esta tabela contra o schema (Prisma.dmmf).
 */
export const EXCLUI_LAB_FORMA = {
  lead: 'tenant_opcional',
  conversation: 'tenant_opcional',
  calendarEvent: 'tenant_opcional',
  paymentGatewayCharge: 'tenant_opcional',
  task: 'tenant_opcional',
  patient: 'tenant_obrigatorio',
  quote: 'via_paciente',
  treatmentPlan: 'via_paciente',
} as const;
export type ModeloExcluiLab = keyof typeof EXCLUI_LAB_FORMA;

/**
 * Acrescenta ao where o filtro "fora os laboratórios". Sem laboratório, devolve
 * o MESMO where (mesma referência, inclusive undefined). Nunca altera o where
 * recebido.
 */
export function excludeLabWhere<W>(modelo: ModeloExcluiLab, where: W, labIds: ReadonlySet<string>): W {
  if (!labIds.size) return where;
  const ids = [...labIds];
  const forma = EXCLUI_LAB_FORMA[modelo];
  const filtro =
    forma === 'tenant_opcional'
      ? { OR: [{ tenant_id: null }, { tenant_id: { notIn: ids } }] }
      : forma === 'tenant_obrigatorio'
        ? { tenant_id: { notIn: ids } }
        : { patient: { tenant_id: { notIn: ids } } };
  return { AND: [where ?? {}, filtro] } as unknown as W;
}

/** Só para testes: esquece o cache e a consulta em voo. */
export function __limparCacheLabTenants(): void {
  cache = null;
  emVoo = null;
}

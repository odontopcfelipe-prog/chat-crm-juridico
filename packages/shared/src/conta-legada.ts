/**
 * Configuração POR CONTA guardada na GlobalSetting (`<CHAVE>_<tenantId>`), com
 * reserva na chave global antiga (`<CHAVE>`, sem conta) só para as contas que já
 * existiam quando a configuração passou a ser por conta.
 *
 * Por que existe: várias telas de clínica gravavam uma chave ÚNICA, que valia para
 * todas as contas (uma clínica desligava ou reescrevia a configuração da outra).
 * Agora cada conta grava a sua. Para nenhuma clínica que já rodava mudar de
 * comportamento no dia da entrega, a conta que já existia continua herdando o
 * valor global antigo até editar o dela. Conta criada depois (clínica ou
 * laboratório novo) nunca herda configuração de outra: sem a chave própria, vale
 * o padrão do código.
 *
 * Conta de LABORATÓRIO nunca é legada (F2 parte 3a): nunca herda a configuração
 * global antiga das clínicas, mesmo criada antes do corte ou convertida depois.
 *
 * Funções puras com o Prisma por parâmetro (sem provider Nest — ver CLAUDE.md:
 * ciclo de DI).
 */
import { isLabTenant } from './lab-tenants';

/**
 * Corte das contas legadas: criadas ANTES deste instante continuam herdando o
 * valor global antigo até a clínica editar o dela; criadas a partir dele nunca
 * herdam (usam a própria chave ou o padrão).
 */
export const CONTAS_LEGADAS_CRIADAS_ATE = '2026-10-27T00:00:00.000Z';

const CORTE_MS = Date.parse(CONTAS_LEGADAS_CRIADAS_ATE);

type PrismaTenantCriacao = {
  tenant: {
    findUnique(args: {
      where: { id: string };
      select: { created_at: true };
    }): Promise<{ created_at?: Date | string | null } | null>;
  };
};

/**
 * Para saber se a conta é laboratório (getLabTenantIds). Opcional no tipo para
 * quem só monta o necessário (testes); sem ele, a lista de laboratórios não é
 * lida e a conta é tratada como clínica, com aviso.
 */
type PrismaTipoDaConta = Partial<Parameters<typeof isLabTenant>[0]>;

type PrismaGlobalSettingLeitura = {
  globalSetting: {
    findUnique(args: { where: { key: string } }): Promise<{ value?: string | null } | null>;
  };
};

/** created_at não muda: o resultado de cada conta fica em memória pelo processo. */
const cache = new Map<string, boolean>();

/**
 * Pela data de criação: true = criada antes do corte (legada), false = nova,
 * null = data ausente ou inválida (não dá para saber).
 */
export function criadaAntesDoCorte(createdAt: unknown): boolean | null {
  if (createdAt === null || createdAt === undefined || createdAt === '') return null;
  const ms =
    createdAt instanceof Date
      ? createdAt.getTime()
      : typeof createdAt === 'string' || typeof createdAt === 'number'
        ? new Date(createdAt).getTime()
        : NaN;
  if (!Number.isFinite(ms)) return null;
  return ms < CORTE_MS;
}

function avisarSemDerrubar(avisar: (msg: string) => void, msg: string): void {
  try {
    avisar(msg);
  } catch {
    // o aviso nunca derruba quem chamou
  }
}

/**
 * A conta já existia antes do corte (herda a configuração global antiga)?
 *
 * Nunca rejeita. Quando não dá para saber (falha na consulta, conta não
 * encontrada, data inválida), responde true — o comportamento de hoje — e avisa;
 * só a resposta certa (conta encontrada com data válida) fica no cache.
 * Sem id (null, '', não-texto): true, sem consultar nada (quem não tem conta lê
 * a global, como hoje).
 *
 * Laboratório: false, sempre. A pergunta vem antes do cache da data (que dura o
 * processo inteiro), porque a conta pode virar laboratório depois. Se a lista de
 * laboratórios não puder ser lida, vale o último conjunto conhecido
 * (getLabTenantIds): o laboratório já conhecido continua não-legado e, sem
 * nenhum conhecido, a conta segue como clínica, como hoje — responder "não
 * legada" na dúvida tiraria de toda clínica antiga a configuração que ela herda
 * enquanto o banco oscila.
 */
export async function contaLegada(
  prisma: PrismaTenantCriacao & PrismaTipoDaConta,
  tenantId: unknown,
  avisar: (msg: string) => void = (msg) => console.warn(msg),
): Promise<boolean> {
  if (typeof tenantId !== 'string' || tenantId === '') return true;
  if (await isLabTenant(prisma as Parameters<typeof isLabTenant>[0], tenantId, avisar)) return false;
  const conhecido = cache.get(tenantId);
  if (conhecido !== undefined) return conhecido;
  try {
    const conta = await prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { created_at: true },
    });
    const legada = criadaAntesDoCorte(conta?.created_at);
    if (legada === null) {
      avisarSemDerrubar(
        avisar,
        `[conta-legada] conta ${tenantId} ${conta ? 'sem data de criação válida' : 'não encontrada'} — tratada como legada (herda a configuração global antiga)`,
      );
      return true;
    }
    cache.set(tenantId, legada);
    return legada;
  } catch (e) {
    avisarSemDerrubar(
      avisar,
      `[conta-legada] falha ao ler a criação da conta ${tenantId} — tratada como legada: ${(e as Error)?.message ?? e}`,
    );
    return true;
  }
}

/** Nome da chave da conta na GlobalSetting: `<CHAVE>_<tenantId>`. */
export function chaveConfigDaConta(chaveGlobal: string, tenantId: string): string {
  return `${chaveGlobal}_${tenantId}`;
}

/**
 * Valor efetivo de uma configuração por conta (texto cru da GlobalSetting):
 *  1. a chave da conta (`<chaveGlobal>_<tenantId>`), se existir;
 *  2. senão, a chave global antiga — SÓ se a conta for legada (contaLegada;
 *     laboratório nunca é);
 *  3. senão, null (quem chama aplica o padrão do código).
 * Sem conta (tenantId vazio): a chave global antiga, como hoje.
 * Erro do banco propaga (como a leitura direta da global que esta função substitui).
 */
export async function lerConfigDaConta(
  prisma: PrismaGlobalSettingLeitura & PrismaTenantCriacao & PrismaTipoDaConta,
  chaveGlobal: string,
  tenantId: string | null | undefined,
  avisar?: (msg: string) => void,
): Promise<string | null> {
  const ler = async (key: string): Promise<string | null> => {
    const linha = await prisma.globalSetting.findUnique({ where: { key } });
    return typeof linha?.value === 'string' ? linha.value : null;
  };
  if (typeof tenantId !== 'string' || tenantId === '') return ler(chaveGlobal);
  const propria = await ler(chaveConfigDaConta(chaveGlobal, tenantId));
  if (propria !== null) return propria;
  if (!(await contaLegada(prisma, tenantId, avisar))) return null;
  return ler(chaveGlobal);
}

/** Só para testes: esquece o que já foi lido das contas. */
export function __limparCacheContaLegada(): void {
  cache.clear();
}

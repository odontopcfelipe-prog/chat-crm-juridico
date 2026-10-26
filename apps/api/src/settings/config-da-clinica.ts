/**
 * Configurações de clínica POR CONTA guardadas na GlobalSetting
 * (`<CHAVE>_<tenantId>`), no padrão de @crm/shared (conta-legada).
 *
 * Leitura (lerConfigDaClinica): a chave da conta; sem ela, a global antiga SÓ
 * para conta legada (criada antes do corte) — laboratório nunca herda
 * configuração de clínica; senão null (quem chama aplica o padrão do código).
 *
 * Escrita (chaveDeGravacaoDaClinica): quem tem conta no token grava SEMPRE na
 * chave da conta, inclusive o SUPER_ADMIN logado numa clínica; o SUPER_ADMIN sem
 * conta grava a global antiga; os demais sem conta recebem 403 PERMISSION_DENIED.
 *
 * Funções puras com o Prisma por parâmetro (sem provider Nest — ver CLAUDE.md:
 * ciclo de DI).
 */
import { chaveConfigDaConta, isLabTenant, lerConfigDaConta } from '@crm/shared';
import { negarPermissao } from '../auth/require-any-permission';

type PrismaLeitura = Parameters<typeof lerConfigDaConta>[0] & Parameters<typeof isLabTenant>[0];

type UsuarioDoToken = { roles?: unknown; tenant_id?: unknown } | null | undefined;

/** Mensagem do 403 de quem salva configuração de clínica sem estar ligado a uma. */
export const SEM_CONTA_MSG = 'Configuração da clínica — sua conta de usuário não está ligada a uma clínica.';

/** O usuário do token é administrador do sistema (SUPER_ADMIN)? */
export function ehSuperAdmin(user: UsuarioDoToken): boolean {
  return Array.isArray(user?.roles) && user!.roles.includes('SUPER_ADMIN');
}

/** Conta (clínica) do token, ou null. */
export function contaDoUsuario(user: UsuarioDoToken): string | null {
  const t = user?.tenant_id;
  return typeof t === 'string' && t !== '' ? t : null;
}

/**
 * Chave onde a configuração de clínica de quem salva é gravada:
 * com conta → `<chave>_<conta>`; SUPER_ADMIN sem conta → a global antiga;
 * sem conta e sem SUPER_ADMIN → 403 PERMISSION_DENIED.
 */
export function chaveDeGravacaoDaClinica(chaveGlobal: string, user: UsuarioDoToken): string {
  const conta = contaDoUsuario(user);
  if (conta) return chaveConfigDaConta(chaveGlobal, conta);
  if (ehSuperAdmin(user)) return chaveGlobal;
  throw negarPermissao(SEM_CONTA_MSG);
}

/**
 * Valor efetivo (texto cru) de uma configuração de clínica para a conta. Sem
 * conta: a global antiga. Erro do banco propaga (como lerConfigDaConta).
 */
export async function lerConfigDaClinica(
  prisma: PrismaLeitura,
  chaveGlobal: string,
  tenantId: string | null | undefined,
  avisar?: (msg: string) => void,
): Promise<string | null> {
  if (typeof tenantId === 'string' && tenantId !== '' && (await isLabTenant(prisma, tenantId, avisar))) {
    const linha = await prisma.globalSetting.findUnique({ where: { key: chaveConfigDaConta(chaveGlobal, tenantId) } });
    return typeof linha?.value === 'string' ? linha.value : null;
  }
  return lerConfigDaConta(prisma, chaveGlobal, tenantId, avisar);
}

/**
 * Como lerConfigDaClinica, mas erro do banco vira null (o padrão do código),
 * como a leitura antiga (SettingsService.get) fazia: uma tela que carrega tudo
 * num Promise.all não pode cair por causa disso.
 */
export async function lerConfigDaClinicaSemErro(
  prisma: PrismaLeitura,
  chaveGlobal: string,
  tenantId: string | null | undefined,
  avisar: (msg: string) => void,
): Promise<string | null> {
  try {
    return await lerConfigDaClinica(prisma, chaveGlobal, tenantId, avisar);
  } catch (e) {
    try {
      avisar(`[config-da-clinica] falha ao ler ${chaveGlobal} da conta ${tenantId ?? '(sem conta)'} — usando o padrão: ${(e as Error)?.message ?? e}`);
    } catch {
      // o aviso nunca derruba quem chamou
    }
    return null;
  }
}

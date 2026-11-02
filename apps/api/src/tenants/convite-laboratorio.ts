/**
 * F11 do laboratório — peças do convite e das chaves do cadastro de laboratório
 * pelo /cadastrar. Funções puras (sem provider do Nest): quem chama passa o
 * próprio prisma ou o `tx` da transação.
 *
 * - O código do convite tem 32 caracteres (24 bytes aleatórios em base64url). O
 *   banco guarda só o sha256 (hex) dele; o código sai uma única vez, na resposta
 *   da criação, e nunca vai para log, auditoria ou listagem.
 * - As duas chaves são lidas NA HORA (sem cache): desligar vale na próxima
 *   requisição. Só o texto exato 'true' liga; falha de leitura = desligada.
 * - O convite é gasto dentro da MESMA transação que cria a conta, com um
 *   updateMany condicional: se outro cadastro gastou antes, nada é gravado.
 */
import { ForbiddenException } from '@nestjs/common';
import { createHash, randomBytes } from 'crypto';
import { publicWebUrl } from '../common/mail/mail.service';
import { CHAVE_CRIACAO_LABORATORIO } from './criacao-laboratorio.service';
import { LAB_CADASTRO_MSG } from './cadastro-laboratorio.textos';

/** Chave da plataforma que abre o cadastro de laboratório ao público (sem convite). */
export const CHAVE_CADASTRO_LABORATORIO = 'LAB_SIGNUP_ENABLED';

export const CODIGO_CADASTRO_LAB_FECHADO = 'CADASTRO_LABORATORIO_FECHADO';
export const CODIGO_CONVITE_INVALIDO = 'CONVITE_INVALIDO';
export const CODIGO_CADASTRO_LAB_TETO = 'CADASTRO_LABORATORIO_TETO';

export const VALIDADE_PADRAO_DIAS = 14;
export const VALIDADE_MAX_DIAS = 60;
/** Contas de laboratório em 24 h acima das quais o cadastro aberto (sem convite) responde 429. */
export const TETO_CADASTRO_LAB_POR_DIA = 20;

export type SituacaoConvite = 'VALIDO' | 'USADO' | 'VENCIDO' | 'REVOGADO';

/** sha256 (hex) do código, como fica no banco. */
export function hashDoCodigo(codigo: string): string {
  return createHash('sha256').update(codigo, 'utf8').digest('hex');
}

/** Código novo (32 caracteres [A-Za-z0-9_-], 192 bits) e o hash que vai para o banco. */
export function gerarCodigoConvite(): { codigo: string; token_hash: string } {
  const codigo = randomBytes(24).toString('base64url');
  return { codigo, token_hash: hashDoCodigo(codigo) };
}

/** O código tem o formato de um código gerado aqui? (Fora dele, nem vai ao banco.) */
export function codigoNoFormato(v: unknown): v is string {
  return typeof v === 'string' && /^[A-Za-z0-9_-]{32}$/.test(v);
}

/** Situação do convite: USADO > REVOGADO > VENCIDO (expires_at <= agora) > VALIDO. */
export function situacaoDoConvite(
  c: { used_at?: Date | null; revoked_at?: Date | null; expires_at: Date },
  agora: Date,
): SituacaoConvite {
  if (c.used_at) return 'USADO';
  if (c.revoked_at) return 'REVOGADO';
  if (new Date(c.expires_at).getTime() <= agora.getTime()) return 'VENCIDO';
  return 'VALIDO';
}

type LinhaDaChave = { key: string; value?: string | null; updated_at?: Date | null };
type PrismaDasChaves = { globalSetting: { findMany(args: any): Promise<LinhaDaChave[]> } };

export interface ChavesCadastroLaboratorio {
  /** CRIACAO_LABORATORIO_LIBERADA === 'true' (chave mestra da F3). */
  criacaoLiberada: boolean;
  /** LAB_SIGNUP_ENABLED === 'true' (cadastro aberto ao público). */
  cadastroAberto: boolean;
  /** Última mudança da LAB_SIGNUP_ENABLED (sem a linha: null). */
  atualizadoEm: Date | null;
}

/** Lê as duas chaves num findMany só. Lança se o banco falhar (quem chama decide). */
export async function lerChavesOuFalhar(prisma: PrismaDasChaves): Promise<ChavesCadastroLaboratorio> {
  const linhas = await prisma.globalSetting.findMany({
    where: { key: { in: [CHAVE_CRIACAO_LABORATORIO, CHAVE_CADASTRO_LABORATORIO] } },
  });
  const linha = (k: string) => (linhas || []).find((l) => l?.key === k);
  const aberto = linha(CHAVE_CADASTRO_LABORATORIO);
  return {
    criacaoLiberada: linha(CHAVE_CRIACAO_LABORATORIO)?.value === 'true',
    cadastroAberto: aberto?.value === 'true',
    atualizadoEm: aberto?.updated_at ?? null,
  };
}

/** As duas chaves, na hora e sem cache. Falha de leitura = as duas desligadas. */
export async function lerChavesCadastroLaboratorio(prisma: PrismaDasChaves): Promise<ChavesCadastroLaboratorio> {
  try {
    return await lerChavesOuFalhar(prisma);
  } catch {
    return { criacaoLiberada: false, cadastroAberto: false, atualizadoEm: null };
  }
}

export interface ConviteValido {
  id: string;
  email: string | null;
  lab_name: string | null;
  created_by_user_id: string | null;
}

/**
 * O convite deste código, se estiver valendo agora (não usado, não revogado, não
 * vencido). Código fora do formato devolve null sem consultar o banco.
 */
export async function acharConviteValido(
  prisma: { labSignupInvite: { findUnique(args: any): Promise<any> } },
  codigo: unknown,
  agora: Date,
): Promise<ConviteValido | null> {
  if (!codigoNoFormato(codigo)) return null;
  const c = await prisma.labSignupInvite.findUnique({
    where: { token_hash: hashDoCodigo(codigo) },
    select: {
      id: true,
      email: true,
      lab_name: true,
      created_by_user_id: true,
      expires_at: true,
      used_at: true,
      revoked_at: true,
    },
  });
  if (!c || situacaoDoConvite(c, agora) !== 'VALIDO') return null;
  return { id: c.id, email: c.email ?? null, lab_name: c.lab_name ?? null, created_by_user_id: c.created_by_user_id ?? null };
}

/**
 * Gasta o convite dentro da transação que cria a conta. Só muda a linha se ela
 * ainda estiver valendo; senão (outro cadastro gastou antes, revogado ou vencido)
 * lança 403 CONVITE_INVALIDO e a transação inteira é desfeita.
 */
export async function consumirConviteNaTransacao(
  tx: { labSignupInvite: { updateMany(args: any): Promise<{ count: number }> } },
  p: { conviteId: string; tenantId: string; agora: Date },
): Promise<void> {
  const r = await tx.labSignupInvite.updateMany({
    where: { id: p.conviteId, used_at: null, revoked_at: null, expires_at: { gt: p.agora } },
    data: { used_at: p.agora, tenant_id: p.tenantId },
  });
  if (r?.count !== 1) {
    throw new ForbiddenException({ statusCode: 403, message: LAB_CADASTRO_MSG.conviteInvalido, code: CODIGO_CONVITE_INVALIDO });
  }
}

/** Link que o SUPER_ADMIN manda ao laboratório. */
export function linkDoConvite(codigo: string): string {
  return `${publicWebUrl()}/cadastrar?tipo=laboratorio&convite=${codigo}`;
}

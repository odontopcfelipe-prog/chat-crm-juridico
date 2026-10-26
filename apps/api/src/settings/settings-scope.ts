/**
 * GET/PUT /settings (caminho genérico da GlobalSetting): o que cada papel alcança.
 *
 * A GlobalSetting não tem conta: a mesma tabela guarda a configuração da
 * plataforma e as chaves por conta (`<CHAVE>_<tenantId>`). Pelo caminho
 * genérico, o ADMIN de clínica só alcança as chaves que as telas de clínica
 * gravam hoje (Base de Conhecimento e Nota Fiscal), e sempre na chave DA CONTA
 * dele. O resto é da plataforma (SUPER_ADMIN) ou tem tela e endpoint próprios.
 *
 * Função pura (sem provider Nest): o controller passa o próprio prisma.
 */
import { BadRequestException } from '@nestjs/common';
import { chaveConfigDaConta, lerConfigDaConta } from '@crm/shared';

/** Chaves que telas de clínica gravam por PUT /settings — sempre por conta. */
export const CLINIC_SCOPED_SETTING_KEYS: ReadonlySet<string> = new Set([
  'MEMORY_BATCH_ENABLED',
  'nfse_provider',
  'nfse_api_key',
  'nfse_cnpj',
  'nfse_inscricao_municipal',
  'nfse_cnae_code',
  'nfse_default_iss_rate',
  'nfse_auto_emit',
  'nfse_servico_descricao',
]);

/** A única chave que tela de clínica lê por GET /settings (Base de Conhecimento). */
export const MEMORY_BATCH_KEY = 'MEMORY_BATCH_ENABLED';

/** Chaves só 'true'/'false'. */
const CHAVES_BOOLEANAS: ReadonlySet<string> = new Set(['MEMORY_BATCH_ENABLED', 'nfse_auto_emit']);

/** Tamanho máximo dos textos (a tela da NFS-e manda '' para campo em branco: vazio vale). */
const TAMANHO_MAXIMO = 2000;

export function isClinicScopedSettingKey(key: string): boolean {
  return CLINIC_SCOPED_SETTING_KEYS.has(key);
}

/** Chave gravada no banco para uma chave de clínica: a da conta. */
export function clinicSettingStorageKey(key: string, tenantId: string): string {
  return chaveConfigDaConta(key, tenantId);
}

/**
 * Valida o valor de uma chave de clínica. Aceita string vazia (a tela da NFS-e
 * manda '' nos campos que ficaram em branco); recusa não-texto, booleano fora de
 * 'true'/'false' e texto acima do limite.
 */
export function validarValorChaveClinica(key: string, value: unknown): string {
  if (typeof value !== 'string') {
    throw new BadRequestException(`Valor de ${key} deve ser texto`);
  }
  if (CHAVES_BOOLEANAS.has(key) && value !== 'true' && value !== 'false') {
    throw new BadRequestException(`Valor de ${key} deve ser 'true' ou 'false'`);
  }
  if (value.length > TAMANHO_MAXIMO) {
    throw new BadRequestException(`Valor de ${key} ultrapassa ${TAMANHO_MAXIMO} caracteres`);
  }
  return value;
}

type PrismaLeitura = Parameters<typeof lerConfigDaConta>[0];

/**
 * Valor efetivo da extração diária de memórias para a conta: a chave da conta;
 * sem ela, a global antiga se a conta for legada; senão 'true' (padrão).
 */
export async function memoryBatchEfetivo(
  prisma: PrismaLeitura,
  tenantId: string,
  avisar?: (msg: string) => void,
): Promise<string> {
  return (await lerConfigDaConta(prisma, MEMORY_BATCH_KEY, tenantId, avisar)) ?? 'true';
}

type LinhaSetting = { key: string; value: string; updated_at?: Date | string | null };

/**
 * Lista do GET /settings para o SUPER_ADMIN com conta: a mesma lista de hoje,
 * com a linha MEMORY_BATCH_ENABLED trocada pelo valor efetivo da conta dele
 * (a tela procura esse nome; sem a troca ela mostraria o valor global). Mantém
 * a ordem por chave.
 */
export function trocarLinhaMemoryBatch<T extends LinhaSetting>(lista: T[], efetivo: string): T[] {
  const antiga = lista.find((s) => s.key === MEMORY_BATCH_KEY);
  const linha = { ...(antiga ?? {}), key: MEMORY_BATCH_KEY, value: efetivo } as T;
  const resto = lista.filter((s) => s.key !== MEMORY_BATCH_KEY);
  const pos = resto.findIndex((s) => s.key > MEMORY_BATCH_KEY);
  if (pos < 0) return [...resto, linha];
  return [...resto.slice(0, pos), linha, ...resto.slice(pos)];
}

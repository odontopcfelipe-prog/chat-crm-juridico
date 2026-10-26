/**
 * F2 parte 2c do laboratório — AÇÃO de usuário que só existe para clínica (seeds de
 * clínica, portal do paciente, envio do orçamento pelo portal, contrato odontológico,
 * contrato jurídico legado, TCLE, retorno/manutenção manual, follow-up...) é RECUSADA
 * na conta de laboratório com um erro claro. O efeito AUTOMÁTICO não usa isto: ele
 * só não acontece, com log `[LAB-GATE] <nome>`.
 *
 * Função pura (sem provider Nest — ver CLAUDE.md: ciclo de DI). Quem pergunta se a
 * conta é laboratório usa `isLabTenant` / `algumLab` de `@crm/shared`, com a conta
 * do REGISTRO (paciente, lead, evento, plano, conversa), nunca a do usuário logado.
 */
import { ForbiddenException } from '@nestjs/common';

/** Código da recusa (o front distingue de falta de permissão, PERMISSION_DENIED). */
export const CODIGO_VERTICAL_NEGADA = 'VERTICAL_DENIED';

/** Erro 403 da função de clínica pedida numa conta de laboratório. */
export function negarLaboratorio(oque: string): ForbiddenException {
  return new ForbiddenException({
    message: `${oque}: função de clínica, não disponível para laboratório.`,
    code: CODIGO_VERTICAL_NEGADA,
  });
}

/**
 * O erro é a recusa do laboratório? Para quem chama em segundo plano (ex.: o TCLE
 * disparado pelo aceite) registrar `[LAB-GATE]` em vez de um aviso de falha.
 */
export function eRecusaDeLaboratorio(erro: unknown): boolean {
  const resposta = (erro as { getResponse?: () => unknown } | null)?.getResponse?.();
  return !!resposta && typeof resposta === 'object' && (resposta as { code?: unknown }).code === CODIGO_VERTICAL_NEGADA;
}

/**
 * F7 do laboratório — o pedido veio de uma conta de laboratório? E a recusa da
 * Central de Disparos no laboratório.
 *
 * pedidoDeLaboratorio lê o claim `bt` do token (só o token de laboratório leva) e,
 * na falta dele, a lista de laboratórios em cache que o LabTenantGuard já carregou
 * neste pedido: a clínica não faz leitura nova. Quem chama passa o resultado como
 * último parâmetro (`lab = false`) dos métodos do serviço que têm ramo de
 * laboratório.
 *
 * Funções puras, sem provider Nest (sem risco de ciclo de DI).
 */
import { ForbiddenException } from '@nestjs/common';
import { isLab, isLabTenantCached, LAB_RECUSA_DISPAROS, type MotivoRecusaLab } from '@crm/shared';
import { CODIGO_VERTICAL_NEGADA } from '../common/lab-gate.util';

/** true quando o usuário do pedido é de uma conta de laboratório. */
export function pedidoDeLaboratorio(user: { bt?: unknown; tenant_id?: unknown } | null | undefined): boolean {
  return isLab(user?.bt) || isLabTenantCached(user?.tenant_id);
}

/** 403 da Central no laboratório, com o texto do motivo e o código da recusa de vertical. */
export function recusarNoLaboratorio(motivo: MotivoRecusaLab): ForbiddenException {
  return new ForbiddenException({ message: LAB_RECUSA_DISPAROS[motivo], code: CODIGO_VERTICAL_NEGADA });
}

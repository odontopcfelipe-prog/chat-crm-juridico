/**
 * Laboratório: comissão, regra de comissão e meta só apontam para registros da conta
 * do token (protético, serviço, item de trabalho e orçamento). Clínica: só a leitura em
 * cache da lista de laboratórios. Função pura com o Prisma por parâmetro (sem provider
 * Nest: ver CLAUDE.md, ciclo de DI).
 */
import { BadRequestException } from '@nestjs/common';
import { isLabTenant } from '@crm/shared';
import type { PrismaService } from '../prisma/prisma.service';
import { LAB_COMISSAO_IDS } from './lab-jogo-textos';

type Ids = {
  professional_user_id?: string | null;
  procedure_id?: string | null;
  treatment_plan_item_id?: string | null;
  quote_id?: string | null;
};

/** Mensagem do primeiro id que não é da conta do laboratório; null quando estão todos certos. */
export async function idForaDaConta(
  prisma: PrismaService,
  tenantId: string,
  ids: Ids,
  avisar?: (msg: string) => void,
): Promise<string | null> {
  if (!(await isLabTenant(prisma, tenantId, avisar))) return null;
  const doId = { select: { id: true } } as const;
  const conferir: Array<[string | null | undefined, string, (id: string) => Promise<unknown>]> = [
    [ids.professional_user_id, LAB_COMISSAO_IDS.profissional, (id) => prisma.user.findFirst({ where: { id, tenant_id: tenantId }, ...doId })],
    [ids.procedure_id, LAB_COMISSAO_IDS.servico, (id) => prisma.procedure.findFirst({ where: { id, tenant_id: tenantId }, ...doId })],
    [
      ids.treatment_plan_item_id,
      LAB_COMISSAO_IDS.itemDeTrabalho,
      (id) => prisma.treatmentPlanItem.findFirst({ where: { id, treatment_plan: { patient: { tenant_id: tenantId } } }, ...doId }),
    ],
    [ids.quote_id, LAB_COMISSAO_IDS.orcamento, (id) => prisma.quote.findFirst({ where: { id, patient: { tenant_id: tenantId } }, ...doId })],
  ];
  for (const [id, mensagem, buscar] of conferir) {
    if (id && !(await buscar(id))) return mensagem;
  }
  return null;
}

/** Recusa a gravação (400) quando algum id não é da conta do laboratório. */
export async function recusarIdsDeOutraConta(
  prisma: PrismaService,
  tenantId: string,
  ids: Ids,
  avisar?: (msg: string) => void,
): Promise<void> {
  const mensagem = await idForaDaConta(prisma, tenantId, ids, avisar);
  if (mensagem) throw new BadRequestException(mensagem);
}

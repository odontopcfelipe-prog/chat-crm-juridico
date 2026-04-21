import type { ToolHandler, ToolContext } from '../tool-executor';

/**
 * Verifica se o paciente da conversa atual tem aplicacoes esteticas
 * com retorno previsto (expected_revisit_at) proximo ou vencido.
 *
 * Usado pela skill copiloto_estetica e pos_consulta para sugerir
 * proativamente o reagendamento (carro-chefe de receita recorrente).
 *
 * Resolucao do paciente:
 * 1) conversation -> lead_id
 * 2) Patient.findFirst({ where: { lead_id } })
 *
 * Se nao houver Patient ainda (lead nao convertido), retorna mensagem
 * informativa para a IA orientar o cadastro/avaliacao primeiro.
 *
 * Params:
 *  - days_window: janela em dias para considerar "proximo" (default 60)
 *
 * Retorno: lista de aplicacoes com retorno previsto + status
 *  (vencido/proximo/ok), ja convertido em texto amigavel para a IA.
 */
export class CheckEstheticRevisitDueHandler implements ToolHandler {
  name = 'check_esthetic_revisit_due';

  async execute(
    params: { days_window?: number },
    context: ToolContext,
  ): Promise<any> {
    const prisma = context.prisma;
    const daysWindow = Math.min(365, Math.max(1, params.days_window ?? 60));

    const convo = await prisma.conversation.findUnique({
      where: { id: context.conversationId },
      select: { tenant_id: true, lead_id: true },
    });
    if (!convo?.tenant_id) {
      return { success: false, error: 'Conversa sem tenant_id associado' };
    }
    if (!convo.lead_id) {
      return { success: false, error: 'Conversa sem lead_id associado' };
    }

    const patient = await prisma.patient.findFirst({
      where: { tenant_id: convo.tenant_id, lead_id: convo.lead_id },
      select: { id: true, name: true },
    });

    if (!patient) {
      return {
        success: true,
        has_patient: false,
        message:
          'Este lead ainda nao foi cadastrado como paciente. Antes de falar de retornos esteticos, sugira agendar uma avaliacao.',
        applications: [],
      };
    }

    const now = new Date();
    const horizon = new Date();
    horizon.setDate(horizon.getDate() + daysWindow);

    const applications = await prisma.estheticApplication.findMany({
      where: {
        tenant_id: convo.tenant_id,
        patient_id: patient.id,
        expected_revisit_at: { not: null },
      },
      orderBy: { expected_revisit_at: 'asc' },
      take: 20,
      select: {
        id: true,
        application_point: true,
        product_name_snapshot: true,
        brand_snapshot: true,
        applied_at: true,
        expected_revisit_at: true,
        procedure: { select: { name: true, category: true } },
      },
    });

    if (applications.length === 0) {
      return {
        success: true,
        has_patient: true,
        patient_name: patient.name,
        message: `${patient.name} nao tem aplicacoes esteticas com retorno previsto registrado.`,
        applications: [],
      };
    }

    const enriched = applications.map((a: typeof applications[number]) => {
      const revisit = a.expected_revisit_at ? new Date(a.expected_revisit_at) : null;
      let status: 'VENCIDO' | 'PROXIMO' | 'FUTURO' = 'FUTURO';
      let dias_relativos = 0;
      if (revisit) {
        const diffMs = revisit.getTime() - now.getTime();
        dias_relativos = Math.round(diffMs / (1000 * 60 * 60 * 24));
        if (revisit < now) status = 'VENCIDO';
        else if (revisit <= horizon) status = 'PROXIMO';
      }
      return {
        ponto: a.application_point,
        procedimento: a.procedure?.name || 'Aplicacao estetica',
        categoria: a.procedure?.category || undefined,
        produto: a.product_name_snapshot || undefined,
        marca: a.brand_snapshot || undefined,
        aplicado_em: a.applied_at.toISOString().slice(0, 10),
        retorno_previsto: revisit?.toISOString().slice(0, 10),
        dias_relativos,
        status,
      };
    });

    const due = enriched.filter((a: typeof enriched[number]) => a.status === 'VENCIDO' || a.status === 'PROXIMO');

    return {
      success: true,
      has_patient: true,
      patient_name: patient.name,
      total_applications_with_revisit: applications.length,
      applications_due_now: due.length,
      message:
        due.length > 0
          ? `${patient.name} tem ${due.length} aplicacao(oes) com retorno vencido ou proximo (janela ${daysWindow} dias). Sugira reagendar.`
          : `${patient.name} esta em dia com seus retornos esteticos.`,
      applications: enriched,
    };
  }
}

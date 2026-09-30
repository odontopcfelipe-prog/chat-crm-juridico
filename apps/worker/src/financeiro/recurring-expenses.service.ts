import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class RecurringExpensesService {
  private readonly logger = new Logger(RecurringExpensesService.name);

  constructor(private prisma: PrismaService) {}

  /**
   * Todo dia às 1h (Maceió): gera despesas recorrentes do mês.
   * Verifica transações-mãe com is_recurring=true e cria filhas se ainda não existem.
   */
  @Cron('0 1 * * *', { timeZone: 'America/Maceio' })
  async generateRecurringExpenses() {
    try {
      const now = new Date();
      const currentMonth = now.getMonth();
      const currentYear = now.getFullYear();

      // Buscar todas as transações recorrentes ativas
      const recurring = await this.prisma.financialTransaction.findMany({
        where: {
          is_recurring: true,
          status: { not: 'CANCELADO' },
        },
      });

      if (recurring.length === 0) return;

      this.logger.log(`[RECURRING] Verificando ${recurring.length} despesa(s) recorrente(s)`);

      let generated = 0;

      for (const parent of recurring) {
        // Verificar se já passou da data final de recorrência
        if (parent.recurrence_end_date && parent.recurrence_end_date < now) {
          continue;
        }

        // Calcular se deve gerar neste mês
        const shouldGenerate = this.shouldGenerateThisMonth(
          parent.recurrence_pattern,
          parent.created_at,
          currentMonth,
          currentYear,
        );
        if (!shouldGenerate) continue;

        // Janela do mês + vencimento — TUDO em meio-dia/UTC (naive-UTC de Maceió),
        // igual ao parcelamento (payables), pra não escorregar 1 dia em outro fuso.
        const startOfMonth = new Date(Date.UTC(currentYear, currentMonth, 1, 0, 0, 0));
        const endOfMonth = new Date(Date.UTC(currentYear, currentMonth + 1, 0, 23, 59, 59));
        const day = parent.recurrence_day || 1;
        const maxDay = new Date(Date.UTC(currentYear, currentMonth + 1, 0)).getUTCDate();
        const dueDate = new Date(Date.UTC(currentYear, currentMonth, Math.min(day, maxDay), 12, 0, 0));

        // Anti-duplicação atômica (2 workers/deploy sobreposto): advisory lock por
        // mãe+mês + re-checagem DENTRO da transação (check-then-act não bastava).
        const lockKey = `payrec:${parent.id}:${currentYear}-${currentMonth}`;
        try {
          const created = await this.prisma.$transaction(async (tx) => {
            await tx.$executeRawUnsafe('SELECT pg_advisory_xact_lock(hashtext($1))', lockKey);
            const existingChild = await tx.financialTransaction.findFirst({
              where: {
                parent_transaction_id: parent.id,
                date: { gte: startOfMonth, lte: endOfMonth },
              },
            });
            if (existingChild) return false; // Já gerou este mês
            await tx.financialTransaction.create({
              data: {
                tenant_id: parent.tenant_id,
                source: (parent as any).source ?? null, // herda a origem (ex.: PAYABLES)
                company_id: (parent as any).company_id ?? null, // herda a empresa (senão vaza pra clínica)
                is_variable_amount: (parent as any).is_variable_amount ?? null, // herda fixo × variável
                type: parent.type,
                category: parent.category,
                description: parent.description,
                amount: parent.amount,
                date: dueDate,
                due_date: dueDate,
                payment_method: parent.payment_method,
                status: 'PENDENTE',
                visible_to_dentist: (parent as any).visible_to_dentist,
                dentist_id: (parent as any).dentist_id,
                lead_id: parent.lead_id,
                notes: parent.notes,
                parent_transaction_id: parent.id,
                is_recurring: false,
              } as any,
            });
            return true;
          });
          if (created) {
            generated++;
            this.logger.log(
              `[RECURRING] Gerada: "${parent.description}" | R$ ${Number(parent.amount).toFixed(2)} | venc. ${dueDate.toISOString().slice(0, 10)}`,
            );
          }
        } catch (e: any) {
          this.logger.warn(`[RECURRING] Falha ao gerar filha da mãe ${parent.id}: ${e?.message}`);
        }
      }

      if (generated > 0) {
        this.logger.log(`[RECURRING] ${generated} despesa(s) recorrente(s) gerada(s) para ${currentMonth + 1}/${currentYear}`);
      }
    } catch (e: any) {
      this.logger.error(`[RECURRING] Erro: ${e.message}`);
    }
  }

  /**
   * Verifica se deve gerar transação neste mês baseado no padrão de recorrência.
   */
  private shouldGenerateThisMonth(
    pattern: string | null,
    createdAt: Date,
    currentMonth: number,
    currentYear: number,
  ): boolean {
    if (!pattern) return false;

    const createdMonth = createdAt.getMonth();
    const createdYear = createdAt.getFullYear();
    const monthsDiff = (currentYear - createdYear) * 12 + (currentMonth - createdMonth);

    switch (pattern) {
      case 'MENSAL':
        return monthsDiff >= 1;
      case 'TRIMESTRAL':
        return monthsDiff >= 3 && monthsDiff % 3 === 0;
      case 'SEMESTRAL':
        return monthsDiff >= 6 && monthsDiff % 6 === 0;
      case 'ANUAL':
        return monthsDiff >= 12 && monthsDiff % 12 === 0;
      default:
        return false;
    }
  }
}

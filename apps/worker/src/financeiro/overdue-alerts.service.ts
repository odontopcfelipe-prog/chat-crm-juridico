import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Notificação de dívidas e recebíveis vencidos a cada 2 horas (horário comercial).
 * - Admin/Financeiro: vê tudo
 * - Dentista: vê apenas do seus processos
 * Notifica via WebSocket (toast no frontend).
 */
@Injectable()
export class OverdueAlertsService {
  private readonly logger = new Logger(OverdueAlertsService.name);

  constructor(private prisma: PrismaService) {}

  /**
   * A cada 2 horas em horário comercial (8h, 10h, 12h, 14h, 16h, 18h) Seg-Sex
   */
  @Cron('0 8,10,12,14,16,18 * * 1-5', { timeZone: 'America/Maceio' })
  async checkOverdueItems() {
    try {
      const now = new Date();

      // 1. Despesas pendentes vencidas (de TODAS as clínicas — agrupadas por tenant abaixo)
      const overdueDespesas = await this.prisma.financialTransaction.findMany({
        where: {
          type: 'DESPESA',
          status: 'PENDENTE',
          due_date: { lt: now },
        },
        select: { id: true, tenant_id: true, description: true, amount: true, due_date: true, dentist_id: true, visible_to_dentist: true },
      });

      if (overdueDespesas.length === 0) return;

      // Agrupa por tenant — 1 alerta POR clínica, com tenant_id. Antes era 1 alerta
      // global (entity_id:'sistema') somando todas as clínicas, o que vazava o total
      // de uma clínica no Log de outra (IDOR).
      const byTenant = new Map<string, typeof overdueDespesas>();
      for (const d of overdueDespesas) {
        const key = d.tenant_id || '__sem_tenant__';
        if (!byTenant.has(key)) byTenant.set(key, []);
        byTenant.get(key)!.push(d);
      }

      for (const [key, list] of byTenant) {
        const total = list.reduce((s, d) => s + Number(d.amount), 0);
        this.logger.log(
          `[OVERDUE] tenant ${key}: ${list.length} despesa(s) vencida(s) (R$ ${total.toFixed(2)})`,
        );
        await this.prisma.auditLog.create({
          data: {
            action: 'ALERTA_VENCIDOS',
            entity: 'FINANCEIRO',
            entity_id: 'sistema',
            tenant_id: key === '__sem_tenant__' ? null : key,
            meta_json: {
              despesas_vencidas: list.length,
              total_despesas: total,
              checked_at: now.toISOString(),
            },
          },
        });
      }
    } catch (e: any) {
      this.logger.error(`[OVERDUE] Erro ao verificar vencidos: ${e.message}`);
    }
  }
}

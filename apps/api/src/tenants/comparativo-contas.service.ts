import { Injectable, Logger } from '@nestjs/common';
import { isLab } from '@crm/shared';
import { PrismaService } from '../prisma/prisma.service';
import { FinanceiroChargesService } from '../financeiro/financeiro-charges.service';
import { ATTENDED_STATUSES } from '../leads/clinic-transfer-guard';
import { bordasDoMes, idsDoComparativo, mesDoComparativo } from './comparativo-contas';

/** Comparativo das contas marcadas no Admin SaaS (ver comparativo-contas.ts). */
@Injectable()
export class ComparativoContasService {
  private readonly logger = new Logger(ComparativoContasService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly charges: FinanceiroChargesService,
  ) {}

  async comparar(idsQuery: unknown, mesQuery: unknown) {
    const mes = mesDoComparativo(mesQuery);
    const ids = idsDoComparativo(idsQuery);
    if (ids.length === 0) return { mes, contas: [] };

    const achadas = await this.prisma.tenant.findMany({
      where: { id: { in: ids } },
      select: { id: true, name: true, status: true, plan: true, business_profile: { select: { business_type: true } } },
    });
    const porId = new Map(achadas.map((t) => [t.id, t]));
    // Uma conta por vez: 20 contas juntas seriam centenas de consultas ao mesmo tempo
    // e tomariam as conexões do banco das clínicas em uso.
    const contas = [];
    for (const id of ids) {
      const t = porId.get(id);
      if (t) contas.push(await this.daConta(t, mes));
    }
    return { mes, contas };
  }

  private async daConta(
    t: { id: string; name: string; status: string; plan: string; business_profile: { business_type: string } | null },
    mes: string,
  ) {
    const b = bordasDoMes(mes);
    const tenant_id = t.id;
    const noMes = { gte: b.real.inicio, lt: b.real.fim };
    const consultasDoMes = { tenant_id, type: 'CONSULTA', start_at: { gte: b.agenda.inicio, lt: b.agenda.fim } };

    const [usuarios, pacientes, pacientes_novos, leads_novos, marcadas, compareceram, faltaram, financeiro] = await Promise.all([
      this.seguro(t.id, 'usuarios', () => this.prisma.user.count({ where: { tenant_id } })),
      this.seguro(t.id, 'pacientes', () => this.prisma.patient.count({ where: { tenant_id } })),
      this.seguro(t.id, 'pacientes_novos', () => this.prisma.patient.count({ where: { tenant_id, created_at: noMes } })),
      this.seguro(t.id, 'leads_novos', () => this.prisma.lead.count({ where: { tenant_id, created_at: noMes } })),
      this.seguro(t.id, 'consultas', () =>
        this.prisma.calendarEvent.count({ where: { ...consultasDoMes, status: { not: 'CANCELADO' } } }),
      ),
      this.seguro(t.id, 'compareceram', () =>
        this.prisma.calendarEvent.count({ where: { ...consultasDoMes, status: { in: ATTENDED_STATUSES } } }),
      ),
      this.seguro(t.id, 'faltaram', () => this.prisma.calendarEvent.count({ where: { ...consultasDoMes, status: 'NO_SHOW' } })),
      // Mesmo cálculo do Financeiro da conta (recebido no mês, a receber e atrasado de hoje).
      this.seguro(t.id, 'financeiro', async () => {
        const d = await this.charges.getDashboard({
          tenantId: tenant_id,
          startDate: b.real.inicio.toISOString(),
          endDate: b.fimInclusivo.toISOString(),
        });
        return {
          recebido: d.recebido_no_periodo.value,
          a_receber: d.a_receber_total.value,
          atrasado: d.atrasado.value,
          atrasado_qtd: d.atrasado.count,
        };
      }),
    ]);

    return {
      id: t.id,
      nome: t.name,
      tipo: isLab(t.business_profile?.business_type) ? 'LABORATORIO' : 'CLINICA',
      status: t.status,
      plano: t.plan,
      usuarios,
      pacientes,
      pacientes_novos,
      leads_novos,
      consultas: { marcadas, compareceram, faltaram },
      financeiro,
    };
  }

  /** Um número que falha vira null (a coluna aparece com "—"), sem derrubar o resto. */
  private async seguro<T>(tenantId: string, nome: string, fn: () => Promise<T>): Promise<T | null> {
    try {
      return await fn();
    } catch (e: any) {
      this.logger.warn(`[COMPARATIVO] ${tenantId} ${nome}: ${e?.message}`);
      return null;
    }
  }
}

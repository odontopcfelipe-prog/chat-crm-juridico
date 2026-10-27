import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { BT_LABORATORIO, ensureLabDefaults } from '@crm/shared';
import { PrismaService } from '../prisma/prisma.service';

/**
 * F3 do laboratório — todo dia (07:15, Maceió, antes da vigia das 07:30) confere
 * em cada conta de laboratório as chaves desligadas (IA, lembretes, régua...) e
 * grava SÓ a que faltar. Chave que a conta já tem fica como está. Rodar duas
 * vezes (ou em duas réplicas) não muda nada.
 *
 * Sem laboratório: uma leitura e mais nada. PADROES_LABORATORIO_OFF=1 desliga.
 */
@Injectable()
export class PadroesLaboratorioService {
  private readonly logger = new Logger('PadroesLaboratorio');

  constructor(private prisma: PrismaService) {}

  @Cron('15 7 * * *', { timeZone: 'America/Maceio' })
  async garantir(): Promise<{ laboratorios: number; gravadas: number }> {
    if (process.env.PADROES_LABORATORIO_OFF === '1') return { laboratorios: 0, gravadas: 0 };
    let labs: Array<{ tenant_id: string }>;
    try {
      // Leitura direta (sem o cache de 60 s): pega também a conta criada agora há pouco.
      labs = await this.prisma.tenantBusinessProfile.findMany({
        where: { business_type: BT_LABORATORIO },
        select: { tenant_id: true },
      });
    } catch (e: any) {
      this.logger.warn(`[LAB-PADROES] falha ao ler os laboratórios: ${e?.message}`);
      return { laboratorios: 0, gravadas: 0 };
    }
    if (!labs.length) return { laboratorios: 0, gravadas: 0 };

    let gravadas = 0;
    for (const lab of labs) {
      try {
        const r = await ensureLabDefaults(this.prisma, lab.tenant_id);
        const n = r.daConta + r.globais;
        gravadas += n;
        if (n) this.logger.log(`[LAB-PADROES] ${lab.tenant_id}: ${r.daConta} da conta + ${r.globais} globais da conta gravadas`);
      } catch (e: any) {
        this.logger.warn(`[LAB-PADROES] ${lab.tenant_id}: falhou — ${e?.message}`);
      }
    }
    this.logger.log(`[LAB-PADROES] ${labs.length} laboratório(s), ${gravadas} chave(s) que faltavam gravadas`);
    return { laboratorios: labs.length, gravadas };
  }
}

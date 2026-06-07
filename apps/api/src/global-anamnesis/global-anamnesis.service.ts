/**
 * Onda 17.32.112 — Ficha de Anamnese MASTER (singleton).
 *
 * - getOrInit(): retorna o registro singleton; se nao existir, cria
 *   com o template V3 default (mesmo de @crm/shared).
 * - update(schema, userId): salva e PROPAGA pra todos os tenants
 *   ativos (upsert do AnamnesisTemplate v3 deles).
 */
import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { DEFAULT_ANAMNESIS_TEMPLATE } from '@crm/shared';

const SINGLETON_ID = 1;

@Injectable()
export class GlobalAnamnesisService {
  private readonly logger = new Logger(GlobalAnamnesisService.name);
  constructor(private readonly prisma: PrismaService) {}

  async getOrInit() {
    const existing = await this.prisma.globalAnamnesisTemplate.findUnique({
      where: { id: SINGLETON_ID },
    });
    if (existing) return existing;
    // Primeira vez — semeia com o template default do @crm/shared
    return this.prisma.globalAnamnesisTemplate.create({
      data: {
        id: SINGLETON_ID,
        version: 1,
        schema: DEFAULT_ANAMNESIS_TEMPLATE as any,
        notes: 'Template inicial (V3 odontologico).',
      },
    });
  }

  /**
   * Atualiza a master + propaga em TODOS os tenants ativos.
   * Tenant que ja tinha AnamnesisTemplate v3 tem o schema sobrescrito.
   * Tenant que nao tinha recebe um novo. Idempotente.
   */
  async update(schema: any, userId: string | null) {
    // 1) Atualiza singleton master
    const saved = await this.prisma.globalAnamnesisTemplate.upsert({
      where: { id: SINGLETON_ID },
      create: {
        id: SINGLETON_ID,
        version: 1,
        schema,
        updated_by_user_id: userId,
      },
      update: {
        schema,
        updated_by_user_id: userId,
        version: { increment: 1 },
      },
    });

    // 2) Propaga pra TODOS os tenants ativos
    const tenants = await this.prisma.tenant.findMany({
      where: { status: { not: 'DELETED' } },
      select: { id: true, name: true },
    });
    let propagated = 0;
    let failed = 0;
    for (const t of tenants) {
      try {
        await this.prisma.anamnesisTemplate.upsert({
          where:  { tenant_id_version: { tenant_id: t.id, version: 3 } },
          update: {
            schema,
            active: true,
            notes:  `Sincronizado da Anamnese Master v${saved.version}`,
          },
          create: {
            tenant_id: t.id,
            version:   3,
            schema,
            active:    true,
            notes:     `Sincronizado da Anamnese Master v${saved.version}`,
          },
        });
        // Desativa versoes anteriores no tenant
        await this.prisma.anamnesisTemplate.updateMany({
          where: { tenant_id: t.id, version: { lt: 3 } },
          data:  { active: false },
        });
        propagated++;
      } catch (err: any) {
        this.logger.error(`[GLOBAL-ANAMNESE] Falha em ${t.name}: ${err?.message}`);
        failed++;
      }
    }
    this.logger.log(
      `[GLOBAL-ANAMNESE] master v${saved.version} salva. Propagado em ${propagated}/${tenants.length} tenants (${failed} falhas).`,
    );
    return {
      master: saved,
      propagated,
      failed,
      total_tenants: tenants.length,
    };
  }
}

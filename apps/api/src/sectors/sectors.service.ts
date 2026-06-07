/**
 * Onda 17.32.116 — Backfill automatico do User.sector.
 *
 * Quando a API sobe (OnModuleInit), procura users que ainda nao
 * tem setor (sector IS NULL) e popula derivando de roles[] via
 * mapBackendRole(). Idempotente — roda toda vez que o boot rola,
 * mas so atualiza quem ainda nao tem.
 */
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { mapBackendRole, type Sector } from '@crm/shared';

@Injectable()
export class SectorsService implements OnModuleInit {
  private readonly logger = new Logger(SectorsService.name);
  constructor(private readonly prisma: PrismaService) {}

  async onModuleInit() {
    try {
      await this.backfillSectors();
    } catch (err: any) {
      this.logger.error(`[SECTORS-BACKFILL] Falhou (nao bloqueia boot): ${err?.message}`);
    }
  }

  /**
   * Roda mapBackendRole(roles) pra cada User com sector NULL e
   * grava o setor derivado. Idempotente: chamadas subsequentes
   * sao no-op (pulam quem ja tem setor).
   */
  async backfillSectors(): Promise<{ scanned: number; updated: number }> {
    const users = await this.prisma.user.findMany({
      where:  { sector: null },
      select: { id: true, roles: true },
    });
    if (users.length === 0) {
      this.logger.log('[SECTORS-BACKFILL] Nenhum user pra atualizar.');
      return { scanned: 0, updated: 0 };
    }
    let updated = 0;
    for (const u of users) {
      const derived: Sector = mapBackendRole(u.roles);
      await this.prisma.user.update({
        where: { id: u.id },
        data:  { sector: derived },
      });
      updated++;
    }
    this.logger.log(
      `[SECTORS-BACKFILL] ${updated}/${users.length} users atualizados com setor derivado.`,
    );
    return { scanned: users.length, updated };
  }
}

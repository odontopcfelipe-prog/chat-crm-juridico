/**
 * Out/2026 — dentistas da clínica (mesma regra do GET /users/lawyers: role
 * DENTIST, ou ADMIN com especialidade) pro direcionamento por especialidade
 * (pickDentistForProcedure em @crm/shared/dentist-routing).
 */
import type { RoutingDentist } from '@crm/shared';
import type { PrismaService } from '../../prisma/prisma.service';

export async function loadTenantDentists(prisma: PrismaService, tenantId: string): Promise<RoutingDentist[]> {
  return prisma.user.findMany({
    where: {
      tenant_id: tenantId,
      OR: [
        { roles: { has: 'DENTIST' } },
        { roles: { has: 'ADMIN' }, specialties: { isEmpty: false } },
      ],
    },
    select: { id: true, name: true, specialties: true },
    orderBy: { name: 'asc' },
  });
}

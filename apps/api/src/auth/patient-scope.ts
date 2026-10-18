/**
 * Out/2026 — "Só os pacientes dele" (regra do dono pro Dentista).
 *
 * Quem NÃO tem a permissão `view_all_patients` enxerga apenas os pacientes da
 * própria carteira. Paciente é "dele" quando:
 *   - ele é o dentista responsável (primary_dentist_id) ou o ortodontista
 *     (ortho_dentist_id) no cadastro; OU
 *   - tem/teve consulta com ele na agenda (pelo patient_id OU pelo lead do
 *     paciente — a IA às vezes agenda só pelo lead); OU
 *   - tem procedimento do orçamento/plano atribuído a ele (QuoteItem.dentist_id),
 *     executado por ele (TreatmentPlanItem.executed_by_user_id) ou orçamento
 *     criado por ele.
 *
 * Duas camadas:
 *   1. `ownPatientsWhere(userId)` — filtro Prisma pras LISTAS (/patients etc.).
 *   2. `PatientScopeGuard` (APP_GUARD global) — qualquer rota com `:patientId`
 *      (e as rotas `/patients/:id...`) devolve 403 se o paciente não é da carteira.
 *
 * ADMIN/SUPER_ADMIN nunca são restringidos (o backend checa ADMIN antes de
 * restringir por dentista — inclusive legado com role ADMIN e setor dentista).
 */
import {
  CanActivate, ExecutionContext, ForbiddenException, Injectable,
} from '@nestjs/common';
import type { Prisma } from '@crm/shared';
import { PrismaService } from '../prisma/prisma.service.js';
import { PermissionsGuard } from './decorators/requires-permission.decorator.js';

export function ownPatientsWhere(userId: string): Prisma.PatientWhereInput {
  return {
    OR: [
      { primary_dentist_id: userId },
      { ortho_dentist_id: userId },
      { appointments: { some: { assigned_user_id: userId } } },
      { lead: { calendar_events: { some: { assigned_user_id: userId } } } },
      { quotes: { some: { items: { some: { dentist_id: userId } } } } },
      { quotes: { some: { created_by_user_id: userId } } },
      { treatment_plans: { some: { items: { some: { executed_by_user_id: userId } } } } },
    ],
  };
}

export function isAdminRole(roles: unknown): boolean {
  const rs = Array.isArray(roles) ? (roles as string[]) : [];
  return rs.includes('ADMIN') || rs.includes('SUPER_ADMIN');
}

/**
 * userId do dono da carteira quando o usuário é RESTRITO aos próprios pacientes;
 * null quando vê todos. Use pra montar filtros de lista:
 *   const owner = await restrictedPatientOwner(prisma, req.user);
 *   if (owner) where.AND.push(ownPatientsWhere(owner));
 */
export async function restrictedPatientOwner(
  prisma: PrismaService,
  user: { id?: string; roles?: string[] } | undefined,
): Promise<string | null> {
  if (!user?.id || isAdminRole(user.roles)) return null;
  const perms = await PermissionsGuard.permissionsFor(prisma, user.id, user.roles ?? []);
  return perms.has('view_all_patients') ? null : user.id;
}

const OWN_CACHE_TTL_MS = 60_000;
const ownCache = new Map<string, { ok: boolean; at: number }>();

/** O paciente é da carteira do usuário? (cache 60s por user+paciente) */
export async function isOwnPatient(
  prisma: PrismaService,
  tenantId: string | null | undefined,
  userId: string,
  patientId: string,
): Promise<boolean> {
  const key = `${userId}:${patientId}`;
  const hit = ownCache.get(key);
  if (hit && Date.now() - hit.at < OWN_CACHE_TTL_MS) return hit.ok;
  const found = await prisma.patient.findFirst({
    where: {
      id: patientId,
      ...(tenantId ? { tenant_id: tenantId } : {}),
      ...ownPatientsWhere(userId),
    },
    select: { id: true },
  });
  const ok = !!found;
  if (ownCache.size > 5000) ownCache.clear();
  ownCache.set(key, { ok, at: Date.now() });
  return ok;
}

/**
 * Guard global: barra rotas de UM paciente fora da carteira do usuário restrito.
 * Olha `:patientId` em qualquer controller e `:id` no PatientsController (rotas
 * `/patients/:id/...`). Rotas sem esses params passam direto (custo zero).
 */
@Injectable()
export class PatientScopeGuard implements CanActivate {
  constructor(private readonly prisma: PrismaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== 'http') return true;
    const req = context.switchToHttp().getRequest();
    const user = req?.user;
    if (!user?.id) return true; // rota pública / sem login — o JwtAuthGuard decide

    const params = req.params || {};
    let patientId: string | undefined = params.patientId;
    if (!patientId && context.getClass()?.name === 'PatientsController' && params.id) {
      patientId = params.id;
    }
    if (!patientId) return true;

    const owner = await restrictedPatientOwner(this.prisma, user);
    if (!owner) return true;
    if (await isOwnPatient(this.prisma, user.tenant_id, owner, patientId)) return true;

    throw new ForbiddenException({
      message: 'Paciente fora da sua carteira — fale com o admin pra liberar "Ver todos os pacientes"',
      code: 'PERMISSION_DENIED',
    });
  }
}

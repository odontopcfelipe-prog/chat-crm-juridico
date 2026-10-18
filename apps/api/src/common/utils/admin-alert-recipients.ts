/**
 * Out/2026 — quem recebe um aviso interno dos ADMs (venda feita, resumo diário,
 * arquivo de não-paciente…): os números da Central + os ADMs adicionados no cadastro
 * da equipe (marcaram o aviso), menos quem desligou. A regra é a de
 * destinatariosAvisoAdm (@crm/shared) — a mesma do worker (admin-alerts).
 * Função pura (sem DI): importa só tipos, não cria ciclo entre módulos.
 */
import {
  destinatariosAvisoAdm,
  disparoEquipe,
  parseAlertPhones,
  type CentralDisparoEquipe,
  type DestinatarioAviso,
  type MembroAvisoEquipe,
} from '@crm/shared';
import type { PrismaService } from '../../prisma/prisma.service';

/**
 * Números de aviso da Central. 'aviso' = VENDA_FEITA_PHONE_<t> (senão o do Resumo
 * diário); 'resumo_diario' = só DAILY_SUMMARY_PHONE_<t> (o card do Resumo diário).
 */
export async function loadCentralAlertPhones(
  prisma: PrismaService,
  tenantId: string,
  origem: CentralDisparoEquipe = 'aviso',
): Promise<string[]> {
  const [vf, ds] = await Promise.all([
    origem === 'aviso'
      ? prisma.globalSetting.findUnique({ where: { key: `VENDA_FEITA_PHONE_${tenantId}` } }).catch(() => null)
      : null,
    prisma.globalSetting.findUnique({ where: { key: `DAILY_SUMMARY_PHONE_${tenantId}` } }).catch(() => null),
  ]);
  const proprios = parseAlertPhones(vf?.value);
  return proprios.length ? proprios : parseAlertPhones(ds?.value);
}

/** ADMs com telefone (podem receber) + quem desligou o aviso no cadastro (sai). */
export async function loadAdminAlertMembers(
  prisma: PrismaService,
  tenantId: string,
  disparo: string,
): Promise<MembroAvisoEquipe[]> {
  return prisma.user
    .findMany({
      where: {
        tenant_id: tenantId,
        phone: { not: null },
        OR: [{ roles: { has: 'ADMIN' } }, { disparos_off: { has: disparo } }],
      },
      select: { id: true, name: true, phone: true, roles: true, disparos_off: true, disparos_on: true },
      orderBy: { name: 'asc' },
    })
    .catch(() => []);
}

/** Destinatários do aviso `disparo` (id de DISPAROS_EQUIPE; a lista da Central vem do catálogo). */
export async function loadAdminAlertRecipients(
  prisma: PrismaService,
  tenantId: string,
  disparo: string,
): Promise<DestinatarioAviso[]> {
  const central = disparoEquipe(disparo)?.central;
  const [numeros, membros] = await Promise.all([
    central ? loadCentralAlertPhones(prisma, tenantId, central) : Promise.resolve([] as string[]),
    loadAdminAlertMembers(prisma, tenantId, disparo),
  ]);
  return destinatariosAvisoAdm(disparo, numeros, membros);
}

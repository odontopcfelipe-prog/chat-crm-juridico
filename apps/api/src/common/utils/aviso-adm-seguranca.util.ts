/**
 * Fase 0 — aviso IMEDIATO aos ADMs de um evento de segurança (ex.: conta Asaas trocada).
 *
 * Dois canais, independentes (um falhar não impede o outro):
 *   1. Notificação no sino de cada ADMIN — rastro durável, sai SEMPRE, mesmo sem telefone;
 *   2. WhatsApp: números da Central (VENDA_FEITA_PHONE_<t>) + ADMs com telefone, tentando
 *      os chips na ordem FINANCEIRO → CLINICA → resto até um REALMENTE entregar.
 *
 * O id do disparo fica FORA do catálogo DISPAROS_EQUIPE de propósito: recebeDisparoEquipe
 * devolve true pra id desconhecido, então todo ADM com telefone recebe e ninguém desliga.
 * Nunca lança. Função pura (sem DI): quem chama passa prisma/whatsapp — não cria ciclo.
 */
import { destinatariosAvisoAdm, type Prisma } from '@crm/shared';
import type { PrismaService } from '../../prisma/prisma.service';
import type { WhatsappService } from '../../whatsapp/whatsapp.service';
import { wasSent } from '../../whatsapp/envio-resultado';
import { loadAdminAlertMembers, loadCentralAlertPhones } from './admin-alert-recipients';

/** FORA do catálogo DISPAROS_EQUIPE de propósito (não dá pra desligar). */
export const DISPARO_ALERTA_SEGURANCA = 'alerta_seguranca';

/** Mesma regra de QuotesService.wasSent: a Evolution NÃO lança em erro, devolve {statusCode,error}. */
export function avisoEntregue(res: any): boolean {
  return wasSent(res);
}

export interface AvisoSegurancaDeps {
  prisma: PrismaService;
  whatsapp?: Pick<WhatsappService, 'sendText'> | null;
  logger?: { warn: (m: string) => void };
}

export interface AvisoSeguranca {
  titulo: string;
  texto: string;
  data?: Record<string, unknown>;
}

/** Ordem dos chips de aviso interno (cópia de QuotesService.sendInternalAlert). */
function ordenarChips<T extends { name: string; purpose?: string | null }>(chips: T[]): T[] {
  const rank = (p?: string | null) => (p === 'FINANCEIRO' ? 0 : p === 'CLINICA' ? 1 : 2);
  return [...chips].sort((a, b) => rank(a.purpose) - rank(b.purpose) || a.name.localeCompare(b.name));
}

/** Avisa os ADMs (sino + WhatsApp). Devolve quantos WhatsApps entregaram e quantas notificações nasceram. */
export async function avisarAdmsSeguranca(
  deps: AvisoSegurancaDeps,
  tenantId: string,
  aviso: AvisoSeguranca,
): Promise<{ whatsapp: number; notificacoes: number }> {
  const out = { whatsapp: 0, notificacoes: 0 };
  const { prisma, whatsapp, logger } = deps;
  if (!tenantId) return out;

  // 1. Rastro durável: notificação pra cada ADMIN (mesmo padrão do post-care).
  try {
    const admins = await prisma.user.findMany({
      where: { tenant_id: tenantId, roles: { has: 'ADMIN' } },
      select: { id: true },
    });
    if (admins.length > 0) {
      const r = await prisma.notification.createMany({
        data: admins.map((u) => ({
          user_id: u.id,
          tenant_id: tenantId,
          notification_type: 'security_alert',
          title: aviso.titulo,
          body: aviso.texto,
          data: (aviso.data ?? {}) as Prisma.InputJsonValue,
        })),
      });
      out.notificacoes = typeof r?.count === 'number' ? r.count : admins.length;
    }
  } catch (e: any) {
    logger?.warn(`[ALERTA_SEGURANCA] notificação falhou (tenant ${tenantId}): ${e?.message || e}`);
  }

  // 2. WhatsApp: cada destino tenta os chips em ordem e para no primeiro que entregou.
  try {
    if (!whatsapp) return out;
    const [numerosCentral, membros] = await Promise.all([
      loadCentralAlertPhones(prisma, tenantId, 'aviso'),
      loadAdminAlertMembers(prisma, tenantId, DISPARO_ALERTA_SEGURANCA),
    ]);
    const destinos = destinatariosAvisoAdm(DISPARO_ALERTA_SEGURANCA, numerosCentral, membros);
    if (destinos.length === 0) return out;
    const chips = ordenarChips(
      await prisma.instance.findMany({ where: { tenant_id: tenantId }, select: { name: true, purpose: true } }),
    );
    for (const d of destinos) {
      let entregue = false;
      for (const c of chips) {
        const res = await whatsapp.sendText(d.phone, aviso.texto, c.name, undefined, tenantId).catch(() => null);
        if (avisoEntregue(res)) {
          entregue = true;
          break;
        }
      }
      if (entregue) out.whatsapp++;
      else logger?.warn(`[ALERTA_SEGURANCA] nenhum chip entregou o aviso "${aviso.titulo}" (tenant ${tenantId}).`);
    }
  } catch (e: any) {
    logger?.warn(`[ALERTA_SEGURANCA] WhatsApp falhou (tenant ${tenantId}): ${e?.message || e}`);
  }
  return out;
}

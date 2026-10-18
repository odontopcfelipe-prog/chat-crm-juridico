// Envio dos ANEXOS (fotos/áudio) de um disparo automático, DEPOIS do texto — lado da API.
// Funções simples (sem injeção Nest): quem já envia o texto passa o próprio prisma e
// whatsapp. NUNCA lança: falha num anexo não pode desfazer nem repetir o texto.
import { Logger } from '@nestjs/common';
import { ordenarAnexos } from '@crm/shared';
import type { PrismaService } from '../prisma/prisma.service';
import type { WhatsappService } from '../whatsapp/whatsapp.service';
import { wasSent } from '../whatsapp/envio-resultado';

const logger = new Logger('DisparoAnexos');
const TTL_MS = 2 * 60_000;
const PAUSA_ENTRE_BOLHAS_MS = 1200;

export type AnexoCarregado = { id: string; kind: string; mime_type: string; original_name: string | null; position: number; b64: string };

const cache = new Map<string, { at: number; anexos: AnexoCarregado[] }>();
const chave = (tenantId: string, disparoId: string) => `${tenantId}|${disparoId}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Anexos do card nesta clínica (cache curto; a tela limpa o cache ao mudar). */
export async function anexosDoDisparo(prisma: PrismaService, tenantId: string, disparoId: string): Promise<AnexoCarregado[]> {
  const k = chave(tenantId, disparoId);
  const hit = cache.get(k);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.anexos;
  const rows = await prisma.disparoAnexo.findMany({
    where: { tenant_id: tenantId, disparo_id: disparoId },
    select: { id: true, kind: true, mime_type: true, original_name: true, position: true, data: true },
  });
  const anexos = ordenarAnexos(
    rows.map((r) => ({ id: r.id, kind: r.kind, mime_type: r.mime_type, original_name: r.original_name, position: r.position, b64: Buffer.from(r.data).toString('base64') })),
  );
  if (cache.size > 300) cache.clear();
  cache.set(k, { at: Date.now(), anexos });
  return anexos;
}

export function limparCacheAnexos(tenantId: string, disparoId: string) {
  cache.delete(chave(tenantId, disparoId));
}

/**
 * Manda os anexos do card pro número, pelo MESMO chip do texto (que já saiu). Sem anexo =
 * não faz nada. Nunca lança; devolve quantos saíram e o que falhou (pro log).
 */
export async function enviarAnexosDoDisparo(
  prisma: PrismaService,
  whatsapp: WhatsappService,
  p: { tenantId: string; disparoId: string; phone: string; instance: string },
): Promise<{ enviados: number; falhas: string[] }> {
  const out = { enviados: 0, falhas: [] as string[] };
  try {
    const anexos = await anexosDoDisparo(prisma, p.tenantId, p.disparoId);
    for (const a of anexos) {
      await sleep(PAUSA_ENTRE_BOLHAS_MS);
      let res: any;
      try {
        res = a.kind === 'audio'
          ? await whatsapp.sendMedia(p.phone, 'audio', a.b64, undefined, p.instance, undefined, a.mime_type, 90000, p.tenantId)
          : await whatsapp.sendMedia(p.phone, 'image', a.b64, '', p.instance, a.original_name || undefined, a.mime_type, 60000, p.tenantId);
      } catch (e: any) {
        res = { error: e?.message || 'erro' };
      }
      if (wasSent(res)) out.enviados++;
      else out.falhas.push(`${a.kind === 'audio' ? 'áudio' : 'foto'}: ${String(res?.error || 'falhou').slice(0, 120)}`);
    }
    if (out.falhas.length) logger.warn(`[ANEXOS] ${p.disparoId} (clínica ${p.tenantId}): ${out.falhas.join('; ')}`);
  } catch (e: any) {
    logger.warn(`[ANEXOS] ${p.disparoId}: não enviou os anexos (${e?.message})`);
  }
  return out;
}

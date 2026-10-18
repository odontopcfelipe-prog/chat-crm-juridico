// Envio dos ANEXOS (fotos/áudio) de um disparo automático, DEPOIS do texto — lado do worker.
// Os arquivos vêm do banco (DisparoAnexo; o worker não enxerga o volume de mídia da API) e
// saem direto pela Evolution, no MESMO chip/número do texto. NUNCA lança: falha num anexo
// não pode marcar o texto como falho nem fazer reenviar.
import { Logger } from '@nestjs/common';
import axios from 'axios';
import { ordenarAnexos, toBrazilWhatsappNumber } from '@crm/shared';
import type { PrismaService } from '../prisma/prisma.service';

const logger = new Logger('DisparoAnexos');
const TTL_MS = 2 * 60_000;
const PAUSA_ENTRE_BOLHAS_MS = 1200;

type Anexo = { id: string; kind: string; mime_type: string; original_name: string | null; position: number; b64: string };
const cache = new Map<string, { at: number; anexos: Anexo[] }>();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function anexosDoDisparo(prisma: PrismaService, tenantId: string, disparoId: string): Promise<Anexo[]> {
  const k = `${tenantId}|${disparoId}`;
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

/** A Evolution não lança em erro de negócio: 2xx com key.id = saiu. */
function saiu(data: any): boolean {
  return !!(data?.key?.id || data?.messageId || data?.id);
}

export async function enviarAnexosDoDisparoWorker(
  prisma: PrismaService,
  evo: { apiUrl?: string | null; apiKey?: string | null },
  p: { tenantId: string; disparoId: string; phone: string; instance: string },
): Promise<{ enviados: number; falhas: string[] }> {
  const out = { enviados: 0, falhas: [] as string[] };
  try {
    if (!evo?.apiUrl || !p.instance || !p.tenantId) return out;
    const anexos = await anexosDoDisparo(prisma, p.tenantId, p.disparoId);
    if (!anexos.length) return out;
    const number = toBrazilWhatsappNumber(p.phone);
    const headers = { 'Content-Type': 'application/json', apikey: evo.apiKey || '' };
    for (const a of anexos) {
      await sleep(PAUSA_ENTRE_BOLHAS_MS);
      try {
        const r = a.kind === 'audio'
          ? await axios.post(`${evo.apiUrl}/message/sendWhatsAppAudio/${p.instance}`, { number, audio: a.b64 }, { headers, timeout: 90000 })
          : await axios.post(
            `${evo.apiUrl}/message/sendMedia/${p.instance}`,
            { number, mediatype: 'image', media: a.b64, mimetype: a.mime_type, caption: '', ...(a.original_name ? { fileName: a.original_name } : {}) },
            { headers, timeout: 60000 },
          );
        if (saiu(r?.data)) out.enviados++;
        else out.falhas.push(`${a.kind === 'audio' ? 'áudio' : 'foto'}: resposta sem id`);
      } catch (e: any) {
        out.falhas.push(`${a.kind === 'audio' ? 'áudio' : 'foto'}: ${String(e?.response?.status || e?.message || 'falhou').slice(0, 120)}`);
      }
    }
    if (out.falhas.length) logger.warn(`[ANEXOS] ${p.disparoId} (clínica ${p.tenantId}): ${out.falhas.join('; ')}`);
  } catch (e: any) {
    logger.warn(`[ANEXOS] ${p.disparoId}: não enviou os anexos (${e?.message})`);
  }
  return out;
}

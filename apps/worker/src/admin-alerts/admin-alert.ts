import axios from 'axios';
import { Logger } from '@nestjs/common';
import { parseAlertPhones, toBrazilWhatsappNumber, type PrismaClient } from '@crm/shared';

/**
 * AVISO INTERNO AOS ADMs — helper PURO (sem DI, sem @Injectable): qualquer serviço
 * do worker chama passando o próprio prisma + a config da Evolution. Não importa
 * módulo nenhum, então não cria ciclo de DI (ver memória "Ciclo de DI derruba a API").
 *
 * Pra onde vai: o MESMO número dos avisos "Venda feita" / "Resumo diário"
 *   GlobalSetting VENDA_FEITA_PHONE_<tenant>  (fallback DAILY_SUMMARY_PHONE_<tenant>),
 * que aceita VÁRIOS números separados por vírgula / ";" / quebra de linha
 * (parseAlertPhones do @crm/shared — mesma regra da API).
 *
 * Por onde sai: um chip DA CLÍNICA, na ordem FINANCEIRO → CLINICA → resto (mesma do
 * sendInternalAlert da API), parando no primeiro que REALMENTE entregou (key.id e
 * sem exists:false). Sem chip DA CLÍNICA: não envia (nunca usa o chip legado global
 * EVOLUTION_INSTANCE_NAME — é de outra clínica; isolamento de tenant).
 *
 * Uso (ex.: ai.processor):
 *   import { sendAdminAlert } from '../admin-alerts/admin-alert';
 *   const r = await sendAdminAlert(this.prisma, this.settings, tenantId, {
 *     type: 'nao_paciente_handoff',
 *     text: '🔔 *Contato não-paciente* ...',
 *     media: { data: base64OuUrl, mediatype: 'document', mimetype: 'application/pdf', fileName: 'curriculo.pdf' },
 *     recipientName: lead.name,
 *   });
 *   // r = { sent: 1, failed: 0, phones: ['5582999998888'], noPhone: false }
 *
 * Nunca lança: erro de leitura/envio vira `failed` + log. Grava 1 DispatchLog por
 * número (type = opts.type, status SENT|FAILED) — aparece na Central de Disparos.
 */

const logger = new Logger('AdminAlert');

/** Config da Evolution (a mesma de SettingsService.getEvolutionConfig()). */
export interface AdminAlertEvolution {
  apiUrl: string;
  apiKey: string;
}

/**
 * Aceita a config pronta OU quem sabe buscá-la (o SettingsService do worker),
 * pra o chamador não precisar resolver antes: `sendAdminAlert(prisma, this.settings, ...)`.
 */
export type AdminAlertEvolutionSource =
  | AdminAlertEvolution
  | { getEvolutionConfig(): Promise<AdminAlertEvolution> };

/** Só os delegates do Prisma que o helper usa (PrismaService do worker serve). */
export type AdminAlertPrisma = Pick<PrismaClient, 'globalSetting' | 'instance' | 'dispatchLog'>;

/** Arquivo anexo (currículo, proposta, foto...). */
export interface AdminAlertMedia {
  /** URL pública (http/https) OU base64 PURO (sem o prefixo "data:...;base64,"). */
  data: string;
  /** Tipo da Evolution: documento, imagem, vídeo ou áudio. */
  mediatype: 'document' | 'image' | 'video' | 'audio';
  /** MIME do arquivo (ex.: application/pdf). Recomendado quando `data` é base64. */
  mimetype?: string | null;
  /** Nome que aparece no WhatsApp (documento). */
  fileName?: string | null;
}

export interface AdminAlertOptions {
  /** Texto do aviso. Com `media`, vai como LEGENDA do arquivo (exceto áudio). */
  text: string;
  /** Arquivo opcional. Se o envio do arquivo falhar em todos os chips, manda só o texto. */
  media?: AdminAlertMedia | null;
  /** DispatchLog.type (aparece na Central de Disparos). Padrão 'admin_alert'. */
  type?: string;
  /** DispatchLog.recipient_name (ex.: o nome do contato/paciente do aviso). */
  recipientName?: string | null;
  /** DispatchLog.ref_event_id / ref_patient_id, quando fizer sentido. */
  refEventId?: string | null;
  refPatientId?: string | null;
}

export interface AdminAlertResult {
  /** Números que receberam (algum chip entregou). */
  sent: number;
  /** Números em que nenhum chip entregou. */
  failed: number;
  /** Números de aviso resolvidos (já no formato de envio, 55+DDD+número). */
  phones: string[];
  /** true = clínica sem número de aviso configurado (nada foi enviado). */
  noPhone: boolean;
}

/**
 * Números de aviso dos ADMs da clínica: VENDA_FEITA_PHONE_<t>, senão
 * DAILY_SUMMARY_PHONE_<t>. Vários números separados por vírgula/;/quebra de linha,
 * normalizados (55) e sem repetidos. [] = nenhum configurado (ou erro de leitura).
 */
export async function adminAlertPhones(
  prisma: Pick<PrismaClient, 'globalSetting'>,
  tenantId: string,
): Promise<string[]> {
  if (!tenantId) return [];
  try {
    const [vf, ds] = await Promise.all([
      prisma.globalSetting.findUnique({ where: { key: `VENDA_FEITA_PHONE_${tenantId}` } }),
      prisma.globalSetting.findUnique({ where: { key: `DAILY_SUMMARY_PHONE_${tenantId}` } }),
    ]);
    const proprios = parseAlertPhones(vf?.value);
    return proprios.length ? proprios : parseAlertPhones(ds?.value);
  } catch (e: any) {
    logger.warn(`[ADMIN-ALERT] tenant ${tenantId}: falha ao ler os números de aviso: ${e?.message}`);
    return [];
  }
}

/** Chips da clínica na ordem do aviso interno: FINANCEIRO → CLINICA → resto (por nome). */
export async function adminAlertChips(
  prisma: Pick<PrismaClient, 'instance'>,
  tenantId: string,
): Promise<string[]> {
  const rank = (p?: string | null) => (p === 'FINANCEIRO' ? 0 : p === 'CLINICA' ? 1 : 2);
  let chips: { name: string; purpose: string | null }[] = [];
  try {
    chips = await prisma.instance.findMany({
      where: { tenant_id: tenantId, type: 'whatsapp' },
      select: { name: true, purpose: true },
    });
  } catch (e: any) {
    logger.warn(`[ADMIN-ALERT] tenant ${tenantId}: falha ao listar chips: ${e?.message}`);
  }
  const nomes = chips
    .filter((c) => !!c.name)
    .sort((a, b) => rank(a.purpose) - rank(b.purpose) || a.name.localeCompare(b.name))
    .map((c) => c.name);
  // SEM fallback pro chip legado EVOLUTION_INSTANCE_NAME: ele é de OUTRA clínica
  // (vazaria nome/telefone de paciente entre tenants). Sem chip da clínica = não envia
  // (DispatchLog FAILED "clínica sem chip"), igual ao sendInternalAlert da API.
  return nomes;
}

/** Sucesso REAL da Evolution: veio id de mensagem, sem erro e sem exists:false. */
export function evolutionEntregou(data: any): boolean {
  if (!data || typeof data !== 'object') return false;
  if (typeof data.statusCode === 'number' && data.statusCode >= 400) return false;
  if (typeof data.status === 'number' && data.status >= 400) return false;
  if (data.error && !data.key) return false;
  if (data.exists === false) return false;
  return !!(data.key?.id || data.messageId || data.id);
}

async function resolverEvo(evo: AdminAlertEvolutionSource): Promise<AdminAlertEvolution | null> {
  try {
    const cfg = 'getEvolutionConfig' in evo ? await evo.getEvolutionConfig() : evo;
    if (!cfg?.apiUrl) return null;
    return { apiUrl: cfg.apiUrl.replace(/\/+$/, ''), apiKey: cfg.apiKey || '' };
  } catch (e: any) {
    logger.warn(`[ADMIN-ALERT] config da Evolution indisponível: ${e?.message}`);
    return null;
  }
}

/** POST na Evolution; devolve o id da mensagem entregue ou null (nunca lança). */
async function postEvolution(
  evo: AdminAlertEvolution,
  path: string,
  body: Record<string, unknown>,
  timeoutMs: number,
): Promise<{ ok: boolean; id: string | null; erro: string | null }> {
  try {
    const res = await axios.post(`${evo.apiUrl}/${path}`, body, {
      headers: { 'Content-Type': 'application/json', apikey: evo.apiKey },
      timeout: timeoutMs,
      maxBodyLength: 40 * 1024 * 1024,
      maxContentLength: 5 * 1024 * 1024,
    });
    const d: any = res.data || {};
    if (evolutionEntregou(d)) return { ok: true, id: d.key?.id || d.messageId || d.id || null, erro: null };
    return { ok: false, id: null, erro: d?.exists === false ? 'número sem WhatsApp' : String(d?.error || d?.message || 'sem id de mensagem').slice(0, 200) };
  } catch (e: any) {
    const status = e?.response?.status;
    return { ok: false, id: null, erro: `${status ?? e?.code ?? 'erro'}: ${String(e?.message || '').slice(0, 160)}` };
  }
}

/**
 * Envia o aviso a TODOS os números de aviso dos ADMs da clínica. Pra cada número,
 * tenta os chips na ordem FINANCEIRO → CLINICA → resto e para no 1º que entregou.
 * Com `media`: tenta o arquivo (legenda = text); se nenhum chip entregar o arquivo,
 * cai pro texto puro (com a observação de que o arquivo não foi anexado).
 * Grava DispatchLog por número (opts.type, SENT/FAILED). Nunca lança.
 */
export async function sendAdminAlert(
  prisma: AdminAlertPrisma,
  evo: AdminAlertEvolutionSource,
  tenantId: string,
  opts: AdminAlertOptions,
): Promise<AdminAlertResult> {
  const type = (opts.type || 'admin_alert').slice(0, 64);
  const text = String(opts.text || '').trim();
  const phones = await adminAlertPhones(prisma, tenantId);
  if (!phones.length) {
    return { sent: 0, failed: 0, phones: [], noPhone: true };
  }
  const cfg = await resolverEvo(evo);
  const chips = cfg ? await adminAlertChips(prisma, tenantId) : [];

  let sent = 0;
  let failed = 0;
  for (const phone of phones) {
    const number = toBrazilWhatsappNumber(phone);
    let entregue: { id: string | null; chip: string } | null = null;
    let ultimoErro: string | null = !cfg ? 'Evolution não configurada' : !chips.length ? 'clínica sem chip' : null;

    if (cfg && opts.media?.data) {
      const m = opts.media;
      for (const chip of chips) {
        const r =
          m.mediatype === 'audio'
            ? await postEvolution(cfg, `message/sendWhatsAppAudio/${chip}`, { number, audio: m.data }, 60_000)
            : await postEvolution(
                cfg,
                `message/sendMedia/${chip}`,
                {
                  number,
                  mediatype: m.mediatype,
                  media: m.data,
                  caption: text,
                  ...(m.fileName ? { fileName: m.fileName } : {}),
                  ...(m.mimetype ? { mimetype: m.mimetype } : {}),
                },
                60_000,
              );
        if (r.ok) {
          entregue = { id: r.id, chip };
          break;
        }
        ultimoErro = `arquivo: ${r.erro}`;
      }
      // Áudio não leva legenda: o texto vai em seguida, pelo mesmo chip.
      if (entregue && m.mediatype === 'audio' && text) {
        await postEvolution(cfg, `message/sendText/${entregue.chip}`, { number, text }, 30_000);
      }
    }

    if (cfg && !entregue && text) {
      const corpo = opts.media?.data ? `${text}\n\n_(o arquivo não pôde ser anexado — veja na conversa pelo painel)_` : text;
      for (const chip of chips) {
        const r = await postEvolution(cfg, `message/sendText/${chip}`, { number, text: corpo }, 30_000);
        if (r.ok) {
          entregue = { id: r.id, chip };
          break;
        }
        ultimoErro = r.erro;
      }
    }

    if (entregue) sent++;
    else failed++;

    try {
      await prisma.dispatchLog.create({
        data: {
          tenant_id: tenantId,
          type,
          channel: 'WHATSAPP',
          recipient_name: opts.recipientName ? String(opts.recipientName).slice(0, 200) : null,
          recipient_phone: number,
          status: entregue ? 'SENT' : 'FAILED',
          error: entregue ? null : (ultimoErro || 'nenhum chip entregou').slice(0, 500),
          external_message_id: entregue?.id || null,
          ref_event_id: opts.refEventId || null,
          ref_patient_id: opts.refPatientId || null,
          sent_at: new Date(),
        },
      });
    } catch (e: any) {
      logger.warn(`[ADMIN-ALERT] DispatchLog (${type}) não gravou: ${e?.message}`);
    }
    if (!entregue) {
      logger.warn(`[ADMIN-ALERT] tenant ${tenantId}: aviso ${type} NÃO entregue pra ${number} (${ultimoErro || 'sem chip'})`);
    }
  }
  return { sent, failed, phones, noPhone: false };
}

import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import {
  CAMPANHA_HORA_FIM,
  CAMPANHA_HORA_INICIO,
  CAMPANHA_TETO_DIA,
  chipPacienteOuLegado,
  escolherChipPaciente,
  findClinicHoliday,
  planejarEnvio,
  renderCampanhaTexto,
  type CampanhaMidiaTipo,
  type CampanhaSetor,
} from '@crm/shared';
import { PrismaService } from '../prisma/prisma.service';
import { WhatsappService } from '../whatsapp/whatsapp.service';
import { FileStorageService } from '../media/filesystem.service';
import { chipForaDoAr, numeroSemWhatsapp, wasSent } from '../whatsapp/envio-resultado';

const LOG = '[CAMPANHA]';
const MACEIO_OFFSET_MS = 3 * 3600e3;
const PACE_MIN_MS = 3 * 60_000;
const PACE_MAX_MS = 7 * 60_000;
const PAUSA_CHIP_CAIDO_MS = 30 * 60_000;
const ENVIANDO_PRESO_MS = 15 * 60_000;
const TENTATIVAS_POR_TICK = 5;
const PAUSA_ENTRE_BOLHAS_MS = 1200;
/** base64 até ~6 MB de arquivo fica no cache; acima (vídeo) é lido do disco a cada envio. */
const CACHE_MIDIA_MAX_B64 = 8 * 1024 * 1024;
export const DISPATCH_TYPE_CAMPANHA = 'campanha_manual';

export type MidiaCampanha = { id: string; kind: string; file_path: string; mime_type: string; position: number; original_name: string | null };

export type ResultadoEnvio = {
  /** A 1ª bolha saiu (o paciente recebeu a campanha). */
  saiu: boolean;
  chipCaido: boolean;
  semWhatsapp: boolean;
  externalId: string | null;
  erros: string[];
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Motor da campanha manual — roda na API (1 réplica; guard `busy`), a cada minuto seg–sáb
 * 9:00–17:59 Maceió. Mesmas travas dos disparos automáticos:
 *  - feriado não envia; teto CAMPANHA_TETO_DIA envios/dia por clínica;
 *  - chip do SETOR da campanha (Clínica/Comercial pela regra única escolherChipPaciente;
 *    Financeiro só pelo chip Financeiro). Sem chip → a campanha PAUSA com o motivo;
 *  - marca-passo POR CHIP no banco (WhatsappChipPacer, o mesmo dos automáticos): 3–7 min
 *    entre pacientes no mesmo chip — os automáticos dividem a vez com a campanha;
 *  - item reivindicado de forma atômica (PENDENTE → ENVIANDO); reconfere o paciente ao vivo
 *    (arquivado, pediu pra não receber, número sem WhatsApp) antes de enviar;
 *  - chip fora do ar devolve o item pra fila e pausa o chip 30 min; timeout fica FALHOU
 *    (pode ter saído — nunca reenvia sozinho); item preso em ENVIANDO > 15 min = FALHOU.
 */
@Injectable()
export class CampanhasEnvioService {
  private readonly logger = new Logger(CampanhasEnvioService.name);
  private busy = false;
  /** base64 dos anexos (≤ 3 por campanha), pra não reler o arquivo a cada paciente. */
  private cacheMidia = new Map<string, string>();

  constructor(
    private prisma: PrismaService,
    private whatsapp: WhatsappService,
    private files: FileStorageService,
  ) {}

  @Cron('*/1 9-17 * * 1-6', { timeZone: 'America/Maceio' })
  async tick() {
    if (this.busy) return;
    this.busy = true;
    try {
      await this.rodar(new Date());
    } catch (e: any) {
      this.logger.warn(`${LOG} tick falhou: ${e?.message}`);
    } finally {
      this.busy = false;
    }
  }

  async rodar(agora: Date): Promise<void> {
    const local = new Date(agora.getTime() - MACEIO_OFFSET_MS);
    const hora = local.getUTCHours();
    if (hora < CAMPANHA_HORA_INICIO || hora >= CAMPANHA_HORA_FIM) return;

    // Agendada que chegou a hora → começa.
    await this.prisma.manualCampaign.updateMany({
      where: { status: 'AGENDADA', scheduled_for: { lte: agora } },
      data: { status: 'ENVIANDO', started_at: agora },
    });
    await this.varrerPresos(agora);

    const ativas = await this.prisma.manualCampaign.findMany({
      where: { status: 'ENVIANDO' },
      orderBy: [{ started_at: 'asc' }, { created_at: 'asc' }],
      select: { id: true, tenant_id: true, setor: true, text: true, name: true },
    });
    if (!this.cacheMidia.size || this.cacheMidia.size > 30) this.cacheMidia.clear();
    const feriadoPorClinica = new Map<string, boolean>();
    for (const c of ativas) {
      try {
        if (!feriadoPorClinica.has(c.tenant_id)) {
          let fechado = true;
          try {
            fechado = !!(await findClinicHoliday(this.prisma, local, c.tenant_id));
          } catch {
            fechado = true; // erro ao conferir = não envia
          }
          feriadoPorClinica.set(c.tenant_id, fechado);
        }
        if (feriadoPorClinica.get(c.tenant_id)) continue;
        await this.processarCampanha(c, agora);
      } catch (e: any) {
        this.logger.warn(`${LOG} campanha ${c.id}: ${e?.message}`);
      }
    }
  }

  /** Item ENVIANDO há mais de 15 min = processo morreu no meio: FALHOU (pode ter saído; não reenvia). */
  private async varrerPresos(agora: Date) {
    const presos = await this.prisma.manualCampaignItem.findMany({
      where: { status: 'ENVIANDO', claimed_at: { lt: new Date(agora.getTime() - ENVIANDO_PRESO_MS) } },
      select: { id: true, campaign_id: true },
      take: 200,
    });
    for (const it of presos) {
      const r = await this.prisma.manualCampaignItem.updateMany({
        where: { id: it.id, status: 'ENVIANDO' },
        data: { status: 'FALHOU', reason: 'interrompido (pode ter saído)' },
      });
      if (r.count) await this.prisma.manualCampaign.update({ where: { id: it.campaign_id }, data: { failed_count: { increment: 1 } } });
    }
  }

  /** Chip do setor, sempre da clínica da campanha. null = não há chip pra esse setor. */
  async chipDoSetor(tenantId: string, setor: CampanhaSetor | string): Promise<string | null> {
    const chips = await this.prisma.instance.findMany({
      where: { type: 'whatsapp', tenant_id: tenantId },
      orderBy: { created_at: 'asc' },
      select: { name: true, purpose: true },
    });
    if (setor === 'FINANCEIRO') return chips.find((c) => (c.purpose || '').toUpperCase() === 'FINANCEIRO')?.name ?? null;
    return chipPacienteOuLegado(escolherChipPaciente(chips, setor === 'COMERCIAL' ? 'COMERCIAL' : 'CLINICA'));
  }

  private inicioDiaMaceio(agora: Date): Date {
    const local = new Date(agora.getTime() - MACEIO_OFFSET_MS);
    return new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate()) + MACEIO_OFFSET_MS);
  }

  private async processarCampanha(
    c: { id: string; tenant_id: string; setor: string; text: string; name: string },
    agora: Date,
  ): Promise<void> {
    const pendente = await this.prisma.manualCampaignItem.count({ where: { campaign_id: c.id, status: 'PENDENTE' } });
    if (!pendente) {
      const enviando = await this.prisma.manualCampaignItem.count({ where: { campaign_id: c.id, status: 'ENVIANDO' } });
      if (!enviando) {
        await this.prisma.manualCampaign.updateMany({
          where: { id: c.id, status: 'ENVIANDO' },
          data: { status: 'CONCLUIDA', completed_at: agora },
        });
        this.logger.log(`${LOG} campanha ${c.id} concluída`);
      }
      return;
    }

    const hoje = await this.prisma.dispatchLog.count({
      where: { tenant_id: c.tenant_id, type: DISPATCH_TYPE_CAMPANHA, sent_at: { gte: this.inicioDiaMaceio(agora) } },
    });
    if (hoje >= CAMPANHA_TETO_DIA) return;

    const chip = await this.chipDoSetor(c.tenant_id, c.setor);
    if (!chip) {
      await this.prisma.manualCampaign.updateMany({
        where: { id: c.id, status: 'ENVIANDO' },
        data: { status: 'PAUSADA', pause_reason: `Sem chip ${c.setor === 'FINANCEIRO' ? 'Financeiro' : c.setor === 'COMERCIAL' ? 'Comercial' : 'da Clínica'} conectado — conecte e clique em Retomar` },
      });
      this.logger.warn(`${LOG} campanha ${c.id}: sem chip pro setor ${c.setor} — pausada`);
      return;
    }

    // Vez do chip (atômico, o mesmo marca-passo dos automáticos).
    await this.prisma.whatsappChipPacer.createMany({ data: [{ instance_name: chip, next_allowed_at: new Date(0) }], skipDuplicates: true });
    const vez = await this.prisma.whatsappChipPacer.updateMany({
      where: { instance_name: chip, next_allowed_at: { lte: agora } },
      data: { next_allowed_at: new Date(agora.getTime() + PACE_MIN_MS + Math.random() * (PACE_MAX_MS - PACE_MIN_MS)) },
    });
    if (vez.count === 0) return;

    let desfecho: 'enviado' | 'falhou' | 'chip_caido' | 'pulado' = 'pulado';
    try {
      const midias = await this.prisma.manualCampaignMedia.findMany({ where: { campaign_id: c.id }, orderBy: { position: 'asc' } });
      const tenant = await this.prisma.tenant.findUnique({ where: { id: c.tenant_id }, select: { name: true } }).catch(() => null);
      for (let i = 0; i < TENTATIVAS_POR_TICK; i++) {
        const item = await this.prisma.manualCampaignItem.findFirst({
          where: { campaign_id: c.id, status: 'PENDENTE' },
          orderBy: { created_at: 'asc' },
          select: { id: true, patient_id: true, phone: true, name: true },
        });
        if (!item) break;
        const claim = await this.prisma.manualCampaignItem.updateMany({
          where: { id: item.id, status: 'PENDENTE' },
          data: { status: 'ENVIANDO', claimed_at: agora },
        });
        if (claim.count === 0) continue;
        desfecho = await this.enviarItem(c, item, chip, midias, tenant?.name || 'a clínica');
        if (desfecho !== 'pulado') break;
      }
    } finally {
      if (desfecho === 'pulado') {
        await this.prisma.whatsappChipPacer.updateMany({ where: { instance_name: chip }, data: { next_allowed_at: agora } }).catch(() => undefined);
      } else if (desfecho === 'chip_caido') {
        await this.prisma.whatsappChipPacer
          .updateMany({ where: { instance_name: chip }, data: { next_allowed_at: new Date(agora.getTime() + PAUSA_CHIP_CAIDO_MS) } })
          .catch(() => undefined);
        this.logger.warn(`${LOG} chip ${chip} fora do ar — campanha ${c.id} espera 30 min`);
      }
    }
  }

  private async enviarItem(
    c: { id: string; tenant_id: string; text: string },
    item: { id: string; patient_id: string; phone: string; name: string | null },
    chip: string,
    midias: MidiaCampanha[],
    clinica: string,
  ): Promise<'enviado' | 'falhou' | 'chip_caido' | 'pulado'> {
    const pular = async (motivo: string) => {
      await this.prisma.manualCampaignItem.update({ where: { id: item.id }, data: { status: 'PULADO', reason: motivo } });
      await this.prisma.manualCampaign.update({ where: { id: c.id }, data: { skipped_count: { increment: 1 } } });
      return 'pulado' as const;
    };
    // Reconfere ao vivo: a lista foi congelada ao iniciar, o cadastro pode ter mudado.
    const p = await this.prisma.patient.findFirst({
      where: { id: item.patient_id, tenant_id: c.tenant_id },
      select: {
        name: true, phone: true, status: true,
        lead: { select: { contact_opt_out_at: true, whatsapp_invalid_at: true, non_patient_category: true } },
      },
    });
    if (!p || p.status === 'ARCHIVED') return pular('paciente arquivado/removido');
    if (p.lead?.contact_opt_out_at || p.lead?.non_patient_category) return pular('pediu pra não receber');
    if (p.lead?.whatsapp_invalid_at) return pular('número sem WhatsApp');
    const phone = (p.phone || item.phone || '').trim();
    if (phone.replace(/\D/g, '').length < 10) return pular('sem telefone');

    const nome = (p.name || item.name || '').trim();
    const r = await this.enviarPara(c.tenant_id, chip, phone, c.text, midias, {
      nome: nome.split(/\s+/)[0] || '',
      nome_completo: nome,
      clinica,
    });

    if (r.chipCaido) {
      // Garantido que não saiu: volta pra fila (outra rodada tenta).
      await this.prisma.manualCampaignItem.update({ where: { id: item.id }, data: { status: 'PENDENTE', claimed_at: null } });
      return 'chip_caido';
    }
    const ok = r.saiu;
    const motivo = ok
      ? r.erros.length ? `parte não saiu: ${r.erros.join('; ')}`.slice(0, 300) : null
      : r.semWhatsapp ? 'número sem WhatsApp' : (r.erros[0] || 'Evolution recusou o envio').slice(0, 300);
    await this.prisma.manualCampaignItem.update({
      where: { id: item.id },
      data: { status: ok ? 'ENVIADO' : 'FALHOU', reason: motivo, external_message_id: r.externalId, sent_at: new Date() },
    });
    await this.prisma.manualCampaign.update({
      where: { id: c.id },
      data: ok ? { sent_count: { increment: 1 } } : { failed_count: { increment: 1 } },
    });
    await this.prisma.dispatchLog
      .create({
        data: {
          tenant_id: c.tenant_id,
          type: DISPATCH_TYPE_CAMPANHA,
          channel: 'WHATSAPP',
          recipient_name: nome || null,
          recipient_phone: phone,
          status: ok ? 'SENT' : 'FAILED',
          error: ok ? null : motivo,
          external_message_id: r.externalId,
          ref_patient_id: item.patient_id,
          sent_at: new Date(),
        },
      })
      .catch((e: any) => this.logger.warn(`${LOG} DispatchLog não registrou: ${e?.message}`));
    return ok ? 'enviado' : 'falhou';
  }

  private async base64Da(m: MidiaCampanha): Promise<string> {
    const hit = this.cacheMidia.get(m.id);
    if (hit) return hit;
    const b64 = (await this.files.read(m.file_path)).toString('base64');
    // Teto de memória: vídeo grande não fica no cache — relê do disco a cada paciente.
    if (b64.length <= CACHE_MIDIA_MAX_B64) this.cacheMidia.set(m.id, b64);
    return b64;
  }

  /**
   * Manda a campanha (texto + fotos + áudio, na ordem de planejarEnvio) pra UM número pelo
   * chip dado. Usado pelo motor e pelo "Enviar teste". Não lança: devolve o que aconteceu.
   */
  async enviarPara(
    tenantId: string,
    chip: string,
    phone: string,
    texto: string,
    midias: MidiaCampanha[],
    vars: Record<string, string>,
  ): Promise<ResultadoEnvio> {
    const passos = planejarEnvio(
      renderCampanhaTexto(texto, vars),
      midias.map((m) => ({ id: m.id, tipo: m.kind as CampanhaMidiaTipo, posicao: m.position })),
    );
    const out: ResultadoEnvio = { saiu: false, chipCaido: false, semWhatsapp: false, externalId: null, erros: [] };
    const porId = new Map(midias.map((m) => [m.id, m]));
    for (let i = 0; i < passos.length; i++) {
      const passo = passos[i];
      let res: any;
      try {
        if (passo.tipo === 'texto') {
          res = await this.whatsapp.sendText(phone, passo.texto, chip, undefined, tenantId);
        } else {
          const m = porId.get(passo.midiaId)!;
          const b64 = await this.base64Da(m);
          res = passo.tipo === 'image'
            ? await this.whatsapp.sendMedia(phone, 'image', b64, passo.legenda, chip, m.original_name || undefined, m.mime_type, 60000, tenantId)
            : passo.tipo === 'video'
              ? await this.whatsapp.sendMedia(phone, 'video', b64, passo.legenda, chip, m.original_name || undefined, m.mime_type, 120000, tenantId)
              : await this.whatsapp.sendMedia(phone, 'audio', b64, undefined, chip, undefined, m.mime_type, 90000, tenantId);
        }
      } catch (e: any) {
        res = { error: e?.message || 'erro', statusCode: e?.response?.status };
      }
      const ok = wasSent(res);
      if (i === 0) {
        if (!ok) {
          out.semWhatsapp = numeroSemWhatsapp(res);
          out.chipCaido = !out.semWhatsapp && chipForaDoAr(res);
          out.erros.push(String(res?.error || res?.message || 'falhou').slice(0, 200));
          return out; // a 1ª bolha não saiu: não manda o resto
        }
        out.saiu = true;
        out.externalId = res?.key?.id || res?.messageId || null;
      } else if (!ok) {
        out.erros.push(`${passo.tipo === 'texto' ? 'texto' : passo.tipo === 'image' ? 'foto' : passo.tipo === 'video' ? 'vídeo' : 'áudio'}: ${String(res?.error || 'falhou').slice(0, 120)}`);
      }
      if (i < passos.length - 1) await sleep(PAUSA_ENTRE_BOLHAS_MS);
    }
    return out;
  }
}

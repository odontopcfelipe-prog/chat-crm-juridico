import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { PatientsService } from './patients.service';

/**
 * Onda 18.x — Auto-backfill das FOTOS dos pacientes (WhatsApp), em GOTEJAMENTO.
 *
 * Problema: quando os arquivos de foto são apagados no disco (redeploy do volume),
 * o `avatar_url` fica pendurado e o card cai nas iniciais. O reparo já existe
 * (`backfillWhatsappAvatars`, que re-busca quando o arquivo não está no storage),
 * mas dependia do usuário clicar "Puxar fotos".
 *
 * Aqui o reparo roda SOZINHO — porém DEVAGAR, pra NUNCA floodar/derrubar o número:
 *   - a cada 5 min, um lote PEQUENO (8 pacientes) POR clínica;
 *   - o próprio backfill pausa 500ms entre consultas ao WhatsApp e PULA quem já
 *     tem foto salva (sem chamada nenhuma);
 *   - respiro de 1.5s ENTRE clínicas;
 *   - só roda pra clínicas com chip CLINICA/COMERCIAL conectado (nunca Financeiro);
 *   - anda por offset (persistido); ao varrer todo mundo, PAUSA ~12h e recomeça
 *     (pra rechecar fotos apagadas/pacientes novos sem rodar à toa).
 *
 * Pico máximo: ~8 consultas/clínica a cada 5 min (≈1,6/min). Muito abaixo de
 * qualquer gatilho de ban — que é sobre ENVIO em massa, não leitura de foto.
 * Kill-switch: GlobalSetting `AVATAR_AUTOBACKFILL_OFF` = "1" desliga tudo.
 */
@Injectable()
export class PatientAvatarBackfillCron {
  private readonly logger = new Logger(PatientAvatarBackfillCron.name);
  private running = false;

  // Lote pequeno por clínica por rodada (o backfill clampa em 1..25).
  private static readonly LIMIT = 8;
  // Pausa após uma passada completa (recheca a cada 12h).
  private static readonly DONE_PAUSE_MS = 12 * 60 * 60 * 1000;

  constructor(
    private prisma: PrismaService,
    private patients: PatientsService,
  ) {}

  @Cron('*/5 * * * *')
  async drip() {
    if (this.running) return; // nunca sobrepõe execuções
    this.running = true;
    try {
      // Kill-switch global.
      const off = await this.prisma.globalSetting.findUnique({ where: { key: 'AVATAR_AUTOBACKFILL_OFF' } });
      if (off?.value && off.value !== '0' && off.value.toLowerCase() !== 'false') return;

      // Clínicas com chip CLINICA/COMERCIAL (o backfill exige; nunca Financeiro).
      const chips = await this.prisma.instance.findMany({
        where: { type: 'whatsapp', purpose: { in: ['CLINICA', 'COMERCIAL'] } },
        select: { tenant_id: true },
      });
      const tenantIds = [...new Set(chips.map((c) => c.tenant_id).filter(Boolean))] as string[];
      if (tenantIds.length === 0) return;

      const now = Date.now();
      for (const tenantId of tenantIds) {
        const state = await this.getState(tenantId);
        if (state.pausedUntil > now) continue; // ainda em pausa pós-passada completa

        try {
          const res = await this.patients.backfillWhatsappAvatars(
            tenantId,
            state.offset,
            PatientAvatarBackfillCron.LIMIT,
          );
          if (res.done) {
            await this.setState(tenantId, { offset: 0, pausedUntil: now + PatientAvatarBackfillCron.DONE_PAUSE_MS });
          } else {
            await this.setState(tenantId, { offset: res.nextOffset, pausedUntil: 0 });
          }
          if (res.updated > 0) {
            this.logger.log(`[AVATAR-AUTO] tenant ${tenantId}: +${res.updated} foto(s) (offset ${res.nextOffset}${res.done ? ', passada completa' : ''})`);
          }
        } catch (e: any) {
          // Chip caiu / Evolution fora / etc. — não trava; tenta na próxima rodada.
          this.logger.warn(`[AVATAR-AUTO] tenant ${tenantId}: ${e?.message}`);
        }

        // Respiro entre clínicas — não rajar de uma pra outra.
        await new Promise((r) => setTimeout(r, 1500));
      }
    } finally {
      this.running = false;
    }
  }

  // ─── Estado por tenant (persistido em GlobalSetting; sobrevive restart) ───
  private async getState(tenantId: string): Promise<{ offset: number; pausedUntil: number }> {
    const row = await this.prisma.globalSetting.findUnique({ where: { key: this.stateKey(tenantId) } });
    if (!row?.value) return { offset: 0, pausedUntil: 0 };
    try {
      const v = JSON.parse(row.value);
      return { offset: Number(v.offset) || 0, pausedUntil: Number(v.pausedUntil) || 0 };
    } catch {
      return { offset: 0, pausedUntil: 0 };
    }
  }

  private async setState(tenantId: string, v: { offset: number; pausedUntil: number }) {
    const key = this.stateKey(tenantId);
    const value = JSON.stringify(v);
    await this.prisma.globalSetting.upsert({
      where: { key },
      create: { key, value },
      update: { value },
    });
  }

  private stateKey(tenantId: string) {
    return `AVATAR_AUTOBACKFILL_STATE_${tenantId}`;
  }
}

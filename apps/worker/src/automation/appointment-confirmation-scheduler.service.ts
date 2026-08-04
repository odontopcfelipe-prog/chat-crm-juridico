import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { formatTenantAddress, DEFAULT_CONFIRMACAO_ORTO } from '@crm/shared';

/**
 * Cron horario que cria AppointmentConfirmation pendente para
 * CalendarEvent.start_at entre 24h e 25h no futuro (status AGENDADO,
 * tipo CONSULTA, sem confirmacao registrada ainda).
 *
 * O envio efetivo do WhatsApp/SMS/email e responsabilidade de outro
 * worker que processa AppointmentConfirmation com sent_at IS NULL.
 *
 * Esta separacao permite:
 *  - Auditoria (registro existe mesmo se envio falhar)
 *  - Reenvio (basta limpar sent_at)
 *  - Multiplos canais (cada canal cria seu registro)
 *
 * Estrategia de janela: 24-25h evita disparar duplicado se o cron rodar
 * varias vezes (idempotencia natural por janela de 1h).
 */
@Injectable()
export class AppointmentConfirmationSchedulerService {
  private readonly logger = new Logger(AppointmentConfirmationSchedulerService.name);

  constructor(private prisma: PrismaService) {}

  @Cron('0 * * * *', { timeZone: 'America/Maceio' })
  async scheduleConfirmations() {
    try {
      const now = new Date();
      const in24h = new Date(now.getTime() + 24 * 60 * 60 * 1000);
      const in25h = new Date(now.getTime() + 25 * 60 * 60 * 1000);

      // Onda 17.61 — TODOS os atendimentos com paciente (CONSULTA + PROCEDIMENTO +
      // RETORNO), AGENDADO, em 24-25h. Antes era so CONSULTA — procedimento/retorno
      // nao recebiam a confirmacao de agendamento.
      // Onda 18.x — + ORTODONTIA: eventos de orto TAMBÉM recebem confirmação. Se a
      // confirmação de orto estiver LIGADA, usam o texto de orto (ordem de chegada);
      // se DESLIGADA, caem na confirmação NORMAL (original).
      const eligible = await this.prisma.calendarEvent.findMany({
        where: {
          type: { in: ['CONSULTA', 'PROCEDIMENTO', 'RETORNO', 'ORTODONTIA'] },
          status: 'AGENDADO',
          patient_id: { not: null },
          start_at: { gte: in24h, lt: in25h },
        },
        select: {
          id: true,
          tenant_id: true,
          type: true,
          title: true,
          start_at: true,
          location: true,
          assigned_user: { select: { name: true } },
          patient: { select: { id: true, name: true, phone: true } },
        },
      });

      if (eligible.length === 0) return;

      let created = 0;
      let skipped = 0;
      // Onda 17.49 — cache do liga/desliga da confirmacao por tenant
      const enabledByTenant = new Map<string, boolean>();
      // Onda 17.56 — cache do TEMPLATE da mensagem por tenant (editável na Central)
      const templateByTenant = new Map<string, string>();
      // Onda 17.57 — cache do endereço da clínica por tenant (fallback do {local})
      const addressByTenant = new Map<string, string>();
      // Onda 18.x — caches do disparo de ORTODONTIA (liga/desliga + texto por tenant)
      const orthoEnabledByTenant = new Map<string, boolean>();
      const orthoTemplateByTenant = new Map<string, string>();
      const DEFAULT_TPL =
        'Oi {nome}, tudo bem? 😊\n\nAqui é pra confirmar seu atendimento com {dentista} amanhã, *{data}* às *{hora}*.\n{local_line}\nPosso confirmar sua presença? 🙂 Qualquer imprevisto, me avisa que a gente ajeita um novo horário.';

      for (const ev of eligible) {
        if (!ev.patient?.phone) {
          skipped++;
          continue;
        }

        // Onda 17.49 — respeita o toggle "Confirmação" (default LIGADO): nao cria
        // a confirmacao se o tenant desligou no painel Operacional.
        const tid = ev.tenant_id || '';
        const isOrtho = ev.type === 'ORTODONTIA';
        let confEnabled = enabledByTenant.get(tid);
        if (confEnabled === undefined) {
          const s = await this.prisma.globalSetting.findUnique({
            where: { key: `APPOINTMENT_CONFIRMATION_ENABLED_${tid}` },
          });
          confEnabled = (s?.value ?? 'true') !== 'false';
          enabledByTenant.set(tid, confEnabled);
        }

        // Onda 18.x — confirmação de ORTODONTIA (default DESLIGADA). Só carrega pra
        // eventos de orto. Regra: orto LIGADA → usa o texto de orto (ordem de
        // chegada); orto DESLIGADA → o evento de orto cai na confirmação NORMAL
        // (gated pelo toggle principal, como qualquer outro tipo).
        let orthoEnabled = false;
        if (isOrtho) {
          const cached = orthoEnabledByTenant.get(tid);
          if (cached === undefined) {
            const s = await this.prisma.globalSetting.findUnique({
              where: { key: `APPOINTMENT_CONFIRMATION_ORTO_ENABLED_${tid}` },
            });
            orthoEnabled = s?.value === 'true';
            orthoEnabledByTenant.set(tid, orthoEnabled);
          } else {
            orthoEnabled = cached;
          }
        }
        const useOrthoTpl = isOrtho && orthoEnabled;
        // Passa se: não-orto → toggle principal; orto → orto-on OU principal-on
        // (orto desligada não deixa o paciente sem confirmação — cai na original).
        const allowed = isOrtho ? (orthoEnabled || confEnabled) : confEnabled;
        if (!allowed) { skipped++; continue; }

        // Onda 17.60 — dedup só contra a CONFIRMAÇÃO de 48h (>= 2880 min). Antes era
        // qualquer lembrete >=12h, mas os lembretes (1d/1h/15min) viraram puro lembrete
        // (não pedem confirmação) — então NÃO devem desligar esta confirmação de 24h.
        // Assim "deixar todas funcionando, ligo o que quero" vale: se você usa a de 48h,
        // ela desliga esta (não duplica); senão, esta confirmação de 24h dispara normal.
        const confirmacao48h = await this.prisma.eventReminder.findFirst({
          where: {
            event_id: ev.id,
            channel: 'WHATSAPP',
            sent_at: null,
            minutes_before: { gte: 2880 },
          },
          select: { id: true },
        });
        if (confirmacao48h) { skipped++; continue; }

        // Ja existe confirmacao por WhatsApp para este agendamento?
        const existing = await this.prisma.appointmentConfirmation.findFirst({
          where: {
            appointment_id: ev.id,
            channel: 'WHATSAPP',
          },
        });
        if (existing) {
          skipped++;
          continue;
        }

        const time = new Date(ev.start_at).toLocaleTimeString('pt-BR', {
          hour: '2-digit',
          minute: '2-digit',
        });
        const date = new Date(ev.start_at).toLocaleDateString('pt-BR', {
          day: '2-digit',
          month: '2-digit',
        });

        // Onda 17.56 — usa o template editável do tenant (cache por tenant).
        // Onda 18.x — se for orto COM a confirmação de orto ligada, usa o texto de
        // orto (APPOINTMENT_CONFIRMATION_ORTO_TEMPLATE); senão, o template normal.
        let tpl: string;
        if (useOrthoTpl) {
          const cachedOrtho = orthoTemplateByTenant.get(tid);
          if (cachedOrtho !== undefined) {
            tpl = cachedOrtho;
          } else {
            const ts = await this.prisma.globalSetting.findUnique({
              where: { key: `APPOINTMENT_CONFIRMATION_ORTO_TEMPLATE_${tid}` },
            });
            let parsed: any = null;
            try { parsed = ts?.value ? JSON.parse(ts.value) : null; } catch { parsed = null; }
            tpl =
              parsed && typeof parsed.template === 'string' && parsed.template.trim()
                ? String(parsed.template)
                : DEFAULT_CONFIRMACAO_ORTO;
            orthoTemplateByTenant.set(tid, tpl);
          }
        } else {
          const cachedTpl = templateByTenant.get(tid);
          if (cachedTpl !== undefined) {
            tpl = cachedTpl;
          } else {
            const ts = await this.prisma.globalSetting.findUnique({
              where: { key: `APPOINTMENT_CONFIRMATION_TEMPLATE_${tid}` },
            });
            let parsed: any = null;
            try { parsed = ts?.value ? JSON.parse(ts.value) : null; } catch { parsed = null; }
            tpl =
              parsed && typeof parsed.template === 'string' && parsed.template.trim()
                ? String(parsed.template)
                : DEFAULT_TPL;
            templateByTenant.set(tid, tpl);
          }
        }

        // Onda 17.57 — {local} = local do evento OU endereço cadastrado da clínica.
        let tenantAddr = addressByTenant.get(tid);
        if (tenantAddr === undefined) {
          const trow = await this.prisma.tenant.findUnique({
            where: { id: tid },
            select: {
              address: true, address_number: true, address_complement: true,
              neighborhood: true, city: true, state: true,
            },
          });
          tenantAddr = formatTenantAddress(trow);
          addressByTenant.set(tid, tenantAddr);
        }
        const local = ev.location || tenantAddr;
        const localLine = local ? `📍 ${local}\n` : '';
        const message = tpl
          .replace(/\{nome_completo\}/g, ev.patient.name)
          .replace(/\{nome\}/g, ev.patient.name.split(' ')[0])
          .replace(/\{dentista\}/g, ev.assigned_user?.name || 'a clínica')
          .replace(/\{data\}/g, date)
          .replace(/\{hora\}/g, time)
          .replace(/\{local_line\}/g, localLine)
          .replace(/\{local\}/g, local)
          .replace(/\n{3,}/g, '\n\n')
          .trim();

        // Cria SERIALIZADO por agendamento (advisory lock). O existing-check acima é
        // check-then-create NÃO-atômico: se DOIS workers rodam juntos (2 réplicas ou
        // sobreposição de deploy), ambos passavam sem achar existente e criavam 2
        // confirmações → 2 mensagens. O lock por appointment_id faz o 2º ver a do 1º.
        await this.prisma.$transaction(async (tx) => {
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${ev.id}))`;
          const dup = await tx.appointmentConfirmation.findFirst({
            where: { appointment_id: ev.id, channel: 'WHATSAPP' },
            select: { id: true },
          });
          if (dup) return; // outra execução já criou dentro da corrida
          await tx.appointmentConfirmation.create({
            data: {
              appointment_id: ev.id,
              channel: 'WHATSAPP',
              scheduled_for: now,
              // sent_at fica null — outro worker envia efetivamente
              message_text: message,
              response_status: 'PENDENTE',
            },
          });
          created++;
        });
      }

      if (created > 0 || skipped > 0) {
        this.logger.log(
          `[ConfirmationScheduler] ${created} criada(s), ${skipped} pulada(s) (sem telefone ou ja existente)`,
        );
      }
    } catch (e: any) {
      this.logger.error(`[ConfirmationScheduler] Erro: ${e.message}`);
    }
  }
}

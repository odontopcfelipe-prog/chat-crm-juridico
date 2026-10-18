import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import {
  aiProfileKey,
  isAiChipPurpose,
  normalizeAiChipProfile,
  DEFAULT_ASSISTANT_NAME,
  type DestinatarioAviso,
} from '@crm/shared';
import { PrismaService } from '../prisma/prisma.service';
import { SettingsService } from '../settings/settings.service';
import { adminAlertRecipients, sendAdminAlert } from './admin-alert';
import {
  ADMIN_AGENDAMENTO_DISPARO,
  ADMIN_AGENDAMENTO_DISPATCH_TYPE,
  ADMIN_AGENDAMENTO_KEY_PREFIX,
  ADMIN_AGENDAMENTO_MAX_POR_TICK,
  ADMIN_AGENDAMENTO_PASSADO_TOLERANCIA_MS,
  ADMIN_AGENDAMENTO_RESPIRO_MS,
  ADMIN_AGENDAMENTO_STATUS,
  ADMIN_AGENDAMENTO_TIPOS,
  agoraNaiveMaceio,
  inicioJanelaAviso,
  montarTextoNovoAgendamento,
  togglesPorClinica,
  type OrigemAgendamento,
} from './admin-agendamento-regras';

const LOG = '[ADMIN-AGENDAMENTO]';
/** Aviso "clínica ligou mas não tem número" no log: no máx. 1×/hora por clínica. */
const AVISO_SEM_NUMERO_MS = 60 * 60 * 1000;

/**
 * "Todo paciente agendado notificar aos ADMs com um disparo" (pedido do dono).
 *
 * A cada minuto, pra cada clínica com o toggle ligado na Central de Disparos:
 *   - ADMIN_AGENDAMENTO_IA_ENABLED_<t>     → eventos marcados pela IA (created_by_ai);
 *   - ADMIN_AGENDAMENTO_EQUIPE_ENABLED_<t> → eventos marcados pela equipe.
 * Só consulta/procedimento/retorno/ortodontia AGENDADO|CONFIRMADO, criados depois de
 * ligar o toggle e nas últimas 2h (nunca avisa backlog), 1ª ocorrência da série.
 *
 * 2 workers rodam este cron → CLAIM ATÔMICO (admin_notified_at null → agora, com o
 * status ainda marcado) ANTES de enviar: só uma réplica avisa; evento cancelado antes
 * do claim não avisa. O envio é o helper puro sendAdminAlert (número dos ADMs, chip
 * FINANCEIRO → CLINICA → resto, DispatchLog 'admin_agendamento').
 *
 * Importa SÓ Prisma e Settings (globais) — sem módulo de IA/fila, sem risco de ciclo de DI.
 */
@Injectable()
export class AdminAgendamentoAlertService {
  private readonly logger = new Logger(AdminAgendamentoAlertService.name);
  private rodando = false;
  private readonly semNumeroLogadoEm = new Map<string, number>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
  ) {}

  @Cron('* * * * *', { timeZone: 'America/Maceio' })
  async tick(): Promise<void> {
    if (this.rodando) return; // tick anterior ainda enviando (Evolution lenta) — não empilha
    this.rodando = true;
    try {
      await this.processar(new Date());
    } catch (e: any) {
      this.logger.error(`${LOG} falha no tick: ${e?.message}`);
    } finally {
      this.rodando = false;
    }
  }

  async processar(agora: Date): Promise<number> {
    const rows = await this.prisma.globalSetting.findMany({
      where: {
        value: 'true',
        OR: [
          { key: { startsWith: ADMIN_AGENDAMENTO_KEY_PREFIX.IA } },
          { key: { startsWith: ADMIN_AGENDAMENTO_KEY_PREFIX.EQUIPE } },
        ],
      },
      select: { key: true, value: true, updated_at: true },
    });
    if (!rows.length) return 0;

    let total = 0;
    for (const [tenantId, ligados] of togglesPorClinica(rows)) {
      try {
        total += await this.processarClinica(tenantId, ligados, agora);
      } catch (e: any) {
        this.logger.warn(`${LOG} clínica ${tenantId}: ${e?.message}`);
      }
    }
    return total;
  }

  private async processarClinica(
    tenantId: string,
    ligados: Partial<Record<OrigemAgendamento, Date>>,
    agora: Date,
  ): Promise<number> {
    // Quem recebe cada origem (números da Central + ADMs com o aviso marcado no cadastro,
    // menos quem desligou). Origem sem ninguém NÃO busca/reivindica os eventos dela:
    // se alguém ligar dentro da janela de 2h, ainda avisa.
    const destinos: Partial<Record<OrigemAgendamento, DestinatarioAviso[]>> = {};
    const origens: any[] = [];
    for (const origem of ['IA', 'EQUIPE'] as const) {
      const desde = ligados[origem];
      if (!desde) continue;
      const lista = await adminAlertRecipients(this.prisma, tenantId, ADMIN_AGENDAMENTO_DISPARO[origem]);
      if (!lista.length) continue;
      destinos[origem] = lista;
      origens.push({ created_by_ai: origem === 'IA', created_at: { gte: inicioJanelaAviso(desde, agora) } });
    }
    if (!origens.length) {
      const ult = this.semNumeroLogadoEm.get(tenantId) || 0;
      if (agora.getTime() - ult > AVISO_SEM_NUMERO_MS) {
        this.semNumeroLogadoEm.set(tenantId, agora.getTime());
        this.logger.warn(
          `${LOG} clínica ${tenantId}: aviso de agendamento ligado mas SEM destinatário (nenhum número na Central e nenhum ADM com telefone e o aviso marcado no cadastro).`,
        );
      }
      return 0;
    }

    const eventos = await this.prisma.calendarEvent.findMany({
      where: {
        tenant_id: tenantId,
        admin_notified_at: null,
        parent_event_id: null, // série recorrente: só a 1ª (o pai) avisa
        type: { in: ADMIN_AGENDAMENTO_TIPOS },
        status: { in: ADMIN_AGENDAMENTO_STATUS },
        // registro retroativo (consulta que já passou) não é "novo agendamento"
        start_at: { gte: new Date(agoraNaiveMaceio(agora).getTime() - ADMIN_AGENDAMENTO_PASSADO_TOLERANCIA_MS) },
        AND: [
          { created_at: { lte: new Date(agora.getTime() - ADMIN_AGENDAMENTO_RESPIRO_MS) } },
          { OR: origens },
        ],
      },
      orderBy: { created_at: 'asc' },
      take: ADMIN_AGENDAMENTO_MAX_POR_TICK,
      select: {
        id: true,
        type: true,
        title: true,
        start_at: true,
        all_day: true,
        created_by_ai: true,
        recurrence_rule: true,
        patient_id: true,
        patient: { select: { name: true, phone: true } },
        lead: { select: { name: true, phone: true } },
        conversation: { select: { instance_name: true } },
        assigned_user: { select: { name: true } },
        created_by: { select: { name: true } },
        appointment_type: { select: { name: true } },
      },
    });
    if (!eventos.length) return 0;

    const assistentes = new Map<string, string>();
    let enviados = 0;
    for (const ev of eventos) {
      // CLAIM ATÔMICO antes de enviar (2 workers) — e só se ainda estiver marcado.
      const claim = await this.prisma.calendarEvent.updateMany({
        where: { id: ev.id, tenant_id: tenantId, admin_notified_at: null, status: { in: ADMIN_AGENDAMENTO_STATUS } },
        data: { admin_notified_at: new Date() },
      });
      if (claim.count === 0) continue;

      const origem: OrigemAgendamento = ev.created_by_ai ? 'IA' : 'EQUIPE';
      const assistente =
        origem === 'IA' ? await this.nomeAssistente(tenantId, ev.conversation?.instance_name, assistentes) : null;
      const nome = ev.patient?.name || ev.lead?.name || ev.title;
      const texto = montarTextoNovoAgendamento({
        pacienteNome: nome,
        telefone: ev.patient?.phone || ev.lead?.phone || null,
        startNaive: ev.start_at,
        allDay: ev.all_day,
        tipo: ev.type,
        tipoNome: ev.appointment_type?.name || null,
        dentista: ev.assigned_user?.name || null,
        origem,
        assistente,
        criadoPor: ev.created_by?.name || null,
        recorrencia: ev.recurrence_rule,
      });

      const r = await sendAdminAlert(this.prisma, this.settings, tenantId, {
        type: ADMIN_AGENDAMENTO_DISPATCH_TYPE,
        recipients: destinos[origem],
        text: texto,
        recipientName: nome,
        refEventId: ev.id,
        refPatientId: ev.patient_id,
      });
      if (r.sent > 0) enviados++;
    }
    if (enviados) this.logger.log(`${LOG} clínica ${tenantId}: ${enviados} aviso(s) de novo agendamento enviados aos ADMs`);
    return enviados;
  }

  /**
   * Nome da assistente (perfil da IA da clínica) do chip da conversa em que a IA
   * marcou; chip sem função = perfil COMERCIAL (mesma regra do webhook/worker).
   */
  private async nomeAssistente(
    tenantId: string,
    instanceName: string | null | undefined,
    cache: Map<string, string>,
  ): Promise<string> {
    let purpose: 'COMERCIAL' | 'CLINICA' | 'FINANCEIRO' = 'COMERCIAL';
    if (instanceName) {
      const inst = await this.prisma.instance
        .findFirst({ where: { name: instanceName }, select: { purpose: true } })
        .catch(() => null);
      if (isAiChipPurpose(inst?.purpose)) purpose = inst!.purpose as typeof purpose;
    }
    const hit = cache.get(purpose);
    if (hit) return hit;
    let nome = DEFAULT_ASSISTANT_NAME;
    try {
      const row = await this.prisma.tenantSetting.findUnique({
        where: { tenant_id_key: { tenant_id: tenantId, key: aiProfileKey(purpose) } },
        select: { value: true },
      });
      if (row?.value) nome = normalizeAiChipProfile(row.value).assistantName;
    } catch {
      /* padrão */
    }
    cache.set(purpose, nome);
    return nome;
  }
}

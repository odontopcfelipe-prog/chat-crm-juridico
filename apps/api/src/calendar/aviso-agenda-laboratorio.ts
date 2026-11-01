/**
 * F7 do laboratório — aviso ao cliente (dentista ou consultório) quando a coleta, a
 * prova ou a entrega é marcada ou muda de horário: WhatsApp pelo chip de Atendimento
 * e o e-mail de agenda da conta.
 *
 * Espelha o aviso da clínica (CalendarService.sendAppointmentEventWhatsapp), com o
 * texto do laboratório e sem os ramos que só a clínica tem (agenda do comercial,
 * ortodontia, anexos do card). Contato que ainda não é cliente recebe do mesmo jeito,
 * pelo chip de Atendimento.
 *
 * Função pura, sem provider Nest: o CalendarService passa as dependências (nada novo
 * no construtor, sem risco de ciclo de injeção). Nunca lança: falha só vira registro
 * no histórico de disparos e log.
 */
import type { Logger } from '@nestjs/common';
import {
  LAB_AGENDA_TEXTOS,
  LAB_AGENDA_TIPO_FRASE,
  aplicarTextoDoLaboratorio,
  enderecoDoCliente,
  horaCurtaNaive,
  tipoSoDoLaboratorio,
  type TenantAddressParts,
} from '@crm/shared';
import type { PrismaService } from '../prisma/prisma.service';
import type { WhatsappService } from '../whatsapp/whatsapp.service';
import type { EmailAutomationService } from '../email-automation/email-automation.service';

/** Linha do histórico de disparos (o logDispatch do CalendarService). */
export interface RegistroDoAvisoDoLaboratorio {
  tenantId: string;
  type: string;
  recipientName?: string | null;
  recipientPhone?: string | null;
  status: 'SENT' | 'FAILED';
  error?: string | null;
  externalMessageId?: string | null;
  refEventId?: string | null;
  refPatientId?: string | null;
}

export interface DepsAvisoDoLaboratorio {
  prisma: PrismaService;
  whatsapp: Pick<WhatsappService, 'sendText'>;
  emailAutomation: Pick<EmailAutomationService, 'dispatch'>;
  logger: Pick<Logger, 'log' | 'warn'>;
  /** Chip do aviso: Atendimento, depois Comercial; nunca o Financeiro. null = nenhum conectado. */
  resolverChip: (tenantId: string) => Promise<string | null>;
  /** Texto da remarcação da conta (o padrão do laboratório quando vazio). */
  textoDaRemarcacao: (tenantId: string) => Promise<string>;
  registrar: (p: RegistroDoAvisoDoLaboratorio) => Promise<void>;
}

/** O que o aviso usa do evento. */
export interface EventoDoAvisoDoLaboratorio {
  id?: string | null;
  type?: string | null;
  start_at?: Date | string | null;
  location?: string | null;
  assigned_user?: { name?: string | null } | null;
}

export interface PedidoDeAvisoDoLaboratorio {
  event: EventoDoAvisoDoLaboratorio;
  patientId?: string | null;
  leadId?: string | null;
  tenantId: string;
  kind: 'created' | 'rescheduled';
}

const MACEIO_OFFSET_MS = 3 * 60 * 60 * 1000;

const SELECT_CLIENTE = {
  name: true,
  phone: true,
  email: true,
  address: true,
  address_number: true,
  address_complement: true,
  neighborhood: true,
  city: true,
  state: true,
} as const;

/** 'DD/MM/AAAA' da agenda naive-UTC (o e-mail mostra o ano, como o da clínica). */
function dataLongaNaive(d: Date | string | null | undefined): string {
  const data = d instanceof Date ? d : new Date(d ?? '');
  if (Number.isNaN(data.getTime())) return '';
  const dd = String(data.getUTCDate()).padStart(2, '0');
  const mm = String(data.getUTCMonth() + 1).padStart(2, '0');
  return `${dd}/${mm}/${data.getUTCFullYear()}`;
}

/** Evolution respondeu erro em vez de lançar (instância fora, número sem WhatsApp). */
function envioRecusado(r: any): string | null {
  if (r && !(r?.statusCode >= 400) && !r?.error) return null;
  return `Evolution recusou o envio${r?.statusCode ? ` (HTTP ${r.statusCode})` : ''}${r?.error ? `: ${r.error}` : ' — instância pode estar offline'}`;
}

/**
 * Avisa o cliente da coleta, prova ou entrega marcada (`created`) ou remarcada
 * (`rescheduled`). Passos: tipo do laboratório; evento no passado não avisa; o
 * liga/desliga da Central (confirmação de agendamento ou reagendamento) corta o
 * WhatsApp e o e-mail; destinatário é o cadastro do cliente e, na falta, o contato;
 * o endereço é o local do evento ou o do cadastro do cliente (nunca o do laboratório).
 */
export async function avisarAgendaDoLaboratorio(
  deps: DepsAvisoDoLaboratorio,
  a: PedidoDeAvisoDoLaboratorio,
): Promise<{ sent: boolean; reason?: string }> {
  const { event, tenantId, kind } = a;
  const registro = kind === 'rescheduled' ? 'agendamento_remarcado' : 'agendamento_criado';
  const patientId = a.patientId || null;
  try {
    const tipo = event?.type;
    if (!tenantId || !tipoSoDoLaboratorio(tipo)) return { sent: false, reason: 'tipo_fora_da_agenda_do_laboratorio' };

    const realStartMs = new Date(event?.start_at ?? '').getTime() + MACEIO_OFFSET_MS;
    if (!Number.isFinite(realStartMs) || realStartMs < Date.now()) {
      deps.logger.log(`[LAB-AGENDA] evento ${event?.id} no passado — sem aviso (${kind}).`);
      return { sent: false, reason: 'evento_passado' };
    }

    const chave =
      kind === 'rescheduled' ? `APPOINTMENT_RESCHEDULED_ENABLED_${tenantId}` : `APPOINTMENT_CONFIRMATION_ENABLED_${tenantId}`;
    const ligado = await deps.prisma.globalSetting.findUnique({ where: { key: chave } }).catch(() => null);
    if ((ligado?.value ?? 'true') === 'false') {
      deps.logger.log(`[LAB-AGENDA] ${registro} desligado na Central da conta ${tenantId} (evento ${event?.id}).`);
      return { sent: false, reason: 'desligado' };
    }

    let nome: string | null = null;
    let telefone: string | null = null;
    let email: string | null = null;
    let cadastro: TenantAddressParts | null = null;
    if (patientId) {
      const p = await deps.prisma.patient.findUnique({ where: { id: patientId }, select: SELECT_CLIENTE }).catch(() => null);
      if (p) {
        nome = p.name || null;
        telefone = p.phone || null;
        email = p.email || null;
        cadastro = p;
      }
    }
    if (a.leadId && (!telefone || !email || !nome)) {
      const l = await deps.prisma.lead
        .findUnique({ where: { id: a.leadId }, select: { name: true, phone: true, email: true } })
        .catch(() => null);
      nome = nome || l?.name || null;
      telefone = telefone || l?.phone || null;
      email = email || l?.email || null;
    }

    const conta = await deps.prisma.tenant.findUnique({ where: { id: tenantId }, select: { name: true } }).catch(() => null);
    const local = enderecoDoCliente(event.location, cadastro);
    const modelo =
      kind === 'rescheduled'
        ? (await deps.textoDaRemarcacao(tenantId)) || LAB_AGENDA_TEXTOS.remarcacao
        : LAB_AGENDA_TEXTOS.avisoAgendado;
    const mensagem = aplicarTextoDoLaboratorio(modelo, {
      nomeDoCliente: nome,
      tipo,
      inicio: event.start_at,
      local,
      laboratorio: conta?.name,
      protetico: event.assigned_user?.name,
    });

    let resultado: { sent: boolean; reason?: string };
    if (!telefone) {
      deps.logger.warn(`[LAB-AGENDA] ${registro}: cliente sem telefone no cadastro (evento ${event.id}).`);
      resultado = { sent: false, reason: LAB_AGENDA_TEXTOS.semTelefone };
    } else {
      const chip = await deps.resolverChip(tenantId);
      if (!chip) {
        deps.logger.warn(`[LAB-AGENDA] ${registro}: sem chip de Atendimento conectado na conta ${tenantId}.`);
        await deps.registrar({
          tenantId, type: registro, recipientName: nome, recipientPhone: telefone, status: 'FAILED',
          error: LAB_AGENDA_TEXTOS.semChip, refEventId: event.id ?? null, refPatientId: patientId,
        });
        resultado = { sent: false, reason: LAB_AGENDA_TEXTOS.semChip };
      } else {
        const r: any = await deps.whatsapp.sendText(telefone, mensagem, chip, undefined, tenantId);
        const recusa = envioRecusado(r);
        if (recusa) {
          deps.logger.warn(`[LAB-AGENDA] ${registro} falhou no envio (evento ${event.id}): ${recusa}`);
          await deps.registrar({
            tenantId, type: registro, recipientName: nome, recipientPhone: telefone, status: 'FAILED',
            error: recusa, refEventId: event.id ?? null, refPatientId: patientId,
          });
          resultado = { sent: false, reason: recusa };
        } else {
          deps.logger.log(`[LAB-AGENDA] ${registro} enviado ao cliente (evento ${event.id}).`);
          await deps.registrar({
            tenantId, type: registro, recipientName: nome, recipientPhone: telefone, status: 'SENT',
            externalMessageId: r?.data?.key?.id ?? null, refEventId: event.id ?? null, refPatientId: patientId,
          });
          resultado = { sent: true };
        }
      }
    }

    if (email) {
      await deps.emailAutomation.dispatch(registro, tenantId, email, {
        cliente_nome: nome || '',
        tipo: LAB_AGENDA_TIPO_FRASE[tipo],
        data: dataLongaNaive(event.start_at),
        hora: horaCurtaNaive(event.start_at),
        local: local || LAB_AGENDA_TEXTOS.localACombinar,
      });
    }
    return resultado;
  } catch (e: any) {
    deps.logger.warn(`[LAB-AGENDA] ${registro} falhou: ${e?.message}`);
    await deps
      .registrar({ tenantId, type: registro, status: 'FAILED', error: e?.message ?? null, refEventId: event?.id ?? null, refPatientId: patientId })
      .catch(() => undefined);
    return { sent: false, reason: e?.message || 'falha ao avisar' };
  }
}

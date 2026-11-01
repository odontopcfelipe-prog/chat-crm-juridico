/**
 * F7 do laboratório — lembretes de 48 h e de 24 h da coleta, da prova e da entrega
 * (fila calendar-reminders). O CalendarReminderWorker decide se o lembrete é do
 * laboratório (lembreteDoLaboratorioSai), faz o mesmo claim atômico da clínica e
 * chama enviarLembreteDoLaboratorio no lugar do envio da clínica.
 *
 * O cliente do laboratório é o dentista ou o consultório: o texto sai do
 * REMINDER_CONFIG da conta (com o padrão do laboratório por baixo), o endereço é o
 * do cadastro do cliente (nunca o do laboratório) e o chip é o de Atendimento da
 * própria conta (função CLINICA; nunca o Financeiro, nunca o de outra conta). Sem
 * IA: a mensagem fica arquivada na conversa do contato e a equipe marca a resposta
 * na agenda (nada de ai_mode nem reminder_context). Sem anexos.
 *
 * Funções puras (sem Nest): as dependências chegam do worker.
 */
import {
  ANTECEDENCIAS_DO_LABORATORIO,
  LAB_AGENDA_TEXTOS,
  REMINDER_CONFIG_PADRAO_DO_LABORATORIO,
  aplicarTextoDoLaboratorio,
  chaveDoLembreteDoLaboratorio,
  enderecoDoCliente,
  tipoSoDoLaboratorio,
} from '@crm/shared';
import { semVariaveis, temVocabularioDeClinica } from '../payment-gateway/cobranca-laboratorio';
import { evolutionSendFailed, type WhatsappService } from '../whatsapp/whatsapp.service';

/** O que o portão precisa do evento (a conta dele e a do contato/cadastro). */
export interface EventoDoPortao {
  tenant_id?: string | null;
  type?: string | null;
  lead?: { tenant_id?: string | null } | null;
  patient?: { tenant_id?: string | null } | null;
}

/**
 * O lembrete é do laboratório e sai? Exige: conta do evento no conjunto de
 * laboratórios; contato e cadastro ausentes ou da MESMA conta; COLETA, PROVA ou
 * ENTREGA; canal WHATSAPP; 48 h ou 24 h. Fora disso o worker sai sem reivindicar
 * (como antes da F7): tarefa, outro, tipo de clínica, 1 h, 15 min, e-mail, evento
 * legado sem conta e contato de outra conta.
 */
export function lembreteDoLaboratorioSai(
  event: EventoDoPortao,
  channel: string,
  minutes: number,
  labs: ReadonlySet<string>,
): boolean {
  const conta = event?.tenant_id;
  if (!conta || !labs.has(conta)) return false;
  const mesmaConta = (x: { tenant_id?: string | null } | null | undefined) => x == null || x.tenant_id === conta;
  if (!mesmaConta(event.lead) || !mesmaConta(event.patient)) return false;
  if (!tipoSoDoLaboratorio(event.type)) return false;
  if (channel !== 'WHATSAPP') return false;
  return ANTECEDENCIAS_DO_LABORATORIO.includes(Number(minutes));
}

export interface DepsDoLembreteDoLaboratorio {
  prisma: any;
  whatsapp: Pick<WhatsappService, 'sendText'>;
  /** Chip de Atendimento da conta (função CLINICA, nunca o Financeiro); null = sem chip. */
  resolverChip: (tenantId: string) => Promise<string | null>;
  logger: { log: (m: string) => void; warn: (m: string) => void };
}

/** Texto do lembrete: o da conta (se não estiver vazio nem falar de clínica) ou o padrão do laboratório. */
async function textoDoLembrete(prisma: any, conta: string, minutesBefore: number): Promise<string> {
  const chave = chaveDoLembreteDoLaboratorio(minutesBefore);
  const padrao = REMINDER_CONFIG_PADRAO_DO_LABORATORIO.templates[chave];
  let daConta: unknown;
  try {
    const row = await prisma.globalSetting.findUnique({ where: { key: `REMINDER_CONFIG_${conta}` } });
    if (row?.value) {
      const parsed = JSON.parse(row.value);
      daConta = { ...REMINDER_CONFIG_PADRAO_DO_LABORATORIO.templates, ...(parsed?.templates || {}) }[chave];
    }
  } catch {
    daConta = undefined; // config ilegível: vale o padrão
  }
  if (typeof daConta !== 'string' || !daConta.trim()) return padrao;
  if (temVocabularioDeClinica(semVariaveis(daConta))) return padrao;
  return daConta;
}

/**
 * Envia o lembrete do laboratório. Lança Error com o motivo (o worker grava FAILED,
 * devolve o claim e avisa a equipe), como o envio da clínica.
 */
export async function enviarLembreteDoLaboratorio(
  deps: DepsDoLembreteDoLaboratorio,
  event: any,
  minutesBefore: number,
): Promise<{ externalMsgId: string | null }> {
  const { prisma, whatsapp, resolverChip, logger } = deps;
  const conta: string = event.tenant_id;

  const telefoneBruto: string = event.patient?.phone || event.lead?.phone || '';
  const telefone = String(telefoneBruto).replace(/\D/g, '');
  if (!telefone) throw new Error(LAB_AGENDA_TEXTOS.semTelefone);

  // Cadastro do cliente: nome, contato e endereço (o {local} é o do consultório dele).
  const cadastro = event.patient_id
    ? await prisma.patient
        .findUnique({
          where: { id: event.patient_id },
          select: {
            name: true,
            lead_id: true,
            address: true,
            address_number: true,
            address_complement: true,
            neighborhood: true,
            city: true,
            state: true,
          },
        })
        .catch(() => null)
    : null;
  const modelo = await textoDoLembrete(prisma, conta, minutesBefore);
  // Nome do laboratório só quando o texto usa {clinica}.
  const laboratorio = modelo.includes('{clinica}')
    ? await prisma.tenant.findUnique({ where: { id: conta }, select: { name: true } }).catch(() => null)
    : null;
  const texto = aplicarTextoDoLaboratorio(modelo, {
    nomeDoCliente: cadastro?.name || event.patient?.name || event.lead?.name || '',
    tipo: event.type,
    inicio: event.start_at,
    local: enderecoDoCliente(event.location, cadastro),
    laboratorio: laboratorio?.name || '',
    protetico: event.assigned_user?.name || '',
  });

  const chip = await resolverChip(conta);
  if (!chip) {
    logger.warn(`[LAB-LEMBRETE] evento ${event.id}: conta ${conta} sem chip de Atendimento`);
    throw new Error(LAB_AGENDA_TEXTOS.semChip);
  }

  const resultado: any = await whatsapp.sendText(telefone, texto, chip, undefined, conta);
  if (evolutionSendFailed(resultado)) {
    throw new Error(
      `Evolution recusou o envio (chip ${chip}): ` +
        `${String(resultado?.statusCode ?? '')} ${String(resultado?.error ?? 'número sem WhatsApp').slice(0, 200)}`.trim(),
    );
  }
  const externalMsgId: string | null = resultado?.data?.key?.id || null;
  logger.log(`[LAB-LEMBRETE] ${minutesBefore}min enviado (evento ${event.id}, chip ${chip})`);

  // Arquiva na conversa do contato, fora do Financeiro. Só last_message_at: sem IA.
  const contatoId: string | null = event.lead_id || cadastro?.lead_id || null;
  if (contatoId) {
    try {
      const conversa = await prisma.conversation.findFirst({
        where: {
          lead_id: contatoId,
          status: { not: 'ENCERRADO' },
          NOT: { inbox: { purpose: 'FINANCEIRO' } },
        },
        orderBy: { last_message_at: 'desc' },
        select: { id: true },
      });
      if (conversa) {
        await prisma.message.create({
          data: {
            conversation_id: conversa.id,
            direction: 'out',
            type: 'text',
            text: texto,
            external_message_id: externalMsgId || `sys_reminder_${Date.now()}`,
            status: 'enviado',
          },
        });
        await prisma.conversation.update({
          where: { id: conversa.id },
          data: { last_message_at: new Date() },
        });
      } else {
        logger.warn(`[LAB-LEMBRETE] evento ${event.id}: contato sem conversa fora do Financeiro — lembrete saiu, mas não foi arquivado`);
      }
    } catch (e: any) {
      logger.warn(`[LAB-LEMBRETE] evento ${event.id}: não arquivou na conversa: ${e?.message}`);
    }
  }

  return { externalMsgId };
}

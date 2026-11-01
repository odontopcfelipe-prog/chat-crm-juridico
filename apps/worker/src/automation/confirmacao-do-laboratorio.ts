/**
 * F7 do laboratório — confirmação da véspera (24 h antes) da coleta, da prova e da
 * entrega. O agendador da clínica (AppointmentConfirmationSchedulerService) continua
 * com a busca e o laço dele; esta busca é separada, só nas contas de laboratório, e
 * roda depois dela (e só quando existe algum laboratório).
 *
 * Diferenças para a clínica: tipos COLETA, PROVA e ENTREGA; o texto é o
 * APPOINTMENT_CONFIRMATION_TEMPLATE da conta ou o padrão do laboratório, com o nome
 * do cliente sem Dr./Dra., o tipo em minúsculas, DD/MM e HH:MM da agenda e o endereço
 * do consultório do cliente; sem o desconto da confirmação de 48 h (no laboratório a
 * de 48 h é só lembrete) e sem olhar se o contato ainda está em captação (vale o
 * cadastro do cliente ou, sem ele, o contato do evento). A trava
 * contra 2 workers é a mesma da clínica: advisory lock por agendamento + conferência
 * dentro da transação. O envio é do dispatcher (mesmo claim da clínica).
 *
 * Função pura (sem Nest): o agendador passa o prisma e o logger.
 */
import {
  LAB_AGENDA_TEXTOS,
  TIPOS_AVISO_LAB,
  aplicarTextoDoLaboratorio,
  enderecoDoCliente,
  tipoSoDoLaboratorio,
} from '@crm/shared';

export interface JanelaDaConfirmacao {
  /** Início da janela (naive-UTC, 24 h à frente). */
  in24h: Date;
  /** Fim da janela (naive-UTC, 25 h à frente). */
  in25h: Date;
  /** Hora real da execução (vira scheduled_for). */
  now: Date;
}

/** Texto salvo na conta ({template}) ou '' quando não há texto utilizável. */
function textoSalvo(valor: string | null | undefined): string {
  let parsed: any = null;
  try {
    parsed = valor ? JSON.parse(valor) : null;
  } catch {
    parsed = null;
  }
  return parsed && typeof parsed.template === 'string' && parsed.template.trim() ? String(parsed.template) : '';
}

export async function agendarConfirmacoesDoLaboratorio(
  prisma: any,
  labs: ReadonlySet<string>,
  janela: JanelaDaConfirmacao,
  logger: { log: (m: string) => void; warn: (m: string) => void },
): Promise<{ criadas: number; puladas: number }> {
  let criadas = 0;
  let puladas = 0;
  if (!labs.size) return { criadas, puladas };

  const eventos: any[] = await prisma.calendarEvent.findMany({
    where: {
      tenant_id: { in: [...labs] },
      type: { in: [...TIPOS_AVISO_LAB] },
      status: 'AGENDADO',
      OR: [{ patient_id: { not: null } }, { lead_id: { not: null } }],
      start_at: { gte: janela.in24h, lt: janela.in25h },
    },
    select: {
      id: true,
      tenant_id: true,
      type: true,
      title: true,
      start_at: true,
      location: true,
      assigned_user: { select: { name: true } },
      lead: { select: { name: true, phone: true, tenant_id: true } },
      patient: {
        select: {
          id: true,
          name: true,
          phone: true,
          tenant_id: true,
          address: true,
          address_number: true,
          address_complement: true,
          neighborhood: true,
          city: true,
          state: true,
        },
      },
    },
  });

  const ligadaPorConta = new Map<string, boolean>();
  const textoPorConta = new Map<string, string>();
  const nomePorConta = new Map<string, string>();

  for (const ev of eventos) {
    // Conferência antes de ler qualquer chave: tipo do laboratório, conta de
    // laboratório e cadastro/contato da MESMA conta do evento.
    const conta: string | null = ev?.tenant_id ?? null;
    const daConta = (x: { tenant_id?: string | null } | null | undefined) => !x || x.tenant_id === conta;
    if (!conta || !labs.has(conta) || !tipoSoDoLaboratorio(ev.type) || (!ev.patient && !ev.lead) || !daConta(ev.patient) || !daConta(ev.lead)) {
      puladas++;
      continue;
    }
    const telefone: string = ev.patient?.phone || ev.lead?.phone || '';
    if (!telefone) {
      puladas++;
      continue;
    }

    // Mesmo liga/desliga da clínica (padrão ligado).
    let ligada = ligadaPorConta.get(conta);
    if (ligada === undefined) {
      const s = await prisma.globalSetting.findUnique({ where: { key: `APPOINTMENT_CONFIRMATION_ENABLED_${conta}` } });
      ligada = (s?.value ?? 'true') !== 'false';
      ligadaPorConta.set(conta, ligada);
    }
    if (!ligada) {
      puladas++;
      continue;
    }

    const existente = await prisma.appointmentConfirmation.findFirst({
      where: { appointment_id: ev.id, channel: 'WHATSAPP' },
    });
    if (existente) {
      puladas++;
      continue;
    }

    let modelo = textoPorConta.get(conta);
    if (modelo === undefined) {
      const s = await prisma.globalSetting.findUnique({ where: { key: `APPOINTMENT_CONFIRMATION_TEMPLATE_${conta}` } });
      modelo = textoSalvo(s?.value) || LAB_AGENDA_TEXTOS.confirmacao24h;
      textoPorConta.set(conta, modelo);
    }

    // Nome do laboratório só quando o texto usa {clinica}.
    let laboratorio = '';
    if (modelo.includes('{clinica}')) {
      const cache = nomePorConta.get(conta);
      if (cache !== undefined) {
        laboratorio = cache;
      } else {
        const t = await prisma.tenant.findUnique({ where: { id: conta }, select: { name: true } }).catch(() => null);
        laboratorio = String(t?.name ?? '').trim();
        nomePorConta.set(conta, laboratorio);
      }
    }

    const mensagem = aplicarTextoDoLaboratorio(modelo, {
      nomeDoCliente: ev.patient?.name || ev.lead?.name,
      tipo: ev.type,
      inicio: ev.start_at,
      local: enderecoDoCliente(ev.location, ev.patient),
      laboratorio,
      protetico: ev.assigned_user?.name || '',
    });

    // Mesma trava da clínica: lock por agendamento e conferência dentro da transação.
    await prisma.$transaction(async (tx: any) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${ev.id}))`;
      const dup = await tx.appointmentConfirmation.findFirst({
        where: { appointment_id: ev.id, channel: 'WHATSAPP' },
        select: { id: true },
      });
      if (dup) return;
      await tx.appointmentConfirmation.create({
        data: {
          appointment_id: ev.id,
          channel: 'WHATSAPP',
          scheduled_for: janela.now,
          message_text: mensagem,
          response_status: 'PENDENTE',
        },
      });
      criadas++;
    });
  }

  if (criadas > 0 || puladas > 0) {
    logger.log(`[ConfirmationScheduler] laboratório: ${criadas} criada(s), ${puladas} pulada(s)`);
  }
  return { criadas, puladas };
}

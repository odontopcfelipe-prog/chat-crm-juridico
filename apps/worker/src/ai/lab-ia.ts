/**
 * IA no atendimento do LABORATÓRIO: a mesma máquina do ai.processor, com as camadas
 * de texto daqui. Módulo-folha (funções puras com o Prisma por parâmetro).
 *
 * Quem decide o caminho é vereditoIaDaConversa, uma vez por job:
 *  - 'clinica': nenhum id é de laboratório. O processor segue como sempre;
 *  - 'nao_responde': laboratório sem a chave da conta, conta fora de ACTIVE, contas
 *    misturadas ou dúvida na leitura. Nunca cai no prompt da clínica;
 *  - 'laboratorio': responde com as camadas deste arquivo.
 *
 * As skills da tabela PromptSkill são globais e nenhuma vale para o laboratório. A
 * skill daqui tem o formato que o processor espera e `id: null`, porque Message.skill_id
 * é chave estrangeira para PromptSkill.
 */
import {
  ANTECEDENCIAS_DO_LABORATORIO,
  algumLab,
  chipDoLabComIa,
  clinicStatusNow,
  contaDoLabLiberaIa,
  contaUnicaDaConversa,
  getLabTenantIds,
  isAiChipPurpose,
  BT_LABORATORIO,
  leituraDeLabsFalhou,
  nomeSalvoDaIa,
  rotuloTipoDoLaboratorio,
  tipoSoDoLaboratorio,
  type AiChipPurpose,
  type AiReplyLength,
  type ClinicHours,
  type TipoDoLaboratorio,
} from '@crm/shared';
import { detectPatientStyle, type PatientStyle } from './conversation-guide';
import { findDentistConflict } from './tool-handlers/book-appointment';
import { isHolidayMatch } from './tool-handlers/check-availability';
import { REMINDER_MIN_DELAY_MS, isPastNaive, reminderDelayMs } from './scheduling-safety';
import type { HistorySender } from './history-sender';
import {
  LAB_IA_AGENDA_DESLIGADA,
  LAB_IA_AGENDA_LIGADA,
  LAB_IA_BASE,
  LAB_IA_CATALOGO,
  LAB_IA_EQUIPE,
  LAB_IA_ESTILO_ESCOLHIDO,
  LAB_IA_ESTILO_ESPELHO,
  LAB_IA_FALLBACK,
  LAB_IA_FINAIS_ATENDIMENTO,
  LAB_IA_FINAIS_FINANCEIRO,
  LAB_IA_FINANCEIRO,
  LAB_IA_INSTRUCAO,
  LAB_IA_LEMBRETE,
  LAB_IA_MIDIA,
  LAB_IA_NOME_PADRAO,
  LAB_IA_RECUSA,
  LAB_IA_SITUACAO,
  LAB_IA_SKILL_ATENDIMENTO,
  LAB_IA_SKILL_COMERCIAL,
  LAB_IA_SKILL_FINANCEIRO,
  LAB_IA_VISITAS,
} from './lab-ia-textos';

// ─── Veredito ────────────────────────────────────────────────────────────────

export type VereditoIaDaConversa =
  | { tipo: 'clinica' }
  | { tipo: 'nao_responde'; motivo: string }
  | { tipo: 'laboratorio'; tenantId: string; purpose: AiChipPurpose };

export type IaDoLaboratorio = Extract<VereditoIaDaConversa, { tipo: 'laboratorio' }>;

/**
 * De quem é a conversa e se a IA do laboratório pode responder. Conta de clínica faz as
 * mesmas leituras de antes: a lista cacheada de laboratórios e, se houver laboratório
 * cadastrado, a linha do chip.
 */
export async function vereditoIaDaConversa(
  prisma: any,
  convo: { tenant_id?: string | null; instance_name?: string | null; lead?: { tenant_id?: string | null } | null },
  opts: { dryRun?: boolean; purposeDoTeste?: unknown; segundaTentativa?: boolean; avisar?: (m: string) => void } = {},
): Promise<VereditoIaDaConversa> {
  const labs = await getLabTenantIds(prisma, opts.avisar);
  const leituraFalhou = leituraDeLabsFalhou();
  if (!labs.size && !leituraFalhou) return { tipo: 'clinica' };

  const idsDaConversa = [convo?.tenant_id, convo?.lead?.tenant_id];
  let chip: { tenant_id?: string | null; purpose?: string | null } | null = null;
  if (convo?.instance_name) {
    try {
      chip = await prisma.instance.findFirst({
        where: { name: convo.instance_name },
        select: { tenant_id: true, purpose: true },
      });
    } catch {
      return { tipo: 'nao_responde', motivo: 'não deu para ler o chip da conversa' };
    }
  }
  const ids = [...idsDaConversa, chip?.tenant_id];
  if (!algumLab(labs, ids)) {
    if (!leituraFalhou) return { tipo: 'clinica' };
    // A lista cacheada falhou há pouco: confere direto só as contas desta conversa, para a
    // clínica não ficar sem resposta até o cache vencer.
    try {
      const contas = ids.filter((t): t is string => typeof t === 'string' && t !== '');
      const achados = await prisma.tenantBusinessProfile.findMany({
        where: { tenant_id: { in: contas }, business_type: BT_LABORATORIO },
        select: { tenant_id: true },
      });
      if (!achados.length) return { tipo: 'clinica' };
    } catch {
      return { tipo: 'nao_responde', motivo: 'não deu para ler quais contas são laboratório' };
    }
  }

  const conta = contaUnicaDaConversa(ids);
  if (!conta) return { tipo: 'nao_responde', motivo: 'conversa, contato e chip de contas diferentes' };
  if (opts.segundaTentativa) return { tipo: 'nao_responde', motivo: 'o laboratório não tem 2ª tentativa' };

  if (opts.dryRun) {
    // Chat de teste: vale antes de ligar o chip, mas gasta a chave compartilhada.
    if (!isAiChipPurpose(opts.purposeDoTeste)) return { tipo: 'nao_responde', motivo: 'teste sem chip escolhido' };
    if (!(await contaDoLabLiberaIa(prisma, conta))) return { tipo: 'nao_responde', motivo: 'conta fora de ACTIVE' };
    return { tipo: 'laboratorio', tenantId: conta, purpose: opts.purposeDoTeste };
  }

  const purpose = chip?.purpose;
  if (!isAiChipPurpose(purpose)) return { tipo: 'nao_responde', motivo: 'chip sem função' };
  if (!(await chipDoLabComIa(prisma, conta, purpose))) {
    return { tipo: 'nao_responde', motivo: `IA do chip ${purpose} desligada ou conta fora de ACTIVE` };
  }
  return { tipo: 'laboratorio', tenantId: conta, purpose };
}

// ─── Skills e camadas do prompt ──────────────────────────────────────────────

export function skillDoLaboratorio(purpose: AiChipPurpose) {
  const eFinanceiro = purpose === 'FINANCEIRO';
  return {
    id: null as string | null,
    name: `Laboratório ${purpose}`,
    area: `laboratorio-${purpose.toLowerCase()}`,
    purpose,
    system_prompt: eFinanceiro
      ? LAB_IA_SKILL_FINANCEIRO
      : purpose === 'CLINICA'
        ? LAB_IA_SKILL_ATENDIMENTO
        : LAB_IA_SKILL_COMERCIAL,
    // null = o modelo padrão da plataforma (a conta não escolhe modelo).
    model: null as string | null,
    provider: 'openai',
    max_tokens: 600,
    max_context_tokens: 4000,
    temperature: 0.4,
    handoff_signal: null as string | null,
    tools: [] as any[],
    assets: [] as any[],
  };
}

/** As camadas de texto que o ai.processor passa ao PromptBuilder na conversa de laboratório. */
export function camadasDoPromptDoLaboratorio(purpose: AiChipPurpose) {
  return {
    mediaCapabilities: LAB_IA_MIDIA,
    behaviorRules: LAB_IA_BASE,
    finalRules: purpose === 'FINANCEIRO' ? LAB_IA_FINAIS_FINANCEIRO : LAB_IA_FINAIS_ATENDIMENTO,
  };
}

export function instrucaoDoTurnoDoLaboratorio(tamanho: string): string {
  return `${LAB_IA_INSTRUCAO} ${tamanho}`;
}

export function regraDeAgendaDoLaboratorio(autobook: boolean): string {
  return autobook ? LAB_IA_AGENDA_LIGADA : LAB_IA_AGENDA_DESLIGADA;
}

/** Texto do tamanho da resposta: o estilo o processor já calculou (resolveReplyStyle). */
export function estiloDoLaboratorio(
  replyLength: AiReplyLength,
  style: PatientStyle,
  chronological: { direction: string; text?: string | null }[],
): string {
  if (replyLength !== 'auto') return LAB_IA_ESTILO_ESCOLHIDO[style];
  return LAB_IA_ESTILO_ESPELHO[detectPatientStyle(chronological)];
}

export function contatoDoLaboratorio(isClient: boolean): string {
  return isClient ? LAB_IA_FALLBACK.contatoCliente : LAB_IA_FALLBACK.contatoNovo;
}

/** Nome da IA: o que a conta salvou no perfil do chip; sem ele, o padrão neutro. */
export function nomeDaIaDoLaboratorio(perfilSalvo: unknown, purpose: AiChipPurpose): string {
  return nomeSalvoDaIa(perfilSalvo) || LAB_IA_NOME_PADRAO[purpose];
}

/** "Situação agora" do prompt, no vocabulário do laboratório. */
export function situacaoAgoraDoLaboratorio(
  hours: ClinicHours | null | undefined,
  feriado: boolean,
  temHorarioEmTexto: boolean,
  nowLocal: Date = new Date(Date.now() - 3 * 60 * 60 * 1000),
): string {
  if (feriado) return LAB_IA_SITUACAO.feriado;
  const status = clinicStatusNow(hours, nowLocal);
  if (status) return status.text.replace(/a clínica/g, 'o laboratório');
  return temHorarioEmTexto ? LAB_IA_SITUACAO.semGrade : LAB_IA_SITUACAO.semHorario;
}

// ─── Catálogo (só da própria conta) ──────────────────────────────────────────

const moeda = (v: number) => v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

export interface ServicoDoCatalogo {
  name: string;
  base_price: unknown;
  lab_spec?: { lead_time_days?: number | null; default_material?: string | null } | null;
}

/** Preço 0 ou sem preço não é preço: a IA diz que vai confirmar com a equipe. */
export function formatarCatalogo(servicos: ServicoDoCatalogo[]): string {
  if (!servicos.length) return LAB_IA_CATALOGO.vazio;
  const linhas = servicos.map((s) => {
    const preco = Number(s.base_price ?? 0);
    const dias = Number(s.lab_spec?.lead_time_days ?? 0);
    const material = String(s.lab_spec?.default_material ?? '').trim();
    const partes = [
      preco > 0 ? moeda(preco) : LAB_IA_CATALOGO.semPreco,
      dias > 0 ? LAB_IA_CATALOGO.prazo(dias) : LAB_IA_CATALOGO.semPrazo,
      ...(material ? [LAB_IA_CATALOGO.material(material)] : []),
    ];
    return `- ${s.name}: ${partes.join('; ')}`;
  });
  return `${LAB_IA_CATALOGO.cabecalho}\n${linhas.join('\n')}`;
}

export async function carregarCatalogoDoLaboratorio(prisma: any, tenantId: string): Promise<string> {
  const servicos: ServicoDoCatalogo[] = await prisma.procedure.findMany({
    where: { tenant_id: tenantId, active: true },
    orderBy: { name: 'asc' },
    take: 200,
    select: { name: true, base_price: true, lab_spec: { select: { lead_time_days: true, default_material: true } } },
  });
  return formatarCatalogo(servicos);
}

// ─── Blocos de contexto ──────────────────────────────────────────────────────

const doisDigitos = (n: number) => String(n).padStart(2, '0');

/** Agenda naive-UTC: DD/MM/AAAA HH:MM saem por getUTC*. Só tipo, data e local (o título é livre). */
export function proximasVisitasDoLaboratorio(
  eventos: { type: string; start_at: Date; location?: string | null }[],
): string {
  if (!eventos.length) return LAB_IA_FALLBACK.semProximasVisitas;
  const linhas = eventos.map((e) => {
    const d = e.start_at;
    const quando = `${doisDigitos(d.getUTCDate())}/${doisDigitos(d.getUTCMonth() + 1)}/${d.getUTCFullYear()} ${doisDigitos(d.getUTCHours())}:${doisDigitos(d.getUTCMinutes())}`;
    return LAB_IA_VISITAS.linha(rotuloTipoDoLaboratorio(e.type), quando, e.location || null);
  });
  return `${LAB_IA_VISITAS.cabecalho}\n${linhas.join('\n')}\n`;
}

/** Bloco do lembrete que o contato pode estar respondendo (até 48 h depois). */
export function lembreteDoLaboratorio(ctx: any, agoraMs: number = Date.now()): string {
  if (!ctx?.sent_at) return '';
  const horas = Math.round((agoraMs - new Date(ctx.sent_at).getTime()) / 3_600_000);
  if (!(horas < 48)) return '';
  const quando = horas === 0 ? LAB_IA_LEMBRETE.menosDeUmaHora : LAB_IA_LEMBRETE.horas(horas);
  return LAB_IA_LEMBRETE.montar(
    quando,
    rotuloTipoDoLaboratorio(ctx.type),
    String(ctx.event_date || ''),
    String(ctx.message_sent || '').slice(0, 500),
  );
}

/** Resumo financeiro no vocabulário do laboratório (os dados vêm de loadFinanceiroContext). */
export function resumoFinanceiroDoLaboratorio(fin: {
  patientId: string | null;
  pagas?: number;
  sendable: { amount: number; dueDate: Date | null; status: string }[];
}): string {
  if (!fin.patientId) return LAB_IA_FINANCEIRO.semCadastro;
  const pagas = fin.pagas ?? 0;
  if (!fin.sendable.length) {
    return pagas > 0 ? LAB_IA_FINANCEIRO.quitado(pagas) : LAB_IA_FINANCEIRO.semCobranca;
  }
  const ddmm = (d: Date | null) => (d ? `${doisDigitos(d.getUTCDate())}/${doisDigitos(d.getUTCMonth() + 1)}` : '-');
  const vencidas = fin.sendable.filter((c) => c.status === 'OVERDUE');
  const soma = (l: { amount: number }[]) => moeda(l.reduce((s, c) => s + c.amount, 0));
  const proxima = fin.sendable[0];
  return [
    LAB_IA_FINANCEIRO.cabecalho,
    LAB_IA_FINANCEIRO.pagas(pagas),
    LAB_IA_FINANCEIRO.emAberto(fin.sendable.length, soma(fin.sendable)),
    vencidas.length ? LAB_IA_FINANCEIRO.atrasadas(vencidas.length, soma(vencidas)) : LAB_IA_FINANCEIRO.semAtrasadas,
    LAB_IA_FINANCEIRO.proxima(ddmm(proxima.dueDate), moeda(proxima.amount)),
    LAB_IA_FINANCEIRO.lista,
    ...fin.sendable.map((c, i) => LAB_IA_FINANCEIRO.linha(i + 1, ddmm(c.dueDate), moeda(c.amount), c.status === 'OVERDUE')),
  ].join('\n');
}

export function avisoFinanceiroDoLaboratorio(lead: { name?: string | null; phone?: string | null } | null, resumo: string): string {
  return LAB_IA_FINANCEIRO.aviso(
    lead?.name || LAB_IA_FINANCEIRO.semNome,
    lead?.phone || LAB_IA_FINANCEIRO.semNumero,
    resumo || LAB_IA_FINANCEIRO.semResumo,
  );
}

// ─── Histórico ───────────────────────────────────────────────────────────────

/**
 * Prefixo do turno 'assistant' no laboratório. A mensagem da IA do laboratório fica sem
 * skill_id (Message.skill_id aponta para PromptSkill), então não dá para separar da
 * mensagem da equipe: as duas vão sem rótulo. Só a automática leva rótulo.
 */
export function prefixoDoTurnoNoLaboratorio(sender: HistorySender): string {
  return sender === 'automation' ? `${LAB_IA_FALLBACK.rotuloAutomatica}: ` : '';
}

export function tirarRotuloDoLaboratorio(texto: string): string {
  return texto.replace(/^[ \t]*\[Mensagem automática do laboratório\]:[ \t]*/gim, '');
}

// ─── O que o modelo devolve em updates ───────────────────────────────────────

/** Motivo de passar para a equipe. `bruta`: a resposta crua, para o JSON truncado. */
export function lerPassarEquipe(updates: any, bruta?: string | null): string | null {
  const direto = updates?.passar_equipe;
  if (typeof direto === 'string' && direto.trim() && direto.trim() !== 'null') return direto.trim().slice(0, 500);
  if (direto === true) return LAB_IA_EQUIPE.motivoPadrao;
  const m = String(bruta || '').match(/"passar_equipe"\s*:\s*"((?:[^"\\]|\\.)+)"/);
  return m ? m[1].replace(/\\n/g, ' ').replace(/\\"/g, '"').trim().slice(0, 500) : null;
}

export interface VisitaPedida {
  tipo: TipoDoLaboratorio;
  date: string;
  time: string;
}

/** updates.visita válida (só COLETA, PROVA ou ENTREGA); qualquer outra coisa é null. */
export function lerVisita(updates: any): VisitaPedida | null {
  const v = updates?.visita;
  if (!v || typeof v !== 'object') return null;
  const tipo = String(v.tipo ?? '').trim().toUpperCase();
  const date = String(v.date ?? '').trim();
  const time = String(v.time ?? '').trim();
  if (!tipoSoDoLaboratorio(tipo) || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}$/.test(time)) return null;
  return { tipo, date, time };
}

/** Só o nome (nunca num cadastro de cliente) e a anotação da própria IA. */
export async function aplicarAtualizacoesDoLaboratorio(
  prisma: any,
  updates: any,
  ids: { conversationId: string; leadId: string; isClient: boolean },
): Promise<void> {
  if (!updates || typeof updates !== 'object') return;
  const nome = typeof updates.name === 'string' ? updates.name.trim() : '';
  if (!ids.isClient && nome.length >= 2 && nome !== 'null') {
    await prisma.lead.update({ where: { id: ids.leadId }, data: { name: nome.slice(0, 120) } });
  }
  const notas = typeof updates.notes === 'string' ? updates.notes.trim() : '';
  if (notas && notas !== 'null') {
    await prisma.conversation.update({ where: { id: ids.conversationId }, data: { ai_notes: notas.slice(0, 2000) } });
  }
}

// ─── Marcar coleta, prova ou entrega (só com AI_AUTOBOOK_ENABLED_<conta> ligado) ─

const DURACAO_DA_VISITA_MIN = 60;
const JANELA_DE_DUPLICIDADE_MS = 3 * 60 * 60 * 1000;

export type ResultadoDaVisita = { ok: true; eventId: string; jaExistia?: boolean } | { ok: false; motivo: string };

function dentroDoHorario(hours: ClinicHours | null | undefined, inicio: Date, fim: Date): boolean {
  if (!hours || !Object.values(hours.days).some(Boolean)) return true;
  const dia = hours.days[String(inicio.getUTCDay()) as '0'];
  if (!dia) return false;
  const hhmm = (d: Date) => `${doisDigitos(d.getUTCHours())}:${doisDigitos(d.getUTCMinutes())}`;
  return hhmm(inicio) >= dia.open && hhmm(fim) <= dia.close;
}

/**
 * Cria a visita na agenda da conta, com os lembretes de 48 h e 24 h do laboratório. O
 * responsável é o atendente da conversa (se for da conta) ou o 1º ADMIN da conta.
 */
export async function marcarVisitaDoLaboratorio(params: {
  prisma: any;
  reminderQueue?: { add: (nome: string, dados: any, opcoes: any) => Promise<any> } | null;
  tenantId: string;
  conversationId: string;
  leadId: string;
  assignedUserId?: string | null;
  assistantName?: string | null;
  hours?: ClinicHours | null;
  visita: VisitaPedida;
}): Promise<ResultadoDaVisita> {
  const { prisma, tenantId, visita } = params;
  if (!tipoSoDoLaboratorio(visita.tipo)) return { ok: false, motivo: LAB_IA_RECUSA.tipo };

  const [y, mo, d] = visita.date.split('-').map(Number);
  const [h, mi] = visita.time.split(':').map(Number);
  const inicio = new Date(Date.UTC(y, mo - 1, d, h, mi, 0, 0));
  if (Number.isNaN(inicio.getTime())) return { ok: false, motivo: LAB_IA_RECUSA.data };
  const fim = new Date(inicio.getTime() + DURACAO_DA_VISITA_MIN * 60_000);
  if (isPastNaive(inicio)) return { ok: false, motivo: LAB_IA_RECUSA.passado };
  if (!dentroDoHorario(params.hours, inicio, fim)) return { ok: false, motivo: LAB_IA_RECUSA.fechado };
  if (await isHolidayMatch(prisma, inicio, tenantId)) return { ok: false, motivo: LAB_IA_RECUSA.feriado };

  const atendente = params.assignedUserId
    ? await prisma.user.findFirst({ where: { id: params.assignedUserId, tenant_id: tenantId }, select: { id: true } })
    : null;
  const responsavel =
    atendente ??
    (await prisma.user.findFirst({
      where: { tenant_id: tenantId, roles: { has: 'ADMIN' } },
      orderBy: { created_at: 'asc' },
      select: { id: true },
    }));
  if (!responsavel?.id) return { ok: false, motivo: LAB_IA_RECUSA.semResponsavel };
  if (await findDentistConflict(prisma, responsavel.id, inicio, fim)) return { ok: false, motivo: LAB_IA_RECUSA.conflito };

  const existente = await prisma.calendarEvent.findFirst({
    where: {
      tenant_id: tenantId,
      lead_id: params.leadId,
      type: visita.tipo,
      status: { in: ['AGENDADO', 'CONFIRMADO'] },
      start_at: {
        gte: new Date(inicio.getTime() - JANELA_DE_DUPLICIDADE_MS),
        lte: new Date(inicio.getTime() + JANELA_DE_DUPLICIDADE_MS),
      },
    },
    select: { id: true },
  });
  if (existente) return { ok: true, eventId: existente.id, jaExistia: true };

  const cliente = await prisma.patient.findFirst({
    where: { lead_id: params.leadId, tenant_id: tenantId },
    select: { id: true },
  });
  const evento = await prisma.calendarEvent.create({
    data: {
      tenant_id: tenantId,
      type: visita.tipo,
      title: rotuloTipoDoLaboratorio(visita.tipo),
      description: LAB_IA_EQUIPE.descricaoEvento(String(params.assistantName ?? '').trim()),
      start_at: inicio,
      end_at: fim,
      status: 'AGENDADO',
      priority: 'NORMAL',
      assigned_user_id: responsavel.id,
      created_by_id: responsavel.id,
      created_by_ai: true,
      lead_id: params.leadId,
      patient_id: cliente?.id,
      conversation_id: params.conversationId,
      reminders: {
        create: ANTECEDENCIAS_DO_LABORATORIO.filter((m) => reminderDelayMs(inicio, m) >= REMINDER_MIN_DELAY_MS).map((m) => ({
          minutes_before: m,
          channel: 'WHATSAPP' as const,
        })),
      },
    },
    include: { reminders: true },
  });
  for (const r of evento.reminders ?? []) {
    const delay = reminderDelayMs(evento.start_at, r.minutes_before);
    if (delay < REMINDER_MIN_DELAY_MS) continue;
    await params.reminderQueue
      ?.add(
        'send-reminder',
        { reminderId: r.id, eventId: evento.id, channel: r.channel },
        { delay, jobId: `reminder-${r.id}`, attempts: 1, removeOnComplete: true, removeOnFail: 50 },
      )
      .catch(() => undefined);
  }
  return { ok: true, eventId: evento.id };
}

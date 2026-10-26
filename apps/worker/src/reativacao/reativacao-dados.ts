/**
 * Régua de reativação — leituras/escritas no banco usadas pelos 3 serviços
 * (planejador, redator, despachante). Funções soltas que recebem o Prisma (como
 * ai/orcamentista.ts), sem injeção — o módulo só depende de Prisma e Settings.
 *
 * TODA consulta leva o tenant_id da clínica (ou parte de um lead já conferido
 * como sendo dela): nunca mexe em contato de outra clínica.
 */
import {
  REATIVACAO_COLUNAS,
  REATIVACAO_MAX_DIAS_PARADO,
  REATIVACAO_TETO_KEY,
  REATIVACAO_TETO_PADRAO,
  REATIVACAO_TIPOS_MSG_INTERNA,
  brazilPhoneMatchVariants,
  defaultReativacaoModelo,
  generalStageFromLegacy,
  generalStageOf,
  loadOfficeHoursValues,
  findClinicHoliday,
  getLabTenantIds,
  precosLiberados,
  reativacaoColunaKey,
  reativacaoEnvioKey,
  reativacaoModeloKey,
  valoresPorProcedimento,
  type ReativacaoColuna,
} from '@crm/shared';
import type { PrismaService } from '../prisma/prisma.service';
import {
  DIA_MS,
  TIPOS_EVENTO_CLINICO,
  ehConversaComercial,
  inicioDiaNaive,
  isReativacaoColuna,
  maceioNaive,
  type MensagemLite,
} from './reativacao-regras';

export const LOG = '[REGUA-REATIV]';
/** Kill-switch GLOBAL (todas as clínicas): GlobalSetting REATIVACAO_LEADS_OFF='true' pausa tudo. */
export const KILL_SWITCH_KEY = 'REATIVACAO_LEADS_OFF';

/** Filtro "conversa fora do inbox FINANCEIRO" — `not` do Prisma descarta NULL, então o OR cobre sem inbox / inbox sem função. */
export const FORA_DO_FINANCEIRO = {
  OR: [{ inbox_id: null }, { inbox: { purpose: null } }, { inbox: { purpose: { not: 'FINANCEIRO' } } }],
};

export async function killSwitchLigado(prisma: PrismaService): Promise<boolean> {
  const row = await prisma.globalSetting.findUnique({ where: { key: KILL_SWITCH_KEY } });
  return row?.value === 'true';
}

/**
 * Clínicas → colunas LIGADAS (GlobalSetting reativacaoColunaKey = 'true'). Lança se o
 * banco falhar: quem chama NÃO pode tratar "erro" como "tudo desligado" (o
 * planejador cancelaria os ciclos de todo mundo).
 * Laboratório (F2) nunca aparece: a régua escreve com IA e texto de clínica. Sem
 * coluna ligada, o planejador não cria ciclo, o redator não escreve, o despachante
 * não envia e a faxina cancela o que houver.
 */
export async function colunasLigadasPorClinica(prisma: PrismaService): Promise<Map<string, Set<ReativacaoColuna>>> {
  const prefixos = REATIVACAO_COLUNAS.map((c) => ({ coluna: c, prefixo: reativacaoColunaKey(c, '') }));
  const rows = await prisma.globalSetting.findMany({
    where: { value: 'true', OR: prefixos.map((p) => ({ key: { startsWith: p.prefixo } })) },
    select: { key: true },
  });
  const labs = await getLabTenantIds(prisma, (m) => console.warn(`${LOG} ${m}`));
  const out = new Map<string, Set<ReativacaoColuna>>();
  for (const r of rows) {
    const hit = prefixos.find((p) => r.key.startsWith(p.prefixo));
    const tenantId = hit ? r.key.slice(hit.prefixo.length) : '';
    if (!hit || !tenantId) continue;
    if (labs.has(tenantId)) continue; // [LAB-GATE] reativacao
    if (!out.has(tenantId)) out.set(tenantId, new Set());
    out.get(tenantId)!.add(hit.coluna);
  }
  return out;
}

/** Clínicas com o ENVIO ligado (GlobalSetting reativacaoEnvioKey = 'true'). */
export async function clinicasComEnvioLigado(prisma: PrismaService): Promise<string[]> {
  const prefixo = reativacaoEnvioKey('');
  const rows = await prisma.globalSetting.findMany({
    where: { key: { startsWith: prefixo }, value: 'true' },
    select: { key: true },
  });
  return rows.map((r) => r.key.slice(prefixo.length)).filter(Boolean);
}

/** Teto diário de toques ENVIADOS da clínica (TenantSetting REATIVACAO_TETO_DIA, 1..200). */
export async function lerTeto(prisma: PrismaService, tenantId: string): Promise<number> {
  try {
    const row = await prisma.tenantSetting.findUnique({
      where: { tenant_id_key: { tenant_id: tenantId, key: REATIVACAO_TETO_KEY } },
    });
    const n = Number.parseInt(String(row?.value ?? ''), 10);
    if (Number.isFinite(n) && n >= 1) return Math.min(n, 200);
  } catch {
    // tabela/linha ausente → padrão
  }
  return REATIVACAO_TETO_PADRAO;
}

/**
 * Texto-modelo de um toque: o que a clínica salvou (TenantSetting reativacaoModeloKey)
 * → senão o padrão. Aceita o valor cru ou JSON {template} (formato dos outros
 * editores da Central) — o modelo pode começar com "{nome}", então JSON inválido
 * cai no valor cru.
 */
export async function lerModelo(prisma: PrismaService, tenantId: string, coluna: ReativacaoColuna, toque: number): Promise<string> {
  try {
    const row = await prisma.tenantSetting.findUnique({
      where: { tenant_id_key: { tenant_id: tenantId, key: reativacaoModeloKey(coluna, toque) } },
    });
    const raw = String(row?.value ?? '').trim();
    if (raw) {
      if (raw.startsWith('{"')) {
        try {
          const parsed = JSON.parse(raw);
          if (typeof parsed?.template === 'string' && parsed.template.trim()) return parsed.template;
        } catch {
          // não era JSON — é o próprio texto
        }
      }
      return raw;
    }
  } catch {
    // cai no padrão
  }
  return defaultReativacaoModelo(coluna, toque);
}

export interface ConversaPrincipal {
  id: string;
  ai_mode: boolean;
  status: string;
  assigned_dentist_id: string | null;
  /** Inbox COMERCIAL / sem inbox / legado sem função — a régua só fala nessas. */
  comercial: boolean;
}

/**
 * Conversa principal do lead = a mais recente que NÃO está ENCERRADA nem no inbox
 * FINANCEIRO. `comercial=false` se ela for de outro setor (ex.: CLINICA) — aí a
 * régua não entra (o contato está sendo tratado como paciente).
 */
export async function conversaPrincipal(prisma: PrismaService, tenantId: string, leadId: string): Promise<ConversaPrincipal | null> {
  const c = await prisma.conversation.findFirst({
    where: { tenant_id: tenantId, lead_id: leadId, status: { not: 'ENCERRADO' }, ...FORA_DO_FINANCEIRO },
    orderBy: { last_message_at: 'desc' },
    select: { id: true, ai_mode: true, status: true, assigned_dentist_id: true, inbox: { select: { purpose: true } } },
  });
  if (!c) return null;
  return {
    id: c.id,
    ai_mode: c.ai_mode,
    status: c.status,
    assigned_dentist_id: c.assigned_dentist_id,
    comercial: ehConversaComercial(c.inbox),
  };
}

/** Ids reais (Evolution) dos toques que a régua já mandou pro lead — não contam como "mensagem real". */
export async function idsDaReguaDoLead(prisma: PrismaService, tenantId: string, leadIds: string[]): Promise<Map<string, Set<string>>> {
  const out = new Map<string, Set<string>>();
  if (!leadIds.length) return out;
  const rows = await prisma.leadDispatch.findMany({
    where: { tenant_id: tenantId, lead_id: { in: leadIds }, NOT: { external_message_ids: { isEmpty: true } } },
    select: { lead_id: true, external_message_ids: true },
  });
  for (const r of rows) {
    if (!out.has(r.lead_id)) out.set(r.lead_id, new Set());
    for (const id of r.external_message_ids) out.get(r.lead_id)!.add(id);
  }
  return out;
}

/** Até onde olhar os envios automáticos (o MAX_DIAS_PARADO + folga): mais velho que isso não decide nada. */
export const JANELA_AUTOMACAO_MS = (REATIVACAO_MAX_DIAS_PARADO + 5) * DIA_MS;
/** Tamanho do lote nas consultas `IN (...)` dos envios automáticos. */
const LOTE_IN_AUTOMACAO = 2000;

function emFatias<T>(itens: T[], n = LOTE_IN_AUTOMACAO): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < itens.length; i += n) out.push(itens.slice(i, i + n));
  return out;
}

/**
 * Horários (ms) das saídas AUTOMÁTICAS de outra nutrição pro lead desde `desde`:
 * sequência com IA (FollowupMessage ENVIADO), broadcast (BroadcastItem ENVIADO) e
 * cron legado (DispatchLog 'followup_lead' SENT, pelo número — variantes do
 * brazilPhoneMatchVariants; a sequência também grava esse log). Existe porque o eco
 * do webhook troca o id `sys_followup_*`/`sys_broadcast_*` da Message pelo id real:
 * o prefixo não sobrevive, o horário do envio sim (ver ehSaidaAutomatica).
 * Em lote (1 consulta por tabela, IN fatiado). Erro PROPAGA: quem chama não planeja,
 * não escreve e não envia (na dúvida, não manda).
 */
export async function temposDeAutomacaoDoLead(
  prisma: PrismaService,
  tenantId: string,
  leads: { id: string; phone: string | null | undefined }[],
  desde: Date,
): Promise<Map<string, number[]>> {
  const out = new Map<string, number[]>();
  if (!leads.length) return out;
  const add = (leadId: string, quando: Date | null) => {
    if (!quando) return;
    if (!out.has(leadId)) out.set(leadId, []);
    out.get(leadId)!.push(new Date(quando).getTime());
  };
  const ids = [...new Set(leads.map((l) => l.id))];
  for (const lote of emFatias(ids)) {
    const [seq, broadcast] = await Promise.all([
      prisma.followupMessage.findMany({
        where: { lead_id: { in: lote }, status: 'ENVIADO', sent_at: { gte: desde } },
        select: { lead_id: true, sent_at: true },
      }),
      prisma.broadcastItem.findMany({
        where: { lead_id: { in: lote }, status: 'ENVIADO', sent_at: { gte: desde } },
        select: { lead_id: true, sent_at: true },
      }),
    ]);
    for (const r of [...seq, ...broadcast]) add(r.lead_id, r.sent_at);
  }
  // Número gravado no log (lead.phone na hora do envio) → leads com esse número.
  const leadsDoNumero = new Map<string, Set<string>>();
  for (const l of leads) {
    const nums = new Set([...brazilPhoneMatchVariants(l.phone), ...(l.phone ? [l.phone] : [])]);
    for (const n of nums) {
      if (!leadsDoNumero.has(n)) leadsDoNumero.set(n, new Set());
      leadsDoNumero.get(n)!.add(l.id);
    }
  }
  for (const lote of emFatias([...leadsDoNumero.keys()])) {
    const logs = await prisma.dispatchLog.findMany({
      where: { tenant_id: tenantId, type: 'followup_lead', status: 'SENT', sent_at: { gte: desde }, recipient_phone: { in: lote } },
      select: { recipient_phone: true, sent_at: true },
    });
    for (const r of logs) for (const leadId of leadsDoNumero.get(r.recipient_phone || '') ?? []) add(leadId, r.sent_at);
  }
  return out;
}

/**
 * Últimas mensagens da conversa (DESC), SEM as que nunca foram pro lead: nota
 * interna ('note' legado e 'internal_note' do chat) e evento de transferência
 * ('transfer_event') — o operador grava essas como direction 'out', e contá-las
 * faria a "clínica" parecer ter falado por último (lead com pergunta sem resposta
 * entrava na régua) e mandaria texto interno pro prompt da IA. Quem chama filtra
 * as da régua (mensagensReais).
 */
export async function ultimasMensagens(prisma: PrismaService, conversationId: string, take = 30): Promise<(MensagemLite & { id: string })[]> {
  return prisma.message.findMany({
    where: { conversation_id: conversationId, type: { notIn: [...REATIVACAO_TIPOS_MSG_INTERNA] } },
    orderBy: { created_at: 'desc' },
    take,
    select: { id: true, direction: true, type: true, created_at: true, external_message_id: true, text: true },
  });
}

/**
 * Consulta clínica MARCADA (AGENDADO/CONFIRMADO) de HOJE em diante — pelo lead (e
 * seus gêmeos de número), pela ficha (Patient ligado ao lead) ou pela conversa.
 * Agenda é naive-UTC → o corte é a meia-noite naive de hoje (inicioDiaNaive): a
 * consulta de hoje que já começou e a recepção ainda não marcou como compareceu
 * TAMBÉM conta (senão a régua mandaria "quer ver um horário?" pra quem está na
 * cadeira). Erro PROPAGA: o despachante devolve o toque pra fila e não envia (não
 * pode nem mandar às cegas, nem encerrar o ciclo como "agendou" por causa de um erro).
 */
export async function temConsultaFutura(
  prisma: PrismaService,
  tenantId: string,
  leadIds: string[],
  conversationIds: string[] = [],
  agora = new Date(),
): Promise<boolean> {
  const or: any[] = [{ lead_id: { in: leadIds } }, { patient: { lead_id: { in: leadIds } } }];
  if (conversationIds.length) or.push({ conversation_id: { in: conversationIds } });
  const ev = await prisma.calendarEvent.findFirst({
    where: {
      tenant_id: tenantId,
      OR: or,
      type: { in: TIPOS_EVENTO_CLINICO },
      status: { in: ['AGENDADO', 'CONFIRMADO'] },
      start_at: { gte: inicioDiaNaive(agora) },
    },
    select: { id: true },
  });
  return !!ev;
}

export interface ContatoIrmao {
  id: string;
  phone: string;
  is_client: boolean;
  contact_opt_out_at: Date | null;
  whatsapp_invalid_at: Date | null;
  /** Triagem da IA: fornecedor/currículo/parceria/negócio/spam (null = pode ser paciente). */
  non_patient_category?: string | null;
}

/**
 * Todos os leads DA CLÍNICA com o mesmo número (variantes com/sem 9, com/sem 55 —
 * brazilPhoneMatchVariants), o próprio lead incluído. A régua fala com a PESSOA:
 * se um gêmeo virou cliente, pediu pra parar ou respondeu, o outro também para.
 */
export async function irmaosDoNumero(
  prisma: PrismaService,
  tenantId: string,
  lead: ContatoIrmao,
): Promise<ContatoIrmao[]> {
  const variantes = brazilPhoneMatchVariants(lead.phone);
  const outros = variantes.length
    ? await prisma.lead.findMany({
        where: { tenant_id: tenantId, phone: { in: variantes }, id: { not: lead.id } },
        select: {
          id: true, phone: true, is_client: true, contact_opt_out_at: true, whatsapp_invalid_at: true,
          non_patient_category: true,
        },
      })
    : [];
  return [lead, ...outros];
}

/**
 * Tabela de valores da clínica — mesma leitura do ai.processor (TenantSetting
 * AI_PRICE_TABLE; AI_PRICES_ENABLED='false' desliga):
 *   - `liberados`: os R$ que a IA pode falar (precosLiberados);
 *   - `valores`: {valor_avaliacao}/{valor_limpeza} do item certo (valoresPorProcedimento)
 *     — o preço fica ligado ao procedimento, não só ao número.
 * Sem tabela ou erro de leitura = nada: na dúvida o texto sai sem preço (o "R$ 350"
 * do gancho padrão era do Instituto e saía pra qualquer clínica).
 */
export async function lerValoresDaClinica(
  prisma: PrismaService,
  tenantId: string,
): Promise<{ liberados: Set<number>; valores: ReturnType<typeof valoresPorProcedimento> }> {
  try {
    const rows = await prisma.tenantSetting.findMany({
      where: { tenant_id: tenantId, key: { in: ['AI_PRICE_TABLE', 'AI_PRICES_ENABLED'] } },
      select: { key: true, value: true },
    });
    const tabela = rows.find((r) => r.key === 'AI_PRICE_TABLE')?.value ?? null;
    const habilitado = rows.find((r) => r.key === 'AI_PRICES_ENABLED')?.value !== 'false';
    return { liberados: precosLiberados(tabela, habilitado), valores: valoresPorProcedimento(tabela, habilitado) };
  } catch {
    return { liberados: new Set(), valores: valoresPorProcedimento(null, false) };
  }
}

/**
 * Coluna geral do lead AGORA: pela etapa do funil (com as irmãs, pro último recurso
 * por posição) ou pelo Lead.stage legado.
 */
export async function colunaGeralDoLead(
  prisma: PrismaService,
  lead: { stage: string | null; stage_id: string | null },
): Promise<string> {
  if (lead.stage_id) {
    const st = await prisma.pipelineStage.findUnique({
      where: { id: lead.stage_id },
      select: {
        slug: true, name: true, position: true, is_initial: true, is_won: true, is_lost: true, is_hidden_from_kanban: true,
        pipeline: {
          select: {
            stages: {
              select: { slug: true, name: true, position: true, is_initial: true, is_won: true, is_lost: true, is_hidden_from_kanban: true },
            },
          },
        },
      },
    });
    if (st) return generalStageOf(st, st.pipeline?.stages);
  }
  return generalStageFromLegacy(lead.stage);
}

/**
 * Encerra o ciclo: o toque em mãos (se houver) e os demais AGENDADO do ciclo viram
 * CANCELADO com o motivo; o ciclo (se ainda ATIVA) vai pro status final. Idempotente
 * (só mexe em quem ainda está AGENDADO/ENVIANDO/ATIVA).
 */
export async function encerrarCiclo(
  prisma: PrismaService,
  args: { tenantId: string; cicloId: string; status: string; motivo: string; toqueEmMaosId?: string | null; agora?: Date },
): Promise<void> {
  const agora = args.agora ?? new Date();
  await prisma.$transaction([
    ...(args.toqueEmMaosId
      ? [
          prisma.leadDispatch.updateMany({
            where: { id: args.toqueEmMaosId, tenant_id: args.tenantId, status: { in: ['AGENDADO', 'ENVIANDO'] } },
            data: { status: 'CANCELADO', motivo: args.motivo },
          }),
        ]
      : []),
    prisma.leadDispatch.updateMany({
      where: { reactivation_id: args.cicloId, tenant_id: args.tenantId, status: 'AGENDADO' },
      data: { status: 'CANCELADO', motivo: args.motivo },
    }),
    prisma.leadReactivation.updateMany({
      where: { id: args.cicloId, tenant_id: args.tenantId, status: 'ATIVA' },
      data: { status: args.status, motivo_fim: args.motivo, ended_at: agora },
    }),
  ]);
}

/**
 * A clínica está FECHADA hoje? Feriado (da clínica + globais) ou dia sem atendimento
 * na grade de Ajustes › IA (AI_CLINIC_HOURS) — ou, sem grade, nos BUSINESS_DAYS que a
 * PRÓPRIA clínica gravou. O padrão global ("1,2,3,4,5") não fecha o sábado da régua:
 * só a configuração da clínica fecha. Erro de banco PROPAGA (quem chama não envia).
 */
export async function clinicaFechadaHoje(prisma: PrismaService, tenantId: string, agora = new Date()): Promise<string | null> {
  const nowLocal = maceioNaive(agora);
  const feriado = await findClinicHoliday(prisma, nowLocal, tenantId);
  if (feriado) return `feriado (${feriado.name})`;
  const dow = nowLocal.getUTCDay();
  const { values, ownKeys, clinicHours } = await loadOfficeHoursValues(prisma, tenantId);
  if (clinicHours) {
    return clinicHours.days[String(dow) as '0'] ? null : 'clínica fechada hoje (horários da IA)';
  }
  if (ownKeys.includes('BUSINESS_DAYS') && values.BUSINESS_DAYS) {
    const dias = values.BUSINESS_DAYS.split(',').map((v) => Number.parseInt(v.trim(), 10)).filter((n) => n >= 0 && n <= 6);
    if (dias.length && !dias.includes(dow)) return 'clínica fechada hoje (dias de atendimento)';
  }
  return null;
}

/** Coluna gravada no ciclo/toque, validada contra o catálogo (null = valor desconhecido). */
export function colunaValida(c: string | null | undefined): ReativacaoColuna | null {
  return isReativacaoColuna(c) ? c : null;
}

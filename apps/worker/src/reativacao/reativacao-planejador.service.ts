import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import {
  REATIVACAO_MAX_DIAS_PARADO,
  REATIVACAO_MIN_DIAS_PARADO,
  REATIVACAO_OFFSETS,
  REATIVACAO_RECICLO_DIAS,
  brazilPhoneMatchVariants,
  generalStageFromLegacy,
  generalStageOf,
  type ReativacaoColuna,
} from '@crm/shared';
import { PrismaService } from '../prisma/prisma.service';
import {
  FORA_DO_FINANCEIRO,
  JANELA_AUTOMACAO_MS,
  LOG,
  colunasLigadasPorClinica,
  idsDaReguaDoLead,
  killSwitchLigado,
  lerTeto,
  temposDeAutomacaoDoLead,
  ultimasMensagens,
} from './reativacao-dados';
import {
  DIA_MS,
  ETAPAS_LEGADAS_FORA,
  EXPIRA_SEM_ENVIO_MS,
  MOTIVO_COLUNA_DESLIGADA,
  MOTIVO_EXPIROU,
  TIPOS_EVENTO_CLINICO,
  avaliarCandidato,
  calcularAgendamentos,
  cicloBloqueiaReciclo,
  cotaNovosCiclos,
  deduplicarPorNumero,
  ehConversaComercial,
  emCarenciaDeNutricao,
  inicioDiaMaceio,
  inicioDiaNaive,
  isReativacaoColuna,
  maceioNaive,
  mensagensReais,
  pedidoDeParar,
  selecionarLote,
  type Avaliacao,
} from './reativacao-regras';

/** Teto de candidatos avaliados (cada um custa 1 consulta de mensagens) por clínica por rodada. */
const MAX_AVALIADOS = 400;
/** Tamanho do lote nas consultas `IN (...)` grandes (telefones/ids). */
const LOTE_IN = 2000;

/** Roda `fn` em lotes de `LOTE_IN` e junta os resultados (IN gigante pesa no Postgres/Prisma). */
async function emLotes<T, R>(itens: T[], fn: (lote: T[]) => Promise<R[]>): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < itens.length; i += LOTE_IN) out.push(...(await fn(itens.slice(i, i + LOTE_IN))));
  return out;
}

type Aprovado = Extract<Avaliacao, { ok: true }> & { leadId: string };

/**
 * Régua de reativação — PLANEJADOR (a cada 30 min, 7h–18h, seg–sáb, Maceió).
 *
 * Coloca na régua quem está PARADO numa coluna LIGADA do "Geral — Leads": cria o
 * ciclo (LeadReactivation) e os toques (LeadDispatch) D0/D+3/D+7… com a data em que
 * cada um sai. NÃO envia nada — o redator escreve o texto e o despachante envia
 * (se o Envio da clínica estiver ligado; senão vira só a prévia dos "Previstos").
 *
 * Também faz a faxina dos ciclos: coluna desligada sai dos Previstos, prévia que
 * nunca saiu expira (pra renovar com quem está parado AGORA) e ciclo sem toque
 * pendente é concluído.
 *
 * 2 réplicas do worker: a criação é serializada por clínica (advisory lock na
 * transação) e reconfere a cota do dia e o ciclo ATIVA lá dentro.
 */
@Injectable()
export class ReativacaoPlanejadorService {
  private readonly logger = new Logger(ReativacaoPlanejadorService.name);
  /** Trava contra rodada sobreposta (uma rodada lenta não pode encavalar na próxima). */
  private busy = false;

  constructor(private prisma: PrismaService) {}

  @Cron('*/30 7-18 * * 1-6', { timeZone: 'America/Maceio' })
  async tick() {
    await this.planejar();
  }

  async planejar(agora = new Date()): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      if (await killSwitchLigado(this.prisma)) return;
      // Erro aqui PROPAGA (catch abaixo): "não consegui ler" não pode virar
      // "tudo desligado" — a faxina cancelaria os ciclos de todas as clínicas.
      const ligadas = await colunasLigadasPorClinica(this.prisma);
      await this.cancelarColunasDesligadas(ligadas, agora);
      await this.expirarCiclosSemEnvio(agora);
      await this.concluirCiclosSemPendentes(agora);
      for (const [tenantId, colunas] of ligadas) {
        try {
          await this.planejarClinica(tenantId, colunas, agora);
        } catch (e: any) {
          this.logger.error(`${LOG} planejador: falha na clínica ${tenantId}: ${e?.message}`);
        }
      }
    } catch (e: any) {
      this.logger.error(`${LOG} planejador: rodada abortada: ${e?.message}`);
    } finally {
      this.busy = false;
    }
  }

  // ─── Faxina ────────────────────────────────────────────────────────────────

  /** Coluna DESLIGADA: os ciclos dela saem dos Previstos (toques AGENDADO → CANCELADO). */
  private async cancelarColunasDesligadas(ligadas: Map<string, Set<ReativacaoColuna>>, agora: Date): Promise<void> {
    const grupos = await this.prisma.leadReactivation.groupBy({
      by: ['tenant_id', 'coluna'],
      where: { status: 'ATIVA' },
    });
    for (const g of grupos) {
      if (ligadas.get(g.tenant_id)?.has(g.coluna as ReativacaoColuna)) continue;
      const ciclos = await this.prisma.leadReactivation.findMany({
        where: { tenant_id: g.tenant_id, coluna: g.coluna, status: 'ATIVA' },
        select: { id: true },
      });
      const ids = ciclos.map((c) => c.id);
      if (!ids.length) continue;
      await this.prisma.$transaction([
        this.prisma.leadDispatch.updateMany({
          where: { tenant_id: g.tenant_id, reactivation_id: { in: ids }, status: 'AGENDADO' },
          data: { status: 'CANCELADO', motivo: MOTIVO_COLUNA_DESLIGADA },
        }),
        this.prisma.leadReactivation.updateMany({
          where: { tenant_id: g.tenant_id, id: { in: ids }, status: 'ATIVA' },
          data: { status: 'CANCELADA', motivo_fim: MOTIVO_COLUNA_DESLIGADA, ended_at: agora },
        }),
      ]);
      this.logger.log(`${LOG} clínica ${g.tenant_id}: coluna ${g.coluna} desligada — ${ids.length} ciclo(s) cancelado(s)`);
    }
  }

  /**
   * Ciclo que NUNCA enviou nada e já tem mais de 7 dias (Envio desligado = prévia
   * parada, ou teto sempre cheio): expira. Assim os Previstos mostram quem está
   * parado AGORA, e o lead pode ser replanejado com a situação atual (não bloqueia
   * o reciclo — nada saiu pra ele).
   */
  private async expirarCiclosSemEnvio(agora: Date): Promise<void> {
    const velhos = await this.prisma.leadReactivation.findMany({
      where: {
        status: 'ATIVA',
        created_at: { lt: new Date(agora.getTime() - EXPIRA_SEM_ENVIO_MS) },
        dispatches: { none: { status: { in: ['ENVIADO', 'ENVIANDO', 'FALHOU'] } } },
      },
      select: { id: true, tenant_id: true },
      take: 1000,
    });
    if (!velhos.length) return;
    const ids = velhos.map((v) => v.id);
    await this.prisma.$transaction([
      this.prisma.leadDispatch.updateMany({
        where: { reactivation_id: { in: ids }, status: 'AGENDADO' },
        data: { status: 'CANCELADO', motivo: MOTIVO_EXPIROU },
      }),
      this.prisma.leadReactivation.updateMany({
        where: { id: { in: ids }, status: 'ATIVA' },
        data: { status: 'CANCELADA', motivo_fim: MOTIVO_EXPIROU, ended_at: agora },
      }),
    ]);
    this.logger.log(`${LOG} ${ids.length} ciclo(s) expirado(s) sem envio (prévia renovada)`);
  }

  /** Ciclo ATIVA sem nenhum toque pendente (último pulado/cancelado à mão) → CONCLUIDA. */
  private async concluirCiclosSemPendentes(agora: Date): Promise<void> {
    const r = await this.prisma.leadReactivation.updateMany({
      where: {
        status: 'ATIVA',
        created_at: { lt: new Date(agora.getTime() - 60 * 60_000) },
        dispatches: { none: { status: { in: ['AGENDADO', 'ENVIANDO'] } } },
      },
      data: { status: 'CONCLUIDA', motivo_fim: 'sem toques pendentes', ended_at: agora },
    });
    if (r.count) this.logger.log(`${LOG} ${r.count} ciclo(s) concluído(s) (sem toques pendentes)`);
  }

  // ─── Planejamento por clínica ──────────────────────────────────────────────

  async planejarClinica(tenantId: string, colunas: Set<ReativacaoColuna>, agora: Date): Promise<number> {
    const teto = await lerTeto(this.prisma, tenantId);
    const cota = cotaNovosCiclos(teto);
    const inicioHoje = inicioDiaMaceio(agora);
    const criadosHoje = await this.prisma.leadReactivation.count({
      where: { tenant_id: tenantId, created_at: { gte: inicioHoje } },
    });
    const vagas = cota - criadosHoje;
    if (vagas <= 0) return 0;

    const aprovados = await this.buscarAprovados(tenantId, colunas, agora, vagas);
    const lote = selecionarLote(aprovados, vagas);
    let criados = 0;
    for (const a of lote) {
      const r = await this.criarCiclo(tenantId, a, cota, inicioHoje, agora);
      if (r === 'ok') criados++;
      if (r === 'cota') break;
    }
    if (criados) {
      this.logger.log(`${LOG} clínica ${tenantId}: ${criados} lead(s) entraram na régua (${aprovados.length} aptos, cota ${cota}/dia)`);
    }
    return criados;
  }

  /**
   * Candidatos aptos da clínica, já avaliados (avaliarCandidato). Consulta em lote o
   * que dá (conversas, leads, ciclos, eventos) e só busca mensagens dos que passam
   * nos filtros baratos, na ordem de quem falou por último mais recentemente.
   */
  private async buscarAprovados(
    tenantId: string,
    colunas: Set<ReativacaoColuna>,
    agora: Date,
    vagas: number,
  ): Promise<Aprovado[]> {
    const agoraMs = agora.getTime();
    const desde = new Date(agoraMs - (REATIVACAO_MAX_DIAS_PARADO + 1) * DIA_MS);

    // 1) Conversas vivas fora do Financeiro, de leads (não pacientes) que podem receber.
    //    Ordem DESC: a 1ª de cada lead é a conversa principal (mais recente).
    const convs = await this.prisma.conversation.findMany({
      where: {
        tenant_id: tenantId,
        status: { not: 'ENCERRADO' },
        last_message_at: { gte: desde },
        ...FORA_DO_FINANCEIRO,
        lead: {
          tenant_id: tenantId,
          is_client: false,
          contact_opt_out_at: null,
          whatsapp_invalid_at: null,
          stage: { notIn: ETAPAS_LEGADAS_FORA },
        },
      },
      orderBy: { last_message_at: 'desc' },
      select: { id: true, lead_id: true, ai_mode: true, last_message_at: true, inbox: { select: { purpose: true } } },
      take: 5000,
    });
    const principal = new Map<string, (typeof convs)[number]>();
    for (const c of convs) if (!principal.has(c.lead_id)) principal.set(c.lead_id, c);
    // Principal tem que ser do Comercial (ou sem setor) e sem humano no comando.
    for (const [leadId, c] of principal) {
      if (!ehConversaComercial(c.inbox) || c.ai_mode === false) principal.delete(leadId);
    }
    if (!principal.size) return [];

    // 2) Coluna geral de cada lead (etapa do funil + irmãs, ou Lead.stage legado).
    const leads = await this.prisma.lead.findMany({
      where: { tenant_id: tenantId, id: { in: [...principal.keys()] } },
      select: {
        id: true,
        phone: true,
        stage: true,
        last_followup_at: true,
        current_stage: {
          select: {
            slug: true, name: true, position: true, pipeline_id: true,
            is_initial: true, is_won: true, is_lost: true, is_hidden_from_kanban: true,
          },
        },
      },
    });
    const pipelineIds = [...new Set(leads.map((l) => l.current_stage?.pipeline_id).filter(Boolean) as string[])];
    const irmas = pipelineIds.length
      ? await this.prisma.pipelineStage.findMany({
          where: { pipeline_id: { in: pipelineIds } },
          select: {
            pipeline_id: true, slug: true, name: true, position: true,
            is_initial: true, is_won: true, is_lost: true, is_hidden_from_kanban: true,
          },
        })
      : [];
    const irmasPorFunil = new Map<string, typeof irmas>();
    for (const s of irmas) {
      if (!irmasPorFunil.has(s.pipeline_id)) irmasPorFunil.set(s.pipeline_id, []);
      irmasPorFunil.get(s.pipeline_id)!.push(s);
    }
    const colunaDe = new Map<string, ReativacaoColuna>();
    for (const l of leads) {
      if (String(l.phone || '').replace(/\D/g, '').length < 10) continue; // sem telefone de verdade
      const geral = l.current_stage
        ? generalStageOf(l.current_stage, irmasPorFunil.get(l.current_stage.pipeline_id))
        : generalStageFromLegacy(l.stage);
      if (isReativacaoColuna(geral) && colunas.has(geral)) colunaDe.set(l.id, geral);
    }
    if (!colunaDe.size) return [];

    // 2b) Mesmo número em 2+ leads (12 × 13 dígitos, com/sem 55): fica 1 candidato
    //     por número (quem conversou por último) e o número inteiro sai se QUALQUER
    //     gêmeo da clínica é cliente, pediu pra parar, não tem WhatsApp ou já está
    //     num ciclo ATIVA — senão a mesma pessoa recebia 2 textos no dia e a resposta
    //     num lead não parava o outro.
    const telefoneDe = new Map(leads.map((l) => [l.id, l.phone]));
    const variantes = [...new Set([...colunaDe.keys()].flatMap((id) => brazilPhoneMatchVariants(telefoneDe.get(id))))];
    const gemeos = await emLotes(variantes, (lote) =>
      this.prisma.lead.findMany({
        where: { tenant_id: tenantId, phone: { in: lote } },
        select: { id: true, phone: true, is_client: true, contact_opt_out_at: true, whatsapp_invalid_at: true },
      }),
    );
    const gemeoEmCiclo = new Set(
      (
        await emLotes([...new Set(gemeos.map((g) => g.id))], (lote) =>
          this.prisma.leadReactivation.findMany({
            where: { tenant_id: tenantId, status: 'ATIVA', lead_id: { in: lote } },
            select: { lead_id: true },
          }),
        )
      ).map((c) => c.lead_id),
    );
    const ids = deduplicarPorNumero(
      [...colunaDe.keys()].map((id) => ({
        id,
        phone: telefoneDe.get(id) ?? null,
        recencia: principal.get(id)!.last_message_at.getTime(),
      })),
      gemeos.map((g) => ({
        id: g.id,
        phone: g.phone,
        bloqueado: g.is_client || !!g.contact_opt_out_at || !!g.whatsapp_invalid_at || gemeoEmCiclo.has(g.id),
      })),
    ).map((c) => c.id);
    if (!ids.length) return [];
    const ultimoFollowupDe = new Map(leads.map((l) => [l.id, l.last_followup_at]));

    // 3) Ciclos: ATIVA (qualquer coluna) e recentes que bloqueiam o reciclo.
    const desdeReciclo = new Date(agoraMs - REATIVACAO_RECICLO_DIAS * DIA_MS);
    const ciclos = await this.prisma.leadReactivation.findMany({
      where: {
        tenant_id: tenantId,
        lead_id: { in: ids },
        OR: [{ status: 'ATIVA' }, { created_at: { gte: desdeReciclo } }],
      },
      select: {
        lead_id: true,
        coluna: true,
        status: true,
        motivo_fim: true,
        dispatches: { where: { status: { in: ['ENVIADO', 'ENVIANDO', 'FALHOU'] } }, select: { id: true }, take: 1 },
      },
    });
    const ativo = new Set<string>();
    const bloqueadas = new Map<string, Set<string>>();
    for (const c of ciclos) {
      if (c.status === 'ATIVA') ativo.add(c.lead_id);
      if (cicloBloqueiaReciclo({ status: c.status, motivo_fim: c.motivo_fim, teveEnvio: c.dispatches.length > 0 })) {
        if (!bloqueadas.has(c.lead_id)) bloqueadas.set(c.lead_id, new Set());
        bloqueadas.get(c.lead_id)!.add(c.coluna);
      }
    }

    // 4) Sequência de follow-up ATIVA (motor antigo) — não nutre em dobro. A sequência
    //    CONCLUÍDA há pouco é pega pela carência de last_followup_at (etapas 6 e 7).
    const emSequencia = new Set(
      (
        await this.prisma.followupEnrollment.findMany({
          where: { lead_id: { in: ids }, status: 'ATIVO', lead: { tenant_id: tenantId } },
          select: { lead_id: true },
        })
      ).map((e) => e.lead_id),
    );

    // 5) Agenda (naive-UTC): consulta marcada de HOJE em diante (a de hoje que já
    //    começou e ninguém marcou compareceu ainda conta — consultaContaComoAgendou) e
    //    o último evento clínico passado.
    const agoraNaive = maceioNaive(agora);
    const convIds = ids.map((id) => principal.get(id)!.id);
    const leadDaConversa = new Map(ids.map((id) => [principal.get(id)!.id, id]));
    const futuros = await this.prisma.calendarEvent.findMany({
      where: {
        tenant_id: tenantId,
        type: { in: TIPOS_EVENTO_CLINICO },
        status: { in: ['AGENDADO', 'CONFIRMADO'] },
        start_at: { gte: inicioDiaNaive(agora) },
        OR: [{ lead_id: { in: ids } }, { patient: { lead_id: { in: ids } } }, { conversation_id: { in: convIds } }],
      },
      select: { lead_id: true, conversation_id: true, patient: { select: { lead_id: true } } },
    });
    const comFuturo = new Set<string>();
    for (const ev of futuros) {
      for (const lid of [ev.lead_id, ev.patient?.lead_id, ev.conversation_id ? leadDaConversa.get(ev.conversation_id) : null]) {
        if (lid) comFuturo.add(lid);
      }
    }
    const idsAgendado = ids.filter((id) => colunaDe.get(id) === 'agendado');
    const noShow = new Map<string, { id: string; startNaive: Date }>();
    if (idsAgendado.length) {
      const passados = await this.prisma.calendarEvent.findMany({
        where: {
          tenant_id: tenantId,
          type: { in: TIPOS_EVENTO_CLINICO },
          start_at: { lte: agoraNaive, gte: new Date(agoraNaive.getTime() - (REATIVACAO_MAX_DIAS_PARADO + 1) * DIA_MS) },
          OR: [{ lead_id: { in: idsAgendado } }, { patient: { lead_id: { in: idsAgendado } } }],
        },
        orderBy: { start_at: 'desc' },
        select: { id: true, status: true, start_at: true, lead_id: true, patient: { select: { lead_id: true } } },
      });
      const visto = new Set<string>();
      for (const ev of passados) {
        const lid = ev.lead_id || ev.patient?.lead_id;
        if (!lid || visto.has(lid)) continue;
        visto.add(lid); // só o ÚLTIMO evento clínico passado conta
        if (ev.status === 'NO_SHOW') noShow.set(lid, { id: ev.id, startNaive: ev.start_at });
      }
    }

    // 6) Filtros baratos antes de olhar mensagens.
    const idsRegua = await idsDaReguaDoLead(this.prisma, tenantId, ids);
    // Horários dos envios automáticos (sequência, broadcast, cron legado): o eco do
    // webhook apaga o prefixo sys_* da Message, o horário fica.
    const temposAuto = await temposDeAutomacaoDoLead(
      this.prisma,
      tenantId,
      ids.map((id) => ({ id, phone: telefoneDe.get(id) ?? null })),
      new Date(agoraMs - JANELA_AUTOMACAO_MS),
    );
    const fila = ids.filter((id) => {
      if (ativo.has(id) || emSequencia.has(id) || comFuturo.has(id)) return false;
      // Carência de outra nutrição (last_followup_at ou envio automático nos últimos 3 dias).
      if (emCarenciaDeNutricao(ultimoFollowupDe.get(id), [], agora, temposAuto.get(id) ?? [])) return false;
      const coluna = colunaDe.get(id)!;
      if (bloqueadas.get(id)?.has(coluna)) return false;
      if (coluna === 'agendado') return noShow.has(id);
      // last_message_at ≥ última mensagem real: se ele é recente demais e a régua
      // nunca mandou nada (que suba esse campo), a conversa não está parada.
      if (!idsRegua.has(id)) {
        const minMs = REATIVACAO_MIN_DIAS_PARADO[coluna] * DIA_MS;
        if (agoraMs - principal.get(id)!.last_message_at.getTime() < minMs) return false;
      }
      return true;
    });
    // "Faltou" primeiro (poucos, gatilho é a falta); depois quem falou por último mais recentemente.
    fila.sort((a, b) => {
      const fa = colunaDe.get(a) === 'agendado' ? 1 : 0;
      const fb = colunaDe.get(b) === 'agendado' ? 1 : 0;
      if (fa !== fb) return fb - fa;
      return principal.get(b)!.last_message_at.getTime() - principal.get(a)!.last_message_at.getTime();
    });

    // 7) Avalia com a última mensagem REAL (sem notas/transferências, sem os toques da
    //    régua e sem as saídas automáticas de outras nutrições).
    const aprovados: Aprovado[] = [];
    let avaliados = 0;
    for (const id of fila) {
      if (avaliados >= MAX_AVALIADOS) break;
      const conv = principal.get(id)!;
      const coluna = colunaDe.get(id)!;
      // Parada antecipada: paradoDesde ≤ last_message_at nas colunas comuns. Com o
      // lote cheio e esta conversa mais fria que o pior aprovado, nenhuma das
      // próximas (mais frias ainda) entraria.
      if (coluna !== 'agendado' && aprovados.length >= vagas) {
        const corte = selecionarLote(aprovados, vagas)[vagas - 1].paradoDesde.getTime();
        if (conv.last_message_at.getTime() < corte) break;
      }
      avaliados++;
      const msgs = await ultimasMensagens(this.prisma, conv.id, 30);
      // Recusou no histórico ("pare", "não tenho interesse no momento 🙏", "me tira
      // dessa lista"): o webhook só grava o opt-out quando já há ciclo, então quem
      // pediu numa conversa normal e recebeu um "tudo bem" ficaria com a última
      // mensagem 'out' e entraria. Aqui só PULA — não grava opt-out, o pedido não foi
      // resposta à régua (ver optOutDefinitivo).
      if (pedidoDeParar(msgs)) continue;
      // Broadcast/sequência recente (sys_* ou horário de envio automático) também dá carência.
      const tempos = temposAuto.get(id) ?? [];
      if (emCarenciaDeNutricao(ultimoFollowupDe.get(id), msgs, agora, tempos)) continue;
      const ult = mensagensReais(msgs, idsRegua.get(id) ?? new Set(), tempos)[0] ?? null;
      const av = avaliarCandidato(
        {
          colunaGeral: coluna,
          ultimaMsgReal: ult ? { direction: ult.direction, created_at: ult.created_at } : null,
          temEventoFuturo: comFuturo.has(id),
          noShow: noShow.get(id) ?? null,
          temCicloAtivo: ativo.has(id),
          colunasBloqueadas: bloqueadas.get(id) ?? new Set(),
        },
        colunas,
        agora,
      );
      if (av.ok) aprovados.push({ ...av, leadId: id });
    }
    return aprovados;
  }

  /**
   * Cria o ciclo + os toques numa transação SERIALIZADA por clínica (advisory lock):
   * reconfere lá dentro a cota do dia e se o lead já ganhou ciclo ATIVA (outra
   * réplica/rodada). P2002 = índice único (ex.: 1 ciclo ATIVA por lead) → já existe.
   */
  private async criarCiclo(
    tenantId: string,
    a: Aprovado,
    cota: number,
    inicioHoje: Date,
    agora: Date,
  ): Promise<'ok' | 'cota' | 'existe'> {
    const offsets = REATIVACAO_OFFSETS[a.coluna];
    const datas = calcularAgendamentos(agora, offsets);
    try {
      return await this.prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`reativacao-plan:${tenantId}`}))`;
        const criadosHoje = await tx.leadReactivation.count({
          where: { tenant_id: tenantId, created_at: { gte: inicioHoje } },
        });
        if (criadosHoje >= cota) return 'cota' as const;
        const ativa = await tx.leadReactivation.findFirst({
          where: { tenant_id: tenantId, lead_id: a.leadId, status: 'ATIVA' },
          select: { id: true },
        });
        if (ativa) return 'existe' as const;
        const ciclo = await tx.leadReactivation.create({
          data: { tenant_id: tenantId, lead_id: a.leadId, coluna: a.coluna, ref_event_id: a.refEventId },
          select: { id: true },
        });
        await tx.leadDispatch.createMany({
          data: datas.map((d, i) => ({
            tenant_id: tenantId,
            lead_id: a.leadId,
            reactivation_id: ciclo.id,
            coluna: a.coluna,
            toque: i + 1,
            agendado_para: d,
          })),
        });
        return 'ok' as const;
      });
    } catch (e: any) {
      if (e?.code === 'P2002') return 'existe';
      throw e;
    }
  }
}

import { Injectable, Logger, BadRequestException, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import {
  REATIVACAO_COLUNAS,
  REATIVACAO_OFFSETS,
  REATIVACAO_TOGGLE_IDS,
  REATIVACAO_TETO_KEY,
  REATIVACAO_TETO_PADRAO,
  REATIVACAO_GANCHOS,
  REATIVACAO_GANCHO_GENERICO,
  REATIVACAO_TEXTO_MAX,
  reativacaoToggleKey,
  reativacaoModeloKey,
  defaultReativacaoModelo,
  renderReativacaoModelo,
  interesseDoFunil,
  dentistaDoModelo,
  precosLiberados,
  removerPrecosNaoLiberados,
  valoresPorProcedimento,
  removerFrasesComVariavelVazia,
  type ReativacaoColuna,
} from '@crm/shared';

/**
 * Régua de REATIVAÇÃO de leads (follow-up do chip COMERCIAL) — lado da API.
 *
 * Aqui só se LÊ o que o worker planejou/enviou (LeadReactivation/LeadDispatch) e
 * se grava a personalização da clínica (teto e textos). Quem planeja, escreve e
 * ENVIA é o worker (apps/worker/src/reativacao). Por isso este módulo depende só
 * do Prisma: nada de WhatsApp/Conversations (ciclo de DI já derrubou a API).
 *
 * Isolamento: TODO where carrega o tenant do token — rota por id sem tenant é IDOR.
 */

const ORCAMENTISTA = 'Orçamentista';
const TETO_MIN = 1;
const TETO_MAX = 200;
// Mesmo teto do worker (validarTextoReativacao recusa texto acima disso): antes a
// tela aceitava 1500, o redator recusava tudo e o toque era cancelado calado
// ("sem texto válido") — o limite agora é UM só, vindo do @crm/shared.
const TEMPLATE_MAX = REATIVACAO_TEXTO_MAX;
const LISTA_MAX = 500;
/** Cópia do GENERIC_NAMES do worker (conversation-guide.ts) — manter igual. */
const NOMES_GENERICOS = new Set(['paciente', 'cliente', 'lead', 'contato', 'desconhecido', 'teste', 'sem']);
/**
 * Motivo dos FALHOU que PODEM ter saído (timeout/5xx/erro interno/interrompido —
 * "Evolution responde erro mas entrega"). Contam no teto do dia, igual ao worker.
 */
const TALVEZ_SAIU = 'pode ter saído';

/** Rank do status de entrega do WhatsApp (o webhook grava em Message.status). */
const ENTREGA_RANK: Record<string, number> = { enviado: 1, entregue: 2, lido: 3 };
const ENTREGA_LABEL = ['', 'enviado', 'entregue', 'lido'] as const;

type Entrega = 'enviado' | 'entregue' | 'lido';

@Injectable()
export class ReactivationService {
  private readonly logger = new Logger(ReactivationService.name);

  constructor(private readonly prisma: PrismaService) {}

  // ─── Helpers ──────────────────────────────────────────────────────────────

  private requireTenant(tenantId: string | null | undefined): string {
    if (!tenantId) throw new BadRequestException('tenant_id ausente');
    return tenantId;
  }

  /** Início/fim do dia de HOJE em Maceió (UTC-3), em instantes UTC reais. */
  private diaMaceio(): { start: Date; end: Date } {
    const offsetMs = 3 * 60 * 60 * 1000;
    const local = new Date(Date.now() - offsetMs);
    const start = new Date(
      Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate(), 0, 0, 0) + offsetMs,
    );
    return { start, end: new Date(start.getTime() + 86400000) };
  }

  private isColuna(v: string): v is ReativacaoColuna {
    return (REATIVACAO_COLUNAS as string[]).includes(v);
  }

  /** Filtro opcional de coluna (?coluna=). Valor desconhecido = 400 (não lista tudo calado). */
  private parseColunaOpcional(coluna?: string): ReativacaoColuna | null {
    const c = (coluna || '').trim();
    if (!c) return null;
    if (!this.isColuna(c)) throw new BadRequestException(`coluna inválida: ${c}`);
    return c;
  }

  /** coluna/toque das rotas de texto — validados contra o catálogo do shared. */
  private parseColunaToque(coluna: string, toque: string): { coluna: ReativacaoColuna; toque: number } {
    if (!this.isColuna(coluna)) throw new BadRequestException(`coluna inválida: ${coluna}`);
    const n = Number(toque);
    const total = REATIVACAO_OFFSETS[coluna].length;
    if (!Number.isInteger(n) || n < 1 || n > total) {
      throw new BadRequestException(`toque inválido: ${toque} (a coluna ${coluna} tem ${total} toques)`);
    }
    return { coluna, toque: n };
  }

  private clampDias(raw: string | undefined, padrao: number, max: number): number {
    const n = parseInt(String(raw ?? ''), 10);
    if (!Number.isFinite(n)) return padrao;
    return Math.min(Math.max(n, 1), max);
  }

  /**
   * Primeiro nome do contato — MESMA regra do redator do worker (leadFirstName em
   * apps/worker/src/ai/conversation-guide.ts): 1ª palavra, só letras, nunca nome
   * genérico ("Paciente", "Cliente"…). Antes a prévia pegava a 1ª sequência de
   * letras em qualquer lugar ("🌸 Maria" → "Maria") e mostrava um nome que o envio
   * real não usa. Sem nome utilizável → null ({nome} fica visível na prévia).
   */
  private primeiroNomeDoLead(name: string | null | undefined): string | null {
    const first = String(name || '').trim().split(/\s+/)[0] || '';
    if (!/^[A-Za-zÀ-ÖØ-öø-ÿ]{2,}$/.test(first)) return null;
    const plain = first.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
    if (NOMES_GENERICOS.has(plain)) return null;
    return first.charAt(0).toUpperCase() + first.slice(1).toLowerCase();
  }

  /**
   * Preços da tabela de valores da clínica (Ajustes › IA › Valores) — mesma leitura
   * do worker: AI_PRICES_ENABLED='false' desliga, sem tabela = nenhum.
   * `liberados` = todo R$ da tabela (2ª barreira, pega R$ digitado à mão no modelo);
   * `valores` = {valor_avaliacao}/{valor_limpeza} ligados ao ITEM (não só ao número).
   * Erro de leitura = nenhum (na dúvida a prévia esconde o preço, igual ao envio).
   */
  private async readPrecos(
    tenantId: string,
  ): Promise<{ liberados: Set<number>; valores: { valor_avaliacao: string; valor_limpeza: string } }> {
    try {
      const rows = await this.prisma.tenantSetting.findMany({
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

  /** Teto diário da clínica (TenantSetting) — inválido/ausente = padrão do shared. */
  private async readTeto(tenantId: string): Promise<number> {
    try {
      const row = await this.prisma.tenantSetting.findUnique({
        where: { tenant_id_key: { tenant_id: tenantId, key: REATIVACAO_TETO_KEY } },
        select: { value: true },
      });
      const n = parseInt(String(row?.value ?? ''), 10);
      if (Number.isInteger(n) && n >= TETO_MIN && n <= TETO_MAX) return n;
    } catch { /* linha/tabela ausente → padrão */ }
    return REATIVACAO_TETO_PADRAO;
  }

  /**
   * Conversa PRINCIPAL de cada lead (a mais recente não-ENCERRADA, fora do
   * Financeiro — a cobrança tem conversa própria e nunca é a da régua). Escopo de
   * tenant pelo LEAD: conversas legadas podem estar com tenant_id null.
   */
  private async conversasPrincipais(
    tenantId: string,
    leadIds: string[],
  ): Promise<Map<string, { id: string; assigned_dentist_id: string | null }>> {
    const map = new Map<string, { id: string; assigned_dentist_id: string | null }>();
    if (!leadIds.length) return map;
    const convs = await this.prisma.conversation.findMany({
      where: {
        lead_id: { in: leadIds },
        lead: { tenant_id: tenantId },
        status: { not: 'ENCERRADO' },
        NOT: { inbox: { purpose: 'FINANCEIRO' } },
      },
      orderBy: { last_message_at: 'desc' },
      select: { id: true, lead_id: true, assigned_dentist_id: true },
    });
    for (const c of convs) {
      if (!map.has(c.lead_id)) map.set(c.lead_id, { id: c.id, assigned_dentist_id: c.assigned_dentist_id });
    }
    return map;
  }

  /**
   * Se o ciclo não tem mais nada pra sair, encerra (senão ficaria ATIVA pra sempre
   * e o planejador nunca mais reativaria o lead — ele pula quem tem ciclo ATIVA).
   */
  private async fecharCicloSemPendentes(tenantId: string, reactivationId: string, motivo: string) {
    const pendentes = await this.prisma.leadDispatch.count({
      where: { tenant_id: tenantId, reactivation_id: reactivationId, status: { in: ['AGENDADO', 'ENVIANDO'] } },
    });
    if (pendentes > 0) return;
    const enviados = await this.prisma.leadDispatch.count({
      where: { tenant_id: tenantId, reactivation_id: reactivationId, status: 'ENVIADO' },
    });
    await this.prisma.leadReactivation.updateMany({
      where: { id: reactivationId, tenant_id: tenantId, status: 'ATIVA' },
      data: { status: enviados > 0 ? 'CONCLUIDA' : 'CANCELADA', motivo_fim: motivo, ended_at: new Date() },
    });
  }

  // ─── Painel ───────────────────────────────────────────────────────────────

  /** KPIs do topo do painel + estado dos liga/desliga (lidos das MESMAS chaves do worker). */
  async getSummary(tenantIdRaw: string | null | undefined) {
    const tenantId = this.requireTenant(tenantIdRaw);
    const { start, end } = this.diaMaceio();
    const since30 = new Date(Date.now() - 30 * 86400000);

    const [toggles, teto, enviadosHoje, previstosHoje, ativos, respondidos, chip] = await Promise.all([
      this.prisma.globalSetting.findMany({
        where: { key: { in: REATIVACAO_TOGGLE_IDS.map((id) => reativacaoToggleKey(id, tenantId)) } },
        select: { key: true, value: true },
      }),
      this.readTeto(tenantId),
      // "Enviados hoje" = o que conta pro TETO (mesma regra do despachante): ENVIADO
      // de hoje + FALHOU "pode ter saído" de hoje (timeout/5xx em que a Evolution
      // pode ter entregue). Só ENVIADO deixava o painel em 0/30 com a Evolution lenta
      // enquanto as mensagens saíam. O "interrompido" (varredura de preso) não grava
      // sent_at — por isso o ramo pelo claimed_at.
      this.prisma.leadDispatch.count({
        where: {
          tenant_id: tenantId,
          OR: [
            { status: 'ENVIADO', sent_at: { gte: start, lt: end } },
            {
              status: 'FALHOU',
              motivo: { contains: TALVEZ_SAIU },
              OR: [
                { sent_at: { gte: start, lt: end } },
                { sent_at: null, claimed_at: { gte: start, lt: end } },
              ],
            },
          ],
        },
      }),
      // "Previstos hoje" = o que está na fila até o fim do dia (inclui atrasados que
      // escorreram de domingo/feriado/teto — saem assim que der).
      this.prisma.leadDispatch.count({
        where: { tenant_id: tenantId, status: 'AGENDADO', agendado_para: { lt: end } },
      }),
      this.prisma.leadReactivation.count({ where: { tenant_id: tenantId, status: 'ATIVA' } }),
      // Ciclos com resposta a um toque ENVIADO (replied_at) — conta ciclo, não mensagem.
      this.prisma.leadDispatch.findMany({
        where: { tenant_id: tenantId, replied_at: { gte: since30 } },
        distinct: ['reactivation_id'],
        select: { reactivation_id: true },
      }),
      // Mesmo chip que o despachante usa (só o COMERCIAL; sem ele não envia).
      this.prisma.instance.findFirst({
        where: { tenant_id: tenantId, type: 'whatsapp', purpose: 'COMERCIAL' },
        orderBy: { created_at: 'asc' },
        select: { name: true },
      }),
    ]);

    // Padrão DESLIGADO: só 'true' liga (começa tudo desligado).
    const on = (id: (typeof REATIVACAO_TOGGLE_IDS)[number]) =>
      toggles.find((t) => t.key === reativacaoToggleKey(id, tenantId))?.value === 'true';

    return {
      envio: on('reativacao_leads'),
      colunas: {
        novo: on('reativacao_novo'),
        conversa: on('reativacao_conversa'),
        convite: on('reativacao_convite'),
        agendado: on('reativacao_agendado'),
        orcamento: on('reativacao_orcamento'),
      },
      teto,
      enviados_hoje: enviadosHoje,
      previstos_hoje: previstosHoje,
      ativos,
      respondidos_30d: respondidos.length,
      chip_comercial: chip?.name ?? null,
    };
  }

  /**
   * Aba "Previstos": toques AGENDADO até N dias. Sem texto da IA ainda → devolve o
   * MODELO preenchido com o que já dá pra saber (nome, clínica, dentista, funil,
   * gancho, valores da tabela, data/hora da falta). {assunto}/{horario*} ficam visíveis: quem preenche
   * é o redator do worker, com o histórico e a agenda do dia.
   */
  async getScheduled(tenantIdRaw: string | null | undefined, coluna?: string, days?: string) {
    const tenantId = this.requireTenant(tenantIdRaw);
    const col = this.parseColunaOpcional(coluna);
    const dias = this.clampDias(days, 14, 60);
    const ate = new Date(Date.now() + dias * 86400000);

    const rows = await this.prisma.leadDispatch.findMany({
      where: {
        tenant_id: tenantId,
        status: 'AGENDADO',
        agendado_para: { lte: ate },
        ...(col ? { coluna: col } : {}),
      },
      orderBy: [{ agendado_para: 'asc' }, { toque: 'asc' }],
      take: LISTA_MAX,
      select: {
        id: true,
        lead_id: true,
        coluna: true,
        toque: true,
        agendado_para: true,
        texto: true,
        dentista_id: true,
        reactivation: { select: { ref_event_id: true } },
        lead: {
          select: {
            name: true,
            phone: true,
            pipeline: { select: { name: true, color: true, slug: true } },
          },
        },
      },
    });
    if (!rows.length) return { items: [] };

    const leadIds = [...new Set(rows.map((r) => r.lead_id))];
    const refIds = [...new Set(rows.map((r) => r.reactivation?.ref_event_id).filter((v): v is string => !!v))];
    // Só precisa montar o modelo pra quem ainda não tem texto da IA.
    const precisaModelo = rows.some((r) => !r.texto);

    const [convs, tenant, orcamentistas, modelosCustom, refEvents, { liberados, valores }] = await Promise.all([
      this.conversasPrincipais(tenantId, leadIds),
      precisaModelo
        ? this.prisma.tenant.findUnique({ where: { id: tenantId }, select: { name: true } })
        : Promise.resolve(null),
      precisaModelo
        ? this.prisma.user.findMany({
            where: { tenant_id: tenantId, specialties: { has: ORCAMENTISTA } },
            select: { id: true, name: true },
          })
        : Promise.resolve([] as { id: string; name: string }[]),
      precisaModelo
        ? this.prisma.tenantSetting.findMany({
            where: { tenant_id: tenantId, key: { startsWith: 'REATIVACAO_MODELO_' } },
            select: { key: true, value: true },
          })
        : Promise.resolve([] as { key: string; value: string }[]),
      precisaModelo && refIds.length
        ? this.prisma.calendarEvent.findMany({
            where: { id: { in: refIds }, tenant_id: tenantId },
            select: { id: true, start_at: true },
          })
        : Promise.resolve([] as { id: string; start_at: Date }[]),
      precisaModelo
        ? this.readPrecos(tenantId)
        : Promise.resolve({ liberados: new Set<number>(), valores: valoresPorProcedimento(null, false) }),
    ]);

    const clinica = String(tenant?.name || '').trim() || null;
    const orcById = new Map(orcamentistas.map((u) => [u.id, u.name]));
    const modeloCustom = new Map(modelosCustom.filter((m) => m.value?.trim()).map((m) => [m.key, m.value]));
    const refById = new Map(refEvents.map((e) => [e.id, e.start_at]));

    // Nomes que não estão entre as orçamentistas: a dentista já gravada no toque
    // (LeadDispatch.dentista_id) e, em clínica SEM orçamentista, o dentista da
    // conversa (o redator cai nele quando ensureOrcamentistaAssigned devolve null).
    const outrosIds = new Set<string>();
    if (precisaModelo) {
      for (const r of rows) {
        if (r.texto) continue;
        if (r.dentista_id && !orcById.has(r.dentista_id)) outrosIds.add(r.dentista_id);
        const assigned = convs.get(r.lead_id)?.assigned_dentist_id;
        if (!orcamentistas.length && assigned) outrosIds.add(assigned);
      }
    }
    const outros = outrosIds.size
      ? await this.prisma.user.findMany({
          where: { id: { in: [...outrosIds] }, tenant_id: tenantId },
          select: { id: true, name: true },
        })
      : [];
    const nomeUser = new Map<string, string>([...orcById, ...outros.map((u) => [u.id, u.name] as [string, string])]);

    // Mesma escolha do redator do worker (ensureOrcamentistaAssigned readOnly →
    // conv.assigned_dentist_id) e o MESMO formato (dentistaDoModelo do @crm/shared):
    // "Dra. <primeiro nome>", "doutora" quando não dá pra cravar (o modelo já tem o
    // artigo: "com a doutora"), "equipe de avaliação" pra orçamentista homem. Antes a
    // prévia fazia o próprio e mostrava "com a a doutora" / "Dra. Dra".
    const dentistaDe = (dispatchDentistaId: string | null, assignedId: string | null | undefined): string => {
      let nome: string | null = null;
      if (dispatchDentistaId && nomeUser.has(dispatchDentistaId)) nome = nomeUser.get(dispatchDentistaId)!;
      else if (assignedId && orcById.has(assignedId)) nome = orcById.get(assignedId)!;
      else if (!orcamentistas.length) nome = assignedId ? nomeUser.get(assignedId) ?? null : null;
      // 2+ orçamentistas sem trava: o worker escolhe a menos ocupada na hora → neutro.
      else if (orcamentistas.length === 1) nome = orcamentistas[0].name;
      return dentistaDoModelo(nome);
    };

    const items = rows.map((r) => {
      const conv = convs.get(r.lead_id) ?? null;
      const coluna = r.coluna;
      const total = this.isColuna(coluna) ? REATIVACAO_OFFSETS[coluna].length : r.toque;
      let texto = r.texto;
      let texto_status: 'ia' | 'modelo' = 'ia';
      if (!texto) {
        texto_status = 'modelo';
        const modelo = this.isColuna(coluna)
          ? modeloCustom.get(reativacaoModeloKey(coluna, r.toque)) ?? defaultReativacaoModelo(coluna, r.toque)
          : '';
        // Data/hora da falta: start_at é "naive-UTC" (hora de Maceió gravada como
        // UTC) → lê com getters UTC, sem converter fuso.
        const ref = r.reactivation?.ref_event_id ? refById.get(r.reactivation.ref_event_id) : null;
        const pad = (n: number) => String(n).padStart(2, '0');
        const slug = r.lead?.pipeline?.slug || '';
        // Preço ligado ao ITEM (mesma regra do worker): {valor_avaliacao}/{valor_limpeza}
        // vêm da linha de avaliação/limpeza da tabela; sem a linha, a FRASE sai (no
        // modelo cru). R$ fora da tabela (digitado à mão) sai pela 2ª barreira — a
        // prévia mostra o que de fato sairia. Gancho que sobrar vazio → o genérico.
        const ganchoBruto = (slug && REATIVACAO_GANCHOS[slug]) || REATIVACAO_GANCHO_GENERICO;
        const gancho =
          removerPrecosNaoLiberados(
            renderReativacaoModelo(removerFrasesComVariavelVazia(ganchoBruto, valores), valores),
            liberados,
          ) || REATIVACAO_GANCHO_GENERICO;
        const renderizado = renderReativacaoModelo(removerFrasesComVariavelVazia(modelo, valores), {
          ...valores,
          nome: this.primeiroNomeDoLead(r.lead?.name),
          clinica,
          dentista: dentistaDe(r.dentista_id, conv?.assigned_dentist_id),
          interesse: interesseDoFunil(r.lead?.pipeline?.name),
          gancho,
          data: ref ? `${pad(ref.getUTCDate())}/${pad(ref.getUTCMonth() + 1)}` : null,
          hora: ref ? `${pad(ref.getUTCHours())}:${pad(ref.getUTCMinutes())}` : null,
        });
        texto = removerPrecosNaoLiberados(renderizado, liberados);
      }
      return {
        id: r.id,
        lead_id: r.lead_id,
        lead_name: r.lead?.name || r.lead?.phone || '',
        lead_phone: r.lead?.phone || '',
        coluna,
        toque: r.toque,
        total_toques: total,
        agendado_para: r.agendado_para.toISOString(),
        texto,
        texto_status,
        pipeline: r.lead?.pipeline ? { name: r.lead.pipeline.name, color: r.lead.pipeline.color ?? null } : null,
        conversation_id: conv?.id ?? null,
      };
    });
    return { items };
  }

  /**
   * Aba "Enviados ✓": ENVIADO/FALHOU/CANCELADO/PULADO da janela. `entrega` vem do
   * Message.status das bolhas do toque (o webhook sobe pra 'entregue'/'lido' pelo
   * id da Evolution); `respondeu` = replied_at gravado no gancho da resposta.
   * `sent_at` sempre vem preenchido: pros que não saíram é o momento do
   * cancelamento/pulo (updated_at) — a tela mostra "quando" em todas as linhas.
   */
  async getSent(tenantIdRaw: string | null | undefined, coluna?: string, days?: string) {
    const tenantId = this.requireTenant(tenantIdRaw);
    const col = this.parseColunaOpcional(coluna);
    const dias = this.clampDias(days, 30, 180);
    const since = new Date(Date.now() - dias * 86400000);

    const rows = await this.prisma.leadDispatch.findMany({
      where: {
        tenant_id: tenantId,
        status: { in: ['ENVIADO', 'FALHOU', 'CANCELADO', 'PULADO'] },
        OR: [{ sent_at: { gte: since } }, { sent_at: null, updated_at: { gte: since } }],
        ...(col ? { coluna: col } : {}),
      },
      orderBy: { updated_at: 'desc' },
      take: LISTA_MAX,
      select: {
        id: true,
        lead_id: true,
        coluna: true,
        toque: true,
        sent_at: true,
        updated_at: true,
        texto: true,
        status: true,
        motivo: true,
        replied_at: true,
        external_message_ids: true,
        lead: { select: { name: true, phone: true } },
      },
    });
    if (!rows.length) return { items: [] };

    const leadIds = [...new Set(rows.map((r) => r.lead_id))];
    const msgIds = [...new Set(rows.flatMap((r) => r.external_message_ids || []))];
    const [convs, msgs] = await Promise.all([
      this.conversasPrincipais(tenantId, leadIds),
      msgIds.length
        ? this.prisma.message.findMany({
            where: { external_message_id: { in: msgIds }, conversation: { lead: { tenant_id: tenantId } } },
            select: { external_message_id: true, status: true },
          })
        : Promise.resolve([] as { external_message_id: string | null; status: string }[]),
    ]);
    const statusByMsg = new Map(msgs.map((m) => [m.external_message_id as string, m.status]));

    const items = rows
      .map((r) => {
        let entrega: Entrega | null = null;
        if (r.status === 'ENVIADO') {
          // Toque = 2–4 bolhas: vale o status mais avançado entre elas (o WhatsApp
          // marca leitura da conversa toda). Sem bolha gravada → 'enviado'.
          const rank = Math.max(1, ...(r.external_message_ids || []).map((id) => ENTREGA_RANK[statusByMsg.get(id) || ''] || 0));
          entrega = ENTREGA_LABEL[rank] as Entrega;
        }
        const quando = r.sent_at ?? r.updated_at;
        return {
          id: r.id,
          lead_id: r.lead_id,
          lead_name: r.lead?.name || r.lead?.phone || '',
          lead_phone: r.lead?.phone || '',
          coluna: r.coluna,
          toque: r.toque,
          total_toques: (REATIVACAO_OFFSETS as Record<string, number[]>)[r.coluna]?.length ?? r.toque,
          sent_at: quando.toISOString(),
          texto: r.texto ?? null,
          status: r.status as 'ENVIADO' | 'FALHOU' | 'CANCELADO' | 'PULADO',
          motivo: r.motivo ?? null,
          entrega,
          respondeu: r.replied_at != null,
          conversation_id: convs.get(r.lead_id)?.id ?? null,
        };
      })
      .sort((a, b) => b.sent_at.localeCompare(a.sent_at));
    return { items };
  }

  // ─── Ações ────────────────────────────────────────────────────────────────

  /** Pular UM toque agendado (só da própria clínica; o que já saiu não volta). */
  async skipDispatch(tenantIdRaw: string | null | undefined, id: string, userId?: string) {
    const tenantId = this.requireTenant(tenantIdRaw);
    const d = await this.prisma.leadDispatch.findFirst({
      where: { id, tenant_id: tenantId, status: 'AGENDADO' },
      select: { id: true, reactivation_id: true },
    });
    if (!d) throw new NotFoundException('Toque não encontrado (ou já saiu da fila)');
    // Condicional no status: se o despachante pegou no meio do caminho, não pula.
    const r = await this.prisma.leadDispatch.updateMany({
      where: { id, tenant_id: tenantId, status: 'AGENDADO' },
      data: { status: 'PULADO', motivo: 'pulado manualmente' },
    });
    if (r.count === 0) throw new NotFoundException('Toque não encontrado (ou já saiu da fila)');
    await this.fecharCicloSemPendentes(tenantId, d.reactivation_id, 'pulado manualmente');
    this.logger.log(`[REGUA-REATIV] toque ${id} pulado manualmente (tenant ${tenantId}, user ${userId || '-'})`);
    return { ok: true };
  }

  /**
   * Parar a régua de UM contato: cancela os toques agendados e encerra o ciclo.
   * opt_out=true marca o contato pra NUNCA mais entrar (mesma marca do "pare" no WhatsApp).
   */
  async stopLead(tenantIdRaw: string | null | undefined, leadId: string, optOut: boolean, userId?: string) {
    const tenantId = this.requireTenant(tenantIdRaw);
    const lead = await this.prisma.lead.findFirst({
      where: { id: leadId, tenant_id: tenantId },
      select: { id: true },
    });
    if (!lead) throw new NotFoundException('Contato não encontrado');
    const now = new Date();
    const [toques, ciclos] = await this.prisma.$transaction(async (tx) => {
      const t = await tx.leadDispatch.updateMany({
        where: { tenant_id: tenantId, lead_id: leadId, status: 'AGENDADO' },
        data: { status: 'CANCELADO', motivo: 'parado manualmente' },
      });
      const c = await tx.leadReactivation.updateMany({
        where: { tenant_id: tenantId, lead_id: leadId, status: 'ATIVA' },
        data: {
          status: 'CANCELADA',
          motivo_fim: optOut ? 'parado manualmente (não reativar mais)' : 'parado manualmente',
          ended_at: now,
        },
      });
      if (optOut) {
        // Não sobrescreve um opt-out anterior (preserva quando/por que pediu primeiro).
        await tx.lead.updateMany({
          where: { id: leadId, tenant_id: tenantId, contact_opt_out_at: null },
          data: { contact_opt_out_at: now, contact_opt_out_reason: 'parado manualmente no painel' },
        });
      }
      return [t.count, c.count];
    });
    this.logger.log(
      `[REGUA-REATIV] lead ${leadId} parado manualmente (tenant ${tenantId}, user ${userId || '-'}): ` +
        `${toques} toque(s) cancelado(s), ${ciclos} ciclo(s)${optOut ? ', opt-out gravado' : ''}`,
    );
    return { ok: true };
  }

  // ─── Configuração (Central de Disparos) ───────────────────────────────────

  async getConfig(tenantIdRaw: string | null | undefined) {
    const tenantId = this.requireTenant(tenantIdRaw);
    return { teto: await this.readTeto(tenantId) };
  }

  async setConfig(tenantIdRaw: string | null | undefined, tetoRaw: unknown) {
    const tenantId = this.requireTenant(tenantIdRaw);
    const teto = typeof tetoRaw === 'string' && tetoRaw.trim() ? Number(tetoRaw) : tetoRaw;
    if (typeof teto !== 'number' || !Number.isInteger(teto) || teto < TETO_MIN || teto > TETO_MAX) {
      throw new BadRequestException(`teto deve ser um número inteiro entre ${TETO_MIN} e ${TETO_MAX}`);
    }
    const value = String(teto);
    await this.prisma.tenantSetting.upsert({
      where: { tenant_id_key: { tenant_id: tenantId, key: REATIVACAO_TETO_KEY } },
      create: { tenant_id: tenantId, key: REATIVACAO_TETO_KEY, value },
      update: { value },
    });
    this.logger.log(`[REGUA-REATIV] teto diário = ${teto} (tenant ${tenantId})`);
    return { teto };
  }

  /** Texto-modelo de um toque: o da clínica (TenantSetting) → padrão do shared. */
  async getTemplate(tenantIdRaw: string | null | undefined, colunaRaw: string, toqueRaw: string) {
    const tenantId = this.requireTenant(tenantIdRaw);
    const { coluna, toque } = this.parseColunaToque(colunaRaw, toqueRaw);
    try {
      const row = await this.prisma.tenantSetting.findUnique({
        where: { tenant_id_key: { tenant_id: tenantId, key: reativacaoModeloKey(coluna, toque) } },
        select: { value: true },
      });
      if (row?.value?.trim()) return { template: row.value };
    } catch { /* linha ausente → padrão */ }
    return { template: defaultReativacaoModelo(coluna, toque) };
  }

  /**
   * Grava o texto-modelo. Vazio = volta ao padrão (apaga a linha — o worker cai no
   * padrão sem precisar tratar string vazia). Os toques AGENDADO desse texto que a
   * IA já escreveu com o modelo ANTIGO voltam pro redator (texto=null): senão sairia
   * o texto velho depois de a clínica ter editado.
   */
  async setTemplate(tenantIdRaw: string | null | undefined, colunaRaw: string, toqueRaw: string, template: unknown) {
    const tenantId = this.requireTenant(tenantIdRaw);
    const { coluna, toque } = this.parseColunaToque(colunaRaw, toqueRaw);
    if (template !== undefined && template !== null && typeof template !== 'string') {
      throw new BadRequestException('template deve ser texto');
    }
    const value = String(template ?? '');
    if (value.length > TEMPLATE_MAX) throw new BadRequestException(`template ultrapassa ${TEMPLATE_MAX} caracteres`);
    const key = reativacaoModeloKey(coluna, toque);
    if (!value.trim()) {
      await this.prisma.tenantSetting.deleteMany({ where: { tenant_id: tenantId, key } });
    } else {
      await this.prisma.tenantSetting.upsert({
        where: { tenant_id_key: { tenant_id: tenantId, key } },
        create: { tenant_id: tenantId, key, value },
        update: { value },
      });
    }
    const reescrever = await this.prisma.leadDispatch.updateMany({
      where: { tenant_id: tenantId, coluna, toque, status: 'AGENDADO', texto: { not: null } },
      data: { texto: null, texto_gerado_em: null },
    });
    this.logger.log(
      `[REGUA-REATIV] modelo ${coluna}/${toque} ${value.trim() ? 'salvo' : 'voltou ao padrão'} (tenant ${tenantId}); ` +
        `${reescrever.count} toque(s) agendado(s) voltam pro redator`,
    );
    return this.getTemplate(tenantId, coluna, String(toque));
  }
}

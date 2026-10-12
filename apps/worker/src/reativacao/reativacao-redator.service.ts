import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import {
  REATIVACAO_COLUNA_LABEL,
  REATIVACAO_GANCHO_GENERICO,
  REATIVACAO_GANCHOS,
  REATIVACAO_OFFSETS,
  REATIVACAO_TEXTO_MAX,
  REATIVACAO_TIPOS_MSG_INTERNA,
  reativacaoPedeHorarios,
  renderReativacaoModelo,
  type ReativacaoColuna,
} from '@crm/shared';
import { PrismaService } from '../prisma/prisma.service';
import { SettingsService } from '../settings/settings.service';
import { calculateCost, createLLMClient, type LLMProvider } from '../ai/llm-client';
import { loadClinicAiContext } from '../ai/clinic-ai-context';
import { leadFirstName } from '../ai/conversation-guide';
import { ensureOrcamentistaAssigned } from '../ai/orcamentista';
import { computeDaySlots } from '../ai/tool-handlers/check-availability';
import {
  JANELA_AUTOMACAO_MS,
  LOG,
  colunasLigadasPorClinica,
  conversaPrincipal,
  idsDaReguaDoLead,
  killSwitchLigado,
  lerModelo,
  lerValoresDaClinica,
  temposDeAutomacaoDoLead,
} from './reativacao-dados';
import {
  DIA_MS,
  chaveDiaMaceio,
  dentistaDoModelo,
  diaSemanaISO,
  escolherHorarios,
  interesseDoFunil,
  isReativacaoColuna,
  maceioNaive,
  mensagensReais,
  renderizarModeloFallback,
  rotuloHorario,
  sanitizarTextoIA,
  semFraseDeValorVazio,
  semPrecoNaoLiberado,
  somarDiasISO,
  validarTextoReativacao,
} from './reativacao-regras';

/** Toques escritos por rodada (cada um = 1 chamada curta ao LLM). */
const LOTE_POR_RODADA = 15;
/** Toque que não conseguiu texto válido espera isso antes de tentar de novo. */
const ESPERA_APOS_FALHA_MS = 60 * 60_000;
/** Toque vencido há mais que isso e ainda sem texto válido (IA e modelo falham) é cancelado. */
const DESISTE_SEM_TEXTO_MS = DIA_MS;
/** Oferta leve quando o toque pede horários e a agenda não tem vaga. */
const OFERTA_LEVE = 'Posso dar uma olhada na agenda e ver se consigo pra essa semana?';

const MIDIA_ROTULO: Record<string, string> = {
  audio: '[áudio]',
  image: '[imagem]',
  video: '[vídeo]',
  document: '[documento]',
  sticker: '[figurinha]',
};

/**
 * Régua de reativação — REDATOR (a cada 15 min, 7h–18h, seg–sáb, Maceió).
 *
 * Escreve o texto de cada toque que sai nas próximas 24h: pega o MODELO do toque
 * (o que a clínica salvou na Central ou o padrão), preenche as variáveis com dados
 * reais (nome, clínica, dentista, funil, 2 horários REAIS da agenda da
 * orçamentista…) e pede pra um LLM barato reescrever com o histórico daquele lead —
 * nunca a mesma mensagem pra todo mundo. O texto passa por validação (sem link, sem
 * preço/horário inventado, sem as frases proibidas); se a IA falhar, vai o modelo
 * preenchido (quando ele não depende da IA).
 *
 * Roda com o Envio desligado também: é o que alimenta a prévia dos "Previstos".
 */
@Injectable()
export class ReativacaoRedatorService {
  private readonly logger = new Logger(ReativacaoRedatorService.name);
  private busy = false;
  /** toque → quando pode tentar de novo (falhou IA e modelo, ou faltou conversa). */
  private espera = new Map<string, number>();

  constructor(
    private prisma: PrismaService,
    private settings: SettingsService,
  ) {}

  @Cron('*/15 7-18 * * 1-6', { timeZone: 'America/Maceio' })
  async tick() {
    await this.redigir();
  }

  async redigir(agora = new Date()): Promise<number> {
    if (this.busy) return 0;
    this.busy = true;
    try {
      if (await killSwitchLigado(this.prisma)) return 0;
      const ligadas = await colunasLigadasPorClinica(this.prisma);
      if (!ligadas.size) return 0;
      const toques = await this.prisma.leadDispatch.findMany({
        where: {
          tenant_id: { in: [...ligadas.keys()] },
          status: 'AGENDADO',
          texto: null,
          agendado_para: { lte: new Date(agora.getTime() + DIA_MS) },
          reactivation: { status: 'ATIVA' },
        },
        orderBy: { agendado_para: 'asc' },
        take: LOTE_POR_RODADA * 3,
        select: { id: true, tenant_id: true, lead_id: true, reactivation_id: true, coluna: true, toque: true, agendado_para: true },
      });
      const agoraMs = agora.getTime();
      for (const [id, ate] of this.espera) if (ate <= agoraMs) this.espera.delete(id);

      let feitos = 0;
      for (const t of toques) {
        if (feitos >= LOTE_POR_RODADA) break;
        if (!isReativacaoColuna(t.coluna) || !ligadas.get(t.tenant_id)?.has(t.coluna)) continue;
        if ((this.espera.get(t.id) ?? 0) > agoraMs) continue;
        feitos++;
        try {
          const ok = await this.redigirToque(t, t.coluna, agora);
          if (!ok) this.espera.set(t.id, agoraMs + ESPERA_APOS_FALHA_MS);
        } catch (e: any) {
          this.espera.set(t.id, agoraMs + ESPERA_APOS_FALHA_MS);
          this.logger.warn(`${LOG} redator: falha no toque ${t.id}: ${e?.message}`);
        }
      }
      return feitos;
    } catch (e: any) {
      this.logger.error(`${LOG} redator: rodada abortada: ${e?.message}`);
      return 0;
    } finally {
      this.busy = false;
    }
  }

  /** Escreve UM toque. true = gravou texto; false = não deu (tenta depois). */
  private async redigirToque(
    t: { id: string; tenant_id: string; lead_id: string; reactivation_id: string; toque: number; agendado_para: Date },
    coluna: ReativacaoColuna,
    agora: Date,
  ): Promise<boolean> {
    const tenantId = t.tenant_id;
    const lead = await this.prisma.lead.findFirst({
      where: { id: t.lead_id, tenant_id: tenantId },
      select: { id: true, name: true, phone: true, pipeline: { select: { name: true, slug: true } } },
    });
    if (!lead) return false;
    const conv = await conversaPrincipal(this.prisma, tenantId, lead.id);
    if (!conv) return false; // o despachante encerra o ciclo; aqui só não escreve
    const ciclo = await this.prisma.leadReactivation.findFirst({
      where: { id: t.reactivation_id, tenant_id: tenantId },
      select: { created_at: true, ref_event_id: true },
    });
    if (!ciclo) return false;

    // Preço: só o que a CLÍNICA liberou (Ajustes › IA › Valores), ligado ao item.
    // {valor_avaliacao}/{valor_limpeza} vêm da linha da avaliação/limpeza na tabela; sem
    // a linha (ou preços desligados) a FRASE sai do modelo e do gancho ANTES de ir pra
    // IA e pro fallback. O R$ digitado à mão fora da tabela também sai
    // (semPrecoNaoLiberado, 2ª barreira). O corte é no modelo CRU (com "{dentista}"):
    // no texto já com "Dra. Ana" o corte por frase partiria o nome no meio.
    const { liberados, valores } = await lerValoresDaClinica(this.prisma, tenantId);
    const modelo = semPrecoNaoLiberado(
      semFraseDeValorVazio(await lerModelo(this.prisma, tenantId, coluna, t.toque), valores),
      liberados,
    );
    const { firmName } = await loadClinicAiContext(this.prisma, tenantId, 'COMERCIAL');

    // Dentista = orçamentista que faria a avaliação. readOnly: a PRÉVIA não trava a
    // conversa num dentista. Mas a escolhida fica gravada no toque (dentista_id) e o
    // despachante trava ESSA na conversa ao enviar — senão, com 2+ orçamentistas, o
    // texto oferecia horário "com a Dra. Ana" e a IA, quando o lead aceitava,
    // travava a menos ocupada daquele momento (podia ser outra).
    let dentistaId: string | null = null;
    try {
      dentistaId = await ensureOrcamentistaAssigned(this.prisma, conv.id, { tenantId, readOnly: true });
    } catch (e: any) {
      this.logger.warn(`${LOG} redator: orçamentista não resolvida (conv ${conv.id}): ${e?.message}`);
    }
    dentistaId = dentistaId || conv.assigned_dentist_id;
    const dentistaUser = dentistaId
      ? await this.prisma.user.findFirst({ where: { id: dentistaId }, select: { name: true } }).catch(() => null)
      : null;

    // Horários REAIS (só quando o modelo pede {horario1}/{horario2}).
    const horarios = reativacaoPedeHorarios(modelo) && dentistaId ? await this.buscarHorarios(dentistaId, tenantId, agora) : [];

    // Faltou (coluna agendado): data/hora do no-show (agenda naive → getUTC*).
    let data: string | null = null;
    let hora: string | null = null;
    let diaFalta: number | null = null;
    if (coluna === 'agendado' && ciclo.ref_event_id) {
      const ev = await this.prisma.calendarEvent.findFirst({
        where: { id: ciclo.ref_event_id, tenant_id: tenantId },
        select: { start_at: true },
      });
      if (ev) {
        const iso = ev.start_at.toISOString();
        data = `${iso.slice(8, 10)}/${iso.slice(5, 7)}`;
        hora = iso.slice(11, 16);
        diaFalta = ev.start_at.getUTCDay();
      }
    }

    // Gancho do funil com os mesmos filtros de preço, já com os valores (sobrou vazio →
    // o genérico, sem preço).
    const ganchoBruto = (lead.pipeline?.slug && REATIVACAO_GANCHOS[lead.pipeline.slug]) || REATIVACAO_GANCHO_GENERICO;
    const gancho =
      renderReativacaoModelo(semPrecoNaoLiberado(semFraseDeValorVazio(ganchoBruto, valores), liberados), valores) ||
      REATIVACAO_GANCHO_GENERICO;

    const interesse = interesseDoFunil(lead.pipeline?.name);
    const nome = leadFirstName(lead.name);
    const vars: Record<string, string | null> = {
      nome,
      clinica: firmName || 'a clínica',
      dentista: dentistaDoModelo(dentistaUser?.name),
      interesse,
      gancho,
      data,
      hora,
      horario1: horarios[0]?.rotulo ?? null,
      horario2: horarios[1]?.rotulo ?? null,
      valor_avaliacao: valores.valor_avaliacao || null,
      valor_limpeza: valores.valor_limpeza || null,
    };
    // {assunto} fica pra IA inferir do histórico; o resto vai preenchido. É ESTE texto
    // (com os valores) que a IA recebe e que a validação usa como fonte dos preços
    // permitidos. O filtro de novo aqui é rede de segurança (preço que viesse por variável).
    const modeloRenderizado = semPrecoNaoLiberado(renderReativacaoModelo(modelo, vars), liberados);

    // Histórico REAL — sem notas internas/transferências (nunca foram pro lead e podem
    // ter desconto/comentário interno que a IA repetiria), sem os toques da régua e sem
    // as saídas automáticas de outra nutrição (pelo horário do envio) — a IA vê com
    // data e quem falou.
    const idsRegua = (await idsDaReguaDoLead(this.prisma, tenantId, [lead.id])).get(lead.id) ?? new Set<string>();
    const temposAuto =
      (
        await temposDeAutomacaoDoLead(
          this.prisma,
          tenantId,
          [{ id: lead.id, phone: lead.phone }],
          new Date(agora.getTime() - JANELA_AUTOMACAO_MS),
        )
      ).get(lead.id) ?? [];
    const reais = mensagensReais(
      await this.prisma.message.findMany({
        where: { conversation_id: conv.id, type: { notIn: [...REATIVACAO_TIPOS_MSG_INTERNA] } },
        orderBy: { created_at: 'desc' },
        take: 40,
        select: { direction: true, type: true, created_at: true, external_message_id: true, text: true },
      }),
      idsRegua,
      temposAuto,
    );
    const baseMsgAt = reais[0]?.created_at ?? null;
    const diasParado = Math.max(0, Math.floor((agora.getTime() - (baseMsgAt ?? ciclo.created_at).getTime()) / DIA_MS));
    const anteriores = await this.prisma.leadDispatch.findMany({
      where: { reactivation_id: t.reactivation_id, tenant_id: tenantId, toque: { lt: t.toque }, texto: { not: null } },
      orderBy: { toque: 'asc' },
      select: { toque: true, texto: true, status: true },
    });

    const ctxValidacao = {
      modeloRenderizado,
      precosLiberados: liberados,
      horarios: horarios.map((h) => h.hora),
      datas: [...horarios.map((h) => h.ddmm), ...(data ? [data] : [])],
      diasHorarios: [
        ...horarios.map((h) => ({ dia: h.dia, hora: h.hora })),
        ...(diaFalta != null && hora ? [{ dia: diaFalta, hora }] : []),
      ],
    };

    // 1) IA reescreve com o histórico.
    let texto: string | null = null;
    let origem = 'ia';
    const ia = await this.escreverComIA({
      tenantId,
      conversationId: conv.id,
      coluna,
      toque: t.toque,
      totalToques: REATIVACAO_OFFSETS[coluna].length,
      modeloRenderizado,
      nome,
      interesse,
      horarios: horarios.map((h) => h.rotulo),
      pedeHorarios: reativacaoPedeHorarios(modelo),
      diasParado,
      historico: reais.slice(0, 10).reverse(),
      anteriores: anteriores.map((a) => ({ toque: a.toque, texto: a.texto || '', enviado: a.status === 'ENVIADO' })),
      agora,
    });
    if (ia) {
      const limpo = sanitizarTextoIA(ia);
      const v = validarTextoReativacao(limpo, ctxValidacao);
      if (v.ok) texto = limpo;
      else this.logger.warn(`${LOG} redator: texto da IA recusado (toque ${t.id}): ${v.motivo}`);
    }
    // 2) Sem IA (ou recusada): o modelo preenchido, se ele não depender da IA.
    if (!texto) {
      // Parte do MESMO modelo já sem preço não liberado (o fallback sai sem IA nenhuma);
      // o filtro de novo é rede de segurança.
      const fbBruto = renderizarModeloFallback(modelo, { ...vars, assunto: interesse });
      const fb = fbBruto ? semPrecoNaoLiberado(fbBruto, liberados) : null;
      if (fb && validarTextoReativacao(fb, ctxValidacao).ok) {
        texto = fb;
        origem = 'modelo';
      }
    }
    if (!texto) {
      // Nem IA nem modelo (ex.: modelo com [instrução] e a IA fora do ar). Tenta de
      // novo depois; vencido há mais de 1 dia, desiste do toque pra não travar o ciclo.
      if (agora.getTime() - new Date(t.agendado_para).getTime() > DESISTE_SEM_TEXTO_MS) {
        await this.prisma.leadDispatch.updateMany({
          where: { id: t.id, tenant_id: tenantId, status: 'AGENDADO', texto: null },
          data: { status: 'CANCELADO', motivo: 'sem texto válido (IA e modelo)' },
        });
        this.logger.warn(`${LOG} redator: toque ${t.id} cancelado — sem texto válido há mais de 1 dia`);
      }
      return false;
    }

    // Grava só se o toque ainda está esperando texto (o despachante pode ter mexido).
    // dentista_id = a profissional citada no texto e dona dos horários oferecidos: o
    // despachante a trava na conversa ao enviar (a IA reaproveita o lock-in).
    const r = await this.prisma.leadDispatch.updateMany({
      where: { id: t.id, tenant_id: tenantId, status: 'AGENDADO', texto: null },
      data: { texto, texto_gerado_em: agora, base_msg_at: baseMsgAt, dentista_id: dentistaId },
    });
    if (r.count) this.logger.log(`${LOG} redator: toque ${t.toque} (${coluna}) do lead ${lead.id} escrito (${origem})`);
    return r.count > 0;
  }

  /**
   * 2 horários reais da orçamentista: de amanhã até 14 dias (agenda naive), pula
   * domingo, para nos 2 primeiros dias com vaga; 1º horário de cada (escolherHorarios).
   * Mesma fonte do check_availability (computeDaySlots: turnos, bloqueios, feriados).
   */
  private async buscarHorarios(
    dentistaId: string,
    tenantId: string,
    agora: Date,
  ): Promise<{ rotulo: string; hora: string; ddmm: string; dia: number }[]> {
    const dias: { diaISO: string; horas: string[] }[] = [];
    const hoje = chaveDiaMaceio(agora);
    try {
      for (let i = 1; i <= 14 && dias.length < 2; i++) {
        const diaISO = somarDiasISO(hoje, i);
        if (diaSemanaISO(diaISO) === 0) continue;
        const horas = await computeDaySlots(this.prisma, dentistaId, diaISO, 60, tenantId);
        if (horas.length) dias.push({ diaISO, horas });
      }
    } catch (e: any) {
      this.logger.warn(`${LOG} redator: falha ao consultar a agenda (dentista ${dentistaId}): ${e?.message}`);
      return [];
    }
    return escolherHorarios(dias).map((h) => ({
      rotulo: rotuloHorario(h.diaISO, h.hora),
      hora: h.hora,
      ddmm: `${h.diaISO.slice(8, 10)}/${h.diaISO.slice(5, 7)}`,
      dia: diaSemanaISO(h.diaISO),
    }));
  }

  /** Chamada curta ao LLM (provider/modelo do router do worker). null = sem chave/erro. */
  private async escreverComIA(p: {
    tenantId: string;
    conversationId: string;
    coluna: ReativacaoColuna;
    toque: number;
    totalToques: number;
    modeloRenderizado: string;
    nome: string | null;
    interesse: string;
    horarios: string[];
    pedeHorarios: boolean;
    diasParado: number;
    historico: { direction: string; type?: string | null; created_at: Date; text?: string | null }[];
    anteriores: { toque: number; texto: string; enviado: boolean }[];
    agora: Date;
  }): Promise<string | null> {
    const router = await this.settings.getRouterConfig();
    const provider = (router.provider === 'anthropic' ? 'anthropic' : 'openai') as LLMProvider;
    const apiKey = provider === 'anthropic' ? await this.settings.getAnthropicKey() : await this.settings.getOpenAiKey();
    if (!apiKey) return null;
    const model = router.model || 'gpt-4.1-mini';

    const fmt = (d: Date) => {
      const n = maceioNaive(new Date(d)).toISOString();
      return `${n.slice(8, 10)}/${n.slice(5, 7)} ${n.slice(11, 16)}`;
    };
    const historico = p.historico.length
      ? p.historico
          .map((m) => {
            const quem = m.direction === 'in' ? 'Contato' : 'Clínica';
            const txt = (m.text || MIDIA_ROTULO[String(m.type)] || '[mídia]').replace(/\s+/g, ' ').slice(0, 300);
            return `[${fmt(m.created_at)}] ${quem}: ${txt}`;
          })
          .join('\n')
      : '(sem mensagens anteriores)';
    const anteriores = p.anteriores.length
      ? p.anteriores.map((a) => `Toque ${a.toque}${a.enviado ? ' (já enviado)' : ''}:\n${a.texto}`).join('\n\n')
      : '(nenhum — este é o primeiro toque)';
    const horarios = p.pedeHorarios
      ? p.horarios.length >= 2
        ? `HORÁRIOS REAIS (os únicos que você pode oferecer): ${p.horarios[0]} ou ${p.horarios[1]}.`
        : p.horarios.length === 1
          ? `Só há UM horário real: ${p.horarios[0]}. Ofereça só ele (sem "ou").`
          : `NÃO há horário livre na agenda: troque a oferta de horários do modelo por: "${OFERTA_LEVE}"`
      : 'Este toque não oferece horários: não proponha dia nem hora de consulta (pode manter as datas que já estão no MODELO).';

    const systemPrompt = `Você escreve UMA mensagem de WhatsApp da recepção de uma clínica odontológica para retomar o contato com uma pessoa que parou de responder.

CONTEXTO: é uma mensagem de RETOMADA depois de ${p.diasParado} dia(s) de silêncio. A última conversa NÃO é de agora: não responda mensagens antigas como se tivessem acabado de chegar e não peça desculpa pela demora.

REGRAS (todas obrigatórias):
- Siga o MODELO: mantenha o objetivo, a estrutura e o convite final dele. Adapte ao histórico (o que a pessoa contou, a dúvida, o interesse) para soar pessoal, nunca genérico.
- 2 a 4 balões curtos, separados por UMA LINHA EM BRANCO. Uma ideia por balão. No máximo ${REATIVACAO_TEXTO_MAX} caracteres no total.
- UMA pergunta no total, no fim.
- No máximo 1 emoji.
- ${p.nome ? `Chame só pelo primeiro nome: ${p.nome}.` : 'Você não sabe o nome da pessoa: não use nome nem invente um.'}
- Nunca diga que é IA, robô ou assistente virtual. Não assine a mensagem.
- Sem links.
- Preço, desconto, porcentagem e parcelamento: só os que já estão no MODELO. Se o MODELO não cita valor, não cite valor nenhum. NUNCA reaproveite valor ou condição que apareça no HISTÓRICO, e não invente preço, desconto nem condição.
- Horários: ${horarios}
- Nunca invente dia, data ou horário.
- {assunto}: troque pelo assunto concreto da conversa em poucas palavras (o que a pessoa queria resolver). Se não der pra saber, use "${p.interesse}".
- Trechos entre colchetes [ ] no MODELO são instruções pra VOCÊ escrever (ex.: a resposta curta à dúvida que ficou em aberto, tirada do histórico). Nunca copie os colchetes.
- Não repita frases nem ideias dos toques anteriores deste ciclo.
- Proibido: "Precisando, é só me chamar", "fico à disposição", "depende muito do que você vai precisar", "a gente agenda sem compromisso", "só na avaliação a doutora consegue te dizer", "você sumiu".
- Sem travessão (—).

Responda APENAS um JSON: {"texto": "<a mensagem, com os balões separados por linha em branco>"}`;

    const userContent = [
      `Hoje: ${fmt(p.agora)}. Etapa: ${REATIVACAO_COLUNA_LABEL[p.coluna]}. Toque ${p.toque} de ${p.totalToques}.`,
      '',
      'MODELO DESTE TOQUE:',
      p.modeloRenderizado,
      '',
      'HISTÓRICO DA CONVERSA (mais antigo primeiro):',
      historico,
      '',
      'TOQUES ANTERIORES DESTE CICLO (não repita):',
      anteriores,
    ].join('\n');

    try {
      const client = createLLMClient(provider, apiKey);
      const resp = await client.chat({
        model,
        systemPrompt,
        messages: [{ role: 'user', content: userContent }],
        maxTokens: 700,
        temperature: 0.6,
        jsonMode: true,
      });
      this.registrarCusto(p.tenantId, p.conversationId, resp.model || model, resp.usage).catch(() => undefined);
      const raw = String(resp.content || '').trim();
      const json = raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1);
      const parsed = JSON.parse(json || '{}');
      return typeof parsed?.texto === 'string' ? parsed.texto : null;
    } catch (e: any) {
      this.logger.warn(`${LOG} redator: LLM falhou (${provider}/${model}): ${e?.message}`);
      return null;
    }
  }

  /** Custo no painel de IA (call_type 'reativacao'). Best-effort. */
  private async registrarCusto(
    tenantId: string,
    conversationId: string,
    model: string,
    usage: { promptTokens: number; completionTokens: number; totalTokens: number },
  ): Promise<void> {
    if (!usage?.totalTokens) return;
    await this.prisma.aiUsage.create({
      data: {
        tenant_id: tenantId,
        conversation_id: conversationId,
        model,
        call_type: 'reativacao',
        prompt_tokens: usage.promptTokens,
        completion_tokens: usage.completionTokens,
        total_tokens: usage.totalTokens,
        cost_usd: calculateCost(model, usage.promptTokens, usage.completionTokens),
      },
    });
  }
}

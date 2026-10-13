import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import axios from 'axios';
import {
  REATIVACAO_OFFSETS,
  REATIVACAO_OPT_OUT_RE,
  REATIVACAO_TIPOS_MSG_INTERNA,
  brazilPhoneMatchVariants,
  toBrazilWhatsappNumber,
} from '@crm/shared';
import { PrismaService } from '../prisma/prisma.service';
import { SettingsService } from '../settings/settings.service';
import { loadClinicAiContext } from '../ai/clinic-ai-context';
import { bubbleTypingMs } from '../ai/conversation-guide';
import { ORCAMENTISTA_SPECIALTY } from '../ai/orcamentista';
import {
  FORA_DO_FINANCEIRO,
  LOG,
  clinicaFechadaHoje,
  clinicasComEnvioLigado,
  colunaGeralDoLead,
  colunaValida,
  colunasLigadasPorClinica,
  conversaPrincipal,
  encerrarCiclo,
  JANELA_AUTOMACAO_MS,
  idsDaReguaDoLead,
  irmaosDoNumero,
  killSwitchLigado,
  lerTeto,
  temConsultaFutura,
  temposDeAutomacaoDoLead,
  ultimasMensagens,
} from './reativacao-dados';
import {
  ENVIANDO_PRESO_MS,
  ETAPAS_LEGADAS_FORA,
  JANELA_UMA_MSG_DIA_MS,
  MOTIVO_NAO_PACIENTE,
  MOTIVO_PODE_TER_SAIDO,
  PAUSA_CHIP_CAIDO_MS,
  PAUSA_DISJUNTOR_MS,
  amanhaAsNove,
  chaveDiaMaceio,
  classificarEnvio,
  dentroDaJanela,
  disjuntorAbre,
  dividirBaloes,
  ehNaoPaciente,
  inicioDiaMaceio,
  interpretarWhatsappNumbers,
  intervaloChipMs,
  leadFalouPorUltimo,
  mensagensReais,
  optOutDefinitivo,
  pedidoDeParar,
  reancorarToques,
  textoPrecisaReescrever,
  variantesEnvio,
  type ResultadoEnvio,
} from './reativacao-regras';

/** Quantos toques o despachante tenta por clínica num tick quando o escolhido é pulado/adiado. */
const TENTATIVAS_POR_TICK = 5;

type Evo = { apiUrl: string; apiKey: string };
/**
 * O que aconteceu com um toque reivindicado. 'pulado' = nada saiu (dá pra tentar o
 * próximo). 'talvez_saiu' = FALHOU mas pode ter chegado (alimenta o disjuntor do chip).
 */
type Desfecho = 'enviado' | 'tentou' | 'talvez_saiu' | 'pulado' | 'chip_caido';

/**
 * Régua de reativação — DESPACHANTE (a cada minuto, 8:00–18:59, seg–sáb, Maceió).
 *
 * Só nas clínicas com o ENVIO ligado (Central de Disparos) e sem o kill-switch. Sai
 * SÓ pelo chip COMERCIAL da clínica (sem ele, não envia — nunca cai em outro chip).
 *
 * Anti-bloqueio, em camadas:
 *   - dia fechado da clínica (feriado / grade de horários) = não envia (erro = não envia);
 *   - janela 8:00–18:59 rechecada com a hora real antes de cada clínica/tentativa;
 *   - teto diário por clínica (ENVIADOS + FALHOU "pode ter saído");
 *   - disjuntor: 2 "pode ter saído" seguidos no chip = pausa de 15 min;
 *   - marca-passo POR CHIP no banco (WhatsappChipPacer): 3–7 min entre envios no
 *     mesmo chip, reservado de forma atômica (vale entre réplicas do worker);
 *   - claim atômico do toque (AGENDADO → ENVIANDO): duas réplicas nunca mandam o mesmo;
 *   - 1 mensagem por dia por lead (saiu algo nas últimas 20h → adia pra amanhã 9h).
 *
 * Antes de cada envio reconfere tudo (virou paciente, pediu pra parar — inclusive no
 * histórico —, agendou, respondeu, humano assumiu, mudou de etapa, a conversa andou),
 * olhando também os leads GÊMEOS do mesmo número — o webhook da API
 * também para a régua na resposta, mas ele pode falhar num deploy: ESTA checagem é
 * a fonte da verdade.
 *
 * Timeout/5xx = FALHOU "pode ter saído" e NUNCA reenvia sozinho; toque preso em
 * ENVIANDO (processo morreu no meio) também vira FALHOU (varredura).
 */
@Injectable()
export class ReativacaoDespachanteService {
  private readonly logger = new Logger(ReativacaoDespachanteService.name);
  private busy = false;
  /** Dia fechado por clínica (cache de 30 min, pra pegar feriado cadastrado no dia): tenant → { ate, motivo|null }. */
  private fechado = new Map<string, { ate: number; motivo: string | null }>();
  /** Evita repetir o mesmo aviso (ex.: "sem chip Comercial") a cada minuto. */
  private avisado = new Map<string, string>();

  constructor(
    private prisma: PrismaService,
    private settings: SettingsService,
  ) {}

  @Cron('*/1 8-18 * * 1-6', { timeZone: 'America/Maceio' })
  async tick() {
    await this.despachar();
  }

  /** Toque ENVIANDO há mais de 15 min = processo morreu no meio: FALHOU, nunca reenvia. */
  @Cron('*/5 * * * *', { timeZone: 'America/Maceio' })
  async varrerPresos(agora = new Date()): Promise<number> {
    try {
      const limite = new Date(agora.getTime() - ENVIANDO_PRESO_MS);
      const r = await this.prisma.leadDispatch.updateMany({
        where: {
          status: 'ENVIANDO',
          OR: [{ claimed_at: { lt: limite } }, { claimed_at: null, updated_at: { lt: limite } }],
        },
        data: { status: 'FALHOU', motivo: `interrompido (${MOTIVO_PODE_TER_SAIDO})` },
      });
      if (r.count) this.logger.warn(`${LOG} ${r.count} toque(s) presos em ENVIANDO marcados como FALHOU (não reenvia)`);
      return r.count;
    } catch (e: any) {
      this.logger.warn(`${LOG} varredura de ENVIANDO falhou: ${e?.message}`);
      return 0;
    }
  }

  async despachar(agora = new Date()): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    // Relógio que ANDA durante o tick: o `agora` é congelado no início, mas o tick
    // das 18:59 processa as clínicas em sequência (cada uma leva de segundos a ~1 min
    // entre checagem do número, digitação e balões) — a janela é rechecada com a hora
    // real antes de cada clínica e de cada tentativa, pra nada sair depois das 19:00.
    const inicioTick = Date.now();
    const agoraReal = () => new Date(agora.getTime() + (Date.now() - inicioTick));
    try {
      if (!dentroDaJanela(agora)) return;
      if (await killSwitchLigado(this.prisma)) return;
      const clinicas = await clinicasComEnvioLigado(this.prisma);
      if (!clinicas.length) return;
      const ligadas = await colunasLigadasPorClinica(this.prisma);
      for (const tenantId of clinicas) {
        if (!dentroDaJanela(agoraReal())) break;
        const colunas = ligadas.get(tenantId);
        if (!colunas?.size) continue;
        try {
          await this.despacharClinica(tenantId, [...colunas], agora, agoraReal);
        } catch (e: any) {
          this.logger.error(`${LOG} despachante: falha na clínica ${tenantId}: ${e?.message}`);
        }
      }
    } catch (e: any) {
      this.logger.error(`${LOG} despachante: tick abortado: ${e?.message}`);
    } finally {
      this.busy = false;
    }
  }

  private avisarUmaVez(chave: string, dia: string, msg: string) {
    if (this.avisado.get(chave) === dia) return;
    this.avisado.set(chave, dia);
    this.logger.warn(msg);
  }

  private async despacharClinica(
    tenantId: string,
    colunas: string[],
    agora: Date,
    agoraReal: () => Date = () => new Date(),
  ): Promise<void> {
    const dia = chaveDiaMaceio(agora);
    const filtroDevidos = {
      tenant_id: tenantId,
      status: 'AGENDADO',
      agendado_para: { lte: agora },
      texto: { not: null },
      coluna: { in: colunas },
      reactivation: { status: 'ATIVA' },
    };
    // Nada vencido com texto pronto → nem gasta a vez do chip.
    const algum = await this.prisma.leadDispatch.findFirst({ where: filtroDevidos, select: { id: true } });
    if (!algum) return;

    // Dia fechado (feriado / grade da clínica). Erro ao checar = não envia (mensagem fria: na dúvida, não manda).
    let cache = this.fechado.get(tenantId);
    if (!cache || cache.ate <= agora.getTime()) {
      try {
        // TTL curto e nunca atravessa a meia-noite de Maceió (o dia seguinte reavalia).
        const ate = Math.min(agora.getTime() + 30 * 60_000, inicioDiaMaceio(agora).getTime() + 86_400_000);
        cache = { ate, motivo: await clinicaFechadaHoje(this.prisma, tenantId, agora) };
        this.fechado.set(tenantId, cache);
      } catch (e: any) {
        this.logger.warn(`${LOG} clínica ${tenantId}: não deu pra checar feriado/horário (${e?.message}) — não envia agora`);
        return;
      }
    }
    if (cache.motivo) {
      this.avisarUmaVez(`fechado:${tenantId}`, dia, `${LOG} clínica ${tenantId}: ${cache.motivo} — régua parada hoje`);
      return;
    }

    // Só o chip COMERCIAL (mesma regra do envio humano: o mais antigo). Sem ele, não envia.
    const chip = await this.prisma.instance.findFirst({
      where: { tenant_id: tenantId, type: 'whatsapp', purpose: 'COMERCIAL' },
      orderBy: { created_at: 'asc' },
      select: { name: true },
    });
    if (!chip?.name) {
      this.avisarUmaVez(`chip:${tenantId}`, dia, `${LOG} clínica ${tenantId}: sem chip COMERCIAL — régua não envia`);
      return;
    }

    // Teto do dia (dia de Maceió): ENVIADOS + os FALHOU que PODEM ter saído (timeout,
    // 5xx, erro depois de falar com a Evolution, preso em ENVIANDO). A Evolution às
    // vezes responde erro mas entrega: se só ENVIADO contasse, uma Evolution lenta
    // deixaria o contador parado e a régua mandaria o dia todo, furando o teto.
    // 'recusado'/SEM_WHATSAPP/telefone inválido não saíram e não contam. O
    // 'interrompido' da varredura não grava sent_at — por isso o claimed_at.
    const teto = await lerTeto(this.prisma, tenantId);
    const inicioHoje = inicioDiaMaceio(agora);
    const enviadosHoje = await this.prisma.leadDispatch.count({
      where: {
        tenant_id: tenantId,
        OR: [
          { status: 'ENVIADO', sent_at: { gte: inicioHoje } },
          {
            status: 'FALHOU',
            motivo: { contains: MOTIVO_PODE_TER_SAIDO },
            OR: [{ sent_at: { gte: inicioHoje } }, { claimed_at: { gte: inicioHoje } }],
          },
        ],
      },
    });
    if (enviadosHoje >= teto) {
      this.avisarUmaVez(`teto:${tenantId}`, dia, `${LOG} clínica ${tenantId}: teto do dia atingido (${enviadosHoje}/${teto})`);
      return;
    }

    const evo = await this.settings.getEvolutionConfig();
    if (!evo?.apiUrl || !evo?.apiKey) {
      this.avisarUmaVez('evo', dia, `${LOG} Evolution não configurada — régua não envia`);
      return;
    }

    // Vez do chip (atômico, vale entre réplicas): só quem move next_allowed_at envia.
    await this.prisma.whatsappChipPacer.createMany({
      data: [{ instance_name: chip.name, next_allowed_at: new Date(0) }],
      skipDuplicates: true,
    });
    const vez = await this.prisma.whatsappChipPacer.updateMany({
      where: { instance_name: chip.name, next_allowed_at: { lte: agora } },
      data: { next_allowed_at: new Date(agora.getTime() + intervaloChipMs()) },
    });
    if (vez.count === 0) return;

    let desfecho: Desfecho = 'pulado';
    const vistos: string[] = [];
    try {
      for (let i = 0; i < TENTATIVAS_POR_TICK; i++) {
        // Rechecagem da janela com a hora REAL, ANTES do claim (nunca deixa toque preso
        // em ENVIANDO): a vez do chip volta no finally porque o desfecho fica 'pulado'.
        if (!dentroDaJanela(agoraReal())) break;
        const cand = await this.prisma.leadDispatch.findFirst({
          where: { ...filtroDevidos, ...(vistos.length ? { id: { notIn: vistos } } : {}) },
          orderBy: { agendado_para: 'asc' },
          select: { id: true, reactivation_id: true, toque: true },
        });
        if (!cand) break;
        vistos.push(cand.id);
        // Toque anterior do mesmo ciclo ainda pendente (ex.: sem texto) → não pula a ordem.
        const anterior = await this.prisma.leadDispatch.count({
          where: {
            tenant_id: tenantId,
            reactivation_id: cand.reactivation_id,
            toque: { lt: cand.toque },
            status: { in: ['AGENDADO', 'ENVIANDO'] },
          },
        });
        if (anterior) continue;
        // CLAIM atômico: só quem vira AGENDADO→ENVIANDO segue (outra réplica pegou = count 0).
        const claim = await this.prisma.leadDispatch.updateMany({
          where: { id: cand.id, tenant_id: tenantId, status: 'AGENDADO' },
          data: { status: 'ENVIANDO', claimed_at: agora },
        });
        if (claim.count === 0) continue;
        desfecho = await this.processarToque(cand.id, tenantId, chip.name, evo, agora);
        if (desfecho !== 'pulado') break;
      }
    } finally {
      // Nada saiu → devolve a vez do chip (o próximo tick tenta de novo). Chip caído →
      // segura a clínica (o chip dela) por 30 min. "Pode ter saído" 2× seguidas no chip
      // → disjuntor: segura 15 min (Evolution degradada).
      if (desfecho === 'pulado') {
        await this.prisma.whatsappChipPacer
          .updateMany({ where: { instance_name: chip.name }, data: { next_allowed_at: agora } })
          .catch(() => undefined);
      } else if (desfecho === 'chip_caido') {
        await this.prisma.whatsappChipPacer
          .updateMany({ where: { instance_name: chip.name }, data: { next_allowed_at: new Date(Date.now() + PAUSA_CHIP_CAIDO_MS) } })
          .catch(() => undefined);
        this.logger.warn(`${LOG} clínica ${tenantId}: chip ${chip.name} fora do ar — régua pausada 30 min`);
      } else if (desfecho === 'talvez_saiu') {
        await this.dispararDisjuntorSePreciso(tenantId, chip.name);
      }
    }
  }

  /**
   * Disjuntor do chip (vale entre réplicas: olha o banco, não memória): as 2 últimas
   * tentativas da régua NESTE chip foram FALHOU "pode ter saído" → pausa o chip 15 min.
   * Nunca lança (roda no finally).
   */
  private async dispararDisjuntorSePreciso(tenantId: string, chip: string): Promise<void> {
    try {
      const ultimas = await this.prisma.leadDispatch.findMany({
        where: { tenant_id: tenantId, instance_name: chip, status: { in: ['ENVIADO', 'FALHOU'] }, sent_at: { not: null } },
        orderBy: { sent_at: 'desc' },
        take: 2,
        select: { status: true, motivo: true },
      });
      if (!disjuntorAbre(ultimas)) return;
      await this.prisma.whatsappChipPacer.updateMany({
        where: { instance_name: chip },
        data: { next_allowed_at: new Date(Date.now() + PAUSA_DISJUNTOR_MS) },
      });
      this.logger.warn(`${LOG} clínica ${tenantId}: 2 envios seguidos "pode ter saído" no chip ${chip} — disjuntor: régua pausada 15 min`);
    } catch (e: any) {
      this.logger.warn(`${LOG} disjuntor do chip ${chip} não avaliou: ${e?.message}`);
    }
  }

  /**
   * Toque já reivindicado (ENVIANDO): reconfere, envia e registra. Qualquer erro
   * ANTES de falar com a Evolution devolve o toque pra AGENDADO; depois de tentar
   * enviar, nunca volta (não arrisca mandar 2×).
   */
  private async processarToque(id: string, tenantId: string, chip: string, evo: Evo, agora: Date): Promise<Desfecho> {
    let falouComEvolution = false;
    const voltar = (data: Record<string, unknown> = {}) =>
      this.prisma.leadDispatch.updateMany({
        where: { id, tenant_id: tenantId, status: 'ENVIANDO' },
        data: { status: 'AGENDADO', claimed_at: null, ...data },
      });
    try {
      const t = await this.prisma.leadDispatch.findFirst({
        where: { id, tenant_id: tenantId },
        select: {
          id: true, toque: true, coluna: true, texto: true, texto_gerado_em: true, base_msg_at: true, dentista_id: true,
          reactivation: { select: { id: true, status: true, created_at: true, coluna: true, ref_event_id: true } },
          lead: {
            select: {
              id: true, tenant_id: true, name: true, phone: true, stage: true, stage_id: true,
              is_client: true, contact_opt_out_at: true, whatsapp_invalid_at: true,
              non_patient_category: true,
            },
          },
        },
      });
      if (!t) return 'pulado';
      const ciclo = t.reactivation;
      const lead = t.lead;
      const encerrar = async (status: string, motivo: string): Promise<Desfecho> => {
        await encerrarCiclo(this.prisma, { tenantId, cicloId: ciclo.id, status, motivo, toqueEmMaosId: id, agora });
        this.logger.log(`${LOG} toque ${id} (lead ${lead?.id}) não enviado: ${motivo} → ciclo ${status}`);
        return 'pulado';
      };

      // ── Checagens (motivo no toque e no ciclo) ──
      if (ciclo.status !== 'ATIVA') {
        await this.prisma.leadDispatch.updateMany({
          where: { id, status: 'ENVIANDO' },
          data: { status: 'CANCELADO', motivo: 'ciclo encerrado' },
        });
        return 'pulado';
      }
      const coluna = colunaValida(ciclo.coluna);
      if (!lead || lead.tenant_id !== tenantId || !coluna) return encerrar('CANCELADA', 'lead/coluna inválidos');

      // A régua fala com a PESSOA, não com o lead_id: o mesmo número pode estar em 2
      // leads (12 × 13 dígitos). Se QUALQUER gêmeo virou cliente, pediu pra parar,
      // não tem WhatsApp ou respondeu, este ciclo para também.
      const irmaos = await irmaosDoNumero(this.prisma, tenantId, lead);
      const irmaosIds = irmaos.map((l) => l.id);
      if (irmaos.some((l) => l.is_client)) return encerrar('VIROU_PACIENTE', 'virou paciente');
      if (irmaos.some((l) => l.contact_opt_out_at)) return encerrar('OPT_OUT', 'pediu pra parar');
      if (irmaos.some((l) => l.whatsapp_invalid_at)) return encerrar('SEM_WHATSAPP', 'número sem WhatsApp');
      // Triagem da IA marcou o contato (ou um gêmeo) como fornecedor/currículo/parceria/
      // negócio/spam depois que o ciclo nasceu: não é lead de venda — encerra sem enviar.
      if (irmaos.some((l) => ehNaoPaciente(l))) return encerrar('CANCELADA', MOTIVO_NAO_PACIENTE);
      if (irmaosIds.length > 1) {
        // Ciclos gêmeos já criados (antes da dedup do planejador): fica só o mais antigo.
        const outro = await this.prisma.leadReactivation.findFirst({
          where: {
            tenant_id: tenantId,
            status: 'ATIVA',
            lead_id: { in: irmaosIds.filter((x) => x !== lead.id) },
            OR: [{ created_at: { lt: ciclo.created_at } }, { created_at: ciclo.created_at, id: { lt: ciclo.id } }],
          },
          select: { id: true },
        });
        if (outro) return encerrar('CANCELADA', 'número já na régua por outro contato');
      }

      const conv = await conversaPrincipal(this.prisma, tenantId, lead.id);
      const msgs = conv ? await ultimasMensagens(this.prisma, conv.id, 30) : [];

      // Pediu pra parar / recusou no histórico (o webhook só grava opt-out quando ele cai
      // com o ciclo/toque vivo; num deploy ele pode falhar, e o pedido anterior ao ciclo
      // ele nunca vê). Opt-out PERMANENTE só com o pedido INEQUÍVOCO (regra estrita) e
      // depois de um toque enviado (resposta à régua); recusa pela regra ampla ("não
      // tenho interesse no momento") ou pedido antigo só encerra o ciclo.
      const pedido = pedidoDeParar(msgs);
      if (pedido) {
        const estrito = REATIVACAO_OPT_OUT_RE.test(String(pedido.text || '').trim());
        const envios = estrito
          ? await this.prisma.leadDispatch.findMany({
              where: { tenant_id: tenantId, lead_id: { in: irmaosIds }, status: 'ENVIADO', sent_at: { lt: pedido.created_at } },
              select: { sent_at: true },
              take: 1,
            })
          : [];
        if (estrito && optOutDefinitivo(pedido.created_at, envios.map((e) => e.sent_at!).filter(Boolean))) {
          await this.prisma.lead
            .updateMany({
              where: { tenant_id: tenantId, id: { in: irmaosIds }, contact_opt_out_at: null },
              data: { contact_opt_out_at: agora, contact_opt_out_reason: String(pedido.text || '').slice(0, 200) },
            })
            .catch((e: any) => this.logger.warn(`${LOG} opt-out do lead ${lead.id} não gravou: ${e?.message}`));
        }
        if (new Date(pedido.created_at).getTime() > new Date(ciclo.created_at).getTime()) {
          await this.marcarRespondido(tenantId, ciclo.id, pedido.created_at);
        }
        return encerrar('OPT_OUT', 'pediu pra parar (histórico)');
      }

      // Respondeu (em qualquer conversa fora do Financeiro, dele ou de um gêmeo de
      // número) depois que o ciclo começou.
      const resposta = await this.prisma.message.findFirst({
        where: {
          direction: 'in',
          created_at: { gt: ciclo.created_at },
          type: { notIn: [...REATIVACAO_TIPOS_MSG_INTERNA] },
          conversation: { lead_id: { in: irmaosIds }, lead: { tenant_id: tenantId }, ...FORA_DO_FINANCEIRO },
        },
        orderBy: { created_at: 'asc' },
        select: { created_at: true },
      });
      if (resposta) {
        await this.marcarRespondido(tenantId, ciclo.id, resposta.created_at);
        return encerrar('RESPONDEU', 'respondeu');
      }

      // Consulta marcada de HOJE em diante (inclusive a de hoje já começada) — do lead,
      // de um gêmeo ou na conversa.
      if (await temConsultaFutura(this.prisma, tenantId, irmaosIds, conv ? [conv.id] : [], agora)) {
        return encerrar('AGENDOU', 'agendou consulta');
      }
      if (!conv || !conv.comercial) return encerrar('CANCELADA', 'sem conversa no Comercial');
      if (conv.ai_mode === false) return encerrar('HUMANO', 'humano assumiu a conversa');
      const colunaAgora = ETAPAS_LEGADAS_FORA.includes(lead.stage) ? 'fora' : await colunaGeralDoLead(this.prisma, lead);
      if (colunaAgora !== coluna) return encerrar('MUDOU_ETAPA', `mudou de etapa (${colunaAgora})`);

      // Última mensagem REAL é do lead = ele escreveu e a clínica é quem deve responder
      // (resposta anterior ao ciclo: corrida com o planejador, ou chats.upsert gravando
      // com timestamp antigo). Coluna "faltou" compara com a hora do NO_SHOW.
      // Saída automática (sequência/broadcast/cron legado) não é conversa: pelo horário
      // do envio, porque o eco do webhook apaga o prefixo sys_* da Message.
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
      const ultimaReal = mensagensReais(msgs, idsRegua, temposAuto)[0];
      if (ultimaReal?.direction === 'in') {
        const falta =
          coluna === 'agendado' && ciclo.ref_event_id
            ? await this.prisma.calendarEvent.findFirst({
                where: { id: ciclo.ref_event_id, tenant_id: tenantId },
                select: { start_at: true },
              })
            : null;
        if (leadFalouPorUltimo(ultimaReal, coluna, falta?.start_at ?? null)) {
          await this.marcarRespondido(tenantId, ciclo.id, new Date(ultimaReal.created_at));
          return encerrar('RESPONDEU', 'respondeu (última mensagem é do lead)');
        }
      }

      // 1 mensagem por dia por PESSOA: qualquer saída nas últimas 20h (operador, IA,
      // lembrete ou toque anterior) — nesta conversa ou na de um gêmeo de número —
      // adia este pra amanhã 9h.
      let saidaRecente = msgs.some(
        (m) => m.direction === 'out' && agora.getTime() - new Date(m.created_at).getTime() < JANELA_UMA_MSG_DIA_MS,
      );
      if (!saidaRecente && irmaosIds.length > 1) {
        saidaRecente = !!(await this.prisma.message.findFirst({
          where: {
            direction: 'out',
            created_at: { gt: new Date(agora.getTime() - JANELA_UMA_MSG_DIA_MS) },
            type: { notIn: [...REATIVACAO_TIPOS_MSG_INTERNA] },
            conversation: { lead_id: { in: irmaosIds }, lead: { tenant_id: tenantId }, ...FORA_DO_FINANCEIRO },
          },
          select: { id: true },
        }));
      }
      if (saidaRecente) {
        await voltar({ agendado_para: amanhaAsNove(agora) });
        return 'pulado';
      }
      // A conversa andou depois que o texto foi escrito → o redator reescreve.
      const baseMs = t.base_msg_at ? new Date(t.base_msg_at).getTime() : 0;
      if (
        !t.texto ||
        (ultimaReal && new Date(ultimaReal.created_at).getTime() > baseMs) ||
        textoPrecisaReescrever(t.texto, t.texto_gerado_em, agora)
      ) {
        await voltar({ texto: null, texto_gerado_em: null, base_msg_at: null, dentista_id: null });
        return 'pulado';
      }

      // Dentista do texto × dentista da conversa. O texto nomeia a orçamentista e
      // oferece horários DA AGENDA DELA (dentista_id, escolhida em modo prévia). Se
      // alguém travou OUTRA orçamentista na conversa depois, o texto mente → reescreve.
      // Se a conversa não tem orçamentista, trava a do texto agora: quando o lead
      // aceitar, a IA reaproveita esse lock-in (senão escolheria a menos ocupada do
      // momento e marcaria com outra profissional).
      // (Se a do texto nem é orçamentista — clínica sem orçamentista, o redator caiu no
      // dentista que estava na conversa — e a conversa mudou, também reescreve: não
      // trava especialista na conversa.)
      if (t.dentista_id && conv.assigned_dentist_id !== t.dentista_id) {
        const ehOrcamentista = async (userId: string) =>
          !!(
            await this.prisma.user.findFirst({ where: { id: userId }, select: { specialties: true } })
          )?.specialties?.includes(ORCAMENTISTA_SPECIALTY);
        const atualEhOrc = conv.assigned_dentist_id ? await ehOrcamentista(conv.assigned_dentist_id) : false;
        if (atualEhOrc || !(await ehOrcamentista(t.dentista_id))) {
          await voltar({ texto: null, texto_gerado_em: null, base_msg_at: null, dentista_id: null });
          return 'pulado';
        }
        await this.prisma.conversation.updateMany({
          // Condicional: só se ninguém travou outra entre a leitura e aqui.
          where: { id: conv.id, tenant_id: tenantId, assigned_dentist_id: conv.assigned_dentist_id },
          data: { assigned_dentist_id: t.dentista_id },
        });
      }

      // ── Número no WhatsApp (com/sem o 9º dígito) ──
      const variantes = variantesEnvio(toBrazilWhatsappNumber(lead.phone), brazilPhoneMatchVariants(lead.phone));
      if (!variantes.length) {
        await this.registrarFalha(t.id, tenantId, lead, 'telefone inválido', agora);
        await encerrarCiclo(this.prisma, { tenantId, cicloId: ciclo.id, status: 'CANCELADA', motivo: 'telefone inválido', agora });
        return 'pulado';
      }
      const check = await this.checarNumero(evo, chip, variantes);
      if (check.estado === 'chip_caido') {
        await voltar();
        return 'chip_caido';
      }
      if (check.estado === 'nao_existe') {
        await this.semWhatsapp(t.id, tenantId, ciclo.id, lead, agora);
        return 'pulado';
      }
      const numero = check.estado === 'existe' ? check.numero : variantes[0];

      // ── Envio em balões ──
      const { profile } = await loadClinicAiContext(this.prisma, tenantId, 'COMERCIAL');
      const assinatura = profile.signature ? `*${profile.assistantName}:* ` : '';
      const baloes = dividirBaloes(t.texto);
      const ids: string[] = [];
      let falha: ResultadoEnvio | null = null;
      let leadEscreveuNoMeio = false;
      let escreveuEm: Date | null = null;
      for (let i = 0; i < baloes.length; i++) {
        if (i > 0) {
          await this.esperar(1500 + Math.round(Math.random() * 1500));
          // O lead escreveu no meio dos balões → para aqui (a IA responde a ele).
          const escreveu = await this.prisma.message.findFirst({
            where: {
              direction: 'in',
              created_at: { gt: agora },
              conversation: { lead_id: lead.id, lead: { tenant_id: tenantId }, ...FORA_DO_FINANCEIRO },
            },
            orderBy: { created_at: 'asc' },
            select: { id: true, created_at: true },
          });
          if (escreveu) {
            leadEscreveuNoMeio = true;
            escreveuEm = escreveu.created_at;
            break;
          }
        }
        const typingMs = bubbleTypingMs(baloes[i]);
        axios
          .post(
            `${evo.apiUrl}/chat/sendPresence/${chip}`,
            { number: numero, delay: typingMs, presence: 'composing' },
            { headers: { 'Content-Type': 'application/json', apikey: evo.apiKey }, timeout: 10000 },
          )
          .catch(() => undefined);
        await this.esperar(typingMs);
        falouComEvolution = true;
        const r = await this.enviarTexto(evo, chip, numero, i === 0 ? `${assinatura}${baloes[i]}` : baloes[i]);
        if (r.tipo !== 'ok') {
          falha = r;
          break;
        }
        ids.push(r.id);
        // Grava já (texto sem assinatura, id REAL): o eco do webhook casa pelo id.
        await this.gravarMensagem(conv.id, baloes[i], r.id, chip);
      }

      if (ids.length) {
        const parcial = falha
          ? `parcial: ${ids.length} de ${baloes.length} balões saíram; depois ${falha.tipo}`
          : leadEscreveuNoMeio && ids.length < baloes.length
            ? `parcial: ${ids.length} de ${baloes.length} balões saíram; o lead escreveu no meio`
            : null;
        await this.concluirEnvio({ t, coluna, tenantId, chip, convId: conv.id, lead, ids, motivo: parcial });
        // Respondeu no meio dos balões: o webhook viu o toque ainda ENVIANDO e não marcou
        // o "respondeu" dele — marca aqui (só a métrica; nunca lança, a mensagem já saiu).
        if (leadEscreveuNoMeio && escreveuEm) {
          await this.marcarRespondido(tenantId, ciclo.id, escreveuEm).catch((e: any) =>
            this.logger.warn(`${LOG} toque ${t.id}: "respondeu" não marcou: ${e?.message}`),
          );
        }
        return falha?.tipo === 'chip_caido' ? 'chip_caido' : 'enviado';
      }
      if (!falha) {
        // Parou antes do 1º balão (não deveria: a checagem de resposta é só do 2º em diante).
        await voltar();
        return 'pulado';
      }
      switch (falha.tipo) {
        case 'sem_whatsapp':
          await this.semWhatsapp(t.id, tenantId, ciclo.id, lead, agora);
          return 'tentou';
        case 'chip_caido':
          await voltar();
          return 'chip_caido';
        case 'talvez_saiu':
          // PODE ter saído: nunca reenvia. Os próximos toques contam a partir de agora.
          // Grava o chip (instance_name) pro disjuntor achar as tentativas dele.
          await this.registrarFalha(t.id, tenantId, lead, `${MOTIVO_PODE_TER_SAIDO} (${falha.detalhe})`, agora, chip);
          await this.reancorarEFechar(tenantId, ciclo.id, t.toque, coluna, agora);
          return 'talvez_saiu';
        default:
          await this.registrarFalha(t.id, tenantId, lead, `recusado pela Evolution (${falha.detalhe})`, agora);
          await this.reancorarEFechar(tenantId, ciclo.id, t.toque, coluna, agora);
          return 'tentou';
      }
    } catch (e: any) {
      this.logger.error(`${LOG} toque ${id}: erro ${falouComEvolution ? 'DEPOIS' : 'antes'} do envio: ${e?.message}`);
      if (falouComEvolution) {
        // Já falou com a Evolution: pode ter saído — nunca volta pra fila.
        await this.prisma.leadDispatch
          .updateMany({
            where: { id, status: 'ENVIANDO' },
            data: { status: 'FALHOU', motivo: `erro interno (${MOTIVO_PODE_TER_SAIDO})`, sent_at: agora, instance_name: chip },
          })
          .catch(() => undefined);
        return 'talvez_saiu';
      }
      await voltar().catch(() => undefined);
      return 'pulado';
    }
  }

  /** Sucesso (ou parcial): toque ENVIADO, conversa, lead, histórico unificado, próximos toques. */
  private async concluirEnvio(a: {
    t: { id: string; toque: number; reactivation: { id: string } };
    coluna: keyof typeof REATIVACAO_OFFSETS;
    tenantId: string;
    chip: string;
    convId: string;
    lead: { id: string; name: string | null; phone: string };
    ids: string[];
    /** Envio parcial (algum balão não saiu) — fica registrado no toque. */
    motivo: string | null;
  }): Promise<void> {
    const sentAt = new Date();
    await this.prisma.leadDispatch.updateMany({
      where: { id: a.t.id, tenant_id: a.tenantId, status: 'ENVIANDO' },
      data: { status: 'ENVIADO', sent_at: sentAt, external_message_ids: a.ids, instance_name: a.chip, motivo: a.motivo },
    });
    await this.prisma.conversation
      .update({ where: { id: a.convId }, data: { last_message_at: sentAt } })
      .catch((e: any) => this.logger.warn(`${LOG} last_message_at não atualizou (conv ${a.convId}): ${e?.message}`));
    // O cron legado de follow-up olha last_followup_at: não pega este lead de novo.
    await this.prisma.lead
      .updateMany({ where: { id: a.lead.id, tenant_id: a.tenantId }, data: { last_followup_at: sentAt } })
      .catch(() => undefined);
    await this.logDispatch(a.tenantId, a.lead, 'SENT', null, a.ids[0]);
    await this.reancorarEFechar(a.tenantId, a.t.reactivation.id, a.t.toque, a.coluna, sentAt);
    this.logger.log(`${LOG} toque ${a.t.toque} (${a.coluna}) enviado ao lead ${a.lead.id} pelo chip ${a.chip} (${a.ids.length} balão(ões))`);
  }

  /** Empurra os próximos toques (intervalo contado do envio real) e conclui o ciclo sem pendentes. */
  private async reancorarEFechar(
    tenantId: string,
    cicloId: string,
    toque: number,
    coluna: keyof typeof REATIVACAO_OFFSETS,
    sentAt: Date,
  ): Promise<void> {
    try {
      const pendentes = await this.prisma.leadDispatch.findMany({
        where: { tenant_id: tenantId, reactivation_id: cicloId, status: 'AGENDADO' },
        select: { id: true, toque: true, agendado_para: true },
      });
      for (const p of reancorarToques(pendentes, toque, sentAt, REATIVACAO_OFFSETS[coluna])) {
        await this.prisma.leadDispatch.updateMany({
          where: { id: p.id, tenant_id: tenantId, status: 'AGENDADO' },
          data: { agendado_para: p.agendado_para },
        });
      }
      const restantes = await this.prisma.leadDispatch.count({
        where: { tenant_id: tenantId, reactivation_id: cicloId, status: { in: ['AGENDADO', 'ENVIANDO'] } },
      });
      if (restantes === 0) {
        await this.prisma.leadReactivation.updateMany({
          where: { id: cicloId, tenant_id: tenantId, status: 'ATIVA' },
          data: { status: 'CONCLUIDA', motivo_fim: 'todos os toques enviados', ended_at: sentAt },
        });
      }
    } catch (e: any) {
      this.logger.warn(`${LOG} reancorar/fechar ciclo ${cicloId} falhou: ${e?.message}`);
    }
  }

  /** Número sem WhatsApp: toque FALHOU, lead marcado (nunca mais entra), ciclo SEM_WHATSAPP. */
  private async semWhatsapp(
    dispatchId: string,
    tenantId: string,
    cicloId: string,
    lead: { id: string; name: string | null; phone: string },
    agora: Date,
  ): Promise<void> {
    await this.registrarFalha(dispatchId, tenantId, lead, 'SEM_WHATSAPP', agora);
    await this.prisma.lead
      .updateMany({ where: { id: lead.id, tenant_id: tenantId }, data: { whatsapp_invalid_at: agora } })
      .catch(() => undefined);
    await encerrarCiclo(this.prisma, { tenantId, cicloId, status: 'SEM_WHATSAPP', motivo: 'número sem WhatsApp', agora });
    this.logger.warn(`${LOG} lead ${lead.id}: número sem WhatsApp — saiu da régua`);
  }

  private async registrarFalha(
    dispatchId: string,
    tenantId: string,
    lead: { id: string; name: string | null; phone: string },
    motivo: string,
    agora: Date,
    /** Chip que tentou (só quando falou com a Evolution) — o disjuntor olha por ele. */
    chip?: string,
  ): Promise<void> {
    await this.prisma.leadDispatch.updateMany({
      where: { id: dispatchId, tenant_id: tenantId, status: 'ENVIANDO' },
      // sent_at = quando tentou (o painel "Enviados" ordena por ele).
      data: { status: 'FALHOU', motivo: motivo.slice(0, 300), sent_at: agora, ...(chip ? { instance_name: chip } : {}) },
    });
    await this.logDispatch(tenantId, lead, 'FAILED', motivo, null);
  }

  /** Respondeu: marca replied_at no último toque ENVIADO do ciclo (métrica "responderam"). */
  private async marcarRespondido(tenantId: string, cicloId: string, quando: Date): Promise<void> {
    const ultimo = await this.prisma.leadDispatch.findFirst({
      where: { tenant_id: tenantId, reactivation_id: cicloId, status: 'ENVIADO', replied_at: null },
      orderBy: { sent_at: 'desc' },
      select: { id: true },
    });
    if (ultimo) {
      await this.prisma.leadDispatch.updateMany({ where: { id: ultimo.id, replied_at: null }, data: { replied_at: quando } });
    }
  }

  /**
   * Grava o balão na conversa com o id REAL da Evolution e o chip. P2002 = o eco do
   * webhook chegou antes e já gravou essa mensagem (external_message_id é único) —
   * não duplica, só garante o chip. Nunca lança: a mensagem já saiu.
   */
  private async gravarMensagem(conversationId: string, texto: string, externalId: string, chip: string): Promise<void> {
    try {
      await this.prisma.message.create({
        data: {
          conversation_id: conversationId,
          direction: 'out',
          type: 'text',
          text: texto,
          external_message_id: externalId,
          status: 'enviado',
          instance_name: chip,
        },
      });
    } catch (e: any) {
      if (e?.code === 'P2002') {
        await this.prisma.message
          .updateMany({ where: { external_message_id: externalId, instance_name: null }, data: { instance_name: chip } })
          .catch(() => undefined);
        return;
      }
      this.logger.warn(`${LOG} balão enviado mas não gravado na conversa ${conversationId}: ${e?.message}`);
    }
  }

  /** Histórico unificado da Central (DispatchLog 'reativacao_lead'). Nunca lança. */
  private async logDispatch(
    tenantId: string,
    lead: { name: string | null; phone: string },
    status: 'SENT' | 'FAILED',
    error: string | null,
    externalId: string | null,
  ): Promise<void> {
    try {
      await this.prisma.dispatchLog.create({
        data: {
          tenant_id: tenantId,
          type: 'reativacao_lead',
          channel: 'WHATSAPP',
          recipient_name: lead.name,
          recipient_phone: lead.phone,
          status,
          error: error ? error.slice(0, 300) : null,
          external_message_id: externalId,
          sent_at: new Date(),
        },
      });
    } catch (e: any) {
      this.logger.warn(`[DISPATCH-LOG] reativacao_lead não registrou: ${e?.message}`);
    }
  }

  /** POST /chat/whatsappNumbers — qual variante do número existe no WhatsApp. */
  private async checarNumero(
    evo: Evo,
    chip: string,
    numeros: string[],
  ): Promise<ReturnType<typeof interpretarWhatsappNumbers> | { estado: 'chip_caido' }> {
    try {
      const res = await axios.post(
        `${evo.apiUrl}/chat/whatsappNumbers/${chip}`,
        { numbers: numeros },
        { headers: { 'Content-Type': 'application/json', apikey: evo.apiKey }, timeout: 10000 },
      );
      return interpretarWhatsappNumbers(res.data, numeros);
    } catch (e: any) {
      const c = classificarEnvio({
        httpStatus: e?.response?.status ?? null,
        data: e?.response?.data,
        erroCodigo: e?.code,
        erroMensagem: e?.message,
      });
      if (c.tipo === 'chip_caido') return { estado: 'chip_caido' };
      // Check indisponível: envia no cadastrado e confia no exists:false do envio.
      return { estado: 'indisponivel' };
    }
  }

  private async enviarTexto(evo: Evo, chip: string, numero: string, text: string): Promise<ResultadoEnvio> {
    try {
      const res = await axios.post(
        `${evo.apiUrl}/message/sendText/${chip}`,
        { number: numero, text },
        { headers: { 'Content-Type': 'application/json', apikey: evo.apiKey }, timeout: 30000 },
      );
      return classificarEnvio({ httpStatus: res.status, data: res.data });
    } catch (e: any) {
      return classificarEnvio({
        httpStatus: e?.response?.status ?? null,
        data: e?.response?.data,
        erroCodigo: e?.code,
        erroMensagem: e?.message,
      });
    }
  }

  private esperar(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import axios from 'axios';
import {
  CHIP_VIGIA_DISPARO,
  CHIP_VIGIA_DISPATCH_TYPE,
  chipVigiaEstadoKey,
  chipVigiaLigada,
  chipVigiaToggleKey,
  getLabTenantIds,
  leituraDeLabsFalhou,
} from '@crm/shared';
import { PrismaService } from '../prisma/prisma.service';
import { SettingsService } from '../settings/settings.service';
import { sendAdminAlert } from './admin-alert';
import {
  PEDIDO_MENSAGENS,
  MEMORIA_LEITURAS_MS,
  avaliarConexao,
  avaliarSilencio,
  decidir,
  diaMaceio,
  estadoAposFalhaDeEnvio,
  lerEstado,
  medeSilencioAgora,
  rotuloDoChip,
  textoDoProblema,
  textoNormalizado,
  type EstadoVigia,
  type Observacao,
  type SinalSilencio,
} from './chip-vigia-regras';

const LOG = '[CHIP-VIGIA]';
const FUNCOES = ['COMERCIAL', 'CLINICA', 'FINANCEIRO'];
/** Contas que a vigia acompanha (suspensa, cancelada ou excluída ficam de fora). */
const STATUS_VIGIADOS = new Set(['ACTIVE', 'TRIAL', 'PAST_DUE']);
/** Falha ao falar com o servidor do WhatsApp: no máx. 1 linha de log a cada 10 min. */
const LOG_FALHA_MS = 10 * 60_000;
const TIMEOUT_MS = 15_000;

interface ChipVigiado {
  name: string;
  tenant_id: string;
  purpose: string | null;
}

interface EstadoNoServidor {
  ok: boolean;
  ownerJid: string | null;
}

type ConfigEvolution = { apiUrl: string; apiKey: string };

/**
 * Vigia dos chips de WhatsApp — pedido do dono em 09/11/2026, depois de o chip da Clínica
 * passar a tarde sem entregar nada ao sistema sem ninguém perceber.
 *
 * A cada minuto, lê no servidor do WhatsApp (Evolution, uma chamada só) o estado de todos
 * os chips com função (Comercial, Clínica, Financeiro) das clínicas com o aviso ligado na
 * Central de Disparos (CHIP_VIGIA_ENABLED_<conta>; padrão LIGADO, só 'false' desliga). A
 * cada 5 minutos, em dia de semana e horário de atendimento, fora de feriado, também confere
 * as últimas mensagens que o chip recebeu. As regras ficam em ./chip-vigia-regras.
 *
 * Avisa os ADMs (números da Central + quem marcou "WhatsApp com problema" no cadastro) por
 * OUTRO chip da clínica primeiro; o chip com problema fica por último. Se ninguém recebe
 * (todos os chips falharam ou não há destinatário), tenta de novo em 10 min, até 3 vezes.
 *
 * Duas réplicas do worker: cada uma lê sozinha, mas só quem trocar o estado gravado do chip
 * (CHIP_VIGIA_ESTADO_<chip>, troca condicional no banco) avisa. Laboratório fica de fora.
 * Importa só Prisma e Settings: sem risco de ciclo de DI.
 */
@Injectable()
export class ChipVigiaService {
  private readonly logger = new Logger(ChipVigiaService.name);
  private rodando = false;
  private readonly leituras = new Map<string, Observacao[]>();
  private falhaLogadaEm = 0;

  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
  ) {}

  @Cron('* * * * *', { timeZone: 'America/Maceio' })
  async tick(): Promise<void> {
    if (this.rodando) return; // tick anterior ainda rodando (servidor lento): não empilha
    this.rodando = true;
    try {
      await this.processar(Date.now());
    } catch (e: any) {
      this.logger.error(`${LOG} falha no tick: ${e?.message}`);
    } finally {
      this.rodando = false;
    }
  }

  /** Uma rodada. Devolve quantos avisos foram tentados (para os testes). */
  async processar(agora: number): Promise<number> {
    const vigiados = await this.chipsVigiados();
    if (!vigiados) return 0; // não deu para saber quem é laboratório: pula a rodada
    this.esquecerChipsFora(vigiados);
    if (!vigiados.length) return 0;

    const cfg = await this.settings.getEvolutionConfig().catch(() => null);
    if (!cfg?.apiUrl) return 0;
    const noServidor = await this.estadosNoServidor(cfg, agora);
    if (!noServidor) return 0; // servidor do WhatsApp fora: não conta como leitura

    const minuto = Math.floor(agora / 60_000);
    const conferirSilencio = minuto % 5 === 0;
    const emFeriado =
      conferirSilencio && medeSilencioAgora(agora)
        ? await this.contasEmFeriado([...new Set(vigiados.map((c) => c.tenant_id))], agora)
        : new Set<string>();

    const linhas = await this.prisma.globalSetting.findMany({
      where: { key: { in: vigiados.map((c) => chipVigiaEstadoKey(c.name)) } },
      select: { key: true, value: true },
    });
    const gravado = new Map(linhas.map((l) => [l.key, l.value]));

    let avisos = 0;
    for (const chip of vigiados) {
      const servidor = noServidor.get(chip.name);
      if (!servidor) continue; // não existe neste servidor ou estado desconhecido: não julga
      this.registrar(chip.name, { t: agora, ok: servidor.ok }, agora);
      try {
        const feriado = emFeriado.has(chip.tenant_id) || emFeriado.has('*');
        avisos += await this.avaliarChip(chip, servidor, gravado.get(chipVigiaEstadoKey(chip.name)) ?? null, cfg, agora, {
          conferirSilencio,
          feriado,
        });
      } catch (e: any) {
        this.logger.warn(`${LOG} chip ${chip.name}: ${e?.message}`);
      }
    }
    return avisos;
  }

  private async avaliarChip(
    chip: ChipVigiado,
    servidor: EstadoNoServidor,
    valorGravado: string | null,
    cfg: ConfigEvolution,
    agora: number,
    opts: { conferirSilencio: boolean; feriado: boolean },
  ): Promise<number> {
    const key = chipVigiaEstadoKey(chip.name);
    const conexao = avaliarConexao(this.leituras.get(chip.name) ?? [], agora);
    const estado = lerEstado(valorGravado);

    // Últimas mensagens recebidas: para medir o silêncio (sem episódio aberto, dia de
    // semana em horário de atendimento) ou para fechar o "sem receber" (a qualquer hora).
    let silencio: SinalSilencio | null = null;
    let recebeuEm: number | null = null;
    const medir =
      opts.conferirSilencio &&
      conexao.agoraOk &&
      (estado.problema === 'sem_receber' || (estado.problema === null && !opts.feriado && medeSilencioAgora(agora)));
    if (medir) {
      const recebidas = await this.recebidasNoServidor(cfg, chip.name);
      if (recebidas?.length) {
        recebeuEm = Math.max(...recebidas);
        if (estado.problema === null) silencio = avaliarSilencio(recebidas, agora);
      }
    }

    const decisao = decidir(estado, conexao, agora, silencio, recebeuEm);
    if (decisao.acao === 'nada') {
      // Primeira vez que a vigia vê o chip conectado: só a partir daí uma queda vira aviso.
      if (servidor.ok && !estado.vistoOpen) {
        await this.trocarEstado(key, valorGravado, { ...estado, vistoOpen: true }).catch(() => false);
      }
      return 0;
    }

    // Troca condicional do estado: só a réplica que trocar avisa.
    const novoValor = JSON.stringify(decisao.novo);
    if (!(await this.trocarEstado(key, valorGravado, decisao.novo))) return 0;

    const doAviso = { purpose: chip.purpose, ownerJid: servidor.ownerJid };
    const text =
      decisao.acao === 'avisar'
        ? textoDoProblema(decisao.problema, doAviso, decisao.desde, agora, {
            quedas: conexao.quedas,
            porHora: silencio?.porHora,
            desdeExato: decisao.desdeExato,
          })
        : textoNormalizado(decisao.problema, doAviso, decisao.desde, decisao.voltouEm);

    const r = await sendAdminAlert(this.prisma, this.settings, chip.tenant_id, {
      type: CHIP_VIGIA_DISPATCH_TYPE,
      disparo: CHIP_VIGIA_DISPARO,
      text,
      recipientName: `Chip ${rotuloDoChip(chip.purpose)}`,
      chipsPorUltimo: [chip.name],
    });
    const oQue = decisao.acao === 'avisar' ? decisao.problema : `${decisao.problema} → normalizado`;
    if (r.sent > 0) {
      this.logger.log(`${LOG} conta ${chip.tenant_id}, chip ${chip.name}: ${oQue} — avisados ${r.sent}, falhas ${r.failed}.`);
      return 1;
    }

    // Ninguém recebeu: volta o estado para tentar de novo em 10 min (até 3 vezes).
    const depois: EstadoVigia = estadoAposFalhaDeEnvio(estado, decisao.novo, agora);
    await this.trocarEstado(key, novoValor, depois).catch(() => false);
    const motivo = r.noPhone ? 'ninguém recebe o aviso (sem número na Central e sem ADM marcado)' : `nenhum chip entregou (${r.failed} número(s))`;
    const proximo = depois.falhasEnvio > 0 ? `nova tentativa em 10 min (${depois.falhasEnvio}ª falha)` : 'desistiu depois de 3 tentativas';
    this.logger.warn(`${LOG} conta ${chip.tenant_id}, chip ${chip.name}: ${oQue}, mas ${motivo}; ${proximo}.`);
    return 1;
  }

  /** Grava o estado só se ninguém mexeu desde a leitura (`antes` = valor lido; null = sem linha). */
  private async trocarEstado(key: string, antes: string | null, novo: EstadoVigia): Promise<boolean> {
    const value = JSON.stringify(novo);
    if (antes !== null) {
      const r = await this.prisma.globalSetting.updateMany({ where: { key, value: antes }, data: { value } });
      return r.count === 1;
    }
    try {
      await this.prisma.globalSetting.create({ data: { key, value } });
      return true;
    } catch (e: any) {
      if (e?.code === 'P2002') return false;
      throw e;
    }
  }

  /**
   * Chips com função das clínicas com a vigia ligada (fora laboratório e conta parada).
   * null = a lista de laboratórios não foi lida (não arrisca avisar a equipe de um).
   */
  private async chipsVigiados(): Promise<ChipVigiado[] | null> {
    const chips = await this.prisma.instance.findMany({
      where: { tenant_id: { not: null }, type: 'whatsapp', purpose: { in: FUNCOES } },
      select: { name: true, tenant_id: true, purpose: true },
    });
    const comConta = chips.filter((c): c is ChipVigiado => !!c.name && !!c.tenant_id);
    if (!comConta.length) return [];
    const contas = [...new Set(comConta.map((c) => c.tenant_id))];
    const [toggles, tenants, labs] = await Promise.all([
      this.prisma.globalSetting.findMany({
        where: { key: { in: contas.map(chipVigiaToggleKey) } },
        select: { key: true, value: true },
      }),
      this.prisma.tenant.findMany({ where: { id: { in: contas } }, select: { id: true, status: true } }),
      getLabTenantIds(this.prisma, (m) => this.logger.warn(m)),
    ]);
    if (leituraDeLabsFalhou()) return null;
    const desligada = new Set(toggles.filter((t) => !chipVigiaLigada(t.value)).map((t) => t.key));
    const ativa = new Set(tenants.filter((t) => STATUS_VIGIADOS.has(t.status)).map((t) => t.id));
    return comConta.filter(
      (c) => ativa.has(c.tenant_id) && !labs.has(c.tenant_id) && !desligada.has(chipVigiaToggleKey(c.tenant_id)),
    );
  }

  private registrar(chip: string, leitura: Observacao, agora: number): void {
    const lista = (this.leituras.get(chip) ?? []).filter((o) => o.t > agora - MEMORIA_LEITURAS_MS);
    lista.push(leitura);
    this.leituras.set(chip, lista);
  }

  private esquecerChipsFora(vigiados: ChipVigiado[]): void {
    const nomes = new Set(vigiados.map((c) => c.name));
    for (const nome of this.leituras.keys()) if (!nomes.has(nome)) this.leituras.delete(nome);
  }

  /**
   * Estado de todos os chips no servidor do WhatsApp (uma chamada). null = sem resposta.
   * Chip sem estado na resposta fica fora do mapa (desconhecido: não vira leitura ruim).
   */
  private async estadosNoServidor(cfg: ConfigEvolution, agora: number): Promise<Map<string, EstadoNoServidor> | null> {
    try {
      const res = await axios.get(`${cfg.apiUrl}/instance/fetchInstances`, {
        headers: { apikey: cfg.apiKey },
        timeout: TIMEOUT_MS,
      });
      const d: any = res.data;
      const lista = Array.isArray(d) ? d : Array.isArray(d?.data) ? d.data : Array.isArray(d?.instances) ? d.instances : null;
      if (!lista) return null;
      const mapa = new Map<string, EstadoNoServidor>();
      for (const item of lista) {
        const i = item?.instance || item;
        const nome = i?.name || i?.instanceName;
        const estado = String(i?.connectionStatus || i?.status || i?.state || i?.connection?.state || '').trim().toLowerCase();
        if (!nome || !estado) continue;
        mapa.set(String(nome), { ok: estado === 'open', ownerJid: i.ownerJid || i.owner || null });
      }
      return mapa;
    } catch (e: any) {
      if (agora - this.falhaLogadaEm > LOG_FALHA_MS) {
        this.falhaLogadaEm = agora;
        this.logger.warn(`${LOG} servidor do WhatsApp sem resposta (${e?.response?.status ?? e?.code ?? 'erro'}): rodada pulada.`);
      }
      return null;
    }
  }

  /**
   * Horários (ms) das últimas mensagens de contato recebidas pelo chip no servidor (sem
   * grupo, status nem canal). null = sem resposta.
   */
  private async recebidasNoServidor(cfg: ConfigEvolution, chip: string): Promise<number[] | null> {
    try {
      const res = await axios.post(
        `${cfg.apiUrl}/chat/findMessages/${encodeURIComponent(chip)}`,
        { where: { key: { fromMe: false } }, offset: PEDIDO_MENSAGENS, page: 1 },
        { headers: { 'Content-Type': 'application/json', apikey: cfg.apiKey }, timeout: TIMEOUT_MS },
      );
      const d: any = res.data;
      const registros = Array.isArray(d?.messages?.records) ? d.messages.records : Array.isArray(d?.messages) ? d.messages : null;
      if (!registros) return null;
      const out: number[] = [];
      for (const r of registros) {
        const jid = String(r?.key?.remoteJid || '');
        if (jid.endsWith('@g.us') || jid.endsWith('@broadcast') || jid.endsWith('@newsletter')) continue;
        const t = paraMs(r?.messageTimestamp);
        if (t !== null) out.push(t);
      }
      return out;
    } catch {
      return null;
    }
  }

  /** Contas em feriado hoje ('*' = feriado nacional). Erro de leitura = nenhuma. */
  private async contasEmFeriado(contas: string[], agora: number): Promise<Set<string>> {
    const dia = diaMaceio(agora);
    const inicio = new Date(`${dia}T00:00:00.000Z`);
    const fim = new Date(inicio.getTime() + 24 * 60 * 60_000);
    const [, mes, d] = dia.split('-').map(Number);
    try {
      const rows = await this.prisma.holiday.findMany({
        where: {
          AND: [
            { OR: [{ tenant_id: null }, { tenant_id: { in: contas } }] },
            { OR: [{ date: { gte: inicio, lt: fim } }, { recurring_yearly: true }] },
          ],
        },
        select: { tenant_id: true, date: true, recurring_yearly: true },
      });
      const out = new Set<string>();
      for (const h of rows) {
        const dt = new Date(h.date);
        const hoje = h.recurring_yearly
          ? dt.getUTCMonth() + 1 === mes && dt.getUTCDate() === d
          : dt >= inicio && dt < fim;
        if (hoje) out.add(h.tenant_id ?? '*');
      }
      return out;
    } catch (e: any) {
      this.logger.warn(`${LOG} feriados não lidos: ${e?.message}`);
      return new Set();
    }
  }
}

/** messageTimestamp da Evolution (segundos, ms, texto ou Long) → ms. */
function paraMs(v: any): number | null {
  const n = typeof v === 'object' && v !== null && 'low' in v ? Number(v.low) : Number(v);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n < 1e12 ? n * 1000 : n;
}

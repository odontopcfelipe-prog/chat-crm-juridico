/**
 * Regras PURAS da vigia dos chips de WhatsApp (sem banco, sem rede): o serviço
 * (chip-vigia.service) observa o estado de cada chip a cada minuto e pergunta aqui
 * se deve avisar os ADMs.
 *
 * Três problemas, do mais grave para o mais leve:
 *   - desconectado: o servidor do WhatsApp diz que o chip não está "open" em todas as
 *     leituras dos últimos 10 minutos;
 *   - instável: o chip caiu e voltou 3 vezes ou mais em 15 minutos;
 *   - sem receber: conectado, já recebeu mensagem hoje e, de repente, ficou 2 horas sem
 *     nada; só em dia de semana, em horário de atendimento e em chip bem movimentado.
 *
 * Cada problema vira UM aviso por episódio. Quando o chip fica 15 minutos estável (ou volta
 * a receber), sai o aviso de "normalizado" e o episódio fecha. Só avisa queda de chip que
 * a vigia já viu conectado alguma vez: chip novo sem QR lido ou abandonado há meses não
 * vira alarme no dia da implantação.
 */

/** Uma leitura do estado do chip (ok = "open" no servidor do WhatsApp). */
export interface Observacao {
  t: number;
  ok: boolean;
}

export type ProblemaChip = 'desconectado' | 'instavel' | 'sem_receber';

/** Estado gravado por chip (GlobalSetting CHIP_VIGIA_ESTADO_<chip>). Datas em ms. */
export interface EstadoVigia {
  /** Episódio aberto (já avisado). null = chip normal. */
  problema: ProblemaChip | null;
  /** Quando o problema começou (primeira leitura ruim, ou a última mensagem recebida). */
  desde: number | null;
  /** Quando o aviso do episódio saiu. */
  avisadoEm: number | null;
  /** Último aviso de "instável" (pausa de 2 h entre dois avisos desse tipo). */
  instavelEm: number | null;
  /** Dia (Maceió, AAAA-MM-DD) do contador de avisos de problema. */
  dia: string | null;
  /** Avisos de problema no dia (teto por chip). */
  avisosNoDia: number;
  /** A vigia já viu este chip conectado alguma vez. */
  vistoOpen: boolean;
  /** Tentativas de aviso seguidas em que ninguém recebeu. */
  falhasEnvio: number;
  /** Última tentativa de aviso em que ninguém recebeu (espera antes de tentar de novo). */
  envioFalhouEm: number | null;
}

export const ESTADO_INICIAL: EstadoVigia = {
  problema: null,
  desde: null,
  avisadoEm: null,
  instavelEm: null,
  dia: null,
  avisosNoDia: 0,
  vistoOpen: false,
  falhasEnvio: 0,
  envioFalhouEm: null,
};

const MIN = 60_000;
const HORA = 60 * MIN;
/** Maceió não tem horário de verão: UTC−3 o ano todo. */
const OFFSET_MACEIO_MS = 3 * HORA;

/** Quanto tempo de leituras ruins seguidas conta como desconectado. */
export const JANELA_DESCONECTADO_MS = 10 * MIN;
/** Leituras mínimas na janela (a leitura é por minuto; folga para tick perdido). */
export const LEITURAS_MIN_DESCONECTADO = 8;
/** Janela das quedas e da estabilidade. */
export const JANELA_INSTAVEL_MS = 15 * MIN;
export const QUEDAS_PARA_INSTAVEL = 3;
export const LEITURAS_MIN_ESTAVEL = 12;
/** Pausa entre dois avisos de "instável" do mesmo chip. */
export const PAUSA_INSTAVEL_MS = 2 * HORA;
/** Teto de avisos de problema por chip por dia (o "normalizado" não conta). */
export const TETO_AVISOS_DIA = 6;
/** Leituras guardadas em memória por chip. */
export const MEMORIA_LEITURAS_MS = 20 * MIN;
/** Episódio aberto há mais que isto é reavaliado do zero (chip removido, vigia desligada e religada). */
export const VALIDADE_EPISODIO_MS = 24 * HORA;
/** Aviso que ninguém recebeu: espera antes de tentar de novo e desiste depois de N tentativas. */
export const ESPERA_REENVIO_MS = 10 * MIN;
export const TENTATIVAS_ENVIO = 3;

/** Sem receber: quantas mensagens pedir ao servidor (as mais recentes, de contato). */
export const PEDIDO_MENSAGENS = 100;
/** Quantas delas, em horário de atendimento, a amostra precisa ter. */
export const AMOSTRA_SILENCIO = 30;
/** A amostra precisa cobrir pelo menos isto de atendimento (rajada curta não conta como movimento). */
export const AMOSTRA_MIN_MINUTOS = 60;
/** Abaixo disto (mensagens por hora útil) o chip é calmo demais para medir silêncio. */
export const POR_HORA_MIN_SILENCIO = 15;
/** Silêncio mínimo, em minutos úteis, antes de avisar. */
export const SILENCIO_MIN_MINUTOS = 120;
/** E pelo menos este múltiplo do intervalo médio entre mensagens. */
export const SILENCIO_MULTIPLO = 10;

// ─── Horário de atendimento (Maceió) ──────────────────────────────────────────

/** Janela de atendimento em minutos do dia (hora local), ou null se fechado. */
function janelaDoDia(diaDaSemana: number): [number, number] | null {
  if (diaDaSemana >= 1 && diaDaSemana <= 5) return [8 * 60, 18 * 60];
  if (diaDaSemana === 6) return [8 * 60, 12 * 60];
  return null;
}

/** Data local de Maceió (AAAA-MM-DD). */
export function diaMaceio(t: number): string {
  return new Date(t - OFFSET_MACEIO_MS).toISOString().slice(0, 10);
}

/** Dia da semana em Maceió (0 = domingo). */
function diaDaSemana(t: number): number {
  return new Date(t - OFFSET_MACEIO_MS).getUTCDay();
}

/** Está em horário de atendimento (seg–sex 8h–18h, sáb 8h–12h, Maceió)? */
export function ehHorarioDeAtendimento(t: number): boolean {
  const local = new Date(t - OFFSET_MACEIO_MS);
  const janela = janelaDoDia(local.getUTCDay());
  if (!janela) return false;
  const minuto = local.getUTCHours() * 60 + local.getUTCMinutes();
  return minuto >= janela[0] && minuto < janela[1];
}

/** Hora de medir o silêncio: dia de semana (seg–sex) em horário de atendimento. */
export function medeSilencioAgora(t: number): boolean {
  const dia = diaDaSemana(t);
  return dia >= 1 && dia <= 5 && ehHorarioDeAtendimento(t);
}

/** Abertura do atendimento no dia local de `t` (ms), ou null se o dia é fechado. */
export function aberturaDoDia(t: number): number | null {
  const local = new Date(t - OFFSET_MACEIO_MS);
  const janela = janelaDoDia(local.getUTCDay());
  if (!janela) return null;
  return Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate()) + OFFSET_MACEIO_MS + janela[0] * MIN;
}

/** Minutos de atendimento entre `de` e `ate` (fora do horário não conta). */
export function minutosUteis(de: number, ate: number): number {
  if (!(ate > de)) return 0;
  let total = 0;
  // Começa no início do dia local de `de` e anda dia a dia (teto de 60 dias).
  const inicioLocal = new Date(de - OFFSET_MACEIO_MS);
  let meiaNoite = Date.UTC(inicioLocal.getUTCFullYear(), inicioLocal.getUTCMonth(), inicioLocal.getUTCDate()) + OFFSET_MACEIO_MS;
  for (let i = 0; i < 60 && meiaNoite < ate; i++, meiaNoite += 24 * HORA) {
    const janela = janelaDoDia(new Date(meiaNoite - OFFSET_MACEIO_MS).getUTCDay());
    if (!janela) continue;
    const abre = meiaNoite + janela[0] * MIN;
    const fecha = meiaNoite + janela[1] * MIN;
    const ini = Math.max(abre, de);
    const fim = Math.min(fecha, ate);
    if (fim > ini) total += fim - ini;
  }
  return total / MIN;
}

// ─── Sinais ───────────────────────────────────────────────────────────────────

export interface SinaisConexao {
  /** Todas as leituras dos últimos 10 min ruins (desde = início da sequência ruim). */
  desconectadoDesde: number | null;
  /** true = havia leitura boa antes da sequência ruim (o "desde" é o horário de verdade). */
  desdeExato: boolean;
  /** Quedas (ok → ruim) nos últimos 15 min. */
  quedas: number;
  /** Todas as leituras dos últimos 15 min ok. */
  estavel: boolean;
  /** Última leitura ok. */
  agoraOk: boolean;
  /** Início da sequência atual de leituras ok (quando o chip voltou), ou null. */
  voltouEm: number | null;
}

/** Lê as leituras do chip e diz o que elas mostram. */
export function avaliarConexao(leituras: readonly Observacao[], agora: number): SinaisConexao {
  const obs = [...leituras].sort((a, b) => a.t - b.t);
  const ultima = obs[obs.length - 1];
  const agoraOk = !!ultima?.ok;

  const ult10 = obs.filter((o) => o.t > agora - JANELA_DESCONECTADO_MS - 30_000);
  let desconectadoDesde: number | null = null;
  let desdeExato = false;
  if (
    ult10.length >= LEITURAS_MIN_DESCONECTADO &&
    ult10.every((o) => !o.ok) &&
    agora - ult10[0].t >= JANELA_DESCONECTADO_MS - 2 * MIN
  ) {
    // Volta até a última leitura boa: o problema começou logo depois dela.
    let i = obs.length - 1;
    while (i > 0 && !obs[i - 1].ok) i--;
    desconectadoDesde = obs[i].t;
    desdeExato = i > 0;
  }

  const ult15 = obs.filter((o) => o.t > agora - JANELA_INSTAVEL_MS - 30_000);
  let quedas = 0;
  for (let i = 1; i < ult15.length; i++) if (ult15[i - 1].ok && !ult15[i].ok) quedas++;
  const estavel =
    ult15.length >= LEITURAS_MIN_ESTAVEL &&
    ult15.every((o) => o.ok) &&
    agora - ult15[0].t >= JANELA_INSTAVEL_MS - 3 * MIN;

  let voltouEm: number | null = null;
  if (agoraOk) {
    let i = obs.length - 1;
    while (i > 0 && obs[i - 1].ok) i--;
    voltouEm = obs[i].t;
  }

  return { desconectadoDesde, desdeExato, quedas, estavel, agoraOk, voltouEm };
}

export interface SinalSilencio {
  /** Mensagens por hora de atendimento (média da amostra). */
  porHora: number;
  /** Última mensagem recebida (ms). */
  ultima: number;
  /** Minutos de atendimento desde a última mensagem. */
  silencioMin: number;
  /** Silêncio a partir do qual avisa, em minutos de atendimento. */
  limiteMin: number;
  semReceber: boolean;
}

/**
 * Silêncio de um chip conectado. `recebidas` = horários (ms) das últimas mensagens de
 * contato (sem grupo nem status) que o servidor do WhatsApp recebeu nesse chip.
 * null = não mede, e então nunca avisa:
 *   - fora de dia de semana ou do horário de atendimento;
 *   - o chip ainda não recebeu nada hoje (manhã calma, recesso, clínica que abre mais tarde);
 *   - menos de 30 mensagens em horário de atendimento, ou elas cabem em menos de 1 hora
 *     (rajada de respostas a uma campanha não faz o chip parecer movimentado);
 *   - menos de 15 mensagens por hora útil.
 */
export function avaliarSilencio(recebidas: readonly number[], agora: number): SinalSilencio | null {
  if (!medeSilencioAgora(agora)) return null;
  const abertura = aberturaDoDia(agora);
  if (abertura === null) return null;

  const ts = recebidas.filter((t) => Number.isFinite(t) && t > 0 && t <= agora + 5 * MIN).sort((a, b) => a - b);
  if (!ts.length) return null;
  const ultima = ts[ts.length - 1];
  if (ultima < abertura) return null; // ainda não recebeu nada hoje: não mede

  // Usa todas as mensagens em horário de atendimento da amostra (o serviço pede ~100): chip
  // muito movimentado ainda cobre mais de 1 h, e uma rajada se dilui no resto.
  const uteis = ts.filter((t) => ehHorarioDeAtendimento(t));
  if (uteis.length < AMOSTRA_SILENCIO) return null;
  const cobertura = minutosUteis(uteis[0], uteis[uteis.length - 1]);
  if (cobertura < AMOSTRA_MIN_MINUTOS) return null;
  const porHora = (uteis.length - 1) / (cobertura / 60);
  if (porHora < POR_HORA_MIN_SILENCIO) return null;

  const silencioMin = minutosUteis(ultima, agora);
  const limiteMin = Math.max(SILENCIO_MIN_MINUTOS, (SILENCIO_MULTIPLO * 60) / porHora);
  return { porHora, ultima, silencioMin, limiteMin, semReceber: silencioMin >= limiteMin };
}

// ─── Decisão ──────────────────────────────────────────────────────────────────

export type Decisao =
  | { acao: 'nada'; motivo?: string }
  | { acao: 'avisar'; problema: ProblemaChip; desde: number; desdeExato: boolean; novo: EstadoVigia }
  | { acao: 'normalizou'; problema: ProblemaChip; desde: number | null; voltouEm: number; novo: EstadoVigia };

/**
 * O que fazer com o chip agora. `silencio` só vem quando foi medido; `recebeuEm` = última
 * mensagem recebida, quando se sabe (fecha o episódio de "sem receber").
 */
export function decidir(
  gravado: EstadoVigia,
  conexao: SinaisConexao,
  agora: number,
  silencio?: SinalSilencio | null,
  recebeuEm?: number | null,
): Decisao {
  const hoje = diaMaceio(agora);
  // Episódio velho (chip removido, vigia desligada e religada): reavalia do zero.
  const estado: EstadoVigia =
    gravado.problema !== null && gravado.avisadoEm !== null && agora - gravado.avisadoEm > VALIDADE_EPISODIO_MS
      ? { ...gravado, problema: null, desde: null, avisadoEm: null }
      : gravado;
  if (estado.envioFalhouEm !== null && agora - estado.envioFalhouEm < ESPERA_REENVIO_MS) {
    return { acao: 'nada', motivo: 'esperando para tentar o aviso de novo' };
  }
  const avisosHoje = estado.dia === hoje ? estado.avisosNoDia : 0;
  const vistoOpen = estado.vistoOpen || conexao.agoraOk;

  let candidato: ProblemaChip | null = null;
  let desde = agora;
  let desdeExato = true;
  if (conexao.desconectadoDesde !== null) {
    candidato = 'desconectado';
    desde = conexao.desconectadoDesde;
    desdeExato = conexao.desdeExato;
  } else if (conexao.quedas >= QUEDAS_PARA_INSTAVEL) {
    candidato = 'instavel';
  } else if (conexao.agoraOk && silencio?.semReceber) {
    candidato = 'sem_receber';
    desde = silencio.ultima;
  }
  // Chip que a vigia nunca viu conectado (sem QR lido, abandonado): queda não é novidade.
  if ((candidato === 'desconectado' || candidato === 'instavel') && !estado.vistoOpen) candidato = null;

  const comum = { vistoOpen, falhasEnvio: 0, envioFalhouEm: null };

  // `inicio` vai no texto; o episódio guarda o começo mais antigo (duração no "normalizado").
  const avisar = (problema: ProblemaChip, inicio: number): Decisao => {
    if (avisosHoje >= TETO_AVISOS_DIA) return { acao: 'nada', motivo: 'teto de avisos do dia' };
    return {
      acao: 'avisar',
      problema,
      desde: inicio,
      desdeExato,
      novo: {
        ...estado,
        ...comum,
        problema,
        desde: estado.problema !== null && estado.desde !== null ? Math.min(estado.desde, inicio) : inicio,
        avisadoEm: agora,
        instavelEm: problema === 'instavel' ? agora : estado.instavelEm,
        dia: hoje,
        avisosNoDia: avisosHoje + 1,
      },
    };
  };

  if (estado.problema === null) {
    if (!candidato) return { acao: 'nada' };
    if (candidato === 'instavel' && estado.instavelEm !== null && agora - estado.instavelEm < PAUSA_INSTAVEL_MS) {
      return { acao: 'nada', motivo: 'pausa do aviso de instável' };
    }
    return avisar(candidato, desde);
  }

  // Piorou para desconectado: avisa de novo (o aviso anterior era mais leve).
  if (candidato === 'desconectado' && estado.problema !== 'desconectado') {
    return avisar('desconectado', desde);
  }

  const fechar = (voltouEm: number): Decisao => ({
    acao: 'normalizou',
    problema: estado.problema as ProblemaChip,
    desde: estado.desde,
    voltouEm,
    novo: { ...estado, ...comum, problema: null, desde: null, avisadoEm: null, dia: hoje, avisosNoDia: avisosHoje },
  });

  if (estado.problema === 'sem_receber') {
    const marco = estado.desde ?? estado.avisadoEm;
    if (recebeuEm != null && marco != null && recebeuEm > marco && conexao.agoraOk) return fechar(recebeuEm);
    return { acao: 'nada' };
  }

  // desconectado ou instável: fecha com 15 min estáveis.
  if (conexao.estavel) return fechar(conexao.voltouEm ?? agora - JANELA_INSTAVEL_MS);
  return { acao: 'nada' };
}

/**
 * Estado a gravar quando o aviso não chegou a ninguém (todos os chips falharam ou não há
 * destinatário): volta ao estado de antes, para tentar de novo daqui a 10 min. Na última
 * tentativa, desiste e fica com o estado novo (o episódio segue como avisado).
 */
export function estadoAposFalhaDeEnvio(antes: EstadoVigia, novo: EstadoVigia, agora: number): EstadoVigia {
  const falhas = antes.falhasEnvio + 1;
  if (falhas >= TENTATIVAS_ENVIO) return { ...novo, falhasEnvio: 0, envioFalhouEm: null };
  return { ...antes, vistoOpen: antes.vistoOpen || novo.vistoOpen, falhasEnvio: falhas, envioFalhouEm: agora };
}

/** Lê o estado gravado (tolerante a valor velho ou quebrado). */
export function lerEstado(valor: string | null | undefined): EstadoVigia {
  if (!valor) return { ...ESTADO_INICIAL };
  try {
    const v = JSON.parse(valor);
    const num = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) ? x : null);
    const problema: ProblemaChip | null =
      v?.problema === 'desconectado' || v?.problema === 'instavel' || v?.problema === 'sem_receber' ? v.problema : null;
    return {
      problema,
      desde: num(v?.desde),
      avisadoEm: num(v?.avisadoEm),
      instavelEm: num(v?.instavelEm),
      dia: typeof v?.dia === 'string' ? v.dia : null,
      avisosNoDia: num(v?.avisosNoDia) ?? 0,
      vistoOpen: v?.vistoOpen === true,
      falhasEnvio: num(v?.falhasEnvio) ?? 0,
      envioFalhouEm: num(v?.envioFalhouEm),
    };
  } catch {
    return { ...ESTADO_INICIAL };
  }
}

// ─── Textos ───────────────────────────────────────────────────────────────────

/** "Comercial", "Clínica" ou "Financeiro" (função do chip). */
export function rotuloDoChip(purpose: string | null | undefined): string {
  if (purpose === 'COMERCIAL') return 'Comercial';
  if (purpose === 'CLINICA') return 'Clínica';
  if (purpose === 'FINANCEIRO') return 'Financeiro';
  return 'WhatsApp';
}

/** Número do chip para leitura: 558299273423 → (82) 9927-3423. Vazio se não souber. */
export function numeroDoChip(ownerJid: string | null | undefined): string {
  let d = String(ownerJid || '').split('@')[0].split(':')[0].replace(/\D/g, '');
  if (d.startsWith('55') && (d.length === 12 || d.length === 13)) d = d.slice(2);
  if (d.length !== 10 && d.length !== 11) return '';
  const ddd = d.slice(0, 2);
  const resto = d.slice(2);
  return `(${ddd}) ${resto.slice(0, resto.length - 4)}-${resto.slice(-4)}`;
}

/** Hora de Maceió (HH:MM). */
export function horaMaceio(t: number): string {
  const local = new Date(t - OFFSET_MACEIO_MS);
  return `${String(local.getUTCHours()).padStart(2, '0')}:${String(local.getUTCMinutes()).padStart(2, '0')}`;
}

/** "45 min", "2h", "2h30". */
export function duracao(ms: number): string {
  const min = Math.max(1, Math.round(ms / MIN));
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m ? `${h}h${String(m).padStart(2, '0')}` : `${h}h`;
}

/** Complemento de "desde": "as 14:05", "ontem, às 18:40" ou "08/11, às 18:40". */
function desdeQuando(t: number, agora: number): string {
  const hora = horaMaceio(t);
  const dia = diaMaceio(t);
  if (dia === diaMaceio(agora)) return `as ${hora}`;
  if (dia === diaMaceio(agora - 24 * HORA)) return `ontem, às ${hora}`;
  const [, mes, d] = dia.split('-');
  return `${d}/${mes}, às ${hora}`;
}

export interface ChipDoAviso {
  purpose: string | null;
  ownerJid?: string | null;
}

function nomeDoChip(chip: ChipDoAviso): string {
  const numero = numeroDoChip(chip.ownerJid);
  return `*${rotuloDoChip(chip.purpose)}*${numero ? ` ${numero}` : ''}`;
}

/**
 * Texto do aviso de problema. `desdeExato` = false quando a vigia já encontrou o chip
 * caído (worker acabou de subir): aí não inventa horário.
 */
export function textoDoProblema(
  problema: ProblemaChip,
  chip: ChipDoAviso,
  desde: number,
  agora: number,
  extra: { quedas?: number; porHora?: number; desdeExato?: boolean } = {},
): string {
  const nome = nomeDoChip(chip);
  if (problema === 'desconectado') {
    const quando = extra.desdeExato === false ? 'há pelo menos 10 minutos' : `desde ${desdeQuando(desde, agora)}`;
    return [
      '⚠️ *WhatsApp desconectado*',
      `O chip ${nome} está desconectado ${quando}.`,
      'Enquanto isso, as mensagens dos pacientes não entram no sistema e os envios por esse chip falham.',
      'Para resolver: Configurações → WhatsApp → *Conectar* no chip, e leia o QR Code com o celular dele.',
    ].join('\n');
  }
  if (problema === 'instavel') {
    const n = extra.quedas ?? QUEDAS_PARA_INSTAVEL;
    return [
      '⚠️ *WhatsApp instável*',
      `O chip ${nome} caiu e voltou ${n} vezes nos últimos 15 minutos.`,
      'Mensagens podem atrasar ou não entrar no sistema. Confira se o celular do chip está ligado, com internet e com o WhatsApp aberto.',
    ].join('\n');
  }
  const porHora = extra.porHora ? Math.round(extra.porHora) : null;
  return [
    '⚠️ *WhatsApp sem receber mensagens*',
    `O chip ${nome} aparece conectado, mas não recebe nenhuma mensagem desde ${desdeQuando(desde, agora)}` +
      (porHora ? ` (normalmente chegam umas ${porHora} por hora).` : '.'),
    'Confira no celular do chip se as mensagens estão chegando lá. Se estiverem, reconecte o chip em Configurações → WhatsApp.',
  ].join('\n');
}

/** Texto do aviso de que o chip voltou ao normal (`voltouEm` = quando voltou). */
export function textoNormalizado(
  problema: ProblemaChip,
  chip: ChipDoAviso,
  desde: number | null,
  voltouEm: number,
): string {
  const nome = nomeDoChip(chip);
  const tempo = desde && voltouEm > desde ? `, depois de ${duracao(voltouEm - desde)} com problema` : '';
  if (problema === 'sem_receber') {
    return [
      '✅ *WhatsApp voltou a receber*',
      `O chip ${nome} voltou a receber mensagens às ${horaMaceio(voltouEm)}${tempo}.`,
      'Vale conferir no celular do chip se alguma mensagem desse período não apareceu no sistema.',
    ].join('\n');
  }
  return [
    '✅ *WhatsApp normalizado*',
    `O chip ${nome} voltou ao normal às ${horaMaceio(voltouEm)}${tempo}.`,
    'O sistema busca sozinho as mensagens que ficaram para trás nas conversas recentes. Vale conferir no celular do chip se faltou alguma.',
  ].join('\n');
}

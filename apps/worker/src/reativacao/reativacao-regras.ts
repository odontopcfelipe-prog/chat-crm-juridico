/**
 * Régua de REATIVAÇÃO de leads — regras PURAS (sem banco, sem rede).
 *
 * Tudo que decide "quem entra", "quando sai", "o texto da IA presta?" e "a Evolution
 * aceitou?" mora aqui, separado do I/O dos serviços (planejador / redator /
 * despachante), pra ser testado em reativacao-regras.spec.ts sem mock de Prisma.
 *
 * Datas: `agendado_para`/`sent_at` são instantes REAIS (UTC). Maceió é UTC-3 fixo
 * (Alagoas não tem horário de verão), então "hora de Maceió" = instante − 3h — a
 * mesma conta que o resto do worker usa (`Date.now() - 3h`). A agenda
 * (CalendarEvent.start_at) é "naive-UTC" (hora de Maceió gravada como UTC): por
 * isso os eventos são comparados com o "agora naive" (instante − 3h).
 */
import {
  REATIVACAO_COLUNAS,
  REATIVACAO_JANELA,
  REATIVACAO_MAX_DIAS_PARADO,
  REATIVACAO_MIN_DIAS_PARADO,
  REATIVACAO_INTERVALO_MIN,
  REATIVACAO_TEXTO_MAX,
  REATIVACAO_TIPOS_MSG_INTERNA,
  ehRecusaDoLead,
  extrairPercentuais,
  extrairValoresDinheiro,
  normalizeBrazilianPhone,
  removerFrasesComVariavelVazia,
  removerPrecosNaoLiberados,
  renderReativacaoModelo,
  type ReativacaoColuna,
} from '@crm/shared';
import { tidyReply } from '../ai/conversation-guide';

// interesseDoFunil / dentistaDoModelo moram no @crm/shared: a prévia da API e o
// texto do worker usam a MESMA regra (antes eram cópias e a prévia divergia, ex.:
// "com a a doutora"). Reexportadas aqui pra quem já importava da régua.
export { interesseDoFunil, dentistaDoModelo, extrairValoresDinheiro, extrairPercentuais } from '@crm/shared';

export const DIA_MS = 86_400_000;
export const MACEIO_OFFSET_MS = 3 * 3_600_000;
/** Hora (Maceió) em que saem os toques 2..N — começo da manhã, depois da abertura. */
export const HORA_TOQUES = 9;
/** Toque ENVIANDO há mais que isso = o processo morreu no meio: vira FALHOU, nunca reenvia. */
export const ENVIANDO_PRESO_MS = 15 * 60_000;
/** Lead que recebeu mensagem nossa (qualquer saída) há menos que isso não recebe outra hoje. */
export const JANELA_UMA_MSG_DIA_MS = 20 * 3_600_000;
/** Pausa da clínica quando o chip Comercial cai (428/"Connection Closed"). */
export const PAUSA_CHIP_CAIDO_MS = 30 * 60_000;
/**
 * Disjuntor: 2 envios seguidos no mesmo chip que "podem ter saído" (timeout/5xx/2xx
 * sem id) = Evolution degradada. Pausa o chip por isso — senão a régua seguiria
 * mandando a cada 3–7 min o dia todo sem nada contar como ENVIADO.
 */
export const PAUSA_DISJUNTOR_MS = 15 * 60_000;
/** Ciclo que nunca enviou nada e cujo 1º toque passou disso = expira (a prévia se renova). */
export const EXPIRA_SEM_ENVIO_MS = 7 * DIA_MS;
/**
 * Limites do texto. O teto vem do @crm/shared (o mesmo que a API aceita no editor da
 * Central): antes o worker recusava acima de 700 e a tela deixava salvar 1500 — o
 * modelo longo nunca saía e ninguém era avisado.
 */
export const TEXTO_MAX_CHARS = REATIVACAO_TEXTO_MAX;
export const BALOES_MAX = 4;

/**
 * Pedaço comum dos motivos de FALHOU em que a mensagem PODE ter chegado ao lead
 * (timeout/5xx, erro depois de falar com a Evolution, toque preso em ENVIANDO). O
 * teto do dia conta esses também — e o disjuntor do chip olha por ele.
 */
export const MOTIVO_PODE_TER_SAIDO = 'pode ter saído';

/** Carência depois de OUTRA nutrição (sequência de follow-up, cron legado, broadcast). */
export const CARENCIA_NUTRICAO_MS = 3 * DIA_MS;
/**
 * Folga pra casar uma 'out' com o horário de um envio automático (sent_at da
 * FollowupMessage/BroadcastItem/DispatchLog): a Message é gravada ms depois do envio
 * e a linha do eco do webhook, segundos depois.
 */
export const TOLERANCIA_AUTOMACAO_MS = 3 * 60_000;

/** Motivos que encerram o ciclo SEM bloquear o reciclo (nada saiu pro lead). */
export const MOTIVO_COLUNA_DESLIGADA = 'coluna desligada';
export const MOTIVO_EXPIROU = 'expirou sem envio';

/** Tipos de evento que contam como consulta do paciente (mesmos do ai.processor). */
export const TIPOS_EVENTO_CLINICO = ['CONSULTA', 'PROCEDIMENTO', 'RETORNO', 'ORTODONTIA'];
/** Etapas legadas (Lead.stage) que nunca entram na régua. */
export const ETAPAS_LEGADAS_FORA = ['PERDIDO', 'FINALIZADO', 'EM_FECHAMENTO'];

export const isReativacaoColuna = (c: string | null | undefined): c is ReativacaoColuna =>
  !!c && (REATIVACAO_COLUNAS as string[]).includes(c);

// ─── Relógio de Maceió ───────────────────────────────────────────────────────

/** Date cujos componentes getUTC* são a hora LOCAL de Maceió (convenção naive do app). */
export function maceioNaive(agora: Date): Date {
  return new Date(agora.getTime() - MACEIO_OFFSET_MS);
}

/** 'YYYY-MM-DD' do dia em Maceió. */
export function chaveDiaMaceio(agora: Date): string {
  return maceioNaive(agora).toISOString().slice(0, 10);
}

/** Instante REAL (UTC) de `diaISO` às `hora:minuto` de Maceió. */
export function instanteMaceio(diaISO: string, hora: number, minuto = 0): Date {
  const [y, m, d] = diaISO.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d, hora, minuto) + MACEIO_OFFSET_MS);
}

/** Instante REAL da meia-noite de hoje em Maceió (início do "hoje" pra contagens). */
export function inicioDiaMaceio(agora: Date): Date {
  return instanteMaceio(chaveDiaMaceio(agora), 0);
}

/**
 * Meia-noite de HOJE na convenção NAIVE da agenda (00:00 de Maceió gravado como UTC).
 * É o corte de "consulta marcada" (AGENDADO/CONFIRMADO de hoje em diante): a
 * consulta de HOJE que já começou e a recepção ainda não marcou como compareceu
 * continua contando como "agendou" — senão a régua manda "quer que eu veja um
 * horário?" pra quem está na cadeira. Não vai além de hoje: o faltoso que nunca foi
 * marcado como NO_SHOW em dias anteriores pode voltar à régua.
 */
export function inicioDiaNaive(agora: Date): Date {
  return new Date(Math.floor(maceioNaive(agora).getTime() / DIA_MS) * DIA_MS);
}

/** Consulta AGENDADO/CONFIRMADO com início `startNaive` conta como "agendou" agora? */
export function consultaContaComoAgendou(startNaive: Date, agora: Date): boolean {
  return new Date(startNaive).getTime() >= inicioDiaNaive(agora).getTime();
}

export function somarDiasISO(diaISO: string, n: number): string {
  const [y, m, d] = diaISO.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d) + n * DIA_MS).toISOString().slice(0, 10);
}

/** 0=dom … 6=sáb do dia `diaISO`. */
export function diaSemanaISO(diaISO: string): number {
  return new Date(`${diaISO}T12:00:00Z`).getUTCDay();
}

/** O dia está nos dias da janela da régua (seg–sáb)? */
export function diaPermitido(diaISO: string): boolean {
  return REATIVACAO_JANELA.dias.includes(diaSemanaISO(diaISO));
}

/** Primeiro dia permitido a partir de `diaISO` (inclusive). */
export function proximoDiaPermitido(diaISO: string): string {
  let d = diaISO;
  for (let i = 0; i < 8 && !diaPermitido(d); i++) d = somarDiasISO(d, 1);
  return d;
}

/** Agora está dentro da janela de envio (seg–sáb, 8:00–18:59 de Maceió)? */
export function dentroDaJanela(agora: Date): boolean {
  const n = maceioNaive(agora);
  const h = n.getUTCHours();
  return REATIVACAO_JANELA.dias.includes(n.getUTCDay()) && h >= REATIVACAO_JANELA.inicio && h < REATIVACAO_JANELA.fim;
}

/** `agora` se estiver na janela; senão o próximo início de janela (8:00 de um dia seg–sáb). */
export function proximoInicioJanela(agora: Date): Date {
  if (dentroDaJanela(agora)) return agora;
  const hoje = chaveDiaMaceio(agora);
  if (diaPermitido(hoje) && maceioNaive(agora).getUTCHours() < REATIVACAO_JANELA.inicio) {
    return instanteMaceio(hoje, REATIVACAO_JANELA.inicio);
  }
  return instanteMaceio(proximoDiaPermitido(somarDiasISO(hoje, 1)), REATIVACAO_JANELA.inicio);
}

/**
 * Quando sai cada toque do ciclo: toque 1 = agora (ou o próximo início de janela);
 * toque k = dia do toque 1 + offset[k] dias, às 9h de Maceió. Domingo escorre pra
 * segunda (o despachante não envia no domingo e o painel mostraria data errada).
 */
export function calcularAgendamentos(agora: Date, offsets: number[]): Date[] {
  const t1 = proximoInicioJanela(agora);
  const dia1 = chaveDiaMaceio(t1);
  return offsets.map((off, i) =>
    i === 0 ? t1 : instanteMaceio(proximoDiaPermitido(somarDiasISO(dia1, off)), HORA_TOQUES),
  );
}

/** "Amanhã às 9h" (Maceió), pulando domingo — pra onde vai o toque adiado. */
export function amanhaAsNove(agora: Date): Date {
  return instanteMaceio(proximoDiaPermitido(somarDiasISO(chaveDiaMaceio(agora), 1)), HORA_TOQUES);
}

/**
 * Depois de um envio, os próximos toques do ciclo não podem sair antes do
 * intervalo planejado CONTADO DO ENVIO REAL (o toque pode ter saído atrasado por
 * teto/fila/adiamento): agendado_para = max(planejado, sent_at + (offset_k − offset_enviado)).
 * Devolve só os que mudam.
 */
export function reancorarToques(
  pendentes: { id: string; toque: number; agendado_para: Date }[],
  toqueEnviado: number,
  sentAt: Date,
  offsets: number[],
): { id: string; agendado_para: Date }[] {
  const base = offsets[toqueEnviado - 1] ?? 0;
  const out: { id: string; agendado_para: Date }[] = [];
  for (const p of pendentes) {
    if (p.toque <= toqueEnviado) continue;
    const diff = (offsets[p.toque - 1] ?? base) - base;
    const minimo = new Date(sentAt.getTime() + Math.max(0, diff) * DIA_MS);
    if (minimo.getTime() > new Date(p.agendado_para).getTime()) out.push({ id: p.id, agendado_para: minimo });
  }
  return out;
}

/** Intervalo sorteado entre dois envios no MESMO chip (3–7 min, jitter humano). */
export function intervaloChipMs(rand: number = Math.random()): number {
  const { min, max } = REATIVACAO_INTERVALO_MIN;
  return Math.floor((min + rand * (max - min)) * 60_000);
}

// ─── Quem entra na régua (planejador) ────────────────────────────────────────

/** Conversa serve de "conversa principal" da régua: inbox COMERCIAL, sem inbox, ou inbox legado sem função. */
export function ehConversaComercial(inbox: { purpose?: string | null } | null | undefined): boolean {
  if (!inbox) return true;
  return !inbox.purpose || inbox.purpose === 'COMERCIAL';
}

export interface MensagemLite {
  direction: string;
  type?: string | null;
  created_at: Date;
  external_message_id?: string | null;
  text?: string | null;
}

/** Tipo de Message que nunca chega ao lead (nota interna, evento de transferência…). */
export function ehMensagemInterna(type: string | null | undefined): boolean {
  return !!type && (REATIVACAO_TIPOS_MSG_INTERNA as readonly string[]).includes(type);
}

/**
 * Saída AUTOMÁTICA de outra nutrição: cron legado de follow-up (`sys_followup_legacy_*`),
 * sequência com IA (`sys_followup_ia_*`) e broadcast (`sys_broadcast_*`). Não é
 * conversa: se contasse, o cutucão legado a cada ~5 dias "zeraria" o relógio de
 * parado e o MAX_DIAS_PARADO nunca barraria o contato frio.
 * O prefixo é só atalho: o eco do webhook troca o `sys_*` pelo id real da Evolution
 * (e o legado grava o texto sem a assinatura, então o eco vira outra 'out'). O que
 * vale é o HORÁRIO do envio (temposDeAutomacaoDoLead → ehSaidaAutomatica).
 */
export const AUTOMACAO_EXT_RE = /^sys_(followup|broadcast)_/;

/** A 'out' saiu junto com um envio automático (até ±3 min de um dos `temposAuto`, em ms)? */
export function ehSaidaAutomatica(m: MensagemLite, temposAuto: readonly number[]): boolean {
  if (m.direction !== 'out' || !temposAuto.length) return false;
  const t = new Date(m.created_at).getTime();
  return temposAuto.some((a) => Math.abs(a - t) <= TOLERANCIA_AUTOMACAO_MS);
}

/**
 * Mensagem "real" da conversa: não é nota interna / transferência (o operador grava
 * como direction 'out', type 'internal_note'/'transfer_event' — não foi pro lead),
 * nem um toque da própria régua (id `sys_reativacao_*` ou um dos ids reais que a
 * régua gravou nos toques), nem saída automática de outra nutrição (prefixo `sys_*`
 * ou ±3 min de um `temposAuto`). É ela que diz há quanto tempo a conversa está
 * parada — o last_message_at da conversa sobe com os nossos toques e com as
 * automações e não serve.
 */
export function ehMensagemReal(
  m: MensagemLite,
  idsDaRegua: ReadonlySet<string>,
  temposAuto: readonly number[] = [],
): boolean {
  if (ehMensagemInterna(m.type)) return false;
  const ext = m.external_message_id || '';
  if (ext.startsWith('sys_reativacao_')) return false;
  if (AUTOMACAO_EXT_RE.test(ext)) return false;
  if (ext && idsDaRegua.has(ext)) return false;
  if (ehSaidaAutomatica(m, temposAuto)) return false;
  return true;
}

/** Mensagens reais em ordem DESC (a 1ª é a última da conversa). */
export function mensagensReais<T extends MensagemLite>(
  msgsDesc: T[],
  idsDaRegua: ReadonlySet<string>,
  temposAuto: readonly number[] = [],
): T[] {
  return msgsDesc.filter((m) => ehMensagemReal(m, idsDaRegua, temposAuto));
}

/**
 * O lead já recusou no histórico? Devolve a mensagem (a mais recente) ou null. Só
 * mensagem DO LEAD ('in') e regra AMPLA (ehRecusaDoLead: estrita OU ampla, até 120
 * caracteres): "Não tenho interesse no momento 🙏", "Me tira dessa lista". Serve só
 * pra PULAR/encerrar o ciclo — trancar o contato pra sempre exige a regra estrita
 * (REATIVACAO_OPT_OUT_RE, no despachante). "Cancelar a consulta" não casa.
 *
 * Existe porque o webhook só grava o opt-out quando já há ciclo/toque: quem disse
 * "pare de me mandar mensagem" numa conversa normal e recebeu um "tudo bem" da IA
 * ficaria com a última mensagem 'out' e entraria na régua.
 */
export function pedidoDeParar<T extends MensagemLite>(msgsDesc: T[]): T | null {
  for (const m of msgsDesc) {
    if (m.direction !== 'in' || ehMensagemInterna(m.type)) continue;
    if (ehRecusaDoLead(m.text)) return m;
  }
  return null;
}

/**
 * O pedido de parar vira opt-out PERMANENTE (lead.contact_opt_out_at)? Só se veio
 * DEPOIS de algum toque que a régua enviou: aí é resposta à régua, sem ambiguidade.
 * Pedido antigo, de antes de qualquer toque ("cancelar" solto numa conversa velha),
 * só encerra o ciclo — não tranca o contato pra sempre.
 */
export function optOutDefinitivo(pedidoEm: Date, enviosDaRegua: Date[]): boolean {
  const p = new Date(pedidoEm).getTime();
  return enviosDaRegua.some((s) => new Date(s).getTime() < p);
}

/**
 * Lead em carência de OUTRA nutrição: last_followup_at (sequência concluída / cron
 * legado gravam) ou uma saída automática (sequência, broadcast, cron legado — pelo
 * horário de envio em `temposAuto`, ou pelo prefixo `sys_*`) há menos de 3 dias.
 * Sem isso quem ignorou uma sequência inteira recebia mais 3–4 toques da régua no
 * dia seguinte (o broadcast nem grava last_followup_at). Só o planejador usa (a régua
 * também grava last_followup_at ao enviar, então o despachante não pode olhar isso
 * sem travar os próprios toques).
 */
export function emCarenciaDeNutricao(
  lastFollowupAt: Date | null | undefined,
  msgsDesc: MensagemLite[],
  agora: Date,
  temposAuto: readonly number[] = [],
): boolean {
  const limite = agora.getTime() - CARENCIA_NUTRICAO_MS;
  if (lastFollowupAt && new Date(lastFollowupAt).getTime() > limite) return true;
  if (temposAuto.some((t) => t > limite)) return true;
  return msgsDesc.some(
    (m) => m.direction === 'out' && AUTOMACAO_EXT_RE.test(m.external_message_id || '') && new Date(m.created_at).getTime() > limite,
  );
}

/**
 * Despachante: a última mensagem REAL é do lead = ele escreveu e a clínica é quem
 * deve responder → o ciclo para (RESPONDEU). Pega a resposta que chegou ANTES do
 * ciclo existir (corrida com o planejador; chats.upsert gravando com timestamp
 * antigo) — a checagem "resposta depois de ciclo.created_at" não vê essas.
 * Coluna `agendado` (faltou): mensagem do lead ANTES da falta ("confirmado!") é
 * esperada; só conta se veio DEPOIS do no-show (mesma regra do avaliarCandidato).
 * Sem o evento da falta, na dúvida não manda.
 */
export function leadFalouPorUltimo(
  ultimaReal: { direction: string; created_at: Date } | null | undefined,
  coluna: ReativacaoColuna,
  faltaStartNaive: Date | null,
): boolean {
  if (!ultimaReal || ultimaReal.direction !== 'in') return false;
  if (coluna !== 'agendado') return true;
  if (!faltaStartNaive) return true;
  return new Date(ultimaReal.created_at).getTime() > new Date(faltaStartNaive).getTime() + MACEIO_OFFSET_MS;
}

/** Chave do número pra casar leads gêmeos (55+DDD+8, sem o 9). Sem telefone → chave única do lead. */
export function chaveDoNumero(id: string, phone: string | null | undefined): string {
  const d = String(phone || '').replace(/\D/g, '');
  return d.length >= 10 ? normalizeBrazilianPhone(d) : `lead:${id}`;
}

/**
 * Mesmo número em 2+ leads (12 × 13 dígitos, com/sem 55 — o merge só apaga o lead
 * VAZIO): a régua fala com a PESSOA, não com o lead_id. Fica 1 candidato por número
 * (o de maior `recencia` — quem conversou por último) e o número inteiro sai se
 * QUALQUER contato com ele estiver bloqueado (cliente, opt-out, sem WhatsApp, ciclo
 * ativo). Sem isso nasciam 2 ciclos e a mesma pessoa recebia 2 textos no mesmo dia,
 * e a resposta num lead não parava o outro.
 */
export function deduplicarPorNumero<T extends { id: string; phone: string | null; recencia: number }>(
  candidatos: T[],
  contatos: { id: string; phone: string | null; bloqueado: boolean }[],
): T[] {
  const bloqueado = new Set<string>();
  for (const c of contatos) if (c.bloqueado) bloqueado.add(chaveDoNumero(c.id, c.phone));
  const melhor = new Map<string, T>();
  for (const c of candidatos) {
    const k = chaveDoNumero(c.id, c.phone);
    if (bloqueado.has(k)) continue;
    const atual = melhor.get(k);
    if (!atual || c.recencia > atual.recencia) melhor.set(k, c);
  }
  const ficam = new Set([...melhor.values()].map((c) => c.id));
  return candidatos.filter((c) => ficam.has(c.id));
}

export interface DadosCandidato {
  /** Coluna do "Geral — Leads" em que o lead está agora (generalStageOf/Legacy). */
  colunaGeral: string;
  /** Última mensagem real da conversa principal (null = conversa sem histórico). */
  ultimaMsgReal: { direction: string; created_at: Date } | null;
  /**
   * Tem consulta clínica marcada (AGENDADO/CONFIRMADO) de HOJE em diante — inclusive a
   * de hoje que já começou e ainda não foi marcada como compareceu (consultaContaComoAgendou)?
   */
  temEventoFuturo: boolean;
  /** Último evento clínico JÁ PASSADO do lead/ficha, se ele for NO_SHOW (start_at naive). */
  noShow: { id: string; startNaive: Date } | null;
  /** Já tem ciclo ATIVA (qualquer coluna)? */
  temCicloAtivo: boolean;
  /** Colunas com ciclo recente que bloqueia o reciclo (REATIVACAO_RECICLO_DIAS). */
  colunasBloqueadas: ReadonlySet<string>;
}

export type Avaliacao =
  | { ok: true; coluna: ReativacaoColuna; paradoDesde: Date; refEventId: string | null }
  | { ok: false; motivo: string };

/**
 * O lead entra na régua agora? Regras da SPEC:
 *   - coluna geral precisa ser uma coluna da régua e estar LIGADA na clínica;
 *   - sem ciclo ATIVA e sem ciclo recente da mesma coluna;
 *   - sem consulta futura marcada;
 *   - "parado": a última mensagem real é DA CLÍNICA e tem de MIN a MAX dias. Se a
 *     última é do lead, a clínica é que deve responder — não é caso de régua;
 *   - coluna `agendado` (faltou) tem regra própria: o último evento clínico passado
 *     é um NO_SHOW de ontem pra trás, e o lead não escreveu DEPOIS do no-show (se
 *     escreveu, a clínica deve responder). Mensagem do lead ANTES do no-show (ex.:
 *     "confirmado!") não impede — o gatilho é a falta.
 */
export function avaliarCandidato(d: DadosCandidato, colunasLigadas: ReadonlySet<string>, agora: Date): Avaliacao {
  const coluna = d.colunaGeral;
  if (!isReativacaoColuna(coluna)) return { ok: false, motivo: `coluna ${coluna} fora da régua` };
  if (!colunasLigadas.has(coluna)) return { ok: false, motivo: 'coluna desligada' };
  if (d.temCicloAtivo) return { ok: false, motivo: 'já tem ciclo ativo' };
  if (d.colunasBloqueadas.has(coluna)) return { ok: false, motivo: 'ciclo recente da mesma coluna' };
  if (d.temEventoFuturo) return { ok: false, motivo: 'tem consulta futura' };

  const agoraMs = agora.getTime();
  const maxMs = REATIVACAO_MAX_DIAS_PARADO * DIA_MS;

  if (coluna === 'agendado') {
    if (!d.noShow) return { ok: false, motivo: 'sem falta (NO_SHOW) recente' };
    // "Há ≥1 dia": o dia do no-show (naive) precisa ser ANTES de hoje (naive).
    const diaFalta = d.noShow.startNaive.toISOString().slice(0, 10);
    if (diaFalta >= chaveDiaMaceio(agora)) return { ok: false, motivo: 'faltou hoje — entra amanhã' };
    // Instante real da falta (naive + 3h) — pra comparar com mensagens (instantes reais).
    const faltaReal = new Date(d.noShow.startNaive.getTime() + MACEIO_OFFSET_MS);
    if (agoraMs - faltaReal.getTime() > maxMs) return { ok: false, motivo: 'falta antiga demais' };
    const ult = d.ultimaMsgReal;
    if (ult && ult.direction === 'in' && new Date(ult.created_at).getTime() > faltaReal.getTime()) {
      return { ok: false, motivo: 'lead escreveu depois da falta — a clínica deve responder' };
    }
    const ultMs = ult ? new Date(ult.created_at).getTime() : 0;
    return { ok: true, coluna, paradoDesde: new Date(Math.max(faltaReal.getTime(), ultMs)), refEventId: d.noShow.id };
  }

  const ult = d.ultimaMsgReal;
  if (!ult) return { ok: false, motivo: 'conversa sem histórico' };
  if (ult.direction !== 'out') return { ok: false, motivo: 'última mensagem é do lead — a clínica deve responder' };
  const paradoMs = agoraMs - new Date(ult.created_at).getTime();
  if (paradoMs < REATIVACAO_MIN_DIAS_PARADO[coluna] * DIA_MS) return { ok: false, motivo: 'parado há pouco tempo' };
  if (paradoMs > maxMs) return { ok: false, motivo: 'parado há tempo demais' };
  return { ok: true, coluna, paradoDesde: new Date(ult.created_at), refEventId: null };
}

/** Lote do dia: quem esfriou há MENOS tempo primeiro (mais chance de voltar), até `vagas`. */
export function selecionarLote<T extends { paradoDesde: Date }>(aprovados: T[], vagas: number): T[] {
  if (vagas <= 0) return [];
  return aprovados
    .slice()
    .sort((a, b) => new Date(b.paradoDesde).getTime() - new Date(a.paradoDesde).getTime())
    .slice(0, vagas);
}

/**
 * Novos ciclos por clínica por dia: um terço do teto (cada ciclo gera vários toques),
 * no MÍNIMO 1. A API aceita teto 1 ou 2 ("começar devagar"); com floor puro a cota
 * dava 0 e a régua nunca planejava nada, sem aviso. O teto de ENVIADOS do
 * despachante continua valendo, então 1 ciclo/dia não fura o ritmo.
 */
export function cotaNovosCiclos(teto: number): number {
  return Math.max(1, Math.floor(teto / 3));
}

/**
 * Disjuntor do chip: as 2 tentativas mais recentes no chip (mais nova primeiro)
 * foram FALHOU "pode ter saído"? Então a Evolution está degradada (responde erro
 * mas talvez entregue) — pausa o chip em vez de seguir tentando a cada 3–7 min.
 */
export function disjuntorAbre(ultimasTentativas: { status: string; motivo: string | null }[]): boolean {
  if (ultimasTentativas.length < 2) return false;
  return ultimasTentativas
    .slice(0, 2)
    .every((t) => t.status === 'FALHOU' && String(t.motivo || '').includes(MOTIVO_PODE_TER_SAIDO));
}

/**
 * Um ciclo recente (dentro de REATIVACAO_RECICLO_DIAS) da mesma coluna impede o
 * lead de voltar pra ela? Sim se algo SAIU pro lead, ou se o ciclo foi encerrado
 * de propósito (parado manualmente, opt-out, sem WhatsApp, concluído). Não bloqueia
 * o ciclo que nunca enviou nada e acabou por motivo "técnico" (coluna desligada,
 * expirou na prévia) ou porque o lead reagiu sozinho durante a prévia — senão
 * desligar uma coluna por 1 dia trancaria esses leads por 90 dias sem nunca terem
 * recebido nada.
 */
export function cicloBloqueiaReciclo(c: { status: string; motivo_fim: string | null; teveEnvio: boolean }): boolean {
  if (c.status === 'ATIVA') return true;
  if (c.teveEnvio) return true;
  if (c.motivo_fim === MOTIVO_COLUNA_DESLIGADA || c.motivo_fim === MOTIVO_EXPIROU) return false;
  return ['CANCELADA', 'OPT_OUT', 'SEM_WHATSAPP', 'CONCLUIDA'].includes(c.status);
}

// ─── Horários reais ({horario1}/{horario2}) ──────────────────────────────────

const DIAS_CURTOS = ['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado'];

/** "quinta 16/10 às 14:00" — rótulo do horário pro cliente. */
export function rotuloHorario(diaISO: string, hora: string): string {
  const [, m, d] = diaISO.split('-');
  return `${DIAS_CURTOS[diaSemanaISO(diaISO)]} ${d}/${m} às ${hora}`;
}

/**
 * Os 2 horários oferecidos: o 1º horário de cada um dos 2 dias mais próximos com
 * vaga (espalha em dias diferentes, o mais cedo primeiro — mesma curadoria do
 * ai.processor). Só 1 dia com vaga → os 2 primeiros horários dele.
 */
export function escolherHorarios(dias: { diaISO: string; horas: string[] }[]): { diaISO: string; hora: string }[] {
  const comVaga = dias.filter((d) => d.horas.length > 0);
  if (comVaga.length >= 2) return comVaga.slice(0, 2).map((d) => ({ diaISO: d.diaISO, hora: d.horas[0] }));
  if (comVaga.length === 1) return comVaga[0].horas.slice(0, 2).map((h) => ({ diaISO: comVaga[0].diaISO, hora: h }));
  return [];
}

// ─── Variáveis do modelo ─────────────────────────────────────────────────────
// interesseDoFunil e dentistaDoModelo: ver o reexport do @crm/shared no topo.

/**
 * Prévia/fallback SEM IA: preenche as variáveis e, se o lead não tem nome chamável,
 * tira o vocativo ("Oi, {nome}!" → "Oi!", "{nome}, lembrei" → "Lembrei"). Devolve
 * null se sobrar algo que só a IA resolve ([instrução] ou {variável} sem valor —
 * ex.: horários quando a agenda não tem vaga).
 */
export function renderizarModeloFallback(
  modelo: string,
  vars: Partial<Record<string, string | null | undefined>>,
): string | null {
  let base = modelo;
  if (!vars.nome || !String(vars.nome).trim()) {
    base = base
      .replace(/,\s*\{nome\}\s*([!?.])/g, '$1')
      .replace(/,\s*\{nome\}/g, '')
      .replace(/(^|\n)\{nome\},\s*(\p{L})/gu, (_m, ini: string, c: string) => `${ini}${c.toUpperCase()}`)
      .replace(/\{nome\}\s*/g, '');
  }
  const texto = renderReativacaoModelo(base, vars).replace(/\n{3,}/g, '\n\n').trim();
  if (!texto || /[[\]{}]/.test(texto)) return null;
  return texto;
}

// ─── Texto da IA: limpeza e validação ────────────────────────────────────────

const EMOJI_RE = /\p{Extended_Pictographic}(?:️|‍\p{Extended_Pictographic})*/gu;

/** Quebra em balões pela LINHA EM BRANCO; acima de `max`, o excedente vai junto no último. */
export function dividirBaloes(texto: string, max = BALOES_MAX): string[] {
  const partes = String(texto || '')
    .split(/\n[ \t]*\n+/)
    .map((p) => p.trim())
    .filter(Boolean);
  if (partes.length <= max) return partes;
  return [...partes.slice(0, max - 1), partes.slice(max - 1).join('\n')];
}

/**
 * Limpa o que a IA devolve antes de validar: aspas em volta, assinatura "*Nome:*"
 * (o despachante põe a do perfil), travessão, linhas em branco a mais, emoji além
 * do primeiro e balões além de 4.
 */
export function sanitizarTextoIA(raw: string | null | undefined): string {
  let t = String(raw ?? '').replace(/\r\n?/g, '\n').trim();
  t = t.replace(/^["“”']+|["“”']+$/g, '').trim();
  t = t.replace(/^\*[^*\n]{1,40}:\*\s*/, '');
  t = tidyReply(t);
  t = t
    .split('\n')
    .map((l) => l.trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n');
  let emojis = 0;
  t = t.replace(EMOJI_RE, (e) => (++emojis === 1 ? e : '')).replace(/[ \t]{2,}/g, ' ');
  return dividirBaloes(t).join('\n\n').trim();
}

const plano = (s: string) =>
  s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

/** Frases que o dono proibiu (comparadas sem acento/pontuação). */
export const FRASES_PROIBIDAS = [
  'precisando e so me chamar',
  'fico a disposicao',
  'estou a disposicao',
  'depende muito do que voce vai precisar',
  'a gente agenda sem compromisso',
  'so na avaliacao a doutora consegue te dizer',
  'voce sumiu',
];

// Valores em dinheiro: extrairValoresDinheiro (@crm/shared) — pega "R$ 150", "150
// reais" e "2 mil". O antigo extrairValoresRS só via "R$" e deixava passar "a
// avaliação sai 120 reais".

/**
 * Tira as frases com preço que a clínica NÃO liberou (removerPrecosNaoLiberados do
 * @crm/shared), mas só mexe no texto quando há o que tirar. Motivo: o corte é por
 * frase (quebra em ". ") e por isso parte "com a Dra. Ana" no meio — aplicado sem
 * necessidade reformataria texto bom. Use no MODELO CRU (com "{dentista}", antes de
 * virar "Dra. Ana") e no gancho; no texto já renderizado vira só uma rede de
 * segurança (normalmente não sobra nada pra tirar).
 */
export function semPrecoNaoLiberado(texto: string, liberados: ReadonlySet<number>): string {
  if (extrairValoresDinheiro(String(texto || '')).every((v) => liberados.has(v))) return texto;
  return removerPrecosNaoLiberados(texto, liberados);
}

/**
 * Tira as frases com {valor_*} que a tabela da clínica não preencheu
 * (removerFrasesComVariavelVazia do @crm/shared), mas só quando há o que tirar — o
 * corte por frase junta as linhas do balão, como no semPrecoNaoLiberado. Use no
 * modelo/gancho CRU, antes de preencher as variáveis.
 */
export function semFraseDeValorVazio(texto: string, valores: Partial<Record<string, string | null | undefined>>): string {
  const vazia = (String(texto || '').match(/\{valor_\w+\}/g) || []).some((m) => !String(valores[m.slice(1, -1)] ?? '').trim());
  return vazia ? removerFrasesComVariavelVazia(texto, valores) : texto;
}

const HORA_RE = /\b([01]?\d|2[0-3])(?::([0-5]\d)|h([0-5]\d)?)(?![\d:])/gi;
/**
 * Hora por extenso COM sufixo, com ou sem "às": "às 15 horas", "quinta, 15 horas",
 * "3 da tarde". Duração não conta ("em 2 horas", "dura 1 hora", "de 2 a 3 horas").
 * Lookbehind com /u porque o \b do JS não vê "à" como letra.
 */
const HORA_EXT_RE =
  /(?<![\p{L}\d])(?<!(?:^|[^\p{L}])(?:em|por|de|a|at[ée]|dura|duram|durante|leva|levam|h[áa]|uns|umas|cerca de|mais de|menos de|quase|apenas|s[óo])\s+)([01]?\d|2[0-3])(?:\s*(?:horas?|hrs?)(?![\p{L}])|\s+(?:da|de|pela)\s+(manh[ãa]|tarde|noite|madrugada)(?![\p{L}]))/giu;
/**
 * Hora SEM sufixo só depois de "às/pelas" (com acento — "as 3 etapas" e "uma das 2
 * opções" não são horário): "às 14", "quinta às 15.", "às 15, ok?". Não pega
 * "às 10 reais", "às 2,5" nem o que já tem sufixo (fica pro HORA_EXT_RE / HORA_RE).
 */
const HORA_NUA_RE =
  /(?<![\p{L}\d])(?:às|pelas|a partir das)\s+([01]?\d|2[0-3])(?![\d:/%hH]|[.,]\d|\s*(?:horas?|hrs?)(?![\p{L}])|\s+(?:da|de|pela)\s+(?:manh|tarde|noite|madrugada)|\s*(?:reais|mil|%|por cento|min|dias|semanas|meses|anos|pessoas|parcelas|x(?![\p{L}])|vezes))/giu;
const DIA_SEMANA_RE = /\b(domingo|segunda|ter[çc]a|quarta|quinta|sexta|s[áa]bado)(?:-feira)?\b/gi;
const DIA_SEMANA_IDX: Record<string, number> = {
  domingo: 0, segunda: 1, terça: 2, terca: 2, quarta: 3, quinta: 4, sexta: 5, sábado: 6, sabado: 6,
};

/** Horários citados ("14:00", "9h", "às 15 horas", "às 3 da tarde") com a posição, em ordem. */
function horariosCitados(texto: string): { index: number; hora: string }[] {
  const out: { index: number; hora: string }[] = [];
  let m: RegExpExecArray | null;
  const a = new RegExp(HORA_RE.source, HORA_RE.flags);
  while ((m = a.exec(texto))) out.push({ index: m.index, hora: `${m[1].padStart(2, '0')}:${m[2] || m[3] || '00'}` });
  const b = new RegExp(HORA_EXT_RE.source, HORA_EXT_RE.flags);
  while ((m = b.exec(texto))) {
    let h = Number(m[1]);
    const periodo = (m[2] || '').toLowerCase();
    if ((periodo === 'tarde' || periodo === 'noite') && h < 12) h += 12;
    out.push({ index: m.index, hora: `${String(h).padStart(2, '0')}:00` });
  }
  const c = new RegExp(HORA_NUA_RE.source, HORA_NUA_RE.flags);
  while ((m = c.exec(texto))) out.push({ index: m.index, hora: `${m[1].padStart(2, '0')}:00` });
  return out.sort((x, y) => x.index - y.index);
}

/** Horários citados ("14:00", "9h", "9h30", "às 15 horas", "às 3 da tarde") → "HH:MM". */
export function extrairHorarios(texto: string): string[] {
  return horariosCitados(texto).map((h) => h.hora);
}

/**
 * Pares (dia da semana, horário) citados: pra cada horário, o dia da semana mais
 * próximo ANTES dele (até 30 caracteres — "quinta 16/10 às 14:00", "sexta às 9h").
 * Pega a IA que troca o dia de um horário real ("quarta às 14:00" quando a vaga é na quinta).
 */
export function paresDiaHora(texto: string): { dia: number; hora: string }[] {
  const out: { dia: number; hora: string }[] = [];
  for (const h of horariosCitados(texto)) {
    const antes = texto.slice(Math.max(0, h.index - 30), h.index);
    const dias = [...antes.matchAll(new RegExp(DIA_SEMANA_RE.source, DIA_SEMANA_RE.flags))];
    const ultimo = dias[dias.length - 1];
    if (!ultimo) continue;
    const dia = DIA_SEMANA_IDX[ultimo[1].toLowerCase()];
    if (dia == null) continue;
    out.push({ dia, hora: h.hora });
  }
  return out;
}

/** Datas citadas ("16/10") → "DD/MM". */
export function extrairDatas(texto: string): string[] {
  const out: string[] = [];
  const re = /\b([0-3]?\d)\/([01]?\d)\b/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(texto))) out.push(`${m[1].padStart(2, '0')}/${m[2].padStart(2, '0')}`);
  return out;
}

export interface ContextoValidacao {
  /**
   * O modelo JÁ com as variáveis e JÁ sem as frases de preço não liberado
   * (removerPrecosNaoLiberados) — é a fonte dos valores/percentuais/horários/datas aceitos.
   */
  modeloRenderizado: string;
  /**
   * Valores (R$) que a CLÍNICA liberou (precosLiberados: AI_PRICE_TABLE +
   * AI_PRICES_ENABLED). Obrigatório de propósito: sem tabela = conjunto vazio =
   * nenhum preço sai (falha fechada).
   */
  precosLiberados: ReadonlySet<number>;
  /** Horários reais oferecidos ("HH:MM"). */
  horarios: string[];
  /** Datas reais oferecidas ("DD/MM"). */
  datas: string[];
  /** Dia da semana de cada horário oferecido (0=dom…6=sáb). */
  diasHorarios?: { dia: number; hora: string }[];
}

/**
 * O texto da IA pode sair? Não vazio, ≤ REATIVACAO_TEXTO_MAX caracteres, sem link,
 * sem [ ] nem {variável} sobrando, todo valor em dinheiro citado ("R$ 150", "150
 * reais", "2 mil") é um preço LIBERADO pela clínica e está no modelo, todo
 * percentual ("10%", "10 por cento") está no modelo, nenhum horário/data inventado
 * (só os fornecidos ou os que já estão no modelo), sem as frases proibidas e sem
 * dizer que é IA.
 */
export function validarTextoReativacao(texto: string, ctx: ContextoValidacao): { ok: true } | { ok: false; motivo: string } {
  const t = String(texto || '').trim();
  if (!t) return { ok: false, motivo: 'vazio' };
  if (t.length > TEXTO_MAX_CHARS) return { ok: false, motivo: `longo (${t.length} caracteres)` };
  if (/https?:\/\/|www\./i.test(t)) return { ok: false, motivo: 'tem link' };
  if (/[[\]]/.test(t)) return { ok: false, motivo: 'sobrou [instrução]' };
  if (/\{\w+\}/.test(t)) return { ok: false, motivo: 'sobrou {variável}' };

  // Preço: precisa estar na tabela da clínica E no modelo deste toque. O modelo já
  // chega filtrado (então "no modelo" implica "liberado"), mas exigir os dois
  // protege se alguém esquecer de filtrar — e barra o valor que a IA tirou do
  // histórico ou de outra frase da tabela.
  const valoresModelo = new Set(extrairValoresDinheiro(ctx.modeloRenderizado));
  const valorInventado = extrairValoresDinheiro(t).find((v) => !ctx.precosLiberados.has(v) || !valoresModelo.has(v));
  if (valorInventado != null) return { ok: false, motivo: `valor ${valorInventado} não liberado/fora do modelo` };

  // Desconto/condição em % só se o modelo da clínica já traz (ex.: "10% à vista").
  const pctModelo = new Set(extrairPercentuais(ctx.modeloRenderizado));
  const pctInventado = extrairPercentuais(t).find((p) => !pctModelo.has(p));
  if (pctInventado != null) return { ok: false, motivo: `percentual ${pctInventado}% fora do modelo` };

  const horasOk = new Set([...ctx.horarios, ...extrairHorarios(ctx.modeloRenderizado)]);
  const horaInventada = extrairHorarios(t).find((h) => !horasOk.has(h));
  if (horaInventada) return { ok: false, motivo: `horário ${horaInventada} inventado` };

  const datasOk = new Set([...ctx.datas, ...extrairDatas(ctx.modeloRenderizado)]);
  const dataInventada = extrairDatas(t).find((d) => !datasOk.has(d));
  if (dataInventada) return { ok: false, motivo: `data ${dataInventada} inventada` };

  const paresOk = new Set(
    [...(ctx.diasHorarios ?? []), ...paresDiaHora(ctx.modeloRenderizado)].map((p) => `${p.dia}|${p.hora}`),
  );
  const parTrocado = paresDiaHora(t).find((p) => !paresOk.has(`${p.dia}|${p.hora}`));
  if (parTrocado) return { ok: false, motivo: `horário ${parTrocado.hora} no dia da semana errado` };

  const p = plano(t);
  const proibida = FRASES_PROIBIDAS.find((f) => p.includes(f));
  if (proibida) return { ok: false, motivo: `frase proibida ("${proibida}")` };
  // A sigla "IA" é checada SEM /i: com a flag, "\bIA\b" casava o "ia" de "você ia
  // vir" / "eu ia te mandar" (imperfeito de "ir") e recusava texto bom.
  if (/intelig[eê]ncia artificial|assistente virtual|chatbot|\bsou (um )?rob[oô]\b/i.test(t) || /\bIA\b/.test(t)) {
    return { ok: false, motivo: 'diz que é IA' };
  }
  return { ok: true };
}

/**
 * O texto pronto ainda serve na hora do envio? Texto com horário (oferta de
 * agenda) só vale no MESMO dia em que foi escrito — os horários começam "amanhã" a
 * partir da escrita e podem já ter passado. Qualquer texto com mais de 3 dias é
 * reescrito (a conversa/agenda mudou). Sem data de escrita = reescreve.
 */
export function textoPrecisaReescrever(texto: string, geradoEm: Date | null | undefined, agora: Date): boolean {
  if (!geradoEm) return true;
  if (agora.getTime() - new Date(geradoEm).getTime() > 3 * DIA_MS) return true;
  return extrairHorarios(texto).length > 0 && chaveDiaMaceio(new Date(geradoEm)) !== chaveDiaMaceio(agora);
}

// ─── Evolution: interpretar respostas ────────────────────────────────────────

const soDigitos = (s: unknown) => String(s ?? '').replace(/\D/g, '');

/**
 * Resposta do POST /chat/whatsappNumbers. `existe` = a variante que está no
 * WhatsApp (preferindo a ordem de `numeros`); `nao_existe` = a Evolution respondeu
 * e NENHUMA variante existe; `indisponivel` = não deu pra saber (quem chama envia
 * no número cadastrado e confia no exists:false do envio).
 */
export function interpretarWhatsappNumbers(
  resp: unknown,
  numeros: string[],
): { estado: 'existe'; numero: string } | { estado: 'nao_existe' } | { estado: 'indisponivel' } {
  const r: any = resp;
  const arr: any[] | null = Array.isArray(r) ? r : Array.isArray(r?.data) ? r.data : null;
  if (!arr || arr.length === 0) return { estado: 'indisponivel' };
  for (const n of numeros) {
    const dn = soDigitos(n);
    const hit = arr.find((x) => x && x.exists === true && (soDigitos(x.number) === dn || soDigitos(String(x.jid || '').split('@')[0]) === dn));
    if (hit) return { estado: 'existe', numero: n };
  }
  const qualquer = arr.find((x) => x && x.exists === true);
  if (qualquer) {
    const num = soDigitos(String(qualquer.jid || '').split('@')[0]) || soDigitos(qualquer.number);
    if (num) return { estado: 'existe', numero: num };
  }
  if (arr.every((x) => x && x.exists === false)) return { estado: 'nao_existe' };
  return { estado: 'indisponivel' };
}

export type ResultadoEnvio =
  | { tipo: 'ok'; id: string }
  | { tipo: 'sem_whatsapp'; detalhe: string }
  | { tipo: 'chip_caido'; detalhe: string }
  | { tipo: 'talvez_saiu'; detalhe: string }
  | { tipo: 'recusado'; detalhe: string };

/**
 * Classifica o resultado de um sendText. Sucesso SÓ com key.id e sem exists:false
 * (a Evolution responde 2xx com exists:false, ou 400 com ele no corpo). Chip fora
 * (404/428/"Connection Closed") = não saiu, dá pra tentar depois. Timeout/5xx/sem
 * resposta/2xx sem id = PODE ter saído: nunca reenviar sozinho.
 */
export function classificarEnvio(r: {
  httpStatus?: number | null;
  data?: unknown;
  erroCodigo?: string | null;
  erroMensagem?: string | null;
}): ResultadoEnvio {
  let corpo = '';
  try {
    corpo = r.data == null ? '' : typeof r.data === 'string' ? r.data : JSON.stringify(r.data);
  } catch {
    corpo = '';
  }
  const msg = String(r.erroMensagem || '');
  const status = typeof r.httpStatus === 'number' ? r.httpStatus : null;
  const detalhe = `${status ?? r.erroCodigo ?? 'sem resposta'}: ${(corpo || msg).slice(0, 160)}`;

  if (/"exists"\s*:\s*false/.test(corpo) || /"exists"\s*:\s*false/.test(msg)) return { tipo: 'sem_whatsapp', detalhe };
  if (status === 404 || status === 428 || /connection closed|not connected|instance .*does not exist/i.test(`${corpo} ${msg}`)) {
    return { tipo: 'chip_caido', detalhe };
  }
  // Evolution inalcançável (recusou a conexão / DNS): a requisição nem chegou — não saiu.
  if (status == null && ['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN'].includes(String(r.erroCodigo || ''))) {
    return { tipo: 'chip_caido', detalhe };
  }
  if (status != null && status >= 200 && status < 300) {
    const d: any = r.data;
    const id = d?.key?.id;
    if (typeof id === 'string' && id) return { tipo: 'ok', id };
    if (d?.error || (typeof d?.status === 'number' && d.status >= 400 && d.status < 500)) return { tipo: 'recusado', detalhe };
    return { tipo: 'talvez_saiu', detalhe };
  }
  if (status == null || status === 408 || status >= 500) return { tipo: 'talvez_saiu', detalhe };
  return { tipo: 'recusado', detalhe };
}

/** Variantes do número pra checar no WhatsApp (com/sem o 9º dígito), a cadastrada primeiro. */
export function variantesEnvio(cadastrado: string, variantes: string[]): string[] {
  const set = new Set<string>();
  const add = (n: string) => {
    const d = soDigitos(n);
    if (d.startsWith('55') && (d.length === 12 || d.length === 13)) set.add(d);
  };
  add(cadastrado);
  variantes.forEach(add);
  return [...set];
}

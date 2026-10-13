/**
 * Regras PURAS do aviso "Novo agendamento" aos ADMs (sem Prisma/DI — testáveis).
 * O serviço (admin-agendamento-alert.service.ts) busca, faz o claim e envia.
 *
 * Agenda naive-UTC: start_at guarda a hora de Maceió gravada como UTC — formata com
 * getUTC* (nunca toLocale*), e "agora" de Maceió = Date.now() - 3h.
 */

/** Origem de quem marcou: a IA (book_appointment, created_by_ai=true) ou a equipe. */
export type OrigemAgendamento = 'IA' | 'EQUIPE';

/** Toggles por clínica (Central de Disparos) — default DESLIGADO, só 'true' liga. */
export const adminAgendamentoKey = (origem: OrigemAgendamento, tenantId: string) =>
  `ADMIN_AGENDAMENTO_${origem}_ENABLED_${tenantId}`;
export const ADMIN_AGENDAMENTO_KEY_PREFIX: Record<OrigemAgendamento, string> = {
  IA: 'ADMIN_AGENDAMENTO_IA_ENABLED_',
  EQUIPE: 'ADMIN_AGENDAMENTO_EQUIPE_ENABLED_',
};

/** DispatchLog.type do aviso (Central de Disparos: DISPATCH_TYPES/TYPE_LABEL). */
export const ADMIN_AGENDAMENTO_DISPATCH_TYPE = 'admin_agendamento';

/** Tipos de evento que são atendimento de verdade (TAREFA/BLOQUEIO/OUTRO/jurídicos ficam de fora). */
export const ADMIN_AGENDAMENTO_TIPOS = ['CONSULTA', 'PROCEDIMENTO', 'RETORNO', 'ORTODONTIA'];
/** Status "marcado" (cancelado/desmarcou/faltou/concluído não avisa). */
export const ADMIN_AGENDAMENTO_STATUS = ['AGENDADO', 'CONFIRMADO'];

/** Nunca avisa backlog: só eventos criados nas últimas 2h (e depois de ligar o toggle). */
export const ADMIN_AGENDAMENTO_JANELA_MS = 2 * 60 * 60 * 1000;
/** Respiro após a criação (o fluxo de criar pode completar o evento logo em seguida). */
export const ADMIN_AGENDAMENTO_RESPIRO_MS = 15 * 1000;
/** Consulta que já passou há mais que isto (registro retroativo) não é "novo agendamento". */
export const ADMIN_AGENDAMENTO_PASSADO_TOLERANCIA_MS = 60 * 60 * 1000;
/** Máximo de avisos por clínica por rodada (1 rodada/minuto). */
export const ADMIN_AGENDAMENTO_MAX_POR_TICK = 20;

const MACEIO_OFFSET_MS = 3 * 60 * 60 * 1000;

/** "Agora" de Maceió no formato naive-UTC da agenda. */
export function agoraNaiveMaceio(agora: Date): Date {
  return new Date(agora.getTime() - MACEIO_OFFSET_MS);
}

/**
 * A partir de quando um evento conta como "novo": o MAIS RECENTE entre a hora em que
 * o toggle foi ligado (GlobalSetting.updated_at) e agora-2h. Ligar o toggle nunca
 * dispara aviso de agendamento antigo.
 */
export function inicioJanelaAviso(toggleLigadoEm: Date | null | undefined, agora: Date): Date {
  const piso = agora.getTime() - ADMIN_AGENDAMENTO_JANELA_MS;
  const ligado = toggleLigadoEm ? new Date(toggleLigadoEm).getTime() : 0;
  return new Date(Math.max(piso, Number.isFinite(ligado) ? ligado : 0));
}

const TIPO_LABEL: Record<string, string> = {
  CONSULTA: 'Consulta',
  PROCEDIMENTO: 'Procedimento',
  RETORNO: 'Retorno',
  ORTODONTIA: 'Ortodontia',
};

/** "Consulta" / "Consulta · Avaliação" (com o tipo de atendimento cadastrado, se houver). */
export function rotuloTipoAgendamento(type: string | null | undefined, appointmentTypeName?: string | null): string {
  const base = TIPO_LABEL[String(type || '').toUpperCase()] || (type ? String(type) : 'Atendimento');
  const extra = String(appointmentTypeName || '').trim();
  if (!extra || extra.toLowerCase() === base.toLowerCase()) return base;
  return `${base} · ${extra}`;
}

const DIAS_SEMANA = ['domingo', 'segunda-feira', 'terça-feira', 'quarta-feira', 'quinta-feira', 'sexta-feira', 'sábado'];
const pad2 = (n: number) => String(n).padStart(2, '0');

/** "segunda-feira 13/10 às 14:30" — start_at naive-UTC (getUTC*). Dia inteiro: sem hora. */
export function rotuloQuandoAgendamento(startNaive: Date, allDay = false): string {
  const d = new Date(startNaive);
  const dia = `${DIAS_SEMANA[d.getUTCDay()]} ${pad2(d.getUTCDate())}/${pad2(d.getUTCMonth() + 1)}`;
  return allDay ? `${dia} (dia inteiro)` : `${dia} às ${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}`;
}

const RECORRENCIA_LABEL: Record<string, string> = {
  DAILY: 'diária',
  WEEKLY: 'semanal',
  BIWEEKLY: 'quinzenal',
  MONTHLY: 'mensal',
  CUSTOM: 'personalizada',
};

export interface DadosAvisoAgendamento {
  pacienteNome: string | null | undefined;
  telefone: string | null | undefined;
  startNaive: Date;
  allDay?: boolean;
  tipo: string | null | undefined;
  tipoNome?: string | null;
  dentista: string | null | undefined;
  origem: OrigemAgendamento;
  /** Nome da assistente da clínica (perfil da IA) — só pra origem IA. */
  assistente?: string | null;
  /** Nome do usuário que marcou — só pra origem EQUIPE. */
  criadoPor?: string | null;
  /** recurrence_rule do evento (série recorrente: avisa só a 1ª). */
  recorrencia?: string | null;
}

/** Texto curto do aviso aos ADMs. */
export function montarTextoNovoAgendamento(d: DadosAvisoAgendamento): string {
  const nome = String(d.pacienteNome || '').trim() || 'Paciente sem nome';
  const tel = String(d.telefone || '').trim();
  const marcadoPor =
    d.origem === 'IA'
      ? `IA (${String(d.assistente || '').trim() || 'assistente'})`
      : String(d.criadoPor || '').trim() || 'equipe';
  const linhas = [
    '📅 *Novo agendamento*',
    `Paciente: ${nome}${tel ? ` (${tel})` : ''}`,
    `Quando: ${rotuloQuandoAgendamento(d.startNaive, !!d.allDay)}`,
    `Tipo: ${rotuloTipoAgendamento(d.tipo, d.tipoNome)}`,
    `Com: ${String(d.dentista || '').trim() || 'sem dentista definido'}`,
    `Marcado por: ${marcadoPor}`,
  ];
  const rec = String(d.recorrencia || '').toUpperCase();
  if (rec) linhas.push(`Repete: ${RECORRENCIA_LABEL[rec] || 'sim'} (aviso só da 1ª)`);
  return linhas.join('\n');
}

/**
 * Agrupa as chaves ligadas (GlobalSetting) por clínica: { tenantId → { IA?, EQUIPE? } }
 * com o updated_at de cada toggle (vira o início da janela).
 */
export function togglesPorClinica(
  rows: { key: string; value: string; updated_at: Date }[],
): Map<string, Partial<Record<OrigemAgendamento, Date>>> {
  const out = new Map<string, Partial<Record<OrigemAgendamento, Date>>>();
  for (const r of rows) {
    if (r.value !== 'true') continue;
    for (const origem of ['IA', 'EQUIPE'] as OrigemAgendamento[]) {
      const prefixo = ADMIN_AGENDAMENTO_KEY_PREFIX[origem];
      if (!r.key.startsWith(prefixo)) continue;
      const tenantId = r.key.slice(prefixo.length);
      if (!tenantId) continue;
      const cur = out.get(tenantId) || {};
      cur[origem] = r.updated_at;
      out.set(tenantId, cur);
    }
  }
  return out;
}

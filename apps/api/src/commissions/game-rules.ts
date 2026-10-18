/**
 * Out/2026 — "Meu jogo" do profissional (decisão do dono).
 *
 * Com os profissionais (dentista) o sistema NÃO fala em comissão nem em dinheiro:
 * mostra PONTOS pela produção clínica, nível, metas e missões. Comissão/R$ fica só
 * na visão do admin/financeiro (Comissões / Modo Jogo da equipe).
 *
 * Pontos do mês — só atividade REAL, nada ligado a R$:
 *   procedimento executado (TreatmentPlanItem DONE, executado por ele) ... +10
 *   atendimento confirmado (consulta dele validada) ...................... +5
 *   avaliação montada (orçamento criado por ele com procedimento) ........ +5
 *   avaliação que virou tratamento (orçamento dele ACEITO no mês) ........ +20
 *   missão da semana cumprida (config COMMISSION_MISSIONS_<tenant>) ...... +50
 *
 * Datas: consulta (start_at) é naive-UTC (hora de Maceió no campo UTC); os demais
 * (executed_at, created_at, accepted_at) são instantes reais → mês de Maceió = UTC+3h.
 */
import type { PrismaService } from '../prisma/prisma.service';

// ─── Missões (config por clínica; a recompensa em texto é da visão do admin) ──
export type MissionDef = { id: string; titulo: string; metrica: string; alvo: number; recompensa: string };
export type MissionsConfig = { enabled: boolean; missions: MissionDef[] };

// Recompensa é TEXTO (a premiação é decisão manual da clínica, NÃO credita no client).
// metrica: 'procedimentos' | 'zero_faltas'.
export const DEFAULT_MISSIONS: MissionsConfig = {
  enabled: true,
  missions: [
    { id: 'proc', titulo: 'Execute 5 procedimentos', metrica: 'procedimentos', alvo: 5, recompensa: '+R$ 100' },
    { id: 'faltas', titulo: 'Zero faltas na agenda', metrica: 'zero_faltas', alvo: 1, recompensa: '+R$ 80' },
  ],
};

export async function readMissionsConfig(prisma: PrismaService, tenantId: string): Promise<MissionsConfig> {
  try {
    const row = await prisma.globalSetting.findUnique({ where: { key: `COMMISSION_MISSIONS_${tenantId}` } });
    if (!row?.value) return DEFAULT_MISSIONS;
    const parsed = JSON.parse(row.value);
    if (!parsed || !Array.isArray(parsed.missions)) return DEFAULT_MISSIONS;
    return { enabled: parsed.enabled !== false, missions: parsed.missions };
  } catch {
    return DEFAULT_MISSIONS;
  }
}

// ─── Pontos e níveis ─────────────────────────────────────────────
export const GAME_POINTS = {
  procedimento: 10,
  atendimento: 5,
  avaliacao: 5,
  conversao: 20,
  missao: 50,
} as const;

export const GAME_LEVELS = [
  { nome: 'Bronze',   emoji: '🥉', min: 0 },
  { nome: 'Prata',    emoji: '🥈', min: 500 },
  { nome: 'Ouro',     emoji: '🥇', min: 1500 },
  { nome: 'Diamante', emoji: '💎', min: 3000 },
] as const;

export type GameLevel = { nome: string; emoji: string; min: number };

// ─── Pontuação POR PROFISSIONAL (out/2026) ───────────────────────
// O admin ajusta no cadastro do dentista (Configurações → Usuários): quanto vale
// cada atividade e a partir de quantos pontos ele sobe de nível. Fica em
// TenantSetting `GAME_SCORING_<userId>` (só o que difere do padrão); campo
// ausente = padrão acima. Sem mudança de schema.
export type GamePointKey = keyof typeof GAME_POINTS;
export const GAME_POINT_KEYS = Object.keys(GAME_POINTS) as GamePointKey[];

export interface GameScoring {
  pontos: Record<GamePointKey, number>;
  niveis: GameLevel[];
  /** true quando o profissional tem configuração própria. */
  personalizado: boolean;
}

/** O que fica salvo: só os overrides (pontos por atividade + mínimo de Prata/Ouro/Diamante). */
export interface GameScoringOverride {
  pontos?: Partial<Record<GamePointKey, number>>;
  niveis?: { prata?: number; ouro?: number; diamante?: number };
}

export const DEFAULT_SCORING: GameScoring = {
  pontos: { ...GAME_POINTS },
  niveis: GAME_LEVELS.map((l) => ({ ...l })),
  personalizado: false,
};

export const gameScoringKey = (userId: string) => `GAME_SCORING_${userId}`;

const MAX_POINTS = 1000;
const MAX_LEVEL = 1_000_000;

/** Aplica o override salvo sobre o padrão (ignora lixo silenciosamente). */
export function mergeScoring(ov: GameScoringOverride | null | undefined): GameScoring {
  if (!ov) return { ...DEFAULT_SCORING, pontos: { ...DEFAULT_SCORING.pontos }, niveis: DEFAULT_SCORING.niveis.map((l) => ({ ...l })) };
  const pontos = { ...GAME_POINTS } as Record<GamePointKey, number>;
  let personalizado = false;
  for (const k of GAME_POINT_KEYS) {
    const v = ov.pontos?.[k];
    if (Number.isInteger(v) && (v as number) >= 0 && (v as number) <= MAX_POINTS) { pontos[k] = v as number; personalizado = true; }
  }
  const mins = [0, GAME_LEVELS[1].min, GAME_LEVELS[2].min, GAME_LEVELS[3].min];
  const lv = [ov.niveis?.prata, ov.niveis?.ouro, ov.niveis?.diamante];
  lv.forEach((v, i) => {
    if (Number.isInteger(v) && (v as number) > 0 && (v as number) <= MAX_LEVEL) { mins[i + 1] = v as number; personalizado = true; }
  });
  // Faixas sempre crescentes (se o salvo ficou incoerente, volta pro padrão das faixas).
  const crescente = mins[1] < mins[2] && mins[2] < mins[3];
  const finalMins = crescente ? mins : [0, GAME_LEVELS[1].min, GAME_LEVELS[2].min, GAME_LEVELS[3].min];
  return {
    pontos,
    niveis: GAME_LEVELS.map((l, i) => ({ nome: l.nome, emoji: l.emoji, min: finalMins[i] })),
    personalizado,
  };
}

/**
 * Valida o que o admin mandou salvar. Campo vazio/null = usa o padrão (não salva).
 * Devolve o override limpo, ou lança Error com mensagem em português.
 */
export function parseScoringInput(body: any): GameScoringOverride {
  const out: GameScoringOverride = {};
  const num = (v: any, label: string, max: number, min: number) => {
    if (v === null || v === undefined || v === '') return undefined;
    const n = Number(v);
    if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${label}: use um número inteiro de ${min} a ${max.toLocaleString('pt-BR')}`);
    return n;
  };
  const LABEL: Record<GamePointKey, string> = {
    procedimento: 'Procedimento executado', atendimento: 'Atendimento confirmado',
    avaliacao: 'Avaliação montada', conversao: 'Avaliação que virou tratamento', missao: 'Missão cumprida',
  };
  for (const k of GAME_POINT_KEYS) {
    const v = num(body?.pontos?.[k], LABEL[k], MAX_POINTS, 0);
    if (v !== undefined) (out.pontos ??= {})[k] = v;
  }
  const prata = num(body?.niveis?.prata, 'Nível Prata', MAX_LEVEL, 1);
  const ouro = num(body?.niveis?.ouro, 'Nível Ouro', MAX_LEVEL, 1);
  const diamante = num(body?.niveis?.diamante, 'Nível Diamante', MAX_LEVEL, 1);
  if (prata !== undefined || ouro !== undefined || diamante !== undefined) {
    const p = prata ?? GAME_LEVELS[1].min;
    const o = ouro ?? GAME_LEVELS[2].min;
    const d = diamante ?? GAME_LEVELS[3].min;
    if (!(p < o && o < d)) throw new Error('Os níveis precisam subir: Prata < Ouro < Diamante');
    out.niveis = {
      ...(prata !== undefined ? { prata } : {}),
      ...(ouro !== undefined ? { ouro } : {}),
      ...(diamante !== undefined ? { diamante } : {}),
    };
  }
  return out;
}

export async function readScoringOverride(prisma: PrismaService, tenantId: string, userId: string): Promise<GameScoringOverride | null> {
  try {
    const row = await prisma.tenantSetting.findUnique({
      where: { tenant_id_key: { tenant_id: tenantId, key: gameScoringKey(userId) } },
    });
    return row?.value ? (JSON.parse(row.value) as GameScoringOverride) : null;
  } catch {
    return null;
  }
}

/** Pontuação efetiva do profissional (padrão + o que o admin ajustou pra ele). */
export async function readGameScoring(prisma: PrismaService, tenantId: string, userId: string): Promise<GameScoring> {
  return mergeScoring(await readScoringOverride(prisma, tenantId, userId));
}

const CLINICAL_TYPES = ['CONSULTA', 'PROCEDIMENTO', 'RETORNO', 'ORTODONTIA'];
const DAY = 24 * 60 * 60 * 1000;
const H3 = 3 * 60 * 60 * 1000;

export function levelFor(pontos: number, niveis: readonly GameLevel[] = GAME_LEVELS) {
  let idx = 0;
  for (let i = 0; i < niveis.length; i++) if (pontos >= niveis[i].min) idx = i;
  const nivel = niveis[idx];
  const prox = niveis[idx + 1] ?? null;
  const progresso = prox ? (pontos - nivel.min) / (prox.min - nivel.min) : 1;
  return {
    nivel: { ...nivel },
    proximo: prox ? { ...prox, faltam: prox.min - pontos } : null,
    progressoNivel: Math.max(0, Math.min(1, progresso)),
  };
}

/** "YYYY-MM" do mês de Maceió de agora. */
export function maceioMonthKey(now = Date.now()): string {
  return new Date(now - H3).toISOString().slice(0, 7);
}

export function monthBounds(month: string) {
  const [y, m] = month.split('-').map(Number);
  const naiveStart = new Date(Date.UTC(y, m - 1, 1));
  const naiveEnd = new Date(Date.UTC(y, m, 1) - 1);
  return {
    naiveStart, naiveEnd,
    realStart: new Date(naiveStart.getTime() + H3),
    realEnd: new Date(naiveEnd.getTime() + H3),
  };
}

/** Semanas (segunda a domingo, naive) cuja SEGUNDA cai dentro do mês. */
export function weeksOfMonth(month: string): { start: Date; end: Date }[] {
  const { naiveStart, naiveEnd } = monthBounds(month);
  const first = new Date(naiveStart);
  const dow = first.getUTCDay();
  const toMon = dow === 1 ? 0 : (8 - dow) % 7; // primeira segunda >= dia 1
  first.setUTCDate(first.getUTCDate() + toMon);
  const weeks: { start: Date; end: Date }[] = [];
  for (let s = first.getTime(); s <= naiveEnd.getTime(); s += 7 * DAY) {
    weeks.push({ start: new Date(s), end: new Date(s + 7 * DAY - 1) });
  }
  return weeks;
}

/** Semana atual (segunda a domingo) no naive-UTC. */
export function currentWeek(now = Date.now()) {
  const n = new Date(now - H3);
  const dow = n.getUTCDay();
  const toMon = dow === 0 ? -6 : 1 - dow;
  const start = new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate() + toMon));
  return { start, end: new Date(start.getTime() + 7 * DAY - 1) };
}

type WeekStats = { procedimentos: number; consultas: number; faltas: number };

/** Uma missão foi cumprida nesta semana? (zero_faltas só vale com semana encerrada e ≥1 consulta) */
export function missionDone(m: MissionDef, w: WeekStats, weekEnded: boolean): boolean {
  if (m.metrica === 'zero_faltas') return weekEnded && w.consultas > 0 && w.faltas === 0;
  if (m.metrica === 'procedimentos') return w.procedimentos >= (m.alvo || 1);
  return false;
}

async function weekStats(
  prisma: PrismaService, tenantId: string, userId: string, from: Date, to: Date,
): Promise<{ execNaive: Date[]; events: { start_at: Date; status: string }[] }> {
  const [items, events] = await Promise.all([
    prisma.treatmentPlanItem.findMany({
      where: {
        status: 'DONE', executed_by_user_id: userId,
        executed_at: { gte: new Date(from.getTime() + H3), lte: new Date(to.getTime() + H3) },
        treatment_plan: { patient: { tenant_id: tenantId } },
      },
      select: { executed_at: true },
    }),
    prisma.calendarEvent.findMany({
      where: {
        tenant_id: tenantId, assigned_user_id: userId,
        type: { in: CLINICAL_TYPES }, start_at: { gte: from, lte: to },
        status: { notIn: ['CANCELADO'] },
      },
      select: { start_at: true, status: true },
    }),
  ]);
  return {
    execNaive: items.filter((i) => i.executed_at).map((i) => new Date((i.executed_at as Date).getTime() - H3)),
    events,
  };
}

function statsFor(w: { start: Date; end: Date }, data: { execNaive: Date[]; events: { start_at: Date; status: string }[] }): WeekStats {
  const inW = (d: Date) => d >= w.start && d <= w.end;
  const evs = data.events.filter((e) => inW(e.start_at));
  return {
    procedimentos: data.execNaive.filter(inW).length,
    consultas: evs.length,
    faltas: evs.filter((e) => e.status === 'NO_SHOW').length,
  };
}

/** Pontos do mês (com a origem de cada um). */
export async function computeMonthPoints(
  prisma: PrismaService, tenantId: string, userId: string, month: string, missions: MissionsConfig,
  scoring: GameScoring = DEFAULT_SCORING,
  now = Date.now(),
) {
  const P = scoring.pontos;
  const b = monthBounds(month);
  const weeks = weeksOfMonth(month);
  const wFrom = weeks[0]?.start ?? b.naiveStart;
  const wTo = weeks[weeks.length - 1]?.end ?? b.naiveEnd;

  const [procedimentos, atendimentos, avaliacoes, conversoes, wk] = await Promise.all([
    prisma.treatmentPlanItem.count({
      where: {
        status: 'DONE', executed_by_user_id: userId,
        executed_at: { gte: b.realStart, lte: b.realEnd },
        treatment_plan: { patient: { tenant_id: tenantId } },
      },
    }),
    prisma.calendarEvent.count({
      where: {
        tenant_id: tenantId, assigned_user_id: userId, validated_at: { not: null },
        type: { in: CLINICAL_TYPES }, start_at: { gte: b.naiveStart, lte: b.naiveEnd },
      },
    }),
    prisma.quote.count({
      where: {
        created_by_user_id: userId, deleted_at: null, patient: { tenant_id: tenantId },
        created_at: { gte: b.realStart, lte: b.realEnd }, items: { some: {} },
      },
    }),
    prisma.quote.count({
      where: {
        created_by_user_id: userId, status: 'ACCEPTED', patient: { tenant_id: tenantId },
        accepted_at: { gte: b.realStart, lte: b.realEnd },
      },
    }),
    missions.enabled && missions.missions.length > 0 && weeks.length > 0
      ? weekStats(prisma, tenantId, userId, wFrom, wTo)
      : Promise.resolve(null),
  ]);

  let missoesCumpridas = 0;
  if (wk) {
    const naiveNow = new Date(now - H3);
    for (const w of weeks) {
      if (w.start > naiveNow) continue; // semana ainda não começou
      const st = statsFor(w, wk);
      const ended = w.end < naiveNow;
      for (const m of missions.missions) if (missionDone(m, st, ended)) missoesCumpridas += 1;
    }
  }

  const fontes = [
    { chave: 'procedimentos', emoji: '🦷', label: 'Procedimentos executados', qtd: procedimentos, cada: P.procedimento },
    { chave: 'atendimentos', emoji: '✅', label: 'Atendimentos confirmados', qtd: atendimentos, cada: P.atendimento },
    { chave: 'avaliacoes', emoji: '📋', label: 'Avaliações montadas', qtd: avaliacoes, cada: P.avaliacao },
    { chave: 'conversoes', emoji: '🤝', label: 'Avaliações que viraram tratamento', qtd: conversoes, cada: P.conversao },
    { chave: 'missoes', emoji: '🎯', label: 'Missões da semana cumpridas', qtd: missoesCumpridas, cada: P.missao },
  ].map((f) => ({ ...f, pontos: f.qtd * f.cada }));

  return { pontos: fontes.reduce((s, f) => s + f.pontos, 0), fontes };
}

const GOAL_LABEL: Record<string, string> = {
  SALES_VALUE: 'Produção do mês',
  FIRST_CONSULTATIONS: 'Primeiras consultas',
  NEW_PATIENTS: 'Pacientes novos',
  MISSES_PCT: 'Faltas na agenda (máximo)',
  OCCUPATION_PCT: 'Ocupação da agenda',
  CONVERSIONS: 'Avaliações que viraram tratamento',
};

/**
 * Visão completa do "Meu jogo" de UM profissional (sempre o usuário logado).
 * Nunca devolve R$: meta de produção (SALES_VALUE) sai só em %.
 */
export async function computeMyGame(
  prisma: PrismaService, tenantId: string, userId: string, month: string, missions: MissionsConfig,
  scoring: GameScoring = DEFAULT_SCORING,
  now = Date.now(),
) {
  const [y, m] = month.split('-').map(Number);
  const prevMonth = new Date(Date.UTC(y, m - 2, 1)).toISOString().slice(0, 7);
  const b = monthBounds(month);
  const isCurrent = month === maceioMonthKey(now);

  const [atual, anterior, goals] = await Promise.all([
    computeMonthPoints(prisma, tenantId, userId, month, missions, scoring, now),
    computeMonthPoints(prisma, tenantId, userId, prevMonth, missions, scoring, now),
    prisma.goal.findMany({
      where: {
        tenant_id: tenantId, active: true, scope: 'PROFESSIONAL', professional_user_id: userId,
        period_start: { lte: b.naiveEnd }, period_end: { gte: b.naiveStart },
      },
      select: { id: true, metric: true, direction: true, target_value: true, current_value: true, notes: true },
      orderBy: { created_at: 'asc' },
    }).catch(() => []),
  ]);

  const metas = goals.map((g) => {
    const alvo = Number(g.target_value);
    const valor = Number(g.current_value ?? 0);
    const limite = g.direction === 'LIMIT';
    const pct = alvo > 0 ? valor / alvo : 0;
    const dinheiro = g.metric === 'SALES_VALUE';
    const porcento = g.metric.endsWith('_PCT');
    return {
      id: g.id,
      label: g.metric === 'CUSTOM' ? (g.notes?.trim() || 'Meta da clínica') : (GOAL_LABEL[g.metric] ?? 'Meta da clínica'),
      limite,
      // Produção (R$) sai só em %: o profissional vê o quanto andou, não valores.
      atual: dinheiro ? null : valor,
      alvo: dinheiro ? null : alvo,
      unidade: porcento ? '%' : '',
      pct: Math.max(0, Math.min(1, limite ? (alvo > 0 ? Math.max(0, 1 - Math.max(0, valor - alvo) / alvo) : 1) : pct)),
      concluida: limite ? valor <= alvo : alvo > 0 && valor >= alvo,
    };
  });

  // Missões da SEMANA atual (só no mês corrente).
  let missoes: { titulo: string; alvo: number; progresso: number; concluida: boolean; detalhe: string; bonus: number }[] = [];
  if (isCurrent && missions.enabled) {
    const w = currentWeek(now);
    const st = statsFor(w, await weekStats(prisma, tenantId, userId, w.start, w.end));
    missoes = missions.missions.map((mi) => {
      if (mi.metrica === 'zero_faltas') {
        return {
          titulo: mi.titulo, alvo: 1, progresso: st.faltas === 0 ? 1 : 0,
          concluida: false, // só fecha quando a semana termina
          detalhe: st.faltas === 0
            ? (st.consultas > 0 ? 'Nenhuma falta até agora — vale no fim da semana' : 'Sem consultas nesta semana ainda')
            : `${st.faltas} falta(s) esta semana`,
          bonus: scoring.pontos.missao,
        };
      }
      const alvo = mi.alvo || 1;
      const prog = Math.min(st.procedimentos, alvo);
      return {
        titulo: mi.titulo, alvo, progresso: prog, concluida: st.procedimentos >= alvo,
        detalhe: `${prog} de ${alvo} concluídos`, bonus: scoring.pontos.missao,
      };
    });
  }

  const lv = levelFor(atual.pontos, scoring.niveis);
  const ouro = scoring.niveis.find((n) => n.nome === 'Ouro')?.min ?? GAME_LEVELS[2].min;
  const qtd = (k: string) => atual.fontes.find((f) => f.chave === k)?.qtd ?? 0;
  const conquistas = [
    { emoji: '🦷', label: 'Primeiro procedimento do mês', desbloqueada: qtd('procedimentos') >= 1 },
    { emoji: '🔟', label: '10 procedimentos', desbloqueada: qtd('procedimentos') >= 10 },
    { emoji: '💯', label: '50 procedimentos', desbloqueada: qtd('procedimentos') >= 50 },
    { emoji: '🤝', label: 'Avaliação que virou tratamento', desbloqueada: qtd('conversoes') >= 1 },
    { emoji: '🎯', label: 'Meta batida', desbloqueada: metas.some((x) => x.concluida) },
    { emoji: '🥇', label: 'Nível Ouro', desbloqueada: atual.pontos >= ouro },
  ];

  return {
    reference_month: month,
    pontos: atual.pontos,
    ...lv,
    fontes: atual.fontes,
    mesAnterior: { reference_month: prevMonth, pontos: anterior.pontos },
    metas,
    missoes,
    conquistas,
    // Regras DESTE profissional (pra tela explicar "como ganhar pontos").
    regras: { pontos: scoring.pontos, niveis: scoring.niveis, personalizado: scoring.personalizado },
  };
}

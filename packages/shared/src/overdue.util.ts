// Onda 18.x — Régua ÚNICA de "boleto vencido".
//
// O problema: `due_date` é uma DATA (gravada à meia-noite UTC, vinda do
// `dueDate` do Asaas no formato "2026-09-22"), mas a comparação era
// `due_date < agora`. Resultado: o boleto que vence HOJE virava "Atrasado" já
// nas primeiras horas do dia — entrava nos Negativados, somava no total em
// atraso, sumia do "Vencem 7d" e, pior, a trava de agendamento barrava um
// paciente que ainda estava dentro do prazo.
//
// Regra correta: vencido = a DATA de vencimento é ANTERIOR à data de hoje no
// fuso da clínica (America/Maceio, UTC-3 fixo, sem horário de verão). Quem
// vence hoje está em aberto o dia inteiro.
//
// Como o campo guarda data-à-meia-noite-UTC, o "corte" é a meia-noite UTC do
// dia de hoje em Maceió — NÃO a meia-noite local convertida (isso deslocaria
// 3h e voltaria a marcar o boleto de hoje como vencido). Cobranças gravadas
// com hora real (ex.: cobrança local criada 14:00Z) também funcionam: hoje
// 14:00Z > corte 00:00Z → em aberto.
//
// Usar SEMPRE estes helpers — nunca recriar a comparação solta.

/** Offset fixo de Maceió (UTC-3) em ms. */
const MACEIO_OFFSET_MS = 3 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Corte de vencimento: meia-noite UTC do dia de HOJE em Maceió.
 * `due_date < corte` = vencido; `>= corte` = em aberto (inclui quem vence hoje).
 * Em Prisma: `due_date: { lt: startOfTodayMaceioUtc() }`.
 */
export function startOfTodayMaceioUtc(now: Date = new Date()): Date {
  const maceio = new Date(now.getTime() - MACEIO_OFFSET_MS); // "relógio" de Maceió
  return new Date(Date.UTC(maceio.getUTCFullYear(), maceio.getUTCMonth(), maceio.getUTCDate()));
}

/** Corte do dia seguinte — "vence até hoje" é `due_date < endOfTodayMaceioUtc()`. */
export function endOfTodayMaceioUtc(now: Date = new Date()): Date {
  return new Date(startOfTodayMaceioUtc(now).getTime() + DAY_MS);
}

/** A cobrança está vencida? (venceu ANTES de hoje, no fuso da clínica) */
export function isOverdueDate(dueDate: Date | string, now: Date = new Date()): boolean {
  return new Date(dueDate).getTime() < startOfTodayMaceioUtc(now).getTime();
}

/**
 * Dias de atraso em DIAS DE CALENDÁRIO: vence hoje = 0, venceu ontem = 1.
 * Antes usava a diferença bruta em ms (arredondando pra baixo), o que dava 0
 * pro boleto de ontem.
 */
export function daysOverdueFrom(dueDate: Date | string, now: Date = new Date()): number {
  const cut = startOfTodayMaceioUtc(now).getTime();
  const due = new Date(dueDate).getTime();
  if (due >= cut) return 0;
  return Math.max(1, Math.round((cut - due) / DAY_MS));
}

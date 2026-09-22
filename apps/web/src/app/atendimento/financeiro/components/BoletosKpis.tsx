'use client';

/**
 * BoletosKpis — Onda 18.x. Dashboard de KPIs da aba Boletos, CONTEXTUAL por chip
* (Negativados / Vencem 7d / Pagos / Todos). Os números vêm de
 * GET /financeiro/charges/kpis (carteira INTEIRA, não só as linhas carregadas).
 *
 * Cada chip tem sua lógica:
 *  - Negativados: valor em atraso, nº de devedores, % de negativados entre os
 *    pacientes com boleto, expectativa de recebimento e os PERFIS (atrasa-mas-paga
 *    / risco / não-paga) por comportamento histórico.
 *    + idade do atraso (1-30/31-90/+90) com
 *    valor e expectativa; média e o mais antigo.
 *  - Vencem 7d: total, pacientes, expectativa (taxa histórica de pontualidade), por dia.
 *  - Pagos: mês atual × anterior (variação), últimos 30d, pontualidade, ticket, por forma.
 *  - Todos: carteira × recebido (%), em aberto, atraso, quitados/em dia/devedores.
 */

import { useMemo } from 'react';
import {
  AlertTriangle, Users, TrendingUp, TrendingDown, Clock, Check, Wallet,
  PiggyBank, Target, ShieldAlert, ShieldCheck, CalendarDays, Layers,
} from 'lucide-react';

export interface ChargesKpis {
  generated_at: string;
  base: { charges: number; cancelled: number; patients_with_charges: number; patients_debtors: number; patients_up_to_date: number; patients_settled: number };
  negativados: {
    patients: number; pct_of_patients: number; overdue_total: number; overdue_count: number; open_total_of_debtors: number;
    expected_recovery: number; expected_recovery_pct: number;
    profiles: Record<'paga_atrasado' | 'risco' | 'nao_paga', { patients: number; total: number }>;
  };
  atrasados: {
    count: number; total: number; patients: number; avg_days: number; oldest_days: number; expected_recovery: number; expected_recovery_pct: number;
    buckets: Record<'d1_30' | 'd31_60' | 'd61_90' | 'd91_180' | 'd180p', { count: number; total: number; expected: number }>;
  };
  upcoming: { count: number; total: number; patients: number; expected: number; expected_pct: number; on_time_rate_pct: number; by_day: Record<string, { count: number; total: number }> };
  pagos: {
    month_total: number; month_count: number; prev_month_total: number; prev_month_count: number; month_delta_pct: number;
    last30_total: number; last30_count: number; on_time_pct: number; avg_late_days: number; avg_ticket: number;
    all_time_total: number; all_time_count: number; by_method_month: Record<string, { count: number; total: number }>;
  };
  todos: {
    carteira_total: number; received_total: number; received_pct: number; open_total: number; overdue_total: number; cancelled_count: number;
    patients_with_charges: number; patients_settled: number; patients_up_to_date: number; patients_debtors: number; pct_settled: number; pct_debtors: number;
  };
}

type Tone = 'red' | 'amber' | 'emerald' | 'blue' | 'violet' | 'slate';

const fmtBRL = (v: number) => (Number(v) || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const fmtPct = (v: number) => `${(Number(v) || 0).toLocaleString('pt-BR', { maximumFractionDigits: 1 })}%`;

// Gradientes por tom — cartão "hero" (grande) e cartões secundários.
const TONE: Record<Tone, { hero: string; ring: string; text: string; soft: string; bar: string }> = {
  red:     { hero: 'from-rose-500 via-red-500 to-orange-500',     ring: 'ring-red-500/30',     text: 'text-red-500',     soft: 'bg-red-500/10',     bar: 'bg-red-500' },
  amber:   { hero: 'from-amber-400 via-orange-500 to-rose-500',   ring: 'ring-amber-500/30',   text: 'text-amber-500',   soft: 'bg-amber-500/10',   bar: 'bg-amber-500' },
  emerald: { hero: 'from-emerald-500 via-teal-500 to-cyan-500',   ring: 'ring-emerald-500/30', text: 'text-emerald-500', soft: 'bg-emerald-500/10', bar: 'bg-emerald-500' },
  blue:    { hero: 'from-sky-500 via-blue-500 to-indigo-500',     ring: 'ring-blue-500/30',    text: 'text-blue-500',    soft: 'bg-blue-500/10',    bar: 'bg-blue-500' },
  violet:  { hero: 'from-violet-500 via-purple-500 to-fuchsia-500', ring: 'ring-violet-500/30', text: 'text-violet-500', soft: 'bg-violet-500/10',  bar: 'bg-violet-500' },
  slate:   { hero: 'from-slate-600 via-slate-700 to-slate-800',   ring: 'ring-slate-500/30',   text: 'text-slate-500',   soft: 'bg-slate-500/10',   bar: 'bg-slate-500' },
};

/** Cartão principal: gradiente cheio, número grande. */
function Hero({ tone, icon: Icon, label, value, sub, extra }: {
  tone: Tone; icon: any; label: string; value: string; sub?: string; extra?: React.ReactNode;
}) {
  const t = TONE[tone];
  return (
    <div className={`relative overflow-hidden rounded-2xl p-4 text-white bg-gradient-to-br ${t.hero} shadow-lg`}>
      <div className="absolute -right-6 -top-6 w-28 h-28 rounded-full bg-white/10" />
      <div className="absolute right-6 -bottom-10 w-24 h-24 rounded-full bg-white/10" />
      <div className="relative flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-[10px] font-bold uppercase tracking-wider text-white/80">{label}</p>
          <p className="text-2xl md:text-[28px] leading-tight font-black tabular-nums mt-1 truncate">{value}</p>
          {sub && <p className="text-[11px] text-white/85 mt-1">{sub}</p>}
        </div>
        <div className="w-9 h-9 rounded-xl bg-white/20 grid place-items-center shrink-0"><Icon size={18} /></div>
      </div>
      {extra && <div className="relative mt-3">{extra}</div>}
    </div>
  );
}

/** Cartão secundário: fundo card, número médio, tom no ícone. */
function Stat({ tone, icon: Icon, label, value, sub, progress }: {
  tone: Tone; icon: any; label: string; value: string; sub?: string; progress?: number;
}) {
  const t = TONE[tone];
  return (
    <div className={`rounded-2xl p-3.5 bg-card border border-border ring-1 ${t.ring} shadow-sm`}>
      <div className="flex items-center gap-2">
        <div className={`w-8 h-8 rounded-lg ${t.soft} ${t.text} grid place-items-center shrink-0`}><Icon size={15} /></div>
        <p className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground truncate">{label}</p>
      </div>
      <p className={`text-xl font-black tabular-nums mt-2 ${t.text}`}>{value}</p>
      {sub && <p className="text-[11px] text-muted-foreground mt-0.5 leading-snug">{sub}</p>}
      {typeof progress === 'number' && (
        <div className="h-1.5 rounded-full bg-muted mt-2 overflow-hidden">
          <div className={`h-full ${t.bar} rounded-full transition-all`} style={{ width: `${Math.max(0, Math.min(100, progress))}%` }} />
        </div>
      )}
    </div>
  );
}

/** Barra segmentada (perfis / faixas) com legenda. */
function Segments({ title, items, fmt = fmtBRL }: { title: string; fmt?: (v: number) => string; items: Array<{ label: string; value: number; count?: number; countLabel?: string; tone: Tone; hint?: string }> }) {
  const total = items.reduce((s, i) => s + i.value, 0);
  return (
    <div className="rounded-2xl p-3.5 bg-card border border-border shadow-sm">
      <p className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground mb-2">{title}</p>
      <div className="h-2.5 rounded-full bg-muted overflow-hidden flex">
        {items.map((i) => (
          <div key={i.label} className={`${TONE[i.tone].bar} h-full`} style={{ width: total > 0 ? `${(i.value / total) * 100}%` : '0%' }} title={`${i.label}: ${fmt(i.value)}`} />
        ))}
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 mt-3">
        {items.map((i) => (
          <div key={i.label} className="min-w-0">
            <div className="flex items-center gap-1.5">
              <span className={`w-2 h-2 rounded-full ${TONE[i.tone].bar} shrink-0`} />
              <span className="text-[11px] font-bold text-foreground truncate">{i.label}</span>
            </div>
            <p className={`text-sm font-black tabular-nums ${TONE[i.tone].text}`}>{fmt(i.value)}</p>
            <p className="text-[10px] text-muted-foreground">
              {typeof i.count === 'number' && `${i.count} ${i.countLabel || ''} · `}{total > 0 ? fmtPct((i.value / total) * 100) : '0%'}
              {i.hint && <span className="block">{i.hint}</span>}
            </p>
          </div>
        ))}
      </div>
    </div>
  );
}

export default function BoletosKpis({ kpis, chip, loading }: { kpis: ChargesKpis | null; chip: string; loading?: boolean }) {
  const view = useMemo(() => {
    if (!kpis) return null;
    const { negativados: n, atrasados: a, upcoming: u, pagos: p, todos: t } = kpis;

    if (chip === 'negativados') {
      return (
        <>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <Hero tone="red" icon={AlertTriangle} label="Total em atraso" value={fmtBRL(n.overdue_total)}
              sub={`${n.overdue_count} boleto(s) vencido(s) · ${fmtBRL(n.open_total_of_debtors)} em aberto (c/ a vencer) dos devedores`} />
            <Hero tone="violet" icon={Users} label="Pacientes negativados" value={String(n.patients)}
              sub={`${fmtPct(n.pct_of_patients)} dos ${kpis.base.patients_with_charges} pacientes com boleto`}
              extra={
                <div className="h-2 rounded-full bg-white/25 overflow-hidden">
                  <div className="h-full bg-white rounded-full" style={{ width: `${Math.min(100, n.pct_of_patients)}%` }} />
                </div>
              } />
            <Hero tone="emerald" icon={Target} label="Expectativa de recebimento" value={fmtBRL(n.expected_recovery)}
              sub={`${fmtPct(n.expected_recovery_pct)} do atraso · pelo histórico de cada paciente e idade da dívida`}
              extra={
                <div className="h-2 rounded-full bg-white/25 overflow-hidden">
                  <div className="h-full bg-white rounded-full" style={{ width: `${Math.min(100, n.expected_recovery_pct)}%` }} />
                </div>
              } />
          </div>
          <Segments
            title="Perfil dos devedores — quem atrasa mas paga × quem não paga"
            items={[
              { label: 'Atrasa, mas paga', value: n.profiles.paga_atrasado.total, count: n.profiles.paga_atrasado.patients, countLabel: 'pacientes', tone: 'emerald', hint: 'já pagou ≥60% do que venceu' },
              { label: 'Em risco', value: n.profiles.risco.total, count: n.profiles.risco.patients, countLabel: 'pacientes', tone: 'amber', hint: 'histórico misto ou sem histórico' },
              { label: 'Não paga', value: n.profiles.nao_paga.total, count: n.profiles.nao_paga.patients, countLabel: 'pacientes', tone: 'red', hint: 'quase nunca pagou / +90d sem pagar' },
            ]}
          />
          {/* Idade do atraso (vinha do chip "Atrasados", removido) — quanto mais velho,
              menor a chance de receber. Atraso médio / mais antigo / provável perda. */}
          <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
            <Stat tone="amber" icon={Clock} label="Atraso médio" value={`${a.avg_days} dias`} sub={`mais antigo: ${a.oldest_days} dias`} />
            <Stat tone="slate" icon={ShieldAlert} label="Provável perda" value={fmtBRL(Math.max(0, a.total - a.expected_recovery))} sub="atraso − expectativa" />
            <Stat tone="blue" icon={Layers} label="Média por boleto vencido" value={fmtBRL(a.count ? a.total / a.count : 0)} sub={`${a.count} boleto(s)`} />
          </div>
          <Segments
            title="Idade do atraso — quanto mais velho, menor a chance de receber"
            items={[
              { label: "1–30 dias", value: a.buckets.d1_30.total, count: a.buckets.d1_30.count, countLabel: "boletos", tone: "amber", hint: `espera ${fmtBRL(a.buckets.d1_30.expected)}` },
              { label: "31–90 dias", value: a.buckets.d31_60.total + a.buckets.d61_90.total, count: a.buckets.d31_60.count + a.buckets.d61_90.count, countLabel: "boletos", tone: "red", hint: `espera ${fmtBRL(a.buckets.d31_60.expected + a.buckets.d61_90.expected)}` },
              { label: "+90 dias", value: a.buckets.d91_180.total + a.buckets.d180p.total, count: a.buckets.d91_180.count + a.buckets.d180p.count, countLabel: "boletos", tone: "slate", hint: `espera ${fmtBRL(a.buckets.d91_180.expected + a.buckets.d180p.expected)}` },
            ]}
          />
        </>
      );
    }

    if (chip === 'upcoming') {
      const days = Object.entries(u.by_day).sort(([x], [y]) => x.localeCompare(y));
      return (
        <>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <Hero tone="amber" icon={CalendarDays} label="Vencem nos próximos 7 dias" value={fmtBRL(u.total)} sub={`${u.count} boleto(s) · ${u.patients} paciente(s)`} />
            <Stat tone="emerald" icon={Target} label="Expectativa de recebimento" value={fmtBRL(u.expected)} sub={`${fmtPct(u.expected_pct)} do total`} progress={u.expected_pct} />
            <Stat tone="blue" icon={ShieldCheck} label="Pontualidade histórica" value={fmtPct(u.on_time_rate_pct)} sub="pagos no prazo, sobre todos os pagos" progress={u.on_time_rate_pct} />
            <Stat tone="slate" icon={Layers} label="Média por boleto" value={fmtBRL(u.count ? u.total / u.count : 0)} sub="ticket dos que vencem" />
          </div>
          {days.length > 0 && (
            <div className="rounded-2xl p-3.5 bg-card border border-border shadow-sm">
              <p className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground mb-2">Por dia de vencimento</p>
              <div className="flex gap-2 overflow-x-auto pb-1">
                {days.map(([d, v]) => {
                  const max = Math.max(...days.map(([, x]) => x.total)) || 1;
                  const dt = new Date(d + 'T12:00:00');
                  return (
                    <div key={d} className="min-w-[88px] flex-1 rounded-xl bg-amber-500/10 p-2 text-center">
                      <p className="text-[10px] font-bold text-amber-600 dark:text-amber-400 uppercase">{dt.toLocaleDateString('pt-BR', { weekday: 'short' }).replace('.', '')}</p>
                      <p className="text-[11px] font-bold text-foreground">{dt.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' })}</p>
                      <div className="h-1.5 rounded-full bg-amber-500/20 my-1.5 overflow-hidden"><div className="h-full bg-amber-500 rounded-full" style={{ width: `${(v.total / max) * 100}%` }} /></div>
                      <p className="text-xs font-black tabular-nums text-foreground">{fmtBRL(v.total)}</p>
                      <p className="text-[10px] text-muted-foreground">{v.count} boleto{v.count > 1 ? 's' : ''}</p>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </>
      );
    }

    if (chip === 'paid') {
      const up = p.month_delta_pct >= 0;
      const methods = Object.entries(p.by_method_month).sort(([, x], [, y]) => y.total - x.total);
      const label: Record<string, string> = { PIX: 'PIX', BOLETO: 'Boleto', CREDIT_CARD: 'Cartão', CLINICA: 'Na clínica', OUTRO: 'Outro' };
      return (
        <>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <Hero tone="emerald" icon={Wallet} label="Recebido este mês" value={fmtBRL(p.month_total)} sub={`${p.month_count} pagamento(s)`}
              extra={
                <span className={`inline-flex items-center gap-1 text-[11px] font-bold px-2 py-0.5 rounded-full ${up ? 'bg-white/25' : 'bg-black/20'}`}>
                  {up ? <TrendingUp size={12} /> : <TrendingDown size={12} />}
                  {up ? '+' : ''}{fmtPct(p.month_delta_pct)} vs mês anterior ({fmtBRL(p.prev_month_total)})
                </span>
              } />
            <Stat tone="blue" icon={PiggyBank} label="Últimos 30 dias" value={fmtBRL(p.last30_total)} sub={`${p.last30_count} pagamento(s)`} />
            <Stat tone="violet" icon={ShieldCheck} label="Pontualidade" value={fmtPct(p.on_time_pct)} sub={`atraso médio de ${p.avg_late_days} dia(s) pra pagar`} progress={p.on_time_pct} />
            <Stat tone="slate" icon={Check} label="Total já recebido" value={fmtBRL(p.all_time_total)} sub={`${p.all_time_count} boletos · ticket ${fmtBRL(p.avg_ticket)}`} />
          </div>
          {methods.length > 0 && (
            <Segments
              title="Por forma de pagamento — este mês"
              items={methods.map(([k, v], i) => ({ label: label[k] || k, value: v.total, count: v.count, countLabel: 'pagamentos', tone: (['emerald', 'blue', 'violet', 'amber', 'slate'] as Tone[])[i % 5] }))}
            />
          )}
        </>
      );
    }

    // Todos
    return (
      <>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <Hero tone="blue" icon={Layers} label="Carteira total" value={fmtBRL(t.carteira_total)} sub={`${kpis.base.charges} boletos · ${t.patients_with_charges} pacientes`} />
          <Stat tone="emerald" icon={Wallet} label="Recebido" value={fmtBRL(t.received_total)} sub={`${fmtPct(t.received_pct)} da carteira`} progress={t.received_pct} />
          <Stat tone="amber" icon={Clock} label="A vencer" value={fmtBRL(t.open_total)} sub="em aberto, dentro do prazo" />
          <Stat tone="red" icon={AlertTriangle} label="Em atraso" value={fmtBRL(t.overdue_total)} sub={`${t.cancelled_count} cancelado(s) fora da conta`} />
        </div>
        <Segments
          title="Pacientes — situação da carteira"
          fmt={(v) => `${v} paciente${v === 1 ? "" : "s"}`}
          items={[
            { label: 'Quitados', value: t.patients_settled, tone: 'emerald', hint: 'nada em aberto' },
            { label: 'Em dia', value: t.patients_up_to_date, tone: 'blue', hint: 'só boletos a vencer' },
            { label: 'Negativados', value: t.patients_debtors, tone: 'red', hint: `${fmtPct(t.pct_debtors)} dos pacientes` },
          ]}
        />
      </>
    );
  }, [kpis, chip]);

  if (loading && !kpis) {
    return (
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {[0, 1, 2, 3].map((i) => <div key={i} className="h-24 rounded-2xl bg-muted/40 animate-pulse" />)}
      </div>
    );
  }
  if (!kpis) return null;
  return (
    <div className="space-y-3">
      {view}
      <p className="text-[10px] text-muted-foreground text-right">
        Calculado sobre a carteira inteira · {new Date(kpis.generated_at).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}
      </p>
    </div>
  );
}

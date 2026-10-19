'use client';

/**
 * Relógio de ponto — peças comuns da central do funcionário (/atendimento/ponto),
 * da central do adm (/atendimento/ponto/equipe) e de Configurações › Ponto:
 * espelho do mês, detalhe da batida, exportar pra contabilidade e imprimir.
 * O CÁLCULO é todo do backend (apps/api/src/ponto/ponto-calc.ts); aqui só formata.
 */
import { useEffect, useState } from 'react';
import {
  ChevronLeft, ChevronRight, MapPin, MapPinOff, PenLine, X, Loader2, Plus,
  Download, Printer, AlertTriangle, Crosshair,
} from 'lucide-react';

/* ── tipos (espelho de apps/api/src/ponto) ───────────────── */
export type GeoStatus = 'NO_LOCAL' | 'FORA' | 'SEM_GPS' | 'IMPRECISO' | 'SEM_REF' | 'MANUAL' | 'REDE_CLINICA';
export type DayStatus =
  | 'OK' | 'HOJE' | 'INCOMPLETO' | 'FALTA' | 'FOLGA' | 'FERIADO' | 'FUTURO' | 'FORA_DO_PERIODO';

export interface DaySchedule { in: string; out: string; break_start: string | null; break_end: string | null }
export type WeekSchedule = (DaySchedule | null)[];
export interface ScheduleVersion { valid_from: string; days: WeekSchedule }

export interface Punch {
  id: string;
  at: string;
  hora: string;
  kind: 'ENTRADA' | 'SAIDA' | null;
  label: string | null;
  source: 'APP' | 'MANUAL' | string;
  geo_status: GeoStatus;
  distance_m: number | null;
  accuracy_m: number | null;
  latitude: number | null;
  longitude: number | null;
  note: string | null;
  created_by: string | null;
  voided: boolean;
  voided_at: string | null;
  void_reason: string | null;
  voided_by: string | null;
}

export interface Day {
  date: string;
  weekday: number;
  schedule: DaySchedule | null;
  pairs: { in: string; out: string | null; minutes: number }[];
  worked_min: number;
  interval_min: number;
  expected_min: number;
  balance_min: number | null;
  tolerance_applied: boolean;
  extra_min: number;
  extra_dsr_min: number;
  debit_min: number;
  absence_min: number;
  status: DayStatus;
  holiday: string | null;
  alerts: string[];
  punches: Punch[];
}

export interface Totals {
  worked_min: number;
  expected_min: number;
  balance_min: number;
  extra_min: number;
  extra_dsr_min: number;
  debit_min: number;
  absence_min: number;
  absences: number;
  days_worked: number;
  incomplete: number;
  today_worked_min: number;
}

export interface Espelho {
  ym: string;
  user_id: string;
  name: string;
  member: { start_date: string; end_date: string | null } | null;
  schedules: ScheduleVersion[];
  totals: Totals;
  punches_count: number;
  adjustments: number;
  days: Day[];
}

export interface PontoLocal { lat: number; lng: number; raio_m: number }

/* ── formatação ──────────────────────────────────────────── */
export const WEEKDAYS = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];
export const WEEKDAYS_LONG = ['Domingo', 'Segunda', 'Terça', 'Quarta', 'Quinta', 'Sexta', 'Sábado'];
const MONTHS = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];

/** 485 → "8h05" (tela) */
export const fmtMin = (min: number) => {
  const abs = Math.abs(Math.round(min));
  return `${min < 0 ? '-' : ''}${Math.floor(abs / 60)}h${String(abs % 60).padStart(2, '0')}`;
};
/** 6174 → "102:54" (contabilidade / folha) */
export const fmtHM = (min: number) => {
  const abs = Math.abs(Math.round(min));
  return `${min < 0 ? '-' : ''}${Math.floor(abs / 60)}:${String(abs % 60).padStart(2, '0')}`;
};
/** saldo com sinal: "+0h32" / "-1h10" / "0h00" */
export const fmtSaldo = (min: number) => (min > 0 ? `+${fmtMin(min)}` : fmtMin(min));
export const saldoCls = (min: number | null) =>
  min == null ? 'text-slate-400' : min > 0 ? 'text-emerald-600' : min < 0 ? 'text-rose-600' : 'text-slate-500';

export const fmtDist = (m: number | null) =>
  m == null ? '' : m >= 1000 ? `${(m / 1000).toFixed(1).replace('.', ',')} km` : `${Math.round(m)} m`;

export const monthLabel = (ym: string) => {
  const [y, m] = ym.split('-').map(Number);
  return `${MONTHS[m - 1]} de ${y}`;
};
/** Só a 1ª letra maiúscula ("Segunda-feira, 19 de outubro") — o CSS capitalize faria "De". */
export const cap1 = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);
export const shiftMonth = (ym: string, delta: number) => {
  const [y, m] = ym.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + delta, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
};
export const dayLabel = (ymd: string) => `${ymd.slice(8, 10)}/${ymd.slice(5, 7)}`;
export const dateBr = (ymd: string) => `${ymd.slice(8, 10)}/${ymd.slice(5, 7)}/${ymd.slice(0, 4)}`;

/** "08:00–12:00 · 13:00–17:00" | "Folga" */
export const scheduleText = (s: DaySchedule | null) =>
  !s ? 'Folga' : s.break_start && s.break_end ? `${s.in}–${s.break_start} · ${s.break_end}–${s.out}` : `${s.in}–${s.out}`;

export const scheduleMinutes = (s: DaySchedule | null) => {
  if (!s) return 0;
  const m = (x: string) => Number(x.slice(0, 2)) * 60 + Number(x.slice(3, 5));
  const total = m(s.out) - m(s.in);
  return s.break_start && s.break_end ? total - (m(s.break_end) - m(s.break_start)) : total;
};

export const apiErr = (e: unknown, fallback: string) => {
  const err = e as { response?: { data?: { message?: string | string[] } }; message?: string } | null;
  const msg = err?.response?.data?.message;
  return Array.isArray(msg) ? msg.join(' · ') : msg || err?.message || fallback;
};

/* ── geo ─────────────────────────────────────────────────── */
export function distanceMeters(lat1: number, lng1: number, lat2: number, lng2: number) {
  const R = 6371000;
  const rad = (x: number) => (x * Math.PI) / 180;
  const a =
    Math.sin(rad(lat2 - lat1) / 2) ** 2 +
    Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(rad(lng2 - lng1) / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

export const GEO_META: Record<string, { label: string; cls: string }> = {
  NO_LOCAL:     { label: 'No local da clínica', cls: 'text-emerald-600' },
  MANUAL:       { label: 'Lançada pelo adm', cls: 'text-violet-600' },
  // estados que hoje são recusados; aparecem só em batidas antigas (v1)
  FORA:         { label: 'Fora do local', cls: 'text-amber-600' },
  SEM_GPS:      { label: 'Sem localização', cls: 'text-amber-600' },
  IMPRECISO:    { label: 'Localização imprecisa', cls: 'text-amber-600' },
  SEM_REF:      { label: 'Sem local cadastrado', cls: 'text-amber-600' },
  REDE_CLINICA: { label: 'Pela rede da clínica', cls: 'text-amber-600' },
};

function GeoIcon({ p, className = 'w-3 h-3' }: { p: Punch; className?: string }) {
  const cls = `${className} ${GEO_META[p.geo_status]?.cls ?? 'text-slate-400'}`;
  if (p.geo_status === 'MANUAL') return <PenLine className={cls} />;
  if (p.geo_status === 'NO_LOCAL') return <MapPin className={cls} />;
  if (p.geo_status === 'IMPRECISO') return <Crosshair className={cls} />;
  return <MapPinOff className={cls} />;
}

/* ── navegação de mês ────────────────────────────────────── */
export function MonthNav({ ym, onChange, maxYm }: { ym: string; onChange: (ym: string) => void; maxYm: string }) {
  return (
    <div className="flex items-center gap-1 bg-white border border-slate-200 rounded-lg">
      <button onClick={() => onChange(shiftMonth(ym, -1))} className="p-2 text-slate-500 hover:text-slate-800" aria-label="Mês anterior">
        <ChevronLeft className="w-4 h-4" />
      </button>
      <span className="text-sm font-semibold text-slate-700 min-w-[9.5rem] text-center">{cap1(monthLabel(ym))}</span>
      <button
        onClick={() => onChange(shiftMonth(ym, 1))}
        disabled={ym >= maxYm}
        className="p-2 text-slate-500 hover:text-slate-800 disabled:opacity-30"
        aria-label="Próximo mês"
      >
        <ChevronRight className="w-4 h-4" />
      </button>
    </div>
  );
}

/* ── totais ──────────────────────────────────────────────── */
export function TotalsCards({ t }: { t: Totals }) {
  const items = [
    { label: 'Trabalhado', value: fmtMin(t.worked_min), cls: 'text-slate-800' },
    { label: 'Previsto', value: fmtMin(t.expected_min), cls: 'text-slate-800' },
    { label: 'Saldo do mês', value: fmtSaldo(t.balance_min), cls: saldoCls(t.balance_min) },
    { label: 'Horas extras', value: fmtMin(t.extra_min), cls: t.extra_min ? 'text-emerald-600' : 'text-slate-800' },
    { label: 'Extras dom./feriado', value: fmtMin(t.extra_dsr_min), cls: t.extra_dsr_min ? 'text-emerald-600' : 'text-slate-800' },
    { label: 'Atrasos e saídas antes', value: fmtMin(t.debit_min), cls: t.debit_min ? 'text-rose-600' : 'text-slate-800' },
    { label: 'Faltas', value: `${t.absences} dia(s) · ${fmtMin(t.absence_min)}`, cls: t.absences ? 'text-rose-600' : 'text-slate-800' },
    { label: 'Sem batida de saída', value: String(t.incomplete), cls: t.incomplete ? 'text-amber-600' : 'text-slate-800' },
  ];
  return (
    <div>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5">
        {items.map((i) => (
          <div key={i.label} className="bg-white border border-slate-200 rounded-xl px-3.5 py-3">
            <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">{i.label}</div>
            <div className={`text-lg font-bold tabular-nums mt-0.5 ${i.cls}`}>{i.value}</div>
          </div>
        ))}
      </div>
      <p className="text-xs text-slate-400 mt-2">
        Totais dos dias fechados (até ontem). Saldo = extras + extras dom./feriado − atrasos − faltas. Tolerância da CLT:
        até 5 min por batida e 10 min no dia não contam (art. 58 §1º).
      </p>
    </div>
  );
}

/* ── espelho do mês ──────────────────────────────────────── */
const STATUS_TXT: Partial<Record<DayStatus, { label: string; cls: string }>> = {
  HOJE:            { label: 'Em andamento', cls: 'text-sky-600' },
  INCOMPLETO:      { label: 'Incompleto', cls: 'text-amber-600' },
  FALTA:           { label: 'Falta', cls: 'text-rose-600' },
  FOLGA:           { label: 'Folga', cls: 'text-slate-400' },
  FERIADO:         { label: 'Feriado', cls: 'text-violet-600' },
  FORA_DO_PERIODO: { label: 'Fora do período no ponto', cls: 'text-slate-400' },
};

/** Dias que aparecem no espelho: tira futuro e dias fora do período sem batida. */
export const visibleDays = (e: Espelho) =>
  e.days.filter((d) => d.status !== 'FUTURO' && !(d.status === 'FORA_DO_PERIODO' && d.punches.length === 0));

export function EspelhoTable({
  data,
  onPunchClick,
  onAdd,
}: {
  data: Espelho;
  onPunchClick: (p: Punch, date: string) => void;
  /** Adm: lançar batida no dia. */
  onAdd?: (date: string) => void;
}) {
  const rows = visibleDays(data);
  return (
    <div className="bg-white border border-slate-200 rounded-xl overflow-x-auto">
      <table className="w-full text-sm min-w-[760px]">
        <thead>
          <tr className="text-left text-[11px] uppercase tracking-wide text-slate-400 border-b border-slate-100">
            <th className="px-3 py-2.5 font-semibold">Dia</th>
            <th className="px-3 py-2.5 font-semibold">Horário</th>
            <th className="px-3 py-2.5 font-semibold">Batidas</th>
            <th className="px-3 py-2.5 font-semibold text-right">Trabalhado</th>
            <th className="px-3 py-2.5 font-semibold text-right">Previsto</th>
            <th className="px-3 py-2.5 font-semibold text-right">Saldo</th>
            <th className="px-3 py-2.5 font-semibold">Observação</th>
            {onAdd && <th className="px-2 py-2.5" />}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 && (
            <tr><td colSpan={onAdd ? 8 : 7} className="px-3 py-8 text-center text-slate-400">Nenhum dia do ponto neste mês.</td></tr>
          )}
          {rows.map((d) => {
            const weekend = d.weekday === 0 || d.weekday === 6;
            const st = STATUS_TXT[d.status];
            const off = d.status === 'FORA_DO_PERIODO';
            return (
              <tr key={d.date} className={`border-b border-slate-50 align-top ${weekend || d.holiday ? 'bg-slate-50/60' : ''} ${d.status === 'HOJE' ? 'bg-sky-50/50' : ''}`}>
                <td className="px-3 py-2 whitespace-nowrap text-slate-700">
                  <span className="font-semibold tabular-nums">{dayLabel(d.date)}</span>{' '}
                  <span className="text-xs text-slate-400">{WEEKDAYS[d.weekday]}</span>
                </td>
                <td className="px-3 py-2 text-xs text-slate-500 whitespace-nowrap tabular-nums">{off ? '—' : d.holiday ? 'Feriado' : scheduleText(d.schedule)}</td>
                <td className="px-3 py-2">
                  <div className="flex flex-wrap gap-1">
                    {d.punches.map((p) => (
                      <button
                        key={p.id}
                        onClick={() => onPunchClick(p, d.date)}
                        title={p.voided ? `Anulada: ${p.void_reason ?? ''}` : `${p.label ?? ''} · ${GEO_META[p.geo_status]?.label ?? ''}`}
                        className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md border text-xs font-semibold tabular-nums transition hover:shadow-sm ${
                          p.voided
                            ? 'border-slate-200 text-slate-300 line-through'
                            : p.kind === 'ENTRADA'
                              ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
                              : 'border-slate-200 bg-slate-50 text-slate-700'
                        }`}
                      >
                        {p.hora}
                        {!p.voided && <GeoIcon p={p} />}
                      </button>
                    ))}
                  </div>
                </td>
                <td className="px-3 py-2 text-right tabular-nums text-slate-700">{d.punches.length || d.worked_min ? fmtMin(d.worked_min) : <span className="text-slate-300">—</span>}</td>
                <td className="px-3 py-2 text-right tabular-nums text-slate-500">{off ? <span className="text-slate-300">—</span> : fmtMin(d.expected_min)}</td>
                <td className={`px-3 py-2 text-right tabular-nums font-semibold ${saldoCls(d.balance_min)}`}>
                  {d.balance_min == null ? '—' : fmtSaldo(d.balance_min)}
                </td>
                <td className="px-3 py-2 text-xs">
                  {st && <span className={`font-semibold ${st.cls}`}>{st.label}{d.holiday ? `: ${d.holiday}` : ''}</span>}
                  {!st && d.holiday && <span className="font-semibold text-violet-600">{d.holiday}</span>}
                  {d.tolerance_applied && d.worked_min !== d.expected_min && (
                    <div className="text-slate-400">
                      Dentro da tolerância: {fmtMin(Math.abs(d.worked_min - d.expected_min))} {d.worked_min < d.expected_min ? 'a menos' : 'a mais'}, não conta
                    </div>
                  )}
                  {d.alerts.map((a) => (
                    <div key={a} className="flex items-start gap-1 text-amber-700"><AlertTriangle className="w-3 h-3 mt-0.5 shrink-0" />{a}</div>
                  ))}
                </td>
                {onAdd && (
                  <td className="px-2 py-2">
                    <button onClick={() => onAdd(d.date)} className="p-1 rounded-md text-slate-400 hover:text-sky-600 hover:bg-sky-50" title="Lançar batida neste dia">
                      <Plus className="w-4 h-4" />
                    </button>
                  </td>
                )}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/* ── modal base ──────────────────────────────────────────── */
export function Modal({ title, onClose, children, wide }: { title: string; onClose: () => void; children: React.ReactNode; wide?: boolean }) {
  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-50 bg-black/40 grid place-items-center p-4 overflow-y-auto" onClick={onClose}>
      <div className={`bg-white rounded-2xl shadow-xl w-full ${wide ? 'max-w-3xl' : 'max-w-md'} p-5 my-auto`} onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-3">
          <h3 className="font-bold text-slate-800">{title}</h3>
          <button onClick={onClose} className="p-1 text-slate-400 hover:text-slate-700" aria-label="Fechar"><X className="w-5 h-5" /></button>
        </div>
        {children}
      </div>
    </div>
  );
}

/* ── detalhe da batida (+ anular, pro adm) ───────────────── */
function DetailRow({ k, v }: { k: string; v: React.ReactNode }) {
  return (
    <div className="flex justify-between gap-3 py-1.5 border-b border-slate-50 text-sm">
      <span className="text-slate-500">{k}</span>
      <span className="text-slate-800 text-right">{v}</span>
    </div>
  );
}

export function PunchDetail({
  p,
  date,
  onClose,
  onVoid,
}: {
  p: Punch;
  date: string;
  onClose: () => void;
  onVoid?: (reason: string) => Promise<void>;
}) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const hasMap = p.latitude != null && p.longitude != null;
  return (
    <Modal title={`Batida de ${dayLabel(date)} às ${p.hora}`} onClose={onClose}>
      <DetailRow k="Tipo" v={p.voided ? 'Anulada' : p.label ?? (p.kind === 'ENTRADA' ? 'Entrada' : 'Saída')} />
      <DetailRow k="Origem" v={p.source === 'MANUAL' ? `Lançada por ${p.created_by ?? 'adm'}` : 'Registrada pelo funcionário'} />
      {p.note && <DetailRow k="Motivo" v={p.note} />}
      <DetailRow k="Local" v={<span className={GEO_META[p.geo_status]?.cls}>{GEO_META[p.geo_status]?.label ?? p.geo_status}</span>} />
      {p.distance_m != null && <DetailRow k="Distância da clínica" v={fmtDist(p.distance_m)} />}
      {p.accuracy_m != null && <DetailRow k="Precisão do GPS" v={`± ${fmtDist(p.accuracy_m)}`} />}
      {hasMap && (
        <DetailRow
          k="Mapa"
          v={<a className="text-sky-600 hover:underline" target="_blank" rel="noreferrer" href={`https://www.google.com/maps?q=${p.latitude},${p.longitude}`}>Ver no mapa</a>}
        />
      )}
      {p.voided && <DetailRow k="Anulada por" v={`${p.voided_by ?? '—'} · ${p.void_reason ?? ''}`} />}

      {onVoid && !p.voided && (
        <div className="mt-4">
          <label className="text-xs font-semibold text-slate-500">Anular esta batida (fica no histórico)</label>
          <textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            rows={2}
            placeholder="Motivo (ex.: bateu duas vezes sem querer)"
            className="mt-1 w-full border border-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-rose-200"
          />
          <button
            disabled={busy || reason.trim().length < 3}
            onClick={async () => { setBusy(true); try { await onVoid(reason.trim()); } finally { setBusy(false); } }}
            className="mt-2 w-full py-2 rounded-lg bg-rose-600 text-white text-sm font-semibold hover:bg-rose-700 disabled:opacity-40 flex items-center justify-center gap-2"
          >
            {busy && <Loader2 className="w-4 h-4 animate-spin" />} Anular batida
          </button>
        </div>
      )}
    </Modal>
  );
}

/* ── lançar batida (adm) ─────────────────────────────────── */
export function AddPunchModal({
  date,
  name,
  onClose,
  onSave,
}: {
  date: string;
  name: string;
  onClose: () => void;
  onSave: (time: string, note: string) => Promise<void>;
}) {
  const [time, setTime] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const ok = /^([01]\d|2[0-3]):[0-5]\d$/.test(time) && note.trim().length >= 3;
  return (
    <Modal title={`Lançar batida · ${name} · ${dayLabel(date)}`} onClose={onClose}>
      <label className="text-xs font-semibold text-slate-500">Hora</label>
      <input type="time" value={time} onChange={(e) => setTime(e.target.value)} className="mt-1 w-full border border-slate-200 rounded-lg px-3 py-2 text-sm tabular-nums" />
      <label className="text-xs font-semibold text-slate-500 mt-3 block">Motivo</label>
      <textarea
        value={note}
        onChange={(e) => setNote(e.target.value)}
        rows={2}
        placeholder="Ex.: esqueceu de bater a saída"
        className="mt-1 w-full border border-slate-200 rounded-lg px-3 py-2 text-sm"
      />
      <p className="text-xs text-slate-400 mt-1">A batida fica marcada como lançada por você, com o motivo.</p>
      <button
        disabled={!ok || busy}
        onClick={async () => { setBusy(true); try { await onSave(time, note.trim()); } finally { setBusy(false); } }}
        className="mt-3 w-full py-2 rounded-lg bg-sky-600 text-white text-sm font-semibold hover:bg-sky-700 disabled:opacity-40 flex items-center justify-center gap-2"
      >
        {busy && <Loader2 className="w-4 h-4 animate-spin" />} Lançar batida
      </button>
    </Modal>
  );
}

/* ── exportar / imprimir (contabilidade) ─────────────────── */
const situacao = (d: Day) => [STATUS_TXT[d.status]?.label, d.holiday].filter(Boolean).join(': ');
const batidasTxt = (d: Day) =>
  d.punches.filter((p) => !p.voided).map((p) => `${p.hora}${p.source === 'MANUAL' ? '*' : ''}`).join(' ');

function downloadCsv(lines: (string | number)[][], filename: string) {
  const csv = lines.map((l) => l.map((c) => `"${String(c ?? '').replace(/"/g, '""')}"`).join(';')).join('\r\n');
  const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
const slug = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-zA-Z0-9]+/g, '-').toLowerCase();

const DETAIL_HEAD = ['Funcionário', 'Data', 'Dia', 'Horário previsto', 'Batidas', 'Trabalhado', 'Previsto', 'Extra', 'Extra dom./feriado', 'Atraso/saída antes', 'Falta', 'Saldo', 'Situação', 'Alertas'];
function detailLines(e: Espelho): (string | number)[][] {
  return visibleDays(e).map((d) => [
    e.name,
    dateBr(d.date),
    WEEKDAYS[d.weekday],
    d.status === 'FORA_DO_PERIODO' ? '' : d.holiday ? 'Feriado' : scheduleText(d.schedule),
    batidasTxt(d),
    fmtHM(d.worked_min),
    d.status === 'FORA_DO_PERIODO' ? '' : fmtHM(d.expected_min),
    d.extra_min ? fmtHM(d.extra_min) : '',
    d.extra_dsr_min ? fmtHM(d.extra_dsr_min) : '',
    d.debit_min ? fmtHM(d.debit_min) : '',
    d.absence_min ? fmtHM(d.absence_min) : '',
    d.balance_min == null ? '' : fmtHM(d.balance_min),
    situacao(d),
    d.alerts.join(' | '),
  ]);
}

/** Espelho de UM funcionário (dia a dia). */
export function exportEspelhoCsv(e: Espelho) {
  const t = e.totals;
  downloadCsv(
    [
      DETAIL_HEAD,
      ...detailLines(e),
      [],
      ['TOTAL (dias fechados)', '', '', '', '', fmtHM(t.worked_min), fmtHM(t.expected_min), fmtHM(t.extra_min), fmtHM(t.extra_dsr_min), fmtHM(t.debit_min), fmtHM(t.absence_min), fmtHM(t.balance_min), `Faltas: ${t.absences} dia(s)`, ''],
      ['* batida lançada pelo adm. Horas em HH:MM.'],
    ],
    `ponto-${slug(e.name)}-${e.ym}.csv`,
  );
}

/** Contabilidade: RESUMO (uma linha por funcionário). */
export function exportResumoCsv(people: Espelho[], ym: string, clinic: string) {
  const head = ['Funcionário', 'No ponto desde', 'Último dia', 'Dias trabalhados', 'Horas trabalhadas', 'Horas previstas', 'Horas extras', 'Extras dom./feriado', 'Atrasos/saídas antes', 'Faltas (dias)', 'Faltas (horas)', 'Saldo', 'Dias sem batida de saída', 'Ajustes do adm'];
  const rows = people.map((e) => {
    const t = e.totals;
    return [
      e.name,
      e.member ? dateBr(e.member.start_date) : 'fora da equipe',
      e.member?.end_date ? dateBr(e.member.end_date) : '',
      t.days_worked,
      fmtHM(t.worked_min),
      fmtHM(t.expected_min),
      fmtHM(t.extra_min),
      fmtHM(t.extra_dsr_min),
      fmtHM(t.debit_min),
      t.absences,
      fmtHM(t.absence_min),
      fmtHM(t.balance_min),
      t.incomplete,
      e.adjustments,
    ];
  });
  downloadCsv(
    [[`${clinic} — ponto de ${monthLabel(ym)}`], [], head, ...rows, [], ['Horas em HH:MM. Totais dos dias fechados. Tolerância CLT art. 58 §1º aplicada (5 min por batida, 10 min no dia).']],
    `ponto-resumo-${ym}.csv`,
  );
}

/** Contabilidade: DETALHADO (todos os funcionários, dia a dia). */
export function exportDetalhadoCsv(people: Espelho[], ym: string) {
  downloadCsv([DETAIL_HEAD, ...people.flatMap((e) => [...detailLines(e), []])], `ponto-detalhado-${ym}.csv`);
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

function espelhoHtml(e: Espelho, clinic: string) {
  const rows = visibleDays(e)
    .map(
      (d) => `<tr>
        <td>${dayLabel(d.date)} ${WEEKDAYS[d.weekday]}</td>
        <td>${esc(d.status === 'FORA_DO_PERIODO' ? '' : d.holiday ? 'Feriado' : scheduleText(d.schedule))}</td>
        <td>${esc(batidasTxt(d))}</td>
        <td class="n">${d.punches.length || d.worked_min ? fmtHM(d.worked_min) : ''}</td>
        <td class="n">${d.status === 'FORA_DO_PERIODO' ? '' : fmtHM(d.expected_min)}</td>
        <td class="n">${d.balance_min == null ? '' : fmtHM(d.balance_min)}</td>
        <td>${esc([situacao(d), ...d.alerts].filter(Boolean).join(' · '))}</td>
      </tr>`,
    )
    .join('');
  const t = e.totals;
  return `<section>
<h1>Espelho de ponto — ${esc(monthLabel(e.ym))}</h1>
<div class="sub">${esc(clinic)} · Funcionário(a): <b>${esc(e.name)}</b>${e.member ? ` · no ponto desde ${dateBr(e.member.start_date)}` : ''}</div>
<table><thead><tr><th>Dia</th><th>Horário</th><th>Batidas</th><th>Trabalhado</th><th>Previsto</th><th>Saldo</th><th>Observação</th></tr></thead><tbody>${rows}</tbody></table>
<table class="tot"><tr>
  <td>Trabalhado <b>${fmtHM(t.worked_min)}</b></td><td>Previsto <b>${fmtHM(t.expected_min)}</b></td>
  <td>Extras <b>${fmtHM(t.extra_min)}</b></td><td>Extras dom./feriado <b>${fmtHM(t.extra_dsr_min)}</b></td>
  <td>Atrasos <b>${fmtHM(t.debit_min)}</b></td><td>Faltas <b>${t.absences} (${fmtHM(t.absence_min)})</b></td>
  <td>Saldo <b>${fmtHM(t.balance_min)}</b></td></tr></table>
<div class="nota">Horas em HH:MM, dias fechados. * batida lançada pelo adm. Tolerância CLT art. 58 §1º (5 min por batida, 10 min no dia).</div>
<div class="sig"><div>${esc(e.name)}</div><div>Responsável — ${esc(clinic)}</div></div>
</section>`;
}

/** Imprime um ou vários espelhos (um por página) pra assinatura. */
export function printEspelhos(list: Espelho[], clinic: string) {
  if (!list.length) return false;
  const html = `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>Espelho de ponto — ${esc(list.length === 1 ? list[0].name : clinic)} — ${list[0].ym}</title>
<style>
  body{font-family:Arial,Helvetica,sans-serif;color:#111;margin:20px;font-size:11px}
  section{page-break-after:always} section:last-child{page-break-after:auto}
  h1{font-size:15px;margin:0 0 2px} .sub{color:#555;margin-bottom:10px}
  table{width:100%;border-collapse:collapse} th,td{border:1px solid #ccc;padding:3px 5px;text-align:left}
  th{background:#f3f4f6;font-size:10px;text-transform:uppercase} td.n{text-align:right;white-space:nowrap}
  table.tot{margin-top:8px} table.tot td{border:1px solid #ccc;font-size:11px}
  .sig{display:flex;gap:40px;margin-top:48px} .sig div{flex:1;border-top:1px solid #111;padding-top:4px;text-align:center}
  .nota{color:#666;font-size:9px;margin-top:6px}
</style></head><body>${list.map((e) => espelhoHtml(e, clinic)).join('')}
<script>window.onload=function(){window.print()}</script>
</body></html>`;
  const w = window.open('', '_blank');
  if (!w) return false;
  w.document.open();
  w.document.write(html);
  w.document.close();
  return true;
}

export function EspelhoActions({ data, clinic }: { data: Espelho; clinic: string }) {
  return (
    <div className="flex items-center gap-2">
      <button onClick={() => exportEspelhoCsv(data)} className="flex items-center gap-1.5 px-3 py-2 rounded-lg border border-slate-200 bg-white text-sm text-slate-600 hover:text-slate-900">
        <Download className="w-4 h-4" /> Planilha
      </button>
      <button onClick={() => printEspelhos([data], clinic)} className="flex items-center gap-1.5 px-3 py-2 rounded-lg border border-slate-200 bg-white text-sm text-slate-600 hover:text-slate-900">
        <Printer className="w-4 h-4" /> Imprimir
      </button>
    </div>
  );
}

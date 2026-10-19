'use client';

/**
 * Relógio de ponto — peças comuns da tela do funcionário (/atendimento/ponto) e da
 * gestão (/atendimento/ponto/equipe): espelho do mês, detalhe da batida, exportar
 * CSV e imprimir pra assinatura. O CÁLCULO é todo do backend (ponto-calc.ts); aqui
 * só formata.
 */
import { useEffect, useState } from 'react';
import {
  ChevronLeft, ChevronRight, MapPin, MapPinOff, PenLine, Wifi, X, Loader2, Plus,
  Download, Printer, AlertTriangle,
} from 'lucide-react';

/* ── tipos (espelho de apps/api/src/ponto) ───────────────── */
export type GeoStatus = 'NO_LOCAL' | 'FORA' | 'SEM_GPS' | 'SEM_REF' | 'REDE_CLINICA' | 'MANUAL';
export type DayStatus = 'OK' | 'HOJE' | 'INCOMPLETO' | 'FALTA' | 'FOLGA' | 'FERIADO' | 'FUTURO' | 'SEM_REGISTRO';

export interface Punch {
  id: string;
  at: string;
  hora: string;
  kind: 'ENTRADA' | 'SAIDA' | null;
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
  pairs: { in: string; out: string | null; minutes: number }[];
  worked_min: number;
  interval_min: number;
  expected_min: number;
  balance_min: number | null;
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
  debit_min: number;
  days_worked: number;
  absences: number;
  incomplete: number;
  today_worked_min: number;
}

export interface Espelho {
  ym: string;
  user_id: string;
  jornada: number[];
  jornada_propria: boolean;
  totals: Totals;
  days: Day[];
}

export interface PontoLocal { lat: number; lng: number; raio_m: number }

/* ── formatação ──────────────────────────────────────────── */
export const WEEKDAYS = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];
const MONTHS = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];

/** 485 → "8h05" */
export const fmtMin = (min: number) => {
  const abs = Math.abs(Math.round(min));
  return `${min < 0 ? '-' : ''}${Math.floor(abs / 60)}h${String(abs % 60).padStart(2, '0')}`;
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

/** "8:00" / "8h" / "8" → 480; vazio → 0; inválido → null */
export const parseHoras = (s: string): number | null => {
  const t = String(s ?? '').trim().toLowerCase().replace('h', ':');
  if (!t) return 0;
  const m = t.match(/^(\d{1,2})(?::(\d{0,2}))?$/);
  if (!m) return null;
  const h = Number(m[1]);
  const mi = Number(m[2] || 0);
  if (mi > 59 || h * 60 + mi > 1440) return null;
  return h * 60 + mi;
};
export const horasInput = (min: number) => `${Math.floor(min / 60)}:${String(min % 60).padStart(2, '0')}`;

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

export const GEO_META: Record<GeoStatus, { label: string; cls: string }> = {
  NO_LOCAL:     { label: 'No local da clínica', cls: 'text-emerald-600' },
  REDE_CLINICA: { label: 'Pela rede da clínica', cls: 'text-emerald-600' },
  FORA:         { label: 'Fora do local', cls: 'text-amber-600' },
  SEM_GPS:      { label: 'Sem localização', cls: 'text-slate-400' },
  SEM_REF:      { label: 'Com localização (clínica sem local cadastrado)', cls: 'text-sky-600' },
  MANUAL:       { label: 'Lançada pelo gestor', cls: 'text-violet-600' },
};

function GeoIcon({ p, className = 'w-3 h-3' }: { p: Punch; className?: string }) {
  const cls = `${className} ${GEO_META[p.geo_status]?.cls ?? 'text-slate-400'}`;
  if (p.geo_status === 'MANUAL') return <PenLine className={cls} />;
  if (p.geo_status === 'REDE_CLINICA') return <Wifi className={cls} />;
  if (p.geo_status === 'SEM_GPS') return <MapPinOff className={cls} />;
  return <MapPin className={cls} />;
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
    { label: 'Saldo (banco de horas)', value: fmtSaldo(t.balance_min), cls: saldoCls(t.balance_min) },
    { label: 'Faltas', value: String(t.absences), cls: t.absences ? 'text-rose-600' : 'text-slate-800' },
    { label: 'Sem batida de saída', value: String(t.incomplete), cls: t.incomplete ? 'text-amber-600' : 'text-slate-800' },
  ];
  return (
    <div>
      <div className="grid grid-cols-2 sm:grid-cols-5 gap-2.5">
        {items.map((i) => (
          <div key={i.label} className="bg-white border border-slate-200 rounded-xl px-3.5 py-3">
            <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">{i.label}</div>
            <div className={`text-lg font-bold tabular-nums mt-0.5 ${i.cls}`}>{i.value}</div>
          </div>
        ))}
      </div>
      <p className="text-xs text-slate-400 mt-2">
        Totais dos dias fechados (até ontem). Extras {fmtMin(t.extra_min)} · a compensar {fmtMin(t.debit_min)}.
        Diferença de até 10 min no dia não conta (CLT, art. 58).
      </p>
    </div>
  );
}

/* ── espelho do mês ──────────────────────────────────────── */
const STATUS_TXT: Partial<Record<DayStatus, { label: string; cls: string }>> = {
  HOJE:       { label: 'Em andamento', cls: 'text-sky-600' },
  INCOMPLETO: { label: 'Incompleto', cls: 'text-amber-600' },
  FALTA:      { label: 'Falta', cls: 'text-rose-600' },
  FOLGA:      { label: 'Folga', cls: 'text-slate-400' },
  FERIADO:    { label: 'Feriado', cls: 'text-violet-600' },
};

export function EspelhoTable({
  data,
  onPunchClick,
  onAdd,
}: {
  data: Espelho;
  onPunchClick: (p: Punch, date: string) => void;
  /** Gestor: lançar batida no dia. */
  onAdd?: (date: string) => void;
}) {
  const rows = data.days.filter((d) => d.status !== 'FUTURO');
  return (
    <div className="bg-white border border-slate-200 rounded-xl overflow-x-auto">
      <table className="w-full text-sm min-w-[640px]">
        <thead>
          <tr className="text-left text-[11px] uppercase tracking-wide text-slate-400 border-b border-slate-100">
            <th className="px-3 py-2.5 font-semibold">Dia</th>
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
            <tr><td colSpan={onAdd ? 7 : 6} className="px-3 py-8 text-center text-slate-400">Nenhum dia neste mês ainda.</td></tr>
          )}
          {rows.map((d) => {
            const weekend = d.weekday === 0 || d.weekday === 6;
            const st = STATUS_TXT[d.status];
            const dim = d.status === 'SEM_REGISTRO';
            return (
              <tr key={d.date} className={`border-b border-slate-50 align-top ${weekend || d.holiday ? 'bg-slate-50/60' : ''} ${d.status === 'HOJE' ? 'bg-sky-50/50' : ''}`}>
                <td className={`px-3 py-2 whitespace-nowrap ${dim ? 'text-slate-300' : 'text-slate-700'}`}>
                  <span className="font-semibold tabular-nums">{dayLabel(d.date)}</span>{' '}
                  <span className="text-xs text-slate-400">{WEEKDAYS[d.weekday]}</span>
                </td>
                <td className="px-3 py-2">
                  <div className="flex flex-wrap gap-1">
                    {d.punches.map((p) => (
                      <button
                        key={p.id}
                        onClick={() => onPunchClick(p, d.date)}
                        title={p.voided ? `Anulada: ${p.void_reason ?? ''}` : `${p.kind === 'ENTRADA' ? 'Entrada' : 'Saída'} · ${GEO_META[p.geo_status]?.label ?? ''}`}
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
                <td className="px-3 py-2 text-right tabular-nums text-slate-500">{dim ? <span className="text-slate-300">—</span> : fmtMin(d.expected_min)}</td>
                <td className={`px-3 py-2 text-right tabular-nums font-semibold ${saldoCls(d.balance_min)}`}>
                  {d.balance_min == null ? '—' : fmtSaldo(d.balance_min)}
                </td>
                <td className="px-3 py-2 text-xs">
                  {st && <span className={`font-semibold ${st.cls}`}>{st.label}{d.holiday ? `: ${d.holiday}` : ''}</span>}
                  {!st && d.holiday && <span className="font-semibold text-violet-600">{d.holiday}</span>}
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
export function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-50 bg-black/40 grid place-items-center p-4" onClick={onClose}>
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-md p-5" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-3">
          <h3 className="font-bold text-slate-800">{title}</h3>
          <button onClick={onClose} className="p-1 text-slate-400 hover:text-slate-700" aria-label="Fechar"><X className="w-5 h-5" /></button>
        </div>
        {children}
      </div>
    </div>
  );
}

/* ── detalhe da batida (+ anular, pro gestor) ────────────── */
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
  const Row = ({ k, v }: { k: string; v: React.ReactNode }) => (
    <div className="flex justify-between gap-3 py-1.5 border-b border-slate-50 text-sm">
      <span className="text-slate-500">{k}</span>
      <span className="text-slate-800 text-right">{v}</span>
    </div>
  );
  return (
    <Modal title={`Batida de ${dayLabel(date)} às ${p.hora}`} onClose={onClose}>
      <Row k="Tipo" v={p.voided ? 'Anulada' : p.kind === 'ENTRADA' ? 'Entrada' : 'Saída'} />
      <Row k="Origem" v={p.source === 'MANUAL' ? `Lançada por ${p.created_by ?? 'gestor'}` : 'Registrada pelo funcionário'} />
      {p.note && <Row k="Motivo" v={p.note} />}
      <Row k="Local" v={<span className={GEO_META[p.geo_status]?.cls}>{GEO_META[p.geo_status]?.label}</span>} />
      {p.distance_m != null && <Row k="Distância da clínica" v={fmtDist(p.distance_m)} />}
      {p.accuracy_m != null && <Row k="Precisão do GPS" v={`± ${fmtDist(p.accuracy_m)}`} />}
      {hasMap && (
        <Row
          k="Mapa"
          v={<a className="text-sky-600 hover:underline" target="_blank" rel="noreferrer" href={`https://www.google.com/maps?q=${p.latitude},${p.longitude}`}>Ver no mapa</a>}
        />
      )}
      {p.voided && <Row k="Anulada por" v={`${p.voided_by ?? '—'} · ${p.void_reason ?? ''}`} />}

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

/* ── lançar batida (gestor) ──────────────────────────────── */
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

/* ── exportar / imprimir ─────────────────────────────────── */
const situacao = (d: Day) =>
  [STATUS_TXT[d.status]?.label, d.holiday].filter(Boolean).join(': ');

const batidasTxt = (d: Day) =>
  d.punches.filter((p) => !p.voided).map((p) => `${p.hora}${p.source === 'MANUAL' ? '*' : ''}`).join(' ');

export function exportCsv(data: Espelho, name: string) {
  const lines = [['Data', 'Dia', 'Batidas', 'Trabalhado', 'Previsto', 'Saldo', 'Situação', 'Alertas']];
  for (const d of data.days.filter((x) => x.status !== 'FUTURO')) {
    lines.push([
      `${dayLabel(d.date)}/${d.date.slice(0, 4)}`,
      WEEKDAYS[d.weekday],
      batidasTxt(d),
      fmtMin(d.worked_min),
      d.status === 'SEM_REGISTRO' ? '' : fmtMin(d.expected_min),
      d.balance_min == null ? '' : fmtSaldo(d.balance_min),
      situacao(d),
      d.alerts.join(' | '),
    ]);
  }
  const t = data.totals;
  lines.push([], ['Totais (dias fechados)', '', '', fmtMin(t.worked_min), fmtMin(t.expected_min), fmtSaldo(t.balance_min), `Faltas: ${t.absences}`, '']);
  lines.push(['* batida lançada pelo gestor']);
  const csv = lines.map((l) => l.map((c) => `"${String(c ?? '').replace(/"/g, '""')}"`).join(';')).join('\r\n');
  const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `ponto-${name.replace(/[^\p{L}\p{N}]+/gu, '-').toLowerCase()}-${data.ym}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

/** Espelho de ponto pra imprimir e assinar (abre numa janela própria). */
export function printEspelho(data: Espelho, name: string, clinic: string) {
  const rows = data.days
    .filter((d) => d.status !== 'FUTURO')
    .map(
      (d) => `<tr>
        <td>${dayLabel(d.date)} ${WEEKDAYS[d.weekday]}</td>
        <td>${esc(batidasTxt(d))}</td>
        <td class="n">${d.punches.length || d.worked_min ? fmtMin(d.worked_min) : ''}</td>
        <td class="n">${d.status === 'SEM_REGISTRO' ? '' : fmtMin(d.expected_min)}</td>
        <td class="n">${d.balance_min == null ? '' : fmtSaldo(d.balance_min)}</td>
        <td>${esc([situacao(d), ...d.alerts].filter(Boolean).join(' · '))}</td>
      </tr>`,
    )
    .join('');
  const t = data.totals;
  const html = `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>Espelho de ponto — ${esc(name)} — ${data.ym}</title>
<style>
  body{font-family:Arial,Helvetica,sans-serif;color:#111;margin:24px;font-size:12px}
  h1{font-size:16px;margin:0 0 2px} .sub{color:#555;margin-bottom:12px}
  table{width:100%;border-collapse:collapse} th,td{border:1px solid #ccc;padding:4px 6px;text-align:left}
  th{background:#f3f4f6;font-size:11px;text-transform:uppercase} td.n{text-align:right;white-space:nowrap}
  .tot{margin-top:10px} .sig{display:flex;gap:40px;margin-top:56px} .sig div{flex:1;border-top:1px solid #111;padding-top:4px;text-align:center}
  .nota{color:#666;font-size:10px;margin-top:8px}
</style></head><body>
<h1>Espelho de ponto — ${esc(monthLabel(data.ym))}</h1>
<div class="sub">${esc(clinic)} · Funcionário(a): <b>${esc(name)}</b></div>
<table><thead><tr><th>Dia</th><th>Batidas</th><th>Trabalhado</th><th>Previsto</th><th>Saldo</th><th>Observação</th></tr></thead><tbody>${rows}</tbody></table>
<div class="tot"><b>Totais (dias fechados):</b> trabalhado ${fmtMin(t.worked_min)} · previsto ${fmtMin(t.expected_min)} · saldo ${fmtSaldo(t.balance_min)} · faltas ${t.absences} · dias sem batida de saída ${t.incomplete}</div>
<div class="nota">* batida lançada pelo gestor. Diferença de até 10 min no dia não é computada (CLT, art. 58 §1º).</div>
<div class="sig"><div>${esc(name)}</div><div>Responsável — ${esc(clinic)}</div></div>
<script>window.onload=function(){window.print()}</script>
</body></html>`;
  const w = window.open('', '_blank');
  if (!w) return false;
  w.document.open();
  w.document.write(html);
  w.document.close();
  return true;
}

export function EspelhoActions({ data, name, clinic }: { data: Espelho; name: string; clinic: string }) {
  return (
    <div className="flex items-center gap-2">
      <button onClick={() => exportCsv(data, name)} className="flex items-center gap-1.5 px-3 py-2 rounded-lg border border-slate-200 bg-white text-sm text-slate-600 hover:text-slate-900">
        <Download className="w-4 h-4" /> Planilha
      </button>
      <button onClick={() => printEspelho(data, name, clinic)} className="flex items-center gap-1.5 px-3 py-2 rounded-lg border border-slate-200 bg-white text-sm text-slate-600 hover:text-slate-900">
        <Printer className="w-4 h-4" /> Imprimir
      </button>
    </div>
  );
}

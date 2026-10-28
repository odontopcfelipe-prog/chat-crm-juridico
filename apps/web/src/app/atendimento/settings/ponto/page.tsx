'use client';

/**
 * Configurações › Ponto (adm, manage_users). Duas coisas:
 *  1. Local base — centro + raio. Fora da área (ou sem localização) o ponto é recusado.
 *  2. Equipe do ponto — quem bate o ponto, desde quando, e o horário de cada um
 *     (entrada, intervalo, saída por dia da semana). Horário tem VIGÊNCIA: mudar não
 *     reescreve meses que já foram pra contabilidade.
 */
import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { Clock, Loader2, MapPin, Save, UserPlus, Users, Trash2, CalendarRange, ArrowRight, Copy, Crosshair } from 'lucide-react';
import api from '@/lib/api';
import { showError, showSuccess } from '@/lib/toast';
import { resetPontoStatusCache } from '@/lib/usePontoStatus';
import { pickBt } from '@crm/shared';
import { useBusinessType } from '@/lib/useBusinessType';
import {
  apiErr, dateBr, fmtMin, Modal, scheduleMinutes, scheduleText, WEEKDAYS, WEEKDAYS_LONG,
  type DaySchedule, type PontoLocal, type ScheduleVersion, type WeekSchedule,
} from '../../ponto/ponto-ui';
import { PontoMap } from '../../ponto/PontoMap';
import { EnderecoBusca, suggestEnderecos, type EnderecoHit } from './EnderecoBusca';
import { fmtM, getBestPosition, isFail, parseCoords, SEM_GPS_M } from '../../ponto/geo-client';

interface Member {
  user_id: string;
  name: string;
  removed_user: boolean;
  start_date: string;
  end_date: string | null;
  active: boolean;
  schedules: ScheduleVersion[]; // mais recente primeiro
}
interface ConfigData {
  local: PontoLocal | null;
  /** Endereço de Identidade da clínica (a busca usa sozinha). */
  clinic_address: string | null;
  clinic_city: string | null;
  max_precisao_m: number;
  today: string;
  members: Member[];
  users: { id: string; name: string; sector: string | null }[];
}

const inputCls =
  'px-2 py-1.5 text-sm border border-border rounded-md bg-card text-foreground tabular-nums focus:outline-none focus:ring-2 focus:ring-primary/30';

/* ── editor de horário (7 dias) ──────────────────────────── */
type Row = { on: boolean; in: string; bs: string; be: string; out: string };

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const toMin = (s: string) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3, 5));

const rowsFromWeek = (w: WeekSchedule): Row[] =>
  w.map((d) => (d ? { on: true, in: d.in, bs: d.break_start ?? '', be: d.break_end ?? '', out: d.out } : { on: false, in: '', bs: '', be: '', out: '' }));

// Padrão sugerido ao cadastrar: seg–sex 08:00–12:00 / 13:00–17:00, sábado 08:00–12:00 (44h).
const DEFAULT_ROWS: Row[] = [
  { on: false, in: '', bs: '', be: '', out: '' },
  ...Array.from({ length: 5 }, () => ({ on: true, in: '08:00', bs: '12:00', be: '13:00', out: '17:00' })),
  { on: true, in: '08:00', bs: '', be: '', out: '12:00' },
];

function rowError(r: Row): string | null {
  if (!r.on) return null;
  if (!HHMM.test(r.in) || !HHMM.test(r.out)) return 'Informe entrada e saída';
  if (toMin(r.out) <= toMin(r.in)) return 'Saída antes da entrada';
  if (!r.bs && !r.be) return null;
  if (!HHMM.test(r.bs) || !HHMM.test(r.be)) return 'Informe início e fim do intervalo';
  const [a, b, c, d] = [r.in, r.bs, r.be, r.out].map(toMin);
  if (!(a < b && b < c && c < d)) return 'Intervalo fora do horário';
  return null;
}

const rowToDay = (r: Row): DaySchedule | null =>
  r.on ? { in: r.in, out: r.out, break_start: r.bs || null, break_end: r.be || null } : null;

function ScheduleEditor({ rows, onChange }: { rows: Row[]; onChange: (r: Row[]) => void }) {
  const set = (i: number, patch: Partial<Row>) => onChange(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const total = rows.reduce((s, r) => s + (rowError(r) ? 0 : scheduleMinutes(rowToDay(r))), 0);
  const copyMonday = () => onChange(rows.map((r, i) => (i >= 1 && i <= 5 ? { ...rows[1] } : r)));
  const timeField = (i: number, key: 'in' | 'bs' | 'be' | 'out', label: string) => (
    <label className="text-[11px] font-semibold text-muted-foreground">
      {label}
      <input
        type="time"
        value={rows[i][key]}
        onChange={(e) => set(i, { [key]: e.target.value } as Partial<Row>)}
        className={`mt-0.5 block w-full ${inputCls}`}
        aria-label={`${WEEKDAYS_LONG[i]} ${label.toLowerCase()}`}
      />
    </label>
  );
  return (
    <div>
      {/* celular: um bloco por dia, horários em 2 colunas (a tabela não cabe) */}
      <div className="sm:hidden space-y-2">
        {rows.map((r, i) => {
          const err = rowError(r);
          return (
            <div key={i} className="border border-border/60 rounded-lg p-2.5">
              <div className="flex items-center justify-between gap-2">
                <label className="flex items-center gap-2 cursor-pointer">
                  <input type="checkbox" checked={r.on} onChange={(e) => set(i, { on: e.target.checked })} className="w-4 h-4" />
                  <span className={r.on ? 'text-foreground font-medium text-sm' : 'text-muted-foreground text-sm'}>{WEEKDAYS_LONG[i]}</span>
                </label>
                <span className={`text-xs tabular-nums ${err ? 'text-rose-600' : 'text-muted-foreground'}`}>
                  {!r.on ? 'Folga' : err ?? fmtMin(scheduleMinutes(rowToDay(r)))}
                </span>
              </div>
              {r.on && (
                <div className="grid grid-cols-2 gap-2 mt-2">
                  {timeField(i, 'in', 'Entrada')}
                  {timeField(i, 'out', 'Saída')}
                  {timeField(i, 'bs', 'Saída intervalo')}
                  {timeField(i, 'be', 'Volta intervalo')}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* computador: tabela */}
      <div className="hidden sm:block overflow-x-auto">
        <table className="w-full text-sm min-w-[560px]">
          <thead>
            <tr className="text-[11px] uppercase tracking-wide text-muted-foreground text-left">
              <th className="py-1.5 pr-2 font-semibold">Dia</th>
              <th className="py-1.5 px-1 font-semibold">Entrada</th>
              <th className="py-1.5 px-1 font-semibold">Saída intervalo</th>
              <th className="py-1.5 px-1 font-semibold">Volta intervalo</th>
              <th className="py-1.5 px-1 font-semibold">Saída</th>
              <th className="py-1.5 pl-2 font-semibold text-right">Horas</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => {
              const err = rowError(r);
              return (
                <tr key={i} className="border-t border-border/60 align-middle">
                  <td className="py-1.5 pr-2">
                    <label className="flex items-center gap-2 cursor-pointer whitespace-nowrap">
                      <input type="checkbox" checked={r.on} onChange={(e) => set(i, { on: e.target.checked })} className="w-4 h-4" />
                      <span className={r.on ? 'text-foreground font-medium' : 'text-muted-foreground'}>{WEEKDAYS_LONG[i]}</span>
                    </label>
                  </td>
                  {r.on ? (
                    <>
                      <td className="py-1.5 px-1"><input type="time" value={r.in} onChange={(e) => set(i, { in: e.target.value })} className={inputCls} aria-label={`${WEEKDAYS_LONG[i]} entrada`} /></td>
                      <td className="py-1.5 px-1"><input type="time" value={r.bs} onChange={(e) => set(i, { bs: e.target.value })} className={inputCls} aria-label={`${WEEKDAYS_LONG[i]} saída intervalo`} /></td>
                      <td className="py-1.5 px-1"><input type="time" value={r.be} onChange={(e) => set(i, { be: e.target.value })} className={inputCls} aria-label={`${WEEKDAYS_LONG[i]} volta intervalo`} /></td>
                      <td className="py-1.5 px-1"><input type="time" value={r.out} onChange={(e) => set(i, { out: e.target.value })} className={inputCls} aria-label={`${WEEKDAYS_LONG[i]} saída`} /></td>
                      <td className={`py-1.5 pl-2 text-right tabular-nums ${err ? 'text-rose-600 text-xs' : 'text-foreground'}`}>
                        {err ?? fmtMin(scheduleMinutes(rowToDay(r)))}
                      </td>
                    </>
                  ) : (
                    <td colSpan={5} className="py-1.5 px-1 text-xs text-muted-foreground">Folga</td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2 mt-2 text-xs text-muted-foreground">
        <span>Total: <b className="text-foreground">{fmtMin(total)}</b> por semana. Sem intervalo? Deixe os dois campos do meio vazios.</span>
        <button type="button" onClick={copyMonday} className="flex items-center gap-1 text-primary hover:underline">
          <Copy className="w-3 h-3" /> Copiar segunda para seg–sex
        </button>
      </div>
    </div>
  );
}

/* ════════════════════════════════════════════════════════════ */
export default function PontoSettingsPage() {
  const bt = useBusinessType();
  const [data, setData] = useState<ConfigData | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [modal, setModal] = useState<
    | { kind: 'add' }
    | { kind: 'schedule'; m: Member }
    | { kind: 'period'; m: Member }
    | null
  >(null);

  useEffect(() => {
    let alive = true;
    api
      .get<ConfigData>('/ponto/config')
      .then((res) => { if (alive) setData(res.data); })
      .catch((e) => { if (alive) setErr(apiErr(e, 'Falha ao carregar a configuração do ponto.')); });
    return () => { alive = false; };
  }, []);

  const applied = (d: ConfigData, msg: string) => {
    setData(d);
    setModal(null);
    resetPontoStatusCache();
    showSuccess(msg);
  };

  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-4xl mx-auto px-3 py-4 sm:p-6 pb-24">
        <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
          <div className="flex items-start gap-3">
            <div className="w-11 h-11 rounded-xl bg-primary/10 text-primary flex items-center justify-center shrink-0">
              <Clock size={22} />
            </div>
            <div>
              <h1 className="text-2xl font-bold text-foreground">Ponto</h1>
              <p className="text-sm text-muted-foreground mt-0.5">
                Local base, quem bate o ponto e o horário de cada um. Fora da área ou sem localização, o ponto não é aceito.
              </p>
            </div>
          </div>
          <Link href="/atendimento/ponto/equipe" className="flex items-center gap-1.5 px-3 py-2 rounded-lg border border-border text-sm font-semibold text-foreground hover:bg-foreground/[0.04]">
            Central do ponto <ArrowRight className="w-4 h-4" />
          </Link>
        </div>

        {err && <div className="mb-4 text-sm text-rose-600 bg-rose-50 border border-rose-200 rounded-xl p-4">{err}</div>}
        {!data && !err && (
          <div className="p-12 flex items-center justify-center text-muted-foreground">
            <Loader2 size={20} className="animate-spin mr-2" /> Carregando...
          </div>
        )}

        {data && (
          <div className="space-y-5">
            <LocalCard data={data} onSaved={(local) => { setData({ ...data, local }); showSuccess('Local do ponto salvo.'); }} />

            <section className="bg-card border border-border rounded-2xl p-4 sm:p-5">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <h2 className="text-[11px] font-bold text-muted-foreground uppercase tracking-wider flex items-center gap-1.5">
                    <Users className="w-3.5 h-3.5" /> Equipe do ponto
                  </h2>
                  <p className="text-xs text-muted-foreground mt-1">Só quem está aqui consegue bater o ponto. Cada um vê só o próprio ponto.</p>
                </div>
                <button onClick={() => setModal({ kind: 'add' })} className="flex items-center gap-1.5 px-3 py-2 rounded-lg bg-primary text-primary-foreground text-sm font-semibold hover:opacity-90">
                  <UserPlus className="w-4 h-4" /> Adicionar funcionário
                </button>
              </div>

              <div className="mt-4 space-y-2">
                {data.members.length === 0 && <p className="text-sm text-muted-foreground">Ninguém na equipe do ponto ainda.</p>}
                {data.members.map((m) => {
                  const current = m.schedules[0];
                  const pending = m.schedules.find((s) => s.valid_from > data.today);
                  const vigente = m.schedules.find((s) => s.valid_from <= data.today) ?? current;
                  return (
                    <div key={m.user_id} className="border border-border rounded-xl p-3.5">
                      <div className="flex flex-wrap items-start justify-between gap-2">
                        <div>
                          <div className="font-semibold text-foreground flex items-center gap-2">
                            {m.name}
                            {m.active ? (
                              <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-emerald-50 text-emerald-700 border border-emerald-200">ATIVO</span>
                            ) : m.start_date > data.today ? (
                              <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-sky-50 text-sky-700 border border-sky-200">COMEÇA {dateBr(m.start_date)}</span>
                            ) : (
                              <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-slate-100 text-slate-500">ENCERRADO</span>
                            )}
                            {m.removed_user && <span className="text-[10px] text-muted-foreground">(usuário excluído)</span>}
                          </div>
                          <div className="text-xs text-muted-foreground mt-0.5">
                            No ponto desde {dateBr(m.start_date)}{m.end_date ? ` até ${dateBr(m.end_date)}` : ''}
                            {vigente ? ` · ${fmtMin(vigente.days.reduce((s, d) => s + scheduleMinutes(d), 0))}/semana` : ''}
                            {pending ? ` · novo horário a partir de ${dateBr(pending.valid_from)}` : ''}
                          </div>
                        </div>
                        <div className="flex gap-2">
                          <button onClick={() => setModal({ kind: 'schedule', m })} className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg border border-border text-xs font-semibold text-foreground hover:bg-foreground/[0.04]">
                            <Clock className="w-3.5 h-3.5" /> Horário
                          </button>
                          <button onClick={() => setModal({ kind: 'period', m })} className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg border border-border text-xs font-semibold text-foreground hover:bg-foreground/[0.04]">
                            <CalendarRange className="w-3.5 h-3.5" /> Período
                          </button>
                        </div>
                      </div>
                      {vigente && (
                        <div className="grid grid-cols-2 sm:grid-cols-4 xl:grid-cols-7 gap-1 mt-2.5">
                          {vigente.days.map((d, i) => (
                            <div key={i} className={`text-[11px] rounded-md px-1.5 py-1 tabular-nums ${d ? 'bg-primary/5 text-foreground' : 'bg-foreground/[0.03] text-muted-foreground'}`}>
                              <span className="font-semibold">{WEEKDAYS[i]}</span> {scheduleText(d)}
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </section>

            <p className="text-xs text-muted-foreground">
              {pickBt(
                bt,
                'Feriados nacionais entram sozinhos no cálculo. Feriados estaduais e municipais vêm do cadastro de feriados da clínica. Esqueceu de bater? Só o adm ajusta, na Central do ponto — e o ajuste fica registrado com o motivo.',
                'Feriados nacionais entram sozinhos no cálculo. Feriados estaduais e municipais vêm do cadastro de feriados do laboratório. Esqueceu de bater? Só o adm ajusta, na Central do ponto — e o ajuste fica registrado com o motivo.',
              )}
            </p>
          </div>
        )}
      </div>

      {data && modal?.kind === 'add' && (
        <AddMemberModal data={data} onClose={() => setModal(null)} onDone={(d) => applied(d, 'Funcionário adicionado ao ponto.')} />
      )}
      {data && modal?.kind === 'schedule' && (
        <ScheduleModal m={modal.m} today={data.today} onClose={() => setModal(null)} onDone={(d, msg) => applied(d, msg)} />
      )}
      {data && modal?.kind === 'period' && (
        <PeriodModal m={modal.m} today={data.today} onClose={() => setModal(null)} onDone={(d) => applied(d, 'Período atualizado.')} />
      )}
    </div>
  );
}

/* ── local base ──────────────────────────────────────────── */
// Leitura de "minha localização" só vira local base com GPS de verdade (±50 m ou
// melhor). Computador de mesa vem do IP (±10 a ±50 km) — já salvou a clínica a
// quilômetros do lugar certo. Por isso o jeito principal é marcar no MAPA.
const LOCAL_MAX_ACC_M = 50;
const MACEIO = { lat: -9.6658, lng: -35.7353 };

function LocalCard({ data, onSaved }: { data: ConfigData; onSaved: (l: PontoLocal) => void }) {
  const bt = useBusinessType();
  const [lat, setLat] = useState(data.local ? String(data.local.lat) : '');
  const [lng, setLng] = useState(data.local ? String(data.local.lng) : '');
  const [raio, setRaio] = useState(String(data.local?.raio_m ?? 100));
  const [reading, setReading] = useState<{ acc: number; done: boolean } | null>(null);
  const [locating, setLocating] = useState(false);
  const [saving, setSaving] = useState(false);
  const [mapKey, setMapKey] = useState('init');
  // Ponto de referência pras sugestões (sem local salvo: a cidade da clínica).
  const [cityCenter, setCityCenter] = useState<{ lat: number; lng: number } | null>(null);
  const [paste, setPaste] = useState('');
  const [pasteState, setPasteState] = useState<{ kind: 'idle' | 'reading' | 'ok' | 'error'; text?: string }>({ kind: 'idle' });
  const [hint, setHint] = useState<string | null>(null);
  const pasteSeq = useRef(0);

  const latN = Number(lat.replace(',', '.'));
  const lngN = Number(lng.replace(',', '.'));
  const raioN = Math.round(Number(raio));
  const coordsOk =
    lat.trim() !== '' && lng.trim() !== '' &&
    Number.isFinite(latN) && Math.abs(latN) <= 90 && Number.isFinite(lngN) && Math.abs(lngN) <= 180;
  const ok = coordsOk && Number.isFinite(raioN) && raioN >= 20 && raioN <= 2000;
  const changed = !data.local || latN !== data.local.lat || lngN !== data.local.lng || raioN !== data.local.raio_m;

  const setPoint = (p: { lat: number; lng: number }, recenter: boolean) => {
    setLat(p.lat.toFixed(6));
    setLng(p.lng.toFixed(6));
    if (recenter) setMapKey(`${p.lat},${p.lng},${Date.now()}`);
  };

  // Colar: coordenadas ou link do Google Maps. O link curto do "Compartilhar"
  // (maps.app.goo.gl) não traz os números — o servidor segue o link e lê o pino.
  const onPaste = async (text: string) => {
    setPaste(text);
    const seq = ++pasteSeq.current;
    const t = text.trim();
    if (!t) { setPasteState({ kind: 'idle' }); return; }
    const p = parseCoords(t);
    if (p) {
      setPoint(p, true);
      setHint(null);
      setPasteState({ kind: 'ok', text: 'Pronto: o ponto azul foi pro local colado. Confira no mapa e salve.' });
      return;
    }
    if (!/^https?:\/\/\S*(goo\.gl|google\.[a-z.]+\/maps|maps\.google)/i.test(t)) {
      setPasteState({ kind: 'error', text: 'Não achei coordenadas aí. Cole o link do Google Maps ou os números (ex.: -9.748534, -36.651963).' });
      return;
    }
    setPasteState({ kind: 'reading' });
    try {
      const res = await api.get<{ lat: number; lng: number }>('/ponto/config/resolve-map', { params: { url: t } });
      if (seq !== pasteSeq.current) return;
      setPoint(res.data, true);
      setHint(null);
      setPasteState({ kind: 'ok', text: 'Pronto: li o pino do link do Google Maps. Confira no mapa e salve.' });
    } catch (e) {
      if (seq !== pasteSeq.current) return;
      setPasteState({ kind: 'error', text: apiErr(e, 'Não consegui ler esse link.') });
    }
  };

  const locate = async () => {
    setLocating(true);
    setReading(null);
    const r = await getBestPosition({
      targetM: 15,
      maxWaitMs: 25000,
      onProgress: (b) => setReading({ acc: b.accuracy, done: false }),
    });
    setLocating(false);
    if (isFail(r)) {
      showError(r.error === 'denied' ? 'Localização bloqueada — permita no cadeado ao lado do endereço.' : 'Não consegui a localização deste aparelho.');
      return;
    }
    setReading({ acc: r.accuracy, done: true });
    if (r.accuracy > LOCAL_MAX_ACC_M) {
      showError(`Leitura imprecisa (± ${fmtM(r.accuracy)}) — não serve como local do ponto. Marque no mapa.`);
      return;
    }
    setPoint({ lat: r.latitude, lng: r.longitude }, true);
  };

  const pickEndereco = (h: EnderecoHit, auto = false) => {
    setPoint({ lat: h.lat, lng: h.lng }, true);
    setHint(
      (auto
        ? pickBt(bt, `Achei pelo endereço cadastrado da clínica (${h.title}). `, `Achei pelo endereço cadastrado do laboratório (${h.title}). `)
        : '') +
        (h.kind === 'street'
          ? pickBt(
              bt,
              'A busca marca o MEIO da rua, não o número: toque no mapa exatamente em cima da clínica e depois salve.',
              'A busca marca o MEIO da rua, não o número: toque no mapa exatamente em cima do laboratório e depois salve.',
            )
          : pickBt(bt, 'Confira no mapa se o ponto azul está em cima da clínica e salve.', 'Confira no mapa se o ponto azul está em cima do laboratório e salve.')),
    );
  };

  // Sem local salvo: busca sozinha pelo endereço de Identidade da clínica e já
  // propõe o ponto (não salva — o adm confere e salva). Só a cidade cadastrada?
  // Centraliza o mapa e as sugestões nela.
  useEffect(() => {
    if (data.local) return;
    let alive = true;
    const run = async () => {
      try {
        if (data.clinic_address) {
          const [first] = await suggestEnderecos(data.clinic_address, null);
          if (alive && first) {
            setCityCenter({ lat: first.lat, lng: first.lng });
            pickEndereco(first, true);
            return;
          }
        }
        if (data.clinic_city) {
          const [city] = await suggestEnderecos(data.clinic_city, null);
          if (alive && city) {
            setCityCenter({ lat: city.lat, lng: city.lng });
            setMapKey(`city-${Date.now()}`);
          }
        }
      } catch {
        /* sem internet pro serviço de mapas: segue no padrão */
      }
    };
    void run();
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- só ao abrir a tela
  }, []);

  const save = async () => {
    setSaving(true);
    try {
      const res = await api.put<PontoLocal>('/ponto/config/local', { lat: latN, lng: lngN, raio_m: raioN });
      onSaved(res.data);
    } catch (e) {
      showError(apiErr(e, 'Não foi possível salvar o local.'));
    } finally {
      setSaving(false);
    }
  };

  const center = coordsOk ? { lat: latN, lng: lngN } : data.local ?? cityCenter ?? MACEIO;
  const bias = coordsOk ? { lat: latN, lng: lngN } : data.local ?? cityCenter;

  return (
    <section className="bg-card border border-border rounded-2xl p-4 sm:p-5">
      <h2 className="text-[11px] font-bold text-muted-foreground uppercase tracking-wider flex items-center gap-1.5">
        <MapPin className="w-3.5 h-3.5" /> Local base do ponto
      </h2>
      <p className="text-xs text-muted-foreground mt-1">
        O ponto só é aceito <b>dentro do círculo</b>, com a localização do celular ligada e precisão de até ±{data.max_precisao_m} m.
        <b>{pickBt(bt, ' Toque no mapa exatamente em cima da clínica', ' Toque no mapa exatamente em cima do laboratório')}</b> e salve.
      </p>
      {!data.local && (
        <p className="mt-2 text-xs font-semibold text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
          Sem local cadastrado ninguém consegue bater o ponto.
        </p>
      )}

      {/* achar a clínica no mapa: busca inteligente (sugestões ao digitar) ou a localização deste celular */}
      <div className="flex flex-wrap gap-2 mt-3">
        <EnderecoBusca bias={bias} onPick={(h) => pickEndereco(h)} inputCls={inputCls} />
        <button onClick={locate} disabled={locating} className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-primary text-primary-foreground text-sm font-semibold hover:opacity-90 disabled:opacity-60">
          {locating ? <Loader2 className="w-4 h-4 animate-spin" /> : <Crosshair className="w-4 h-4" />}
          {locating ? `Aguardando o GPS${reading ? ` (± ${fmtM(reading.acc)})` : '…'}` : 'Usar minha localização (celular)'}
        </button>
      </div>
      {reading?.done && (
        <p className={`mt-2 text-xs ${reading.acc <= LOCAL_MAX_ACC_M ? 'text-emerald-600' : 'text-rose-600'}`}>
          {reading.acc <= LOCAL_MAX_ACC_M
            ? pickBt(
                bt,
                `Leitura boa (± ${fmtM(reading.acc)}). Confira no mapa se o ponto azul está em cima da clínica.`,
                `Leitura boa (± ${fmtM(reading.acc)}). Confira no mapa se o ponto azul está em cima do laboratório.`,
              )
            : reading.acc > SEM_GPS_M
              ? `Este aparelho está sem GPS (± ${fmtM(reading.acc)}) — a localização veio da internet e erra por quilômetros. Marque no mapa.`
              : `Leitura imprecisa (± ${fmtM(reading.acc)}). Tente de novo perto de uma janela, ou marque no mapa.`}
        </p>
      )}

      <div className="mt-3">
        <PontoMap
          center={center}
          recenterKey={mapKey}
          zoom={data.local || coordsOk ? 17 : 13}
          clinic={coordsOk ? { lat: latN, lng: lngN, raio_m: Number.isFinite(raioN) && raioN > 0 ? raioN : 100 } : null}
          onPick={(p) => { setPoint(p, false); setHint(null); }}
          height={320}
        />
      </div>

      <div className="flex flex-wrap items-end gap-3 mt-3">
        <label className="text-xs font-semibold text-muted-foreground">Raio da área (m)
          <input value={raio} onChange={(e) => setRaio(e.target.value)} inputMode="numeric" className={`mt-1 block w-24 ${inputCls}`} />
        </label>
        <label className="text-xs font-semibold text-muted-foreground">Latitude
          <input value={lat} onChange={(e) => setLat(e.target.value)} placeholder="-9.665800" className={`mt-1 block w-32 ${inputCls}`} />
        </label>
        <label className="text-xs font-semibold text-muted-foreground">Longitude
          <input value={lng} onChange={(e) => setLng(e.target.value)} placeholder="-35.735300" className={`mt-1 block w-32 ${inputCls}`} />
        </label>
        <button onClick={save} disabled={!ok || !changed || saving} className="flex items-center gap-1.5 px-3 py-2 rounded-lg bg-slate-800 text-white text-sm font-semibold hover:bg-slate-900 disabled:opacity-40">
          {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />} Salvar local
        </button>
      </div>
      <div className="mt-2">
        <input
          value={paste}
          onChange={(e) => onPaste(e.target.value)}
          placeholder="Ou cole aqui o link do Google Maps (o do “Compartilhar” serve) ou as coordenadas"
          className={`w-full ${inputCls}`}
        />
        {pasteState.kind === 'reading' && (
          <p className="text-xs text-muted-foreground mt-1 flex items-center gap-1"><Loader2 className="w-3 h-3 animate-spin" /> Lendo o link do Google Maps…</p>
        )}
        {pasteState.kind === 'ok' && <p className="text-xs text-emerald-600 mt-1">{pasteState.text}</p>}
        {pasteState.kind === 'error' && <p className="text-xs text-amber-700 mt-1">{pasteState.text}</p>}
      </div>
      {hint && <p className="text-xs font-semibold text-sky-700 mt-2">{hint}</p>}
      <p className="text-xs text-muted-foreground mt-2">
        Raio sugerido: 50 a 150 m (o GPS do celular dentro de prédios erra uns 10 a 50 m). Computador de mesa não tem GPS — o ponto é pelo celular.
      </p>
    </section>
  );
}

/* ── adicionar funcionário ───────────────────────────────── */
function AddMemberModal({ data, onClose, onDone }: { data: ConfigData; onClose: () => void; onDone: (d: ConfigData) => void }) {
  const enrolled = new Set(data.members.map((m) => m.user_id));
  const options = data.users.filter((u) => !enrolled.has(u.id));
  const [userId, setUserId] = useState(options[0]?.id ?? '');
  const [start, setStart] = useState(data.today);
  const [rows, setRows] = useState<Row[]>(DEFAULT_ROWS);
  const [busy, setBusy] = useState(false);
  const ok = !!userId && /^\d{4}-\d{2}-\d{2}$/.test(start) && rows.every((r) => !rowError(r)) && rows.some((r) => r.on);

  const save = async () => {
    setBusy(true);
    try {
      const res = await api.post<ConfigData>('/ponto/members', { user_id: userId, start_date: start, days: rows.map(rowToDay) });
      onDone(res.data);
    } catch (e) {
      showError(apiErr(e, 'Não foi possível adicionar.'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title="Adicionar funcionário ao ponto" onClose={onClose} wide>
      {options.length === 0 ? (
        <p className="text-sm text-slate-500">Todos os usuários já estão na equipe do ponto.</p>
      ) : (
        <>
          <div className="grid sm:grid-cols-2 gap-3">
            <label className="text-xs font-semibold text-slate-500">Funcionário
              <select value={userId} onChange={(e) => setUserId(e.target.value)} className="mt-1 w-full border border-slate-200 rounded-lg px-2 py-2 text-sm bg-white">
                {options.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
              </select>
            </label>
            <label className="text-xs font-semibold text-slate-500">Começa a bater o ponto em
              <input type="date" value={start} onChange={(e) => setStart(e.target.value)} className="mt-1 w-full border border-slate-200 rounded-lg px-2 py-1.5 text-sm" />
            </label>
          </div>
          <p className="text-xs text-slate-400 mt-1">Faltas contam a partir desta data.</p>
          <h4 className="text-sm font-semibold text-slate-700 mt-4 mb-1">Horário de trabalho</h4>
          <ScheduleEditor rows={rows} onChange={setRows} />
          <div className="flex justify-end gap-2 mt-4">
            <button onClick={onClose} className="px-3 py-2 rounded-lg text-sm text-slate-600 hover:bg-slate-100">Cancelar</button>
            <button disabled={!ok || busy} onClick={save} className="px-4 py-2 rounded-lg bg-sky-600 text-white text-sm font-semibold hover:bg-sky-700 disabled:opacity-40 flex items-center gap-2">
              {busy && <Loader2 className="w-4 h-4 animate-spin" />} Adicionar ao ponto
            </button>
          </div>
        </>
      )}
    </Modal>
  );
}

/* ── horário (com vigência) ──────────────────────────────── */
function ScheduleModal({ m, today, onClose, onDone }: { m: Member; today: string; onClose: () => void; onDone: (d: ConfigData, msg: string) => void }) {
  const base = m.schedules.find((s) => s.valid_from <= today) ?? m.schedules[0];
  const [rows, setRows] = useState<Row[]>(() => (base ? rowsFromWeek(base.days) : DEFAULT_ROWS));
  const [from, setFrom] = useState(today < m.start_date ? m.start_date : today);
  const [busy, setBusy] = useState(false);
  const ok = /^\d{4}-\d{2}-\d{2}$/.test(from) && rows.every((r) => !rowError(r)) && rows.some((r) => r.on);

  const save = async () => {
    setBusy(true);
    try {
      const res = await api.put<ConfigData>(`/ponto/members/${m.user_id}/schedule`, { valid_from: from, days: rows.map(rowToDay) });
      onDone(res.data, `Horário salvo (vale a partir de ${dateBr(from)}).`);
    } catch (e) {
      showError(apiErr(e, 'Não foi possível salvar o horário.'));
    } finally {
      setBusy(false);
    }
  };
  const remove = async (validFrom: string) => {
    if (!window.confirm(`Apagar o horário que vale a partir de ${dateBr(validFrom)}? Os dias dessa época passam a usar o horário anterior.`)) return;
    try {
      const res = await api.delete<ConfigData>(`/ponto/members/${m.user_id}/schedules/${validFrom}`);
      onDone(res.data, 'Horário apagado.');
    } catch (e) {
      showError(apiErr(e, 'Não foi possível apagar.'));
    }
  };

  return (
    <Modal title={`Horário de ${m.name}`} onClose={onClose} wide>
      <ScheduleEditor rows={rows} onChange={setRows} />
      <div className="mt-4 flex flex-wrap items-end gap-3">
        <label className="text-xs font-semibold text-slate-500">Este horário vale a partir de
          <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="mt-1 block border border-slate-200 rounded-lg px-2 py-1.5 text-sm" />
        </label>
        <p className="text-xs text-slate-400 flex-1 min-w-[220px]">
          Os dias antes dessa data continuam com o horário antigo — o que já foi pra contabilidade não muda.
          Usar a mesma data de um horário existente substitui aquele horário.
        </p>
      </div>
      {m.schedules.length > 0 && (
        <div className="mt-4">
          <h4 className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-1">Histórico de horários</h4>
          <ul className="space-y-1">
            {m.schedules.map((s) => (
              <li key={s.valid_from} className="flex items-center justify-between text-xs border border-slate-100 rounded-lg px-2.5 py-1.5">
                <span>
                  <b>A partir de {dateBr(s.valid_from)}</b> · {fmtMin(s.days.reduce((t, d) => t + scheduleMinutes(d), 0))}/semana
                  {s.valid_from > today ? ' · ainda não começou' : ''}
                </span>
                <span className="flex items-center gap-2">
                  <button onClick={() => setRows(rowsFromWeek(s.days))} className="text-sky-600 hover:underline">Usar como base</button>
                  {m.schedules.length > 1 && (
                    <button onClick={() => remove(s.valid_from)} className="text-slate-400 hover:text-rose-600" aria-label="Apagar horário"><Trash2 className="w-3.5 h-3.5" /></button>
                  )}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
      <div className="flex justify-end gap-2 mt-4">
        <button onClick={onClose} className="px-3 py-2 rounded-lg text-sm text-slate-600 hover:bg-slate-100">Cancelar</button>
        <button disabled={!ok || busy} onClick={save} className="px-4 py-2 rounded-lg bg-sky-600 text-white text-sm font-semibold hover:bg-sky-700 disabled:opacity-40 flex items-center gap-2">
          {busy && <Loader2 className="w-4 h-4 animate-spin" />} Salvar horário
        </button>
      </div>
    </Modal>
  );
}

/* ── período na equipe (início / último dia) ─────────────── */
function PeriodModal({ m, today, onClose, onDone }: { m: Member; today: string; onClose: () => void; onDone: (d: ConfigData) => void }) {
  const [start, setStart] = useState(m.start_date);
  const [end, setEnd] = useState(m.end_date ?? '');
  const [busy, setBusy] = useState(false);
  const ok = /^\d{4}-\d{2}-\d{2}$/.test(start) && (!end || (/^\d{4}-\d{2}-\d{2}$/.test(end) && end >= start));

  const save = async (endValue: string | null) => {
    setBusy(true);
    try {
      const res = await api.patch<ConfigData>(`/ponto/members/${m.user_id}`, { start_date: start, end_date: endValue });
      onDone(res.data);
    } catch (e) {
      showError(apiErr(e, 'Não foi possível salvar.'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title={`Período no ponto · ${m.name}`} onClose={onClose}>
      <label className="text-xs font-semibold text-slate-500">Primeiro dia (faltas contam a partir daqui)
        <input type="date" value={start} onChange={(e) => setStart(e.target.value)} className="mt-1 w-full border border-slate-200 rounded-lg px-2 py-1.5 text-sm" />
      </label>
      <label className="text-xs font-semibold text-slate-500 mt-3 block">Último dia (saiu da empresa / parou de bater)
        <input type="date" value={end} onChange={(e) => setEnd(e.target.value)} className="mt-1 w-full border border-slate-200 rounded-lg px-2 py-1.5 text-sm" />
      </label>
      <p className="text-xs text-slate-400 mt-1">Deixe o último dia vazio enquanto a pessoa bate o ponto. O histórico nunca é apagado.</p>
      <div className="flex flex-wrap justify-between gap-2 mt-4">
        {!m.end_date ? (
          <button disabled={busy} onClick={() => save(today)} className="px-3 py-2 rounded-lg text-sm text-rose-600 hover:bg-rose-50">
            Encerrar hoje
          </button>
        ) : (
          <button disabled={busy} onClick={() => save(null)} className="px-3 py-2 rounded-lg text-sm text-emerald-700 hover:bg-emerald-50">
            Reativar
          </button>
        )}
        <div className="flex gap-2">
          <button onClick={onClose} className="px-3 py-2 rounded-lg text-sm text-slate-600 hover:bg-slate-100">Cancelar</button>
          <button disabled={!ok || busy} onClick={() => save(end || null)} className="px-4 py-2 rounded-lg bg-sky-600 text-white text-sm font-semibold hover:bg-sky-700 disabled:opacity-40 flex items-center gap-2">
            {busy && <Loader2 className="w-4 h-4 animate-spin" />} Salvar
          </button>
        </div>
      </div>
    </Modal>
  );
}

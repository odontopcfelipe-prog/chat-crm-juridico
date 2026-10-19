'use client';

/**
 * Relógio de ponto — tela do funcionário. Bate entrada/saída com a localização do
 * aparelho (a HORA é sempre a do servidor) e mostra o espelho do mês com as horas
 * calculadas pelo backend. Quem gerencia usuários tem o atalho pra equipe.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Clock, ChevronLeft, Loader2, LogIn, LogOut, MapPin, MapPinOff, Users, Wifi } from 'lucide-react';
import api from '@/lib/api';
import { showError, showSuccess } from '@/lib/toast';
import { useUserPermissions } from '@/lib/useUserPermissions';
import { useTenant } from '@/lib/useTenant';
import {
  apiErr, cap1, distanceMeters, EspelhoActions, EspelhoTable, fmtDist, fmtMin, MonthNav, PunchDetail,
  TotalsCards, GEO_META, type Day, type Espelho, type Punch, type PontoLocal,
} from './ponto-ui';

interface MeData {
  server_now: string;
  today: string;
  user: { id: string; name: string };
  next: 'ENTRADA' | 'SAIDA';
  today_calc: Day;
  today_punches: Punch[];
  config: { local: PontoLocal | null; exigir_local: boolean; tem_rede: boolean };
  espelho: Espelho;
}

type Pos = { latitude: number; longitude: number; accuracy: number; ts: number };
type GeoState = { kind: 'idle' | 'loading' | 'ok' | 'denied' | 'unavailable'; pos?: Pos };

const FRESH_MS = 2 * 60 * 1000;

function readPosition(): Promise<Pos | null> {
  if (typeof navigator === 'undefined' || !navigator.geolocation) return Promise.resolve(null);
  return new Promise((resolve) => {
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ latitude: p.coords.latitude, longitude: p.coords.longitude, accuracy: p.coords.accuracy, ts: Date.now() }),
      () => resolve(null),
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 30000 },
    );
  });
}

export default function PontoPage() {
  const router = useRouter();
  const { hasPermission } = useUserPermissions();
  const tenant = useTenant();
  const [data, setData] = useState<MeData | null>(null);
  const [ym, setYm] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [offset, setOffset] = useState(0); // relógio do servidor − relógio do aparelho
  const [now, setNow] = useState(() => Date.now());
  const [geo, setGeo] = useState<GeoState>({ kind: 'idle' });
  const [detail, setDetail] = useState<{ p: Punch; date: string } | null>(null);
  const geoRef = useRef<GeoState>(geo);
  geoRef.current = geo;

  const load = useCallback(async (month?: string | null) => {
    setErr(null);
    try {
      const t0 = Date.now();
      const res = await api.get<MeData>('/ponto/me', { params: month ? { month } : {} });
      const t1 = Date.now();
      setOffset(new Date(res.data.server_now).getTime() - (t0 + t1) / 2);
      setData(res.data);
      setYm(res.data.espelho.ym);
    } catch (e) {
      setErr(apiErr(e, 'Falha ao carregar o ponto.'));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  // relógio (1s) — hora do SERVIDOR, mostrada no fuso de Maceió
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  // localização ao vivo (pra mostrar se está no local ANTES de bater)
  useEffect(() => {
    if (typeof navigator === 'undefined' || !navigator.geolocation) {
      setGeo({ kind: 'unavailable' });
      return;
    }
    setGeo({ kind: 'loading' });
    const id = navigator.geolocation.watchPosition(
      (p) => setGeo({ kind: 'ok', pos: { latitude: p.coords.latitude, longitude: p.coords.longitude, accuracy: p.coords.accuracy, ts: Date.now() } }),
      (e) => setGeo((g) => (g.pos ? g : { kind: e.code === 1 ? 'denied' : 'unavailable' })),
      { enableHighAccuracy: true, maximumAge: 30000, timeout: 20000 },
    );
    return () => navigator.geolocation.clearWatch(id);
  }, []);

  const punch = async () => {
    if (!data) return;
    setBusy(true);
    try {
      let pos = geoRef.current.pos && Date.now() - geoRef.current.pos.ts < FRESH_MS ? geoRef.current.pos : null;
      if (!pos) pos = await readPosition();
      const body = pos ? { latitude: pos.latitude, longitude: pos.longitude, accuracy: Math.round(pos.accuracy) } : {};
      const res = await api.post('/ponto/punch', body);
      showSuccess(`${res.data.kind === 'ENTRADA' ? 'Entrada' : 'Saída'} registrada às ${res.data.hora}`);
      await load(ym);
    } catch (e) {
      showError(apiErr(e, 'Não foi possível registrar o ponto.'));
    } finally {
      setBusy(false);
    }
  };

  if (loading) return <div className="py-24 grid place-items-center"><Loader2 className="w-6 h-6 animate-spin text-sky-500" /></div>;
  if (err || !data) {
    return (
      <div className="max-w-lg mx-auto mt-10 text-center bg-rose-50 border border-rose-200 rounded-xl p-6">
        <p className="font-semibold text-rose-700">Não consegui abrir o ponto</p>
        <p className="text-sm text-rose-600 mt-2 break-words">{err}</p>
        <button onClick={() => { setLoading(true); load(ym); }} className="mt-4 px-4 py-2 rounded-lg bg-rose-600 text-white text-sm font-semibold hover:bg-rose-700">Tentar de novo</button>
      </div>
    );
  }

  const serverNow = new Date(now + offset);
  const hora = serverNow.toLocaleTimeString('pt-BR', { timeZone: 'America/Maceio', hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const dataLonga = serverNow.toLocaleDateString('pt-BR', { timeZone: 'America/Maceio', weekday: 'long', day: 'numeric', month: 'long' });
  const isEntrada = data.next === 'ENTRADA';
  const todayPunches = data.today_punches;
  const working = !isEntrada;
  // com a entrada aberta, o trabalhado de hoje corre junto com o relógio
  const sinceLoad = Math.floor((now + offset) / 60000) - Math.floor(new Date(data.server_now).getTime() / 60000);
  const workedToday = data.today_calc.worked_min + (working ? Math.max(0, sinceLoad) : 0);

  // situação do GPS (prévia no aparelho; quem decide é o servidor)
  const local = data.config.local;
  const dist = geo.pos && local ? distanceMeters(geo.pos.latitude, geo.pos.longitude, local.lat, local.lng) : null;
  const dentro = dist != null && local ? dist <= local.raio_m + Math.min(geo.pos?.accuracy ?? 0, 100) : null;

  return (
    <div className="max-w-5xl mx-auto px-4 py-6">
      <button onClick={() => router.back()} className="flex items-center gap-1 text-sm text-slate-500 hover:text-slate-700 mb-3">
        <ChevronLeft className="w-4 h-4" /> Voltar
      </button>
      <div className="flex flex-wrap items-center justify-between gap-3 mb-5">
        <div className="flex items-center gap-2.5">
          <div className="w-10 h-10 rounded-xl bg-sky-100 text-sky-700 grid place-items-center"><Clock className="w-5 h-5" /></div>
          <div>
            <h1 className="text-xl font-bold text-slate-800 leading-none">Ponto</h1>
            <p className="text-sm text-slate-500 mt-0.5">Registre entrada e saída. A hora registrada é a do sistema.</p>
          </div>
        </div>
        {hasPermission('manage_users') && (
          <Link href="/atendimento/ponto/equipe" className="flex items-center gap-1.5 px-3 py-2 rounded-lg bg-slate-800 text-white text-sm font-semibold hover:bg-slate-900">
            <Users className="w-4 h-4" /> Ponto da equipe
          </Link>
        )}
      </div>

      {/* relógio + botão */}
      <div className="grid md:grid-cols-5 gap-4 mb-6">
        <div className="md:col-span-3 bg-white border border-slate-200 rounded-2xl p-6 flex flex-col items-center text-center">
          <div className="text-sm text-slate-500">{cap1(dataLonga)}</div>
          <div className="text-5xl sm:text-6xl font-bold text-slate-800 tabular-nums tracking-tight mt-1">{hora}</div>

          <div className="mt-3 text-sm min-h-[1.5rem]">
            {geo.kind === 'loading' && !geo.pos && <span className="text-slate-400 flex items-center gap-1.5"><Loader2 className="w-3.5 h-3.5 animate-spin" /> Localizando…</span>}
            {geo.kind === 'denied' && <span className="text-amber-600 flex items-center gap-1.5"><MapPinOff className="w-4 h-4" /> Localização bloqueada — permita no cadeado ao lado do endereço</span>}
            {geo.kind === 'unavailable' && !geo.pos && <span className="text-slate-400 flex items-center gap-1.5"><MapPinOff className="w-4 h-4" /> Localização indisponível neste aparelho</span>}
            {geo.pos && local && (
              <span className={`flex items-center gap-1.5 ${dentro ? 'text-emerald-600' : 'text-amber-600'}`}>
                <MapPin className="w-4 h-4" /> {dentro ? 'No local da clínica' : 'Fora do local da clínica'} · {fmtDist(dist)}
                <span className="text-slate-400">(± {fmtDist(geo.pos.accuracy)})</span>
              </span>
            )}
            {geo.pos && !local && <span className="text-sky-600 flex items-center gap-1.5"><MapPin className="w-4 h-4" /> Localização ativa</span>}
          </div>

          <button
            onClick={punch}
            disabled={busy}
            className={`mt-5 w-full max-w-sm py-4 rounded-2xl text-white text-lg font-bold shadow-sm transition flex items-center justify-center gap-2 disabled:opacity-60 ${
              isEntrada ? 'bg-emerald-600 hover:bg-emerald-700' : 'bg-rose-600 hover:bg-rose-700'
            }`}
          >
            {busy ? <Loader2 className="w-5 h-5 animate-spin" /> : isEntrada ? <LogIn className="w-5 h-5" /> : <LogOut className="w-5 h-5" />}
            {isEntrada ? 'Registrar entrada' : 'Registrar saída'}
          </button>
          {data.config.exigir_local && (
            <p className="text-xs text-slate-400 mt-2 flex items-center gap-1">
              {data.config.tem_rede ? <Wifi className="w-3 h-3" /> : <MapPin className="w-3 h-3" />}
              A clínica só aceita o ponto no local{data.config.tem_rede ? ' ou pela rede da clínica' : ''}.
            </p>
          )}
        </div>

        <div className="md:col-span-2 bg-white border border-slate-200 rounded-2xl p-5">
          <div className="flex items-center justify-between">
            <h2 className="font-bold text-slate-800">Hoje</h2>
            <span className={`text-xs font-bold px-2.5 py-1 rounded-full border ${working ? 'bg-emerald-50 text-emerald-700 border-emerald-200' : 'bg-slate-50 text-slate-500 border-slate-200'}`}>
              {working ? 'Trabalhando' : todayPunches.length ? 'Fora do expediente' : 'Sem registro'}
            </span>
          </div>
          <ul className="mt-3 space-y-1.5">
            {todayPunches.length === 0 && <li className="text-sm text-slate-400">Nenhuma batida hoje.</li>}
            {todayPunches.map((p) => (
              <li key={p.id}>
                <button onClick={() => setDetail({ p, date: data.today })} className={`w-full flex items-center justify-between text-sm px-3 py-2 rounded-lg border ${p.voided ? 'border-slate-100 text-slate-300 line-through' : 'border-slate-100 hover:bg-slate-50'}`}>
                  <span className="font-semibold tabular-nums">{p.hora}</span>
                  <span className={p.voided ? '' : p.kind === 'ENTRADA' ? 'text-emerald-700' : 'text-slate-600'}>
                    {p.voided ? 'Anulada' : p.kind === 'ENTRADA' ? 'Entrada' : 'Saída'}
                  </span>
                  <span className={`text-xs ${GEO_META[p.geo_status]?.cls}`}>{GEO_META[p.geo_status]?.label}</span>
                </button>
              </li>
            ))}
          </ul>
          <div className="mt-4 pt-3 border-t border-slate-100 grid grid-cols-2 gap-2 text-sm">
            <div>
              <div className="text-[11px] uppercase tracking-wide font-semibold text-slate-400">Trabalhado hoje</div>
              <div className="text-lg font-bold tabular-nums text-slate-800">{fmtMin(workedToday)}</div>
            </div>
            <div>
              <div className="text-[11px] uppercase tracking-wide font-semibold text-slate-400">Jornada de hoje</div>
              <div className="text-lg font-bold tabular-nums text-slate-800">{fmtMin(data.today_calc.expected_min)}</div>
            </div>
          </div>
        </div>
      </div>

      {/* espelho do mês */}
      <div className="flex flex-wrap items-center justify-between gap-3 mb-3">
        <h2 className="font-bold text-slate-800">Meu espelho de ponto</h2>
        <div className="flex flex-wrap items-center gap-2">
          <MonthNav ym={data.espelho.ym} maxYm={data.today.slice(0, 7)} onChange={(m) => { setYm(m); load(m); }} />
          <EspelhoActions data={data.espelho} name={data.user.name} clinic={tenant?.name ?? 'Clínica'} />
        </div>
      </div>
      <div className="space-y-3">
        <TotalsCards t={data.espelho.totals} />
        <EspelhoTable data={data.espelho} onPunchClick={(p, date) => setDetail({ p, date })} />
        <p className="text-xs text-slate-400">
          Esqueceu de bater ou bateu errado? Fale com o gestor — ele lança ou anula a batida com o motivo, e tudo fica registrado aqui.
        </p>
      </div>

      {detail && <PunchDetail p={detail.p} date={detail.date} onClose={() => setDetail(null)} />}
    </div>
  );
}

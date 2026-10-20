'use client';

/**
 * Relógio de ponto — central do FUNCIONÁRIO. Só o próprio ponto. Bate com a
 * localização do aparelho, dentro da área da clínica (o servidor confere de novo
 * e grava a hora DELE). Adm que não bate ponto cai direto na central da equipe.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Clock, ChevronLeft, Loader2, LogIn, LogOut, MapPin, MapPinOff, Users, RefreshCw, Crosshair, Lock } from 'lucide-react';
import api from '@/lib/api';
import { showError, showSuccess } from '@/lib/toast';
import { useUserPermissions } from '@/lib/useUserPermissions';
import { useTenant } from '@/lib/useTenant';
import {
  apiErr, cap1, dateBr, distanceMeters, EspelhoActions, EspelhoTable, fmtDist, fmtMin, GEO_META, MonthNav,
  PunchDetail, scheduleText, TotalsCards, type Day, type DaySchedule, type Espelho, type Punch, type PontoLocal,
} from './ponto-ui';
import { getBestPosition, isFail, precisionHint, SEM_GPS_M, type GeoReading } from './geo-client';
import { PontoMap } from './PontoMap';

interface MeData {
  server_now: string;
  today: string;
  user: { id: string; name: string };
  member: { start_date: string; end_date: string | null; active: boolean } | null;
  local: PontoLocal | null;
  max_precisao_m: number;
  today_schedule: DaySchedule | null;
  next_label: string;
  next_is_entry: boolean;
  today_calc: Day;
  today_punches: Punch[];
  espelho: Espelho;
}

type Pos = GeoReading;
type GeoState = { kind: 'idle' | 'loading' | 'ok' | 'denied' | 'unavailable'; pos?: Pos };

// Precisão boa o bastante pra bater sem esperar mais (o servidor aceita até max_precisao_m).
const BOA_M = 30;
const FRESCA_MS = 15000;

export default function PontoPage() {
  const router = useRouter();
  const { hasPermission, ready: permsReady } = useUserPermissions();
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
  const [waiting, setWaiting] = useState<number | null | undefined>(undefined); // aguardando o GPS (± m da melhor leitura)
  const [showMap, setShowMap] = useState(false);
  const geoRef = useRef<GeoState>(geo);
  geoRef.current = geo;
  const isAdm = hasPermission('manage_users');

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

  // Adm que não está na equipe do ponto: a central dele é a da equipe.
  useEffect(() => {
    if (data && !data.member && permsReady && isAdm) router.replace('/atendimento/ponto/equipe');
  }, [data, permsReady, isAdm, router]);

  // relógio (1s) — hora do SERVIDOR, mostrada no fuso de Maceió
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  // localização ao vivo (mostra se está dentro da área ANTES de bater)
  const watching = !!data?.member?.active;
  useEffect(() => {
    if (!watching) return;
    if (typeof navigator === 'undefined' || !navigator.geolocation) {
      setGeo({ kind: 'unavailable' });
      return;
    }
    setGeo({ kind: 'loading' });
    const id = navigator.geolocation.watchPosition(
      (p) => setGeo({ kind: 'ok', pos: { latitude: p.coords.latitude, longitude: p.coords.longitude, accuracy: p.coords.accuracy, ts: Date.now() } }),
      (e) => setGeo((g) => (g.pos ? g : { kind: e.code === 1 ? 'denied' : 'unavailable' })),
      { enableHighAccuracy: true, maximumAge: 0, timeout: 60000 },
    );
    return () => navigator.geolocation.clearWatch(id);
  }, [watching]);

  /** Leitura firme: usa a do relógio se for recente e boa; senão espera o GPS (até 20 s). */
  const bestNow = async (): Promise<Pos | null> => {
    const cur = geoRef.current.pos;
    if (cur && Date.now() - cur.ts < FRESCA_MS && cur.accuracy <= BOA_M) return cur;
    setWaiting(cur?.accuracy ?? null);
    const r = await getBestPosition({ targetM: BOA_M, maxWaitMs: 20000, onProgress: (b) => setWaiting(b.accuracy) });
    setWaiting(undefined);
    if (isFail(r)) {
      if (r.error === 'denied') setGeo({ kind: 'denied' });
      else if (!cur) setGeo({ kind: 'unavailable' });
      return cur && Date.now() - cur.ts < FRESCA_MS ? cur : null;
    }
    setGeo({ kind: 'ok', pos: r });
    return r;
  };

  const relocate = async () => {
    setGeo((g) => ({ ...g, kind: 'loading' }));
    await bestNow();
  };

  const punch = async () => {
    if (!data) return;
    setBusy(true);
    try {
      // Leitura NOVA e firme na hora de bater (a 1ª leitura do GPS costuma vir ruim).
      const r = await bestNow();
      if (!r) {
        showError(geoRef.current.kind === 'denied' ? 'Permita a localização para registrar o ponto.' : 'Não consegui sua localização. Ative o GPS e tente de novo.');
        return;
      }
      if (r.accuracy > data.max_precisao_m) {
        showError(precisionHint(r.accuracy, data.max_precisao_m).text);
        return;
      }
      const res = await api.post('/ponto/punch', { latitude: r.latitude, longitude: r.longitude, accuracy: Math.round(r.accuracy) });
      showSuccess(`${res.data.label} registrada às ${res.data.hora}`);
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

  if (!data.member) {
    if (isAdm) return <div className="py-24 grid place-items-center"><Loader2 className="w-6 h-6 animate-spin text-sky-500" /></div>;
    return (
      <div className="max-w-md mx-auto px-4 py-20 text-center">
        <Lock className="w-10 h-10 mx-auto text-slate-300" />
        <p className="mt-4 text-slate-600">Você não está na equipe do ponto. Se você precisa bater o ponto, fale com o administrador.</p>
      </div>
    );
  }

  const serverNow = new Date(now + offset);
  const hora = serverNow.toLocaleTimeString('pt-BR', { timeZone: 'America/Maceio', hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const dataLonga = serverNow.toLocaleDateString('pt-BR', { timeZone: 'America/Maceio', weekday: 'long', day: 'numeric', month: 'long' });
  const working = !data.next_is_entry;
  const sinceLoad = Math.floor((now + offset) / 60000) - Math.floor(new Date(data.server_now).getTime() / 60000);
  const workedToday = data.today_calc.worked_min + (working ? Math.max(0, sinceLoad) : 0);

  // Prévia da área no aparelho (quem decide é o servidor, com a leitura enviada na batida).
  const local = data.local;
  const dist = geo.pos && local ? distanceMeters(geo.pos.latitude, geo.pos.longitude, local.lat, local.lng) : null;
  const inside = dist != null && local != null && dist <= local.raio_m;
  const precise = !!geo.pos && geo.pos.accuracy <= data.max_precisao_m;
  // Fora da área com leitura PRECISA = fora mesmo. Leitura ruim ainda pode melhorar:
  // o botão fica liberado e, ao clicar, espera o GPS firmar antes de mandar.
  const surelyOut = !!geo.pos && precise && !inside;
  // Leitura de quilômetros = aparelho sem GPS (computador / celular sem "localização
  // precisa"): não melhora esperando, então o botão trava (o "Localizar de novo" tenta de novo).
  const noGps = !!geo.pos && geo.pos.accuracy > SEM_GPS_M;
  const canPunch = data.member.active && !!local && geo.kind !== 'denied' && !surelyOut && !noGps;
  const hint = geo.pos ? precisionHint(geo.pos.accuracy, data.max_precisao_m) : null;

  return (
    <div className="max-w-5xl mx-auto px-4 py-6">
      <button onClick={() => router.back()} className="flex items-center gap-1 text-sm text-slate-500 hover:text-slate-700 mb-3">
        <ChevronLeft className="w-4 h-4" /> Voltar
      </button>
      <div className="flex flex-wrap items-center justify-between gap-3 mb-5">
        <div className="flex items-center gap-2.5">
          <div className="w-10 h-10 rounded-xl bg-sky-100 text-sky-700 grid place-items-center"><Clock className="w-5 h-5" /></div>
          <div>
            <h1 className="text-xl font-bold text-slate-800 leading-none">Meu ponto</h1>
            <p className="text-sm text-slate-500 mt-0.5">Registre no local da clínica. A hora registrada é a do sistema.</p>
          </div>
        </div>
        {isAdm && (
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

          {!data.member.active ? (
            <p className="mt-4 text-sm text-slate-500">
              {data.today < data.member.start_date
                ? `Seu ponto começa em ${dateBr(data.member.start_date)}.`
                : 'Seu ponto foi encerrado. Fale com o administrador.'}
            </p>
          ) : !local ? (
            <p className="mt-4 text-sm font-semibold text-amber-700">O administrador ainda não cadastrou o local do ponto.</p>
          ) : (
            <>
              <div className="mt-3 text-sm min-h-[1.5rem] flex flex-wrap items-center justify-center gap-x-2">
                {geo.kind === 'loading' && !geo.pos && <span className="text-slate-400 flex items-center gap-1.5"><Loader2 className="w-3.5 h-3.5 animate-spin" /> Localizando…</span>}
                {geo.kind === 'denied' && <span className="text-rose-600 flex items-center gap-1.5"><MapPinOff className="w-4 h-4" /> Localização bloqueada — permita no cadeado ao lado do endereço</span>}
                {geo.kind === 'unavailable' && !geo.pos && <span className="text-rose-600 flex items-center gap-1.5"><MapPinOff className="w-4 h-4" /> Não consegui sua localização — ative o GPS</span>}
                {geo.pos && !precise && hint && (
                  <span className="text-amber-700 flex items-start gap-1.5 max-w-md"><Crosshair className="w-4 h-4 shrink-0 mt-0.5" /> {hint.text}</span>
                )}
                {geo.pos && precise && !inside && (
                  <span className="text-rose-600 flex items-center gap-1.5"><MapPin className="w-4 h-4" /> Fora da área da clínica · {fmtDist(dist)}</span>
                )}
                {geo.pos && precise && inside && (
                  <span className="text-emerald-600 flex items-center gap-1.5"><MapPin className="w-4 h-4" /> Dentro da área da clínica · {fmtDist(dist)}</span>
                )}
                {geo.pos && precise && <span className="text-slate-400 text-xs">(± {fmtDist(geo.pos.accuracy)})</span>}
              </div>

              <button
                onClick={punch}
                disabled={busy || !canPunch}
                className={`mt-5 w-full max-w-sm py-4 rounded-2xl text-white text-lg font-bold shadow-sm transition flex items-center justify-center gap-2 disabled:opacity-40 disabled:cursor-not-allowed ${
                  data.next_is_entry ? 'bg-emerald-600 hover:bg-emerald-700' : 'bg-rose-600 hover:bg-rose-700'
                }`}
              >
                {busy ? <Loader2 className="w-5 h-5 animate-spin" /> : data.next_is_entry ? <LogIn className="w-5 h-5" /> : <LogOut className="w-5 h-5" />}
                {waiting !== undefined
                  ? `Aguardando o GPS${waiting != null ? ` (± ${fmtDist(waiting)})` : '…'}`
                  : `Registrar ${data.next_label.toLowerCase()}`}
              </button>
              <div className="mt-2 flex items-center gap-4 text-sm">
                {(!precise || !inside) && geo.kind !== 'loading' && !busy && (
                  <button onClick={relocate} className="text-sky-600 hover:underline flex items-center gap-1">
                    <RefreshCw className="w-3.5 h-3.5" /> Localizar de novo
                  </button>
                )}
                <button onClick={() => setShowMap((v) => !v)} className="text-sky-600 hover:underline flex items-center gap-1">
                  <MapPin className="w-3.5 h-3.5" /> {showMap ? 'Esconder mapa' : 'Ver no mapa'}
                </button>
              </div>
              {showMap && (
                <div className="mt-3 w-full max-w-md">
                  {/* Só mostra (sem onPick): o funcionário NÃO escolhe o local — o ponto usa só o GPS.
                      Leitura imprecisa não vira bolinha verde: com ±50 km a internet "chuta" o
                      centro da cidade, que pode cair perto da clínica e enganar. */}
                  <PontoMap
                    center={geo.pos && precise ? { lat: geo.pos.latitude, lng: geo.pos.longitude } : { lat: local.lat, lng: local.lng }}
                    recenterKey={geo.pos && precise ? 'you' : 'clinic'}
                    zoom={16}
                    clinic={local}
                    you={geo.pos && precise ? { lat: geo.pos.latitude, lng: geo.pos.longitude, accuracy: geo.pos.accuracy } : null}
                    height={240}
                  />
                  <p className="text-[11px] text-slate-400 mt-1">
                    {geo.pos && !precise
                      ? `Sua posição não aparece: a leitura deste aparelho erra até ± ${fmtDist(geo.pos.accuracy)}, então não dá pra saber onde você está.`
                      : 'Azul = área da clínica · verde = você (o tracejado é a margem de erro do GPS).'}{' '}
                    O mapa só mostra — o ponto usa o GPS do aparelho.
                  </p>
                </div>
              )}
              <p className="text-xs text-slate-400 mt-2">O ponto só é aceito com localização, dentro da área da clínica.</p>
            </>
          )}
        </div>

        <div className="md:col-span-2 bg-white border border-slate-200 rounded-2xl p-5">
          <div className="flex items-center justify-between">
            <h2 className="font-bold text-slate-800">Hoje</h2>
            <span className={`text-xs font-bold px-2.5 py-1 rounded-full border ${working ? 'bg-emerald-50 text-emerald-700 border-emerald-200' : 'bg-slate-50 text-slate-500 border-slate-200'}`}>
              {working ? 'Trabalhando' : data.today_punches.length ? 'Fora do expediente' : 'Sem registro'}
            </span>
          </div>
          <p className="text-xs text-slate-500 mt-1">
            Seu horário: <span className="tabular-nums">{data.today_calc.holiday ? `feriado (${data.today_calc.holiday})` : scheduleText(data.today_schedule)}</span>
          </p>
          <ul className="mt-3 space-y-1.5">
            {data.today_punches.length === 0 && <li className="text-sm text-slate-400">Nenhuma batida hoje.</li>}
            {data.today_punches.map((p) => (
              <li key={p.id}>
                <button onClick={() => setDetail({ p, date: data.today })} className={`w-full flex items-center justify-between gap-2 text-sm px-3 py-2 rounded-lg border ${p.voided ? 'border-slate-100 text-slate-300 line-through' : 'border-slate-100 hover:bg-slate-50'}`}>
                  <span className="font-semibold tabular-nums">{p.hora}</span>
                  <span className={p.voided ? '' : p.kind === 'ENTRADA' ? 'text-emerald-700' : 'text-slate-600'}>{p.voided ? 'Anulada' : p.label}</span>
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
              <div className="text-[11px] uppercase tracking-wide font-semibold text-slate-400">Previsto hoje</div>
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
          <EspelhoActions data={data.espelho} clinic={tenant?.name ?? 'Clínica'} />
        </div>
      </div>
      <div className="space-y-3">
        <TotalsCards t={data.espelho.totals} />
        <EspelhoTable data={data.espelho} onPunchClick={(p, date) => setDetail({ p, date })} />
        <p className="text-xs text-slate-400">
          Esqueceu de bater ou bateu errado? Só o administrador ajusta — ele lança ou anula a batida com o motivo, e tudo fica registrado aqui.
        </p>
      </div>

      {detail && <PunchDetail p={detail.p} date={detail.date} onClose={() => setDetail(null)} />}
    </div>
  );
}

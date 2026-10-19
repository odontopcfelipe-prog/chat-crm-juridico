'use client';

/**
 * Relógio de ponto — gestão (manage_users): horas da equipe no mês, quem está
 * trabalhando agora, espelho de cada um com lançar/anular batida (sempre com
 * motivo), jornada por funcionário e a configuração do local da clínica.
 */
import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  ChevronLeft, Clock, Loader2, Lock, MapPin, Save, Settings2, Trash2, Users, Wifi, AlertTriangle,
} from 'lucide-react';
import api from '@/lib/api';
import { showError, showSuccess } from '@/lib/toast';
import { useUserPermissions } from '@/lib/useUserPermissions';
import { useTenant } from '@/lib/useTenant';
import {
  AddPunchModal, apiErr, EspelhoActions, EspelhoTable, fmtMin, fmtSaldo, horasInput, MonthNav,
  parseHoras, PunchDetail, saldoCls, TotalsCards, WEEKDAYS, type Espelho, type PontoLocal, type Punch,
  type Totals,
} from '../ponto-ui';

interface Person {
  id: string;
  name: string;
  sector: string | null;
  removed: boolean;
  jornada: number[] | null;
  totals: Totals;
  punches_count: number;
  fora_do_local: number;
  sem_gps: number;
  trabalhando_agora: boolean;
  ultima_batida: string | null;
}
interface TeamData { ym: string; today: string; jornada_padrao: number[]; people: Person[] }
interface Config {
  local: PontoLocal | null;
  exigir_local: boolean;
  ips: string[];
  jornada_padrao: number[];
  my_ip: string | null;
  my_ip_publico: boolean;
}

const currentYm = () => new Date(Date.now() - 3 * 3600 * 1000).toISOString().slice(0, 7);

export default function PontoEquipePage() {
  const router = useRouter();
  const { hasPermission, ready } = useUserPermissions();
  const [tab, setTab] = useState<'equipe' | 'config'>('equipe');

  if (ready && !hasPermission('manage_users')) {
    return (
      <div className="max-w-md mx-auto px-4 py-20 text-center">
        <Lock className="w-10 h-10 mx-auto text-slate-300" />
        <p className="mt-4 text-slate-600">O ponto da equipe é do gestor. Peça ao administrador a permissão <b>Gerenciar usuários</b>.</p>
      </div>
    );
  }

  return (
    <div className="max-w-6xl mx-auto px-4 py-6">
      <button onClick={() => router.push('/atendimento/ponto')} className="flex items-center gap-1 text-sm text-slate-500 hover:text-slate-700 mb-3">
        <ChevronLeft className="w-4 h-4" /> Meu ponto
      </button>
      <div className="flex flex-wrap items-center justify-between gap-3 mb-5">
        <div className="flex items-center gap-2.5">
          <div className="w-10 h-10 rounded-xl bg-sky-100 text-sky-700 grid place-items-center"><Users className="w-5 h-5" /></div>
          <div>
            <h1 className="text-xl font-bold text-slate-800 leading-none">Ponto da equipe</h1>
            <p className="text-sm text-slate-500 mt-0.5">Horas do mês, ajustes e configuração do relógio.</p>
          </div>
        </div>
        <div className="flex bg-slate-100 rounded-lg p-1 text-sm font-semibold">
          <button onClick={() => setTab('equipe')} className={`px-3.5 py-1.5 rounded-md transition ${tab === 'equipe' ? 'bg-white shadow text-slate-800' : 'text-slate-500'}`}>Equipe</button>
          <button onClick={() => setTab('config')} className={`px-3.5 py-1.5 rounded-md transition flex items-center gap-1.5 ${tab === 'config' ? 'bg-white shadow text-slate-800' : 'text-slate-500'}`}><Settings2 className="w-4 h-4" /> Configuração</button>
        </div>
      </div>
      {tab === 'equipe' ? <EquipeView /> : <ConfigView />}
    </div>
  );
}

/* ════════════════════════════════════════════════════════════
   Equipe
════════════════════════════════════════════════════════════ */
function EquipeView() {
  const [ym, setYm] = useState(currentYm);
  const [data, setData] = useState<TeamData | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [selected, setSelected] = useState<Person | null>(null);

  const load = useCallback(async (month: string) => {
    setErr(null);
    try {
      const res = await api.get<TeamData>('/ponto/team', { params: { month } });
      setData(res.data);
    } catch (e) {
      setErr(apiErr(e, 'Falha ao carregar a equipe.'));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(ym); }, [load, ym]);

  if (selected) {
    return (
      <PersonView
        person={selected}
        ym={ym}
        jornadaPadrao={data?.jornada_padrao ?? []}
        onYm={setYm}
        onBack={() => { setSelected(null); load(ym); }}
      />
    );
  }

  if (loading) return <div className="py-20 grid place-items-center"><Loader2 className="w-6 h-6 animate-spin text-sky-500" /></div>;
  if (err || !data) return <div className="text-center text-rose-600 bg-rose-50 border border-rose-200 rounded-xl p-6">{err}</div>;

  const agora = data.people.filter((p) => p.trabalhando_agora);
  // "Ativo" = já usa o ponto (bateu no mês, tem jornada própria ou tem dia previsto/falta no mês).
  const usaPonto = (p: Person) => p.punches_count > 0 || !!p.jornada || p.totals.expected_min > 0;
  const ativos = data.people.filter(usaPonto);
  const semRegistro = data.people.filter((p) => !usaPonto(p) && !p.removed);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span className="font-semibold text-slate-600">Trabalhando agora:</span>
          {agora.length === 0 && <span className="text-slate-400">ninguém</span>}
          {agora.map((p) => (
            <span key={p.id} className="px-2.5 py-1 rounded-full bg-emerald-50 text-emerald-700 border border-emerald-200 text-xs font-semibold">
              {p.name.split(' ')[0]} · desde {p.ultima_batida}
            </span>
          ))}
        </div>
        <MonthNav ym={ym} maxYm={currentYm()} onChange={(m) => { setLoading(true); setYm(m); }} />
      </div>

      <div className="bg-white border border-slate-200 rounded-xl overflow-x-auto">
        <table className="w-full text-sm min-w-[720px]">
          <thead>
            <tr className="text-left text-[11px] uppercase tracking-wide text-slate-400 border-b border-slate-100">
              <th className="px-3 py-2.5 font-semibold">Funcionário</th>
              <th className="px-3 py-2.5 font-semibold text-right">Trabalhado</th>
              <th className="px-3 py-2.5 font-semibold text-right">Previsto</th>
              <th className="px-3 py-2.5 font-semibold text-right">Saldo</th>
              <th className="px-3 py-2.5 font-semibold text-right">Faltas</th>
              <th className="px-3 py-2.5 font-semibold text-right">Sem saída</th>
              <th className="px-3 py-2.5 font-semibold">Localização</th>
            </tr>
          </thead>
          <tbody>
            {ativos.length === 0 && (
              <tr><td colSpan={7} className="px-3 py-8 text-center text-slate-400">Ninguém bateu o ponto neste mês ainda.</td></tr>
            )}
            {ativos.map((p) => (
              <tr key={p.id} onClick={() => setSelected(p)} className="border-b border-slate-50 hover:bg-sky-50/50 cursor-pointer">
                <td className="px-3 py-2.5">
                  <div className="font-semibold text-slate-800 flex items-center gap-2">
                    {p.trabalhando_agora && <span className="w-2 h-2 rounded-full bg-emerald-500" title="Trabalhando agora" />}
                    {p.name}
                    {p.removed && <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-slate-100 text-slate-500">EXCLUÍDO</span>}
                  </div>
                  <div className="text-xs text-slate-400">{p.punches_count} batida(s) no mês{p.jornada ? ' · jornada própria' : ''}</div>
                </td>
                <td className="px-3 py-2.5 text-right tabular-nums">{fmtMin(p.totals.worked_min)}</td>
                <td className="px-3 py-2.5 text-right tabular-nums text-slate-500">{fmtMin(p.totals.expected_min)}</td>
                <td className={`px-3 py-2.5 text-right tabular-nums font-semibold ${saldoCls(p.totals.balance_min)}`}>{fmtSaldo(p.totals.balance_min)}</td>
                <td className={`px-3 py-2.5 text-right tabular-nums ${p.totals.absences ? 'text-rose-600 font-semibold' : 'text-slate-400'}`}>{p.totals.absences}</td>
                <td className={`px-3 py-2.5 text-right tabular-nums ${p.totals.incomplete ? 'text-amber-600 font-semibold' : 'text-slate-400'}`}>{p.totals.incomplete}</td>
                <td className="px-3 py-2.5 text-xs">
                  {p.fora_do_local > 0 && <div className="text-amber-600 flex items-center gap-1"><MapPin className="w-3 h-3" /> {p.fora_do_local} fora do local</div>}
                  {p.sem_gps > 0 && <div className="text-slate-400">{p.sem_gps} sem GPS</div>}
                  {!p.fora_do_local && !p.sem_gps && p.punches_count > 0 && <span className="text-emerald-600">tudo no local</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {semRegistro.length > 0 && (
        <div className="text-xs text-slate-500">
          <span className="font-semibold">Sem batida no mês:</span>{' '}
          {semRegistro.map((p, i) => (
            <button key={p.id} onClick={() => setSelected(p)} className="hover:text-sky-600 hover:underline">
              {p.name}{i < semRegistro.length - 1 ? ', ' : ''}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/* ════════════════════════════════════════════════════════════
   Espelho de um funcionário (gestor)
════════════════════════════════════════════════════════════ */
function PersonView({
  person, ym, jornadaPadrao, onYm, onBack,
}: {
  person: Person;
  ym: string;
  jornadaPadrao: number[];
  onYm: (ym: string) => void;
  onBack: () => void;
}) {
  const tenant = useTenant();
  const [data, setData] = useState<Espelho | null>(null);
  const [loading, setLoading] = useState(true);
  const [detail, setDetail] = useState<{ p: Punch; date: string } | null>(null);
  const [addDate, setAddDate] = useState<string | null>(null);
  const [editJornada, setEditJornada] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await api.get<Espelho>(`/ponto/users/${person.id}`, { params: { month: ym } });
      setData(res.data);
    } catch (e) {
      showError(apiErr(e, 'Falha ao carregar o espelho.'));
    } finally {
      setLoading(false);
    }
  }, [person.id, ym]);

  useEffect(() => { setLoading(true); load(); }, [load]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <button onClick={onBack} className="flex items-center gap-1 text-sm text-slate-500 hover:text-slate-700">
            <ChevronLeft className="w-4 h-4" /> Equipe
          </button>
          <h2 className="text-lg font-bold text-slate-800 mt-1">{person.name}</h2>
          {data && (
            <button onClick={() => setEditJornada(true)} disabled={person.removed} className="text-xs text-slate-500 hover:text-sky-600 flex items-center gap-1 disabled:hover:text-slate-500">
              <Clock className="w-3 h-3" />
              Jornada {data.jornada_propria ? 'própria' : 'padrão'}: {data.jornada.map((m, i) => `${WEEKDAYS[i]} ${m ? fmtMin(m) : '—'}`).join(' · ')}
              {!person.removed && <span className="text-sky-600 font-semibold ml-1">alterar</span>}
            </button>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <MonthNav ym={ym} maxYm={currentYm()} onChange={onYm} />
          {data && <EspelhoActions data={data} name={person.name} clinic={tenant?.name ?? 'Clínica'} />}
        </div>
      </div>

      {loading || !data ? (
        <div className="py-20 grid place-items-center"><Loader2 className="w-6 h-6 animate-spin text-sky-500" /></div>
      ) : (
        <>
          <TotalsCards t={data.totals} />
          <EspelhoTable
            data={data}
            onPunchClick={(p, date) => setDetail({ p, date })}
            onAdd={person.removed ? undefined : (date) => setAddDate(date)}
          />
          <p className="text-xs text-slate-400">
            Clique numa batida para ver o local no mapa ou anular (com motivo). Use o + para lançar uma batida esquecida.
            Nada é apagado: anuladas e lançadas ficam no histórico do funcionário.
          </p>
        </>
      )}

      {detail && (
        <PunchDetail
          p={detail.p}
          date={detail.date}
          onClose={() => setDetail(null)}
          onVoid={async (reason) => {
            try {
              const res = await api.post<Espelho>(`/ponto/punches/${detail.p.id}/void`, { reason });
              if (res.data.ym === ym) setData(res.data);
              showSuccess('Batida anulada.');
              setDetail(null);
            } catch (e) {
              showError(apiErr(e, 'Não foi possível anular.'));
            }
          }}
        />
      )}
      {addDate && (
        <AddPunchModal
          date={addDate}
          name={person.name}
          onClose={() => setAddDate(null)}
          onSave={async (time, note) => {
            try {
              const res = await api.post<Espelho>(`/ponto/users/${person.id}/punches`, { date: addDate, time, note });
              if (res.data.ym === ym) setData(res.data);
              showSuccess(`Batida das ${time} lançada.`);
              setAddDate(null);
            } catch (e) {
              showError(apiErr(e, 'Não foi possível lançar.'));
            }
          }}
        />
      )}
      {editJornada && data && (
        <JornadaModal
          name={person.name}
          value={data.jornada}
          propria={data.jornada_propria}
          padrao={jornadaPadrao}
          onClose={() => setEditJornada(false)}
          onSave={async (minutes) => {
            try {
              await api.put(`/ponto/users/${person.id}/schedule`, { minutes });
              showSuccess('Jornada salva.');
              setEditJornada(false);
              load();
            } catch (e) {
              showError(apiErr(e, 'Não foi possível salvar a jornada.'));
            }
          }}
        />
      )}
    </div>
  );
}

/* ── editor de jornada (7 dias) ──────────────────────────── */
function JornadaInputs({ value, onChange }: { value: string[]; onChange: (v: string[]) => void }) {
  const mins = value.map(parseHoras);
  const total = mins.reduce<number>((s, m) => s + (m ?? 0), 0);
  return (
    <div>
      <div className="grid grid-cols-7 gap-1.5">
        {WEEKDAYS.map((w, i) => (
          <label key={w} className="text-center">
            <span className="text-[11px] font-semibold text-slate-400 uppercase">{w}</span>
            <input
              value={value[i]}
              onChange={(e) => { const v = [...value]; v[i] = e.target.value; onChange(v); }}
              inputMode="numeric"
              placeholder="0:00"
              className={`mt-0.5 w-full border rounded-lg px-1 py-1.5 text-sm text-center tabular-nums ${mins[i] == null ? 'border-rose-300 bg-rose-50' : 'border-slate-200'}`}
            />
          </label>
        ))}
      </div>
      <p className="text-xs text-slate-500 mt-1.5">Total: <b>{fmtMin(total)}</b> por semana. Use horas:minutos (ex.: 8:00, 4:30). Dia sem expediente = 0.</p>
    </div>
  );
}

function JornadaModal({
  name, value, propria, padrao, onClose, onSave,
}: {
  name: string;
  value: number[];
  propria: boolean;
  padrao: number[];
  onClose: () => void;
  onSave: (minutes: number[] | null) => Promise<void>;
}) {
  const [v, setV] = useState(() => value.map(horasInput));
  const [busy, setBusy] = useState(false);
  const mins = v.map(parseHoras);
  const ok = mins.every((m) => m != null);
  return (
    <div className="fixed inset-0 z-50 bg-black/40 grid place-items-center p-4" onClick={onClose}>
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-lg p-5" onClick={(e) => e.stopPropagation()}>
        <h3 className="font-bold text-slate-800">Jornada de {name}</h3>
        <p className="text-xs text-slate-500 mt-0.5 mb-3">Horas previstas em cada dia da semana — é a base do saldo.</p>
        <JornadaInputs value={v} onChange={setV} />
        <div className="flex flex-wrap justify-between gap-2 mt-4">
          {propria ? (
            <button
              disabled={busy}
              onClick={async () => { setBusy(true); try { await onSave(null); } finally { setBusy(false); } }}
              className="text-sm text-slate-500 hover:text-slate-800"
            >
              Voltar para a padrão ({fmtMin(padrao.reduce((s, m) => s + m, 0))}/semana)
            </button>
          ) : <span />}
          <div className="flex gap-2">
            <button onClick={onClose} className="px-3 py-2 rounded-lg text-sm text-slate-600 hover:bg-slate-100">Cancelar</button>
            <button
              disabled={!ok || busy}
              onClick={async () => { setBusy(true); try { await onSave(mins as number[]); } finally { setBusy(false); } }}
              className="px-4 py-2 rounded-lg bg-sky-600 text-white text-sm font-semibold hover:bg-sky-700 disabled:opacity-40 flex items-center gap-2"
            >
              {busy && <Loader2 className="w-4 h-4 animate-spin" />} Salvar
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ════════════════════════════════════════════════════════════
   Configuração
════════════════════════════════════════════════════════════ */
function ConfigView() {
  const [cfg, setCfg] = useState<Config | null>(null);
  const [lat, setLat] = useState('');
  const [lng, setLng] = useState('');
  const [raio, setRaio] = useState('150');
  const [exigir, setExigir] = useState(false);
  const [ips, setIps] = useState<string[]>([]);
  const [jornada, setJornada] = useState<string[]>([]);
  const [locating, setLocating] = useState(false);
  const [saving, setSaving] = useState(false);

  const apply = (c: Config) => {
    setCfg(c);
    setLat(c.local ? String(c.local.lat) : '');
    setLng(c.local ? String(c.local.lng) : '');
    setRaio(String(c.local?.raio_m ?? 150));
    setExigir(c.exigir_local);
    setIps(c.ips);
    setJornada(c.jornada_padrao.map(horasInput));
  };

  useEffect(() => {
    api.get<Config>('/ponto/config').then((r) => apply(r.data)).catch((e) => showError(apiErr(e, 'Falha ao carregar a configuração.')));
  }, []);

  if (!cfg) return <div className="py-20 grid place-items-center"><Loader2 className="w-6 h-6 animate-spin text-sky-500" /></div>;

  const latN = Number(lat.replace(',', '.'));
  const lngN = Number(lng.replace(',', '.'));
  const raioN = Math.round(Number(raio));
  const temLocal = lat.trim() !== '' && lng.trim() !== '';
  const localOk = !temLocal || (Number.isFinite(latN) && Math.abs(latN) <= 90 && Number.isFinite(lngN) && Math.abs(lngN) <= 180);
  const raioOk = Number.isFinite(raioN) && raioN >= 20 && raioN <= 5000;
  const jornadaMin = jornada.map(parseHoras);
  const jornadaOk = jornadaMin.every((m) => m != null);
  const semReferencia = !temLocal && ips.length === 0;

  const usarMinhaLocalizacao = () => {
    if (!navigator.geolocation) { showError('Este aparelho não informa a localização.'); return; }
    setLocating(true);
    navigator.geolocation.getCurrentPosition(
      (p) => {
        setLat(p.coords.latitude.toFixed(6));
        setLng(p.coords.longitude.toFixed(6));
        setLocating(false);
        if (p.coords.accuracy > 100) showError(`Precisão baixa (± ${Math.round(p.coords.accuracy)} m). Se puder, faça isso pelo celular, dentro da clínica.`);
      },
      () => { setLocating(false); showError('Não consegui a localização. Permita o acesso no navegador.'); },
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 },
    );
  };

  const save = async () => {
    setSaving(true);
    try {
      const res = await api.put<Config>('/ponto/config', {
        local: temLocal ? { lat: latN, lng: lngN, raio_m: raioN } : null,
        exigir_local: exigir,
        ips,
        jornada_padrao: jornadaMin,
      });
      apply(res.data);
      showSuccess('Configuração do ponto salva.');
    } catch (e) {
      showError(apiErr(e, 'Não foi possível salvar.'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="grid lg:grid-cols-2 gap-4">
      <section className="bg-white border border-slate-200 rounded-xl p-5 space-y-3">
        <h3 className="font-bold text-slate-800 flex items-center gap-2"><MapPin className="w-4 h-4 text-sky-600" /> Local da clínica</h3>
        <p className="text-sm text-slate-500">Cada batida guarda a localização do aparelho e a distância até aqui. O ideal é marcar pelo celular, de dentro da clínica.</p>
        <button onClick={usarMinhaLocalizacao} disabled={locating} className="px-3 py-2 rounded-lg bg-sky-600 text-white text-sm font-semibold hover:bg-sky-700 disabled:opacity-50 flex items-center gap-2">
          {locating ? <Loader2 className="w-4 h-4 animate-spin" /> : <MapPin className="w-4 h-4" />} Usar minha localização atual
        </button>
        <div className="grid grid-cols-3 gap-2">
          <label className="text-xs font-semibold text-slate-500">Latitude
            <input value={lat} onChange={(e) => setLat(e.target.value)} placeholder="-9.665800" className="mt-1 w-full border border-slate-200 rounded-lg px-2 py-1.5 text-sm tabular-nums" />
          </label>
          <label className="text-xs font-semibold text-slate-500">Longitude
            <input value={lng} onChange={(e) => setLng(e.target.value)} placeholder="-35.735300" className="mt-1 w-full border border-slate-200 rounded-lg px-2 py-1.5 text-sm tabular-nums" />
          </label>
          <label className="text-xs font-semibold text-slate-500">Raio (metros)
            <input value={raio} onChange={(e) => setRaio(e.target.value)} inputMode="numeric" className={`mt-1 w-full border rounded-lg px-2 py-1.5 text-sm tabular-nums ${raioOk ? 'border-slate-200' : 'border-rose-300 bg-rose-50'}`} />
          </label>
        </div>
        {!localOk && <p className="text-xs text-rose-600">Latitude/longitude inválidas.</p>}
        <div className="flex items-center gap-3 text-sm">
          {temLocal && localOk && (
            <a href={`https://www.google.com/maps?q=${latN},${lngN}`} target="_blank" rel="noreferrer" className="text-sky-600 hover:underline">Conferir no mapa</a>
          )}
          {temLocal && <button onClick={() => { setLat(''); setLng(''); }} className="text-slate-400 hover:text-rose-600">Remover local</button>}
        </div>
      </section>

      <section className="bg-white border border-slate-200 rounded-xl p-5 space-y-3">
        <h3 className="font-bold text-slate-800 flex items-center gap-2"><Wifi className="w-4 h-4 text-sky-600" /> Rede da clínica</h3>
        <p className="text-sm text-slate-500">
          Computador sem GPS (recepção) costuma errar a localização por quilômetros. Cadastre a internet da clínica:
          quem bater por ela conta como no local.
        </p>
        <div className="space-y-1.5">
          {ips.length === 0 && <p className="text-xs text-slate-400">Nenhuma rede cadastrada.</p>}
          {ips.map((ip) => (
            <div key={ip} className="flex items-center justify-between text-sm border border-slate-100 rounded-lg px-3 py-1.5">
              <span className="tabular-nums">{ip}</span>
              <button onClick={() => setIps(ips.filter((x) => x !== ip))} className="text-slate-400 hover:text-rose-600" aria-label="Remover"><Trash2 className="w-4 h-4" /></button>
            </div>
          ))}
        </div>
        {cfg.my_ip_publico && cfg.my_ip && !ips.includes(cfg.my_ip) && (
          <button onClick={() => setIps([...ips, cfg.my_ip as string])} className="px-3 py-2 rounded-lg border border-sky-200 text-sky-700 text-sm font-semibold hover:bg-sky-50">
            Adicionar a rede de onde estou agora ({cfg.my_ip})
          </button>
        )}
        {!cfg.my_ip_publico && (
          <p className="text-xs text-amber-600">Não foi possível identificar o endereço público desta rede.</p>
        )}
        <p className="text-xs text-slate-400">Só cadastre estando na clínica. Se a operadora trocar o endereço, cadastre de novo.</p>
      </section>

      <section className="bg-white border border-slate-200 rounded-xl p-5 space-y-3">
        <h3 className="font-bold text-slate-800">Regra da batida</h3>
        <label className="flex items-start gap-3 cursor-pointer">
          <input type="checkbox" checked={exigir} onChange={(e) => setExigir(e.target.checked)} className="mt-1 w-4 h-4" />
          <span className="text-sm text-slate-700">
            <b>Só aceitar o ponto no local</b> — dentro do raio ou pela rede da clínica. Sem localização ou longe, a batida é recusada.
            <span className="block text-xs text-slate-400 mt-0.5">Desligado: aceita de qualquer lugar e marca “fora do local” para você conferir.</span>
          </span>
        </label>
        {exigir && semReferencia && (
          <p className="text-xs text-amber-600 flex items-center gap-1"><AlertTriangle className="w-3.5 h-3.5" /> Cadastre o local ou a rede da clínica — sem isso a regra não tem como valer.</p>
        )}
      </section>

      <section className="bg-white border border-slate-200 rounded-xl p-5 space-y-3">
        <h3 className="font-bold text-slate-800">Jornada padrão</h3>
        <p className="text-sm text-slate-500">Vale para todos, menos quem tiver jornada própria (defina no espelho do funcionário).</p>
        <JornadaInputs value={jornada} onChange={setJornada} />
      </section>

      <div className="lg:col-span-2 flex justify-end">
        <button
          onClick={save}
          disabled={saving || !localOk || (temLocal && !raioOk) || !jornadaOk}
          className="px-5 py-2.5 rounded-lg bg-slate-800 text-white text-sm font-semibold hover:bg-slate-900 disabled:opacity-40 flex items-center gap-2"
        >
          {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />} Salvar configuração
        </button>
      </div>
    </div>
  );
}

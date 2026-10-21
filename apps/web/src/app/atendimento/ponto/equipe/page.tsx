'use client';

/**
 * Relógio de ponto — central do ADM (manage_users): horas da equipe no mês, quem
 * está trabalhando agora, espelho de cada um com lançar/anular batida (sempre com
 * motivo) e o envio pra contabilidade (resumo, detalhado e impressão dos espelhos).
 * A configuração (local base, equipe e horários) fica em Configurações › Ponto.
 */
import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  ChevronLeft, Clock, Loader2, Lock, Users, Settings2, FileSpreadsheet, Printer, AlertTriangle, Send,
} from 'lucide-react';
import api from '@/lib/api';
import { showError, showSuccess } from '@/lib/toast';
import { useUserPermissions } from '@/lib/useUserPermissions';
import { usePontoStatus } from '@/lib/usePontoStatus';
import { useTenant } from '@/lib/useTenant';
import {
  AddPunchModal, apiErr, dateBr, EspelhoActions, EspelhoTable, exportDetalhadoCsv, exportResumoCsv, fmtMin,
  fmtSaldo, monthLabel, MonthNav, printEspelhos, PunchDetail, saldoCls, scheduleText, TotalsCards, WEEKDAYS,
  type Espelho, type Punch, type Totals,
} from '../ponto-ui';

interface Person {
  user_id: string;
  name: string;
  member: { start_date: string; end_date: string | null } | null;
  totals: Totals;
  punches_count: number;
  adjustments: number;
  alerts_count: number;
  trabalhando_agora: boolean;
  ultima_batida: string | null;
}
interface TeamData { ym: string; today: string; people: Person[] }

const currentYm = () => new Date(Date.now() - 3 * 3600 * 1000).toISOString().slice(0, 7);

export default function PontoEquipePage() {
  const router = useRouter();
  const { hasPermission, ready } = useUserPermissions();
  const ponto = usePontoStatus();

  if (ready && !hasPermission('manage_users')) {
    return (
      <div className="max-w-md mx-auto px-4 py-20 text-center">
        <Lock className="w-10 h-10 mx-auto text-slate-300" />
        <p className="mt-4 text-slate-600">A central do ponto é do administrador. Cada funcionário vê só o próprio ponto.</p>
      </div>
    );
  }

  return (
    <div className="max-w-6xl mx-auto px-4 py-6">
      <button onClick={() => router.back()} className="flex items-center gap-1 text-sm text-slate-500 hover:text-slate-700 mb-3">
        <ChevronLeft className="w-4 h-4" /> Voltar
      </button>
      <div className="flex flex-wrap items-center justify-between gap-3 mb-5">
        <div className="flex items-center gap-2.5">
          <div className="w-10 h-10 rounded-xl bg-sky-100 text-sky-700 grid place-items-center"><Users className="w-5 h-5" /></div>
          <div>
            <h1 className="text-xl font-bold text-slate-800 leading-none">Ponto da equipe</h1>
            <p className="text-sm text-slate-500 mt-0.5">Horas do mês, ajustes e envio para a contabilidade.</p>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          {ponto.member && (
            <Link href="/atendimento/ponto" className="flex items-center gap-1.5 px-3 py-2 rounded-lg border border-slate-200 bg-white text-sm font-semibold text-slate-700 hover:bg-slate-50">
              <Clock className="w-4 h-4" /> Meu ponto
            </Link>
          )}
          <Link href="/atendimento/settings/ponto" className="flex items-center gap-1.5 px-3 py-2 rounded-lg bg-slate-800 text-white text-sm font-semibold hover:bg-slate-900">
            <Settings2 className="w-4 h-4" /> Configurar ponto
          </Link>
        </div>
      </div>
      <EquipeView />
    </div>
  );
}

/* ════════════════════════════════════════════════════════════
   Equipe
════════════════════════════════════════════════════════════ */
function EquipeView() {
  const tenant = useTenant();
  const [ym, setYm] = useState(currentYm);
  const [data, setData] = useState<TeamData | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [selected, setSelected] = useState<Person | null>(null);
  const [exporting, setExporting] = useState<string | null>(null);

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

  const exportar = async (kind: 'resumo' | 'detalhado' | 'imprimir') => {
    setExporting(kind);
    try {
      const res = await api.get<{ ym: string; people: Espelho[] }>('/ponto/report', { params: { month: ym } });
      const clinic = tenant?.name ?? 'Clínica';
      if (!res.data.people.length) { showError('Ninguém no ponto neste mês.'); return; }
      if (kind === 'resumo') exportResumoCsv(res.data.people, res.data.ym, clinic);
      else if (kind === 'detalhado') exportDetalhadoCsv(res.data.people, res.data.ym);
      else if (!printEspelhos(res.data.people, clinic)) showError('O navegador bloqueou a janela de impressão — permita pop-ups.');
      if (kind !== 'imprimir') showSuccess('Planilha baixada.');
    } catch (e) {
      showError(apiErr(e, 'Não foi possível gerar o relatório.'));
    } finally {
      setExporting(null);
    }
  };

  if (selected) {
    return <PersonView person={selected} ym={ym} onYm={setYm} onBack={() => { setSelected(null); load(ym); }} />;
  }

  if (loading) return <div className="py-20 grid place-items-center"><Loader2 className="w-6 h-6 animate-spin text-sky-500" /></div>;
  if (err || !data) return <div className="text-center text-rose-600 bg-rose-50 border border-rose-200 rounded-xl p-6">{err}</div>;

  const agora = data.people.filter((p) => p.trabalhando_agora);
  const pendentes = data.people.reduce((s, p) => s + p.totals.incomplete, 0);
  const fechado = ym < data.today.slice(0, 7);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span className="font-semibold text-slate-600">Trabalhando agora:</span>
          {agora.length === 0 && <span className="text-slate-400">ninguém</span>}
          {agora.map((p) => (
            <span key={p.user_id} className="px-2.5 py-1 rounded-full bg-emerald-50 text-emerald-700 border border-emerald-200 text-xs font-semibold">
              {p.name.split(' ')[0]} · desde {p.ultima_batida}
            </span>
          ))}
        </div>
        <MonthNav ym={ym} maxYm={currentYm()} onChange={(m) => { setLoading(true); setYm(m); }} />
      </div>

      {/* celular: um cartão por funcionário (a tabela de 9 colunas não cabe) */}
      <div className="sm:hidden space-y-2">
        {data.people.length === 0 && (
          <p className="bg-white border border-slate-200 rounded-xl px-3 py-8 text-center text-sm text-slate-400">
            Ninguém no ponto neste mês. <Link href="/atendimento/settings/ponto" className="text-sky-600 hover:underline">Adicione a equipe em Configurações › Ponto</Link>.
          </p>
        )}
        {data.people.map((p) => {
          const t = p.totals;
          const cell = (label: string, value: string, cls = 'text-slate-700') => (
            <div>
              <div className="text-[10px] uppercase tracking-wide font-semibold text-slate-400">{label}</div>
              <div className={`text-sm tabular-nums font-semibold ${cls}`}>{value}</div>
            </div>
          );
          return (
            <button key={p.user_id} onClick={() => setSelected(p)} className="w-full text-left bg-white border border-slate-200 rounded-xl p-3 active:bg-sky-50">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="font-semibold text-slate-800 flex items-center gap-2">
                    {p.trabalhando_agora && <span className="w-2 h-2 rounded-full bg-emerald-500 shrink-0" title="Trabalhando agora" />}
                    <span className="truncate">{p.name}</span>
                  </div>
                  <div className="text-xs text-slate-400">
                    {p.member ? `desde ${dateBr(p.member.start_date)}` : 'fora da equipe — não conta'} · {p.punches_count} batida(s)
                  </div>
                </div>
                <div className={`text-base tabular-nums font-bold shrink-0 ${saldoCls(t.balance_min)}`}>{fmtSaldo(t.balance_min)}</div>
              </div>
              <div className="grid grid-cols-3 gap-2 mt-2">
                {cell('Trabalhado', fmtMin(t.worked_min))}
                {cell('Previsto', fmtMin(t.expected_min), 'text-slate-500')}
                {cell('Extras', fmtMin(t.extra_min), t.extra_min ? 'text-emerald-600' : 'text-slate-400')}
                {cell('Dom./feriado', fmtMin(t.extra_dsr_min), t.extra_dsr_min ? 'text-emerald-600' : 'text-slate-400')}
                {cell('Atrasos', fmtMin(t.debit_min), t.debit_min ? 'text-rose-600' : 'text-slate-400')}
                {cell('Faltas', String(t.absences), t.absences ? 'text-rose-600' : 'text-slate-400')}
              </div>
              {(t.incomplete > 0 || p.alerts_count > 0 || p.adjustments > 0) && (
                <div className="mt-2 text-xs flex flex-wrap gap-x-3">
                  {t.incomplete > 0 && <span className="text-amber-600 font-semibold">{t.incomplete} dia(s) sem saída</span>}
                  {p.alerts_count > 0 && <span className="text-amber-700">{p.alerts_count} alerta(s)</span>}
                  {p.adjustments > 0 && <span className="text-violet-600">{p.adjustments} ajuste(s) do adm</span>}
                </div>
              )}
            </button>
          );
        })}
      </div>

      {/* computador: tabela */}
      <div className="hidden sm:block bg-white border border-slate-200 rounded-xl overflow-x-auto">
        <table className="w-full text-sm min-w-[860px]">
          <thead>
            <tr className="text-left text-[11px] uppercase tracking-wide text-slate-400 border-b border-slate-100">
              <th className="px-3 py-2.5 font-semibold">Funcionário</th>
              <th className="px-3 py-2.5 font-semibold text-right">Trabalhado</th>
              <th className="px-3 py-2.5 font-semibold text-right">Previsto</th>
              <th className="px-3 py-2.5 font-semibold text-right">Extras</th>
              <th className="px-3 py-2.5 font-semibold text-right">Dom./feriado</th>
              <th className="px-3 py-2.5 font-semibold text-right">Atrasos</th>
              <th className="px-3 py-2.5 font-semibold text-right">Faltas</th>
              <th className="px-3 py-2.5 font-semibold text-right">Saldo</th>
              <th className="px-3 py-2.5 font-semibold">Pendências</th>
            </tr>
          </thead>
          <tbody>
            {data.people.length === 0 && (
              <tr><td colSpan={9} className="px-3 py-8 text-center text-slate-400">
                Ninguém no ponto neste mês. <Link href="/atendimento/settings/ponto" className="text-sky-600 hover:underline">Adicione a equipe em Configurações › Ponto</Link>.
              </td></tr>
            )}
            {data.people.map((p) => {
              const t = p.totals;
              return (
                <tr key={p.user_id} onClick={() => setSelected(p)} className="border-b border-slate-50 hover:bg-sky-50/50 cursor-pointer">
                  <td className="px-3 py-2.5">
                    <div className="font-semibold text-slate-800 flex items-center gap-2">
                      {p.trabalhando_agora && <span className="w-2 h-2 rounded-full bg-emerald-500" title="Trabalhando agora" />}
                      {p.name}
                      {!p.member && <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-amber-50 text-amber-700">FORA DA EQUIPE</span>}
                    </div>
                    <div className="text-xs text-slate-400">
                      {p.member ? `desde ${dateBr(p.member.start_date)}${p.member.end_date ? ` até ${dateBr(p.member.end_date)}` : ''}` : 'batidas não contam'}
                      {' · '}{p.punches_count} batida(s)
                    </div>
                  </td>
                  <td className="px-3 py-2.5 text-right tabular-nums">{fmtMin(t.worked_min)}</td>
                  <td className="px-3 py-2.5 text-right tabular-nums text-slate-500">{fmtMin(t.expected_min)}</td>
                  <td className={`px-3 py-2.5 text-right tabular-nums ${t.extra_min ? 'text-emerald-600' : 'text-slate-400'}`}>{fmtMin(t.extra_min)}</td>
                  <td className={`px-3 py-2.5 text-right tabular-nums ${t.extra_dsr_min ? 'text-emerald-600' : 'text-slate-400'}`}>{fmtMin(t.extra_dsr_min)}</td>
                  <td className={`px-3 py-2.5 text-right tabular-nums ${t.debit_min ? 'text-rose-600' : 'text-slate-400'}`}>{fmtMin(t.debit_min)}</td>
                  <td className={`px-3 py-2.5 text-right tabular-nums ${t.absences ? 'text-rose-600 font-semibold' : 'text-slate-400'}`}>{t.absences}</td>
                  <td className={`px-3 py-2.5 text-right tabular-nums font-semibold ${saldoCls(t.balance_min)}`}>{fmtSaldo(t.balance_min)}</td>
                  <td className="px-3 py-2.5 text-xs">
                    {t.incomplete > 0 && <div className="text-amber-600 font-semibold">{t.incomplete} dia(s) sem saída</div>}
                    {p.alerts_count > 0 && <div className="text-amber-700">{p.alerts_count} alerta(s)</div>}
                    {p.adjustments > 0 && <div className="text-violet-600">{p.adjustments} ajuste(s) do adm</div>}
                    {!t.incomplete && !p.alerts_count && !p.adjustments && <span className="text-slate-300">—</span>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* contabilidade */}
      <section className="bg-white border border-slate-200 rounded-xl p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h3 className="font-bold text-slate-800 flex items-center gap-2"><Send className="w-4 h-4 text-sky-600" /> Enviar para a contabilidade — {monthLabel(ym)}</h3>
            <p className="text-xs text-slate-500 mt-0.5">
              {fechado ? 'Mês fechado.' : 'Mês em andamento: os totais vão até ontem.'} Horas em HH:MM, com a tolerância da CLT já aplicada.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <button disabled={!!exporting} onClick={() => exportar('resumo')} className="flex items-center gap-1.5 px-3 py-2 rounded-lg bg-sky-600 text-white text-sm font-semibold hover:bg-sky-700 disabled:opacity-50">
              {exporting === 'resumo' ? <Loader2 className="w-4 h-4 animate-spin" /> : <FileSpreadsheet className="w-4 h-4" />} Resumo (planilha)
            </button>
            <button disabled={!!exporting} onClick={() => exportar('detalhado')} className="flex items-center gap-1.5 px-3 py-2 rounded-lg border border-slate-200 text-sm font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50">
              {exporting === 'detalhado' ? <Loader2 className="w-4 h-4 animate-spin" /> : <FileSpreadsheet className="w-4 h-4" />} Detalhado dia a dia
            </button>
            <button disabled={!!exporting} onClick={() => exportar('imprimir')} className="flex items-center gap-1.5 px-3 py-2 rounded-lg border border-slate-200 text-sm font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50">
              {exporting === 'imprimir' ? <Loader2 className="w-4 h-4 animate-spin" /> : <Printer className="w-4 h-4" />} Imprimir espelhos
            </button>
          </div>
        </div>
        {pendentes > 0 && (
          <p className="mt-3 text-xs font-semibold text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 flex items-center gap-1.5">
            <AlertTriangle className="w-3.5 h-3.5" /> {pendentes} dia(s) sem batida de saída não entram no total. Ajuste antes de enviar.
          </p>
        )}
      </section>
    </div>
  );
}

/* ════════════════════════════════════════════════════════════
   Espelho de um funcionário (adm)
════════════════════════════════════════════════════════════ */
function PersonView({
  person, ym, onYm, onBack,
}: {
  person: Person;
  ym: string;
  onYm: (ym: string) => void;
  onBack: () => void;
}) {
  const tenant = useTenant();
  const [data, setData] = useState<Espelho | null>(null);
  const [loading, setLoading] = useState(true);
  const [detail, setDetail] = useState<{ p: Punch; date: string } | null>(null);
  const [addDate, setAddDate] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await api.get<Espelho>(`/ponto/users/${person.user_id}`, { params: { month: ym } });
      setData(res.data);
    } catch (e) {
      showError(apiErr(e, 'Falha ao carregar o espelho.'));
    } finally {
      setLoading(false);
    }
  }, [person.user_id, ym]);

  useEffect(() => { setLoading(true); load(); }, [load]);

  const vigente = data?.schedules[0];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <button onClick={onBack} className="flex items-center gap-1 text-sm text-slate-500 hover:text-slate-700">
            <ChevronLeft className="w-4 h-4" /> Equipe
          </button>
          <h2 className="text-lg font-bold text-slate-800 mt-1">{person.name}</h2>
          {data?.member ? (
            <p className="text-xs text-slate-500">
              No ponto desde {dateBr(data.member.start_date)}{data.member.end_date ? ` até ${dateBr(data.member.end_date)}` : ''}
              {vigente ? ` · horário desde ${dateBr(vigente.valid_from)}: ` : ''}
              {vigente && vigente.days.map((d, i) => (d ? `${WEEKDAYS[i]} ${scheduleText(d)}` : null)).filter(Boolean).join(' · ')}
              {' '}<Link href="/atendimento/settings/ponto" className="text-sky-600 font-semibold hover:underline">alterar</Link>
            </p>
          ) : data ? (
            <p className="text-xs text-amber-700">Não está na equipe do ponto — as batidas aparecem, mas não contam.</p>
          ) : null}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <MonthNav ym={ym} maxYm={currentYm()} onChange={onYm} />
          {data && <EspelhoActions data={data} clinic={tenant?.name ?? 'Clínica'} />}
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
            onAdd={(date) => setAddDate(date)}
          />
          <p className="text-xs text-slate-400">
            Clique numa batida para ver o local no mapa ou anular (com motivo). Use o + para lançar uma batida esquecida.
            Nada é apagado: anuladas e lançadas ficam no histórico do funcionário e no espelho.
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
              const res = await api.post<Espelho>(`/ponto/users/${person.user_id}/punches`, { date: addDate, time, note });
              if (res.data.ym === ym) setData(res.data);
              showSuccess(`Batida das ${time} lançada.`);
              setAddDate(null);
            } catch (e) {
              showError(apiErr(e, 'Não foi possível lançar.'));
            }
          }}
        />
      )}
    </div>
  );
}


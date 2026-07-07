'use client';

import { useEffect, useState, useCallback } from 'react';
import {
  Wallet, Plus, X, Loader2, Lock, Check, RotateCcw, Banknote, CreditCard,
  Landmark, ArrowLeftRight, Trash2, ShieldCheck, TrendingUp, TrendingDown,
  ChevronLeft, Settings2, CircleDollarSign,
} from 'lucide-react';
import api from '@/lib/api';
import { showError, showSuccess } from '@/lib/toast';
import { useUserPermissions } from '@/lib/useUserPermissions';

/* ── helpers ─────────────────────────────────────────────── */
const brl = (v: any) =>
  `R$ ${(Number(v) || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

// Parse robusto de valor digitado em pt-BR: aceita "1.234,56", "1234,56",
// "1234.56" e "1234". Retorna null se vazio/inválido (pra "não informado").
const parseMoney = (s: string): number | null => {
  const raw = String(s ?? '').trim();
  if (!raw) return null;
  let v = raw.replace(/[^\d.,-]/g, '');
  if (v.includes(',')) v = v.replace(/\./g, '').replace(',', '.'); // 1.234,56 -> 1234.56
  const n = Number(v);
  return isNaN(n) ? null : n;
};

const dayLabel = (iso: string) => {
  try {
    const d = new Date(iso);
    return d.toLocaleDateString('pt-BR', { weekday: 'short', day: '2-digit', month: '2-digit' });
  } catch { return iso?.slice(0, 10) ?? '--'; }
};

const timeLabel = (iso: string) => {
  try { return new Date(iso).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }); }
  catch { return ''; }
};

const METHODS = [
  { key: 'DINHEIRO', label: 'Dinheiro', bucket: 'cash', Icon: Banknote },
  { key: 'CARTAO', label: 'Cartão', bucket: 'card', Icon: CreditCard },
  { key: 'PIX', label: 'PIX', bucket: 'pix', Icon: Landmark },
  { key: 'TRANSFERENCIA', label: 'Transferência', bucket: 'transfer', Icon: ArrowLeftRight },
] as const;

const STATUS_META: Record<string, { label: string; cls: string }> = {
  ABERTO:    { label: 'Aberto',                cls: 'bg-emerald-50 text-emerald-700 border-emerald-200' },
  FECHADO:   { label: 'Aguardando validação',  cls: 'bg-amber-50 text-amber-700 border-amber-200' },
  VALIDADO:  { label: 'Validado',              cls: 'bg-sky-50 text-sky-700 border-sky-200' },
  DEVOLVIDO: { label: 'Devolvido',             cls: 'bg-rose-50 text-rose-700 border-rose-200' },
};

/* ── types (leves) ───────────────────────────────────────── */
interface Account { id: string; name: string; kind: string; is_gateway: boolean; active: boolean }
interface Movement {
  id: string; type: 'RECEITA' | 'DESPESA'; description: string; amount: string; date: string;
  payment_method: string | null; reference_id: string | null;
  gateway_charge?: { received_in_cash: boolean } | null;
  account: { id: string; name: string; kind: string } | null;
  lead: { id: string; name: string } | null;
}
interface Closing {
  id: string; cash_date: string; status: string;
  closing_notes?: string | null; validation_notes?: string | null;
  counted_cash?: string | null; counted_card?: string | null; counted_pix?: string | null; counted_transfer?: string | null;
  expected_cash?: string | null; expected_card?: string | null; expected_pix?: string | null; expected_transfer?: string | null;
  opened_by?: { name: string } | null; closed_by?: { name: string } | null; validated_by?: { name: string } | null;
  transactions?: Movement[];
  totals?: Totals;
}
interface Totals { by: { cash: number; card: number; pix: number; transfer: number; gateway: number }; entradas: number; saidas: number; saldo: number }
interface TodayData { cash_date: string; closing: Closing | null; accounts: Account[]; movements: Movement[]; totals: Totals }

/* ════════════════════════════════════════════════════════════
   Página
════════════════════════════════════════════════════════════ */
export default function CaixaPage() {
  const { hasPermission, ready } = useUserPermissions();
  const canOperate = hasPermission('operate_cash');
  const canValidate = hasPermission('manage_financial');
  const [view, setView] = useState<'dia' | 'fechamentos'>('dia');

  if (ready && !canOperate) {
    return (
      <div className="max-w-md mx-auto px-4 py-20 text-center">
        <Lock className="w-10 h-10 mx-auto text-slate-300" />
        <p className="mt-4 text-slate-600">Você não tem acesso ao Caixa. Peça ao administrador a permissão <b>Operar caixa</b>.</p>
      </div>
    );
  }

  return (
    <div className="max-w-5xl mx-auto px-4 py-6">
      <div className="flex items-center justify-between gap-3 mb-5">
        <div className="flex items-center gap-2.5">
          <div className="w-10 h-10 rounded-xl bg-emerald-100 text-emerald-700 grid place-items-center"><Wallet className="w-5 h-5" /></div>
          <div>
            <h1 className="text-xl font-bold text-slate-800 leading-none">Caixa</h1>
            <p className="text-sm text-slate-500 mt-0.5">Entradas, saídas e fechamento do dia.</p>
          </div>
        </div>
        <div className="flex bg-slate-100 rounded-lg p-1 text-sm font-semibold">
          <button onClick={() => setView('dia')} className={`px-3.5 py-1.5 rounded-md transition ${view === 'dia' ? 'bg-white shadow text-slate-800' : 'text-slate-500'}`}>Caixa do dia</button>
          <button onClick={() => setView('fechamentos')} className={`px-3.5 py-1.5 rounded-md transition ${view === 'fechamentos' ? 'bg-white shadow text-slate-800' : 'text-slate-500'}`}>Fechamentos</button>
        </div>
      </div>

      {view === 'dia' ? <DiaView /> : <FechamentosView canValidate={canValidate} canOperate={canOperate} />}
    </div>
  );
}

/* ════════════════════════════════════════════════════════════
   Caixa do dia
════════════════════════════════════════════════════════════ */
function DiaView() {
  const [data, setData] = useState<TodayData | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [addDir, setAddDir] = useState<'ENTRADA' | 'SAIDA' | null>(null);
  const [closing, setClosing] = useState(false);
  const [showContas, setShowContas] = useState(false);

  const load = useCallback(async () => {
    setErr(null);
    try {
      const res = await api.get<TodayData>('/caixa/today');
      setData(res.data);
    } catch (e: any) {
      const status = e?.response?.status;
      const msg = e?.response?.data?.message || e?.message || 'Falha ao carregar o caixa.';
      setErr(status ? `[${status}] ${msg}` : msg);
    } finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  if (loading) return <div className="py-20 grid place-items-center"><Loader2 className="w-6 h-6 animate-spin text-emerald-500" /></div>;
  if (err) return (
    <div className="max-w-lg mx-auto mt-10 text-center bg-rose-50 border border-rose-200 rounded-xl p-6">
      <p className="font-semibold text-rose-700">Não consegui abrir o caixa</p>
      <p className="text-sm text-rose-600 mt-2 break-words">{err}</p>
      <button onClick={() => { setLoading(true); load(); }} className="mt-4 px-4 py-2 rounded-lg bg-rose-600 text-white text-sm font-semibold hover:bg-rose-700">Tentar de novo</button>
    </div>
  );
  if (!data) return null;

  const status = data.closing?.status || 'ABERTO';
  const st = STATUS_META[status] ?? STATUS_META.ABERTO;
  const isOpen = status === 'ABERTO' || status === 'DEVOLVIDO';
  const { by } = data.totals;

  return (
    <div className="space-y-5">
      {/* status + saldo */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <span className="text-sm text-slate-500">Hoje · {dayLabel(data.cash_date)}</span>
          <span className={`text-xs font-bold px-2.5 py-1 rounded-full border ${st.cls}`}>{st.label}</span>
        </div>
        <button onClick={() => setShowContas(true)} className="text-sm text-slate-500 hover:text-slate-700 flex items-center gap-1.5">
          <Settings2 className="w-4 h-4" /> Contas
        </button>
      </div>

      {/* totais por forma */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {METHODS.map(({ key, label, bucket, Icon }) => (
          <div key={key} className="bg-white border border-slate-200 rounded-xl p-3.5">
            <div className="flex items-center gap-1.5 text-slate-400 text-xs font-semibold uppercase tracking-wide"><Icon className="w-3.5 h-3.5" /> {label}</div>
            <div className="text-lg font-bold text-slate-800 mt-1 tabular-nums">{brl((by as any)[bucket])}</div>
          </div>
        ))}
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <div className="bg-emerald-50 border border-emerald-100 rounded-xl p-3.5">
          <div className="flex items-center gap-1.5 text-emerald-600 text-xs font-semibold uppercase tracking-wide"><TrendingUp className="w-3.5 h-3.5" /> Entradas</div>
          <div className="text-lg font-bold text-emerald-700 mt-1 tabular-nums">{brl(data.totals.entradas)}</div>
        </div>
        <div className="bg-rose-50 border border-rose-100 rounded-xl p-3.5">
          <div className="flex items-center gap-1.5 text-rose-500 text-xs font-semibold uppercase tracking-wide"><TrendingDown className="w-3.5 h-3.5" /> Saídas</div>
          <div className="text-lg font-bold text-rose-600 mt-1 tabular-nums">{brl(data.totals.saidas)}</div>
        </div>
        <div className="bg-slate-800 rounded-xl p-3.5">
          <div className="flex items-center gap-1.5 text-slate-300 text-xs font-semibold uppercase tracking-wide"><CircleDollarSign className="w-3.5 h-3.5" /> Saldo do dia</div>
          <div className="text-lg font-bold text-white mt-1 tabular-nums">{brl(data.totals.saldo)}</div>
        </div>
      </div>

      {by.gateway ? (
        <p className="text-xs text-slate-400 -mt-2">Recebido pelo Asaas (online): <b className="text-slate-500">{brl(by.gateway)}</b> — entra no relatório, mas não conta na conferência física.</p>
      ) : null}

      {/* ações */}
      {status === 'DEVOLVIDO' && (
        <div className="flex items-start gap-2 text-sm bg-rose-50 border border-rose-200 rounded-lg px-4 py-3 text-rose-700">
          <RotateCcw className="w-4 h-4 mt-0.5 shrink-0" />
          <span>O administrador <b>devolveu</b> este caixa pra corrigir{data.closing?.validation_notes ? `: “${data.closing.validation_notes}”` : '.'} Ajuste os lançamentos e <b>feche de novo</b>.</span>
        </div>
      )}
      {isOpen ? (
        <div className="flex flex-wrap gap-2.5">
          <button onClick={() => setAddDir('ENTRADA')} className="flex items-center gap-1.5 px-4 py-2.5 rounded-lg bg-emerald-600 text-white font-semibold text-sm hover:bg-emerald-700"><Plus className="w-4 h-4" /> Entrada</button>
          <button onClick={() => setAddDir('SAIDA')} className="flex items-center gap-1.5 px-4 py-2.5 rounded-lg bg-white border border-slate-300 text-slate-700 font-semibold text-sm hover:bg-slate-50"><TrendingDown className="w-4 h-4" /> Saída</button>
          <button onClick={() => setClosing(true)} className="flex items-center gap-1.5 px-4 py-2.5 rounded-lg bg-slate-800 text-white font-semibold text-sm hover:bg-slate-900 ml-auto"><Lock className="w-4 h-4" /> Fechar caixa</button>
        </div>
      ) : (
        <div className="flex items-center gap-2 text-sm text-slate-500 bg-slate-50 border border-slate-200 rounded-lg px-4 py-3">
          <Check className="w-4 h-4 text-emerald-500" />
          Caixa {status === 'VALIDADO' ? 'validado' : 'fechado'}{data.closing?.closed_by ? ` por ${data.closing.closed_by.name}` : ''}. {status === 'FECHADO' ? 'Aguardando validação do administrador.' : ''}
        </div>
      )}

      {/* movimentos */}
      <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
        <div className="px-4 py-3 border-b border-slate-100 text-sm font-semibold text-slate-600">Movimentos do dia ({data.movements.length})</div>
        {data.movements.length === 0 ? (
          <div className="px-4 py-10 text-center text-slate-400 text-sm">Nenhum lançamento hoje ainda.</div>
        ) : (
          <ul className="divide-y divide-slate-50">
            {data.movements.map((m) => (
              <li key={m.id} className="flex items-center justify-between gap-3 px-4 py-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className={`text-[10px] font-bold uppercase px-1.5 py-0.5 rounded ${m.type === 'DESPESA' ? 'bg-rose-100 text-rose-600' : 'bg-emerald-100 text-emerald-700'}`}>{m.type === 'DESPESA' ? 'Saída' : 'Entrada'}</span>
                    {m.gateway_charge && (m.gateway_charge.received_in_cash
                      ? <span className="text-[10px] font-bold uppercase px-1.5 py-0.5 rounded bg-violet-100 text-violet-600">Balcão</span>
                      : <span className="text-[10px] font-bold uppercase px-1.5 py-0.5 rounded bg-sky-100 text-sky-600">Asaas</span>)}
                    <span className="text-sm text-slate-700 truncate">{m.description}{m.lead ? ` · ${m.lead.name}` : ''}</span>
                  </div>
                  <div className="text-xs text-slate-400 mt-0.5">{timeLabel(m.date)} · {m.payment_method || '--'}{m.account ? ` · ${m.account.name}` : ''}</div>
                </div>
                <div className="flex items-center gap-2.5 shrink-0">
                  <span className={`text-sm font-bold tabular-nums ${m.type === 'DESPESA' ? 'text-rose-600' : 'text-slate-800'}`}>{m.type === 'DESPESA' ? '− ' : ''}{brl(m.amount)}</span>
                  {isOpen && !m.gateway_charge && !m.reference_id && (
                    <button onClick={() => removeMovement(m.id, load)} className="text-slate-300 hover:text-rose-500" title="Remover lançamento"><Trash2 className="w-4 h-4" /></button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      {addDir && <AddMovementModal direction={addDir} accounts={data.accounts} onClose={() => setAddDir(null)} onSaved={() => { setAddDir(null); load(); }} />}
      {closing && <CloseModal totals={data.totals} closingId={data.closing?.id} onClose={() => setClosing(false)} onSaved={() => { setClosing(false); load(); }} />}
      {showContas && <ContasModal accounts={data.accounts} onClose={() => setShowContas(false)} onChanged={load} />}
    </div>
  );
}

async function removeMovement(id: string, reload: () => void) {
  if (!confirm('Remover este lançamento do caixa?')) return;
  try { await api.delete(`/caixa/movements/${id}`); showSuccess('Lançamento removido.'); reload(); }
  catch (e: any) { showError(e?.response?.data?.message || 'Não foi possível remover.'); }
}

/* ── Modal: adicionar entrada/saída ──────────────────────── */
function AddMovementModal({ direction, accounts, onClose, onSaved }: { direction: 'ENTRADA' | 'SAIDA'; accounts: Account[]; onClose: () => void; onSaved: () => void }) {
  const isSaida = direction === 'SAIDA';
  const [amount, setAmount] = useState('');
  const [method, setMethod] = useState('DINHEIRO');
  const [accountId, setAccountId] = useState(accounts[0]?.id || '');
  const [description, setDescription] = useState('');
  const [saving, setSaving] = useState(false);

  const save = async () => {
    const val = parseMoney(amount);
    if (!val || val <= 0) return showError('Informe um valor válido.');
    if (!accountId) return showError('Escolha a conta.');
    setSaving(true);
    try {
      await api.post('/caixa/movements', { direction, amount: val, method, account_id: accountId, description: description.trim() || undefined });
      showSuccess(isSaida ? 'Saída registrada.' : 'Entrada registrada.');
      onSaved();
    } catch (e: any) { showError(e?.response?.data?.message || 'Não foi possível lançar.'); }
    finally { setSaving(false); }
  };

  return (
    <Modal onClose={onClose} title={isSaida ? 'Nova saída (sangria / troco)' : 'Nova entrada'}>
      <label className="block text-sm font-semibold text-slate-600 mb-1">Valor</label>
      <input autoFocus inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0,00" className="w-full border border-slate-300 rounded-lg px-3 py-2.5 text-lg font-bold tabular-nums mb-4" />

      <label className="block text-sm font-semibold text-slate-600 mb-1.5">Forma de pagamento</label>
      <div className="grid grid-cols-2 gap-2 mb-4">
        {METHODS.map(({ key, label, Icon }) => (
          <button key={key} onClick={() => setMethod(key)} className={`flex items-center gap-2 px-3 py-2 rounded-lg border text-sm font-medium ${method === key ? 'border-emerald-500 bg-emerald-50 text-emerald-700' : 'border-slate-200 text-slate-600'}`}>
            <Icon className="w-4 h-4" /> {label}
          </button>
        ))}
      </div>

      <label className="block text-sm font-semibold text-slate-600 mb-1">Conta</label>
      <select value={accountId} onChange={(e) => setAccountId(e.target.value)} className="w-full border border-slate-300 rounded-lg px-3 py-2.5 mb-4 bg-white">
        {accounts.filter((a) => a.active).map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
      </select>

      <label className="block text-sm font-semibold text-slate-600 mb-1">Descrição <span className="font-normal text-slate-400">(opcional)</span></label>
      <input value={description} onChange={(e) => setDescription(e.target.value)} placeholder={isSaida ? 'Ex: sangria pro banco' : 'Ex: sinal João'} className="w-full border border-slate-300 rounded-lg px-3 py-2.5 mb-5" />

      <button disabled={saving} onClick={save} className={`w-full py-2.5 rounded-lg text-white font-semibold ${isSaida ? 'bg-rose-600 hover:bg-rose-700' : 'bg-emerald-600 hover:bg-emerald-700'} disabled:opacity-60 flex items-center justify-center gap-2`}>
        {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />} {isSaida ? 'Registrar saída' : 'Registrar entrada'}
      </button>
    </Modal>
  );
}

/* ── Modal: fechar o caixa ───────────────────────────────── */
function CloseModal({ totals, closingId, onClose, onSaved }: { totals: Totals; closingId?: string; onClose: () => void; onSaved: () => void }) {
  const [counted, setCounted] = useState<Record<string, string>>({ cash: '', card: '', pix: '', transfer: '' });
  const [notes, setNotes] = useState('');
  const [saving, setSaving] = useState(false);

  const set = (b: string, v: string) => setCounted((p) => ({ ...p, [b]: v }));

  const save = async () => {
    setSaving(true);
    try {
      // Campo em branco = "não contei" → manda undefined (não 0, que viraria −esperado).
      await api.post('/caixa/close', {
        closing_id: closingId,
        counted_cash: parseMoney(counted.cash) ?? undefined,
        counted_card: parseMoney(counted.card) ?? undefined,
        counted_pix: parseMoney(counted.pix) ?? undefined,
        counted_transfer: parseMoney(counted.transfer) ?? undefined,
        closing_notes: notes.trim() || undefined,
      });
      showSuccess('Caixa fechado. Vai pra validação do administrador.');
      onSaved();
    } catch (e: any) { showError(e?.response?.data?.message || 'Não foi possível fechar.'); }
    finally { setSaving(false); }
  };

  return (
    <Modal onClose={onClose} title="Fechar o caixa do dia">
      <p className="text-sm text-slate-500 mb-4">Confira o que você <b>contou</b> de cada forma. A divergência aparece na hora — não trava, o admin valida com a observação.</p>
      <div className="space-y-2.5 mb-4">
        {METHODS.map(({ key, label, bucket, Icon }) => {
          const exp = (totals.by as any)[bucket] as number;
          const cntN = parseMoney(counted[bucket]);
          const touched = cntN !== null;
          const diff = touched ? Math.round((cntN! - exp) * 100) / 100 : 0;
          return (
            <div key={key} className="flex items-center gap-3">
              <div className="flex items-center gap-1.5 w-32 text-sm text-slate-600"><Icon className="w-4 h-4 text-slate-400" /> {label}</div>
              <div className="text-xs text-slate-400 w-24 text-right tabular-nums">esperado<br /><b className="text-slate-600 text-sm">{brl(exp)}</b></div>
              <input inputMode="decimal" value={counted[bucket]} onChange={(e) => set(bucket, e.target.value)} placeholder="contado" className="flex-1 border border-slate-300 rounded-lg px-3 py-2 tabular-nums" />
              <div className={`w-20 text-right text-sm font-bold tabular-nums ${!touched ? 'text-slate-300' : diff === 0 ? 'text-emerald-600' : 'text-rose-600'}`}>
                {touched ? (diff === 0 ? 'ok' : (diff > 0 ? '+' : '') + brl(diff)) : '—'}
              </div>
            </div>
          );
        })}
      </div>
      <label className="block text-sm font-semibold text-slate-600 mb-1">Observação <span className="font-normal text-slate-400">(opcional)</span></label>
      <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} placeholder="Ex: sobrou R$ 5 de troco não registrado" className="w-full border border-slate-300 rounded-lg px-3 py-2 mb-5 resize-none" />
      <button disabled={saving} onClick={save} className="w-full py-2.5 rounded-lg bg-slate-800 text-white font-semibold hover:bg-slate-900 disabled:opacity-60 flex items-center justify-center gap-2">
        {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Lock className="w-4 h-4" />} Fechar e enviar pra validação
      </button>
    </Modal>
  );
}

/* ── Modal: contas ───────────────────────────────────────── */
function ContasModal({ accounts, onClose, onChanged }: { accounts: Account[]; onClose: () => void; onChanged: () => void }) {
  const [list, setList] = useState(accounts);
  const [newName, setNewName] = useState('');
  const [newKind, setNewKind] = useState('CAIXA');
  const [busy, setBusy] = useState(false);

  const rename = async (id: string, name: string) => {
    try { await api.patch(`/caixa/accounts/${id}`, { name }); onChanged(); }
    catch (e: any) { showError(e?.response?.data?.message || 'Falha ao renomear.'); }
  };
  const add = async () => {
    if (!newName.trim()) return;
    setBusy(true);
    try {
      const res = await api.post<Account>('/caixa/accounts', { name: newName.trim(), kind: newKind });
      setList((p) => [...p, res.data]); setNewName(''); onChanged();
    } catch (e: any) { showError(e?.response?.data?.message || 'Falha ao criar conta.'); }
    finally { setBusy(false); }
  };

  return (
    <Modal onClose={onClose} title="Contas do caixa">
      <p className="text-sm text-slate-500 mb-4">Onde o dinheiro cai. Renomeie do jeito da sua clínica (nome do banco, maquininha…).</p>
      <div className="space-y-2 mb-4">
        {list.map((a) => (
          <div key={a.id} className="flex items-center gap-2">
            <input defaultValue={a.name} onBlur={(e) => e.target.value.trim() && e.target.value !== a.name && rename(a.id, e.target.value.trim())} className="flex-1 border border-slate-200 rounded-lg px-3 py-2 text-sm" />
            <span className="text-[10px] font-bold uppercase text-slate-400 w-14">{a.kind}</span>
            {a.is_gateway && <span className="text-[10px] font-bold uppercase px-1.5 py-0.5 rounded bg-sky-100 text-sky-600">Asaas</span>}
          </div>
        ))}
      </div>
      <div className="flex items-center gap-2 border-t border-slate-100 pt-3">
        <input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="Nova conta" className="flex-1 border border-slate-300 rounded-lg px-3 py-2 text-sm" />
        <select value={newKind} onChange={(e) => setNewKind(e.target.value)} className="border border-slate-300 rounded-lg px-2 py-2 text-sm bg-white">
          <option value="CAIXA">Dinheiro</option>
          <option value="BANCO">Banco</option>
          <option value="CARTAO">Cartão</option>
        </select>
        <button disabled={busy} onClick={add} className="px-3 py-2 rounded-lg bg-emerald-600 text-white text-sm font-semibold disabled:opacity-60"><Plus className="w-4 h-4" /></button>
      </div>
    </Modal>
  );
}

/* ════════════════════════════════════════════════════════════
   Fechamentos (admin valida)
════════════════════════════════════════════════════════════ */
function FechamentosView({ canValidate, canOperate }: { canValidate: boolean; canOperate: boolean }) {
  const [list, setList] = useState<Closing[]>([]);
  const [loading, setLoading] = useState(true);
  const [detail, setDetail] = useState<Closing | null>(null);

  const load = useCallback(async () => {
    try { const res = await api.get<Closing[]>('/caixa/closings'); setList(res.data); }
    catch (e: any) { showError(e?.response?.data?.message || 'Falha ao carregar.'); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const openDetail = async (id: string) => {
    try { const res = await api.get<Closing>(`/caixa/closings/${id}`); setDetail(res.data); }
    catch (e: any) { showError(e?.response?.data?.message || 'Falha ao abrir.'); }
  };

  if (loading) return <div className="py-20 grid place-items-center"><Loader2 className="w-6 h-6 animate-spin text-emerald-500" /></div>;
  if (detail) return <ClosingDetail closing={detail} canValidate={canValidate} canOperate={canOperate} onBack={() => setDetail(null)} onChanged={() => { setDetail(null); load(); }} />;

  return (
    <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
      {list.length === 0 ? (
        <div className="px-4 py-14 text-center text-slate-400 text-sm">Nenhum fechamento ainda.</div>
      ) : (
        <ul className="divide-y divide-slate-50">
          {list.map((c) => {
            const st = STATUS_META[c.status] ?? STATUS_META.ABERTO;
            return (
              <li key={c.id}>
                <button onClick={() => openDetail(c.id)} className="w-full flex items-center justify-between gap-3 px-4 py-3.5 hover:bg-slate-50 text-left">
                  <div className="min-w-0">
                    <div className="font-semibold text-slate-800 text-sm capitalize">{dayLabel(c.cash_date)}</div>
                    <div className="text-xs text-slate-400 mt-0.5">{c.closed_by ? `Fechado por ${c.closed_by.name}` : c.opened_by ? `Aberto por ${c.opened_by.name}` : 'Movimento do dia'}</div>
                  </div>
                  <div className="flex items-center gap-4 shrink-0">
                    <div className="text-right">
                      <div className="text-sm font-bold text-slate-800 tabular-nums">{brl(c.totals?.saldo ?? 0)}</div>
                      {c.totals && c.totals.entradas > 0 && <div className="text-[11px] text-emerald-600 tabular-nums">+{brl(c.totals.entradas)} entrou</div>}
                    </div>
                    <span className={`text-xs font-bold px-2.5 py-1 rounded-full border ${st.cls}`}>{st.label}</span>
                  </div>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function ClosingDetail({ closing, canValidate, canOperate, onBack, onChanged }: { closing: Closing; canValidate: boolean; canOperate: boolean; onBack: () => void; onChanged: () => void }) {
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [reclose, setReclose] = useState(false);
  const st = STATUS_META[closing.status] ?? STATUS_META.ABERTO;
  const expectedTotals: Totals = {
    by: {
      cash: Number(closing.expected_cash) || 0, card: Number(closing.expected_card) || 0,
      pix: Number(closing.expected_pix) || 0, transfer: Number(closing.expected_transfer) || 0, gateway: 0,
    },
    entradas: 0, saidas: 0, saldo: 0,
  };

  const act = async (kind: 'validate' | 'return') => {
    setBusy(true);
    try {
      await api.post(`/caixa/closings/${closing.id}/${kind}`, { validation_notes: notes.trim() || undefined });
      showSuccess(kind === 'validate' ? 'Caixa validado.' : 'Devolvido pra recepção corrigir.');
      onChanged();
    } catch (e: any) { showError(e?.response?.data?.message || 'Não foi possível.'); }
    finally { setBusy(false); }
  };

  const rows = METHODS.map(({ key, label, bucket }) => {
    const exp = Number((closing as any)[`expected_${bucket}`]) || 0;
    const cnt = (closing as any)[`counted_${bucket}`];
    const cntN = cnt == null ? null : Number(cnt);
    const diff = cntN == null ? null : cntN - exp;
    return { key, label, exp, cnt: cntN, diff };
  });

  return (
    <div className="space-y-4">
      <button onClick={onBack} className="flex items-center gap-1 text-sm text-slate-500 hover:text-slate-700"><ChevronLeft className="w-4 h-4" /> Voltar</button>
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-bold text-slate-800 capitalize">{dayLabel(closing.cash_date)}</h2>
        <span className={`text-xs font-bold px-2.5 py-1 rounded-full border ${st.cls}`}>{st.label}</span>
      </div>

      <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
        <table className="w-full text-sm">
          <thead><tr className="text-xs uppercase text-slate-400 border-b border-slate-100">
            <th className="text-left font-semibold px-4 py-2.5">Forma</th>
            <th className="text-right font-semibold px-4 py-2.5">Esperado</th>
            <th className="text-right font-semibold px-4 py-2.5">Contado</th>
            <th className="text-right font-semibold px-4 py-2.5">Diferença</th>
          </tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.key} className="border-b border-slate-50 last:border-0">
                <td className="px-4 py-2.5 text-slate-600">{r.label}</td>
                <td className="px-4 py-2.5 text-right tabular-nums text-slate-700">{brl(r.exp)}</td>
                <td className="px-4 py-2.5 text-right tabular-nums text-slate-700">{r.cnt == null ? '—' : brl(r.cnt)}</td>
                <td className={`px-4 py-2.5 text-right tabular-nums font-semibold ${r.diff == null ? 'text-slate-300' : r.diff === 0 ? 'text-emerald-600' : 'text-rose-600'}`}>{r.diff == null ? '—' : r.diff === 0 ? 'ok' : (r.diff > 0 ? '+' : '') + brl(r.diff)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {closing.closing_notes && <p className="text-sm text-slate-500"><b>Obs. da recepção:</b> {closing.closing_notes}</p>}
      {closing.validated_by && <p className="text-sm text-slate-500"><ShieldCheck className="w-4 h-4 inline text-sky-500" /> Validado por {closing.validated_by.name}{closing.validation_notes ? ` — ${closing.validation_notes}` : ''}</p>}

      {closing.transactions && closing.transactions.length > 0 && (
        <details className="bg-white border border-slate-200 rounded-xl">
          <summary className="px-4 py-3 text-sm font-semibold text-slate-600 cursor-pointer">Movimentos ({closing.transactions.length})</summary>
          <ul className="divide-y divide-slate-50 border-t border-slate-100">
            {closing.transactions.map((m) => (
              <li key={m.id} className="flex items-center justify-between px-4 py-2.5 text-sm">
                <span className="text-slate-600 truncate">{m.type === 'DESPESA' ? '↓ ' : '↑ '}{m.description}</span>
                <span className={`tabular-nums font-semibold ${m.type === 'DESPESA' ? 'text-rose-600' : 'text-slate-700'}`}>{brl(m.amount)}</span>
              </li>
            ))}
          </ul>
        </details>
      )}

      {canValidate && closing.status === 'FECHADO' && (
        <div className="bg-slate-50 border border-slate-200 rounded-xl p-4 space-y-3">
          <input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Observação (ex: divergência aceita)" className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm" />
          <div className="flex gap-2.5">
            <button disabled={busy} onClick={() => act('validate')} className="flex-1 flex items-center justify-center gap-1.5 py-2.5 rounded-lg bg-emerald-600 text-white font-semibold text-sm hover:bg-emerald-700 disabled:opacity-60"><Check className="w-4 h-4" /> Validar</button>
            <button disabled={busy} onClick={() => act('return')} className="flex items-center justify-center gap-1.5 px-4 py-2.5 rounded-lg bg-white border border-slate-300 text-slate-600 font-semibold text-sm hover:bg-slate-50 disabled:opacity-60"><RotateCcw className="w-4 h-4" /> Devolver</button>
          </div>
        </div>
      )}

      {canOperate && (closing.status === 'DEVOLVIDO' || closing.status === 'ABERTO') && (
        <button onClick={() => setReclose(true)} className="w-full flex items-center justify-center gap-1.5 py-2.5 rounded-lg bg-slate-800 text-white font-semibold text-sm hover:bg-slate-900">
          <Lock className="w-4 h-4" /> {closing.status === 'DEVOLVIDO' ? 'Corrigir contagem e fechar de novo' : 'Fechar este dia'}
        </button>
      )}
      {reclose && <CloseModal totals={expectedTotals} closingId={closing.id} onClose={() => setReclose(false)} onSaved={() => { setReclose(false); onChanged(); }} />}
    </div>
  );
}

/* ── Modal genérico ──────────────────────────────────────── */
function Modal({ title, children, onClose }: { title: string; children: React.ReactNode; onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-slate-900/40 p-0 sm:p-4" onClick={onClose}>
      <div className="bg-white w-full sm:max-w-md rounded-t-2xl sm:rounded-2xl p-5 max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-4">
          <h3 className="font-bold text-slate-800">{title}</h3>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600"><X className="w-5 h-5" /></button>
        </div>
        {children}
      </div>
    </div>
  );
}

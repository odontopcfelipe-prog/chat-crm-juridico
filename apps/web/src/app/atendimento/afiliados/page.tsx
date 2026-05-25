'use client';

/**
 * Afiliados — Dashboard global do programa de afiliado.
 * Onda 5e v36 (Fase 25).
 *
 * Pagina admin-only que mostra:
 *   - 4 KPIs (ativos, indicacoes do mes, saldo total, saques pendentes)
 *   - Top 5 afiliados do mes
 *   - Tabela completa com todos os afiliados
 *   - Saques pendentes (admin aprova/recusa em batch)
 *
 * Endpoints:
 *   GET /patients/affiliates                      (dashboard)
 *   GET /patients/affiliates/pending-withdrawals  (saques pra aprovar)
 *   POST /patients/:id/affiliate/withdraw/:wid/pay
 *   POST /patients/:id/affiliate/withdraw/:wid/refuse
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  HandCoins, Users, TrendingUp, Wallet, Clock, ExternalLink,
  Trophy, Loader2, RefreshCw, CheckCircle2, XCircle, AlertCircle,
  Plus, Search, UserPlus, X, ArrowRight,
} from 'lucide-react';
import api from '@/lib/api';
import { useRole } from '@/lib/useRole';
import { showError, showSuccess } from '@/lib/toast';

interface Affiliate {
  id: string;
  name: string;
  phone: string | null;
  affiliate_code: string | null;
  commission_pct: number;
  created_at: string;
  indicacoes_total: number;
  indicacoes_mes: number;
  creditado_total: number;
  sacado_total: number;
  pendente_saque: number;
  saldo_disponivel: number;
}

interface Dashboard {
  kpis: {
    total_ativos: number;
    indicacoes_mes: number;
    saldo_total: number;
    saques_pendentes_qtd: number;
    saques_pendentes_valor: number;
  };
  top5: Affiliate[];
  affiliates: Affiliate[];
}

interface PendingWithdrawal {
  id: string;
  patient_id: string;
  patient_name: string;
  patient_phone: string | null;
  affiliate_code: string | null;
  amount: number;
  method: 'PIX' | 'DINHEIRO' | 'CREDITO_TRATAMENTO';
  pix_key: string | null;
  requested_at: string;
  notes: string | null;
}

function brl(v: number) {
  return v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString('pt-BR', { day: '2-digit', month: 'short', year: 'numeric' });
}

export default function AfiliadosPage() {
  const router = useRouter();
  const role = useRole();
  const [loading, setLoading] = useState(true);
  const [data, setData] = useState<Dashboard | null>(null);
  const [pending, setPending] = useState<PendingWithdrawal[]>([]);
  const [processingId, setProcessingId] = useState<string | null>(null);
  // v37 — modal de "Adicionar afiliado" (selecionar existente OU criar novo)
  const [addModalOpen, setAddModalOpen] = useState(false);

  const fetchAll = useCallback(async () => {
    setLoading(true);
    try {
      const [dashRes, pendRes] = await Promise.all([
        api.get('/patients/affiliates'),
        api.get('/patients/affiliates/pending-withdrawals'),
      ]);
      setData(dashRes.data);
      setPending(pendRes.data || []);
    } catch (e: any) {
      showError(e?.response?.data?.message || 'Erro ao carregar dashboard');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (role.isAdmin) fetchAll();
  }, [fetchAll, role.isAdmin]);

  const approveWithdrawal = async (w: PendingWithdrawal) => {
    if (!confirm(`Confirmar pagamento de ${brl(w.amount)} via ${w.method} pra ${w.patient_name}?`)) return;
    setProcessingId(w.id);
    try {
      await api.post(`/patients/${w.patient_id}/affiliate/withdraw/${w.id}/pay`);
      showSuccess('Saque confirmado');
      fetchAll();
    } catch (e: any) {
      showError(e?.response?.data?.message || 'Erro ao confirmar');
    } finally {
      setProcessingId(null);
    }
  };

  const refuseWithdrawal = async (w: PendingWithdrawal) => {
    const reason = prompt(`Motivo da recusa do saque de ${w.patient_name}:`);
    if (reason === null) return;
    setProcessingId(w.id);
    try {
      await api.post(`/patients/${w.patient_id}/affiliate/withdraw/${w.id}/refuse`, { notes: reason });
      showSuccess('Saque recusado');
      fetchAll();
    } catch (e: any) {
      showError(e?.response?.data?.message || 'Erro ao recusar');
    } finally {
      setProcessingId(null);
    }
  };

  if (!role.isAdmin) {
    return (
      <div className="p-6 max-w-2xl mx-auto">
        <div className="bg-amber-500/10 border border-amber-500/30 rounded-xl p-4 text-amber-700 dark:text-amber-300">
          <p className="font-semibold mb-1">Acesso restrito</p>
          <p className="text-sm">Apenas administradores podem ver o dashboard de afiliados.</p>
        </div>
      </div>
    );
  }

  if (loading && !data) {
    return (
      <div className="p-6 flex items-center justify-center text-muted-foreground">
        <Loader2 size={20} className="animate-spin mr-2" /> Carregando…
      </div>
    );
  }

  const kpis = data?.kpis;
  const top5 = data?.top5 ?? [];
  const affiliates = data?.affiliates ?? [];

  return (
    <div className="h-full overflow-y-auto bg-background">
      <div className="w-full p-4 md:p-6 space-y-6">

        {/* Header */}
        <header className="flex items-center justify-between gap-3 flex-wrap">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-emerald-100 dark:bg-emerald-950/40 text-emerald-600 flex items-center justify-center">
              <HandCoins size={20} strokeWidth={2.2} />
            </div>
            <div>
              <h1 className="text-xl font-bold text-foreground">Afiliados</h1>
              <p className="text-xs text-muted-foreground">
                Pacientes parceiros — recebem 3% por indicação fechada
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setAddModalOpen(true)}
              className="inline-flex items-center gap-2 px-3 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white text-sm font-semibold shadow-sm"
              title="Adicionar paciente como afiliado"
            >
              <Plus size={14} strokeWidth={2.5} /> Adicionar afiliado
            </button>
            <button
              onClick={fetchAll}
              disabled={loading}
              className="p-2 rounded-lg text-muted-foreground hover:text-foreground hover:bg-accent"
              title="Atualizar"
            >
              <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
            </button>
          </div>
        </header>

        {addModalOpen && (
          <AddAffiliateModal
            onClose={() => setAddModalOpen(false)}
            onSuccess={(patientId) => {
              setAddModalOpen(false);
              fetchAll();
              // Pula direto pra ficha do novo afiliado na aba Afiliado
              router.push(`/atendimento/pacientes/${patientId}?tab=affiliate`);
            }}
          />
        )}

        {/* KPIs */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <KpiCard
            icon={<Users size={14} />}
            label="Afiliados ativos"
            value={String(kpis?.total_ativos ?? 0)}
            color="emerald"
          />
          <KpiCard
            icon={<TrendingUp size={14} />}
            label="Indicações no mês"
            value={String(kpis?.indicacoes_mes ?? 0)}
            color="sky"
          />
          <KpiCard
            icon={<Wallet size={14} />}
            label="Saldo total a pagar"
            value={brl(kpis?.saldo_total ?? 0)}
            color="orange"
          />
          <KpiCard
            icon={<Clock size={14} />}
            label="Saques pendentes"
            value={
              kpis?.saques_pendentes_qtd
                ? `${kpis.saques_pendentes_qtd} (${brl(kpis.saques_pendentes_valor)})`
                : '0'
            }
            color="amber"
          />
        </div>

        {/* Saques pendentes */}
        {pending.length > 0 && (
          <section className="rounded-xl border-2 border-amber-300 dark:border-amber-800 bg-amber-50/50 dark:bg-amber-950/20 overflow-hidden">
            <header className="flex items-center gap-2 px-4 py-3 bg-amber-100/60 dark:bg-amber-950/40 border-b border-amber-300 dark:border-amber-800">
              <AlertCircle size={14} className="text-amber-700 dark:text-amber-400" />
              <h2 className="text-sm font-bold text-amber-900 dark:text-amber-200">
                Saques pendentes de aprovação ({pending.length})
              </h2>
            </header>
            <table className="w-full text-sm">
              <thead className="bg-amber-100/30 dark:bg-amber-950/10 text-[10px] uppercase tracking-wider text-amber-700 dark:text-amber-400">
                <tr>
                  <th className="px-4 py-2 text-left font-bold">Afiliado</th>
                  <th className="px-4 py-2 text-left font-bold">Solicitado</th>
                  <th className="px-4 py-2 text-left font-bold">Método</th>
                  <th className="px-4 py-2 text-right font-bold">Valor</th>
                  <th className="px-4 py-2 text-center font-bold">Ações</th>
                </tr>
              </thead>
              <tbody>
                {pending.map((w) => (
                  <tr key={w.id} className="border-t border-amber-200 dark:border-amber-900 hover:bg-amber-100/30 dark:hover:bg-amber-950/30">
                    <td className="px-4 py-2.5">
                      <div className="font-semibold text-foreground">{w.patient_name}</div>
                      {w.affiliate_code && (
                        <div className="text-[10px] font-mono text-emerald-700 dark:text-emerald-400">
                          {w.affiliate_code}
                        </div>
                      )}
                    </td>
                    <td className="px-4 py-2.5 text-muted-foreground">{formatDate(w.requested_at)}</td>
                    <td className="px-4 py-2.5">
                      <span className="text-xs font-medium">
                        {w.method === 'PIX' && `PIX (${w.pix_key})`}
                        {w.method === 'DINHEIRO' && 'Dinheiro'}
                        {w.method === 'CREDITO_TRATAMENTO' && 'Crédito em tratamento'}
                      </span>
                    </td>
                    <td className="px-4 py-2.5 text-right tabular-nums font-bold text-amber-900 dark:text-amber-200">
                      {brl(w.amount)}
                    </td>
                    <td className="px-4 py-2.5">
                      <div className="flex items-center justify-center gap-1">
                        <button
                          onClick={() => approveWithdrawal(w)}
                          disabled={processingId === w.id}
                          className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-bold disabled:opacity-50"
                          title="Confirmar pagamento"
                        >
                          {processingId === w.id ? <Loader2 size={11} className="animate-spin" /> : <CheckCircle2 size={11} />}
                          Pagar
                        </button>
                        <button
                          onClick={() => refuseWithdrawal(w)}
                          disabled={processingId === w.id}
                          className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg border border-rose-300 dark:border-rose-800 text-rose-700 dark:text-rose-400 hover:bg-rose-50 dark:hover:bg-rose-950/30 text-xs font-bold disabled:opacity-50"
                        >
                          <XCircle size={11} /> Recusar
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        )}

        {/* Top 5 do mês */}
        {top5.length > 0 && (
          <section className="rounded-xl border border-border bg-card overflow-hidden">
            <header className="flex items-center gap-2 px-4 py-3 border-b border-border bg-muted/30">
              <Trophy size={14} className="text-amber-500" />
              <h2 className="text-sm font-bold text-foreground">Top 5 do mês</h2>
            </header>
            <div className="divide-y divide-border">
              {top5.map((a, idx) => (
                <button
                  key={a.id}
                  onClick={() => router.push(`/atendimento/pacientes/${a.id}?tab=affiliate`)}
                  className="w-full text-left flex items-center gap-3 px-4 py-3 hover:bg-accent/40 transition-colors"
                >
                  <span className={`flex items-center justify-center w-7 h-7 rounded-full font-bold text-sm ${
                    idx === 0 ? 'bg-amber-100 text-amber-700 dark:bg-amber-950/40 dark:text-amber-400' :
                    idx === 1 ? 'bg-slate-200 text-slate-700 dark:bg-slate-800 dark:text-slate-300' :
                    idx === 2 ? 'bg-orange-100 text-orange-700 dark:bg-orange-950/40 dark:text-orange-400' :
                    'bg-muted text-muted-foreground'
                  }`}>{idx + 1}</span>
                  <div className="flex-1 min-w-0">
                    <div className="font-semibold text-foreground truncate">{a.name}</div>
                    {a.affiliate_code && (
                      <div className="text-[10px] font-mono text-emerald-700 dark:text-emerald-400">
                        {a.affiliate_code}
                      </div>
                    )}
                  </div>
                  <div className="text-right shrink-0">
                    <div className="text-sm font-bold text-foreground">
                      {a.indicacoes_mes} indicaç{a.indicacoes_mes === 1 ? 'ão' : 'ões'}
                    </div>
                    <div className="text-xs text-emerald-700 dark:text-emerald-400 tabular-nums">
                      {brl(a.indicacoes_mes > 0 ? (a.creditado_total / Math.max(1, a.indicacoes_total)) * a.indicacoes_mes : 0)}
                    </div>
                  </div>
                  <ExternalLink size={12} className="text-muted-foreground shrink-0" />
                </button>
              ))}
            </div>
          </section>
        )}

        {/* Tabela completa */}
        <section className="rounded-xl border border-border bg-card overflow-hidden">
          <header className="flex items-center justify-between gap-2 px-4 py-3 border-b border-border bg-muted/30">
            <div className="flex items-center gap-2">
              <Users size={14} className="text-emerald-600" />
              <h2 className="text-sm font-bold text-foreground">
                Todos os afiliados ({affiliates.length})
              </h2>
            </div>
          </header>

          {affiliates.length === 0 ? (
            <div className="px-4 py-12 text-center text-muted-foreground">
              <HandCoins size={32} className="mx-auto mb-2 opacity-40" />
              <p className="text-sm font-medium">Nenhum afiliado ainda</p>
              <p className="text-xs mt-1">
                Marque pacientes como afiliados pela ficha (botão verde no header
                ou modal Editar).
              </p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-muted/40 text-[10px] uppercase tracking-wider text-muted-foreground">
                  <tr>
                    <th className="px-4 py-2 text-left font-bold">Afiliado</th>
                    <th className="px-4 py-2 text-left font-bold">Código</th>
                    <th className="px-4 py-2 text-center font-bold">Indicações<br/>(mês / total)</th>
                    <th className="px-4 py-2 text-right font-bold">Ganhou</th>
                    <th className="px-4 py-2 text-right font-bold">Sacou</th>
                    <th className="px-4 py-2 text-right font-bold">Disponível</th>
                    <th className="px-4 py-2 text-center font-bold"></th>
                  </tr>
                </thead>
                <tbody>
                  {affiliates.map((a) => (
                    <tr
                      key={a.id}
                      onClick={() => router.push(`/atendimento/pacientes/${a.id}?tab=affiliate`)}
                      className="border-t border-border hover:bg-accent/40 cursor-pointer transition-colors"
                    >
                      <td className="px-4 py-2.5">
                        <div className="font-semibold text-foreground">{a.name}</div>
                        {a.phone && <div className="text-xs text-muted-foreground">{a.phone}</div>}
                      </td>
                      <td className="px-4 py-2.5 font-mono text-xs text-emerald-700 dark:text-emerald-400">
                        {a.affiliate_code || '—'}
                      </td>
                      <td className="px-4 py-2.5 text-center">
                        <span className="font-bold text-foreground">{a.indicacoes_mes}</span>
                        <span className="text-muted-foreground"> / {a.indicacoes_total}</span>
                      </td>
                      <td className="px-4 py-2.5 text-right tabular-nums text-foreground">{brl(a.creditado_total)}</td>
                      <td className="px-4 py-2.5 text-right tabular-nums text-muted-foreground">{brl(a.sacado_total)}</td>
                      <td className="px-4 py-2.5 text-right tabular-nums font-bold text-emerald-700 dark:text-emerald-400">
                        {brl(a.saldo_disponivel)}
                      </td>
                      <td className="px-4 py-2.5 text-center">
                        <ExternalLink size={12} className="text-muted-foreground inline" />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

// ─── AddAffiliateModal ────────────────────────────────────────────────────
// Modal pra adicionar afiliado: 2 modos
//   1) Selecionar paciente existente (busca por nome/telefone, debounce 300ms)
//   2) Criar paciente novo (mini-form com nome+telefone+email)
// Em ambos casos faz PATCH is_affiliate=true + affiliate_code auto-gerado
// do nome (uppercase, sem acento).

interface PatientLite {
  id: string;
  name: string;
  phone: string | null;
  is_affiliate: boolean;
}

function slugifyName(name: string): string {
  return (name || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .slice(0, 20);
}

function AddAffiliateModal({
  onClose,
  onSuccess,
}: {
  onClose: () => void;
  onSuccess: (patientId: string) => void;
}) {
  const [mode, setMode] = useState<'pick' | 'create'>('pick');
  const [submitting, setSubmitting] = useState(false);

  // Modo "pick": busca paciente existente
  const [query, setQuery] = useState('');
  const [searching, setSearching] = useState(false);
  const [results, setResults] = useState<PatientLite[]>([]);

  // Modo "create": cadastro novo
  const [newName, setNewName] = useState('');
  const [newPhone, setNewPhone] = useState('');
  const [newEmail, setNewEmail] = useState('');

  // Debounced search
  useEffect(() => {
    if (mode !== 'pick') return;
    if (!query.trim()) {
      setResults([]);
      return;
    }
    let cancelled = false;
    setSearching(true);
    const handle = setTimeout(async () => {
      try {
        const res = await api.get('/patients', { params: { search: query, limit: 20 } });
        if (cancelled) return;
        const list = Array.isArray(res.data?.data) ? res.data.data : Array.isArray(res.data) ? res.data : [];
        setResults(
          list.map((p: any) => ({
            id: p.id,
            name: p.name,
            phone: p.phone,
            is_affiliate: !!p.is_affiliate,
          })),
        );
      } catch {
        if (!cancelled) setResults([]);
      } finally {
        if (!cancelled) setSearching(false);
      }
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
  }, [query, mode]);

  const selectExisting = async (p: PatientLite) => {
    if (p.is_affiliate) {
      if (!confirm(`${p.name} já é afiliado. Abrir a ficha?`)) return;
      onSuccess(p.id);
      return;
    }
    if (!confirm(
      `Tornar ${p.name} um afiliado da clínica?\n\n` +
      `• Recebe 3% por indicação fechada\n` +
      `• Saldo acumula e pode ser sacado\n` +
      `• Código: ${slugifyName(p.name) || '(definir depois)'}`,
    )) return;
    setSubmitting(true);
    try {
      await api.patch(`/patients/${p.id}`, {
        is_affiliate: true,
        affiliate_code: slugifyName(p.name) || null,
        affiliate_commission_pct: 3,
      });
      showSuccess('Afiliado adicionado');
      onSuccess(p.id);
    } catch (e: any) {
      showError(e?.response?.data?.message || 'Erro ao ativar afiliado');
    } finally {
      setSubmitting(false);
    }
  };

  const createNew = async () => {
    if (!newName.trim()) {
      showError('Nome é obrigatório');
      return;
    }
    setSubmitting(true);
    try {
      // Cria patient + ja marca como afiliado num so payload
      const res = await api.post('/patients', {
        name: newName.trim(),
        phone: newPhone.trim() || undefined,
        email: newEmail.trim() || undefined,
        is_affiliate: true,
        affiliate_code: slugifyName(newName) || null,
        affiliate_commission_pct: 3,
      });
      const patientId = res.data?.id;
      if (!patientId) throw new Error('Patient criado mas id não retornado');
      showSuccess('Paciente criado e adicionado como afiliado');
      onSuccess(patientId);
    } catch (e: any) {
      showError(e?.response?.data?.message || 'Erro ao criar paciente');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[9999] flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm">
      <div className="w-full max-w-md bg-card border border-border rounded-2xl shadow-2xl">
        <header className="flex items-center justify-between px-5 py-4 border-b border-border">
          <h3 className="text-base font-bold text-foreground flex items-center gap-2">
            <HandCoins size={16} className="text-emerald-600" />
            Adicionar afiliado
          </h3>
          <button onClick={onClose} className="p-1 rounded text-muted-foreground hover:bg-accent">
            <X size={16} />
          </button>
        </header>

        {/* Toggle entre modos */}
        <div className="flex border-b border-border">
          <button
            onClick={() => setMode('pick')}
            className={`flex-1 px-4 py-2.5 text-sm font-semibold transition-colors flex items-center justify-center gap-2 ${
              mode === 'pick'
                ? 'bg-emerald-50 dark:bg-emerald-950/30 text-emerald-700 dark:text-emerald-400 border-b-2 border-emerald-500'
                : 'text-muted-foreground hover:bg-accent border-b-2 border-transparent'
            }`}
          >
            <Search size={14} /> Paciente existente
          </button>
          <button
            onClick={() => setMode('create')}
            className={`flex-1 px-4 py-2.5 text-sm font-semibold transition-colors flex items-center justify-center gap-2 ${
              mode === 'create'
                ? 'bg-emerald-50 dark:bg-emerald-950/30 text-emerald-700 dark:text-emerald-400 border-b-2 border-emerald-500'
                : 'text-muted-foreground hover:bg-accent border-b-2 border-transparent'
            }`}
          >
            <UserPlus size={14} /> Novo paciente
          </button>
        </div>

        {/* Conteúdo */}
        <div className="p-5 space-y-4">
          {mode === 'pick' ? (
            <>
              <div>
                <label className="text-xs font-bold uppercase tracking-wider text-muted-foreground mb-1 block">
                  Buscar paciente
                </label>
                <input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Nome ou telefone..."
                  autoFocus
                  className="w-full px-3 py-2 rounded-lg border border-border bg-background text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500/30"
                />
              </div>

              <div className="max-h-72 overflow-y-auto -mx-2">
                {searching && (
                  <div className="flex items-center justify-center py-6 text-muted-foreground text-sm">
                    <Loader2 size={14} className="animate-spin mr-2" /> Buscando…
                  </div>
                )}
                {!searching && query.trim() && results.length === 0 && (
                  <div className="text-center py-6 text-sm text-muted-foreground">
                    Nenhum paciente encontrado pra <strong>{query}</strong>.
                    <p className="text-xs mt-2">
                      Tente cadastrar novo na aba ao lado.
                    </p>
                  </div>
                )}
                {!searching && !query.trim() && (
                  <div className="text-center py-6 text-sm text-muted-foreground">
                    Digite o nome ou telefone do paciente.
                  </div>
                )}
                <div className="divide-y divide-border">
                  {results.map((p) => (
                    <button
                      key={p.id}
                      onClick={() => selectExisting(p)}
                      disabled={submitting}
                      className="w-full text-left flex items-center gap-3 px-3 py-2.5 hover:bg-accent/40 transition-colors disabled:opacity-50"
                    >
                      <div className="flex-1 min-w-0">
                        <div className="font-semibold text-sm text-foreground truncate">{p.name}</div>
                        {p.phone && (
                          <div className="text-xs text-muted-foreground">{p.phone}</div>
                        )}
                      </div>
                      {p.is_affiliate ? (
                        <span className="text-[10px] font-bold uppercase tracking-wider text-emerald-700 dark:text-emerald-400 px-1.5 py-0.5 rounded bg-emerald-50 dark:bg-emerald-950/40 border border-emerald-200 dark:border-emerald-900">
                          Já é afiliado
                        </span>
                      ) : (
                        <ArrowRight size={14} className="text-emerald-600 shrink-0" />
                      )}
                    </button>
                  ))}
                </div>
              </div>
            </>
          ) : (
            <>
              <div className="rounded-lg border border-emerald-200 dark:border-emerald-900/50 bg-emerald-50 dark:bg-emerald-950/20 p-3 text-xs leading-relaxed text-emerald-900 dark:text-emerald-200">
                Cria um paciente novo já marcado como afiliado ativo (3% de comissão).
                Você pode completar os dados depois pelo botão Editar da ficha.
              </div>
              <div>
                <label className="text-xs font-bold uppercase tracking-wider text-muted-foreground mb-1 block">
                  Nome *
                </label>
                <input
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  placeholder="Nome completo"
                  autoFocus
                  className="w-full px-3 py-2 rounded-lg border border-border bg-background text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500/30"
                />
                {newName.trim() && (
                  <p className="text-[11px] text-muted-foreground mt-1">
                    Código de afiliado:{' '}
                    <span className="font-mono font-bold text-emerald-700 dark:text-emerald-400">
                      {slugifyName(newName) || '(definir depois)'}
                    </span>
                  </p>
                )}
              </div>
              <div>
                <label className="text-xs font-bold uppercase tracking-wider text-muted-foreground mb-1 block">
                  Telefone
                </label>
                <input
                  value={newPhone}
                  onChange={(e) => setNewPhone(e.target.value)}
                  placeholder="82 99999-9999"
                  className="w-full px-3 py-2 rounded-lg border border-border bg-background text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500/30"
                />
              </div>
              <div>
                <label className="text-xs font-bold uppercase tracking-wider text-muted-foreground mb-1 block">
                  E-mail
                </label>
                <input
                  type="email"
                  value={newEmail}
                  onChange={(e) => setNewEmail(e.target.value)}
                  placeholder="email@dominio.com"
                  className="w-full px-3 py-2 rounded-lg border border-border bg-background text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500/30"
                />
              </div>
            </>
          )}
        </div>

        <footer className="flex justify-end gap-2 px-5 py-3 border-t border-border bg-muted/20">
          <button
            onClick={onClose}
            disabled={submitting}
            className="px-4 py-2 rounded-lg text-sm font-medium text-muted-foreground hover:bg-accent disabled:opacity-50"
          >
            Cancelar
          </button>
          {mode === 'create' && (
            <button
              onClick={createNew}
              disabled={submitting || !newName.trim()}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-emerald-600 text-white text-sm font-bold hover:bg-emerald-700 disabled:opacity-40"
            >
              {submitting ? <Loader2 size={14} className="animate-spin" /> : <UserPlus size={14} />}
              Cadastrar e adicionar
            </button>
          )}
        </footer>
      </div>
    </div>
  );
}

function KpiCard({
  icon, label, value, color,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  color: 'emerald' | 'sky' | 'orange' | 'amber';
}) {
  const colorCls = {
    emerald: 'border-emerald-300 dark:border-emerald-800 bg-emerald-50 dark:bg-emerald-950/20 text-emerald-700 dark:text-emerald-400',
    sky:     'border-sky-300 dark:border-sky-800 bg-sky-50 dark:bg-sky-950/20 text-sky-700 dark:text-sky-400',
    orange:  'border-orange-300 dark:border-orange-800 bg-orange-50 dark:bg-orange-950/20 text-orange-700 dark:text-orange-400',
    amber:   'border-amber-300 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/20 text-amber-700 dark:text-amber-400',
  }[color];

  return (
    <div className={`rounded-xl border ${colorCls} p-4`}>
      <div className="flex items-center gap-2 mb-1 opacity-80">
        {icon}
        <span className="text-[10px] uppercase font-bold tracking-wider">{label}</span>
      </div>
      <p className="text-xl font-bold tabular-nums">{value}</p>
    </div>
  );
}

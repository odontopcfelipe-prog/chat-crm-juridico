'use client';

/**
 * Indicação Premiada (Fase 21) — UI principal.
 *
 * Lista todas as indicações com filtros por status, cards de stats
 * (quantos estão pendentes, quanto cashback a clínica deve, etc) e
 * ações pra marcar como PAID. Também permite configurar a regra
 * (valor padrão + validade) num modal lateral.
 */
import { Suspense, useCallback, useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import {
  Trophy, Loader2, Phone, ArrowRight, DollarSign, Clock,
  CheckCircle2, XCircle, Settings as SettingsIcon, X, Save, AlertTriangle,
} from 'lucide-react';
import api from '@/lib/api';
import { showError, showSuccess } from '@/lib/toast';

interface Referral {
  id: string;
  status: 'PENDING' | 'EARNED' | 'PAID' | 'EXPIRED' | 'CANCELLED';
  reward_value: string; // Decimal vem como string do Prisma
  earned_at: string | null;
  paid_at: string | null;
  expires_at: string | null;
  notes: string | null;
  created_at: string;
  triggering_plan_id: string | null;
  referrer: { id: string; name: string | null; phone: string; avatar_url: string | null };
  referred: { id: string; name: string | null; phone: string; avatar_url: string | null };
}

interface Stats {
  byStatus: Record<string, { count: number; total: number }>;
  totalCount: number;
  totalRewardCirculating: number;
}

interface Rule {
  id: string;
  enabled: boolean;
  default_reward_value: string;
  expiration_days: number;
  notes: string | null;
}

const STATUS_CFG: Record<Referral['status'], { label: string; cls: string; icon: React.ElementType }> = {
  PENDING:   { label: 'Aguardando',  cls: 'bg-amber-500/10 text-amber-600 border-amber-500/20', icon: Clock },
  EARNED:    { label: 'A pagar',     cls: 'bg-blue-500/10 text-blue-600 border-blue-500/20', icon: AlertTriangle },
  PAID:      { label: 'Pago',        cls: 'bg-emerald-500/10 text-emerald-600 border-emerald-500/20', icon: CheckCircle2 },
  EXPIRED:   { label: 'Expirado',    cls: 'bg-muted text-muted-foreground border-border', icon: XCircle },
  CANCELLED: { label: 'Cancelado',   cls: 'bg-red-500/10 text-red-600 border-red-500/20', icon: XCircle },
};

const formatBRL = (v: number | string) =>
  Number(v).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

export default function ReferralsPage() {
  return (
    <Suspense fallback={
      <div className="p-6 flex items-center justify-center text-muted-foreground">
        <Loader2 size={20} className="animate-spin mr-2" /> Carregando...
      </div>
    }>
      <ReferralsPageInner />
    </Suspense>
  );
}

function ReferralsPageInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [referrals, setReferrals] = useState<Referral[]>([]);
  const [stats, setStats] = useState<Stats | null>(null);
  const [rule, setRule] = useState<Rule | null>(null);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState<string>(searchParams.get('status') || '');
  const [referrerFilter, setReferrerFilter] = useState<string>(searchParams.get('referrerId') || '');
  const [showRuleModal, setShowRuleModal] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (statusFilter) params.set('status', statusFilter);
      if (referrerFilter) params.set('referrerId', referrerFilter);
      const [listR, statsR, ruleR] = await Promise.all([
        api.get<Referral[]>(`/referrals?${params}`),
        api.get<Stats>('/referrals/stats'),
        api.get<Rule>('/referrals/rule'),
      ]);
      setReferrals(listR.data);
      setStats(statsR.data);
      setRule(ruleR.data);
    } catch (err: any) {
      showError(err?.response?.data?.message || 'Erro ao carregar indicações');
    } finally {
      setLoading(false);
    }
  }, [statusFilter, referrerFilter]);

  useEffect(() => { load(); }, [load]);

  const handleMarkPaid = async (r: Referral) => {
    if (!confirm(`Marcar como PAGO o cashback de ${formatBRL(r.reward_value)} pra ${r.referrer.name || 'paciente'}?`)) return;
    try {
      await api.post(`/referrals/${r.id}/mark-paid`);
      showSuccess('Cashback marcado como pago');
      load();
    } catch (err: any) {
      showError(err?.response?.data?.message || 'Erro ao marcar como pago');
    }
  };

  return (
    <div className="p-6 w-full">
      <div className="flex items-start justify-between gap-4 mb-6 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold text-foreground flex items-center gap-2">
            <Trophy size={26} className="text-primary" /> Indicação Premiada
          </h1>
          <p className="text-sm text-muted-foreground mt-1 max-w-2xl">
            Programa de cashback: paciente A indica B. Quando B fecha um plano,
            A ganha {rule ? formatBRL(rule.default_reward_value) : '—'} pra usar
            como desconto na próxima parcela ou tratamento.
          </p>
        </div>
        <button
          onClick={() => setShowRuleModal(true)}
          className="inline-flex items-center gap-2 px-3 py-2 rounded-lg border border-border hover:bg-accent text-sm"
        >
          <SettingsIcon size={14} /> Configurar programa
        </button>
      </div>

      {/* Status do programa */}
      {rule && !rule.enabled && (
        <div className="mb-4 p-3 rounded-xl bg-amber-500/10 border border-amber-500/20 text-sm text-amber-700">
          ⚠ O programa está <strong>desativado</strong>. Novas indicações não vão gerar cashback.
          <button
            onClick={() => setShowRuleModal(true)}
            className="ml-2 underline"
          >
            Ativar agora
          </button>
        </div>
      )}

      {/* Stats cards */}
      {stats && (
        <div className="grid grid-cols-2 md:grid-cols-5 gap-3 mb-6">
          <StatCard label="Total" value={stats.totalCount} bottomLabel="indicações" />
          <StatCard
            label="Aguardando"
            value={stats.byStatus.PENDING?.count || 0}
            bottomLabel="pacientes ainda não fecharam"
            cls="text-amber-600"
          />
          <StatCard
            label="A pagar"
            value={stats.byStatus.EARNED?.count || 0}
            bottomLabel={formatBRL(stats.byStatus.EARNED?.total || 0)}
            cls="text-blue-600"
          />
          <StatCard
            label="Pagos"
            value={stats.byStatus.PAID?.count || 0}
            bottomLabel={formatBRL(stats.byStatus.PAID?.total || 0)}
            cls="text-emerald-600"
          />
          <StatCard
            label="Cashback total"
            value={formatBRL(stats.totalRewardCirculating)}
            bottomLabel="já gerado pelo programa"
            cls="text-primary"
            isCurrency
          />
        </div>
      )}

      {/* Filtros */}
      <div className="flex flex-col sm:flex-row gap-2 mb-4">
        <div className="flex gap-1 bg-card border border-border rounded-lg p-1 flex-wrap">
          {(['', 'PENDING', 'EARNED', 'PAID', 'EXPIRED', 'CANCELLED'] as const).map((s) => (
            <button
              key={s || 'TODOS'}
              onClick={() => setStatusFilter(s)}
              className={`px-3 py-1.5 rounded text-sm font-medium ${
                statusFilter === s
                  ? 'bg-primary text-primary-foreground'
                  : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              {s ? STATUS_CFG[s as Referral['status']].label : 'Todos'}
            </button>
          ))}
        </div>
        {referrerFilter && (
          <button
            onClick={() => { setReferrerFilter(''); router.replace('/atendimento/referrals'); }}
            className="text-xs px-3 py-1.5 rounded-lg border border-border hover:bg-accent inline-flex items-center gap-1"
          >
            Limpar filtro de indicador <X size={12} />
          </button>
        )}
      </div>

      {/* Lista */}
      {loading ? (
        <div className="p-12 flex items-center justify-center text-muted-foreground">
          <Loader2 size={20} className="animate-spin mr-2" /> Carregando...
        </div>
      ) : referrals.length === 0 ? (
        <div className="p-12 text-center bg-card border border-border rounded-xl">
          <Trophy size={28} className="mx-auto mb-2 text-muted-foreground/50" />
          <p className="text-sm text-muted-foreground">
            {statusFilter
              ? 'Nenhuma indicação com esse status.'
              : 'Nenhuma indicação registrada ainda. Quando um paciente novo for cadastrado com "indicado por outro paciente" no formulário, aparece aqui.'}
          </p>
        </div>
      ) : (
        <div className="bg-card border border-border rounded-xl overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-muted-foreground text-xs uppercase">
              <tr>
                <th className="text-left px-4 py-2 font-medium">Indicador → Indicado</th>
                <th className="text-left px-4 py-2 font-medium">Status</th>
                <th className="text-right px-4 py-2 font-medium">Cashback</th>
                <th className="text-left px-4 py-2 font-medium">Datas</th>
                <th className="text-right px-4 py-2 font-medium">Ações</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {referrals.map((r) => {
                const cfg = STATUS_CFG[r.status];
                const Icon = cfg.icon;
                return (
                  <tr key={r.id} className="hover:bg-muted/30">
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2 text-sm">
                        <button
                          onClick={() => router.push(`/atendimento/pacientes/${r.referrer.id}`)}
                          className="hover:text-primary text-left"
                        >
                          <div className="font-medium">{r.referrer.name || 'Sem nome'}</div>
                          <div className="text-xs text-muted-foreground flex items-center gap-1">
                            <Phone size={10} /> {r.referrer.phone}
                          </div>
                        </button>
                        <ArrowRight size={14} className="text-muted-foreground shrink-0" />
                        <button
                          onClick={() => router.push(`/atendimento/pacientes/${r.referred.id}`)}
                          className="hover:text-primary text-left"
                        >
                          <div className="font-medium">{r.referred.name || 'Sem nome'}</div>
                          <div className="text-xs text-muted-foreground flex items-center gap-1">
                            <Phone size={10} /> {r.referred.phone}
                          </div>
                        </button>
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <span className={`inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full border ${cfg.cls}`}>
                        <Icon size={11} /> {cfg.label}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-right font-semibold">
                      {formatBRL(r.reward_value)}
                    </td>
                    <td className="px-4 py-3 text-xs text-muted-foreground">
                      <div>Indicação em {new Date(r.created_at).toLocaleDateString('pt-BR')}</div>
                      {r.earned_at && <div>Plano fechado em {new Date(r.earned_at).toLocaleDateString('pt-BR')}</div>}
                      {r.paid_at && <div>Pago em {new Date(r.paid_at).toLocaleDateString('pt-BR')}</div>}
                      {!r.earned_at && r.expires_at && (
                        <div className="text-amber-600">
                          Expira em {new Date(r.expires_at).toLocaleDateString('pt-BR')}
                        </div>
                      )}
                    </td>
                    <td className="px-4 py-3 text-right">
                      {r.status === 'EARNED' && (
                        <button
                          onClick={() => handleMarkPaid(r)}
                          className="text-xs inline-flex items-center gap-1 px-3 py-1.5 rounded-lg bg-primary text-primary-foreground hover:bg-primary/90"
                        >
                          <DollarSign size={12} /> Marcar pago
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {showRuleModal && rule && (
        <RuleModal
          rule={rule}
          onClose={() => setShowRuleModal(false)}
          onSaved={() => { setShowRuleModal(false); load(); }}
        />
      )}
    </div>
  );
}

function StatCard({
  label, value, bottomLabel, cls, isCurrency,
}: { label: string; value: number | string; bottomLabel?: string; cls?: string; isCurrency?: boolean }) {
  return (
    <div className="bg-card border border-border rounded-xl p-4">
      <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">{label}</p>
      <p className={`${isCurrency ? 'text-xl' : 'text-2xl'} font-bold mt-1 ${cls || 'text-foreground'}`}>
        {value}
      </p>
      {bottomLabel && (
        <p className="text-xs text-muted-foreground mt-0.5">{bottomLabel}</p>
      )}
    </div>
  );
}

// ─── Modal de configuração da regra ───────────────────────

function RuleModal({
  rule, onClose, onSaved,
}: { rule: Rule; onClose: () => void; onSaved: () => void }) {
  const [enabled, setEnabled] = useState(rule.enabled);
  const [reward, setReward] = useState(rule.default_reward_value);
  const [expirationDays, setExpirationDays] = useState(rule.expiration_days);
  const [notes, setNotes] = useState(rule.notes || '');
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    setSaving(true);
    try {
      await api.patch('/referrals/rule', {
        enabled,
        default_reward_value: Number(reward),
        expiration_days: Number(expirationDays),
        notes: notes.trim() || null,
      });
      showSuccess('Configuração salva');
      onSaved();
    } catch (err: any) {
      showError(err?.response?.data?.message || 'Erro ao salvar');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-[100] bg-black/50 backdrop-blur-sm flex items-center justify-center p-4"
      onClick={onClose}
    >
      <div
        className="bg-card border border-border rounded-xl w-full max-w-md shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between p-4 border-b border-border">
          <div className="flex items-center gap-2">
            <SettingsIcon size={18} className="text-primary" />
            <h2 className="text-base font-semibold">Configurar Indicação Premiada</h2>
          </div>
          <button onClick={onClose} className="p-1 hover:bg-accent rounded">
            <X size={18} />
          </button>
        </div>

        <div className="p-4 space-y-4">
          <label className="flex items-start gap-3 cursor-pointer">
            <input
              type="checkbox"
              checked={enabled}
              onChange={(e) => setEnabled(e.target.checked)}
              className="w-4 h-4 mt-0.5 rounded border-border"
            />
            <div>
              <div className="text-sm font-medium">Programa ativo</div>
              <div className="text-xs text-muted-foreground">
                Quando ativo, novas indicações vão gerar cashback automaticamente.
              </div>
            </div>
          </label>

          <div>
            <label className="block text-xs font-medium mb-1">Valor padrão do cashback (R$)</label>
            <input
              type="number"
              step="0.01"
              min="0"
              value={reward}
              onChange={(e) => setReward(e.target.value)}
              className="w-full px-3 py-2 rounded-lg bg-background border border-border text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
            />
            <p className="text-xs text-muted-foreground mt-1">
              Valor que o indicador ganha quando o paciente novo fecha um plano.
            </p>
          </div>

          <div>
            <label className="block text-xs font-medium mb-1">Validade (dias após o plano fechar)</label>
            <input
              type="number"
              min="1"
              value={expirationDays}
              onChange={(e) => setExpirationDays(Number(e.target.value))}
              className="w-full px-3 py-2 rounded-lg bg-background border border-border text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
            />
            <p className="text-xs text-muted-foreground mt-1">
              Após esse prazo, indicações ainda não pagas viram EXPIRADAS.
            </p>
          </div>

          <div>
            <label className="block text-xs font-medium mb-1">Observações (opcional)</label>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={2}
              placeholder="Ex: regras especiais para indicações de alto valor"
              className="w-full px-3 py-2 rounded-lg bg-background border border-border text-sm resize-none focus:outline-none focus:ring-2 focus:ring-primary/30"
            />
          </div>

          <div className="flex justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="px-3 py-2 rounded-lg border border-border text-sm hover:bg-accent"
            >
              Cancelar
            </button>
            <button
              onClick={submit}
              disabled={saving}
              className="inline-flex items-center gap-1 px-3 py-2 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 disabled:opacity-50"
            >
              {saving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
              Salvar
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

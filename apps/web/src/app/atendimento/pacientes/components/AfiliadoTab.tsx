'use client';

/**
 * AfiliadoTab — aba "Afiliado" da ficha do paciente.
 *
 * So aparece quando patient.is_affiliate = true. Mostra:
 *   - Card de saldo (disponivel / total acumulado / total sacado)
 *   - Tabela de indicacoes (paciente indicado, data, valor fechado, comissao)
 *   - Botao "Sacar" + historico de saques
 *
 * Regra do programa: afiliado recebe 3% do valor total de cada tratamento
 * fechado por indicacao dele. Saldo acumula automaticamente e pode ser
 * sacado em dinheiro OU usado como credito em tratamentos proprios.
 *
 * Estado backend: aguarda schema (Patient + AffiliateReferral + AffiliateWithdrawal).
 * Por enquanto a UI usa dados mockados pra mostrar layout — quando o backend
 * subir, basta trocar o fetch.
 */

import { useEffect, useMemo, useState, useCallback } from 'react';
import {
  HandCoins, TrendingUp, Wallet, Download, Users, Clock,
  ArrowDownToLine, CheckCircle2, AlertCircle, Info, Loader2, RefreshCw, Award,
} from 'lucide-react';
import api from '@/lib/api';
import { showError, showSuccess } from '@/lib/toast';

interface Props {
  patientId: string;
  patientName: string;
  affiliateCode: string | null;
}

interface Referral {
  id: string;
  indicated_name: string;
  indicated_phone: string | null;
  closed_at: string | null;       // null = ainda nao fechou
  treatment_value: number;
  commission_value: number;       // 3% do treatment_value
  commission_pct: number;
  status: 'pendente' | 'creditado' | 'cancelado';
  quote_id?: string | null;
  /** id do paciente indicado — link direto pra ficha dele */
  indicated_id?: string | null;
  /** Como o indicado esta hoje (pagamento/tratamento/agenda/negociacao) */
  contexto?: ReferralContext | null;
}


/** Contexto operacional do indicado — como ele esta HOJE (vem do backend). */
interface ReferralContext {
  pagamento: {
    status: 'ATRASADO' | 'EM_DIA' | 'QUITADO' | 'SEM_COBRANCA';
    atrasadas: number;
    valor_atrasado: number;
    abertas: number;
    valor_aberto: number;
    valor_pago: number;
    proxima_due: string | null;
  };
  tratamento: { status: string; itens_total: number; itens_feitos: number; pct: number };
  atendimento: {
    status: 'AGENDADO' | 'EM_ATENDIMENTO' | 'SUMIDO' | 'NUNCA_VEIO';
    ultimo_at: string | null;
    proximo_at: string | null;
    dias_sem_vir: number | null;
  };
  negociacao: { propostas_abertas: number; valor_em_negociacao: number };
  alerta: 'ATRASO' | 'SUMIDO' | 'NEGOCIACAO_PARADA' | 'OK';
}

/** Indicado que ainda NAO fechou — o que a clinica precisa correr atras. */
interface PipelineRow {
  patient_id: string;
  name: string | null;
  phone: string | null;
  origem: 'cadastro' | 'venda';
  desde: string;
  contexto: ReferralContext | null;
}

interface Alertas {
  atrasados: number;
  sumidos: number;
  em_negociacao: number;
  valor_atrasado: number;
  valor_em_negociacao: number;
}

interface Withdrawal {
  id: string;
  amount: number;
  requested_at: string;
  paid_at: string | null;
  method: 'PIX' | 'CREDITO_TRATAMENTO' | 'DINHEIRO';
  status: 'solicitado' | 'pago' | 'recusado';
  pix_key?: string | null;
}

interface FaixaInfo {
  ativo: boolean;
  atual?: { label: string; min: number; pct: number };
  proxima?: { label: string; min: number; pct: number } | null;
  faltam?: number;
  pctFixo?: number;
  indicacoesCreditadas: number;
}

interface DashboardData {
  stats: { disponivel: number; totalAcumulado: number; totalSacado: number; pendenteSaque: number };
  faixa?: FaixaInfo;
  referrals: Referral[];
  pipeline?: PipelineRow[];
  alertas?: Alertas;
  withdrawals: Withdrawal[];
  patient: { affiliate_commission_pct: number };
}

function brl(v: number): string {
  return v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('pt-BR', { day: '2-digit', month: 'short', year: 'numeric' });
}


/** Bolinha do semaforo + rotulo curto. Verde = nada a fazer. */
function SemaforoDot({ alerta }: { alerta: ReferralContext['alerta'] }) {
  const cfg = {
    ATRASO: { cls: 'bg-red-500', label: 'Em atraso' },
    SUMIDO: { cls: 'bg-amber-500', label: 'Sem agenda' },
    NEGOCIACAO_PARADA: { cls: 'bg-sky-500', label: 'Negociando' },
    OK: { cls: 'bg-emerald-500', label: 'Em dia' },
  }[alerta];
  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap" title={cfg.label}>
      <span className={`w-2 h-2 rounded-full shrink-0 ${cfg.cls}`} />
      <span className="text-[11px] text-muted-foreground">{cfg.label}</span>
    </span>
  );
}

/** Coluna "Pagamentos": o que importa e se tem boleto vencido e quanto. */
function PagamentoCell({ ctx }: { ctx: ReferralContext | null }) {
  if (!ctx) return <span className="text-xs text-muted-foreground">—</span>;
  const pg = ctx.pagamento;
  if (pg.status === 'ATRASADO') {
    return (
      <div className="text-xs">
        <span className="font-bold text-red-600 dark:text-red-400">
          {brl(pg.valor_atrasado)} vencido
        </span>
        <div className="text-[10px] text-muted-foreground">
          {pg.atrasadas} boleto{pg.atrasadas === 1 ? '' : 's'} em atraso
        </div>
      </div>
    );
  }
  if (pg.status === 'EM_DIA') {
    return (
      <div className="text-xs">
        <span className="font-semibold text-emerald-700 dark:text-emerald-400">Em dia</span>
        <div className="text-[10px] text-muted-foreground">
          {brl(pg.valor_aberto)} a vencer
          {pg.proxima_due ? ` · próx. ${formatDate(pg.proxima_due)}` : ''}
        </div>
      </div>
    );
  }
  if (pg.status === 'QUITADO') {
    return (
      <div className="text-xs">
        <span className="font-semibold text-emerald-700 dark:text-emerald-400">Quitado</span>
        <div className="text-[10px] text-muted-foreground">{brl(pg.valor_pago)} pago</div>
      </div>
    );
  }
  return <span className="text-xs text-muted-foreground">sem cobrança</span>;
}

/** Coluna "Tratamento": andou ou parou? */
function TratamentoCell({ ctx }: { ctx: ReferralContext | null }) {
  if (!ctx || ctx.tratamento.status === 'SEM_PLANO') {
    return <span className="text-xs text-muted-foreground">sem plano</span>;
  }
  const t = ctx.tratamento;
  const LABEL: Record<string, string> = {
    PENDING_SIGNATURE: 'aguardando assinatura',
    ACTIVE: 'em tratamento',
    PAUSED: 'pausado',
    COMPLETED: 'concluído',
  };
  return (
    <div className="text-xs">
      <div className="flex items-center gap-1.5">
        <div className="w-14 h-1.5 rounded-full bg-muted overflow-hidden shrink-0">
          <div
            className={`h-full ${t.pct >= 100 ? 'bg-emerald-500' : 'bg-sky-500'}`}
            style={{ width: `${Math.min(100, t.pct)}%` }}
          />
        </div>
        <span className="tabular-nums font-semibold text-foreground">{t.pct}%</span>
      </div>
      <div className="text-[10px] text-muted-foreground">
        {t.itens_feitos}/{t.itens_total} itens · {LABEL[t.status] || t.status.toLowerCase()}
      </div>
    </div>
  );
}

/** Coluna "Atendimento": quando veio, quando volta. */
function AtendimentoCell({ ctx }: { ctx: ReferralContext | null }) {
  if (!ctx) return <span className="text-xs text-muted-foreground">—</span>;
  const a = ctx.atendimento;
  if (a.status === 'AGENDADO') {
    return (
      <div className="text-xs">
        <span className="font-semibold text-sky-700 dark:text-sky-400">
          Agendado {a.proximo_at ? formatDate(a.proximo_at) : ''}
        </span>
        {a.ultimo_at && (
          <div className="text-[10px] text-muted-foreground">últ. {formatDate(a.ultimo_at)}</div>
        )}
      </div>
    );
  }
  if (a.status === 'NUNCA_VEIO') {
    return <span className="text-xs font-semibold text-amber-700 dark:text-amber-400">Nunca veio</span>;
  }
  if (a.status === 'SUMIDO') {
    return (
      <div className="text-xs">
        <span className="font-semibold text-amber-700 dark:text-amber-400">
          {a.dias_sem_vir} dias sem vir
        </span>
        <div className="text-[10px] text-muted-foreground">sem próxima consulta</div>
      </div>
    );
  }
  return (
    <div className="text-xs">
      <span className="text-foreground">Ativo</span>
      {a.ultimo_at && (
        <div className="text-[10px] text-muted-foreground">últ. {formatDate(a.ultimo_at)}</div>
      )}
    </div>
  );
}

/** Coluna "Negociação": proposta aberta parada e dinheiro na mesa. */
function NegociacaoCell({ ctx }: { ctx: ReferralContext | null }) {
  if (!ctx || ctx.negociacao.propostas_abertas === 0) {
    return <span className="text-xs text-muted-foreground">—</span>;
  }
  const n = ctx.negociacao;
  return (
    <div className="text-xs">
      <span className="font-semibold text-sky-700 dark:text-sky-400">
        {n.propostas_abertas} proposta{n.propostas_abertas === 1 ? '' : 's'}
      </span>
      <div className="text-[10px] text-muted-foreground">{brl(n.valor_em_negociacao)} em aberto</div>
    </div>
  );
}

export default function AfiliadoTab({ patientId, patientName, affiliateCode }: Props) {
  const [loading, setLoading] = useState(true);
  const [data, setData] = useState<DashboardData | null>(null);
  const [showWithdrawModal, setShowWithdrawModal] = useState(false);
  // Lancamento retroativo: vendas antigas que nunca viraram indicacao.
  const [showRetroModal, setShowRetroModal] = useState(false);

  const fetchDashboard = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.get(`/patients/${patientId}/affiliate`);
      setData(res.data);
    } catch (e: any) {
      showError(e?.response?.data?.message || 'Erro ao carregar dashboard de afiliado');
    } finally {
      setLoading(false);
    }
  }, [patientId]);

  useEffect(() => {
    fetchDashboard();
  }, [fetchDashboard]);

  const referrals = data?.referrals ?? [];
  const pipeline = data?.pipeline ?? [];
  const alertas = data?.alertas;
  const withdrawals = data?.withdrawals ?? [];
  const stats = data?.stats ?? { disponivel: 0, totalAcumulado: 0, totalSacado: 0, pendenteSaque: 0 };
  const faixa = data?.faixa;
  // Quando as faixas estão ligadas, o % vigente é o da faixa atual; senão, o fixo do cadastro.
  const COMMISSION_PCT =
    faixa?.ativo && faixa.atual ? faixa.atual.pct : data?.patient?.affiliate_commission_pct ?? 3;

  // Conta indicacoes por status
  const referralsByStatus = useMemo(() => {
    return {
      total: referrals.length,
      fechados: referrals.filter((r) => r.status === 'creditado').length,
      pendentes: referrals.filter((r) => r.status === 'pendente').length,
    };
  }, [referrals]);

  if (loading && !data) {
    return (
      <div className="flex items-center justify-center py-16 text-muted-foreground">
        <Loader2 size={20} className="animate-spin mr-2" />
        Carregando dashboard de afiliado…
      </div>
    );
  }

  return (
    <div className="space-y-6 p-1">
      {/* Header */}
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h2 className="text-lg font-bold text-foreground flex items-center gap-2">
            <HandCoins size={20} className="text-emerald-600" />
            Programa de Afiliado
          </h2>
          <p className="text-xs text-muted-foreground mt-0.5">
            {patientName} recebe <strong>{COMMISSION_PCT}%</strong> do valor de cada
            tratamento fechado por indicação dele.
          </p>
        </div>
        <div className="flex items-center gap-3">
          {affiliateCode && (
            <div className="text-right">
              <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-bold">Código</p>
              <p className="text-base font-mono font-bold text-emerald-700 dark:text-emerald-400">
                {affiliateCode}
              </p>
            </div>
          )}
          <button
            onClick={fetchDashboard}
            disabled={loading}
            className="p-1.5 rounded-lg text-muted-foreground hover:text-foreground hover:bg-accent transition-all"
            title="Atualizar"
          >
            <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
          </button>
        </div>
      </div>

      {/* Faixa atual + progresso pra próxima (só quando as faixas estão ligadas) */}
      {faixa?.ativo && faixa.atual && (
        <div className="rounded-xl border border-emerald-300 dark:border-emerald-800 bg-gradient-to-r from-emerald-50 to-transparent dark:from-emerald-950/30 dark:to-transparent p-4">
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <div className="flex items-center gap-2">
              <Award size={16} className="text-emerald-600" />
              <span className="text-sm font-bold text-foreground">Faixa {faixa.atual.label}</span>
              <span className="text-[10px] font-bold uppercase px-1.5 py-0.5 rounded-full bg-emerald-100 text-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-400">
                {faixa.atual.pct}%
              </span>
            </div>
            {faixa.proxima ? (
              <span className="text-xs text-muted-foreground">
                faltam <strong className="text-foreground">{faixa.faltam}</strong>{' '}
                indicaç{faixa.faltam === 1 ? 'ão' : 'ões'} pra{' '}
                <strong className="text-foreground">{faixa.proxima.label}</strong> ({faixa.proxima.pct}%)
              </span>
            ) : (
              <span className="text-xs font-semibold text-emerald-700 dark:text-emerald-400">
                Faixa máxima atingida 🏆
              </span>
            )}
          </div>
          {faixa.proxima && (
            <div className="mt-2 h-2 rounded-full bg-emerald-100 dark:bg-emerald-950/50 overflow-hidden">
              <div
                className="h-full bg-emerald-500 rounded-full transition-all"
                style={{
                  width: `${Math.min(100, Math.round((faixa.indicacoesCreditadas / Math.max(1, faixa.proxima.min)) * 100))}%`,
                }}
              />
            </div>
          )}
        </div>
      )}

      {/* Cards de saldo */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
        <div className="rounded-xl border-2 border-emerald-300 dark:border-emerald-800 bg-gradient-to-br from-emerald-50 to-emerald-100/40 dark:from-emerald-950/40 dark:to-emerald-900/20 p-4">
          <div className="flex items-center gap-2 text-emerald-700 dark:text-emerald-400 mb-1">
            <Wallet size={14} />
            <span className="text-[10px] uppercase font-bold tracking-wider">Disponível</span>
          </div>
          <p className="text-2xl font-bold text-emerald-900 dark:text-emerald-300 tabular-nums">
            {brl(stats.disponivel)}
          </p>
          <p className="text-[11px] text-emerald-700/70 dark:text-emerald-400/70 mt-1">
            pronto pra sacar
          </p>
        </div>

        <div className="rounded-xl border border-border bg-card p-4">
          <div className="flex items-center gap-2 text-muted-foreground mb-1">
            <TrendingUp size={14} />
            <span className="text-[10px] uppercase font-bold tracking-wider">Acumulado</span>
          </div>
          <p className="text-2xl font-bold text-foreground tabular-nums">
            {brl(stats.totalAcumulado)}
          </p>
          <p className="text-[11px] text-muted-foreground mt-1">total ganho histórico</p>
        </div>

        <div className="rounded-xl border border-border bg-card p-4">
          <div className="flex items-center gap-2 text-muted-foreground mb-1">
            <Download size={14} />
            <span className="text-[10px] uppercase font-bold tracking-wider">Sacado</span>
          </div>
          <p className="text-2xl font-bold text-foreground tabular-nums">
            {brl(stats.totalSacado)}
          </p>
          <p className="text-[11px] text-muted-foreground mt-1">já retirado</p>
        </div>

        <div className="rounded-xl border border-amber-300 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/30 p-4">
          <div className="flex items-center gap-2 text-amber-700 dark:text-amber-400 mb-1">
            <Clock size={14} />
            <span className="text-[10px] uppercase font-bold tracking-wider">Pendente</span>
          </div>
          <p className="text-2xl font-bold text-amber-800 dark:text-amber-300 tabular-nums">
            {brl(stats.pendenteSaque)}
          </p>
          <p className="text-[11px] text-amber-700/70 dark:text-amber-400/70 mt-1">
            saque solicitado
          </p>
        </div>
      </div>

      {/* Acoes principais */}
      <div className="flex flex-wrap gap-2">
        <button
          onClick={() => setShowWithdrawModal(true)}
          disabled={stats.disponivel <= 0}
          className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-emerald-600 text-white text-sm font-bold hover:bg-emerald-700 transition-colors shadow-sm disabled:opacity-40 disabled:pointer-events-none"
        >
          <ArrowDownToLine size={14} />
          Sacar saldo
        </button>
        <button
          disabled={stats.disponivel <= 0}
          className="inline-flex items-center gap-2 px-4 py-2 rounded-lg border border-emerald-300 dark:border-emerald-800 text-emerald-700 dark:text-emerald-400 text-sm font-bold hover:bg-emerald-50 dark:hover:bg-emerald-950/30 transition-colors disabled:opacity-40 disabled:pointer-events-none"
        >
          <CheckCircle2 size={14} />
          Usar como crédito em tratamento
        </button>
      </div>

      {/* Barra de acompanhamento: o que pede ação AGORA entre os indicados.
          Só aparece quando há algo a fazer — tela limpa quando está tudo em dia. */}
      {alertas && (alertas.atrasados > 0 || alertas.sumidos > 0 || alertas.em_negociacao > 0) && (
        <div className="flex flex-wrap items-center gap-2 rounded-xl border border-border bg-muted/20 px-3 py-2">
          <span className="text-[11px] font-bold uppercase tracking-wider text-muted-foreground">
            Precisa de atenção
          </span>
          {alertas.atrasados > 0 && (
            <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-red-700 dark:text-red-400 bg-red-500/10 border border-red-500/30 rounded-full px-2.5 py-1">
              <AlertCircle size={12} />
              {alertas.atrasados} em atraso · {brl(alertas.valor_atrasado)}
            </span>
          )}
          {alertas.sumidos > 0 && (
            <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-amber-700 dark:text-amber-400 bg-amber-500/10 border border-amber-500/30 rounded-full px-2.5 py-1">
              <Clock size={12} />
              {alertas.sumidos} sem agenda
            </span>
          )}
          {alertas.em_negociacao > 0 && (
            <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-sky-700 dark:text-sky-400 bg-sky-500/10 border border-sky-500/30 rounded-full px-2.5 py-1">
              <TrendingUp size={12} />
              {alertas.em_negociacao} negociando · {brl(alertas.valor_em_negociacao)}
            </span>
          )}
        </div>
      )}

      {/* Indicacoes */}
      <section className="rounded-xl border border-border bg-card overflow-hidden">
        <header className="flex items-center justify-between px-4 py-3 border-b border-border bg-muted/30">
          <div className="flex items-center gap-2">
            <Users size={14} className="text-emerald-600" />
            <h3 className="text-sm font-bold text-foreground">Indicações</h3>
            <span className="text-xs text-muted-foreground">
              ({referralsByStatus.fechados} fechadas · {referralsByStatus.pendentes} pendentes)
            </span>
          </div>
          <button
            type="button"
            onClick={() => setShowRetroModal(true)}
            className="text-xs font-semibold text-primary hover:underline inline-flex items-center gap-1"
            title="Registrar uma venda antiga que este afiliado indicou"
          >
            <Clock size={12} />
            Lançar indicação antiga
          </button>
        </header>

        {referrals.length === 0 ? (
          <div className="px-4 py-10 text-center text-muted-foreground">
            <Users size={28} className="mx-auto mb-2 opacity-40" />
            <p className="text-sm font-medium">Nenhuma indicação ainda</p>
            <p className="text-xs mt-1">
              Quando alguém se cadastrar usando o código <strong>{affiliateCode || '—'}</strong>
              {' '}e fechar um tratamento, vai aparecer aqui.
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-muted/40 text-[10px] uppercase tracking-wider text-muted-foreground">
              <tr>
                <th className="px-4 py-2 text-left font-bold">Paciente indicado</th>
                <th className="px-4 py-2 text-left font-bold">Situação</th>
                <th className="px-4 py-2 text-left font-bold">Pagamentos</th>
                <th className="px-4 py-2 text-left font-bold">Tratamento</th>
                <th className="px-4 py-2 text-left font-bold">Atendimento</th>
                <th className="px-4 py-2 text-right font-bold">Valor tratamento</th>
                <th className="px-4 py-2 text-right font-bold">Comissão ({COMMISSION_PCT}%)</th>
                <th className="px-4 py-2 text-center font-bold">Status</th>
              </tr>
            </thead>
            <tbody>
              {referrals.map((r) => (
                <tr key={r.id} className="border-t border-border hover:bg-accent/40 align-top">
                  <td className="px-4 py-2.5">
                    {r.indicated_id ? (
                      <a
                        href={`/atendimento/pacientes/${r.indicated_id}`}
                        className="font-semibold text-foreground hover:text-primary hover:underline"
                      >
                        {r.indicated_name}
                      </a>
                    ) : (
                      <span className="font-semibold text-foreground">{r.indicated_name}</span>
                    )}
                    {r.indicated_phone && (
                      <div className="text-xs text-muted-foreground">{r.indicated_phone}</div>
                    )}
                    <div className="text-[10px] text-muted-foreground mt-0.5">
                      fechou {r.closed_at ? formatDate(r.closed_at) : '—'}
                    </div>
                  </td>
                  <td className="px-4 py-2.5">
                    <SemaforoDot alerta={r.contexto?.alerta ?? 'OK'} />
                  </td>
                  <td className="px-4 py-2.5"><PagamentoCell ctx={r.contexto ?? null} /></td>
                  <td className="px-4 py-2.5"><TratamentoCell ctx={r.contexto ?? null} /></td>
                  <td className="px-4 py-2.5"><AtendimentoCell ctx={r.contexto ?? null} /></td>
                  <td className="px-4 py-2.5 text-right tabular-nums text-foreground">
                    {brl(r.treatment_value)}
                  </td>
                  <td className="px-4 py-2.5 text-right tabular-nums font-bold text-emerald-700 dark:text-emerald-400">
                    {brl(r.commission_value)}
                  </td>
                  <td className="px-4 py-2.5 text-center">
                    <StatusBadge status={r.status} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        )}
      </section>

      {/* Pipeline: indicados que ainda NAO fecharam. Sem isso a aba so conta
          comissao — e ninguem lembra de correr atras de quem ficou pelo caminho. */}
      {pipeline.length > 0 && (
        <section className="rounded-xl border border-border bg-card overflow-hidden">
          <header className="flex items-center justify-between px-4 py-3 border-b border-border bg-muted/30">
            <div className="flex items-center gap-2">
              <Clock size={14} className="text-sky-600" />
              <h3 className="text-sm font-bold text-foreground">Indicados que ainda não fecharam</h3>
              <span className="text-xs text-muted-foreground">({pipeline.length})</span>
            </div>
            <span className="text-[10px] text-muted-foreground">
              ainda não geram comissão
            </span>
          </header>
          <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-muted/40 text-[10px] uppercase tracking-wider text-muted-foreground">
              <tr>
                <th className="px-4 py-2 text-left font-bold">Indicado</th>
                <th className="px-4 py-2 text-left font-bold">Situação</th>
                <th className="px-4 py-2 text-left font-bold">Negociação</th>
                <th className="px-4 py-2 text-left font-bold">Atendimento</th>
                <th className="px-4 py-2 text-left font-bold">Vínculo</th>
              </tr>
            </thead>
            <tbody>
              {pipeline.map((row) => (
                <tr key={row.patient_id} className="border-t border-border hover:bg-accent/40 align-top">
                  <td className="px-4 py-2.5">
                    <a
                      href={`/atendimento/pacientes/${row.patient_id}`}
                      className="font-semibold text-foreground hover:text-primary hover:underline"
                    >
                      {row.name || 'Sem nome'}
                    </a>
                    {row.phone && (
                      <div className="text-xs text-muted-foreground">{row.phone}</div>
                    )}
                  </td>
                  <td className="px-4 py-2.5">
                    <SemaforoDot alerta={row.contexto?.alerta ?? 'OK'} />
                  </td>
                  <td className="px-4 py-2.5"><NegociacaoCell ctx={row.contexto} /></td>
                  <td className="px-4 py-2.5"><AtendimentoCell ctx={row.contexto} /></td>
                  <td className="px-4 py-2.5">
                    <span className="text-[10px] text-muted-foreground">
                      {row.origem === 'venda' ? 'só nesta venda' : 'cadastro (todas as vendas)'}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        </section>
      )}

      {/* Saques */}
      <section className="rounded-xl border border-border bg-card overflow-hidden">
        <header className="flex items-center gap-2 px-4 py-3 border-b border-border bg-muted/30">
          <Download size={14} className="text-emerald-600" />
          <h3 className="text-sm font-bold text-foreground">Histórico de saques</h3>
        </header>

        {withdrawals.length === 0 ? (
          <div className="px-4 py-8 text-center text-muted-foreground">
            <p className="text-sm">Nenhum saque registrado ainda.</p>
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-muted/40 text-[10px] uppercase tracking-wider text-muted-foreground">
              <tr>
                <th className="px-4 py-2 text-left font-bold">Solicitado</th>
                <th className="px-4 py-2 text-left font-bold">Método</th>
                <th className="px-4 py-2 text-right font-bold">Valor</th>
                <th className="px-4 py-2 text-center font-bold">Status</th>
                <th className="px-4 py-2 text-left font-bold">Pago em</th>
              </tr>
            </thead>
            <tbody>
              {withdrawals.map((w) => (
                <tr key={w.id} className="border-t border-border hover:bg-accent/40">
                  <td className="px-4 py-2.5">{formatDate(w.requested_at)}</td>
                  <td className="px-4 py-2.5 text-muted-foreground">
                    {w.method === 'PIX' && 'PIX'}
                    {w.method === 'DINHEIRO' && 'Dinheiro'}
                    {w.method === 'CREDITO_TRATAMENTO' && 'Crédito em tratamento'}
                  </td>
                  <td className="px-4 py-2.5 text-right tabular-nums font-bold">
                    {brl(w.amount)}
                  </td>
                  <td className="px-4 py-2.5 text-center">
                    <WithdrawalStatusBadge status={w.status} />
                  </td>
                  <td className="px-4 py-2.5 text-muted-foreground">
                    {w.paid_at ? formatDate(w.paid_at) : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {/* Info box (rodape) */}
      <div className="rounded-lg border border-blue-200 dark:border-blue-900/50 bg-blue-50 dark:bg-blue-950/20 p-3 text-xs text-blue-900 dark:text-blue-300 flex items-start gap-2">
        <Info size={14} className="shrink-0 mt-0.5" />
        <div>
          <strong>Como funciona o crédito:</strong> em vez de sacar em dinheiro, o saldo
          pode virar desconto em qualquer tratamento próprio do afiliado (vale como PIX
          no fechamento). A escolha é feita no momento do saque.
        </div>
      </div>

      {/* Lancamento retroativo de indicacao */}
      {showRetroModal && (
        <LancarRetroativoModal
          affiliateId={patientId}
          affiliateName={patientName}
          defaultPct={COMMISSION_PCT}
          onClose={() => setShowRetroModal(false)}
          onSuccess={() => {
            setShowRetroModal(false);
            fetchDashboard();
          }}
        />
      )}

      {/* Modal de saque */}
      {showWithdrawModal && (
        <WithdrawModal
          available={stats.disponivel}
          patientId={patientId}
          onClose={() => setShowWithdrawModal(false)}
          onSuccess={() => {
            setShowWithdrawModal(false);
            fetchDashboard();
          }}
        />
      )}
    </div>
  );
}


/**
 * Lancamento RETROATIVO de indicacao (admin).
 *
 * O motor automatico so credita comissao em venda NOVA. Tudo que fechou antes
 * do afiliado existir no sistema entra por aqui, na mao.
 *
 * O valor e sempre o ACERTADO na negociacao, SEM juros do parcelamento —
 * amarrando numa proposta, o campo ja vem preenchido com o valor da proposta
 * (que e o combinado; juros vivem nas cobrancas, nunca na proposta).
 */
type PacienteLite = { id: string; name: string | null; phone: string | null };
type QuoteLite = { id: string; status: string; title: string | null; quote_number?: number; total_value: string | number; created_at: string };

function LancarRetroativoModal({
  affiliateId,
  affiliateName,
  defaultPct,
  onClose,
  onSuccess,
}: {
  affiliateId: string;
  affiliateName: string;
  defaultPct: number;
  onClose: () => void;
  onSuccess: () => void;
}) {
  const [term, setTerm] = useState('');
  const [busca, setBusca] = useState<Array<{ id: string; name: string | null; phone: string | null }>>([]);
  const [buscando, setBuscando] = useState(false);
  const [indicado, setIndicado] = useState<{ id: string; name: string | null; phone: string | null } | null>(null);

  const [quotes, setQuotes] = useState<QuoteLite[]>([]);
  const [quoteId, setQuoteId] = useState('');

  const [valor, setValor] = useState('');
  const [pct, setPct] = useState(String(defaultPct));
  const [data, setData] = useState('');
  const [notas, setNotas] = useState('');
  const [jaRepassado, setJaRepassado] = useState(false);
  const [metodo, setMetodo] = useState<'DINHEIRO' | 'PIX' | 'CREDITO_TRATAMENTO'>('DINHEIRO');
  const [salvando, setSalvando] = useState(false);

  // Busca do paciente indicado — no servidor, debounce 300ms.
  useEffect(() => {
    const q = term.trim();
    if (indicado || q.length < 2) { setBusca([]); setBuscando(false); return; }
    setBuscando(true);
    let cancelled = false;
    const t = setTimeout(() => {
      api.get(`/patients?limit=10&status=ACTIVE&search=${encodeURIComponent(q)}`)
        .then((r) => { if (!cancelled) setBusca((r.data?.data || []).map((x: PacienteLite) => ({ id: x.id, name: x.name, phone: x.phone }))); })
        .catch(() => { if (!cancelled) setBusca([]); })
        .finally(() => { if (!cancelled) setBuscando(false); });
    }, 300);
    return () => { cancelled = true; clearTimeout(t); };
  }, [term, indicado]);

  // Propostas ACEITAS do indicado: amarrar a venda da o rastro e o valor certo.
  useEffect(() => {
    if (!indicado) { setQuotes([]); return; }
    api.get(`/patients/${indicado.id}/quotes`)
      .then((r) => setQuotes((r.data || []).filter((q: QuoteLite) => q.status === 'ACCEPTED')))
      .catch(() => setQuotes([]));
  }, [indicado]);

  const escolherQuote = (id: string) => {
    setQuoteId(id);
    const q = quotes.find((x) => x.id === id);
    if (q) {
      setValor(String(Number(q.total_value) || 0));
      if (!data) setData(String(q.created_at).slice(0, 10));
    }
  };

  const valorNum = Number(String(valor).replace(',', '.')) || 0;
  const pctNum = Number(String(pct).replace(',', '.')) || 0;
  const comissao = +(valorNum * (pctNum / 100)).toFixed(2);

  const salvar = async () => {
    if (!indicado) { showError('Escolha o paciente indicado'); return; }
    if (!(valorNum > 0)) { showError('Informe o valor acertado do tratamento'); return; }
    if (!(pctNum > 0)) { showError('Informe o percentual da comissão'); return; }
    setSalvando(true);
    try {
      const body: Record<string, unknown> = {
        referred_patient_id: indicado.id,
        treatment_value: +valorNum.toFixed(2),
        commission_pct: +pctNum.toFixed(2),
      };
      if (quoteId) body.quote_id = quoteId;
      if (data) body.closed_at = data;
      if (notas.trim()) body.notes = notas.trim();
      if (jaRepassado) { body.ja_repassado = true; body.repasse_method = metodo; }
      await api.post(`/patients/${affiliateId}/affiliate/referrals`, body);
      showSuccess(
        jaRepassado
          ? `Indicação lançada e comissão marcada como repassada (${brl(comissao)})`
          : `Indicação lançada — ${brl(comissao)} creditados`,
      );
      onSuccess();
    } catch (e: unknown) {
      const err = e as { response?: { data?: { message?: string } } };
      showError(err?.response?.data?.message || 'Erro ao lançar indicação');
    } finally {
      setSalvando(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[100] bg-black/50 backdrop-blur-sm flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-card border border-border rounded-xl w-full max-w-lg shadow-2xl max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
        <div className="px-4 py-3 border-b border-border">
          <h3 className="text-sm font-bold text-foreground flex items-center gap-2">
            <Clock size={15} className="text-sky-600" />
            Lançar indicação antiga
          </h3>
          <p className="text-[11px] text-muted-foreground mt-0.5">
            Venda que <strong>{affiliateName}</strong> indicou e já fechou, mas nunca foi registrada.
          </p>
        </div>

        <div className="p-4 space-y-3">
          {/* 1. Paciente indicado */}
          <div>
            <label className="block text-xs font-semibold mb-1">Paciente indicado</label>
            {indicado ? (
              <div className="flex items-center justify-between gap-2 p-2 rounded-lg border border-border bg-background">
                <div className="text-sm min-w-0">
                  <div className="font-medium truncate">{indicado.name || 'Sem nome'}</div>
                  <div className="text-[11px] text-muted-foreground">{indicado.phone || 'sem telefone'}</div>
                </div>
                <button
                  type="button"
                  onClick={() => { setIndicado(null); setTerm(''); setQuoteId(''); setQuotes([]); }}
                  className="text-xs text-muted-foreground hover:text-foreground shrink-0"
                >
                  Trocar
                </button>
              </div>
            ) : (
              <>
                <input
                  autoFocus
                  value={term}
                  onChange={(e) => setTerm(e.target.value)}
                  placeholder="Buscar por nome, telefone ou CPF..."
                  className="w-full px-2.5 py-1.5 text-sm rounded-md border border-border bg-background"
                />
                {term.trim().length >= 2 && (
                  <div className="mt-1 max-h-36 overflow-y-auto border border-border rounded-md bg-background">
                    {buscando ? (
                      <div className="p-2 text-[11px] text-muted-foreground">Buscando...</div>
                    ) : busca.length === 0 ? (
                      <div className="p-2 text-[11px] text-muted-foreground">Nenhum paciente encontrado</div>
                    ) : (
                      busca.map((b) => (
                        <button
                          type="button"
                          key={b.id}
                          onClick={() => { setIndicado(b); setTerm(''); }}
                          className="w-full px-2.5 py-1.5 text-left text-sm hover:bg-accent border-b border-border last:border-0"
                        >
                          <div className="font-medium">{b.name || 'Sem nome'}</div>
                          <div className="text-[10px] text-muted-foreground">{b.phone || 'sem telefone'}</div>
                        </button>
                      ))
                    )}
                  </div>
                )}
              </>
            )}
          </div>

          {/* 2. Proposta (opcional) — preenche o valor acertado */}
          {indicado && (
            <div>
              <label className="block text-xs font-semibold mb-1">
                Proposta que gerou a venda <span className="font-normal text-muted-foreground">(opcional)</span>
              </label>
              {quotes.length === 0 ? (
                <p className="text-[11px] text-muted-foreground">
                  Nenhuma proposta aceita neste cadastro — informe o valor na mão abaixo.
                </p>
              ) : (
                <select
                  value={quoteId}
                  onChange={(e) => escolherQuote(e.target.value)}
                  className="w-full px-2.5 py-1.5 text-sm rounded-md border border-border bg-background"
                >
                  <option value="">Sem vínculo com proposta</option>
                  {quotes.map((q) => (
                    <option key={q.id} value={q.id}>
                      {q.quote_number ? `#${q.quote_number} · ` : ''}{q.title || 'Sem nome'} — {brl(Number(q.total_value) || 0)}
                    </option>
                  ))}
                </select>
              )}
            </div>
          )}

          {/* 3. Valor + % */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-semibold mb-1">Valor acertado (R$)</label>
              <input
                value={valor}
                onChange={(e) => setValor(e.target.value)}
                inputMode="decimal"
                placeholder="0,00"
                className="w-full px-2.5 py-1.5 text-sm rounded-md border border-border bg-background tabular-nums"
              />
              <p className="text-[10px] text-muted-foreground mt-0.5">sem os juros do parcelamento</p>
            </div>
            <div>
              <label className="block text-xs font-semibold mb-1">Comissão (%)</label>
              <input
                value={pct}
                onChange={(e) => setPct(e.target.value)}
                inputMode="decimal"
                className="w-full px-2.5 py-1.5 text-sm rounded-md border border-border bg-background tabular-nums"
              />
              <p className="text-[10px] text-muted-foreground mt-0.5">padrão do cadastro: {defaultPct}%</p>
            </div>
          </div>

          {/* 4. Data + observação */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-semibold mb-1">Data do fechamento</label>
              <input
                type="date"
                value={data}
                onChange={(e) => setData(e.target.value)}
                className="w-full px-2.5 py-1.5 text-sm rounded-md border border-border bg-background"
              />
            </div>
            <div>
              <label className="block text-xs font-semibold mb-1">Observação</label>
              <input
                value={notas}
                onChange={(e) => setNotas(e.target.value)}
                placeholder="ex: acerto verbal de 2025"
                className="w-full px-2.5 py-1.5 text-sm rounded-md border border-border bg-background"
              />
            </div>
          </div>

          {/* 5. Já repassei */}
          <div className="rounded-lg border border-border bg-muted/20 p-2.5">
            <label className="flex items-start gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={jaRepassado}
                onChange={(e) => setJaRepassado(e.target.checked)}
                className="mt-0.5"
              />
              <span className="text-xs">
                <strong>Já repassei essa comissão</strong>
                <span className="block text-[10px] text-muted-foreground mt-0.5">
                  Registra como pago no mesmo lançamento — não entra no saldo disponível. Não lança
                  despesa no caixa de hoje (o dinheiro saiu no passado, fora do sistema).
                </span>
              </span>
            </label>
            {jaRepassado && (
              <select
                value={metodo}
                onChange={(e) => setMetodo(e.target.value as 'DINHEIRO' | 'PIX' | 'CREDITO_TRATAMENTO')}
                className="mt-2 w-full px-2.5 py-1.5 text-sm rounded-md border border-border bg-background"
              >
                <option value="DINHEIRO">Dinheiro</option>
                <option value="PIX">PIX</option>
                <option value="CREDITO_TRATAMENTO">Crédito em tratamento</option>
              </select>
            )}
          </div>

          {/* Resumo */}
          <div className="flex items-center justify-between rounded-lg bg-emerald-500/10 border border-emerald-500/30 px-3 py-2">
            <span className="text-xs font-semibold text-foreground">Comissão</span>
            <span className="text-sm font-bold tabular-nums text-emerald-700 dark:text-emerald-400">
              {brl(comissao)}
            </span>
          </div>
        </div>

        <div className="px-4 py-3 border-t border-border flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={salvando}
            className="px-3 py-1.5 text-xs rounded-lg border border-border hover:bg-accent disabled:opacity-50"
          >
            Cancelar
          </button>
          <button
            type="button"
            onClick={salvar}
            disabled={salvando || !indicado || !(valorNum > 0)}
            className="px-3 py-1.5 text-xs font-semibold rounded-lg bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-50 inline-flex items-center gap-1.5"
          >
            {salvando && <Loader2 size={12} className="animate-spin" />}
            Lançar indicação
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Helpers ───────────────────────────────────────────

function StatusBadge({ status }: { status: Referral['status'] }) {
  const map = {
    creditado: { label: 'Creditado', cls: 'bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-400 border-emerald-200 dark:border-emerald-900' },
    pendente:  { label: 'Pendente',  cls: 'bg-amber-50 dark:bg-amber-950/40 text-amber-700 dark:text-amber-400 border-amber-200 dark:border-amber-900' },
    cancelado: { label: 'Cancelado', cls: 'bg-rose-50 dark:bg-rose-950/40 text-rose-700 dark:text-rose-400 border-rose-200 dark:border-rose-900' },
  };
  const m = map[status];
  return (
    <span className={`inline-block text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded border ${m.cls}`}>
      {m.label}
    </span>
  );
}

function WithdrawalStatusBadge({ status }: { status: Withdrawal['status'] }) {
  const map = {
    pago:        { label: 'Pago',        cls: 'bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-400 border-emerald-200 dark:border-emerald-900' },
    solicitado:  { label: 'Solicitado',  cls: 'bg-amber-50 dark:bg-amber-950/40 text-amber-700 dark:text-amber-400 border-amber-200 dark:border-amber-900' },
    recusado:    { label: 'Recusado',    cls: 'bg-rose-50 dark:bg-rose-950/40 text-rose-700 dark:text-rose-400 border-rose-200 dark:border-rose-900' },
  };
  const m = map[status];
  return (
    <span className={`inline-block text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded border ${m.cls}`}>
      {m.label}
    </span>
  );
}

// ─── Modal de saque ───────────────────────────────────────

function WithdrawModal({
  available,
  patientId,
  onClose,
  onSuccess,
}: {
  available: number;
  patientId: string;
  onClose: () => void;
  onSuccess: () => void;
}) {
  const [amount, setAmount] = useState(available);
  const [method, setMethod] = useState<'PIX' | 'DINHEIRO' | 'CREDITO_TRATAMENTO'>('PIX');
  const [pixKey, setPixKey] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const valid = amount > 0 && amount <= available && (method !== 'PIX' || pixKey.trim().length > 0);

  const handleSubmit = async () => {
    setSubmitting(true);
    try {
      await api.post(`/patients/${patientId}/affiliate/withdraw`, {
        amount,
        method,
        ...(method === 'PIX' ? { pix_key: pixKey.trim() } : {}),
      });
      showSuccess('Saque solicitado — aguardando confirmação do admin');
      onSuccess();
    } catch (e: any) {
      showError(e?.response?.data?.message || 'Erro ao solicitar saque');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[9999] flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm">
      <div className="w-full max-w-md bg-card border border-border rounded-2xl shadow-2xl">
        <header className="flex items-center justify-between px-5 py-4 border-b border-border">
          <h3 className="text-base font-bold text-foreground flex items-center gap-2">
            <ArrowDownToLine size={16} className="text-emerald-600" />
            Solicitar saque
          </h3>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground">✕</button>
        </header>

        <div className="p-5 space-y-4">
          <div className="rounded-lg bg-emerald-50 dark:bg-emerald-950/30 border border-emerald-200 dark:border-emerald-900 p-3 text-center">
            <p className="text-[10px] uppercase tracking-wider font-bold text-emerald-700 dark:text-emerald-400">Disponível</p>
            <p className="text-xl font-bold text-emerald-900 dark:text-emerald-300 tabular-nums">
              {available.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })}
            </p>
          </div>

          <div>
            <label className="text-xs font-bold uppercase tracking-wider text-muted-foreground mb-1 block">
              Valor a sacar
            </label>
            <input
              type="number"
              min={0.01}
              max={available}
              step={0.01}
              value={amount}
              onChange={(e) => setAmount(Number(e.target.value))}
              className="w-full px-3 py-2 rounded-lg border border-border bg-background text-base font-bold text-foreground outline-none focus:ring-2 focus:ring-emerald-500/30"
            />
          </div>

          <div>
            <label className="text-xs font-bold uppercase tracking-wider text-muted-foreground mb-1 block">
              Método
            </label>
            <div className="grid grid-cols-3 gap-2">
              {([
                { id: 'PIX', label: 'PIX' },
                { id: 'DINHEIRO', label: 'Dinheiro' },
                { id: 'CREDITO_TRATAMENTO', label: 'Crédito' },
              ] as const).map((m) => (
                <button
                  key={m.id}
                  type="button"
                  onClick={() => setMethod(m.id)}
                  className={`px-3 py-2 rounded-lg border text-sm font-bold transition-all ${
                    method === m.id
                      ? 'bg-emerald-500/10 border-emerald-500 text-emerald-700 dark:text-emerald-400'
                      : 'border-border text-muted-foreground hover:bg-accent'
                  }`}
                >
                  {m.label}
                </button>
              ))}
            </div>
          </div>

          {method === 'PIX' && (
            <div>
              <label className="text-xs font-bold uppercase tracking-wider text-muted-foreground mb-1 block">
                Chave PIX
              </label>
              <input
                value={pixKey}
                onChange={(e) => setPixKey(e.target.value)}
                placeholder="CPF, telefone, email ou chave aleatória"
                className="w-full px-3 py-2 rounded-lg border border-border bg-background text-sm outline-none focus:ring-2 focus:ring-emerald-500/30"
              />
            </div>
          )}

          {method === 'CREDITO_TRATAMENTO' && (
            <div className="rounded-lg border border-blue-200 dark:border-blue-900 bg-blue-50 dark:bg-blue-950/30 p-3 text-xs text-blue-900 dark:text-blue-300 flex items-start gap-2">
              <Info size={13} className="shrink-0 mt-0.5" />
              <span>O valor vai aparecer como desconto disponível no próximo orçamento criado pra esse paciente.</span>
            </div>
          )}

          {amount > available && (
            <div className="rounded-lg border border-rose-300 dark:border-rose-900 bg-rose-50 dark:bg-rose-950/30 p-2 text-xs text-rose-700 dark:text-rose-400 flex items-center gap-1.5">
              <AlertCircle size={12} />
              Valor maior que o disponível pra saque.
            </div>
          )}
        </div>

        <footer className="flex justify-end gap-2 px-5 py-3 border-t border-border bg-muted/20">
          <button onClick={onClose} className="px-4 py-2 rounded-lg text-sm font-medium text-muted-foreground hover:bg-accent">
            Cancelar
          </button>
          <button
            onClick={handleSubmit}
            disabled={!valid || submitting}
            className="px-4 py-2 rounded-lg bg-emerald-600 text-white text-sm font-bold hover:bg-emerald-700 disabled:opacity-40 disabled:pointer-events-none"
          >
            {submitting ? 'Solicitando...' : 'Solicitar saque'}
          </button>
        </footer>
      </div>
    </div>
  );
}

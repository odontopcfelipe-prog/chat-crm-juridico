'use client';

/**
 * "Boletos do mês" — topo da aba (BoletosTab, chip "Do mês").
 *
 * Mostra o mês inteiro pelo VENCIMENTO, nas cores pedidas pela clínica:
 *   pago = verde · vence hoje = amarelo · a vencer = normal · atrasado = vermelho.
 *  - faixa do mês: quanto já entrou × quanto falta (cada cor = um pedaço);
 *  - cartões por situação (clicar filtra a lista);
 *  - calendário: o total que vence em cada dia, com a mesma barra de cores
 *    (clicar num dia mostra só aquele dia na lista).
 * Os dados vêm de GET /financeiro/charges/month (BoletosTab busca e repassa).
 */

import { useMemo } from 'react';
import Link from 'next/link';
import { AlertTriangle, ChevronLeft, ChevronRight, Loader2, X } from 'lucide-react';

export type MesStatus = 'pago' | 'hoje' | 'aberto' | 'atrasado';

/** Parcelamento gravado como cobrança ÚNICA (valor total) — fica fora do calendário. */
export interface MesGuardaChuva {
  charge_id: string;
  patient: { id: string; name: string | null } | null;
  installments: number | null;
  total: number;
  first_due: string;
}

export interface MesCharge {
  id: string;
  amount: number;
  due_date: string;
  computed_status: 'PAGO' | 'CANCELADO' | 'ATRASADO' | 'EM_ABERTO';
  due_today?: boolean;
}

/** Situação da cobrança na visão do mês. */
export const statusDoMes = (c: MesCharge): MesStatus =>
  c.computed_status === 'PAGO' ? 'pago' : c.computed_status === 'ATRASADO' ? 'atrasado' : c.due_today ? 'hoje' : 'aberto';

/** Dia do vencimento (AAAA-MM-DD). `due_date` é DATA à meia-noite UTC → a parte UTC é o dia certo. */
export const diaDoVencimento = (c: { due_date: string }) => c.due_date.slice(0, 10);

/** Mês de hoje no fuso da clínica (Maceió, UTC-3 fixo). */
export const mesAtualMaceio = () => new Date(Date.now() - 3 * 3_600_000).toISOString().slice(0, 7);

export const somarMes = (mes: string, delta: number) => {
  const [y, m] = mes.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + delta, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
};

export const nomeDoMes = (mes: string) => {
  const [y, m] = mes.split('-').map(Number);
  const s = new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString('pt-BR', { month: 'long', year: 'numeric', timeZone: 'UTC' });
  return s.charAt(0).toUpperCase() + s.slice(1);
};

/** Cores de cada situação — a lista (BoletosTab) usa as mesmas. */
export const MES_COR: Record<MesStatus, { label: string; bar: string; text: string; tile: string; dot: string }> = {
  pago: {
    label: 'Recebido',
    bar: 'bg-emerald-500',
    text: 'text-emerald-600 dark:text-emerald-400',
    tile: 'border-emerald-500/40 bg-emerald-500/[0.07]',
    dot: 'bg-emerald-500',
  },
  hoje: {
    label: 'Vence hoje',
    bar: 'bg-yellow-400',
    text: 'text-yellow-600 dark:text-yellow-400',
    tile: 'border-yellow-400/60 bg-yellow-400/[0.12]',
    dot: 'bg-yellow-400',
  },
  aberto: {
    label: 'A vencer',
    bar: 'bg-slate-300 dark:bg-slate-600',
    text: 'text-foreground',
    tile: 'border-border bg-background',
    dot: 'bg-slate-400',
  },
  atrasado: {
    label: 'Atrasado',
    bar: 'bg-red-500',
    text: 'text-red-600 dark:text-red-400',
    tile: 'border-red-500/40 bg-red-500/[0.07]',
    dot: 'bg-red-500',
  },
};
const ORDEM: MesStatus[] = ['pago', 'hoje', 'aberto', 'atrasado'];
const SEMANA = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];

const fmtBRL = (v: number) => v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
/** Valor mínimo pra célula do celular (~40px): 466 · 1,6k · 12k. */
const fmtMini = (v: number) =>
  v >= 1000 ? `${(v / 1000).toLocaleString('pt-BR', { maximumFractionDigits: v >= 10_000 ? 0 : 1 })}k` : String(Math.round(v));
/** Valor curto pra caber na célula do calendário. */
const fmtCurto = (v: number) =>
  v >= 10_000
    ? `R$ ${v.toLocaleString('pt-BR', { notation: 'compact', maximumFractionDigits: 1 })}`
    : v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL', maximumFractionDigits: 0 });

type Soma = Record<MesStatus, { total: number; count: number }>;
const somaVazia = (): Soma => ({
  pago: { total: 0, count: 0 },
  hoje: { total: 0, count: 0 },
  aberto: { total: 0, count: 0 },
  atrasado: { total: 0, count: 0 },
});

/** Barra empilhada nas cores da régua (largura proporcional ao valor). */
function BarraStatus({ soma, total, alta }: { soma: Soma; total: number; alta?: boolean }) {
  if (total <= 0) return null;
  return (
    <div className={`flex w-full overflow-hidden rounded-full bg-muted ${alta ? 'h-2.5' : 'h-1'}`}>
      {ORDEM.map((s) =>
        soma[s].total > 0 ? (
          <div key={s} className={MES_COR[s].bar} style={{ width: `${(soma[s].total / total) * 100}%` }} />
        ) : null,
      )}
    </div>
  );
}

interface Props {
  mes: string;
  hoje: string | null;
  charges: MesCharge[];
  loading: boolean;
  /** `charges` é deste mês? Enquanto carrega (ou se falhou) não mostra R$ 0,00 falso. */
  pronto: boolean;
  /** Entrou no mês, mas é de boleto que vence em OUTRO mês. */
  recebidoOutrosMeses: { count: number; total: number } | null;
  /** Parcelamentos gravados como cobrança única (valor total) que podem ter parcela no mês. */
  guardaChuvas: MesGuardaChuva[];
  diaSelecionado: string | null;
  statusSelecionado: MesStatus | null;
  onMes: (mes: string) => void;
  onDia: (dia: string | null) => void;
  onStatus: (s: MesStatus | null) => void;
}

export default function BoletosMesResumo({
  mes, hoje, charges, loading, pronto, recebidoOutrosMeses, guardaChuvas, diaSelecionado, statusSelecionado, onMes, onDia, onStatus,
}: Props) {
  const { geral, totalMes, porDia } = useMemo(() => {
    const geral = somaVazia();
    const porDia = new Map<string, { soma: Soma; total: number; count: number }>();
    let totalMes = 0;
    for (const c of charges) {
      const s = statusDoMes(c);
      geral[s].total += c.amount;
      geral[s].count += 1;
      totalMes += c.amount;
      const k = diaDoVencimento(c);
      let d = porDia.get(k);
      if (!d) { d = { soma: somaVazia(), total: 0, count: 0 }; porDia.set(k, d); }
      d.soma[s].total += c.amount;
      d.soma[s].count += 1;
      d.total += c.amount;
      d.count += 1;
    }
    return { geral, totalMes, porDia };
  }, [charges]);

  const [y, m] = mes.split('-').map(Number);
  const primeiroDiaSemana = new Date(Date.UTC(y, m - 1, 1)).getUTCDay();
  const diasNoMes = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const celulas: (number | null)[] = [
    ...Array.from({ length: primeiroDiaSemana }, () => null),
    ...Array.from({ length: diasNoMes }, (_, i) => i + 1),
  ];
  const mesAtual = mesAtualMaceio();
  const falta = geral.hoje.total + geral.aberto.total + geral.atrasado.total;
  const pctRecebido = totalMes > 0 ? Math.round((geral.pago.total / totalMes) * 100) : 0;

  return (
    <div className="bg-card border border-border rounded-xl p-4 space-y-4">
      {/* Mês + navegação */}
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => onMes(somarMes(mes, -1))}
          className="p-1.5 rounded-lg border border-border hover:bg-accent/40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary"
          aria-label="Mês anterior"
        >
          <ChevronLeft size={16} />
        </button>
        <h2 className="text-base font-bold text-foreground min-w-[150px] text-center">{nomeDoMes(mes)}</h2>
        <button
          type="button"
          onClick={() => onMes(somarMes(mes, 1))}
          className="p-1.5 rounded-lg border border-border hover:bg-accent/40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary"
          aria-label="Próximo mês"
        >
          <ChevronRight size={16} />
        </button>
        {mes !== mesAtual && (
          <button
            type="button"
            onClick={() => onMes(mesAtual)}
            className="px-2.5 py-1 rounded-lg text-xs font-semibold border border-border hover:bg-accent/40"
          >
            Voltar pro mês atual
          </button>
        )}
        {loading && <Loader2 size={15} className="animate-spin text-primary" />}
        <div className="ml-auto text-right">
          <span className="block text-[10px] font-bold uppercase tracking-wider text-muted-foreground">Previsto no mês</span>
          <span className="text-lg font-bold tabular-nums text-foreground">{pronto ? fmtBRL(totalMes) : '—'}</span>
          {pronto && (
            <span className="ml-1.5 text-xs text-muted-foreground">
              · {charges.length} cobrança{charges.length === 1 ? '' : 's'}
            </span>
          )}
        </div>
      </div>

      {/* O que entra nesta aba (fora da linha de navegação — no celular quebrava as setas). */}
      <p className="-mt-2 text-[11px] text-muted-foreground">
        Só vendas parceladas em boleto: parcelas e entrada das propostas + boletos importados do Asaas.
      </p>

      {/* Faixa do mês: recebido × o que falta */}
      <div className="space-y-1.5">
        <BarraStatus soma={geral} total={totalMes} alta />
        <div className="flex flex-wrap justify-between gap-x-4 text-xs text-muted-foreground">
          <span>
            <strong className="text-emerald-600 dark:text-emerald-400 tabular-nums">{pronto ? fmtBRL(geral.pago.total) : '—'}</strong>{' '}
            recebido{pronto ? ` (${pctRecebido}%)` : ''}
          </span>
          <span>
            falta receber <strong className="text-foreground tabular-nums">{pronto ? fmtBRL(falta) : '—'}</strong>
          </span>
        </div>
      </div>

      {/* Cartões por situação — clicar filtra a lista */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-2">
        {ORDEM.map((s) => {
          const ativo = statusSelecionado === s;
          return (
            <button
              key={s}
              type="button"
              onClick={() => onStatus(ativo ? null : s)}
              aria-pressed={ativo}
              title={ativo ? 'Mostrar todas as situações' : `Mostrar só: ${MES_COR[s].label.toLowerCase()}`}
              className={`text-left rounded-lg border px-3 py-2 transition-shadow hover:shadow-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary ${MES_COR[s].tile} ${
                ativo ? 'ring-2 ring-primary' : ''
              }`}
            >
              <span className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wider text-muted-foreground">
                <span className={`w-2 h-2 rounded-full ${MES_COR[s].dot}`} />
                {MES_COR[s].label}
              </span>
              <span className={`block text-base font-bold tabular-nums ${MES_COR[s].text}`}>{pronto ? fmtBRL(geral[s].total) : '—'}</span>
              <span className="text-[11px] text-muted-foreground">
                {pronto ? `${geral[s].count} cobrança${geral[s].count === 1 ? '' : 's'}` : 'carregando…'}
              </span>
            </button>
          );
        })}
      </div>

      {recebidoOutrosMeses && recebidoOutrosMeses.count > 0 && (
        <p className="text-xs text-muted-foreground">
          Também entraram{' '}
          <strong className="text-emerald-600 dark:text-emerald-400 tabular-nums">{fmtBRL(recebidoOutrosMeses.total)}</strong>{' '}
          neste mês de {recebidoOutrosMeses.count} cobrança{recebidoOutrosMeses.count === 1 ? '' : 's'} que vencia
          {recebidoOutrosMeses.count === 1 ? '' : 'm'} em outro mês (atrasada paga agora ou adiantada) — não estão na lista.
        </p>
      )}

      {pronto && guardaChuvas.length > 0 && (
        <div className="rounded-lg border border-amber-500/40 bg-amber-500/[0.07] px-3 py-2 text-xs text-foreground">
          <p className="flex items-start gap-1.5">
            <AlertTriangle size={13} className="mt-0.5 shrink-0 text-amber-600 dark:text-amber-400" />
            <span>
              {guardaChuvas.length === 1 ? 'Este parcelamento ficou gravado' : `Estes ${guardaChuvas.length} parcelamentos ficaram gravados`}{' '}
              como uma cobrança só, com o valor total — por isso <strong>não entram</strong> no previsto nem no calendário.
              Confira as parcelas na ficha do paciente:
            </span>
          </p>
          <ul className="mt-1.5 flex flex-wrap gap-1.5 pl-5">
            {guardaChuvas.map((g) => (
              <li key={g.charge_id}>
                {g.patient ? (
                  <Link
                    href={`/atendimento/pacientes/${g.patient.id}?tab=financial`}
                    className="inline-flex items-center gap-1 rounded-full bg-background border border-border px-2 py-0.5 hover:border-primary hover:text-primary"
                  >
                    {g.patient.name || 'Sem nome'}
                    <span className="text-muted-foreground">
                      · {g.installments ? `${g.installments}x · ` : ''}{fmtBRL(g.total)}
                    </span>
                  </Link>
                ) : (
                  <span className="inline-flex rounded-full bg-background border border-border px-2 py-0.5">
                    Sem paciente · {fmtBRL(g.total)}
                  </span>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Calendário — o que vence em cada dia */}
      <div>
        <div className="flex items-center justify-between mb-1.5">
          <span className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">Vencimentos por dia</span>
          {diaSelecionado && (
            <button
              type="button"
              onClick={() => onDia(null)}
              className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-semibold bg-primary/10 text-primary hover:bg-primary/20"
            >
              Só {diaSelecionado.slice(8, 10)}/{diaSelecionado.slice(5, 7)} <X size={11} />
            </button>
          )}
        </div>
        <div className="grid grid-cols-7 gap-1">
          {SEMANA.map((d) => (
            <div key={d} className="text-center text-[10px] font-semibold uppercase text-muted-foreground pb-0.5">
              {d}
            </div>
          ))}
          {celulas.map((dia, i) => {
            if (dia === null) return <div key={`v${i}`} />;
            const iso = `${mes}-${String(dia).padStart(2, '0')}`;
            const d = porDia.get(iso);
            const ehHoje = iso === hoje;
            const selecionado = diaSelecionado === iso;
            // Cor do valor do dia: atrasado manda, depois vence hoje; tudo pago = verde.
            const cor = !d
              ? ''
              : d.soma.atrasado.count > 0
                ? MES_COR.atrasado.text
                : d.soma.hoje.count > 0
                  ? MES_COR.hoje.text
                  : d.soma.pago.count === d.count
                    ? MES_COR.pago.text
                    : 'text-foreground';
            const resumo = d
              ? `${dia}/${String(m).padStart(2, '0')} · ${d.count} cobrança${d.count === 1 ? '' : 's'} · ${fmtBRL(d.total)}` +
                ORDEM.filter((s) => d.soma[s].count > 0)
                  .map((s) => `\n${MES_COR[s].label}: ${fmtBRL(d.soma[s].total)} (${d.soma[s].count})`)
                  .join('')
              : undefined;
            return (
              <button
                key={iso}
                type="button"
                disabled={!d}
                onClick={() => onDia(selecionado ? null : iso)}
                title={resumo}
                aria-pressed={selecionado}
                aria-label={resumo || `${dia} — nada vence`}
                className={`min-h-[44px] sm:min-h-[58px] min-w-0 overflow-hidden rounded-md border p-1 text-left flex flex-col gap-0.5 transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary ${
                  d ? 'border-border bg-background hover:bg-accent/30 cursor-pointer' : 'border-transparent bg-muted/30 cursor-default'
                } ${ehHoje ? 'border-yellow-400 bg-yellow-400/[0.10]' : ''} ${selecionado ? 'ring-2 ring-primary' : ''}`}
              >
                <span className={`text-[11px] font-semibold tabular-nums ${d ? 'text-foreground' : 'text-muted-foreground/60'}`}>
                  {dia}
                  {/* No celular a célula é estreita: só a borda amarela marca o dia. */}
                  {ehHoje && <span className="hidden sm:inline ml-1 text-[9px] font-bold uppercase text-yellow-600 dark:text-yellow-400">hoje</span>}
                </span>
                {d && (
                  <>
                    <span className={`hidden sm:block text-[11px] font-bold tabular-nums leading-tight truncate ${cor}`}>
                      {fmtCurto(d.total)}
                    </span>
                    <span className={`sm:hidden text-[9px] font-bold tabular-nums leading-tight truncate ${cor}`}>
                      {fmtMini(d.total)}
                    </span>
                    <span className="mt-auto">
                      <BarraStatus soma={d.soma} total={d.total} />
                    </span>
                  </>
                )}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

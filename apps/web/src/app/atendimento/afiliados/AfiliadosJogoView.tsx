'use client';

/**
 * Onda 17.64 — "Modo Jogo" dos Afiliados (Corrida das Indicações).
 *
 * FRONTEIRA (real vs. estado vazio honesto):
 *  - Ranking, meta coletiva, faixas e ganho da temporada = DADO REAL (GET
 *    /patients/affiliates/game; o servidor monta o viewModel, o componente não
 *    calcula nada). Sem afiliado/indicação → estado vazio honesto, nunca número
 *    inventado.
 *  - Meta da temporada = config real (PATCH /patients/affiliates/season-goal).
 *  - Missões = progresso REAL (indicações fechadas no mês); a recompensa é um
 *    rótulo — o pagamento/brinde fica a critério da clínica.
 */
import { useCallback, useEffect, useState } from 'react';
import {
  Trophy, Users, Wallet, Target, Star, Gift, Loader2, RefreshCw, MessageCircle, Award,
} from 'lucide-react';
import api from '@/lib/api';
import { showError, showSuccess } from '@/lib/toast';

interface RankRow {
  id: string;
  nome: string;
  iniciais: string;
  affiliate_code: string | null;
  indicacoesMes: number;
  indicacoesTotal: number;
  ganhoTemporada: number;
  ganhoTotal: number;
  faixaLabel: string | null;
  faixaPct: number;
  proxima: { label: string; pct: number; faltam: number } | null;
}
interface Game {
  reference_month: string;
  kpis: { afiliadosAtivos: number; geradoTemporada: number };
  meta: { fechados: number; alvo: number | null };
  ranking: RankRow[];
  faixas: { enabled: boolean; tiers: { label: string; pct: number; min: number; range: string }[] };
  missoes: { titulo: string; recompensa: string; alvo: number; progresso: number; concluida: boolean }[];
}

const brl = (v: number) => Number(v || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const MESES = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];
function mesLabel(ym: string) {
  const [, m] = (ym || '').split('-');
  const i = parseInt(m, 10) - 1;
  return i >= 0 && i < 12 ? MESES[i] : ym;
}
const FAIXA_TONE: Record<string, string> = {
  Bronze: 'bg-amber-100 text-amber-700 border-amber-200 dark:bg-amber-950/40 dark:text-amber-400 dark:border-amber-900',
  Prata: 'bg-slate-100 text-slate-700 border-slate-200 dark:bg-slate-800 dark:text-slate-300 dark:border-slate-700',
  Ouro: 'bg-yellow-100 text-yellow-700 border-yellow-200 dark:bg-yellow-950/40 dark:text-yellow-400 dark:border-yellow-900',
  Diamante: 'bg-cyan-100 text-cyan-700 border-cyan-200 dark:bg-cyan-950/40 dark:text-cyan-400 dark:border-cyan-900',
};
const faixaTone = (l?: string | null) => (l && FAIXA_TONE[l]) || 'bg-muted text-muted-foreground border-border';
const FAIXA_EMOJI: Record<string, string> = { Bronze: '🥉', Prata: '🥈', Ouro: '🥇', Diamante: '💎' };

export default function AfiliadosJogoView() {
  const [game, setGame] = useState<Game | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const { data } = await api.get<Game>('/patients/affiliates/game');
      setGame(data);
    } catch (e: any) {
      showError(e?.response?.data?.message || 'Erro ao carregar o Modo Jogo');
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => { load(); }, [load]);

  const definirMeta = async () => {
    const raw = window.prompt(
      'Meta coletiva da temporada — quantas indicações FECHADAS a clínica quer bater no mês?\n\n(0 ou vazio remove a meta)',
      String(game?.meta.alvo ?? ''),
    );
    if (raw == null) return;
    const goal = Math.max(0, Math.floor(Number(raw.replace(/\D/g, '')) || 0));
    try {
      await api.patch('/patients/affiliates/season-goal', { goal });
      showSuccess(goal ? `Meta da temporada: ${goal} fechados` : 'Meta removida');
      load();
    } catch (e: any) {
      showError(e?.response?.data?.message || 'Erro ao salvar a meta');
    }
  };

  if (loading && !game) {
    return (
      <div className="p-12 flex items-center justify-center text-muted-foreground">
        <Loader2 size={20} className="animate-spin mr-2" /> Carregando o Modo Jogo…
      </div>
    );
  }
  if (!game) return null;

  const { kpis, meta, ranking, faixas, missoes } = game;
  const semAfiliados = ranking.length === 0;
  const top3 = ranking.slice(0, 3);
  const resto = ranking.slice(3);
  const metaPct = meta.alvo ? Math.min(100, Math.round((meta.fechados / meta.alvo) * 100)) : 0;
  const faltam = meta.alvo ? Math.max(0, meta.alvo - meta.fechados) : 0;
  const lider = ranking[0];

  return (
    <div className="space-y-5">
      {/* ===== HERO — Temporada / Corrida das Indicações ===== */}
      <section className="rounded-2xl overflow-hidden bg-gradient-to-br from-emerald-700 to-emerald-900 text-white p-5 md:p-6">
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div className="min-w-0">
            <div className="text-[11px] font-bold uppercase tracking-wider text-emerald-200/90 flex items-center gap-1.5">
              <Trophy size={13} /> Temporada de {mesLabel(game.reference_month)}
            </div>
            <h2 className="text-2xl font-extrabold mt-0.5">Corrida das Indicações</h2>
            <p className="text-sm text-emerald-100/80 mt-1 max-w-xl">
              Cada tratamento fechado por indicação conta ponto. Bata a meta da clínica e todos os
              afiliados concorrem ao prêmio.
            </p>
          </div>
          <div className="flex gap-2 shrink-0">
            <div className="rounded-xl bg-white/10 border border-white/15 px-4 py-2.5 text-center">
              <div className="text-[10px] font-bold uppercase tracking-wider text-emerald-100/80">Afiliados ativos</div>
              <div className="text-2xl font-extrabold tabular-nums">{kpis.afiliadosAtivos}</div>
            </div>
            <div className="rounded-xl bg-white/10 border border-white/15 px-4 py-2.5 text-center">
              <div className="text-[10px] font-bold uppercase tracking-wider text-emerald-100/80">Gerado na temporada</div>
              <div className="text-2xl font-extrabold tabular-nums">{brl(kpis.geradoTemporada)}</div>
            </div>
          </div>
        </div>

        {/* Meta coletiva */}
        <div className="mt-5">
          {meta.alvo ? (
            <>
              <div className="flex items-center justify-between text-sm font-semibold mb-1.5">
                <span className="text-emerald-100/90">Meta coletiva da temporada</span>
                <span className="text-amber-300 tabular-nums">{meta.fechados} / {meta.alvo} fechados</span>
              </div>
              <div className="h-3 rounded-full bg-white/15 overflow-hidden">
                <div
                  className="h-full rounded-full bg-gradient-to-r from-amber-400 to-amber-300 transition-all"
                  style={{ width: `${metaPct}%` }}
                />
              </div>
              <p className="text-xs text-emerald-100/80 mt-2">
                {faltam > 0 ? (
                  <>Faltam <b className="text-white">{faltam}</b> indicaç{faltam === 1 ? 'ão' : 'ões'} fechada{faltam === 1 ? '' : 's'} pra desbloquear o prêmio do mês 🎁 — mobilize a galera!</>
                ) : (
                  <>Meta da temporada batida! 🎉 O prêmio do mês foi desbloqueado.</>
                )}{' '}
                <button onClick={definirMeta} className="underline font-semibold hover:text-white">ajustar</button>
              </p>
            </>
          ) : (
            <div className="rounded-xl bg-white/10 border border-white/15 p-3 flex items-center justify-between gap-3 flex-wrap">
              <div className="flex items-center gap-2 text-sm text-emerald-100/90">
                <Target size={16} /> Defina a <b>meta coletiva</b> da temporada pra ligar a barra de progresso e o prêmio do mês.
              </div>
              <button onClick={definirMeta} className="bg-white text-emerald-800 font-bold text-sm px-4 py-2 rounded-lg hover:bg-emerald-50">
                Definir meta
              </button>
            </div>
          )}
        </div>
      </section>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
          {/* ===== Ranking (2 colunas) ===== */}
          <section className="lg:col-span-2 rounded-2xl border border-border bg-card overflow-hidden">
            <header className="flex items-center justify-between px-4 py-3 border-b border-border bg-muted/30">
              <h3 className="text-sm font-bold text-foreground flex items-center gap-2">
                <Trophy size={15} className="text-amber-500" /> Ranking da temporada
              </h3>
              <button onClick={load} className="text-[10px] font-bold uppercase tracking-wider text-emerald-600 inline-flex items-center gap-1 hover:text-emerald-700">
                <RefreshCw size={11} className={loading ? 'animate-spin' : ''} /> atualiza ao vivo
              </button>
            </header>

            {semAfiliados ? (
              <div className="p-10 text-center text-muted-foreground">
                <Users size={30} className="mx-auto mb-2 opacity-40" />
                <p className="text-sm font-medium">Nenhum afiliado na corrida ainda</p>
                <p className="text-xs mt-1 max-w-md mx-auto">
                  Marque pacientes como afiliados (botão <b>“+ Adicionar afiliado”</b>). Quando indicarem e
                  o tratamento fechar, eles sobem no ranking aqui — sem número inventado.
                </p>
              </div>
            ) : (
            <>
            {/* Pódio top 3 */}
            <div className="flex items-end justify-center gap-3 md:gap-5 px-4 pt-6 pb-4">
              {[1, 0, 2].map((slot) => {
                const r = top3[slot];
                if (!r) return <div key={slot} className="w-24" />;
                const place = slot + 1;
                const h = place === 1 ? 'h-24' : place === 2 ? 'h-16' : 'h-12';
                const podTone = place === 1
                  ? 'from-amber-400 to-yellow-500'
                  : place === 2
                  ? 'from-slate-300 to-slate-400'
                  : 'from-orange-400 to-orange-600';
                const avaTone = place === 1 ? 'bg-amber-500' : place === 2 ? 'bg-slate-400' : 'bg-orange-500';
                return (
                  <div key={r.id} className="flex flex-col items-center w-24">
                    <div className={`relative w-12 h-12 rounded-full ${avaTone} text-white flex items-center justify-center font-extrabold ${place === 1 ? 'ring-4 ring-amber-300/60' : ''}`}>
                      {r.iniciais}
                      {place === 1 && <span className="absolute -top-3 text-lg">👑</span>}
                    </div>
                    <div className="text-xs font-bold text-foreground mt-1.5 text-center truncate w-full">{r.nome}</div>
                    <div className="text-[11px] text-muted-foreground">{r.indicacoesMes} fechado{r.indicacoesMes === 1 ? '' : 's'}</div>
                    <div className={`w-full ${h} mt-1 rounded-t-lg bg-gradient-to-b ${podTone} flex items-start justify-center pt-1 text-white font-extrabold text-lg`}>
                      {place}
                    </div>
                  </div>
                );
              })}
            </div>

            {/* Lista do 4º em diante */}
            {resto.length > 0 && (
              <div className="divide-y divide-border border-t border-border">
                {resto.map((r, i) => (
                  <div key={r.id} className="flex items-center gap-3 px-4 py-3">
                    <span className="w-5 text-center text-sm font-bold text-muted-foreground">{i + 4}</span>
                    <div className="w-8 h-8 rounded-full bg-emerald-100 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-400 flex items-center justify-center text-xs font-bold">
                      {r.iniciais}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-1.5">
                        <span className="text-sm font-semibold text-foreground truncate">{r.nome}</span>
                        {r.faixaLabel && (
                          <span className={`text-[9px] font-bold uppercase px-1.5 py-0.5 rounded-full border ${faixaTone(r.faixaLabel)}`}>
                            {r.faixaLabel} · {r.faixaPct}%
                          </span>
                        )}
                      </div>
                      {r.proxima ? (
                        <div className="text-[11px] text-muted-foreground">
                          Faltam {r.proxima.faltam} fechada{r.proxima.faltam === 1 ? '' : 's'} pra virar {r.proxima.label} ({r.proxima.pct}%)
                        </div>
                      ) : (
                        <div className="text-[11px] text-muted-foreground">{r.indicacoesTotal} indicações no total</div>
                      )}
                    </div>
                    <div className="text-right shrink-0">
                      <div className="text-sm font-bold text-emerald-700 dark:text-emerald-400 tabular-nums">{brl(r.ganhoTemporada)}</div>
                      <div className="text-[9px] uppercase tracking-wider text-muted-foreground">temporada</div>
                    </div>
                  </div>
                ))}
              </div>
            )}
            </>
            )}
          </section>

          {/* ===== Sidebar: faixas + missões + prévia ===== */}
          <div className="space-y-5">
            {/* Faixas de recompensa */}
            <section className="rounded-2xl border border-border bg-card overflow-hidden">
              <header className="flex items-center gap-2 px-4 py-3 border-b border-border bg-muted/30">
                <Award size={15} className="text-emerald-600" />
                <h3 className="text-sm font-bold text-foreground">Faixas de recompensa</h3>
                <span className={`ml-auto text-[9px] font-bold uppercase px-1.5 py-0.5 rounded-full ${faixas.enabled ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-400' : 'bg-muted text-muted-foreground'}`}>
                  {faixas.enabled ? 'Ativas' : 'Preview'}
                </span>
              </header>
              <div className="divide-y divide-border">
                {faixas.tiers.map((t) => {
                  const aqui = faixas.enabled && lider?.faixaLabel === t.label;
                  return (
                    <div key={t.label} className={`flex items-center gap-3 px-4 py-2.5 ${aqui ? 'bg-emerald-50/60 dark:bg-emerald-950/20' : ''}`}>
                      <span className="text-lg w-6 text-center">{FAIXA_EMOJI[t.label] || '🎖️'}</span>
                      <div className="flex-1 min-w-0">
                        <div className="text-sm font-bold text-foreground flex items-center gap-1.5">
                          {t.label}
                          <span className="text-[10px] font-bold text-emerald-600">{t.pct}%</span>
                          {aqui && <span className="text-[9px] font-bold uppercase bg-emerald-600 text-white px-1.5 py-0.5 rounded-full">líder aqui</span>}
                        </div>
                        <div className="text-[11px] text-muted-foreground">{t.range}</div>
                      </div>
                    </div>
                  );
                })}
              </div>
              {!faixas.enabled && (
                <div className="px-4 py-2 text-[11px] text-muted-foreground border-t border-border">
                  Estrutura sugerida — ligue as faixas no <b>painel</b> pra valer no cálculo da comissão.
                </div>
              )}
            </section>

            {/* Missões do mês */}
            <section className="rounded-2xl border border-border bg-card overflow-hidden">
              <header className="flex items-center gap-2 px-4 py-3 border-b border-border bg-muted/30">
                <Star size={15} className="text-violet-500" />
                <h3 className="text-sm font-bold text-foreground">Missões do mês</h3>
              </header>
              <div className="p-3 space-y-2">
                {missoes.map((m, i) => {
                  const pct = Math.min(100, Math.round((m.progresso / Math.max(1, m.alvo)) * 100));
                  return (
                    <div key={i} className={`rounded-xl border p-3 ${m.concluida ? 'border-emerald-300 bg-emerald-50/50 dark:border-emerald-900 dark:bg-emerald-950/20' : 'border-border'}`}>
                      <div className="flex items-center justify-between gap-2 mb-1.5">
                        <span className="text-sm font-semibold text-foreground">{m.titulo}</span>
                        <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded-full ${m.concluida ? 'bg-emerald-600 text-white' : 'bg-amber-100 text-amber-700 dark:bg-amber-950/40 dark:text-amber-400'}`}>
                          {m.concluida ? '✓ Conquistado' : m.recompensa}
                        </span>
                      </div>
                      <div className="h-2 rounded-full bg-muted overflow-hidden">
                        <div className="h-full rounded-full bg-emerald-500" style={{ width: `${pct}%` }} />
                      </div>
                      <div className="text-[11px] text-muted-foreground mt-1">{m.progresso} de {m.alvo} indicações</div>
                    </div>
                  );
                })}
              </div>
              <div className="px-4 py-2 text-[11px] text-muted-foreground border-t border-border">
                Progresso real (indicações fechadas no mês). A recompensa é um rótulo — o prêmio fica a critério da clínica.
              </div>
            </section>

            {/* O que o afiliado vê (prévia do líder) */}
            {lider && (
              <section className="rounded-2xl overflow-hidden border border-emerald-300 dark:border-emerald-900">
                <header className="flex items-center gap-2 px-4 py-2.5 bg-muted/30 border-b border-border">
                  <MessageCircle size={14} className="text-emerald-600" />
                  <h3 className="text-xs font-bold text-foreground">O que o afiliado vê</h3>
                </header>
                <div className="bg-gradient-to-br from-emerald-600 to-emerald-800 text-white p-4">
                  <div className="text-[10px] font-bold uppercase tracking-wider text-emerald-200/90">
                    Seu progresso{lider.faixaLabel ? ` · Faixa ${lider.faixaLabel}` : ''}
                  </div>
                  <div className="text-lg font-extrabold mt-0.5">Você já ganhou {brl(lider.ganhoTemporada)}</div>
                  <p className="text-xs text-emerald-100/85 mt-1">
                    {lider.proxima
                      ? <>Falta <b>{lider.proxima.faltam}</b> indicação pra virar {lider.proxima.label} e subir pra {lider.proxima.pct}% em cada uma.</>
                      : <>{lider.indicacoesTotal} indicações fechadas — topo da tabela! 🏆</>}
                  </p>
                  <div className="mt-3 inline-flex items-center gap-2 bg-white text-emerald-800 font-bold text-sm px-4 py-2 rounded-lg w-full justify-center opacity-90">
                    <MessageCircle size={14} /> Indicar pelo WhatsApp
                  </div>
                  <p className="text-[10px] text-emerald-100/70 mt-1.5 text-center">prévia — é assim que o afiliado vê o próprio progresso</p>
                </div>
              </section>
            )}
          </div>
        </div>
    </div>
  );
}

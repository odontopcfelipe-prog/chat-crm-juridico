'use client';

/**
 * "Meu jogo" — pontuação, nível, metas e missões do PROFISSIONAL logado (out/2026).
 *
 * Decisão do dono: com os profissionais (dentista) o sistema NÃO fala em comissão
 * nem em dinheiro — mostra PONTOS pela produção clínica e incentiva com metas e
 * missões. Comissão/R$ ficam só na visão do admin/financeiro.
 *
 * O servidor é a fonte (GET /my-game → game-rules.ts); esta tela só desenha.
 * Visual reaproveitado do "Modo Jogo" (comissoes-jogo.css, escopo .cjogo).
 */

import { useEffect, useState } from 'react';
import { ChevronLeft, ChevronRight, Loader2, Trophy } from 'lucide-react';
import api from '@/lib/api';
import '../comissoes/comissoes-jogo.css';

interface Fonte { chave: string; emoji: string; label: string; qtd: number; cada: number; pontos: number }
interface Meta { id: string; label: string; limite: boolean; atual: number | null; alvo: number | null; unidade: string; pct: number; concluida: boolean }
interface Missao { titulo: string; alvo: number; progresso: number; concluida: boolean; detalhe: string; bonus: number }
interface Conquista { emoji: string; label: string; desbloqueada: boolean }
interface Nivel { nome: string; emoji: string; min: number }
interface MyGame {
  reference_month: string;
  pontos: number;
  nivel: Nivel;
  proximo: (Nivel & { faltam: number }) | null;
  progressoNivel: number;
  fontes: Fonte[];
  mesAnterior: { reference_month: string; pontos: number };
  metas: Meta[];
  missoes: Missao[];
  conquistas: Conquista[];
}

const MONTHS_PT = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];

function maceioMonth(): string {
  return new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString().slice(0, 7);
}
function shiftMonth(month: string, delta: number): string {
  const [y, m] = month.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1 + delta, 1)).toISOString().slice(0, 7);
}
function monthLabel(month: string): string {
  const [y, m] = month.split('-').map(Number);
  const nome = MONTHS_PT[m - 1];
  return `${nome[0].toUpperCase()}${nome.slice(1)} de ${y}`;
}
const pts = (n: number) => `${n.toLocaleString('pt-BR')} pts`;

export default function MeuJogoPage() {
  const current = maceioMonth();
  const [month, setMonth] = useState(current);
  const [data, setData] = useState<MyGame | null>(null);
  const [loading, setLoading] = useState(true);
  const [nome, setNome] = useState<string>('');

  useEffect(() => {
    api.get<{ name?: string }>('/users/me').then((r) => setNome(r.data?.name || '')).catch(() => {});
  }, []);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    api.get<MyGame>('/my-game', { params: { month } })
      .then((r) => { if (alive) setData(r.data); })
      .catch(() => { if (alive) setData(null); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [month]);

  const iniciais = nome.split(' ').filter(Boolean).slice(0, 2).map((s) => s[0]?.toUpperCase()).join('') || '🦷';
  const diff = data ? data.pontos - data.mesAnterior.pontos : 0;

  return (
    // RAIZ rolável: o <main> do layout é overflow-hidden.
    <div className="h-full overflow-y-auto bg-[#f6f5fb]">
      <div className="cjogo max-w-4xl mx-auto px-4 sm:px-6 pt-5 sm:pt-6 pb-24 md:pb-8">
        <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
          <h1 className="text-2xl font-bold flex items-center gap-2" style={{ color: 'var(--cj-ink)' }}>
            <Trophy size={24} className="text-amber-500" /> Meu jogo
          </h1>
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={() => setMonth((m) => shiftMonth(m, -1))}
              className="h-9 w-9 inline-flex items-center justify-center rounded-lg border border-[#e2e5ed] bg-white hover:bg-[#f1ebff]"
              aria-label="Mês anterior"
            >
              <ChevronLeft size={18} />
            </button>
            <span className="min-w-[150px] text-center text-sm font-semibold">{monthLabel(month)}</span>
            <button
              type="button"
              onClick={() => setMonth((m) => shiftMonth(m, 1))}
              disabled={month >= current}
              className="h-9 w-9 inline-flex items-center justify-center rounded-lg border border-[#e2e5ed] bg-white hover:bg-[#f1ebff] disabled:opacity-40"
              aria-label="Próximo mês"
            >
              <ChevronRight size={18} />
            </button>
          </div>
        </div>

        {loading && !data ? (
          <div className="p-12 flex items-center justify-center text-[#5b6172]">
            <Loader2 size={20} className="animate-spin mr-2" /> Carregando...
          </div>
        ) : !data ? (
          <div className="cj-panel text-center text-sm text-[#5b6172]">Não consegui carregar sua pontuação agora.</div>
        ) : (
          <>
            {/* HUD — nível e pontos do mês */}
            <div className="cj-hud">
              <div className="cj-hud-top">
                <div className="cj-player">
                  <div className="cj-ava">
                    <div className="cj-ring" style={{ background: 'linear-gradient(135deg,#fbbf24,#f59e0b)' }}>
                      <div className="cj-face">{iniciais}</div>
                    </div>
                    <span className="cj-lvl">{data.nivel.emoji} {data.nivel.nome}</span>
                  </div>
                  <div>
                    <div className="cj-nm">{nome || 'Você'}</div>
                    <div className="cj-tier">Nível {data.nivel.nome}</div>
                  </div>
                </div>
                <div className="text-right">
                  <div className="text-3xl sm:text-4xl font-black tracking-tight">{pts(data.pontos)}</div>
                  <div className="text-xs mt-1 text-white/75">
                    Mês anterior: {pts(data.mesAnterior.pontos)}
                    {data.mesAnterior.pontos > 0 && diff !== 0 && (
                      <b className={diff > 0 ? 'text-emerald-300' : 'text-rose-300'}> {diff > 0 ? '▲' : '▼'} {Math.abs(diff).toLocaleString('pt-BR')}</b>
                    )}
                  </div>
                </div>
              </div>
              <div className="cj-xpwrap">
                <div className="cj-xplabels">
                  <span className="l">{data.proximo ? `Rumo ao ${data.proximo.emoji} ${data.proximo.nome}` : 'Nível máximo!'}</span>
                  <span className="r">{data.proximo ? `faltam ${pts(data.proximo.faltam)}` : '💎'}</span>
                </div>
                <div className="cj-xpbar">
                  <div className="cj-xpfill" style={{ width: `${Math.round(data.progressoNivel * 100)}%` }} />
                </div>
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
              {/* De onde vieram os pontos */}
              <div className="cj-panel">
                <div className="cj-ph">⭐ De onde vieram seus pontos</div>
                <ul className="divide-y divide-[#eceef3]">
                  {data.fontes.map((f) => (
                    <li key={f.chave} className="flex items-center gap-3 py-2.5">
                      <span className="w-8 h-8 rounded-lg grid place-items-center bg-[#f1ebff] text-base shrink-0">{f.emoji}</span>
                      <div className="min-w-0 flex-1">
                        <div className="text-sm font-semibold truncate">{f.label}</div>
                        <div className="text-xs text-[#9aa0b0]">{f.qtd} × {f.cada} pts</div>
                      </div>
                      <div className={`text-sm font-extrabold tabular-nums ${f.pontos > 0 ? 'text-[#6d28d9]' : 'text-[#9aa0b0]'}`}>
                        +{f.pontos.toLocaleString('pt-BR')}
                      </div>
                    </li>
                  ))}
                </ul>
              </div>

              {/* Missões da semana */}
              <div className="cj-panel">
                <div className="cj-ph">🎯 Missões da semana</div>
                {data.missoes.length === 0 ? (
                  <p className="text-sm text-[#5b6172]">
                    {month === current ? 'Sem missões nesta semana.' : 'As missões aparecem na semana atual. Neste mês, as cumpridas já estão nos pontos.'}
                  </p>
                ) : (
                  data.missoes.map((m) => (
                    <div key={m.titulo} className={`cj-mission ${m.concluida ? 'done' : ''}`}>
                      <div className="cj-mh">
                        <span className="cj-mt">{m.concluida ? '✅ ' : ''}{m.titulo}</span>
                        <span className="cj-rew">+{m.bonus} pts</span>
                      </div>
                      <div className="cj-mbar">
                        <div className="cj-mfill" style={{ width: `${Math.round((m.alvo > 0 ? m.progresso / m.alvo : 0) * 100)}%` }} />
                      </div>
                      <div className="cj-mp">{m.detalhe}</div>
                    </div>
                  ))
                )}
              </div>
            </div>

            {/* Metas do mês (cadastradas pela clínica em Metas) */}
            <div className="cj-panel mb-4">
              <div className="cj-ph">🏁 Suas metas do mês</div>
              {data.metas.length === 0 ? (
                <p className="text-sm text-[#5b6172]">Nenhuma meta sua neste mês ainda. Quando a clínica lançar, ela aparece aqui.</p>
              ) : (
                <div className="space-y-3.5">
                  {data.metas.map((m) => (
                    <div key={m.id}>
                      <div className="flex items-center justify-between gap-3 text-sm">
                        <span className="font-semibold">{m.concluida ? '✅ ' : ''}{m.label}</span>
                        <span className="text-xs font-bold text-[#5b6172] tabular-nums">
                          {m.atual != null && m.alvo != null
                            ? `${m.atual.toLocaleString('pt-BR')}${m.unidade} ${m.limite ? 'de no máximo' : 'de'} ${m.alvo.toLocaleString('pt-BR')}${m.unidade}`
                            : `${Math.round(m.pct * 100)}%`}
                        </span>
                      </div>
                      <div className="cj-mbar">
                        <div
                          className="cj-mfill"
                          style={{
                            width: `${Math.round(m.pct * 100)}%`,
                            background: m.concluida ? 'linear-gradient(90deg,#22c55e,#16a34a)' : undefined,
                          }}
                        />
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Conquistas */}
            <div className="cj-panel mb-4">
              <div className="cj-ph">🏅 Conquistas do mês</div>
              <div className="cj-shelf">
                {data.conquistas.map((c) => (
                  <div key={c.label} className={`cj-ach ${c.desbloqueada ? '' : 'lock'}`} title={c.label}>
                    <div className="em">{c.emoji}</div>
                    <div className="al">{c.label}</div>
                  </div>
                ))}
              </div>
            </div>

            {/* Como ganhar pontos */}
            <div className="text-xs text-[#5b6172] leading-relaxed px-1">
              <b>Como ganhar pontos:</b>{' '}
              {data.fontes.map((f) => `${f.label.toLowerCase()} +${f.cada}`).join(' · ')}.
              {' '}Níveis: 🥉 Bronze · 🥈 Prata (500) · 🥇 Ouro (1.500) · 💎 Diamante (3.000) — zera todo mês.
            </div>
          </>
        )}
      </div>
    </div>
  );
}

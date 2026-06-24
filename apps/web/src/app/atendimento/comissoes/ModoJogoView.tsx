'use client';

/**
 * Onda 17.62 — "Modo Jogo" das Comissões (skill comissoes-gamificadas).
 *
 * FRONTEIRA (o que é real vs. estado vazio honesto):
 *  - Carteira (devida/disponível/paga) e faixa (% real da regra) = DADO REAL (vem do
 *    GET /commissions/game, que o servidor monta — o componente não calcula nada).
 *  - Resgatar = AÇÃO FINANCEIRA real: confirma e chama POST /commissions/:id/pay (que JÁ
 *    existe), refletindo o estado só após sucesso. Sem fluxo de pagamento novo.
 *  - Meta / barra de XP / faixas / missões / conquistas = DADO NOVO (Fase 2). Enquanto
 *    não existir, renderiza estado vazio honesto — NUNCA um número/barra inventado.
 */
import { useEffect, useMemo, useState } from 'react';
import api from '@/lib/api';
import { Loader2, Coins, Star, Trophy } from 'lucide-react';
import './comissoes-jogo.css';

type Player = {
  professional_user_id: string;
  nome: string;
  iniciais: string;
  faixaPct: number | null;
  faixaLabel: string;
  temRegra: boolean;
  carteira: { devida: number; disponivel: number; paga: number };
  resgatavel: { total: number; ids: string[] };
  meta: null | { id: string; alvo: number; atual: number };
  streakSemanas: null | number;
  producaoMes: number;
  tiersAtivo: boolean;
  trilha: { nome: string; emoji: string; percentual: number; estado: string; faixaInfo: string }[];
  missoes: { titulo: string; recompensa: string; alvo: number; progresso: number; concluida: boolean; detalhe: string }[];
  conquistas: { emoji: string; label: string; desbloqueada: boolean }[];
};

const fmt = (n: number) => Number(n || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const MESES = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];
function mesLabelOf(ym: string): string {
  const [y, m] = (ym || '').split('-');
  const i = parseInt(m, 10) - 1;
  return i >= 0 && i < 12 ? `${MESES[i]} de ${y}` : ym;
}
function periodOfMonth(ym: string) {
  const [y, m] = (ym || '').split('-').map(Number);
  return {
    start: new Date(Date.UTC(y, m - 1, 1)).toISOString(),
    end: new Date(Date.UTC(y, m, 0, 23, 59, 59)).toISOString(),
  };
}

export default function ModoJogoView() {
  const [players, setPlayers] = useState<Player[]>([]);
  const [month, setMonth] = useState('');
  const [loading, setLoading] = useState(true);
  const [selId, setSelId] = useState('');
  const [resgatando, setResgatando] = useState(false);

  const load = () => {
    setLoading(true);
    // Atualiza o cache das metas (current_value) em segundo plano — barra fica fresca.
    api.post('/goals/recalculate-all').catch(() => {});
    api
      .get<{ reference_month: string; players: Player[] }>('/commissions/game')
      .then(({ data }) => {
        setPlayers(data.players || []);
        setMonth(data.reference_month || '');
        setSelId((prev) => prev || data.players?.[0]?.professional_user_id || '');
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  };
  useEffect(load, []);

  const sel = useMemo(
    () => players.find((p) => p.professional_user_id === selId) || players[0],
    [players, selId],
  );

  async function resgatar() {
    if (!sel || sel.resgatavel.ids.length === 0 || resgatando) return;
    const ok = window.confirm(
      `Resgatar ${fmt(sel.resgatavel.total)} de ${sel.nome} agora?\n\n` +
        `Isso marca ${sel.resgatavel.ids.length} comissão(ões) DISPONÍVEL como PAGA. Confirma?`,
    );
    if (!ok) return;
    setResgatando(true);
    try {
      // Serviço EXISTENTE — uma chamada por comissão (sem endpoint batch ainda).
      for (const id of sel.resgatavel.ids) {
        await api.post(`/commissions/${id}/pay`, { payment_method: 'PIX' });
      }
      load(); // só reflete o estado real depois do sucesso do backend
    } catch {
      alert('Não consegui resgatar todas. O saldo pode ter mudado — recarregando.');
      load();
    } finally {
      setResgatando(false);
    }
  }

  // Fase 2 — define/ajusta a META do mês reusando o Goal (SALES_VALUE, PROFESSIONAL,
  // MONTHLY). É a produção (orçamentos aceitos) do profissional → acende a barra de XP.
  async function definirMeta() {
    if (!sel) return;
    const raw = window.prompt(
      `Meta de produção (R$) de ${sel.nome} para ${mesLabelOf(month)}:\n\n` +
        `É o total de orçamentos aceitos no mês — a barra enche conforme ele produz.`,
      String(sel.meta?.alvo ?? ''),
    );
    if (raw == null) return;
    const alvo = Number(raw.replace(/\./g, '').replace(',', '.').replace(/[^\d.]/g, ''));
    if (!alvo || alvo <= 0) {
      alert('Informe um valor válido (ex.: 9000).');
      return;
    }
    try {
      if (sel.meta?.id) {
        await api.patch(`/goals/${sel.meta.id}`, { target_value: alvo });
        await api.post(`/goals/${sel.meta.id}/recalculate`).catch(() => {});
      } else {
        const { start, end } = periodOfMonth(month);
        await api.post('/goals', {
          metric: 'SALES_VALUE',
          scope: 'PROFESSIONAL',
          professional_user_id: sel.professional_user_id,
          direction: 'ACHIEVE',
          target_value: alvo,
          period_type: 'MONTHLY',
          period_start: start,
          period_end: end,
        });
      }
      load();
    } catch {
      alert('Não consegui salvar a meta. Verifique sua permissão (financeiro).');
    }
  }

  if (loading) {
    return (
      <div className="p-12 flex items-center justify-center text-muted-foreground">
        <Loader2 size={20} className="animate-spin mr-2" /> Carregando modo jogo...
      </div>
    );
  }

  if (players.length === 0) {
    return (
      <div className="p-12 text-center text-sm text-muted-foreground">
        Nenhum dentista cadastrado nesta clínica ainda. Cadastre a equipe e crie as regras em{' '}
        <strong>Configurações → Regras de Comissão</strong> pra o Modo Jogo ganhar vida.
      </div>
    );
  }

  return (
    <div className="cjogo">
      {/* Titlebar + seletor de profissional (admin revisa cada um) */}
      <div className="flex items-center gap-3 mb-4 flex-wrap">
        <span className="cj-tag">MODO JOGO</span>
        {players.length > 1 && (
          <select className="cj-select" value={sel?.professional_user_id} onChange={(e) => setSelId(e.target.value)}>
            {players.map((p) => (
              <option key={p.professional_user_id} value={p.professional_user_id}>
                {p.nome}
              </option>
            ))}
          </select>
        )}
        <span className="text-xs text-muted-foreground">· {mesLabelOf(month)}</span>
      </div>

      {sel && (
        <>
          {/* ===== HUD ===== */}
          <div className="cj-hud">
            <div className="cj-hud-top">
              <div className="cj-player">
                <div className="cj-ava">
                  <div className="cj-ring" style={{ background: 'conic-gradient(var(--cj-gold-2) 0 100%)' }}>
                    <div className="cj-face">{sel.iniciais}</div>
                  </div>
                </div>
                <div>
                  <div className="cj-nm">{sel.nome}</div>
                  <div className="cj-tier">
                    <Star size={14} fill="currentColor" /> {sel.faixaLabel}
                  </div>
                </div>
              </div>
              {/* streak omitido — sem tracking real ainda (estado vazio honesto) */}
            </div>

            {/* Meta: barra de XP REAL (Goal SALES_VALUE) OU estado vazio honesto + CTA */}
            {sel.meta ? (
              <div className="cj-xpwrap">
                <div className="cj-xplabels">
                  <span className="l">Progresso da meta de {mesLabelOf(month).split(' de ')[0]}</span>
                  <span className="r">{fmt(sel.meta.atual)} / {fmt(sel.meta.alvo)}</span>
                </div>
                <div className="cj-xpbar">
                  <div
                    className="cj-xpfill"
                    style={{ width: `${Math.max(0, Math.min(100, sel.meta.alvo > 0 ? (sel.meta.atual / sel.meta.alvo) * 100 : 0))}%` }}
                  />
                </div>
                <div className="cj-xpsub">
                  {sel.meta.atual >= sel.meta.alvo ? (
                    <>Meta batida! 🎉</>
                  ) : (
                    <>Faltam <b>{fmt(sel.meta.alvo - sel.meta.atual)}</b> pra bater a meta do mês. 💪</>
                  )}{' '}
                  <button className="cj-link" onClick={definirMeta}>ajustar</button>
                </div>
              </div>
            ) : (
              <div className="cj-meta-empty">
                <div className="t">🎯 Defina a meta de {mesLabelOf(month).split(' de ')[0]}</div>
                <div className="s">
                  A meta é a produção (orçamentos aceitos) do profissional no mês. Com ela, a barra de
                  progresso liga e mostra “faltam R$ X”.
                </div>
                <button className="cj-meta-btn" onClick={definirMeta}>Definir meta</button>
              </div>
            )}
          </div>

          {/* ===== Carteira (estados reais vestidos de jogo) ===== */}
          <div className="cj-vault">
            <div className="cj-coin prod">
              <div className="cj-ct"><span className="dot" />Em produção <span className="cj-orig">· DEVIDA</span></div>
              <div className="cj-cv">{fmt(sel.carteira.devida)}</div>
              <div className="cj-cs">Procedimentos feitos, aguardando o paciente pagar.</div>
            </div>
            <div className="cj-coin disp">
              <div className="cj-ct"><span className="dot" />Pronto pra resgatar <span className="cj-orig">· DISPONÍVEL</span></div>
              <div className="cj-cv">{fmt(sel.carteira.disponivel)}</div>
              <div className="cj-cs">Paciente já pagou — é do profissional.</div>
              {sel.resgatavel.total > 0 ? (
                <button className="cj-claim" onClick={resgatar} disabled={resgatando}>
                  {resgatando ? <Loader2 size={16} className="animate-spin" /> : <Coins size={16} />}
                  Resgatar agora
                </button>
              ) : (
                <div className="cj-claim-empty">Nada pra resgatar agora.</div>
              )}
            </div>
            <div className="cj-coin pago">
              <div className="cj-ct"><span className="dot" />Resgatado no mês <span className="cj-orig">· PAGA</span></div>
              <div className="cj-cv">{fmt(sel.carteira.paga)}</div>
              <div className="cj-cs">Já liquidado pela clínica.</div>
            </div>
          </div>

          {/* ===== Trilha de faixas (Fase 2b — PREVIEW até ativar no cálculo) ===== */}
          <div className="cj-panel" style={{ marginBottom: 16 }}>
            <div className="cj-ph">
              <Trophy size={18} className="text-violet-600" /> Trilha de faixas
              <span className="cj-badge-soft">{sel.tiersAtivo ? 'ATIVO' : 'PREVIEW'}</span>
            </div>
            <p className="text-xs text-muted-foreground -mt-1 mb-3">
              Produção do mês: <b>{fmt(sel.producaoMes)}</b>.{' '}
              {sel.tiersAtivo
                ? 'As faixas valem no cálculo da comissão.'
                : 'Estrutura sugerida — ainda NÃO muda o pagamento. Me passe seus números (limites/%) e eu ativo no cálculo, validando.'}
            </p>
            <div className="cj-trail">
              <div className="cj-connector" />
              {sel.trilha.map((s, i) => (
                <div key={i} className={`cj-step ${s.estado}`}>
                  <div className="cj-node">{s.emoji}</div>
                  <div className="cj-si">
                    <div className="cj-sn">{s.nome} <span className="cj-pct">{s.percentual}%</span></div>
                    <div className="cj-sd">{s.faixaInfo}</div>
                  </div>
                  {s.estado === 'cur' && <span className="cj-badge now">AGORA</span>}
                  {s.estado === 'done' && <span className="cj-badge ok">✓</span>}
                </div>
              ))}
            </div>
          </div>

          {/* ===== Conquistas (Fase 2b — selos derivados de dado REAL) ===== */}
          <div className="cj-panel" style={{ marginBottom: 16 }}>
            <div className="cj-ph"><Trophy size={18} className="text-violet-600" /> Conquistas</div>
            <div className="cj-shelf">
              {sel.conquistas.map((c, i) => (
                <div key={i} className={`cj-ach ${c.desbloqueada ? '' : 'lock'}`} title={c.desbloqueada ? 'Desbloqueada' : 'Bloqueada'}>
                  <div className="em">{c.emoji}</div>
                  <div className="al">{c.label}</div>
                </div>
              ))}
            </div>
          </div>

          {/* ===== Missões da semana (Fase 2b — tracking REAL; recompensa é rótulo) ===== */}
          {sel.missoes.length > 0 && (
            <div className="cj-panel">
              <div className="cj-ph"><Star size={18} className="text-violet-600" /> Missões da semana</div>
              {sel.missoes.map((m, i) => {
                const pct = Math.max(0, Math.min(100, m.alvo > 0 ? (m.progresso / m.alvo) * 100 : 0));
                return (
                  <div key={i} className={`cj-mission ${m.concluida ? 'done' : ''}`}>
                    <div className="cj-mh">
                      <span className="cj-mt">{m.titulo}</span>
                      <span className="cj-rew">{m.concluida ? '✓ Conquistado' : m.recompensa}</span>
                    </div>
                    <div className="cj-mbar"><div className="cj-mfill" style={{ width: `${pct}%` }} /></div>
                    <div className="cj-mp">{m.detalhe}{m.concluida ? ' · bônus liberado!' : ''}</div>
                  </div>
                );
              })}
              <p className="text-[11px] text-muted-foreground mt-2">
                Progresso real (procedimentos executados / faltas na semana). A recompensa é um bônus — o pagamento fica a critério da clínica.
              </p>
            </div>
          )}
        </>
      )}
    </div>
  );
}

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
import { Loader2, Coins, Star, Trophy, Target, Sparkles } from 'lucide-react';
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
  meta: null | { alvo: number; atual: number };
  streakSemanas: null | number;
};

const fmt = (n: number) => Number(n || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const MESES = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];
function mesLabelOf(ym: string): string {
  const [y, m] = (ym || '').split('-');
  const i = parseInt(m, 10) - 1;
  return i >= 0 && i < 12 ? `${MESES[i]} de ${y}` : ym;
}

export default function ModoJogoView() {
  const [players, setPlayers] = useState<Player[]>([]);
  const [month, setMonth] = useState('');
  const [loading, setLoading] = useState(true);
  const [selId, setSelId] = useState('');
  const [resgatando, setResgatando] = useState(false);

  const load = () => {
    setLoading(true);
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
        Nenhum profissional com regra de comissão cadastrada. Crie regras em{' '}
        <strong>Configurações → Regras de Comissão</strong> pra ativar o Modo Jogo.
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

            {/* Meta: sem modelo ainda → estado vazio honesto (NUNCA barra chutada) */}
            <div className="cj-meta-empty">
              <div className="t">🎯 Defina sua meta de {mesLabelOf(month).split(' de ')[0]}</div>
              <div className="s">
                A barra de progresso e os níveis ligam quando a meta do mês existir. Por enquanto,
                bora começar — sua carteira já está rolando abaixo. 💪
              </div>
            </div>
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

          {/* ===== Em breve (Fase 2 — dado/regra novos) ===== */}
          <div className="cj-panel">
            <div className="cj-ph">
              <Sparkles size={18} className="text-violet-600" /> Progressão
              <span className="cj-soon">FASE 2</span>
            </div>
            <p className="text-sm text-muted-foreground -mt-1 mb-1">
              O jogo completo destrava quando configurarmos os dados abaixo (regra financeira, em
              etapa separada). Nada aqui é número inventado.
            </p>
            <ul className="cj-soon-list">
              <li><span className="ico"><Target size={15} /></span> <b>Meta do mês</b> — barra de XP e “faltam R$ X pra bater”.</li>
              <li><span className="ico"><Trophy size={15} /></span> <b>Trilha de faixas</b> (Bronze → Diamante) — cada faixa destrava uma % maior, ligada à comissão real.</li>
              <li><span className="ico"><Star size={15} /></span> <b>Missões da semana</b> — ex.: “3 clareamentos”, “zero faltas”, com bônus.</li>
              <li><span className="ico"><Sparkles size={15} /></span> <b>Conquistas</b> — selos derivados do histórico.</li>
            </ul>
          </div>
        </>
      )}
    </div>
  );
}

'use client';

/**
 * Onda 17.32.156 — Passo 6 do Onboarding Wizard: revisão da tabela
 * de preços.
 *
 * Em vez de fechar o wizard pra navegar, abrimos a tela completa
 * /atendimento/settings/procedures num modal fullscreen POR CIMA
 * do wizard. Botão "Voltar ao wizard" no topo fecha o modal sem
 * sair do fluxo de configuração.
 *
 * Marcação de done acontece via auto-detect do backend (Onda 151):
 * quando o user editar algum procedimento, na próxima vez que o
 * wizard reabrir o passo, vem como "Pronto".
 */
import { useEffect, useState } from 'react';
import {
  CheckCircle2, Loader2, Tag, ExternalLink, AlertCircle, ArrowLeft,
} from 'lucide-react';
import api from '@/lib/api';

interface Procedure {
  id: string;
  name: string;
  base_price: number | string | null;
}

interface Props {
  alreadyDone?: boolean;
}

export default function PricingQuickReview({ alreadyDone = false }: Props) {
  const [count, setCount] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showFullTable, setShowFullTable] = useState(false);

  const fetchCount = () => {
    api.get<Procedure[]>('/procedures')
      .then((r) => setCount(Array.isArray(r.data) ? r.data.length : 0))
      .catch((e: any) => {
        const raw = e?.response?.data?.message || '';
        if (typeof raw === 'string' && raw.startsWith('Cannot')) {
          setError('Servidor ainda nao reconhece — deploy em andamento?');
        } else {
          setError('Nao foi possivel carregar a tabela. Voce ainda pode abrir a tela completa.');
        }
      });
  };

  useEffect(() => { fetchCount(); }, []);

  // Quando fecha o modal da tela completa, recarrega o count
  // (pode ter aumentado/diminuido se o user adicionou/removeu)
  const handleCloseFullTable = () => {
    setShowFullTable(false);
    setCount(null);
    fetchCount();
  };

  return (
    <>
      <div className="bg-violet-500/5 border border-violet-500/20 rounded-2xl p-6 min-h-[260px] flex flex-col">
        {alreadyDone && (
          <p className="mb-3 text-xs text-emerald-700 dark:text-emerald-400 flex items-center gap-1.5">
            <CheckCircle2 size={12} />
            Você já personalizou a tabela.
          </p>
        )}

        <div className="flex items-center gap-4 mb-5">
          <div className="w-14 h-14 rounded-2xl bg-violet-500/15 text-violet-600 dark:text-violet-400 grid place-items-center shrink-0">
            <Tag size={28} />
          </div>
          <div className="flex-1 min-w-0">
            {count === null && !error ? (
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="animate-spin" size={14} />
                Carregando…
              </div>
            ) : count !== null ? (
              <>
                <p className="text-2xl font-extrabold text-foreground leading-tight">
                  {count} procedimentos cadastrados
                </p>
                <p className="text-xs text-muted-foreground">
                  Vieram da tabela padrão odontológica. Você pode editar preços,
                  remover o que não usa e adicionar novos.
                </p>
              </>
            ) : null}
          </div>
        </div>

        {count !== null && count > 0 && (
          <p className="text-[11px] text-muted-foreground mb-5">
            💡 Recursos da tela: busca, filtro por especialidade, edição em massa
            (reajuste %), modal completo com TUSS, duração, descrição,
            instruções pós-procedimento, etc.
          </p>
        )}

        {/* Onda 17.32.156 — Abre tela completa em modal por cima
            do wizard (sem fechar/perder o fluxo) */}
        <button
          type="button"
          onClick={() => setShowFullTable(true)}
          className="inline-flex items-center justify-center gap-2 w-full px-6 py-3 rounded-xl bg-violet-600 hover:bg-violet-700 text-white font-bold text-sm shadow-[0_6px_18px_-4px_rgba(124,58,237,0.5)] transition-all"
        >
          <ExternalLink size={16} />
          Abrir tabela completa
        </button>

        <p className="text-[11px] text-muted-foreground mt-3 text-center">
          A tabela abre por cima do wizard. Quando fechar, você volta pra esse passo.
        </p>

        {error && (
          <p className="mt-3 text-xs text-rose-600 dark:text-rose-400 flex items-start gap-1.5">
            <AlertCircle size={14} className="shrink-0 mt-0.5" />
            <span>{error}</span>
          </p>
        )}
      </div>

      {/* Modal fullscreen com iframe da tela completa */}
      {showFullTable && (
        <FullTableModal onClose={handleCloseFullTable} />
      )}
    </>
  );
}

// ─── Modal fullscreen com iframe ─────────────────────────────────

function FullTableModal({ onClose }: { onClose: () => void }) {
  const [iframeLoading, setIframeLoading] = useState(true);

  return (
    <div className="fixed inset-0 z-[300] bg-black/70 backdrop-blur-sm flex items-stretch">
      <div className="m-4 flex-1 bg-background rounded-2xl overflow-hidden shadow-2xl flex flex-col">
        {/* Header sticky com botao voltar */}
        <header className="bg-violet-600 text-white px-5 py-3 flex items-center justify-between shrink-0">
          <button
            type="button"
            onClick={onClose}
            className="inline-flex items-center gap-2 text-sm font-bold hover:bg-white/10 px-3 py-1.5 rounded-lg transition-colors"
          >
            <ArrowLeft size={16} />
            Voltar ao wizard
          </button>
          <span className="text-xs font-bold uppercase tracking-wider opacity-80">
            Tabela de Preços
          </span>
        </header>

        {/* Iframe da tela real */}
        <div className="flex-1 relative overflow-hidden">
          {iframeLoading && (
            <div className="absolute inset-0 grid place-items-center bg-background">
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="animate-spin" size={16} />
                Carregando tabela completa…
              </div>
            </div>
          )}
          <iframe
            src="/atendimento/settings/procedures"
            title="Tabela de preços"
            className="w-full h-full border-0"
            onLoad={() => setIframeLoading(false)}
          />
        </div>
      </div>
    </div>
  );
}

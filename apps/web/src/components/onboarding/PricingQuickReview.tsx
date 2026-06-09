'use client';

/**
 * Onda 17.32.155 — Passo 6 do Onboarding Wizard: revisão da tabela
 * de preços.
 *
 * Simplificado em relacao a versao anterior (Ondas 151-153) — em
 * vez de duplicar uma UI complexa dentro do wizard (com bugs no
 * botao editar, marcacao prematura de "done" ao deletar, etc),
 * agora mostramos:
 *   - Resumo: quantos procedimentos ja existem
 *   - Botao GRANDE "Abrir tabela completa" -> fecha wizard +
 *     navega pra /atendimento/settings/procedures (tela com TODAS
 *     as funcionalidades: busca, filtro por especialidade, modal
 *     de edicao completo, reajuste em massa, etc).
 *
 * Marcacao de done acontece via auto-detect do backend quando o
 * user editar pelo menos 1 procedimento (Onda 151) — nao mais
 * disparado manualmente a cada edicao.
 */
import { useEffect, useState } from 'react';
import Link from 'next/link';
import {
  CheckCircle2, Loader2, Tag, ExternalLink, AlertCircle,
} from 'lucide-react';
import api from '@/lib/api';

interface Procedure {
  id: string;
  name: string;
  base_price: number | string | null;
}

interface Props {
  alreadyDone?: boolean;
  /** Fecha o wizard antes de navegar (senao o overlay z-200 cobre
      a tela de destino e parece que nao aconteceu nada). */
  onClose: () => void;
}

export default function PricingQuickReview({ alreadyDone = false, onClose }: Props) {
  const [count, setCount] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
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
  }, []);

  return (
    <div className="bg-violet-500/5 border border-violet-500/20 rounded-2xl p-6 min-h-[260px] flex flex-col">
      {alreadyDone && (
        <p className="mb-3 text-xs text-emerald-700 dark:text-emerald-400 flex items-center gap-1.5">
          <CheckCircle2 size={12} />
          Você já personalizou a tabela.
        </p>
      )}

      {/* Resumo */}
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
                remover o que não usa e adicionar novos na tela completa.
              </p>
            </>
          ) : null}
        </div>
      </div>

      {/* Lista breve de exemplos (3 primeiros) — opcional, so se tem dados */}
      {count !== null && count > 0 && (
        <p className="text-[11px] text-muted-foreground mb-5">
          💡 Recursos da tela completa: busca, filtro por especialidade,
          edição em massa (reajuste %), modal completo com TUSS,
          duração, descrição, instruções pós-procedimento, etc.
        </p>
      )}

      {/* CTA principal */}
      <Link
        href="/atendimento/settings/procedures"
        onClick={onClose}
        className="inline-flex items-center justify-center gap-2 w-full px-6 py-3 rounded-xl bg-violet-600 hover:bg-violet-700 text-white font-bold text-sm shadow-[0_6px_18px_-4px_rgba(124,58,237,0.5)] transition-all"
      >
        <ExternalLink size={16} />
        Abrir tabela completa
      </Link>

      <p className="text-[11px] text-muted-foreground mt-3 text-center">
        Quando você editar/remover/adicionar lá e voltar ao wizard,
        essa etapa aparece como <b>Pronto</b> automaticamente.
      </p>

      {error && (
        <p className="mt-3 text-xs text-rose-600 dark:text-rose-400 flex items-start gap-1.5">
          <AlertCircle size={14} className="shrink-0 mt-0.5" />
          <span>{error}</span>
        </p>
      )}
    </div>
  );
}

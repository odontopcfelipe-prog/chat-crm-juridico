'use client';

/**
 * Fechamentos — kanban dedicado à fase de fechamento de orçamento.
 *
 * Layout:
 *  ┌─ Header KPIs (5 cards) ──────────────────────────────────────┐
 *  │ Pipeline R$ | Em fechamento | Vencem 7d | Expirados | Conv % │
 *  └──────────────────────────────────────────────────────────────┘
 *  ┌──────────┬─────────┬─────────┬──────────┬─────────────┬────────┐
 *  │ Lentes   │ Facetas │Implante │Ortodontia│Harmonização │Outros  │
 *  │ Porcelana│ Resina  │         │          │Facial       │        │
 *  ├──────────┼─────────┼─────────┼──────────┼─────────────┼────────┤
 *  │  Cards   │  Cards  │  Cards  │  Cards   │   Cards     │  Cards │
 *  │  ...     │  ...    │  ...    │  ...     │   ...       │  ...   │
 *  └──────────┴─────────┴─────────┴──────────┴─────────────┴────────┘
 *
 * Endpoint: GET /quotes/closing-board (commercial.controller.ts)
 * Recebe: { summary, by_category: { LENTES_PORCELANA: [...], ... } }
 *
 * Card de Quote:
 *  - paciente (link pra ficha)
 *  - valor total
 *  - urgência (vencimento)
 *  - procedimento principal + qtd itens
 *  - ações: Ver, Reenviar WA, Marcar Aceito
 */

import { Suspense, useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  DollarSign, Loader2, Send, Check, MessageCircle, Clock, AlertTriangle,
  TrendingUp, Eye, Sparkles, Smile, Wrench, Brain, Layers, FileText,
} from 'lucide-react';
import api from '@/lib/api';
import { showError, showSuccess } from '@/lib/toast';
import { PatientAvatar } from '@/components/PatientAvatar';

interface QuoteCard {
  id: string;
  status: 'SENT';
  total_value: number;
  valid_until: string | null;
  days_left: number | null;
  sent_at: string | null;
  whatsapp_read_at: string | null;
  portal_view_count: number;
  portal_last_viewed_at: string | null;
  patient: { id: string; name: string | null; phone: string | null; avatar_url: string | null };
  created_by: { id: string; name: string } | null;
  main_procedure: string;
  items_count: number;
}

type ColumnKey =
  | 'LENTES_PORCELANA'
  | 'FACETAS_RESINA'
  | 'IMPLANTE'
  | 'ORTODONTIA'
  | 'HARMONIZACAO_FACIAL'
  | 'OUTROS';

interface BoardData {
  summary: {
    pipeline_value: number;
    count_total: number;
    expiring_7d: number;
    expired: number;
    conversion_rate_30d: number | null;
  };
  by_category: Record<ColumnKey, QuoteCard[]>;
}

const COLUMNS: Array<{
  key: ColumnKey;
  label: string;
  icon: React.ElementType;
  accent: string; // tailwind classes for header
  emoji: string;
}> = [
  { key: 'LENTES_PORCELANA', label: 'Lentes Porcelana', icon: Sparkles, accent: 'border-violet-400 bg-violet-50 text-violet-900', emoji: '✨' },
  { key: 'FACETAS_RESINA', label: 'Facetas Resina', icon: Smile, accent: 'border-orange-400 bg-orange-50 text-orange-900', emoji: '🦷' },
  { key: 'IMPLANTE', label: 'Implante', icon: Wrench, accent: 'border-sky-400 bg-sky-50 text-sky-900', emoji: '🔩' },
  { key: 'ORTODONTIA', label: 'Ortodontia', icon: Brain, accent: 'border-purple-400 bg-purple-50 text-purple-900', emoji: '🦴' },
  { key: 'HARMONIZACAO_FACIAL', label: 'Harmonização Facial', icon: Sparkles, accent: 'border-pink-400 bg-pink-50 text-pink-900', emoji: '💉' },
  { key: 'OUTROS', label: 'Outros', icon: Layers, accent: 'border-slate-400 bg-slate-50 text-slate-900', emoji: '🗂️' },
];

const formatBRL = (v: number) =>
  Number(v).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

const formatPct = (v: number | null) =>
  v === null ? '—' : `${(v * 100).toFixed(0)}%`;

/** Texto + cor da urgência baseada em days_left. */
function urgencyTag(daysLeft: number | null): { text: string; cls: string } {
  if (daysLeft === null) return { text: 'Sem prazo', cls: 'text-muted-foreground bg-muted' };
  if (daysLeft < 0) return { text: `Expirou há ${Math.abs(daysLeft)}d`, cls: 'text-red-700 bg-red-100' };
  if (daysLeft === 0) return { text: 'Expira HOJE', cls: 'text-red-700 bg-red-100 animate-pulse' };
  if (daysLeft <= 3) return { text: `${daysLeft}d restantes`, cls: 'text-red-600 bg-red-50' };
  if (daysLeft <= 7) return { text: `${daysLeft}d`, cls: 'text-amber-700 bg-amber-50' };
  return { text: `${daysLeft}d`, cls: 'text-emerald-700 bg-emerald-50' };
}

export default function FechamentosPage() {
  return (
    <Suspense fallback={
      <div className="p-6 flex items-center justify-center text-muted-foreground">
        <Loader2 size={20} className="animate-spin mr-2" /> Carregando...
      </div>
    }>
      <FechamentosPageInner />
    </Suspense>
  );
}

// Board "vazio" pra usar como fallback inicial / em caso de erro — garante
// que a UI sempre renderize (KPIs zerados + 6 colunas vazias) em vez de
// uma tela "Sem dados" sem nem cabeçalho.
const EMPTY_BOARD: BoardData = {
  summary: {
    pipeline_value: 0,
    count_total: 0,
    expiring_7d: 0,
    expired: 0,
    conversion_rate_30d: null,
  },
  by_category: {
    LENTES_PORCELANA: [],
    FACETAS_RESINA: [],
    IMPLANTE: [],
    ORTODONTIA: [],
    HARMONIZACAO_FACIAL: [],
    OUTROS: [],
  },
};

function FechamentosPageInner() {
  const router = useRouter();
  const [board, setBoard] = useState<BoardData>(EMPTY_BOARD);
  const [loading, setLoading] = useState(true);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [actionLoading, setActionLoading] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setErrorMsg(null);
    try {
      const r = await api.get<BoardData>('/quotes/closing-board');
      // Defesa: se a API retornar algo inesperado, manter board vazio mas
      // mostrar erro inline em vez de tela em branco.
      if (!r.data || !r.data.summary || !r.data.by_category) {
        // eslint-disable-next-line no-console
        console.warn('[fechamentos] resposta inesperada do endpoint:', r.data);
        setErrorMsg('A API retornou um formato inesperado. Tente novamente em instantes.');
        return;
      }
      setBoard(r.data);
    } catch (e: any) {
      // eslint-disable-next-line no-console
      console.error('[fechamentos] erro ao carregar:', e?.response?.status, e?.response?.data, e);
      const apiMsg = e?.response?.data?.message;
      const status = e?.response?.status;
      const msg = apiMsg
        ? `${apiMsg}${status ? ` (HTTP ${status})` : ''}`
        : (status ? `Erro HTTP ${status}` : 'Erro ao carregar fechamentos');
      setErrorMsg(msg);
      showError(msg);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const handleResend = async (quoteId: string) => {
    setActionLoading(quoteId);
    try {
      await api.post(`/quotes/${quoteId}/send-whatsapp`);
      showSuccess('Orçamento reenviado por WhatsApp');
      load();
    } catch (e: any) {
      showError(e?.response?.data?.message || 'Erro ao reenviar');
    } finally {
      setActionLoading(null);
    }
  };

  const handleMarkAccepted = async (quoteId: string) => {
    if (!confirm('Marcar este orçamento como ACEITO? O paciente entra em fase de assinatura.')) return;
    setActionLoading(quoteId);
    try {
      await api.post(`/quotes/${quoteId}/accept`);
      showSuccess('Orçamento marcado como aceito');
      load();
    } catch (e: any) {
      showError(e?.response?.data?.message || 'Erro ao aceitar');
    } finally {
      setActionLoading(null);
    }
  };

  const { summary, by_category } = board;

  return (
    <div className="p-6 space-y-6 min-h-screen bg-background">
      {/* Header com título + ações */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Fechamentos</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Orçamentos enviados aguardando resposta. Card sai daqui ao ser aceito.
          </p>
        </div>
        <button
          onClick={load}
          disabled={loading}
          className="px-3 py-1.5 text-sm border rounded-lg hover:bg-muted transition-colors disabled:opacity-50 flex items-center gap-2"
        >
          {loading && <Loader2 size={14} className="animate-spin" />}
          Atualizar
        </button>
      </div>

      {/* Banner de erro inline (visível mesmo sem toast) */}
      {errorMsg && (
        <div className="border border-red-300 bg-red-50 text-red-800 rounded-lg p-3 flex items-start gap-3">
          <AlertTriangle size={18} className="text-red-600 mt-0.5 shrink-0" />
          <div className="flex-1 text-sm">
            <div className="font-medium">Não foi possível carregar fechamentos</div>
            <div className="text-red-700/80 mt-0.5">{errorMsg}</div>
          </div>
          <button
            onClick={load}
            className="text-xs px-2 py-1 rounded border border-red-300 hover:bg-red-100"
          >
            Tentar novamente
          </button>
        </div>
      )}

      {/* KPIs */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
        <KpiCard
          icon={DollarSign}
          label="Pipeline em fechamento"
          value={formatBRL(summary.pipeline_value)}
          accent="text-emerald-600"
        />
        <KpiCard
          icon={FileText}
          label="Aguardando resposta"
          value={String(summary.count_total)}
          accent="text-blue-600"
        />
        <KpiCard
          icon={Clock}
          label="Vencem em 7 dias"
          value={String(summary.expiring_7d)}
          accent={summary.expiring_7d > 0 ? 'text-amber-600' : 'text-muted-foreground'}
        />
        <KpiCard
          icon={AlertTriangle}
          label="Já expiraram"
          value={String(summary.expired)}
          accent={summary.expired > 0 ? 'text-red-600' : 'text-muted-foreground'}
        />
        <KpiCard
          icon={TrendingUp}
          label="Conversão (30d)"
          value={formatPct(summary.conversion_rate_30d)}
          accent="text-violet-600"
        />
      </div>

      {/* Kanban de 6 colunas */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6 gap-3">
        {COLUMNS.map((col) => {
          const cards = by_category[col.key] || [];
          const colTotal = cards.reduce((s, c) => s + c.total_value, 0);
          const Icon = col.icon;
          return (
            <div key={col.key} className="flex flex-col bg-card border rounded-lg overflow-hidden">
              {/* Header da coluna */}
              <div className={`px-3 py-2 border-b-2 ${col.accent} flex items-center justify-between`}>
                <div className="flex items-center gap-2 min-w-0">
                  <span className="text-base shrink-0">{col.emoji}</span>
                  <span className="font-semibold text-sm truncate">{col.label}</span>
                </div>
                <span className="text-xs font-mono opacity-70 shrink-0">
                  {cards.length}
                </span>
              </div>
              {/* Total da coluna */}
              <div className="px-3 py-1.5 text-xs text-muted-foreground border-b bg-background/50">
                {colTotal > 0 ? formatBRL(colTotal) : '—'}
              </div>
              {/* Cards */}
              <div className="flex-1 p-2 space-y-2 min-h-[200px] max-h-[calc(100vh-22rem)] overflow-y-auto">
                {cards.length === 0 ? (
                  <div className="text-xs text-muted-foreground text-center py-6 italic">
                    Sem orçamentos
                  </div>
                ) : (
                  cards.map((q) => (
                    <QuoteCardItem
                      key={q.id}
                      quote={q}
                      loading={actionLoading === q.id}
                      onView={() => router.push(`/atendimento/pacientes/${q.patient.id}?tab=orcamentos`)}
                      onResend={() => handleResend(q.id)}
                      onAccept={() => handleMarkAccepted(q.id)}
                    />
                  ))
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─── KPI ──────────────────────────────────────────────────────────────────

function KpiCard({
  icon: Icon, label, value, accent,
}: { icon: React.ElementType; label: string; value: string; accent: string }) {
  return (
    <div className="p-3 border rounded-lg bg-card">
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <Icon size={14} className={accent} />
        <span className="truncate">{label}</span>
      </div>
      <div className={`text-lg font-bold mt-1 ${accent}`}>{value}</div>
    </div>
  );
}

// ─── Card de Quote ────────────────────────────────────────────────────────

function QuoteCardItem({
  quote: q,
  loading,
  onView,
  onResend,
  onAccept,
}: {
  quote: QuoteCard;
  loading: boolean;
  onView: () => void;
  onResend: () => void;
  onAccept: () => void;
}) {
  const urgency = urgencyTag(q.days_left);
  const wasRead = !!q.whatsapp_read_at;
  const portalViews = q.portal_view_count;

  return (
    <div className="border rounded-md p-2.5 bg-card hover:shadow-sm transition-shadow space-y-2">
      {/* Linha 1: Avatar + Nome + valor */}
      <div className="flex items-start justify-between gap-2">
        <button
          onClick={onView}
          className="flex items-center gap-2 hover:text-blue-600 flex-1 min-w-0 text-left"
          title={q.patient.name || 'Sem nome'}
        >
          <PatientAvatar
            patientId={q.patient.id}
            patientName={q.patient.name || 'Sem nome'}
            avatarUrl={q.patient.avatar_url}
            size={28}
          />
          <span className="font-medium text-sm truncate min-w-0">
            {q.patient.name || 'Sem nome'}
          </span>
        </button>
        <span className="text-sm font-bold text-emerald-700 whitespace-nowrap shrink-0">
          {formatBRL(q.total_value)}
        </span>
      </div>

      {/* Linha 2: Procedimento principal + N itens */}
      <div className="text-xs text-muted-foreground truncate" title={q.main_procedure}>
        {q.main_procedure}
        {q.items_count > 1 && (
          <span className="ml-1 text-muted-foreground/70">
            (+{q.items_count - 1} {q.items_count === 2 ? 'item' : 'itens'})
          </span>
        )}
      </div>

      {/* Linha 3: Urgência + leitura/visualização */}
      <div className="flex items-center justify-between gap-2 text-xs">
        <span className={`px-1.5 py-0.5 rounded font-medium ${urgency.cls}`}>
          {urgency.text}
        </span>
        <div className="flex items-center gap-2 text-muted-foreground">
          {wasRead && (
            <span title="Lido no WhatsApp" className="flex items-center gap-0.5">
              <MessageCircle size={11} className="text-blue-500" />
              <Check size={11} className="text-blue-500 -ml-1" />
            </span>
          )}
          {portalViews > 0 && (
            <span title={`Portal aberto ${portalViews}x`} className="flex items-center gap-0.5">
              <Eye size={11} />
              <span>{portalViews}</span>
            </span>
          )}
        </div>
      </div>

      {/* Ações */}
      <div className="flex items-center gap-1 pt-1 border-t">
        <button
          onClick={onView}
          disabled={loading}
          className="flex-1 text-xs px-2 py-1 rounded border hover:bg-muted disabled:opacity-50 flex items-center justify-center gap-1"
          title="Abrir ficha do paciente"
        >
          <Eye size={11} /> Ver
        </button>
        {q.patient.phone && (
          <button
            onClick={onResend}
            disabled={loading}
            className="flex-1 text-xs px-2 py-1 rounded border hover:bg-blue-50 hover:border-blue-300 disabled:opacity-50 flex items-center justify-center gap-1"
            title="Reenviar orçamento por WhatsApp"
          >
            {loading ? <Loader2 size={11} className="animate-spin" /> : <Send size={11} />}
            WA
          </button>
        )}
        <button
          onClick={onAccept}
          disabled={loading}
          className="flex-1 text-xs px-2 py-1 rounded border bg-emerald-50 border-emerald-300 hover:bg-emerald-100 text-emerald-700 disabled:opacity-50 flex items-center justify-center gap-1"
          title="Marcar como aceito (paciente confirmou fechamento)"
        >
          {loading ? <Loader2 size={11} className="animate-spin" /> : <Check size={11} />}
          Aceitar
        </button>
      </div>
    </div>
  );
}

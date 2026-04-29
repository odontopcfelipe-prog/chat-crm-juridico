'use client';

/**
 * QuoteVersions — historico de versoes do orcamento (Fase 24 — Onda 3b).
 *
 * Mostra timeline de todas as alteracoes "seladas" (envio/aceite/rejeite/
 * renegociacao). Click numa versao antiga abre modal com snapshot completo
 * pra operador comparar com o estado atual.
 *
 * Auto-esconde se nao tem versoes (orcamento ainda DRAFT, nunca foi enviado).
 */
import { useEffect, useState } from 'react';
import {
  History, Loader2, X, Send, Check, XCircle, Repeat,
} from 'lucide-react';
import api from '@/lib/api';
import { showError } from '@/lib/toast';

interface QuoteVersion {
  id: string;
  version_number: number;
  status: string;
  total_value: string | number;
  trigger: 'SEND' | 'ACCEPT' | 'REJECT' | 'RENEGOTIATE' | 'MANUAL';
  change_note: string | null;
  created_at: string;
  created_by: { id: string; name: string };
}

interface VersionDetail extends QuoteVersion {
  snapshot: any;
}

interface Props {
  quoteId: string;
}

const TRIGGER_CFG: Record<QuoteVersion['trigger'], { label: string; icon: React.ElementType; cls: string }> = {
  SEND:        { label: 'Enviado',     icon: Send,    cls: 'text-blue-600 bg-blue-500/10 border-blue-500/20' },
  ACCEPT:      { label: 'Aceito',      icon: Check,   cls: 'text-emerald-600 bg-emerald-500/10 border-emerald-500/20' },
  REJECT:      { label: 'Rejeitado',   icon: XCircle, cls: 'text-red-600 bg-red-500/10 border-red-500/20' },
  RENEGOTIATE: { label: 'Renegociado', icon: Repeat,  cls: 'text-amber-600 bg-amber-500/10 border-amber-500/20' },
  MANUAL:      { label: 'Manual',      icon: History, cls: 'text-muted-foreground bg-muted border-border' },
};

const formatBRL = (v: number | string) =>
  Number(v).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

export default function QuoteVersions({ quoteId }: Props) {
  const [list, setList] = useState<QuoteVersion[]>([]);
  const [loading, setLoading] = useState(true);
  const [openVersion, setOpenVersion] = useState<VersionDetail | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);

  useEffect(() => {
    setLoading(true);
    api.get<QuoteVersion[]>(`/quotes/${quoteId}/versions`)
      .then((r) => setList(r.data || []))
      .catch((err) => {
        // Falha silenciosa — pode ser que ainda nao tenha versao (orcamento DRAFT)
        if (err?.response?.status !== 404) {
          showError(err?.response?.data?.message || 'Erro ao carregar histórico');
        }
      })
      .finally(() => setLoading(false));
  }, [quoteId]);

  const openDetail = async (v: QuoteVersion) => {
    setLoadingDetail(true);
    try {
      const { data } = await api.get<VersionDetail>(`/quote-versions/${v.id}`);
      setOpenVersion(data);
    } catch (err: any) {
      showError(err?.response?.data?.message || 'Erro ao carregar versão');
    } finally {
      setLoadingDetail(false);
    }
  };

  // Auto-esconde se nao ha versoes (UI limpa)
  if (loading) return null;
  if (list.length === 0) return null;

  return (
    <div className="bg-card border border-border rounded-xl p-4 mb-4">
      <h3 className="text-sm font-semibold mb-3 flex items-center gap-2">
        <History size={14} className="text-primary" />
        Histórico de versões
        <span className="text-xs text-muted-foreground">({list.length})</span>
      </h3>

      <ol className="relative border-l-2 border-border ml-3 space-y-3">
        {list.map((v) => {
          const cfg = TRIGGER_CFG[v.trigger] || TRIGGER_CFG.MANUAL;
          const Icon = cfg.icon;
          return (
            <li key={v.id} className="ml-5 relative">
              <span className={`absolute -left-[34px] top-1 w-5 h-5 rounded-full border-4 border-background flex items-center justify-center ${cfg.cls.split(' ')[1]}`}>
                <Icon size={10} className={cfg.cls.split(' ')[0]} />
              </span>
              <button
                onClick={() => openDetail(v)}
                className="text-left w-full bg-background border border-border rounded-lg p-3 hover:border-primary/40 transition-colors group"
              >
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-mono font-bold text-sm">v{v.version_number}</span>
                  <span className={`text-[10px] px-1.5 py-0.5 rounded border ${cfg.cls}`}>
                    {cfg.label}
                  </span>
                  <span className="text-sm font-semibold ml-auto group-hover:text-primary">
                    {formatBRL(v.total_value)}
                  </span>
                </div>
                <div className="text-xs text-muted-foreground mt-1 flex items-center gap-2 flex-wrap">
                  <span>
                    {new Date(v.created_at).toLocaleString('pt-BR', {
                      day: '2-digit', month: '2-digit', year: 'numeric',
                      hour: '2-digit', minute: '2-digit',
                    })}
                  </span>
                  {v.created_by && <span>por {v.created_by.name}</span>}
                </div>
                {v.change_note && (
                  <p className="text-xs text-muted-foreground italic mt-1">"{v.change_note}"</p>
                )}
              </button>
            </li>
          );
        })}
      </ol>

      {(openVersion || loadingDetail) && (
        <VersionDetailModal
          version={openVersion}
          loading={loadingDetail}
          onClose={() => setOpenVersion(null)}
        />
      )}
    </div>
  );
}

// ─── Modal com snapshot completo ──────────────────────────

function VersionDetailModal({
  version, loading, onClose,
}: { version: VersionDetail | null; loading: boolean; onClose: () => void }) {
  return (
    <div
      className="fixed inset-0 z-[100] bg-black/50 backdrop-blur-sm flex items-center justify-center p-4"
      onClick={onClose}
    >
      <div
        className="bg-card border border-border rounded-xl w-full max-w-2xl shadow-2xl max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between p-4 border-b border-border sticky top-0 bg-card z-10">
          <div className="flex items-center gap-2">
            <History size={18} className="text-primary" />
            <h2 className="text-base font-semibold">
              {version ? `Versão v${version.version_number}` : 'Carregando...'}
            </h2>
            {version && (
              <span className="text-xs text-muted-foreground">
                · {new Date(version.created_at).toLocaleString('pt-BR')}
              </span>
            )}
          </div>
          <button onClick={onClose} className="p-1 hover:bg-accent rounded">
            <X size={18} />
          </button>
        </div>

        <div className="p-4">
          {loading || !version ? (
            <div className="py-8 text-center text-muted-foreground">
              <Loader2 size={20} className="inline animate-spin mr-1" /> Carregando snapshot...
            </div>
          ) : (
            <VersionSnapshotView snapshot={version.snapshot} />
          )}
        </div>
      </div>
    </div>
  );
}

function VersionSnapshotView({ snapshot }: { snapshot: any }) {
  if (!snapshot) return <p className="text-muted-foreground text-sm">Snapshot vazio.</p>;
  return (
    <div className="space-y-4">
      {/* Resumo financeiro */}
      <div className="grid grid-cols-3 gap-3 text-sm">
        <div>
          <p className="text-xs text-muted-foreground">Subtotal</p>
          <p className="font-semibold">{formatBRL(snapshot.subtotal || 0)}</p>
        </div>
        <div>
          <p className="text-xs text-muted-foreground">Desconto</p>
          <p className="font-semibold">
            {Number(snapshot.discount_percent || 0)}% ({formatBRL(snapshot.discount_value || 0)})
          </p>
        </div>
        <div>
          <p className="text-xs text-muted-foreground">Total</p>
          <p className="text-lg font-bold text-primary">{formatBRL(snapshot.total_value || 0)}</p>
        </div>
      </div>

      {snapshot.coupon && (
        <div className="text-xs p-2 rounded bg-emerald-500/5 border border-emerald-500/20">
          🏷️ Cupom: <span className="font-mono font-bold">{snapshot.coupon.code}</span>
        </div>
      )}

      {snapshot.payment_terms && (
        <div className="text-sm">
          <p className="text-xs text-muted-foreground">Condições de pagamento</p>
          <p>{snapshot.payment_terms}</p>
        </div>
      )}

      {/* Items */}
      {Array.isArray(snapshot.items) && snapshot.items.length > 0 && (
        <div>
          <p className="text-xs font-semibold text-muted-foreground mb-2">PROCEDIMENTOS</p>
          <table className="w-full text-sm">
            <thead className="text-xs text-muted-foreground">
              <tr className="border-b border-border">
                <th className="text-left py-1.5 font-medium">Procedimento</th>
                <th className="text-center py-1.5 font-medium">Dente</th>
                <th className="text-right py-1.5 font-medium">Qtd</th>
                <th className="text-right py-1.5 font-medium">Unit.</th>
                <th className="text-right py-1.5 font-medium">Total</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {snapshot.items.map((it: any, idx: number) => (
                <tr key={idx}>
                  <td className="py-1.5">{it.procedure_name || it.procedure_id?.slice(0, 8) || '—'}</td>
                  <td className="py-1.5 text-center text-xs">{it.tooth_fdi || '—'}</td>
                  <td className="py-1.5 text-right text-xs">{it.quantity}</td>
                  <td className="py-1.5 text-right text-xs">{formatBRL(it.unit_price || 0)}</td>
                  <td className="py-1.5 text-right font-semibold">{formatBRL(it.total_price || 0)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {snapshot.notes && (
        <div className="text-sm">
          <p className="text-xs text-muted-foreground">Observações</p>
          <p className="italic">{snapshot.notes}</p>
        </div>
      )}

      {snapshot.rejection_reason && (
        <div className="text-sm p-2 rounded bg-red-500/5 border border-red-500/20">
          <p className="text-xs font-semibold text-red-700">Motivo da rejeição</p>
          <p className="text-red-700">{snapshot.rejection_reason}</p>
        </div>
      )}
    </div>
  );
}

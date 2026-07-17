'use client';

// Central 2.0 — RESUMO do disparo aberto: métricas + a lista de envios (pra quem
// mandou, quando, status de entrega, erro). Fica ACIMA do editor quando um card é
// aberto. Fonte: GET /followup/disparo-detail?id=<card>&days=30.
import { useEffect, useState } from 'react';
import { Loader2, History, CheckCircle2, XCircle, Clock3, Eye } from 'lucide-react';
import api from '@/lib/api';

interface Envio {
  quando: string | null;
  nome: string | null;
  telefone: string | null;
  status: string; // SENT | DELIVERED | READ | FAILED | A_ENVIAR
  erro: string | null;
  extra?: string | null;
}
interface Detail {
  id: string;
  fonte: string | null;
  resumo: { hoje: number; aEnviar: number; falhasJanela: number; ultimoEnvio: string | null; janelaDias: number; total: number };
  envios: Envio[];
}

const STATUS_UI: Record<string, { label: string; cls: string; icon: typeof CheckCircle2 }> = {
  SENT: { label: 'enviado', cls: 'text-emerald-600 dark:text-emerald-400', icon: CheckCircle2 },
  DELIVERED: { label: 'entregue', cls: 'text-emerald-600 dark:text-emerald-400', icon: CheckCircle2 },
  READ: { label: 'lido', cls: 'text-sky-600 dark:text-sky-400', icon: Eye },
  FAILED: { label: 'falhou', cls: 'text-red-500', icon: XCircle },
  A_ENVIAR: { label: 'a enviar', cls: 'text-muted-foreground', icon: Clock3 },
};

function fmtQuando(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export function DisparoResumo({ disparoId }: { disparoId: string }) {
  const [loading, setLoading] = useState(true);
  const [detail, setDetail] = useState<Detail | null>(null);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    api.get<Detail>(`/followup/disparo-detail?id=${encodeURIComponent(disparoId)}&days=30`, { timeout: 12000 })
      .then((r) => { if (alive) setDetail(r.data); })
      .catch(() => { if (alive) setDetail(null); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [disparoId]);

  if (loading) {
    return (
      <div className="bg-card border border-border rounded-2xl p-5 mb-4 flex items-center gap-2 text-muted-foreground text-sm">
        <Loader2 size={15} className="animate-spin" /> Carregando o resumo do disparo…
      </div>
    );
  }

  // Sem fonte de registro (ex.: disparo antigo ainda não instrumentado) ou API velha.
  if (!detail || !detail.fonte) {
    return (
      <div className="bg-card border border-border rounded-2xl p-4 mb-4 text-[12px] text-muted-foreground">
        <History size={13} className="inline mr-1.5 -mt-0.5" />
        Este disparo ainda não tem registro individual de envios — os próximos passam a aparecer aqui.
      </div>
    );
  }

  const r = detail.resumo;
  return (
    <div className="bg-card border border-border rounded-2xl overflow-hidden mb-4">
      <div className="border-b border-border px-5 py-3 flex items-center gap-2">
        <History size={15} className="text-primary" />
        <h3 className="text-sm font-bold">Resumo do disparo</h3>
        <span className="text-[10px] text-muted-foreground ml-auto">últimos {r.janelaDias} dias</span>
      </div>

      {/* Métricas */}
      <div className="grid grid-cols-2 sm:grid-cols-4 divide-x divide-border border-b border-border text-center">
        <div className="py-3"><div className="text-lg font-extrabold tabular-nums">{r.hoje}</div><div className="text-[10px] uppercase tracking-wide text-muted-foreground">enviados hoje</div></div>
        <div className="py-3"><div className="text-lg font-extrabold tabular-nums">{r.aEnviar}</div><div className="text-[10px] uppercase tracking-wide text-muted-foreground">a enviar</div></div>
        <div className="py-3"><div className={`text-lg font-extrabold tabular-nums ${r.falhasJanela > 0 ? 'text-red-500' : ''}`}>{r.falhasJanela}</div><div className="text-[10px] uppercase tracking-wide text-muted-foreground">falhas</div></div>
        <div className="py-3"><div className="text-lg font-extrabold tabular-nums">{fmtQuando(r.ultimoEnvio)}</div><div className="text-[10px] uppercase tracking-wide text-muted-foreground">último envio</div></div>
      </div>

      {/* Lista de envios */}
      {detail.envios.length === 0 ? (
        <div className="px-5 py-4 text-[12px] text-muted-foreground">Nenhum envio registrado na janela.</div>
      ) : (
        <div className="max-h-72 overflow-y-auto divide-y divide-border">
          {detail.envios.map((e, i) => {
            const st = STATUS_UI[e.status] || STATUS_UI.SENT;
            const Icon = st.icon;
            return (
              <div key={i} className="px-5 py-2 flex items-center gap-3 text-[12px]">
                <span className="text-muted-foreground tabular-nums w-20 shrink-0">{fmtQuando(e.quando)}</span>
                <span className="font-semibold truncate min-w-0 flex-1">{e.nome || '(sem nome)'}</span>
                <span className="text-muted-foreground tabular-nums hidden sm:inline">{e.telefone || ''}</span>
                {e.extra && (
                  <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded bg-primary/10 text-primary whitespace-nowrap">{e.extra}</span>
                )}
                <span className={`inline-flex items-center gap-1 font-semibold whitespace-nowrap ${st.cls}`} title={e.erro || undefined}>
                  <Icon size={12} /> {st.label}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

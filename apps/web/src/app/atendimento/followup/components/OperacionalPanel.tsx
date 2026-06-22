'use client';

// Onda 17.49 — Painel "Operacional": as 4 automacoes do dia-a-dia que rodam no
// piloto automatico (confirmacao / lembrete / pos-atendimento / resumo dentista)
// em cards grandes, cada um com a metrica do dia, liga/desliga real e "Abrir".
// Dados: GET /followup/operacional. Toggle: PATCH /followup/operacional/toggle.

import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { CalendarCheck, Bell, Heart, FileText, Cake, ArrowRight, Loader2, Bot, History } from 'lucide-react';
import api from '@/lib/api';
import { showError } from '@/lib/toast';

type Which = 'confirmacao' | 'lembrete' | 'pos' | 'dentista' | 'aniversario';

interface OperacionalData {
  confirmacao: { enabled: boolean; enviadasHoje: number; confirmadasHoje: number; pct: number };
  lembrete: { enabled: boolean; enviadosHoje: number; antecedenciaLabel: string };
  pos: { enabled: boolean; nps: number | null; respostasHoje: number; media30d: number | null; responded: number };
  dentista: { enabled: boolean; sendAt: string; dentistasHoje: number };
  aniversario: { enabled: boolean; sendAt: string; aniversariantesHoje: number };
}

const COLOR: Record<string, string> = {
  emerald: 'bg-emerald-500/10 text-emerald-600',
  amber: 'bg-amber-500/10 text-amber-600',
  pink: 'bg-pink-500/10 text-pink-600',
  sky: 'bg-sky-500/10 text-sky-600',
  rose: 'bg-rose-500/10 text-rose-600',
};

// "07:00" -> "7h00"
const fmtHora = (hhmm: string): string => {
  const [h, m] = (hhmm || '07:00').split(':');
  return `${parseInt(h, 10)}h${m ?? '00'}`;
};

export function OperacionalPanel({ onOpenTab }: { onOpenTab: (tab: string) => void }) {
  const router = useRouter();
  const [data, setData] = useState<OperacionalData | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const r = await api.get<OperacionalData>('/followup/operacional');
      setData(r.data);
    } catch (e: any) {
      showError(e?.response?.data?.message || 'Falha ao carregar o painel operacional');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  // Resiliente a skew de versao backend/frontend: cada card so entra se o bloco
  // de dados dele veio na resposta. Assim um campo faltando (ex: API antiga sem
  // 'aniversario') apenas OMITE o card, em vez de quebrar a tela inteira.
  const cards = (data ? [
    data.confirmacao && {
      which: 'confirmacao' as Which, title: 'Confirmação de consulta', Icon: CalendarCheck, color: 'emerald',
      enabled: data.confirmacao.enabled,
      metric: data.confirmacao.enviadasHoje > 0 ? `${data.confirmacao.pct}%` : '—',
      sub: data.confirmacao.enviadasHoje > 0
        ? <>confirmaram · <b className="font-semibold text-foreground">{data.confirmacao.confirmadasHoje} de {data.confirmacao.enviadasHoje}</b> hoje</>
        : <>nenhuma enviada hoje</>,
      onOpen: () => router.push('/atendimento/agenda'),
    },
    data.lembrete && {
      which: 'lembrete' as Which, title: 'Lembrete de consulta', Icon: Bell, color: 'amber',
      enabled: data.lembrete.enabled,
      metric: `${data.lembrete.enviadosHoje}`,
      sub: <>enviados hoje · <b className="font-semibold text-foreground">{data.lembrete.antecedenciaLabel}</b></>,
      onOpen: () => onOpenTab('lembretes'),
    },
    data.pos && {
      which: 'pos' as Which, title: 'Pós-atendimento', Icon: Heart, color: 'pink',
      enabled: data.pos.enabled,
      metric: data.pos.nps != null ? `NPS ${data.pos.nps}` : '—',
      sub: <>média 30 dias · <b className="font-semibold text-foreground">{data.pos.respostasHoje} respostas</b> hoje</>,
      onOpen: () => onOpenTab('pos-atendimento'),
    },
    data.dentista && {
      which: 'dentista' as Which, title: 'Resumo do dentista', Icon: FileText, color: 'sky',
      enabled: data.dentista.enabled,
      metric: fmtHora(data.dentista.sendAt),
      sub: <><b className="font-semibold text-foreground">{data.dentista.dentistasHoje} dentistas</b> com agenda hoje</>,
      onOpen: () => onOpenTab('dentista'),
    },
    data.aniversario && {
      which: 'aniversario' as Which, title: 'Aniversário', Icon: Cake, color: 'rose',
      enabled: data.aniversario.enabled,
      metric: `${data.aniversario.aniversariantesHoje}`,
      sub: data.aniversario.enabled
        ? <>aniversariantes · <b className="font-semibold text-foreground">parabéns às {fmtHora(data.aniversario.sendAt)}</b></>
        : <>aniversariantes hoje · <b className="font-semibold text-foreground">envio desligado</b></>,
      onOpen: () => onOpenTab('aniversario'),
    },
  ] : []).filter(Boolean) as Array<{
    which: Which; title: string; Icon: typeof Bell; color: string;
    enabled: boolean; metric: string; sub: ReactNode; onOpen: () => void;
  }>;

  const ligados = cards.filter((c) => c.enabled).length;

  return (
    <div>
      <div className="flex items-center gap-2 mb-3 flex-wrap">
        <Bot size={18} className="text-primary" />
        <h2 className="text-base font-semibold text-foreground">Operacional</h2>
        <span className="text-sm text-muted-foreground">— o dia a dia que roda no piloto automático</span>
        {data && (
          <span className="ml-auto text-[11px] font-medium text-muted-foreground bg-muted/50 border border-border rounded-full px-2.5 py-1">
            {ligados} de {cards.length} ligados
          </span>
        )}
      </div>

      {/* Onda 17.60 — acesso ao histórico unificado de todos os disparos. */}
      <button
        onClick={() => onOpenTab('historico')}
        className="w-full mb-4 flex items-center gap-3 p-3.5 rounded-2xl border border-border bg-gradient-to-r from-primary/5 to-transparent hover:from-primary/10 transition-colors text-left"
      >
        <div className="w-10 h-10 rounded-xl bg-primary/10 text-primary flex items-center justify-center shrink-0">
          <History size={20} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-sm font-bold text-foreground">Histórico de Disparos</div>
          <div className="text-[11px] text-muted-foreground">Tudo que saiu pro paciente — lembretes, confirmações, NPS, aniversário e mais — num lugar só.</div>
        </div>
        <ArrowRight size={16} className="text-muted-foreground shrink-0" />
      </button>

      {loading ? (
        <div className="py-10 flex items-center justify-center text-muted-foreground">
          <Loader2 size={18} className="animate-spin mr-2" /> Carregando...
        </div>
      ) : !data ? null : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {cards.map((c) => {
            const Icon = c.Icon;
            return (
              <div key={c.which} className="bg-card border border-border rounded-2xl p-5 flex flex-col">
                <div className="flex items-start justify-between">
                  <div className={`w-11 h-11 rounded-xl flex items-center justify-center ${COLOR[c.color]}`}>
                    <Icon size={22} />
                  </div>
                  <span
                    className={`w-2.5 h-2.5 rounded-full mt-1 ${c.enabled ? 'bg-emerald-500' : 'bg-muted-foreground/30'}`}
                    title={c.enabled ? 'Ligado' : 'Desligado'}
                  />
                </div>
                <p className="text-sm font-medium text-foreground mt-3">{c.title}</p>
                <p className="text-3xl font-bold text-foreground mt-1 leading-none">{c.metric}</p>
                <p className="text-xs text-muted-foreground mt-1.5">{c.sub}</p>
                <div className="flex items-center justify-between mt-4 pt-3 border-t border-border">
                  {/* Onda 17.60 — só LEITURA aqui (liga/desliga vive na Central de
                      Disparos: "configura lá, opera aqui"). */}
                  <span className={`text-xs font-medium ${c.enabled ? 'text-emerald-600 dark:text-emerald-400' : 'text-muted-foreground'}`}>
                    {c.enabled ? '● Ligado' : '○ Desligado'}
                  </span>
                  <button
                    onClick={c.onOpen}
                    className="inline-flex items-center gap-1 text-sm font-medium text-primary hover:underline"
                  >
                    Abrir <ArrowRight size={14} />
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

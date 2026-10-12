'use client';

// Régua de REATIVAÇÃO de leads (follow-up do chip Comercial) — gaveta do CRC.
// Mostra o que a régua VAI mandar (Previstos, com o texto) e o que já mandou
// (Enviados ✓, com entrega/leitura e se o contato respondeu). Aqui só se OPERA
// (pular um toque, parar a régua de um contato); ligar/desligar e editar os textos
// ficam em Configurações › Disparos (Central de Disparos), como os outros disparos.
// Fonte: /reactivation/* (tenant sempre do token no backend).
import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  X as XIcon, Send, RefreshCw, Loader2, Inbox, AlertTriangle, Check, CheckCheck, SkipForward, Ban,
  Sparkles, FileText, MessageCircle, Smartphone, CornerDownLeft,
} from 'lucide-react';
import api from '@/lib/api';
import { formatPhone } from '@/lib/utils';
import { showError, showSuccess } from '@/lib/toast';
import {
  REATIVACAO_COLUNAS, REATIVACAO_COLUNA_COR, REATIVACAO_COLUNA_LABEL, REATIVACAO_INTERVALO_MIN, REATIVACAO_JANELA,
  isReativacaoColuna, reativacaoBaloes, type ReativacaoColuna,
} from '@/lib/reativacao';

// ─── Contrato da API (/reactivation/*) ───────────────────────────────────────

interface Summary {
  envio: boolean;
  colunas: Record<ReativacaoColuna, boolean>;
  teto: number;
  enviados_hoje: number;
  previstos_hoje: number;
  ativos: number;
  respondidos_30d: number;
  chip_comercial: string | null;
}

interface ScheduledItem {
  id: string;
  lead_id: string;
  lead_name: string | null;
  lead_phone: string | null;
  coluna: string;
  toque: number;
  total_toques: number;
  agendado_para: string; // ISO, UTC real
  texto: string | null;
  texto_status: 'ia' | 'modelo';
  pipeline: { name: string; color: string | null } | null;
  conversation_id: string | null;
}

interface SentItem {
  id: string;
  lead_id: string;
  lead_name: string | null;
  lead_phone: string | null;
  coluna: string;
  toque: number;
  total_toques?: number;
  sent_at: string | null;
  texto: string | null;
  status: 'ENVIADO' | 'FALHOU' | 'CANCELADO' | 'PULADO' | string;
  motivo: string | null;
  entrega: 'enviado' | 'entregue' | 'lido' | null;
  respondeu: boolean;
  conversation_id: string | null;
}

type Tab = 'previstos' | 'enviados';

// ─── Datas (sempre no fuso da clínica — Maceió) ─────────────────────────────
// agendado_para/sent_at são instantes UTC de verdade; a janela da régua é em hora
// de Maceió, então "hoje/amanhã" e a hora exibida são calculados nesse fuso (e não
// no fuso do computador de quem abre o painel).

const TZ = 'America/Maceio';
const fmtDayKey = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' });
const fmtDiaMes = new Intl.DateTimeFormat('pt-BR', { timeZone: TZ, day: '2-digit', month: '2-digit' });
const fmtSemana = new Intl.DateTimeFormat('pt-BR', { timeZone: TZ, weekday: 'short' });
const fmtHora = new Intl.DateTimeFormat('pt-BR', { timeZone: TZ, hour: '2-digit', minute: '2-digit' });
const fmtSoHora = new Intl.DateTimeFormat('en-US', { timeZone: TZ, hour: 'numeric', hourCycle: 'h23' });

/** Hora cheia agora em Maceió (0–23). */
function horaMaceio(): number {
  const h = Number(fmtSoHora.format(new Date()));
  return Number.isFinite(h) ? h : 0;
}

/** 'YYYY-MM-DD' do instante no fuso de Maceió. */
function dayKeyOf(d: Date): string {
  return fmtDayKey.format(d);
}
/** Dia da semana (0=dom) de um 'YYYY-MM-DD' (meio-dia UTC: não vira o dia por fuso). */
function weekdayOfKey(key: string): number {
  return new Date(`${key}T12:00:00Z`).getUTCDay();
}
function diaMesOfKey(key: string): string {
  const [, m, d] = key.split('-');
  return `${d}/${m}`;
}
function semanaCurta(d: Date): string {
  const s = fmtSemana.format(d).replace('.', '');
  return s.charAt(0).toUpperCase() + s.slice(1);
}
function fmtQuando(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const hoje = dayKeyOf(new Date());
  const ontem = dayKeyOf(new Date(Date.now() - 86_400_000));
  const k = dayKeyOf(d);
  const dia = k === hoje ? 'hoje' : k === ontem ? 'ontem' : fmtDiaMes.format(d);
  return `${dia} ${fmtHora.format(d)}`;
}

/** Forma do erro do axios que interessa aqui (sem `any`). */
type ApiErr = { code?: string; response?: { status?: number; data?: { message?: unknown } } };

function errStatus(e: unknown): number | undefined {
  return (e as ApiErr | null)?.response?.status;
}

function errMsg(e: unknown, fallback: string): string {
  const err = (e ?? {}) as ApiErr;
  const raw = err.response?.data?.message;
  const msg = Array.isArray(raw) ? raw.join(' · ') : typeof raw === 'string' ? raw : '';
  // Rota inexistente (API ainda sem a régua): o Nest responde 404 "Cannot GET /…".
  // Um 404 de verdade (toque não achado) vem com a mensagem do serviço.
  if (err.response?.status === 404 && (!msg || /^Cannot (GET|POST|PUT|PATCH|DELETE) /.test(msg))) {
    return 'A régua de reativação ainda não está disponível neste servidor (a API precisa ser atualizada).';
  }
  if (err.code === 'ECONNABORTED' || !err.response) return 'Sem resposta do servidor. Tente de novo em instantes.';
  return msg || fallback;
}

// ─── Peças visuais ───────────────────────────────────────────────────────────

function ColunaBadge({ coluna }: { coluna: string }) {
  const known = isReativacaoColuna(coluna);
  const color = known ? REATIVACAO_COLUNA_COR[coluna] : '#6b7280';
  return (
    <span
      className="text-[10px] font-semibold px-1.5 py-0.5 rounded-full border whitespace-nowrap"
      style={{ color, borderColor: color + '55', backgroundColor: color + '14' }}
    >
      {known ? REATIVACAO_COLUNA_LABEL[coluna] : coluna}
    </span>
  );
}

/** Texto em balões (o worker manda 1 balão por bloco separado por linha em branco). */
function Baloes({ texto, muted }: { texto: string | null; muted?: boolean }) {
  const baloes = reativacaoBaloes(texto);
  if (baloes.length === 0) {
    return <p className="text-[11px] italic text-muted-foreground">(sem texto)</p>;
  }
  return (
    <div className="flex flex-col items-end gap-1">
      {baloes.map((b, i) => (
        <div
          key={i}
          className={`max-w-[92%] px-3 py-1.5 rounded-2xl rounded-tr-md text-[12px] leading-snug whitespace-pre-wrap break-words border ${
            muted
              ? 'bg-muted/50 border-border text-muted-foreground'
              : 'bg-emerald-500/10 border-emerald-500/20 text-foreground'
          }`}
        >
          {b}
        </div>
      ))}
    </div>
  );
}

// Motivos gravados como CÓDIGO pelo worker/API (status do ciclo) → texto pra equipe.
// O resto (ex.: 'pulado manualmente', 'pode ter saído') já vem legível.
const MOTIVO_LABEL: Record<string, string> = {
  SEM_WHATSAPP: 'número sem WhatsApp',
  RESPONDEU: 'o contato respondeu',
  AGENDOU: 'agendou',
  VIROU_PACIENTE: 'virou paciente',
  OPT_OUT: 'pediu pra parar',
  MUDOU_ETAPA: 'mudou de etapa no funil',
  HUMANO: 'um humano assumiu a conversa',
  CANCELADA: 'régua cancelada',
};
const motivoLabel = (m: string | null) => (m ? MOTIVO_LABEL[m.trim().toUpperCase()] ?? m : '');

function EntregaIcon({ item }: { item: SentItem }) {
  if (item.status === 'FALHOU') {
    return (
      <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-red-500" title={motivoLabel(item.motivo) || 'falhou'}>
        <AlertTriangle size={13} /> falhou
      </span>
    );
  }
  if (item.status === 'CANCELADO' || item.status === 'PULADO') {
    return (
      <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded bg-muted text-muted-foreground" title={motivoLabel(item.motivo) || undefined}>
        {item.status === 'PULADO' ? 'pulado' : 'cancelado'}
      </span>
    );
  }
  if (item.entrega === 'lido') {
    return <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-sky-500" title="Lido"><CheckCheck size={14} /> lido</span>;
  }
  if (item.entrega === 'entregue') {
    return <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-muted-foreground" title="Entregue"><CheckCheck size={14} /> entregue</span>;
  }
  return <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-muted-foreground" title="Enviado"><Check size={14} /> enviado</span>;
}

// ─── Painel ──────────────────────────────────────────────────────────────────

export function ReativacaoPanel({ onClose }: { onClose: () => void }) {
  const router = useRouter();
  const [tab, setTab] = useState<Tab>('previstos');
  const [coluna, setColuna] = useState<ReativacaoColuna | ''>('');

  const [summary, setSummary] = useState<Summary | null>(null);
  const [summaryError, setSummaryError] = useState<string | null>(null);

  const [scheduled, setScheduled] = useState<ScheduledItem[] | null>(null);
  const [sent, setSent] = useState<SentItem[] | null>(null);
  const [listLoading, setListLoading] = useState(true);
  const [listError, setListError] = useState<string | null>(null);

  // Ação em andamento por item (pular/parar) — trava os botões daquela linha.
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  // Confirmação inline do "Parar régua" (precisa de confirmação + opção de opt-out).
  const [stopFor, setStopFor] = useState<{ itemId: string; leadId: string; name: string } | null>(null);
  const [stopOptOut, setStopOptOut] = useState(false);

  // Descarta resposta velha quando o filtro/aba muda antes de a anterior chegar.
  const reqSeq = useRef(0);

  const loadSummary = useCallback(async () => {
    try {
      const r = await api.get<Summary>('/reactivation/summary', { timeout: 15000 });
      setSummary(r.data);
      setSummaryError(null);
    } catch (e) {
      setSummaryError(errMsg(e, 'Não foi possível carregar o resumo da régua.'));
    }
  }, []);

  const loadList = useCallback(async (which: Tab, col: ReativacaoColuna | '') => {
    const seq = ++reqSeq.current;
    setListLoading(true);
    setListError(null);
    try {
      const params: Record<string, string | number> = { days: which === 'previstos' ? 14 : 30 };
      if (col) params.coluna = col;
      if (which === 'previstos') {
        const r = await api.get<{ items: ScheduledItem[] }>('/reactivation/scheduled', { params, timeout: 20000 });
        if (seq !== reqSeq.current) return;
        setScheduled(Array.isArray(r.data?.items) ? r.data.items : []);
      } else {
        const r = await api.get<{ items: SentItem[] }>('/reactivation/sent', { params, timeout: 20000 });
        if (seq !== reqSeq.current) return;
        setSent(Array.isArray(r.data?.items) ? r.data.items : []);
      }
    } catch (e) {
      if (seq !== reqSeq.current) return;
      setListError(errMsg(e, 'Não foi possível carregar a lista.'));
    } finally {
      if (seq === reqSeq.current) setListLoading(false);
    }
  }, []);

  useEffect(() => { loadSummary(); }, [loadSummary]);
  useEffect(() => { loadList(tab, coluna); }, [tab, coluna, loadList]);

  // Esc fecha (a confirmação de parar, se aberta; senão a gaveta).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (stopFor) setStopFor(null);
      else onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, stopFor]);

  const refresh = () => { loadSummary(); loadList(tab, coluna); };

  // Mesmo caminho do "Abrir no chat" do CRC (openInChat): o inbox lê crm_open_conv.
  const openChat = (conversationId: string | null) => {
    if (!conversationId) return;
    try { sessionStorage.setItem('crm_open_conv', conversationId); } catch { /* storage indisponível */ }
    router.push('/atendimento');
  };

  const skip = async (item: ScheduledItem) => {
    setBusy((b) => ({ ...b, [item.id]: true }));
    try {
      await api.post(`/reactivation/dispatches/${item.id}/skip`);
      setScheduled((list) => (list ? list.filter((x) => x.id !== item.id) : list));
      showSuccess('Toque pulado.');
      loadSummary();
    } catch (e) {
      showError(errMsg(e, 'Não foi possível pular este toque.'));
      // 404 = já saiu/foi cancelado por outro caminho → recarrega pra refletir.
      if (errStatus(e) === 404) loadList(tab, coluna);
    } finally {
      setBusy((b) => { const n = { ...b }; delete n[item.id]; return n; });
    }
  };

  const confirmStop = async () => {
    if (!stopFor) return;
    const { itemId, leadId } = stopFor;
    const optOut = stopOptOut;
    setBusy((b) => ({ ...b, [itemId]: true }));
    try {
      await api.post(`/reactivation/leads/${leadId}/stop`, { opt_out: optOut });
      // Some com TODOS os toques previstos do contato (a régua dele parou inteira).
      setScheduled((list) => (list ? list.filter((x) => x.lead_id !== leadId) : list));
      setStopFor(null);
      setStopOptOut(false);
      showSuccess(optOut ? 'Régua parada — este contato não entra mais na reativação.' : 'Régua parada para este contato.');
      loadSummary();
    } catch (e) {
      showError(errMsg(e, 'Não foi possível parar a régua deste contato.'));
    } finally {
      setBusy((b) => { const n = { ...b }; delete n[itemId]; return n; });
    }
  };

  // ── Previstos agrupados por dia (fuso de Maceió) ──
  const hojeKey = dayKeyOf(new Date());
  const amanhaKey = dayKeyOf(new Date(Date.now() + 86_400_000));
  const grupos: { key: string; label: string; nota: string | null; items: (ScheduledItem & { atrasadoDesde: string | null })[] }[] = [];
  if (scheduled) {
    const byKey = new Map<string, (ScheduledItem & { atrasadoDesde: string | null })[]>();
    for (const it of scheduled) {
      const d = new Date(it.agendado_para);
      const real = Number.isNaN(d.getTime()) ? hojeKey : dayKeyOf(d);
      // O que já devia ter saído (envio desligado, teto do dia, domingo…) está na
      // fila AGORA: mostra em "Hoje", com a data original.
      const key = real < hojeKey ? hojeKey : real;
      const arr = byKey.get(key) || [];
      arr.push({ ...it, atrasadoDesde: real < hojeKey ? diaMesOfKey(real) : null });
      byKey.set(key, arr);
    }
    const janelaHojeEncerrada = horaMaceio() >= REATIVACAO_JANELA.fim;
    for (const key of [...byKey.keys()].sort()) {
      const sample = new Date(`${key}T15:00:00Z`); // meio-dia em Maceió
      const base = key === hojeKey ? 'Hoje' : key === amanhaKey ? 'Amanhã' : semanaCurta(sample);
      // Domingo (fora da janela seg–sáb) não envia: o que cai nele escorre pro dia útil seguinte.
      const foraDaJanela = !REATIVACAO_JANELA.dias.includes(weekdayOfKey(key));
      grupos.push({
        key,
        label: `${base} · ${diaMesOfKey(key)}`,
        nota: foraDaJanela
          ? 'não envia neste dia → sai no próximo dia útil'
          : key === hojeKey && janelaHojeEncerrada
            ? `janela de hoje encerrada (${REATIVACAO_JANELA.fim}h) → sai no próximo dia útil`
            : `${REATIVACAO_JANELA.inicio}h–${REATIVACAO_JANELA.fim}h`,
        items: byKey.get(key)!.sort((a, b) => a.agendado_para.localeCompare(b.agendado_para)),
      });
    }
  }

  const nenhumaColuna = !!summary && !REATIVACAO_COLUNAS.some((c) => summary.colunas?.[c]);

  const kpi = (label: string, value: string | number, cls: string, title?: string) => (
    <div className={`flex-1 min-w-[110px] p-3 rounded-xl border ${cls}`} title={title}>
      <div className="text-[10px] font-bold uppercase tracking-wider opacity-70">{label}</div>
      <div className="text-xl font-extrabold mt-0.5 tabular-nums">{value}</div>
    </div>
  );

  const empty = (msg: string) => (
    <div className="py-14 flex flex-col items-center justify-center text-muted-foreground gap-2">
      <Inbox size={28} className="opacity-40" />
      <p className="text-sm text-center px-6">{msg}</p>
    </div>
  );

  const configLink = (
    <Link href="/atendimento/settings/disparos" className="font-semibold underline underline-offset-2 hover:opacity-80">
      Configurações › Disparos
    </Link>
  );

  return (
    <>
      {/* z acima da barra inferior do celular (z-60), senão ela cobre o fim da lista. */}
      <div className="fixed inset-0 z-[65] bg-black/30 backdrop-blur-[2px]" onClick={onClose} />
      <aside className="fixed right-0 top-0 h-full w-full sm:w-[560px] z-[70] bg-card border-l border-border shadow-2xl flex flex-col animate-in slide-in-from-right duration-200">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-border shrink-0">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <Send size={16} className="text-primary" />
              <h2 className="text-[14px] font-bold text-foreground">Disparos de reativação</h2>
            </div>
            <p className="text-[11px] text-muted-foreground mt-0.5 truncate">
              Follow-up do chip Comercial pra quem parou de responder.
            </p>
          </div>
          <div className="flex items-center gap-1">
            <button
              onClick={refresh}
              disabled={listLoading}
              className="p-1.5 rounded-lg hover:bg-accent text-muted-foreground disabled:opacity-50"
              title="Atualizar"
            >
              <RefreshCw size={15} className={listLoading ? 'animate-spin' : ''} />
            </button>
            <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-accent text-muted-foreground" title="Fechar (Esc)">
              <XIcon size={16} />
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4 custom-scrollbar">
          {/* KPIs */}
          {summaryError ? (
            <div className="flex items-start gap-2 p-3 rounded-xl border border-red-500/30 bg-red-500/10 text-[12px] text-red-700 dark:text-red-300">
              <AlertTriangle size={14} className="shrink-0 mt-0.5" />
              <span className="flex-1">{summaryError}</span>
              <button onClick={loadSummary} className="font-semibold underline underline-offset-2 shrink-0">Tentar de novo</button>
            </div>
          ) : !summary ? (
            <div className="flex items-center gap-2 text-[12px] text-muted-foreground"><Loader2 size={13} className="animate-spin" /> Carregando o resumo…</div>
          ) : (
            <>
              <div className="flex gap-2 flex-wrap">
                {kpi('Enviados hoje', `${summary.enviados_hoje}/${summary.teto}`,
                  summary.enviados_hoje >= summary.teto
                    ? 'border-amber-500/30 bg-amber-500/5 text-amber-600 dark:text-amber-400'
                    : 'border-emerald-500/20 bg-emerald-500/5 text-emerald-600 dark:text-emerald-400',
                  // Conta igual ao teto do worker: inclui as que deram erro mas podem ter saído.
                  'Mensagens da régua que saíram hoje (inclui as que deram erro mas podem ter saído — contam pro teto) / teto diário da clínica')}
                {kpi('Previstos hoje', summary.previstos_hoje, 'border-sky-500/20 bg-sky-500/5 text-sky-600 dark:text-sky-400')}
                {kpi('Na régua', summary.ativos, 'border-border bg-card text-foreground', 'Contatos com régua ativa agora')}
                {kpi('Responderam', summary.respondidos_30d, 'border-violet-500/20 bg-violet-500/5 text-violet-600 dark:text-violet-400', 'Contatos que responderam a um toque nos últimos 30 dias')}
              </div>

              {!summary.envio && (
                <div className="flex items-start gap-2 p-3 rounded-xl border border-amber-500/30 bg-amber-500/10 text-[12px] text-amber-800 dark:text-amber-300">
                  <AlertTriangle size={14} className="shrink-0 mt-0.5" />
                  <span><b>Envio desligado</b> — isto é o que sairia. Ligue em {configLink}.</span>
                </div>
              )}
              {nenhumaColuna && (
                <div className="flex items-start gap-2 p-3 rounded-xl border border-border bg-muted/40 text-[12px] text-muted-foreground">
                  <AlertTriangle size={14} className="shrink-0 mt-0.5" />
                  <span><b className="text-foreground">Nenhuma coluna ligada</b> — ninguém entra na régua. Ligue as colunas em {configLink}.</span>
                </div>
              )}
              {summary.envio && !summary.chip_comercial && (
                <div className="flex items-start gap-2 p-3 rounded-xl border border-red-500/30 bg-red-500/10 text-[12px] text-red-700 dark:text-red-300">
                  <Smartphone size={14} className="shrink-0 mt-0.5" />
                  <span><b>Sem chip Comercial</b> — a régua não envia (nunca sai pelo chip da Clínica). Conecte um chip Comercial em Configurações › WhatsApp.</span>
                </div>
              )}
              <p className="text-[11px] text-muted-foreground">
                {summary.chip_comercial ? <>Sai pelo chip <b className="text-foreground">{summary.chip_comercial}</b> · </> : null}
                seg–sáb {REATIVACAO_JANELA.inicio}h–{REATIVACAO_JANELA.fim}h · {REATIVACAO_INTERVALO_MIN.min}–{REATIVACAO_INTERVALO_MIN.max} min entre envios · 1 mensagem por dia por contato · para quando o contato responde.
              </p>
            </>
          )}

          {/* Abas */}
          <div className="flex gap-1 border-b border-border">
            {([
              { id: 'previstos' as Tab, label: 'Previstos' },
              { id: 'enviados' as Tab, label: 'Enviados ✓' },
            ]).map((t) => (
              <button
                key={t.id}
                onClick={() => { setTab(t.id); setStopFor(null); }}
                className={`px-3 py-2 text-sm font-semibold -mb-px border-b-2 whitespace-nowrap transition-colors ${
                  tab === t.id ? 'border-primary text-primary' : 'border-transparent text-muted-foreground hover:text-foreground'
                }`}
              >
                {t.label}
                {t.id === 'previstos' && scheduled && <span className="opacity-60 ml-1">{scheduled.length}</span>}
                {t.id === 'enviados' && sent && <span className="opacity-60 ml-1">{sent.length}</span>}
              </button>
            ))}
          </div>

          {/* Filtro por coluna */}
          <div className="flex items-center gap-1.5 flex-wrap">
            <button
              onClick={() => setColuna('')}
              className={`px-2.5 py-1 text-[11px] font-semibold rounded-full border transition-colors ${
                coluna === '' ? 'bg-primary text-primary-foreground border-primary' : 'bg-background text-muted-foreground border-border hover:text-foreground'
              }`}
            >
              Todas
            </button>
            {REATIVACAO_COLUNAS.map((c) => {
              const ativa = coluna === c;
              const cor = REATIVACAO_COLUNA_COR[c];
              const desligada = !!summary && !summary.colunas?.[c];
              return (
                <button
                  key={c}
                  onClick={() => setColuna(ativa ? '' : c)}
                  title={desligada ? 'Coluna desligada em Configurações › Disparos' : undefined}
                  className={`inline-flex items-center gap-1 px-2.5 py-1 text-[11px] font-semibold rounded-full border transition-colors ${
                    ativa ? 'text-white' : 'bg-background text-muted-foreground border-border hover:text-foreground'
                  } ${desligada && !ativa ? 'opacity-60' : ''}`}
                  style={ativa ? { backgroundColor: cor, borderColor: cor } : undefined}
                >
                  <span className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: ativa ? '#fff' : cor }} />
                  {REATIVACAO_COLUNA_LABEL[c]}
                </button>
              );
            })}
          </div>

          {/* Lista */}
          {listError ? (
            <div className="flex items-start gap-2 p-3 rounded-xl border border-red-500/30 bg-red-500/10 text-[12px] text-red-700 dark:text-red-300">
              <AlertTriangle size={14} className="shrink-0 mt-0.5" />
              <span className="flex-1">{listError}</span>
              <button onClick={() => loadList(tab, coluna)} className="font-semibold underline underline-offset-2 shrink-0">Tentar de novo</button>
            </div>
          ) : listLoading && (tab === 'previstos' ? !scheduled : !sent) ? (
            <div className="py-14 flex items-center justify-center text-muted-foreground"><Loader2 size={20} className="animate-spin" /></div>
          ) : tab === 'previstos' ? (
            grupos.length === 0 ? empty(
              nenhumaColuna
                ? 'Nenhuma coluna ligada — ligue as colunas em Configurações › Disparos pra os contatos parados entrarem aqui.'
                : coluna
                  ? `Nenhum toque previsto em “${REATIVACAO_COLUNA_LABEL[coluna]}” nos próximos 14 dias.`
                  : 'Nenhum toque previsto nos próximos 14 dias. O planejador roda de 30 em 30 min (seg–sáb) e coloca aqui quem está parado nas colunas ligadas.',
            ) : (
              <div className={`space-y-4 ${listLoading ? 'opacity-60' : ''}`}>
                {grupos.map((g) => (
                  <div key={g.key} className="space-y-2">
                    <div className="flex items-baseline gap-2 sticky top-0 bg-card/95 backdrop-blur py-1 z-[1]">
                      <span className="text-[12px] font-bold text-foreground">{g.label}</span>
                      {g.nota && <span className="text-[11px] text-muted-foreground">{g.nota}</span>}
                      <span className="text-[11px] text-muted-foreground ml-auto">{g.items.length}</span>
                    </div>
                    {g.items.map((it) => {
                      const isBusy = !!busy[it.id];
                      const confirming = stopFor?.itemId === it.id;
                      return (
                        <div key={it.id} className="rounded-xl border border-border bg-background/40 p-3 space-y-2">
                          <div className="flex items-start gap-2">
                            <div className="min-w-0 flex-1">
                              {it.conversation_id ? (
                                <button
                                  onClick={() => openChat(it.conversation_id)}
                                  className="text-sm font-semibold text-foreground hover:text-primary hover:underline truncate max-w-full text-left inline-flex items-center gap-1"
                                  title="Abrir a conversa"
                                >
                                  {it.lead_name || 'Sem nome'} <MessageCircle size={12} className="shrink-0 opacity-60" />
                                </button>
                              ) : (
                                <span className="text-sm font-semibold text-foreground truncate block" title="Sem conversa vinculada">{it.lead_name || 'Sem nome'}</span>
                              )}
                              {it.lead_phone && <div className="text-[11px] text-muted-foreground">{formatPhone(it.lead_phone)}</div>}
                            </div>
                            <div className="flex flex-col items-end gap-1 shrink-0">
                              <ColunaBadge coluna={it.coluna} />
                              <span className="text-[10px] font-semibold text-muted-foreground whitespace-nowrap">
                                toque {it.toque} de {it.total_toques}
                              </span>
                            </div>
                          </div>

                          <div className="flex items-center gap-1.5 flex-wrap">
                            {it.texto_status === 'ia' ? (
                              <span className="inline-flex items-center gap-1 text-[10px] font-semibold px-1.5 py-0.5 rounded bg-violet-500/15 text-violet-600 dark:text-violet-400">
                                <Sparkles size={10} /> texto da IA
                              </span>
                            ) : (
                              <span
                                className="inline-flex items-center gap-1 text-[10px] font-semibold px-1.5 py-0.5 rounded bg-muted text-muted-foreground"
                                title="Ainda é o modelo preenchido. Até ~1 dia antes do envio a IA reescreve com o histórico da conversa."
                              >
                                <FileText size={10} /> modelo — a IA adapta
                              </span>
                            )}
                            {it.pipeline && (
                              <span
                                className="text-[10px] font-semibold px-1.5 py-0.5 rounded-full border whitespace-nowrap"
                                style={{ color: it.pipeline.color || '#6b7280', borderColor: (it.pipeline.color || '#6b7280') + '55' }}
                              >
                                {it.pipeline.name}
                              </span>
                            )}
                            {it.atrasadoDesde && (
                              <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-700 dark:text-amber-400" title="Já devia ter saído — está na fila">
                                previsto p/ {it.atrasadoDesde}
                              </span>
                            )}
                          </div>

                          <Baloes texto={it.texto} muted={it.texto_status !== 'ia'} />

                          {confirming ? (
                            <div className="rounded-lg border border-red-500/30 bg-red-500/5 p-2.5 space-y-2">
                              <p className="text-[12px] text-foreground">
                                Parar a régua de <b>{stopFor?.name}</b>? Os próximos toques deste contato são cancelados.
                              </p>
                              <label className="flex items-start gap-2 text-[11px] text-muted-foreground cursor-pointer">
                                <input
                                  type="checkbox"
                                  checked={stopOptOut}
                                  onChange={(e) => setStopOptOut(e.target.checked)}
                                  className="mt-0.5"
                                />
                                <span>Não reativar mais este contato (ex.: pediu pra não receber mensagens).</span>
                              </label>
                              <div className="flex justify-end gap-2">
                                <button
                                  onClick={() => { setStopFor(null); setStopOptOut(false); }}
                                  disabled={isBusy}
                                  className="px-3 py-1.5 text-[12px] font-semibold rounded-lg border border-border hover:bg-accent disabled:opacity-50"
                                >
                                  Cancelar
                                </button>
                                <button
                                  onClick={confirmStop}
                                  disabled={isBusy}
                                  className="inline-flex items-center gap-1.5 px-3 py-1.5 text-[12px] font-bold rounded-lg bg-red-500 text-white hover:bg-red-600 disabled:opacity-50"
                                >
                                  {isBusy ? <Loader2 size={12} className="animate-spin" /> : <Ban size={12} />} Parar régua
                                </button>
                              </div>
                            </div>
                          ) : (
                            <div className="flex justify-end gap-2">
                              <button
                                onClick={() => skip(it)}
                                disabled={isBusy}
                                className="inline-flex items-center gap-1 px-2.5 py-1 text-[11px] font-semibold rounded-lg border border-border hover:bg-accent text-muted-foreground hover:text-foreground disabled:opacity-50"
                                title="Não manda ESTE toque; os próximos seguem"
                              >
                                {isBusy ? <Loader2 size={12} className="animate-spin" /> : <SkipForward size={12} />} Pular
                              </button>
                              <button
                                onClick={() => { setStopFor({ itemId: it.id, leadId: it.lead_id, name: it.lead_name || 'este contato' }); setStopOptOut(false); }}
                                disabled={isBusy}
                                className="inline-flex items-center gap-1 px-2.5 py-1 text-[11px] font-semibold rounded-lg border border-red-500/30 text-red-600 dark:text-red-400 hover:bg-red-500/10 disabled:opacity-50"
                                title="Cancela todos os próximos toques deste contato"
                              >
                                <Ban size={12} /> Parar régua deste contato
                              </button>
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                ))}
              </div>
            )
          ) : (
            !sent || sent.length === 0 ? empty(
              coluna
                ? `Nada enviado em “${REATIVACAO_COLUNA_LABEL[coluna]}” nos últimos 30 dias.`
                : 'Nada enviado nos últimos 30 dias.',
            ) : (
              <div className={`space-y-2 ${listLoading ? 'opacity-60' : ''}`}>
                {sent.map((it) => (
                  <div key={it.id} className="rounded-xl border border-border bg-background/40 p-3 space-y-2">
                    <div className="flex items-start gap-2">
                      <div className="min-w-0 flex-1">
                        {it.conversation_id ? (
                          <button
                            onClick={() => openChat(it.conversation_id)}
                            className="text-sm font-semibold text-foreground hover:text-primary hover:underline truncate max-w-full text-left inline-flex items-center gap-1"
                            title="Abrir a conversa"
                          >
                            {it.lead_name || 'Sem nome'} <MessageCircle size={12} className="shrink-0 opacity-60" />
                          </button>
                        ) : (
                          <span className="text-sm font-semibold text-foreground truncate block">{it.lead_name || 'Sem nome'}</span>
                        )}
                        <div className="text-[11px] text-muted-foreground">
                          {it.lead_phone ? <>{formatPhone(it.lead_phone)} · </> : null}
                          <span className="tabular-nums">{it.sent_at ? fmtQuando(it.sent_at) : 'não enviado'}</span>
                        </div>
                      </div>
                      <div className="flex flex-col items-end gap-1 shrink-0">
                        <ColunaBadge coluna={it.coluna} />
                        <span className="text-[10px] font-semibold text-muted-foreground whitespace-nowrap">toque {it.toque}{it.total_toques ? ` de ${it.total_toques}` : ''}</span>
                      </div>
                    </div>

                    <div className="flex items-center gap-2 flex-wrap">
                      <EntregaIcon item={it} />
                      {it.respondeu && (
                        <span className="inline-flex items-center gap-1 text-[10px] font-semibold px-1.5 py-0.5 rounded bg-emerald-500/15 text-emerald-600 dark:text-emerald-400">
                          <CornerDownLeft size={10} /> respondeu
                        </span>
                      )}
                      {it.motivo && it.status !== 'ENVIADO' && (
                        <span className={`text-[11px] ${it.status === 'FALHOU' ? 'text-red-500' : 'text-muted-foreground'}`}>
                          {motivoLabel(it.motivo)}
                        </span>
                      )}
                    </div>

                    {it.texto && <Baloes texto={it.texto} muted={it.status !== 'ENVIADO'} />}
                  </div>
                ))}
              </div>
            )
          )}
        </div>
      </aside>
    </>
  );
}

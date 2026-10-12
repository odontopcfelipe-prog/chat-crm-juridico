'use client';

// Editor do card geral "Envio da reativação" (régua de reativação de leads, follow-up
// do chip COMERCIAL). Não tem texto — os textos são por coluna/toque, nos cards de
// coluna. Aqui: o TETO diário da clínica (GET/PUT /reactivation/config) e os freios
// anti-bloqueio, só informativos (são fixos no worker, iguais pra todas as clínicas).
// O liga/desliga do ENVIO fica no botão do card, como nos outros disparos.
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Loader2, Save, ShieldCheck, Smartphone, AlertTriangle } from 'lucide-react';
import api from '@/lib/api';
import { showError, showSuccess } from '@/lib/toast';
import { useRole } from '@/lib/useRole';
import {
  REATIVACAO_COLUNAS, REATIVACAO_COLUNA_LABEL, REATIVACAO_INTERVALO_MIN, REATIVACAO_JANELA, REATIVACAO_TETO_PADRAO,
} from '@/lib/reativacao';

interface Summary {
  envio: boolean;
  colunas: Record<string, boolean>;
  teto: number;
  enviados_hoje: number;
  previstos_hoje: number;
  ativos: number;
  respondidos_30d: number;
  chip_comercial: string | null;
}

const TETO_MIN = 1;
const TETO_MAX = 200;

/** Status + mensagem do erro do axios (sem `any`); a do Nest pode vir em array. */
function errInfo(e: unknown): { status?: number; message: string } {
  const r = (e as { response?: { status?: number; data?: { message?: unknown } } } | null)?.response;
  const raw = r?.data?.message;
  return {
    status: r?.status,
    message: Array.isArray(raw) ? raw.join(' · ') : typeof raw === 'string' ? raw : '',
  };
}

export function ReativacaoConfigEditor() {
  const { isAdmin } = useRole();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [teto, setTeto] = useState<string>(String(REATIVACAO_TETO_PADRAO));
  const [summary, setSummary] = useState<Summary | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    // Config é o essencial (o editor); o resumo (chip/colunas/hoje) é só contexto —
    // se falhar, o editor continua funcionando.
    Promise.allSettled([
      api.get<{ teto: number }>('/reactivation/config', { timeout: 15000 }),
      api.get<Summary>('/reactivation/summary', { timeout: 15000 }),
    ]).then(([cfgRes, sumRes]) => {
      if (cancelled) return;
      if (cfgRes.status === 'fulfilled') {
        const t = Number(cfgRes.value.data?.teto);
        setTeto(String(Number.isFinite(t) && t > 0 ? t : REATIVACAO_TETO_PADRAO));
        setLoadError(null);
      } else {
        // 404 aqui = rota inexistente (a API ainda não tem a régua).
        setLoadError(
          errInfo(cfgRes.reason).status === 404
            ? 'A régua de reativação ainda não está disponível neste servidor (a API precisa ser atualizada).'
            : errInfo(cfgRes.reason).message || 'Não foi possível carregar a configuração da régua.',
        );
      }
      if (sumRes.status === 'fulfilled') setSummary(sumRes.value.data);
    }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  const tetoNum = Number(teto);
  const tetoValido = Number.isInteger(tetoNum) && tetoNum >= TETO_MIN && tetoNum <= TETO_MAX;

  const save = async () => {
    if (!tetoValido) {
      showError(`O teto diário precisa ser um número inteiro de ${TETO_MIN} a ${TETO_MAX}.`);
      return;
    }
    setSaving(true);
    try {
      const r = await api.put<{ teto: number }>('/reactivation/config', { teto: tetoNum });
      if (r.data?.teto != null) setTeto(String(r.data.teto));
      showSuccess('Teto diário salvo.');
    } catch (e) {
      showError(errInfo(e).message || 'Não foi possível salvar o teto diário');
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="py-12 flex items-center justify-center text-muted-foreground">
        <Loader2 size={18} className="animate-spin" />
      </div>
    );
  }

  const colunasLigadas = summary
    ? REATIVACAO_COLUNAS.filter((c) => summary.colunas?.[c])
    : [];
  const dias = REATIVACAO_JANELA.dias.length === 6 ? 'segunda a sábado' : 'dias úteis';

  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-lg font-bold text-foreground flex items-center gap-2">
          <ShieldCheck size={18} className="text-pink-600" /> Envio da reativação de leads
        </h2>
        <p className="text-sm text-muted-foreground mt-1">
          Follow-up do <b>chip Comercial</b> pra quem parou de responder no <b>Geral — Leads</b> do CRC. Cada coluna
          tem a sua régua de toques e os seus textos (cards logo abaixo deste, na lista). Como ligar com segurança:
        </p>
        <ol className="text-sm text-muted-foreground mt-2 space-y-1 list-decimal pl-5">
          <li>Ligue as <b>colunas</b> que quer reativar — os contatos parados entram nos <b>Previstos</b> (CRC › botão <b>Disparos</b>), com o texto que sairia. <b>Nada é enviado.</b></li>
          <li>Confira os Previstos por uns dias (dá pra pular um toque ou parar a régua de um contato).</li>
          <li>Ligue o <b>Envio</b> no botão deste card — aí os toques saem de verdade.</li>
        </ol>
      </div>

      {loadError && (
        <div className="flex items-start gap-2 p-3 rounded-xl border border-red-500/30 bg-red-500/10 text-[12px] text-red-700 dark:text-red-300">
          <AlertTriangle size={14} className="shrink-0 mt-0.5" />
          <span>{loadError}</span>
        </div>
      )}

      {/* Estado atual (contexto) — só aparece se o resumo carregou. */}
      {summary && (
        <div className="rounded-xl border border-border p-4 space-y-2 text-[12px]">
          <div className="flex items-center gap-2 flex-wrap">
            <Smartphone size={13} className="text-muted-foreground" />
            {summary.chip_comercial ? (
              <span>Sai pelo chip Comercial <b>{summary.chip_comercial}</b>.</span>
            ) : (
              <span className="font-semibold text-red-600 dark:text-red-400">
                Sem chip Comercial — a régua não envia. Conecte um chip com a função Comercial em Configurações › WhatsApp.
              </span>
            )}
          </div>
          <div className="text-muted-foreground">
            Envio <b className={summary.envio ? 'text-emerald-600 dark:text-emerald-400' : ''}>{summary.envio ? 'LIGADO' : 'desligado'}</b>
            {' · '}
            {colunasLigadas.length > 0
              ? <>colunas ligadas: <b className="text-foreground">{colunasLigadas.map((c) => REATIVACAO_COLUNA_LABEL[c]).join(', ')}</b></>
              : <>nenhuma coluna ligada (ninguém entra na régua)</>}
            {' · '}hoje: <b className="text-foreground">{summary.enviados_hoje}</b> enviados de <b className="text-foreground">{summary.teto}</b>
            {' · '}<b className="text-foreground">{summary.ativos}</b> contatos na régua
          </div>
        </div>
      )}

      <div className="rounded-xl border border-border p-4 space-y-4">
        <div>
          <label className="text-sm font-medium text-foreground" htmlFor="reativacao-teto">Teto diário de mensagens</label>
          <div className="mt-1 flex items-center gap-2">
            <input
              id="reativacao-teto"
              type="number"
              inputMode="numeric"
              min={TETO_MIN}
              max={TETO_MAX}
              step={1}
              value={teto}
              disabled={!isAdmin || !!loadError}
              onChange={(e) => setTeto(e.target.value.replace(/[^\d]/g, ''))}
              className={`block w-28 px-3 py-2 rounded-lg border bg-card text-sm outline-none focus:ring-2 focus:ring-primary/30 disabled:opacity-60 ${tetoValido ? 'border-border' : 'border-red-500'}`}
            />
            <span className="text-[12px] text-muted-foreground">mensagens por dia nesta clínica</span>
          </div>
          <p className="text-[11px] text-muted-foreground mt-1">
            Padrão <b>{REATIVACAO_TETO_PADRAO}</b> (de {TETO_MIN} a {TETO_MAX}). Bateu o teto, o resto fica pro próximo dia útil.
            Comece baixo: chip novo mandando muito pra contato frio é o que mais leva a bloqueio.
          </p>
        </div>

        <div className="p-3 rounded-lg bg-muted/30 border border-border">
          <div className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground mb-1.5">Freios automáticos (fixos)</div>
          <ul className="text-[12px] text-muted-foreground space-y-1 list-disc pl-4">
            <li>Só de <b>{dias}</b>, das <b>{REATIVACAO_JANELA.inicio}h às {REATIVACAO_JANELA.fim}h</b> (horário de Maceió); feriado e dia fechado da clínica não envia.</li>
            <li><b>{REATIVACAO_INTERVALO_MIN.min} a {REATIVACAO_INTERVALO_MIN.max} minutos</b> entre um envio e outro no mesmo chip.</li>
            <li>No máximo <b>1 mensagem por dia</b> pra cada contato (se alguém da equipe já falou com ele, o toque fica pro dia seguinte).</li>
            <li><b>Só pelo chip Comercial</b> — sem ele, não envia (nunca cai pro chip da Clínica).</li>
            <li>Para sozinha quando o contato <b>responde</b>, <b>agenda</b>, <b>vira paciente</b>, <b>pede pra parar</b> ou quando um <b>humano assume</b> a conversa.</li>
            <li>Número sem WhatsApp sai da régua e não volta.</li>
          </ul>
        </div>

        <div className="flex items-center justify-between gap-3 flex-wrap">
          <Link href="/atendimento/crm" className="text-[12px] font-semibold text-primary hover:underline">
            Ver Previstos e Enviados no CRC →
          </Link>
          <button
            type="button"
            onClick={save}
            disabled={saving || !isAdmin || !tetoValido || !!loadError}
            title={!isAdmin ? 'Apenas ADMIN pode alterar' : undefined}
            className="px-5 py-2 rounded-lg bg-primary text-primary-foreground text-sm font-bold inline-flex items-center gap-2 disabled:opacity-50"
          >
            {saving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />} Salvar
          </button>
        </div>
      </div>
    </div>
  );
}

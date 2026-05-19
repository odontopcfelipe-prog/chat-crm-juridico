'use client';

/**
 * ProximosPassosTimeline — Onda 14.24 (Fase 1).
 *
 * Painel "Proximos passos" que aparece dentro do painel inline da proposta
 * aceita (na aba Propostas). Mostra uma timeline de 5 etapas:
 *
 *   1. Plano de tratamento criado   (done — auto)
 *   2. Anamnese e TCLE concluidos   (done — preenchidos)
 *   3. Contrato em assinatura       (sub-timeline: gerado, enviado, aberto,
 *                                     assinado paciente, assinado clinica)
 *   4. Gerar cobranca PIX           (bloqueada ate contrato assinar/pular)
 *   5. Agendar primeira sessao      (bloqueada ate contrato assinar/pular)
 *
 * Fase 1 = transicoes de contrato manuais (operador clica "Marcar enviado",
 * "Marcar paciente assinou", etc). Fase 2 vai trocar por webhooks ClickSign.
 *
 * Atalho "Pular contrato" pra valores baixos (< R$ 500 sugerido) libera
 * cobranca direto sem assinatura.
 */

import { useCallback, useEffect, useState } from 'react';
import {
  Loader2, Check, FileText, Lock, Bolt, Calendar, X, Eye, Send,
  Clock, ArrowRight, FastForward,
} from 'lucide-react';
import api from '@/lib/api';
import { showError, showSuccess } from '@/lib/toast';

interface ContractEvent {
  id: string;
  event_type: string;
  description: string | null;
  occurred_at: string;
  triggered_by_user_id: string | null;
}

interface Contract {
  id: string;
  quote_id: string;
  template_type: string;
  status: 'DRAFT' | 'SENT' | 'OPENED' | 'PATIENT_SIGNED' | 'SIGNED' | 'EXPIRED' | 'CANCELLED';
  skipped: boolean;
  skipped_reason: string | null;
  skipped_at: string | null;
  clicksign_document_id: string | null;
  signing_url: string | null;
  pdf_url: string | null;
  sent_at: string | null;
  opened_at: string | null;
  patient_signed_at: string | null;
  clinic_signed_at: string | null;
  signed_at: string | null;
  expires_at: string | null;
  cancelled_at: string | null;
  cancellation_reason: string | null;
  created_at: string;
  events: ContractEvent[];
}

const TEMPLATE_LABELS: Record<string, string> = {
  ORTODONTIA: 'Contrato + TCLE — Ortodontia',
  IMPLANTE: 'Contrato + TCLE — Implante',
  LENTES: 'Contrato + TCLE — Lentes / Facetas',
  CLINICO_BASICO: 'Contrato + TCLE — Clínico básico',
};

/** Threshold (em R$) abaixo do qual sugerimos pular o contrato.
 *  Espelhado no backend (ContractsService.SKIP_SUGGESTED_BELOW_BRL). */
const SKIP_SUGGESTED_BELOW = 500;

interface Props {
  quoteId: string;
  /** Titulo do orcamento — exibido no header do card. */
  quoteTitle: string;
  /** Valor total da proposta — usado pra decidir se sugerimos pular contrato. */
  quoteTotal: number;
  /** Numero global do orcamento (#NNN). */
  quoteNumberBadge?: string;
  /** Callback pra abrir o fluxo de cobranca (passa controle pro pai). */
  onGenerateBilling?: () => void;
  /** Callback pra abrir o fluxo de agendar (passa controle pro pai). */
  onSchedule?: () => void;
  /** Recarrega tudo apos transicoes. */
  onChange?: () => void | Promise<void>;
}

type StepStatus = 'done' | 'active' | 'next-action' | 'blocked' | 'pending';

interface Step {
  key: string;
  icon: React.ReactNode;
  title: string;
  meta?: string;
  status: StepStatus;
  badge?: { label: string; variant: 'waiting' | 'done' | 'blocked' | 'next' };
  /** Conteudo extra (ex: sub-timeline do contrato) */
  extra?: React.ReactNode;
  /** Acao no canto direito */
  action?: React.ReactNode;
}

export default function ProximosPassosTimeline({
  quoteId,
  quoteTitle,
  quoteTotal,
  quoteNumberBadge,
  onGenerateBilling,
  onSchedule,
  onChange,
}: Props) {
  const [contract, setContract] = useState<Contract | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const { data } = await api.get<Contract | null>(`/quotes/${quoteId}/contract`);
      setContract(data || null);
    } catch (err: unknown) {
      const e = err as { response?: { data?: { message?: string } } };
      showError(e?.response?.data?.message || 'Erro ao carregar contrato');
    } finally {
      setLoading(false);
    }
  }, [quoteId]);

  useEffect(() => { load(); }, [load]);

  // ── Acoes do operador ─────────────────────────────────────────

  const createContract = useCallback(async () => {
    setBusy(true);
    try {
      const { data } = await api.post<Contract>(`/quotes/${quoteId}/contract`, {});
      setContract(data);
      showSuccess('Contrato criado — pronto pra enviar');
      onChange?.();
    } catch (err: unknown) {
      const e = err as { response?: { data?: { message?: string } } };
      showError(e?.response?.data?.message || 'Erro ao criar contrato');
    } finally {
      setBusy(false);
    }
  }, [quoteId, onChange]);

  const transitionContract = useCallback(async (
    action: 'send' | 'mark-opened' | 'sign-patient' | 'sign-clinic' | 'cancel' | 'skip',
    body?: Record<string, unknown>,
  ) => {
    if (!contract) return;
    setBusy(true);
    try {
      const { data } = await api.post<Contract>(`/contracts/${contract.id}/${action}`, body || {});
      setContract(data);
      const labels: Record<string, string> = {
        'send': 'Marcado como enviado',
        'mark-opened': 'Marcado como aberto',
        'sign-patient': 'Paciente marcado como assinado',
        'sign-clinic': 'Clínica marcada como assinada — contrato finalizado',
        'cancel': 'Contrato cancelado',
        'skip': 'Contrato pulado — cobrança liberada',
      };
      showSuccess(labels[action] || 'Atualizado');
      onChange?.();
    } catch (err: unknown) {
      const e = err as { response?: { data?: { message?: string } } };
      showError(e?.response?.data?.message || 'Erro ao atualizar contrato');
    } finally {
      setBusy(false);
    }
  }, [contract, onChange]);

  const askAndCancel = useCallback(() => {
    const reason = window.prompt('Motivo do cancelamento (opcional):') ?? undefined;
    if (reason === undefined) return; // operador cancelou o prompt
    transitionContract('cancel', { reason });
  }, [transitionContract]);

  const askAndSkip = useCallback(() => {
    const ok = window.confirm(
      `Pular contrato pra esta proposta?\n\nA cobrança vai ser liberada sem assinatura.\nValor da proposta: R$ ${quoteTotal.toFixed(2).replace('.', ',')}.\n\nO operador assume o risco (recomendado só pra valores baixos).`,
    );
    if (!ok) return;
    const reason = window.prompt('Justificativa (opcional, fica no audit):') ?? undefined;
    transitionContract('skip', { reason });
  }, [transitionContract, quoteTotal]);

  // ── Construcao das etapas ─────────────────────────────────────
  // Estado do contrato determina as etapas 3, 4 e 5:
  //   - Sem contrato + nao pulado: step 3 = "Decidir contrato"
  //   - Contrato DRAFT: step 3 = "Pronto pra enviar"
  //   - Contrato SENT/OPENED/PATIENT_SIGNED: step 3 = active com sub-timeline
  //   - Contrato SIGNED ou SKIPPED: step 3 = done, step 4 = next-action
  //   - Contrato CANCELLED/EXPIRED: step 3 = error

  const buildSteps = (): Step[] => {
    const contractDoneOrSkipped =
      contract?.status === 'SIGNED' || contract?.skipped === true;

    const steps: Step[] = [
      {
        key: 'plan',
        icon: <Check size={13} />,
        title: 'Plano de tratamento criado',
        meta: 'aberto automaticamente ao aprovar a proposta',
        status: 'done',
      },
      {
        key: 'anamnese',
        icon: <Check size={13} />,
        title: 'Anamnese e TCLE',
        meta: 'preenchidos no atendimento clínico',
        status: 'done',
      },
    ];

    // Step 3 — Contrato (lógica complexa)
    if (!contract) {
      const suggestSkip = quoteTotal < SKIP_SUGGESTED_BELOW;
      steps.push({
        key: 'contract',
        icon: <FileText size={13} />,
        title: 'Contrato de tratamento',
        meta: suggestSkip
          ? `valor baixo (< R$ ${SKIP_SUGGESTED_BELOW}) — você pode pular o contrato`
          : 'crie um contrato pra coletar assinatura do paciente',
        status: 'next-action',
        action: (
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={createContract}
              disabled={busy}
              className="text-xs px-3 py-1.5 rounded-md bg-foreground text-background hover:opacity-90 disabled:opacity-50 inline-flex items-center gap-1.5 font-medium"
            >
              {busy && <Loader2 size={12} className="animate-spin" />}
              <ArrowRight size={12} />
              Criar contrato
            </button>
            {suggestSkip && (
              <button
                type="button"
                onClick={askAndSkip}
                disabled={busy}
                className="text-xs px-2.5 py-1.5 rounded-md border border-border hover:bg-accent disabled:opacity-50 inline-flex items-center gap-1.5"
              >
                <FastForward size={12} />
                Pular
              </button>
            )}
          </div>
        ),
      });
    } else if (contract.skipped) {
      steps.push({
        key: 'contract',
        icon: <FastForward size={13} />,
        title: 'Contrato pulado',
        meta: contract.skipped_reason
          ? `motivo: ${contract.skipped_reason}`
          : 'pulado pelo operador (sem assinatura)',
        status: 'done',
        badge: { label: 'pulado', variant: 'done' },
      });
    } else if (contract.status === 'CANCELLED') {
      steps.push({
        key: 'contract',
        icon: <X size={13} />,
        title: 'Contrato cancelado',
        meta: contract.cancellation_reason || 'cancelado pelo operador',
        status: 'blocked',
        action: (
          <button
            type="button"
            onClick={createContract}
            disabled={busy}
            className="text-xs px-3 py-1.5 rounded-md border border-border hover:bg-accent disabled:opacity-50 inline-flex items-center gap-1.5"
          >
            <ArrowRight size={12} />
            Criar novo
          </button>
        ),
      });
    } else if (contract.status === 'SIGNED') {
      steps.push({
        key: 'contract',
        icon: <Check size={13} />,
        title: 'Contrato assinado',
        meta: `paciente assinou ${formatDateTime(contract.patient_signed_at)} · clínica assinou ${formatDateTime(contract.clinic_signed_at)}`,
        status: 'done',
        badge: { label: 'finalizado', variant: 'done' },
      });
    } else {
      // DRAFT/SENT/OPENED/PATIENT_SIGNED — etapa ativa com sub-timeline
      const statusLabels: Record<string, string> = {
        DRAFT: 'pronto pra enviar',
        SENT: 'aguardando paciente abrir',
        OPENED: 'aberto pelo paciente — aguardando assinatura',
        PATIENT_SIGNED: 'paciente assinou — aguardando clínica',
        EXPIRED: 'expirado',
      };
      steps.push({
        key: 'contract',
        icon: <FileText size={13} />,
        title: 'Contrato em assinatura',
        meta: TEMPLATE_LABELS[contract.template_type] || contract.template_type,
        status: 'active',
        badge: { label: statusLabels[contract.status] || contract.status, variant: 'waiting' },
        extra: <ContractSubTimeline contract={contract} busy={busy} onAction={transitionContract} onCancel={askAndCancel} onSkip={askAndSkip} quoteTotal={quoteTotal} />,
      });
    }

    // Step 4 — Cobrança
    steps.push({
      key: 'billing',
      icon: contractDoneOrSkipped
        ? <Bolt size={13} />
        : <Lock size={13} />,
      title: 'Gerar cobrança',
      meta: contractDoneOrSkipped
        ? 'primeira parcela ou valor à vista — clique pra escolher forma de pagamento'
        : 'bloqueada até o contrato estar assinado ou pulado',
      status: contractDoneOrSkipped ? 'next-action' : 'blocked',
      badge: contractDoneOrSkipped
        ? { label: 'próxima ação', variant: 'next' }
        : { label: 'bloqueada', variant: 'blocked' },
      action: contractDoneOrSkipped && onGenerateBilling ? (
        <button
          type="button"
          onClick={onGenerateBilling}
          className="text-xs px-3 py-1.5 rounded-md bg-foreground text-background hover:opacity-90 inline-flex items-center gap-1.5 font-medium"
        >
          <ArrowRight size={12} />
          Gerar agora
        </button>
      ) : null,
    });

    // Step 5 — Agendar
    steps.push({
      key: 'schedule',
      icon: <Calendar size={13} />,
      title: 'Agendar primeira sessão',
      meta: contractDoneOrSkipped
        ? 'reserve cadeira pra começar o tratamento'
        : 'liberado após contrato',
      status: contractDoneOrSkipped ? 'pending' : 'blocked',
      action: contractDoneOrSkipped && onSchedule ? (
        <button
          type="button"
          onClick={onSchedule}
          className="text-xs px-3 py-1.5 rounded-md border border-border hover:bg-accent inline-flex items-center gap-1.5"
        >
          Agendar
        </button>
      ) : null,
    });

    return steps;
  };

  if (loading) {
    return (
      <div className="bg-card border border-border rounded-xl p-4 flex items-center justify-center text-muted-foreground text-sm">
        <Loader2 size={14} className="animate-spin mr-2" />
        Carregando próximos passos...
      </div>
    );
  }

  const steps = buildSteps();
  const doneCount = steps.filter((s) => s.status === 'done').length;
  const totalCount = steps.length;

  return (
    <div className="bg-card border border-border rounded-xl p-4">
      {/* Header */}
      <div className="flex items-center gap-3 mb-4">
        <div className="w-9 h-9 rounded-full bg-primary/10 text-primary flex items-center justify-center shrink-0">
          <ArrowRight size={18} />
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold truncate">
            Próximos passos{quoteNumberBadge ? ` · ${quoteNumberBadge}` : ''} — {quoteTitle}
          </p>
          <p className="text-xs text-muted-foreground">
            {doneCount} de {totalCount} etapas concluídas
            {contract && !contract.skipped && contract.status !== 'SIGNED' && contract.status !== 'CANCELLED'
              ? ' · gerar cobrança está esperando o contrato'
              : ''}
          </p>
        </div>
      </div>

      {/* Lista de etapas */}
      <div className="flex flex-col gap-2">
        {steps.map((step) => (
          <StepRow key={step.key} step={step} />
        ))}
      </div>
    </div>
  );
}

// ─── Sub-componentes ─────────────────────────────────────────────

function StepRow({ step }: { step: Step }) {
  const bgCls = {
    'done': 'bg-muted/40 opacity-75',
    'active': 'border-sky-500/50 bg-sky-50/50 dark:bg-sky-950/20',
    'next-action': 'border-sky-500/60 bg-sky-50/40 dark:bg-sky-950/20 shadow-[0_0_0_2px_rgba(186,217,239,0.5)]',
    'blocked': 'bg-muted/30 opacity-55',
    'pending': 'bg-card',
  }[step.status];

  const iconBgCls = {
    'done': 'bg-emerald-500/15 text-emerald-700 border-transparent',
    'active': 'bg-sky-500/15 text-sky-700 border-transparent',
    'next-action': 'bg-sky-600 text-white border-transparent',
    'blocked': 'bg-muted text-muted-foreground border-transparent',
    'pending': 'bg-card text-muted-foreground border-border',
  }[step.status];

  return (
    <div className={`flex items-start gap-3 px-3.5 py-3 border border-border rounded-lg ${bgCls}`}>
      <div className={`w-6 h-6 rounded-full border flex items-center justify-center shrink-0 mt-0.5 ${iconBgCls}`}>
        {step.icon}
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-sm font-medium flex items-center gap-2 flex-wrap">
          <span>{step.title}</span>
          {step.badge && <StepBadge {...step.badge} />}
        </div>
        {step.meta && (
          <p className="text-[11px] text-muted-foreground mt-0.5">{step.meta}</p>
        )}
        {step.extra}
      </div>
      {step.action && (
        <div className="shrink-0 flex items-center">{step.action}</div>
      )}
    </div>
  );
}

function StepBadge({ label, variant }: { label: string; variant: 'waiting' | 'done' | 'blocked' | 'next' }) {
  const cls = {
    waiting: 'bg-amber-100 text-amber-800 dark:bg-amber-950/30 dark:text-amber-300',
    done: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950/30 dark:text-emerald-300',
    blocked: 'bg-muted text-muted-foreground',
    next: 'bg-sky-100 text-sky-800 dark:bg-sky-950/30 dark:text-sky-300',
  }[variant];
  const icon = {
    waiting: <Clock size={9} />,
    done: <Check size={9} />,
    blocked: <Lock size={9} />,
    next: <Bolt size={9} />,
  }[variant];
  return (
    <span className={`inline-flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-full font-medium ${cls}`}>
      {icon}
      {label}
    </span>
  );
}

/** Sub-timeline do contrato — mostrada dentro da etapa "Contrato em assinatura". */
function ContractSubTimeline({
  contract,
  busy,
  onAction,
  onCancel,
  onSkip,
  quoteTotal,
}: {
  contract: Contract;
  busy: boolean;
  onAction: (action: 'send' | 'mark-opened' | 'sign-patient' | 'sign-clinic' | 'cancel' | 'skip') => void;
  onCancel: () => void;
  onSkip: () => void;
  quoteTotal: number;
}) {
  // Sub-steps:
  // 1. Documento gerado (sempre done — Contract sempre tem CREATED event)
  // 2. Enviado ao paciente (done se sent_at, active se DRAFT)
  // 3. Paciente abriu (done se opened_at, active se SENT)
  // 4. Paciente assinou (done se patient_signed_at, active se OPENED ou SENT)
  // 5. Clínica assinou (done se clinic_signed_at, active se PATIENT_SIGNED)

  const showSkipShortcut = quoteTotal < SKIP_SUGGESTED_BELOW;

  const subSteps: Array<{
    label: string;
    state: 'done' | 'active' | 'pending';
    when?: string | null;
    action?: React.ReactNode;
  }> = [
    {
      label: 'Documento gerado a partir do template',
      state: 'done',
      when: contract.created_at,
    },
    {
      label: 'Enviado ao paciente',
      state: contract.sent_at ? 'done' : (contract.status === 'DRAFT' ? 'active' : 'pending'),
      when: contract.sent_at,
      action: !contract.sent_at && contract.status === 'DRAFT' ? (
        <button
          type="button"
          onClick={() => onAction('send')}
          disabled={busy}
          className="text-[11px] px-2 py-1 rounded border border-border hover:bg-accent disabled:opacity-50 inline-flex items-center gap-1"
        >
          <Send size={10} /> Marcar enviado
        </button>
      ) : undefined,
    },
    {
      label: 'Paciente abriu o documento',
      state: contract.opened_at ? 'done' : (contract.status === 'SENT' ? 'active' : 'pending'),
      when: contract.opened_at,
      action: !contract.opened_at && contract.status === 'SENT' ? (
        <button
          type="button"
          onClick={() => onAction('mark-opened')}
          disabled={busy}
          className="text-[11px] px-2 py-1 rounded border border-border hover:bg-accent disabled:opacity-50 inline-flex items-center gap-1"
        >
          <Eye size={10} /> Marcar aberto
        </button>
      ) : undefined,
    },
    {
      label: 'Assinatura do paciente',
      state: contract.patient_signed_at ? 'done' : (
        (contract.status === 'SENT' || contract.status === 'OPENED') ? 'active' : 'pending'
      ),
      when: contract.patient_signed_at,
      action: !contract.patient_signed_at && (contract.status === 'SENT' || contract.status === 'OPENED') ? (
        <button
          type="button"
          onClick={() => onAction('sign-patient')}
          disabled={busy}
          className="text-[11px] px-2 py-1 rounded border border-border hover:bg-accent disabled:opacity-50 inline-flex items-center gap-1"
        >
          <Check size={10} /> Marcar assinado
        </button>
      ) : undefined,
    },
    {
      label: 'Assinatura da clínica',
      state: contract.clinic_signed_at ? 'done' : (
        contract.status === 'PATIENT_SIGNED' ? 'active' : 'pending'
      ),
      when: contract.clinic_signed_at,
      action: !contract.clinic_signed_at && contract.status === 'PATIENT_SIGNED' ? (
        <button
          type="button"
          onClick={() => onAction('sign-clinic')}
          disabled={busy}
          className="text-[11px] px-2 py-1 rounded bg-emerald-600 text-white hover:opacity-90 disabled:opacity-50 inline-flex items-center gap-1 font-medium"
        >
          <Check size={10} /> Finalizar
        </button>
      ) : undefined,
    },
  ];

  return (
    <div className="mt-3 p-3 bg-card border border-border rounded-md">
      <div className="text-[11px] text-muted-foreground mb-2 font-medium">
        Etapas da assinatura
      </div>
      <div className="space-y-1.5">
        {subSteps.map((s, i) => (
          <div key={i} className="flex items-center gap-2.5">
            <div className={`w-4 h-4 rounded-full flex items-center justify-center text-[8px] shrink-0 ${
              s.state === 'done'
                ? 'bg-emerald-500/15 text-emerald-700'
                : s.state === 'active'
                ? 'bg-sky-500/15 text-sky-700'
                : 'bg-muted text-muted-foreground border border-border'
            }`}>
              {s.state === 'done' ? <Check size={9} /> : s.state === 'active' ? <Loader2 size={9} className="animate-spin" /> : null}
            </div>
            <span className={`text-xs flex-1 ${s.state === 'pending' ? 'text-muted-foreground' : 'text-foreground'}`}>
              {s.label}
            </span>
            {s.when && (
              <span className="text-[10px] text-muted-foreground">{formatDateTime(s.when)}</span>
            )}
            {s.action && <div className="shrink-0">{s.action}</div>}
          </div>
        ))}
      </div>

      {/* Ações secundárias */}
      <div className="mt-3 pt-3 border-t border-border/60 flex items-center gap-2 flex-wrap">
        {showSkipShortcut && (
          <button
            type="button"
            onClick={onSkip}
            disabled={busy}
            className="text-[11px] px-2 py-1 rounded border border-amber-500/50 text-amber-700 hover:bg-amber-50 dark:hover:bg-amber-950/20 disabled:opacity-50 inline-flex items-center gap-1"
            title={`Pular contrato (valor baixo: R$ ${quoteTotal.toFixed(2).replace('.', ',')})`}
          >
            <FastForward size={10} />
            Pular contrato
          </button>
        )}
        <button
          type="button"
          onClick={onCancel}
          disabled={busy}
          className="text-[11px] px-2 py-1 rounded border border-border hover:bg-accent disabled:opacity-50 inline-flex items-center gap-1"
        >
          <X size={10} />
          Cancelar e refazer
        </button>
      </div>
    </div>
  );
}

// ─── Helpers ─────────────────────────────────────────────────────

function formatDateTime(iso: string | null): string {
  if (!iso) return '';
  try {
    const d = new Date(iso);
    const date = d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });
    const time = d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
    return `${date} às ${time}`;
  } catch {
    return iso;
  }
}

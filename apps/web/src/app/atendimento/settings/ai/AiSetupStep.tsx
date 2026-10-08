'use client';

import { CheckCircle2, CircleDashed } from 'lucide-react';

export type StepStatus = 'done' | 'pending' | 'optional' | 'checking';

export interface AiSetupStepInfo {
  n: number;
  id: string;
  title: string;
  status: StepStatus;
  /** Etapa opcional: não entra na conta de "obrigatórias concluídas". */
  optional?: boolean;
}

const STATUS_LABEL: Record<StepStatus, string> = {
  done: 'Concluída',
  pending: 'Pendente',
  optional: 'Opcional',
  checking: 'Verificando…',
};

function StatusChip({ status }: { status: StepStatus }) {
  const cls =
    status === 'done'
      ? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 border-emerald-500/30'
      : status === 'pending'
        ? 'bg-amber-500/10 text-amber-700 dark:text-amber-400 border-amber-500/30'
        : 'bg-muted text-muted-foreground border-border';
  return (
    <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide ${cls}`}>
      {status === 'done' ? <CheckCircle2 size={11} /> : <CircleDashed size={11} />}
      {STATUS_LABEL[status]}
    </span>
  );
}

/**
 * Uma ETAPA da configuração da IA (Ajustes › IA): número + título + o que fazer
 * nela + situação (concluída/pendente/opcional). O conteúdo (cards) vem como children.
 */
export function AiSetupStep({
  n,
  id,
  title,
  description,
  status,
  children,
}: {
  n: number;
  id: string;
  title: string;
  description: string;
  status: StepStatus;
  children: React.ReactNode;
}) {
  return (
    <section id={id} className="scroll-mt-4 space-y-3">
      <div className="flex flex-wrap items-start gap-3">
        <div className="flex h-9 min-w-9 items-center justify-center rounded-xl bg-primary text-primary-foreground px-2 text-sm font-black shadow-sm shadow-primary/20">
          {n}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-[11px] font-black uppercase tracking-widest text-primary">{n}ª etapa</p>
            <StatusChip status={status} />
          </div>
          <h2 className="text-base font-bold text-foreground leading-tight">{title}</h2>
          <p className="text-[12px] text-muted-foreground mt-0.5 max-w-2xl">{description}</p>
        </div>
      </div>
      <div className="space-y-4 sm:pl-12">{children}</div>
    </section>
  );
}

/** Atalhos pras etapas, no topo da página (rola até a etapa). */
export function AiSetupStepNav({ steps, loading = false }: { steps: AiSetupStepInfo[]; loading?: boolean }) {
  const requiredSteps = steps.filter((s) => !s.optional);
  const done = requiredSteps.filter((s) => s.status === 'done').length;
  const required = requiredSteps.length;
  return (
    <div className="space-y-2">
      <p className="text-[11px] text-muted-foreground">
        {loading ? 'Verificando as etapas…' : `${done} de ${required} etapas obrigatórias concluídas.`} Faça na ordem; depois teste em{' '}
        <b className="text-foreground">Teste sua IA</b>.
      </p>
      <div className="flex gap-2 overflow-x-auto pb-1 custom-scrollbar">
        {steps.map((s) => (
          <button
            key={s.id}
            type="button"
            onClick={() => document.getElementById(s.id)?.scrollIntoView({ behavior: 'smooth', block: 'start' })}
            className={`shrink-0 flex items-center gap-2 rounded-xl border px-3 py-2 text-xs font-semibold transition-colors ${
              !loading && s.status === 'done'
                ? 'border-emerald-500/30 bg-emerald-500/5 text-foreground hover:bg-emerald-500/10'
                : 'border-border bg-card text-foreground hover:bg-muted/40'
            }`}
          >
            <span
              className={`flex h-5 w-5 items-center justify-center rounded-full text-[10px] font-black ${
                !loading && s.status === 'done' ? 'bg-emerald-500 text-white' : 'bg-primary/10 text-primary'
              }`}
            >
              {!loading && s.status === 'done' ? '✓' : s.n}
            </span>
            {s.title}
          </button>
        ))}
      </div>
    </div>
  );
}

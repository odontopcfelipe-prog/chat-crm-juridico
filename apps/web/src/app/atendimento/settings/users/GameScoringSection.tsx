'use client';

/**
 * Out/2026 — "Pontuação do jogo" no cadastro do dentista.
 *
 * O admin define, POR PROFISSIONAL, quanto vale cada atividade no "Meu jogo" e a
 * partir de quantos pontos ele sobe de nível. Campo em branco = padrão da clínica.
 * Salvo em PUT /users/:id/game-scoring (game-rules.ts no backend é a fonte da regra).
 */

import { RotateCcw, Trophy } from 'lucide-react';

export type ScoringPointKey = 'procedimento' | 'atendimento' | 'avaliacao' | 'conversao' | 'missao';
export type ScoringLevelKey = 'prata' | 'ouro' | 'diamante';

export interface ScoringDraft {
  pontos: Record<ScoringPointKey, string>;
  niveis: Record<ScoringLevelKey, string>;
}

// Padrão (espelho de GAME_POINTS / GAME_LEVELS em apps/api/src/commissions/game-rules.ts).
export const SCORING_DEFAULTS = {
  pontos: { procedimento: 10, atendimento: 5, avaliacao: 5, conversao: 20, missao: 50 } as Record<ScoringPointKey, number>,
  niveis: { prata: 500, ouro: 1500, diamante: 3000 } as Record<ScoringLevelKey, number>,
};

export const EMPTY_SCORING: ScoringDraft = {
  pontos: { procedimento: '', atendimento: '', avaliacao: '', conversao: '', missao: '' },
  niveis: { prata: '', ouro: '', diamante: '' },
};

const POINT_ROWS: { key: ScoringPointKey; label: string; desc: string }[] = [
  { key: 'procedimento', label: 'Procedimento executado', desc: 'Cada item do plano que ele marca como feito' },
  { key: 'atendimento', label: 'Atendimento confirmado', desc: 'Cada consulta dele que ele confirma' },
  { key: 'avaliacao', label: 'Avaliação montada', desc: 'Cada orçamento que ele monta na Avaliação' },
  { key: 'conversao', label: 'Avaliação que virou tratamento', desc: 'Cada orçamento dele aceito pelo paciente' },
  { key: 'missao', label: 'Missão da semana cumprida', desc: 'Cada missão batida na semana' },
];

const LEVEL_ROWS: { key: ScoringLevelKey; label: string }[] = [
  { key: 'prata', label: '🥈 Prata a partir de' },
  { key: 'ouro', label: '🥇 Ouro a partir de' },
  { key: 'diamante', label: '💎 Diamante a partir de' },
];

/** Converte o override salvo (GET) no rascunho do formulário. */
export function overrideToDraft(ov: any): ScoringDraft {
  const d: ScoringDraft = { pontos: { ...EMPTY_SCORING.pontos }, niveis: { ...EMPTY_SCORING.niveis } };
  for (const r of POINT_ROWS) if (ov?.pontos?.[r.key] != null) d.pontos[r.key] = String(ov.pontos[r.key]);
  for (const r of LEVEL_ROWS) if (ov?.niveis?.[r.key] != null) d.niveis[r.key] = String(ov.niveis[r.key]);
  return d;
}

/** Corpo do PUT (vazio = padrão). */
export function draftToBody(d: ScoringDraft) {
  const pick = (v: string) => (v.trim() === '' ? null : Number(v));
  return {
    pontos: Object.fromEntries(POINT_ROWS.map((r) => [r.key, pick(d.pontos[r.key])])),
    niveis: Object.fromEntries(LEVEL_ROWS.map((r) => [r.key, pick(d.niveis[r.key])])),
  };
}

/** Mesma validação do backend, pra avisar ANTES de salvar o usuário. */
export function validateDraft(d: ScoringDraft): string | null {
  for (const r of POINT_ROWS) {
    const v = d.pontos[r.key].trim();
    if (v === '') continue;
    const n = Number(v);
    if (!Number.isInteger(n) || n < 0 || n > 1000) return `${r.label}: use um número inteiro de 0 a 1.000`;
  }
  const lv = (k: ScoringLevelKey) => {
    const v = d.niveis[k].trim();
    return v === '' ? SCORING_DEFAULTS.niveis[k] : Number(v);
  };
  for (const r of LEVEL_ROWS) {
    const v = d.niveis[r.key].trim();
    if (v === '') continue;
    const n = Number(v);
    if (!Number.isInteger(n) || n < 1) return `Nível ${r.key[0].toUpperCase()}${r.key.slice(1)}: use um número inteiro maior que zero`;
  }
  if (!(lv('prata') < lv('ouro') && lv('ouro') < lv('diamante'))) {
    return 'Os níveis precisam subir: Prata < Ouro < Diamante';
  }
  return null;
}

export function draftIsEmpty(d: ScoringDraft): boolean {
  return [...Object.values(d.pontos), ...Object.values(d.niveis)].every((v) => v.trim() === '');
}

export function GameScoringSection({ value, onChange }: { value: ScoringDraft; onChange: (d: ScoringDraft) => void }) {
  const inputCls =
    'w-20 px-2.5 py-2 border border-border rounded-lg bg-background text-foreground text-sm tabular-nums text-right focus:ring-2 focus:ring-primary/20 focus:border-primary outline-none placeholder:text-muted-foreground/50';
  const personalizado = !draftIsEmpty(value);
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2 ml-1">
        <label className="text-[12px] font-bold text-muted-foreground uppercase tracking-wider flex items-center gap-1.5">
          <Trophy size={13} className="text-amber-500" /> Pontuação do jogo
          <span className="font-medium normal-case tracking-normal opacity-60">· deste profissional</span>
        </label>
        {personalizado && (
          <button
            type="button"
            onClick={() => onChange({ pontos: { ...EMPTY_SCORING.pontos }, niveis: { ...EMPTY_SCORING.niveis } })}
            className="text-[11px] font-semibold text-primary hover:underline inline-flex items-center gap-1"
          >
            <RotateCcw size={11} /> Restaurar padrão
          </button>
        )}
      </div>
      <div className="space-y-2.5 p-3 rounded-xl border border-border bg-background/40">
        {POINT_ROWS.map((r) => (
          <div key={r.key} className="flex items-center gap-2">
            <div className="flex-1 min-w-0">
              <p className="text-[12px] font-semibold text-foreground">{r.label}</p>
              <p className="text-[10px] text-muted-foreground">{r.desc}</p>
            </div>
            <input
              type="number" min="0" max="1000" step="1" inputMode="numeric"
              value={value.pontos[r.key]}
              onChange={(e) => onChange({ ...value, pontos: { ...value.pontos, [r.key]: e.target.value } })}
              placeholder={String(SCORING_DEFAULTS.pontos[r.key])}
              className={inputCls}
              aria-label={`${r.label} (pontos)`}
            />
            <span className="w-6 text-[11px] text-muted-foreground">pts</span>
          </div>
        ))}
        <div className="pt-2 border-t border-border/60">
          <p className="text-[11px] font-semibold text-muted-foreground mb-1.5">Níveis (pontos no mês)</p>
          <div className="space-y-2">
            {LEVEL_ROWS.map((r) => (
              <div key={r.key} className="flex items-center gap-2">
                <p className="flex-1 text-[12px] font-semibold text-foreground">{r.label}</p>
                <input
                  type="number" min="1" step="1" inputMode="numeric"
                  value={value.niveis[r.key]}
                  onChange={(e) => onChange({ ...value, niveis: { ...value.niveis, [r.key]: e.target.value } })}
                  placeholder={String(SCORING_DEFAULTS.niveis[r.key])}
                  className={inputCls}
                  aria-label={r.label}
                />
                <span className="w-6 text-[11px] text-muted-foreground">pts</span>
              </div>
            ))}
          </div>
        </div>
      </div>
      <p className="text-[10px] text-muted-foreground opacity-70 ml-1 leading-snug">
        Em branco = padrão (o número cinza). É o que o profissional vê em <b>Meu jogo</b>, sempre em pontos, nunca em R$.
        A pontuação zera todo mês.
      </p>
    </div>
  );
}

'use client';

import { useState } from 'react';
import { Loader2, Save, X } from 'lucide-react';

export type QuestionType = 'text' | 'textarea' | 'number' | 'boolean' | 'select' | 'multiselect';

export interface Question {
  id: string;
  type: QuestionType;
  label: string;
  required?: boolean;
  options?: string[];
}

export interface Section {
  id: string;
  title: string;
  questions: Question[];
}

export interface AnamnesisSchema {
  sections: Section[];
}

interface Props {
  schema: AnamnesisSchema;
  initialAnswers?: Record<string, any>;
  readOnly?: boolean;
  onSave?: (answers: Record<string, any>) => Promise<void> | void;
  onCancel?: () => void;
  saving?: boolean;
}

export default function DynamicAnamneseForm({
  schema, initialAnswers = {}, readOnly = false, onSave, onCancel, saving,
}: Props) {
  const [answers, setAnswers] = useState<Record<string, any>>(initialAnswers);
  const [error, setError] = useState<string | null>(null);

  const setAnswer = (qid: string, value: any) => {
    setAnswers((prev) => ({ ...prev, [qid]: value }));
    setError(null);
  };

  const validate = () => {
    for (const section of schema.sections) {
      for (const q of section.questions) {
        if (!q.required) continue;
        const v = answers[q.id];
        if (v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0)) {
          setError(`Campo obrigatório vazio: ${section.title} → ${q.label}`);
          return false;
        }
      }
    }
    return true;
  };

  const submit = async () => {
    if (readOnly || !onSave) return;
    if (!validate()) return;
    await onSave(answers);
  };

  return (
    <div className="space-y-4">
      {error && (
        <div className="bg-destructive/10 border border-destructive/20 text-destructive rounded-lg px-4 py-2 text-sm">
          {error}
        </div>
      )}

      {schema.sections.map((section) => (
        <div key={section.id} className="bg-card border border-border rounded-xl p-4">
          <h3 className="font-semibold text-foreground mb-3">{section.title}</h3>
          <div className="space-y-3">
            {section.questions.map((q) => (
              <QuestionField
                key={q.id}
                question={q}
                value={answers[q.id]}
                onChange={(v) => setAnswer(q.id, v)}
                readOnly={readOnly}
              />
            ))}
          </div>
        </div>
      ))}

      {!readOnly && onSave && (
        <div className="flex justify-end gap-2 pt-2">
          {onCancel && (
            <button
              type="button"
              onClick={onCancel}
              disabled={saving}
              className="px-4 py-2 rounded-lg border border-border text-sm font-medium hover:bg-accent disabled:opacity-50 flex items-center gap-2"
            >
              <X size={14} /> Cancelar
            </button>
          )}
          <button
            type="button"
            onClick={submit}
            disabled={saving}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 disabled:opacity-50"
          >
            {saving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
            Salvar anamnese
          </button>
        </div>
      )}
    </div>
  );
}

function QuestionField({
  question, value, onChange, readOnly,
}: {
  question: Question;
  value: any;
  onChange: (v: any) => void;
  readOnly?: boolean;
}) {
  const commonInputCls =
    'w-full px-3 py-2 rounded-lg bg-background border border-border text-sm focus:outline-none focus:ring-2 focus:ring-primary/30 disabled:opacity-60';

  const label = (
    <label className="block text-xs font-medium text-foreground mb-1">
      {question.label}
      {question.required && <span className="text-destructive ml-1">*</span>}
    </label>
  );

  switch (question.type) {
    case 'text':
      return (
        <div>
          {label}
          <input
            type="text"
            value={value ?? ''}
            onChange={(e) => onChange(e.target.value)}
            disabled={readOnly}
            className={commonInputCls}
          />
        </div>
      );
    case 'number':
      return (
        <div>
          {label}
          <input
            type="number"
            value={value ?? ''}
            onChange={(e) => {
              const n = e.target.value === '' ? null : Number(e.target.value);
              onChange(n);
            }}
            disabled={readOnly}
            className={commonInputCls}
          />
        </div>
      );
    case 'textarea':
      return (
        <div>
          {label}
          <textarea
            value={value ?? ''}
            onChange={(e) => onChange(e.target.value)}
            disabled={readOnly}
            rows={3}
            className={`${commonInputCls} resize-y`}
          />
        </div>
      );
    case 'boolean':
      return (
        <div className="flex items-center justify-between gap-3 py-1">
          <span className="text-sm text-foreground">
            {question.label}
            {question.required && <span className="text-destructive ml-1">*</span>}
          </span>
          <div className="flex gap-1 shrink-0">
            {[
              { v: true, label: 'Sim' },
              { v: false, label: 'Não' },
            ].map((opt) => (
              <button
                key={opt.label}
                type="button"
                disabled={readOnly}
                onClick={() => onChange(opt.v)}
                className={`px-3 py-1 rounded-md text-xs font-medium transition-colors ${
                  value === opt.v
                    ? 'bg-primary text-primary-foreground'
                    : 'bg-background border border-border text-muted-foreground hover:bg-accent'
                } disabled:opacity-60`}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </div>
      );
    case 'select':
      return (
        <div>
          {label}
          <select
            value={value ?? ''}
            onChange={(e) => onChange(e.target.value || null)}
            disabled={readOnly}
            className={commonInputCls}
          >
            <option value="">—</option>
            {question.options?.map((opt) => (
              <option key={opt} value={opt}>{opt}</option>
            ))}
          </select>
        </div>
      );
    case 'multiselect':
      const arr: string[] = Array.isArray(value) ? value : [];
      return (
        <div>
          {label}
          <div className="flex flex-wrap gap-1.5">
            {question.options?.map((opt) => {
              const selected = arr.includes(opt);
              return (
                <button
                  key={opt}
                  type="button"
                  disabled={readOnly}
                  onClick={() => {
                    if (selected) onChange(arr.filter((x) => x !== opt));
                    else onChange([...arr, opt]);
                  }}
                  className={`px-3 py-1 rounded-full text-xs font-medium border transition-colors ${
                    selected
                      ? 'bg-primary/10 text-primary border-primary/30'
                      : 'bg-background border-border text-muted-foreground hover:bg-accent'
                  } disabled:opacity-60`}
                >
                  {opt}
                </button>
              );
            })}
          </div>
        </div>
      );
    default:
      return null;
  }
}

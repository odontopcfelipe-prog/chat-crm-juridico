'use client';

import { useEffect, useState, useCallback } from 'react';
import {
  Loader2, Stethoscope, Plus, Save, CheckSquare, Lock, User, Calendar, MessageSquare,
  Edit3, ArrowLeft, X,
} from 'lucide-react';
import api from '@/lib/api';
import { showError, showSuccess } from '@/lib/toast';

interface Props {
  patientId: string;
}

interface ClinicalNote {
  id: string;
  subjective: string | null;
  objective: string | null;
  assessment: string | null;
  plan: string | null;
  is_finalized: boolean;
  finalized_at: string | null;
  addendum: string | null;
  addendum_at: string | null;
  created_at: string;
  author: { id: string; name: string } | null;
  appointment: { id: string; start_at: string; title: string } | null;
}

interface MedicalRecord {
  id: string;
  chief_complaint: string | null;
  history: string | null;
  opened_at: string;
  closed_at: string | null;
}

type Mode = 'list' | 'new' | 'edit' | 'addendum';

export default function ProntuarioTab({ patientId }: Props) {
  const [record, setRecord] = useState<MedicalRecord | null>(null);
  const [notes, setNotes] = useState<ClinicalNote[]>([]);
  const [mode, setMode] = useState<Mode>('list');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  // Form state
  const [subjective, setSubjective] = useState('');
  const [objective, setObjective] = useState('');
  const [assessment, setAssessment] = useState('');
  const [plan, setPlan] = useState('');
  const [addendumText, setAddendumText] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [mr, notesRes] = await Promise.all([
        api.get<MedicalRecord>(`/patients/${patientId}/medical-record`),
        api.get<ClinicalNote[]>(`/patients/${patientId}/clinical-notes`),
      ]);
      setRecord(mr.data);
      setNotes(notesRes.data);
    } catch (err: any) {
      showError(err?.response?.data?.message || 'Erro ao carregar prontuário');
    } finally {
      setLoading(false);
    }
  }, [patientId]);

  useEffect(() => {
    load();
  }, [load]);

  const resetForm = () => {
    setSubjective('');
    setObjective('');
    setAssessment('');
    setPlan('');
    setAddendumText('');
    setEditingId(null);
  };

  const startNew = () => {
    resetForm();
    setMode('new');
  };

  const startEdit = (n: ClinicalNote) => {
    setSubjective(n.subjective || '');
    setObjective(n.objective || '');
    setAssessment(n.assessment || '');
    setPlan(n.plan || '');
    setEditingId(n.id);
    setMode('edit');
  };

  const startAddendum = (n: ClinicalNote) => {
    setAddendumText('');
    setEditingId(n.id);
    setMode('addendum');
  };

  const saveNew = async () => {
    if (!subjective && !objective && !assessment && !plan) {
      showError('Preencha pelo menos um campo do SOAP');
      return;
    }
    setSaving(true);
    try {
      await api.post(`/patients/${patientId}/clinical-notes`, {
        subjective: subjective || undefined,
        objective: objective || undefined,
        assessment: assessment || undefined,
        plan: plan || undefined,
      });
      showSuccess('Nota clínica criada');
      resetForm();
      setMode('list');
      await load();
    } catch (err: any) {
      showError(err?.response?.data?.message || 'Erro ao salvar');
    } finally {
      setSaving(false);
    }
  };

  const saveEdit = async () => {
    if (!editingId) return;
    setSaving(true);
    try {
      await api.patch(`/clinical-notes/${editingId}`, {
        subjective: subjective || undefined,
        objective: objective || undefined,
        assessment: assessment || undefined,
        plan: plan || undefined,
      });
      showSuccess('Nota atualizada');
      resetForm();
      setMode('list');
      await load();
    } catch (err: any) {
      showError(err?.response?.data?.message || 'Erro ao atualizar');
    } finally {
      setSaving(false);
    }
  };

  const finalize = async (id: string) => {
    if (!confirm('Finalizar esta nota? Após finalizar, só será possível adicionar addendum.')) return;
    try {
      await api.post(`/clinical-notes/${id}/finalize`);
      showSuccess('Nota finalizada');
      await load();
    } catch (err: any) {
      showError(err?.response?.data?.message || 'Erro ao finalizar');
    }
  };

  const saveAddendum = async () => {
    if (!editingId || !addendumText.trim()) {
      showError('Escreva o addendum antes de salvar');
      return;
    }
    setSaving(true);
    try {
      await api.post(`/clinical-notes/${editingId}/addendum`, { addendum: addendumText.trim() });
      showSuccess('Addendum adicionado');
      resetForm();
      setMode('list');
      await load();
    } catch (err: any) {
      showError(err?.response?.data?.message || 'Erro ao adicionar addendum');
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="py-12 flex items-center justify-center text-muted-foreground">
        <Loader2 size={18} className="animate-spin mr-2" /> Carregando prontuário...
      </div>
    );
  }

  // ─── Novo / Editar ────────────────────────────────────────────
  if (mode === 'new' || mode === 'edit') {
    return (
      <div>
        <button
          onClick={() => { resetForm(); setMode('list'); }}
          className="text-sm text-muted-foreground hover:text-foreground flex items-center gap-1 mb-3"
        >
          <ArrowLeft size={14} /> Voltar
        </button>

        <div className="bg-card border border-border rounded-xl p-4 space-y-3">
          <h3 className="font-semibold text-foreground">
            {mode === 'new' ? 'Nova nota clínica (SOAP)' : 'Editar nota'}
          </h3>

          <SOAPField label="S (Subjetivo) — relato do paciente" value={subjective} onChange={setSubjective} />
          <SOAPField label="O (Objetivo) — exame clínico" value={objective} onChange={setObjective} />
          <SOAPField label="A (Avaliação) — diagnóstico" value={assessment} onChange={setAssessment} />
          <SOAPField label="P (Plano) — conduta" value={plan} onChange={setPlan} />

          <div className="flex justify-end gap-2 pt-2">
            <button
              onClick={() => { resetForm(); setMode('list'); }}
              disabled={saving}
              className="px-4 py-2 rounded-lg border border-border text-sm font-medium hover:bg-accent disabled:opacity-50"
            >
              Cancelar
            </button>
            <button
              onClick={mode === 'new' ? saveNew : saveEdit}
              disabled={saving}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 disabled:opacity-50"
            >
              {saving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
              Salvar
            </button>
          </div>
        </div>
      </div>
    );
  }

  // ─── Addendum ─────────────────────────────────────────────────
  if (mode === 'addendum') {
    const note = notes.find((n) => n.id === editingId);
    return (
      <div>
        <button
          onClick={() => { resetForm(); setMode('list'); }}
          className="text-sm text-muted-foreground hover:text-foreground flex items-center gap-1 mb-3"
        >
          <ArrowLeft size={14} /> Voltar
        </button>

        <div className="bg-card border border-border rounded-xl p-4 space-y-3">
          <h3 className="font-semibold text-foreground">Adicionar addendum</h3>
          <p className="text-xs text-muted-foreground">
            A nota original foi finalizada em{' '}
            {note?.finalized_at ? new Date(note.finalized_at).toLocaleString('pt-BR') : 'N/A'}
            . Este texto será anexado à nota preservando o conteúdo original.
          </p>
          <textarea
            value={addendumText}
            onChange={(e) => setAddendumText(e.target.value)}
            rows={5}
            placeholder="Escreva aqui a correção ou observação complementar..."
            className="w-full px-3 py-2 rounded-lg bg-background border border-border text-sm focus:outline-none focus:ring-2 focus:ring-primary/30 resize-y"
          />
          <div className="flex justify-end gap-2">
            <button
              onClick={() => { resetForm(); setMode('list'); }}
              disabled={saving}
              className="px-4 py-2 rounded-lg border border-border text-sm font-medium hover:bg-accent disabled:opacity-50"
            >
              Cancelar
            </button>
            <button
              onClick={saveAddendum}
              disabled={saving}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 disabled:opacity-50"
            >
              {saving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
              Adicionar addendum
            </button>
          </div>
        </div>
      </div>
    );
  }

  // ─── Lista (default) ──────────────────────────────────────────
  return (
    <div>
      {/* Cabeçalho do MedicalRecord */}
      {record && (
        <div className="bg-card border border-border rounded-xl p-4 mb-4">
          <h3 className="font-semibold text-sm text-foreground mb-2 flex items-center gap-2">
            <Stethoscope size={16} /> Prontuário
          </h3>
          <dl className="grid grid-cols-1 md:grid-cols-2 gap-x-4 gap-y-1 text-sm">
            <div>
              <dt className="text-xs text-muted-foreground">Queixa principal</dt>
              <dd className="text-foreground">{record.chief_complaint || <span className="text-muted-foreground">—</span>}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">Histórico</dt>
              <dd className="text-foreground">{record.history || <span className="text-muted-foreground">—</span>}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">Aberto em</dt>
              <dd className="text-foreground">{new Date(record.opened_at).toLocaleDateString('pt-BR')}</dd>
            </div>
            {record.closed_at && (
              <div>
                <dt className="text-xs text-muted-foreground">Fechado em</dt>
                <dd className="text-foreground">{new Date(record.closed_at).toLocaleDateString('pt-BR')}</dd>
              </div>
            )}
          </dl>
        </div>
      )}

      <div className="flex items-center justify-between mb-3">
        <p className="text-sm text-muted-foreground">{notes.length} nota(s) clínica(s)</p>
        <button
          onClick={startNew}
          className="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90"
        >
          <Plus size={14} /> Nova nota
        </button>
      </div>

      {notes.length === 0 ? (
        <div className="bg-card border border-border border-dashed rounded-xl p-8 text-center">
          <MessageSquare size={32} className="mx-auto text-muted-foreground mb-2" />
          <p className="text-muted-foreground text-sm">Nenhuma nota clínica ainda.</p>
          <p className="text-xs text-muted-foreground mt-1">
            Clique em "Nova nota" para registrar o primeiro atendimento.
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {notes.map((n) => (
            <article key={n.id} className="bg-card border border-border rounded-xl p-4">
              <header className="flex items-start justify-between gap-3 mb-3 pb-3 border-b border-border">
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <span className="flex items-center gap-1"><User size={12} /> {n.author?.name || '—'}</span>
                  <span>·</span>
                  <span className="flex items-center gap-1"><Calendar size={12} /> {new Date(n.created_at).toLocaleString('pt-BR')}</span>
                </div>
                <div className="flex items-center gap-1">
                  {n.is_finalized ? (
                    <span className="text-xs px-2 py-0.5 rounded-full bg-emerald-500/10 text-emerald-600 border border-emerald-500/20 flex items-center gap-1">
                      <Lock size={10} /> Finalizada
                    </span>
                  ) : (
                    <>
                      <button
                        onClick={() => startEdit(n)}
                        className="text-xs text-primary hover:bg-primary/10 px-2 py-1 rounded flex items-center gap-1"
                      >
                        <Edit3 size={12} /> Editar
                      </button>
                      <button
                        onClick={() => finalize(n.id)}
                        className="text-xs text-foreground hover:bg-accent px-2 py-1 rounded flex items-center gap-1"
                      >
                        <CheckSquare size={12} /> Finalizar
                      </button>
                    </>
                  )}
                  {n.is_finalized && (
                    <button
                      onClick={() => startAddendum(n)}
                      className="text-xs text-primary hover:bg-primary/10 px-2 py-1 rounded flex items-center gap-1"
                    >
                      <Plus size={12} /> Addendum
                    </button>
                  )}
                </div>
              </header>

              <div className="space-y-2 text-sm">
                {n.subjective && <SOAPLine label="S" value={n.subjective} />}
                {n.objective && <SOAPLine label="O" value={n.objective} />}
                {n.assessment && <SOAPLine label="A" value={n.assessment} />}
                {n.plan && <SOAPLine label="P" value={n.plan} />}
              </div>

              {n.addendum && (
                <div className="mt-3 pt-3 border-t border-dashed border-border">
                  <p className="text-xs font-semibold text-amber-600 mb-1">
                    Addendum{n.addendum_at && ` — ${new Date(n.addendum_at).toLocaleString('pt-BR')}`}
                  </p>
                  <p className="text-sm text-foreground whitespace-pre-wrap">{n.addendum}</p>
                </div>
              )}
            </article>
          ))}
        </div>
      )}
    </div>
  );
}

function SOAPField({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <div>
      <label className="block text-xs font-medium text-foreground mb-1">{label}</label>
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        rows={2}
        className="w-full px-3 py-2 rounded-lg bg-background border border-border text-sm focus:outline-none focus:ring-2 focus:ring-primary/30 resize-y"
      />
    </div>
  );
}

function SOAPLine({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex gap-2">
      <span className="font-bold text-primary text-xs shrink-0 w-5 pt-0.5">{label}</span>
      <span className="text-foreground whitespace-pre-wrap flex-1">{value}</span>
    </div>
  );
}

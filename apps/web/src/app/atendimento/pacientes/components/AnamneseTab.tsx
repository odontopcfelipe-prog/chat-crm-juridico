'use client';

import { useEffect, useState, useCallback } from 'react';
import { Loader2, FileText, Plus, ArrowLeft, Edit3, CheckCircle2 } from 'lucide-react';
import api from '@/lib/api';
import { showError, showSuccess } from '@/lib/toast';
import DynamicAnamneseForm, { AnamnesisSchema } from './DynamicAnamneseForm';

interface Props {
  patientId: string;
}

interface AnamneseListItem {
  id: string;
  filled_at: string;
  filled_by_user_id: string | null;
  template: { id: string; version: number };
}

interface AnamneseDetail {
  id: string;
  filled_at: string;
  answers: Record<string, any>;
  template_schema: AnamnesisSchema;
  template: { id: string; version: number };
}

interface Template {
  id: string;
  version: number;
  schema: AnamnesisSchema;
}

type Mode = 'list' | 'new' | 'view' | 'edit';

export default function AnamneseTab({ patientId }: Props) {
  const [list, setList] = useState<AnamneseListItem[]>([]);
  const [activeTemplate, setActiveTemplate] = useState<Template | null>(null);
  const [current, setCurrent] = useState<AnamneseDetail | null>(null);
  const [mode, setMode] = useState<Mode>('list');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const loadList = useCallback(async () => {
    setLoading(true);
    try {
      const { data } = await api.get<AnamneseListItem[]>(`/patients/${patientId}/anamneses`);
      setList(data);
    } catch (err: any) {
      showError(err?.response?.data?.message || 'Erro ao carregar anamneses');
    } finally {
      setLoading(false);
    }
  }, [patientId]);

  useEffect(() => {
    loadList();
  }, [loadList]);

  const handleNew = async () => {
    try {
      const { data } = await api.get<Template>('/anamnesis-templates/active');
      setActiveTemplate(data);
      setMode('new');
    } catch (err: any) {
      showError(err?.response?.data?.message || 'Nenhum template ativo. Admin precisa cadastrar.');
    }
  };

  const handleView = async (id: string) => {
    try {
      const { data } = await api.get<AnamneseDetail>(`/anamneses/${id}`);
      setCurrent(data);
      setMode('view');
    } catch (err: any) {
      showError(err?.response?.data?.message || 'Erro ao carregar anamnese');
    }
  };

  const handleSaveNew = async (answers: Record<string, any>) => {
    setSaving(true);
    try {
      await api.post(`/patients/${patientId}/anamneses`, { answers });
      showSuccess('Anamnese salva');
      setMode('list');
      await loadList();
    } catch (err: any) {
      showError(err?.response?.data?.message || 'Erro ao salvar');
    } finally {
      setSaving(false);
    }
  };

  const handleSaveEdit = async (answers: Record<string, any>) => {
    if (!current) return;
    setSaving(true);
    try {
      await api.patch(`/anamneses/${current.id}`, { answers });
      showSuccess('Anamnese atualizada');
      setMode('list');
      setCurrent(null);
      await loadList();
    } catch (err: any) {
      showError(err?.response?.data?.message || 'Erro ao salvar');
    } finally {
      setSaving(false);
    }
  };

  // ─── Modos: new ───────────────────────────────────────────────
  if (mode === 'new' && activeTemplate) {
    return (
      <div>
        <div className="flex items-center justify-between mb-3">
          <button
            onClick={() => setMode('list')}
            className="text-sm text-muted-foreground hover:text-foreground flex items-center gap-1"
          >
            <ArrowLeft size={14} /> Voltar
          </button>
          <span className="text-xs text-muted-foreground">
            Template v{activeTemplate.version}
          </span>
        </div>
        <DynamicAnamneseForm
          schema={activeTemplate.schema}
          onSave={handleSaveNew}
          onCancel={() => setMode('list')}
          saving={saving}
        />
      </div>
    );
  }

  // ─── Modos: view / edit ───────────────────────────────────────
  if ((mode === 'view' || mode === 'edit') && current) {
    return (
      <div>
        <div className="flex items-center justify-between mb-3">
          <button
            onClick={() => {
              setMode('list');
              setCurrent(null);
            }}
            className="text-sm text-muted-foreground hover:text-foreground flex items-center gap-1"
          >
            <ArrowLeft size={14} /> Voltar
          </button>
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground">
              Preenchido em {new Date(current.filled_at).toLocaleString('pt-BR')} · Template v{current.template.version}
            </span>
            {mode === 'view' && (
              <button
                onClick={() => setMode('edit')}
                className="text-xs text-primary hover:bg-primary/10 px-2 py-1 rounded flex items-center gap-1"
              >
                <Edit3 size={12} /> Editar
              </button>
            )}
          </div>
        </div>
        <DynamicAnamneseForm
          schema={current.template_schema}
          initialAnswers={current.answers}
          readOnly={mode === 'view'}
          onSave={mode === 'edit' ? handleSaveEdit : undefined}
          onCancel={mode === 'edit' ? () => setMode('view') : undefined}
          saving={saving}
        />
      </div>
    );
  }

  // ─── Modo list (default) ──────────────────────────────────────
  return (
    <div>
      <div className="flex items-center justify-between mb-3">
        <p className="text-sm text-muted-foreground">
          {list.length} anamnese(s) registrada(s)
        </p>
        <button
          onClick={handleNew}
          className="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90"
        >
          <Plus size={14} /> Nova anamnese
        </button>
      </div>

      {loading ? (
        <div className="py-12 flex items-center justify-center text-muted-foreground">
          <Loader2 size={18} className="animate-spin mr-2" /> Carregando...
        </div>
      ) : list.length === 0 ? (
        <div className="bg-card border border-border border-dashed rounded-xl p-8 text-center">
          <FileText size={32} className="mx-auto text-muted-foreground mb-2" />
          <p className="text-muted-foreground text-sm">Nenhuma anamnese preenchida ainda.</p>
          <p className="text-xs text-muted-foreground mt-1">
            Clique em "Nova anamnese" para começar a primeira ficha.
          </p>
        </div>
      ) : (
        <ul className="bg-card border border-border rounded-xl divide-y divide-border">
          {list.map((a) => (
            <li
              key={a.id}
              onClick={() => handleView(a.id)}
              className="px-4 py-3 hover:bg-accent/40 cursor-pointer flex items-center gap-3"
            >
              <CheckCircle2 size={18} className="text-primary shrink-0" />
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-foreground">
                  Anamnese preenchida
                </p>
                <p className="text-xs text-muted-foreground">
                  {new Date(a.filled_at).toLocaleString('pt-BR')} · Template v{a.template.version}
                </p>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

'use client';

/**
 * Settings → Modelos de Orçamento (Fase 24 — Onda 2).
 *
 * Admin cria templates pré-prontos por especialidade. Operador na ficha
 * do paciente clica "Usar modelo" → puxa todos os procedimentos de uma vez.
 */
import { useEffect, useState, FormEvent } from 'react';
import {
  FileStack, Loader2, Plus, Pencil, Trash2, X, Save, ChevronDown, ChevronUp,
} from 'lucide-react';
import api from '@/lib/api';
import { showError, showSuccess } from '@/lib/toast';

interface Procedure {
  id: string;
  name: string;
  base_price: string | number;
  code_tuss: string | null;
}

interface TemplateItem {
  id: string;
  procedure_id: string;
  quantity: number;
  unit_price: string | number | null;
  notes: string | null;
  procedure?: { id: string; name: string; base_price: string | number };
}

interface Template {
  id: string;
  name: string;
  description: string | null;
  specialty: string | null;
  is_active: boolean;
  items?: TemplateItem[];
  _count?: { items: number };
}

export default function QuoteTemplatesSettingsPage() {
  const [list, setList] = useState<Template[]>([]);
  const [procedures, setProcedures] = useState<Procedure[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<Template | null>(null);
  const [creating, setCreating] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      const [tplsRes, procsRes] = await Promise.all([
        api.get<Template[]>('/quote-templates'),
        api.get<Procedure[]>('/procedures'),
      ]);
      setList(tplsRes.data);
      setProcedures(procsRes.data);
    } catch (err: any) {
      showError(err?.response?.data?.message || 'Erro ao carregar');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const handleDelete = async (t: Template) => {
    if (!confirm(`Remover modelo "${t.name}"?`)) return;
    try {
      await api.delete(`/quote-templates/${t.id}`);
      showSuccess('Modelo removido');
      load();
    } catch (err: any) {
      showError(err?.response?.data?.message || 'Erro ao remover');
    }
  };

  const openEdit = async (t: Template) => {
    try {
      const { data } = await api.get<Template>(`/quote-templates/${t.id}`);
      setEditing(data);
    } catch (err: any) {
      showError(err?.response?.data?.message || 'Erro ao carregar modelo');
    }
  };

  return (
    <div className="p-6 max-w-5xl mx-auto">
      <div className="flex items-start justify-between gap-4 mb-6 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold text-foreground flex items-center gap-2">
            <FileStack size={24} className="text-primary" /> Modelos de Orçamento
          </h1>
          <p className="text-sm text-muted-foreground mt-1 max-w-2xl">
            Cestas pré-prontas de procedimentos por especialidade. Operador clica
            "Usar modelo" no orçamento e ganha minutos de cadastro.
          </p>
        </div>
        <button
          onClick={() => setCreating(true)}
          className="inline-flex items-center gap-2 px-3 py-2 rounded-lg bg-primary text-primary-foreground hover:bg-primary/90 text-sm font-medium"
        >
          <Plus size={16} /> Novo modelo
        </button>
      </div>

      {loading ? (
        <div className="p-12 flex items-center justify-center text-muted-foreground">
          <Loader2 size={20} className="animate-spin mr-2" /> Carregando...
        </div>
      ) : list.length === 0 ? (
        <div className="p-12 text-center bg-card border border-border rounded-xl">
          <FileStack size={28} className="mx-auto mb-2 text-muted-foreground/50" />
          <p className="text-sm text-muted-foreground mb-3">Nenhum modelo cadastrado.</p>
          <button
            onClick={() => setCreating(true)}
            className="inline-flex items-center gap-2 px-3 py-2 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90"
          >
            <Plus size={14} /> Criar primeiro modelo
          </button>
        </div>
      ) : (
        <ul className="bg-card border border-border rounded-xl divide-y divide-border">
          {list.map((t) => (
            <li key={t.id} className="px-4 py-3 flex items-center gap-3">
              <FileStack size={18} className={t.is_active ? 'text-primary' : 'text-muted-foreground'} />
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium flex items-center gap-2 flex-wrap">
                  {t.name}
                  {!t.is_active && (
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground">
                      Inativo
                    </span>
                  )}
                  {t.specialty && (
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-primary/10 text-primary border border-primary/20">
                      {t.specialty}
                    </span>
                  )}
                </p>
                <p className="text-xs text-muted-foreground">
                  {t._count?.items || 0} procedimento(s)
                  {t.description && ` · ${t.description}`}
                </p>
              </div>
              <button
                onClick={() => openEdit(t)}
                className="text-muted-foreground hover:text-foreground p-1"
                title="Editar"
              >
                <Pencil size={14} />
              </button>
              <button
                onClick={() => handleDelete(t)}
                className="text-muted-foreground hover:text-destructive p-1"
                title="Remover"
              >
                <Trash2 size={14} />
              </button>
            </li>
          ))}
        </ul>
      )}

      {(creating || editing) && (
        <TemplateModal
          template={editing}
          procedures={procedures}
          onClose={() => { setCreating(false); setEditing(null); }}
          onSaved={() => { setCreating(false); setEditing(null); load(); }}
        />
      )}
    </div>
  );
}

// ─── Modal de criar/editar template ───────────────────────

function TemplateModal({
  template, procedures, onClose, onSaved,
}: {
  template: Template | null;
  procedures: Procedure[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const isEdit = !!template;
  const [name, setName] = useState(template?.name || '');
  const [description, setDescription] = useState(template?.description || '');
  const [specialty, setSpecialty] = useState(template?.specialty || '');
  const [isActive, setIsActive] = useState(template?.is_active !== false);
  const [items, setItems] = useState<Array<{
    procedure_id: string;
    quantity: number;
    unit_price: string;
    notes: string;
  }>>(
    template?.items?.map((i) => ({
      procedure_id: i.procedure_id,
      quantity: i.quantity,
      unit_price: i.unit_price !== null ? String(i.unit_price) : '',
      notes: i.notes || '',
    })) || []
  );
  const [saving, setSaving] = useState(false);

  const addItem = () => {
    setItems([...items, { procedure_id: '', quantity: 1, unit_price: '', notes: '' }]);
  };
  const removeItem = (idx: number) => {
    setItems(items.filter((_, i) => i !== idx));
  };
  const updateItem = (idx: number, patch: Partial<typeof items[0]>) => {
    setItems(items.map((it, i) => i === idx ? { ...it, ...patch } : it));
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim()) {
      showError('Nome obrigatório');
      return;
    }
    const validItems = items.filter((i) => i.procedure_id);
    setSaving(true);
    try {
      const payload = {
        name: name.trim(),
        description: description.trim() || null,
        specialty: specialty.trim() || null,
        is_active: isActive,
        items: validItems.map((i) => ({
          procedure_id: i.procedure_id,
          quantity: i.quantity || 1,
          unit_price: i.unit_price === '' ? null : Number(i.unit_price),
          notes: i.notes.trim() || null,
        })),
      };
      if (isEdit) {
        await api.patch(`/quote-templates/${template!.id}`, payload);
        showSuccess('Modelo atualizado');
      } else {
        await api.post('/quote-templates', payload);
        showSuccess('Modelo criado');
      }
      onSaved();
    } catch (err: any) {
      showError(err?.response?.data?.message || 'Erro ao salvar');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-[100] bg-black/50 backdrop-blur-sm flex items-center justify-center p-4"
      onClick={onClose}
    >
      <div
        className="bg-card border border-border rounded-xl w-full max-w-2xl shadow-2xl max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between p-4 border-b border-border sticky top-0 bg-card z-10">
          <div className="flex items-center gap-2">
            <FileStack size={18} className="text-primary" />
            <h2 className="text-base font-semibold">{isEdit ? 'Editar modelo' : 'Novo modelo'}</h2>
          </div>
          <button onClick={onClose} className="p-1 hover:bg-accent rounded">
            <X size={18} />
          </button>
        </div>

        <form onSubmit={submit} className="p-4 space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium mb-1">Nome do modelo *</label>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                required
                placeholder="Ex: Implante unitário completo"
                className="w-full px-3 py-2 rounded-lg bg-background border border-border text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
              />
            </div>
            <div>
              <label className="block text-xs font-medium mb-1">Especialidade (tag)</label>
              <input
                value={specialty}
                onChange={(e) => setSpecialty(e.target.value)}
                placeholder="Ex: Implante, Estética, Endodontia"
                className="w-full px-3 py-2 rounded-lg bg-background border border-border text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
              />
            </div>
          </div>

          <div>
            <label className="block text-xs font-medium mb-1">Descrição</label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={2}
              placeholder="Quando usar este modelo, observações"
              className="w-full px-3 py-2 rounded-lg bg-background border border-border text-sm resize-none focus:outline-none focus:ring-2 focus:ring-primary/30"
            />
          </div>

          <label className="flex items-center gap-2 text-sm cursor-pointer">
            <input
              type="checkbox"
              checked={isActive}
              onChange={(e) => setIsActive(e.target.checked)}
              className="w-4 h-4 rounded border-border"
            />
            Modelo ativo (operador pode usar)
          </label>

          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="block text-xs font-medium">Procedimentos</label>
              <button
                type="button"
                onClick={addItem}
                className="text-xs px-2 py-1 rounded bg-primary text-primary-foreground hover:bg-primary/90 inline-flex items-center gap-1"
              >
                <Plus size={11} /> Adicionar
              </button>
            </div>
            {items.length === 0 ? (
              <p className="text-xs text-muted-foreground italic py-2">
                Nenhum procedimento. Adicione pelo menos 1 pra o modelo ser útil.
              </p>
            ) : (
              <div className="space-y-2 max-h-72 overflow-y-auto">
                {items.map((it, idx) => (
                  <div key={idx} className="flex gap-2 items-start p-2 bg-background border border-border rounded-lg">
                    <select
                      value={it.procedure_id}
                      onChange={(e) => updateItem(idx, { procedure_id: e.target.value })}
                      className="flex-1 px-2 py-1 rounded bg-card border border-border text-xs focus:outline-none focus:ring-2 focus:ring-primary/30"
                    >
                      <option value="">Selecione procedimento</option>
                      {procedures.map((p) => (
                        <option key={p.id} value={p.id}>{p.name}</option>
                      ))}
                    </select>
                    <input
                      type="number"
                      min={1}
                      value={it.quantity}
                      onChange={(e) => updateItem(idx, { quantity: Number(e.target.value) })}
                      placeholder="Qtd"
                      className="w-16 px-2 py-1 rounded bg-card border border-border text-xs"
                    />
                    <input
                      type="number"
                      step="0.01"
                      min={0}
                      value={it.unit_price}
                      onChange={(e) => updateItem(idx, { unit_price: e.target.value })}
                      placeholder="Preço (auto)"
                      title="Deixe vazio pra usar preço base do procedimento"
                      className="w-24 px-2 py-1 rounded bg-card border border-border text-xs"
                    />
                    <button
                      type="button"
                      onClick={() => removeItem(idx)}
                      className="text-muted-foreground hover:text-destructive p-1"
                    >
                      <X size={14} />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="flex justify-end gap-2 pt-2 border-t border-border">
            <button
              type="button"
              onClick={onClose}
              className="px-3 py-2 rounded-lg border border-border text-sm hover:bg-accent"
            >
              Cancelar
            </button>
            <button
              type="submit"
              disabled={saving}
              className="inline-flex items-center gap-1 px-3 py-2 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 disabled:opacity-50"
            >
              {saving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
              {isEdit ? 'Salvar' : 'Criar'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

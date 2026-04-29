'use client';

/**
 * Settings → Especialidades.
 *
 * Categorias usadas em Procedimentos pra agrupamento. Admin cria/edita.
 * Procedimentos linkam via specialty_id (opcional).
 */
import { useEffect, useState, FormEvent } from 'react';
import {
  Layers, Loader2, Plus, Pencil, Trash2, X, Save,
} from 'lucide-react';
import api from '@/lib/api';
import { showError, showSuccess } from '@/lib/toast';

interface Specialty {
  id: string;
  name: string;
  description: string | null;
  icon: string | null;
  active: boolean;
  _count?: { procedures: number };
}

export default function SpecialtiesSettingsPage() {
  const [list, setList] = useState<Specialty[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<Specialty | null>(null);
  const [creating, setCreating] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      const { data } = await api.get<Specialty[]>('/specialties');
      setList(data);
    } catch (err: any) {
      showError(err?.response?.data?.message || 'Erro ao carregar');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const handleDelete = async (s: Specialty) => {
    if (!confirm(`Remover especialidade "${s.name}"? Procedimentos linkados ficarão sem especialidade.`)) return;
    try {
      await api.delete(`/specialties/${s.id}`);
      showSuccess('Especialidade removida');
      load();
    } catch (err: any) {
      showError(err?.response?.data?.message || 'Erro ao remover');
    }
  };

  return (
    <div className="p-6 max-w-3xl mx-auto">
      <div className="flex items-start justify-between gap-4 mb-6 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold text-foreground flex items-center gap-2">
            <Layers size={24} className="text-primary" /> Especialidades
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            Categorias para organizar os procedimentos da clínica
            (ex: Endodontia, Implantodontia, Estética, Ortodontia).
          </p>
        </div>
        <button
          onClick={() => setCreating(true)}
          className="inline-flex items-center gap-2 px-3 py-2 rounded-lg bg-primary text-primary-foreground hover:bg-primary/90 text-sm font-medium"
        >
          <Plus size={16} /> Nova especialidade
        </button>
      </div>

      {loading ? (
        <div className="p-12 flex items-center justify-center text-muted-foreground">
          <Loader2 size={20} className="animate-spin mr-2" /> Carregando...
        </div>
      ) : list.length === 0 ? (
        <div className="p-12 text-center bg-card border border-border rounded-xl">
          <Layers size={28} className="mx-auto mb-2 text-muted-foreground/50" />
          <p className="text-sm text-muted-foreground mb-3">Nenhuma especialidade cadastrada.</p>
          <button
            onClick={() => setCreating(true)}
            className="inline-flex items-center gap-2 px-3 py-2 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90"
          >
            <Plus size={14} /> Criar primeira
          </button>
        </div>
      ) : (
        <ul className="bg-card border border-border rounded-xl divide-y divide-border">
          {list.map((s) => (
            <li key={s.id} className="px-4 py-3 flex items-center gap-3">
              <Layers size={18} className={s.active ? 'text-primary' : 'text-muted-foreground'} />
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium flex items-center gap-2">
                  {s.name}
                  {!s.active && (
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground">
                      Inativo
                    </span>
                  )}
                </p>
                {s.description && (
                  <p className="text-xs text-muted-foreground">{s.description}</p>
                )}
                {s._count && (
                  <p className="text-xs text-muted-foreground">
                    {s._count.procedures} procedimento(s)
                  </p>
                )}
              </div>
              <button
                onClick={() => setEditing(s)}
                className="text-muted-foreground hover:text-foreground p-1"
                title="Editar"
              >
                <Pencil size={14} />
              </button>
              <button
                onClick={() => handleDelete(s)}
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
        <SpecialtyModal
          specialty={editing}
          onClose={() => { setCreating(false); setEditing(null); }}
          onSaved={() => { setCreating(false); setEditing(null); load(); }}
        />
      )}
    </div>
  );
}

function SpecialtyModal({
  specialty, onClose, onSaved,
}: { specialty: Specialty | null; onClose: () => void; onSaved: () => void }) {
  const isEdit = !!specialty;
  const [name, setName] = useState(specialty?.name || '');
  const [description, setDescription] = useState(specialty?.description || '');
  const [icon, setIcon] = useState(specialty?.icon || '');
  const [active, setActive] = useState(specialty?.active !== false);
  const [saving, setSaving] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return showError('Nome obrigatório');
    setSaving(true);
    try {
      const payload = {
        name: name.trim(),
        description: description.trim() || null,
        icon: icon.trim() || null,
        active,
      };
      if (isEdit) {
        await api.patch(`/specialties/${specialty!.id}`, payload);
        showSuccess('Especialidade atualizada');
      } else {
        await api.post('/specialties', payload);
        showSuccess('Especialidade criada');
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
        className="bg-card border border-border rounded-xl w-full max-w-md shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between p-4 border-b border-border">
          <div className="flex items-center gap-2">
            <Layers size={18} className="text-primary" />
            <h2 className="text-base font-semibold">
              {isEdit ? 'Editar especialidade' : 'Nova especialidade'}
            </h2>
          </div>
          <button onClick={onClose} className="p-1 hover:bg-accent rounded">
            <X size={18} />
          </button>
        </div>

        <form onSubmit={submit} className="p-4 space-y-3">
          <div>
            <label className="block text-xs font-medium mb-1">Nome *</label>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              autoFocus
              placeholder="Ex: Endodontia, Implantodontia, Estética Facial"
              className="w-full px-3 py-2 rounded-lg bg-background border border-border text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
            />
          </div>

          <div>
            <label className="block text-xs font-medium mb-1">Descrição</label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={2}
              placeholder="O que essa especialidade abrange"
              className="w-full px-3 py-2 rounded-lg bg-background border border-border text-sm resize-none"
            />
          </div>

          <label className="flex items-center gap-2 text-sm cursor-pointer">
            <input
              type="checkbox"
              checked={active}
              onChange={(e) => setActive(e.target.checked)}
              className="w-4 h-4 rounded border-border"
            />
            Especialidade ativa
          </label>

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

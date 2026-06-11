'use client';

/**
 * Settings → Tags de Pacientes (Fase 20).
 *
 * Admin/operadores criam/editam/removem tags do tenant. Cada tag tem nome,
 * cor (hex) e descrição opcional. Tags são depois atribuídas a pacientes
 * na ficha individual ou em massa.
 */
import { useEffect, useState, FormEvent } from 'react';
import { Tag, Loader2, Plus, Pencil, Trash2, X, Save } from 'lucide-react';
import api from '@/lib/api';
import { showError, showSuccess } from '@/lib/toast';
import { useRole } from '@/lib/useRole';

interface PatientTag {
  id: string;
  name: string;
  color: string | null;
  description: string | null;
  _count: { patients: number };
}

// Paleta de cores sugeridas pra usuário não ter que digitar hex
const COLOR_PRESETS = [
  '#ef4444', // red
  '#f97316', // orange
  '#eab308', // yellow
  '#84cc16', // lime
  '#22c55e', // green
  '#14b8a6', // teal
  '#06b6d4', // cyan
  '#3b82f6', // blue
  '#8b5cf6', // violet
  '#a855f7', // purple
  '#ec4899', // pink
  '#64748b', // slate
];

export default function PatientTagsSettingsPage() {
  // Excluir etiqueta e destrutivo (some de todos os pacientes) — API exige
  // ADMIN (Onda 17.34); esconde a lixeira pra quem nao pode em vez de
  // deixar clicar e tomar 403.
  const { isAdmin } = useRole();
  const [tags, setTags] = useState<PatientTag[]>([]);
  const [loading, setLoading] = useState(true);
  const [openModal, setOpenModal] = useState(false);
  const [editing, setEditing] = useState<PatientTag | null>(null);

  const load = async () => {
    setLoading(true);
    try {
      const { data } = await api.get<PatientTag[]>('/patient-tags');
      setTags(data);
    } catch (err: any) {
      showError(err?.response?.data?.message || 'Erro ao carregar tags');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const handleDelete = async (tag: PatientTag) => {
    if (!confirm(`Remover a tag "${tag.name}"? Ela será desvinculada de todos os ${tag._count.patients} paciente(s) que a usam.`)) return;
    try {
      await api.delete(`/patient-tags/${tag.id}`);
      showSuccess('Tag removida');
      load();
    } catch (err: any) {
      showError(err?.response?.data?.message || 'Erro ao remover');
    }
  };

  return (
    <div className="p-6 max-w-4xl mx-auto">
      <div className="flex items-start justify-between gap-4 mb-6 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold text-foreground flex items-center gap-2">
            <Tag size={24} className="text-primary" /> Tags de Pacientes
          </h1>
          <p className="text-sm text-muted-foreground mt-1 max-w-2xl">
            Crie etiquetas pra classificar pacientes (ex: VIP, Alergia crítica, Sem revisão 6m).
            Tags ajudam a filtrar a lista e dar contexto rápido na ficha.
          </p>
        </div>
        <button
          onClick={() => { setEditing(null); setOpenModal(true); }}
          className="inline-flex items-center gap-2 px-3 py-2 rounded-lg bg-primary text-primary-foreground hover:bg-primary/90 text-sm font-medium"
        >
          <Plus size={16} /> Nova tag
        </button>
      </div>

      {loading ? (
        <div className="p-12 flex items-center justify-center text-muted-foreground">
          <Loader2 size={20} className="animate-spin mr-2" /> Carregando...
        </div>
      ) : tags.length === 0 ? (
        <div className="p-12 text-center bg-card border border-border rounded-xl">
          <Tag size={28} className="mx-auto mb-2 text-muted-foreground/50" />
          <p className="text-sm text-muted-foreground mb-3">
            Nenhuma tag criada ainda.
          </p>
          <button
            onClick={() => { setEditing(null); setOpenModal(true); }}
            className="inline-flex items-center gap-2 px-3 py-2 rounded-lg bg-primary text-primary-foreground hover:bg-primary/90 text-sm font-medium"
          >
            <Plus size={14} /> Criar primeira tag
          </button>
        </div>
      ) : (
        <div className="bg-card border border-border rounded-xl overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-muted-foreground text-xs uppercase">
              <tr>
                <th className="text-left px-4 py-2 font-medium">Tag</th>
                <th className="text-left px-4 py-2 font-medium">Descrição</th>
                <th className="text-right px-4 py-2 font-medium">Pacientes</th>
                <th className="text-right px-4 py-2 font-medium">Ações</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {tags.map((t) => (
                <tr key={t.id} className="hover:bg-muted/30 transition-colors">
                  <td className="px-4 py-2">
                    <span
                      className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-xs font-medium border"
                      style={{
                        backgroundColor: t.color ? `${t.color}20` : undefined,
                        borderColor: t.color ? `${t.color}50` : undefined,
                        color: t.color || undefined,
                      }}
                    >
                      <span className="w-2 h-2 rounded-full" style={{ backgroundColor: t.color || '#64748b' }} />
                      {t.name}
                    </span>
                  </td>
                  <td className="px-4 py-2 text-muted-foreground text-xs">
                    {t.description || <span className="opacity-60">—</span>}
                  </td>
                  <td className="px-4 py-2 text-right text-xs">{t._count.patients}</td>
                  <td className="px-4 py-2 text-right">
                    <button
                      onClick={() => { setEditing(t); setOpenModal(true); }}
                      className="text-muted-foreground hover:text-foreground p-1 mr-1"
                      title="Editar"
                    >
                      <Pencil size={14} />
                    </button>
                    {isAdmin && (
                      <button
                        onClick={() => handleDelete(t)}
                        className="text-muted-foreground hover:text-destructive p-1"
                        title="Remover"
                      >
                        <Trash2 size={14} />
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {openModal && (
        <TagModal
          tag={editing}
          onClose={() => setOpenModal(false)}
          onSaved={() => { setOpenModal(false); load(); }}
        />
      )}
    </div>
  );
}

// ─── Modal de criar/editar tag ────────────────────────────

function TagModal({
  tag, onClose, onSaved,
}: { tag: PatientTag | null; onClose: () => void; onSaved: () => void }) {
  const isEdit = !!tag;
  const [name, setName] = useState(tag?.name || '');
  const [color, setColor] = useState(tag?.color || COLOR_PRESETS[0]);
  const [description, setDescription] = useState(tag?.description || '');
  const [saving, setSaving] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim()) {
      showError('Nome é obrigatório');
      return;
    }
    setSaving(true);
    try {
      const payload = {
        name: name.trim(),
        color: color || null,
        description: description.trim() || null,
      };
      if (isEdit) {
        await api.patch(`/patient-tags/${tag!.id}`, payload);
        showSuccess('Tag atualizada');
      } else {
        await api.post('/patient-tags', payload);
        showSuccess('Tag criada');
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
            <Tag size={18} className="text-primary" />
            <h2 className="text-base font-semibold">{isEdit ? 'Editar tag' : 'Nova tag'}</h2>
          </div>
          <button onClick={onClose} className="p-1 hover:bg-accent rounded">
            <X size={18} />
          </button>
        </div>

        <form onSubmit={submit} className="p-4 space-y-4">
          <div>
            <label className="block text-xs font-medium mb-1">Nome *</label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              autoFocus
              required
              placeholder="Ex: VIP, Alergia crítica, Inadimplente"
              className="w-full px-3 py-2 rounded-lg bg-background border border-border text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
            />
          </div>

          <div>
            <label className="block text-xs font-medium mb-2">Cor do badge</label>
            <div className="flex flex-wrap gap-2">
              {COLOR_PRESETS.map((c) => (
                <button
                  key={c}
                  type="button"
                  onClick={() => setColor(c)}
                  className={`w-7 h-7 rounded-full border-2 transition-transform ${
                    color === c ? 'border-foreground scale-110' : 'border-transparent hover:scale-105'
                  }`}
                  style={{ backgroundColor: c }}
                  title={c}
                />
              ))}
              {/* Custom hex input */}
              <input
                type="color"
                value={color}
                onChange={(e) => setColor(e.target.value)}
                className="w-7 h-7 rounded-full border-2 border-transparent cursor-pointer"
                title="Cor customizada"
              />
            </div>
          </div>

          <div>
            <label className="block text-xs font-medium mb-1">Descrição (opcional)</label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={2}
              placeholder="Tooltip explicando quando usar essa tag"
              className="w-full px-3 py-2 rounded-lg bg-background border border-border text-sm resize-none focus:outline-none focus:ring-2 focus:ring-primary/30"
            />
          </div>

          {/* Preview */}
          <div className="bg-background border border-border rounded-lg p-3">
            <p className="text-xs font-medium text-muted-foreground mb-2">Preview:</p>
            <span
              className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-xs font-medium border"
              style={{
                backgroundColor: `${color}20`,
                borderColor: `${color}50`,
                color: color,
              }}
            >
              <span className="w-2 h-2 rounded-full" style={{ backgroundColor: color }} />
              {name || 'Nome da tag'}
            </span>
          </div>

          <div className="flex justify-end gap-2 pt-2">
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

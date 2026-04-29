'use client';

/**
 * PatientTagsPicker — exibe e gerencia as tags atribuídas a um paciente.
 *
 * Usado no header da ficha do paciente. Mostra badges das tags atuais com
 * X pra remover, e um botão "+ Tag" que abre um popover com as tags
 * disponíveis do tenant pra adicionar (busca + click). O backend é
 * idempotente (PUT /patients/:id/tags substitui o set completo).
 */
import { useEffect, useRef, useState } from 'react';
import { Plus, X, Tag as TagIcon, Loader2 } from 'lucide-react';
import api from '@/lib/api';
import { showError } from '@/lib/toast';

export interface PatientTag {
  id: string;
  name: string;
  color: string | null;
  description: string | null;
}

export interface AssignedTag {
  tag_id: string;
  tag: PatientTag;
}

interface Props {
  patientId: string;
  initialTags: AssignedTag[];
  onChange?: (tags: AssignedTag[]) => void;
}

export default function PatientTagsPicker({ patientId, initialTags, onChange }: Props) {
  const [tags, setTags] = useState<AssignedTag[]>(initialTags);
  const [allTags, setAllTags] = useState<PatientTag[]>([]);
  const [loadingAll, setLoadingAll] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [saving, setSaving] = useState(false);
  const popoverRef = useRef<HTMLDivElement>(null);

  // Atualiza quando initialTags muda (após reload do patient)
  useEffect(() => { setTags(initialTags); }, [initialTags]);

  // Carrega lista completa quando o picker abre pela primeira vez
  useEffect(() => {
    if (!pickerOpen || allTags.length > 0) return;
    setLoadingAll(true);
    api.get<PatientTag[]>('/patient-tags')
      .then((r) => setAllTags(r.data || []))
      .catch((err) => showError(err?.response?.data?.message || 'Erro ao carregar tags'))
      .finally(() => setLoadingAll(false));
  }, [pickerOpen, allTags.length]);

  // Fecha popover ao clicar fora
  useEffect(() => {
    if (!pickerOpen) return;
    const handler = (e: MouseEvent) => {
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) {
        setPickerOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [pickerOpen]);

  const updateTags = async (newTagIds: string[], optimistic?: AssignedTag[]) => {
    setSaving(true);
    if (optimistic) setTags(optimistic);
    try {
      const { data } = await api.put<AssignedTag[]>(`/patients/${patientId}/tags`, {
        tag_ids: newTagIds,
      });
      setTags(data);
      onChange?.(data);
    } catch (err: any) {
      // Rollback otimista
      setTags(initialTags);
      showError(err?.response?.data?.message || 'Erro ao atualizar tags');
    } finally {
      setSaving(false);
    }
  };

  const addTag = (tag: PatientTag) => {
    if (tags.some((t) => t.tag_id === tag.id)) return; // já tem
    const next = [...tags, { tag_id: tag.id, tag }];
    updateTags(next.map((t) => t.tag_id), next);
    setSearch('');
  };

  const removeTag = (tagId: string) => {
    const next = tags.filter((t) => t.tag_id !== tagId);
    updateTags(next.map((t) => t.tag_id), next);
  };

  const filteredAvailable = allTags
    .filter((t) => !tags.some((a) => a.tag_id === t.id))
    .filter((t) => !search.trim() || t.name.toLowerCase().includes(search.toLowerCase()));

  return (
    <div className="flex items-center gap-1 flex-wrap" ref={popoverRef}>
      {tags.map((t) => (
        <Badge key={t.tag_id} tag={t.tag} onRemove={() => removeTag(t.tag_id)} />
      ))}

      {/* Botão "+" pra abrir picker */}
      <div className="relative">
        <button
          onClick={() => setPickerOpen((v) => !v)}
          disabled={saving}
          className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs border border-dashed border-border hover:border-primary hover:text-primary transition-colors disabled:opacity-50"
          title="Adicionar tag"
        >
          {saving ? <Loader2 size={11} className="animate-spin" /> : <Plus size={11} />}
          Tag
        </button>

        {pickerOpen && (
          <div className="absolute top-full mt-1 left-0 z-50 w-64 bg-card border border-border rounded-lg shadow-2xl p-2">
            <input
              type="text"
              autoFocus
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Buscar tag..."
              className="w-full px-2 py-1.5 mb-2 rounded bg-background border border-border text-xs focus:outline-none focus:ring-2 focus:ring-primary/30"
            />
            <div className="max-h-48 overflow-y-auto">
              {loadingAll ? (
                <div className="p-3 text-center text-xs text-muted-foreground">
                  <Loader2 size={14} className="animate-spin inline mr-1" /> Carregando
                </div>
              ) : allTags.length === 0 ? (
                <div className="p-3 text-center text-xs text-muted-foreground">
                  Nenhuma tag criada ainda.
                  <br />
                  <a href="/atendimento/settings/patient-tags" className="text-primary hover:underline">
                    Criar tags
                  </a>
                </div>
              ) : filteredAvailable.length === 0 ? (
                <div className="p-3 text-center text-xs text-muted-foreground">
                  {tags.length === allTags.length
                    ? 'Todas as tags já estão atribuídas.'
                    : 'Nenhuma tag corresponde à busca.'}
                </div>
              ) : (
                filteredAvailable.map((t) => (
                  <button
                    key={t.id}
                    onClick={() => addTag(t)}
                    className="w-full text-left px-2 py-1.5 rounded text-xs hover:bg-accent flex items-center gap-2"
                    title={t.description || undefined}
                  >
                    <span
                      className="w-2.5 h-2.5 rounded-full shrink-0"
                      style={{ backgroundColor: t.color || '#64748b' }}
                    />
                    <span className="truncate">{t.name}</span>
                  </button>
                ))
              )}
            </div>
            <div className="border-t border-border mt-2 pt-2">
              <a
                href="/atendimento/settings/patient-tags"
                className="text-[11px] text-muted-foreground hover:text-primary inline-flex items-center gap-1"
              >
                <TagIcon size={10} /> Gerenciar tags
              </a>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Badge compartilhado (usado na ficha + lista) ───────────

export function Badge({ tag, onRemove }: { tag: PatientTag; onRemove?: () => void }) {
  const color = tag.color || '#64748b';
  return (
    <span
      className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium border whitespace-nowrap"
      style={{
        backgroundColor: `${color}20`,
        borderColor: `${color}50`,
        color: color,
      }}
      title={tag.description || tag.name}
    >
      <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ backgroundColor: color }} />
      {tag.name}
      {onRemove && (
        <button
          onClick={(e) => { e.stopPropagation(); onRemove(); }}
          className="ml-0.5 hover:bg-foreground/10 rounded-full p-0.5"
          title="Remover"
        >
          <X size={10} />
        </button>
      )}
    </span>
  );
}

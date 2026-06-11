'use client';

/**
 * TagChipsSelector — lista única de chips de etiquetas (Onda 17.35).
 *
 * Compartilhado entre NewPatientModal e EditPatientModal pra UI ser idêntica:
 * - Todas as etiquetas do tenant viram chips clicáveis (marca/desmarca).
 * - "Paciente Antigo" SEMPRE aparece (em 1º): se ainda não existe no tenant,
 *   é criada sob demanda ao clicar (id sentinela '__antigo__').
 * - Chip "+ Nova" abre input inline pra criar etiqueta na hora (Enter cria,
 *   Esc cancela; cor automática por nome; nome repetido só seleciona).
 *
 * O pai controla selectedTagIds; onChange devolve também se "Paciente Antigo"
 * está marcado (o cadastro usa isso pra liberar CPF/CEP).
 */
import { useEffect, useState } from 'react';
import { Loader2, Check, Plus, X } from 'lucide-react';
import api from '@/lib/api';
import { showError } from '@/lib/toast';
import { type PatientTag } from './PatientTagsPicker';

export const PACIENTE_ANTIGO_NAME = 'Paciente Antigo';
const PACIENTE_ANTIGO_COLOR = '#b45309'; // amber-700 — legível em badge claro/escuro

// Paleta pra etiquetas criadas inline. Cor determinística pelo nome (sem
// Math.random) só pra variar — ajustável depois em Configurações → Etiquetas.
const NEW_TAG_COLORS = ['#0ea5e9', '#10b981', '#8b5cf6', '#ec4899', '#f59e0b', '#ef4444', '#14b8a6', '#6366f1'];
const colorForName = (name: string) => {
  let sum = 0;
  for (let i = 0; i < name.length; i++) sum += name.charCodeAt(i);
  return NEW_TAG_COLORS[sum % NEW_TAG_COLORS.length];
};

interface Props {
  selectedTagIds: string[];
  onChange: (ids: string[], antigoSelected: boolean) => void;
}

export default function TagChipsSelector({ selectedTagIds, onChange }: Props) {
  const [allTags, setAllTags] = useState<PatientTag[]>([]);
  const [creatingAntigo, setCreatingAntigo] = useState(false);
  const [newTagName, setNewTagName] = useState('');
  const [creatingTag, setCreatingTag] = useState(false);
  const [addingTag, setAddingTag] = useState(false);

  useEffect(() => {
    api.get<PatientTag[]>('/patient-tags')
      .then((r) => setAllTags(r.data || []))
      .catch(() => {}); // sem etiquetas não impede o formulário
  }, []);

  const pacienteAntigoTag = allTags.find(
    (t) => t.name.trim().toLowerCase() === PACIENTE_ANTIGO_NAME.toLowerCase(),
  );
  const otherTags = allTags.filter((t) => t.id !== pacienteAntigoTag?.id);
  const antigoSelected = !!pacienteAntigoTag && selectedTagIds.includes(pacienteAntigoTag.id);

  const isAntigoId = (id: string) =>
    !!pacienteAntigoTag && id === pacienteAntigoTag.id;

  const emit = (ids: string[]) => {
    const antigo = !!pacienteAntigoTag && ids.includes(pacienteAntigoTag.id);
    onChange(ids, antigo);
  };

  const toggleTag = (id: string) =>
    emit(selectedTagIds.includes(id) ? selectedTagIds.filter((x) => x !== id) : [...selectedTagIds, id]);

  // "Paciente Antigo": se já existe, alterna; senão cria sob demanda e marca.
  const toggleAntigo = async () => {
    if (creatingAntigo) return; // guard: evita 2 POSTs em clique duplo
    if (pacienteAntigoTag) {
      toggleTag(pacienteAntigoTag.id);
      return;
    }
    setCreatingAntigo(true);
    try {
      const { data } = await api.post<PatientTag>('/patient-tags', {
        name: PACIENTE_ANTIGO_NAME,
        color: PACIENTE_ANTIGO_COLOR,
        description: 'Paciente cadastrado da base antiga (fichas de papel, pré-sistema)',
      });
      setAllTags((prev) => [...prev, data]);
      onChange([...selectedTagIds, data.id], true);
    } catch (err: any) {
      // Corrida/duplicada: a etiqueta já existe — recarrega a lista e marca.
      try {
        const { data: list } = await api.get<PatientTag[]>('/patient-tags');
        setAllTags(list || []);
        const found = (list || []).find(
          (t) => t.name.trim().toLowerCase() === PACIENTE_ANTIGO_NAME.toLowerCase(),
        );
        if (found) {
          if (!selectedTagIds.includes(found.id)) onChange([...selectedTagIds, found.id], true);
        } else showError(err?.response?.data?.message || 'Erro ao criar etiqueta');
      } catch {
        showError(err?.response?.data?.message || 'Erro ao criar etiqueta');
      }
    } finally {
      setCreatingAntigo(false);
    }
  };

  // Cria etiqueta nova (qualquer nome) e já marca. Nome repetido só seleciona.
  const createAndSelectTag = async () => {
    const name = newTagName.trim();
    if (!name || creatingTag) return;
    const close = () => { setNewTagName(''); setAddingTag(false); };
    const existing = allTags.find((t) => t.name.trim().toLowerCase() === name.toLowerCase());
    if (existing) {
      if (!selectedTagIds.includes(existing.id)) toggleTag(existing.id);
      close();
      return;
    }
    setCreatingTag(true);
    try {
      const { data } = await api.post<PatientTag>('/patient-tags', { name, color: colorForName(name) });
      setAllTags((prev) => [...prev, data]);
      emit([...selectedTagIds, data.id]);
      close();
    } catch (err: any) {
      // Corrida/duplicada — recarrega e marca a existente.
      try {
        const { data: list } = await api.get<PatientTag[]>('/patient-tags');
        setAllTags(list || []);
        const found = (list || []).find((t) => t.name.trim().toLowerCase() === name.toLowerCase());
        if (found) {
          if (!selectedTagIds.includes(found.id)) emit([...selectedTagIds, found.id]);
          close();
        } else showError(err?.response?.data?.message || 'Erro ao criar etiqueta');
      } catch {
        showError(err?.response?.data?.message || 'Erro ao criar etiqueta');
      }
    } finally {
      setCreatingTag(false);
    }
  };

  // "Paciente Antigo" sempre em 1º — como tag real ou chip "fantasma" que
  // cria sob demanda ao clicar.
  const antigoChip: PatientTag = pacienteAntigoTag ?? {
    id: '__antigo__',
    name: PACIENTE_ANTIGO_NAME,
    color: PACIENTE_ANTIGO_COLOR,
    description: 'Paciente cadastrado da base antiga (fichas de papel, pré-sistema)',
  };
  const displayTags: PatientTag[] = [antigoChip, ...otherTags];

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {displayTags.map((t) => {
        const synthetic = t.id === '__antigo__';
        const selected = synthetic ? antigoSelected : selectedTagIds.includes(t.id);
        const color = t.color || '#64748b';
        const busy = (synthetic || isAntigoId(t.id)) && creatingAntigo;
        return (
          <button
            key={t.id}
            type="button"
            onClick={() => (synthetic ? toggleAntigo() : toggleTag(t.id))}
            disabled={busy}
            title={t.description || t.name}
            className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium border transition-colors disabled:opacity-60"
            style={
              selected
                ? { backgroundColor: color, borderColor: color, color: '#fff' }
                : { backgroundColor: `${color}15`, borderColor: `${color}50`, color }
            }
          >
            {busy ? (
              <Loader2 size={11} className="animate-spin" />
            ) : (
              <span
                className="w-2 h-2 rounded-full shrink-0"
                style={{ backgroundColor: selected ? '#fff' : color }}
              />
            )}
            {t.name}
            {selected && <Check size={12} />}
          </button>
        );
      })}

      {/* Criar nova etiqueta — chip "+ Nova" que vira input inline */}
      {addingTag ? (
        <span className="inline-flex items-center gap-1">
          <input
            autoFocus
            value={newTagName}
            onChange={(e) => setNewTagName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') { e.preventDefault(); createAndSelectTag(); }
              if (e.key === 'Escape') { setAddingTag(false); setNewTagName(''); }
            }}
            placeholder="Nome da etiqueta…"
            maxLength={40}
            className="w-44 px-2.5 py-1 rounded-full text-xs bg-background border border-border focus:outline-none focus:ring-2 focus:ring-primary/30"
          />
          <button
            type="button"
            onClick={createAndSelectTag}
            disabled={!newTagName.trim() || creatingTag}
            title="Criar etiqueta"
            className="inline-flex items-center justify-center w-6 h-6 rounded-full bg-primary text-primary-foreground disabled:opacity-50"
          >
            {creatingTag ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />}
          </button>
          <button
            type="button"
            onClick={() => { setAddingTag(false); setNewTagName(''); }}
            title="Cancelar"
            className="inline-flex items-center justify-center w-6 h-6 rounded-full border border-border text-muted-foreground hover:bg-accent"
          >
            <X size={12} />
          </button>
        </span>
      ) : (
        <button
          type="button"
          onClick={() => setAddingTag(true)}
          className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-medium border border-dashed border-border text-muted-foreground hover:border-primary hover:text-primary transition-colors"
        >
          <Plus size={12} /> Nova
        </button>
      )}
    </div>
  );
}

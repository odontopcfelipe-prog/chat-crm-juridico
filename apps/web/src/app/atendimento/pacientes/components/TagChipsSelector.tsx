'use client';

/**
 * TagChipsSelector — seletor de etiquetas dos modais de paciente (Onda 17.35).
 *
 * Mostra SÓ as etiquetas selecionadas como chips (pedido do dono do produto:
 * sem poluir com todas as opções). Pra adicionar, o chip "+ Etiqueta" abre um
 * popover com as disponíveis do tenant + campo de criar nova na hora.
 * "Paciente Antigo" aparece sempre no topo do popover — se ainda não existe
 * no tenant, é criada sob demanda ao clicar (id sentinela '__antigo__').
 *
 * Compartilhado entre NewPatientModal e EditPatientModal. O pai controla
 * selectedTagIds; onChange devolve também se "Paciente Antigo" está marcado
 * (o cadastro usa isso pra liberar CPF/CEP).
 */
import { useEffect, useRef, useState } from 'react';
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
  const [pickerOpen, setPickerOpen] = useState(false);
  const [creatingAntigo, setCreatingAntigo] = useState(false);
  const [newTagName, setNewTagName] = useState('');
  const [creatingTag, setCreatingTag] = useState(false);
  const popoverRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    api.get<PatientTag[]>('/patient-tags')
      .then((r) => setAllTags(r.data || []))
      .catch(() => {}); // sem etiquetas não impede o formulário
  }, []);

  // Fecha o popover ao clicar fora
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

  const pacienteAntigoTag = allTags.find(
    (t) => t.name.trim().toLowerCase() === PACIENTE_ANTIGO_NAME.toLowerCase(),
  );

  const emit = (ids: string[]) => {
    const antigo = !!pacienteAntigoTag && ids.includes(pacienteAntigoTag.id);
    onChange(ids, antigo);
  };

  const addTag = (id: string) => {
    if (!selectedTagIds.includes(id)) emit([...selectedTagIds, id]);
  };
  const removeTag = (id: string) => emit(selectedTagIds.filter((x) => x !== id));

  // "Paciente Antigo": se já existe, marca; senão cria sob demanda e marca.
  const addAntigo = async () => {
    if (creatingAntigo) return; // guard: evita 2 POSTs em clique duplo
    if (pacienteAntigoTag) {
      addTag(pacienteAntigoTag.id);
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
    const existing = allTags.find((t) => t.name.trim().toLowerCase() === name.toLowerCase());
    if (existing) {
      addTag(existing.id);
      setNewTagName('');
      return;
    }
    setCreatingTag(true);
    try {
      const { data } = await api.post<PatientTag>('/patient-tags', { name, color: colorForName(name) });
      setAllTags((prev) => [...prev, data]);
      emit([...selectedTagIds, data.id]);
      setNewTagName('');
    } catch (err: any) {
      // Corrida/duplicada — recarrega e marca a existente.
      try {
        const { data: list } = await api.get<PatientTag[]>('/patient-tags');
        setAllTags(list || []);
        const found = (list || []).find((t) => t.name.trim().toLowerCase() === name.toLowerCase());
        if (found) {
          if (!selectedTagIds.includes(found.id)) emit([...selectedTagIds, found.id]);
          setNewTagName('');
        } else showError(err?.response?.data?.message || 'Erro ao criar etiqueta');
      } catch {
        showError(err?.response?.data?.message || 'Erro ao criar etiqueta');
      }
    } finally {
      setCreatingTag(false);
    }
  };

  const selectedTags = selectedTagIds
    .map((id) => allTags.find((t) => t.id === id))
    .filter(Boolean) as PatientTag[];

  // Disponíveis no popover: "Paciente Antigo" sempre no topo (real ou a criar)
  const antigoAvailable = !pacienteAntigoTag || !selectedTagIds.includes(pacienteAntigoTag.id);
  const otherAvailable = allTags.filter(
    (t) => !selectedTagIds.includes(t.id) && t.id !== pacienteAntigoTag?.id,
  );

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {/* Só as marcadas aparecem — chip preenchida com X pra remover */}
      {selectedTags.map((t) => {
        const color = t.color || '#64748b';
        return (
          <span
            key={t.id}
            title={t.description || t.name}
            className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium border"
            style={{ backgroundColor: color, borderColor: color, color: '#fff' }}
          >
            <span className="w-2 h-2 rounded-full shrink-0 bg-white" />
            {t.name}
            <button
              type="button"
              onClick={() => removeTag(t.id)}
              title="Remover etiqueta"
              className="ml-0.5 hover:bg-white/20 rounded-full p-0.5"
            >
              <X size={11} />
            </button>
          </span>
        );
      })}

      {/* "+ Etiqueta" abre o popover com as disponíveis + criar nova */}
      <div className="relative" ref={popoverRef}>
        <button
          type="button"
          onClick={() => setPickerOpen((v) => !v)}
          className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-medium border border-dashed border-border text-muted-foreground hover:border-primary hover:text-primary transition-colors"
        >
          <Plus size={12} /> Etiqueta
        </button>

        {pickerOpen && (
          <div className="absolute top-full mt-1 left-0 z-50 w-60 bg-card border border-border rounded-lg shadow-2xl p-1.5">
            <div className="max-h-44 overflow-y-auto">
              {/* Paciente Antigo sempre no topo — cria sob demanda se preciso */}
              {antigoAvailable && (
                <button
                  type="button"
                  onClick={addAntigo}
                  disabled={creatingAntigo}
                  title="Paciente cadastrado da base antiga (fichas de papel, pré-sistema)"
                  className="w-full text-left px-2 py-1.5 rounded text-xs hover:bg-accent flex items-center gap-2 disabled:opacity-60"
                >
                  {creatingAntigo ? (
                    <Loader2 size={11} className="animate-spin shrink-0" />
                  ) : (
                    <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ backgroundColor: PACIENTE_ANTIGO_COLOR }} />
                  )}
                  <span className="truncate font-medium">{PACIENTE_ANTIGO_NAME}</span>
                </button>
              )}
              {otherAvailable.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => addTag(t.id)}
                  title={t.description || undefined}
                  className="w-full text-left px-2 py-1.5 rounded text-xs hover:bg-accent flex items-center gap-2"
                >
                  <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ backgroundColor: t.color || '#64748b' }} />
                  <span className="truncate">{t.name}</span>
                </button>
              ))}
              {!antigoAvailable && otherAvailable.length === 0 && (
                <div className="p-2 text-center text-xs text-muted-foreground">
                  Todas as etiquetas já estão marcadas.
                </div>
              )}
            </div>

            {/* Criar etiqueta nova na hora */}
            <div className="border-t border-border mt-1.5 pt-1.5 flex items-center gap-1">
              <input
                value={newTagName}
                onChange={(e) => setNewTagName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') { e.preventDefault(); createAndSelectTag(); }
                  if (e.key === 'Escape') setPickerOpen(false);
                }}
                placeholder="Criar nova etiqueta…"
                maxLength={40}
                className="flex-1 px-2 py-1.5 rounded bg-background border border-border text-xs focus:outline-none focus:ring-2 focus:ring-primary/30"
              />
              <button
                type="button"
                onClick={createAndSelectTag}
                disabled={!newTagName.trim() || creatingTag}
                title="Criar etiqueta"
                className="inline-flex items-center justify-center w-7 h-7 rounded bg-primary text-primary-foreground disabled:opacity-50 shrink-0"
              >
                {creatingTag ? <Loader2 size={12} className="animate-spin" /> : <Check size={13} />}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

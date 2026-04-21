'use client';

import { useCallback, useEffect, useState } from 'react';
import { Tag, Loader2, Plus, X, Edit2, Trash2 } from 'lucide-react';
import api from '@/lib/api';
import { showError, showSuccess } from '@/lib/toast';

interface Marker {
  id: string;
  name: string;
  color: string | null;
  active: boolean;
  _count?: { assignments: number };
}

const SUGGESTED = [
  { name: 'Primeira consulta', color: '#28A745' },
  { name: 'Indicacao',         color: '#2196F3' },
  { name: 'VIP',               color: '#FFC107' },
  { name: 'Retorno 3 meses',   color: '#9C27B0' },
  { name: 'Retorno 6 meses',   color: '#9C27B0' },
  { name: 'Estetica facial',   color: '#F58220' },
  { name: 'Plano',             color: '#607D8B' },
];

export default function MarkersSettingsPage() {
  const [loading, setLoading] = useState(true);
  const [markers, setMarkers] = useState<Marker[]>([]);
  const [editing, setEditing] = useState<Marker | null>(null);
  const [openModal, setOpenModal] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const { data } = await api.get<Marker[]>('/appointment-markers');
      setMarkers(data || []);
    } catch (err: any) {
      showError(err?.response?.data?.message || 'Erro ao carregar marcadores');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const archive = async (id: string, name: string) => {
    if (!confirm(`Arquivar o marcador "${name}"? Vinculos antigos sao preservados.`)) return;
    try {
      await api.delete(`/appointment-markers/${id}`);
      showSuccess('Marcador arquivado');
      load();
    } catch (err: any) {
      showError(err?.response?.data?.message || 'Erro ao arquivar');
    }
  };

  const seedSuggested = async () => {
    if (!confirm('Criar marcadores sugeridos (Primeira consulta, Indicacao, VIP, Retornos 3m/6m, Estetica facial, Plano)?')) return;
    let created = 0;
    for (const s of SUGGESTED) {
      try {
        await api.post('/appointment-markers', s);
        created++;
      } catch {
        // ignora — ja existe (unique constraint tenant_id+name)
      }
    }
    showSuccess(`${created} marcadores criados (existentes ignorados)`);
    load();
  };

  return (
    <div className="p-6 max-w-4xl mx-auto">
      <div className="mb-6 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-foreground flex items-center gap-2">
            <Tag size={26} className="text-primary" /> Marcadores de agendamento
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            Tags reutilizaveis para classificar agendamentos (Indicacao, VIP, Plano X, Primeira consulta).
          </p>
        </div>
        <div className="flex gap-2">
          {markers.length === 0 && (
            <button
              onClick={seedSuggested}
              className="inline-flex items-center gap-1 px-3 py-2 rounded-lg border border-border text-sm hover:bg-accent"
            >
              + Sugeridos
            </button>
          )}
          <button
            onClick={() => { setEditing(null); setOpenModal(true); }}
            className="inline-flex items-center gap-1 px-4 py-2 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90"
          >
            <Plus size={16} /> Novo marcador
          </button>
        </div>
      </div>

      {loading ? (
        <div className="p-12 flex items-center justify-center text-muted-foreground">
          <Loader2 size={20} className="animate-spin mr-2" /> Carregando...
        </div>
      ) : markers.length === 0 ? (
        <div className="p-12 text-center text-sm text-muted-foreground">
          <Tag size={28} className="mx-auto mb-2 opacity-50" />
          <p>Nenhum marcador cadastrado.</p>
          <p className="text-xs mt-1">Use o botao "+ Sugeridos" para comecar com um conjunto basico.</p>
        </div>
      ) : (
        <div className="bg-card border border-border rounded-xl overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-muted/30 text-left text-xs uppercase tracking-wide text-muted-foreground">
                <th className="px-3 py-2">Marcador</th>
                <th className="px-3 py-2 text-right">Usos</th>
                <th className="px-3 py-2">Status</th>
                <th className="px-3 py-2 text-right">Acoes</th>
              </tr>
            </thead>
            <tbody>
              {markers.map((m) => (
                <tr key={m.id} className="border-b border-border last:border-0 hover:bg-accent/30">
                  <td className="px-3 py-2">
                    <span
                      className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded text-xs font-medium border"
                      style={{
                        backgroundColor: m.color ? `${m.color}20` : undefined,
                        color: m.color || undefined,
                        borderColor: m.color ? `${m.color}40` : undefined,
                      }}
                    >
                      {m.color && (
                        <span
                          className="inline-block w-2 h-2 rounded-full"
                          style={{ backgroundColor: m.color }}
                        />
                      )}
                      {m.name}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-right text-xs text-muted-foreground">
                    {m._count?.assignments ?? 0}
                  </td>
                  <td className="px-3 py-2">
                    {m.active ? (
                      <span className="text-xs text-green-700">Ativo</span>
                    ) : (
                      <span className="text-xs text-muted-foreground">Inativo</span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-right">
                    <div className="inline-flex gap-1">
                      <button
                        onClick={() => { setEditing(m); setOpenModal(true); }}
                        className="p-1.5 rounded hover:bg-accent"
                        title="Editar"
                      >
                        <Edit2 size={14} />
                      </button>
                      {m.active && (
                        <button
                          onClick={() => archive(m.id, m.name)}
                          className="p-1.5 rounded hover:bg-destructive/10 text-destructive"
                          title="Arquivar"
                        >
                          <Trash2 size={14} />
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {openModal && (
        <MarkerModal
          marker={editing}
          onClose={() => { setOpenModal(false); setEditing(null); }}
          onSaved={() => { setOpenModal(false); setEditing(null); load(); }}
        />
      )}
    </div>
  );
}

function MarkerModal({
  marker, onClose, onSaved,
}: { marker: Marker | null; onClose: () => void; onSaved: () => void }) {
  const [saving, setSaving] = useState(false);
  const [name, setName] = useState(marker?.name || '');
  const [color, setColor] = useState(marker?.color || '#28A745');

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) {
      showError('Nome e obrigatorio');
      return;
    }
    setSaving(true);
    try {
      const payload = { name: name.trim(), color: color || undefined };
      if (marker) {
        await api.patch(`/appointment-markers/${marker.id}`, payload);
        showSuccess('Marcador atualizado');
      } else {
        await api.post('/appointment-markers', payload);
        showSuccess('Marcador cadastrado');
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
          <h2 className="text-lg font-semibold flex items-center gap-2">
            <Tag size={20} className="text-primary" /> {marker ? 'Editar marcador' : 'Novo marcador'}
          </h2>
          <button onClick={onClose} className="p-1 hover:bg-accent rounded">
            <X size={18} />
          </button>
        </div>

        <form onSubmit={submit} className="p-4 space-y-3">
          <div>
            <label className="block text-xs font-medium mb-1">Nome *</label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Indicacao, VIP, Plano Basico..."
              autoFocus
              className="w-full px-3 py-2 rounded-lg bg-background border border-border text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
            />
          </div>

          <div>
            <label className="block text-xs font-medium mb-1">Cor do badge</label>
            <div className="flex gap-2 items-center">
              <input
                type="color"
                value={color}
                onChange={(e) => setColor(e.target.value)}
                className="h-9 w-16 rounded border border-border cursor-pointer"
              />
              <input
                type="text"
                value={color}
                onChange={(e) => setColor(e.target.value)}
                className="flex-1 px-3 py-2 rounded-lg bg-background border border-border text-sm font-mono focus:outline-none focus:ring-2 focus:ring-primary/30"
              />
            </div>
          </div>

          {/* Preview */}
          <div className="p-3 bg-background border border-border rounded-lg">
            <p className="text-xs text-muted-foreground mb-2">Preview:</p>
            <span
              className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded text-xs font-medium border"
              style={{
                backgroundColor: `${color}20`,
                color: color,
                borderColor: `${color}40`,
              }}
            >
              <span
                className="inline-block w-2 h-2 rounded-full"
                style={{ backgroundColor: color }}
              />
              {name || 'Nome do marcador'}
            </span>
          </div>

          <div className="flex justify-end gap-2 pt-3 border-t border-border">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 rounded-lg border border-border text-sm font-medium hover:bg-accent"
            >
              Cancelar
            </button>
            <button
              type="submit"
              disabled={saving}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 disabled:opacity-50"
            >
              {saving ? <Loader2 size={16} className="animate-spin" /> : <Plus size={16} />}
              {marker ? 'Atualizar' : 'Cadastrar'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

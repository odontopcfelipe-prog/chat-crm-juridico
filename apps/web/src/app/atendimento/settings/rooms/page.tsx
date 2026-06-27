'use client';

import { useCallback, useEffect, useState } from 'react';
import { DoorOpen, Loader2, Plus, X, Edit2, Trash2 } from 'lucide-react';
import api from '@/lib/api';
import { showError, showSuccess } from '@/lib/toast';

interface Room {
  id: string;
  name: string;
  description: string | null;
  color: string | null;
  capacity: number;
  active: boolean;
}

export default function RoomsSettingsPage() {
  const [loading, setLoading] = useState(true);
  const [rooms, setRooms] = useState<Room[]>([]);
  const [editing, setEditing] = useState<Room | null>(null);
  const [openModal, setOpenModal] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const { data } = await api.get<Room[]>('/rooms');
      setRooms(data || []);
    } catch (err: any) {
      showError(err?.response?.data?.message || 'Erro ao carregar salas');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const archive = async (id: string, name: string) => {
    if (!confirm(`Arquivar a sala "${name}"? Agendamentos antigos sao preservados.`)) return;
    try {
      await api.delete(`/rooms/${id}`);
      showSuccess('Sala arquivada');
      load();
    } catch (err: any) {
      showError(err?.response?.data?.message || 'Erro ao arquivar');
    }
  };

  return (
    <div className="h-full overflow-y-auto p-6 max-w-4xl mx-auto">
      <div className="mb-6 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-foreground flex items-center gap-2">
            <DoorOpen size={26} className="text-primary" /> Salas e cadeiras
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            Recursos fisicos reservaveis na agenda (cadeira odontologica, sala HOF, sala cirurgica).
          </p>
        </div>
        <button
          onClick={() => { setEditing(null); setOpenModal(true); }}
          className="inline-flex items-center gap-1 px-4 py-2 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90"
        >
          <Plus size={16} /> Nova sala
        </button>
      </div>

      {loading ? (
        <div className="p-12 flex items-center justify-center text-muted-foreground">
          <Loader2 size={20} className="animate-spin mr-2" /> Carregando...
        </div>
      ) : rooms.length === 0 ? (
        <div className="p-12 text-center text-sm text-muted-foreground">
          <DoorOpen size={28} className="mx-auto mb-2 opacity-50" />
          Nenhuma sala cadastrada.
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {rooms.map((r) => (
            <div key={r.id} className="bg-card border border-border rounded-xl p-4">
              <div className="flex items-start justify-between mb-2">
                <div className="flex items-center gap-2">
                  {r.color && (
                    <span
                      className="inline-block w-4 h-4 rounded-full border border-border"
                      style={{ backgroundColor: r.color }}
                    />
                  )}
                  <h3 className="font-semibold text-foreground">{r.name}</h3>
                </div>
                {!r.active && (
                  <span className="text-xs px-2 py-0.5 rounded bg-muted text-muted-foreground">
                    Inativa
                  </span>
                )}
              </div>
              {r.description && (
                <p className="text-xs text-muted-foreground mb-3">{r.description}</p>
              )}
              <div className="flex items-center justify-between text-xs">
                <span className="text-muted-foreground">Capacidade: {r.capacity}</span>
                <div className="flex gap-1">
                  <button
                    onClick={() => { setEditing(r); setOpenModal(true); }}
                    className="p-1.5 rounded hover:bg-accent"
                    title="Editar"
                  >
                    <Edit2 size={14} />
                  </button>
                  {r.active && (
                    <button
                      onClick={() => archive(r.id, r.name)}
                      className="p-1.5 rounded hover:bg-destructive/10 text-destructive"
                      title="Arquivar"
                    >
                      <Trash2 size={14} />
                    </button>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {openModal && (
        <RoomModal
          room={editing}
          onClose={() => { setOpenModal(false); setEditing(null); }}
          onSaved={() => { setOpenModal(false); setEditing(null); load(); }}
        />
      )}
    </div>
  );
}

function RoomModal({
  room, onClose, onSaved,
}: { room: Room | null; onClose: () => void; onSaved: () => void }) {
  const [saving, setSaving] = useState(false);
  const [name, setName] = useState(room?.name || '');
  const [description, setDescription] = useState(room?.description || '');
  const [color, setColor] = useState(room?.color || '#F58220');
  const [capacity, setCapacity] = useState(String(room?.capacity || 1));

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) {
      showError('Nome e obrigatorio');
      return;
    }
    setSaving(true);
    try {
      const payload = {
        name: name.trim(),
        description: description.trim() || undefined,
        color: color || undefined,
        capacity: parseInt(capacity, 10) || 1,
      };
      if (room) {
        await api.patch(`/rooms/${room.id}`, payload);
        showSuccess('Sala atualizada');
      } else {
        await api.post('/rooms', payload);
        showSuccess('Sala cadastrada');
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
            <DoorOpen size={20} className="text-primary" /> {room ? 'Editar sala' : 'Nova sala'}
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
              placeholder="Cadeira 1, Sala HOF, Sala Cirurgia..."
              autoFocus
              className="w-full px-3 py-2 rounded-lg bg-background border border-border text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
            />
          </div>

          <div>
            <label className="block text-xs font-medium mb-1">Descricao</label>
            <input
              type="text"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Atendimento geral, equipamento especifico..."
              className="w-full px-3 py-2 rounded-lg bg-background border border-border text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium mb-1">Cor (badge na agenda)</label>
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
            <div>
              <label className="block text-xs font-medium mb-1">Capacidade</label>
              <input
                type="number"
                min="1"
                max="20"
                value={capacity}
                onChange={(e) => setCapacity(e.target.value)}
                className="w-full px-3 py-2 rounded-lg bg-background border border-border text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
              />
            </div>
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
              {room ? 'Atualizar' : 'Cadastrar'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

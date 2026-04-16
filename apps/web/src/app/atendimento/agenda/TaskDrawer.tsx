'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  X, CheckCircle2, Circle, Plus, Trash2, Loader2,
  CalendarDays, User, Briefcase, MessageSquare,
  CheckSquare, ChevronRight, Pencil, Check,
} from 'lucide-react';
import api from '@/lib/api';
import { showError, showSuccess } from '@/lib/toast';

// ─── Tipos ────────────────────────────────────────────────────────────────────

interface ChecklistItem {
  id: string;
  text: string;
  done: boolean;
  position: number;
}

interface Comment {
  id: string;
  text: string;
  created_at: string;
  user: { id: string; name: string };
}

interface TaskDetail {
  id: string;
  title: string;
  description: string | null;
  status: string;
  due_at: string | null;
  assigned_user: { id: string; name: string } | null;
  lead: { id: string; name: string | null; phone: string } | null;
  legal_case: { id: string; case_number: string | null } | null;
  checklist_items: ChecklistItem[];
  comments: Comment[];
  _count: { comments: number; checklist_items: number };
}

const STATUS_CONFIG: Record<string, { label: string; color: string; bg: string }> = {
  A_FAZER:      { label: 'A Fazer',      color: 'text-blue-400',  bg: 'bg-blue-400/10'  },
  EM_PROGRESSO: { label: 'Em Progresso', color: 'text-amber-400', bg: 'bg-amber-400/10' },
  CONCLUIDA:    { label: 'Concluída',    color: 'text-green-400', bg: 'bg-green-400/10' },
  CANCELADA:    { label: 'Cancelada',    color: 'text-red-400',   bg: 'bg-red-400/10'   },
};

const STATUS_CYCLE: Record<string, string> = {
  A_FAZER: 'EM_PROGRESSO', EM_PROGRESSO: 'CONCLUIDA',
  CONCLUIDA: 'A_FAZER',    CANCELADA: 'A_FAZER',
};

// ─── Componente ───────────────────────────────────────────────────────────────

export function TaskDrawer({
  taskId,
  onClose,
  onStatusChange,
}: {
  taskId: string;
  onClose: () => void;
  onStatusChange?: (id: string, status: string) => void;
}) {
  const [task, setTask] = useState<TaskDetail | null>(null);
  const [loading, setLoading] = useState(true);

  // Checklist
  const [newItem, setNewItem] = useState('');
  const [addingItem, setAddingItem] = useState(false);

  // Comentários
  const [newComment, setNewComment] = useState('');
  const [sendingComment, setSendingComment] = useState(false);
  const commentsEndRef = useRef<HTMLDivElement>(null);

  // Edição inline
  type EditField = 'title' | 'description' | 'due_at';
  const [editingField, setEditingField] = useState<EditField | null>(null);
  const [editValue, setEditValue] = useState('');

  // ─── Fetch task detail ──────────────────────────────────────────────────────

  const fetchTask = useCallback(async () => {
    try {
      const res = await api.get(`/tasks/${taskId}`);
      setTask(res.data);
    } catch {
      showError('Erro ao carregar tarefa');
    } finally {
      setLoading(false);
    }
  }, [taskId]);

  useEffect(() => { fetchTask(); }, [fetchTask]);

  useEffect(() => {
    commentsEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [task?.comments?.length]);

  // ─── Handlers ──────────────────────────────────────────────────────────────

  const handleCycleStatus = async () => {
    if (!task) return;
    const next = STATUS_CYCLE[task.status] ?? 'A_FAZER';
    try {
      await api.patch(`/tasks/${task.id}/status`, { status: next });
      setTask(prev => prev ? { ...prev, status: next } : prev);
      onStatusChange?.(task.id, next);
      showSuccess(`Status → ${STATUS_CONFIG[next]?.label}`);
    } catch { showError('Erro ao atualizar status'); }
  };

  const handleMarkComplete = async () => {
    if (!task) return;
    try {
      // Tentar como CalendarEvent primeiro, depois como Task
      await api.patch(`/calendar/events/${task.id}/status`, { status: 'CONCLUIDO' }).catch(() =>
        api.patch(`/tasks/${task.id}/status`, { status: 'CONCLUIDA' })
      );
      setTask(prev => prev ? { ...prev, status: 'CONCLUIDA' } : prev);
      onStatusChange?.(task.id, 'CONCLUIDA');
      showSuccess('Tarefa concluída!');
    } catch { showError('Erro ao concluir tarefa'); }
  };

  const [deleting, setDeleting] = useState(false);
  const handleDeleteTask = async () => {
    if (!task || !confirm('Excluir esta tarefa permanentemente?')) return;
    setDeleting(true);
    try {
      await api.delete(`/calendar/events/${task.id}`).catch(() =>
        api.delete(`/tasks/${task.id}`)
      );
      showSuccess('Tarefa excluída');
      onClose();
      onStatusChange?.(task.id, 'DELETED');
    } catch { showError('Erro ao excluir tarefa'); }
    finally { setDeleting(false); }
  };

  const handleAddChecklistItem = async () => {
    if (!newItem.trim() || !task) return;
    setAddingItem(true);
    try {
      const res = await api.post(`/tasks/${task.id}/checklist`, { text: newItem.trim() });
      setTask(prev => prev ? { ...prev, checklist_items: [...prev.checklist_items, res.data] } : prev);
      setNewItem('');
    } catch { showError('Erro ao adicionar item'); }
    finally { setAddingItem(false); }
  };

  const handleToggleItem = async (item: ChecklistItem) => {
    if (!task) return;
    try {
      await api.patch(`/tasks/${task.id}/checklist/${item.id}`, { done: !item.done });
      setTask(prev => prev ? {
        ...prev,
        checklist_items: prev.checklist_items.map(i =>
          i.id === item.id ? { ...i, done: !i.done } : i
        ),
      } : prev);
    } catch { showError('Erro ao atualizar item'); }
  };

  const handleDeleteItem = async (itemId: string) => {
    if (!task) return;
    try {
      await api.delete(`/tasks/${task.id}/checklist/${itemId}`);
      setTask(prev => prev ? {
        ...prev,
        checklist_items: prev.checklist_items.filter(i => i.id !== itemId),
      } : prev);
    } catch { showError('Erro ao remover item'); }
  };

  const startEdit = (field: EditField) => {
    if (!task) return;
    setEditingField(field);
    if (field === 'due_at') {
      // datetime-local format: YYYY-MM-DDTHH:mm
      setEditValue(task.due_at ? task.due_at.slice(0, 16) : '');
    } else {
      setEditValue((task[field] as string) ?? '');
    }
  };

  const handleSaveField = async () => {
    if (!task || !editingField) return;
    const payload: Record<string, string | null> = {};
    if (editingField === 'title' && !editValue.trim()) { setEditingField(null); return; }
    if (editingField === 'due_at') {
      payload.due_at = editValue ? new Date(editValue).toISOString() : null;
    } else {
      payload[editingField] = editValue.trim() || null;
    }
    try {
      await api.patch(`/tasks/${task.id}`, payload);
      setTask(prev => prev ? { ...prev, ...payload } as TaskDetail : prev);
      showSuccess('Tarefa atualizada');
    } catch { showError('Erro ao salvar'); }
    setEditingField(null);
  };

  const handleAddComment = async () => {
    if (!newComment.trim() || !task) return;
    setSendingComment(true);
    try {
      const res = await api.post(`/tasks/${task.id}/comments`, { text: newComment.trim() });
      setTask(prev => prev ? { ...prev, comments: [...prev.comments, res.data] } : prev);
      setNewComment('');
    } catch { showError('Erro ao adicionar comentário'); }
    finally { setSendingComment(false); }
  };

  // ─── Render ────────────────────────────────────────────────────────────────

  const doneCount = task?.checklist_items.filter(i => i.done).length ?? 0;
  const totalCount = task?.checklist_items.length ?? 0;
  const progressPct = totalCount > 0 ? Math.round((doneCount / totalCount) * 100) : 0;

  return (
    <>
      {/* Overlay */}
      <div
        className="fixed inset-0 z-[200] bg-black/30 backdrop-blur-sm"
        onClick={onClose}
      />

      {/* Drawer */}
      <div className="fixed right-0 top-0 bottom-0 z-[201] w-full max-w-md bg-card border-l border-border shadow-2xl flex flex-col animate-in slide-in-from-right-5 duration-200">

        {/* Header */}
        <div className="shrink-0 flex items-center gap-3 px-5 py-4 border-b border-border">
          {loading ? (
            <Loader2 size={16} className="animate-spin text-primary" />
          ) : (
            <button
              onClick={handleCycleStatus}
              title={`Status: ${STATUS_CONFIG[task?.status ?? 'A_FAZER']?.label}`}
              className="shrink-0"
            >
              {task?.status === 'CONCLUIDA' || task?.status === 'CANCELADA'
                ? <CheckCircle2 size={20} className="text-green-400" />
                : <Circle size={20} className="text-muted-foreground/40 hover:text-primary transition-colors" />
              }
            </button>
          )}
          {editingField === 'title' ? (
            <input
              autoFocus
              value={editValue}
              onChange={e => setEditValue(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') handleSaveField(); if (e.key === 'Escape') setEditingField(null); }}
              onBlur={handleSaveField}
              className="flex-1 text-sm font-semibold bg-transparent border-b border-primary outline-none text-foreground"
            />
          ) : (
            <h2
              className="flex-1 text-sm font-semibold text-foreground truncate cursor-text hover:text-primary transition-colors"
              onClick={() => !loading && startEdit('title')}
              title="Clique para editar"
            >
              {loading ? 'Carregando...' : task?.title ?? 'Tarefa'}
            </h2>
          )}
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
          >
            <X size={16} />
          </button>
        </div>

        {loading ? (
          <div className="flex-1 flex items-center justify-center">
            <Loader2 size={28} className="animate-spin text-primary/40" />
          </div>
        ) : task ? (
          <>
          <div className="flex-1 overflow-y-auto custom-scrollbar">

            {/* Meta */}
            <div className="px-5 py-4 space-y-2 border-b border-border/50">
              <div className="flex items-center gap-2 flex-wrap">
                {/* Status badge */}
                {(() => {
                  const cfg = STATUS_CONFIG[task.status] ?? STATUS_CONFIG.A_FAZER;
                  return (
                    <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${cfg.bg} ${cfg.color}`}>
                      {cfg.label}
                    </span>
                  );
                })()}

                {/* Due date — editável */}
                {editingField === 'due_at' ? (
                  <input
                    autoFocus
                    type="datetime-local"
                    value={editValue}
                    onChange={e => setEditValue(e.target.value)}
                    onBlur={handleSaveField}
                    onKeyDown={e => { if (e.key === 'Enter') handleSaveField(); if (e.key === 'Escape') setEditingField(null); }}
                    className="text-[11px] bg-background border border-primary/40 rounded-lg px-2 py-0.5 outline-none text-foreground"
                  />
                ) : (
                  <button
                    onClick={() => startEdit('due_at')}
                    className={`flex items-center gap-1 text-[11px] font-semibold hover:opacity-80 transition-opacity group ${
                      task.due_at && new Date(task.due_at) < new Date() && task.status !== 'CONCLUIDA'
                        ? 'text-red-400' : 'text-muted-foreground'
                    }`}
                    title="Clique para editar prazo"
                  >
                    <CalendarDays size={10} />
                    {task.due_at
                      ? new Date(task.due_at).toLocaleDateString('pt-BR', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })
                      : <span className="opacity-50">Sem prazo</span>
                    }
                    <Pencil size={8} className="opacity-0 group-hover:opacity-60 transition-opacity" />
                  </button>
                )}

                {/* Assigned */}
                {task.assigned_user && (
                  <span className="flex items-center gap-1 text-[11px] text-muted-foreground">
                    <User size={10} /> {task.assigned_user.name}
                  </span>
                )}

                {/* Lead */}
                {task.lead && (
                  <span className="flex items-center gap-1 text-[11px] text-muted-foreground">
                    <Briefcase size={10} /> {task.lead.name || task.lead.phone}
                  </span>
                )}
              </div>

              {/* Description — editável */}
              {editingField === 'description' ? (
                <textarea
                  autoFocus
                  rows={3}
                  value={editValue}
                  onChange={e => setEditValue(e.target.value)}
                  onBlur={handleSaveField}
                  onKeyDown={e => { if (e.key === 'Escape') setEditingField(null); if (e.key === 'Enter' && e.ctrlKey) handleSaveField(); }}
                  placeholder="Descrição da tarefa..."
                  className="w-full text-xs bg-background border border-primary/40 rounded-lg px-2 py-1.5 outline-none text-foreground resize-none placeholder:text-muted-foreground/40"
                />
              ) : (
                <button
                  onClick={() => startEdit('description')}
                  className="w-full text-left group"
                  title="Clique para editar descrição"
                >
                  {task.description ? (
                    <p className="text-xs text-muted-foreground leading-relaxed group-hover:text-foreground transition-colors">
                      {task.description}
                    </p>
                  ) : (
                    <p className="text-xs text-muted-foreground/30 group-hover:text-muted-foreground/60 transition-colors flex items-center gap-1">
                      <Pencil size={10} />
                      Adicionar descrição...
                    </p>
                  )}
                </button>
              )}
            </div>

            {/* ── Checklist ──────────────────────────────────────── */}
            <div className="px-5 py-4 border-b border-border/50">
              <div className="flex items-center gap-2 mb-3">
                <CheckSquare size={13} className="text-primary" />
                <span className="text-xs font-semibold text-foreground">
                  Checklist
                </span>
                {totalCount > 0 && (
                  <span className="text-[10px] text-muted-foreground ml-auto">
                    {doneCount}/{totalCount}
                  </span>
                )}
              </div>

              {/* Progress bar */}
              {totalCount > 0 && (
                <div className="h-1.5 bg-accent rounded-full mb-3 overflow-hidden">
                  <div
                    className="h-full bg-primary rounded-full transition-all duration-300"
                    style={{ width: `${progressPct}%` }}
                  />
                </div>
              )}

              {/* Items */}
              <div className="space-y-1.5">
                {task.checklist_items.map(item => (
                  <div key={item.id} className="flex items-center gap-2 group">
                    <button
                      onClick={() => handleToggleItem(item)}
                      className="shrink-0 transition-transform hover:scale-110"
                    >
                      {item.done
                        ? <CheckCircle2 size={15} className="text-green-400" />
                        : <Circle size={15} className="text-muted-foreground/40 hover:text-primary transition-colors" />
                      }
                    </button>
                    <span className={`flex-1 text-xs ${item.done ? 'line-through text-muted-foreground/50' : 'text-foreground'}`}>
                      {item.text}
                    </span>
                    <button
                      onClick={() => handleDeleteItem(item.id)}
                      className="opacity-0 group-hover:opacity-100 p-1 rounded text-muted-foreground/40 hover:text-red-400 transition-all"
                    >
                      <Trash2 size={11} />
                    </button>
                  </div>
                ))}
              </div>

              {/* Add item */}
              <div className="flex items-center gap-2 mt-2.5">
                <ChevronRight size={13} className="text-muted-foreground/40 shrink-0" />
                <input
                  value={newItem}
                  onChange={e => setNewItem(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && handleAddChecklistItem()}
                  placeholder="Adicionar item..."
                  className="flex-1 text-xs bg-transparent text-foreground placeholder:text-muted-foreground/40 outline-none"
                />
                {newItem.trim() && (
                  <button
                    onClick={handleAddChecklistItem}
                    disabled={addingItem}
                    className="shrink-0 p-1 rounded bg-primary/10 text-primary hover:bg-primary/20 transition-colors"
                  >
                    {addingItem ? <Loader2 size={11} className="animate-spin" /> : <Plus size={11} />}
                  </button>
                )}
              </div>
            </div>

            {/* ── Comentários ────────────────────────────────────── */}
            <div className="px-5 py-4">
              <div className="flex items-center gap-2 mb-3">
                <MessageSquare size={13} className="text-primary" />
                <span className="text-xs font-semibold text-foreground">
                  Comentários ({task.comments.length})
                </span>
              </div>

              <div className="space-y-3 mb-3">
                {task.comments.map(c => (
                  <div key={c.id} className="flex gap-2">
                    <div className="w-6 h-6 rounded-full bg-primary/15 flex items-center justify-center shrink-0 text-[10px] font-bold text-primary">
                      {c.user.name.charAt(0).toUpperCase()}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-1.5 mb-0.5">
                        <span className="text-[11px] font-semibold text-foreground">{c.user.name}</span>
                        <span className="text-[10px] text-muted-foreground">
                          {new Date(c.created_at).toLocaleString('pt-BR', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}
                        </span>
                      </div>
                      <p className="text-xs text-muted-foreground leading-relaxed">{c.text}</p>
                    </div>
                  </div>
                ))}
                <div ref={commentsEndRef} />
              </div>

              {/* Add comment */}
              <div className="flex items-end gap-2">
                <textarea
                  value={newComment}
                  onChange={e => setNewComment(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleAddComment(); } }}
                  placeholder="Adicionar comentário... (Enter para enviar)"
                  rows={2}
                  className="flex-1 px-3 py-2 rounded-xl border border-border bg-background text-xs text-foreground placeholder:text-muted-foreground/50 outline-none focus:ring-2 focus:ring-primary/25 resize-none"
                />
                <button
                  onClick={handleAddComment}
                  disabled={!newComment.trim() || sendingComment}
                  className="px-3 py-2 rounded-xl bg-primary text-primary-foreground text-xs font-semibold disabled:opacity-40 hover:bg-primary/90 transition-colors flex items-center gap-1"
                >
                  {sendingComment ? <Loader2 size={11} className="animate-spin" /> : <Plus size={11} />}
                </button>
              </div>
            </div>

          </div>

          {/* Footer com ações */}
          {task.status !== 'CONCLUIDA' && task.status !== 'CANCELADA' ? (
            <div className="shrink-0 border-t border-border px-5 py-3 flex items-center gap-2">
              <button
                onClick={handleMarkComplete}
                className="flex-1 flex items-center justify-center gap-1.5 px-3 py-2.5 bg-emerald-500 text-white rounded-xl text-xs font-bold hover:opacity-90 transition-opacity"
              >
                <CheckCircle2 size={14} /> Concluir Tarefa
              </button>
              <button
                onClick={handleDeleteTask}
                disabled={deleting}
                className="flex items-center justify-center gap-1.5 px-3 py-2.5 border border-red-400/30 text-red-400 rounded-xl text-xs font-bold hover:bg-red-500/10 transition-colors disabled:opacity-50"
              >
                {deleting ? <Loader2 size={14} className="animate-spin" /> : <Trash2 size={14} />} Excluir
              </button>
            </div>
          ) : (
            <div className="shrink-0 border-t border-border px-5 py-3 flex items-center gap-2">
              <div className="flex-1 text-xs text-emerald-400 font-semibold flex items-center gap-1.5">
                <CheckCircle2 size={14} /> Tarefa concluída
              </div>
              <button
                onClick={handleDeleteTask}
                disabled={deleting}
                className="flex items-center justify-center gap-1.5 px-3 py-2.5 border border-red-400/30 text-red-400 rounded-xl text-xs font-bold hover:bg-red-500/10 transition-colors disabled:opacity-50"
              >
                {deleting ? <Loader2 size={14} className="animate-spin" /> : <Trash2 size={14} />} Excluir
              </button>
            </div>
          )}
          </>
        ) : (
          <div className="flex-1 flex items-center justify-center text-sm text-muted-foreground">
            Tarefa não encontrada
          </div>
        )}
      </div>
    </>
  );
}

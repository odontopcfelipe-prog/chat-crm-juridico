'use client';

import { useState } from 'react';
import {
  CalendarDays, User, MessageSquare, AlertTriangle, CheckSquare,
} from 'lucide-react';
import api from '@/lib/api';
import { showError, showSuccess } from '@/lib/toast';

// ─── Tipos ────────────────────────────────────────────────────────────────────

interface Task {
  id: string;
  title: string;
  description: string | null;
  status: string;
  due_at: string | null;
  assigned_user: { id: string; name: string } | null;
  lead: { id: string; name: string | null; phone: string } | null;
  legal_case_id: string | null;
  _count?: { comments: number };
}

const COLUMNS: { id: string; label: string; color: string; accent: string }[] = [
  { id: 'A_FAZER',      label: 'A Fazer',      color: 'text-blue-400',  accent: 'border-blue-400/40'  },
  { id: 'EM_PROGRESSO', label: 'Em Progresso', color: 'text-amber-400', accent: 'border-amber-400/40' },
  { id: 'CONCLUIDA',    label: 'Concluída',    color: 'text-green-400', accent: 'border-green-400/40' },
  { id: 'CANCELADA',    label: 'Cancelada',    color: 'text-red-400',   accent: 'border-red-400/40'   },
];

function formatDue(due: string | null) {
  if (!due) return null;
  const d = new Date(due);
  const now = new Date();
  const diff = Math.floor((d.getTime() - now.getTime()) / 86400000);
  if (diff < -1) return { text: `${Math.abs(diff)}d atraso`, overdue: true };
  if (diff === -1) return { text: 'Ontem', overdue: true };
  if (diff === 0) return { text: 'Hoje', overdue: false };
  if (diff === 1) return { text: 'Amanhã', overdue: false };
  return { text: d.toLocaleDateString('pt-BR', { day: '2-digit', month: 'short' }), overdue: false };
}

// ─── Componente ───────────────────────────────────────────────────────────────

export function KanbanBoard({
  tasks,
  onTaskClick,
  onStatusChange,
}: {
  tasks: Task[];
  onTaskClick: (id: string) => void;
  onStatusChange: (id: string, status: string) => void;
}) {
  const [dragOverCol, setDragOverCol] = useState<string | null>(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);

  const tasksByCol = (colId: string) =>
    tasks.filter(t => t.status === colId);

  const handleDragStart = (e: React.DragEvent, taskId: string) => {
    e.dataTransfer.setData('taskId', taskId);
    setDraggingId(taskId);
  };

  const handleDrop = async (e: React.DragEvent, colId: string) => {
    e.preventDefault();
    const taskId = e.dataTransfer.getData('taskId');
    const task = tasks.find(t => t.id === taskId);
    if (!task || task.status === colId) {
      setDragOverCol(null);
      setDraggingId(null);
      return;
    }
    try {
      await api.patch(`/tasks/${taskId}/status`, { status: colId });
      onStatusChange(taskId, colId);
      showSuccess(`Movido para "${COLUMNS.find(c => c.id === colId)?.label}"`);
    } catch {
      showError('Erro ao mover tarefa');
    }
    setDragOverCol(null);
    setDraggingId(null);
  };

  return (
    <div className="flex gap-3 h-full overflow-x-auto px-6 py-4 pb-6">
      {COLUMNS.map(col => {
        const colTasks = tasksByCol(col.id);
        const isOver = dragOverCol === col.id;

        return (
          <div
            key={col.id}
            className="flex flex-col shrink-0 w-72"
            onDragOver={e => { e.preventDefault(); setDragOverCol(col.id); }}
            onDragLeave={() => setDragOverCol(null)}
            onDrop={e => handleDrop(e, col.id)}
          >
            {/* Column header */}
            <div className={`flex items-center gap-2 mb-3 px-1 py-2 rounded-xl border ${col.accent} ${isOver ? 'bg-accent/30' : 'bg-transparent'} transition-colors`}>
              <span className={`text-xs font-bold ${col.color}`}>{col.label}</span>
              <span className="ml-auto text-[11px] font-semibold text-muted-foreground bg-accent/60 px-2 py-0.5 rounded-full">
                {colTasks.length}
              </span>
            </div>

            {/* Cards */}
            <div className={`flex-1 space-y-2 min-h-[120px] rounded-xl transition-colors ${isOver ? 'bg-accent/20' : ''}`}>
              {colTasks.map(task => {
                const dueInfo = formatDue(task.due_at);
                const isDragging = draggingId === task.id;

                return (
                  <div
                    key={task.id}
                    draggable
                    onDragStart={e => handleDragStart(e, task.id)}
                    onDragEnd={() => setDraggingId(null)}
                    onClick={() => onTaskClick(task.id)}
                    className={`bg-card border border-border rounded-xl p-3 cursor-pointer hover:shadow-md hover:border-border/80 transition-all select-none group ${
                      isDragging ? 'opacity-40 scale-95' : 'opacity-100'
                    }`}
                  >
                    {/* Title */}
                    <p className={`text-xs font-semibold text-foreground mb-2 leading-snug ${
                      col.id === 'CONCLUIDA' ? 'line-through text-muted-foreground' : ''
                    }`}>
                      {task.title}
                    </p>

                    {/* Meta */}
                    <div className="flex flex-wrap items-center gap-2">
                      {dueInfo && (
                        <span className={`flex items-center gap-0.5 text-[10px] font-semibold ${
                          dueInfo.overdue ? 'text-red-400' : 'text-muted-foreground'
                        }`}>
                          {dueInfo.overdue && <AlertTriangle size={9} />}
                          <CalendarDays size={9} />
                          {dueInfo.text}
                        </span>
                      )}
                      {task.assigned_user && (
                        <span className="flex items-center gap-0.5 text-[10px] text-muted-foreground">
                          <User size={9} />
                          {task.assigned_user.name.split(' ')[0]}
                        </span>
                      )}
                      {(task._count?.comments ?? 0) > 0 && (
                        <span className="flex items-center gap-0.5 text-[10px] text-muted-foreground ml-auto">
                          <MessageSquare size={9} />
                          {task._count!.comments}
                        </span>
                      )}
                    </div>

                    {/* Lead pill */}
                    {task.lead && (
                      <div className="mt-2 inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-accent/50 text-[9px] text-muted-foreground">
                        {task.lead.name || task.lead.phone}
                      </div>
                    )}
                  </div>
                );
              })}

              {/* Drop target empty */}
              {colTasks.length === 0 && (
                <div className={`flex flex-col items-center justify-center py-8 rounded-xl border-2 border-dashed transition-colors ${
                  isOver ? 'border-primary/50 bg-primary/5' : 'border-border/30'
                }`}>
                  <CheckSquare size={20} className="text-muted-foreground/20 mb-1" />
                  <p className="text-[10px] text-muted-foreground/40">Arraste aqui</p>
                </div>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

'use client';

/**
 * Modal de gestao de bloqueios de agenda do dentista.
 *
 * Fase 25 (Onda 5e v9) — permite ADMIN e dentistas criarem janelas de
 * indisponibilidade (ferias, doenca, curso, etc). IA respeita esses
 * bloqueios em check_availability + book_appointment, garantindo que
 * pacientes nao sao agendados em periodos onde o dentista nao pode atender.
 *
 * Fluxo:
 *   1. User clica "Bloquear" no header da agenda
 *   2. Modal abre com:
 *      - Form de criacao (dentista, periodo, motivo)
 *      - Lista de bloqueios ativos do tenant (futuros)
 *   3. Criar dispara POST /calendar/blocks; remover dispara DELETE
 *   4. onClose triggera refetch dos eventos no parent (pra agenda atualizar)
 */

import { useEffect, useState } from 'react';
import { X, Trash2, Loader2, AlertCircle, Calendar as CalIcon } from 'lucide-react';
import api from '@/lib/api';
import { showError, showSuccess } from '@/lib/toast';
import { swallow } from '@/lib/errors';

interface UserOption {
  id: string;
  name: string;
}

interface ScheduleBlock {
  id: string;
  user_id: string;
  start_at: string;
  end_at: string;
  all_day: boolean;
  reason: string;
  notes?: string | null;
  user?: { id: string; name: string };
  creator?: { id: string; name: string } | null;
}

interface Props {
  open: boolean;
  onClose: () => void;
  users: UserOption[]; // dentistas pra escolher (vem do parent que ja carrega)
  currentUserId: string; // user logado, default no select
  isAdmin: boolean; // permite criar pra outros
}

const REASONS = ['Férias', 'Doença', 'Curso', 'Compromisso pessoal', 'Outros'];

export function ScheduleBlockModal({ open, onClose, users, currentUserId, isAdmin }: Props) {
  const [loading, setLoading] = useState(false);
  const [creating, setCreating] = useState(false);
  const [blocks, setBlocks] = useState<ScheduleBlock[]>([]);

  // Form state
  const [userId, setUserId] = useState(currentUserId);
  const [allDay, setAllDay] = useState(true);
  const [startDate, setStartDate] = useState('');
  const [startTime, setStartTime] = useState('08:00');
  const [endDate, setEndDate] = useState('');
  const [endTime, setEndTime] = useState('18:00');
  const [reason, setReason] = useState(REASONS[0]);
  const [reasonCustom, setReasonCustom] = useState('');
  const [notes, setNotes] = useState('');

  useEffect(() => {
    if (!open) return;
    setUserId(currentUserId);
    // default: hoje + 1 semana
    const today = new Date();
    const week = new Date();
    week.setDate(week.getDate() + 7);
    setStartDate(today.toISOString().slice(0, 10));
    setEndDate(week.toISOString().slice(0, 10));
    fetchBlocks();
  }, [open, currentUserId]);

  const fetchBlocks = async () => {
    setLoading(true);
    try {
      // Pega bloqueios futuros (a partir de hoje)
      const today = new Date().toISOString().slice(0, 10);
      const res = await api.get('/calendar/blocks', {
        params: { from: today },
      });
      setBlocks(res.data || []);
    } catch (e) {
      swallow('lazy load schedule blocks')(e);
    } finally {
      setLoading(false);
    }
  };

  const handleCreate = async () => {
    if (!userId) return showError('Selecione um dentista');
    if (!startDate || !endDate) return showError('Datas obrigatórias');
    const finalReason = reason === 'Outros' ? reasonCustom.trim() : reason;
    if (!finalReason) return showError('Informe o motivo');

    // UTC naive: monta as datas como ISO sem conversao de timezone
    const startAt = allDay
      ? `${startDate}T00:00:00.000Z`
      : `${startDate}T${startTime}:00.000Z`;
    const endAt = allDay
      ? `${endDate}T23:59:59.000Z`
      : `${endDate}T${endTime}:00.000Z`;

    if (new Date(endAt) <= new Date(startAt)) {
      return showError('Data/hora final deve ser maior que inicial');
    }

    setCreating(true);
    try {
      await api.post('/calendar/blocks', {
        user_id: userId,
        start_at: startAt,
        end_at: endAt,
        all_day: allDay,
        reason: finalReason,
        notes: notes || undefined,
      });
      showSuccess('Bloqueio criado');
      // limpa form e refetch
      setNotes('');
      setReasonCustom('');
      fetchBlocks();
    } catch (e: any) {
      showError(e?.response?.data?.message || 'Erro ao criar bloqueio');
    } finally {
      setCreating(false);
    }
  };

  const handleDelete = async (id: string) => {
    if (!confirm('Remover este bloqueio? A agenda vai liberar esse período pra novos agendamentos.')) return;
    try {
      await api.delete(`/calendar/blocks/${id}`);
      showSuccess('Bloqueio removido');
      fetchBlocks();
    } catch (e: any) {
      showError(e?.response?.data?.message || 'Erro ao remover');
    }
  };

  if (!open) return null;

  const fmtDate = (iso: string) => {
    const d = new Date(iso);
    const dd = String(d.getUTCDate()).padStart(2, '0');
    const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
    const hh = String(d.getUTCHours()).padStart(2, '0');
    const mi = String(d.getUTCMinutes()).padStart(2, '0');
    return `${dd}/${mm} ${hh}:${mi}`;
  };

  return (
    <div className="fixed inset-0 z-[100] bg-black/50 flex items-center justify-center p-4" onClick={onClose}>
      <div
        className="bg-card text-foreground rounded-2xl shadow-2xl w-full max-w-2xl max-h-[90vh] overflow-y-auto border border-border"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="sticky top-0 bg-card border-b border-border px-6 py-4 flex items-center justify-between z-10">
          <div className="flex items-center gap-2">
            <CalIcon size={20} className="text-primary" />
            <h2 className="text-lg font-bold">Bloquear agenda do dentista</h2>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg hover:bg-accent transition-colors"
            aria-label="Fechar"
          >
            <X size={18} />
          </button>
        </div>

        {/* Body */}
        <div className="p-6 space-y-6">
          {/* Aviso */}
          <div className="flex gap-2 p-3 rounded-lg bg-amber-500/10 border border-amber-500/30 text-sm">
            <AlertCircle size={16} className="text-amber-600 shrink-0 mt-0.5" />
            <p className="text-amber-900 dark:text-amber-200">
              Bloqueios impedem que a IA agende novos pacientes nesse período.
              <strong> Eventos já agendados continuam ativos</strong> — cancele manualmente se quiser.
            </p>
          </div>

          {/* Form de criacao */}
          <div className="space-y-3">
            <h3 className="text-sm font-bold uppercase tracking-wider text-muted-foreground">Novo bloqueio</h3>

            {/* Dentista */}
            <div>
              <label className="block text-xs font-semibold mb-1">Dentista</label>
              <select
                value={userId}
                onChange={(e) => setUserId(e.target.value)}
                disabled={!isAdmin}
                className="w-full px-3 py-2 rounded-lg border border-border bg-background text-sm disabled:opacity-50"
              >
                {users.map((u) => (
                  <option key={u.id} value={u.id}>{u.name}</option>
                ))}
              </select>
              {!isAdmin && (
                <p className="text-[10px] text-muted-foreground mt-1">Apenas ADMIN pode bloquear agenda de outros dentistas.</p>
              )}
            </div>

            {/* All day toggle */}
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={allDay}
                onChange={(e) => setAllDay(e.target.checked)}
                className="w-4 h-4"
              />
              <span className="text-sm">Dia inteiro (sem horários específicos)</span>
            </label>

            {/* Datas */}
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-semibold mb-1">Início</label>
                <div className="flex gap-1">
                  <input
                    type="date"
                    value={startDate}
                    onChange={(e) => setStartDate(e.target.value)}
                    className="flex-1 px-2 py-2 rounded-lg border border-border bg-background text-sm"
                  />
                  {!allDay && (
                    <input
                      type="time"
                      value={startTime}
                      onChange={(e) => setStartTime(e.target.value)}
                      className="w-24 px-2 py-2 rounded-lg border border-border bg-background text-sm"
                    />
                  )}
                </div>
              </div>
              <div>
                <label className="block text-xs font-semibold mb-1">Fim</label>
                <div className="flex gap-1">
                  <input
                    type="date"
                    value={endDate}
                    onChange={(e) => setEndDate(e.target.value)}
                    className="flex-1 px-2 py-2 rounded-lg border border-border bg-background text-sm"
                  />
                  {!allDay && (
                    <input
                      type="time"
                      value={endTime}
                      onChange={(e) => setEndTime(e.target.value)}
                      className="w-24 px-2 py-2 rounded-lg border border-border bg-background text-sm"
                    />
                  )}
                </div>
              </div>
            </div>

            {/* Motivo */}
            <div>
              <label className="block text-xs font-semibold mb-1">Motivo</label>
              <select
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                className="w-full px-3 py-2 rounded-lg border border-border bg-background text-sm"
              >
                {REASONS.map((r) => <option key={r} value={r}>{r}</option>)}
              </select>
              {reason === 'Outros' && (
                <input
                  type="text"
                  placeholder="Descreva o motivo"
                  value={reasonCustom}
                  onChange={(e) => setReasonCustom(e.target.value)}
                  className="mt-2 w-full px-3 py-2 rounded-lg border border-border bg-background text-sm"
                />
              )}
            </div>

            {/* Notes */}
            <div>
              <label className="block text-xs font-semibold mb-1">Observações <span className="text-muted-foreground font-normal">(opcional)</span></label>
              <textarea
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                rows={2}
                placeholder="Ex: Atestado médico, viagem internacional…"
                className="w-full px-3 py-2 rounded-lg border border-border bg-background text-sm resize-none"
              />
            </div>

            <button
              onClick={handleCreate}
              disabled={creating}
              className="w-full py-2.5 rounded-lg bg-primary text-primary-foreground font-semibold text-sm hover:bg-primary/90 transition-colors disabled:opacity-50 flex items-center justify-center gap-2"
            >
              {creating && <Loader2 size={14} className="animate-spin" />}
              Criar bloqueio
            </button>
          </div>

          {/* Lista de bloqueios ativos */}
          <div className="space-y-2">
            <h3 className="text-sm font-bold uppercase tracking-wider text-muted-foreground">Bloqueios ativos</h3>
            {loading ? (
              <div className="flex items-center justify-center py-8 text-muted-foreground">
                <Loader2 size={16} className="animate-spin mr-2" /> Carregando…
              </div>
            ) : blocks.length === 0 ? (
              <p className="text-sm text-muted-foreground italic py-4 text-center">Nenhum bloqueio futuro.</p>
            ) : (
              <ul className="space-y-1.5">
                {blocks.map((b) => (
                  <li
                    key={b.id}
                    className="flex items-center justify-between gap-2 p-3 rounded-lg border border-border bg-background"
                  >
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-semibold text-sm">{b.user?.name || '?'}</span>
                        <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-amber-500/15 text-amber-700 dark:text-amber-300">
                          {b.reason}
                        </span>
                        {b.all_day && (
                          <span className="text-[10px] text-muted-foreground">DIA INTEIRO</span>
                        )}
                      </div>
                      <p className="text-xs text-muted-foreground mt-0.5">
                        {fmtDate(b.start_at)} — {fmtDate(b.end_at)}
                      </p>
                      {b.notes && <p className="text-xs italic mt-1">{b.notes}</p>}
                    </div>
                    <button
                      onClick={() => handleDelete(b.id)}
                      className="p-2 rounded-lg text-destructive hover:bg-destructive/10 transition-colors shrink-0"
                      title="Remover bloqueio"
                    >
                      <Trash2 size={14} />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

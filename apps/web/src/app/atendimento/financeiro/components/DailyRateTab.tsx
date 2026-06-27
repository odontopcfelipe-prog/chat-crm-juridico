'use client';

/**
 * DailyRateTab — Fase 5 (Lançar Diária).
 *
 * Form pra lançar a DIÁRIA de um profissional como DESPESA no caixa
 * (FinancialTransaction type='DESPESA', category='DIARIA'). NÃO é comissão.
 *
 * Quem usa: admin/financeiro (a aba é gateada por manage_financial no page.tsx;
 * o endpoint POST /financeiro/daily-rate também exige manage_financial).
 *
 * Profissionais vêm de GET /users — filtra os que têm daily_rate configurado.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Loader2, CalendarClock, Save } from 'lucide-react';
import api from '@/lib/api';
import { showError, showSuccess } from '@/lib/toast';

interface ProfessionalUser {
  id: string;
  name: string;
  daily_rate: string | number | null;
}

const fmtBRL = (v: number) =>
  v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

/** Data de hoje no formato YYYY-MM-DD pra <input type="date">. */
function todayStr(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export default function DailyRateTab() {
  const [loading, setLoading] = useState(true);
  const [pros, setPros] = useState<ProfessionalUser[]>([]);

  const [professionalId, setProfessionalId] = useState('');
  const [date, setDate] = useState(todayStr());
  const [isHalfDay, setIsHalfDay] = useState(false);
  const [notes, setNotes] = useState('');
  const [saving, setSaving] = useState(false);

  const fetchPros = useCallback(async () => {
    setLoading(true);
    try {
      // Endpoint tenant-scoped gateado por manage_financial — já vem só com quem tem
      // diária (não depende de GET /users, que é @Roles ADMIN).
      const r = await api.get('/financeiro/professionals-with-rate');
      const all: any[] = Array.isArray(r.data) ? r.data : r.data?.data || [];
      const withRate = all
        .filter((u) => u.daily_rate != null && Number(u.daily_rate) > 0)
        .map((u) => ({ id: u.id, name: u.name, daily_rate: u.daily_rate }));
      setPros(withRate);
    } catch (e: any) {
      const status = e?.response?.status;
      const msg = e?.response?.data?.message || e?.message || 'erro desconhecido';
      showError(`Erro ao carregar profissionais (${status || 'sem status'}): ${msg}`);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchPros();
  }, [fetchPros]);

  const selected = useMemo(
    () => pros.find((p) => p.id === professionalId) || null,
    [pros, professionalId],
  );

  const baseRate = selected ? Number(selected.daily_rate) : 0;
  const finalAmount = isHalfDay ? baseRate / 2 : baseRate;

  const resetForm = () => {
    setProfessionalId('');
    setDate(todayStr());
    setIsHalfDay(false);
    setNotes('');
  };

  const handleSubmit = async () => {
    if (!professionalId) {
      showError('Selecione um profissional');
      return;
    }
    setSaving(true);
    try {
      await api.post('/financeiro/daily-rate', {
        professional_user_id: professionalId,
        is_half_day: isHalfDay,
        date: date || undefined,
        notes: notes.trim() || undefined,
      });
      showSuccess('Diária lançada no caixa');
      resetForm();
    } catch (e: any) {
      const msg = e?.response?.data?.message || e?.message || 'Erro ao lançar diária';
      showError(Array.isArray(msg) ? msg.join(', ') : msg);
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-16">
        <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <div className="w-8 h-8 rounded-lg bg-red-500/10 flex items-center justify-center">
          <CalendarClock size={16} className="text-red-400" />
        </div>
        <div>
          <h3 className="text-sm font-bold text-foreground">Lançar diária</h3>
          <p className="text-xs text-muted-foreground">
            Registra a diária do profissional como despesa no caixa.
          </p>
        </div>
      </div>

      {pros.length === 0 ? (
        <div className="bg-card border border-border rounded-xl p-6 text-center">
          <p className="text-sm text-muted-foreground">
            Nenhum profissional com diária configurada. Defina o valor da diária em
            Configurações &rarr; Usuários.
          </p>
        </div>
      ) : (
        <div className="bg-card border border-border rounded-xl p-4 space-y-4 max-w-lg">
          {/* Profissional */}
          <div>
            <label className="block text-xs font-semibold text-muted-foreground mb-1.5">
              Profissional
            </label>
            <select
              value={professionalId}
              onChange={(e) => setProfessionalId(e.target.value)}
              className="w-full px-3 py-2 text-sm bg-background border border-border rounded-xl text-foreground focus:outline-none focus:ring-1 focus:ring-primary"
            >
              <option value="">Selecione...</option>
              {pros.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} — {fmtBRL(Number(p.daily_rate))}
                </option>
              ))}
            </select>
          </div>

          {/* Data */}
          <div>
            <label className="block text-xs font-semibold text-muted-foreground mb-1.5">
              Data
            </label>
            <input
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
              className="w-full px-3 py-2 text-sm bg-background border border-border rounded-xl text-foreground focus:outline-none focus:ring-1 focus:ring-primary"
            />
          </div>

          {/* Meia-diária */}
          <label className="flex items-center gap-2 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={isHalfDay}
              onChange={(e) => setIsHalfDay(e.target.checked)}
              className="w-4 h-4 rounded border-border accent-primary"
            />
            <span className="text-sm text-foreground">Meia-diária (50%)</span>
          </label>

          {/* Notas */}
          <div>
            <label className="block text-xs font-semibold text-muted-foreground mb-1.5">
              Notas (opcional)
            </label>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={2}
              placeholder="Ex: cobertura de plantão, troca de turno..."
              className="w-full px-3 py-2 text-sm bg-background border border-border rounded-xl text-foreground focus:outline-none focus:ring-1 focus:ring-primary resize-none"
            />
          </div>

          {/* Resumo do valor */}
          {selected && (
            <div className="flex items-center justify-between px-3 py-2 bg-red-500/5 border border-red-500/20 rounded-xl">
              <span className="text-xs text-muted-foreground font-semibold uppercase tracking-wide">
                {isHalfDay ? 'Meia-diária' : 'Diária'}
              </span>
              <span className="text-base font-bold text-red-400 tabular-nums">
                {fmtBRL(finalAmount)}
              </span>
            </div>
          )}

          {/* Submit */}
          <button
            onClick={handleSubmit}
            disabled={saving || !professionalId}
            className="w-full flex items-center justify-center gap-2 px-4 py-2.5 bg-primary text-primary-foreground rounded-xl text-sm font-bold hover:opacity-90 transition-opacity disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {saving ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <Save className="w-4 h-4" />
            )}
            Lançar diária
          </button>
        </div>
      )}
    </div>
  );
}

'use client';

/**
 * Mini-modais para CRUD rápido de alergia e medicação na aba Visão geral.
 * Mantidos juntos pra reduzir overhead — ambos compartilham padrão simples
 * e backend já existente (POST/DELETE em /patients/:id/allergies|medications).
 */
import { useState, FormEvent } from 'react';
import { X, Loader2, Plus, AlertTriangle, Pill } from 'lucide-react';
import api from '@/lib/api';
import { showError, showSuccess } from '@/lib/toast';

const inputCls = 'w-full px-3 py-2 rounded-lg bg-background border border-border text-sm focus:outline-none focus:ring-2 focus:ring-primary/30';

const SEVERITY_OPTIONS = [
  { v: '', l: '—' },
  { v: 'MILD', l: 'Leve' },
  { v: 'MODERATE', l: 'Moderada' },
  { v: 'SEVERE', l: 'Grave' },
];

// ─── ADICIONAR ALERGIA ───────────────────────────────────────

export function AddAllergyModal({
  patientId, onClose, onCreated,
}: { patientId: string; onClose: () => void; onCreated: () => void }) {
  const [allergen, setAllergen] = useState('');
  const [severity, setSeverity] = useState('');
  const [notes, setNotes] = useState('');
  const [loading, setLoading] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!allergen.trim()) {
      showError('Substância é obrigatória');
      return;
    }
    setLoading(true);
    try {
      await api.post(`/patients/${patientId}/allergies`, {
        allergen: allergen.trim(),
        severity: severity || undefined,
        notes: notes.trim() || undefined,
      });
      showSuccess('Alergia registrada');
      onCreated();
    } catch (err: any) {
      showError(err?.response?.data?.message || 'Erro ao registrar');
    } finally {
      setLoading(false);
    }
  };

  return (
    <Wrapper onClose={onClose} icon={<AlertTriangle size={18} className="text-amber-500" />} title="Adicionar alergia">
      <form onSubmit={submit} className="p-4 space-y-3">
        <div>
          <label className="block text-xs font-medium mb-1">Substância *</label>
          <input
            value={allergen}
            onChange={(e) => setAllergen(e.target.value)}
            autoFocus
            placeholder="Ex: Penicilina, Latex, Anestésico local..."
            className={inputCls}
          />
        </div>
        <div>
          <label className="block text-xs font-medium mb-1">Severidade</label>
          <select value={severity} onChange={(e) => setSeverity(e.target.value)} className={inputCls}>
            {SEVERITY_OPTIONS.map((s) => <option key={s.v} value={s.v}>{s.l}</option>)}
          </select>
        </div>
        <div>
          <label className="block text-xs font-medium mb-1">Observações</label>
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            rows={2}
            placeholder="Reação observada, contexto, etc"
            className={`${inputCls} resize-none`}
          />
        </div>
        <Footer onClose={onClose} loading={loading} />
      </form>
    </Wrapper>
  );
}

// ─── ADICIONAR MEDICAÇÃO ───────────────────────────────────────

export function AddMedicationModal({
  patientId, onClose, onCreated,
}: { patientId: string; onClose: () => void; onCreated: () => void }) {
  const [medication, setMedication] = useState('');
  const [dosage, setDosage] = useState('');
  const [frequency, setFrequency] = useState('');
  const [reason, setReason] = useState('');
  const [loading, setLoading] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!medication.trim()) {
      showError('Nome do medicamento é obrigatório');
      return;
    }
    setLoading(true);
    try {
      await api.post(`/patients/${patientId}/medications`, {
        medication: medication.trim(),
        dosage: dosage.trim() || undefined,
        frequency: frequency.trim() || undefined,
        reason: reason.trim() || undefined,
      });
      showSuccess('Medicação registrada');
      onCreated();
    } catch (err: any) {
      showError(err?.response?.data?.message || 'Erro ao registrar');
    } finally {
      setLoading(false);
    }
  };

  return (
    <Wrapper onClose={onClose} icon={<Pill size={18} className="text-primary" />} title="Adicionar medicação">
      <form onSubmit={submit} className="p-4 space-y-3">
        <div>
          <label className="block text-xs font-medium mb-1">Medicamento *</label>
          <input
            value={medication}
            onChange={(e) => setMedication(e.target.value)}
            autoFocus
            placeholder="Ex: Losartana, Omeprazol..."
            className={inputCls}
          />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="block text-xs font-medium mb-1">Dosagem</label>
            <input
              value={dosage}
              onChange={(e) => setDosage(e.target.value)}
              placeholder="Ex: 50mg"
              className={inputCls}
            />
          </div>
          <div>
            <label className="block text-xs font-medium mb-1">Frequência</label>
            <input
              value={frequency}
              onChange={(e) => setFrequency(e.target.value)}
              placeholder="Ex: 1x ao dia"
              className={inputCls}
            />
          </div>
        </div>
        <div>
          <label className="block text-xs font-medium mb-1">Motivo / Indicação</label>
          <input
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Ex: hipertensão"
            className={inputCls}
          />
        </div>
        <Footer onClose={onClose} loading={loading} />
      </form>
    </Wrapper>
  );
}

// ─── Layout compartilhado ───────────────────────────────────────

function Wrapper({
  children, onClose, icon, title,
}: { children: React.ReactNode; onClose: () => void; icon: React.ReactNode; title: string }) {
  return (
    <div
      className="fixed inset-0 z-[110] bg-black/50 backdrop-blur-sm flex items-center justify-center p-4"
      onClick={onClose}
    >
      <div
        className="bg-card border border-border rounded-xl w-full max-w-md shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between p-4 border-b border-border">
          <div className="flex items-center gap-2">
            {icon}
            <h2 className="text-base font-semibold">{title}</h2>
          </div>
          <button onClick={onClose} className="p-1 hover:bg-accent rounded">
            <X size={18} />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

function Footer({ onClose, loading }: { onClose: () => void; loading: boolean }) {
  return (
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
        disabled={loading}
        className="inline-flex items-center gap-1 px-3 py-2 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 disabled:opacity-50"
      >
        {loading ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />}
        Adicionar
      </button>
    </div>
  );
}

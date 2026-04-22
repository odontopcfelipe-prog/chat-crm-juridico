'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Sparkles, Loader2, Upload, X, Plus, AlertTriangle, Trash2, Image as ImgIcon,
} from 'lucide-react';
import api, { API_BASE_URL } from '@/lib/api';
import { showError, showSuccess } from '@/lib/toast';

interface Simulation {
  id: string;
  simulation_type: string;
  status: string;
  before_s3_key: string;
  after_s3_key: string | null;
  prompt: string | null;
  notes: string | null;
  patient_consent: boolean;
  patient_consent_at: string | null;
  provider: string;
  error_message: string | null;
  created_at: string;
  created_by?: { id: string; name: string } | null;
}

const TYPE_LABEL: Record<string, string> = {
  SMILE:           'Sorriso (Smile Design)',
  FACE_HARMONY:    'Harmonizacao facial',
  LIPS:            'Labios',
  RHINOMODULATION: 'Rinomodulacao',
  OTHER:           'Outro',
};

const STATUS_CFG: Record<string, { label: string; cls: string }> = {
  PROCESSING: { label: 'Processando',  cls: 'bg-amber-500/10 text-amber-700 border-amber-500/20' },
  DONE:       { label: 'Concluida',    cls: 'bg-green-500/10 text-green-700 border-green-500/20' },
  FAILED:     { label: 'Falhou',       cls: 'bg-destructive/10 text-destructive border-destructive/20' },
};

function imgUrl(simId: string, kind: 'before' | 'after'): string {
  return `${API_BASE_URL}/smile-simulations/${simId}/image/${kind}`;
}

export default function SmileDesignTab({ patientId }: { patientId: string }) {
  const [loading, setLoading] = useState(true);
  const [sims, setSims] = useState<Simulation[]>([]);
  const [openModal, setOpenModal] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const { data } = await api.get<Simulation[]>(`/patients/${patientId}/smile-simulations`);
      setSims(data || []);
    } catch (err: any) {
      showError(err?.response?.data?.message || 'Erro ao carregar');
    } finally {
      setLoading(false);
    }
  }, [patientId]);

  useEffect(() => { load(); }, [load]);

  // Polling para PROCESSING -> DONE
  useEffect(() => {
    if (!sims.some((s) => s.status === 'PROCESSING')) return;
    const t = setInterval(load, 3000);
    return () => clearInterval(t);
  }, [sims, load]);

  const remove = async (id: string) => {
    if (!confirm('Excluir esta simulacao?')) return;
    try {
      await api.delete(`/smile-simulations/${id}`);
      showSuccess('Excluida');
      load();
    } catch (err: any) {
      showError(err?.response?.data?.message || 'Erro');
    }
  };

  return (
    <div>
      <div className="flex items-start justify-between mb-3 gap-3">
        <div>
          <h3 className="font-semibold text-foreground flex items-center gap-2">
            <Sparkles size={16} className="text-primary" /> Smile / Face Design Studio
          </h3>
          <p className="text-xs text-muted-foreground mt-1">
            Simulacao de antes/depois usando IA. Ferramenta de venda de planos esteticos.
          </p>
        </div>
        <button
          onClick={() => setOpenModal(true)}
          className="inline-flex items-center gap-1 px-3 py-2 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90"
        >
          <Plus size={14} /> Nova simulacao
        </button>
      </div>

      <div className="bg-amber-500/10 border border-amber-500/20 rounded-lg p-3 mb-4 flex items-start gap-2 text-xs text-amber-700 dark:text-amber-400">
        <AlertTriangle size={14} className="shrink-0 mt-0.5" />
        <div>
          <p className="font-medium">Imagens geradas sao SIMULACOES</p>
          <p className="opacity-90 mt-0.5">
            Conforme CFO Resolucao 118/2012, toda imagem deve ser claramente
            identificada como simulacao, nao como garantia de resultado.
            Apresente sempre ao paciente nesse contexto.
          </p>
        </div>
      </div>

      {loading ? (
        <div className="p-12 flex items-center justify-center text-muted-foreground">
          <Loader2 size={20} className="animate-spin mr-2" /> Carregando...
        </div>
      ) : sims.length === 0 ? (
        <div className="p-12 text-center text-sm text-muted-foreground bg-card border border-border rounded-xl">
          <ImgIcon size={28} className="mx-auto mb-2 opacity-40" />
          <p>Nenhuma simulacao criada para este paciente.</p>
          <p className="text-xs mt-1">Click em "Nova simulacao" para enviar uma foto.</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {sims.map((s) => {
            const cfg = STATUS_CFG[s.status] || STATUS_CFG.PROCESSING;
            return (
              <div key={s.id} className="bg-card border border-border rounded-xl overflow-hidden">
                <div className="px-3 py-2 border-b border-border flex items-center justify-between gap-2">
                  <div>
                    <p className="text-sm font-semibold">{TYPE_LABEL[s.simulation_type] || s.simulation_type}</p>
                    <p className="text-[10px] text-muted-foreground">
                      {new Date(s.created_at).toLocaleString('pt-BR', {
                        day: '2-digit', month: '2-digit', year: 'numeric',
                        hour: '2-digit', minute: '2-digit',
                      })}
                      {s.created_by && ` · ${s.created_by.name}`}
                    </p>
                  </div>
                  <div className="flex items-center gap-1">
                    <span className={`text-[10px] px-2 py-0.5 rounded border ${cfg.cls}`}>{cfg.label}</span>
                    <button
                      onClick={() => remove(s.id)}
                      className="p-1 rounded hover:bg-destructive/10 text-destructive"
                      title="Excluir"
                    >
                      <Trash2 size={12} />
                    </button>
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-px bg-border">
                  <div className="bg-muted/30 aspect-square relative">
                    <img
                      src={imgUrl(s.id, 'before')}
                      alt="Antes"
                      className="w-full h-full object-cover"
                      crossOrigin="use-credentials"
                    />
                    <span className="absolute top-1 left-1 bg-black/60 text-white text-[10px] px-1.5 py-0.5 rounded">
                      ANTES
                    </span>
                  </div>
                  <div className="bg-muted/30 aspect-square relative">
                    {s.status === 'DONE' && s.after_s3_key ? (
                      <>
                        <img
                          src={imgUrl(s.id, 'after')}
                          alt="Depois (simulacao)"
                          className="w-full h-full object-cover"
                          crossOrigin="use-credentials"
                        />
                        <span className="absolute top-1 left-1 bg-primary text-primary-foreground text-[10px] px-1.5 py-0.5 rounded font-bold">
                          DEPOIS (sim.)
                        </span>
                      </>
                    ) : s.status === 'FAILED' ? (
                      <div className="w-full h-full flex items-center justify-center text-center p-3">
                        <p className="text-xs text-destructive">
                          Falha: {s.error_message || 'erro desconhecido'}
                        </p>
                      </div>
                    ) : (
                      <div className="w-full h-full flex items-center justify-center">
                        <Loader2 size={24} className="animate-spin text-muted-foreground" />
                      </div>
                    )}
                  </div>
                </div>

                {(s.prompt || s.notes) && (
                  <div className="px-3 py-2 text-xs space-y-1">
                    {s.prompt && <p><strong>Prompt:</strong> {s.prompt}</p>}
                    {s.notes && <p className="text-muted-foreground italic">{s.notes}</p>}
                  </div>
                )}

                {s.provider === 'mock' && s.status === 'DONE' && (
                  <div className="px-3 py-1.5 bg-amber-500/5 border-t border-amber-500/20 text-[10px] text-amber-700">
                    Provider mock: imagem 'depois' = original. Configure provider real (Replicate/fal/etc.) em settings.
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {openModal && (
        <NewSimulationModal
          patientId={patientId}
          onClose={() => setOpenModal(false)}
          onCreated={() => { setOpenModal(false); load(); }}
        />
      )}
    </div>
  );
}

function NewSimulationModal({
  patientId, onClose, onCreated,
}: { patientId: string; onClose: () => void; onCreated: () => void }) {
  const [saving, setSaving] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [type, setType] = useState('SMILE');
  const [prompt, setPrompt] = useState('');
  const [notes, setNotes] = useState('');
  const [consent, setConsent] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const onFile = (f: File | null) => {
    setFile(f);
    if (f) {
      const r = new FileReader();
      r.onload = () => setPreview(r.result as string);
      r.readAsDataURL(f);
    } else setPreview(null);
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!file) { showError('Selecione uma foto'); return; }
    if (!consent) { showError('Consentimento do paciente obrigatorio'); return; }
    setSaving(true);
    try {
      const fd = new FormData();
      fd.append('file', file);
      fd.append('simulation_type', type);
      if (prompt.trim()) fd.append('prompt', prompt.trim());
      if (notes.trim()) fd.append('notes', notes.trim());
      fd.append('patient_consent', 'true');
      await api.post(`/patients/${patientId}/smile-simulations`, fd, {
        headers: { 'Content-Type': 'multipart/form-data' },
      });
      showSuccess('Simulacao em processamento');
      onCreated();
    } catch (err: any) {
      showError(err?.response?.data?.message || 'Erro');
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
        className="bg-card border border-border rounded-xl w-full max-w-lg shadow-2xl max-h-[90vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between p-4 border-b border-border">
          <h2 className="text-lg font-semibold flex items-center gap-2">
            <Sparkles size={20} className="text-primary" /> Nova simulacao
          </h2>
          <button onClick={onClose} className="p-1 hover:bg-accent rounded">
            <X size={18} />
          </button>
        </div>

        <form onSubmit={submit} className="p-4 space-y-3 overflow-y-auto">
          <div>
            <label className="block text-xs font-medium mb-1">Tipo *</label>
            <select
              value={type}
              onChange={(e) => setType(e.target.value)}
              className="w-full px-3 py-2 rounded-lg bg-background border border-border text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
            >
              {Object.entries(TYPE_LABEL).map(([v, l]) => (
                <option key={v} value={v}>{l}</option>
              ))}
            </select>
          </div>

          <div>
            <label className="block text-xs font-medium mb-1">Foto (antes) *</label>
            <button
              type="button"
              onClick={() => fileRef.current?.click()}
              className="w-full border-2 border-dashed border-border rounded-lg p-4 text-center hover:bg-accent cursor-pointer"
            >
              {preview ? (
                <img src={preview} alt="Preview" className="max-h-48 mx-auto rounded" />
              ) : (
                <div className="text-muted-foreground">
                  <Upload size={24} className="mx-auto mb-2" />
                  <p className="text-sm">Click para escolher uma foto</p>
                  <p className="text-xs opacity-70">JPG/PNG ate 15MB</p>
                </div>
              )}
            </button>
            <input
              ref={fileRef}
              type="file"
              accept="image/*"
              onChange={(e) => onFile(e.target.files?.[0] || null)}
              className="hidden"
            />
          </div>

          <div>
            <label className="block text-xs font-medium mb-1">Prompt (opcional)</label>
            <input
              type="text"
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="Ex: clarear dentes, alinhar, simular facetas..."
              className="w-full px-3 py-2 rounded-lg bg-background border border-border text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
            />
          </div>

          <div>
            <label className="block text-xs font-medium mb-1">Observacoes</label>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={2}
              className="w-full px-3 py-2 rounded-lg bg-background border border-border text-sm focus:outline-none focus:ring-2 focus:ring-primary/30 resize-none"
            />
          </div>

          <label className="flex items-start gap-2 p-3 rounded-lg bg-amber-500/10 border border-amber-500/20 cursor-pointer">
            <input
              type="checkbox"
              checked={consent}
              onChange={(e) => setConsent(e.target.checked)}
              className="accent-amber-500 mt-0.5 shrink-0"
            />
            <span className="text-xs text-amber-700 dark:text-amber-400">
              Confirmo que o paciente <strong>autorizou</strong> a geracao desta simulacao
              e foi orientado de que se trata de simulacao por IA, nao garantia de
              resultado (CFO Resolucao 118/2012). *
            </span>
          </label>

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
              disabled={saving || !file || !consent}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 disabled:opacity-50"
            >
              {saving ? <Loader2 size={16} className="animate-spin" /> : <Sparkles size={16} />}
              Gerar simulacao
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

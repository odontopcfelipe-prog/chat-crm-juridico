'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  FileSignature, Loader2, Plus, ArrowLeft, Save, Clock, CalendarClock,
  ChevronDown, Trash2, Sparkles, RefreshCw, ExternalLink, FileText,
  Edit3, Eye, MoreVertical, User, History,
} from 'lucide-react';
import api from '@/lib/api';
import { showError, showSuccess } from '@/lib/toast';
import TiptapEditor from '@/components/TiptapEditor';
import GoogleDocsEmbed from '@/components/GoogleDocsEmbed';

// ─── Types ───────────────────────────────────────────────

interface PetitionSummary {
  id: string;
  title: string;
  type: string;
  status: string;
  template_id: string | null;
  created_at: string;
  updated_at: string;
  created_by: { id: string; name: string };
  _count: { versions: number };
}

interface PetitionDetail {
  id: string;
  title: string;
  type: string;
  status: string;
  content_json: any;
  content_html: string | null;
  template_id: string | null;
  google_doc_id: string | null;
  google_doc_url: string | null;
  created_at: string;
  updated_at: string;
  created_by: { id: string; name: string };
  template: { id: string; name: string } | null;
  _count: { versions: number };
}

interface PetitionVersionItem {
  id: string;
  version: number;
  created_at: string;
  saved_by: { id: string; name: string };
}

const TYPES = [
  'INICIAL', 'CONTESTACAO', 'REPLICA', 'EMBARGOS',
  'RECURSO', 'MANIFESTACAO', 'OUTRO',
];

const TYPE_LABELS: Record<string, string> = {
  INICIAL: 'Petição Inicial',
  CONTESTACAO: 'Contestação',
  REPLICA: 'Réplica',
  EMBARGOS: 'Embargos',
  RECURSO: 'Recurso',
  MANIFESTACAO: 'Manifestação',
  OUTRO: 'Outro',
};

const STATUS_LABELS: Record<string, string> = {
  RASCUNHO: 'Rascunho',
  EM_REVISAO: 'Em Revisão',
  APROVADA: 'Aprovada',
  PROTOCOLADA: 'Protocolada',
};

const STATUS_COLORS: Record<string, { text: string; bg: string; border: string; dot: string }> = {
  RASCUNHO: { text: 'text-zinc-400', bg: 'bg-zinc-500/10', border: 'border-zinc-500/20', dot: 'bg-zinc-400' },
  EM_REVISAO: { text: 'text-amber-400', bg: 'bg-amber-500/10', border: 'border-amber-500/20', dot: 'bg-amber-400' },
  APROVADA: { text: 'text-emerald-400', bg: 'bg-emerald-500/10', border: 'border-emerald-500/20', dot: 'bg-emerald-400' },
  PROTOCOLADA: { text: 'text-blue-400', bg: 'bg-blue-500/10', border: 'border-blue-500/20', dot: 'bg-blue-400' },
};

const TYPE_COLORS: Record<string, { text: string; bg: string }> = {
  INICIAL: { text: 'text-blue-400', bg: 'bg-blue-500/10' },
  CONTESTACAO: { text: 'text-red-400', bg: 'bg-red-500/10' },
  REPLICA: { text: 'text-purple-400', bg: 'bg-purple-500/10' },
  EMBARGOS: { text: 'text-amber-400', bg: 'bg-amber-500/10' },
  RECURSO: { text: 'text-cyan-400', bg: 'bg-cyan-500/10' },
  MANIFESTACAO: { text: 'text-emerald-400', bg: 'bg-emerald-500/10' },
  OUTRO: { text: 'text-zinc-400', bg: 'bg-zinc-500/10' },
};

function formatDate(d: string) {
  return new Date(d).toLocaleString('pt-BR', {
    day: '2-digit', month: '2-digit', year: '2-digit',
    hour: '2-digit', minute: '2-digit',
  });
}

// ─── Component ───────────────────────────────────────────

export default function TabPeticoes({ caseId }: { caseId: string }) {
  const [petitions, setPetitions] = useState<PetitionSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [editingPetition, setEditingPetition] = useState<PetitionDetail | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [menuOpenId, setMenuOpenId] = useState<string | null>(null);

  // ─── List ────────────────────────────────────────────────

  const fetchList = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.get(`/petitions/case/${caseId}`);
      setPetitions(res.data || []);
    } catch {
      showError('Erro ao carregar petições');
    } finally {
      setLoading(false);
    }
  }, [caseId]);

  useEffect(() => {
    fetchList();
  }, [fetchList]);

  // ─── Open petition ──────────────────────────────────────

  const openPetition = async (id: string) => {
    try {
      const res = await api.get(`/petitions/${id}`);
      setEditingPetition(res.data);
    } catch {
      showError('Erro ao abrir petição');
    }
  };

  const closePetition = () => {
    setEditingPetition(null);
    fetchList();
  };

  // ─── Delete petition ───────────────────────────────────

  const handleDelete = async (id: string, title: string) => {
    if (!confirm(`Excluir a petição "${title}"? Esta ação não pode ser desfeita.`)) return;
    setDeletingId(id);
    try {
      await api.delete(`/petitions/${id}`);
      showSuccess('Petição excluída');
      setPetitions(prev => prev.filter(p => p.id !== id));
    } catch {
      showError('Erro ao excluir petição');
    } finally {
      setDeletingId(null);
      setMenuOpenId(null);
    }
  };

  // ─── Close menu on outside click ───────────────────────

  useEffect(() => {
    if (!menuOpenId) return;
    const handler = () => setMenuOpenId(null);
    document.addEventListener('click', handler);
    return () => document.removeEventListener('click', handler);
  }, [menuOpenId]);

  // ─── Render editor ──────────────────────────────────────

  if (editingPetition) {
    return (
      <PetitionEditor
        petition={editingPetition}
        onBack={closePetition}
      />
    );
  }

  // Stats
  const total = petitions.length;
  const byStatus = {
    rascunho: petitions.filter(p => p.status === 'RASCUNHO').length,
    revisao: petitions.filter(p => p.status === 'EM_REVISAO').length,
    aprovada: petitions.filter(p => p.status === 'APROVADA').length,
    protocolada: petitions.filter(p => p.status === 'PROTOCOLADA').length,
  };

  return (
    <div className="p-4 space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2.5">
          <div className="w-8 h-8 rounded-xl bg-primary/10 border border-primary/20 flex items-center justify-center">
            <FileSignature className="w-4 h-4 text-primary" />
          </div>
          <div>
            <h2 className="text-[13px] font-bold text-foreground">Petições</h2>
            <p className="text-[10px] text-muted-foreground">
              {total === 0 ? 'Nenhuma petição' : `${total} petição${total > 1 ? 'ões' : ''}`}
            </p>
          </div>
        </div>
        <button
          onClick={() => setShowCreate(true)}
          className="flex items-center gap-1.5 px-3.5 py-2 text-[11px] font-semibold bg-primary text-primary-foreground rounded-xl hover:bg-primary/90 transition-all shadow-sm"
        >
          <Plus className="w-3.5 h-3.5" /> Nova Petição
        </button>
      </div>

      {/* Stats mini cards */}
      {total > 0 && (
        <div className="grid grid-cols-4 gap-2">
          {[
            { label: 'Rascunho', count: byStatus.rascunho, color: STATUS_COLORS.RASCUNHO },
            { label: 'Em Revisão', count: byStatus.revisao, color: STATUS_COLORS.EM_REVISAO },
            { label: 'Aprovada', count: byStatus.aprovada, color: STATUS_COLORS.APROVADA },
            { label: 'Protocolada', count: byStatus.protocolada, color: STATUS_COLORS.PROTOCOLADA },
          ].map(s => (
            <div key={s.label} className={`rounded-xl ${s.color.bg} border ${s.color.border} px-3 py-2 text-center`}>
              <p className={`text-lg font-bold ${s.color.text}`}>{s.count}</p>
              <p className="text-[9px] text-muted-foreground font-medium uppercase tracking-wide">{s.label}</p>
            </div>
          ))}
        </div>
      )}

      {/* Create form */}
      {showCreate && (
        <CreatePetitionForm
          caseId={caseId}
          onCreated={(id) => {
            setShowCreate(false);
            openPetition(id);
          }}
          onCancel={() => setShowCreate(false)}
        />
      )}

      {/* List */}
      {loading ? (
        <div className="flex justify-center py-16">
          <Loader2 className="w-6 h-6 animate-spin text-primary" />
        </div>
      ) : petitions.length === 0 && !showCreate ? (
        <div className="flex flex-col items-center justify-center py-16 text-center">
          <div className="w-16 h-16 rounded-2xl bg-accent/30 border border-border flex items-center justify-center mb-4">
            <FileSignature className="w-7 h-7 text-muted-foreground/40" />
          </div>
          <p className="text-sm font-medium text-muted-foreground">Nenhuma petição criada</p>
          <p className="text-[11px] text-muted-foreground/60 mt-1">Clique em &quot;Nova Petição&quot; para começar</p>
        </div>
      ) : (
        <div className="space-y-2">
          {petitions.map((p) => {
            const statusColor = STATUS_COLORS[p.status] || STATUS_COLORS.RASCUNHO;
            const typeColor = TYPE_COLORS[p.type] || TYPE_COLORS.OUTRO;
            const isDeleting = deletingId === p.id;

            return (
              <div
                key={p.id}
                className={`group relative rounded-2xl border border-border bg-card hover:border-primary/30 transition-all ${isDeleting ? 'opacity-50 pointer-events-none' : ''}`}
              >
                <div
                  className="flex items-center gap-3 p-3.5 cursor-pointer"
                  onClick={() => openPetition(p.id)}
                >
                  {/* Status indicator */}
                  <div className={`w-10 h-10 rounded-xl ${statusColor.bg} border ${statusColor.border} flex items-center justify-center shrink-0`}>
                    <FileSignature className={`w-4.5 h-4.5 ${statusColor.text}`} />
                  </div>

                  {/* Content */}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-[13px] font-semibold text-foreground truncate">{p.title}</span>
                      <span className={`shrink-0 px-2 py-0.5 rounded-full text-[9px] font-bold uppercase ${typeColor.bg} ${typeColor.text}`}>
                        {TYPE_LABELS[p.type] || p.type}
                      </span>
                    </div>
                    <div className="flex items-center gap-3 mt-1">
                      <span className="flex items-center gap-1 text-[10px] text-muted-foreground">
                        <User className="w-3 h-3" />
                        {p.created_by.name}
                      </span>
                      <span className="flex items-center gap-1 text-[10px] text-muted-foreground">
                        <Clock className="w-3 h-3" />
                        {formatDate(p.updated_at)}
                      </span>
                      {p._count.versions > 0 && (
                        <span className="flex items-center gap-1 text-[10px] text-muted-foreground">
                          <History className="w-3 h-3" />
                          {p._count.versions} versões
                        </span>
                      )}
                    </div>
                  </div>

                  {/* Status badge */}
                  <div className={`shrink-0 flex items-center gap-1.5 px-2.5 py-1 rounded-lg ${statusColor.bg} border ${statusColor.border}`}>
                    <span className={`w-1.5 h-1.5 rounded-full ${statusColor.dot}`} />
                    <span className={`text-[10px] font-semibold ${statusColor.text}`}>
                      {STATUS_LABELS[p.status] || p.status}
                    </span>
                  </div>

                  {/* Actions menu */}
                  <div className="relative shrink-0" onClick={(e) => e.stopPropagation()}>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        setMenuOpenId(menuOpenId === p.id ? null : p.id);
                      }}
                      className="w-7 h-7 rounded-lg flex items-center justify-center text-muted-foreground/50 hover:text-foreground hover:bg-accent/50 transition-colors opacity-0 group-hover:opacity-100"
                    >
                      <MoreVertical className="w-3.5 h-3.5" />
                    </button>

                    {/* Dropdown */}
                    {menuOpenId === p.id && (
                      <div className="absolute right-0 top-full mt-1 z-50 w-44 bg-card border border-border rounded-xl shadow-xl py-1 animate-in fade-in slide-in-from-top-2 duration-200">
                        <button
                          onClick={() => { openPetition(p.id); setMenuOpenId(null); }}
                          className="w-full flex items-center gap-2 px-3 py-2 text-[11px] text-foreground hover:bg-accent/50 transition-colors"
                        >
                          <Edit3 className="w-3.5 h-3.5" /> Editar petição
                        </button>
                        {p.status !== 'PROTOCOLADA' && (
                          <button
                            onClick={() => handleDelete(p.id, p.title)}
                            disabled={isDeleting}
                            className="w-full flex items-center gap-2 px-3 py-2 text-[11px] text-red-400 hover:bg-red-500/10 transition-colors"
                          >
                            {isDeleting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Trash2 className="w-3.5 h-3.5" />}
                            Excluir petição
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ─── Create Form ─────────────────────────────────────────

function CreatePetitionForm({
  caseId,
  onCreated,
  onCancel,
}: {
  caseId: string;
  onCreated: (id: string) => void;
  onCancel: () => void;
}) {
  const [title, setTitle] = useState('');
  const [type, setType] = useState('INICIAL');
  const [saving, setSaving] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [deadlineAt, setDeadlineAt] = useState('');
  const [createGoogleDoc, setCreateGoogleDoc] = useState(true);
  const [driveConfigured, setDriveConfigured] = useState(false);

  useEffect(() => {
    api.get('/google-drive/config').then(res => {
      setDriveConfigured(res.data?.configured || false);
    }).catch(() => {});
  }, []);

  const handleCreate = async () => {
    if (!title.trim()) {
      showError('Informe o título da petição');
      return;
    }
    setSaving(true);
    try {
      const res = await api.post(`/petitions/case/${caseId}`, {
        title,
        type,
        deadline_at: deadlineAt || undefined,
        create_google_doc: driveConfigured ? createGoogleDoc : false,
      });
      showSuccess(res.data.google_doc_url ? 'Petição criada no Google Docs' : 'Petição criada');
      onCreated(res.data.id);
    } catch {
      showError('Erro ao criar petição');
    } finally {
      setSaving(false);
    }
  };

  const handleGenerateAI = async () => {
    if (!title.trim()) {
      showError('Informe o título da petição');
      return;
    }
    setGenerating(true);
    try {
      const res = await api.post(`/petitions/case/${caseId}/generate`, { title, type });
      showSuccess('Petição gerada com IA');
      onCreated(res.data.id);
    } catch (e: any) {
      showError(e?.response?.data?.message || 'Erro ao gerar petição com IA');
    } finally {
      setGenerating(false);
    }
  };

  const busy = saving || generating;

  return (
    <div className="rounded-2xl border-2 border-primary/30 bg-card p-5 space-y-4">
      <div className="flex items-center gap-2">
        <div className="w-7 h-7 rounded-lg bg-primary/10 flex items-center justify-center">
          <Plus className="w-3.5 h-3.5 text-primary" />
        </div>
        <h3 className="text-[13px] font-bold text-foreground">Nova Petição</h3>
      </div>

      <div className="grid grid-cols-[1fr_160px] gap-3">
        <input
          type="text"
          placeholder="Título da petição..."
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          className="w-full px-3 py-2.5 rounded-xl bg-accent/30 border border-border text-[12px] text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary/40 transition-all"
          autoFocus
          onKeyDown={(e) => e.key === 'Enter' && !busy && handleCreate()}
        />
        <select
          value={type}
          onChange={(e) => setType(e.target.value)}
          className="w-full px-3 py-2.5 rounded-xl bg-accent/30 border border-border text-[12px] text-foreground focus:outline-none focus:ring-2 focus:ring-primary/30 transition-all appearance-none cursor-pointer"
        >
          {TYPES.map((t) => (
            <option key={t} value={t}>{TYPE_LABELS[t]}</option>
          ))}
        </select>
      </div>

      <div className="flex items-center gap-4">
        <div className="flex items-center gap-2">
          <CalendarClock className="w-3.5 h-3.5 text-muted-foreground" />
          <span className="text-[10px] font-bold text-muted-foreground uppercase tracking-wider">Prazo</span>
          <input
            type="date"
            value={deadlineAt}
            onChange={(e) => setDeadlineAt(e.target.value)}
            className="px-2.5 py-1.5 rounded-lg bg-accent/30 border border-border text-[11px] text-foreground focus:outline-none focus:ring-2 focus:ring-primary/30 transition-all"
            min={new Date().toISOString().split('T')[0]}
          />
        </div>
        {driveConfigured && (
          <label className="flex items-center gap-2 text-[11px] cursor-pointer ml-auto select-none">
            <div className={`relative w-8 h-4.5 rounded-full transition-colors ${createGoogleDoc ? 'bg-blue-500' : 'bg-accent/60'}`}>
              <input
                type="checkbox"
                checked={createGoogleDoc}
                onChange={(e) => setCreateGoogleDoc(e.target.checked)}
                className="sr-only"
              />
              <div className={`absolute top-0.5 w-3.5 h-3.5 rounded-full bg-white shadow transition-transform ${createGoogleDoc ? 'translate-x-4' : 'translate-x-0.5'}`} />
            </div>
            <FileText className="w-3.5 h-3.5 text-blue-400" />
            <span className="text-muted-foreground font-medium">Google Docs</span>
          </label>
        )}
      </div>

      {generating && (
        <div className="flex items-center gap-2 px-3 py-2 rounded-xl bg-primary/5 border border-primary/20">
          <Sparkles className="w-3.5 h-3.5 text-primary animate-pulse" />
          <span className="text-[11px] text-primary font-medium">Gerando petição com IA... isso pode levar até 30 segundos</span>
        </div>
      )}

      <div className="flex justify-end gap-2 pt-1">
        <button
          onClick={onCancel}
          disabled={busy}
          className="px-3.5 py-2 text-[11px] font-medium text-muted-foreground hover:text-foreground rounded-xl hover:bg-accent/50 transition-colors"
        >
          Cancelar
        </button>
        <button
          onClick={handleCreate}
          disabled={busy}
          className="flex items-center gap-1.5 px-3.5 py-2 text-[11px] font-semibold text-foreground bg-accent/50 border border-border rounded-xl hover:bg-accent transition-colors"
        >
          {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Plus className="w-3.5 h-3.5" />}
          Criar vazia
        </button>
        <button
          onClick={handleGenerateAI}
          disabled={busy}
          className="flex items-center gap-1.5 px-3.5 py-2 text-[11px] font-semibold bg-primary text-primary-foreground rounded-xl hover:bg-primary/90 transition-all shadow-sm"
        >
          {generating ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Sparkles className="w-3.5 h-3.5" />}
          Gerar com IA
        </button>
      </div>
    </div>
  );
}

// ─── Petition Editor ─────────────────────────────────────

function PetitionEditor({
  petition,
  onBack,
}: {
  petition: PetitionDetail;
  onBack: () => void;
}) {
  const [status, setStatus] = useState(petition.status);
  const [title, setTitle] = useState(petition.title);
  const [saving, setSaving] = useState(false);
  const [autoSaveStatus, setAutoSaveStatus] = useState<'saved' | 'saving' | 'idle'>('idle');
  const [versions, setVersions] = useState<PetitionVersionItem[]>([]);
  const [showVersions, setShowVersions] = useState(false);
  const [savingVersion, setSavingVersion] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [regenerating, setRegenerating] = useState(false);
  const [contentKey, setContentKey] = useState(0);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latestContentRef = useRef<{ json: any; html: string } | null>(null);
  const [currentContent, setCurrentContent] = useState(petition.content_json);
  // Google Docs é SEMPRE o editor primário quando disponível
  const [googleDocUrl, setGoogleDocUrl] = useState(petition.google_doc_url);
  const hasGoogleDoc = !!googleDocUrl;
  const [editorMode, setEditorMode] = useState<'local' | 'gdocs'>(
    hasGoogleDoc ? 'gdocs' : 'local'
  );
  const [syncing, setSyncing] = useState(false);
  const [showLinkDoc, setShowLinkDoc] = useState(false);
  const [linkDocUrl, setLinkDocUrl] = useState('');
  const [linkingDoc, setLinkingDoc] = useState(false);

  const isEditable = status === 'RASCUNHO' || status === 'EM_REVISAO';

  // ─── Auto-save ──────────────────────────────────────────

  const doAutoSave = useCallback(async (json: any, html: string) => {
    setAutoSaveStatus('saving');
    try {
      await api.patch(`/petitions/${petition.id}`, {
        content_json: json,
        content_html: html,
      });
      setAutoSaveStatus('saved');
    } catch {
      setAutoSaveStatus('idle');
    }
  }, [petition.id]);

  const handleEditorChange = useCallback((json: any, html: string) => {
    latestContentRef.current = { json, html };
    setAutoSaveStatus('idle');

    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      doAutoSave(json, html);
    }, 2000);
  }, [doAutoSave]);

  // Cleanup debounce
  useEffect(() => {
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, []);

  // ─── Status change ────────────────────────────────────────

  const handleStatusChange = async (newStatus: string) => {
    setSaving(true);
    try {
      await api.patch(`/petitions/${petition.id}/status`, { status: newStatus });
      setStatus(newStatus);
      showSuccess(`Status alterado para ${STATUS_LABELS[newStatus]}`);
    } catch (e: any) {
      showError(e?.response?.data?.message || 'Erro ao alterar status');
    } finally {
      setSaving(false);
    }
  };

  // ─── Title save ────────────────────────────────────────────

  const handleTitleSave = async () => {
    if (!title.trim() || title === petition.title) return;
    try {
      await api.patch(`/petitions/${petition.id}`, { title });
      showSuccess('Título salvo');
    } catch {
      showError('Erro ao salvar título');
    }
  };

  // ─── Version ──────────────────────────────────────────────

  const handleSaveVersion = async () => {
    setSavingVersion(true);
    try {
      await api.post(`/petitions/${petition.id}/version`);
      showSuccess('Versão salva');
      loadVersions();
    } catch (e: any) {
      showError(e?.response?.data?.message || 'Erro ao salvar versão');
    } finally {
      setSavingVersion(false);
    }
  };

  const loadVersions = async () => {
    try {
      const res = await api.get(`/petitions/${petition.id}/versions`);
      setVersions(res.data || []);
    } catch {
      // silent
    }
  };

  useEffect(() => {
    if (showVersions) loadVersions();
  }, [showVersions]);

  // ─── Delete ────────────────────────────────────────────────

  const handleDelete = async () => {
    if (!confirm('Tem certeza que deseja excluir esta petição?')) return;
    setDeleting(true);
    try {
      await api.delete(`/petitions/${petition.id}`);
      showSuccess('Petição excluída');
      onBack();
    } catch (e: any) {
      showError(e?.response?.data?.message || 'Erro ao excluir');
    } finally {
      setDeleting(false);
    }
  };

  // ─── Regenerate with AI ────────────────────────────────────

  const handleRegenerate = async () => {
    if (!confirm('Isso substituirá o conteúdo atual da petição pelo gerado pela IA. Deseja continuar?')) return;
    setRegenerating(true);
    try {
      const res = await api.post(`/petitions/${petition.id}/generate`);
      setCurrentContent(res.data.content_json);
      setContentKey(prev => prev + 1);
      showSuccess('Petição regenerada com IA');
    } catch (e: any) {
      showError(e?.response?.data?.message || 'Erro ao regenerar petição');
    } finally {
      setRegenerating(false);
    }
  };

  // ─── Sync from Google Doc ────────────────────────────────────

  const handleSyncFromGoogleDoc = async () => {
    setSyncing(true);
    try {
      await api.post(`/petitions/${petition.id}/sync-gdoc`);
      showSuccess('Conteúdo sincronizado do Google Docs');
    } catch (e: any) {
      showError(e?.response?.data?.message || 'Erro ao sincronizar');
    } finally {
      setSyncing(false);
    }
  };

  // ─── Link Google Doc manually ────────────────────────────────

  const handleLinkGoogleDoc = async () => {
    const url = linkDocUrl.trim();
    if (!url) { showError('Cole a URL do Google Doc'); return; }

    // Extrair docId da URL: https://docs.google.com/document/d/XXXXX/edit
    const match = url.match(/\/document\/d\/([a-zA-Z0-9_-]+)/);
    if (!match) { showError('URL inválida. Cole uma URL do Google Docs (ex: https://docs.google.com/document/d/...)'); return; }

    const docId = match[1];
    const docUrl = `https://docs.google.com/document/d/${docId}/edit`;

    setLinkingDoc(true);
    try {
      await api.patch(`/petitions/${petition.id}`, {
        google_doc_id: docId,
        google_doc_url: docUrl,
      });
      setGoogleDocUrl(docUrl);
      setEditorMode('gdocs');
      setShowLinkDoc(false);
      setLinkDocUrl('');
      showSuccess('Google Doc vinculado com sucesso!');
    } catch {
      showError('Erro ao vincular Google Doc');
    } finally {
      setLinkingDoc(false);
    }
  };

  // ─── Status transitions ────────────────────────────────────

  const transitions: Record<string, string[]> = {
    RASCUNHO: ['EM_REVISAO'],
    EM_REVISAO: ['RASCUNHO', 'APROVADA'],
    APROVADA: ['EM_REVISAO', 'PROTOCOLADA'],
    PROTOCOLADA: [],
  };

  const allowedTransitions = transitions[status] || [];

  return (
    <div className="flex flex-col h-full">
      {/* Editor header */}
      <div className="flex items-center gap-3 border-b border-base-300 bg-base-200/30 px-4 py-2">
        <button
          onClick={onBack}
          className="btn btn-ghost btn-sm btn-circle"
          title="Voltar à lista"
        >
          <ArrowLeft className="h-4 w-4" />
        </button>

        {/* Title */}
        <input
          type="text"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onBlur={handleTitleSave}
          className="input input-ghost input-sm font-semibold flex-1 min-w-0"
          disabled={!isEditable}
        />

        {/* Type badge */}
        <span className="badge badge-xs badge-outline shrink-0">
          {TYPE_LABELS[petition.type] || petition.type}
        </span>

        {/* Status badge */}
        <span className={`badge badge-sm ${STATUS_COLORS[status] || ''} shrink-0`}>
          {STATUS_LABELS[status] || status}
        </span>

        {/* Auto-save indicator */}
        {autoSaveStatus === 'saving' && (
          <span className="text-xs text-base-content/40 flex items-center gap-1 shrink-0">
            <Loader2 className="h-3 w-3 animate-spin" /> Salvando...
          </span>
        )}
        {autoSaveStatus === 'saved' && (
          <span className="text-xs text-success/60 shrink-0">Salvo</span>
        )}
      </div>

      {/* Action bar */}
      <div className="flex items-center gap-2 border-b border-base-300 bg-base-100 px-4 py-1.5 flex-wrap">
        {/* Google Docs: botão discreto para trocar para editor local (avançado) */}
        {hasGoogleDoc && editorMode === 'gdocs' && (
          <button
            onClick={() => setEditorMode('local')}
            className="btn btn-ghost btn-xs gap-1 text-base-content/40 hover:text-base-content/60"
            title="Alternar para editor local (avançado)"
          >
            Editor local
          </button>
        )}

        {/* Se está no editor local mas tem Google Doc, botão para voltar ao Docs */}
        {hasGoogleDoc && editorMode === 'local' && (
          <>
            <button
              onClick={() => setEditorMode('gdocs')}
              className="btn btn-ghost btn-xs gap-1 text-blue-500"
            >
              <FileText className="h-3 w-3" />
              Voltar ao Google Docs
            </button>
            <button
              onClick={handleSyncFromGoogleDoc}
              disabled={syncing}
              className="btn btn-ghost btn-xs gap-1 text-blue-500"
              title="Sincronizar conteúdo do Google Docs"
            >
              {syncing ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
              Sincronizar
            </button>
          </>
        )}

        {/* Save version */}
        <button
          onClick={handleSaveVersion}
          disabled={savingVersion}
          className="btn btn-ghost btn-xs gap-1"
          title="Salvar versão (snapshot)"
        >
          {savingVersion ? <Loader2 className="h-3 w-3 animate-spin" /> : <Save className="h-3 w-3" />}
          Salvar versão
        </button>

        {/* View versions */}
        <button
          onClick={() => setShowVersions(!showVersions)}
          className="btn btn-ghost btn-xs gap-1"
        >
          <Clock className="h-3 w-3" />
          Versões ({petition._count.versions})
          <ChevronDown className={`h-3 w-3 transition-transform ${showVersions ? 'rotate-180' : ''}`} />
        </button>

        {/* Regenerate with AI (only in local editor mode) */}
        {isEditable && editorMode === 'local' && (
          <button
            onClick={handleRegenerate}
            disabled={regenerating}
            className="btn btn-ghost btn-xs gap-1 text-primary"
            title="Regenerar conteúdo com IA"
          >
            {regenerating ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
            {regenerating ? 'Gerando...' : 'Regenerar com IA'}
          </button>
        )}

        {/* Vincular Google Doc (quando não tem doc vinculado) */}
        {!hasGoogleDoc && isEditable && (
          <button
            onClick={() => setShowLinkDoc(!showLinkDoc)}
            className="btn btn-ghost btn-xs gap-1 text-blue-500"
            title="Vincular um Google Doc existente"
          >
            <ExternalLink className="h-3 w-3" />
            Vincular Google Doc
          </button>
        )}

        <div className="flex-1" />

        {/* Status transitions */}
        {allowedTransitions.map((newStatus) => (
          <button
            key={newStatus}
            onClick={() => handleStatusChange(newStatus)}
            disabled={saving}
            className="btn btn-outline btn-xs"
          >
            {saving ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
            {STATUS_LABELS[newStatus]}
          </button>
        ))}

        {/* Delete (only drafts) */}
        {status === 'RASCUNHO' && (
          <button
            onClick={handleDelete}
            disabled={deleting}
            className="btn btn-ghost btn-xs text-error"
            title="Excluir petição"
          >
            <Trash2 className="h-3 w-3" />
          </button>
        )}
      </div>

      {/* Link Google Doc panel */}
      {showLinkDoc && (
        <div className="border-b border-base-300 bg-blue-500/5 px-4 py-3 space-y-2">
          <p className="text-xs text-base-content/70">
            Crie um Google Doc no seu Drive e cole a URL abaixo para editar diretamente no sistema:
          </p>
          <div className="flex gap-2">
            <input
              type="text"
              value={linkDocUrl}
              onChange={(e) => setLinkDocUrl(e.target.value)}
              placeholder="https://docs.google.com/document/d/.../edit"
              className="input input-bordered input-sm flex-1 text-xs"
              onKeyDown={(e) => e.key === 'Enter' && handleLinkGoogleDoc()}
              autoFocus
            />
            <button
              onClick={handleLinkGoogleDoc}
              disabled={linkingDoc || !linkDocUrl.trim()}
              className="btn btn-primary btn-sm gap-1"
            >
              {linkingDoc ? <Loader2 className="h-3 w-3 animate-spin" /> : <FileText className="h-3 w-3" />}
              Vincular
            </button>
            <button onClick={() => { setShowLinkDoc(false); setLinkDocUrl(''); }} className="btn btn-ghost btn-sm">
              Cancelar
            </button>
          </div>
          <p className="text-[10px] text-base-content/40">
            Dica: Abra o <a href="https://docs.google.com/document/create" target="_blank" rel="noopener noreferrer" className="text-blue-500 underline">Google Docs</a>, crie um documento, e cole a URL aqui.
            O documento precisa estar como &quot;Qualquer pessoa com o link pode editar&quot;.
          </p>
        </div>
      )}

      {/* Versions panel */}
      {showVersions && (
        <div className="border-b border-base-300 bg-base-200/30 px-4 py-2 max-h-40 overflow-y-auto">
          {versions.length === 0 ? (
            <p className="text-xs text-base-content/50">Nenhuma versão salva</p>
          ) : (
            <div className="space-y-1">
              {versions.map((v) => (
                <div key={v.id} className="flex items-center justify-between text-xs">
                  <span className="font-medium">v{v.version}</span>
                  <span className="text-base-content/50">{v.saved_by.name}</span>
                  <span className="text-base-content/40">{formatDate(v.created_at)}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Editor */}
      <div className={`flex-1 overflow-y-auto ${editorMode === 'gdocs' ? 'p-0' : 'p-4'}`}>
        {regenerating ? (
          <div className="flex flex-col items-center justify-center py-20 gap-3">
            <Sparkles className="h-8 w-8 text-primary animate-pulse" />
            <p className="text-sm text-base-content/60">Gerando petição com IA... isso pode levar até 30 segundos</p>
          </div>
        ) : editorMode === 'gdocs' && googleDocUrl ? (
          <GoogleDocsEmbed
            docUrl={googleDocUrl}
            editable={isEditable}
            fullHeight
            petitionId={petition.id}
          />
        ) : (
          <TiptapEditor
            key={contentKey}
            initialContent={currentContent}
            onChange={handleEditorChange}
            editable={isEditable}
            placeholder="Comece a redigir sua petição..."
          />
        )}
      </div>
    </div>
  );
}

'use client';

import { useEffect, useMemo, useState } from 'react';
import {
  Kanban, Plus, Trash2, X, RefreshCw, Pencil, Check, Sparkles,
  GripVertical, Trophy, XCircle, Flag, ChevronDown,
  AlertCircle, Loader2, Cloud, CloudOff,
  Star, ArrowUp, ArrowDown,
} from 'lucide-react';
import api from '@/lib/api';

interface Stage {
  id: string;
  pipeline_id: string;
  name: string;
  slug: string;
  color: string | null;
  emoji: string | null;
  description: string | null;
  position: number;
  is_initial: boolean;
  is_won: boolean;
  is_lost: boolean;
  auto_actions?: any;
}

interface Pipeline {
  id: string;
  tenant_id: string | null;
  name: string;
  slug: string;
  description: string | null;
  color: string | null;
  is_default: boolean;
  is_active: boolean;
  position: number;
  stages: Stage[];
  _count: { leads: number; stages: number };
}

interface Template {
  key: string;
  name: string;
  slug: string;
  description: string;
  color: string;
  stage_count: number;
}

const COLOR_PALETTE = [
  { hex: '#ef4444', label: 'Vermelho' },
  { hex: '#f97316', label: 'Laranja' },
  { hex: '#eab308', label: 'Amarelo' },
  { hex: '#22c55e', label: 'Verde' },
  { hex: '#3b82f6', label: 'Azul' },
  { hex: '#a855f7', label: 'Roxo' },
  { hex: '#ec4899', label: 'Rosa' },
];

const EMOJI_SUGGESTIONS = ['👋', '🔍', '📅', '🩺', '📄', '📋', '💬', '✨', '✅', '❌', '🎯', '🦷', '🧑‍⚕️', '💰', '📱', '🏆'];

const STAGNATION_PRESETS = [1, 2, 3, 5, 7, 14];

// Espelha PipelinesService.normalizeSlug do backend para não divergir.
function normalizeSlug(raw: string): string {
  return raw
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50);
}

export default function PipelinesSettingsPage() {
  const [pipelines, setPipelines] = useState<Pipeline[]>([]);
  const [templates, setTemplates] = useState<Template[]>([]);
  const [loading, setLoading] = useState(true);
  const [showNewMenu, setShowNewMenu] = useState(false);
  const [showEmptyModal, setShowEmptyModal] = useState(false);
  const [expandedPipelineId, setExpandedPipelineId] = useState<string | null>(null);
  const [editingStageId, setEditingStageId] = useState<string | null>(null);

  const fetchData = async () => {
    setLoading(true);
    try {
      const [pRes, tRes] = await Promise.all([
        api.get('/pipelines'),
        api.get('/pipelines/templates'),
      ]);
      setPipelines(pRes.data);
      setTemplates(tRes.data);
    } catch (e) {
      console.error('Erro ao buscar funis:', e);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { fetchData(); }, []);

  const createFromTemplate = async (key: string) => {
    try {
      await api.post(`/pipelines/from-template/${key}`, { is_default: pipelines.length === 0 });
      setShowNewMenu(false);
      fetchData();
    } catch (e: any) {
      alert(e?.response?.data?.message || 'Erro ao criar funil a partir de template.');
    }
  };

  const deletePipeline = async (id: string, name: string) => {
    if (!confirm(`Excluir o funil "${name}"? Esta ação não pode ser desfeita.`)) return;
    try {
      await api.delete(`/pipelines/${id}`);
      fetchData();
    } catch (e: any) {
      alert(e?.response?.data?.message || 'Erro ao excluir funil.');
    }
  };

  const [migrating, setMigrating] = useState(false);
  const migrateLegacyLeads = async () => {
    const defaultPipe = pipelines.find(p => p.is_default) ?? pipelines[0];
    if (!defaultPipe) {
      alert('Crie um funil primeiro.');
      return;
    }
    const ok = confirm(
      `Migrar leads antigos (sem funil) para "${defaultPipe.name}"?\n\n` +
      `Isso vincula o campo stage legado (INICIAL, QUALIFICANDO, etc.) às etapas do funil. ` +
      `Operação idempotente — roda com segurança várias vezes.`,
    );
    if (!ok) return;
    setMigrating(true);
    try {
      const res = await api.post('/pipelines/backfill-legacy-stages', { pipeline_id: defaultPipe.id });
      const { migrated, total_candidates, by_stage } = res.data || {};
      const parts = Object.entries(by_stage || {}).map(([slug, n]) => `${slug}: ${n}`).join(', ');
      alert(`Migração concluída. ${migrated}/${total_candidates} lead(s) vinculado(s).\n\nPor etapa: ${parts || '—'}`);
      fetchData();
    } catch (e: any) {
      alert(e?.response?.data?.message || 'Erro ao migrar leads.');
    } finally {
      setMigrating(false);
    }
  };

  const togglePipeline = (id: string) => {
    setExpandedPipelineId(expandedPipelineId === id ? null : id);
  };

  const setDefaultPipeline = async (id: string) => {
    // Optimistic: marca este como default e desmarca os outros localmente
    setPipelines(prev => prev.map(p => ({ ...p, is_default: p.id === id })));
    try {
      await api.patch(`/pipelines/${id}`, { is_default: true });
    } catch (e: any) {
      alert(e?.response?.data?.message || 'Erro ao definir como padrão.');
      fetchData();
    }
  };

  const movePipeline = async (id: string, direction: 'up' | 'down') => {
    const sorted = [...pipelines].sort((a, b) => a.position - b.position);
    const idx = sorted.findIndex(p => p.id === id);
    if (idx < 0) return;
    const swapWith = direction === 'up' ? idx - 1 : idx + 1;
    if (swapWith < 0 || swapWith >= sorted.length) return;

    const a = sorted[idx];
    const b = sorted[swapWith];
    // Otimismo: troca posições localmente
    setPipelines(prev => prev.map(p => {
      if (p.id === a.id) return { ...p, position: b.position };
      if (p.id === b.id) return { ...p, position: a.position };
      return p;
    }));
    try {
      await Promise.all([
        api.patch(`/pipelines/${a.id}`, { position: b.position }),
        api.patch(`/pipelines/${b.id}`, { position: a.position }),
      ]);
    } catch (e: any) {
      alert(e?.response?.data?.message || 'Erro ao reordenar funis.');
      fetchData();
    }
  };

  return (
    <div className="flex-1 flex flex-col min-h-0 bg-background">
      <header className="p-8 border-b border-border bg-card/30 backdrop-blur-md">
        <div className="max-w-6xl mx-auto">
          <div className="flex items-center gap-3 mb-2">
            <div className="w-10 h-10 rounded-xl bg-primary/10 text-primary flex items-center justify-center">
              <Kanban size={24} />
            </div>
            <h1 className="text-3xl font-bold text-foreground tracking-tight">Funis de CRC</h1>
          </div>
          <p className="text-muted-foreground max-w-3xl">
            Crie múltiplos funis (ex: Odontologia, Estética) e configure as etapas de cada um. A IA usa essas etapas
            para classificar e mover leads automaticamente — edite aqui, sem precisar de deploy.
          </p>
        </div>
      </header>

      <div className="flex-1 overflow-y-auto p-8 custom-scrollbar">
        <div className="max-w-6xl mx-auto space-y-6">

          <StagnationSettings />

          <div className="flex justify-between items-center">
            <h2 className="text-xl font-bold text-foreground">
              {pipelines.length} funil(is) configurado(s)
            </h2>
            <div className="flex items-center gap-2">
              {pipelines.length > 0 && (
                <button
                  onClick={migrateLegacyLeads}
                  disabled={migrating}
                  className="px-3 py-2 rounded-xl text-sm font-semibold border border-border bg-card text-muted-foreground hover:text-foreground hover:bg-accent transition-all disabled:opacity-50 flex items-center gap-2"
                  title="Vincula leads sem funil ao funil padrão, mapeando pelo stage legado"
                >
                  {migrating ? <RefreshCw size={14} className="animate-spin" /> : <RefreshCw size={14} />}
                  Migrar leads antigos
                </button>
              )}
              <div className="relative">
              <button
                onClick={() => setShowNewMenu(v => !v)}
                className="bg-primary text-primary-foreground px-4 py-2 rounded-xl font-bold text-sm flex items-center gap-2 hover:bg-primary/90 transition-all shadow-lg shadow-primary/20"
              >
                <Plus size={18} />
                Novo Funil
                <ChevronDown size={14} />
              </button>
              {showNewMenu && (
                <>
                  <div className="fixed inset-0 z-10" onClick={() => setShowNewMenu(false)} />
                  <div className="absolute right-0 mt-2 w-72 bg-card border border-border rounded-2xl shadow-2xl z-20 overflow-hidden">
                    <button
                      onClick={() => { setShowEmptyModal(true); setShowNewMenu(false); }}
                      className="w-full text-left px-4 py-3 hover:bg-accent transition-colors border-b border-border"
                    >
                      <div className="font-bold text-sm text-foreground">Criar do zero</div>
                      <div className="text-xs text-muted-foreground">Define nome e adiciona etapas manualmente.</div>
                    </button>
                    <div className="px-4 py-2 bg-muted/30 border-b border-border">
                      <div className="text-[10px] font-black text-muted-foreground uppercase tracking-wider flex items-center gap-1.5">
                        <Sparkles size={10} /> Usar template
                      </div>
                    </div>
                    {templates.map(t => (
                      <button
                        key={t.key}
                        onClick={() => createFromTemplate(t.key)}
                        className="w-full text-left px-4 py-3 hover:bg-accent transition-colors border-b border-border last:border-b-0 flex items-center gap-3"
                      >
                        <div className="w-8 h-8 rounded-lg flex-shrink-0" style={{ backgroundColor: `${t.color}22`, border: `1px solid ${t.color}` }} />
                        <div className="flex-1 min-w-0">
                          <div className="font-bold text-sm text-foreground">{t.name}</div>
                          <div className="text-[11px] text-muted-foreground truncate">{t.stage_count} etapas · {t.description.slice(0, 60)}...</div>
                        </div>
                      </button>
                    ))}
                  </div>
                </>
              )}
              </div>
            </div>
          </div>

          {loading ? (
            <div className="py-20 flex flex-col items-center gap-4 text-muted-foreground">
              <RefreshCw className="animate-spin" size={40} />
              <p>Carregando funis...</p>
            </div>
          ) : pipelines.length === 0 ? (
            <div className="py-20 border-2 border-dashed border-border rounded-3xl flex flex-col items-center justify-center text-center px-6">
              <div className="w-16 h-16 bg-muted rounded-full flex items-center justify-center mb-4">
                <Kanban size={32} className="text-muted-foreground opacity-30" />
              </div>
              <h3 className="text-xl font-bold text-foreground mb-2">Nenhum funil configurado ainda</h3>
              <p className="text-muted-foreground max-w-md mb-6">
                Crie seu primeiro funil (ex: Odontologia) para organizar como a IA classifica e avança leads pelas etapas do atendimento.
              </p>
              <button
                onClick={() => setShowNewMenu(true)}
                className="bg-primary text-primary-foreground px-5 py-2.5 rounded-xl font-bold text-sm inline-flex items-center gap-2"
              >
                <Plus size={16} /> Criar primeiro funil
              </button>
            </div>
          ) : (
            <div className="space-y-4">
              {[...pipelines].sort((a, b) => a.position - b.position).map((p, idx, arr) => (
                <PipelineCard
                  key={p.id}
                  pipeline={p}
                  expanded={expandedPipelineId === p.id}
                  editingStageId={editingStageId}
                  isFirst={idx === 0}
                  isLast={idx === arr.length - 1}
                  onToggle={() => togglePipeline(p.id)}
                  onDelete={() => deletePipeline(p.id, p.name)}
                  onSetDefault={() => setDefaultPipeline(p.id)}
                  onMoveUp={() => movePipeline(p.id, 'up')}
                  onMoveDown={() => movePipeline(p.id, 'down')}
                  onRefresh={fetchData}
                  onEditStage={setEditingStageId}
                />
              ))}
            </div>
          )}
        </div>
      </div>

      {showEmptyModal && (
        <CreateEmptyModal
          onClose={() => setShowEmptyModal(false)}
          onCreated={() => { setShowEmptyModal(false); fetchData(); }}
        />
      )}
    </div>
  );
}

/* ──────────────────────────────────────────────────────────────
 * StagnationSettings — dias ate alerta de lead parado
 * (absorve a antiga pagina "CRM Pipeline (legado)")
 * ────────────────────────────────────────────────────────────── */

function StagnationSettings() {
  const [days, setDays] = useState<number>(3);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.get('/settings/crm-config')
      .then(r => { setDays(r.data.stagnationDays ?? 3); setError(null); })
      .catch(() => setError('Não foi possível carregar.'))
      .finally(() => setLoading(false));
  }, []);

  const save = async (value: number) => {
    const clamped = Math.max(1, Math.min(90, Math.round(value)));
    setDays(clamped);
    setSaving(true);
    setError(null);
    try {
      await api.patch('/settings/crm-config', { stagnationDays: clamped });
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
    } catch {
      setError('Erro ao salvar.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="bg-card border border-border rounded-2xl p-5">
      <div className="flex items-center gap-2 mb-4">
        <AlertCircle size={14} className="text-muted-foreground" />
        <h3 className="text-[11px] font-bold text-muted-foreground uppercase tracking-wider">
          Alerta de leads parados
        </h3>
        <div className="ml-auto flex items-center gap-2 min-h-[18px]">
          {saving && <Loader2 size={13} className="animate-spin text-muted-foreground" />}
          {saved && !saving && (
            <span className="flex items-center gap-1 text-xs text-emerald-400 font-semibold">
              <Cloud size={12} /> Salvo
            </span>
          )}
          {error && (
            <span className="flex items-center gap-1 text-xs text-red-400">
              <CloudOff size={12} /> {error}
            </span>
          )}
        </div>
      </div>

      {loading ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground py-2">
          <Loader2 size={14} className="animate-spin" /> Carregando…
        </div>
      ) : (
        <>
          <p className="text-[12px] text-muted-foreground mb-3">
            Exibir alerta no CRC quando um lead ficar sem mensagem por pelo menos{' '}
            <span className="text-foreground font-bold">{days} dia{days !== 1 ? 's' : ''}</span>
            {' '}(exceto nas etapas marcadas como ganho/perdido).
          </p>

          <div className="flex flex-wrap items-center gap-2">
            {STAGNATION_PRESETS.map((p) => (
              <button
                key={p}
                onClick={() => save(p)}
                disabled={saving}
                className={`px-3 py-1.5 rounded-lg text-[13px] font-semibold border transition-all disabled:opacity-50 ${
                  days === p
                    ? 'border-primary/60 bg-primary/10 text-primary'
                    : 'border-border bg-muted/20 text-muted-foreground hover:bg-muted/50 hover:text-foreground'
                }`}
              >
                {p} dia{p !== 1 ? 's' : ''}
              </button>
            ))}
            <div className="flex items-center gap-2 ml-2">
              <span className="text-[12px] text-muted-foreground">ou</span>
              <input
                type="number"
                min={1}
                max={90}
                value={days}
                disabled={saving}
                onChange={(e) => setDays(Number(e.target.value))}
                onBlur={(e) => save(Number(e.target.value))}
                onKeyDown={(e) => { if (e.key === 'Enter') save(Number((e.target as HTMLInputElement).value)); }}
                className="w-20 px-3 py-1.5 rounded-lg border border-border bg-background text-[13px] text-center focus:outline-none focus:border-primary transition-colors disabled:opacity-50"
              />
              <span className="text-[12px] text-muted-foreground">dias</span>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

/* ──────────────────────────────────────────────────────────────
 * PipelineCard
 * ────────────────────────────────────────────────────────────── */

function PipelineCard({
  pipeline, expanded, editingStageId, isFirst, isLast,
  onToggle, onDelete, onSetDefault, onMoveUp, onMoveDown, onRefresh, onEditStage,
}: {
  pipeline: Pipeline;
  expanded: boolean;
  editingStageId: string | null;
  isFirst: boolean;
  isLast: boolean;
  onToggle: () => void;
  onDelete: () => void;
  onSetDefault: () => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
  onRefresh: () => void;
  onEditStage: (id: string | null) => void;
}) {
  const color = pipeline.color || '#6b7280';

  return (
    <div className="bg-card border border-border rounded-2xl shadow-sm overflow-hidden relative">
      <div className="absolute left-0 top-0 bottom-0 w-1.5" style={{ backgroundColor: color }} />

      <div className="p-5 pl-8">
        <div className="flex items-center justify-between">
          <button onClick={onToggle} className="flex items-center gap-3 flex-1 text-left">
            <div
              className="w-10 h-10 rounded-xl flex items-center justify-center"
              style={{ backgroundColor: `${color}20`, color }}
            >
              <Kanban size={20} />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h3 className="text-lg font-black text-foreground">{pipeline.name}</h3>
                {pipeline.is_default && (
                  <span className="text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-md bg-primary/10 text-primary border border-primary/20">
                    Padrão
                  </span>
                )}
                <span className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">
                  slug: {pipeline.slug}
                </span>
              </div>
              <div className="text-xs text-muted-foreground mt-0.5">
                {pipeline._count.stages} etapas · {pipeline._count.leads} leads
                {pipeline.description && <span className="block mt-0.5 text-[11px] italic">"{pipeline.description.slice(0, 90)}{pipeline.description.length > 90 ? '...' : ''}"</span>}
              </div>
            </div>
          </button>
          <div className="flex items-center gap-1">
            {/* Reordenar: ↑ / ↓ */}
            <div className="flex flex-col">
              <button
                onClick={onMoveUp}
                disabled={isFirst}
                title="Mover para cima"
                className="p-0.5 text-muted-foreground hover:text-foreground hover:bg-accent rounded transition-all disabled:opacity-25 disabled:cursor-not-allowed"
              >
                <ArrowUp size={13} />
              </button>
              <button
                onClick={onMoveDown}
                disabled={isLast}
                title="Mover para baixo"
                className="p-0.5 text-muted-foreground hover:text-foreground hover:bg-accent rounded transition-all disabled:opacity-25 disabled:cursor-not-allowed"
              >
                <ArrowDown size={13} />
              </button>
            </div>
            {/* Marcar como padrão */}
            <button
              onClick={onSetDefault}
              disabled={pipeline.is_default}
              title={pipeline.is_default ? 'Já é o funil padrão' : 'Definir como funil padrão'}
              className={`p-2 rounded-lg transition-all ${
                pipeline.is_default
                  ? 'text-primary cursor-default'
                  : 'text-muted-foreground hover:text-primary hover:bg-primary/10'
              }`}
            >
              <Star size={16} fill={pipeline.is_default ? 'currentColor' : 'none'} />
            </button>
            <ChevronDown size={18} className={`text-muted-foreground transition-transform ${expanded ? 'rotate-180' : ''}`} />
            <button
              onClick={onDelete}
              className="p-2 text-muted-foreground hover:text-red-500 hover:bg-red-500/10 rounded-lg transition-all"
              title="Excluir funil"
            >
              <Trash2 size={16} />
            </button>
          </div>
        </div>

        {expanded && (
          <div className="mt-5 pt-5 border-t border-border">
            <StagesList
              pipeline={pipeline}
              editingStageId={editingStageId}
              onEditStage={onEditStage}
              onRefresh={onRefresh}
            />
          </div>
        )}
      </div>
    </div>
  );
}

/* ──────────────────────────────────────────────────────────────
 * StagesList — lista de etapas do funil com inline add/edit
 * ────────────────────────────────────────────────────────────── */

function StagesList({
  pipeline, editingStageId, onEditStage, onRefresh,
}: {
  pipeline: Pipeline;
  editingStageId: string | null;
  onEditStage: (id: string | null) => void;
  onRefresh: () => void;
}) {
  const [adding, setAdding] = useState(false);
  const [newStage, setNewStage] = useState<Partial<Stage>>({ name: '', emoji: '👋', color: '#3b82f6' });

  const addStage = async () => {
    if (!newStage.name?.trim()) return;
    try {
      await api.post(`/pipelines/${pipeline.id}/stages`, {
        name: newStage.name,
        slug: normalizeSlug(newStage.name),
        emoji: newStage.emoji || null,
        color: newStage.color || null,
        position: pipeline.stages.length,
      });
      setAdding(false);
      setNewStage({ name: '', emoji: '👋', color: '#3b82f6' });
      onRefresh();
    } catch (e: any) {
      alert(e?.response?.data?.message || 'Erro ao criar etapa.');
    }
  };

  const deleteStage = async (stage: Stage) => {
    if (!confirm(`Excluir a etapa "${stage.name}"?`)) return;
    try {
      await api.delete(`/pipelines/${pipeline.id}/stages/${stage.id}`);
      onRefresh();
    } catch (e: any) {
      alert(e?.response?.data?.message || 'Erro ao excluir etapa.');
    }
  };

  const setFlag = async (stage: Stage, flag: 'is_initial' | 'is_won' | 'is_lost', value: boolean) => {
    try {
      await api.patch(`/pipelines/${pipeline.id}/stages/${stage.id}`, { [flag]: value });
      onRefresh();
    } catch (e: any) {
      alert(e?.response?.data?.message || 'Erro ao atualizar flag.');
    }
  };

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between mb-3">
        <h4 className="text-[11px] font-black text-muted-foreground uppercase tracking-wider">Etapas do funil</h4>
        {!adding && (
          <button
            onClick={() => setAdding(true)}
            className="text-xs font-bold text-primary hover:text-primary/80 flex items-center gap-1"
          >
            <Plus size={12} /> Nova etapa
          </button>
        )}
      </div>

      {pipeline.stages.map(s => (
        <StageRow
          key={s.id}
          stage={s}
          isEditing={editingStageId === s.id}
          onStartEdit={() => onEditStage(s.id)}
          onCancelEdit={() => onEditStage(null)}
          onDelete={() => deleteStage(s)}
          onSetFlag={(flag, value) => setFlag(s, flag, value)}
          onSaved={onRefresh}
          pipelineId={pipeline.id}
        />
      ))}

      {adding && (
        <div className="flex items-center gap-2 p-3 bg-muted/30 border-2 border-dashed border-primary/30 rounded-xl">
          <select
            value={newStage.emoji || ''}
            onChange={(e) => setNewStage({ ...newStage, emoji: e.target.value })}
            className="w-14 text-xl bg-background border border-border rounded-lg px-1 py-1.5 text-center"
          >
            {EMOJI_SUGGESTIONS.map(e => <option key={e} value={e}>{e}</option>)}
          </select>
          <input
            type="text"
            autoFocus
            value={newStage.name || ''}
            onChange={(e) => setNewStage({ ...newStage, name: e.target.value })}
            onKeyDown={(e) => e.key === 'Enter' && addStage()}
            placeholder="Nome da etapa (ex: Qualificando)"
            className="flex-1 bg-background border border-border rounded-lg px-3 py-2 text-sm outline-none focus:border-primary/50"
          />
          <ColorPicker value={newStage.color || '#3b82f6'} onChange={(c) => setNewStage({ ...newStage, color: c })} />
          <button
            onClick={addStage}
            className="bg-primary text-primary-foreground px-3 py-2 rounded-lg font-bold text-xs hover:bg-primary/90"
          >
            <Check size={14} />
          </button>
          <button
            onClick={() => { setAdding(false); setNewStage({ name: '', emoji: '👋', color: '#3b82f6' }); }}
            className="p-2 text-muted-foreground hover:text-foreground"
          >
            <X size={14} />
          </button>
        </div>
      )}

      {pipeline.stages.length === 0 && !adding && (
        <div className="text-center py-6 text-sm text-muted-foreground italic">
          Nenhuma etapa ainda. Clique em "Nova etapa" para começar.
        </div>
      )}
    </div>
  );
}

/* ──────────────────────────────────────────────────────────────
 * StageRow — linha de etapa com edit inline + flags
 * ────────────────────────────────────────────────────────────── */

function StageRow({
  stage, isEditing, pipelineId,
  onStartEdit, onCancelEdit, onDelete, onSetFlag, onSaved,
}: {
  stage: Stage;
  isEditing: boolean;
  pipelineId: string;
  onStartEdit: () => void;
  onCancelEdit: () => void;
  onDelete: () => void;
  onSetFlag: (flag: 'is_initial' | 'is_won' | 'is_lost', value: boolean) => void;
  onSaved: () => void;
}) {
  const [editName, setEditName] = useState(stage.name);
  const [editEmoji, setEditEmoji] = useState(stage.emoji || '');
  const [editColor, setEditColor] = useState(stage.color || '#3b82f6');
  const [editDescription, setEditDescription] = useState(stage.description || '');

  const save = async () => {
    try {
      await api.patch(`/pipelines/${pipelineId}/stages/${stage.id}`, {
        name: editName,
        emoji: editEmoji || null,
        color: editColor || null,
        description: editDescription || null,
      });
      onCancelEdit();
      onSaved();
    } catch (e: any) {
      alert(e?.response?.data?.message || 'Erro ao salvar etapa.');
    }
  };

  if (isEditing) {
    return (
      <div className="p-3 bg-muted/30 border-2 border-primary/30 rounded-xl space-y-2">
        <div className="flex items-center gap-2">
          <select
            value={editEmoji}
            onChange={(e) => setEditEmoji(e.target.value)}
            className="w-14 text-xl bg-background border border-border rounded-lg px-1 py-1.5 text-center"
          >
            <option value="">—</option>
            {EMOJI_SUGGESTIONS.map(e => <option key={e} value={e}>{e}</option>)}
          </select>
          <input
            type="text"
            value={editName}
            onChange={(e) => setEditName(e.target.value)}
            className="flex-1 bg-background border border-border rounded-lg px-3 py-2 text-sm outline-none focus:border-primary/50"
          />
          <ColorPicker value={editColor} onChange={setEditColor} />
        </div>
        <textarea
          value={editDescription}
          onChange={(e) => setEditDescription(e.target.value)}
          placeholder="Descrição para a IA: quando mover o lead para esta etapa?"
          rows={2}
          className="w-full bg-background border border-border rounded-lg px-3 py-2 text-xs outline-none focus:border-primary/50 resize-none"
        />
        <div className="flex justify-end gap-2">
          <button
            onClick={onCancelEdit}
            className="px-3 py-1.5 text-xs font-bold text-muted-foreground hover:text-foreground"
          >
            Cancelar
          </button>
          <button
            onClick={save}
            className="bg-primary text-primary-foreground px-4 py-1.5 rounded-lg font-bold text-xs"
          >
            Salvar
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2 p-2.5 rounded-xl hover:bg-accent/30 transition-all group">
      <GripVertical size={14} className="text-muted-foreground/40 cursor-grab" />
      <div
        className="w-8 h-8 rounded-lg flex items-center justify-center text-base flex-shrink-0"
        style={{ backgroundColor: `${stage.color || '#6b7280'}20`, color: stage.color || '#6b7280' }}
      >
        {stage.emoji || '•'}
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="font-bold text-sm text-foreground truncate">{stage.name}</span>
          <span className="text-[10px] text-muted-foreground font-mono">{stage.slug}</span>
          {stage.is_initial && <FlagBadge icon={<Flag size={9} />} label="inicial" color="text-blue-500 bg-blue-500/10" />}
          {stage.is_won && <FlagBadge icon={<Trophy size={9} />} label="ganho" color="text-emerald-500 bg-emerald-500/10" />}
          {stage.is_lost && <FlagBadge icon={<XCircle size={9} />} label="perdido" color="text-red-500 bg-red-500/10" />}
        </div>
        {stage.description && (
          <div className="text-[11px] text-muted-foreground mt-0.5 truncate">{stage.description}</div>
        )}
      </div>
      <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
        <FlagToggle active={stage.is_initial} icon={<Flag size={11} />} title="Marcar como inicial"
          onClick={() => onSetFlag('is_initial', !stage.is_initial)} />
        <FlagToggle active={stage.is_won} icon={<Trophy size={11} />} title="Marcar como ganho"
          onClick={() => onSetFlag('is_won', !stage.is_won)} />
        <FlagToggle active={stage.is_lost} icon={<XCircle size={11} />} title="Marcar como perdido"
          onClick={() => onSetFlag('is_lost', !stage.is_lost)} />
        <button onClick={onStartEdit}
          className="p-1.5 text-muted-foreground hover:text-primary hover:bg-primary/10 rounded-lg">
          <Pencil size={12} />
        </button>
        <button onClick={onDelete}
          className="p-1.5 text-muted-foreground hover:text-red-500 hover:bg-red-500/10 rounded-lg">
          <Trash2 size={12} />
        </button>
      </div>
    </div>
  );
}

function FlagBadge({ icon, label, color }: { icon: React.ReactNode; label: string; color: string }) {
  return (
    <span className={`text-[9px] font-black uppercase tracking-wider px-1.5 py-0.5 rounded ${color} flex items-center gap-1`}>
      {icon} {label}
    </span>
  );
}

function FlagToggle({ active, icon, title, onClick }: { active: boolean; icon: React.ReactNode; title: string; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      title={title}
      className={`p-1.5 rounded-lg transition-all ${active ? 'bg-primary/10 text-primary' : 'text-muted-foreground hover:text-foreground hover:bg-accent'}`}
    >
      {icon}
    </button>
  );
}

function ColorPicker({ value, onChange }: { value: string; onChange: (c: string) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen(v => !v)}
        className="w-9 h-9 rounded-lg border-2 border-border hover:border-primary/40 transition-all"
        style={{ backgroundColor: value }}
        title={value}
      />
      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div className="absolute right-0 top-full mt-1 p-2 bg-card border border-border rounded-xl shadow-xl z-20 flex gap-1">
            {COLOR_PALETTE.map(c => (
              <button
                key={c.hex}
                type="button"
                onClick={() => { onChange(c.hex); setOpen(false); }}
                className="w-7 h-7 rounded-lg hover:scale-110 transition-all"
                style={{ backgroundColor: c.hex }}
                title={c.label}
              />
            ))}
          </div>
        </>
      )}
    </div>
  );
}

/* ──────────────────────────────────────────────────────────────
 * CreateEmptyModal — criar funil do zero
 * ────────────────────────────────────────────────────────────── */

function CreateEmptyModal({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [color, setColor] = useState('#3b82f6');
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) { setErr('Informe o nome.'); return; }
    setSaving(true);
    setErr('');
    try {
      const slug = normalizeSlug(name);
      if (!slug) { setErr('Informe um nome válido.'); setSaving(false); return; }
      await api.post('/pipelines', { name, slug, description: description || null, color });
      onCreated();
    } catch (e: any) {
      setErr(e?.response?.data?.message || 'Erro ao criar funil.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
      <div className="relative z-10 w-full max-w-md bg-card border border-border rounded-2xl shadow-2xl overflow-hidden">
        <div className="flex items-center justify-between px-6 py-5 border-b border-border bg-foreground/[0.02]">
          <h2 className="text-lg font-bold tracking-tight">Novo funil</h2>
          <button onClick={onClose} className="p-1.5 hover:bg-foreground/[0.05] rounded-lg">
            <X size={18} />
          </button>
        </div>
        <form onSubmit={save} className="p-6 space-y-4">
          {err && (
            <div className="p-3 bg-destructive/10 border border-destructive/20 rounded-xl text-destructive text-[13px]">{err}</div>
          )}
          <div className="space-y-1.5">
            <label className="text-[12px] font-bold text-muted-foreground uppercase tracking-wider">Nome</label>
            <input
              autoFocus
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Ex: Odontologia, Estética Facial, B2B"
              className="w-full bg-background border border-border rounded-xl px-4 py-2.5 outline-none focus:border-primary/50"
              required
            />
          </div>
          <div className="space-y-1.5">
            <label className="text-[12px] font-bold text-muted-foreground uppercase tracking-wider">Descrição (pra IA)</label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={3}
              placeholder="Quando a IA deve usar este funil? Ex: 'Leads interessados em procedimentos odontológicos convencionais'"
              className="w-full bg-background border border-border rounded-xl px-4 py-2.5 text-sm outline-none focus:border-primary/50 resize-none"
            />
          </div>
          <div className="space-y-1.5">
            <label className="text-[12px] font-bold text-muted-foreground uppercase tracking-wider">Cor</label>
            <div className="flex gap-2">
              {COLOR_PALETTE.map(c => (
                <button
                  key={c.hex}
                  type="button"
                  onClick={() => setColor(c.hex)}
                  className={`w-9 h-9 rounded-full flex items-center justify-center transition-all ${color === c.hex ? 'ring-2 ring-offset-2 ring-offset-card scale-110' : ''}`}
                  style={{ backgroundColor: c.hex, ['--tw-ring-color' as any]: c.hex }}
                >
                  {color === c.hex && <Check className="w-4 h-4 text-white" strokeWidth={3} />}
                </button>
              ))}
            </div>
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <button type="button" onClick={onClose} className="px-5 py-2.5 text-sm font-bold text-muted-foreground hover:text-foreground hover:bg-foreground/[0.05] rounded-xl transition-all">
              Cancelar
            </button>
            <button type="submit" disabled={saving} className="px-6 py-2.5 bg-primary text-primary-foreground font-bold rounded-xl transition-all disabled:opacity-50 flex items-center gap-2">
              {saving && <RefreshCw size={14} className="animate-spin" />}
              Criar funil
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

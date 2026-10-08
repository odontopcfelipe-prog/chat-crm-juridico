'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import {
  Brain,
  MapPin,
  Users,
  DollarSign,
  ClipboardList,
  Stethoscope,
  CreditCard,
  Scale,
  BookOpen,
  Phone,
  ShieldAlert,
  Layers,
  Tag,
  Archive,
  Plus,
  Pencil,
  Trash2,
  ChevronDown,
  ChevronRight,
  Search,
  Play,
  Loader2,
  CheckCircle2,
  AlertCircle,
  Sparkles,
  RefreshCw,
  Save,
  X,
  Lock,
  RotateCcw,
  Settings,
  Cpu,
  FileCode2,
} from 'lucide-react';
import api from '@/lib/api';
import {
  ORG_MEMORY_SUBCATEGORIES,
  LEGACY_ORG_MEMORY_SUBCATEGORIES,
  ORG_MEMORY_LABELS,
  ORG_MEMORY_PRICE_RE,
  archiveEffectText,
  isOrgMemorySubcategory,
  orgMemoryLabel,
  orgSummaryNote,
  type OrgSummaryState,
} from './memory-categories';
import { MemoryReviewPanel, type ActiveMemorySnapshot } from './MemoryReviewPanel';

type IconCmp = React.ComponentType<{ className?: string; size?: number }>;

const CATEGORY_ICONS: Record<string, IconCmp> = {
  office_info: MapPin,
  team: Users,
  procedures: ClipboardList,
  treatments: Stethoscope,
  payment: CreditCard,
  rules: ShieldAlert,
  // antigas (sistema jurídico) — só aparecem se ainda tiverem memórias
  fees: DollarSign,
  court_info: Scale,
  legal_knowledge: BookOpen,
  contacts: Phone,
};

interface CategoryView {
  key: string;
  label: string;
  hint: string;
  icon: IconCmp;
  /** Categoria antiga/desconhecida: não oferece "adicionar" e mostra a dica sempre. */
  legacy: boolean;
}

/** Onde a clínica configura preços (a memória não guarda valores). */
const PRICES_HREF = '/atendimento/settings/ai#etapa-valores';

/**
 * Parece preço? ("R$ 150", "150 reais", "10% de desconto") — preço não fica na
 * memória. Mesma regra da revisão/extração (ORG_MEMORY_PRICE_RE do shared).
 */
function looksLikePrice(text: string): boolean {
  return ORG_MEMORY_PRICE_RE.test(text);
}

/** A atualização do resumo roda ~60s depois de arquivar/restaurar (debounce da API) + o tempo da IA. */
const PROFILE_REFRESH_DELAY_MS = 90_000;

interface MemoryItem {
  id: string;
  content: string;
  subcategory: string | null;
  confidence: number;
  source_type: string;
  created_at: string;
  updated_at: string;
}

interface OrgMemoriesResponse {
  groups: Record<string, MemoryItem[]>;
  total: number;
}

interface OrgStats {
  total: number;
  by_subcategory: Record<string, number>;
  last_extraction: string | null;
}

interface OrgProfile {
  id: string;
  summary: string;
  facts: any;
  source_memory_count: number;
  generated_at: string;
  version: number;
  manually_edited_at: string | null;
}

interface ModelOption {
  value: string;
  label: string;
}

interface OrgProfileSettings {
  model: string;
  model_default: string;
  available_models: ModelOption[];
  incremental_prompt: string;
  incremental_prompt_default: string;
  incremental_is_custom: boolean;
  rebuild_prompt: string;
  rebuild_prompt_default: string;
  rebuild_is_custom: boolean;
}

function formatSourceLabel(src: string): string {
  switch (src) {
    case 'batch':
      return 'Extração automática';
    case 'manual':
      return 'Adicionada manualmente';
    case 'retroactive':
      return 'Extração retroativa';
    default:
      return src;
  }
}

function formatDate(iso: string | null): string {
  if (!iso) return '—';
  try {
    const d = new Date(iso);
    return d.toLocaleString('pt-BR', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      timeZone: 'America/Maceio',
    });
  } catch {
    return iso;
  }
}

export default function KnowledgeSettingsPage() {
  const [groups, setGroups] = useState<Record<string, MemoryItem[]>>({});
  const [stats, setStats] = useState<OrgStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>({
    office_info: true,
    team: true,
  });
  const [search, setSearch] = useState('');
  const [adding, setAdding] = useState<{ subcategory: string } | null>(null);
  const [editing, setEditing] = useState<MemoryItem | null>(null);
  const [newContent, setNewContent] = useState('');
  const [editContent, setEditContent] = useState('');
  // Categoria na edição ('' = manter a atual; usado pra tirar memória de categoria antiga)
  const [editSubcategory, setEditSubcategory] = useState('');
  const [saving, setSaving] = useState(false);
  const [archivingId, setArchivingId] = useState<string | null>(null);
  // Muda quando arquiva por aqui → o painel recarrega a lista de arquivadas se estiver aberta
  const [archivedVersion, setArchivedVersion] = useState(0);
  const [batchEnabled, setBatchEnabled] = useState(true);
  const [extracting, setExtracting] = useState(false);
  const [message, setMessage] = useState<{ text: string; type: 'ok' | 'err' | 'warn' } | null>(null);
  const feedbackTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const profileTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [orgProfile, setOrgProfile] = useState<OrgProfile | null>(null);
  const [profileOpen, setProfileOpen] = useState(true);
  const [regeneratingProfile, setRegeneratingProfile] = useState(false);
  const [editingProfile, setEditingProfile] = useState(false);
  const [editProfileContent, setEditProfileContent] = useState('');
  const [savingProfile, setSavingProfile] = useState(false);
  const [rebuildingProfile, setRebuildingProfile] = useState(false);

  // Configuracoes avancadas (modelo + prompts)
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [settings, setSettings] = useState<OrgProfileSettings | null>(null);
  const [settingsLoading, setSettingsLoading] = useState(false);
  const [settingsSaving, setSettingsSaving] = useState(false);
  const [editModel, setEditModel] = useState('');
  const [editIncremental, setEditIncremental] = useState('');
  const [editRebuild, setEditRebuild] = useState('');
  const [activePromptTab, setActivePromptTab] = useState<'incremental' | 'rebuild'>('incremental');

  // quiet=true: recarrega sem trocar a lista pelo "Carregando..." (ex.: depois de arquivar)
  const loadData = useCallback(async (quiet = false) => {
    if (!quiet) setLoading(true);
    setError(null);
    try {
      const [memsRes, statsRes, settingsRes, profileRes] = await Promise.all([
        api.get<OrgMemoriesResponse>('/memories/organization'),
        api.get<OrgStats>('/memories/organization/stats'),
        api.get('/settings'),
        api.get<OrgProfile | null>('/memories/organization/profile'),
      ]);
      setGroups(memsRes.data.groups || {});
      setStats(statsRes.data);
      setOrgProfile(profileRes.data);
      const rows = Array.isArray(settingsRes.data) ? settingsRes.data : [];
      const flag = rows.find((r: any) => r?.key === 'MEMORY_BATCH_ENABLED');
      setBatchEnabled((flag?.value ?? 'true').toLowerCase() !== 'false');
    } catch (e: any) {
      setError(e?.response?.data?.message || e.message || 'Erro ao carregar');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadData();
  }, [loadData]);

  const reloadQuiet = useCallback(() => loadData(true), [loadData]);

  // Resumo: sem resumo a IA lê as memórias cruas; editado à mão não muda sozinho.
  const summaryState: OrgSummaryState = !orgProfile ? 'none' : orgProfile.manually_edited_at ? 'manual' : 'auto';

  // Memórias ativas (id → texto/categoria): o painel de revisão tira/desmarca
  // sugestões velhas quando a lista recarrega (editar, apagar, arquivar pela lista).
  const activeMemories = useMemo(() => {
    const map = new Map<string, ActiveMemorySnapshot>();
    for (const items of Object.values(groups)) {
      for (const m of items) map.set(m.id, { content: m.content, subcategory: m.subcategory ?? null });
    }
    return map;
  }, [groups]);

  // Depois de arquivar/restaurar, a API atualiza o resumo em ~1 min: busca de novo
  // só o resumo (não mexe na lista nem em edição aberta).
  const refreshProfileLater = useCallback(() => {
    if (profileTimerRef.current) clearTimeout(profileTimerRef.current);
    profileTimerRef.current = setTimeout(async () => {
      profileTimerRef.current = null;
      try {
        const res = await api.get<OrgProfile | null>('/memories/organization/profile');
        setOrgProfile(res.data);
      } catch {
        // fica o resumo atual — recarregar a página resolve
      }
    }, PROFILE_REFRESH_DELAY_MS);
  }, []);

  useEffect(
    () => () => {
      if (profileTimerRef.current) clearTimeout(profileTimerRef.current);
      if (feedbackTimerRef.current) clearTimeout(feedbackTimerRef.current);
    },
    [],
  );

  const toggleGroup = (key: string) =>
    setOpenGroups((prev) => ({ ...prev, [key]: !prev[key] }));

  // As 6 categorias da clínica sempre; antigas (jurídico) e desconhecidas só se
  // ainda tiverem memórias — pra poder revisar/mover/arquivar.
  const categories = useMemo<CategoryView[]>(() => {
    const out: CategoryView[] = ORG_MEMORY_SUBCATEGORIES.map((key) => ({
      key,
      label: ORG_MEMORY_LABELS[key].label,
      hint: ORG_MEMORY_LABELS[key].hint,
      icon: CATEGORY_ICONS[key] ?? Layers,
      legacy: false,
    }));
    const known = new Set<string>([...ORG_MEMORY_SUBCATEGORIES, ...LEGACY_ORG_MEMORY_SUBCATEGORIES]);
    const extraKeys = [
      ...LEGACY_ORG_MEMORY_SUBCATEGORIES,
      ...Object.keys(groups).filter((k) => !known.has(k)),
    ];
    for (const key of extraKeys) {
      if (!(groups[key]?.length > 0)) continue;
      const meta = ORG_MEMORY_LABELS[key];
      out.push({
        key,
        label: meta ? meta.label : `${orgMemoryLabel(key)} (antigo)`,
        hint: meta ? meta.hint : 'Mova para uma das categorias novas ou arquive',
        icon: CATEGORY_ICONS[key] ?? Layers,
        legacy: true,
      });
    }
    return out;
  }, [groups]);

  const filteredGroups = useMemo(() => {
    if (!search.trim()) return groups;
    const q = search.trim().toLowerCase();
    const out: Record<string, MemoryItem[]> = {};
    for (const [k, items] of Object.entries(groups)) {
      const filtered = items.filter((m) => m.content.toLowerCase().includes(q));
      if (filtered.length > 0) out[k] = filtered;
    }
    return out;
  }, [groups, search]);

  // Um timer só: aviso novo não é apagado pelo timer do anterior.
  const showFeedback = (text: string, type: 'ok' | 'err' | 'warn' = 'ok', ms = 4000) => {
    setMessage({ text, type });
    if (feedbackTimerRef.current) clearTimeout(feedbackTimerRef.current);
    feedbackTimerRef.current = setTimeout(() => {
      feedbackTimerRef.current = null;
      setMessage(null);
    }, ms);
  };

  const handleAdd = async () => {
    if (!adding) return;
    const content = newContent.trim();
    if (content.length < 5) {
      showFeedback('Conteúdo muito curto (mín. 5 caracteres)', 'err');
      return;
    }
    if (
      looksLikePrice(content) &&
      !confirm('Isto parece um preço. Preços ficam em Ajustes IA › Valores, não aqui. Salvar mesmo assim?')
    ) {
      return;
    }
    setSaving(true);
    try {
      await api.post('/memories/organization', {
        content,
        subcategory: adding.subcategory,
      });
      setNewContent('');
      setAdding(null);
      await loadData();
      showFeedback('Memória adicionada');
    } catch (e: any) {
      showFeedback(e?.response?.data?.message || 'Erro ao adicionar', 'err');
    } finally {
      setSaving(false);
    }
  };

  const handleUpdate = async () => {
    if (!editing) return;
    const content = editContent.trim();
    if (content.length < 5) {
      showFeedback('Conteúdo muito curto', 'err');
      return;
    }
    if (
      content !== editing.content.trim() &&
      looksLikePrice(content) &&
      !confirm('Isto parece um preço. Preços ficam em Ajustes IA › Valores, não aqui. Salvar mesmo assim?')
    ) {
      return;
    }
    // Só manda a categoria se mudou (serve pra tirar memória de categoria antiga)
    const payload: { content: string; subcategory?: string } = { content };
    if (editSubcategory && editSubcategory !== editing.subcategory) payload.subcategory = editSubcategory;
    setSaving(true);
    try {
      await api.put(`/memories/${editing.id}`, payload);
      setEditing(null);
      setEditContent('');
      setEditSubcategory('');
      await loadData();
      showFeedback('Memória atualizada');
    } catch (e: any) {
      showFeedback(e?.response?.data?.message || 'Erro ao atualizar', 'err');
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (id: string) => {
    if (
      !confirm(
        // Apagar NÃO passa pela atualização do resumo (só arquivar passa): no resumo
        // automático o fato continua lá até Refazer do zero — por isso o texto próprio.
        `Apagar esta memória de vez? Não dá pra desfazer. ${
          summaryState === 'auto'
            ? 'Atenção: apagar NÃO tira isso do resumo da clínica, que é o que a IA usa. Para a IA parar de usar, prefira "Arquivar" (o resumo se atualiza em cerca de 1 minuto).'
            : archiveEffectText(summaryState, 1)
        }\n\nSe quiser poder desfazer, use "Arquivar".`,
      )
    )
      return;
    try {
      await api.delete(`/memories/${id}`);
      await loadData();
      showFeedback('Memória removida');
    } catch (e: any) {
      showFeedback(e?.response?.data?.message || 'Erro ao remover', 'err');
    }
  };

  // Arquivar não apaga: sai da base e dá pra restaurar em "Ver arquivadas".
  // Confirma antes (como o apagar): o que muda pra IA depende do resumo da clínica.
  const handleArchive = async (id: string) => {
    if (
      !confirm(
        `Arquivar esta memória? ${archiveEffectText(summaryState, 1)}\n\nArquivar não apaga: dá pra restaurar em Ver arquivadas.`,
      )
    )
      return;
    setArchivingId(id);
    try {
      const res = await api.post<{ archived?: number; summary?: string }>('/memories/organization/archive', {
        ids: [id],
      });
      const n = Number(res.data?.archived ?? 1);
      await loadData(true);
      setArchivedVersion((v) => v + 1);
      if (n <= 0) {
        showFeedback('Essa memória já não estava ativa — a lista foi atualizada', 'err');
        return;
      }
      const note = orgSummaryNote(res.data?.summary, summaryState, n);
      if (note?.outcome === 'regen_queued') refreshProfileLater();
      const base = 'Memória arquivada — dá pra restaurar em "Ver arquivadas".';
      if (!note) showFeedback(base);
      else if (note.tone === 'warn') showFeedback(`${base} ${note.text}`, 'warn', 12000);
      else showFeedback(`${base} ${note.text}`, 'ok', 6000);
    } catch (e: any) {
      showFeedback(e?.response?.data?.message || 'Erro ao arquivar', 'err');
    } finally {
      setArchivingId(null);
    }
  };

  const handleToggleBatch = async (next: boolean) => {
    try {
      await api.put('/settings', {
        key: 'MEMORY_BATCH_ENABLED',
        value: next ? 'true' : 'false',
      });
      setBatchEnabled(next);
      showFeedback(next ? 'Extração diária ativada' : 'Extração diária desativada');
    } catch (e: any) {
      showFeedback(e?.response?.data?.message || 'Erro ao salvar', 'err');
    }
  };

  const handleExtractNow = async () => {
    setExtracting(true);
    try {
      await api.post('/memories/extract-now');
      showFeedback('Extração disparada — resultado em alguns minutos');
    } catch (e: any) {
      showFeedback(e?.response?.data?.message || 'Erro ao extrair', 'err');
    } finally {
      setExtracting(false);
    }
  };

  const handleRegenerateProfile = async () => {
    // Se tem edição manual, confirma antes de sobrescrever
    if (orgProfile?.manually_edited_at) {
      const ok = confirm(
        'Este resumo foi editado à mão. A atualização pode ajustar o texto com as memórias novas. Continuar?',
      );
      if (!ok) return;
    }
    setRegeneratingProfile(true);
    try {
      await api.post('/memories/organization/regenerate-profile');
      showFeedback('Atualização do resumo pedida — fica pronta em ~1 minuto');
      setTimeout(() => loadData(true), 8000);
    } catch (e: any) {
      showFeedback(e?.response?.data?.message || 'Erro ao regenerar', 'err');
    } finally {
      setRegeneratingProfile(false);
    }
  };

  const handleRebuildProfile = async () => {
    const ok = confirm(
      'REFAZER DO ZERO vai DESCARTAR o texto atual (incluindo edições manuais) e gerar um resumo completamente novo a partir de todas as memórias. Use apenas quando o texto atual acumulou problemas ou ficou muito desatualizado.\n\nContinuar?',
    );
    if (!ok) return;
    setRebuildingProfile(true);
    try {
      await api.post('/memories/organization/rebuild-profile');
      showFeedback('Resumo sendo refeito — fica pronto em ~1 minuto');
      setTimeout(() => loadData(true), 8000);
    } catch (e: any) {
      showFeedback(e?.response?.data?.message || 'Erro ao refazer', 'err');
    } finally {
      setRebuildingProfile(false);
    }
  };

  // ─── Configurações avançadas ──────────────────────────────────────

  const loadSettings = useCallback(async () => {
    setSettingsLoading(true);
    try {
      const res = await api.get<OrgProfileSettings>('/memories/organization/settings');
      setSettings(res.data);
      setEditModel(res.data.model);
      setEditIncremental(res.data.incremental_is_custom ? res.data.incremental_prompt : '');
      setEditRebuild(res.data.rebuild_is_custom ? res.data.rebuild_prompt : '');
    } catch (e: any) {
      showFeedback(e?.response?.data?.message || 'Erro ao carregar configurações', 'err');
    } finally {
      setSettingsLoading(false);
    }
  }, []);

  useEffect(() => {
    if (advancedOpen && !settings) loadSettings();
  }, [advancedOpen, settings, loadSettings]);

  const handleSaveSettings = async () => {
    if (!settings) return;
    setSettingsSaving(true);
    try {
      const payload: any = {};
      if (editModel !== settings.model) payload.model = editModel;
      // Compara contra o valor atual (pode ser string vazia se está usando default)
      const currentIncremental = settings.incremental_is_custom ? settings.incremental_prompt : '';
      if (editIncremental !== currentIncremental) payload.incremental_prompt = editIncremental;
      const currentRebuild = settings.rebuild_is_custom ? settings.rebuild_prompt : '';
      if (editRebuild !== currentRebuild) payload.rebuild_prompt = editRebuild;

      if (Object.keys(payload).length === 0) {
        showFeedback('Nenhuma alteração a salvar', 'err');
        return;
      }
      const res = await api.put<OrgProfileSettings>('/memories/organization/settings', payload);
      setSettings(res.data);
      setEditModel(res.data.model);
      setEditIncremental(res.data.incremental_is_custom ? res.data.incremental_prompt : '');
      setEditRebuild(res.data.rebuild_is_custom ? res.data.rebuild_prompt : '');
      showFeedback('Configurações salvas');
    } catch (e: any) {
      showFeedback(e?.response?.data?.message || 'Erro ao salvar', 'err');
    } finally {
      setSettingsSaving(false);
    }
  };

  const handleResetPrompt = (which: 'incremental' | 'rebuild') => {
    const name = which === 'incremental' ? 'incremental' : 'Refazer do zero';
    const ok = confirm(`Restaurar o prompt "${name}" para o padrão do sistema? Sua customização será perdida.`);
    if (!ok) return;
    if (which === 'incremental') setEditIncremental('');
    else setEditRebuild('');
  };

  const handleLoadDefaultPrompt = (which: 'incremental' | 'rebuild') => {
    if (!settings) return;
    if (which === 'incremental') setEditIncremental(settings.incremental_prompt_default);
    else setEditRebuild(settings.rebuild_prompt_default);
  };

  // Sem resumo ainda: começa em branco (o PUT cria o resumo).
  const handleStartEditProfile = () => {
    setEditProfileContent(orgProfile?.summary ?? '');
    setEditingProfile(true);
  };

  const handleCancelEditProfile = () => {
    setEditingProfile(false);
    setEditProfileContent('');
  };

  const handleSaveProfile = async () => {
    const summary = editProfileContent.trim();
    if (summary.length < 50) {
      showFeedback('Resumo muito curto (mín. 50 caracteres)', 'err');
      return;
    }
    setSavingProfile(true);
    try {
      const isNew = !orgProfile;
      await api.put('/memories/organization/profile', { summary });
      setEditingProfile(false);
      setEditProfileContent('');
      setProfileOpen(true);
      await loadData(true);
      showFeedback(
        isNew
          ? 'Resumo criado — a atualização automática da madrugada não sobrescreve texto escrito à mão'
          : 'Resumo atualizado — a atualização automática da madrugada não sobrescreve texto editado à mão',
      );
    } catch (e: any) {
      showFeedback(e?.response?.data?.message || 'Erro ao salvar', 'err');
    } finally {
      setSavingProfile(false);
    }
  };

  return (
    <div className="p-6 md:p-8 max-w-5xl mx-auto">
      {/* Header */}
      <div className="mb-6">
        <div className="flex items-center gap-3 mb-2">
          <div className="w-10 h-10 rounded-xl bg-primary/10 flex items-center justify-center">
            <Brain className="w-5 h-5 text-primary" />
          </div>
          <div>
            <h1 className="text-xl font-semibold text-foreground">Base de Conhecimento da Clínica</h1>
            <p className="text-sm text-muted-foreground">
              O que a IA sabe sobre a clínica e usa em <strong>todos</strong> os atendimentos com pacientes.
            </p>
          </div>
        </div>
      </div>

      {/* Control bar: toggle + extract now */}
      <div className="bg-card border border-border rounded-xl p-4 mb-4 flex flex-col md:flex-row md:items-center md:justify-between gap-4">
        <div className="flex items-center gap-3">
          <Layers className="w-4 h-4 text-muted-foreground" />
          <div>
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium">Extração automática diária</span>
              <button
                onClick={() => handleToggleBatch(!batchEnabled)}
                className={`relative w-10 h-5 rounded-full transition-colors ${
                  batchEnabled ? 'bg-primary' : 'bg-muted'
                }`}
                aria-label="Alternar extração automática"
              >
                <span
                  className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white transition-transform ${
                    batchEnabled ? 'translate-x-5' : 'translate-x-0'
                  }`}
                />
              </button>
            </div>
            <p className="text-xs text-muted-foreground mt-0.5">
              Roda toda noite à meia-noite analisando as conversas do dia.
            </p>
          </div>
        </div>
        <button
          onClick={handleExtractNow}
          disabled={extracting}
          className="inline-flex items-center gap-2 px-3 py-2 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 disabled:opacity-50"
        >
          {extracting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Play className="w-4 h-4" />}
          Rodar extração agora
        </button>
      </div>

      {/* Profile consolidado card */}
      <div className="bg-gradient-to-br from-primary/5 via-card to-card border border-primary/20 rounded-xl mb-4 overflow-hidden">
        <div className="flex items-center">
          <button
            onClick={() => !editingProfile && setProfileOpen(!profileOpen)}
            disabled={editingProfile}
            className="flex-1 px-4 py-3 flex items-center gap-3 hover:bg-foreground/[0.03] transition-colors text-left disabled:cursor-default"
          >
            <Sparkles className="w-4 h-4 text-primary" />
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-sm font-semibold">Resumo da clínica</span>
                {orgProfile && (
                  <span className="text-[10px] text-muted-foreground font-mono">
                    v{orgProfile.version}
                  </span>
                )}
                {orgProfile?.manually_edited_at && (
                  <span
                    className="inline-flex items-center gap-1 text-[10px] text-amber-600 dark:text-amber-400 bg-amber-500/10 border border-amber-500/20 px-1.5 py-0.5 rounded-full"
                    title="Este resumo foi editado à mão — a atualização automática NÃO sobrescreve"
                  >
                    <Lock className="w-2.5 h-2.5" />
                    editado à mão
                  </span>
                )}
              </div>
              <p className="text-[11px] text-muted-foreground mt-0.5">
                {orgProfile
                  ? `A IA lê este texto em todas as conversas com pacientes. Atualiza toda noite com as ${orgProfile.source_memory_count} memórias abaixo.`
                  : 'Ainda não existe. Gere a partir das memórias ou escreva o seu. Por enquanto a IA usa as memórias abaixo.'}
              </p>
            </div>
            {!editingProfile && (
              profileOpen ? (
                <ChevronDown className="w-4 h-4 text-muted-foreground" />
              ) : (
                <ChevronRight className="w-4 h-4 text-muted-foreground" />
              )
            )}
          </button>
          {!editingProfile && (
            <button
              onClick={handleStartEditProfile}
              className="px-3 py-2 text-muted-foreground hover:text-primary hover:bg-primary/10 transition-colors"
              title={orgProfile ? 'Editar à mão' : 'Escrever o resumo'}
            >
              <Pencil className="w-4 h-4" />
            </button>
          )}
          {!editingProfile && (
            <button
              onClick={handleRegenerateProfile}
              disabled={regeneratingProfile}
              className="px-3 py-2 text-muted-foreground hover:text-primary hover:bg-primary/10 transition-colors disabled:opacity-50"
              title={
                !orgProfile
                  ? 'Gerar o resumo a partir das memórias'
                  : orgProfile.manually_edited_at
                    ? 'Atualizar com as memórias (pode ajustar o texto editado à mão)'
                    : 'Atualizar o resumo agora'
              }
            >
              {regeneratingProfile ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <RefreshCw className="w-4 h-4" />
              )}
            </button>
          )}
        </div>

        {(profileOpen || editingProfile) && (
          <div className="border-t border-primary/10 bg-background/40 px-5 py-4">
            {editingProfile ? (
              <div>
                <p className="text-[11px] text-muted-foreground mb-2">
                  {orgProfile
                    ? 'Edite o texto que a IA lê nas conversas com pacientes.'
                    : 'Escreva o que a IA precisa saber da clínica pra atender pacientes: onde fica, quem atende, como funciona a avaliação, formas de pagamento, regras.'}{' '}
                  Texto escrito à mão <strong>não é sobrescrito</strong> pela atualização automática da madrugada. Para voltar à geração automática, use o botão de atualizar.
                </p>
                <p className="text-[11px] text-amber-700 dark:text-amber-400 bg-amber-500/10 border border-amber-500/20 rounded-lg px-2.5 py-1.5 mb-2">
                  Não coloque aqui assunto interno (caixa, vendas, cobrança), dados de pacientes nem preços. Preços ficam em{' '}
                  <Link href={PRICES_HREF} className="font-semibold underline">Ajustes IA › Valores</Link>.
                </p>
                <textarea
                  value={editProfileContent}
                  onChange={(e) => setEditProfileContent(e.target.value)}
                  className="w-full min-h-[400px] text-[13px] p-3 rounded-lg bg-card border border-border focus:outline-none focus:ring-1 focus:ring-primary leading-relaxed resize-y font-mono"
                  placeholder={'## Sobre a clínica\nEndereço, horário, Instagram...\n\n## Equipe\nDentistas e especialidades...\n\n## Como atendemos\nAvaliação, agendamento, faltas...'}
                  autoFocus
                />
                <div className="flex items-center justify-between mt-3">
                  <span className="text-[10px] text-muted-foreground">
                    {editProfileContent.length} caracteres
                    {editProfileContent.length < 50 && ' (mín. 50)'}
                  </span>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={handleCancelEditProfile}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs text-muted-foreground hover:text-foreground hover:bg-foreground/[0.05]"
                    >
                      <X className="w-3.5 h-3.5" />
                      Cancelar
                    </button>
                    <button
                      onClick={handleSaveProfile}
                      disabled={savingProfile || editProfileContent.trim().length < 50}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-primary text-primary-foreground text-xs font-medium hover:bg-primary/90 disabled:opacity-50"
                    >
                      {savingProfile ? (
                        <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      ) : (
                        <Save className="w-3.5 h-3.5" />
                      )}
                      {orgProfile ? 'Salvar edição' : 'Salvar resumo'}
                    </button>
                  </div>
                </div>
              </div>
            ) : orgProfile ? (
              <>
                <div className="prose prose-sm dark:prose-invert max-w-none text-[13px] text-foreground whitespace-pre-wrap leading-relaxed">
                  {orgProfile.summary}
                </div>
                <div className="mt-3 flex items-center justify-between gap-3 flex-wrap">
                  <p className="text-[10px] text-muted-foreground">
                    {orgProfile.manually_edited_at
                      ? `Editado à mão em ${formatDate(orgProfile.manually_edited_at)}`
                      : `Última atualização: ${formatDate(orgProfile.generated_at)}`}
                  </p>
                  <button
                    onClick={handleRebuildProfile}
                    disabled={rebuildingProfile}
                    className="inline-flex items-center gap-1.5 text-[10px] text-muted-foreground hover:text-red-500 transition-colors disabled:opacity-50"
                    title="Descartar o texto atual e gerar do zero a partir de todas as memórias"
                  >
                    {rebuildingProfile ? (
                      <Loader2 className="w-3 h-3 animate-spin" />
                    ) : (
                      <RotateCcw className="w-3 h-3" />
                    )}
                    Refazer do zero
                  </button>
                </div>
              </>
            ) : (
              <div className="text-center py-4 text-sm text-muted-foreground">
                <p>A clínica ainda não tem resumo.</p>
                <p className="text-[11px] mt-0.5">
                  Dica: antes de gerar, use &quot;Revisar com IA&quot; abaixo pra tirar da base o que não serve pra atender pacientes.
                </p>
                <div className="mt-3 flex items-center justify-center gap-2 flex-wrap">
                  <button
                    onClick={handleRegenerateProfile}
                    disabled={regeneratingProfile}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-primary/10 text-primary text-xs font-medium hover:bg-primary/20 disabled:opacity-50"
                  >
                    {regeneratingProfile ? (
                      <Loader2 className="w-3 h-3 animate-spin" />
                    ) : (
                      <Sparkles className="w-3 h-3" />
                    )}
                    Gerar a partir das memórias
                  </button>
                  <button
                    onClick={handleStartEditProfile}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-border text-xs font-medium text-foreground hover:bg-foreground/[0.05]"
                  >
                    <Pencil className="w-3 h-3" />
                    Escrever o resumo
                  </button>
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Limpeza com IA + arquivadas */}
      <MemoryReviewPanel
        onChanged={reloadQuiet}
        archivedVersion={archivedVersion}
        summaryState={summaryState}
        activeMemories={activeMemories}
        onSummaryQueued={refreshProfileLater}
      />

      {/* Search */}
      <div className="relative mb-2">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
        <input
          type="text"
          placeholder="Buscar memória..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="w-full pl-9 pr-3 py-2 text-sm rounded-lg bg-card border border-border focus:outline-none focus:ring-1 focus:ring-primary"
        />
      </div>
      <p className="mb-4 flex items-center gap-1.5 text-[11px] text-muted-foreground">
        <Tag className="w-3 h-3 shrink-0" />
        <span>
          Preços não ficam aqui: use{' '}
          <Link href={PRICES_HREF} className="text-primary hover:underline">
            Ajustes IA › Valores
          </Link>
          .
        </span>
      </p>

      {/* Message */}
      {message && (
        <div
          className={`mb-4 px-3 py-2 rounded-lg text-sm flex items-center gap-2 ${
            message.type === 'ok'
              ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border border-emerald-500/20'
              : message.type === 'warn'
                ? 'bg-amber-500/10 text-amber-700 dark:text-amber-400 border border-amber-500/20'
                : 'bg-red-500/10 text-red-600 dark:text-red-400 border border-red-500/20'
          }`}
        >
          {message.type === 'ok' ? (
            <CheckCircle2 className="w-4 h-4 shrink-0" />
          ) : (
            <AlertCircle className="w-4 h-4 shrink-0" />
          )}
          <span className="flex-1">{message.text}</span>
          {message.type === 'warn' && (
            <button
              onClick={() => setMessage(null)}
              className="p-0.5 rounded hover:bg-amber-500/10 shrink-0"
              title="Fechar aviso"
              aria-label="Fechar aviso"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
      )}

      {/* Loading */}
      {loading && (
        <div className="flex items-center justify-center py-12 text-muted-foreground">
          <Loader2 className="w-5 h-5 animate-spin mr-2" />
          Carregando...
        </div>
      )}

      {/* Error */}
      {error && !loading && (
        <div className="bg-red-500/10 border border-red-500/20 text-red-600 dark:text-red-400 rounded-lg p-4 mb-4">
          {error}
        </div>
      )}

      {/* Groups */}
      {!loading && !error && (
        <div className="space-y-2">
          {categories.map((cat) => {
            const items = filteredGroups[cat.key] || [];
            const open = openGroups[cat.key] ?? false;
            const Icon = cat.icon;
            const startAdding = () => {
              setAdding({ subcategory: cat.key });
              setNewContent('');
              setOpenGroups((prev) => ({ ...prev, [cat.key]: true }));
            };
            return (
              <div
                key={cat.key}
                className={`bg-card border rounded-xl overflow-hidden ${
                  cat.legacy ? 'border-amber-500/30' : 'border-border'
                }`}
              >
                <div className="flex items-center">
                  <button
                    onClick={() => toggleGroup(cat.key)}
                    className="flex-1 flex items-center gap-3 px-4 py-3 hover:bg-foreground/[0.03] transition-colors text-left"
                  >
                    {open ? (
                      <ChevronDown className="w-4 h-4 text-muted-foreground" />
                    ) : (
                      <ChevronRight className="w-4 h-4 text-muted-foreground" />
                    )}
                    <Icon className={`w-4 h-4 ${cat.legacy ? 'text-amber-600 dark:text-amber-400' : 'text-primary'}`} />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium">{cat.label}</span>
                        <span className="text-xs text-muted-foreground">({items.length})</span>
                      </div>
                      {(!open || cat.legacy) && (
                        <p
                          className={`text-[11px] truncate ${
                            cat.legacy ? 'text-amber-700 dark:text-amber-400' : 'text-muted-foreground'
                          }`}
                        >
                          {cat.hint}
                        </p>
                      )}
                    </div>
                  </button>
                  {/* Categoria antiga não recebe memória nova */}
                  {!cat.legacy && (
                    <button
                      onClick={startAdding}
                      className="px-3 py-2 text-muted-foreground hover:text-primary hover:bg-primary/10 transition-colors"
                      title="Adicionar memória"
                    >
                      <Plus className="w-4 h-4" />
                    </button>
                  )}
                </div>

                {open && (
                  <div className="border-t border-border bg-foreground/[0.02]">
                    {items.length === 0 && adding?.subcategory !== cat.key && (
                      <div className="px-4 py-6 text-center text-sm text-muted-foreground">
                        <p>{search.trim() ? 'Nada encontrado nesta categoria.' : 'Nenhuma memória nesta categoria.'}</p>
                        {!cat.legacy && !search.trim() && (
                          <button onClick={startAdding} className="mt-2 text-primary text-xs hover:underline">
                            + Adicionar primeira memória
                          </button>
                        )}
                      </div>
                    )}

                    {adding?.subcategory === cat.key && (
                      <div className="p-3 border-b border-border bg-background/50">
                        <textarea
                          value={newContent}
                          onChange={(e) => setNewContent(e.target.value)}
                          placeholder={`Ex: ${cat.hint}`}
                          className="w-full text-sm p-2 rounded-lg bg-card border border-border focus:outline-none focus:ring-1 focus:ring-primary min-h-[80px] resize-none"
                          autoFocus
                        />
                        <div className="flex items-center justify-end gap-2 mt-2">
                          <button
                            onClick={() => {
                              setAdding(null);
                              setNewContent('');
                            }}
                            className="px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground"
                          >
                            Cancelar
                          </button>
                          <button
                            onClick={handleAdd}
                            disabled={saving}
                            className="px-3 py-1.5 text-xs font-medium bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 disabled:opacity-50 inline-flex items-center gap-1.5"
                          >
                            {saving ? <Loader2 className="w-3 h-3 animate-spin" /> : null}
                            Adicionar
                          </button>
                        </div>
                      </div>
                    )}

                    {items.map((item) => (
                      <div
                        key={item.id}
                        className="px-4 py-3 border-b border-border last:border-b-0 hover:bg-foreground/[0.03] transition-colors"
                      >
                        {editing?.id === item.id ? (
                          <div>
                            <textarea
                              value={editContent}
                              onChange={(e) => setEditContent(e.target.value)}
                              className="w-full text-sm p-2 rounded-lg bg-card border border-border focus:outline-none focus:ring-1 focus:ring-primary min-h-[80px] resize-none"
                              autoFocus
                            />
                            <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 mt-2">
                              {/* Categoria: só as 6 da clínica (tira memória de categoria antiga) */}
                              <label className="flex items-center gap-2 text-[11px] text-muted-foreground">
                                Categoria
                                <select
                                  value={editSubcategory}
                                  onChange={(e) => setEditSubcategory(e.target.value)}
                                  className="text-xs p-1.5 rounded-lg bg-card border border-border text-foreground focus:outline-none focus:ring-1 focus:ring-primary"
                                >
                                  {!isOrgMemorySubcategory(item.subcategory) && (
                                    <option value="">Manter em {cat.label}</option>
                                  )}
                                  {ORG_MEMORY_SUBCATEGORIES.map((k) => (
                                    <option key={k} value={k}>
                                      {ORG_MEMORY_LABELS[k].label}
                                    </option>
                                  ))}
                                </select>
                              </label>
                              <div className="flex items-center justify-end gap-2">
                                <button
                                  onClick={() => {
                                    setEditing(null);
                                    setEditContent('');
                                    setEditSubcategory('');
                                  }}
                                  className="px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground"
                                >
                                  Cancelar
                                </button>
                                <button
                                  onClick={handleUpdate}
                                  disabled={saving}
                                  className="px-3 py-1.5 text-xs font-medium bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 disabled:opacity-50 inline-flex items-center gap-1.5"
                                >
                                  {saving ? <Loader2 className="w-3 h-3 animate-spin" /> : null}
                                  Salvar
                                </button>
                              </div>
                            </div>
                          </div>
                        ) : (
                          <div className="flex items-start gap-3">
                            <div className="flex-1 min-w-0">
                              <p className="text-sm text-foreground">{item.content}</p>
                              <div className="flex items-center gap-3 mt-1 text-[10px] text-muted-foreground">
                                <span>{formatSourceLabel(item.source_type)}</span>
                                <span>•</span>
                                <span>Confiança {Math.round(item.confidence * 100)}%</span>
                                <span>•</span>
                                <span>{formatDate(item.created_at)}</span>
                              </div>
                            </div>
                            <div className="flex items-center gap-1 shrink-0">
                              <button
                                onClick={() => {
                                  setEditing(item);
                                  setEditContent(item.content);
                                  setEditSubcategory(isOrgMemorySubcategory(item.subcategory) ? item.subcategory : '');
                                }}
                                className="p-1.5 text-muted-foreground hover:text-primary hover:bg-primary/10 rounded transition-colors"
                                title={cat.legacy ? 'Editar / mudar de categoria' : 'Editar'}
                              >
                                <Pencil className="w-3.5 h-3.5" />
                              </button>
                              <button
                                onClick={() => handleArchive(item.id)}
                                disabled={archivingId === item.id}
                                className="p-1.5 text-muted-foreground hover:text-amber-600 hover:bg-amber-500/10 rounded transition-colors disabled:opacity-50"
                                title="Arquivar (sai da base; dá pra restaurar em Ver arquivadas)"
                              >
                                {archivingId === item.id ? (
                                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                                ) : (
                                  <Archive className="w-3.5 h-3.5" />
                                )}
                              </button>
                              <button
                                onClick={() => handleDelete(item.id)}
                                className="p-1.5 text-muted-foreground hover:text-red-500 hover:bg-red-500/10 rounded transition-colors"
                                title="Apagar de vez"
                              >
                                <Trash2 className="w-3.5 h-3.5" />
                              </button>
                            </div>
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Configurações Avançadas */}
      {!loading && (
        <div className="mt-6 bg-card border border-border rounded-xl overflow-hidden">
          <button
            onClick={() => setAdvancedOpen(!advancedOpen)}
            className="w-full px-4 py-3 flex items-center gap-3 hover:bg-foreground/[0.03] transition-colors text-left"
          >
            <Settings className="w-4 h-4 text-muted-foreground" />
            <div className="flex-1 min-w-0">
              <span className="text-sm font-medium">Configurações Avançadas</span>
              <p className="text-[11px] text-muted-foreground mt-0.5">
                Modelo de IA e prompts usados pela consolidação do resumo
              </p>
            </div>
            {advancedOpen ? (
              <ChevronDown className="w-4 h-4 text-muted-foreground" />
            ) : (
              <ChevronRight className="w-4 h-4 text-muted-foreground" />
            )}
          </button>

          {advancedOpen && (
            <div className="border-t border-border bg-foreground/[0.02] px-5 py-4">
              {settingsLoading ? (
                <div className="flex items-center justify-center py-6 text-muted-foreground">
                  <Loader2 className="w-4 h-4 animate-spin mr-2" />
                  Carregando configurações...
                </div>
              ) : settings ? (
                <div className="space-y-6">
                  {/* Modelo da IA */}
                  <div>
                    <div className="flex items-center gap-2 mb-2">
                      <Cpu className="w-3.5 h-3.5 text-primary" />
                      <label className="text-[12px] font-semibold">Modelo da IA</label>
                      {editModel !== settings.model_default && (
                        <span className="text-[10px] text-amber-600 dark:text-amber-400 bg-amber-500/10 border border-amber-500/20 px-1.5 py-0.5 rounded-full">
                          personalizado
                        </span>
                      )}
                    </div>
                    <select
                      value={editModel}
                      onChange={(e) => setEditModel(e.target.value)}
                      className="w-full text-sm p-2 rounded-lg bg-card border border-border focus:outline-none focus:ring-1 focus:ring-primary"
                    >
                      {settings.available_models.map((opt) => (
                        <option key={opt.value} value={opt.value}>
                          {opt.label}
                        </option>
                      ))}
                    </select>
                    <p className="text-[10px] text-muted-foreground mt-1">
                      Modelo usado em cada consolidação do resumo (incremental + "Refazer do zero"). Padrão: {settings.model_default}.
                    </p>
                  </div>

                  {/* Prompts */}
                  <div>
                    <div className="flex items-center gap-2 mb-2">
                      <FileCode2 className="w-3.5 h-3.5 text-primary" />
                      <label className="text-[12px] font-semibold">Prompts</label>
                    </div>

                    {/* Tabs */}
                    <div className="flex border-b border-border mb-3">
                      <button
                        onClick={() => setActivePromptTab('incremental')}
                        className={`px-3 py-2 text-[12px] font-medium border-b-2 transition-colors -mb-px ${
                          activePromptTab === 'incremental'
                            ? 'border-primary text-primary'
                            : 'border-transparent text-muted-foreground hover:text-foreground'
                        }`}
                      >
                        Incremental (padrão)
                        {editIncremental.trim() !== '' && (
                          <span className="ml-1.5 text-[9px] text-amber-600 dark:text-amber-400 bg-amber-500/10 px-1 rounded">●</span>
                        )}
                      </button>
                      <button
                        onClick={() => setActivePromptTab('rebuild')}
                        className={`px-3 py-2 text-[12px] font-medium border-b-2 transition-colors -mb-px ${
                          activePromptTab === 'rebuild'
                            ? 'border-primary text-primary'
                            : 'border-transparent text-muted-foreground hover:text-foreground'
                        }`}
                      >
                        Refazer do zero
                        {editRebuild.trim() !== '' && (
                          <span className="ml-1.5 text-[9px] text-amber-600 dark:text-amber-400 bg-amber-500/10 px-1 rounded">●</span>
                        )}
                      </button>
                    </div>

                    {/* Incremental tab */}
                    {activePromptTab === 'incremental' && (
                      <div>
                        <div className="flex items-center justify-between mb-2">
                          <p className="text-[11px] text-muted-foreground">
                            Usado toda madrugada (02h) para atualizar o resumo com as memórias novas ou apagadas do dia.{' '}
                            {editIncremental.trim() === '' && (
                              <span className="text-foreground font-medium">Usando padrão do sistema.</span>
                            )}
                          </p>
                          <div className="flex items-center gap-2">
                            <button
                              onClick={() => handleLoadDefaultPrompt('incremental')}
                              className="text-[10px] text-primary hover:underline"
                            >
                              Ver/copiar padrão
                            </button>
                            {editIncremental.trim() !== '' && (
                              <button
                                onClick={() => handleResetPrompt('incremental')}
                                className="text-[10px] text-muted-foreground hover:text-red-500"
                              >
                                Restaurar padrão
                              </button>
                            )}
                          </div>
                        </div>
                        <textarea
                          value={editIncremental}
                          onChange={(e) => setEditIncremental(e.target.value)}
                          placeholder={settings.incremental_prompt_default}
                          className="w-full min-h-[300px] text-[11px] p-3 rounded-lg bg-card border border-border focus:outline-none focus:ring-1 focus:ring-primary resize-y font-mono leading-relaxed"
                        />
                        <p className="text-[10px] text-muted-foreground mt-1">
                          Deixar vazio = usar o padrão do sistema. Mínimo 100 caracteres quando customizado.
                        </p>
                      </div>
                    )}

                    {/* Rebuild tab */}
                    {activePromptTab === 'rebuild' && (
                      <div>
                        <div className="flex items-center justify-between mb-2">
                          <p className="text-[11px] text-muted-foreground">
                            Usado quando alguém clica "Refazer do zero" — escreve um resumo novo a partir de todas as memórias.{' '}
                            {editRebuild.trim() === '' && (
                              <span className="text-foreground font-medium">Usando padrão do sistema.</span>
                            )}
                          </p>
                          <div className="flex items-center gap-2">
                            <button
                              onClick={() => handleLoadDefaultPrompt('rebuild')}
                              className="text-[10px] text-primary hover:underline"
                            >
                              Ver/copiar padrão
                            </button>
                            {editRebuild.trim() !== '' && (
                              <button
                                onClick={() => handleResetPrompt('rebuild')}
                                className="text-[10px] text-muted-foreground hover:text-red-500"
                              >
                                Restaurar padrão
                              </button>
                            )}
                          </div>
                        </div>
                        <textarea
                          value={editRebuild}
                          onChange={(e) => setEditRebuild(e.target.value)}
                          placeholder={settings.rebuild_prompt_default}
                          className="w-full min-h-[300px] text-[11px] p-3 rounded-lg bg-card border border-border focus:outline-none focus:ring-1 focus:ring-primary resize-y font-mono leading-relaxed"
                        />
                        <p className="text-[10px] text-muted-foreground mt-1">
                          Deixar vazio = usar o padrão do sistema. Mínimo 100 caracteres quando customizado.
                        </p>
                      </div>
                    )}
                  </div>

                  {/* Botão salvar */}
                  <div className="flex items-center justify-end pt-2 border-t border-border">
                    <button
                      onClick={handleSaveSettings}
                      disabled={settingsSaving}
                      className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 disabled:opacity-50"
                    >
                      {settingsSaving ? (
                        <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      ) : (
                        <Save className="w-3.5 h-3.5" />
                      )}
                      Salvar alterações
                    </button>
                  </div>
                </div>
              ) : null}
            </div>
          )}
        </div>
      )}

      {/* Footer */}
      {!loading && stats && (
        <div className="mt-6 text-center text-xs text-muted-foreground">
          Total: <strong className="text-foreground">{stats.total}</strong> memórias •
          Última extração automática:{' '}
          <strong className="text-foreground">{formatDate(stats.last_extraction)}</strong>
        </div>
      )}
    </div>
  );
}

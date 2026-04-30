'use client';

/**
 * Settings → Tabela de Preços (Procedimentos).
 *
 * Tela centralizada onde admin/gerente cadastra TODOS os procedimentos
 * que a clínica oferece com seus preços base. Esses preços são puxados
 * automaticamente quando operador monta um orçamento — basta clicar no
 * procedimento e o valor já vem preenchido.
 *
 * Features:
 *  - Listagem agrupada por especialidade (ou "Sem especialidade")
 *  - Busca por nome ou código TUSS
 *  - Filtro mostrar inativos (soft-delete)
 *  - Edição inline rápida do preço (clicar no valor → vira input → enter salva)
 *  - Modal completo pra criar/editar todos os campos
 *  - Reajuste em massa (aplica %) — apply 5% em todos da especialidade X
 *  - Indicador visual: quantos orçamentos usam cada procedimento
 */
import { useEffect, useMemo, useState, FormEvent } from 'react';
import {
  DollarSign, Loader2, Plus, Pencil, Trash2, X, Save, Search,
  ChevronDown, ChevronRight, TrendingUp, AlertCircle, Layers,
} from 'lucide-react';
import api from '@/lib/api';
import { showError, showSuccess } from '@/lib/toast';

interface Procedure {
  id: string;
  name: string;
  code_tuss: string | null;
  internal_code: string | null;
  description: string | null;
  duration_minutes: number;
  base_price: string | number;
  category: string | null;
  specialty_id: string | null;
  specialty?: { id: string; name: string } | null;
  active: boolean;
  requires_x_ray: boolean;
  requires_anesthesia: boolean;
  default_revisit_months: number | null;
}

interface Specialty {
  id: string;
  name: string;
  active: boolean;
}

const formatBRL = (v: number | string) =>
  Number(v).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

/**
 * Paleta de 8 cores para destacar visualmente cada grupo de especialidade.
 * Hash do ID -> indice 0-7 garante que a mesma especialidade SEMPRE receba
 * a mesma cor (consistencia entre sessoes). Mesmo padrao usado pra dentistas
 * na agenda — visual familiar.
 */
const SPECIALTY_COLORS = [
  { bar: '#a855f7', tint: 'rgba(168, 85, 247, 0.08)' }, // roxo (Cirurgia)
  { bar: '#3b82f6', tint: 'rgba(59, 130, 246, 0.08)' }, // azul (Clinica Geral)
  { bar: '#22c55e', tint: 'rgba(34, 197, 94, 0.08)' },  // verde (Profilaxia)
  { bar: '#f97316', tint: 'rgba(249, 115, 22, 0.08)' }, // laranja (Endodontia)
  { bar: '#ec4899', tint: 'rgba(236, 72, 153, 0.08)' }, // rosa (Estetica)
  { bar: '#14b8a6', tint: 'rgba(20, 184, 166, 0.08)' }, // teal (Implantes)
  { bar: '#eab308', tint: 'rgba(234, 179, 8, 0.08)' },  // amarelo (Ortodontia)
  { bar: '#06b6d4', tint: 'rgba(6, 182, 212, 0.08)' },  // ciano (Periodontia)
];

function colorForSpecialty(key: string) {
  // "Sem especialidade" key '__none__' -> cor neutra cinza
  if (key === '__none__') {
    return { bar: '#94a3b8', tint: 'rgba(148, 163, 184, 0.06)' };
  }
  // Hash simples do id -> indice estavel
  let hash = 0;
  for (let i = 0; i < key.length; i++) hash = (hash * 31 + key.charCodeAt(i)) | 0;
  return SPECIALTY_COLORS[Math.abs(hash) % SPECIALTY_COLORS.length];
}

export default function ProceduresSettingsPage() {
  const [list, setList] = useState<Procedure[]>([]);
  const [specialties, setSpecialties] = useState<Specialty[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [showInactive, setShowInactive] = useState(false);
  const [specialtyFilter, setSpecialtyFilter] = useState<string>('');
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());
  const [editing, setEditing] = useState<Procedure | null>(null);
  const [creating, setCreating] = useState(false);
  const [bulkAdjustOpen, setBulkAdjustOpen] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (search.trim()) params.set('search', search.trim());
      if (showInactive) params.set('includeInactive', 'true');
      if (specialtyFilter) params.set('specialtyId', specialtyFilter);
      const [procRes, specRes] = await Promise.all([
        api.get<Procedure[]>(`/procedures?${params}`),
        api.get<Specialty[]>('/specialties'),
      ]);
      setList(procRes.data);
      setSpecialties(specRes.data);
    } catch (err: any) {
      showError(err?.response?.data?.message || 'Erro ao carregar tabela de preços');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    const t = setTimeout(load, 200);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search, showInactive, specialtyFilter]);

  const handleDelete = async (p: Procedure) => {
    const action = p.active ? 'arquivar' : 'restaurar';
    if (!confirm(`${action.charAt(0).toUpperCase() + action.slice(1)} o procedimento "${p.name}"?`)) return;
    try {
      if (p.active) {
        await api.delete(`/procedures/${p.id}`);
      } else {
        await api.patch(`/procedures/${p.id}`, { active: true });
      }
      showSuccess(`Procedimento ${p.active ? 'arquivado' : 'restaurado'}`);
      load();
    } catch (err: any) {
      showError(err?.response?.data?.message || 'Erro ao remover');
    }
  };

  // Agrupa por especialidade (ou "Sem especialidade")
  const grouped = useMemo(() => {
    const groups: Record<string, { name: string; items: Procedure[] }> = {};
    for (const p of list) {
      const key = p.specialty?.id || '__none__';
      const name = p.specialty?.name || 'Sem especialidade';
      if (!groups[key]) groups[key] = { name, items: [] };
      groups[key].items.push(p);
    }
    return Object.entries(groups)
      .map(([key, value]) => ({ key, ...value }))
      .sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));
  }, [list]);

  const toggleGroup = (key: string) => {
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  // Total de procedimentos ativos
  const activeCount = list.filter((p) => p.active).length;
  const totalValue = list
    .filter((p) => p.active)
    .reduce((acc, p) => acc + Number(p.base_price), 0);

  return (
    <div className="p-6 max-w-6xl mx-auto">
      <div className="flex items-start justify-between gap-4 mb-6 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold text-foreground flex items-center gap-2">
            <DollarSign size={24} className="text-primary" /> Tabela de Preços
          </h1>
          <p className="text-sm text-muted-foreground mt-1 max-w-2xl">
            Procedimentos e preços base usados pra montar orçamentos. Cada vez
            que operador adiciona um procedimento ao orçamento, o valor base aqui
            é puxado automaticamente.
          </p>
        </div>
        <div className="flex gap-2">
          <button
            onClick={() => setBulkAdjustOpen(true)}
            className="inline-flex items-center gap-2 px-3 py-2 rounded-lg border border-border hover:bg-accent text-sm"
            title="Aplicar reajuste percentual em vários procedimentos"
          >
            <TrendingUp size={14} /> Reajuste em massa
          </button>
          <button
            onClick={() => setCreating(true)}
            className="inline-flex items-center gap-2 px-3 py-2 rounded-lg bg-primary text-primary-foreground hover:bg-primary/90 text-sm font-medium"
          >
            <Plus size={16} /> Novo procedimento
          </button>
        </div>
      </div>

      {/* Stats compactos */}
      <div className="grid grid-cols-3 gap-3 mb-4">
        <div className="bg-card border border-border rounded-xl p-3">
          <p className="text-xs text-muted-foreground">Procedimentos ativos</p>
          <p className="text-xl font-bold text-foreground">{activeCount}</p>
        </div>
        <div className="bg-card border border-border rounded-xl p-3">
          <p className="text-xs text-muted-foreground">Especialidades</p>
          <p className="text-xl font-bold text-foreground">{grouped.length}</p>
        </div>
        <div className="bg-card border border-border rounded-xl p-3">
          <p className="text-xs text-muted-foreground">Soma dos preços base</p>
          <p className="text-xl font-bold text-primary">{formatBRL(totalValue)}</p>
        </div>
      </div>

      {/* Toolbar */}
      <div className="flex flex-wrap gap-2 mb-4">
        <div className="relative flex-1 min-w-[200px]">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Buscar por nome ou código TUSS..."
            className="w-full pl-9 pr-3 py-2 rounded-lg bg-card border border-border text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
          />
        </div>
        <select
          value={specialtyFilter}
          onChange={(e) => setSpecialtyFilter(e.target.value)}
          className="px-3 py-2 rounded-lg bg-card border border-border text-sm"
        >
          <option value="">Todas as especialidades</option>
          {specialties.map((s) => (
            <option key={s.id} value={s.id}>{s.name}</option>
          ))}
        </select>
        <label className="flex items-center gap-2 text-sm cursor-pointer px-3">
          <input
            type="checkbox"
            checked={showInactive}
            onChange={(e) => setShowInactive(e.target.checked)}
            className="w-4 h-4 rounded border-border"
          />
          Mostrar arquivados
        </label>
      </div>

      {/* Lista agrupada */}
      {loading ? (
        <div className="p-12 flex items-center justify-center text-muted-foreground">
          <Loader2 size={20} className="animate-spin mr-2" /> Carregando...
        </div>
      ) : list.length === 0 ? (
        <div className="p-12 text-center bg-card border border-border rounded-xl">
          <DollarSign size={28} className="mx-auto mb-2 text-muted-foreground/50" />
          <p className="text-sm text-muted-foreground mb-3">
            {search || specialtyFilter
              ? 'Nenhum procedimento corresponde aos filtros.'
              : 'Nenhum procedimento cadastrado ainda.'}
          </p>
          {!search && !specialtyFilter && (
            <button
              onClick={() => setCreating(true)}
              className="inline-flex items-center gap-2 px-3 py-2 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90"
            >
              <Plus size={14} /> Cadastrar primeiro procedimento
            </button>
          )}
        </div>
      ) : (
        <div className="space-y-3">
          {grouped.map((group) => {
            const collapsed = collapsedGroups.has(group.key);
            const color = colorForSpecialty(group.key);
            const groupSum = group.items.reduce((acc, p) => acc + Number(p.base_price), 0);
            return (
              <div
                key={group.key}
                className="bg-card border border-border rounded-xl overflow-hidden border-l-4"
                style={{ borderLeftColor: color.bar }}
              >
                <button
                  onClick={() => toggleGroup(group.key)}
                  className="w-full px-4 py-3 flex items-center gap-3 hover:brightness-95 transition-all border-b border-border text-left"
                  style={{ background: color.tint }}
                >
                  {collapsed
                    ? <ChevronRight size={18} style={{ color: color.bar }} />
                    : <ChevronDown size={18} style={{ color: color.bar }} />}
                  <Layers size={16} style={{ color: color.bar }} className="shrink-0" />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-base font-bold text-foreground">
                        {group.name}
                      </span>
                      <span
                        className="text-[10px] font-semibold px-2 py-0.5 rounded-full uppercase tracking-wider"
                        style={{ background: color.bar + '20', color: color.bar }}
                      >
                        {group.items.length} {group.items.length === 1 ? 'procedimento' : 'procedimentos'}
                      </span>
                    </div>
                  </div>
                  <div className="text-right">
                    <p className="text-[10px] text-muted-foreground uppercase tracking-wider">Soma</p>
                    <p className="text-base font-bold" style={{ color: color.bar }}>
                      {formatBRL(groupSum)}
                    </p>
                  </div>
                </button>
                {!collapsed && (
                  <table className="w-full text-sm">
                    <thead className="text-muted-foreground text-xs uppercase border-b border-border">
                      <tr>
                        <th className="text-left px-4 py-2 font-medium">Nome</th>
                        <th className="text-left px-4 py-2 font-medium">TUSS</th>
                        <th className="text-right px-4 py-2 font-medium">Duração</th>
                        <th className="text-right px-4 py-2 font-medium">Preço base</th>
                        <th className="text-right px-4 py-2 font-medium">Ações</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border">
                      {group.items.map((p) => (
                        <ProcedureRow
                          key={p.id}
                          procedure={p}
                          onPriceUpdate={load}
                          onEdit={() => setEditing(p)}
                          onDelete={() => handleDelete(p)}
                        />
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            );
          })}
        </div>
      )}

      {(creating || editing) && (
        <ProcedureModal
          procedure={editing}
          specialties={specialties}
          onClose={() => { setCreating(false); setEditing(null); }}
          onSaved={() => { setCreating(false); setEditing(null); load(); }}
        />
      )}
      {bulkAdjustOpen && (
        <BulkAdjustModal
          specialties={specialties}
          onClose={() => setBulkAdjustOpen(false)}
          onApplied={() => { setBulkAdjustOpen(false); load(); }}
        />
      )}
    </div>
  );
}

// ─── Linha individual com edição inline de preço ───────────

function ProcedureRow({
  procedure: p, onPriceUpdate, onEdit, onDelete,
}: {
  procedure: Procedure;
  onPriceUpdate: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const [editingPrice, setEditingPrice] = useState(false);
  const [priceDraft, setPriceDraft] = useState(String(p.base_price));
  const [saving, setSaving] = useState(false);

  const savePrice = async () => {
    const newPrice = Number(priceDraft);
    if (isNaN(newPrice) || newPrice < 0) {
      showError('Preço inválido');
      return;
    }
    setSaving(true);
    try {
      await api.patch(`/procedures/${p.id}`, { base_price: newPrice });
      showSuccess('Preço atualizado');
      setEditingPrice(false);
      onPriceUpdate();
    } catch (err: any) {
      showError(err?.response?.data?.message || 'Erro ao salvar');
    } finally {
      setSaving(false);
    }
  };

  return (
    <tr className={`hover:bg-muted/30 ${!p.active ? 'opacity-50' : ''}`}>
      <td className="px-4 py-2">
        <div className="font-medium">{p.name}</div>
        {p.description && (
          <div className="text-xs text-muted-foreground truncate max-w-md">{p.description}</div>
        )}
        {!p.active && (
          <span className="text-[10px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground">
            Arquivado
          </span>
        )}
      </td>
      <td className="px-4 py-2 text-xs text-muted-foreground font-mono">
        {p.code_tuss || '—'}
      </td>
      <td className="px-4 py-2 text-right text-xs text-muted-foreground">
        {p.duration_minutes} min
      </td>
      <td className="px-4 py-2 text-right">
        {editingPrice ? (
          <div className="flex items-center justify-end gap-1">
            <span className="text-xs text-muted-foreground">R$</span>
            <input
              type="number"
              step="0.01"
              min={0}
              value={priceDraft}
              onChange={(e) => setPriceDraft(e.target.value)}
              autoFocus
              onKeyDown={(e) => {
                if (e.key === 'Enter') savePrice();
                if (e.key === 'Escape') { setEditingPrice(false); setPriceDraft(String(p.base_price)); }
              }}
              className="w-24 px-2 py-1 text-right rounded bg-background border border-primary/40 text-sm"
            />
            <button
              onClick={savePrice}
              disabled={saving}
              className="text-primary hover:bg-primary/10 p-1 rounded"
            >
              {saving ? <Loader2 size={12} className="animate-spin" /> : <Save size={12} />}
            </button>
            <button
              onClick={() => { setEditingPrice(false); setPriceDraft(String(p.base_price)); }}
              className="text-muted-foreground hover:bg-accent p-1 rounded"
            >
              <X size={12} />
            </button>
          </div>
        ) : (
          <button
            onClick={() => setEditingPrice(true)}
            disabled={!p.active}
            className="font-semibold text-primary hover:underline disabled:no-underline disabled:text-muted-foreground"
            title="Clique pra editar preço inline"
          >
            {formatBRL(p.base_price)}
          </button>
        )}
      </td>
      <td className="px-4 py-2 text-right">
        <button
          onClick={onEdit}
          className="text-muted-foreground hover:text-foreground p-1 mr-1"
          title="Editar tudo"
        >
          <Pencil size={14} />
        </button>
        <button
          onClick={onDelete}
          className={`p-1 ${p.active ? 'text-muted-foreground hover:text-destructive' : 'text-emerald-600 hover:text-emerald-700'}`}
          title={p.active ? 'Arquivar' : 'Restaurar'}
        >
          <Trash2 size={14} />
        </button>
      </td>
    </tr>
  );
}

// ─── Modal de criar/editar (campos completos) ───────────

function ProcedureModal({
  procedure, specialties, onClose, onSaved,
}: {
  procedure: Procedure | null;
  specialties: Specialty[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const isEdit = !!procedure;
  const [name, setName] = useState(procedure?.name || '');
  const [codeTuss, setCodeTuss] = useState(procedure?.code_tuss || '');
  const [internalCode, setInternalCode] = useState(procedure?.internal_code || '');
  const [description, setDescription] = useState(procedure?.description || '');
  const [durationMinutes, setDurationMinutes] = useState(procedure?.duration_minutes || 30);
  const [basePrice, setBasePrice] = useState(procedure ? String(procedure.base_price) : '');
  const [specialtyId, setSpecialtyId] = useState(procedure?.specialty_id || '');
  const [requiresXRay, setRequiresXRay] = useState(procedure?.requires_x_ray || false);
  const [requiresAnesthesia, setRequiresAnesthesia] = useState(procedure?.requires_anesthesia || false);
  const [defaultRevisitMonths, setDefaultRevisitMonths] = useState<string>(
    procedure?.default_revisit_months?.toString() || ''
  );
  const [saving, setSaving] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return showError('Nome obrigatório');
    if (!basePrice || Number(basePrice) < 0) return showError('Preço inválido');
    setSaving(true);
    try {
      const payload = {
        name: name.trim(),
        code_tuss: codeTuss.trim() || null,
        internal_code: internalCode.trim() || null,
        description: description.trim() || null,
        duration_minutes: Number(durationMinutes),
        base_price: Number(basePrice),
        specialty_id: specialtyId || null,
        requires_x_ray: requiresXRay,
        requires_anesthesia: requiresAnesthesia,
        default_revisit_months: defaultRevisitMonths ? Number(defaultRevisitMonths) : null,
      };
      if (isEdit) {
        await api.patch(`/procedures/${procedure!.id}`, payload);
        showSuccess('Procedimento atualizado');
      } else {
        await api.post('/procedures', payload);
        showSuccess('Procedimento criado');
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
        className="bg-card border border-border rounded-xl w-full max-w-xl shadow-2xl max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between p-4 border-b border-border">
          <div className="flex items-center gap-2">
            <DollarSign size={18} className="text-primary" />
            <h2 className="text-base font-semibold">
              {isEdit ? 'Editar procedimento' : 'Novo procedimento'}
            </h2>
          </div>
          <button onClick={onClose} className="p-1 hover:bg-accent rounded">
            <X size={18} />
          </button>
        </div>

        <form onSubmit={submit} className="p-4 space-y-3">
          <div>
            <label className="block text-xs font-medium mb-1">Nome *</label>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              autoFocus
              placeholder="Ex: Restauração de resina simples"
              className="w-full px-3 py-2 rounded-lg bg-background border border-border text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium mb-1">Especialidade</label>
              <select
                value={specialtyId}
                onChange={(e) => setSpecialtyId(e.target.value)}
                className="w-full px-3 py-2 rounded-lg bg-background border border-border text-sm"
              >
                <option value="">— Sem especialidade —</option>
                {specialties.map((s) => (
                  <option key={s.id} value={s.id}>{s.name}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium mb-1">Preço base (R$) *</label>
              <input
                type="number"
                step="0.01"
                min={0}
                value={basePrice}
                onChange={(e) => setBasePrice(e.target.value)}
                required
                placeholder="150.00"
                className="w-full px-3 py-2 rounded-lg bg-background border border-border text-sm font-semibold"
              />
            </div>
          </div>

          <div className="grid grid-cols-3 gap-3">
            <div>
              <label className="block text-xs font-medium mb-1">Código TUSS</label>
              <input
                value={codeTuss}
                onChange={(e) => setCodeTuss(e.target.value)}
                placeholder="00000000"
                className="w-full px-3 py-2 rounded-lg bg-background border border-border text-sm font-mono"
              />
            </div>
            <div>
              <label className="block text-xs font-medium mb-1">Código interno</label>
              <input
                value={internalCode}
                onChange={(e) => setInternalCode(e.target.value)}
                placeholder="opcional"
                className="w-full px-3 py-2 rounded-lg bg-background border border-border text-sm"
              />
            </div>
            <div>
              <label className="block text-xs font-medium mb-1">Duração (min)</label>
              <input
                type="number"
                min={5}
                value={durationMinutes}
                onChange={(e) => setDurationMinutes(Number(e.target.value))}
                className="w-full px-3 py-2 rounded-lg bg-background border border-border text-sm"
              />
            </div>
          </div>

          <div>
            <label className="block text-xs font-medium mb-1">Descrição</label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={2}
              placeholder="Detalhes do procedimento, materiais, técnicas..."
              className="w-full px-3 py-2 rounded-lg bg-background border border-border text-sm resize-none"
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <label className="flex items-center gap-2 text-sm cursor-pointer">
              <input
                type="checkbox"
                checked={requiresXRay}
                onChange={(e) => setRequiresXRay(e.target.checked)}
                className="w-4 h-4 rounded border-border"
              />
              Requer raio-X
            </label>
            <label className="flex items-center gap-2 text-sm cursor-pointer">
              <input
                type="checkbox"
                checked={requiresAnesthesia}
                onChange={(e) => setRequiresAnesthesia(e.target.checked)}
                className="w-4 h-4 rounded border-border"
              />
              Requer anestesia
            </label>
          </div>

          <div>
            <label className="block text-xs font-medium mb-1">
              Revisita padrão (meses)
              <span className="text-muted-foreground ml-1">— pra estética facial</span>
            </label>
            <input
              type="number"
              min={1}
              value={defaultRevisitMonths}
              onChange={(e) => setDefaultRevisitMonths(e.target.value)}
              placeholder="Ex: 6 (limpeza), 12 (botox), 24 (sculptra)"
              className="w-full px-3 py-2 rounded-lg bg-background border border-border text-sm"
            />
          </div>

          <div className="flex justify-end gap-2 pt-2 border-t border-border">
            <button
              type="button"
              onClick={onClose}
              className="px-3 py-2 rounded-lg border border-border text-sm hover:bg-accent"
            >
              Cancelar
            </button>
            <button
              type="submit"
              disabled={saving}
              className="inline-flex items-center gap-1 px-3 py-2 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 disabled:opacity-50"
            >
              {saving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
              {isEdit ? 'Salvar' : 'Criar'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ─── Modal de reajuste em massa ───────────

function BulkAdjustModal({
  specialties, onClose, onApplied,
}: {
  specialties: Specialty[];
  onClose: () => void;
  onApplied: () => void;
}) {
  const [scope, setScope] = useState<'all' | 'specialty'>('all');
  const [specialtyId, setSpecialtyId] = useState('');
  const [percent, setPercent] = useState('5');
  const [direction, setDirection] = useState<'up' | 'down'>('up');
  const [applying, setApplying] = useState(false);

  const apply = async () => {
    const pct = Number(percent);
    if (isNaN(pct) || pct <= 0) return showError('Percentual inválido');
    if (scope === 'specialty' && !specialtyId) return showError('Escolha uma especialidade');
    const factor = direction === 'up' ? 1 + pct / 100 : 1 - pct / 100;
    const verb = direction === 'up' ? 'aumentar' : 'reduzir';
    const target = scope === 'all' ? 'TODOS os procedimentos ativos' : `procedimentos da especialidade selecionada`;
    if (!confirm(`Confirma ${verb} ${pct}% nos preços de ${target}?\n\nEssa ação não é reversível em massa.`)) return;

    setApplying(true);
    try {
      // Carrega procedimentos no escopo
      const params = new URLSearchParams();
      if (scope === 'specialty') params.set('specialtyId', specialtyId);
      const { data: procs } = await api.get<Procedure[]>(`/procedures?${params}`);
      const activeProcs = procs.filter((p) => p.active);

      // Aplica reajuste em série (poderia paralelizar mas mantém log claro)
      let updated = 0;
      for (const p of activeProcs) {
        const newPrice = Math.round(Number(p.base_price) * factor * 100) / 100;
        await api.patch(`/procedures/${p.id}`, { base_price: newPrice });
        updated++;
      }
      showSuccess(`Reajuste aplicado em ${updated} procedimento(s)`);
      onApplied();
    } catch (err: any) {
      showError(err?.response?.data?.message || 'Erro ao aplicar reajuste');
    } finally {
      setApplying(false);
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
          <div className="flex items-center gap-2">
            <TrendingUp size={18} className="text-primary" />
            <h2 className="text-base font-semibold">Reajuste em massa</h2>
          </div>
          <button onClick={onClose} className="p-1 hover:bg-accent rounded">
            <X size={18} />
          </button>
        </div>

        <div className="p-4 space-y-4">
          <div className="bg-amber-500/5 border border-amber-500/20 rounded-lg p-3 text-xs text-amber-700 flex items-start gap-2">
            <AlertCircle size={14} className="shrink-0 mt-0.5" />
            <span>
              <strong>Cuidado:</strong> aplica novo preço em vários procedimentos de uma só vez.
              Útil pra reajuste anual, mas <strong>não é reversível</strong> em massa.
            </span>
          </div>

          <div>
            <label className="block text-xs font-medium mb-1">Aplicar em</label>
            <select
              value={scope}
              onChange={(e) => setScope(e.target.value as 'all' | 'specialty')}
              className="w-full px-3 py-2 rounded-lg bg-background border border-border text-sm"
            >
              <option value="all">Todos os procedimentos ativos</option>
              <option value="specialty">Apenas uma especialidade</option>
            </select>
          </div>

          {scope === 'specialty' && (
            <div>
              <label className="block text-xs font-medium mb-1">Especialidade</label>
              <select
                value={specialtyId}
                onChange={(e) => setSpecialtyId(e.target.value)}
                className="w-full px-3 py-2 rounded-lg bg-background border border-border text-sm"
              >
                <option value="">Selecione</option>
                {specialties.map((s) => (
                  <option key={s.id} value={s.id}>{s.name}</option>
                ))}
              </select>
            </div>
          )}

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium mb-1">Direção</label>
              <select
                value={direction}
                onChange={(e) => setDirection(e.target.value as 'up' | 'down')}
                className="w-full px-3 py-2 rounded-lg bg-background border border-border text-sm"
              >
                <option value="up">Aumentar (+)</option>
                <option value="down">Reduzir (-)</option>
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium mb-1">Percentual (%)</label>
              <input
                type="number"
                step="0.5"
                min={0.5}
                max={100}
                value={percent}
                onChange={(e) => setPercent(e.target.value)}
                className="w-full px-3 py-2 rounded-lg bg-background border border-border text-sm"
              />
            </div>
          </div>

          <div className="flex justify-end gap-2 pt-2 border-t border-border">
            <button
              type="button"
              onClick={onClose}
              className="px-3 py-2 rounded-lg border border-border text-sm hover:bg-accent"
            >
              Cancelar
            </button>
            <button
              onClick={apply}
              disabled={applying}
              className="inline-flex items-center gap-1 px-3 py-2 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 disabled:opacity-50"
            >
              {applying ? <Loader2 size={14} className="animate-spin" /> : <TrendingUp size={14} />}
              Aplicar reajuste
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

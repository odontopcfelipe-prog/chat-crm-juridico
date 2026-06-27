'use client';

/**
 * Settings → Sugestões automáticas (estado clínico → procedimento).
 *
 * Quando dentista anota um estado num dente do odontograma, sistema sugere
 * automaticamente um procedimento ao orçamento (se houver mapping configurado).
 * Reduz cliques de anotar -> orçar de ~4 pra 2.
 *
 * UX: estados pré-definidos, cada um pode ter N sugestões (priority decide ordem).
 * Sem mapping = fluxo cai pro picker manual (UX padrão).
 */
import { useEffect, useMemo, useState } from 'react';
import {
  Lightbulb, Loader2, Plus, X, Search,
} from 'lucide-react';
import api from '@/lib/api';
import { showError, showSuccess } from '@/lib/toast';

interface Procedure {
  id: string;
  name: string;
  base_price: string | number;
  code_tuss: string | null;
  duration_minutes?: number;
  specialty?: { id: string; name: string } | null;
}

interface Suggestion {
  id: string;
  state: string;
  procedure_id: string;
  priority: number;
  active: boolean;
  procedure: Procedure;
}

// Estados clinicos suportados (espelha VALID_STATES no backend)
const STATES = [
  { v: 'CARIE', label: 'Cárie', cls: 'bg-red-500/10 text-red-700 border-red-500/40' },
  { v: 'RESTAURADO', label: 'Restaurado', cls: 'bg-blue-500/10 text-blue-700 border-blue-500/40' },
  { v: 'AUSENTE', label: 'Ausente', cls: 'bg-muted text-muted-foreground border-border' },
  { v: 'PROTESE', label: 'Prótese', cls: 'bg-purple-500/10 text-purple-700 border-purple-500/40' },
  { v: 'IMPLANTE', label: 'Implante', cls: 'bg-indigo-500/10 text-indigo-700 border-indigo-500/40' },
  { v: 'ENDODONTIA', label: 'Endodontia', cls: 'bg-amber-500/10 text-amber-700 border-amber-500/40' },
  { v: 'EXTRACAO_INDICADA', label: 'Extração indicada', cls: 'bg-orange-500/10 text-orange-700 border-orange-500/40' },
  { v: 'COROA', label: 'Coroa', cls: 'bg-teal-500/10 text-teal-700 border-teal-500/40' },
  { v: 'FRATURA', label: 'Fratura', cls: 'bg-pink-500/10 text-pink-700 border-pink-500/40' },
  { v: 'OUTROS', label: 'Outros', cls: 'bg-gray-500/10 text-gray-700 border-gray-500/40' },
] as const;

const formatBRL = (v: number | string) =>
  Number(v).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

type ApiError = { response?: { data?: { message?: string } } };
const errMsg = (err: unknown, fallback: string) =>
  (err as ApiError)?.response?.data?.message || fallback;

export default function SugestoesClinicasPage() {
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [procedures, setProcedures] = useState<Procedure[]>([]);
  const [loading, setLoading] = useState(true);
  const [addingForState, setAddingForState] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    try {
      const [sugRes, procRes] = await Promise.all([
        api.get<Suggestion[]>('/state-suggestions'),
        api.get<Procedure[]>('/procedures'),
      ]);
      setSuggestions(sugRes.data || []);
      setProcedures(procRes.data || []);
    } catch (err) {
      showError(errMsg(err, 'Erro ao carregar'));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const byState = useMemo(() => {
    const m = new Map<string, Suggestion[]>();
    for (const s of suggestions) {
      if (!m.has(s.state)) m.set(s.state, []);
      m.get(s.state)!.push(s);
    }
    for (const arr of m.values()) arr.sort((a, b) => a.priority - b.priority);
    return m;
  }, [suggestions]);

  const removeSuggestion = async (id: string) => {
    if (!confirm('Remover esta sugestao?')) return;
    try {
      await api.delete(`/state-suggestions/${id}`);
      showSuccess('Removido');
      await load();
    } catch (err) {
      showError(errMsg(err, 'Erro ao remover'));
    }
  };

  const toggleActive = async (s: Suggestion) => {
    try {
      await api.patch(`/state-suggestions/${s.id}`, { active: !s.active });
      await load();
    } catch (err) {
      showError(errMsg(err, 'Erro ao alterar'));
    }
  };

  const onSuggestionAdded = async () => {
    setAddingForState(null);
    await load();
  };

  if (loading) {
    return (
      <div className="py-16 flex items-center justify-center text-muted-foreground">
        <Loader2 size={18} className="animate-spin mr-2" /> Carregando...
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto max-w-4xl mx-auto p-6 space-y-4">
      <div className="flex items-start gap-3">
        <Lightbulb size={24} className="text-amber-600 shrink-0 mt-1" />
        <div>
          <h1 className="text-xl font-semibold">Sugestões automáticas</h1>
          <p className="text-sm text-muted-foreground">
            Quando dentista anotar um estado no odontograma (ex: cárie), sistema
            sugere automaticamente um procedimento ao orçamento. Configure abaixo.
            Sem mapping = fluxo manual continua funcionando normalmente.
          </p>
        </div>
      </div>

      {procedures.length === 0 && (
        <div className="bg-amber-500/5 border border-amber-500/30 rounded-xl p-4 text-sm">
          Nenhum procedimento cadastrado.{' '}
          <a href="/atendimento/settings/procedures" className="text-amber-700 underline font-medium">
            Cadastre a tabela de preços primeiro →
          </a>
        </div>
      )}

      <div className="space-y-3">
        {STATES.map((st) => {
          const list = byState.get(st.v) || [];
          const isAdding = addingForState === st.v;
          return (
            <div key={st.v} className="bg-card border border-border rounded-xl overflow-hidden">
              <div className={`px-4 py-2.5 border-b border-border flex items-center gap-3 ${st.cls.split(' ').slice(0, 2).join(' ')}`}>
                <span className={`inline-block px-2 py-0.5 rounded text-xs border font-semibold ${st.cls}`}>
                  {st.label}
                </span>
                <span className="text-xs text-muted-foreground">
                  {list.length === 0 ? 'sem sugestões' : `${list.length} ${list.length === 1 ? 'sugestão' : 'sugestões'}`}
                </span>
                {!isAdding && procedures.length > 0 && (
                  <button
                    onClick={() => setAddingForState(st.v)}
                    className="ml-auto text-xs inline-flex items-center gap-1 px-2.5 py-1 rounded-lg border border-border hover:bg-accent text-muted-foreground hover:text-foreground"
                  >
                    <Plus size={12} /> adicionar
                  </button>
                )}
              </div>

              {list.length > 0 && (
                <ul className="divide-y divide-border">
                  {list.map((s) => (
                    <li key={s.id} className="px-4 py-2.5 flex items-center gap-3">
                      <span className="text-sm font-medium flex-1 truncate">
                        {s.procedure.name}
                        {s.procedure.specialty && (
                          <span className="ml-2 text-xs text-muted-foreground font-normal">
                            · {s.procedure.specialty.name}
                          </span>
                        )}
                      </span>
                      <span className="text-sm font-semibold shrink-0">
                        {formatBRL(s.procedure.base_price)}
                      </span>
                      <span className="text-xs text-muted-foreground shrink-0">
                        prioridade {s.priority}
                      </span>
                      <label className="inline-flex items-center gap-1 text-xs cursor-pointer shrink-0">
                        <input
                          type="checkbox"
                          checked={s.active}
                          onChange={() => toggleActive(s)}
                          className="rounded"
                        />
                        Ativo
                      </label>
                      <button
                        onClick={() => removeSuggestion(s.id)}
                        className="text-muted-foreground hover:text-destructive p-1 shrink-0"
                        title="Remover"
                      >
                        <X size={14} />
                      </button>
                    </li>
                  ))}
                </ul>
              )}

              {isAdding && (
                <AddSuggestionRow
                  state={st.v}
                  procedures={procedures}
                  alreadyAdded={new Set(list.map((s) => s.procedure_id))}
                  onCancel={() => setAddingForState(null)}
                  onAdded={onSuggestionAdded}
                />
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─── Form inline pra adicionar nova sugestao ──────────────────

function AddSuggestionRow({
  state, procedures, alreadyAdded, onCancel, onAdded,
}: {
  state: string;
  procedures: Procedure[];
  alreadyAdded: Set<string>;
  onCancel: () => void;
  onAdded: () => void | Promise<void>;
}) {
  const [search, setSearch] = useState('');
  const [priority, setPriority] = useState(0);
  const [saving, setSaving] = useState(false);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return procedures
      .filter((p) => !alreadyAdded.has(p.id))
      .filter((p) =>
        !q || p.name.toLowerCase().includes(q) || (p.code_tuss || '').toLowerCase().includes(q),
      )
      .slice(0, 50);
  }, [procedures, alreadyAdded, search]);

  const submit = async (procedureId: string) => {
    setSaving(true);
    try {
      await api.post('/state-suggestions', {
        state,
        procedure_id: procedureId,
        priority,
      });
      showSuccess('Sugestao adicionada');
      await onAdded();
    } catch (err) {
      showError(errMsg(err, 'Erro ao adicionar'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="bg-background/50 border-t border-border p-3 space-y-2">
      <div className="flex items-center gap-2">
        <Search size={14} className="text-muted-foreground" />
        <input
          autoFocus
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Buscar procedimento..."
          className="flex-1 px-2 py-1.5 rounded-lg bg-background border border-border text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
        />
        <label className="text-xs text-muted-foreground inline-flex items-center gap-1">
          Prioridade:
          <input
            type="number"
            min={0}
            value={priority}
            onChange={(e) => setPriority(Math.max(0, parseInt(e.target.value, 10) || 0))}
            className="w-14 px-2 py-1 rounded border border-border bg-background text-sm text-center"
          />
        </label>
        <button
          onClick={onCancel}
          className="p-1 hover:bg-accent rounded text-muted-foreground"
          title="Cancelar"
        >
          <X size={14} />
        </button>
      </div>
      <div className="max-h-56 overflow-y-auto space-y-1 border border-border rounded-lg bg-card">
        {filtered.length === 0 ? (
          <div className="p-4 text-center text-xs text-muted-foreground">
            {procedures.length === alreadyAdded.size
              ? 'Todos os procedimentos ja estao mapeados pra este estado'
              : `Nenhum procedimento encontrado para "${search}"`}
          </div>
        ) : (
          filtered.map((p) => (
            <button
              key={p.id}
              onClick={() => submit(p.id)}
              disabled={saving}
              className="w-full px-3 py-2 flex items-center gap-2 hover:bg-accent/50 text-left text-sm border-b border-border last:border-b-0 disabled:opacity-50"
            >
              <Plus size={12} className="text-muted-foreground" />
              <span className="flex-1 truncate font-medium">{p.name}</span>
              {p.specialty && (
                <span className="text-[10px] text-muted-foreground">
                  {p.specialty.name}
                </span>
              )}
              <span className="font-semibold">{formatBRL(p.base_price)}</span>
            </button>
          ))
        )}
      </div>
    </div>
  );
}

'use client';

/**
 * Onda 17.32.163 — Passo 6 do Onboarding Wizard: revisão da tabela
 * de preços DENTRO do próprio passo (inline, sem modal/iframe).
 *
 * Historico das tentativas anteriores (bugs ja mapeados e evitados):
 *  - Onda 151: inline v1 — tela preta (toFixed em Decimal string),
 *    done prematuro a cada acao -> wizard pulava etapa sozinho
 *  - Onda 155/156: redirect/iframe — user pediu de volta o inline
 *
 * Regras desta versao:
 *  1. base_price SEMPRE passa por toNumber() (Prisma Decimal vem
 *     como string no JSON)
 *  2. NENHUMA acao (editar/remover/adicionar) marca a etapa como
 *     done — o user mexe a vontade sem o wizard avancar sozinho.
 *     Conclusao explicita via botao "Concluir revisao".
 *  3. Lista agrupada por especialidade, igual a tela do sistema.
 */
import { useEffect, useMemo, useState, useCallback } from 'react';
import {
  CheckCircle2, Loader2, Plus, Trash2, AlertCircle, Pencil, Tag,
} from 'lucide-react';
import api from '@/lib/api';

interface Procedure {
  id: string;
  name: string;
  // Prisma Decimal serializa como STRING em JSON
  base_price: number | string | null;
  duration_minutes: number | null;
  active: boolean;
  specialty?: { id: string; name: string; icon?: string | null } | null;
}

interface Props {
  alreadyDone?: boolean;
  /** Marca a etapa como done (so via botao explicito "Concluir revisao") */
  onConcluded: () => Promise<void>;
}

// ─── Helpers de moeda (Onda 153 — coercao segura de Decimal) ──────
function toNumber(v: number | string | null | undefined): number {
  if (v == null) return 0;
  if (typeof v === 'number') return isFinite(v) ? v : 0;
  const n = parseFloat(String(v).replace(',', '.'));
  return isFinite(n) ? n : 0;
}

function formatBRL(v: number | string | null | undefined): string {
  const n = toNumber(v);
  return `R$ ${n.toFixed(2).replace('.', ',')}`;
}

function parseBRL(s: string): number {
  const clean = String(s).replace(/[R$\s.]/g, '').replace(',', '.');
  const n = parseFloat(clean);
  return isNaN(n) ? 0 : n;
}

export default function PricingQuickReview({ alreadyDone = false, onConcluded }: Props) {
  const [list, setList] = useState<Procedure[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [savingId, setSavingId] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);
  const [concluding, setConcluding] = useState(false);

  // Override local do input de preco por id (nao muta o objeto)
  const [localEdits, setLocalEdits] = useState<Record<string, string>>({});

  // Adicionar novo
  const [newName, setNewName] = useState('');
  const [newPrice, setNewPrice] = useState('');
  const [adding, setAdding] = useState(false);

  // Confirmacao de remocao
  const [confirmDelete, setConfirmDelete] = useState<Procedure | null>(null);
  const [deleting, setDeleting] = useState(false);

  const flashSuccess = (msg: string) => {
    setSuccessMsg(msg);
    setTimeout(() => setSuccessMsg(null), 3000);
  };

  const fetchList = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const res = await api.get<Procedure[]>('/procedures');
      setList(Array.isArray(res.data) ? res.data : []);
    } catch (e: any) {
      const raw = e?.response?.data?.message || '';
      if (typeof raw === 'string' && raw.startsWith('Cannot')) {
        setError('Servidor ainda nao reconhece — deploy em andamento?');
      } else {
        setError('Nao foi possivel carregar a tabela de precos.');
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchList(); }, [fetchList]);

  // ─── Agrupamento por especialidade (igual a tela do sistema) ────
  const groups = useMemo(() => {
    const map = new Map<string, { name: string; icon: string; items: Procedure[] }>();
    for (const p of list) {
      const key = p.specialty?.id ?? '_none';
      if (!map.has(key)) {
        map.set(key, {
          name: p.specialty?.name ?? 'Sem especialidade',
          icon: p.specialty?.icon || '🦷',
          items: [],
        });
      }
      map.get(key)!.items.push(p);
    }
    return Array.from(map.values()).sort((a, b) => a.name.localeCompare(b.name));
  }, [list]);

  // ─── Editar preco inline (salva no blur) ────────────────────────
  const handlePriceChange = (id: string, v: string) =>
    setLocalEdits((m) => ({ ...m, [id]: v }));

  const handlePriceBlur = async (proc: Procedure) => {
    const localStr = localEdits[proc.id];
    if (localStr === undefined) return; // nao editou
    const newVal = parseBRL(localStr);
    const current = toNumber(proc.base_price);
    if (newVal === current) {
      setLocalEdits((m) => { const c = { ...m }; delete c[proc.id]; return c; });
      return;
    }
    setSavingId(proc.id); setError(null);
    try {
      await api.patch(`/procedures/${proc.id}`, { base_price: newVal });
      setList((arr) => arr.map((p) => p.id === proc.id ? { ...p, base_price: newVal } : p));
      setLocalEdits((m) => { const c = { ...m }; delete c[proc.id]; return c; });
      flashSuccess(`"${proc.name}" → ${formatBRL(newVal)}`);
    } catch (e: any) {
      const raw = e?.response?.data?.message || '';
      setError(typeof raw === 'string' && raw ? raw : 'Falha ao salvar o preço.');
    } finally {
      setSavingId(null);
    }
  };

  // ─── Adicionar ──────────────────────────────────────────────────
  const handleAdd = async () => {
    if (!newName.trim()) { setError('Nome do procedimento é obrigatório.'); return; }
    setAdding(true); setError(null);
    try {
      const payload: any = { name: newName.trim() };
      if (newPrice.trim()) payload.base_price = parseBRL(newPrice);
      const res = await api.post<Procedure>('/procedures', payload);
      setList((arr) => [res.data, ...arr]);
      flashSuccess(`"${newName.trim()}" adicionado.`);
      setNewName(''); setNewPrice('');
    } catch (e: any) {
      const raw = e?.response?.data?.message || '';
      setError(typeof raw === 'string' && raw ? raw : 'Falha ao adicionar.');
    } finally {
      setAdding(false);
    }
  };

  // ─── Remover ────────────────────────────────────────────────────
  const handleDeleteConfirm = async () => {
    if (!confirmDelete) return;
    setDeleting(true); setError(null);
    try {
      await api.delete(`/procedures/${confirmDelete.id}`);
      setList((arr) => arr.filter((p) => p.id !== confirmDelete.id));
      flashSuccess(`"${confirmDelete.name}" removido.`);
      setConfirmDelete(null);
    } catch (e: any) {
      const raw = e?.response?.data?.message || '';
      setError(typeof raw === 'string' && raw ? raw : 'Falha ao remover.');
    } finally {
      setDeleting(false);
    }
  };

  // ─── Concluir revisao (UNICO ponto que marca done) ──────────────
  const handleConclude = async () => {
    setConcluding(true); setError(null);
    try {
      await onConcluded();
    } catch {
      setError('Não foi possível salvar a conclusão. Tente de novo.');
    } finally {
      setConcluding(false);
    }
  };

  return (
    <>
      <div className="bg-violet-500/5 border border-violet-500/20 rounded-2xl p-4 max-h-[52vh] overflow-y-auto">
        {/* Banner sucesso efemero */}
        {successMsg && (
          <div className="mb-3 bg-emerald-500/15 border border-emerald-500/40 rounded-xl p-2.5 flex items-center gap-2 animate-in slide-in-from-top-2 duration-300">
            <CheckCircle2 size={16} className="text-emerald-500 shrink-0" />
            <p className="text-xs font-medium text-emerald-700 dark:text-emerald-400 flex-1">{successMsg}</p>
          </div>
        )}
        {alreadyDone && !successMsg && (
          <p className="mb-3 text-xs text-emerald-700 dark:text-emerald-400 flex items-center gap-1.5">
            <CheckCircle2 size={12} />
            Você já revisou a tabela. Pode ajustar mais se quiser.
          </p>
        )}

        <p className="text-xs text-muted-foreground mb-3 flex items-center gap-1.5">
          <Pencil size={11} />
          Clique num preço pra editar (salva ao sair do campo). Lixeira remove.
        </p>

        {/* Adicionar novo */}
        <div className="bg-white dark:bg-card border border-violet-500/30 rounded-xl p-3 mb-4">
          <p className="text-[10px] font-bold uppercase tracking-wider text-violet-700 dark:text-violet-400 mb-2 flex items-center gap-1">
            <Plus size={12} /> Adicionar procedimento
          </p>
          <div className="grid grid-cols-1 md:grid-cols-[1fr_120px_110px] gap-2">
            <input
              type="text"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="Nome do procedimento"
              className="px-3 py-2 rounded-lg bg-background border border-border text-sm outline-none focus:border-violet-500"
            />
            <input
              type="text"
              value={newPrice}
              onChange={(e) => setNewPrice(e.target.value)}
              placeholder="R$ 0,00"
              className="px-3 py-2 rounded-lg bg-background border border-border text-sm outline-none focus:border-violet-500 font-mono"
            />
            <button
              type="button"
              onClick={handleAdd}
              disabled={adding || !newName.trim()}
              className="inline-flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg bg-violet-600 hover:bg-violet-700 text-white font-bold text-xs transition-all disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {adding ? <Loader2 className="animate-spin" size={14} /> : <Plus size={14} />}
              Adicionar
            </button>
          </div>
        </div>

        {/* Lista agrupada por especialidade */}
        {loading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground py-8 justify-center">
            <Loader2 className="animate-spin" size={16} />
            Carregando tabela…
          </div>
        ) : list.length === 0 ? (
          <p className="text-center text-sm text-muted-foreground py-8">
            Nenhum procedimento ainda. Adicione um acima pra começar.
          </p>
        ) : (
          <div className="space-y-4">
            {groups.map((g) => (
              <div key={g.name}>
                <div className="flex items-center justify-between mb-1.5 px-1">
                  <span className="text-xs font-bold text-foreground flex items-center gap-1.5">
                    <span>{g.icon}</span>
                    {g.name}
                    <span className="text-[10px] font-bold text-violet-600 dark:text-violet-400 bg-violet-500/10 px-1.5 py-0.5 rounded-full">
                      {g.items.length}
                    </span>
                  </span>
                  <span className="text-[10px] font-bold text-muted-foreground">
                    {formatBRL(g.items.reduce((sum, p) => sum + toNumber(p.base_price), 0))}
                  </span>
                </div>
                <ul className="space-y-1">
                  {g.items.map((proc) => {
                    const localPrice = localEdits[proc.id];
                    const isSaving = savingId === proc.id;
                    return (
                      <li
                        key={proc.id}
                        className="bg-white dark:bg-card border border-border rounded-lg px-3 py-1.5 flex items-center gap-2 hover:border-violet-500/40 transition-colors"
                      >
                        <span className="flex-1 min-w-0 text-sm text-foreground truncate">{proc.name}</span>
                        {proc.duration_minutes != null && (
                          <span className="text-[10px] text-muted-foreground shrink-0 hidden md:inline">
                            {proc.duration_minutes} min
                          </span>
                        )}
                        <div className="flex items-center gap-1 shrink-0">
                          <input
                            type="text"
                            value={localPrice ?? formatBRL(proc.base_price)}
                            onChange={(e) => handlePriceChange(proc.id, e.target.value)}
                            onBlur={() => handlePriceBlur(proc)}
                            disabled={isSaving}
                            className="w-24 px-2 py-1 rounded-md bg-violet-50 dark:bg-violet-900/20 border border-violet-200 dark:border-violet-800 text-xs font-mono font-bold text-violet-700 dark:text-violet-300 outline-none focus:border-violet-500 text-right disabled:opacity-50"
                          />
                          {isSaving && <Loader2 className="animate-spin text-violet-500" size={13} />}
                        </div>
                        <button
                          type="button"
                          onClick={() => setConfirmDelete(proc)}
                          disabled={isSaving}
                          title="Remover"
                          className="text-rose-500 hover:bg-rose-500/10 p-1 rounded-md disabled:opacity-50 shrink-0"
                        >
                          <Trash2 size={13} />
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </div>
            ))}
          </div>
        )}

        {error && (
          <p className="mt-3 text-xs text-rose-600 dark:text-rose-400 flex items-start gap-1.5">
            <AlertCircle size={14} className="shrink-0 mt-0.5" />
            <span>{error}</span>
          </p>
        )}

        {/* Concluir revisao — UNICO ponto que marca a etapa como done.
            Acoes na tabela nunca avancam o wizard sozinhas. */}
        {!alreadyDone && !loading && (
          <button
            type="button"
            onClick={handleConclude}
            disabled={concluding}
            className="mt-4 w-full inline-flex items-center justify-center gap-2 px-6 py-2.5 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white font-bold text-sm transition-all disabled:opacity-50"
          >
            {concluding ? <Loader2 className="animate-spin" size={16} /> : <Tag size={16} />}
            Concluir revisão da tabela
          </button>
        )}
      </div>

      {/* Modal confirmacao de remocao (acima do wizard z-200) */}
      {confirmDelete && (
        <div
          className="fixed inset-0 z-[210] bg-black/60 flex items-center justify-center p-4"
          onClick={() => !deleting && setConfirmDelete(null)}
        >
          <div
            className="bg-card border border-border rounded-2xl p-5 max-w-sm w-full"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="text-base font-bold text-foreground mb-2">Remover procedimento?</h3>
            <p className="text-sm text-muted-foreground mb-4">
              "<b>{confirmDelete.name}</b>" será removido da tabela. Você pode adicionar de novo quando quiser.
            </p>
            <div className="flex gap-2 justify-end">
              <button
                onClick={() => setConfirmDelete(null)}
                disabled={deleting}
                className="px-4 py-2 rounded-lg text-sm font-bold text-muted-foreground hover:bg-muted/40 disabled:opacity-50"
              >
                Cancelar
              </button>
              <button
                onClick={handleDeleteConfirm}
                disabled={deleting}
                className="bg-rose-500 hover:bg-rose-600 text-white font-bold text-sm px-4 py-2 rounded-lg inline-flex items-center gap-1.5 disabled:opacity-50"
              >
                {deleting ? <Loader2 className="animate-spin" size={14} /> : <Trash2 size={14} />}
                Remover
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

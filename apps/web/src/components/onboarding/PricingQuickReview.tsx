'use client';

/**
 * Onda 17.32.151 — Revisão rápida da tabela de preços no Onboarding Wizard.
 *
 * Lista todos os procedimentos do tenant (plantados via seed default ou
 * adicionados manualmente). Permite:
 *   - Editar preço inline (input controlado, salva no blur)
 *   - Remover (com confirmação)
 *   - Adicionar novo procedimento (nome + preço)
 *
 * Quando o user mexer em qualquer coisa, dispara onUpdated() pra
 * marcar a etapa como done.
 */
import { useEffect, useState, useCallback } from 'react';
import {
  CheckCircle2, Loader2, Plus, Trash2, AlertCircle, Pencil,
} from 'lucide-react';
import api from '@/lib/api';

interface Procedure {
  id: string;
  name: string;
  // Prisma Decimal serializa como STRING em JSON, nao number.
  // Aceitamos os 3 formatos pra robustez.
  base_price: number | string | null;
  duration_minutes: number | null;
  active: boolean;
  specialty?: { id: string; name: string } | null;
}

interface Props {
  alreadyDone?: boolean;
  onUpdated: () => Promise<void>;
}

/** Onda 17.32.153 — Coerce qualquer tipo (number|string|null) pra number. */
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
  // Remove "R$", pontos de milhar e troca vírgula por ponto
  const clean = String(s).replace(/[R$\s.]/g, '').replace(',', '.');
  const n = parseFloat(clean);
  return isNaN(n) ? 0 : n;
}

export default function PricingQuickReview({ alreadyDone = false, onUpdated }: Props) {
  const [list, setList] = useState<Procedure[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [savingId, setSavingId] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);

  // Nova linha (add manual)
  const [newName, setNewName] = useState('');
  const [newPrice, setNewPrice] = useState('');
  const [adding, setAdding] = useState(false);

  // Confirmação de remoção
  const [confirmDelete, setConfirmDelete] = useState<Procedure | null>(null);

  // Onda 17.32.153 — Override local do input de preco por id (em vez
  // de mutar o objeto Procedure com cast `as any`)
  const [localEdits, setLocalEdits] = useState<Record<string, string>>({});

  const fetchList = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const res = await api.get<Procedure[]>('/procedures');
      setList(Array.isArray(res.data) ? res.data : []);
    } catch (e: any) {
      const raw = e?.response?.data?.message || '';
      setError(typeof raw === 'string' ? raw : 'Não foi possível carregar a tabela de preços.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchList(); }, [fetchList]);

  // ─── Edita preço inline ──────────────────────────────────────────
  const handlePriceChange = (id: string, newValue: string) => {
    setLocalEdits((m) => ({ ...m, [id]: newValue }));
  };

  const handlePriceBlur = async (proc: Procedure) => {
    const localStr = localEdits[proc.id];
    if (localStr === undefined) return; // nao editou
    const newPrice = parseBRL(localStr);
    const currentPrice = toNumber(proc.base_price);
    if (newPrice === currentPrice) {
      // Limpa override pra mostrar valor formatado oficial
      setLocalEdits((m) => { const c = { ...m }; delete c[proc.id]; return c; });
      return;
    }
    setSavingId(proc.id);
    try {
      await api.patch(`/procedures/${proc.id}`, { base_price: newPrice });
      setList((arr) => arr.map((p) =>
        p.id === proc.id ? { ...p, base_price: newPrice } : p
      ));
      setLocalEdits((m) => { const c = { ...m }; delete c[proc.id]; return c; });
      setSuccessMsg(`"${proc.name}" atualizado pra ${formatBRL(newPrice)}`);
      setTimeout(() => setSuccessMsg(null), 3000);
      await onUpdated();
    } catch (e: any) {
      const raw = e?.response?.data?.message || '';
      setError(typeof raw === 'string' ? raw : 'Falha ao salvar preço.');
    } finally {
      setSavingId(null);
    }
  };

  // ─── Adicionar novo ──────────────────────────────────────────────
  const handleAdd = async () => {
    if (!newName.trim()) {
      setError('Nome do procedimento é obrigatório.');
      return;
    }
    setAdding(true); setError(null);
    try {
      const payload: any = { name: newName.trim() };
      if (newPrice.trim()) payload.base_price = parseBRL(newPrice);
      const res = await api.post<Procedure>('/procedures', payload);
      setList((arr) => [res.data, ...arr]);
      setSuccessMsg(`"${newName.trim()}" adicionado.`);
      setNewName(''); setNewPrice('');
      setTimeout(() => setSuccessMsg(null), 3000);
      await onUpdated();
    } catch (e: any) {
      const raw = e?.response?.data?.message || '';
      setError(typeof raw === 'string' ? raw : 'Falha ao adicionar procedimento.');
    } finally {
      setAdding(false);
    }
  };

  // ─── Remover ─────────────────────────────────────────────────────
  const handleDeleteConfirm = async () => {
    if (!confirmDelete) return;
    setSavingId(confirmDelete.id); setError(null);
    try {
      await api.delete(`/procedures/${confirmDelete.id}`);
      setList((arr) => arr.filter((p) => p.id !== confirmDelete.id));
      setSuccessMsg(`"${confirmDelete.name}" removido.`);
      setConfirmDelete(null);
      setTimeout(() => setSuccessMsg(null), 3000);
      await onUpdated();
    } catch (e: any) {
      const raw = e?.response?.data?.message || '';
      setError(typeof raw === 'string' ? raw : 'Falha ao remover.');
    } finally {
      setSavingId(null);
    }
  };

  // ─── Render ──────────────────────────────────────────────────────
  return (
    <div className="bg-violet-500/5 border border-violet-500/20 rounded-2xl p-5 max-h-[55vh] overflow-y-auto">
      {/* Banner sucesso */}
      {successMsg && (
        <div className="mb-3 bg-emerald-500/15 border border-emerald-500/40 rounded-xl p-2.5 flex items-center gap-2 animate-in slide-in-from-top-2 duration-300">
          <CheckCircle2 size={16} className="text-emerald-500 shrink-0" />
          <p className="text-xs font-medium text-emerald-700 dark:text-emerald-400 flex-1">{successMsg}</p>
        </div>
      )}
      {alreadyDone && !successMsg && (
        <p className="mb-3 text-xs text-emerald-700 dark:text-emerald-400 flex items-center gap-1.5">
          <CheckCircle2 size={12} />
          Você já personalizou a tabela. Pode revisar mais um pouco se quiser.
        </p>
      )}

      <p className="text-xs text-muted-foreground mb-3">
        Essa é a tabela de preços padrão da clínica. Edite qualquer valor (clique e digite),
        remova o que não usa ou adicione novos procedimentos.
      </p>

      {/* Adicionar novo */}
      <div className="bg-white dark:bg-card border border-violet-500/30 rounded-xl p-3 mb-4">
        <p className="text-[10px] font-bold uppercase tracking-wider text-violet-700 dark:text-violet-400 mb-2 flex items-center gap-1">
          <Plus size={12} /> Adicionar novo procedimento
        </p>
        <div className="grid grid-cols-1 md:grid-cols-[1fr_140px_120px] gap-2">
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

      {/* Lista */}
      {loading ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground py-6 justify-center">
          <Loader2 className="animate-spin" size={16} />
          Carregando tabela…
        </div>
      ) : list.length === 0 ? (
        <p className="text-center text-sm text-muted-foreground py-6">
          Nenhum procedimento cadastrado ainda. Adicione um acima pra começar.
        </p>
      ) : (
        <ul className="space-y-1.5">
          {list.map((proc) => {
            const localPrice = localEdits[proc.id];
            const isSaving = savingId === proc.id;
            return (
              <li
                key={proc.id}
                className="bg-white dark:bg-card border border-border rounded-lg px-3 py-2 flex items-center gap-3 hover:border-violet-500/40 transition-colors"
              >
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-foreground truncate">{proc.name}</p>
                  {proc.specialty?.name && (
                    <p className="text-[10px] text-muted-foreground truncate">
                      {proc.specialty.name}
                    </p>
                  )}
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  <Pencil size={11} className="text-muted-foreground" />
                  <input
                    type="text"
                    value={localPrice ?? formatBRL(proc.base_price)}
                    onChange={(e) => handlePriceChange(proc.id, e.target.value)}
                    onBlur={() => handlePriceBlur(proc)}
                    disabled={isSaving}
                    className="w-28 px-2 py-1 rounded-md bg-violet-50 dark:bg-violet-900/20 border border-violet-200 dark:border-violet-800 text-xs font-mono font-bold text-violet-700 dark:text-violet-300 outline-none focus:border-violet-500 disabled:opacity-50"
                  />
                  {isSaving && <Loader2 className="animate-spin text-violet-500" size={14} />}
                </div>
                <button
                  type="button"
                  onClick={() => setConfirmDelete(proc)}
                  disabled={isSaving}
                  title="Remover"
                  className="text-rose-500 hover:bg-rose-500/10 p-1.5 rounded-md disabled:opacity-50"
                >
                  <Trash2 size={14} />
                </button>
              </li>
            );
          })}
        </ul>
      )}

      {error && (
        <p className="mt-3 text-xs text-rose-600 dark:text-rose-400 flex items-start gap-1.5">
          <AlertCircle size={14} className="shrink-0 mt-0.5" />
          <span>{error}</span>
        </p>
      )}

      {/* Modal confirmação remoção */}
      {confirmDelete && (
        <div
          className="fixed inset-0 z-[210] bg-black/60 flex items-center justify-center p-4"
          onClick={() => setConfirmDelete(null)}
        >
          <div
            className="bg-card border border-border rounded-2xl p-5 max-w-sm w-full"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="text-base font-bold text-foreground mb-2">Remover procedimento?</h3>
            <p className="text-sm text-muted-foreground mb-4">
              "<b>{confirmDelete.name}</b>" será removido da tabela. Você pode adicionar de novo a qualquer momento.
            </p>
            <div className="flex gap-2 justify-end">
              <button
                onClick={() => setConfirmDelete(null)}
                className="px-4 py-2 rounded-lg text-sm font-bold text-muted-foreground hover:bg-muted/40"
              >
                Cancelar
              </button>
              <button
                onClick={handleDeleteConfirm}
                disabled={savingId === confirmDelete.id}
                className="bg-rose-500 hover:bg-rose-600 text-white font-bold text-sm px-4 py-2 rounded-lg inline-flex items-center gap-1.5 disabled:opacity-50"
              >
                {savingId === confirmDelete.id
                  ? <Loader2 className="animate-spin" size={14} />
                  : <Trash2 size={14} />}
                Remover
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

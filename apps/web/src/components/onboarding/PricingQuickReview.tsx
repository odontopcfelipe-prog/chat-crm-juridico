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

interface Specialty {
  id: string;
  name: string;
  icon?: string | null;
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
  // Onda 17.32.164 — especialidade do novo procedimento (opcional)
  const [newSpecialtyId, setNewSpecialtyId] = useState('');
  const [specialties, setSpecialties] = useState<Specialty[]>([]);
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

  // Onda 17.32.164 — Carrega especialidades pro select do "Adicionar".
  // Best-effort: se falhar, o select simplesmente nao aparece e o
  // procedimento e criado sem especialidade (comportamento anterior).
  useEffect(() => {
    api.get<Specialty[]>('/specialties')
      .then((r) => setSpecialties(Array.isArray(r.data) ? r.data : []))
      .catch(() => { /* select fica vazio — add continua funcionando */ });
  }, []);

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
      // Onda 17.32.164 — especialidade escolhida no select (opcional)
      if (newSpecialtyId) payload.specialty_id = newSpecialtyId;
      const res = await api.post<Procedure>('/procedures', payload);
      // O POST pode nao devolver o objeto specialty populado — injeta
      // localmente pro item cair no grupo certo sem precisar refetch
      const chosen = specialties.find((s) => s.id === newSpecialtyId) || null;
      const created: Procedure = {
        ...res.data,
        specialty: res.data.specialty ?? chosen,
      };
      setList((arr) => [created, ...arr]);
      flashSuccess(`"${newName.trim()}" adicionado${chosen ? ` em ${chosen.name}` : ''}.`);
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
      <div className="rounded-2xl border border-white/5 bg-black/30 p-4 max-h-[52vh] overflow-y-auto">
        {/* Banner sucesso efemero */}
        {successMsg && (
          <div className="mb-3 flex items-center gap-2 rounded-xl border border-emerald-400/30 bg-emerald-500/15 p-2.5">
            <CheckCircle2 size={16} className="shrink-0 text-emerald-400" />
            <p className="flex-1 text-xs font-medium text-emerald-300">{successMsg}</p>
          </div>
        )}
        {alreadyDone && !successMsg && (
          <p className="mb-3 flex items-center gap-1.5 text-xs text-emerald-400">
            <CheckCircle2 size={12} />
            Você já revisou a tabela. Pode ajustar mais se quiser.
          </p>
        )}

        <p className="mb-3 flex items-center gap-1.5 text-xs text-zinc-500">
          <Pencil size={11} />
          Clique num preço pra editar (salva ao sair do campo). Lixeira remove.
        </p>

        {/* Adicionar novo */}
        <div className="mb-4 rounded-xl bg-white/[0.03] p-3 ring-1 ring-white/5">
          <p className="mb-2 flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wider text-amber-400">
            <Plus size={12} /> Adicionar procedimento
          </p>
          <div className="grid grid-cols-1 md:grid-cols-[1fr_170px_110px_110px] gap-2">
            <input
              type="text"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="Nome do procedimento"
              className="px-3 py-2 rounded-lg bg-white/[0.04] text-sm text-zinc-100 ring-1 ring-white/10 placeholder:text-zinc-600 transition focus:outline-none focus:ring-2 focus:ring-amber-400/40"
            />
            {/* Onda 17.32.164 — especialidade (opcional) */}
            <select
              value={newSpecialtyId}
              onChange={(e) => setNewSpecialtyId(e.target.value)}
              className="px-3 py-2 rounded-lg bg-white/[0.04] text-sm text-zinc-100 ring-1 ring-white/10 transition focus:outline-none focus:ring-2 focus:ring-amber-400/40 cursor-pointer"
            >
              <option value="" className="bg-zinc-900">Especialidade…</option>
              {specialties.map((s) => (
                <option key={s.id} value={s.id} className="bg-zinc-900">
                  {s.icon ? `${s.icon} ` : ''}{s.name}
                </option>
              ))}
            </select>
            <input
              type="text"
              value={newPrice}
              onChange={(e) => setNewPrice(e.target.value)}
              placeholder="R$ 0,00"
              className="px-3 py-2 rounded-lg bg-white/[0.04] text-sm font-mono text-zinc-100 ring-1 ring-white/10 placeholder:text-zinc-600 transition focus:outline-none focus:ring-2 focus:ring-amber-400/40"
            />
            <button
              type="button"
              onClick={handleAdd}
              disabled={adding || !newName.trim()}
              className="inline-flex items-center justify-center gap-1.5 rounded-lg bg-amber-400 px-3 py-2 text-xs font-semibold text-amber-950 transition hover:bg-amber-300 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-white/50"
            >
              {adding ? <Loader2 className="animate-spin" size={14} /> : <Plus size={14} />}
              Adicionar
            </button>
          </div>
        </div>

        {/* Lista agrupada por especialidade */}
        {loading ? (
          <div className="flex items-center justify-center gap-2 py-8 text-sm text-zinc-500">
            <Loader2 className="animate-spin" size={16} />
            Carregando tabela…
          </div>
        ) : list.length === 0 ? (
          <p className="py-8 text-center text-sm text-zinc-500">
            Nenhum procedimento ainda. Adicione um acima pra começar.
          </p>
        ) : (
          <div className="space-y-4">
            {groups.map((g) => (
              <div key={g.name}>
                <div className="mb-1.5 flex items-center justify-between px-1">
                  <span className="flex items-center gap-1.5 text-xs font-semibold text-zinc-200">
                    <span>{g.icon}</span>
                    {g.name}
                    <span className="rounded-full bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-semibold text-amber-400">
                      {g.items.length}
                    </span>
                  </span>
                  <span className="text-[10px] font-semibold tabular-nums text-zinc-500">
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
                        className="flex items-center gap-2 rounded-lg bg-white/[0.03] px-3 py-1.5 ring-1 ring-white/5 transition hover:ring-amber-400/30"
                      >
                        <span className="min-w-0 flex-1 truncate text-sm text-zinc-200">{proc.name}</span>
                        {proc.duration_minutes != null && (
                          <span className="hidden shrink-0 text-[10px] text-zinc-600 md:inline">
                            {proc.duration_minutes} min
                          </span>
                        )}
                        <div className="flex shrink-0 items-center gap-1">
                          <input
                            type="text"
                            value={localPrice ?? formatBRL(proc.base_price)}
                            onChange={(e) => handlePriceChange(proc.id, e.target.value)}
                            onBlur={() => handlePriceBlur(proc)}
                            disabled={isSaving}
                            className="w-24 rounded-md bg-amber-500/10 px-2 py-1 text-right text-xs font-mono font-semibold tabular-nums text-amber-300 ring-1 ring-amber-400/20 transition focus:outline-none focus:ring-2 focus:ring-amber-400/50 disabled:opacity-50"
                          />
                          {isSaving && <Loader2 className="animate-spin text-amber-400" size={13} />}
                        </div>
                        <button
                          type="button"
                          onClick={() => setConfirmDelete(proc)}
                          disabled={isSaving}
                          title="Remover"
                          className="shrink-0 rounded-md p-1 text-rose-400 transition hover:bg-rose-500/10 disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-white/30"
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
          <p className="mt-3 flex items-start gap-1.5 text-xs text-rose-400">
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
            className="mt-4 flex w-full items-center justify-center gap-2 rounded-xl bg-emerald-500 px-5 py-2.5 text-sm font-semibold text-emerald-950 shadow-lg transition hover:bg-emerald-400 active:scale-[0.98] disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-white/50"
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
            className="w-full max-w-sm rounded-2xl border border-white/10 bg-zinc-900 p-5 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="mb-2 text-base font-bold text-white">Remover procedimento?</h3>
            <p className="mb-4 text-sm leading-relaxed text-zinc-400">
              "<b className="text-zinc-200">{confirmDelete.name}</b>" será removido da tabela. Você pode adicionar de novo quando quiser.
            </p>
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setConfirmDelete(null)}
                disabled={deleting}
                className="rounded-lg px-4 py-2 text-sm font-medium text-zinc-500 transition hover:bg-white/5 hover:text-zinc-300 disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-white/30"
              >
                Cancelar
              </button>
              <button
                onClick={handleDeleteConfirm}
                disabled={deleting}
                className="inline-flex items-center gap-1.5 rounded-lg bg-rose-500 px-4 py-2 text-sm font-semibold text-rose-950 transition hover:bg-rose-400 disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-white/50"
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

'use client';

/**
 * Tabela de Preços → "Materiais" do procedimento.
 *
 * Liga o procedimento aos produtos do estoque que ele gasta (ProcedureConsumable).
 * É esse vínculo que a Venda rápida usa para dar baixa no estoque: sem material
 * ligado, a venda não baixa nada (o bloco "Dar baixa no estoque" nem aparece).
 * Antes só existia a API — não havia tela, então na prática nada baixava.
 *
 * Ligar o mesmo produto de novo só troca a quantidade (a API faz upsert).
 * Mudar exige a permissão de estoque (manage_inventory); sem ela, só leitura.
 */
import { useEffect, useState } from 'react';
import { Boxes, Loader2, Package, Plus, Save, Search, Trash2, X } from 'lucide-react';
import api, { API_BASE_URL } from '@/lib/api';
import { showError, showSuccess } from '@/lib/toast';
import { useAuthedImage } from '@/lib/use-authed-image';
import { useUserPermissions } from '@/lib/useUserPermissions';

interface ProdutoResumo {
  id: string;
  name: string;
  brand: string | null;
  unit: string;
  current_stock: string | number;
  photo_url: string | null;
  updated_at: string;
  active?: boolean;
}

interface Vinculo {
  id: string;
  quantity: string | number;
  product: ProdutoResumo;
}

const fmtQtd = (v: number) => v.toLocaleString('pt-BR', { maximumFractionDigits: 3 });

/** "1,5" / "1.5" / "2" → número com até 3 casas (o que a API aceita). Inválido ou ≤ 0 = NaN. */
function parseQtd(txt: string): number {
  const s = txt.trim().replace(/\s+/g, '').replace(',', '.');
  if (!/^\d+(\.\d{1,3})?$/.test(s)) return NaN;
  const n = Number(s);
  return n > 0 ? n : NaN;
}

function errMsg(err: unknown, fallback: string): string {
  const e = err as { response?: { data?: { message?: unknown } }; message?: unknown } | null;
  const msg = e?.response?.data?.message ?? e?.message;
  if (Array.isArray(msg)) return msg.join(', ') || fallback;
  return typeof msg === 'string' && msg ? msg : fallback;
}

/** Miniatura da foto do produto (fetch autenticado); sem foto, ícone de pacote. */
function Miniatura({ produto, size = 36 }: { produto: ProdutoResumo; size?: number }) {
  const url = produto.photo_url
    ? `${API_BASE_URL}/products/${produto.id}/photo?v=${encodeURIComponent(produto.updated_at)}`
    : null;
  const { src } = useAuthedImage(url);
  return (
    <div
      className="rounded-lg overflow-hidden shrink-0 flex items-center justify-center bg-muted text-muted-foreground"
      style={{ width: size, height: size }}
    >
      {src ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={src} alt={produto.name} className="w-full h-full object-cover" />
      ) : (
        <Package size={Math.round(size * 0.45)} className="opacity-60" />
      )}
    </div>
  );
}

function Saldo({ produto }: { produto: ProdutoResumo }) {
  const saldo = Number(produto.current_stock) || 0;
  return (
    <span className={`tabular-nums ${saldo <= 0 ? 'text-red-600 dark:text-red-400 font-semibold' : 'text-muted-foreground'}`}>
      saldo {fmtQtd(saldo)} {produto.unit}
    </span>
  );
}

/**
 * Botão "Materiais" da linha do procedimento, com a contagem. Mora aqui (e não na
 * page.tsx) porque a page tem pickBt e o CI trava texto novo em arquivo com pickBt.
 */
export function BotaoMateriais({ quantidade, onClick }: { quantidade: number; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className={`relative p-1 mr-1 rounded transition-colors ${
        quantidade > 0 ? 'text-primary hover:text-primary/80' : 'text-muted-foreground/50 hover:text-foreground'
      }`}
      title={quantidade > 0
        ? `Gasta ${quantidade} ${quantidade === 1 ? 'material' : 'materiais'} do estoque — clique para ver`
        : 'Ligar materiais do estoque (a venda rápida dá baixa por eles)'}
      aria-label="Materiais do estoque"
    >
      <Boxes size={14} />
      {quantidade > 0 && (
        <span className="absolute -top-1 -right-1 min-w-[14px] h-[14px] px-0.5 rounded-full bg-primary text-primary-foreground text-[9px] font-bold leading-[14px] text-center">
          {quantidade}
        </span>
      )}
    </button>
  );
}

export default function MateriaisProcedimento({
  procedureId, procedureName, onClose, onChanged,
}: {
  procedureId: string;
  procedureName: string;
  onClose: () => void;
  /** Quantidade de materiais ligados depois de cada mudança (atualiza a contagem na lista). */
  onChanged: (total: number) => void;
}) {
  const { hasPermission } = useUserPermissions();
  const podeMudar = hasPermission('manage_inventory');

  const [vinculos, setVinculos] = useState<Vinculo[]>([]);
  const [carregando, setCarregando] = useState(true);
  // Quantidade sendo editada na linha (id do vínculo → texto).
  const [rascunho, setRascunho] = useState<Record<string, string>>({});
  const [salvando, setSalvando] = useState<string | null>(null);

  // Adicionar: busca no estoque → escolhe → quantidade.
  const [busca, setBusca] = useState('');
  const [resultados, setResultados] = useState<ProdutoResumo[]>([]);
  const [buscando, setBuscando] = useState(false);
  const [escolhido, setEscolhido] = useState<ProdutoResumo | null>(null);
  const [qtdTxt, setQtdTxt] = useState('1');

  const carregar = async () => {
    try {
      const { data } = await api.get<Vinculo[]>(`/procedures/${procedureId}/consumables`);
      const lista = Array.isArray(data) ? data : [];
      setVinculos(lista);
      onChanged(lista.length);
    } catch (err: unknown) {
      showError(errMsg(err, 'Erro ao carregar os materiais'));
    } finally {
      setCarregando(false);
    }
  };

  useEffect(() => {
    carregar();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [procedureId]);

  // Busca de produto (só ativos), com espera de 250 ms entre teclas.
  useEffect(() => {
    if (!podeMudar || escolhido) return;
    let cancelado = false;
    setBuscando(true);
    const t = setTimeout(() => {
      const params = new URLSearchParams({ active: 'true', limit: '20' });
      if (busca.trim()) params.set('search', busca.trim());
      api.get<{ data: ProdutoResumo[] }>(`/products?${params}`)
        .then(({ data }) => { if (!cancelado) setResultados(Array.isArray(data?.data) ? data.data : []); })
        .catch(() => { if (!cancelado) setResultados([]); })
        .finally(() => { if (!cancelado) setBuscando(false); });
    }, 250);
    return () => { cancelado = true; clearTimeout(t); };
  }, [busca, escolhido, podeMudar]);

  const ligar = async (produto: ProdutoResumo, quantidade: number, chave: string) => {
    setSalvando(chave);
    try {
      await api.post(`/procedures/${procedureId}/consumables`, { product_id: produto.id, quantity: quantidade });
      return true;
    } catch (err: unknown) {
      showError(errMsg(err, 'Erro ao salvar o material'));
      return false;
    } finally {
      setSalvando(null);
    }
  };

  const adicionar = async () => {
    if (!escolhido) return;
    const q = parseQtd(qtdTxt);
    if (Number.isNaN(q)) {
      showError('Quantidade inválida: use um número maior que zero (até 3 casas, ex.: 0,5).');
      return;
    }
    const jaLigado = vinculos.some((v) => v.product.id === escolhido.id);
    if (await ligar(escolhido, q, 'novo')) {
      showSuccess(jaLigado ? `Quantidade de ${escolhido.name} atualizada` : `${escolhido.name} ligado ao procedimento`);
      setEscolhido(null);
      setBusca('');
      setQtdTxt('1');
      await carregar();
    }
  };

  const salvarQtd = async (v: Vinculo) => {
    const txt = rascunho[v.id];
    if (txt == null) return;
    const q = parseQtd(txt);
    if (Number.isNaN(q)) {
      showError('Quantidade inválida: use um número maior que zero (até 3 casas, ex.: 0,5).');
      return;
    }
    if (await ligar(v.product, q, v.id)) {
      setRascunho((r) => { const n = { ...r }; delete n[v.id]; return n; });
      await carregar();
    }
  };

  const desligar = async (v: Vinculo) => {
    if (!confirm(`Tirar "${v.product.name}" dos materiais de "${procedureName}"? A venda rápida deixa de baixar esse produto.`)) return;
    setSalvando(v.id);
    try {
      await api.delete(`/procedure-consumables/${v.id}`);
      await carregar();
    } catch (err: unknown) {
      showError(errMsg(err, 'Erro ao tirar o material'));
    } finally {
      setSalvando(null);
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
        <div className="flex items-start justify-between gap-3 p-4 border-b border-border">
          <div className="flex items-start gap-2 min-w-0">
            <Boxes size={18} className="text-primary mt-0.5 shrink-0" />
            <div className="min-w-0">
              <h2 className="text-base font-semibold truncate">Materiais — {procedureName}</h2>
              <p className="text-xs text-muted-foreground mt-0.5">
                Cada vez que este procedimento é vendido na Venda rápida, estes materiais saem do
                estoque. Com dentes marcados, conta uma vez por dente.
              </p>
            </div>
          </div>
          <button onClick={onClose} className="p-1 hover:bg-accent rounded shrink-0" aria-label="Fechar">
            <X size={18} />
          </button>
        </div>

        <div className="p-4 space-y-4">
          {/* Materiais ligados */}
          {carregando ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 size={14} className="animate-spin" /> Carregando…
            </div>
          ) : vinculos.length === 0 ? (
            <p className="text-sm text-muted-foreground rounded-lg border border-dashed border-border px-3 py-3">
              Nenhum material ligado: a venda rápida não baixa nada do estoque para este procedimento.
            </p>
          ) : (
            <ul className="divide-y divide-border rounded-lg border border-border">
              {vinculos.map((v) => {
                const editando = rascunho[v.id] != null;
                return (
                  <li key={v.id} className="flex items-center gap-3 px-3 py-2">
                    <Miniatura produto={v.product} />
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-medium truncate">
                        {v.product.name}
                        {v.product.brand && <span className="text-muted-foreground font-normal"> · {v.product.brand}</span>}
                      </div>
                      <div className="text-xs flex flex-wrap gap-x-2">
                        <Saldo produto={v.product} />
                        {v.product.active === false && (
                          <span className="text-amber-700 dark:text-amber-400">produto arquivado no estoque</span>
                        )}
                      </div>
                    </div>
                    <div className="flex items-center gap-1 shrink-0">
                      {podeMudar && editando ? (
                        <>
                          <input
                            value={rascunho[v.id]}
                            onChange={(e) => setRascunho((r) => ({ ...r, [v.id]: e.target.value }))}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') salvarQtd(v);
                              if (e.key === 'Escape') setRascunho((r) => { const n = { ...r }; delete n[v.id]; return n; });
                            }}
                            inputMode="decimal"
                            autoFocus
                            aria-label={`Quantidade de ${v.product.name}`}
                            className="w-16 px-2 py-1 text-right rounded bg-background border border-primary/40 text-sm"
                          />
                          <span className="text-xs text-muted-foreground">{v.product.unit}</span>
                          <button
                            onClick={() => salvarQtd(v)}
                            disabled={salvando === v.id}
                            className="text-primary hover:bg-primary/10 p-1 rounded"
                            aria-label="Salvar quantidade"
                          >
                            {salvando === v.id ? <Loader2 size={13} className="animate-spin" /> : <Save size={13} />}
                          </button>
                        </>
                      ) : (
                        <button
                          onClick={() => podeMudar && setRascunho((r) => ({ ...r, [v.id]: fmtQtd(Number(v.quantity) || 0) }))}
                          disabled={!podeMudar}
                          className="text-sm font-semibold tabular-nums px-1.5 py-0.5 rounded hover:bg-accent disabled:hover:bg-transparent"
                          title={podeMudar ? 'Clique para mudar a quantidade' : undefined}
                        >
                          {fmtQtd(Number(v.quantity) || 0)} {v.product.unit}
                        </button>
                      )}
                      {podeMudar && (
                        <button
                          onClick={() => desligar(v)}
                          disabled={salvando === v.id}
                          className="text-muted-foreground hover:text-destructive p-1 rounded"
                          aria-label={`Tirar ${v.product.name}`}
                          title="Tirar este material"
                        >
                          <Trash2 size={14} />
                        </button>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}

          {/* Adicionar */}
          {podeMudar ? (
            <div className="rounded-lg border border-border p-3 space-y-2">
              <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Adicionar material</p>
              {escolhido ? (
                <div className="flex flex-wrap items-center gap-2">
                  <div className="flex items-center gap-2 flex-1 min-w-[180px]">
                    <Miniatura produto={escolhido} size={32} />
                    <div className="min-w-0">
                      <div className="text-sm font-medium truncate">{escolhido.name}</div>
                      <div className="text-xs"><Saldo produto={escolhido} /></div>
                    </div>
                    <button
                      onClick={() => setEscolhido(null)}
                      className="p-1 text-muted-foreground hover:bg-accent rounded"
                      aria-label="Trocar produto"
                      title="Trocar produto"
                    >
                      <X size={14} />
                    </button>
                  </div>
                  <label className="flex items-center gap-1.5 text-sm">
                    <span className="text-xs text-muted-foreground">Gasta por vez</span>
                    <input
                      value={qtdTxt}
                      onChange={(e) => setQtdTxt(e.target.value)}
                      onKeyDown={(e) => { if (e.key === 'Enter') adicionar(); }}
                      inputMode="decimal"
                      autoFocus
                      className="w-16 px-2 py-1 text-right rounded bg-background border border-border text-sm"
                    />
                    <span className="text-xs text-muted-foreground">{escolhido.unit}</span>
                  </label>
                  <button
                    onClick={adicionar}
                    disabled={salvando === 'novo'}
                    className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 disabled:opacity-60"
                  >
                    {salvando === 'novo' ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />}
                    {vinculos.some((v) => v.product.id === escolhido.id) ? 'Atualizar' : 'Adicionar'}
                  </button>
                </div>
              ) : (
                <>
                  <div className="relative">
                    <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
                    <input
                      value={busca}
                      onChange={(e) => setBusca(e.target.value)}
                      placeholder="Buscar produto do estoque (nome, marca, SKU)…"
                      className="w-full pl-8 pr-3 py-2 rounded-lg bg-background border border-border text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
                    />
                  </div>
                  <ul className="max-h-56 overflow-y-auto rounded-lg border border-border divide-y divide-border">
                    {buscando && resultados.length === 0 ? (
                      <li className="px-3 py-2 text-xs text-muted-foreground flex items-center gap-2">
                        <Loader2 size={12} className="animate-spin" /> Buscando…
                      </li>
                    ) : resultados.length === 0 ? (
                      <li className="px-3 py-2 text-xs text-muted-foreground">
                        Nenhum produto encontrado. Cadastre em{' '}
                        <a href="/atendimento/estoque" className="text-primary hover:underline">Estoque → Produtos</a>.
                      </li>
                    ) : (
                      resultados.map((p) => {
                        const ligado = vinculos.some((v) => v.product.id === p.id);
                        return (
                          <li key={p.id}>
                            <button
                              onClick={() => { setEscolhido(p); setQtdTxt('1'); }}
                              className="w-full flex items-center gap-2 px-3 py-1.5 text-left hover:bg-accent"
                            >
                              <Miniatura produto={p} size={28} />
                              <span className="flex-1 min-w-0 text-sm truncate">
                                {p.name}
                                {p.brand && <span className="text-muted-foreground"> · {p.brand}</span>}
                              </span>
                              <span className="text-xs shrink-0">
                                {ligado ? <span className="text-primary font-medium">já ligado</span> : <Saldo produto={p} />}
                              </span>
                            </button>
                          </li>
                        );
                      })
                    )}
                  </ul>
                </>
              )}
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">
              Só quem gerencia o estoque pode mudar os materiais deste procedimento.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

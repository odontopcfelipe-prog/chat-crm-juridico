'use client';

import { useEffect, useMemo, useState } from 'react';
import { Tag, CheckCircle2, RefreshCw, Plus, Trash2, Search, X } from 'lucide-react';
import api from '@/lib/api';

type Mode = 'template' | 'free';
type Item = { name: string; price: string; includes: string };
type Form = { doctor: string; items: Item[] };
/** Procedimento da Tabela de Preços desta clínica (GET /procedures). */
type Proc = {
  id: string;
  name: string;
  base_price: string | number | null;
  description?: string | null;
  specialty?: { name: string } | null;
};

// Sugestão para clínica que nunca salvou: só os nomes. Os valores são de cada
// clínica (vêm da Tabela de Preços ou são digitados) — antes vinham os do Instituto.
const DEFAULT_ITEMS: Item[] = [
  { name: 'Consulta de avaliação', price: '', includes: '' },
  {
    name: 'Limpeza',
    price: '',
    includes:
      'remoção de todo o tártaro com raspagem em todos os dentes (inclusive subgengival), aplicação de flúor, polimento de todos os dentes, escovação e fio dental em cada dente',
  },
  { name: 'Manutenção de aparelho', price: '', includes: '' },
];

/** Valor da tabela no jeito do campo: 350 → "350", 1500 → "1.500", 89.9 → "89,90". Sem valor → "". */
export function precoDaTabela(v: unknown): string {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return '';
  return Number.isInteger(n)
    ? n.toLocaleString('pt-BR', { maximumFractionDigits: 0 })
    : n.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// Limites da API (PUT /settings/ai-price-table): o texto que a IA lê é CORTADO em
// 4.000 caracteres (sem aviso — sumiam os últimos itens e o "Demais tratamentos")
// e a lista do modelo pronto acima de 8.000 dá erro. A tela avisa e trava antes.
export const LIMITE_TEXTO_IA = 4000;
export const LIMITE_LISTA = 8000;

const chaveNome = (s: string) =>
  s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
const DEFAULT_FORM: Form = { doctor: '', items: DEFAULT_ITEMS };

/** Lê o form salvo (aceita o formato antigo, de 3 campos fixos). */
function normalizeForm(raw: any): Form {
  if (!raw) return DEFAULT_FORM;
  if (Array.isArray(raw.items)) {
    return {
      doctor: String(raw.doctor || ''),
      items: raw.items.map((i: any) => ({
        name: String(i?.name || ''),
        price: String(i?.price || ''),
        includes: String(i?.includes || ''),
      })),
    };
  }
  return {
    doctor: String(raw.doctor || ''),
    items: [
      { ...DEFAULT_ITEMS[0], price: String(raw.avaliacao ?? '') },
      { ...DEFAULT_ITEMS[1], price: String(raw.limpeza ?? '') },
      { ...DEFAULT_ITEMS[2], price: String(raw.manutencao ?? '') },
    ],
  };
}

const money = (v: string) => {
  const n = v.replace(/[^\d,.]/g, '').trim();
  return n ? `R$ ${n}` : '';
};

/**
 * Texto padrão de orientação de valores — revisado a partir da explicação da
 * recepção. Só muda o nome de quem avalia e os valores; linha com valor vazio some.
 */
export function buildPriceGuide(f: Form): string {
  const doctor = f.doctor.trim() || 'a doutora';
  const lines = f.items
    .filter((i) => i.name.trim() && money(i.price))
    .map((i) => `• ${i.name.trim()}: ${money(i.price)}${i.includes.trim() ? ` (${i.includes.trim()})` : ''}`);
  return [
    lines.length ? `Valores que podemos informar:\n${lines.join('\n')}` : 'Nenhum valor pode ser informado antes da consulta.',
    '',
    'Demais tratamentos: o valor só é passado depois da consulta completa de avaliação, porque cada plano de tratamento é feito sob medida. Na consulta fazemos:',
    '1. Anamnese: uma conversa sobre a sua saúde e o seu histórico;',
    '2. Fotografias da face e do sorriso;',
    '3. Escaneamento intraoral: o mapeamento digital dos seus dentes;',
    `4. Avaliação com ${doctor}, que analisa tudo e ouve você para entender a sua queixa e o que você deseja.`,
    'Com isso montamos o seu plano de tratamento com o que é realmente indicado para você.',
  ].join('\n');
}

/**
 * Orientação de valores da Sophia — por clínica. "Modelo pronto" (só troca nome e
 * valores) ou texto livre, + chave pra liberar ou não a IA a passar valores.
 */
/** onStatus(true) = há orientação de valores salva (a etapa "Valores" está concluída). */
export function AiPriceTableCard({ onStatus }: { onStatus?: (saved: boolean) => void } = {}) {
  const [mode, setMode] = useState<Mode>('template');
  const [form, setForm] = useState<Form>(DEFAULT_FORM);
  const [freeText, setFreeText] = useState('');
  const [enabled, setEnabled] = useState(true);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  // Nada salvo ainda pra esta clínica: os campos mostram só a SUGESTÃO e a Sophia
  // não informa valor nenhum — avisa claramente pra não parecer que já vale.
  const [neverSaved, setNeverSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Tabela de Preços da clínica: o "Adicionar procedimento" escolhe dela em vez de
  // criar item do zero. null = carregando.
  const [procs, setProcs] = useState<Proc[] | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [busca, setBusca] = useState('');

  useEffect(() => {
    api.get('/procedures')
      .then((r) => setProcs(Array.isArray(r.data) ? r.data : []))
      .catch(() => setProcs([]));
  }, []);

  useEffect(() => {
    api.get('/settings/ai-price-table')
      .then((r) => {
        const d = r.data || {};
        setEnabled(d.enabled !== false);
        setNeverSaved(!String(d.value || '').trim());
        onStatus?.(!!String(d.value || '').trim());
        if (d.form?.mode === 'free' || (!d.form && d.value)) {
          setMode('free');
          setFreeText(d.value || '');
        } else if (d.form) {
          setForm(normalizeForm(d.form));
        }
      })
      .catch(() => setError('Não consegui carregar a orientação de valores.'))
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Clínica que nunca salvou: a sugestão (só nomes) pega o valor da Tabela de Preços
  // quando o nome bate — senão o item da tabela some do seletor (já está na lista) e o
  // valor dele ficava de fora. Uma vez só; o que já foi salvo nunca é mexido.
  const [sugestaoPreenchida, setSugestaoPreenchida] = useState(false);
  useEffect(() => {
    if (sugestaoPreenchida || loading || !neverSaved || mode !== 'template' || !procs?.length) return;
    setSugestaoPreenchida(true);
    const porNome = new Map(procs.map((p) => [chaveNome(p.name), p]));
    setForm((f) => ({
      ...f,
      items: f.items.map((it) => {
        const p = porNome.get(chaveNome(it.name));
        return p && !it.price.trim() ? { ...it, price: precoDaTabela(p.base_price) } : it;
      }),
    }));
  }, [sugestaoPreenchida, loading, neverSaved, mode, procs]);

  const preview = useMemo(() => buildPriceGuide(form), [form]);
  const finalText = mode === 'template' ? preview : freeText;
  const tamanhoLista = mode === 'template' ? JSON.stringify({ mode, ...form }).length : 0;
  const grandeDemais = finalText.length > LIMITE_TEXTO_IA || tamanhoLista > LIMITE_LISTA;

  const save = async () => {
    if (grandeDemais) return;
    setSaving(true);
    setError(null);
    try {
      await api.put('/settings/ai-price-table', {
        value: finalText,
        enabled,
        form: mode === 'template' ? { mode, ...form } : { mode },
      });
      setSaved(true);
      setNeverSaved(!finalText.trim());
      onStatus?.(!!finalText.trim());
      setTimeout(() => setSaved(false), 2500);
    } catch (e: any) {
      setError(e?.response?.data?.message || 'Não consegui salvar.');
    } finally {
      setSaving(false);
    }
  };

  const setItem = (idx: number, patch: Partial<Item>) =>
    setForm((f) => ({ ...f, items: f.items.map((it, i) => (i === idx ? { ...it, ...patch } : it)) }));
  const addItem = () => setForm((f) => ({ ...f, items: [...f.items, { name: '', price: '', includes: '' }] }));
  const addFromTable = (p: Proc) =>
    setForm((f) => ({
      ...f,
      items: [
        ...f.items,
        {
          name: p.name.trim(),
          price: precoDaTabela(p.base_price),
          includes: String(p.description || '').replace(/\s+/g, ' ').trim().slice(0, 300),
        },
      ],
    }));
  const removeItem = (idx: number) => setForm((f) => ({ ...f, items: f.items.filter((_, i) => i !== idx) }));

  // Procedimentos da tabela que ainda não estão na lista, filtrados pela busca.
  const naLista = useMemo(() => new Set(form.items.map((i) => chaveNome(i.name))), [form.items]);
  const opcoes = useMemo(() => {
    const q = chaveNome(busca);
    return (procs || []).filter(
      (p) =>
        !naLista.has(chaveNome(p.name)) &&
        (!q || chaveNome(p.name).includes(q) || chaveNome(p.specialty?.name || '').includes(q)),
    );
  }, [procs, naLista, busca]);
  const inputCls =
    'w-full rounded-xl border border-border bg-background px-3 py-2 text-sm text-foreground outline-none focus:border-primary/60';

  return (
    <div className="bg-card rounded-2xl border border-border shadow-sm overflow-hidden">
      <div className="p-4 border-b border-border flex flex-wrap items-center justify-between gap-3 bg-primary/5">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-full bg-primary/10 text-primary flex items-center justify-center shrink-0">
            <Tag size={16} />
          </div>
          <div>
            <h4 className="text-sm font-bold text-foreground">Valores: o que a IA pode falar</h4>
            <p className="text-[11px] text-muted-foreground mt-0.5 max-w-xl">
              Só desta clínica. A Sophia explica o que está incluso antes do valor, uma vez só, e usa o resto pra explicar a consulta.
            </p>
          </div>
        </div>
        <label className="flex items-center gap-2 cursor-pointer select-none">
          <span className="text-xs font-semibold text-foreground">{enabled ? 'Pode passar valores' : 'Não passar valores'}</span>
          <button
            type="button"
            role="switch"
            aria-checked={enabled}
            onClick={() => setEnabled((v) => !v)}
            className={`relative w-11 h-6 rounded-full transition-colors ${enabled ? 'bg-primary' : 'bg-muted-foreground/30'}`}
          >
            <span className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white shadow transition-transform ${enabled ? 'translate-x-5' : ''}`} />
          </button>
        </label>
      </div>

      <div className="p-5 space-y-4">
        {loading ? (
          <div className="flex justify-center py-4"><RefreshCw className="animate-spin text-muted-foreground" size={18} /></div>
        ) : (
          <>
            {neverSaved && (
              <p className="text-xs font-semibold rounded-lg bg-red-500/10 text-red-600 dark:text-red-400 px-3 py-2">
                Ainda não está valendo: isto é só a sugestão. Confira e clique em Salvar. Até lá a Sophia não informa nenhum valor.
              </p>
            )}
            {!enabled && (
              <p className="text-xs rounded-lg bg-amber-500/10 text-amber-700 dark:text-amber-400 px-3 py-2">
                Desligado: a Sophia não informa nenhum valor. Diz que depende da avaliação e convida pra consulta. O texto fica guardado.
              </p>
            )}

            <div className="inline-flex rounded-xl border border-border p-0.5 text-xs font-semibold">
              {([['template', 'Modelo pronto'], ['free', 'Escrever do meu jeito']] as const).map(([m, label]) => (
                <button
                  key={m}
                  type="button"
                  onClick={() => {
                    if (m === 'free' && !freeText.trim()) setFreeText(preview);
                    setMode(m);
                  }}
                  className={`px-3 py-1.5 rounded-lg transition-colors ${mode === m ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground'}`}
                >
                  {label}
                </button>
              ))}
            </div>

            {mode === 'template' ? (
              <>
                <label className="flex flex-col gap-1 max-w-sm">
                  <span className="text-[11px] font-semibold text-muted-foreground">Quem faz a avaliação</span>
                  <input
                    value={form.doctor}
                    onChange={(e) => setForm((f) => ({ ...f, doctor: e.target.value }))}
                    placeholder="Ex.: a Dra. Ana"
                    className={inputCls}
                  />
                </label>

                <div className="space-y-2">
                  <div className="hidden sm:grid grid-cols-[1.2fr_120px_2fr_36px] gap-2 px-1 text-[11px] font-semibold text-muted-foreground">
                    <span>Procedimento</span>
                    <span>Valor</span>
                    <span>O que está incluso (opcional)</span>
                    <span />
                  </div>
                  {form.items.map((it, idx) => (
                    <div key={idx} className="grid grid-cols-1 sm:grid-cols-[1.2fr_120px_2fr_36px] gap-2 items-center">
                      <input
                        value={it.name}
                        onChange={(e) => setItem(idx, { name: e.target.value })}
                        placeholder="Ex.: Clareamento"
                        className={inputCls}
                      />
                      <div className="flex items-center rounded-xl border border-border bg-background focus-within:border-primary/60">
                        <span className="pl-3 text-sm text-muted-foreground">R$</span>
                        <input
                          value={it.price}
                          onChange={(e) => setItem(idx, { price: e.target.value })}
                          placeholder="0"
                          className="w-full bg-transparent px-2 py-2 text-sm text-foreground outline-none"
                        />
                      </div>
                      <input
                        value={it.includes}
                        onChange={(e) => setItem(idx, { includes: e.target.value })}
                        placeholder="Ex.: polimento, flúor e remoção de tártaro"
                        className={inputCls}
                      />
                      <button
                        type="button"
                        onClick={() => removeItem(idx)}
                        aria-label="Remover procedimento"
                        className="h-9 w-9 flex items-center justify-center rounded-lg text-muted-foreground hover:text-red-500 hover:bg-red-500/10"
                      >
                        <Trash2 size={15} />
                      </button>
                    </div>
                  ))}
                  {!pickerOpen ? (
                    <button
                      type="button"
                      onClick={() => {
                        setBusca('');
                        setPickerOpen(true);
                      }}
                      className="text-xs font-semibold text-primary hover:underline flex items-center gap-1"
                    >
                      <Plus size={13} /> Adicionar procedimento
                    </button>
                  ) : (
                    <div className="rounded-xl border border-primary/30 bg-background p-3 space-y-2">
                      <div className="flex items-center justify-between gap-2">
                        <p className="text-xs font-semibold text-foreground">Escolha da Tabela de Preços</p>
                        <button
                          type="button"
                          onClick={() => setPickerOpen(false)}
                          aria-label="Fechar"
                          className="h-7 w-7 flex items-center justify-center rounded-lg text-muted-foreground hover:text-foreground hover:bg-muted"
                        >
                          <X size={14} />
                        </button>
                      </div>
                      <div className="flex items-center gap-2 rounded-xl border border-border bg-background px-3 focus-within:border-primary/60">
                        <Search size={14} className="text-muted-foreground shrink-0" />
                        <input
                          autoFocus
                          value={busca}
                          onChange={(e) => setBusca(e.target.value)}
                          placeholder="Buscar procedimento ou especialidade"
                          className="w-full bg-transparent py-2 text-sm text-foreground outline-none"
                        />
                      </div>
                      {procs === null ? (
                        <p className="text-xs text-muted-foreground py-2 flex items-center gap-2">
                          <RefreshCw size={13} className="animate-spin" /> Carregando a tabela...
                        </p>
                      ) : procs.length === 0 ? (
                        <p className="text-xs text-muted-foreground py-2">
                          A Tabela de Preços desta clínica está vazia.{' '}
                          <a href="/atendimento/settings/procedures" className="text-primary underline">
                            Cadastrar procedimentos
                          </a>
                        </p>
                      ) : opcoes.length === 0 ? (
                        <p className="text-xs text-muted-foreground py-2">
                          {busca.trim() ? 'Nenhum procedimento com esse nome na tabela.' : 'Todos os procedimentos da tabela já estão na lista.'}
                        </p>
                      ) : (
                        <ul className="max-h-64 overflow-y-auto divide-y divide-border rounded-lg border border-border">
                          {opcoes.map((p) => {
                            const preco = precoDaTabela(p.base_price);
                            return (
                              <li key={p.id}>
                                <button
                                  type="button"
                                  onClick={() => addFromTable(p)}
                                  className="w-full flex items-center justify-between gap-3 px-3 py-2 text-left hover:bg-primary/5"
                                >
                                  <span className="min-w-0">
                                    <span className="block text-sm text-foreground truncate">{p.name}</span>
                                    {p.specialty?.name && (
                                      <span className="block text-[11px] text-muted-foreground truncate">{p.specialty.name}</span>
                                    )}
                                  </span>
                                  <span className={`shrink-0 text-xs font-semibold ${preco ? 'text-foreground' : 'text-muted-foreground'}`}>
                                    {preco ? `R$ ${preco}` : 'sem valor'}
                                  </span>
                                </button>
                              </li>
                            );
                          })}
                        </ul>
                      )}
                      <button
                        type="button"
                        onClick={() => {
                          addItem();
                          setPickerOpen(false);
                        }}
                        className="text-[11px] font-semibold text-muted-foreground hover:text-primary hover:underline"
                      >
                        Não está na tabela? Escrever um item à mão
                      </button>
                    </div>
                  )}
                </div>
                <p className="text-[11px] text-muted-foreground">
                  Quando o paciente pergunta, a IA informa o valor dos procedimentos desta lista (de qualquer especialidade).
                  O que não está aqui ela explica e deixa o valor pra depois da consulta. Item sem valor não é informado.
                </p>
                <div>
                  <p className="text-[11px] font-semibold text-muted-foreground mb-1">O que a Sophia vai seguir:</p>
                  <pre className={`whitespace-pre-wrap rounded-xl border border-border bg-muted/30 px-3 py-2.5 text-sm text-foreground font-sans ${!enabled ? 'opacity-60' : ''}`}>
                    {preview}
                  </pre>
                </div>
              </>
            ) : (
              <textarea
                value={freeText}
                onChange={(e) => setFreeText(e.target.value)}
                rows={10}
                placeholder="Escreva como explicaria pra uma recepcionista nova: quais valores pode passar e como explicar o resto."
                className={`w-full rounded-xl border border-border bg-background px-3 py-2.5 text-sm text-foreground outline-none focus:border-primary/60 resize-y ${!enabled ? 'opacity-60' : ''}`}
              />
            )}

            {grandeDemais ? (
              <p className="text-xs font-semibold rounded-lg bg-red-500/10 text-red-600 dark:text-red-400 px-3 py-2">
                Grande demais para a IA ({finalText.length.toLocaleString('pt-BR')} de {LIMITE_TEXTO_IA.toLocaleString('pt-BR')} caracteres).
                {mode === 'template'
                  ? 'Encurte os textos de "o que está incluso" ou tire alguns itens.'
                  : 'Encurte o texto.'}{' '}
                Acima disso o fim não chegaria à IA.
              </p>
            ) : finalText.length > LIMITE_TEXTO_IA * 0.8 ? (
              <p className="text-[11px] text-amber-700 dark:text-amber-400">
                {finalText.length.toLocaleString('pt-BR')} de {LIMITE_TEXTO_IA.toLocaleString('pt-BR')} caracteres: perto do limite que a IA lê.
              </p>
            ) : null}
            {error && <p className="text-xs text-red-500">{error}</p>}
            <div className="flex justify-end">
              <button
                type="button"
                onClick={save}
                disabled={saving || grandeDemais}
                className="px-4 py-2 rounded-xl bg-primary text-primary-foreground text-sm font-bold hover:opacity-90 disabled:opacity-50 flex items-center gap-2"
              >
                {saved ? <><CheckCircle2 size={15} /> Salvo</> : saving ? 'Salvando...' : 'Salvar'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

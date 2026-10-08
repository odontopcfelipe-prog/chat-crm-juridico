'use client';

import { useEffect, useMemo, useState } from 'react';
import { Tag, CheckCircle2, RefreshCw, Plus, Trash2 } from 'lucide-react';
import api from '@/lib/api';

type Mode = 'template' | 'free';
type Item = { name: string; price: string; includes: string };
type Form = { doctor: string; items: Item[] };

const DEFAULT_ITEMS: Item[] = [
  { name: 'Consulta de avaliação', price: '150', includes: '' },
  { name: 'Limpeza', price: '350', includes: 'remoção de tártaro, polimento e aplicação de flúor' },
  { name: 'Manutenção de aparelho', price: '150', includes: '' },
];
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
export function AiPriceTableCard() {
  const [mode, setMode] = useState<Mode>('template');
  const [form, setForm] = useState<Form>(DEFAULT_FORM);
  const [freeText, setFreeText] = useState('');
  const [enabled, setEnabled] = useState(true);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.get('/settings/ai-price-table')
      .then((r) => {
        const d = r.data || {};
        setEnabled(d.enabled !== false);
        if (d.form?.mode === 'free' || (!d.form && d.value)) {
          setMode('free');
          setFreeText(d.value || '');
        } else if (d.form) {
          setForm(normalizeForm(d.form));
        }
      })
      .catch(() => setError('Não consegui carregar a orientação de valores.'))
      .finally(() => setLoading(false));
  }, []);

  const preview = useMemo(() => buildPriceGuide(form), [form]);
  const finalText = mode === 'template' ? preview : freeText;

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      await api.put('/settings/ai-price-table', {
        value: finalText,
        enabled,
        form: mode === 'template' ? { mode, ...form } : { mode },
      });
      setSaved(true);
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
  const removeItem = (idx: number) => setForm((f) => ({ ...f, items: f.items.filter((_, i) => i !== idx) }));
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
                    placeholder="Ex.: a Dra. Suellen"
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
                  <button
                    type="button"
                    onClick={addItem}
                    className="text-xs font-semibold text-primary hover:underline flex items-center gap-1"
                  >
                    <Plus size={13} /> Adicionar procedimento
                  </button>
                </div>
                <p className="text-[11px] text-muted-foreground">
                  Só os procedimentos desta lista têm valor informado. Os especialistas (implante, ortodontia, lentes…)
                  explicam o tratamento, mas o valor fica pra depois da consulta. Item sem valor não é informado.
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

            {error && <p className="text-xs text-red-500">{error}</p>}
            <div className="flex justify-end">
              <button
                type="button"
                onClick={save}
                disabled={saving}
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

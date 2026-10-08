'use client';

import { useEffect, useState } from 'react';
import { Tag, CheckCircle2, RefreshCw } from 'lucide-react';
import api from '@/lib/api';

const EXAMPLE = `Valores que podemos passar:
- Avaliação: R$ 150.
- Limpeza: R$ 350 (remoção de tártaro, polimento e aplicação de flúor).
- Manutenção de aparelho: R$ 150.

Os demais valores só conseguimos passar após a consulta completa, onde fazemos: anamnese (sua história de saúde), fotografias da face e do sorriso, escaneamento intraoral (o mapeamento dos dentes) e, por último, a doutora avalia tudo e te ouve para entender sua dor e sua necessidade. Assim montamos o seu plano de tratamento com o que for indicado para você.`;

/**
 * Orientação de valores da Sophia — por clínica. Texto livre (como você explicaria
 * pra uma recepcionista nova) + chave pra liberar ou não a IA a passar valores.
 * Desligada: a IA não fala preço de nada, mas o texto fica guardado.
 */
export function AiPriceTableCard() {
  const [value, setValue] = useState('');
  const [enabled, setEnabled] = useState(true);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.get('/settings/ai-price-table')
      .then((r) => {
        setValue(r.data?.value || '');
        setEnabled(r.data?.enabled !== false);
      })
      .catch(() => setError('Não consegui carregar a orientação de valores.'))
      .finally(() => setLoading(false));
  }, []);

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      await api.put('/settings/ai-price-table', { value, enabled });
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
    } catch (e: any) {
      setError(e?.response?.data?.message || 'Não consegui salvar.');
    } finally {
      setSaving(false);
    }
  };

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
              Escreva como explicaria pra uma recepcionista nova: quais valores pode passar e como explicar o resto.
              Só desta clínica. A Sophia diz o que está incluso antes do valor, uma vez só.
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
      <div className="p-5 space-y-3">
        {loading ? (
          <div className="flex justify-center py-4"><RefreshCw className="animate-spin text-muted-foreground" size={18} /></div>
        ) : (
          <>
            {!enabled && (
              <p className="text-xs rounded-lg bg-amber-500/10 text-amber-700 dark:text-amber-400 px-3 py-2">
                Desligado: a Sophia não informa nenhum valor. Diz que depende da avaliação e convida pra consulta. O texto abaixo fica guardado.
              </p>
            )}
            <textarea
              value={value}
              onChange={(e) => setValue(e.target.value)}
              placeholder={EXAMPLE}
              rows={9}
              className={`w-full rounded-xl border border-border bg-background px-3 py-2.5 text-sm text-foreground outline-none focus:border-primary/60 resize-y ${!enabled ? 'opacity-60' : ''}`}
            />
            {!value.trim() && (
              <button
                type="button"
                onClick={() => setValue(EXAMPLE)}
                className="text-xs font-semibold text-primary hover:underline"
              >
                Usar este modelo (avaliação 150, limpeza 350, manutenção 150 + explicação da consulta)
              </button>
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

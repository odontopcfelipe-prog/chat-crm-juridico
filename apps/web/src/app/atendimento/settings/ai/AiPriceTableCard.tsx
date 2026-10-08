'use client';

import { useEffect, useState } from 'react';
import { Tag, CheckCircle2, RefreshCw } from 'lucide-react';
import api from '@/lib/api';

const EXAMPLE = `Consulta de avaliação — R$ 150: avaliação completa com a doutora, que examina o sorriso e explica o tratamento.
Manutenção de aparelho — R$ 150.
Limpeza — R$ 350: polimento, aplicação de flúor e remoção de tártaro. Em até 3x sem juros.`;

/**
 * Valores que a Sophia pode informar no WhatsApp — por clínica. A IA sempre diz o
 * conceito antes do valor, uma vez só; o que não estiver aqui ela não precifica.
 */
export function AiPriceTableCard() {
  const [value, setValue] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.get('/settings/ai-price-table')
      .then((r) => setValue(r.data?.value || ''))
      .catch(() => setError('Não consegui carregar os valores.'))
      .finally(() => setLoading(false));
  }, []);

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      await api.put('/settings/ai-price-table', { value });
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
      <div className="p-4 border-b border-border flex items-center gap-3 bg-primary/5">
        <div className="w-8 h-8 rounded-full bg-primary/10 text-primary flex items-center justify-center shrink-0">
          <Tag size={16} />
        </div>
        <div>
          <h4 className="text-sm font-bold text-foreground">Valores que a IA pode falar</h4>
          <p className="text-[11px] text-muted-foreground mt-0.5 max-w-xl">
            Só desta clínica. Um item por linha, com o que está incluso. A Sophia explica o conceito antes do valor, uma vez só.
            O que não estiver aqui ela não informa: diz que depende da avaliação.
          </p>
        </div>
      </div>
      <div className="p-5 space-y-3">
        {loading ? (
          <div className="flex justify-center py-4"><RefreshCw className="animate-spin text-muted-foreground" size={18} /></div>
        ) : (
          <>
            <textarea
              value={value}
              onChange={(e) => setValue(e.target.value)}
              placeholder={EXAMPLE}
              rows={5}
              className="w-full rounded-xl border border-border bg-background px-3 py-2.5 text-sm text-foreground outline-none focus:border-primary/60 resize-y"
            />
            {!value.trim() && (
              <button
                type="button"
                onClick={() => setValue(EXAMPLE)}
                className="text-xs font-semibold text-primary hover:underline"
              >
                Usar o exemplo (consulta 150, manutenção 150, limpeza 350)
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
                {saved ? <><CheckCircle2 size={15} /> Salvo</> : saving ? 'Salvando...' : 'Salvar valores'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

'use client';

// Vários números de aviso (cada um com o "55" fixo — Phone55Input). Usado nos avisos
// internos aos ADMs (Venda feita / Resumo diário / Novo agendamento / Triagem): o aviso
// sai pra TODOS os números da lista. Salvo como "5582…, 5582…" (phone55.joinPhones55).
import { Plus, X } from 'lucide-react';
import { Phone55Input } from './Phone55Input';

const MAX_NUMEROS = 5;

export function Phones55ListInput({
  locais,
  onChange,
}: {
  locais: string[];
  onChange: (v: string[]) => void;
}) {
  const lista = locais.length ? locais : [''];
  const set = (i: number, v: string) => onChange(lista.map((x, j) => (j === i ? v : x)));
  const remove = (i: number) => {
    const next = lista.filter((_, j) => j !== i);
    onChange(next.length ? next : ['']);
  };
  return (
    <div className="space-y-2">
      {lista.map((local, i) => (
        <div key={i} className="flex items-center gap-2">
          <div className="flex-1 min-w-0">
            <Phone55Input local={local} onLocal={(v) => set(i, v)} />
          </div>
          {lista.length > 1 && (
            <button
              type="button"
              onClick={() => remove(i)}
              title="Remover este número"
              aria-label="Remover este número"
              className="mt-1 p-2 rounded-lg border border-border text-muted-foreground hover:text-red-500 hover:border-red-500/40"
            >
              <X size={14} />
            </button>
          )}
        </div>
      ))}
      {lista.length < MAX_NUMEROS && (
        <button
          type="button"
          onClick={() => onChange([...lista, ''])}
          className="text-[12px] font-medium text-primary inline-flex items-center gap-1 hover:underline"
        >
          <Plus size={13} /> Adicionar outro número
        </button>
      )}
    </div>
  );
}

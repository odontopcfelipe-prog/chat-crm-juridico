'use client';

// Campo de telefone com o "55" (código do país) FIXO à esquerda — a pessoa digita
// só DDD + número, e o 55 nunca some (não dá pra apagar). O strip/join do valor
// salvo fica no phone55.ts. Aceita só dígitos. UM número por campo (vários números:
// Phones55ListInput, "Adicionar outro número").
import { stripCountry55 } from './phone55';

export function Phone55Input({
  local,
  onLocal,
  placeholder = '82999998888',
}: {
  local: string;
  onLocal: (v: string) => void;
  placeholder?: string;
}) {
  const digitos = (local || '').replace(/\D/g, '').length;
  // DDD + número = 10 (fixo) ou 11 (celular) dígitos. Fora disso o aviso não entrega —
  // avisa já no campo (a API também recusa ao salvar).
  const invalido = digitos > 0 && digitos !== 10 && digitos !== 11;
  return (
    <div>
      <div
        className={`mt-1 flex items-stretch rounded-lg border bg-card overflow-hidden focus-within:ring-2 focus-within:ring-primary/30 ${
          invalido ? 'border-red-500/60' : 'border-border'
        }`}
      >
        <span className="flex items-center px-3 text-sm font-medium text-muted-foreground bg-muted/40 border-r border-border select-none">
          🇧🇷&nbsp;55
        </span>
        <input
          value={local}
          onChange={(e) => {
            const d = e.target.value.replace(/\D/g, '');
            // Colou o número inteiro com o 55 (ex.: 5582999998888)? O 55 já é fixo: tira.
            onLocal(d.length >= 12 && d.startsWith('55') ? stripCountry55(d) : d);
          }}
          placeholder={placeholder}
          inputMode="numeric"
          aria-invalid={invalido || undefined}
          className="flex-1 min-w-0 px-3 py-2 bg-transparent text-sm outline-none"
        />
      </div>
      {invalido && (
        <p className="mt-1 text-[11px] text-red-500">
          Um número por campo: DDD + número (10 ou 11 dígitos). Pra mais de um, use &quot;Adicionar outro número&quot;.
        </p>
      )}
    </div>
  );
}

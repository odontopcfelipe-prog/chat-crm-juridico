'use client';

// Campo de telefone com o "55" (código do país) FIXO à esquerda — a pessoa digita
// só DDD + número, e o 55 nunca some (não dá pra apagar). O strip/join do valor
// salvo fica no phone55.ts. Aceita só dígitos.
export function Phone55Input({
  local,
  onLocal,
  placeholder = '82999998888',
}: {
  local: string;
  onLocal: (v: string) => void;
  placeholder?: string;
}) {
  return (
    <div className="mt-1 flex items-stretch rounded-lg border border-border bg-card overflow-hidden focus-within:ring-2 focus-within:ring-primary/30">
      <span className="flex items-center px-3 text-sm font-medium text-muted-foreground bg-muted/40 border-r border-border select-none">
        🇧🇷&nbsp;55
      </span>
      <input
        value={local}
        onChange={(e) => onLocal(e.target.value.replace(/\D/g, ''))}
        placeholder={placeholder}
        inputMode="numeric"
        className="flex-1 min-w-0 px-3 py-2 bg-transparent text-sm outline-none"
      />
    </div>
  );
}

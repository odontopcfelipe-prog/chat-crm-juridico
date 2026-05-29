import React from 'react';

/**
 * Ícone de dente em SVG inline (o lucide-react não tem "tooth" nativo).
 */
function ToothIcon({ className = '' }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className} aria-hidden="true">
      <path d="M12 2C8.5 2 6 4 6 7.5c0 1.8.4 3 .8 4.8.3 1.3.4 2.7.6 4 .3 1.8.6 3.7 1.6 3.7.8 0 1-1.2 1.2-2.5.2-1.3.4-2.5 1.8-2.5s1.6 1.2 1.8 2.5c.2 1.3.4 2.5 1.2 2.5 1 0 1.3-1.9 1.6-3.7.2-1.3.3-2.7.6-4 .4-1.8.8-3 .8-4.8C18 4 15.5 2 12 2z" />
    </svg>
  );
}

type Size = 'sm' | 'md' | 'lg';

const CFG: Record<Size, { box: string; icon: string; odonto: string; system: string }> = {
  sm: { box: 'h-9 w-9 rounded-lg', icon: 'h-5 w-5', odonto: 'text-base', system: 'text-[8px] tracking-[0.3em]' },
  md: { box: 'h-12 w-12 rounded-xl', icon: 'h-7 w-7', odonto: 'text-xl', system: 'text-[10px] tracking-[0.35em]' },
  lg: { box: 'h-16 w-16 rounded-2xl', icon: 'h-9 w-9', odonto: 'text-3xl', system: 'text-sm tracking-[0.4em]' },
};

/**
 * Logo "ODONTO SYSTEM" — caixa com gradiente azul→roxo + dente + texto.
 * Substitui o logo em imagem (era do escritório jurídico). Provisório:
 * trocar pelo PNG oficial quando disponível.
 */
export function OdontoLogo({ size = 'md', className = '' }: { size?: Size; className?: string }) {
  const cfg = CFG[size];
  return (
    <div className={`flex items-center gap-2.5 ${className}`}>
      <div
        className={`flex items-center justify-center ${cfg.box} bg-linear-to-br from-cyan-400 via-blue-500 to-purple-600 shadow-[0_4px_14px_rgba(59,130,246,0.45)] shrink-0`}
      >
        <ToothIcon className={`${cfg.icon} text-white`} />
      </div>
      <div className="flex flex-col leading-none">
        <span className={`text-[#FAFAFA] font-extrabold ${cfg.odonto} tracking-tight`}>ODONTO</span>
        <span className={`text-slate-400 font-semibold ${cfg.system} mt-1`}>SYSTEM</span>
      </div>
    </div>
  );
}

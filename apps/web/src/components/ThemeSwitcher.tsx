'use client';

import { useTheme } from 'next-themes';
import { useEffect, useState } from 'react';
import { Palette } from 'lucide-react';

/**
 * Temas disponiveis. id = chave persistida em localStorage (NAO renomear,
 * quebraria preferencias salvas dos users). name = label exibido no menu.
 *
 * Onda 5e v4: nomes realinhados com cor real do accent_primary +
 * 2 temas novos (Esmeralda + Vermelho).
 *
 * Existentes (renomeados pra ficar coerentes):
 *   escuro -> "Noturno" (preto + dourado)
 *   claro  -> "Claro" (branco + sepia)
 *   odonto -> "Laranja" (Clinicorp #F58220)
 *   azul   -> "Azul" (azul Royal #2952a3)
 *   verde  -> "Floresta" (verde escuro tradicional #1a7a4a)
 *   rose   -> "Rosé" (rosa pastel #c4254a)
 *
 * Novos:
 *   mint     -> "Esmeralda" (verde claro vibrante #10b981)
 *   vermelho -> "Vermelho" (red bold #dc2626)
 */
export const THEMES = [
  { id: 'escuro',   name: 'Noturno',   color: '#000000', accent: '#a1773d', dark: true  },
  { id: 'claro',    name: 'Claro',     color: '#ffffff', accent: '#8b6630', dark: false },
  { id: 'odonto',   name: 'Laranja',   color: '#ffffff', accent: '#f58220', dark: false },
  { id: 'rose',     name: 'Rosé',      color: '#fdf2f3', accent: '#c4254a', dark: false },
  { id: 'vermelho', name: 'Vermelho',  color: '#fef2f2', accent: '#dc2626', dark: false },
  { id: 'azul',     name: 'Azul',      color: '#f0f4fa', accent: '#2952a3', dark: false },
  { id: 'verde',    name: 'Floresta',  color: '#f0faf5', accent: '#1a7a4a', dark: false },
  { id: 'mint',     name: 'Esmeralda', color: '#f0fdf4', accent: '#10b981', dark: false },
];

export function ThemeSwitcher() {
  const [mounted, setMounted] = useState(false);
  const { theme, setTheme } = useTheme();

  useEffect(() => {
    setMounted(true);
  }, []);

  if (!mounted) return null;

  return (
    <div className="flex flex-col space-y-3 mt-6 p-4 bg-muted/50 rounded-xl border border-border">
      <div className="flex items-center text-sm font-semibold text-muted-foreground mb-2">
        <Palette className="w-4 h-4 mr-2" />
        Aparência
      </div>
      <div className="flex flex-wrap gap-2">
        {THEMES.map((t) => {
          const isActive = theme === t.id;
          return (
            <button
              key={t.id}
              onClick={() => setTheme(t.id)}
              className={`relative flex items-center gap-2 px-3 py-1.5 rounded-full text-[11px] font-bold transition-all border
                ${isActive
                  ? 'ring-2 ring-offset-1 ring-offset-background opacity-100 border-transparent shadow-sm'
                  : 'border-border opacity-70 hover:opacity-100'
                }
              `}
              style={{
                backgroundColor: t.color,
                color: t.dark ? '#fff' : '#111',
                ['--tw-ring-color' as string]: t.accent,
              }}
              title={t.name}
            >
              <span
                className="w-2.5 h-2.5 rounded-full shrink-0"
                style={{ backgroundColor: t.accent }}
              />
              {t.name}
            </button>
          );
        })}
      </div>
    </div>
  );
}

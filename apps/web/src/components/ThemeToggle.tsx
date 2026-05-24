'use client';
import { useTheme } from 'next-themes';
import { Sun, Moon } from 'lucide-react';
import { useEffect, useState } from 'react';

/**
 * Onda 15 — Toggle rapido entre o tema dark padrao (noturno) e o tema
 * light padrao (glacier). Pra trocar pros outros 2 temas (cyber/coral)
 * o usuario usa o <ThemeSwitcher /> completo na sidebar/menu.
 */
const DARK_THEMES = new Set(['noturno', 'cyber']);

export function ThemeToggle() {
  const { theme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  if (!mounted) return null;

  const isDark = DARK_THEMES.has(theme ?? '');

  return (
    <button
      onClick={() => setTheme(isDark ? 'glacier' : 'noturno')}
      className="p-2 rounded-lg text-muted-foreground hover:text-foreground hover:bg-[var(--glass-bg)] backdrop-blur-md transition-all hover:shadow-[0_0_10px_rgba(var(--accent-glow),0.35)]"
      title={isDark ? 'Modo claro' : 'Modo escuro'}
      aria-label="Alternar tema"
    >
      {isDark ? <Sun size={16} /> : <Moon size={16} />}
    </button>
  );
}

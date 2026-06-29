'use client';

import { useTheme } from 'next-themes';
import { useEffect, useState } from 'react';
import { Palette, Sparkles, Square, CircleDashed } from 'lucide-react';
import { useVisualMode } from '@/components/VisualModeProvider';

/**
 * Onda 15 — 4 temas futuristas (2 dark + 2 light).
 * Cada tema tem:
 *   id        — chave persistida em localStorage (NAO renomear sem migração)
 *   name      — label exibido
 *   gradient  — preview do fundo do tema (CSS background-image válido)
 *   accent    — preview do accent (CSS background-image válido, gradient diagonal)
 *   solidBg   — cor primária chapada (fallback p/ legado que usa backgroundColor)
 *   dark      — se texto sobre o preview deve ser branco
 *
 * Temas removidos nesta refatoração: claro, odonto, rose, vermelho, azul,
 * verde, mint. Quem tinha um desses salvo no localStorage cai no default
 * (noturno) automaticamente porque providers.tsx só lista os 4 novos.
 */
export const THEMES = [
  {
    id: 'noturno',
    name: 'Noturno Gold',
    gradient: 'radial-gradient(ellipse at top, #1a1208 0%, #000000 65%)',
    accent: 'linear-gradient(135deg, #a1773d 0%, #eae2a1 100%)',
    solidBg: '#000000',
    color: '#000000',
    dark: true,
  },
  {
    id: 'cyber',
    name: 'Cyber Violet',
    gradient: 'radial-gradient(ellipse at top, #1e0a3c 0%, #0a0118 70%)',
    accent: 'linear-gradient(135deg, #8b5cf6 0%, #06b6d4 100%)',
    solidBg: '#0a0118',
    color: '#0a0118',
    dark: true,
  },
  {
    // Onda 17.32.101 — Tema unificado com /lp, /cadastrar e /login.
    // Substitui o antigo "Glacier" (azul ciano). Quem tinha glacier
    // salvo no localStorage migra automatico (alias em globals.css).
    id: 'violet',
    name: 'Violet',
    gradient: 'linear-gradient(180deg, #f3eeff 0%, #faf7ff 50%, #ffffff 100%)',
    accent: 'linear-gradient(135deg, #7c3aed 0%, #34d399 100%)',
    solidBg: '#faf7ff',
    color: '#faf7ff',
    dark: false,
  },
  {
    id: 'coral',
    name: 'Coral Sunrise',
    gradient: 'linear-gradient(180deg, #ffedd5 0%, #fff7ed 50%, #ffffff 100%)',
    accent: 'linear-gradient(135deg, #f97316 0%, #ec4899 100%)',
    solidBg: '#fff7ed',
    color: '#fff7ed',
    dark: false,
  },
];

export function ThemeSwitcher() {
  const [mounted, setMounted] = useState(false);
  const { theme, setTheme } = useTheme();
  const { mode: fxMode, setMode: setFxMode } = useVisualMode();

  useEffect(() => {
    setMounted(true);
  }, []);

  if (!mounted) return null;

  return (
    <div className="flex flex-col space-y-4 mt-6 p-4 glass-card">
      {/* ── COR DO TEMA ─────────────────────────────────────────── */}
      <div>
        <div className="flex items-center text-sm font-semibold text-muted-foreground mb-3">
          <Palette className="w-4 h-4 mr-2" />
          Aparência
        </div>
        <div className="grid grid-cols-2 gap-2">
          {THEMES.map((t) => {
            const isActive = theme === t.id;
            return (
              <button
                key={t.id}
                onClick={() => setTheme(t.id)}
                className={`group relative flex items-center gap-2 px-3 py-2 rounded-xl text-[11px] font-bold transition-all border overflow-hidden ${
                  isActive
                    ? 'border-transparent ring-2 ring-offset-2 ring-offset-background scale-[1.02]'
                    : 'border-border/40 opacity-75 hover:opacity-100 hover:scale-[1.01]'
                }`}
                style={{
                  background: t.gradient,
                  color: t.dark ? '#ffffff' : '#0a0a0a',
                  ['--tw-ring-color' as string]: 'rgb(var(--accent-glow))',
                  boxShadow: isActive
                    ? '0 0 14px rgba(var(--accent-glow), 0.55), 0 0 32px rgba(var(--accent-glow), 0.25)'
                    : undefined,
                }}
                title={t.name}
              >
                <span
                  className="w-3 h-3 rounded-full shrink-0 ring-1 ring-white/40"
                  style={{ background: t.accent }}
                />
                <span className="truncate">{t.name}</span>
              </button>
            );
          })}
        </div>
      </div>

      {/* ── ESTILO (intensidade visual) ─────────────────────────── */}
      <div>
        <div className="flex items-center text-sm font-semibold text-muted-foreground mb-3">
          <Sparkles className="w-4 h-4 mr-2" />
          Estilo
        </div>
        <div className="grid grid-cols-3 gap-2">
          <button
            onClick={() => setFxMode('solid')}
            className={`flex items-center justify-center gap-1.5 px-2 py-2 rounded-xl text-[10px] font-bold transition-all border ${
              fxMode === 'solid'
                ? 'bg-[var(--bg-tertiary)] border-[var(--accent-primary)] text-foreground'
                : 'bg-transparent border-border/40 text-muted-foreground hover:text-foreground hover:border-border'
            }`}
            title="Visual ERP clássico: cores chapadas, sem efeitos. Melhor pra leitura de telas densas."
          >
            <Square className="w-3 h-3" />
            <span>Clássico</span>
          </button>
        </div>
      </div>
    </div>
  );
}

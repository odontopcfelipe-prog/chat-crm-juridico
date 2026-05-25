'use client';

import { createContext, useContext, useEffect, useState, ReactNode } from 'react';

/**
 * Onda 15.1 — Visual Mode (intensidade visual independente do tema de cor).
 *
 * - 'neon'  → gradientes, glassmorphism, glow, animacoes (default)
 * - 'solid' → estilo ERP clássico: cores chapadas, bordas duras, zero efeitos
 * - 'clay'  → Onda 14.55: claymorphism "massinha 3D" — cantos super
 *             arredondados, sombras 3D soft, paleta pastel sobre o tema
 *             ativo. Independente do tema de cor (combina com noturno/
 *             cyber/glacier/coral).
 *
 * Persiste em localStorage como 'fx-mode'. O atributo data-fx vai no <html>
 * paralelo ao data-theme do next-themes, permitindo CSS condicionar os
 * efeitos sem mexer nas variaveis de cor:
 *   [data-fx="neon"]  body { background: var(--gradient-bg); }
 *   [data-fx="solid"] body { background: var(--bg-primary); }
 *   [data-fx="clay"]  body { background: gradient lavanda + rounded-* maior }
 */
export type FxMode = 'neon' | 'solid' | 'clay';

interface VisualModeContextValue {
  mode: FxMode;
  setMode: (m: FxMode) => void;
  toggle: () => void;
}

const VisualModeContext = createContext<VisualModeContextValue | null>(null);

const STORAGE_KEY = 'fx-mode';
const DEFAULT_MODE: FxMode = 'neon';

export function VisualModeProvider({ children }: { children: ReactNode }) {
  const [mode, setModeState] = useState<FxMode>(DEFAULT_MODE);
  const [hydrated, setHydrated] = useState(false);

  // Carrega do localStorage no mount
  useEffect(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved === 'solid' || saved === 'neon' || saved === 'clay') {
        setModeState(saved);
      }
    } catch {
      // localStorage indisponivel (SSR/privacy mode) — fica no default
    }
    setHydrated(true);
  }, []);

  // Aplica no html assim que hidratar / mudar
  useEffect(() => {
    if (!hydrated) return;
    document.documentElement.setAttribute('data-fx', mode);
  }, [mode, hydrated]);

  const setMode = (m: FxMode) => {
    setModeState(m);
    try {
      localStorage.setItem(STORAGE_KEY, m);
    } catch {
      // ignore
    }
  };

  // Toggle cicla pelos 3 modos na ordem neon → solid → clay → neon
  const toggle = () => {
    const next: FxMode = mode === 'neon' ? 'solid' : mode === 'solid' ? 'clay' : 'neon';
    setMode(next);
  };

  return (
    <VisualModeContext.Provider value={{ mode, setMode, toggle }}>
      {children}
    </VisualModeContext.Provider>
  );
}

export function useVisualMode(): VisualModeContextValue {
  const ctx = useContext(VisualModeContext);
  if (!ctx) {
    // fallback silencioso pra componentes fora do provider (SSR, testes)
    return { mode: DEFAULT_MODE, setMode: () => {}, toggle: () => {} };
  }
  return ctx;
}

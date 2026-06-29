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
// Efeitos Futurista (neon) e Massinha (clay) removidos do sistema — só o estilo
// normal/clássico (solid) continua. Default e qualquer valor salvo caem pra solid.
const DEFAULT_MODE: FxMode = 'solid';

export function VisualModeProvider({ children }: { children: ReactNode }) {
  const [mode, setModeState] = useState<FxMode>(DEFAULT_MODE);
  const [hydrated, setHydrated] = useState(false);

  // Carrega do localStorage no mount. Futurista/Massinha removidos: só 'solid' vale;
  // valores antigos (neon/clay) são ignorados e caem pro normal.
  useEffect(() => {
    setHydrated(true);
  }, []);

  // Aplica no html assim que hidratar / mudar
  useEffect(() => {
    if (!hydrated) return;
    document.documentElement.setAttribute('data-fx', mode);
  }, [mode, hydrated]);

  // Efeitos removidos — qualquer setMode força 'solid' (normal).
  const setMode = (_m: FxMode) => {
    setModeState('solid');
    try {
      localStorage.setItem(STORAGE_KEY, 'solid');
    } catch {
      // ignore
    }
  };

  // Toggle desativado — não há mais efeitos pra alternar.
  const toggle = () => { /* no-op: Futurista/Massinha removidos */ };

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

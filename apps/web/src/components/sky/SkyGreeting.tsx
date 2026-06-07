'use client';

/**
 * Onda 17.32.108 — Componentes do ceu dinamico.
 *
 * Dois exports:
 *  - SkyBackdrop  (Modo 1): so o ceu como fundo absoluto. Coloca atras
 *                            da sua saudacao atual. Use position:relative
 *                            no pai e z-index:1 na sua saudacao.
 *  - SkyGreeting  (Modo 2): banner completo com ceu + saudacao + periodo.
 *
 * HIDRATACAO: o componente inicia com DEFAULT_MINUTE (meio-dia neutro),
 * IGUAL no servidor e no cliente. O useEffect (so no browser) troca pra
 * hora real e atualiza a cada 30s. NAO chame new Date() no corpo do
 * render nem no useState inicial — reintroduz mismatch.
 */
import { useEffect, useState } from 'react';
import {
  getSkyState,
  getStarPositions,
  getCloudPositions,
  minuteOfDay,
  type SkyState,
} from './sky';
import './sky-greeting.css';

// Meio-dia: estado neutro pro SSR (sol no centro, gradient claro)
const DEFAULT_MINUTE = 720;

// Estrelas e nuvens sao posicoes determinisicas — calculo uma vez
const STARS  = getStarPositions(60);
const CLOUDS = getCloudPositions(6);

function useSkyMinute(): number {
  // Estado inicial FIXO pro SSR/CSR baterem (sem hydration mismatch)
  const [minute, setMinute] = useState(DEFAULT_MINUTE);

  useEffect(() => {
    // So aqui pode usar new Date() (so roda no browser)
    setMinute(minuteOfDay(new Date()));
    const id = setInterval(() => {
      setMinute(minuteOfDay(new Date()));
    }, 30_000);
    return () => clearInterval(id);
  }, []);

  return minute;
}

// ─── Cena do ceu (compartilhada pelos 2 modos) ─────────────────────
function SkyScene({ state }: { state: SkyState }) {
  return (
    <div className="sky-greet" aria-hidden="true">
      <div className="sky-bg" style={{ background: state.background }} />

      {/* Estrelas — opacidade dinamica */}
      <div className="sky-stars" style={{ opacity: state.stars }}>
        {STARS.map((s, i) => (
          <span
            key={`s-${i}`}
            className="sky-star"
            style={{
              left:  `${s.x}%`,
              top:   `${s.y}%`,
              width:  `${s.size}px`,
              height: `${s.size}px`,
              animationDelay: `${s.twinkle * 3}s`,
            }}
          />
        ))}
      </div>

      {/* Nuvens — opacidade dinamica */}
      <div className="sky-clouds" style={{ opacity: state.clouds }}>
        {CLOUDS.map((c, i) => (
          <span
            key={`c-${i}`}
            className="sky-cloud"
            style={{
              top:   `${c.y}%`,
              left:  `${c.x}%`,
              transform: `scale(${c.scale})`,
              animationDuration: `${c.speed}s`,
              animationDelay: `${i * -7}s`,
            }}
          />
        ))}
      </div>

      {/* Sol */}
      <div
        className="sky-sun"
        style={{
          left:    `${state.sun.x}%`,
          top:     `${state.sun.y}%`,
          opacity: state.sun.opacity,
        }}
      />

      {/* Lua */}
      <div
        className="sky-moon"
        style={{
          left:    `${state.moon.x}%`,
          top:     `${state.moon.y}%`,
          opacity: state.moon.opacity,
        }}
      />

      {/* Linha do horizonte */}
      <div className="sky-horizon" />
    </div>
  );
}

// ─── Modo 1: so o fundo ────────────────────────────────────────────
export function SkyBackdrop() {
  const minute = useSkyMinute();
  const state = getSkyState(minute);
  return <SkyScene state={state} />;
}

// ─── Modo 2: banner completo com saudacao ─────────────────────────
export interface SkyGreetingProps {
  /** Nome do usuario (so primeiro nome eh exibido) */
  name?: string;
  children?: React.ReactNode;
  className?: string;
}

export function SkyGreeting({ name, children, className = '' }: SkyGreetingProps) {
  const minute = useSkyMinute();
  const state = getSkyState(minute);
  const firstName = name ? name.split(' ')[0] : 'visitante';
  const periodLabel = {
    morning:   'Manhã',
    afternoon: 'Tarde',
    night:     'Noite',
  }[state.greeting.period];

  return (
    <div className={`sky-greet-banner sg-phase-${state.phase} ${className}`}>
      <SkyScene state={state} />
      <div className="sky-greet-content">
        <span className="sg-period">{periodLabel}</span>
        <h1 className="sg-greet">
          {state.greeting.text}, <em>{firstName}</em>
        </h1>
        {children}
      </div>
    </div>
  );
}

export default SkyGreeting;

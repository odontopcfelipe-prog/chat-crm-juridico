/**
 * Onda 17.32.108 — Motor puro do ceu dinamico.
 *
 * Funcoes determinisicas (sem DOM/Math.random) que recebem o minuto
 * do dia (0-1439) e devolvem cor, posicao do sol/lua, fase, etc.
 *
 * Math.random eh PROIBIDO aqui: posicoes precisam ser identicas no
 * servidor e no cliente pra evitar hydration mismatch. Toda
 * aleatoriedade aparente vem de uma seed numerica.
 */

export type SkyPhase = 'night' | 'dawn' | 'morning' | 'noon' | 'afternoon' | 'dusk';
export type Period = 'morning' | 'afternoon' | 'night';

export interface SkyState {
  phase: SkyPhase;
  /** CSS linear-gradient pronto pra usar em background */
  background: string;
  sun:   { x: number; y: number; opacity: number };
  moon:  { x: number; y: number; opacity: number };
  /** Opacidade das estrelas, 0-1 */
  stars:  number;
  /** Opacidade das nuvens, 0-1 */
  clouds: number;
  greeting: { text: string; period: Period };
}

// ─── Fases por faixa de minutos ──────────────────────────────────
const PHASE_RANGES: Array<{ phase: SkyPhase; start: number; end: number }> = [
  { phase: 'night',     start:    0, end:  300 }, // 00:00–05:00
  { phase: 'dawn',      start:  300, end:  420 }, // 05:00–07:00
  { phase: 'morning',   start:  420, end:  720 }, // 07:00–12:00
  { phase: 'noon',      start:  720, end:  900 }, // 12:00–15:00
  { phase: 'afternoon', start:  900, end: 1080 }, // 15:00–18:00
  { phase: 'dusk',      start: 1080, end: 1200 }, // 18:00–20:00
  { phase: 'night',     start: 1200, end: 1440 }, // 20:00–24:00
];

// 3 paradas de cor por fase (topo, meio, base do gradient)
const PHASE_COLORS: Record<SkyPhase, [string, string, string]> = {
  night:     ['#0a0e27', '#1c1740', '#2a1b4a'],
  dawn:      ['#3d2870', '#ff7e5f', '#ffd6a5'],
  morning:   ['#7ec0ee', '#bde0fe', '#fdf6e4'],
  noon:      ['#4ea4d9', '#7cb9e8', '#cee5f5'],
  afternoon: ['#6ba4d6', '#f0c987', '#ffd9a8'],
  dusk:      ['#4a2e6a', '#e85a7e', '#ffaa5e'],
};

// ─── Utilitarios determinisicos ──────────────────────────────────
function clamp01(t: number): number {
  return Math.max(0, Math.min(1, t));
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Curva senoidal pra arco (sol/lua: alto no meio, baixo nas pontas) */
function arc(t: number): number {
  // t=0 → 0, t=0.5 → 1, t=1 → 0
  return Math.sin(clamp01(t) * Math.PI);
}

/** PRNG simples baseado em seed numerica — determinisco, sem Math.random */
function hash(n: number): number {
  let x = (n + 1) * 2654435761;
  x = (x ^ (x >>> 13)) * 1597334677;
  x = x ^ (x >>> 16);
  return (x >>> 0) / 0xffffffff;
}

// ─── Funcao principal: estado do ceu pra um minuto do dia ────────
export function getSkyState(minute: number): SkyState {
  const m = ((Math.floor(minute) % 1440) + 1440) % 1440;

  // Determina fase atual
  const phaseEntry = PHASE_RANGES.find((p) => m >= p.start && m < p.end) ?? PHASE_RANGES[0];
  const phase: SkyPhase = phaseEntry.phase;

  // Sol: visivel 06:00–18:00 (m=360 a m=1080)
  const SUN_START = 360;
  const SUN_END   = 1080;
  const sunVisible = m >= SUN_START && m <= SUN_END;
  const sunT = sunVisible ? (m - SUN_START) / (SUN_END - SUN_START) : 0;
  const sun = {
    x: lerp(8, 92, sunT),
    y: sunVisible ? 75 - 65 * arc(sunT) : 80,
    opacity: sunVisible ? clamp01(arc(sunT) * 1.5 + 0.3) : 0,
  };

  // Lua: visivel 18:00–06:00 do dia seguinte
  let moonT = 0;
  let moonVisible = false;
  if (m >= 1080 || m < 360) {
    moonVisible = true;
    const moonMinAdj = m >= 1080 ? m : m + 1440;
    moonT = (moonMinAdj - 1080) / 720;
  }
  const moon = {
    x: lerp(8, 92, moonT),
    y: moonVisible ? 75 - 60 * arc(moonT) : 80,
    opacity: moonVisible ? clamp01(arc(moonT) * 1.5 + 0.4) : 0,
  };

  // Estrelas: visiveis a noite, fade in/out nos crepusculos
  let stars = 0;
  if (m < 240 || m >= 1200) stars = 1;
  else if (m >= 240 && m < 360) stars = 1 - (m - 240) / 120;       // 04:00–06:00 fade out
  else if (m >= 1080 && m < 1200) stars = (m - 1080) / 120;        // 18:00–20:00 fade in

  // Nuvens: visiveis de dia
  let clouds = 0;
  if (m >= 420 && m < 1020) clouds = 1;
  else if (m >= 360 && m < 420) clouds = (m - 360) / 60;
  else if (m >= 1020 && m < 1080) clouds = 1 - (m - 1020) / 60;

  // Gradient
  const c = PHASE_COLORS[phase];
  const background = `linear-gradient(180deg, ${c[0]} 0%, ${c[1]} 55%, ${c[2]} 100%)`;

  // Saudacao
  let greeting: { text: string; period: Period };
  if (m >= 300 && m < 720)        greeting = { text: 'Bom dia',   period: 'morning' };
  else if (m >= 720 && m < 1080)  greeting = { text: 'Boa tarde', period: 'afternoon' };
  else                            greeting = { text: 'Boa noite', period: 'night' };

  return { phase, background, sun, moon, stars, clouds, greeting };
}

// ─── Posicoes determinisicas das estrelas (mesmas no SSR e no client) ─
export interface StarPos { x: number; y: number; size: number; twinkle: number }
export function getStarPositions(count: number = 50): StarPos[] {
  const stars: StarPos[] = [];
  for (let i = 0; i < count; i++) {
    stars.push({
      x: hash(i * 17 + 1)  * 100,
      y: hash(i * 31 + 2)  * 65, // so na metade superior
      size: 0.6 + hash(i * 53 + 3) * 1.4,
      twinkle: hash(i * 71 + 4),
    });
  }
  return stars;
}

// ─── Posicoes determinisicas das nuvens ──────────────────────────
export interface CloudPos { x: number; y: number; scale: number; speed: number }
export function getCloudPositions(count: number = 6): CloudPos[] {
  const clouds: CloudPos[] = [];
  for (let i = 0; i < count; i++) {
    clouds.push({
      x: hash(i * 91 + 11)  * 110 - 10, // -10 a 100 (algumas comecam fora da tela)
      y: 10 + hash(i * 113 + 12) * 35,  // 10–45%
      scale: 0.7 + hash(i * 137 + 13) * 0.8,
      speed: 30 + hash(i * 157 + 14) * 40,
    });
  }
  return clouds;
}

// Hora -> minuto-do-dia, util pro componente
export function minuteOfDay(d: Date): number {
  return d.getHours() * 60 + d.getMinutes();
}

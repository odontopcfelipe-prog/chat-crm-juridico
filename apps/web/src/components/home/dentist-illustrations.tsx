/**
 * Ilustrações do painel do dentista (SVG puro — sem foto/imagem externa, leve e
 * nítido em qualquer tela). Cada uma ocupa o canto inferior direito do card.
 */

const TOOTH_PATH =
  'M60 8C36 8 18 20 18 46c0 22 6 34 11 50 4 13 7 26 13 26 7 0 7-20 12-20s5 20 12 20c6 0 9-13 13-26 5-16 11-28 11-50 0-26-18-38-42-38Z';

export function CalendarArt() {
  return (
    <svg viewBox="0 0 220 170" aria-hidden="true">
      <defs>
        <linearGradient id="dhCalPage" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#ffffff" />
          <stop offset="1" stopColor="#f1ecfb" />
        </linearGradient>
        <filter id="dhCalShadow" x="-20%" y="-20%" width="140%" height="150%">
          <feDropShadow dx="0" dy="8" stdDeviation="8" floodColor="#5b3fa8" floodOpacity="0.18" />
        </filter>
      </defs>
      <g transform="rotate(-9 120 100)" filter="url(#dhCalShadow)">
        <rect x="56" y="28" width="150" height="128" rx="12" fill="url(#dhCalPage)" />
        <rect x="56" y="28" width="150" height="26" rx="12" fill="#ede5ff" />
        {Array.from({ length: 8 }).map((_, i) => (
          <g key={i}>
            <rect x={70 + i * 17} y="18" width="5" height="22" rx="2.5" fill="#2d2440" />
          </g>
        ))}
        {Array.from({ length: 4 }).map((_, r) =>
          Array.from({ length: 6 }).map((__, c) => (
            <rect
              key={`${r}-${c}`}
              x={68 + c * 22} y={66 + r * 21} width="15" height="12" rx="3"
              fill={r === 1 && c === 3 ? '#8b5cf6' : '#e6dcfa'}
            />
          )),
        )}
      </g>
      <g transform="rotate(-28 70 150)">
        <rect x="8" y="142" width="120" height="9" rx="4.5" fill="#9ca3af" />
        <rect x="8" y="142" width="34" height="9" rx="4.5" fill="#4b5563" />
        <path d="M128 142 l14 4.5 -14 4.5z" fill="#d1d5db" />
      </g>
    </svg>
  );
}

export function PatientCardsArt() {
  return (
    <svg viewBox="0 0 220 170" aria-hidden="true">
      <defs>
        <linearGradient id="dhAvatar" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#60a5fa" />
          <stop offset="1" stopColor="#2563eb" />
        </linearGradient>
        <filter id="dhCardShadow" x="-20%" y="-20%" width="140%" height="150%">
          <feDropShadow dx="0" dy="8" stdDeviation="8" floodColor="#1e40af" floodOpacity="0.16" />
        </filter>
      </defs>
      <g transform="rotate(-14 110 110)" filter="url(#dhCardShadow)">
        <rect x="40" y="48" width="160" height="104" rx="14" fill="#dbe7fb" />
      </g>
      <g transform="rotate(-6 130 110)" filter="url(#dhCardShadow)">
        <rect x="58" y="56" width="160" height="104" rx="14" fill="#ffffff" />
        <circle cx="96" cy="100" r="24" fill="url(#dhAvatar)" />
        <circle cx="96" cy="94" r="8.5" fill="#ffffff" />
        <path d="M80 114c3-9 9-13 16-13s13 4 16 13" fill="#ffffff" />
        <rect x="132" y="80" width="68" height="9" rx="4.5" fill="#c7d7f5" />
        <rect x="132" y="97" width="54" height="9" rx="4.5" fill="#dbe5f8" />
        <rect x="132" y="114" width="62" height="9" rx="4.5" fill="#dbe5f8" />
        <rect x="76" y="136" width="118" height="8" rx="4" fill="#e8eef9" />
      </g>
    </svg>
  );
}

export function ToothRingArt() {
  return (
    <svg viewBox="0 0 220 170" aria-hidden="true">
      <defs>
        <radialGradient id="dhToothFill" cx="0.38" cy="0.3" r="0.8">
          <stop offset="0" stopColor="#ffffff" />
          <stop offset="0.65" stopColor="#f4f7f6" />
          <stop offset="1" stopColor="#d7e3df" />
        </radialGradient>
        <linearGradient id="dhRing" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor="#10b981" />
          <stop offset="1" stopColor="#047857" />
        </linearGradient>
        <filter id="dhToothShadow" x="-30%" y="-20%" width="160%" height="150%">
          <feDropShadow dx="0" dy="10" stdDeviation="9" floodColor="#065f46" floodOpacity="0.22" />
        </filter>
      </defs>
      <path d="M44 112 a78 22 -12 0 1 150 -30" fill="none" stroke="url(#dhRing)" strokeWidth="10" strokeLinecap="round" opacity="0.55" />
      <g transform="translate(72 18) scale(1.08)" filter="url(#dhToothShadow)">
        <path d={TOOTH_PATH} fill="url(#dhToothFill)" />
        <path d="M34 30c6-8 16-11 24-10" fill="none" stroke="#ffffff" strokeWidth="6" strokeLinecap="round" opacity="0.9" />
      </g>
      <path d="M40 128 a80 24 -12 0 0 156 -32" fill="none" stroke="url(#dhRing)" strokeWidth="11" strokeLinecap="round" />
      <path d="M186 30 l3 8 8 3 -8 3 -3 8 -3 -8 -8 -3 8 -3z" fill="#34d399" />
    </svg>
  );
}

export function TrophyArt() {
  return (
    <svg viewBox="0 0 220 170" aria-hidden="true">
      <defs>
        <linearGradient id="dhGold" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#fde68a" />
          <stop offset="0.45" stopColor="#f5b83d" />
          <stop offset="1" stopColor="#b7791f" />
        </linearGradient>
        <filter id="dhTrophyShadow" x="-30%" y="-20%" width="160%" height="150%">
          <feDropShadow dx="0" dy="10" stdDeviation="8" floodColor="#92400e" floodOpacity="0.25" />
        </filter>
      </defs>
      <ellipse cx="128" cy="160" rx="62" ry="8" fill="#f0c99a" opacity="0.6" />
      <g filter="url(#dhTrophyShadow)">
        <path d="M92 34 C70 34 64 48 66 60 c3 16 18 24 30 26" fill="none" stroke="url(#dhGold)" strokeWidth="9" strokeLinecap="round" />
        <path d="M164 34 C186 34 192 48 190 60 c-3 16 -18 24 -30 26" fill="none" stroke="url(#dhGold)" strokeWidth="9" strokeLinecap="round" />
        <path d="M86 24 h84 v22 c0 30 -18 50 -42 50 s-42 -20 -42 -50z" fill="url(#dhGold)" />
        <path d="M128 40 l6.5 13 14.3 2 -10.4 10 2.5 14.2 -12.9 -6.8 -12.9 6.8 2.5 -14.2 -10.4 -10 14.3 -2z" fill="#fff3c4" opacity="0.95" />
        <rect x="120" y="94" width="16" height="22" rx="3" fill="#d39b2e" />
        <rect x="102" y="114" width="52" height="12" rx="4" fill="url(#dhGold)" />
        <rect x="92" y="126" width="72" height="30" rx="6" fill="#2b2118" />
        <rect x="110" y="134" width="36" height="12" rx="3" fill="url(#dhGold)" />
      </g>
    </svg>
  );
}

export function ClockArt() {
  return (
    <svg viewBox="0 0 220 170" aria-hidden="true">
      <circle cx="140" cy="96" r="56" fill="#ffffff" stroke="#c7d2fe" strokeWidth="10" />
      <path d="M140 62 v34 l22 14" fill="none" stroke="#4f46e5" strokeWidth="8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** Arte da faixa de boas-vindas: um dente brilhante dentro de um "sorriso" de luz. */
export function HeroArt() {
  return (
    <svg viewBox="0 0 320 220" aria-hidden="true">
      <defs>
        <radialGradient id="dhHeroGlow" cx="0.5" cy="0.5" r="0.5">
          <stop offset="0" stopColor="#3fb68f" stopOpacity="0.55" />
          <stop offset="1" stopColor="#3fb68f" stopOpacity="0" />
        </radialGradient>
        <radialGradient id="dhHeroTooth" cx="0.36" cy="0.28" r="0.85">
          <stop offset="0" stopColor="#ffffff" />
          <stop offset="0.7" stopColor="#eef5f2" />
          <stop offset="1" stopColor="#c9dbd4" />
        </radialGradient>
        <filter id="dhHeroShadow" x="-30%" y="-20%" width="160%" height="150%">
          <feDropShadow dx="0" dy="12" stdDeviation="10" floodColor="#03140f" floodOpacity="0.45" />
        </filter>
      </defs>
      <circle cx="170" cy="110" r="108" fill="url(#dhHeroGlow)" />
      <circle cx="170" cy="110" r="78" fill="none" stroke="#ffffff" strokeOpacity="0.12" strokeWidth="1.5" />
      <circle cx="170" cy="110" r="96" fill="none" stroke="#ffffff" strokeOpacity="0.07" strokeWidth="1.5" />
      <g transform="translate(110 34) scale(1.05)" filter="url(#dhHeroShadow)">
        <path d={TOOTH_PATH} fill="url(#dhHeroTooth)" />
        <path d="M34 30c6-8 16-11 24-10" fill="none" stroke="#ffffff" strokeWidth="6" strokeLinecap="round" />
      </g>
      <path d="M96 168 q74 44 148 0" fill="none" stroke="#d4a64a" strokeWidth="5" strokeLinecap="round" />
      {[
        [252, 52, 1], [84, 64, 0.75], [262, 150, 0.6], [214, 26, 0.5],
      ].map(([x, y, s], i) => (
        <path
          key={i}
          transform={`translate(${x} ${y}) scale(${s})`}
          d="M0 -12 l3.5 8.5 8.5 3.5 -8.5 3.5 -3.5 8.5 -3.5 -8.5 -8.5 -3.5 8.5 -3.5z"
          fill="#f3d38a"
        />
      ))}
    </svg>
  );
}

/** Folhas discretas no canto do card do relógio. */
export function LeavesArt() {
  return (
    <svg viewBox="0 0 120 160" aria-hidden="true">
      <path d="M96 160 C92 110 86 70 64 30" fill="none" stroke="#3f7d5c" strokeWidth="2" opacity="0.5" />
      {[
        [64, 34, -40], [74, 62, 30], [70, 88, -35], [84, 108, 28], [80, 132, -30], [92, 150, 25],
      ].map(([x, y, r], i) => (
        <ellipse
          key={i} cx={x} cy={y} rx="9" ry="22"
          transform={`rotate(${r} ${x} ${y})`}
          fill={i % 2 ? '#5fa77f' : '#3f8a63'} opacity="0.55"
        />
      ))}
    </svg>
  );
}

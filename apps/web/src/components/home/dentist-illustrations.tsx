/**
 * Ilustrações do painel do dentista (SVG puro — sem foto/imagem externa, leve e
 * nítido em qualquer tela). Cada uma ocupa o canto inferior direito do card.
 *
 * Out/2026 — versão NEUTRA (multi-clínica): tons de cinza quente + um detalhe na
 * cor da clínica, aplicado por classe (dh-af = preenchimento, dh-as = traço,
 * dh-asoft = cor clara; dh-al/dh-als = cor clareada, pro fundo grafite) — a cor
 * vem de --dh-accent em .dh (Tenant.theme_color).
 */

const TOOTH_PATH =
  'M7 3c-2.2 0-4 1.9-4 4.5 0 3.3 1.3 5 2 8 .5 2.2 1 5.5 2.6 5.5 1.9 0 1.7-5 4.4-5s2.5 5 4.4 5c1.6 0 2.1-3.3 2.6-5.5.7-3 2-4.7 2-8C21 4.9 19.2 3 17 3c-2 0-3 1.2-5 1.2S9 3 7 3z';
// Lado direito do dente (sombra), pro volume.
const TOOTH_SHADE =
  'M14.6 4.5c.9-.8 1.7-1.5 2.4-1.5 2.2 0 4 1.9 4 4.5 0 3.3-1.3 5-2 8-.5 2.2-1 5.5-2.6 5.5-.6 0-1-.5-1.3-1.3.9-2.4 1.6-5.2 2.1-7.7.7-3.4-.5-6-2.6-7.5z';
const SPARK = (x: number, y: number, r: number) =>
  `M${x} ${y - r}l${r * 0.27} ${r * 0.73} ${r * 0.73} ${r * 0.27}-${r * 0.73} ${r * 0.27}-${r * 0.27} ${r * 0.73}-${r * 0.27}-${r * 0.73}-${r * 0.73}-${r * 0.27} ${r * 0.73}-${r * 0.27}z`;

export function CalendarArt() {
  return (
    <svg viewBox="0 0 180 140" aria-hidden="true">
      <ellipse cx="104" cy="132" rx="64" ry="7" fill="#000" opacity="0.07" />
      <g transform="rotate(-9 104 80)">
        <rect x="42" y="30" width="126" height="102" rx="15" fill="#fff" stroke="#E4E0D8" strokeWidth="2" />
        <path d="M42 45a15 15 0 0 1 15-15h96a15 15 0 0 1 15 15v12H42z" fill="#EFECE6" />
        <path d="M62 22v17M78 22v17M94 22v17M110 22v17M126 22v17M142 22v17" stroke="#4B5058" strokeWidth="3.6" strokeLinecap="round" />
        <g fill="#EEEBE5">
          {[67, 86, 105].map((y) => [54, 76, 98, 120, 142].map((x) => (
            (x === 98 && y === 86) || (x === 142 && y === 105) ? null
              : <rect key={`${x}-${y}`} x={x} y={y} width={x === 142 ? 15 : 17} height="12" rx="3.5" />
          )))}
        </g>
        <rect className="dh-af" x="98" y="86" width="17" height="12" rx="3.5" />
      </g>
      <g transform="rotate(32 60 118)">
        <rect x="20" y="114" width="70" height="9" rx="4.5" fill="#9AA0A8" />
        <rect x="20" y="114" width="14" height="9" rx="3" fill="#D6D1C6" />
        <path d="M90 114l12 4.5-12 4.5z" fill="#E8C9A6" />
        <path d="M98 116.9l4 1.6-4 1.6z" fill="#3A3E45" />
      </g>
    </svg>
  );
}

export function PatientCardsArt() {
  return (
    <svg viewBox="0 0 180 140" aria-hidden="true">
      <ellipse cx="104" cy="132" rx="66" ry="7" fill="#000" opacity="0.07" />
      <rect x="52" y="34" width="130" height="88" rx="15" fill="#E9E6E0" transform="rotate(-8 117 78)" />
      <rect x="38" y="36" width="134" height="90" rx="15" fill="#fff" stroke="#E4E0D8" strokeWidth="2" />
      <rect x="38" y="36" width="134" height="16" rx="8" fill="#F3F1EC" />
      <circle className="dh-asoft" cx="76" cy="84" r="21" />
      <circle className="dh-af" cx="76" cy="77" r="7.5" />
      <path className="dh-af" d="M62 97c3-7 8-10 14-10s11 3 14 10" />
      <rect x="106" y="68" width="52" height="8" rx="4" fill="#D6D1C6" />
      <rect x="106" y="83" width="40" height="8" rx="4" fill="#E8E4DC" />
      <rect x="106" y="98" width="46" height="8" rx="4" fill="#E8E4DC" />
      <circle className="dh-af" cx="160" cy="44" r="3" />
    </svg>
  );
}

export function ToothRingArt() {
  return (
    <svg viewBox="0 0 180 150" aria-hidden="true">
      <ellipse cx="92" cy="140" rx="54" ry="6" fill="#000" opacity="0.07" />
      <path className="dh-as" d="M28 112a64 19 0 0 1 128 0" fill="none" strokeWidth="6" opacity="0.3" />
      <g transform="translate(46 8) scale(3.8)">
        <path d={TOOTH_PATH} fill="#fff" stroke="#DCD7CD" strokeWidth="0.45" strokeLinejoin="round" />
        <path d={TOOTH_SHADE} fill="#EEEBE5" />
      </g>
      <path className="dh-as" d="M28 112a64 19 0 0 0 128 0" fill="none" strokeWidth="6" strokeLinecap="round" />
      <path className="dh-af dh-tw" d={SPARK(152, 33, 9.6)} />
    </svg>
  );
}

export function TrophyArt() {
  return (
    <svg viewBox="0 0 180 150" aria-hidden="true">
      <ellipse cx="96" cy="142" rx="44" ry="6" fill="#000" opacity="0.08" />
      <path d="M58 36H40v13a21 21 0 0 0 21 21" fill="none" stroke="#CFC9BC" strokeWidth="9" strokeLinecap="round" />
      <path d="M134 36h18v13a21 21 0 0 1-21 21" fill="none" stroke="#CFC9BC" strokeWidth="9" strokeLinecap="round" />
      <path d="M54 22h84v40a42 42 0 0 1-84 0z" fill="#E9E5DE" />
      <path d="M96 22h42v40a42 42 0 0 1-42 42z" fill="#DCD7CC" />
      <path d="M64 30v30a32 32 0 0 0 14 27" fill="none" stroke="#fff" strokeWidth="5" strokeLinecap="round" opacity="0.85" />
      <polygon className="dh-af" points="96,40 100.6,53 114.4,53 103.3,61.2 107.5,74.3 96,66.2 84.5,74.3 88.7,61.2 77.6,53 91.4,53" />
      <rect x="89" y="104" width="14" height="16" fill="#CFC9BC" />
      <rect x="68" y="118" width="56" height="18" rx="5" fill="#2B2F36" />
      <rect className="dh-af" x="80" y="124" width="32" height="5" rx="2.5" opacity="0.8" />
    </svg>
  );
}

/** "Validar atendimento": prancheta com a lista — o item validado na cor da clínica. */
export function ValidateArt() {
  return (
    <svg viewBox="0 0 180 150" aria-hidden="true">
      <ellipse cx="102" cy="140" rx="56" ry="6" fill="#000" opacity="0.07" />
      <g transform="rotate(-7 102 80)">
        <rect x="52" y="20" width="104" height="118" rx="14" fill="#E9E5DE" />
        <rect x="60" y="30" width="88" height="102" rx="9" fill="#fff" stroke="#E4E0D8" strokeWidth="2" />
        <rect x="84" y="12" width="40" height="18" rx="7" fill="#4B5058" />
        <rect x="96" y="16" width="16" height="5" rx="2.5" fill="#9AA0A8" />
        <circle className="dh-af" cx="78" cy="58" r="8" />
        <path d="M74.5 58l2.6 2.6 5-5.2" fill="none" stroke="#fff" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" />
        <rect x="92" y="54" width="44" height="8" rx="4" fill="#D6D1C6" />
        <circle cx="78" cy="83" r="7" fill="none" stroke="#CFC9BC" strokeWidth="2.5" />
        <rect x="92" y="79" width="38" height="8" rx="4" fill="#E8E4DC" />
        <circle cx="78" cy="107" r="7" fill="none" stroke="#CFC9BC" strokeWidth="2.5" />
        <rect x="92" y="103" width="42" height="8" rx="4" fill="#E8E4DC" />
      </g>
      <path className="dh-af dh-tw" d={SPARK(158, 30, 8.8)} />
    </svg>
  );
}

export function ClockArt() {
  return (
    <svg viewBox="0 0 180 150" aria-hidden="true">
      <ellipse cx="96" cy="140" rx="50" ry="6" fill="#000" opacity="0.07" />
      <circle cx="96" cy="78" r="52" fill="#fff" stroke="#E4E0D8" strokeWidth="2" />
      <circle cx="96" cy="78" r="40" fill="#F3F1EC" />
      <path d="M96 52v26l18 12" fill="none" stroke="#4B5058" strokeWidth="5" strokeLinecap="round" />
      <circle className="dh-af" cx="96" cy="78" r="5" />
    </svg>
  );
}

/** Arte da faixa de boas-vindas: um dente com volume num disco, sorriso e brilhos. */
export function HeroArt() {
  return (
    <svg viewBox="0 0 240 240" aria-hidden="true">
      <circle cx="120" cy="120" r="92" fill="rgba(255,255,255,0.04)" stroke="rgba(255,255,255,0.08)" strokeWidth="1.5" />
      <ellipse cx="120" cy="196" rx="46" ry="7" fill="#000" opacity="0.18" />
      <g transform="translate(70 50) scale(4.2)">
        <path d={TOOTH_PATH} fill="#fff" />
        <path d={TOOTH_SHADE} fill="#E6E8EC" />
        <path d="M6.2 5.8c.6-1 1.7-1.5 2.8-1.3" fill="none" stroke="#fff" strokeWidth="0.9" strokeLinecap="round" opacity="0.9" />
      </g>
      <path className="dh-als" d="M60 176c34 26 86 26 120 0" fill="none" strokeWidth="6" strokeLinecap="round" />
      <path className="dh-al dh-tw" d={SPARK(36, 84, 11.8)} />
      <path className="dh-al dh-tw2" d={SPARK(200, 60, 8.8)} />
      <path className="dh-al dh-tw" d={SPARK(206, 167, 7.2)} opacity="0.7" />
    </svg>
  );
}

/** Folhas discretas no card do relógio (tons quentes neutros). */
export function LeavesArt() {
  return (
    <svg viewBox="0 0 60 130" aria-hidden="true">
      <path d="M30 128C28 96 26 64 34 10" fill="none" stroke="#C9C3B6" strokeWidth="2" strokeLinecap="round" />
      <path d="M33 24c-9-4-14-12-12-20 9 2 14 10 12 20z" fill="#DCD7CC" />
      <path d="M33 32c8-5 16-4 21 2-8 5-16 4-21-2z" fill="#CFC9BC" />
      <path d="M31 52c-9-3-15-10-14-18 9 1 15 8 14 18z" fill="#DCD7CC" />
      <path d="M31 62c8-5 16-5 22 1-8 5-16 5-22-1z" fill="#CFC9BC" />
      <path d="M30 82c-9-3-15-10-14-18 9 1 15 8 14 18z" fill="#DCD7CC" />
      <path d="M30 94c8-5 16-5 22 1-8 5-16 5-22-1z" fill="#CFC9BC" />
      <path d="M30 112c-8-3-13-9-12-16 8 1 13 7 12 16z" fill="#DCD7CC" />
    </svg>
  );
}

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

/** Nova consulta: ficha com um dente e o "+" na cor da clínica. */
export function ConsultArt() {
  return (
    <svg viewBox="0 0 180 150" aria-hidden="true">
      <ellipse cx="100" cy="140" rx="58" ry="6" fill="#000" opacity="0.07" />
      <rect x="58" y="22" width="104" height="112" rx="15" fill="#E9E6E0" transform="rotate(7 110 78)" />
      <rect x="44" y="20" width="106" height="114" rx="15" fill="#fff" stroke="#E4E0D8" strokeWidth="2" />
      <g transform="translate(60 30) scale(3.1)">
        <path d={TOOTH_PATH} fill="#F6F4F0" stroke="#D6D1C6" strokeWidth="0.55" strokeLinejoin="round" />
        <path d={TOOTH_SHADE} fill="#ECE8E1" />
      </g>
      <rect x="62" y="104" width="54" height="7" rx="3.5" fill="#D6D1C6" />
      <rect x="62" y="116" width="38" height="7" rx="3.5" fill="#E8E4DC" />
      <circle className="dh-af" cx="146" cy="30" r="17" />
      <path d="M146 22v16M138 30h16" stroke="#fff" strokeWidth="3.6" strokeLinecap="round" />
      <path className="dh-af dh-tw" d={SPARK(30, 44, 8)} />
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

// ─── Out/2026 — ilustrações dos cards dos OUTROS setores (mesmo estilo neutro:
// cinza quente + um detalhe na cor da clínica). O painel virou o de todos. ───

/** WhatsApp / conversas: dois balões, o da resposta na cor da clínica. */
export function ChatArt() {
  return (
    <svg viewBox="0 0 180 150" aria-hidden="true">
      <ellipse cx="100" cy="140" rx="58" ry="6" fill="#000" opacity="0.07" />
      <path d="M50 26h82a14 14 0 0 1 14 14v38a14 14 0 0 1-14 14H90l-18 15V92H50a14 14 0 0 1-14-14V40a14 14 0 0 1 14-14z" fill="#fff" stroke="#E4E0D8" strokeWidth="2" />
      <rect x="54" y="45" width="68" height="8" rx="4" fill="#D6D1C6" />
      <rect x="54" y="61" width="48" height="8" rx="4" fill="#E8E4DC" />
      <path className="dh-af" d="M104 84h50a12 12 0 0 1 12 12v18a12 12 0 0 1-12 12h-4v12l-14-12h-32a12 12 0 0 1-12-12V96a12 12 0 0 1 12-12z" />
      <circle cx="116" cy="105" r="3.6" fill="#fff" />
      <circle cx="129" cy="105" r="3.6" fill="#fff" />
      <circle cx="142" cy="105" r="3.6" fill="#fff" />
      <path className="dh-af dh-tw" d={SPARK(24, 40, 8)} />
    </svg>
  );
}

/** CRC / follow-up: funil com os contatos entrando. */
export function FunnelArt() {
  return (
    <svg viewBox="0 0 180 150" aria-hidden="true">
      <ellipse cx="100" cy="140" rx="46" ry="6" fill="#000" opacity="0.07" />
      <path d="M38 40h124l-42 50v34l-40 14V90z" fill="#fff" stroke="#E4E0D8" strokeWidth="2" strokeLinejoin="round" />
      <path d="M38 40h124l-10 12H48z" fill="#E9E6E0" />
      <path d="M62 66h76" stroke="#E8E4DC" strokeWidth="6" strokeLinecap="round" />
      <circle className="dh-af" cx="74" cy="22" r="7" />
      <circle className="dh-asoft" cx="100" cy="14" r="6" />
      <circle className="dh-af" cx="126" cy="24" r="5.5" />
      <path className="dh-as" d="M100 96v26" fill="none" strokeWidth="4" strokeLinecap="round" />
      <path className="dh-af dh-tw" d={SPARK(160, 18, 8)} />
    </svg>
  );
}

/** Avaliação / propostas / fechamentos / relatórios: documentos com o "ok". */
export function DocArt() {
  return (
    <svg viewBox="0 0 180 150" aria-hidden="true">
      <ellipse cx="102" cy="140" rx="52" ry="6" fill="#000" opacity="0.07" />
      <rect x="68" y="18" width="88" height="112" rx="12" fill="#E9E6E0" transform="rotate(8 112 74)" />
      <rect x="52" y="20" width="88" height="114" rx="12" fill="#fff" stroke="#E4E0D8" strokeWidth="2" />
      <rect x="66" y="38" width="44" height="8" rx="4" fill="#D6D1C6" />
      <rect x="66" y="56" width="60" height="7" rx="3.5" fill="#E8E4DC" />
      <rect x="66" y="70" width="52" height="7" rx="3.5" fill="#E8E4DC" />
      <rect x="66" y="84" width="58" height="7" rx="3.5" fill="#E8E4DC" />
      <circle className="dh-af" cx="134" cy="112" r="17" />
      <path d="M126 112l6 6 11-12" fill="none" stroke="#fff" strokeWidth="3.4" strokeLinecap="round" strokeLinejoin="round" />
      <path className="dh-af dh-tw" d={SPARK(30, 50, 8)} />
    </svg>
  );
}

/** Caixa / financeiro: carteira com moedas. */
export function MoneyArt() {
  return (
    <svg viewBox="0 0 180 150" aria-hidden="true">
      <ellipse cx="100" cy="140" rx="60" ry="6" fill="#000" opacity="0.07" />
      <rect x="40" y="46" width="112" height="78" rx="16" fill="#fff" stroke="#E4E0D8" strokeWidth="2" />
      <path d="M40 62c0-9 7-16 16-16h80c9 0 16 7 16 16v4H40z" fill="#E9E6E0" />
      <rect x="118" y="76" width="40" height="26" rx="10" fill="#F3F1EC" stroke="#E4E0D8" strokeWidth="2" />
      <circle className="dh-af" cx="132" cy="89" r="5" />
      <circle className="dh-af" cx="74" cy="34" r="15" />
      <circle cx="74" cy="34" r="9" fill="none" stroke="#fff" strokeWidth="2" opacity="0.7" />
      <circle className="dh-asoft" cx="98" cy="24" r="11" />
      <path className="dh-af dh-tw" d={SPARK(160, 30, 8)} />
    </svg>
  );
}

/** Cobranças / boletos: boleto com código de barras e o selo. */
export function BoletoArt() {
  const barras = [64, 70, 73, 79, 84, 88, 94, 99, 103, 109, 114, 118, 124];
  return (
    <svg viewBox="0 0 180 150" aria-hidden="true">
      <ellipse cx="100" cy="140" rx="58" ry="6" fill="#000" opacity="0.07" />
      <path d="M48 20h96v110l-12-8-12 8-12-8-12 8-12-8-12 8-12-8-12 8z" fill="#fff" stroke="#E4E0D8" strokeWidth="2" strokeLinejoin="round" />
      <rect x="62" y="36" width="50" height="8" rx="4" fill="#D6D1C6" />
      <rect x="62" y="52" width="66" height="7" rx="3.5" fill="#E8E4DC" />
      {barras.map((x, i) => (
        <rect key={x} x={x} y="76" width={i % 3 === 0 ? 3.4 : 2} height="26" fill="#4B5058" opacity="0.75" />
      ))}
      <circle className="dh-af" cx="140" cy="34" r="16" />
      <path d="M134 34h12M140 28v12" stroke="#fff" strokeWidth="3" strokeLinecap="round" />
      <path className="dh-af dh-tw" d={SPARK(28, 60, 8)} />
    </svg>
  );
}

/** CRM / visão geral / indicadores: gráfico de barras com a linha da clínica. */
export function ChartArt() {
  return (
    <svg viewBox="0 0 180 150" aria-hidden="true">
      <ellipse cx="100" cy="140" rx="60" ry="6" fill="#000" opacity="0.07" />
      <rect x="38" y="24" width="124" height="104" rx="16" fill="#fff" stroke="#E4E0D8" strokeWidth="2" />
      <rect x="56" y="82" width="14" height="30" rx="4" fill="#E8E4DC" />
      <rect x="80" y="66" width="14" height="46" rx="4" fill="#D6D1C6" />
      <rect x="104" y="74" width="14" height="38" rx="4" fill="#E8E4DC" />
      <rect className="dh-af" x="128" y="50" width="14" height="62" rx="4" />
      <path className="dh-as" d="M58 70l24-18 24 10 30-26" fill="none" strokeWidth="3.2" strokeLinecap="round" strokeLinejoin="round" />
      <circle className="dh-af" cx="136" cy="36" r="5" />
      <path className="dh-af dh-tw" d={SPARK(26, 34, 8)} />
    </svg>
  );
}

/** Venda rápida: comprovante com o raio na cor da clínica. */
export function ZapArt() {
  return (
    <svg viewBox="0 0 180 150" aria-hidden="true">
      <ellipse cx="100" cy="140" rx="54" ry="6" fill="#000" opacity="0.07" />
      <rect x="50" y="24" width="84" height="106" rx="14" fill="#fff" stroke="#E4E0D8" strokeWidth="2" />
      <rect x="64" y="42" width="40" height="8" rx="4" fill="#D6D1C6" />
      <rect x="64" y="58" width="56" height="7" rx="3.5" fill="#E8E4DC" />
      <rect x="64" y="72" width="46" height="7" rx="3.5" fill="#E8E4DC" />
      <rect x="64" y="102" width="56" height="12" rx="6" fill="#F3F1EC" />
      <circle className="dh-af" cx="136" cy="44" r="22" />
      <path d="M139 30l-12 17h9l-4 13 13-18h-9z" fill="#fff" />
      <path className="dh-af dh-tw" d={SPARK(28, 92, 8)} />
    </svg>
  );
}

/** Retornos: calendário com a seta de volta. */
export function ReturnArt() {
  const quadradinhos: Array<[number, number]> = [];
  for (let c = 0; c < 4; c++) for (let r = 0; r < 2; r++) quadradinhos.push([54 + c * 20, 66 + r * 20]);
  return (
    <svg viewBox="0 0 180 150" aria-hidden="true">
      <ellipse cx="96" cy="140" rx="56" ry="6" fill="#000" opacity="0.07" />
      <rect x="40" y="32" width="104" height="96" rx="14" fill="#fff" stroke="#E4E0D8" strokeWidth="2" />
      <path d="M40 46c0-8 6-14 14-14h76c8 0 14 6 14 14v8H40z" fill="#E9E6E0" />
      <rect x="62" y="22" width="8" height="18" rx="4" fill="#4B5058" />
      <rect x="114" y="22" width="8" height="18" rx="4" fill="#4B5058" />
      {quadradinhos.map(([x, y]) => (
        <rect key={`${x}-${y}`} x={x} y={y} width="12" height="10" rx="3" fill="#E8E4DC" />
      ))}
      <circle className="dh-af" cx="140" cy="104" r="22" />
      <path d="M150 104a10 10 0 1 1-4-8" fill="none" stroke="#fff" strokeWidth="3.2" strokeLinecap="round" />
      <path d="M148 90l-1 7 7 1" fill="none" stroke="#fff" strokeWidth="3.2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** Aniversariantes: bolo com a vela acesa na cor da clínica. */
export function CakeArt() {
  return (
    <svg viewBox="0 0 180 150" aria-hidden="true">
      <ellipse cx="96" cy="140" rx="56" ry="6" fill="#000" opacity="0.07" />
      <rect x="42" y="84" width="108" height="48" rx="12" fill="#fff" stroke="#E4E0D8" strokeWidth="2" />
      <rect x="56" y="58" width="80" height="30" rx="10" fill="#F3F1EC" stroke="#E4E0D8" strokeWidth="2" />
      <path className="dh-as" d="M42 100c9 7 18 7 27 0s18-7 27 0 18 7 27 0 18-7 27 0" fill="none" strokeWidth="4" strokeLinecap="round" />
      <rect x="92" y="36" width="8" height="22" rx="3" fill="#D6D1C6" />
      <path className="dh-af" d="M96 18c6 7 6 13 0 16-6-3-6-9 0-16z" />
      <path className="dh-af dh-tw" d={SPARK(150, 40, 8)} />
      <path className="dh-af dh-tw" d={SPARK(36, 54, 6)} />
    </svg>
  );
}

/** Marketing: megafone com as ondas na cor da clínica. */
export function MegaphoneArt() {
  return (
    <svg viewBox="0 0 180 150" aria-hidden="true">
      <ellipse cx="92" cy="140" rx="52" ry="6" fill="#000" opacity="0.07" />
      <path d="M44 62h18l52-28v86L62 92H44a10 10 0 0 1-10-10V72a10 10 0 0 1 10-10z" fill="#fff" stroke="#E4E0D8" strokeWidth="2" strokeLinejoin="round" />
      <path d="M52 92l8 30h14l-6-28" fill="#E9E6E0" />
      <rect x="110" y="34" width="10" height="86" rx="5" fill="#4B5058" />
      <path className="dh-as" d="M134 62c8 8 8 22 0 30M146 52c14 14 14 38 0 52" fill="none" strokeWidth="4" strokeLinecap="round" />
      <path className="dh-af dh-tw" d={SPARK(40, 34, 8)} />
    </svg>
  );
}

/** Configurações: engrenagem. */
export function GearArt() {
  const dentes = [0, 45, 90, 135, 180, 225, 270, 315];
  return (
    <svg viewBox="0 0 180 150" aria-hidden="true">
      <ellipse cx="96" cy="140" rx="50" ry="6" fill="#000" opacity="0.07" />
      <g transform="translate(96 76)">
        {dentes.map((r) => (
          <rect key={r} x="-9" y="-56" width="18" height="22" rx="5" fill="#E9E6E0" transform={'rotate(' + r + ')'} />
        ))}
        <circle r="42" fill="#fff" stroke="#E4E0D8" strokeWidth="2" />
        <circle className="dh-af" r="16" />
        <circle r="6" fill="#fff" />
      </g>
      <path className="dh-af dh-tw" d={SPARK(156, 28, 8)} />
    </svg>
  );
}

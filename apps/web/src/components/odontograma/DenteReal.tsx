'use client';

/**
 * Out/2026 — Dente realista do odontograma (pedido do dono: "mais real e aparecer
 * os procedimentos — implante, facetas..."; depois "mais bonito e mais realista").
 *
 * - Formato pelo TIPO do dente (FDI): incisivo central/lateral, canino,
 *   pré-molar, molar (vista de frente). Decíduos usam os mesmos formatos.
 * - Esmalte em camadas: translúcido azulado na borda incisal, marfim no meio,
 *   mais amarelado no colo; sombra nas laterais (volume) e brilho suave.
 * - Gengiva cobrindo o colo, com papilas entre os dentes; a raiz aparece de
 *   leve por baixo (fica nítida quando tem canal ou implante).
 * - Desenhado com a coroa pra CIMA (arcada inferior); o superior é espelhado e
 *   as arcadas fazem uma leve curva de sorriso (molares mais afastados do meio).
 * - O procedimento aparece NO dente: implante, faceta, coroa, canal, restauração,
 *   extração, limpeza, clareamento e aparelho — classificado pelo NOME (e pela
 *   especialidade, se o nome não disser); cada clínica cadastra os seus.
 */
import { useId, type CSSProperties } from 'react';

export type MarcaTipo =
  | 'implante' | 'faceta' | 'coroa' | 'canal' | 'restauracao'
  | 'extracao' | 'limpeza' | 'clareamento' | 'ortodontia' | 'outro';

export const MARCAS: Record<MarcaTipo, { label: string; cor: string }> = {
  implante:    { label: 'Implante',    cor: '#64748b' },
  faceta:      { label: 'Faceta / lente', cor: '#0ea5e9' },
  coroa:       { label: 'Coroa / prótese', cor: '#d97706' },
  canal:       { label: 'Canal',       cor: '#dc2626' },
  restauracao: { label: 'Restauração', cor: '#2563eb' },
  extracao:    { label: 'Extração',    cor: '#b91c1c' },
  limpeza:     { label: 'Limpeza / gengiva', cor: '#16a34a' },
  clareamento: { label: 'Clareamento', cor: '#ca8a04' },
  ortodontia:  { label: 'Aparelho',    cor: '#475569' },
  outro:       { label: 'Outro procedimento', cor: '#7c3aed' },
};

const sem = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

/** Tipos de marca de um procedimento (pode ser mais de um: "coroa sobre implante"). */
export function classificarProcedimento(nome: string, especialidade?: string | null): MarcaTipo[] {
  const n = sem(nome || '');
  const out = new Set<MarcaTipo>();
  if (/implant/.test(n)) out.add('implante');
  if (/extra[cç]|exodont|siso/.test(n)) out.add('extracao');
  if (/canal|endodon|pulp/.test(n)) out.add('canal');
  if (/facet|lente|laminad/.test(n)) out.add('faceta');
  if (/coroa|protes|ponte|pivo|onlay|inlay|overlay|bloco ceram/.test(n)) out.add('coroa');
  if (/restaur|resina|obtura|amalgam/.test(n)) out.add('restauracao');
  if (/limpeza|profilax|raspag|periodon|tartaro|polimento|gengiv/.test(n)) out.add('limpeza');
  if (/clarea/.test(n)) out.add('clareamento');
  if (/ortod|aparelho|bracket|alinhador/.test(n)) out.add('ortodontia');
  if (out.size === 0 && especialidade) {
    const e = sem(especialidade);
    if (/implant/.test(e)) out.add('implante');
    else if (/endodon/.test(e)) out.add('canal');
    else if (/protes/.test(e)) out.add('coroa');
    else if (/periodon/.test(e)) out.add('limpeza');
    else if (/ortod/.test(e)) out.add('ortodontia');
    else if (/dentist|estetic/.test(e)) out.add('restauracao');
  }
  if (out.size === 0) out.add('outro');
  return [...out];
}

export interface MarcaDente {
  tipo: MarcaTipo;
  nome: string;
}

type Forma = 'central' | 'lateral' | 'canino' | 'premolar' | 'molar';

function formaDoDente(fdi: string): Forma {
  const quadrante = Number(fdi[0]);
  const pos = Number(fdi[1]);
  if (quadrante >= 5) return pos <= 1 ? 'central' : pos === 2 ? 'lateral' : pos === 3 ? 'canino' : 'molar';
  if (pos === 1) return 'central';
  if (pos === 2) return 'lateral';
  if (pos === 3) return 'canino';
  if (pos <= 5) return 'premolar';
  return 'molar';
}

// Curva do sorriso: quanto o dente se afasta do meio (px), pela posição 1..8.
const CURVA = [0, 0, 1, 3, 5, 8, 11, 14, 17];

// Coordenadas num quadro 40×80 (coroa em cima, colo em y≈32, raízes embaixo).
// `w` = largura útil (o viewBox recorta o centro) — cada tipo com a largura real.
// `sulcos` = detalhes da superfície (cúspides / lobos), bem suaves.
const FORMAS: Record<Forma, {
  w: number; coroa: string; raizes: string[]; oclusal: [number, number]; anterior: boolean; sulcos: string[];
}> = {
  central: {
    w: 30, anterior: true,
    coroa: 'M12.2 33 C10.6 26 8.6 17 8.3 10.5 C8.1 6 9.6 3.6 13.2 3.3 C16 3.1 18 3.6 20 3.6 C22 3.6 24 3.1 26.8 3.3 C30.4 3.6 31.9 6 31.7 10.5 C31.4 17 29.4 26 27.8 33 Z',
    raizes: ['M12.2 33 C12.3 50 16.4 70 20 76 C23.6 70 27.7 50 27.8 33 Z'],
    oclusal: [20, 7],
    sulcos: ['M16 6 C15.6 12 15.4 18 15.8 24', 'M24 6 C24.4 12 24.6 18 24.2 24'],
  },
  lateral: {
    w: 26, anterior: true,
    coroa: 'M13.6 33 C12.2 26 10.2 17.5 9.9 11.5 C9.7 7 11.2 4.6 14.5 4.4 C16.8 4.2 18.3 4.8 20 4.8 C21.7 4.8 23.2 4.2 25.5 4.4 C28.8 4.6 30.3 7 30.1 11.5 C29.8 17.5 27.8 26 26.4 33 Z',
    raizes: ['M13.6 33 C13.7 49 17 67 20 72 C23 67 26.3 49 26.4 33 Z'],
    oclusal: [20, 8],
    sulcos: ['M17 8 C16.8 14 16.8 19 17.1 24'],
  },
  canino: {
    w: 30, anterior: true,
    coroa: 'M12.2 33 C9.5 26 7.6 18 8.4 12 C9.3 7.5 14 3.6 18.6 1.8 C19.5 1.5 20.5 1.5 21.4 1.8 C26 3.6 30.7 7.5 31.6 12 C32.4 18 30.5 26 27.8 33 Z',
    raizes: ['M12.2 33 C12.3 53 16.4 76 20 79 C23.6 76 27.7 53 27.8 33 Z'],
    oclusal: [20, 6],
    sulcos: ['M20 4 C19.6 12 19.6 20 20 27'],
  },
  premolar: {
    w: 32, anterior: false,
    coroa: 'M12 33 C8.8 28 6.6 21 6.6 14.5 C6.6 8.5 9.6 4.9 13.4 4.5 C15.9 4.3 17.7 6.7 20 6.7 C22.3 6.7 24.1 4.3 26.6 4.5 C30.4 4.9 33.4 8.5 33.4 14.5 C33.4 21 31.2 28 28 33 Z',
    raizes: ['M12 33 C12 50 16 70 20 74 C24 70 28 50 28 33 Z'],
    oclusal: [20, 9],
    sulcos: ['M20 7.5 C19.6 13 19.8 19 20.3 24'],
  },
  molar: {
    w: 40, anterior: false,
    coroa: 'M8.6 33 C5.2 28.5 2.6 21 2.6 14.5 C2.6 8.2 5.6 4.4 9.8 4 C12.9 3.7 14.4 6.4 16.6 6.5 C18.6 6.6 19.6 3.3 22.4 3.3 C25.2 3.3 25.9 6.5 27.8 6.5 C29.7 6.5 30.9 3.8 33.4 4.2 C36.9 4.8 37.6 9 37.4 14.5 C37.2 21 34.8 28.5 31.4 33 Z',
    raizes: [
      'M9 32 C7.8 45 9.2 62 12 70 C14 73 17 68 17 60 C17 50 17.8 40 18.8 33 Z',
      'M21.2 33 C22.2 40 23 50 23 60 C23 68 26 73 28 70 C30.8 62 32.2 45 31 32 Z',
    ],
    oclusal: [20, 9],
    sulcos: ['M16.6 7.5 C16 13 16.4 19 17.4 25', 'M27.4 7.5 C27.8 13 27.6 19 26.8 25'],
  },
};

const ALTURA_PADRAO = 76;

export interface DenteRealProps {
  fdi: string;
  /** Arcada superior: desenha espelhado (coroa pra baixo). */
  superior: boolean;
  marcas?: MarcaDente[];
  /** Selecionado pro procedimento ativo (coroa âmbar). */
  selecionado?: boolean;
  /** Altura do desenho em px (a largura sai do tipo do dente). */
  altura?: number;
  onClick?: () => void;
  disabled?: boolean;
  title?: string;
  /** Número do dente: 'fora' = acima no superior / abaixo no inferior. */
  numero?: 'fora' | 'nenhum';
  /** Curva do sorriso (molares mais longe do meio). */
  curva?: boolean;
}

export function DenteReal({
  fdi, superior, marcas = [], selecionado = false, altura = ALTURA_PADRAO,
  onClick, disabled = false, title, numero = 'fora', curva = true,
}: DenteRealProps) {
  const uid = useId().replace(/[^a-zA-Z0-9_-]/g, '');
  const forma = formaDoDente(fdi);
  const f = FORMAS[forma];
  const tipos = new Set(marcas.map((m) => m.tipo));
  const temImplante = tipos.has('implante');
  const temCanal = tipos.has('canal') && !temImplante;
  const extraido = tipos.has('extracao');
  const largura = Math.round((altura * f.w) / 80);
  const x0 = (40 - f.w) / 2;
  const xr = x0 + f.w;
  const [ox, oy] = f.oclusal;
  const deslocamento = curva ? Math.round((CURVA[Number(fdi[1])] ?? 0) * (altura / ALTURA_PADRAO)) : 0;

  const id = (n: string) => `${n}-${uid}`;
  const espelho = superior ? 'matrix(1 0 0 -1 0 80)' : undefined;
  // Margem da gengiva: papilas entre os dentes (y≈24) e o colo no meio (y≈35).
  const margem = `M${x0 - 3} 27 Q20 45 ${xr + 3} 27`;

  const titulo = title ?? (marcas.length
    ? `Dente ${fdi} — ${marcas.map((m) => m.nome).join(' · ')}`
    : `Dente ${fdi}`);

  const label = numero === 'fora' && (
    <span
      className={`min-w-[20px] rounded-full px-1 py-px text-center text-[10px] font-bold leading-[14px] tabular-nums ${
        selecionado
          ? 'bg-amber-500 text-white'
          : marcas.length ? 'bg-foreground/85 text-background' : 'text-muted-foreground'
      }`}
    >
      {fdi}
    </span>
  );

  const estilo: CSSProperties = { width: largura, height: altura };
  const desloc: CSSProperties | undefined = deslocamento
    ? { transform: `translateY(${superior ? -deslocamento : deslocamento}px)` }
    : undefined;

  const conteudo = (
    <>
      {superior && label}
      <svg viewBox={`${x0} 0 ${f.w} 80`} style={estilo} overflow="visible" aria-hidden="true">
        <defs>
          {/* Esmalte: borda incisal translúcida → marfim → colo amarelado */}
          <linearGradient id={id('esm')} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={f.anterior ? '#e3ebee' : '#f5efe3'} />
            <stop offset="16%" stopColor="#fbf8f0" />
            <stop offset="55%" stopColor="#f8f0de" />
            <stop offset="100%" stopColor="#e6d1a6" />
          </linearGradient>
          {/* Volume: laterais sombreadas */}
          <linearGradient id={id('vol')} x1="0" y1="0" x2="1" y2="0">
            <stop offset="0%" stopColor="#7a5c33" stopOpacity="0.34" />
            <stop offset="24%" stopColor="#7a5c33" stopOpacity="0" />
            <stop offset="70%" stopColor="#7a5c33" stopOpacity="0" />
            <stop offset="100%" stopColor="#7a5c33" stopOpacity="0.42" />
          </linearGradient>
          <linearGradient id={id('raiz')} x1="0" y1="0" x2="1" y2="0">
            <stop offset="0%" stopColor="#d9c08f" />
            <stop offset="45%" stopColor="#efdfbd" />
            <stop offset="100%" stopColor="#cfb27c" />
          </linearGradient>
          {/* Gengiva: rosada na margem, sumindo em direção à raiz */}
          <linearGradient id={id('geng')} x1="0" y1="0" x2="0" y2="1">
            <stop offset="28%" stopColor="#ef9aa3" />
            <stop offset="60%" stopColor="#e7838e" stopOpacity="0.92" />
            <stop offset="100%" stopColor="#de7581" stopOpacity="0" />
          </linearGradient>
          <linearGradient id={id('met')} x1="0" y1="0" x2="1" y2="0">
            <stop offset="0%" stopColor="#5b6472" />
            <stop offset="40%" stopColor="#eef1f5" />
            <stop offset="62%" stopColor="#b7bfca" />
            <stop offset="100%" stopColor="#3f4652" />
          </linearGradient>
          <linearGradient id={id('ouro')} x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor="#fff6d0" />
            <stop offset="45%" stopColor="#f6cf6a" />
            <stop offset="100%" stopColor="#c88a1c" />
          </linearGradient>
          <linearGradient id={id('vidro')} x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor="#f0faff" stopOpacity="0.95" />
            <stop offset="100%" stopColor="#a5dcf7" stopOpacity="0.8" />
          </linearGradient>
          <radialGradient id={id('resina')} cx="0.35" cy="0.35" r="0.8">
            <stop offset="0%" stopColor="#93c5fd" />
            <stop offset="100%" stopColor="#1d4ed8" />
          </radialGradient>
          <filter id={id('brilho')} x="-50%" y="-50%" width="200%" height="200%">
            <feGaussianBlur stdDeviation="1.1" />
          </filter>
          <clipPath id={id('coroa')}><path d={f.coroa} /></clipPath>
        </defs>

        <g transform={espelho}>
          {/* 1. Gengiva (atrás) */}
          <path d={`${margem} L${xr + 3} 80 L${x0 - 3} 80 Z`} fill={`url(#${id('geng')})`} />

          <g opacity={extraido ? 0.22 : 1}>
            {/* 2. Raízes por baixo da gengiva (ou o parafuso do implante) */}
            {temImplante ? (
              <g>
                <path d="M14.4 35 L25.6 35 L24.2 69 Q20 76 15.8 69 Z" fill={`url(#${id('met')})`} stroke="#3f4652" strokeWidth="0.5" />
                {[39, 43.5, 48, 52.5, 57, 61.5, 66].map((y) => (
                  <path key={y} d={`M14.6 ${y} Q20 ${y - 2.2} 25.4 ${y - 2.6}`} stroke="#323844" strokeWidth="0.85" fill="none" opacity="0.65" />
                ))}
                <rect x="15.6" y="29.5" width="8.8" height="6" rx="1.4" fill={`url(#${id('met')})`} stroke="#4b5563" strokeWidth="0.5" />
              </g>
            ) : (
              f.raizes.map((d, i) => (
                <path key={i} d={d} fill={`url(#${id('raiz')})`} stroke="#b89a64" strokeWidth="0.5" opacity={temCanal ? 0.75 : 0.3} />
              ))
            )}
            {temCanal && (
              <g stroke="#dc2626" strokeWidth="1.6" fill="none" strokeLinecap="round">
                {forma === 'molar' ? (
                  <>
                    <path d="M14 33 C13 45 12.5 58 12.6 66" />
                    <path d="M26 33 C27 45 27.5 58 27.4 66" />
                  </>
                ) : (
                  <path d="M20 33 C20 48 20 62 20 70" />
                )}
              </g>
            )}

            {/* 3. Coroa em camadas */}
            <path d={f.coroa} fill={`url(#${id('esm')})`} />
            <g clipPath={`url(#${id('coroa')})`}>
              <rect x="0" y="0" width="40" height="40" fill={`url(#${id('vol')})`} />
              {!f.anterior && <rect x="0" y="0" width="40" height="6.5" fill="#cdb98f" opacity="0.28" />}
              {f.sulcos.map((d, i) => (
                <path key={i} d={d} stroke="#d8c59c" strokeWidth="0.7" fill="none" opacity="0.7" />
              ))}
              {temCanal && <ellipse cx="20" cy="27" rx={forma === 'molar' ? 9 : 5} ry="4.5" fill="#fca5a5" opacity="0.55" />}
            </g>
            <path d={f.coroa} fill="none" stroke="#c8b285" strokeWidth="0.55" strokeLinejoin="round" />

            {/* Coroa protética: cerâmica/ouro brilhante cobrindo a coroa */}
            {tipos.has('coroa') && (
              <g>
                <path d={f.coroa} fill={`url(#${id('ouro')})`} />
                <path d={f.coroa} fill={`url(#${id('vol')})`} />
                <path d={f.coroa} fill="none" stroke="#b7791f" strokeWidth="0.9" />
              </g>
            )}

            {/* Faceta / lente: lâmina de vidro na frente da coroa */}
            {tipos.has('faceta') && (
              <g clipPath={`url(#${id('coroa')})`}>
                <rect x="0" y="0" width="40" height="29" fill={`url(#${id('vidro')})`} />
                <path d="M0 29 Q20 31 40 29" stroke="#0ea5e9" strokeWidth="1" fill="none" />
              </g>
            )}
            {tipos.has('faceta') && <path d={f.coroa} fill="none" stroke="#38bdf8" strokeWidth="0.9" />}

            {/* Restauração: resina azul na face oclusal / incisal */}
            {tipos.has('restauracao') && (
              <g>
                <ellipse cx={ox} cy={oy + 4} rx={forma === 'molar' ? 8 : 5.2} ry="3.8" fill={`url(#${id('resina')})`} />
                <ellipse cx={ox - 1.6} cy={oy + 2.8} rx="1.4" ry="0.8" fill="#fff" opacity="0.8" />
              </g>
            )}

            {/* Clareamento: coroa mais branca */}
            {tipos.has('clareamento') && <path d={f.coroa} fill="#ffffff" opacity="0.5" />}

            {/* Brilho do esmalte (suave, desfocado) */}
            <ellipse
              cx={20 - f.w * 0.18}
              cy="13"
              rx="2.2"
              ry="7"
              fill="#ffffff"
              opacity={tipos.has('coroa') ? 0.55 : 0.75}
              filter={`url(#${id('brilho')})`}
            />

            {/* Aparelho: bráquete metálico + fio */}
            {tipos.has('ortodontia') && (
              <g>
                <path d="M-4 17 L44 17" stroke="#8b95a3" strokeWidth="1.1" />
                <rect x="14.5" y="12.5" width="11" height="9" rx="1.8" fill={`url(#${id('met')})`} stroke="#4b5563" strokeWidth="0.7" />
                <path d="M14.5 17 L25.5 17" stroke="#4b5563" strokeWidth="0.7" />
              </g>
            )}

            {/* Selecionado: coroa âmbar */}
            {selecionado && (
              <path d={f.coroa} fill="#fbbf24" fillOpacity="0.3" stroke="#d97706" strokeWidth="1.8" strokeLinejoin="round" />
            )}
          </g>

          {/* 4. Margem da gengiva POR CIMA do colo (papilas entre os dentes) */}
          <path d={`${margem} L${xr + 3} 37 L${x0 - 3} 37 Z`} fill="#ef9aa3" />
          <path d={margem} stroke="#f7c6cb" strokeWidth="1.1" fill="none" />
          {tipos.has('limpeza') && (
            <path d={margem} stroke="#16a34a" strokeWidth="1.8" fill="none" strokeLinecap="round" />
          )}

          {/* Outro: ponto na cor da marca */}
          {tipos.has('outro') && <circle cx="20" cy="17" r="3.4" fill="#7c3aed" stroke="#fff" strokeWidth="1" />}
        </g>

        {/* Clareamento: brilhos (fora do espelho, sempre pra cima) */}
        {tipos.has('clareamento') && (
          <g fill="#facc15">
            <path d={`M${xr - 4} ${superior ? 62 : 4} l1 2.4 2.4 1 -2.4 1 -1 2.4 -1 -2.4 -2.4 -1 2.4 -1 z`} />
          </g>
        )}

        {/* Extração: X vermelho por cima */}
        {extraido && (
          <g stroke="#dc2626" strokeWidth="2.6" strokeLinecap="round">
            <path d={`M${x0 + 4} ${superior ? 46 : 4} L${xr - 4} ${superior ? 76 : 34}`} />
            <path d={`M${xr - 4} ${superior ? 46 : 4} L${x0 + 4} ${superior ? 76 : 34}`} />
          </g>
        )}
      </svg>
      {!superior && label}
    </>
  );

  const classe = `flex flex-col items-center gap-1 ${
    onClick ? (disabled ? 'cursor-not-allowed' : 'cursor-pointer transition-transform hover:scale-[1.06]') : ''
  }`;
  return onClick ? (
    <button
      type="button"
      onClick={disabled ? undefined : onClick}
      disabled={disabled}
      title={titulo}
      aria-label={titulo}
      className={classe}
      style={desloc}
    >
      {conteudo}
    </button>
  ) : (
    <div title={titulo} className={classe} style={desloc}>{conteudo}</div>
  );
}

/** Legenda: só os tipos que aparecem no odontograma, com os dentes de cada um. */
export function LegendaMarcas({ porDente }: { porDente: Map<string, MarcaDente[]> }) {
  const grupos = new Map<MarcaTipo, string[]>();
  for (const [fdi, marcas] of porDente) {
    for (const m of marcas) {
      const l = grupos.get(m.tipo) ?? [];
      if (!l.includes(fdi)) l.push(fdi);
      grupos.set(m.tipo, l);
    }
  }
  if (grupos.size === 0) return null;
  return (
    <div className="flex flex-wrap justify-center gap-1.5 pt-1">
      {[...grupos.entries()].map(([tipo, dentes]) => (
        <span
          key={tipo}
          className="inline-flex items-center gap-1.5 rounded-full border border-border bg-background px-2.5 py-1 text-[11px] text-foreground"
        >
          <span className="h-2.5 w-2.5 rounded-full" style={{ background: MARCAS[tipo].cor }} />
          <strong className="font-semibold">{MARCAS[tipo].label}</strong>
          <span className="text-muted-foreground tabular-nums">{dentes.sort().join(', ')}</span>
        </span>
      ))}
    </div>
  );
}

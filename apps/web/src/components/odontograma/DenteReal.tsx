'use client';

/**
 * Out/2026 — Dente realista do odontograma (pedido do dono: "mais real e aparecer
 * os procedimentos — implante, facetas...").
 *
 * - Formato pelo TIPO do dente (FDI): incisivo central/lateral, canino,
 *   pré-molar, molar — coroa com esmalte + raízes. Decíduos usam os mesmos
 *   formatos (o 4 e o 5 de leite são molares).
 * - Desenhado com a coroa pra CIMA (arcada inferior); o superior é espelhado na
 *   vertical, então as coroas das duas arcadas se encontram no meio, como na boca.
 * - O procedimento aparece NO dente: implante (parafuso no lugar da raiz),
 *   faceta, coroa, canal, restauração, extração, limpeza, clareamento e aparelho.
 *   A classificação é pelo NOME do procedimento (e pela especialidade, se o nome
 *   não disser) — cada clínica cadastra os seus.
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

// Coordenadas num quadro 40×80 (coroa em cima, colo em y=32, raízes embaixo).
// `w` = largura útil (o viewBox recorta o centro), pra cada tipo ter a largura real.
const FORMAS: Record<Forma, { w: number; coroa: string; raizes: string[]; oclusal: [number, number] }> = {
  central: {
    w: 30,
    coroa: 'M12 32 C10 24 8 15 8 9 Q8 3.5 13 3.5 L27 3.5 Q32 3.5 32 9 C32 15 30 24 28 32 Z',
    raizes: ['M12 32 C12 50 16.5 71 20 76 C23.5 71 28 50 28 32 Z'],
    oclusal: [20, 7],
  },
  lateral: {
    w: 26,
    coroa: 'M13.5 32 C11.5 24 9.5 15 9.5 9.5 Q9.5 4.5 14 4.5 L26 4.5 Q30.5 4.5 30.5 9.5 C30.5 15 28.5 24 26.5 32 Z',
    raizes: ['M13.5 32 C13.5 49 17 68 20 72 C23 68 26.5 49 26.5 32 Z'],
    oclusal: [20, 8],
  },
  canino: {
    w: 30,
    coroa: 'M12 32 C9 25 7 17 8.5 11 C10 6.5 15 2.5 20 1.5 C25 2.5 30 6.5 31.5 11 C33 17 31 25 28 32 Z',
    raizes: ['M12 32 C12 53 16.5 76 20 79 C23.5 76 28 53 28 32 Z'],
    oclusal: [20, 6],
  },
  premolar: {
    w: 32,
    coroa: 'M11 32 C8 26 6 18 6.5 12 C7 6.5 10 4 13.5 4 C16 4 17.5 6.5 20 6.5 C22.5 6.5 24 4 26.5 4 C30 4 33 6.5 33.5 12 C34 18 32 26 29 32 Z',
    raizes: ['M12 32 C12 50 16 70 20 74 C24 70 28 50 28 32 Z'],
    oclusal: [20, 9],
  },
  molar: {
    w: 40,
    coroa: 'M7 32 C3.5 26 2 17 3 11 C4 5.5 7.5 3.5 10.5 3.5 C13.5 3.5 14.5 6.5 16.5 6.5 C18.5 6.5 19.5 3.5 22.5 3.5 C25.5 3.5 25.5 6.5 27.5 6.5 C29.5 6.5 30.5 3.5 32 3.5 C36 3.5 38 7 37.5 12 C37 18 36 26 33 32 Z',
    raizes: [
      'M7.5 31 C6.5 45 8.5 62 11.5 70 C13.5 73 16.5 68 16.5 60 C16.5 50 17.5 40 18.5 33 Z',
      'M21.5 33 C22.5 40 23.5 50 23.5 60 C23.5 68 26.5 73 28.5 70 C31.5 62 33.5 45 32.5 31 Z',
    ],
    oclusal: [20, 9],
  },
};

const ALTURA_PADRAO = 76;

export interface DenteRealProps {
  fdi: string;
  /** Arcada superior: desenha espelhado (coroa pra baixo). */
  superior: boolean;
  marcas?: MarcaDente[];
  /** Selecionado pro procedimento ativo (brilho âmbar). */
  selecionado?: boolean;
  /** Altura do desenho em px (a largura sai do tipo do dente). */
  altura?: number;
  onClick?: () => void;
  disabled?: boolean;
  title?: string;
  /** Número do dente: 'fora' = acima no superior / abaixo no inferior. */
  numero?: 'fora' | 'nenhum';
}

export function DenteReal({
  fdi, superior, marcas = [], selecionado = false, altura = ALTURA_PADRAO,
  onClick, disabled = false, title, numero = 'fora',
}: DenteRealProps) {
  const uid = useId().replace(/[^a-zA-Z0-9_-]/g, '');
  const forma = formaDoDente(fdi);
  const f = FORMAS[forma];
  const tipos = new Set(marcas.map((m) => m.tipo));
  const temImplante = tipos.has('implante');
  const extraido = tipos.has('extracao');
  const largura = Math.round((altura * f.w) / 80);
  const x0 = (40 - f.w) / 2;
  const [ox, oy] = f.oclusal;

  const esmalte = `esm-${uid}`;
  const raiz = `raiz-${uid}`;
  const metal = `met-${uid}`;
  const recorte = `rec-${uid}`;
  const gengivaId = `geng-${uid}`;

  const titulo = title ?? (marcas.length
    ? `Dente ${fdi} — ${marcas.map((m) => m.nome).join(' · ')}`
    : `Dente ${fdi}`);

  const label = numero === 'fora' && (
    <span
      className={`text-[10px] font-bold leading-none tabular-nums ${
        selecionado ? 'text-amber-600' : marcas.length ? 'text-foreground' : 'text-muted-foreground'
      }`}
    >
      {fdi}
    </span>
  );

  // Selecionado: a COROA fica âmbar (o brilho em volta pegaria a gengiva junto).
  const estilo: CSSProperties = { width: largura, height: altura };

  const classe = `flex flex-col items-center gap-1 ${
    onClick ? (disabled ? 'cursor-not-allowed' : 'cursor-pointer transition-transform hover:-translate-y-0.5') : ''
  }`;
  const conteudo = (
    <>
      {superior && label}
      <svg viewBox={`${x0} 0 ${f.w} 80`} style={estilo} overflow="visible" aria-hidden="true">
        <defs>
          <linearGradient id={esmalte} x1="0" y1="0" x2="1" y2="0">
            <stop offset="0%" stopColor="#e9dfcb" />
            <stop offset="38%" stopColor="#fffdf7" />
            <stop offset="70%" stopColor="#f8f2e6" />
            <stop offset="100%" stopColor="#ddd0b6" />
          </linearGradient>
          <linearGradient id={raiz} x1="0" y1="0" x2="1" y2="0">
            <stop offset="0%" stopColor="#dcc69c" />
            <stop offset="45%" stopColor="#f1e3c4" />
            <stop offset="100%" stopColor="#d4bb8d" />
          </linearGradient>
          <linearGradient id={metal} x1="0" y1="0" x2="1" y2="0">
            <stop offset="0%" stopColor="#6b7280" />
            <stop offset="45%" stopColor="#e5e7eb" />
            <stop offset="100%" stopColor="#4b5563" />
          </linearGradient>
          <clipPath id={recorte}><path d={f.coroa} /></clipPath>
          <linearGradient id={gengivaId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#f4b3b8" />
            <stop offset="100%" stopColor="#e98d96" />
          </linearGradient>
        </defs>

        {/* Gengiva: faixa rosada atrás das raízes (passa um pouco das bordas pra
            emendar com o dente vizinho e formar a arcada). As raízes ficam
            "dentro" dela (meio transparentes). */}
        <g transform={superior ? 'matrix(1 0 0 -1 0 80)' : undefined}>
          <path
            d={`M${x0 - 3} 27 Q20 41 ${x0 + f.w + 3} 27 L${x0 + f.w + 3} 80 L${x0 - 3} 80 Z`}
            fill={`url(#${gengivaId})`}
          />
        </g>

        <g transform={superior ? 'matrix(1 0 0 -1 0 80)' : undefined} opacity={extraido ? 0.38 : 1}>
          {/* Raízes (ou o parafuso do implante no lugar delas) */}
          {temImplante ? (
            <g>
              <path d="M14.5 34 L25.5 34 L24 70 Q20 76 16 70 Z" fill={`url(#${metal})`} stroke="#4b5563" strokeWidth="0.6" />
              {[38, 43, 48, 53, 58, 63, 68].map((y) => (
                <path key={y} d={`M14.6 ${y} L25.4 ${y - 2.6}`} stroke="#374151" strokeWidth="0.9" opacity="0.7" />
              ))}
              <rect x="16" y="30" width="8" height="5" rx="1" fill="#cbd5e1" stroke="#64748b" strokeWidth="0.5" />
            </g>
          ) : (
            f.raizes.map((d, i) => (
              <path key={i} d={d} fill={`url(#${raiz})`} stroke="#c2a878" strokeWidth="0.6" strokeLinejoin="round" opacity="0.5" />
            ))
          )}

          {/* Canal: câmara pulpar + condutos em vermelho */}
          {tipos.has('canal') && !temImplante && (
            <g stroke="#dc2626" strokeWidth="1.5" fill="none" strokeLinecap="round">
              {forma === 'molar' ? (
                <>
                  <path d="M14 33 C13 45 12.5 58 12.5 66" />
                  <path d="M26 33 C27 45 27.5 58 27.5 66" />
                </>
              ) : (
                <path d="M20 33 C20 48 20 62 20 70" />
              )}
            </g>
          )}

          {/* Coroa (esmalte) */}
          <path d={f.coroa} fill={`url(#${esmalte})`} stroke="#cdbb97" strokeWidth="0.7" strokeLinejoin="round" />
          {tipos.has('canal') && !temImplante && (
            <ellipse cx="20" cy="25" rx={forma === 'molar' ? 8 : 4.5} ry="4" fill="#fecaca" stroke="#dc2626" strokeWidth="1.1" />
          )}

          {/* Coroa protética: cerâmica dourada clara cobrindo a coroa */}
          {tipos.has('coroa') && (
            <g clipPath={`url(#${recorte})`}>
              <rect x="0" y="0" width="40" height="33" fill="#fde68a" opacity="0.75" />
              <path d="M0 29 L40 29" stroke="#d97706" strokeWidth="2.2" />
            </g>
          )}
          {tipos.has('coroa') && <path d={f.coroa} fill="none" stroke="#d97706" strokeWidth="1.3" />}

          {/* Faceta / lente: lâmina perolada na face da coroa */}
          {tipos.has('faceta') && (
            <g clipPath={`url(#${recorte})`}>
              <rect x="0" y="0" width="40" height="27" fill="#e0f2fe" opacity="0.85" />
              <path d="M11 4 C11.5 12 12.5 19 14 26" stroke="#ffffff" strokeWidth="2.2" opacity="0.9" fill="none" />
              <path d="M0 27 L40 27" stroke="#0ea5e9" strokeWidth="1.2" />
            </g>
          )}
          {tipos.has('faceta') && <path d={f.coroa} fill="none" stroke="#0ea5e9" strokeWidth="1.1" />}

          {/* Restauração: mancha azul na face oclusal / incisal */}
          {tipos.has('restauracao') && (
            <ellipse cx={ox} cy={oy + 4} rx={forma === 'molar' ? 8 : 5} ry="3.6" fill="#2563eb" opacity="0.85" />
          )}

          {/* Brilho do esmalte */}
          {!tipos.has('coroa') && (
            <ellipse cx={20 - f.w * 0.2} cy="14" rx="1.8" ry="6.5" fill="#ffffff" opacity="0.65" />
          )}

          {/* Clareamento: coroa mais branca + brilhos */}
          {tipos.has('clareamento') && (
            <g>
              <path d={f.coroa} fill="#ffffff" opacity="0.55" />
              <path d="M30 6 l1 2.4 2.4 1 -2.4 1 -1 2.4 -1 -2.4 -2.4 -1 2.4 -1 z" fill="#facc15" />
            </g>
          )}

          {/* Aparelho: bráquete + fio */}
          {tipos.has('ortodontia') && (
            <g>
              <path d="M0 17 L40 17" stroke="#64748b" strokeWidth="1.1" />
              <rect x="15" y="13" width="10" height="8" rx="1.5" fill="#cbd5e1" stroke="#475569" strokeWidth="0.9" />
            </g>
          )}

          {/* Limpeza / gengiva: linha verde no colo do dente */}
          {tipos.has('limpeza') && (
            <path d="M2 33.5 Q8 30.5 14 33.5 T26 33.5 T38 33.5" stroke="#16a34a" strokeWidth="1.8" fill="none" strokeLinecap="round" />
          )}

          {/* Outro: ponto na cor da marca */}
          {tipos.has('outro') && <circle cx="20" cy="18" r="3.4" fill="#7c3aed" stroke="#fff" strokeWidth="1" />}

          {/* Selecionado pro procedimento ativo: coroa contornada em âmbar */}
          {selecionado && (
            <path d={f.coroa} fill="#fbbf24" fillOpacity="0.28" stroke="#d97706" strokeWidth="2" strokeLinejoin="round" />
          )}

          {/* Contorno do colo (junção esmalte-raiz) */}
          {!temImplante && <path d={`M${x0 + 4} 32 Q20 34 ${x0 + f.w - 4} 32`} stroke="#cdb78d" strokeWidth="0.5" fill="none" />}
        </g>

        {/* Extração: X vermelho por cima (fora do espelhamento, sempre igual) */}
        {extraido && (
          <g stroke="#dc2626" strokeWidth="2.6" strokeLinecap="round">
            <path d={`M${x0 + 3} 10 L${x0 + f.w - 3} 70`} />
            <path d={`M${x0 + f.w - 3} 10 L${x0 + 3} 70`} />
          </g>
        )}
      </svg>
      {!superior && label}
    </>
  );
  return onClick ? (
    <button type="button" onClick={disabled ? undefined : onClick} disabled={disabled} title={titulo} aria-label={titulo} className={classe}>
      {conteudo}
    </button>
  ) : (
    <div title={titulo} className={classe}>{conteudo}</div>
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

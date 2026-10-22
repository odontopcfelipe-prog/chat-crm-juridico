'use client';

/**
 * Out/2026 — Odontograma realista (pedidos do dono: "mais real e aparecer os
 * procedimentos", "mais bonito e mais realista", "visual semelhante à foto" —
 * a prancha clássica: fundo vinho, faixa de gengiva vermelha ondulada, coroas
 * brancas, raízes cor de pele e os números na faixa branca entre as arcadas).
 *
 * - DenteReal: formato pelo TIPO do dente (FDI) — incisivo central/lateral,
 *   canino, pré-molar, molar — com coroa branca (volume e brilho), raízes e a
 *   linha rosada do colo. Superior espelhado; molares mais afastados do meio
 *   (curva do sorriso) com os números alinhados na faixa do meio.
 * - ArcoFundo: o painel vinho com a gengiva ondulada atrás de cada arcada.
 * - O procedimento aparece NO dente: implante (parafuso no lugar da raiz),
 *   faceta, coroa, canal, restauração, extração, limpeza, clareamento e
 *   aparelho — classificado pelo NOME (e pela especialidade, se o nome não
 *   disser); cada clínica cadastra os seus.
 * - ResumoProcedimentos: a soma ao lado ("10 implantes, 8 restaurações...").
 */
import { useId, type CSSProperties } from 'react';

export type MarcaTipo =
  | 'implante' | 'faceta' | 'coroa' | 'canal' | 'restauracao'
  | 'extracao' | 'limpeza' | 'clareamento' | 'ortodontia' | 'outro'
  // Estados clínicos do odontograma da ficha (o que o dente TEM, não o que vai fazer).
  | 'carie' | 'fratura' | 'ausente';

export const MARCAS: Record<MarcaTipo, { label: string; plural: string; cor: string }> = {
  implante:    { label: 'Implante',           plural: 'Implantes',            cor: '#64748b' },
  faceta:      { label: 'Faceta / lente',     plural: 'Facetas / lentes',     cor: '#0ea5e9' },
  coroa:       { label: 'Coroa / prótese',    plural: 'Coroas / próteses',    cor: '#d97706' },
  canal:       { label: 'Canal',              plural: 'Canais',               cor: '#dc2626' },
  restauracao: { label: 'Restauração',        plural: 'Restaurações',         cor: '#2563eb' },
  extracao:    { label: 'Extração',           plural: 'Extrações',            cor: '#b91c1c' },
  limpeza:     { label: 'Limpeza / gengiva',  plural: 'Limpezas / gengiva',   cor: '#16a34a' },
  clareamento: { label: 'Clareamento',        plural: 'Clareamentos',         cor: '#ca8a04' },
  ortodontia:  { label: 'Aparelho',           plural: 'Aparelhos',            cor: '#475569' },
  outro:       { label: 'Outro procedimento', plural: 'Outros procedimentos', cor: '#7c3aed' },
  carie:       { label: 'Cárie',              plural: 'Cáries',               cor: '#7c4a1e' },
  fratura:     { label: 'Fratura',            plural: 'Fraturas',             cor: '#be185d' },
  ausente:     { label: 'Ausente',            plural: 'Ausentes',             cor: '#9ca3af' },
};

/** Estado anotado no odontograma da ficha (ToothRecord.state) → marca do dente. */
export function marcaDoEstadoClinico(estado: string): MarcaTipo {
  switch (estado) {
    case 'CARIE': return 'carie';
    case 'RESTAURADO': return 'restauracao';
    case 'AUSENTE': return 'ausente';
    case 'PROTESE':
    case 'COROA': return 'coroa';
    case 'IMPLANTE': return 'implante';
    case 'ENDODONTIA': return 'canal';
    case 'EXTRACAO_INDICADA': return 'extracao';
    case 'FRATURA': return 'fratura';
    default: return 'outro';
  }
}

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
  // "Faceta de resina" / "coroa de resina" é faceta / coroa — não restauração.
  if (/restaur|obtura|amalgam/.test(n) || (/resina/.test(n) && !out.has('faceta') && !out.has('coroa'))) {
    out.add('restauracao');
  }
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

// Coordenadas num quadro 40×80 (coroa em cima, colo em y≈33, raízes embaixo).
// `w` = largura útil (o viewBox recorta o centro) — cada tipo com a largura real.
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
/** Altura (px) da faixa do número — o ArcoFundo não pinta essa parte. */
export const ALTURA_NUMERO = 28;
/** Onde o fundo vinho termina, contado da borda do número: sobra uma faixa
 *  vermelha de 8px entre a ponta dos dentes e a borda (como na prancha). */
export const RECUO_FUNDO = ALTURA_NUMERO - 8;

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
  /** Número do dente na faixa do MEIO (entre as arcadas), ou sem número. */
  numero?: 'meio' | 'nenhum';
  /** Curva do sorriso (molares mais longe do meio). Desligada: o dono quer tudo alinhado. */
  curva?: boolean;
}

export function DenteReal({
  fdi, superior, marcas = [], selecionado = false, altura = ALTURA_PADRAO,
  onClick, disabled = false, title, numero = 'meio', curva = false,
}: DenteRealProps) {
  const uid = useId().replace(/[^a-zA-Z0-9_-]/g, '');
  const forma = formaDoDente(fdi);
  const f = FORMAS[forma];
  const tipos = new Set(marcas.map((m) => m.tipo));
  const temImplante = tipos.has('implante');
  const temCanal = tipos.has('canal') && !temImplante;
  const extraido = tipos.has('extracao');
  const ausente = tipos.has('ausente');
  const largura = Math.round((altura * f.w) / 80);
  const x0 = (40 - f.w) / 2;
  const xr = x0 + f.w;
  const [ox, oy] = f.oclusal;
  const deslocamento = curva ? Math.round((CURVA[Number(fdi[1])] ?? 0) * (altura / ALTURA_PADRAO)) : 0;

  const id = (n: string) => `${n}-${uid}`;
  const espelho = superior ? 'matrix(1 0 0 -1 0 80)' : undefined;
  // Linha rosada do colo (junção coroa-raiz), como na prancha.
  const colo = `M${x0 + 1.5} 33 Q20 36.5 ${xr - 1.5} 33`;

  const titulo = title ?? (marcas.length
    ? `Dente ${fdi} — ${marcas.map((m) => m.nome).join(' · ')}`
    : `Dente ${fdi}`);

  const label = numero === 'meio' && (
    <span
      className={`flex items-center justify-center rounded-full px-1.5 text-[12.5px] font-semibold leading-none tabular-nums ${
        selecionado
          ? 'bg-amber-500 text-white'
          : marcas.length ? 'font-extrabold text-foreground' : 'text-foreground/70'
      }`}
      style={{ height: 18, minWidth: 22 }}
    >
      {fdi}
    </span>
  );

  // A curva mexe só no DESENHO — os números ficam alinhados na faixa do meio.
  const estilo: CSSProperties = {
    width: largura,
    height: altura,
    transform: deslocamento ? `translateY(${superior ? -deslocamento : deslocamento}px)` : undefined,
    filter: 'drop-shadow(0 1.5px 1.5px rgba(40, 0, 8, 0.28))',
  };

  const conteudo = (
    <>
      {!superior && label}
      <svg viewBox={`${x0} 0 ${f.w} 80`} style={estilo} overflow="visible" aria-hidden="true">
        <defs>
          {/* Coroa branca: brilho em cima, cinza frio perto do colo */}
          <linearGradient id={id('esm')} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={f.anterior ? '#f3f6f8' : '#fbfcfd'} />
            <stop offset="35%" stopColor="#ffffff" />
            <stop offset="78%" stopColor="#eef1f4" />
            <stop offset="100%" stopColor="#d9dee5" />
          </linearGradient>
          {/* Volume: laterais em cinza frio */}
          <linearGradient id={id('vol')} x1="0" y1="0" x2="1" y2="0">
            <stop offset="0%" stopColor="#5c6878" stopOpacity="0.26" />
            <stop offset="26%" stopColor="#5c6878" stopOpacity="0" />
            <stop offset="66%" stopColor="#5c6878" stopOpacity="0" />
            <stop offset="100%" stopColor="#5c6878" stopOpacity="0.36" />
          </linearGradient>
          {/* Raiz cor de pele (pêssego) */}
          <linearGradient id={id('raiz')} x1="0" y1="0" x2="1" y2="0">
            <stop offset="0%" stopColor="#efb98c" />
            <stop offset="45%" stopColor="#fbd8b4" />
            <stop offset="100%" stopColor="#e9ab7b" />
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
            <stop offset="100%" stopColor="#a5dcf7" stopOpacity="0.85" />
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
          <g opacity={ausente ? 0.12 : extraido ? 0.25 : 1}>
            {/* Raízes (ou o parafuso do implante no lugar delas) */}
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
                <path key={i} d={d} fill={`url(#${id('raiz')})`} stroke="#dc9c6c" strokeWidth="0.45" strokeLinejoin="round" />
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

            {/* Coroa branca em camadas */}
            <path d={f.coroa} fill={`url(#${id('esm')})`} />
            <g clipPath={`url(#${id('coroa')})`}>
              <rect x="0" y="0" width="40" height="40" fill={`url(#${id('vol')})`} />
              {!f.anterior && <rect x="0" y="0" width="40" height="6.5" fill="#c9d1db" opacity="0.32" />}
              {f.sulcos.map((d, i) => (
                <path key={i} d={d} stroke="#d3dae3" strokeWidth="0.7" fill="none" opacity="0.8" />
              ))}
              {temCanal && <ellipse cx="20" cy="27" rx={forma === 'molar' ? 9 : 5} ry="4.5" fill="#fca5a5" opacity="0.55" />}
            </g>
            <path d={f.coroa} fill="none" stroke="#c4ccd6" strokeWidth="0.5" strokeLinejoin="round" />

            {/* Coroa protética: ouro/cerâmica brilhante */}
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

            {/* Cárie: mancha escura na face oclusal / incisal */}
            {tipos.has('carie') && (
              <g>
                <ellipse cx={ox + 1} cy={oy + 5} rx={forma === 'molar' ? 6.5 : 4.2} ry="3.4" fill="#b45309" opacity="0.35" />
                <path
                  d={`M${ox - 2.6} ${oy + 4.4} q1.2 -2.2 3 -1.2 q2 -1 2.6 1 q0.8 2 -1 2.8 q-1.6 1.2 -3.2 0.2 q-1.8 -0.8 -1.4 -2.8 z`}
                  fill="#3f2410"
                  opacity="0.9"
                />
              </g>
            )}

            {/* Fratura: trinca em zigue-zague na coroa */}
            {tipos.has('fratura') && (
              <path
                d={`M${x0 + 5} 6 L${20 - 2} 13 L${20 + 2} 16 L${20 - 1} 22 L${xr - 6} 27`}
                stroke="#9f1239"
                strokeWidth="1.3"
                fill="none"
                strokeLinejoin="round"
                strokeLinecap="round"
              />
            )}

            {/* Restauração: resina azul na face oclusal / incisal */}
            {tipos.has('restauracao') && (
              <g>
                <ellipse cx={ox} cy={oy + 4} rx={forma === 'molar' ? 8 : 5.2} ry="3.8" fill={`url(#${id('resina')})`} />
                <ellipse cx={ox - 1.6} cy={oy + 2.8} rx="1.4" ry="0.8" fill="#fff" opacity="0.8" />
              </g>
            )}

            {/* Brilho do esmalte (suave, desfocado) */}
            <ellipse
              cx={20 - f.w * 0.18}
              cy="13"
              rx="2.2"
              ry="7"
              fill="#ffffff"
              opacity={tipos.has('coroa') ? 0.55 : 0.9}
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

            {/* Linha rosada do colo (ou verde, quando tem limpeza/gengiva) */}
            {!temImplante && (
              <path
                d={colo}
                stroke={tipos.has('limpeza') ? '#16a34a' : '#ea8f9a'}
                strokeWidth={tipos.has('limpeza') ? 2 : 0.9}
                fill="none"
                strokeLinecap="round"
              />
            )}

            {/* Selecionado: coroa âmbar */}
            {selecionado && (
              <path d={f.coroa} fill="#fbbf24" fillOpacity="0.32" stroke="#d97706" strokeWidth="1.8" strokeLinejoin="round" />
            )}
          </g>

          {/* Outro: ponto na cor da marca */}
          {tipos.has('outro') && <circle cx="20" cy="17" r="3.4" fill="#7c3aed" stroke="#fff" strokeWidth="1" />}
        </g>

        {/* Clareamento: brilho (fora do espelho) */}
        {tipos.has('clareamento') && (
          <path
            d={`M${xr - 4} ${superior ? 62 : 4} l1 2.4 2.4 1 -2.4 1 -1 2.4 -1 -2.4 -2.4 -1 2.4 -1 z`}
            fill="#facc15"
          />
        )}

        {/* Extração: X vermelho por cima da coroa */}
        {extraido && (
          <g stroke="#ff4d5e" strokeWidth="2.6" strokeLinecap="round">
            <path d={`M${x0 + 4} ${superior ? 46 : 4} L${xr - 4} ${superior ? 76 : 34}`} />
            <path d={`M${xr - 4} ${superior ? 46 : 4} L${x0 + 4} ${superior ? 76 : 34}`} />
          </g>
        )}
      </svg>
      {superior && label}
    </>
  );

  // gap-2.5 (10px) entre o dente e o número = ALTURA_NUMERO (18 + 10).
  const classe = `flex flex-col items-center gap-2.5 ${
    onClick ? (disabled ? 'cursor-not-allowed' : 'cursor-pointer transition-transform hover:scale-[1.06]') : ''
  }`;
  return onClick ? (
    <button type="button" onClick={disabled ? undefined : onClick} disabled={disabled} title={titulo} aria-label={titulo} className={classe}>
      {conteudo}
    </button>
  ) : (
    <div title={titulo} className={classe}>{conteudo}</div>
  );
}

/**
 * Fundo da arcada (como na prancha): painel vinho e a faixa de gengiva vermelha
 * ondulada onde ficam as coroas. Fica atrás da fileira (posição absoluta) e
 * não pinta a faixa do número (lado do meio).
 */
export function ArcoFundo({ superior, ondas = 16 }: { superior: boolean; ondas?: number }) {
  const uid = useId().replace(/[^a-zA-Z0-9_-]/g, '');
  // Faixa da gengiva: metade de baixo (superior) / de cima (inferior), com onda.
  const base = superior ? 50 : 50;
  const passo = 100 / ondas;
  let onda = `M0 ${base}`;
  for (let i = 0; i < ondas; i++) {
    const x = i * passo;
    onda += ` Q${(x + passo / 2).toFixed(2)} ${base + (i % 2 ? 6 : -6)} ${(x + passo).toFixed(2)} ${base}`;
  }
  const banda = superior ? `${onda} L100 100 L0 100 Z` : `${onda} L100 0 L0 0 Z`;
  return (
    <div
      aria-hidden="true"
      className="pointer-events-none absolute inset-x-0 overflow-hidden rounded-2xl"
      style={superior ? { top: 0, bottom: RECUO_FUNDO } : { top: RECUO_FUNDO, bottom: 0 }}
    >
      <svg className="h-full w-full" viewBox="0 0 100 100" preserveAspectRatio="none">
        <defs>
          <linearGradient id={`fundo-${uid}`} x1="0" y1={superior ? 0 : 1} x2="0" y2={superior ? 1 : 0}>
            <stop offset="0%" stopColor="#a65662" />
            <stop offset="100%" stopColor="#8f3f4b" />
          </linearGradient>
          <linearGradient id={`banda-${uid}`} x1="0" y1={superior ? 0 : 1} x2="0" y2={superior ? 1 : 0}>
            <stop offset="0%" stopColor="#8a0b20" />
            <stop offset="100%" stopColor="#b3162f" />
          </linearGradient>
        </defs>
        <rect width="100" height="100" fill={`url(#fundo-${uid})`} />
        <path d={banda} fill={`url(#banda-${uid})`} />
        <path d={onda} fill="none" stroke="#6d0717" strokeWidth="1.4" vectorEffect="non-scaling-stroke" opacity="0.8" />
        <path d={onda} fill="none" stroke="#d9707e" strokeWidth="0.8" vectorEffect="non-scaling-stroke" opacity="0.5" transform={`translate(0 ${superior ? -1.2 : 1.2})`} />
      </svg>
    </div>
  );
}

export interface ItemResumo {
  nome: string;
  especialidade?: string | null;
  /** Dentes do procedimento (cada dente conta 1). */
  dentes: string[];
  /** Sem dente (ex.: clareamento da boca toda): conta a quantidade. */
  qtd?: number;
}

/**
 * Resumo ao lado: a soma POR ITEM (procedimento como está cadastrado) — pedido do
 * dono: "separe por itens". Somar por TIPO contava duas vezes o que é um item só
 * ("coroa sobre implante" = a coroa em cima e o implante embaixo, 1 procedimento).
 * Mesmo procedimento em vários dentes vira uma linha com a soma.
 */
export function ResumoProcedimentos({ itens, className = '' }: { itens: ItemResumo[]; className?: string }) {
  const por = new Map<string, { nome: string; tipos: MarcaTipo[]; n: number; dentes: Set<string> }>();
  const todosDentes = new Set<string>();
  let total = 0;
  for (const it of itens) {
    const n = it.dentes.length || Math.max(1, it.qtd ?? 1);
    total += n;
    it.dentes.forEach((d) => todosDentes.add(d));
    const chave = sem(it.nome).trim();
    const g = por.get(chave) ?? {
      nome: it.nome,
      tipos: classificarProcedimento(it.nome, it.especialidade),
      n: 0,
      dentes: new Set<string>(),
    };
    g.n += n;
    it.dentes.forEach((d) => g.dentes.add(d));
    por.set(chave, g);
  }
  const linhas = [...por.values()].sort((a, b) => b.n - a.n || a.nome.localeCompare(b.nome));
  return (
    <aside className={`rounded-2xl border border-border bg-background p-3 ${className}`}>
      <p className="mb-1 text-[11px] font-bold uppercase tracking-wider text-muted-foreground">Resumo do plano</p>
      {linhas.length === 0 ? (
        <p className="py-2 text-xs leading-snug text-muted-foreground">
          Os procedimentos que você marcar aparecem somados aqui.
        </p>
      ) : (
        <>
          <ul className="max-h-[230px] divide-y divide-border overflow-y-auto">
            {linhas.map((g) => (
              <li key={g.nome} className="flex items-center gap-2.5 py-1.5">
                <span className="w-8 shrink-0 text-right text-xl font-extrabold tabular-nums" style={{ color: MARCAS[g.tipos[0]].cor }}>
                  {g.n}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-start gap-1.5">
                    <span className="mt-[5px] flex shrink-0 gap-0.5">
                      {g.tipos.map((t) => (
                        <span key={t} className="h-2 w-2 rounded-full" style={{ background: MARCAS[t].cor }} title={MARCAS[t].label} />
                      ))}
                    </span>
                    <span className="line-clamp-2 text-[13px] font-semibold leading-tight text-foreground" title={g.nome}>{g.nome}</span>
                  </span>
                  {g.dentes.size > 0 && (
                    <span className="block truncate text-[10.5px] tabular-nums text-muted-foreground" title={[...g.dentes].sort().join(', ')}>
                      {g.dentes.size === 1 ? 'Dente ' : 'Dentes '}{[...g.dentes].sort().join(', ')}
                    </span>
                  )}
                </span>
              </li>
            ))}
          </ul>
          <p className="mt-2 border-t border-border pt-2 text-[11px] text-muted-foreground">
            <strong className="text-foreground">{total}</strong> procedimento{total === 1 ? '' : 's'}
            {' · '}
            <strong className="text-foreground">{todosDentes.size}</strong> dente{todosDentes.size === 1 ? '' : 's'}
          </p>
        </>
      )}
    </aside>
  );
}

// Quadrantes FDI na ordem de leitura (paciente de frente).
const QUADRANTES = {
  adulto: {
    supDir: ['18', '17', '16', '15', '14', '13', '12', '11'],
    supEsq: ['21', '22', '23', '24', '25', '26', '27', '28'],
    infDir: ['48', '47', '46', '45', '44', '43', '42', '41'],
    infEsq: ['31', '32', '33', '34', '35', '36', '37', '38'],
  },
  infantil: {
    supDir: ['55', '54', '53', '52', '51'],
    supEsq: ['61', '62', '63', '64', '65'],
    infDir: ['85', '84', '83', '82', '81'],
    infEsq: ['71', '72', '73', '74', '75'],
  },
};

/**
 * Prancha completa (as duas arcadas no fundo vinho) pra reaproveitar fora da
 * avaliação — venda rápida (seleciona dentes) e visão geral da ficha (só mostra).
 * `onToggle` presente = dentes clicáveis.
 */
export function OdontogramaPrancha({
  infantil = false,
  marcas,
  selecionados,
  onToggle,
  altura = ALTURA_PADRAO,
  titulo,
}: {
  infantil?: boolean;
  marcas?: Map<string, MarcaDente[]>;
  selecionados?: Set<string>;
  onToggle?: (fdi: string) => void;
  altura?: number;
  titulo?: (fdi: string) => string | undefined;
}) {
  const q = infantil ? QUADRANTES.infantil : QUADRANTES.adulto;
  const gap = altura < 60 ? 'gap-0.5' : 'gap-1';
  const linha = (lista: string[], superior: boolean) => (
    <div className={`flex ${gap} ${superior ? 'items-end pt-2' : 'items-start pb-2'}`}>
      {lista.map((fdi) => (
        <DenteReal
          key={fdi}
          fdi={fdi}
          superior={superior}
          marcas={marcas?.get(fdi) ?? []}
          selecionado={selecionados?.has(fdi) ?? false}
          altura={altura}
          onClick={onToggle ? () => onToggle(fdi) : undefined}
          title={titulo?.(fdi)}
        />
      ))}
    </div>
  );
  return (
    <div className="inline-flex flex-col">
      <div className="relative px-2">
        <ArcoFundo superior />
        <div className="relative flex justify-center gap-1.5">
          {linha(q.supDir, true)}
          <div className="w-px self-stretch bg-white/45" style={{ marginBottom: RECUO_FUNDO }} />
          {linha(q.supEsq, true)}
        </div>
      </div>
      <div className="mx-2 h-px bg-border" />
      <div className="relative px-2">
        <ArcoFundo superior={false} />
        <div className="relative flex justify-center gap-1.5">
          {linha(q.infDir, false)}
          <div className="w-px self-stretch bg-white/45" style={{ marginTop: RECUO_FUNDO }} />
          {linha(q.infEsq, false)}
        </div>
      </div>
    </div>
  );
}

/** Legenda compacta (chips) — usada no mini-odontograma do card. */
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

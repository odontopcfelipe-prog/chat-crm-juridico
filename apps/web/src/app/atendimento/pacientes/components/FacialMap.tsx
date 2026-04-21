'use client';

import { useState } from 'react';

/**
 * Mapa facial com 30 pontos padronizados de aplicacao estetica.
 * Os codigos batem 1:1 com `EstheticApplication.application_point` no schema.
 *
 * Uso:
 *   <FacialMap onPointClick={(point) => setSelected(point)} highlighted={['GLABELA']} />
 */

export interface FacialPoint {
  code: string;
  label: string;
  cx: number;
  cy: number;
  side?: 'D' | 'E' | 'C'; // Direita, Esquerda, Central (auto)
}

// 30 pontos. Coordenadas em viewBox 0 0 400 540.
export const FACIAL_POINTS: FacialPoint[] = [
  { code: 'FRONTAL',          label: 'Frontal',         cx: 200, cy: 110, side: 'C' },
  { code: 'GLABELA',          label: 'Glabela',         cx: 200, cy: 160, side: 'C' },
  { code: 'SUPRACILIAR_DIR',  label: 'Supraciliar D',   cx: 170, cy: 170, side: 'D' },
  { code: 'SUPRACILIAR_ESQ',  label: 'Supraciliar E',   cx: 230, cy: 170, side: 'E' },
  { code: 'PE_DE_GALINHA_DIR',label: 'Pe-de-galinha D', cx: 115, cy: 200, side: 'D' },
  { code: 'PE_DE_GALINHA_ESQ',label: 'Pe-de-galinha E', cx: 285, cy: 200, side: 'E' },
  { code: 'TEMPORAL_DIR',     label: 'Temporal D',      cx: 70,  cy: 170, side: 'D' },
  { code: 'TEMPORAL_ESQ',     label: 'Temporal E',      cx: 330, cy: 170, side: 'E' },
  { code: 'NASAL_DORSO',      label: 'Dorso nasal',     cx: 200, cy: 215, side: 'C' },
  { code: 'BUNNY_LINES',      label: 'Bunny lines',     cx: 175, cy: 235, side: 'C' },
  { code: 'PONTA_NASAL',      label: 'Ponta nasal',     cx: 200, cy: 270, side: 'C' },
  { code: 'MALAR_DIR',        label: 'Malar D',         cx: 130, cy: 260, side: 'D' },
  { code: 'MALAR_ESQ',        label: 'Malar E',         cx: 270, cy: 260, side: 'E' },
  { code: 'MASSETER_DIR',     label: 'Masseter D',      cx: 95,  cy: 330, side: 'D' },
  { code: 'MASSETER_ESQ',     label: 'Masseter E',      cx: 305, cy: 330, side: 'E' },
  { code: 'NASOLABIAL_DIR',   label: 'Nasolabial D',    cx: 170, cy: 300, side: 'D' },
  { code: 'NASOLABIAL_ESQ',   label: 'Nasolabial E',    cx: 230, cy: 300, side: 'E' },
  { code: 'LABIO_SUPERIOR',   label: 'Labio superior',  cx: 200, cy: 325, side: 'C' },
  { code: 'LABIO_INFERIOR',   label: 'Labio inferior',  cx: 200, cy: 360, side: 'C' },
  { code: 'COMISSURA_DIR',    label: 'Comissura D',     cx: 168, cy: 343, side: 'D' },
  { code: 'COMISSURA_ESQ',    label: 'Comissura E',     cx: 232, cy: 343, side: 'E' },
  { code: 'MARIONETE_DIR',    label: 'Marionete D',     cx: 165, cy: 380, side: 'D' },
  { code: 'MARIONETE_ESQ',    label: 'Marionete E',     cx: 235, cy: 380, side: 'E' },
  { code: 'MENTO',            label: 'Mento',           cx: 200, cy: 410, side: 'C' },
  { code: 'MANDIBULA_DIR',    label: 'Mandibula D',     cx: 125, cy: 415, side: 'D' },
  { code: 'MANDIBULA_ESQ',    label: 'Mandibula E',     cx: 275, cy: 415, side: 'E' },
  { code: 'PESCOCO',          label: 'Pescoco',         cx: 200, cy: 460, side: 'C' },
  { code: 'PLATISMA',         label: 'Platisma',        cx: 175, cy: 480, side: 'C' },
  { code: 'COLO',             label: 'Colo',            cx: 200, cy: 510, side: 'C' },
  { code: 'OUTRO',            label: 'Outro',           cx: 365, cy: 525, side: 'C' },
];

interface Props {
  onPointClick?: (point: FacialPoint) => void;
  /** Pontos com aplicacao recente — desenhados preenchidos */
  highlighted?: string[];
  /** Pontos selecionados no momento (formulario aberto) — borda mais grossa */
  selected?: string[];
  /** Mapa code->count: mostra badge numerico (historico de aplicacoes) */
  pointCounts?: Record<string, number>;
  /** Tamanho relativo do componente */
  className?: string;
}

export function FacialMap({
  onPointClick,
  highlighted = [],
  selected = [],
  pointCounts = {},
  className = 'w-full max-w-[400px] mx-auto',
}: Props) {
  const [hover, setHover] = useState<FacialPoint | null>(null);

  return (
    <div className={className}>
      <svg
        viewBox="0 0 400 540"
        className="w-full h-auto"
        xmlns="http://www.w3.org/2000/svg"
      >
        {/* Contorno do rosto (estilizado) */}
        <ellipse
          cx="200"
          cy="270"
          rx="135"
          ry="180"
          fill="var(--bg-secondary, #f5f5f5)"
          stroke="var(--border-default, #e0e0e0)"
          strokeWidth="1.5"
        />

        {/* Pescoco */}
        <path
          d="M 155,420 Q 155,470 145,510 L 255,510 Q 245,470 245,420 Z"
          fill="var(--bg-secondary, #f5f5f5)"
          stroke="var(--border-default, #e0e0e0)"
          strokeWidth="1.5"
        />

        {/* Colo */}
        <path
          d="M 110,505 L 290,505 L 320,540 L 80,540 Z"
          fill="var(--bg-secondary, #f5f5f5)"
          stroke="var(--border-default, #e0e0e0)"
          strokeWidth="1.5"
        />

        {/* Sobrancelhas */}
        <path d="M 145,165 Q 170,158 195,165" stroke="var(--text-muted, #777)" strokeWidth="2.5" fill="none" strokeLinecap="round" />
        <path d="M 205,165 Q 230,158 255,165" stroke="var(--text-muted, #777)" strokeWidth="2.5" fill="none" strokeLinecap="round" />

        {/* Olhos */}
        <ellipse cx="170" cy="190" rx="14" ry="6" fill="white" stroke="var(--text-muted, #777)" strokeWidth="1" />
        <ellipse cx="230" cy="190" rx="14" ry="6" fill="white" stroke="var(--text-muted, #777)" strokeWidth="1" />
        <circle cx="170" cy="190" r="3" fill="var(--text-primary, #333)" />
        <circle cx="230" cy="190" r="3" fill="var(--text-primary, #333)" />

        {/* Nariz */}
        <path d="M 200,200 Q 195,235 188,265 Q 200,275 212,265 Q 205,235 200,200" stroke="var(--text-muted, #777)" strokeWidth="1.5" fill="none" strokeLinejoin="round" />

        {/* Boca */}
        <path d="M 175,335 Q 200,345 225,335 Q 200,355 175,335" stroke="var(--text-muted, #777)" strokeWidth="1.5" fill="var(--bg-tertiary, #eee)" strokeLinejoin="round" />

        {/* Linha do queixo (sutil) */}
        <path d="M 125,400 Q 200,440 275,400" stroke="var(--text-muted, #999)" strokeWidth="1" fill="none" strokeDasharray="2,2" opacity="0.5" />

        {/* Pontos de aplicacao */}
        {FACIAL_POINTS.map((point) => {
          const isHover = hover?.code === point.code;
          const isSelected = selected.includes(point.code);
          const isHighlighted = highlighted.includes(point.code);
          const count = pointCounts[point.code] || 0;

          const r = isHover ? 11 : isSelected ? 10 : 8;
          const strokeWidth = isSelected ? 3 : 1.5;
          const fill = isHighlighted ? 'var(--accent-primary, #f58220)' : isHover ? 'var(--accent-primary, #f58220)' : 'white';
          const stroke = isHighlighted || isSelected ? 'var(--accent-primary, #f58220)' : 'var(--text-muted, #777)';

          return (
            <g key={point.code}>
              <circle
                cx={point.cx}
                cy={point.cy}
                r={r}
                fill={fill}
                stroke={stroke}
                strokeWidth={strokeWidth}
                style={{ cursor: 'pointer', transition: 'all 0.15s ease' }}
                onMouseEnter={() => setHover(point)}
                onMouseLeave={() => setHover(null)}
                onClick={() => onPointClick?.(point)}
              />
              {count > 0 && (
                <text
                  x={point.cx}
                  y={point.cy + 3}
                  textAnchor="middle"
                  fontSize="10"
                  fontWeight="700"
                  fill={isHighlighted ? 'white' : 'var(--text-primary, #333)'}
                  style={{ pointerEvents: 'none' }}
                >
                  {count}
                </text>
              )}
            </g>
          );
        })}

        {/* Tooltip do hover */}
        {hover && (
          <g style={{ pointerEvents: 'none' }}>
            <rect
              x={Math.min(hover.cx + 14, 260)}
              y={hover.cy - 22}
              width={Math.max(hover.label.length * 7 + 12, 80)}
              height="22"
              rx="4"
              fill="var(--text-primary, #333)"
              opacity="0.92"
            />
            <text
              x={Math.min(hover.cx + 14, 260) + 6}
              y={hover.cy - 7}
              fontSize="11"
              fontWeight="600"
              fill="white"
            >
              {hover.label}
            </text>
          </g>
        )}
      </svg>

      {/* Legenda compacta */}
      <div className="mt-3 flex items-center justify-center gap-4 text-xs text-muted-foreground">
        <span className="flex items-center gap-1.5">
          <span className="inline-block w-3 h-3 rounded-full bg-white border border-current" />
          Disponivel
        </span>
        <span className="flex items-center gap-1.5">
          <span className="inline-block w-3 h-3 rounded-full bg-primary" />
          Com aplicacao
        </span>
      </div>
    </div>
  );
}

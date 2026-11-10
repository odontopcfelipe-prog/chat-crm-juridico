'use client';

/**
 * Passos CAD — a arcada clicável da ficha do caso. A imagem é a arcada que o dono escolheu
 * (public/passos-cad/arcada.png); por cima dela, cada dente tem o contorno dele
 * (mapa-da-arcada.ts), que é a área do clique e do destaque. Cada dente funciona no teclado.
 */
import { DENTES_DA_IMAGEM, ALTURA_DA_IMAGEM, LARGURA_DA_IMAGEM } from './mapa-da-arcada';
import { TEXTOS as T } from './textos';

/** O dente escolhido fica tingido na cor principal sem apagar os traços da imagem (multiplica). */
const ESTILO = `
.passos-cad-dente { fill: transparent; cursor: pointer; mix-blend-mode: multiply; transition: fill .15s; outline: none; }
.passos-cad-dente:hover { fill: color-mix(in srgb, var(--color-primary) 16%, transparent); }
.passos-cad-dente:focus-visible { stroke: var(--color-primary); stroke-width: 2.5px; stroke-dasharray: 4 3; }
.passos-cad-dente[aria-pressed='true'] { fill: color-mix(in srgb, var(--color-primary) 30%, transparent); stroke: var(--color-primary); stroke-width: 2.5px; }
.passos-cad-dente[aria-disabled='true'] { cursor: default; pointer-events: none; }
`;

export function Odontograma({ selecionado, travado, aoEscolher }: { selecionado: number | null; travado: boolean; aoEscolher: (fdi: number) => void }) {
  return (
    <div
      className={`relative ${travado ? 'opacity-60' : ''}`}
      style={{ width: `min(100cqw, ${(LARGURA_DA_IMAGEM / ALTURA_DA_IMAGEM) * 100}cqh)`, aspectRatio: `${LARGURA_DA_IMAGEM} / ${ALTURA_DA_IMAGEM}` }}
      data-testid="arcada"
    >
      {/* eslint-disable-next-line @next/next/no-img-element -- imagem estática da arcada, com o mapa de clique por cima */}
      <img src="/passos-cad/arcada.png" alt="" draggable={false} className="absolute inset-0 w-full h-full select-none pointer-events-none" />
      <svg viewBox={`0 0 ${LARGURA_DA_IMAGEM} ${ALTURA_DA_IMAGEM}`} className="absolute inset-0 w-full h-full" role="group" aria-label={T.fichaDenteSel}>
        <style>{ESTILO}</style>
        {DENTES_DA_IMAGEM.map((d) => (
          <path
            key={d.fdi}
            d={d.contorno}
            role="button"
            tabIndex={travado ? -1 : 0}
            data-testid={`dente-${d.fdi}`}
            aria-label={`${T.fichaDenteSel} ${d.fdi}`}
            aria-pressed={selecionado === d.fdi}
            aria-disabled={travado}
            className="passos-cad-dente"
            vectorEffect="non-scaling-stroke"
            onClick={() => !travado && aoEscolher(d.fdi)}
            onKeyDown={(e) => {
              if (travado || (e.key !== 'Enter' && e.key !== ' ')) return;
              e.preventDefault();
              aoEscolher(d.fdi);
            }}
          />
        ))}
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center text-center pointer-events-none">
        {selecionado ? (
          <>
            <span className="text-2xl font-light text-foreground" data-testid="dente-escolhido">{`${T.fichaDenteSel} ${selecionado}`}</span>
            <span className="text-xs text-muted-foreground">{T.fichaCoroa}</span>
          </>
        ) : (
          <span className="text-sm text-muted-foreground max-w-[9rem]">{T.fichaEscolhaDente}</span>
        )}
      </div>
    </div>
  );
}

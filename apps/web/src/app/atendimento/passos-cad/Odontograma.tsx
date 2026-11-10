'use client';

/**
 * Passos CAD — a arcada clicável da ficha do caso. Cada dente é um botão de verdade: funciona no
 * teclado, e o clique só vale sobre o desenho do dente, não no canto da caixa dele.
 */
import { useMemo } from 'react';
import { ALTURA_DO_ARCO, FORMA_DO_DENTE, LARGURA_DO_ARCO, dentesDoArco } from './arco-dos-dentes';
import { TEXTOS as T } from './textos';

export function Odontograma({ selecionado, travado, aoEscolher }: { selecionado: number | null; travado: boolean; aoEscolher: (fdi: number) => void }) {
  const dentes = useMemo(dentesDoArco, []);
  return (
    <div className="relative" style={{ width: `min(100cqw, ${(LARGURA_DO_ARCO / ALTURA_DO_ARCO) * 100}cqh)`, aspectRatio: `${LARGURA_DO_ARCO} / ${ALTURA_DO_ARCO}` }} data-testid="arcada">
      {dentes.map((d) => {
        const forma = FORMA_DO_DENTE[d.tipo];
        const escolhido = selecionado === d.fdi;
        return (
          <button
            key={d.fdi}
            type="button"
            data-testid={`dente-${d.fdi}`}
            aria-label={`${T.fichaDenteSel} ${d.fdi}`}
            aria-pressed={escolhido}
            disabled={travado}
            onClick={() => aoEscolher(d.fdi)}
            className="group absolute pointer-events-none flex items-center justify-center rounded-full focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary disabled:opacity-60"
            style={{
              left: `${(d.x / LARGURA_DO_ARCO) * 100}%`,
              top: `${(d.y / ALTURA_DO_ARCO) * 100}%`,
              width: `${(d.largura / LARGURA_DO_ARCO) * 100}%`,
              height: `${(d.altura / ALTURA_DO_ARCO) * 100}%`,
              transform: 'translate(-50%, -50%)',
            }}
          >
            <svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true" className="absolute inset-0 w-full h-full overflow-visible" style={{ transform: `rotate(${d.rotacao}deg)` }}>
              {/* Odontograma em traço: dente cinza-claro, contorno escuro e sulcos finos. */}
              <path
                d={forma.contorno}
                strokeWidth={escolhido ? 2.4 : 1.5}
                vectorEffect="non-scaling-stroke"
                className={`transition-colors ${travado ? '' : 'cursor-pointer'} ${escolhido ? '' : 'fill-[#cfcfcf] stroke-[#3d3d3d] group-hover:fill-[#e2e2e2]'}`}
                style={{ pointerEvents: 'auto', ...(escolhido ? { fill: 'color-mix(in srgb, var(--color-primary) 30%, #e6e6e6)', stroke: 'var(--color-primary)' } : {}) }}
              />
              <path d={forma.sulcos} fill="none" stroke="#3d3d3d" strokeOpacity={0.9} strokeWidth={1.1} strokeLinecap="round" vectorEffect="non-scaling-stroke" />
            </svg>
            <span className={`relative text-[11px] font-semibold leading-none select-none ${escolhido ? 'text-primary' : 'text-neutral-800'}`}>{d.fdi}</span>
          </button>
        );
      })}
      <div className="absolute inset-0 flex flex-col items-center justify-center text-center pointer-events-none">
        {selecionado ? (
          <>
            <span className="text-2xl font-light text-foreground" data-testid="dente-escolhido">{`${T.fichaDenteSel} ${selecionado}`}</span>
            <span className="text-xs text-muted-foreground">{T.fichaCoroa}</span>
          </>
        ) : (
          <span className="text-sm text-muted-foreground max-w-[10rem]">{T.fichaEscolhaDente}</span>
        )}
      </div>
    </div>
  );
}

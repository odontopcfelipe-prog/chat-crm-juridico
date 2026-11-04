'use client';

/** Passos CAD — campos usados em mais de uma etapa. */
import { useEffect, useState, type ReactNode } from 'react';
import { MAIOR_BROCA, normalizarBroca } from './motor/fresa';

const CHAVE_DA_BROCA = 'passos-cad-diametro-broca';

/** Cada fresadora tem a sua broca: fica lembrada neste navegador, para não digitar em todo caso. */
export function brocaLembrada(padrao: number): number {
  try {
    return normalizarBroca(window.localStorage.getItem(CHAVE_DA_BROCA) ?? '') ?? padrao;
  } catch {
    return padrao;
  }
}

function lembrarBroca(v: number): void {
  try {
    window.localStorage.setItem(CHAVE_DA_BROCA, String(v));
  } catch {
    // Sem armazenamento, só não fica lembrada.
  }
}

/**
 * Diâmetro da broca. Apagar o campo para redigitar não pode virar 0: isso desligaria a compensação
 * em todos os casos seguintes, sem aviso. Só vale o número completo, e só fica lembrado ao sair.
 */
export const CampoDeBroca = ({ valor, aoMudar, className, testid, travado }: { valor: number; aoMudar: (v: number) => void; className: string; testid?: string; travado?: boolean }) => {
  const [texto, setTexto] = useState(String(valor));
  useEffect(() => setTexto(String(valor)), [valor]);
  return (
    <input
      type="number"
      data-testid={testid}
      className={className}
      min={0}
      max={MAIOR_BROCA}
      step={0.05}
      disabled={travado}
      value={texto}
      onChange={(e) => {
        setTexto(e.target.value);
        const v = normalizarBroca(e.target.value);
        if (v !== null) aoMudar(v);
      }}
      onBlur={() => {
        setTexto(String(valor));
        lembrarBroca(valor);
      }}
    />
  );
};

export const Campo = ({ rotulo, ajuda, children }: { rotulo: string; ajuda?: string; children: ReactNode }) => (
  <label className="block">
    <span className="block text-xs font-semibold text-foreground mb-1">{rotulo}</span>
    {children}
    {ajuda && <span className="block text-[11px] text-muted-foreground mt-1">{ajuda}</span>}
  </label>
);

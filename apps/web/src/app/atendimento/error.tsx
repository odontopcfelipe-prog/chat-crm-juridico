'use client';

import { useEffect, useState } from 'react';

export default function AtendimentoError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const [showDetails, setShowDetails] = useState(false);

  useEffect(() => {
    // Stack completo no console pra debug — abrir DevTools (F12) pra ver
    console.error('[Atendimento] Erro capturado pelo Error Boundary:', error);
    console.error('[Atendimento] Stack:', error?.stack);
    if (error?.digest) console.error('[Atendimento] Digest:', error.digest);
  }, [error]);

  return (
    <div className="flex items-center justify-center min-h-screen bg-background p-4">
      <div className="text-center p-8 max-w-2xl w-full">
        <div className="text-5xl mb-4">&#9888;&#65039;</div>
        <h2 className="text-xl font-semibold mb-2 text-foreground">Algo deu errado</h2>
        <p className="text-muted-foreground mb-4">
          Ocorreu um erro inesperado no atendimento. Tente recarregar a pagina.
        </p>

        {/* Mensagem do erro sempre visivel — ajuda a diagnosticar
            sem precisar abrir DevTools. */}
        {error?.message && (
          <div className="mb-4 px-4 py-3 rounded-lg bg-destructive/10 border border-destructive/20 text-left">
            <p className="text-xs font-mono text-destructive break-words">
              <strong>Erro:</strong> {error.message}
            </p>
            {error.digest && (
              <p className="text-[10px] font-mono text-muted-foreground mt-1">
                Digest: {error.digest}
              </p>
            )}
          </div>
        )}

        <div className="flex gap-3 justify-center mb-4">
          <button
            onClick={reset}
            className="px-6 py-2.5 bg-primary text-white rounded-lg hover:bg-primary/90 transition font-medium"
          >
            Tentar novamente
          </button>
          <button
            onClick={() => window.location.reload()}
            className="px-6 py-2.5 border border-border text-foreground rounded-lg hover:bg-muted transition font-medium"
          >
            Recarregar pagina
          </button>
        </div>

        {/* Stack tecnico expansivel — pra reportar o bug */}
        {error?.stack && (
          <button
            onClick={() => setShowDetails((v) => !v)}
            className="text-xs text-muted-foreground hover:text-foreground underline"
          >
            {showDetails ? 'Ocultar' : 'Mostrar'} detalhes tecnicos
          </button>
        )}
        {showDetails && error?.stack && (
          <pre className="mt-3 p-3 rounded-lg bg-muted border border-border text-[10px] font-mono text-left text-foreground/80 overflow-auto max-h-64 whitespace-pre-wrap break-words">
            {error.stack}
          </pre>
        )}
      </div>
    </div>
  );
}

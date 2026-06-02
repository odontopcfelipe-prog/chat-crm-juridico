'use client';

/**
 * Wrapper que carrega o ChatClient com SSR DESABILITADO.
 *
 * Por que? A ChatClient (1271 linhas) usa useState lazy init lendo
 * localStorage, useSocket via context, e re-renderiza pesadamente
 * conforme socket recebe eventos. Em Next.js 16 + React 19, o
 * pre-render server-side desse componente "use client" gerava
 * Minified React #418 (hydration mismatch). Resultado: o React
 * descartava a hidratacao e o componente ficava em estado
 * inconsistente — sem mensagens, sem nome do paciente, sem
 * funcionar (era exatamente o bug que aparecia em /chat/[id]
 * standalone E nos iframes do split).
 *
 * Solucao: render 100% client-side via flag `mounted` + Suspense.
 * Equivalente em comportamento ao dynamic({ ssr: false }) sem
 * precisar mover pra um arquivo separado (next/dynamic so funciona
 * fora do app router).
 *
 * Onda 17.20.
 */

import { Suspense, useEffect, useState } from 'react';
import ChatClient from './ChatClient';

export default function ChatPage({ params }: { params: Promise<{ id: string }> }) {
  // mounted=false durante SSR + primeira pintura client. So apos
  // useEffect (puro client) o componente real renderiza.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  if (!mounted) {
    return (
      <div className="flex h-screen items-center justify-center text-muted-foreground text-sm">
        Carregando conversa…
      </div>
    );
  }

  return (
    <Suspense
      fallback={
        <div className="flex h-screen items-center justify-center text-muted-foreground text-sm">
          Carregando conversa…
        </div>
      }
    >
      <ChatClient params={params} />
    </Suspense>
  );
}

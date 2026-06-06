'use client';

import { ThemeProvider as NextThemesProvider } from 'next-themes';
import { ReactNode } from 'react';
import { VisualModeProvider } from '@/components/VisualModeProvider';

// Onda 17.32.101 — Default trocado de "noturno" pra "violet" pra
// unificar com a identidade do funil de venda (/lp, /cadastrar,
// /atendimento/login). "glacier" mantido na lista por compatibilidade
// com sessoes antigas — agora vira alias do violet (mesmo CSS).
export function Providers({ children }: { children: ReactNode }) {
  return (
    <NextThemesProvider
      attribute="data-theme"
      defaultTheme="violet"
      themes={['violet', 'noturno', 'cyber', 'glacier', 'coral']}
      enableSystem={false}
    >
      <VisualModeProvider>
        {children}
      </VisualModeProvider>
    </NextThemesProvider>
  );
}

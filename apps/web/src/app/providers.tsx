'use client';

import { ThemeProvider as NextThemesProvider } from 'next-themes';
import { ReactNode } from 'react';

export function Providers({ children }: { children: ReactNode }) {
  return (
    <NextThemesProvider
      attribute="data-theme"
      defaultTheme="escuro"
      themes={['escuro', 'claro', 'odonto', 'rose', 'vermelho', 'azul', 'verde', 'mint']}
      enableSystem={false}
    >
      {children}
    </NextThemesProvider>
  );
}

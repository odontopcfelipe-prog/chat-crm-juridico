'use client';

import { ThemeProvider as NextThemesProvider } from 'next-themes';
import { ReactNode } from 'react';
import { VisualModeProvider } from '@/components/VisualModeProvider';

export function Providers({ children }: { children: ReactNode }) {
  return (
    <NextThemesProvider
      attribute="data-theme"
      defaultTheme="noturno"
      themes={['noturno', 'cyber', 'glacier', 'coral']}
      enableSystem={false}
    >
      <VisualModeProvider>
        {children}
      </VisualModeProvider>
    </NextThemesProvider>
  );
}

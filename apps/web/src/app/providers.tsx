'use client';

import { ThemeProvider as NextThemesProvider } from 'next-themes';
import { ReactNode } from 'react';
import { VisualModeProvider } from '@/components/VisualModeProvider';

// Out/2026 — padrão = "whatsapp" (cores do WhatsApp Web claro), pedido do dono:
// "deixe a cor do sistema padronizada com a do WhatsApp original". A chave
// nova (`storageKey`) faz TODO MUNDO começar no WhatsApp uma vez — quem tinha
// violet/noturno salvo na chave antiga ("theme") cai no padrão; depois disso a
// escolha em Aparência volta a ser respeitada. "glacier" segue como alias do violet.
export function Providers({ children }: { children: ReactNode }) {
  return (
    <NextThemesProvider
      attribute="data-theme"
      defaultTheme="whatsapp"
      storageKey="theme-wa"
      themes={['whatsapp', 'violet', 'noturno', 'cyber', 'glacier', 'coral']}
      enableSystem={false}
    >
      <VisualModeProvider>
        {children}
      </VisualModeProvider>
    </NextThemesProvider>
  );
}

import type { Metadata } from 'next';
import { Ubuntu_Sans } from 'next/font/google';
import './globals.css';
import { Providers } from './providers';
import { GTMScript, GTMNoScript } from '@/components/GTMScript';
import { Toaster } from 'react-hot-toast';

const ubuntuSans = Ubuntu_Sans({
  subsets: ['latin'],
  variable: '--font-ubuntu',
});

export const metadata: Metadata = {
  title: 'Instituto Odonto Passos | Clínica Odontológica',
  description: 'Clínica odontológica especializada em atendimento personalizado e tratamentos modernos.',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="pt-BR" translate="no" suppressHydrationWarning className={ubuntuSans.variable}>
      <head>
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        {/* Desliga o Google Tradutor globalmente. Sistema interno em PT-BR
            nao precisa de traducao automatica, e o Tradutor causa crash
            tipo "removeChild/insertBefore on Node — no anterior nao eh filho
            deste no" ao trocar nodes de texto que o React e libs externas
            (schedule-x, day-pilot) gerenciam diretamente.
            Bug ref: facebook/react#11538. */}
        <meta name="google" content="notranslate" />
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link href="https://fonts.googleapis.com/css2?family=Inter:wght@100..900&display=swap" rel="stylesheet" />
        {/* Google Tag Manager */}
        <GTMScript />
      </head>
      <body className="font-sans antialiased text-foreground bg-background notranslate" translate="no">
        {/* GTM noscript fallback */}
        <GTMNoScript />
        <Providers>
          <Toaster position="top-right" toastOptions={{ style: { fontSize: '14px' } }} />
          <main className="min-h-screen flex flex-col">
            {children}
          </main>
        </Providers>
      </body>
    </html>
  );
}

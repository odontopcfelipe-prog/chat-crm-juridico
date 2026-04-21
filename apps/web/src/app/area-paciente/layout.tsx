'use client';

import { useEffect, useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import {
  Calendar, Wallet, FileText, Home, LogOut, Menu, X,
} from 'lucide-react';
import { clearPortalToken, getPortalToken } from '@/lib/portalApi';

const NAV_ITEMS = [
  { href: '/area-paciente', label: 'Início',       icon: Home },
  { href: '/area-paciente/agendamentos', label: 'Agendamentos', icon: Calendar },
  { href: '/area-paciente/parcelas',    label: 'Parcelas',     icon: Wallet },
  { href: '/area-paciente/anamnese',    label: 'Anamnese',     icon: FileText },
];

export default function PortalLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const [mounted, setMounted] = useState(false);
  const [open, setOpen] = useState(false);

  // Rotas publicas (auth) — nao exigem JWT
  const isPublic = pathname?.startsWith('/area-paciente/auth') || pathname === '/area-paciente/login';

  useEffect(() => {
    setMounted(true);
    if (isPublic) return;
    const token = getPortalToken();
    if (!token) router.replace('/area-paciente/login');
  }, [isPublic, router]);

  // Injeta manifest PWA + theme-color no head (uma vez)
  useEffect(() => {
    if (typeof document === 'undefined') return;
    const manifestId = 'manifest-area-paciente';
    if (!document.getElementById(manifestId)) {
      const link = document.createElement('link');
      link.id = manifestId;
      link.rel = 'manifest';
      link.href = '/manifest-area-paciente.json';
      document.head.appendChild(link);
    }
    const themeId = 'theme-color-area-paciente';
    if (!document.getElementById(themeId)) {
      const meta = document.createElement('meta');
      meta.id = themeId;
      meta.name = 'theme-color';
      meta.content = '#F58220';
      document.head.appendChild(meta);
    }
  }, []);

  if (!mounted) return null;
  if (isPublic) return <>{children}</>;

  const logout = () => {
    clearPortalToken();
    router.replace('/area-paciente/login');
  };

  return (
    <div className="min-h-screen bg-background flex flex-col">
      {/* Header */}
      <header className="bg-card border-b border-border sticky top-0 z-50">
        <div className="max-w-3xl mx-auto px-4 py-3 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-full bg-primary flex items-center justify-center text-primary-foreground font-bold text-sm">
              OP
            </div>
            <div>
              <h1 className="text-sm font-bold leading-tight">Portal do Paciente</h1>
              <p className="text-[10px] text-muted-foreground leading-tight">Instituto Odonto Passos</p>
            </div>
          </div>
          <button
            onClick={() => setOpen(!open)}
            className="md:hidden p-1.5 hover:bg-accent rounded"
          >
            {open ? <X size={18} /> : <Menu size={18} />}
          </button>
          <nav className="hidden md:flex items-center gap-1">
            {NAV_ITEMS.map((item) => {
              const Icon = item.icon;
              const active = pathname === item.href;
              return (
                <button
                  key={item.href}
                  onClick={() => router.push(item.href)}
                  className={`px-3 py-1.5 rounded text-sm font-medium flex items-center gap-1.5 ${
                    active ? 'bg-primary text-primary-foreground' : 'hover:bg-accent text-muted-foreground'
                  }`}
                >
                  <Icon size={14} />
                  {item.label}
                </button>
              );
            })}
            <button
              onClick={logout}
              className="ml-2 p-1.5 hover:bg-destructive/10 text-destructive rounded"
              title="Sair"
            >
              <LogOut size={16} />
            </button>
          </nav>
        </div>
        {/* Mobile menu */}
        {open && (
          <nav className="md:hidden border-t border-border">
            {NAV_ITEMS.map((item) => {
              const Icon = item.icon;
              const active = pathname === item.href;
              return (
                <button
                  key={item.href}
                  onClick={() => { setOpen(false); router.push(item.href); }}
                  className={`w-full text-left px-4 py-3 flex items-center gap-2 text-sm ${
                    active ? 'bg-primary/10 text-primary' : 'hover:bg-accent'
                  }`}
                >
                  <Icon size={16} />
                  {item.label}
                </button>
              );
            })}
            <button
              onClick={logout}
              className="w-full text-left px-4 py-3 flex items-center gap-2 text-sm text-destructive hover:bg-destructive/10"
            >
              <LogOut size={16} />
              Sair
            </button>
          </nav>
        )}
      </header>

      {/* Conteudo */}
      <main className="flex-1 max-w-3xl mx-auto w-full px-4 py-4 pb-20 md:pb-4">
        {children}
      </main>

      {/* Bottom nav (mobile) */}
      <nav className="md:hidden fixed bottom-0 inset-x-0 bg-card border-t border-border z-40">
        <div className="grid grid-cols-4 max-w-3xl mx-auto">
          {NAV_ITEMS.map((item) => {
            const Icon = item.icon;
            const active = pathname === item.href;
            return (
              <button
                key={item.href}
                onClick={() => router.push(item.href)}
                className={`flex flex-col items-center gap-0.5 py-2.5 text-[10px] ${
                  active ? 'text-primary' : 'text-muted-foreground'
                }`}
              >
                <Icon size={18} />
                {item.label}
              </button>
            );
          })}
        </div>
      </nav>
    </div>
  );
}

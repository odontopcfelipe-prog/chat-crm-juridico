'use client';

// Onda 17.50 — Menu de conta no topo (avatar + "Sair").
//
// Antes, o botão "Sair" e a identidade do usuário viviam DENTRO da barra
// lateral. Como a barra agora some pros papéis simples (só o Adm Geral
// mantém), o logout precisa estar SEMPRE acessível no header global —
// senão a recepção/dentista ficariam sem como deslogar. Este menu cobre
// isso pra todos os papéis (admin também ganha, é redundante mas inofensivo).

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { User, LogOut, ChevronDown } from 'lucide-react';

function readEmailFromToken(): string | null {
  if (typeof window === 'undefined') return null;
  try {
    const token = localStorage.getItem('token');
    if (!token) return null;
    const b64 = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    const payload = JSON.parse(atob(b64));
    return typeof payload?.email === 'string' ? payload.email : null;
  } catch {
    return null;
  }
}

export function AccountMenu() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => { setEmail(readEmailFromToken()); }, []);

  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, []);

  const initials = (email?.trim()?.slice(0, 2) || 'U').toUpperCase();

  const logout = () => {
    try { localStorage.removeItem('token'); } catch { /* noop */ }
    router.push('/atendimento/login');
  };

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center gap-1.5 h-10 pl-1 pr-2 rounded-xl text-foreground hover:bg-[var(--glass-bg)] hover:backdrop-blur-md transition-all"
        title="Conta"
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <span className="w-7 h-7 rounded-full bg-primary/15 text-primary text-[11px] font-bold flex items-center justify-center">
          {initials}
        </span>
        <ChevronDown size={14} className="text-muted-foreground" />
      </button>

      {open && (
        <div
          role="menu"
          className="absolute right-0 mt-1.5 w-56 bg-card border border-border rounded-xl shadow-xl z-[70] overflow-hidden"
        >
          <div className="flex items-center gap-2.5 px-3 py-3 border-b border-border">
            <span className="w-9 h-9 rounded-full bg-primary/15 text-primary text-xs font-bold flex items-center justify-center shrink-0">
              {initials}
            </span>
            <div className="min-w-0">
              <div className="text-xs font-medium text-foreground flex items-center gap-1">
                <User size={12} /> Minha conta
              </div>
              <div className="text-xs text-muted-foreground truncate">{email || '—'}</div>
            </div>
          </div>
          <button
            type="button"
            onClick={logout}
            className="w-full flex items-center gap-2.5 px-3 py-2.5 text-sm font-medium text-destructive hover:bg-destructive/10 transition-colors"
            role="menuitem"
          >
            <LogOut size={16} /> Sair
          </button>
        </div>
      )}
    </div>
  );
}

'use client';

// Onda 17.50 — Menu de conta no topo (avatar + "Sair").
//
// Antes, o botão "Sair" e a identidade do usuário viviam DENTRO da barra
// lateral. Como a barra agora some pros papéis simples (só o Adm Geral
// mantém), o logout precisa estar SEMPRE acessível no header global —
// senão a recepção/dentista ficariam sem como deslogar. Este menu cobre
// isso pra todos os papéis (admin também ganha, é redundante mas inofensivo).
//
// Onda 17.61 (FIX) — o dropdown era `position:absolute` DENTRO do header, que
// tem `backdrop-blur` (cria stacking context) e nenhum z-index. Resultado: o
// menu pintava ATRÁS do <main> (irmão posterior) → ninguém conseguia deslogar.
// Agora o dropdown vai num PORTAL (document.body) com posição fixed, igual ao
// ThemeMenuButton — escapa do stacking/clipping e SEMPRE aparece por cima.

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useRouter } from 'next/navigation';
import { User, LogOut, ChevronDown } from 'lucide-react';
import { clearSessionTraces } from '@/lib/api';

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

const MENU_W = 224; // w-56

export function AccountMenu() {
  const router = useRouter();
  const [mounted, setMounted] = useState(false);
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const [email, setEmail] = useState<string | null>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const popupRef = useRef<HTMLDivElement>(null);

  useEffect(() => setMounted(true), []);
  useEffect(() => { setEmail(readEmailFromToken()); }, []);

  // Fecha em click fora / ESC (cobre o popup no portal E o botão).
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (
        !popupRef.current?.contains(e.target as Node) &&
        !btnRef.current?.contains(e.target as Node)
      ) {
        setOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const initials = (email?.trim()?.slice(0, 2) || 'U').toUpperCase();

  const toggle = (e: React.MouseEvent) => {
    if (open) { setOpen(false); setPos(null); return; }
    const rect = e.currentTarget.getBoundingClientRect();
    const MARGIN = 8;
    setPos({
      top: rect.bottom + 6,
      left: Math.max(MARGIN, rect.right - MENU_W),
    });
    setEmail(readEmailFromToken());
    setOpen(true);
  };

  const logout = () => {
    try { localStorage.removeItem('token'); clearSessionTraces(); } catch { /* noop */ }
    setOpen(false);
    router.push('/atendimento/login');
  };

  return (
    <div className="relative">
      <button
        ref={btnRef}
        type="button"
        onClick={toggle}
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

      {mounted && open && pos && createPortal(
        <div
          ref={popupRef}
          role="menu"
          style={{ position: 'fixed', top: pos.top, left: pos.left, zIndex: 9999, width: MENU_W }}
          className="bg-card border border-border rounded-xl shadow-2xl overflow-hidden"
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
        </div>,
        document.body,
      )}
    </div>
  );
}

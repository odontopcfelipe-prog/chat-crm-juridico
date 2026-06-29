'use client';

/**
 * Onda 15.8 — Botao de Aparencia (tema + estilo) standalone pra usar no
 * header global. Antes a logica de popup vivia dentro da Sidebar; agora
 * fica num componente reutilizavel que pode ser colocado em qualquer
 * lugar (header, sidebar mobile, settings, etc).
 *
 * - Botao com icone Palette
 * - Click abre popover fixo (renderiza via createPortal) com:
 *   - Lista de 4 temas de COR (Noturno Gold, Cyber Violet, Glacier, Coral)
 *   - Toggle Classico/Futurista/Massinha (3 estilos visuais — Onda 14.56)
 *
 * Fecha automaticamente: click fora, ESC, scroll do body.
 */
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Palette, Sparkles, Square, Check, CircleDashed } from 'lucide-react';
import { useTheme } from 'next-themes';
import { useVisualMode } from '@/components/VisualModeProvider';
import { THEMES } from '@/components/ThemeSwitcher';

interface Props {
  /** Variante visual do botao. 'header' = compacto pra topbar, 'sidebar' = card branco. */
  variant?: 'header' | 'sidebar';
  /** Posicionamento do popup. 'right' (default) = abre pra esquerda do botao,
      'left' = abre pra direita. */
  align?: 'right' | 'left';
}

export function ThemeMenuButton({ variant = 'header', align = 'right' }: Props) {
  const [mounted, setMounted] = useState(false);
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const { theme, setTheme } = useTheme();
  const { mode: fxMode, setMode: setFxMode } = useVisualMode();
  const btnRef = useRef<HTMLButtonElement>(null);
  const popupRef = useRef<HTMLDivElement>(null);

  useEffect(() => setMounted(true), []);

  // Fecha em click fora / ESC
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
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const toggle = (e: React.MouseEvent) => {
    if (open) {
      setOpen(false);
      setPos(null);
      return;
    }
    const rect = e.currentTarget.getBoundingClientRect();
    // popup tem ~360px de altura, 280px largura
    const POPUP_W = 280;
    const POPUP_H = 360;
    const MARGIN = 8;
    const top = Math.min(rect.bottom + MARGIN, window.innerHeight - POPUP_H - MARGIN);
    const left =
      align === 'right'
        ? Math.max(MARGIN, rect.right - POPUP_W)
        : Math.min(rect.left, window.innerWidth - POPUP_W - MARGIN);
    setPos({ top, left });
    setOpen(true);
  };

  if (!mounted) return null;

  const btnCls =
    variant === 'header'
      ? `inline-flex items-center justify-center w-10 h-10 rounded-xl transition-all text-foreground hover:bg-[var(--glass-bg)] hover:backdrop-blur-md ${
          open ? 'bg-[var(--glass-bg)] backdrop-blur-md' : ''
        }`
      : `w-full flex items-center gap-2 rounded-lg px-2.5 py-2 bg-card text-foreground hover:bg-accent transition-colors`;

  return (
    <>
      <button
        ref={btnRef}
        onClick={toggle}
        className={btnCls}
        title="Aparência"
        aria-label="Aparência"
      >
        <Palette size={variant === 'header' ? 18 : 16} className="shrink-0 text-primary" />
        {variant === 'sidebar' && <span className="text-[13px] font-medium">Aparência</span>}
      </button>

      {open &&
        pos &&
        createPortal(
          <div
            ref={popupRef}
            style={{
              position: 'fixed',
              top: pos.top,
              left: pos.left,
              zIndex: 9999,
              width: 280,
            }}
            className="glass-card p-4 flex flex-col space-y-4 shadow-2xl border border-border"
          >
            {/* ── COR DO TEMA ── */}
            <div>
              <p className="flex items-center text-[11px] font-bold text-muted-foreground uppercase tracking-wider mb-2">
                <Palette className="w-3 h-3 mr-1.5" />
                Temas
              </p>
              <div className="flex flex-col gap-1">
                {THEMES.map((t) => (
                  <button
                    key={t.id}
                    onClick={() => {
                      setTheme(t.id);
                    }}
                    className={`flex items-center justify-between w-full px-3 py-2 rounded-lg text-sm text-foreground transition-colors hover:bg-accent ${
                      theme === t.id ? 'bg-accent' : 'bg-transparent'
                    }`}
                  >
                    <div className="flex items-center gap-2.5">
                      <div
                        className="w-3.5 h-3.5 rounded-full border border-border shadow-inner shrink-0"
                        style={{ background: t.accent ?? t.color }}
                      />
                      <span className="truncate">{t.name}</span>
                    </div>
                    {theme === t.id && <Check size={14} className="text-primary shrink-0" />}
                  </button>
                ))}
              </div>
            </div>

            {/* ── ESTILO ── */}
            <div>
              <p className="flex items-center text-[11px] font-bold text-muted-foreground uppercase tracking-wider mb-2">
                <Sparkles className="w-3 h-3 mr-1.5" />
                Estilo
              </p>
              <div className="grid grid-cols-3 gap-2">
                <button
                  onClick={() => setFxMode('solid')}
                  className={`flex items-center justify-center gap-1 px-2 py-1.5 rounded-lg text-[10px] font-bold transition-all border ${
                    fxMode === 'solid'
                      ? 'bg-[var(--bg-tertiary)] border-[var(--accent-primary)] text-foreground'
                      : 'bg-transparent border-border/40 text-muted-foreground hover:text-foreground hover:border-border'
                  }`}
                  title="Visual ERP clássico: cores chapadas, sem efeitos."
                >
                  <Square className="w-3 h-3" />
                  Clássico
                </button>
              </div>
            </div>
          </div>,
          document.body
        )}
    </>
  );
}

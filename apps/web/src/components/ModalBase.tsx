'use client';

/**
 * ModalBase — wrapper unico pra todos os modais do app (Fase 25 Onda 2.7).
 *
 * Antes: 8+ modais bespoke duplicavam estilo, animacao, fechamento por ESC,
 * click-outside (NewContactModal, AddQuoteItemModal, AllergyMedicationModal,
 * EditPatientModal, etc). 200+ LOC repetido. Mudanca de design = 8 PRs.
 *
 * Agora: importa daqui e foca no conteudo:
 *   <ModalBase open={open} onClose={close} title="Editar paciente">
 *     {form}
 *   </ModalBase>
 *
 * Features built-in:
 *  - Backdrop com blur + click-outside fecha (override via closeOnBackdrop=false)
 *  - ESC fecha (override via closeOnEsc=false)
 *  - Header opcional com titulo + X
 *  - Body scrollavel se conteudo grande (max-h 90vh)
 *  - Tamanhos sm | md | lg | xl | full (full = quase tela cheia)
 *  - Lock scroll do body quando aberto (sem barrer atras)
 *  - Foco automatico no primeiro elemento focavel (acessibilidade)
 *  - aria-modal + role=dialog (screen readers)
 *  - Animacao fade-in suave
 *  - Renderiza via portal (sai do tree pra evitar z-index hell)
 */

import { useEffect, useRef, ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';

export type ModalSize = 'sm' | 'md' | 'lg' | 'xl' | 'full';

interface Props {
  open: boolean;
  onClose: () => void;
  /** Titulo do header. Se ausente, header nao eh renderizado. */
  title?: ReactNode;
  /** Subtitulo opcional abaixo do titulo (texto pequeno) */
  subtitle?: ReactNode;
  /** Conteudo do body do modal */
  children: ReactNode;
  /** Footer opcional (geralmente botoes de acao) */
  footer?: ReactNode;
  /** Tamanho — afeta max-width. default: md */
  size?: ModalSize;
  /** Click no backdrop fecha o modal? default: true */
  closeOnBackdrop?: boolean;
  /** ESC fecha o modal? default: true */
  closeOnEsc?: boolean;
  /** Esconde botao X do header. default: false (mostra) */
  hideCloseButton?: boolean;
  /** Classes Tailwind extras pro container do modal */
  className?: string;
}

const SIZE_MAX_W: Record<ModalSize, string> = {
  sm: 'max-w-sm',
  md: 'max-w-md',
  lg: 'max-w-2xl',
  xl: 'max-w-4xl',
  full: 'max-w-[95vw]',
};

export default function ModalBase({
  open,
  onClose,
  title,
  subtitle,
  children,
  footer,
  size = 'md',
  closeOnBackdrop = true,
  closeOnEsc = true,
  hideCloseButton = false,
  className = '',
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);

  // Lock scroll do body + ESC handler
  useEffect(() => {
    if (!open) return;

    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    const onKey = (e: KeyboardEvent) => {
      if (closeOnEsc && e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);

    // Foco automatico no primeiro elemento focavel pra acessibilidade
    const focusTimer = setTimeout(() => {
      const firstFocusable = containerRef.current?.querySelector<HTMLElement>(
        'input:not([disabled]), button:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      );
      firstFocusable?.focus();
    }, 50);

    return () => {
      document.body.style.overflow = prevOverflow;
      window.removeEventListener('keydown', onKey);
      clearTimeout(focusTimer);
    };
  }, [open, onClose, closeOnEsc]);

  if (!open) return null;
  if (typeof document === 'undefined') return null; // SSR safety

  const modal = (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby={title ? 'modal-title' : undefined}
      className="fixed inset-0 z-[100] bg-black/50 backdrop-blur-sm flex items-center justify-center p-4 animate-in fade-in duration-150"
      onClick={closeOnBackdrop ? onClose : undefined}
    >
      <div
        ref={containerRef}
        onClick={(e) => e.stopPropagation()}
        className={`bg-card border border-border rounded-xl w-full ${SIZE_MAX_W[size]} shadow-2xl max-h-[90vh] flex flex-col ${className}`}
      >
        {(title || !hideCloseButton) && (
          <div className="flex items-start justify-between p-4 border-b border-border shrink-0">
            <div className="min-w-0 flex-1">
              {title && (
                <h2 id="modal-title" className="text-base font-semibold truncate">
                  {title}
                </h2>
              )}
              {subtitle && (
                <p className="text-xs text-muted-foreground mt-0.5">{subtitle}</p>
              )}
            </div>
            {!hideCloseButton && (
              <button
                onClick={onClose}
                className="p-1 hover:bg-accent rounded ml-2 shrink-0"
                aria-label="Fechar modal"
                type="button"
              >
                <X size={18} />
              </button>
            )}
          </div>
        )}

        <div className="overflow-y-auto p-4 flex-1">{children}</div>

        {footer && (
          <div className="border-t border-border p-3 shrink-0 flex items-center justify-end gap-2">
            {footer}
          </div>
        )}
      </div>
    </div>
  );

  return createPortal(modal, document.body);
}

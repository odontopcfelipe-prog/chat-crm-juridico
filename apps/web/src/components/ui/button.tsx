"use client";

import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";
import { Loader2 } from "lucide-react";

/**
 * Onda 15 — Visual futurista neon agressivo.
 *
 * - `default`: gradiente do tema + glow neon permanente (CTA padrão).
 * - `outline`: glass card (transparente + blur) com borda neon, glow só no hover.
 * - `ghost`: 100% transparente; ganha glass-bg + glow leve no hover.
 * - `secondary`: glass surface neutra com texto do tema.
 * - `neon`: igual ao default mas com pulse animado pra CTAs principais.
 * - `destructive`/`success`/`warning`: cores chapadas + glow correspondente.
 *
 * Todas as variantes leem `--accent-glow` (RGB triplet) e `--gradient-accent`
 * definidos por tema em globals.css — trocar tema atualiza tudo via CSS vars.
 */
const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-lg text-sm font-medium transition-all duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:pointer-events-none disabled:opacity-50 active:scale-[0.98] relative overflow-hidden",
  {
    variants: {
      variant: {
        default:
          "text-white font-semibold [background:var(--gradient-accent)] shadow-[0_0_12px_rgba(var(--accent-glow),0.40),0_0_26px_rgba(var(--accent-glow),0.20)] hover:shadow-[0_0_18px_rgba(var(--accent-glow),0.65),0_0_42px_rgba(var(--accent-glow),0.35)] hover:brightness-110 focus-visible:ring-primary",
        neon:
          "text-white font-semibold [background:var(--gradient-accent)] shadow-[0_0_14px_rgba(var(--accent-glow),0.55),0_0_32px_rgba(var(--accent-glow),0.30)] hover:brightness-110 neon-pulse focus-visible:ring-primary",
        destructive:
          "bg-destructive text-destructive-foreground shadow-[0_0_10px_rgba(239,68,68,0.40),0_0_22px_rgba(239,68,68,0.20)] hover:bg-destructive/90 hover:shadow-[0_0_14px_rgba(239,68,68,0.65),0_0_30px_rgba(239,68,68,0.35)] focus-visible:ring-destructive",
        outline:
          "bg-[var(--glass-bg)] backdrop-blur-md border border-[var(--glass-border)] text-foreground shadow-[inset_0_0_8px_rgba(var(--accent-glow),0.10)] hover:border-[rgba(var(--accent-glow),0.55)] hover:shadow-[0_0_12px_rgba(var(--accent-glow),0.35),inset_0_0_10px_rgba(var(--accent-glow),0.15)] hover:text-foreground focus-visible:ring-primary",
        secondary:
          "bg-[color-mix(in_srgb,var(--bg-secondary)_70%,transparent)] backdrop-blur-md text-foreground border border-[var(--border-subtle)] shadow-sm hover:bg-[var(--bg-hover)] hover:border-[var(--border-default)] hover:shadow-[0_0_10px_rgba(var(--accent-glow),0.25)] focus-visible:ring-primary",
        ghost:
          "bg-transparent text-foreground hover:bg-[var(--glass-bg)] hover:backdrop-blur-md hover:shadow-[0_0_8px_rgba(var(--accent-glow),0.25)] focus-visible:ring-primary",
        link:
          "text-primary underline-offset-4 hover:underline hover:[text-shadow:0_0_8px_rgba(var(--accent-glow),0.5)] focus-visible:ring-primary",
        success:
          "bg-emerald-600 text-white shadow-[0_0_10px_rgba(16,185,129,0.40),0_0_22px_rgba(16,185,129,0.20)] hover:bg-emerald-700 hover:shadow-[0_0_14px_rgba(16,185,129,0.65),0_0_30px_rgba(16,185,129,0.35)] focus-visible:ring-emerald-600",
        warning:
          "bg-amber-500 text-white shadow-[0_0_10px_rgba(245,158,11,0.40),0_0_22px_rgba(245,158,11,0.20)] hover:bg-amber-600 hover:shadow-[0_0_14px_rgba(245,158,11,0.65),0_0_30px_rgba(245,158,11,0.35)] focus-visible:ring-amber-500",
      },
      size: {
        default: "h-10 px-4 py-2",
        sm: "h-8 rounded-md px-3 text-xs",
        lg: "h-12 rounded-lg px-8 text-base",
        xl: "h-14 rounded-xl px-10 text-lg",
        icon: "h-10 w-10",
        "icon-sm": "h-8 w-8",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  isLoading?: boolean;
  leftIcon?: React.ReactNode;
  rightIcon?: React.ReactNode;
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  (
    {
      className,
      variant,
      size,
      isLoading,
      leftIcon,
      rightIcon,
      children,
      disabled,
      ...props
    },
    ref
  ) => {
    return (
      <button
        className={cn(buttonVariants({ variant, size, className }))}
        ref={ref}
        disabled={disabled || isLoading}
        {...props}
      >
        {isLoading ? (
          <Loader2 className="h-4 w-4 animate-spin" />
        ) : (
          leftIcon
        )}
        {children}
        {!isLoading && rightIcon}
      </button>
    );
  }
);
Button.displayName = "Button";

export { Button, buttonVariants };
